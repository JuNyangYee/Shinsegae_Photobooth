// 브라우저 확인 도구 (개발 PC 전용, Windows). 의존성 없음: Node 22+ 내장 WebSocket으로 Chrome DevTools Protocol(CDP)에 붙는다.
//
//   npm run check:browser                              시나리오 확인 (가짜 카메라)
//   npm run check:browser -- --camera real             실제 카메라(OBS 가상카메라 등)로
//   npm run check:browser -- --soak --camera real      장시간 실측 기본 10분 (S 수동 사이클 반복, 1분마다 기록)
//   npm run check:browser -- --soak 60 --camera real   더 길게: 분을 준다
//
// 옵션: --camera fake|real, --soak [분] (기본 10), --interval <초> (soak의 S 간격, 기본 20), --csv <경로> (soak 원자료, 기본 logs/soak_*.csv),
//       --chrome <chrome.exe 경로>, --keep-profile (실패 조사용으로 임시 프로필을 지우지 않음)
//
// 하는 일: bin/server/serve.ps1을 남는 포트로 띄우고, %TEMP% 임시 프로필의 headless Chrome을 띄워 앱을 연다.
// 앱 상태는 운영자 D 화면(개발용 정보)의 글자로 읽는다. 앱 코드에 확인 전용 훅을 두지 않는다.
// 끝나면 자신이 띄운 서버·Chrome·임시 프로필만 정리한다. 사용자의 Chrome·OBS는 건드리지 않는다.
// 사진·프레임은 저장하지 않는다. 가짜 카메라에는 얼굴이 없으므로 자동 시작은 확인하지 않는다(docs/SYSTEM.md 1절).
// S 사이클 시나리오는 P(자동 촬영 일시정지)를 켜고 돌린다. 실제 카메라 앞에 사람이 있어도 자동 회차가 끼어들지 않게 (5-2).

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupFile, createCdpSession, restoreFile } from './browser-check-lib.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_FILE = join(repo, 'config', 'presence.local.json');
const SETTINGS_API = '/local-api/presence-settings';
const EFFECT_SETTINGS_FILE = join(repo, 'config', 'effect.local.json');
const EFFECT_SETTINGS_API = '/local-api/effect-settings';
const MODEL_PATTERN = '*blaze_face_short_range.tflite*';
// MediaPipe 사용 통계 전송은 CSP로 막는 것이 의도된 동작이다(docs/SYSTEM.md 1절). 이 주소의 CSP 메시지는 실패로 세지 않는다.
const EXPECTED_CSP_HOST = 'odml.pa.googleapis.com';

// ---------- 옵션 ----------

function parseArgs(argv) {
  const options = { camera: 'fake', soak: 0, interval: 20, csv: '', chrome: '', keepProfile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} needs a value`);
      return argv[i];
    };
    if (arg === '--camera') options.camera = value();
    else if (arg === '--soak') {
      // 분을 생략하면 기본 10분
      const next = argv[i + 1];
      options.soak = next !== undefined && !next.startsWith('--') ? Number(value()) : DEFAULT_SOAK_MINUTES;
    }
    else if (arg === '--interval') options.interval = Number(value());
    else if (arg === '--csv') options.csv = value();
    else if (arg === '--chrome') options.chrome = value();
    else if (arg === '--keep-profile') options.keepProfile = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!['fake', 'real'].includes(options.camera)) throw new Error('--camera must be fake or real');
  if (!(options.soak >= 0) || !(options.interval >= 5)) throw new Error('--soak must be a number of minutes, --interval >= 5');
  return options;
}

const DEFAULT_SOAK_MINUTES = 10;
const options = parseArgs(process.argv.slice(2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...parts) => console.log(`[${elapsed()}]`, ...parts);

// ---------- 정리 대상 (이 도구가 만든 것만) ----------

const owned = { server: null, chrome: null, profile: null, cdp: null, settingsBackup: null, effectBackup: null };
let cleaning = null;

// 조절값 파일은 시작할 때 바이트 그대로(또는 "없음") 백업하고, 모든 정리 경로에서 파일 시스템으로 직접 되돌린다
// (4단계 검수 1: 서버 API로 되돌리면 잘못된 JSON·16KB 초과 원본이 거절돼 시험 값이 남았다).
// 인식 조절값(presence.local.json)과 효과 조절값(effect.local.json, 5-2) 둘 다 같은 방법으로 되돌린다.
function restoreSettings(reason) {
  const details = [];
  let ok = true;
  for (const [label, backup] of [['settings', owned.settingsBackup], ['effect settings', owned.effectBackup]]) {
    if (!backup) continue;
    const result = restoreFile(backup);
    if (!result.ok || result.detail !== 'unchanged') log(`${label} file ${result.ok ? 'OK' : 'FAIL'} (${reason}): ${result.detail}`);
    ok &&= result.ok;
    details.push(`${label}: ${result.detail}`);
  }
  return { ok, detail: details.join('; ') || 'no backup' };
}

function killTree(pid) {
  if (!pid) return;
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
}

async function cleanup() {
  if (cleaning) return cleaning;
  cleaning = (async () => {
    try { owned.cdp?.close(); } catch { /* 이미 닫힘 */ }
    if (owned.chrome) {
      owned.chrome.kill();
      await sleep(500);
      killTree(owned.chrome.pid);
    }
    if (owned.server) killTree(owned.server.pid);
    const restored = restoreSettings('cleanup');
    if (!restored.ok) results.push({ name: '조절값 파일 원래대로', ok: false, detail: restored.detail, ms: 0 });
    if (owned.profile && !options.keepProfile) {
      for (let attempt = 0; attempt < 10 && existsSync(owned.profile); attempt += 1) {
        try { rmSync(owned.profile, { recursive: true, force: true }); } catch { await sleep(500); }
      }
      if (existsSync(owned.profile)) log('WARN temp profile could not be removed:', owned.profile);
    } else if (owned.profile) {
      log('temp profile kept:', owned.profile);
    }
  })();
  return cleaning;
}

process.on('SIGINT', async () => {
  log('interrupted; cleaning up');
  await cleanup();
  process.exit(130);
});
process.on('uncaughtException', async (error) => {
  log('ERROR uncaught', error?.stack ?? error);
  await cleanup();
  process.exit(1);
});

// ---------- 서버·Chrome ----------

function freePort() {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

function findChrome() {
  const candidates = [
    options.chrome,
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google\\Chrome\\Application\\chrome.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Google\\Chrome\\Application\\chrome.exe'),
  ].filter(Boolean);
  const found = candidates.find((path) => existsSync(path));
  if (!found) throw new Error(`chrome.exe not found (tried ${candidates.join(', ')}); use --chrome`);
  return found;
}

async function startServer(port) {
  owned.server = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    join(repo, 'bin', 'server', 'serve.ps1'), '-Port', String(port)], { stdio: 'ignore', windowsHide: true });
  for (let i = 0; i < 60; i += 1) {
    await sleep(250);
    try {
      if ((await fetch(`http://localhost:${port}/`)).ok) return;
    } catch { /* 아직 */ }
  }
  throw new Error(`server did not answer on port ${port}`);
}

