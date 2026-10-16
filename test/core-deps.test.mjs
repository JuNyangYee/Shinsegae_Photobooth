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

// DOM·카메라·캔버스·네트워크·브라우저 저장소 전역. 타이머·performance·Date·console·URL은 Node에도 있어 허용한다.
// 전역 객체(globalThis·window·self) 자체는 쓰면 위반이다. 예외는 매개변수 기본값 `timers = globalThis`(타이머 메서드만) 하나.
const BROWSER_GLOBALS = new Set([
  'document', 'window', 'self', 'navigator', 'location', 'localStorage', 'sessionStorage', 'indexedDB', 'caches',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource',
  'HTMLElement', 'HTMLCanvasElement', 'HTMLVideoElement', 'HTMLImageElement', 'OffscreenCanvas',
  'CanvasRenderingContext2D', 'Image', 'ImageBitmap', 'ImageData', 'createImageBitmap',
  'requestAnimationFrame', 'cancelAnimationFrame', 'matchMedia', 'getComputedStyle',
  'MediaStream', 'MediaStreamTrack', 'Worker', 'FileReader',
]);
const GLOBAL_OBJECTS = new Set(['globalThis', 'self', 'window']);
// 매개변수 기본값으로 받은 전역 객체(`timers = globalThis`)에서 쓸 수 있는 속성
const TIMER_METHODS = new Set(['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']);
// 뒤에 오는 '('가 매개변수 목록이 아닌 이름 (`if (…) {` 등). 이 뒤의 ++/--는 후위가 아니다
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'with', 'return', 'typeof', 'await', 'yield', 'new', 'delete', 'void',
  'in', 'of', 'instanceof', 'case', 'throw', 'else', 'do', 'import', 'super']);

/** 주석을 버리고 이름·문자열·구두점 토큰으로 나눈다. 템플릿 글자는 버리고 `${…}` 안은 코드로 읽는다. */
function tokenize(src) {
  const tokens = [];
  const braces = []; // '{' 또는 템플릿 '${' 의 짝을 맞춘다
  let i = 0;
  const last = () => tokens[tokens.length - 1];
  // '/'가 정규식의 시작인지. 값 뒤(이름·숫자·문자열·닫는 괄호·후위 ++/--)면 나눗셈이다.
  // 애매하면 나눗셈으로 본다: 나눗셈을 정규식으로 잘못 읽으면 뒤 코드를 건너뛰어 위반을 놓치지만, 반대는 더 검사할 뿐이다.
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === 'str' || t.type === 'num') return false;
    if (t.type === 'id') return ['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await', 'instanceof'].includes(t.value);
    if (t.value === '++' || t.value === '--') return !t.postfix;
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
    if (src.startsWith('=>', i)) { tokens.push({ type: 'punct', value: '=>' }); i += 2; continue; }
    if (src.startsWith('++', i) || src.startsWith('--', i)) {
      const t = last(); // 값 바로 뒤면 후위 연산자
      const postfix = !!t && (t.type === 'num' || t.type === 'str' || (t.type === 'id' && !NOT_METHOD.has(t.value)) || t.value === ')' || t.value === ']');
      tokens.push({ type: 'punct', value: src.slice(i, i + 2), postfix }); i += 2; continue;
    }
    if (src.startsWith('?.', i) && !/\d/.test(src[i + 2] ?? '')) { tokens.push({ type: 'punct', value: '.' }); i += 2; continue; }
    if (c === '{') braces.push('{');
    if (c === '}') {
      if (braces.pop() === 'tpl') { tokens.push({ type: 'punct', value: ')' }); i += 1; readTemplate(); continue; }
    }
    tokens.push({ type: 'punct', value: c }); i += 1;
  }
  return tokens;
}

/** 여는·닫는 괄호 토큰 위치를 서로 잇는다. */
function matchBrackets(tokens) {
  const match = new Map();
  const stack = [];
  tokens.forEach((t, k) => {
    if (t.type !== 'punct') return;
    if ('([{'.includes(t.value)) stack.push(k);
    else if (')]}'.includes(t.value) && stack.length) { const open = stack.pop(); match.set(open, k); match.set(k, open); }
  });
  return match;
}

