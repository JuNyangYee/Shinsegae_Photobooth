// 실행: npm test
// src/web/core/ 의존 규칙 검사 (docs/SYSTEM.md 2절 "폴더 규칙").
// core는 같은 core와 config만 불러오고, core에서 닿는 파일(전이적으로)은 브라우저 전역을 쓰지 않는다.
// config 안에도 순수하지 않은 파일(settings-file.js, 기본값이 globalThis.fetch)이 있으므로, 폴더만이 아니라 닿는 파일마다 본다.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { posix } from 'node:path';

const repo = fileURLToPath(new URL('../', import.meta.url)).replace(/\\/g, '/');
const WEB = 'src/web';
const CORE = `${WEB}/core`;
const ALLOWED_DIRS = [`${WEB}/core`, `${WEB}/config`];

// DOM·카메라·캔버스·네트워크·브라우저 저장소 전역. timers·performance·Date·console·URL·globalThis는 Node에도 있어 허용한다.
const BROWSER_GLOBALS = new Set([
  'document', 'window', 'self', 'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'HTMLElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLImageElement', 'OffscreenCanvas',
  'CanvasRenderingContext2D', 'Image', 'ImageBitmap', 'ImageData', 'createImageBitmap',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
  'MediaStream', 'MediaStreamTrack', 'Worker', 'FileReader',
]);
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window']);

/** 주석을 버리고 이름·문자열·구두점 토큰으로 나눈다. 템플릿 글자는 버리고 `${…}` 안은 코드로 읽는다. */
function tokenize(src) {
  const tokens = [];
  const braces = []; // '{' 또는 템플릿 '${' 의 짝을 맞춘다
  let i = 0;
  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === 'str' || t.type === 'num') return false;
    if (t.type === 'id') return ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await'].includes(t.value);
    return ![')', ']', '}'].includes(t.value);
  };
  const readTemplate = () => { // i는 ` 다음 또는 } 다음
    while (i < src.length) {
      if (src[i] === '\\') { i += 2; continue; }
      if (src[i] === '`') { i += 1; tokens.push({ type: 'str', value: null }); return; }
      if (src[i] === '$' && src[i + 1] === '{') { i += 2; braces.push('tpl'); tokens.push({ type: 'punct', value: '(' }); return; }
      i += 1;
    }
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && src[i + 1] === '*') { const end = src.indexOf('*/', i + 2); i = end < 0 ? src.length : end + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1; let value = '';
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') { value += src[j + 1]; j += 2; } else { value += src[j]; j += 1; } }
      tokens.push({ type: 'str', value }); i = j + 1; continue;
    }
    if (c === '`') { i += 1; readTemplate(); continue; }
    if (c === '/' && regexAllowed()) {
      let j = i + 1; let inClass = false;
      while (j < src.length && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j += 1; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        j += 1;
      }
      j += 1; while (/[a-z]/i.test(src[j] ?? '')) j += 1;
      tokens.push({ type: 'num', value: 'regex' }); i = j; continue;
    }
    const id = /^[A-Za-z_$][\w$]*/.exec(src.slice(i, i + 64));
    if (id) { tokens.push({ type: 'id', value: id[0] }); i += id[0].length; continue; }
    const num = /^\d[\w.]*/.exec(src.slice(i, i + 64));
    if (num) { tokens.push({ type: 'num', value: num[0] }); i += num[0].length; continue; }
    if (src.startsWith('...', i)) { tokens.push({ type: 'punct', value: '...' }); i += 3; continue; }
    if (src.startsWith('?.', i) && !/\d/.test(src[i + 2] ?? '')) { tokens.push({ type: 'punct', value: '.' }); i += 2; continue; }
    if (c === '{') braces.push('{');
    if (c === '}') {
      if (braces.pop() === 'tpl') { tokens.push({ type: 'punct', value: ')' }); i += 1; readTemplate(); continue; }
    }
    tokens.push({ type: 'punct', value: c }); i += 1;
  }
  return tokens;
}

/** 정적 import·export from·부수 효과 import·동적 import()의 대상과, 브라우저 전역 사용을 뽑는다. */
function scanSource(src) {
  const tokens = tokenize(src);
  const specifiers = [];
  const problems = [];
  tokens.forEach((t, k) => {
    if (t.type !== 'id') return;
    const prev = tokens[k - 1];
    const next = tokens[k + 1];
    const afterDot = prev?.type === 'punct' && prev.value === '.';
    if (t.value === 'from' && !afterDot && next?.type === 'str') specifiers.push(next.value);
    if (t.value === 'import' && !afterDot) {
      if (next?.type === 'str') specifiers.push(next.value);
      if (next?.value === '(') {
        const arg = tokens[k + 2];
        if (arg?.type === 'str' && arg.value !== null && tokens[k + 3]?.value === ')') specifiers.push(arg.value);
        else problems.push('dynamic import() without a string literal');
      }
    }
    if (!BROWSER_GLOBALS.has(t.value)) return;
    if (afterDot) {
      const owner = tokens[k - 2];
      if (owner?.type === 'id' && GLOBAL_OBJECTS.has(owner.value) && tokens[k - 3]?.value !== '.') problems.push(`global ${owner.value}.${t.value}`);
      return;
    }
    const objectKey = next?.value === ':' && (prev?.value === '{' || prev?.value === ',');
    if (!objectKey) problems.push(`global ${t.value}`);
  });
  return { specifiers, problems };
}