// 디버깅 포트는 0(자동)으로 두고 프로필의 DevToolsActivePort 파일에서 읽는다. 다른 Chrome과 포트가 겹치지 않는다.
// --user-data-dir를 항상 주므로 사용자의 Chrome에 붙지 않는다.
async function startChrome() {
  owned.profile = mkdtempSync(join(tmpdir(), 'photobooth-check-'));
  const args = ['--headless=new', `--user-data-dir=${owned.profile}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--window-size=1080,1920', '--autoplay-policy=no-user-gesture-required'];
  // 카메라 권한은 CDP Browser.setPermission으로 준다. --use-fake-ui-for-media-stream은 CDP로 거절한 권한도 자동 수락해 버려
  // 권한 거절 시나리오를 만들 수 없다(확인함).
  if (options.camera === 'fake') args.push('--use-fake-device-for-media-stream');
  owned.chrome = spawn(findChrome(), [...args, 'about:blank'], { stdio: 'ignore' });
  const portFile = join(owned.profile, 'DevToolsActivePort');
  for (let i = 0; i < 80; i += 1) {
    await sleep(250);
    if (!existsSync(portFile)) continue;
    const [port] = readFileSync(portFile, 'utf8').split('\n');
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 아직 */ }
  }
  throw new Error('chrome did not start');
}

// ---------- CDP ----------

// 요청마다 제한 시간(15초), 연결이 끊기면 기다리던 요청을 모두 실패시킨다 (browser-check-lib.mjs, 4단계 검수 2).
function connect(url) {
  return new Promise((resolveConnection, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error('CDP connection timeout')), 10000);
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('CDP connection failed'));
    };
    ws.onopen = () => {
      clearTimeout(timer);
      owned.cdp = createCdpSession(ws, { timeoutMs: 15000 });
      resolveConnection(owned.cdp);
    };
  });
}

// ---------- 앱 조작 ----------

function createApp(cdp, origin) {
  const events = { external: [], csp: [], cspExpected: 0, exceptions: [], console: { error: 0, warning: 0, info: 0, log: 0, other: 0 } };
  let modelBlocked = false;

  cdp.on((data) => {
    if (data.method === 'Network.requestWillBeSent') {
      const url = data.params.request.url;
      if (!url.startsWith(`${origin}/`) && !url.startsWith('blob:') && !url.startsWith('data:')) events.external.push(url);
    } else if (data.method === 'Runtime.exceptionThrown') {
      events.exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    } else if (data.method === 'Runtime.consoleAPICalled') {
      const type = data.params.type === 'warn' ? 'warning' : data.params.type;
      events.console[type in events.console ? type : 'other'] += 1;
    } else if (data.method === 'Log.entryAdded') {
      const { text, level } = data.params.entry;
      if (/Content Security Policy/i.test(text)) {
        if (text.includes(EXPECTED_CSP_HOST)) events.cspExpected += 1;
        else events.csp.push(text);
      }
      if (level === 'error') events.console.error += 1;
    } else if (data.method === 'Fetch.requestPaused') {
      const { requestId } = data.params;
      if (modelBlocked) {
        cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 404, body: Buffer.from('blocked by browser-check\n').toString('base64') });
      } else {
        cdp.send('Fetch.continueRequest', { requestId });
      }
    }
  });

  async function evaluate(expression, sendOptions) {
    const result = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sendOptions);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  const app = {
    cdp,
    events,
    evaluate,
    async init() {
      // 생성 실패 정리 시나리오용: 페이지 스크립트보다 먼저 setInterval·clearInterval을 감싸 살아 있는 타이머를 센다.
      // 앱이 생성 중에만 감싸는 setInterval은 이 위에 놓이므로, 라이브러리가 부른 쪽이 그대로 보인다.
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
        const active = new Map();
        const set = window.setInterval, clear = window.clearInterval;
        window.setInterval = function (fn, ms, ...rest) { const id = set.call(this, fn, ms, ...rest); active.set(id, ms); return id; };
        window.clearInterval = function (id) { active.delete(id); return clear.call(this, id); };
        Object.defineProperty(window, '__photoboothCheck', { value: Object.freeze({
          intervals60s: () => [...active.values()].filter((ms) => ms === 60000).length,
          loaderScripts: () => [...document.querySelectorAll('script[src]')].filter((s) => /vision_wasm.*\\.js/.test(s.src)).length,
        }) });
      })();` });
      await cdp.send('Page.enable');
      await cdp.send('Runtime.enable');
      await cdp.send('Log.enable');
      await cdp.send('Network.enable');
      await cdp.send('Performance.enable');
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
    },
    async open() {
      await cdp.send('Page.navigate', { url: `${origin}/` });
      await app.waitFor('page loaded', () => evaluate("document.readyState === 'complete' && !!document.getElementById('dev-info')"), 15000);
      // D 화면(개발용 정보)을 켠다. 새로 열 때마다 꺼진 상태로 시작한다.
      await app.key('KeyD');
      await app.waitFor('dev info', async () => (await app.dev()).has('session'), 5000);
    },
    async key(code) {
      const key = code.replace(/^Key/, '').toLowerCase();
      for (const type of ['keyDown', 'keyUp']) {
        await cdp.send('Input.dispatchKeyEvent', { type, code, key, windowsVirtualKeyCode: key.toUpperCase().charCodeAt(0) });
      }
    },
    /** D 화면 글자를 줄 머리말 → 값으로. 예: get('session') → 'idle (round 1 by key, completed 1)' */
    async dev() {
      const text = await evaluate("document.getElementById('dev-info').textContent");
      const map = new Map();
      for (const line of text.split('\n')) {
        const match = /^(\S+)\s+:\s?(.*)$/.exec(line);
        if (match && !map.has(match[1])) map.set(match[1], match[2]);
      }
      return map;
    },
    /** D 화면 글자 전체 (들여쓴 하위 줄 `  output   :` 등도 읽을 때) */
    devText: () => evaluate("document.getElementById('dev-info').textContent"),
    /** E 화면 선택 상자를 고른다 (change 이벤트) */
    choose: (key, value) => evaluate(`(() => { const s = document.querySelector('#effect-panel select[data-key="${key}"]');
      s.value = '${value}'; s.dispatchEvent(new Event('change')); return s.value; })()`),
    /** 관람객 안내 문구 (없으면 '') */
    status: () => evaluate("(() => { const s = document.getElementById('status'); return s.hidden ? '' : s.textContent; })()"),
    async waitFor(label, predicate, timeoutMs) {
      const end = Date.now() + timeoutMs;
      let last;
      while (Date.now() < end) {
        if (cdp.closed()) throw new Error(`${label}: ${cdp.closed()}`); // 끊겼으면 기다리지 않는다
        try {
          last = await predicate();
          if (last) return last;
        } catch (error) {
          last = error.message;
        }
        await sleep(250);
      }
      throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)`);
    },
    async blockModel(block) {
      modelBlocked = block;
      if (block) await cdp.send('Fetch.enable', { patterns: [{ urlPattern: MODEL_PATTERN }] });
      else await cdp.send('Fetch.disable');
    },
    async setCameraPermission(setting) {
      await cdp.send('Browser.setPermission', { permission: { name: 'camera' }, setting, origin });
    },
    async metrics() {
      const { metrics } = await cdp.send('Performance.getMetrics');
      return Object.fromEntries(metrics.map(({ name, value }) => [name, value]));
    },
  };
  return app;
}

// D 화면 값 해석
const parseResources = (line = '') => {
  const m = /object URLs (\d+), canvases (\d+), pending jobs (\d+) \(taken (\d+), released (\d+)/.exec(line);
  const prints = Number(/print data (\d+)/.exec(line)?.[1] ?? NaN); // 감열지 인쇄 데이터 (6-1)
  return m ? { urls: +m[1], canvases: +m[2], pending: +m[3], taken: +m[4], released: +m[5], prints } : null;
};
const photoFree = (r) => r && r.urls === 0 && r.canvases === 0 && r.pending === 0 && r.prints === 0;
// D 화면 하위 줄 (`  output   : …`)
const subLine = (text, head) => text.split('\n').find((l) => l.startsWith(`  ${head}`))?.replace(/^\s*\S+\s+:\s?/, '') ?? '';
const parseCompleted = (line = '') => Number(/completed (\d+)/.exec(line)?.[1] ?? NaN);
const parseFps = (line = '') => Number(/@ (\d+(?:\.\d+)?)fps/.exec(line)?.[1] ?? NaN);
const sessionState = (line = '') => line.split(' ')[0];

/** S 한 사이클: 카운트다운 → 결과 → 쿨타임 → 대기. 끝나면 D 값을 돌려준다 */
async function manualCycle(app, { onResult } = {}) {
  const before = parseCompleted((await app.dev()).get('session'));
  await app.key('KeyS');
  await app.waitFor('countdown', async () => sessionState((await app.dev()).get('session')) === 'countdown', 3000);
  await app.waitFor('result', async () => sessionState((await app.dev()).get('session')) === 'result', 6000);
  // 결과 사진이 실제로 보이는지: <img>가 보이고, 디코딩된 크기가 D capture 줄의 캡처 크기와 같다 (4단계 검수 8)
  const shown = await app.waitFor('result image decoded', async () => {
    const image = await app.evaluate(`(() => { const r = document.getElementById('result'); const box = r.getBoundingClientRect();
      return { hidden: r.hidden, complete: r.complete, src: r.src.startsWith('blob:'), w: r.naturalWidth, h: r.naturalHeight,
        boxW: Math.round(box.width), boxH: Math.round(box.height), display: getComputedStyle(r).display }; })()`);
    return image.complete && image.w > 0 ? image : null;
  }, 3000);
  const captured = /^(\d+)x(\d+)/.exec((await app.dev()).get('capture') ?? '');
  if (shown.hidden || !shown.src || shown.display === 'none' || shown.boxW === 0 || shown.boxH === 0) {
    throw new Error(`result image not visible: ${JSON.stringify(shown)}`);
  }
  if (!captured || shown.w !== Number(captured[1]) || shown.h !== Number(captured[2])) {
    throw new Error(`result image ${shown.w}x${shown.h}, capture ${captured?.[0] ?? '?'}`);
  }
  const extra = onResult ? await onResult() : undefined; // 결과 사진이 보이는 동안 확인할 것
  await app.waitFor('cooldown', async () => sessionState((await app.dev()).get('session')) === 'cooldown', 13000);
  await app.waitFor('idle', async () => sessionState((await app.dev()).get('session')) === 'idle', 8000);
  const dev = await app.dev();
  return { completedDelta: parseCompleted(dev.get('session')) - before, resources: parseResources(dev.get('resources')), dev,
    image: `${shown.w}x${shown.h} shown ${shown.boxW}x${shown.boxH}css`, extra };
}

/**
 * P로 자동 촬영을 멈추고 대기 상태가 된 뒤 run을 돌리고, 끝나면 원래대로 되돌린다 (5-2).
 * 실제 카메라 앞에 사람이 있으면 S 사이클의 쿨타임 뒤 자동 회차가 시작돼 대기 상태를 기다리다 실패했다(로그 02).
 */
async function withAutoPaused(app, run) {
  const paused = async () => /^PAUSED/.test((await app.dev()).get('auto') ?? '');
  const wasPaused = await paused();
  if (!wasPaused) {
    await app.key('KeyP');
    await app.waitFor('auto paused', paused, 3000);
  }
  try {
    // 일시정지 전에 시작된 자동 회차(결과·쿨타임)가 끝날 때까지
    await app.waitFor('idle before S', async () => sessionState((await app.dev()).get('session')) === 'idle', 25000);
    return await run();
  } finally {
    if (!wasPaused && !app.cdp.closed()) {
      await app.key('KeyP');
      await app.waitFor('auto resumed', async () => !(await paused()), 3000).catch(() => {});
    }
  }
}

/**
 * 감열지 S 한 장: 효과 캔버스 그림을 기록하고 S → 결과 화면용 이미지(무손실 PNG, 1080x1920)가 셔터 직전 그림과 화소까지 같고,
 * 다른 그림과는 다르며, 종이색·잉크색과 그 사이(경계 화소)뿐이고, 인쇄 데이터가 576x1024 1비트인지 본다 (6-1).
 * withAutoPaused 안에서 부른다.
 */
async function thermalShot(app, { method, check }) {
  await app.evaluate(EFFECT_READER);
  await app.evaluate('window.__fxReader.drawings.length = 0; window.__fxReader.pinned = null; true');
  await sleep(500);
  const { completedDelta, resources, dev, image, extra: c } = await manualCycle(app, { onResult: () => app.evaluate(EFFECT_COMPARE) });
  await app.evaluate('window.__fxReader.drawings.length = 0; true');
  expect(completedDelta === 1, `S completed +${completedDelta}`);
  expect(photoFree(resources), `resources ${dev.get('resources')}`);
  const fx = dev.get('photo-fx') ?? '';
  expect(new RegExp(`^applied thermal 576x1024 ${method} .*same drawing as preview, ${check}`).test(fx), `photo-fx ${fx}`);
  expect(image.startsWith('1080x1920') && /image\/png/.test(dev.get('capture') ?? ''), `result ${image}, capture ${dev.get('capture')}`);
  const print = dev.get('print') ?? '';
  expect(/^576x1024 1-bit, raster 72B\/row 73728B, png \d+B \(IHDR depth 1 color 0\)/.test(print), `print ${print}`);
  // 화면용 이미지(b)는 결과 크기로 미리 확대한다(정수배 최근접 + 경계 1화소만 섞음). CSS 확대 방식은 쓰지 않는다
  expect(c.size === '1080x1920' && c.previewSize === '1080x1920' && c.shutterIndex >= 0, `compare ${JSON.stringify(c)}`);
  expect(c.twoTone.ends.length === 2 && c.twoTone.offLine === 0, `result is not paper/ink only: ${JSON.stringify(c.twoTone)}`);
  expect(c.resultRendering === 'auto' && c.canvasRendering === 'auto', `image-rendering ${c.resultRendering} / ${c.canvasRendering}`);
  // 1비트 점 사진은 인쇄 점 = 화면 화소 1:1 폭 (576/1080, 6-3·8단계)
  expect(c.box.dots && Math.abs(c.box.ratio - 576 / 1080) < 0.001, `result box ${JSON.stringify(c.box)}`);
  const atShutter = c.drawings[c.shutterIndex];
  const others = c.drawings.filter((_, i) => i !== c.shutterIndex);
  expect(atShutter.mismatch === 0, `shutter drawing differs in ${atShutter.mismatch} px (${JSON.stringify(c.drawings)})`);
  expect(others.length > 0 && others.every((d) => d.mismatch > 0), `other drawings: ${JSON.stringify(c.drawings)}`);
  return { fx, print, compare: `shutter drawing 0 px differ, other drawings ${others.map((d) => d.mismatch).join('/')} px,`
    + ` paper/ink ${c.twoTone.ends.join(' / ')} only (pure ${(c.twoTone.pureRatio * 100).toFixed(1)}%, rest edge blends)` };
}

/**
 * 회색조 유화 S 한 장 (8단계 기본값): 결과(JPEG 1080x1920)가 셔터 직전 미리보기 그림과 10x10 블록 평균으로 가장 가깝고(1/255 미만),
 * 미리보기 그림이 무채색(R=G=B)이며 결과도 무채색에 가깝고(JPEG), 인쇄 데이터가 576x1024 1비트이고, 결과 폭이 영역의 정확히 절반인지 본다.
 * withAutoPaused 안에서 부른다.
 */
async function grayOilShot(app, { method = 'blue-noise', check = 'gpu=cpu' } = {}) {
  await app.evaluate(EFFECT_READER);
  await app.evaluate('window.__fxReader.drawings.length = 0; window.__fxReader.pinned = null; true');
  await sleep(500);
  const { completedDelta, resources, dev, image, extra: c } = await manualCycle(app, { onResult: () => app.evaluate(EFFECT_COMPARE) });
  await app.evaluate('window.__fxReader.drawings.length = 0; true');
  expect(completedDelta === 1, `S completed +${completedDelta}`);
  expect(photoFree(resources), `resources ${dev.get('resources')}`);
  const fx = dev.get('photo-fx') ?? '';
  expect(new RegExp(`^applied gray-oil 1080x1920 print ${method} seed \\d+ tick \\d+ \\(same drawing as preview, ${check}\\)`).test(fx), `photo-fx ${fx}`);
  expect(image.startsWith('1080x1920') && /image\/jpeg/.test(dev.get('capture') ?? ''), `result ${image}, capture ${dev.get('capture')}`);
  const print = dev.get('print') ?? '';
  expect(/^576x1024 1-bit, raster 72B\/row 73728B, png \d+B \(IHDR depth 1 color 0\)/.test(print), `print ${print}`);
  expect(c.size === '1080x1920' && c.previewSize === '1080x1920' && c.shutterIndex >= 0, `compare ${JSON.stringify(c)}`);
  const atShutter = c.drawings[c.shutterIndex];
  const others = c.drawings.filter((_, i) => i !== c.shutterIndex);
  expect(atShutter.diff < 1 && others.length > 0 && others.every((d) => d.diff > atShutter.diff), `block diff: ${JSON.stringify(c.drawings)}`);
  // 무채색: 미리보기 그림은 화소마다 R=G=B, 결과는 JPEG라 1 이하 허용
  expect(c.drawings.every((d) => d.chroma === 0), `preview chroma ${c.drawings.map((d) => d.chroma).join('/')}`);
  expect(c.resultChroma <= 1, `result chroma ${c.resultChroma}`);
  // 연속 톤 사진은 영역 폭의 정확히 절반 (1080 화면 1/2, 4K 1:1, 8단계)
  expect(!c.box.dots && Math.abs(c.box.ratio - 0.5) < 0.001, `result box ${JSON.stringify(c.box)}`);
  return { fx, print, compare: `shutter drawing block diff ${atShutter.diff}/255, other drawings ${others.map((d) => d.diff).join('/')},`
    + ` max chroma preview 0 / result ${c.resultChroma}, result ${c.box.width}px = ${c.box.ratio} of stage` };
}

// 효과 캔버스에 새 그림이 그려진 화면 갱신마다 화소를 복사해 둔다(최근 8장, 페이지 메모리 안에서만).
// preserveDrawingBuffer가 false라, 앱의 requestAnimationFrame 콜백 뒤 같은 화면 갱신 안에서 읽어야 그림이 남아 있다.
// 셔터 순간(카운트다운 숫자가 숨겨지는 순간)도 기록하고, 그때 마지막 그림을 따로 남긴다(결과가 늦게 나와도 8장 밖으로 밀리지 않게, 6-1).
const EFFECT_READER = `(() => {
  if (window.__fxReader) return true;
  const c = document.getElementById('effect');
  const gl = c.getContext('webgl2');
  const r = window.__fxReader = { drawings: [], shutterAt: null };
  const probe = new Uint8Array(8 * 8 * 4);
  new MutationObserver(() => {
    const cd = document.getElementById('countdown');
    if (cd.hidden && r.wasCounting) { r.shutterAt = performance.now(); r.pinned = r.drawings[r.drawings.length - 1] ?? null; }
    r.wasCounting = !cd.hidden;
  }).observe(document.getElementById('countdown'), { attributes: true, attributeFilter: ['hidden'] });
  const loop = () => {
    requestAnimationFrame(loop);
    const W = c.width, H = c.height;
    if (c.hidden || W < 16) return;
    gl.readPixels((W >> 1) - 4, (H >> 1) - 4, 8, 8, gl.RGBA, gl.UNSIGNED_BYTE, probe);
    let any = 0; for (let i = 0; i < probe.length; i += 4) any += probe[i] + probe[i + 1] + probe[i + 2];
    if (any === 0) return; // 이 화면 갱신에서는 새로 그리지 않았다
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    r.drawings.push({ at: performance.now(), W, H, buf });
    if (r.drawings.length > 8) r.drawings.shift();
  };
  requestAnimationFrame(loop);
  return true;
})()`;

// 결과 사진(#result)과 기록한 그림들을 10x10 블록 평균(RGB)으로 비교한다. 셔터 직전 그림 = 셔터 전에 마지막으로 그린 것
const EFFECT_COMPARE = `(() => {
  const r = window.__fxReader;
  const img = document.getElementById('result');
  const W = img.naturalWidth, H = img.naturalHeight, B = 10, gw = Math.floor(W / B), gh = Math.floor(H / B);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  const res = x.getImageData(0, 0, W, H).data; cv.width = 0;
  const grid = (get) => { const g = new Float64Array(gw * gh * 3);
    for (let y = 0; y < gh * B; y++) for (let xx = 0; xx < gw * B; xx++) { const i = get(xx, y), k = (Math.floor(y / B) * gw + Math.floor(xx / B)) * 3;
      g[k] += i[0]; g[k + 1] += i[1]; g[k + 2] += i[2]; }
    for (let k = 0; k < g.length; k++) g[k] /= B * B; return g; };
  const resGrid = grid((xx, y) => { const i = (y * W + xx) * 4; return [res[i], res[i + 1], res[i + 2]]; });
  const diff = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length; };
  // 화소가 정확히 다른 수 (감열지 결과는 무손실 PNG라 셔터 직전 그림과 0이어야 한다, 6-1)
  const mismatch = (d) => { let c = 0; for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4, j = ((d.H - 1 - y) * d.W + xx) * 4;
    if (res[i] !== d.buf[j] || res[i + 1] !== d.buf[j + 1] || res[i + 2] !== d.buf[j + 2]) c++; } return c; };
  // 감열지 화면은 종이색·잉크색 두 색과 그 사이(경계 화소)뿐이다: 화소마다 R로 비율을 구해 G·B가 같은 비율인지, 순수 두 색 비율
  const ends = (() => { const c = new Map(); for (let i = 0; i < res.length; i += 4) { const k = res[i] + ',' + res[i + 1] + ',' + res[i + 2]; c.set(k, (c.get(k) ?? 0) + 1); }
    return [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => k.split(',').map(Number)).sort((a, b) => a[0] - b[0]); })();
  let offLine = 0, pure = 0;
  if (ends.length === 2) { const [ink, paper] = ends; for (let i = 0; i < res.length; i += 4) {
    const t = (res[i] - ink[0]) / (paper[0] - ink[0]);
    if (Math.abs(res[i + 1] - (ink[1] + t * (paper[1] - ink[1]))) > 1.5 || Math.abs(res[i + 2] - (ink[2] + t * (paper[2] - ink[2]))) > 1.5) offLine++;
    if (t === 0 || t === 1) pure++; } }
  // 채도(무채색 확인, 8단계): 화소마다 RGB 최댓값 − 최솟값의 최댓값
  const chroma = (a) => { let m = 0; for (let i = 0; i < a.length; i += 4) { const hi = Math.max(a[i], a[i + 1], a[i + 2]), lo = Math.min(a[i], a[i + 1], a[i + 2]); if (hi - lo > m) m = hi - lo; } return m; };
  const list = r.pinned && !r.drawings.includes(r.pinned) ? [r.pinned, ...r.drawings] : r.drawings;
  const out = list.filter((d) => d.W === W && d.H === H).map((d) => ({
    beforeShutter: d.at < r.shutterAt, msFromShutter: Math.round(d.at - r.shutterAt),
    diff: +diff(resGrid, grid((xx, y) => { const i = ((d.H - 1 - y) * d.W + xx) * 4; return [d.buf[i], d.buf[i + 1], d.buf[i + 2]]; })).toFixed(3),
    mismatch: mismatch(d), chroma: chroma(d.buf),
  }));
  // 결과 출력물 폭: 9:16 영역 대비 비율, 1비트 점 사진 표시(is-dots)
  const photoBox = document.querySelector('.result-photo').getBoundingClientRect(), stageBox = document.getElementById('stage').getBoundingClientRect();
  const box = { width: +photoBox.width.toFixed(3), ratio: +(photoBox.width / stageBox.width).toFixed(4), dots: document.getElementById('result-card').classList.contains('is-dots') };
  const shutterDrawing = out.map((d) => d.beforeShutter).lastIndexOf(true);
  return { size: W + 'x' + H, previewSize: r.drawings.length ? r.drawings.at(-1).W + 'x' + r.drawings.at(-1).H : '-', shutterAt: r.shutterAt, drawings: out, shutterIndex: shutterDrawing,
    resultChroma: chroma(res), box,
    twoTone: { ends: ends.map((c) => c.join(',')), offLine, pureRatio: +(pure / (W * H)).toFixed(3) }, resultRendering: getComputedStyle(img).imageRendering, canvasRendering: getComputedStyle(document.getElementById('effect')).imageRendering };
})()`;

// ---------- 시나리오 ----------

const results = [];
async function scenario(name, run) {
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started });
    log('PASS', name, detail ? `-- ${detail}` : '');
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - started });
    log('FAIL', name, '--', error.message);
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitReady(app) {
  await app.waitFor('camera ready', async () => /^ready/.test((await app.dev()).get('status') ?? ''), 20000);
  await app.waitFor('detector running', async () => /^running, health ok/.test((await app.dev()).get('detector') ?? ''), 20000);
  await app.waitFor('settings loaded', async () => !/^loading/.test((await app.dev()).get('settings') ?? 'loading'), 10000);
}

async function runScenarios(app, origin) {
  await scenario('페이지 로드, 카메라 ready, 감지기 ok', async () => {
    await app.setCameraPermission('granted');
    await app.open();
    await waitReady(app);
    const dev = await app.dev();
    expect(dev.get('delegate') && dev.get('delegate') !== '-', `delegate ${dev.get('delegate')}`);
    expect(dev.get('guidance') === 'none', `guidance ${dev.get('guidance')}`);
    expect((await app.status()) === '', 'visitor status message shown');
    // 화면 서체 (7-2): 서체 세 개(Pretendard 400·500, Noto Serif KR 300)를 실제로 불러 쓸 수 있고, 받은 에셋이 모두 200.
    // 세리프·Medium은 숨겨진 화면(카운트다운·준비 중·운영자 패널)에서만 쓰여 아직 안 불렸을 수 있어 document.fonts.load로 부른다
    const assets = await app.evaluate(`(async () => {
      await Promise.all(['400 16px Pretendard', '500 16px Pretendard', '300 16px "Noto Serif KR"'].map((f) => document.fonts.load(f, '준비 3')));
      const fonts = [...document.fonts].map((f) => f.family.replace(/"/g, '') + ' ' + f.weight + ' ' + f.status);
      const files = performance.getEntriesByType('resource').filter((e) => new URL(e.name).pathname.startsWith('/assets/'))
        .map((e) => ({ path: new URL(e.name).pathname, status: e.responseStatus }));
      return { fonts, files }; })()`);
    const wanted = ['Pretendard 400 loaded', 'Pretendard 500 loaded', 'Noto Serif KR 300 loaded'];
    expect(wanted.every((f) => assets.fonts.includes(f)), `fonts ${assets.fonts.join(', ')}`);
    const failed = assets.files.filter((f) => f.status !== 200);
    expect(assets.files.length >= 3 && failed.length === 0, `assets ${JSON.stringify(failed.length ? failed : assets.files)}`);
    return `delegate ${dev.get('delegate')}, ${dev.get('video')}, detect @ ${parseFps(dev.get('detect'))}fps, settings ${dev.get('settings')};`
      + ` fonts loaded, ${assets.files.length} assets 200`;
  });

  await scenario('S 수동 한 사이클 (결과 사진 표시 → 쿨타임 → 대기), 사진 자원 0', async () => {
    const { completedDelta, resources, dev, image } = await withAutoPaused(app, () => manualCycle(app));
    expect(completedDelta === 1, `completed +${completedDelta}`);
    expect(photoFree(resources), `resources ${dev.get('resources')}`);
    return `${dev.get('capture')?.split(',')[0]}; result image ${image}; ${dev.get('resources')}`;
  });

  await scenario('사진 효과 미리보기: 캔버스 표시, 초당 그림 = fps, 컨텍스트 손실 → 원본 미리보기 → 복구', async () => {
    const line = await app.waitFor('effect running', async () => {
      const value = (await app.dev()).get('effect') ?? '';
      return /^running, \d+x\d+/.test(value) ? value : null;
    }, 10000);
    await sleep(2500); // 초당 그림 수는 최근 1초로 잰다
    const running = (await app.dev()).get('effect') ?? '';
    const m = /fps (\d+) -> (\d+) drawings\/s/.exec(running);
    expect(m && Math.abs(Number(m[2]) - Number(m[1])) <= 1, `drawings/s: ${running}`);
    const layout = await app.evaluate(`(() => { const c = document.getElementById('effect'), v = document.getElementById('preview');
      const box = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); };
      return { hidden: c.hidden, canvas: box(c), video: box(v), canvasTransform: getComputedStyle(c).transform, videoMirrored: v.classList.contains('is-mirrored') }; })()`);
    expect(!layout.hidden && layout.canvas === layout.video, `canvas ${JSON.stringify(layout)}`);
    expect(layout.canvasTransform === 'none', `effect canvas must not be CSS-mirrored: ${layout.canvasTransform}`);
    // 컨텍스트 손실 (WEBGL_lose_context) → 캔버스 숨김(원본 미리보기), 카메라 그대로 → 되살리면 다시 효과
    await app.evaluate("window.__loseEffect = document.getElementById('effect').getContext('webgl2').getExtension('WEBGL_lose_context'); __loseEffect.loseContext(); true");
    await app.waitFor('context-lost', async () => /^context-lost/.test((await app.dev()).get('effect') ?? ''), 5000);
    const lost = await app.evaluate("({ hidden: document.getElementById('effect').hidden, playing: !document.getElementById('preview').paused })");
    const cameraWhileLost = (await app.dev()).get('status') ?? '';
    expect(lost.hidden && lost.playing && /^ready/.test(cameraWhileLost), `while lost: ${JSON.stringify(lost)} camera ${cameraWhileLost}`);
    await app.evaluate('__loseEffect.restoreContext(); true');
    const restored = await app.waitFor('effect restored', async () => {
      const value = (await app.dev()).get('effect') ?? '';
      return /^running, .*context lost 1x/.test(value) ? value : null;
    }, 8000);
    expect(!(await app.evaluate("document.getElementById('effect').hidden")), 'canvas hidden after restore');
    return `${line.split(', fps')[0]}; ${m[2]} drawings/s at fps ${m[1]}; context lost → camera preview → restored`;
  });

  await scenario('촬영 결과(회색조 유화 기본값): 1080x1920 JPEG = 셔터 순간 미리보기 그림, 미리보기·결과 무채색, 인쇄 데이터 576x1024 1비트(블루 노이즈, GPU = CPU), 결과 폭 1/2', async () => withAutoPaused(app, async () => {
    const output = subLine(await app.devText(), 'output');
    expect(/^gray-oil \(input luma Rec\.709 -> oil2f -> gray\), print data on photo: paper 576 blue-noise/.test(output), `output ${output}`);
    const { fx, print, compare } = await grayOilShot(app);
    return `${fx.split(' (applied')[0]}; ${compare}; print ${print.split(', black')[0]}`;
  }));

  await scenario('효과 WebGL2 생성 실패 → 원본 미리보기, 카메라·감지기·S 그대로', async () => {
    // 페이지 스크립트보다 먼저 효과 캔버스의 webgl2만 null을 돌려주게 한다 (감지기의 WebGL은 그대로)
    const { identifier } = await app.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        if (this.id === 'effect' && type === 'webgl2') return null;
        return original.call(this, type, ...rest);
      };
    })();` });
    try {
      await app.open();
      await waitReady(app);
      const dev = await app.dev();
      const effect = dev.get('effect') ?? '';
      expect(/^fallback \(webgl2-unavailable/.test(effect), `effect ${effect}`);
      expect(await app.evaluate("document.getElementById('effect').hidden"), 'effect canvas visible in fallback');
      expect((await app.status()) === '', 'visitor status message shown in fallback');
      const { completedDelta, resources, dev: after } = await withAutoPaused(app, () => manualCycle(app));
      // 회색조 유화 기본값: 원본 사진(결과 크기)을 입력 회색조·레벨로, 인쇄 데이터도 그 사진에서 (8단계)
      expect(/^RAW PHOTO gray-oil 1080x1920 /.test(after.get('photo-fx') ?? ''), `photo-fx ${after.get('photo-fx')}`);
      expect(/^576x1024 1-bit/.test(after.get('print') ?? ''), `print ${after.get('print')}`);
      expect(completedDelta === 1, `S completed +${completedDelta}`);
      expect(resources && resources.urls === 0 && resources.canvases === 0 && resources.pending === 0, 'resources not released');
      return `${effect}; camera ready, detector ok, S cycle ok`;
    } finally {
      await app.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
  });

  await scenario('출력 모드 3단계(E): 끔 1080x1920 JPEG, 회색조 1080x1920 JPEG, 감열지 Atkinson(CPU) PNG = 미리보기, 용지 384점·감마 저장 → 새로고침 유지', async () => {
    const details = [];
    try {
      await app.open();
      await waitReady(app);
      await app.key('KeyE');
      await app.waitFor('effect panel open', () => app.evaluate("!document.getElementById('effect-panel').hidden"), 5000);
      for (const mode of ['off', 'gray']) {
        await app.choose('outputMode', mode);
        await app.waitFor(`output ${mode}`, async () => subLine(await app.devText(), 'output') === mode, 5000);
        const canvas = await app.evaluate("(() => { const c = document.getElementById('effect'); return c.width + 'x' + c.height; })()");
        expect(canvas === '1080x1920', `${mode}: canvas ${canvas}`);
        const { completedDelta, resources, dev, image } = await withAutoPaused(app, () => manualCycle(app));
        const fx = dev.get('photo-fx') ?? '';
        expect(completedDelta === 1 && photoFree(resources), `${mode}: S +${completedDelta}, ${dev.get('resources')}`);
        expect(new RegExp(`^applied ${mode === 'gray' ? 'gray ' : ''}1080x1920 .*same drawing as preview`).test(fx), `${mode}: photo-fx ${fx}`);
        expect(image.startsWith('1080x1920') && /image\/jpeg/.test(dev.get('capture') ?? ''), `${mode}: ${image}, ${dev.get('capture')}`);
        expect(dev.get('print') === '-', `${mode}: print ${dev.get('print')}`);
        details.push(`${mode} ${image.split(' ')[0]} jpeg`);
      }
      await app.choose('outputMode', 'thermal');
      await app.choose('bwStyle', 'tone'); // 점 방식은 톤 점·질감 강조 점에서 쓴다 (7-1)
      await app.choose('dither', 'bayer');
      await app.waitFor('bayer', async () => /^thermal 576x1024 bayer \(style tone\)/.test(subLine(await app.devText(), 'output')), 5000);
      const bayerCanvas = await app.evaluate("(() => { const c = document.getElementById('effect'); return c.width + 'x' + c.height; })()");
      expect(bayerCanvas === '1080x1920', `bayer canvas ${bayerCanvas}`);
      await app.choose('dither', 'atkinson');
      const shot = await withAutoPaused(app, () => thermalShot(app, { method: 'atkinson', check: 'cpu dither' }));
      details.push(`atkinson ${shot.compare}`);
      // 용지 384점(58mm), 감마 1.3 → 저장 → 새로고침
      await app.choose('paperDots', '384');
      await app.evaluate(`(() => { const i = document.querySelector('#effect-panel input[data-key="gamma"]'); i.value = '1.3'; i.dispatchEvent(new Event('input')); return true; })()`);
      await app.waitFor('paper 384', async () => /^thermal 384x683 atkinson/.test(subLine(await app.devText(), 'output')), 5000);
      await app.evaluate("document.querySelector('#effect-panel button[data-action=\"save\"]').click(); true");
      await app.waitFor('saved message', () => app.evaluate("document.querySelector('#effect-panel [data-message]').textContent === '파일에 저장했습니다.'"), 5000);
      await app.key('KeyE');
      await app.open(); // 새로고침
      await waitReady(app);
      const kept = await app.waitFor('kept after reload', async () => {
        const text = await app.devText();
        return /^thermal 384x683 atkinson/.test(subLine(text, 'output')) && /output thermal atkinson paper 384 .*gamma 1\.3/.test(subLine(text, 'values'))
          ? subLine(text, 'output') : null;
      }, 10000);
      const canvas = await app.evaluate("(() => { const c = document.getElementById('effect'); return c.width + 'x' + c.height + ' ' + getComputedStyle(c).imageRendering; })()");
      expect(canvas === '1080x1920 auto', `canvas after reload ${canvas}`);
      const api = await app.evaluate(`(async () => (await (await fetch('${EFFECT_SETTINGS_API}', { cache: 'no-store' })).json()))()`);
      expect(api.version === 1 && api.settings.outputMode === 'thermal' && api.settings.dither === 'atkinson' && api.settings.paperDots === 384
        && api.settings.gamma === 1.3, `file ${JSON.stringify(api)}`);
      details.push(`saved → reload: ${kept.split(',')[0]}, canvas ${canvas}, file version 1 with output keys`);
      return details.join('; ');
    } finally {
      const restored = restoreSettings('after output mode scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
    }
  });

  await scenario('흑백 스타일(7-1) GPU = CPU·결정성·그림 사이 바뀐 점 (합성 이미지, 붓 결 선·흐름 선·질감 강조 점, 용지 576·384)', async () => {
    const outcome = await app.evaluate(`(async () => {
      const R = await import('/effect/oil-renderer.js'); const T = await import('/core/thermal.js');
      const C = await import('/config/config.js'); const S = await import('/config/effect-settings.js');
      // 합성 시험 이미지 (카메라 영상 아님): 동심원 + 방사 띠 + 경사 (흐름장이 생기게)
      const src = new OffscreenCanvas(1080, 1920); const x = src.getContext('2d');
      const g = x.createLinearGradient(0, 0, 1080, 1920); g.addColorStop(0, '#203040'); g.addColorStop(1, '#f0d0a0'); x.fillStyle = g; x.fillRect(0, 0, 1080, 1920);
      for (let i = 0; i < 14; i++) { x.strokeStyle = i % 2 ? '#401010' : '#e0e8f0'; x.lineWidth = 18; x.beginPath(); x.arc(540, 700, 40 + i * 32, 0, 7); x.stroke(); }
      for (let i = 0; i < 24; i++) { x.fillStyle = i % 2 ? '#a03030' : '#30a040'; x.fillRect(i * 45, 1300, 45, 500); }
      const r = R.createOilRenderer({ canvas: new OffscreenCanvas(4, 4), display: C.config.thermalDisplay });
      const rows = []; let first = true;
      try {
        for (const paperDots of [576, 384]) for (const [bwStyle, dither] of [['stroke', 'blue-noise'], ['flow', 'blue-noise'], ['texture', 'blue-noise'], ['texture', 'bayer']]) {
          const settings = S.normalizeEffectSettings({ ...C.config.effect, outputMode: 'thermal', bwStyle, dither, paperDots }, C.config.effect).settings;
          const opt = { settings, width: 1080, height: 1920, seed: 11, output: 'print' };
          const out = r.render(first ? src : null, opt); first = false;
          const again = r.render(null, opt);
          const next = r.render(null, { ...opt, seed: 12 });
          const cpu = out.thr ? T.ditherWithThresholds(out.gray, out.thr) : T.ditherThreshold(out.gray, out.printWidth, out.printHeight, T.thresholdMap(dither));
          let diff = 0, repeat = 0, changed = 0, white = 0;
          for (let i = 0; i < cpu.length; i++) { diff += cpu[i] !== out.mask[i]; repeat += again.mask[i] !== out.mask[i]; changed += next.mask[i] !== out.mask[i]; white += out.mask[i]; }
          rows.push({ size: out.printWidth + 'x' + out.printHeight, style: bwStyle + (bwStyle === 'texture' ? '/' + dither : ''), dots: cpu.length, diff, repeat,
            changed: +(changed / cpu.length * 100).toFixed(2), white: +(white / cpu.length).toFixed(3), thr: Boolean(out.thr) });
        }
      } finally { r.dispose(); }
      return rows;
    })()`, { timeout: 60000 });
    for (const row of outcome) {
      expect(row.diff === 0, `${row.size} ${row.style}: GPU != CPU in ${row.diff} of ${row.dots} dots`);
      expect(row.repeat === 0, `${row.size} ${row.style}: same seed and frame differ in ${row.repeat} dots`);
      expect(row.thr === !row.style.startsWith('texture'), `${row.size} ${row.style}: thresholds ${row.thr}`);
      expect(row.white > 0.05 && row.white < 0.95, `${row.size} ${row.style}: white ${row.white}`);
      expect(row.changed > 0 && row.changed < 30, `${row.size} ${row.style}: changed ${row.changed}%`);
    }
    return outcome.map((r) => `${r.size} ${r.style} 0/${r.dots} differ, repeat 0, next drawing ${r.changed}%`).join('; ');
  });

  await scenario('GPU 문턱값 디더 = CPU (비트 단위, 합성 이미지, 용지 576·384), 1비트 PNG 왕복, 방식별 CPU 디더 시간', async () => {
    const outcome = await app.evaluate(`(async () => {
      const R = await import('/effect/oil-renderer.js'); const T = await import('/core/thermal.js'); const PE = await import('/effect/photo-effect.js');
      const C = await import('/config/config.js'); const S = await import('/config/effect-settings.js');
      // 합성 시험 이미지 (카메라 영상 아님): 가로 회색 경사 + 세로 색 경사 + 결정적 잡음
      const src = new OffscreenCanvas(1080, 1920); const x = src.getContext('2d');
      const img = x.createImageData(1080, 1920);
      for (let y = 0; y < 1920; y++) for (let i = 0; i < 1080; i++) { const k = (y * 1080 + i) * 4, n = ((i * 7919 + y * 104729) % 61) - 30;
        img.data[k] = Math.min(255, Math.max(0, (i * 255) / 1079 + n)); img.data[k + 1] = Math.min(255, Math.max(0, (y * 255) / 1919 + n)); img.data[k + 2] = (i ^ y) & 255; img.data[k + 3] = 255; }
      x.putImageData(img, 0, 0);
      const r = R.createOilRenderer({ canvas: new OffscreenCanvas(4, 4), display: C.config.thermalDisplay });
      const rows = []; let first = true;
      try {
        for (const paperDots of [576, 384]) for (const dither of ['bayer', 'blue-noise']) {
          const settings = S.normalizeEffectSettings({ ...C.config.effect, outputMode: 'thermal', bwStyle: 'tone', dither, paperDots, gamma: 1.2, contrast: 1.1 }, C.config.effect).settings;
          const out = r.render(first ? src : null, { settings, width: 1080, height: 1920, seed: 11, output: 'print' }); first = false;
          const cpu = T.ditherThreshold(out.gray, out.printWidth, out.printHeight, T.thresholdMap(dither));
          let diff = 0, white = 0; for (let i = 0; i < cpu.length; i++) { diff += cpu[i] !== out.mask[i] ? 1 : 0; white += out.mask[i]; }
          // 1비트 PNG → 브라우저가 디코드한 화소가 마스크와 같은지
          const png = await T.encodeOneBitPng(out.mask, out.printWidth, out.printHeight, PE.deflateZlib);
          const bmp = await createImageBitmap(new Blob([png], { type: 'image/png' }));
          const c2 = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d'); c2.drawImage(bmp, 0, 0);
          const px = c2.getImageData(0, 0, bmp.width, bmp.height).data; let pngDiff = 0;
          for (let i = 0; i < out.mask.length; i++) pngDiff += px[i * 4] !== (out.mask[i] ? 255 : 0) ? 1 : 0;
          const times = {};
          for (const m of ['atkinson', 'floyd-steinberg', 'bayer', 'blue-noise']) { const t0 = performance.now(); for (let k = 0; k < 5; k++) T.dither(out.gray, out.printWidth, out.printHeight, m); times[m] = +((performance.now() - t0) / 5).toFixed(2); }
          rows.push({ size: out.printWidth + 'x' + out.printHeight, dither, diff, dots: cpu.length, white: +(white / cpu.length).toFixed(3),
            png: { bytes: png.length, header: T.readPngHeader(png), size: bmp.width + 'x' + bmp.height, diff: pngDiff }, times });
        }
      } finally { r.dispose(); }
      return rows;
    })()`, { timeout: 60000 });
    for (const row of outcome) {
      expect(row.diff === 0, `${row.size} ${row.dither}: GPU != CPU in ${row.diff} of ${row.dots} dots`);
      expect(row.white > 0.05 && row.white < 0.95, `${row.size} ${row.dither}: white ${row.white}`);
      expect(row.png.diff === 0 && row.png.header.bitDepth === 1 && row.png.header.colorType === 0 && row.png.size === row.size, `${row.size} png ${JSON.stringify(row.png)}`);
    }
    const t = outcome[0].times;
    return `${outcome.map((r) => `${r.size} ${r.dither} 0/${r.dots} differ`).join(', ')}; PNG depth 1 round-trip 0 differ (${outcome[0].png.bytes}B);`
      + ` CPU dither 576x1024: atkinson ${t.atkinson}ms, floyd-steinberg ${t['floyd-steinberg']}ms, bayer ${t.bayer}ms, blue-noise ${t['blue-noise']}ms`;
  });

  await scenario('흑백 스타일 4가지(E, 감열지): 미리보기 캔버스 1080x1920·D 표시, 붓 결 선·흐름 선·질감 강조 점 결과 = 셔터 순간 그림(화면용 PNG 화소까지, 인쇄 576x1024), 저장 → 새로고침 유지 (파일은 원래대로)', async () => {
    const details = [];
    try {
      await app.open();
      await waitReady(app);
      await app.key('KeyE');
      await app.waitFor('effect panel open', () => app.evaluate("!document.getElementById('effect-panel').hidden"), 5000);
      await app.choose('outputMode', 'thermal'); // 흑백 스타일은 감열지에서만 (8단계부터 기본 모드는 회색조 유화)
      for (const [style, screen] of [['tone', 'blue-noise'], ['texture', 'blue-noise'], ['flow', 'flow-lines'], ['stroke', 'stroke-lines']]) {
        await app.choose('bwStyle', style);
        await app.waitFor(`style ${style}`, async () => new RegExp(`^thermal 576x1024 ${screen} \\(style ${style}\\)`).test(subLine(await app.devText(), 'output')), 5000);
        const canvas = await app.evaluate("(() => { const c = document.getElementById('effect'); return c.width + 'x' + c.height + (c.hidden ? ' hidden' : ''); })()");
        expect(canvas === '1080x1920', `${style}: canvas ${canvas}`);
        const disabled = await app.evaluate(`['dither', 'bwTexture', 'lineSpacing'].map((k) => document.querySelector('#effect-panel [data-key="' + k + '"]:is(select, input)').disabled).join(',')`);
        const want = { tone: 'false,true,true', texture: 'false,false,true', flow: 'true,false,false', stroke: 'true,false,false' }[style];
        expect(disabled === want, `${style}: disabled dither,bwTexture,lineSpacing ${disabled}`);
        details.push(`${style} ${screen}`);
      }
      for (const [style, method] of [['stroke', 'stroke-lines'], ['flow', 'flow-lines'], ['texture', 'blue-noise']]) {
        await app.choose('bwStyle', style);
        const shot = await withAutoPaused(app, () => thermalShot(app, { method, check: 'gpu=cpu' }));
        details.push(`${style} shot: ${shot.compare.split(',')[0]}`);
      }
      // 흐름 선·간격 6점 저장 → 새로고침
      await app.choose('bwStyle', 'flow');
      await app.evaluate(`(() => { const i = document.querySelector('#effect-panel input[data-key="lineSpacing"]'); i.value = '6'; i.dispatchEvent(new Event('input')); return true; })()`);
      await app.evaluate("document.querySelector('#effect-panel button[data-action=\"save\"]').click(); true");
      await app.waitFor('saved message', () => app.evaluate("document.querySelector('#effect-panel [data-message]').textContent === '파일에 저장했습니다.'"), 5000);
      await app.key('KeyE');
      await app.open();
      await waitReady(app);
      const kept = await app.waitFor('kept after reload', async () => {
        const text = await app.devText();
        return /^thermal 576x1024 flow-lines \(style flow\)/.test(subLine(text, 'output')) && /style flow texture 1 lines 6/.test(subLine(text, 'values')) ? subLine(text, 'values') : null;
      }, 10000);
      const api = await app.evaluate(`(async () => (await (await fetch('${EFFECT_SETTINGS_API}', { cache: 'no-store' })).json()))()`);
      expect(api.version === 1 && api.settings.bwStyle === 'flow' && api.settings.lineSpacing === 6, `file ${JSON.stringify(api)}`);
      details.push(`saved → reload: ${/style flow texture 1 lines 6/.exec(kept)[0]}, file version 1`);
      return details.join('; ');
    } finally {
      const restored = restoreSettings('after bw style scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
    }
  });

  await scenario('효과 조절(E) → 즉시 반영 → 저장 → 새로고침 뒤 유지, 효과 조절값 API (파일은 원래대로)', async () => {
    try {
      await app.open();
      await waitReady(app);
      await app.key('KeyE');
      await app.waitFor('effect panel open', () => app.evaluate("!document.getElementById('effect-panel').hidden"), 5000);
      await app.evaluate(`(() => { const i = document.querySelector('#effect-panel input[data-key="fps"]'); i.value = '12'; i.dispatchEvent(new Event('input')); return true; })()`);
      await sleep(2000);
      const live = (await app.dev()).get('effect') ?? '';
      expect(/fps 12 -> 1[1-3] drawings\/s/.test(live), `after slider: ${live}`);
      await app.evaluate("document.querySelector('#effect-panel button[data-action=\"save\"]').click(); true");
      await app.waitFor('saved message', () => app.evaluate("document.querySelector('#effect-panel [data-message]').textContent === '파일에 저장했습니다.'"), 5000);
      await app.key('KeyE');
      await app.open(); // 새로고침
      await waitReady(app);
      const kept = await app.waitFor('fps 12 after reload', async () => {
        const value = (await app.dev()).get('effect') ?? '';
        return /fps 12 ->/.test(value) ? value : null;
      }, 10000);
      const api = await app.evaluate(`(async () => {
        const url = '${EFFECT_SETTINGS_API}';
        const get = await fetch(url, { cache: 'no-store' });
        const body = await get.json();
        const noHeader = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const other = await fetch('/local-api/Effect-Settings', { cache: 'no-store' });
        return { get: get.status, fps: body.settings.fps, version: body.version, noHeader: noHeader.status, other: other.status };
      })()`);
      expect(api.get === 200 && api.fps === 12 && api.version === 1, `GET ${JSON.stringify(api)}`);
      expect(api.noHeader === 403 && api.other === 404, `rejects ${JSON.stringify(api)}`);
      return `slider fps 12 applied live; saved; after reload ${kept.split(', boil')[0].replace(/^running, /, '')}; API GET 200, no header 403, other case 404`;
    } finally {
      const restored = restoreSettings('after effect settings scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
    }
  });

  await scenario('결과 효과 렌더 실패 3가지(예외·INVALID_OPERATION·컨텍스트 손실) → 원본 사진으로 대신, 인쇄 읽기만 실패 2가지 → 유화 사진 그대로·인쇄 데이터는 사진에서 CPU로 (관람객 흐름 계속)', async () => {
    // 효과 캔버스 컨텍스트의 결과 화소 읽기만 건드린다(회색조 유화 결과는 1080x1920 화소가 먼저, 인쇄 데이터는 4점씩 묶은 144x1024.
    // 미리보기는 읽지 않는다).
    // 감지기의 WebGL은 그대로 (5단계 검수 1의 실제 WebGL 재현)
    // - throw: 예외를 던진다
    // - invalid: 결과 FBO(RGBA8)를 RGB 형식으로 읽어 실제 INVALID_OPERATION을 낸다 (화소는 0으로 남는다)
    // - lose: 읽기 직전에 WEBGL_lose_context로 컨텍스트를 잃게 한다 (화소는 0으로 남는다)
    // - print-throw·print-invalid: 사진 읽기는 그대로 두고 두 번째 큰 읽기(인쇄용 회색 144x1024)만 실패시킨다 (8단계 검수 1)
    const { identifier } = await app.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
      const original = WebGL2RenderingContext.prototype.readPixels;
      WebGL2RenderingContext.prototype.readPixels = function (x, y, w, h, format, type, ...rest) {
        let mode = window.__photoboothFailPhotoEffect;
        if (mode && this.canvas?.id === 'effect' && w * h >= 100000) {
          if (mode.startsWith('print-')) {
            window.__photoboothBigReads = (window.__photoboothBigReads ?? 0) + 1;
            if (window.__photoboothBigReads < 2) return original.call(this, x, y, w, h, format, type, ...rest);
            mode = mode.slice('print-'.length);
          }
          window.__photoboothFailPhotoEffect = null; // 한 번만
          if (mode === 'throw') throw new Error('readPixels blocked by browser-check');
          if (mode === 'invalid') return original.call(this, x, y, w, h, this.RGB, type, ...rest);
          if (mode === 'lose') { window.__photoboothLost = this.getExtension('WEBGL_lose_context'); window.__photoboothLost.loseContext(); }
        }
        return original.call(this, x, y, w, h, format, type, ...rest);
      };
    })();` });
    const expected = { throw: /readPixels blocked/, invalid: /render-failed: GL error 0x502 during photo render/, lose: /context-lost: context lost during photo render/,
      'print-throw': /readPixels blocked/, 'print-invalid': /render-failed: GL error 0x502 during print data/ };
    const details = [];
    try {
      await app.open();
      await waitReady(app);
      for (const mode of ['throw', 'invalid', 'lose', 'print-throw', 'print-invalid']) {
        await app.waitFor('effect running', async () => /^running,/.test((await app.dev()).get('effect') ?? ''), 10000);
        await app.evaluate(`window.__photoboothBigReads = 0; window.__photoboothFailPhotoEffect = '${mode}'; true`);
        const { completedDelta, resources, dev, image } = await withAutoPaused(app, () => manualCycle(app));
        const fx = dev.get('photo-fx') ?? '';
        expect(completedDelta === 1, `${mode}: S completed +${completedDelta}`);
        if (mode.startsWith('print-')) {
          // 셔터 순간 유화 사진은 그대로(applied), 인쇄 데이터는 확정된 사진에서 CPU로 (8단계 검수 1)
          const print = dev.get('print') ?? '';
          expect(/^applied gray-oil 1080x1920 print blue-noise .*\(same drawing as preview, cpu from photo\)/.test(fx), `${mode}: photo-fx ${fx}`);
          expect(/^576x1024 1-bit/.test(print) && expected[mode].test(print) && /from photo on CPU/.test(print), `${mode}: print ${print}`);
          expect(image.startsWith('1080x1920') && /image\/jpeg/.test(dev.get('capture') ?? ''), `${mode}: result ${image}, ${dev.get('capture')}`);
          expect(photoFree(resources), `${mode}: resources ${dev.get('resources')}`);
          expect(/^running,/.test(dev.get('effect') ?? ''), `${mode}: preview after failure ${dev.get('effect')}`);
          details.push(`${mode} → applied, print from photo (${/GPU print failed: ([^)]*)/.exec(print)?.[1] ?? print})`);
          continue;
        }
        // 회색조 유화 기본값: 원본 사진(결과 크기)을 입력 회색조·레벨로, 인쇄 데이터도 그 사진에서 (8단계)
        expect(/^RAW PHOTO gray-oil 1080x1920 /.test(fx) && expected[mode].test(fx), `${mode}: photo-fx ${fx}`);
        expect(image.startsWith('1080x1920'), `${mode}: result image ${image}`);
        expect(/^576x1024 1-bit/.test(dev.get('print') ?? ''), `${mode}: print ${dev.get('print')}`);
        expect(photoFree(resources), `${mode}: resources ${dev.get('resources')}`);
        if (mode === 'lose') {
          expect(/^context-lost/.test(dev.get('effect') ?? ''), `lose: preview ${dev.get('effect')}`);
          await app.evaluate('window.__photoboothLost.restoreContext(); true');
          await app.waitFor('effect restored', async () => /^running,/.test((await app.dev()).get('effect') ?? ''), 8000);
        } else {
          expect(/^running,/.test(dev.get('effect') ?? ''), `${mode}: preview after failure ${dev.get('effect')}`);
        }
        details.push(`${mode} → ${/\(([^)]*)\)/.exec(fx)?.[1] ?? fx}`);
      }
      return `${details.join('; ')}; photo read failures: raw photo -> gray 1080x1920 on CPU with print data 576x1024, preview running again`;
    } finally {
      await app.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
  });

  await scenario('조절값 API GET·PUT 왕복 (저장 파일은 원래대로)', async () => {
    const existed = owned.settingsBackup.existed;
    try {
      const probe = JSON.stringify({ version: 1, settings: { region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, minFaceHeight: 0.05,
        maxFaceHeight: 0.6, minScore: 0.71, presentHoldMs: 500, absentGraceMs: 1000 }, browserCheck: new Date().toISOString() }, null, 2);
      const outcome = await app.evaluate(`(async () => {
        const url = '${SETTINGS_API}';
        const before = (await fetch(url, { cache: 'no-store' })).status;
        const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Photobooth': '1' }, body: ${JSON.stringify(probe)} });
        const back = await fetch(url, { cache: 'no-store' });
        const noHeader = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        return { before, put: put.status, back: back.status, same: (await back.text()) === ${JSON.stringify(probe)}, noHeader: noHeader.status };
      })()`);
      expect(outcome.before === (existed ? 200 : 404), `GET before ${outcome.before}`);
      expect(outcome.put === 204 && outcome.back === 200 && outcome.same, `PUT ${outcome.put}, GET ${outcome.back}, same ${outcome.same}`);
      expect(outcome.noHeader === 403, `PUT without X-Photobooth ${outcome.noHeader}`);
      return `GET ${outcome.before} → PUT ${outcome.put} → GET ${outcome.back} same; no header → ${outcome.noHeader}`;
    } finally {
      // 원래대로: 시작할 때 백업한 바이트(또는 "없음")로 파일 시스템에서 직접 되돌린다. 마지막 정리에서도 한 번 더 확인한다.
      const restored = restoreSettings('after settings scenario');
      if (!restored.ok) throw new Error(`could not restore settings file: ${restored.detail}`);
    }
  });

  await scenario('감지기 생성 실패 3회: 60초 타이머·로더 스크립트 증가 0 (실제 MediaPipe)', async () => {
    // 사전 확인은 통과하고 MediaPipe 그래프 시작에서 실패하게: 모델 대신 저장소의 LICENSE 파일과 그 크기·SHA-256을 넘긴다.
    const license = readFileSync(join(repo, 'lib', 'mediapipe', 'tasks-vision', 'LICENSE'));
    const sha256 = createHash('sha256').update(license).digest('hex');
    const outcome = await app.evaluate(`(async () => {
      const m = await import('/vision/face-detector.js');
      const probe = window.__photoboothCheck;
      const before = { timers: probe.intervals60s(), scripts: probe.loaderScripts() };
      const errors = [];
      for (let i = 0; i < 3; i += 1) {
        try {
          (await m.createFaceDetector({ bundlePath: '/lib/mediapipe/tasks-vision/vision_bundle.mjs', wasmPath: '/lib/mediapipe/tasks-vision/wasm',
            modelPath: '/lib/mediapipe/tasks-vision/LICENSE', modelBytes: ${license.length}, modelSha256: '${sha256}',
            delegates: ['GPU', 'CPU'], minDetectionConfidence: 0.3 })).close();
          errors.push('created');
        } catch (error) { errors.push(error.code); }
      }
      return { before, after: { timers: probe.intervals60s(), scripts: probe.loaderScripts() }, errors };
    })()`, { timeout: 60000 });
    expect(outcome.errors.every((code) => code === 'create-failed'), `errors ${outcome.errors.join(',')}`);
    expect(outcome.after.timers === outcome.before.timers, `60s timers ${outcome.before.timers} -> ${outcome.after.timers}`);
    expect(outcome.after.scripts === outcome.before.scripts, `loader scripts ${outcome.before.scripts} -> ${outcome.after.scripts}`);
    const dev = await app.dev();
    expect(/^running, health ok/.test(dev.get('detector') ?? ''), `app detector ${dev.get('detector')}`);
    return `create-failed x3; 60s timers ${outcome.before.timers}→${outcome.after.timers}, loader scripts ${outcome.before.scripts}→${outcome.after.scripts}; app detector still ok`;
  });

  await scenario('카메라 권한 거절 → 직원 문의 안내 → 허용 → 회복', async () => {
    await app.setCameraPermission('denied');
    await app.open();
    await app.waitFor('permission-denied', async () => /^permission-denied/.test((await app.dev()).get('status') ?? ''), 15000);
    await app.waitFor('staff notice', async () => (await app.status()).includes('직원에게 문의'), 5000);
    const deniedAt = Date.now();
    await app.setCameraPermission('granted');
    await app.waitFor('camera ready after grant', async () => /^ready/.test((await app.dev()).get('status') ?? ''), 15000);
    const recoverMs = Date.now() - deniedAt;
    await app.waitFor('notice cleared', async () => (await app.status()) === '', 20000);
    return `recovered ${recoverMs}ms after grant`;
  });

  await scenario('모델 요청 차단 → 감지기 장애 안내, S는 동작', async () => {
    await app.blockModel(true);
    try {
      await app.open();
      await app.waitFor('detector retrying', async () => /health (retrying|fault) \/ model-unavailable/.test((await app.dev()).get('detector') ?? ''), 15000);
      await app.waitFor('camera ready', async () => /^ready/.test((await app.dev()).get('status') ?? ''), 20000);
      await app.waitFor('preparing notice', async () => (await app.status()).startsWith('준비 중입니다.'), 5000);
      const notice = (await app.status()).replace(/\n/g, ' ');
      // 인식 표시(테두리 빛)와 대기 안내가 숨겨져 있다 (6-2)
      const presenceHidden = await app.evaluate("!document.getElementById('stage').classList.contains('is-present') && document.getElementById('guide').hidden");
      expect(presenceHidden, 'presence indicator or idle guide visible during detector fault');
      const dev = await app.dev();
      const { completedDelta, resources } = await withAutoPaused(app, () => manualCycle(app));
      expect(completedDelta === 1, `S completed +${completedDelta}`);
      expect(resources && resources.urls === 0 && resources.canvases === 0, 'resources not released');
      return `${dev.get('detector')}; notice "${notice}"; S cycle ok`;
    } finally {
      await app.blockModel(false);
    }
  });

  await scenario('외부 요청 0, CSP 위반 0, 페이지 예외 0', async () => {
    const { external, csp, cspExpected, exceptions } = app.events;
    expect(external.length === 0, `external: ${external.slice(0, 3).join(', ')}`);
    expect(csp.length === 0, `csp: ${csp[0]}`);
    expect(exceptions.length === 0, `exception: ${exceptions[0]}`);
    return `external 0, csp 0 (MediaPipe telemetry blocked as designed: ${cspExpected}), exceptions 0`;
  });
}

// ---------- 장시간 실측 ----------

function chromeMemory() {
  // 이 도구의 임시 프로필로 뜬 chrome.exe만 더한다. PrivatePageCount(커밋)와 WorkingSetSize, 바이트.
  const profile = owned.profile.replace(/'/g, "''");
  const script = `$p = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${profile}*' };`
    + ' $o = [ordered]@{ count = @($p).Count; private = ($p | Measure-Object -Property PrivatePageCount -Sum).Sum;'
    + ' workingSet = ($p | Measure-Object -Property WorkingSetSize -Sum).Sum }; $o | ConvertTo-Json -Compress';
  const out = spawnSync('powershell', ['-NoProfile', '-Command', script], { encoding: 'utf8', windowsHide: true });
  try { return JSON.parse(out.stdout.trim()); } catch { return { count: 0, private: 0, workingSet: 0 }; }
}