/**
 * 파일 안에서 선언된 이름(매개변수, let·const·var, 함수·클래스 이름, 구조분해, catch, import)과
 * 매개변수 기본값으로 받은 전역 객체(`timers = globalThis`)를 찾는다.
 * 한계: 범위(scope)를 추적하지 않는다. 파일 어디에서든 선언된 이름이면 그 파일의 같은 이름을 모두 지역으로 본다.
 * 그래서 한 함수의 매개변수 `location`과 다른 곳의 전역 `location`이 한 파일에 같이 있으면 전역 쪽을 놓친다.
 * 완전한 JS 파서가 아니다(경계를 지키는 안전장치). 모르는 구문은 선언으로 보지 않는다 — 놓치기보다 오탐 쪽으로 기운다.
 */
function collectBindings(tokens, match) {
  const names = new Set();
  const injected = new Map(); // 이름 → 기본값 globalThis 토큰 위치
  const at = (k) => (tokens[k]?.type === 'punct' ? tokens[k].value : null);
  const skipExpr = (k) => { // 깊이 0의 ',' 또는 닫는 괄호·';'까지
    while (k < tokens.length) {
      const v = at(k);
      if ((v === '(' || v === '[' || v === '{') && match.has(k)) { k = match.get(k) + 1; continue; }
      if (v === ',' || v === ')' || v === ']' || v === '}' || v === ';') return k;
      k += 1;
    }
    return k;
  };
  const pattern = (k, param) => { // 이름 또는 구조분해 하나(와 기본값)를 읽고 다음 위치를 돌려준다
    const t = tokens[k];
    if (!t) return k;
    if (t.type === 'id') {
      names.add(t.value);
      k += 1;
    } else if ((t.value === '[' || t.value === '{') && match.has(k)) {
      const end = match.get(k);
      let j = k + 1;
      while (j < end) {
        const u = tokens[j];
        if (u.value === ',') { j += 1; continue; }
        if (u.value === '...') { j = pattern(j + 1, param); continue; }
        if (t.value === '{') {
          const afterKey = u.value === '[' && match.has(j) ? match.get(j) + 1 : j + 1;
          if (at(afterKey) === ':') { j = pattern(afterKey + 1, param); continue; } // { 키: 이름 }
          if (u.type !== 'id') { j = Math.max(j + 1, skipExpr(j)); continue; }
        }
        j = pattern(j, param);
      }
      k = end + 1;
    } else {
      return k + 1;
    }
    if (at(k) === '=') {
      if (param && t.type === 'id' && tokens[k + 1]?.type === 'id' && tokens[k + 1].value === 'globalThis'
        && [',', ')', '}', ']'].includes(at(k + 2))) injected.set(t.value, k + 1);
      k = skipExpr(k + 1);
    }
    return k;
  };
  const params = (open) => {
    const end = match.get(open);
    let j = open + 1;
    while (j < end) {
      if (at(j) === ',') { j += 1; continue; }
      j = pattern(at(j) === '...' ? j + 1 : j, true);
    }
  };
  const isParamList = (open) => match.has(open) && ['=>', '{'].includes(at(match.get(open) + 1));

  tokens.forEach((t, k) => {
    if (t.type === 'id' && at(k - 1) !== '.') {
      if (['let', 'const', 'var'].includes(t.value)) {
        let j = pattern(k + 1, false);
        while (at(j) === ',') j = pattern(j + 1, false);
      } else if (t.value === 'function') {
        let j = k + 1;
        if (at(j) === '*') j += 1;
        if (tokens[j]?.type === 'id') { names.add(tokens[j].value); j += 1; }
        if (at(j) === '(' && match.has(j)) params(j);
      } else if (t.value === 'class' && tokens[k + 1]?.type === 'id') {
        names.add(tokens[k + 1].value);
      } else if (at(k + 1) === '=>') {
        names.add(t.value); // x => …
      } else if (at(k + 1) === '(' && !NOT_METHOD.has(t.value) && isParamList(k + 1)) {
        params(k + 1); // 메서드 name(…) {, catch (e) {
      } else if (t.value === 'import' && tokens[k + 1]?.type !== 'str' && !['(', '.'].includes(at(k + 1))) {
        for (let j = k + 1; j < tokens.length && !(tokens[j].type === 'id' && tokens[j].value === 'from'); j += 1) {
          const u = tokens[j]; // import x, { a as b }, * as ns
          if (u.type === 'id' && u.value !== 'as' && !(tokens[j + 1]?.type === 'id' && tokens[j + 1].value === 'as')) names.add(u.value);
        }
      }
    }
    if (at(k) === ')' && at(k + 1) === '=>' && match.has(k)) params(match.get(k)); // (a, b) => …
  });
  return { names, injected };
}