/** 브라우저 URL 또는 상대 경로를 저장소 경로로 푼다. 패키지 이름·lib/는 null(허용 밖). */
function resolveSpecifier(fromFile, spec) {
  if (spec.startsWith('./') || spec.startsWith('../')) return posix.normalize(posix.join(posix.dirname(fromFile), spec));
  if (spec.startsWith('/') && !spec.startsWith('/lib/')) return posix.normalize(`${WEB}${spec}`);
  return null;
}

/** core 파일들에서 시작해 import를 전이적으로 따라가며 위반을 모은다. read(path) → 소스 */
function checkCore(entries, read) {
  const violations = [];
  const seen = new Set();
  const visit = (file, via) => {
    if (seen.has(file)) return;
    seen.add(file);
    let source;
    try { source = read(file); } catch { violations.push(`${via.join(' -> ')}: cannot read ${file}`); return; }
    const chain = [...via, file];
    const { specifiers, problems } = scanSource(source);
    for (const p of problems) violations.push(`${chain.join(' -> ')}: ${p}`);
    for (const spec of specifiers) {
      const target = resolveSpecifier(file, spec);
      if (target === null || !ALLOWED_DIRS.some((dir) => target.startsWith(`${dir}/`))) {
        violations.push(`${chain.join(' -> ')}: imports '${spec}' (only core/ and config/ are allowed)`);
        continue;
      }
      visit(target, chain);
    }
  };
  for (const entry of entries) visit(entry, []);
  return violations;
}

const coreFiles = () => readdirSync(`${repo}${CORE}`).filter((f) => f.endsWith('.js')).sort().map((f) => `${CORE}/${f}`);
const readRepo = (file) => readFileSync(`${repo}${file}`, 'utf8');

describe('core 의존 규칙: 실제 src/web/core', () => {
  it('core 폴더에 검사할 모듈이 있다', () => {
    assert.ok(coreFiles().length >= 2, `core files: ${coreFiles().join(', ')}`);
  });

  it('core에서 닿는 모든 파일이 core·config 안에 있고 브라우저 전역을 쓰지 않는다 (전이적)', () => {
    assert.deepEqual(checkCore(coreFiles(), readRepo), []);
  });

  it('config의 settings-file.js는 순수하지 않으므로 core에서 부르면 위반이다 (검사가 실제 파일을 본다)', () => {
    const files = { [`${CORE}/x.js`]: "import { createSettingsFileClient } from '../config/settings-file.js';" };
    const read = (f) => files[f] ?? readRepo(f);
    const violations = checkCore([`${CORE}/x.js`], read);
    assert.ok(violations.some((v) => v.includes('settings-file.js') && v.includes('globalThis.fetch')), violations.join('\n'));
  });
});

describe('core 의존 규칙: 검사기 자체', () => {
  const check = (files) => checkCore(Object.keys(files).filter((f) => f.startsWith(`${CORE}/`)), (f) => {
    if (!(f in files)) throw new Error('missing');
    return files[f];
  });

  it('허용 밖 import(다른 폴더, 절대 URL, lib, 패키지, 문자열이 아닌 동적 import)를 찾는다', () => {
    const v = check({
      [`${CORE}/a.js`]: [
        "import { x } from '../camera/capture.js';",
        "export { y } from '/vision/face-detector.js';",
        "import '/lib/mediapipe/tasks-vision/vision_bundle.mjs';",
        "import z from 'some-package';",
        'const m = await import(path);',
        "const n = await import('../ui/region-drag.js');",
      ].join('\n'),
    });
    assert.equal(v.length, 6, v.join('\n'));
  });

  it('core → config → 다른 폴더처럼 전이적으로 닿는 위반을 경로와 함께 보고한다', () => {
    const v = check({
      [`${CORE}/a.js`]: "import { b } from './b.js';",
      [`${CORE}/b.js`]: "import { c } from '../config/c.js';",
      [`${WEB}/config/c.js`]: 'export const c = () => document.title;',
    });
    assert.deepEqual(v, [`${CORE}/a.js -> ${CORE}/b.js -> ${WEB}/config/c.js: global document`]);
  });

  it('브라우저 전역: 이름 그대로·globalThis 속성·펼침은 잡고, 주석·문자열·템플릿 글자·정규식·속성·객체 키는 무시한다', () => {
    const bad = check({
      [`${CORE}/a.js`]: [
        'const w = window.innerWidth;',
        'const f = globalThis.fetch;',
        'const s = { ...navigator };',
        'const t = `${location.href}`;',
      ].join('\n'),
    });
    assert.deepEqual(bad.map((v) => v.split(': ').pop()), ['global window', 'global globalThis.fetch', 'global navigator', 'global location']);

    const ok = check({
      [`${CORE}/a.js`]: [
        '// document.title, window.alert()',
        '/* navigator */',
        "const a = 'document';",
        'const b = `fetch ${1 + 2} window`;',
        'const r = /document|window/g;',
        'const c = obj.document ?? obj?.fetch;',
        'const d = { document: 1, location: 2 };',
        'const e = timers.setTimeout(() => performance.now(), 10) / 2;',
        "import { g } from './g.js';",
      ].join('\n'),
      [`${CORE}/g.js`]: 'export const g = globalThis.setTimeout;',
    });
    assert.deepEqual(ok, []);
  });
});