function slopePerHour(points) {
  const n = points.length;
  if (n < 2) return 0;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  const num = points.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0);
  const den = points.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  return den === 0 ? 0 : (num / den) * 60; // x는 분
}

async function runSoak(app) {
  const minutes = options.soak;
  const csvPath = options.csv || join(repo, 'logs', `soak_${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  mkdirSync(dirname(csvPath), { recursive: true });
  const header = 'minute,jsHeapMB,nodes,listeners,documents,chromeProcesses,chromePrivateMB,chromeWorkingSetMB,'
    + 'objectURLs,canvases,pending,taken,released,completed,detectFps,camera,detector,session,'
    + 'consoleError,consoleWarning,consoleInfo,consoleLog,exceptions,sPressed,sIgnored';
  writeFileSync(csvPath, `${header}\n`);
  log(`soak ${minutes} min, S every ${options.interval}s, camera ${options.camera}, csv ${csvPath}`);

  await app.setCameraPermission('granted');
  await app.open();
  await waitReady(app);
  const rows = [];
  let sPressed = 0;
  let sIgnored = 0;
  // 통과 조건용 (4단계 검수 5): S를 누르기 직전(대기 상태)마다 사진 자원 0·taken = released인지, 기록을 제대로 읽었는지
  let idleChecks = 0;
  const idleViolations = [];
  const readFailures = [];
  let nextPress = Date.now();
  let nextSample = Date.now();
  const start = Date.now();
  const end = start + minutes * 60000 + 2000; // 마지막 분(minute = minutes)도 기록한다
  while (Date.now() <= end) {
    if (Date.now() >= nextPress) {
      nextPress += options.interval * 1000;
      const before = await app.dev();
      const state = sessionState(before.get('session'));
      if (state === 'idle') {
        const res = parseResources(before.get('resources'));
        idleChecks += 1;
        if (!res) readFailures.push(`idle resources unreadable: ${before.get('resources')}`);
        else if (res.urls || res.canvases || res.pending || res.taken !== res.released) idleViolations.push(before.get('resources'));
        await app.key('KeyS');
        sPressed += 1;
      } else {
        sIgnored += 1; // 자동 회차나 쿨타임 중이면 누르지 않는다
      }
    }
    if (Date.now() >= nextSample) {
      nextSample += 60000;
      await app.evaluate('void 0'); // CDP 연결 확인
      await sleep(0);
      const metrics = await app.metrics();
      const dev = await app.dev();
      const res = parseResources(dev.get('resources')) ?? {};
      const mem = chromeMemory();
      const row = {
        minute: Math.round((Date.now() - start) / 60000),
        jsHeapMB: +(metrics.JSHeapUsedSize / 1048576).toFixed(2),
        nodes: metrics.Nodes, listeners: metrics.JSEventListeners, documents: metrics.Documents,
        chromeProcesses: mem.count, chromePrivateMB: +(mem.private / 1048576).toFixed(1), chromeWorkingSetMB: +(mem.workingSet / 1048576).toFixed(1),
        objectURLs: res.urls, canvases: res.canvases, pending: res.pending, taken: res.taken, released: res.released,
        completed: parseCompleted(dev.get('session')), detectFps: parseFps(dev.get('detect')),
        camera: (dev.get('status') ?? '').split(' ')[0], detector: (dev.get('detector') ?? '').replace(/,/g, ';'),
        session: sessionState(dev.get('session')),
        consoleError: app.events.console.error, consoleWarning: app.events.console.warning, consoleInfo: app.events.console.info,
        consoleLog: app.events.console.log, exceptions: app.events.exceptions.length, sPressed, sIgnored,
      };
      for (const key of ['jsHeapMB', 'nodes', 'listeners', 'documents', 'objectURLs', 'canvases', 'pending', 'completed', 'detectFps']) {
        if (!Number.isFinite(row[key])) readFailures.push(`m${row.minute} ${key}=${row[key]}`);
      }
      if (!(mem.count > 0)) readFailures.push(`m${row.minute} chrome memory unreadable`);
      rows.push(row);
      writeFileSync(csvPath, `${Object.values(row).join(',')}\n`, { flag: 'a' });
      log(`soak m${row.minute}: heap ${row.jsHeapMB}MB, nodes ${row.nodes}, listeners ${row.listeners}, docs ${row.documents},`
        + ` chrome ${row.chromePrivateMB}MB private (${row.chromeProcesses} proc), photos ${row.objectURLs}/${row.canvases}/${row.pending},`
        + ` completed ${row.completed}, ${row.detectFps}fps, ${row.camera}, ${row.detector}, console e${row.consoleError}/w${row.consoleWarning}`);
    }
    await sleep(500);
  }

  // 요약: 시작·중간·끝과 기울기(시간당, 최소제곱). 첫 5분은 시작 직후 증가(캐시·JIT)라 기울기에서 뺀 값도 함께 본다.
  const keys = ['jsHeapMB', 'nodes', 'listeners', 'documents', 'chromePrivateMB', 'chromeWorkingSetMB', 'detectFps'];
  const mid = rows[Math.floor(rows.length / 2)];
  const last = rows[rows.length - 1];
  const summary = keys.map((key) => {
    const all = rows.map((r) => ({ x: r.minute, y: r[key] }));
    const settled = all.filter((p) => p.x >= 5);
    return { key, start: rows[0][key], mid: mid[key], end: last[key], min: Math.min(...all.map((p) => p.y)), max: Math.max(...all.map((p) => p.y)),
      slopePerHour: +slopePerHour(all).toFixed(2), slopePerHourAfter5m: +slopePerHour(settled).toFixed(2) };
  });
  console.log('\nsoak summary');
  console.table(summary);
  const photoMax = Math.max(...rows.map((r) => (r.objectURLs ?? 0) + (r.canvases ?? 0) + (r.pending ?? 0)));
  console.log(`cycles completed ${last.completed} (S pressed ${sPressed}, skipped ${sIgnored}), photo resources max at sample ${photoMax},`
    + ` console error ${last.consoleError} warning ${last.consoleWarning}, exceptions ${last.exceptions}, csv ${csvPath}`);
  // 통과 조건 (4단계 검수 5): 모든 기록에서 카메라 ready·감지기 ok, 대기 중 사진 자원 0, 외부 요청·CSP 위반·예외 0, 측정값을 모두 읽음, 회차 진행
  const { external, csp, exceptions } = app.events;
  const problems = [
    ...rows.filter((r) => r.camera !== 'ready').map((r) => `m${r.minute} camera ${r.camera}`),
    ...rows.filter((r) => !/health ok/.test(r.detector)).map((r) => `m${r.minute} detector ${r.detector}`),
    ...idleViolations.map((v) => `idle resources ${v}`),
    ...readFailures,
    ...(idleChecks === 0 ? ['no idle check'] : []),
    ...(external.length ? [`external requests ${external.length}`] : []),
    ...(csp.length ? [`csp violations ${csp.length}`] : []),
    ...(exceptions.length ? [`exceptions ${exceptions.length}`] : []),
    ...(last.completed > 0 ? [] : ['no completed cycle']),
  ];
  console.log(`idle checks ${idleChecks} (violations ${idleViolations.length}), read failures ${readFailures.length}, external ${external.length}, csp ${csp.length}`);
  results.push({ name: `장시간 실측 ${minutes}분`, ok: problems.length === 0,
    detail: problems.length ? problems.slice(0, 5).join('; ') : `cycles ${last.completed}, idle checks ${idleChecks}, heap ${rows[0].jsHeapMB}→${last.jsHeapMB}MB, chrome ${rows[0].chromePrivateMB}→${last.chromePrivateMB}MB`,
    ms: minutes * 60000 });
}

// ---------- 실행 ----------

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows only (bin/server/serve.ps1 needs Windows PowerShell)');
  if (typeof WebSocket !== 'function') throw new Error('Node 22 or newer is required (built-in WebSocket)');
  owned.settingsBackup = backupFile(SETTINGS_FILE);
  log(`settings file backup: ${owned.settingsBackup.existed ? `${owned.settingsBackup.bytes.length} bytes` : 'none (will stay absent)'}`);
  owned.effectBackup = backupFile(EFFECT_SETTINGS_FILE);
  log(`effect settings file backup: ${owned.effectBackup.existed ? `${owned.effectBackup.bytes.length} bytes` : 'none (will stay absent)'}`);
  const port = await freePort();
  const origin = `http://localhost:${port}`;
  log(`repo ${repo}`);
  log(`server ${origin}, camera ${options.camera}`);
  await startServer(port);
  const cdp = await connect(await startChrome());
  const app = createApp(cdp, origin);
  await app.init();
  if (options.soak > 0) await runSoak(app);
  else await runScenarios(app, origin);
}

let exitCode = 0;
try {
  await main();
} catch (error) {
  log('ERROR', error.message);
  results.push({ name: 'setup', ok: false, detail: error.message, ms: 0 });
} finally {
  await cleanup();
  console.log('');
  console.table(results.map(({ name, ok, detail, ms }) => ({ result: ok ? 'PASS' : 'FAIL', scenario: name, seconds: +(ms / 1000).toFixed(1), detail })));
  const failed = results.filter((r) => !r.ok).length;
  console.log(`${results.length - failed}/${results.length} passed`);
  exitCode = failed > 0 || results.length === 0 ? 1 : 0;
}
process.exit(exitCode);