/** 정적 import·export from·부수 효과 import·동적 import()의 대상과, 브라우저 전역 사용을 뽑는다. */
function scanSource(src) {
  const tokens = tokenize(src);
  const { names, injected } = collectBindings(tokens, matchBrackets(tokens));
  const allowedGlobalRefs = new Set(injected.values());
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
    if (afterDot) return; // 속성 이름 (obj.document)
    if (next?.value === ':' && (prev?.value === '{' || prev?.value === ',')) return; // 객체 키 ({ document: … })

    // 기본값으로 받은 전역 객체: 타이머 메서드 호출(`timers.setTimeout`)만 허용. 넘기기·구조분해·대괄호 접근은 위반
    if (injected.has(t.value) && injected.get(t.value) !== k + 2) {
      const property = next?.value === '.' ? tokens[k + 2] : null;
      if (!(property?.type === 'id' && TIMER_METHODS.has(property.value))) {
        problems.push(`injected global ${t.value}${property ? `.${property.value}` : ''} (only ${[...TIMER_METHODS].join('/')})`);
      }
      return;
    }
    // 전역 객체 자체(globalThis·window·self): 속성·대괄호·구조분해·괄호·별칭 어느 형태든 위반
    if (GLOBAL_OBJECTS.has(t.value)) {
      if (allowedGlobalRefs.has(k) || (t.value !== 'globalThis' && names.has(t.value))) return;
      const property = next?.value === '.' && tokens[k + 2]?.type === 'id' ? `.${tokens[k + 2].value}` : '';
      problems.push(`global ${t.value}${property}`);
      return;
    }
    if (BROWSER_GLOBALS.has(t.value) && !names.has(t.value)) problems.push(`global ${t.value}`);
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
    assert.deepEqual(bad.map((v) => v.split(': ').pop()), ['global window.innerWidth', 'global globalThis.fetch', 'global navigator', 'global location']);

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
      [`${CORE}/g.js`]: 'export const g = Date.now() / 2;',
    });
    assert.deepEqual(ok, []);
  });

  // 단위 검수 1: 후위 ++ 뒤의 '/'를 정규식으로 읽어 뒤 코드를 건너뛰었다
  it('나눗셈과 정규식을 직전 토큰으로 구분한다 (후위 ++·--, 닫는 괄호, 이름, 숫자 뒤는 나눗셈)', () => {
    const cases = [
      'let n=2; const half=n++ / 2; document.title;',
      'let n=2; const half=n-- / 2; document.title;',
      'const a = [4]; const q = a[0] / 2; document.title;',
      'const q = (1 + 2) / 3 / document.title;',
      'const n = 4; const q = n / 2 / document.title;',
      'const q = 8 / 2; document.title;',
    ];
    for (const source of cases) {
      assert.deepEqual(check({ [`${CORE}/a.js`]: source }).map((v) => v.split(': ').pop()), ['global document'], source);
    }
    // 정규식 자리(대입·인자·return·전위 ++ 뒤 등)의 글자는 코드로 읽지 않는다
    const regexes = [
      'const r = /document/;',
      'f(/window/g);',
      'function t(s) { return /location/.test(s); }',
      'const x = [/fetch/, /navigator/];',
      'const y = !/document/.test(s);',
    ];
    for (const source of regexes) assert.deepEqual(check({ [`${CORE}/a.js`]: source }), [], source);
  });

  // 단위 검수 2: 전역 객체를 대괄호·구조분해·괄호로 쓰면 통과했다
  it('전역 객체(globalThis·window·self)는 대괄호·구조분해·괄호·별칭 어느 형태로 써도 위반이다', () => {
    const cases = [
      "globalThis['fetch']('/x');",
      'const {fetch: request} = globalThis;',
      '(globalThis).document.title;',
      'const g = globalThis; g.setTimeout(f, 1);',
      "window['document'];",
      'const s = self;',
      'export default globalThis;',
    ];
    for (const source of cases) {
      const v = check({ [`${CORE}/a.js`]: source });
      assert.ok(v.length >= 1 && v.every((x) => /global (globalThis|window|self)/.test(x)), `${source}\n${v.join('\n')}`);
    }
  });

  it('예외: 매개변수 기본값 `timers = globalThis`는 그 이름을 타이머 메서드로만 쓸 때 허용한다 (session.js의 주입 기본값)', () => {
    const allowed = [
      'export function s({ timers = globalThis, now = () => 0 } = {}) { const id = timers.setTimeout(f, 1); timers.clearTimeout(id); }',
      'export function s(timers = globalThis) { timers.setInterval(f, 1); timers.clearInterval(1); }',
    ];
    for (const source of allowed) assert.deepEqual(check({ [`${CORE}/a.js`]: source }), [], source);
    const cases = [
      'export function s({ timers = globalThis } = {}) { timers.fetch(); }',
      'export function s({ timers = globalThis } = {}) { const { document: d } = timers; }',
      "export function s({ timers = globalThis } = {}) { timers['fetch'](); }",
      'export function s({ timers = globalThis } = {}) { leak(timers); }',
      'const timers = globalThis; timers.setTimeout(f, 1);', // 매개변수 기본값이 아니면 예외가 아니다
      'export function s({ timers = globalThis.window } = {}) {}',
    ];
    for (const source of cases) assert.ok(check({ [`${CORE}/a.js`]: source }).length >= 1, source);
  });

  // 단위 검수 3: 매개변수 이름을 전역으로 보고 실패했다
  it('파일 안에서 선언한 이름(매개변수·지역 변수·함수·클래스·구조분해·catch·import)은 전역으로 보지 않는다', () => {
    const declared = [
      'export function normalize(location) { return location.x; }',
      'export const f = (document) => document.title;',
      'export const f = fetch => fetch(1);',
      'export const f = async ({ navigator, a: [location] }, ...Image) => navigator + location + Image;',
      'const { document } = obj; export const t = document.title;',
      'let [window, ...rest] = list; export { window };',
      'var fetch = stub; fetch();',
      'function Image() {} new Image();',
      'class Worker {} new Worker();',
      'try { x(); } catch (location) { location.reload(); }',
      "import { fetch } from './f.js'; fetch();",
      "import { x as document } from './f.js'; document.title;",
      'const o = { read(location) { return location; }, get g() { return 1; } };',
      'export function s({ timers = {}, fetch = (u) => u } = {}) { return fetch(1); }',
    ];
    const files = { [`${CORE}/f.js`]: 'export const fetch = 1, x = 2;' };
    for (const source of declared) assert.deepEqual(check({ ...files, [`${CORE}/a.js`]: source }), [], source);
    // 선언되지 않은 이름은 그대로 전역이다 (기본값 식·호출 인자 안의 이름 포함)
    const globals = [
      'export function normalize(loc) { return location.x; }',
      'export function s({ timers = {}, now = () => performance.now(), doc = document } = {}) {}',
      'export const f = (a, b) => g(a, document);',
      'const { a = document } = obj;',
    ];
    for (const source of globals) {
      assert.deepEqual(check({ [`${CORE}/a.js`]: source }).map((v) => v.split(': ').pop()), [source.includes('location') ? 'global location' : 'global document'], source);
    }
  });
});
