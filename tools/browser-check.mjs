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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backupFile, createCdpSession, restoreFile } from './browser-check-lib.mjs';
import { config } from '../src/web/config/config.js';
import { computeCameraView, mapPoint } from '../src/web/core/camera-view.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_FILE = join(repo, 'config', 'presence.local.json');
const SETTINGS_API = '/local-api/presence-settings';
const EFFECT_SETTINGS_FILE = join(repo, 'config', 'effect.local.json');
const EFFECT_SETTINGS_API = '/local-api/effect-settings';
const CAMERA_SETTINGS_FILE = join(repo, 'config', 'camera.local.json');
const CAMERA_SETTINGS_API = '/local-api/camera-settings';
const TIMING_SETTINGS_FILE = join(repo, 'config', 'timing.local.json');
const TIMING_SETTINGS_API = '/local-api/timing-settings';
// 운영자 화면(E, 9-2·10)의 섹션 요소 id
const SECTION_IDS = Object.freeze({ camera: 'camera-panel', presence: 'tuning-panel', timing: 'timing-panel', effect: 'effect-panel' });
const MODEL_PATTERN = '*blaze_face_short_range.tflite*';
// MediaPipe 사용 통계 전송은 CSP로 막는 것이 의도된 동작이다(docs/SYSTEM.md 1절). 이 주소의 CSP 메시지는 실패로 세지 않는다.
const EXPECTED_CSP_HOST = 'odml.pa.googleapis.com';

// ---------- 옵션 ----------

function parseArgs(argv) {
  const options = { camera: 'fake', soak: 0, interval: 20, csv: '', chrome: '', keepProfile: false, only: [], cameraLabel: '', screens: '' };
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
    // 이름에 이 글자가 들어간 시나리오만 (| 로 여럿). 첫 시나리오(페이지 로드)는 늘 돈다. 개발 중 다시 확인용
    else if (arg === '--only') options.only = value().split('|').map((t) => t.trim()).filter(Boolean);
    // 카메라 설정 시나리오(9-1)가 쓸 장치 라벨 (예: 옆으로 세운 실제 웹캠). 비우면 기본 규칙(OBS → 기본 카메라)
    else if (arg === '--camera-label') options.cameraLabel = value();
    // 운영자 화면 캡처(PNG)를 남길 폴더 (9-2 검수용). 실제 카메라 영상이 찍히지 않게 가짜 카메라에서만 쓴다
    else if (arg === '--screens') options.screens = value();
    else throw new Error(`unknown option: ${arg}`);
  }
  if (!['fake', 'real'].includes(options.camera)) throw new Error('--camera must be fake or real');
  if (options.screens && options.camera !== 'fake') throw new Error('--screens is for the fake camera only (no real camera images are saved)');
  if (!(options.soak >= 0) || !(options.interval >= 5)) throw new Error('--soak must be a number of minutes, --interval >= 5');
  return options;
}

const DEFAULT_SOAK_MINUTES = 10;
const options = parseArgs(process.argv.slice(2));
// 카메라 설정 기본값 (9-1, config.camera). 카메라 시나리오는 이 위에 바꿀 값만 얹어 파일에 쓴다
const CAMERA_DEFAULTS = Object.freeze({ ...config.camera, deviceLabel: options.cameraLabel });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now();
const elapsed = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;
const log = (...parts) => console.log(`[${elapsed()}]`, ...parts);

// ---------- 정리 대상 (이 도구가 만든 것만) ----------

const owned = { server: null, chrome: null, profile: null, cdp: null, settingsBackup: null, effectBackup: null, cameraBackup: null, timingBackup: null };
let cleaning = null;

// 조절값 파일은 시작할 때 바이트 그대로(또는 "없음") 백업하고, 모든 정리 경로에서 파일 시스템으로 직접 되돌린다
// (4단계 검수 1: 서버 API로 되돌리면 잘못된 JSON·16KB 초과 원본이 거절돼 시험 값이 남았다).
// 인식 조절값(presence.local.json)·효과 조절값(effect.local.json, 5-2)·카메라 설정(camera.local.json, 9-1)·시간 설정(timing.local.json, 10)
// 모두 같은 방법으로 되돌린다.
function restoreSettings(reason) {
  const details = [];
  let ok = true;
  // 시간 시나리오가 쓰기 실패를 만들려고 시간 파일 자리에 둔 빈 폴더가 남았으면 먼저 지운다
  if (owned.timingBackup && existsSync(TIMING_SETTINGS_FILE) && statSync(TIMING_SETTINGS_FILE).isDirectory()) {
    try { rmdirSync(TIMING_SETTINGS_FILE); } catch (error) { log('WARN timing placeholder folder:', error.message); }
  }
  for (const [label, backup] of [['settings', owned.settingsBackup], ['effect settings', owned.effectBackup], ['camera settings', owned.cameraBackup],
    ['timing settings', owned.timingBackup]]) {
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
  // tail: 실패 진단용 최근 기록 (콘솔·로그 항목·조절값 API 요청과 응답 상태, 시각은 도구 시작 기준). 내용은 글자만이고 영상은 없다
  const events = { external: [], csp: [], cspExpected: 0, exceptions: [], console: { error: 0, warning: 0, info: 0, log: 0, other: 0 }, tail: [] };
  const TAIL_MAX = 80;
  const note = (line) => {
    events.tail.push(`${elapsed()} ${line}`.slice(0, 400));
    if (events.tail.length > TAIL_MAX) events.tail.shift();
  };
  const apiRequests = new Map(); // requestId → 'METHOD /local-api/...'
  let modelBlocked = false;

  cdp.on((data) => {
    if (data.method === 'Network.requestWillBeSent') {
      const url = data.params.request.url;
      if (!url.startsWith(`${origin}/`) && !url.startsWith('blob:') && !url.startsWith('data:')) events.external.push(url);
      if (url.includes('/local-api/')) apiRequests.set(data.params.requestId, `${data.params.request.method} ${new URL(url).pathname}`);
      if (data.params.type === 'Document') note(`navigate ${url}`);
    } else if (data.method === 'Network.responseReceived' && apiRequests.has(data.params.requestId)) {
      note(`api ${apiRequests.get(data.params.requestId)} -> ${data.params.response.status}`);
      apiRequests.delete(data.params.requestId);
    } else if (data.method === 'Network.loadingFailed' && apiRequests.has(data.params.requestId)) {
      note(`api ${apiRequests.get(data.params.requestId)} -> failed ${data.params.errorText}`);
      apiRequests.delete(data.params.requestId);
    } else if (data.method === 'Runtime.exceptionThrown') {
      events.exceptions.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
      note(`exception ${events.exceptions.at(-1)}`);
    } else if (data.method === 'Runtime.consoleAPICalled') {
      const type = data.params.type === 'warn' ? 'warning' : data.params.type;
      events.console[type in events.console ? type : 'other'] += 1;
      note(`console.${data.params.type} ${data.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    } else if (data.method === 'Log.entryAdded') {
      const { text, level } = data.params.entry;
      if (level === 'error' || level === 'warning') note(`log.${level} ${text}`);
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
      // 이전 문서에 표시를 남기고, 표시가 없는 새 문서가 다 불러와질 때까지 기다린다. readyState만 보면 새 문서가 자리 잡기 전에
      // 이전 문서에서 조건이 맞아 D 키·D 글자를 이전 문서에서 다룰 수 있다(10단계: 원인 미확인 실패 한 번의 후보, 로그 2026-11-03-01)
      const token = `open-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      await evaluate(`window.__photoboothOpen = '${token}'; true`).catch(() => {});
      await cdp.send('Page.navigate', { url: `${origin}/` });
      let previousSeen = false;
      await app.waitFor('page loaded', async () => {
        const s = await evaluate(`({ previous: window.__photoboothOpen === '${token}', ready: document.readyState === 'complete' && !!document.getElementById('dev-info') })`);
        if (s.previous) previousSeen = s.ready; // 이전 문서가 아직 "다 불러온" 상태로 보였다
        return !s.previous && s.ready;
      }, 15000);
      if (previousSeen) log('NOTE open(): previous document still looked loaded right after Page.navigate (waited for the new one)');
      // D 화면(개발용 정보)을 켠다. 새로 열 때마다 꺼진 상태로 시작한다(켜져 있으면 누르지 않는다)
      if (await evaluate("document.getElementById('dev-info').hidden")) await app.key('KeyD');
      await app.waitFor('dev info', async () => !(await evaluate("document.getElementById('dev-info').hidden")) && (await app.dev()).has('session'), 5000);
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
    /** 운영자 화면(E) 섹션의 선택 상자를 고른다 (change 이벤트). scope 기본은 필터 섹션 */
    choose: (key, value, scope = '#effect-panel') => evaluate(`(() => { const s = document.querySelector('${scope} select[data-key="${key}"]');
      s.value = '${value}'; s.dispatchEvent(new Event('change')); return s.value; })()`),
    /** 운영자 화면(E) 섹션의 슬라이더를 움직인다 (input 이벤트) */
    slide: (key, value, scope = '#effect-panel') => evaluate(`(() => { const i = document.querySelector('${scope} input[data-key="${key}"]');
      i.value = '${value}'; i.dispatchEvent(new Event('input')); return i.value; })()`),
    /** 운영자 화면(E) 섹션의 버튼을 누른다 */
    press: (action, scope) => evaluate(`(() => { document.querySelector('${scope} button[data-action="${action}"]').click(); return true; })()`),
    /** 운영자 화면(E, 9-2)을 열고 그 섹션을 보인다: camera·presence·timing·effect */
    async openSection(name) {
      if (await evaluate("document.getElementById('operator-panel').hidden")) {
        await app.key('KeyE');
        await app.waitFor('operator panel open', () => evaluate("!document.getElementById('operator-panel').hidden"), 5000);
      }
      await evaluate(`document.querySelector('#operator-panel button[data-section="${name}"]').click(); true`);
      await app.waitFor(`${name} section shown`, () => evaluate(`!document.getElementById('${SECTION_IDS[name]}').hidden`), 3000);
    },
    /** 운영자 화면을 닫는다 (저장하지 않은 섹션은 되돌린다) */
    async closePanel() {
      if (await evaluate("document.getElementById('operator-panel').hidden")) return;
      await app.key('KeyE');
      await app.waitFor('operator panel closed', () => evaluate("document.getElementById('operator-panel').hidden"), 5000);
    },
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
      let state = '';
      try {
        const d = await app.dev();
        state = ` [D status ${d.get('status')}; reason ${d.get('reason')}; video ${d.get('video')}; effect ${(d.get('effect') ?? '-').slice(0, 80)}; raw-view ${d.get('raw-view')}]`;
      } catch { /* D를 읽지 못함 */ }
      throw new Error(`timeout waiting for ${label} (${timeoutMs}ms)${state}`);
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
 * E 화면에서 미리보기 처리 해상도를 1로 둔다 (열린 E 화면에서 부른다. 저장하지 않으면 닫을 때 되돌아간다).
 * 결과가 셔터 순간 미리보기와 화소까지 같은지는 미리보기가 결과와 같은 크기일 때만 볼 수 있다. 기본값 0.5에서는 같은 그림을
 * 낮은 해상도로 그려 화소가 다르다 (docs/SYSTEM.md 6절, 2026-10-19 기본값 변경).
 */
async function previewScaleOne(app) {
  await app.slide('previewScale', 1);
  // 설정 값(x1)만이 아니라 실제로 1080x1920으로 그린 뒤까지 기다린다. 설정은 바로 보이고 그림은 다음 화면 갱신에 바뀌어, 그 사이에
  // 캔버스 크기를 읽으면 540x960이었다(실제 카메라 1회, 첫 촬영 멈춤 수정 때)
  await app.waitFor('preview x1 drawn', async () => /^running, 1080x1920 \(preview x1,/.test((await app.dev()).get('effect') ?? ''), 5000);
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
 * 회색조 유화 S 한 장 (8단계 기본값): 결과(JPEG 1080x1920)가 셔터 직전 미리보기 그림과 같은 영역의 블록 평균(결과 10x10)으로 가장 가깝고,
 * 미리보기 그림이 무채색(R=G=B)이며 결과도 무채색에 가깝고(JPEG), 인쇄 데이터가 576x1024 1비트이고, 결과 폭이 영역의 정확히 절반인지 본다.
 * 미리보기가 결과와 같은 크기(처리 해상도 1)면 차이 1/255 미만이어야 한다. 기본값 0.5(540x960, 2026-10-19)는 같은 그림을 낮은 해상도로
 * 그려 화소가 다르므로(docs/SYSTEM.md 6절 "원본과의 차이") 셔터 직전 그림이 다른 그림보다 가까운지와 상한만 본다.
 * withAutoPaused 안에서 부른다.
 */
async function grayOilShot(app, { method = 'blue-noise', check = 'gpu=cpu', previewSize = '540x960' } = {}) {
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
  expect(c.size === '1080x1920' && c.previewSize === previewSize && c.shutterIndex >= 0, `compare ${JSON.stringify(c)}`);
  const atShutter = c.drawings[c.shutterIndex];
  const others = c.drawings.filter((_, i) => i !== c.shutterIndex);
  const limit = previewSize === c.size ? 1 : SCALED_PREVIEW_DIFF_LIMIT;
  expect(atShutter.diff < limit && others.length > 0 && others.every((d) => d.diff > atShutter.diff), `block diff (limit ${limit}): ${JSON.stringify(c.drawings)}`);
  // 무채색: 미리보기 그림은 화소마다 R=G=B, 결과는 JPEG라 1 이하 허용
  expect(c.drawings.every((d) => d.chroma === 0), `preview chroma ${c.drawings.map((d) => d.chroma).join('/')}`);
  expect(c.resultChroma <= 1, `result chroma ${c.resultChroma}`);
  // 연속 톤 사진은 영역 폭의 정확히 절반 (1080 화면 1/2, 4K 1:1, 8단계)
  expect(!c.box.dots && Math.abs(c.box.ratio - 0.5) < 0.001, `result box ${JSON.stringify(c.box)}`);
  return { fx, print, compare: `preview ${c.previewSize}, shutter drawing block diff ${atShutter.diff}/255, other drawings ${others.map((d) => d.diff).join('/')},`
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
  // 새 그림인지: 지운 버퍼는 모두 0이다(alpha false라 알파로는 구분하지 못한다). 중앙 한 점이 아니라 가운데 가로·세로 한 줄을 본다
  // (대비를 높인 기본값에서는 어두운 곳이 순수 검정이라, 중앙 8x8만 보면 그린 그림을 놓친다, 로그 2026-10-26-01)
  const row = new Uint8Array(4096 * 4), col = new Uint8Array(4096 * 4);
  const anyLit = (a, n) => { for (let i = 0; i < n; i += 4) if (a[i] || a[i + 1] || a[i + 2]) return true; return false; };
  new MutationObserver(() => {
    const cd = document.getElementById('countdown');
    if (cd.hidden && r.wasCounting) { r.shutterAt = performance.now(); r.pinned = r.drawings[r.drawings.length - 1] ?? null; }
    r.wasCounting = !cd.hidden;
  }).observe(document.getElementById('countdown'), { attributes: true, attributeFilter: ['hidden'] });
  const loop = () => {
    requestAnimationFrame(loop);
    const W = c.width, H = c.height;
    if (c.hidden || W < 16) return;
    gl.readPixels(0, H >> 1, W, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
    gl.readPixels(W >> 1, 0, 1, H, gl.RGBA, gl.UNSIGNED_BYTE, col);
    if (!anyLit(row, W * 4) && !anyLit(col, H * 4)) return; // 이 화면 갱신에서는 새로 그리지 않았다
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    r.drawings.push({ at: performance.now(), W, H, buf });
    if (r.drawings.length > 8) r.drawings.shift();
  };
  requestAnimationFrame(loop);
  return true;
})()`;

// 미리보기가 결과보다 작을 때(처리 해상도 0.5 등) 셔터 직전 그림과 결과의 블록 평균 차이 상한 (/255). 측정값은 로그 2026-10-19-07
const SCALED_PREVIEW_DIFF_LIMIT = 4;

// 결과 사진(#result)과 기록한 그림들을 10x10 블록 평균(RGB)으로 비교한다. 셔터 직전 그림 = 셔터 전에 마지막으로 그린 것.
// 미리보기가 결과보다 작으면(처리 해상도 < 1) 같은 영역의 블록(0.5배면 5x5)끼리 비교한다. 블록이 정수 화소가 아닌 크기는 건너뛴다.
const EFFECT_COMPARE = `(() => {
  const r = window.__fxReader;
  const img = document.getElementById('result');
  const W = img.naturalWidth, H = img.naturalHeight, B = 10, gw = Math.floor(W / B), gh = Math.floor(H / B);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  const res = x.getImageData(0, 0, W, H).data; cv.width = 0;
  const grid = (get, b = B) => { const g = new Float64Array(gw * gh * 3);
    for (let y = 0; y < gh * b; y++) for (let xx = 0; xx < gw * b; xx++) { const i = get(xx, y), k = (Math.floor(y / b) * gw + Math.floor(xx / b)) * 3;
      g[k] += i[0]; g[k + 1] += i[1]; g[k + 2] += i[2]; }
    for (let k = 0; k < g.length; k++) g[k] /= b * b; return g; };
  const resGrid = grid((xx, y) => { const i = (y * W + xx) * 4; return [res[i], res[i + 1], res[i + 2]]; });
  const diff = (a, b) => { let s = 0; for (let k = 0; k < a.length; k++) s += Math.abs(a[k] - b[k]); return s / a.length; };
  // 화소가 정확히 다른 수 (감열지 결과는 무손실 PNG라 셔터 직전 그림과 0이어야 한다, 6-1)
  const mismatch = (d) => { if (d.W !== W || d.H !== H) return null; let c = 0; for (let y = 0; y < H; y++) for (let xx = 0; xx < W; xx++) { const i = (y * W + xx) * 4, j = ((d.H - 1 - y) * d.W + xx) * 4;
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
  const blockOf = (d) => d.W * B / W; // 미리보기 그림에서 결과 10x10과 같은 영역의 블록 크기
  const out = list.filter((d) => d.W * H === d.H * W && Number.isInteger(blockOf(d))).map((d) => ({
    beforeShutter: d.at < r.shutterAt, msFromShutter: Math.round(d.at - r.shutterAt),
    diff: +diff(resGrid, grid((xx, y) => { const i = ((d.H - 1 - y) * d.W + xx) * 4; return [d.buf[i], d.buf[i + 1], d.buf[i + 2]]; }, blockOf(d))).toFixed(3),
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

// 좌우 방향 확인 (E 화면 "카메라" 좌우 반전, 2026-10-26). 이미지는 페이지 메모리 안에서 18x32 밝기 격자로만 줄여 비교하고 저장하지 않는다.
// 효과 캔버스에 새 그림이 그려진 화면 갱신마다 그 그림과 같은 순간의 <video> 프레임(보이는 9:16 영역, 반전 전)을 격자로 남긴다.
// 셔터 순간(카운트다운 숫자가 숨겨지는 순간)에는 마지막 그림과 그 그림과 같은 순간의 영상을 따로 남긴다
// (셔터 순간에 영상을 새로 읽으면 다른 프레임이라, 움직이는 가짜 카메라에서는 상관이 0.3까지 떨어졌다).
// 방향은 비대칭 성분의 상관(anti, -1~1)으로 본다: 각 격자에서 자기 좌우 뒤집음을 뺀 것(g - flip(g))끼리의 피어슨 상관이다.
// 같은 방향이면 +, 거울 방향이면 −. 가짜 카메라 화면은 거의 좌우 대칭이라 그냥 상관은 그대로·뒤집음이 비슷하다(0.86 / 0.89).
const MIRROR_READER = `(() => {
  if (window.__mirrorReader) return true;
  const c = document.getElementById('effect'), v = document.getElementById('preview');
  const gl = c.getContext('webgl2');
  const GW = 18, GH = 32, UP = 4;
  const t = document.createElement('canvas'); t.width = GW * UP; t.height = GH * UP;
  const tx = t.getContext('2d', { willReadFrequently: true }); tx.imageSmoothingQuality = 'high';
  const luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  // 큰 그림을 GW x GH 블록 평균 밝기로. at(x, y)는 왼쪽 위 원점 화소의 RGBA 시작 번호
  const grid = (W, H, data, at) => { const g = new Float64Array(GW * GH), n = new Float64Array(GW * GH);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = Math.floor(y * GH / H) * GW + Math.floor(x * GW / W); g[k] += luma(data, at(x, y)); n[k]++; }
    for (let k = 0; k < g.length; k++) g[k] /= n[k]; return g; };
  const videoGrid = () => { const vw = v.videoWidth, vh = v.videoHeight, a = 9 / 16, va = vw / vh;
    const sw = va > a ? vh * a : vw, sh = va > a ? vh : vw / a;
    tx.drawImage(v, (vw - sw) / 2, (vh - sh) / 2, sw, sh, 0, 0, t.width, t.height);
    return grid(t.width, t.height, tx.getImageData(0, 0, t.width, t.height).data, (x, y) => (y * t.width + x) * 4); };
  // 카메라 처리 경로(9-1)를 거친 영상 격자: r.view(core/camera-view.js computeCameraView)가 있으면 그 변환으로 그린다 (색 보정 없음)
  const stageGrid = () => { if (!r.view || !r.canvasTransform) return null;
    tx.save(); tx.fillStyle = '#000'; tx.fillRect(0, 0, t.width, t.height); tx.setTransform(...r.canvasTransform(r.view, t.width, t.height));
    tx.drawImage(v, 0, 0); tx.restore();
    return grid(t.width, t.height, tx.getImageData(0, 0, t.width, t.height).data, (x, y) => (y * t.width + x) * 4); };
  const r = window.__mirrorReader = { GW, GH, samples: [], shutter: null, grid, view: null, canvasTransform: null };
  r.stageGrid = stageGrid;
  r.videoGrid = videoGrid;
  new MutationObserver(() => { const cd = document.getElementById('countdown');
    if (cd.hidden && r.wasCounting) r.shutter = r.samples.at(-1) ?? null;
    r.wasCounting = !cd.hidden; }).observe(document.getElementById('countdown'), { attributes: true, attributeFilter: ['hidden'] });
  const loop = () => {
    requestAnimationFrame(loop);
    const W = c.width, H = c.height;
    if (c.hidden || W < 16 || !(v.videoWidth > 0)) return;
    // 이 화면 갱신에 새로 그렸는지: 가로줄 4개(높이 1/5·2/5·3/5·4/5)의 RGB가 모두 0이면 그리지 않았다 (preserveDrawingBuffer false,
    // 알파는 늘 255라 쓰지 않는다). EFFECT_READER처럼 가운데 8x8만 보면 레벨 뒤 가운데가 순수 검정인 실제 OBS 장면에서 새 그림을 못 셌다 (9-1)
    const row = new Uint8Array(W * 4);
    let any = 0;
    for (const f of [0.2, 0.4, 0.6, 0.8]) {
      gl.readPixels(0, Math.floor(H * f), W, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      for (let i = 0; i < row.length && any === 0; i += 4) any += row[i] + row[i + 1] + row[i + 2];
      if (any) break;
    }
    if (any === 0) return;
    const buf = new Uint8Array(W * H * 4);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    r.samples.push({ drawing: grid(W, H, buf, (x, y) => ((H - 1 - y) * W + x) * 4), video: videoGrid(), stage: stageGrid() });
    if (r.samples.length > 12) r.samples.shift();
  };
  requestAnimationFrame(loop);
  return true;
})()`;

// 격자 상관 도구 (페이지 안): corr(a, b), flip(g) 좌우 뒤집기, orient(a, b) = { same, flipped, anti }
const MIRROR_MATH = `const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
    let s = 0, sa = 0, sb = 0; for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; s += x * y; sa += x * x; sb += y * y; } return sa && sb ? s / Math.sqrt(sa * sb) : 0; };
  const flip = (g) => { const { GW, GH } = window.__mirrorReader, f = new Float64Array(g.length); for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) f[y * GW + x] = g[y * GW + GW - 1 - x]; return f; };
  const odd = (g) => { const f = flip(g); return g.map((v, i) => v - f[i]); };
  const orient = (a, b) => ({ same: +corr(a, b).toFixed(3), flipped: +corr(a, flip(b)).toFixed(3), anti: +corr(odd(a), odd(b)).toFixed(3) });`;

// 최근 그림들(새로 그린 화면 갱신마다)의 효과 그림 ↔ 같은 순간 영상 상관 평균
const MIRROR_PREVIEW = `(() => { ${MIRROR_MATH}
  const list = window.__mirrorReader.samples.map((s) => orient(s.drawing, s.video));
  const avg = (k) => +(list.reduce((a, o) => a + o[k], 0) / Math.max(1, list.length)).toFixed(3);
  return { n: list.length, same: avg('same'), flipped: avg('flipped'), anti: avg('anti'), antiMin: Math.min(...list.map((o) => Math.abs(o.anti))) }; })()`;

// 결과 사진 ↔ 셔터 순간 그림·그 그림의 영상 상관 (결과 화면에서 부른다)
const MIRROR_RESULT = `(() => { ${MIRROR_MATH}
  const r = window.__mirrorReader, img = document.getElementById('result');
  const W = img.naturalWidth, H = img.naturalHeight, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const x = cv.getContext('2d', { willReadFrequently: true }); x.drawImage(img, 0, 0);
  const res = r.grid(W, H, x.getImageData(0, 0, W, H).data, (xx, y) => (y * W + xx) * 4); cv.width = 0;
  // 격자 값 범위(최소·최대·NaN 수): 실패 메시지에서 그림을 못 읽었는지 가린다
  const range = (g) => (g ? [Math.round(Math.min(...g)), Math.round(Math.max(...g)), g.filter(Number.isNaN).length].join('/') : '-');
  return { size: W + 'x' + H, ranges: [range(res), range(r.shutter?.drawing), range(r.shutter?.video)].join(' '),
    drawing: r.shutter?.drawing ? orient(res, r.shutter.drawing) : null, video: r.shutter ? orient(res, r.shutter.video) : null,
    stage: r.shutter?.stage ? orient(res, r.shutter.stage) : null }; })()`;

// 원본 창(9-2) ↔ 지금 변환한 영상·변환 전 cover 영상: 원본 창 캔버스를 같은 격자로 줄여 상관 (원본 창은 색 보정 포함, 격자 영상은 기하만)
const RAW_WINDOW_CHECK = `(() => { ${MIRROR_MATH}
  const r = window.__mirrorReader, c = document.getElementById('raw-window-canvas');
  const W = c.width, H = c.height, d = c.getContext('2d').getImageData(0, 0, W, H).data;
  const g = r.grid(W, H, d, (x, y) => (y * W + x) * 4), s = r.stageGrid(), v = r.videoGrid();
  return { size: W + 'x' + H, hidden: document.getElementById('raw-window').hidden, stage: s ? +corr(g, s).toFixed(3) : null, cover: +corr(g, v).toFixed(3) }; })()`;

// 카메라 처리 경로 (9-1)의 미리보기 ↔ 같은 순간 영상: 변환한 영상(stage)과 변환 전 cover 영상(video) 상관 평균
const CAMERA_PREVIEW = `(() => { ${MIRROR_MATH}
  const list = window.__mirrorReader.samples.filter((s) => s.stage).map((s) => ({ stage: corr(s.drawing, s.stage), cover: corr(s.drawing, s.video) }));
  const avg = (k) => +(list.reduce((a, o) => a + o[k], 0) / Math.max(1, list.length)).toFixed(3);
  return { n: list.length, stage: avg('stage'), cover: avg('cover'), stageMin: +Math.min(...list.map((o) => o.stage)).toFixed(3) }; })()`;

/**
 * 카메라 처리 경로 (9-1)가 2D 캔버스(감지·캡처·원본 미리보기)와 효과 셰이더에서 같은 그림인지 페이지 안에서 잰다. 이미지는 저장하지 않는다.
 * 같은 영상 프레임(ImageBitmap 한 장)에서 ① 변환만 한 2D 그림 a, ② 앱의 색 보정 SVG 필터까지 건 2D 그림 b(= camera-frame.js draw),
 * ③ 앱 셰이더 FS_GRADE(uAmt 0 → 카메라 입력 그대로, effect/oil-shaders.js CAMERA_INPUT)로 그린 그림 g를 원본 화소 크기로 만든다.
 * b ↔ a에 core 기준식(applyCameraColor)을 적용한 값, g ↔ b를 화소 차이(평균·99%)와 18x32 격자 차이(최대)로 비교한다.
 */
const cameraPathCheck = (camera) => `(async () => {
  const cv = await import('/core/camera-view.js');
  const sh = await import('/effect/oil-shaders.js');
  // 같은 프레임 한 장: <video>를 세 번 읽으면 그 사이 다음 프레임이 될 수 있다(가짜 카메라의 움직이는 부분이 한 격자에서 크게 달랐다)
  const video = document.getElementById('preview');
  const v = await createImageBitmap(video);
  v.videoWidth = v.width; v.videoHeight = v.height;
  const view = cv.computeCameraView({ videoWidth: v.width, videoHeight: v.height, stageAspect: 9 / 16, camera: ${JSON.stringify(camera)} });
  const OW = Math.round(view.visibleWidthPx), OH = Math.round(view.visibleHeightPx);
  const color = cv.cameraColorMatrix(${JSON.stringify(camera)});
  const filter = document.querySelector('svg.camera-filter filter');
  const appFilter = filter ? 'url(#' + filter.id + ')' : 'none';
  const draw2d = (f) => { const c = document.createElement('canvas'); c.width = OW; c.height = OH; const x = c.getContext('2d', { willReadFrequently: true });
    x.fillStyle = '#000'; x.fillRect(0, 0, OW, OH); x.setTransform(...cv.canvasTransform(view, OW, OH)); x.filter = f; x.drawImage(v, 0, 0);
    const d = x.getImageData(0, 0, OW, OH).data; c.width = 0; return d; };
  // GL: 앱 셰이더 그대로 (VS + FS_GRADE, uAmt 0)
  const gc = document.createElement('canvas'); gc.width = OW; gc.height = OH;
  const gl = gc.getContext('webgl2', { preserveDrawingBuffer: true });
  const compile = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
  const prog = gl.createProgram(); gl.attachShader(prog, compile(gl.VERTEX_SHADER, sh.VS)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, sh.FS_GRADE));
  gl.linkProgram(prog); if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  const tex = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, tex);
  for (const [k, val] of [[gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, val);
  const a = draw2d('none');
  const b = draw2d(appFilter);
  // 앱은 <video>를 UNPACK_FLIP_Y로 올린다. ImageBitmap에는 그 설정이 듣지 않아 같은 프레임을 위아래 뒤집은 비트맵으로 올린다
  const flipped = await createImageBitmap(v, { imageOrientation: 'flipY' });
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, flipped); flipped.close();
  gl.useProgram(prog); gl.viewport(0, 0, OW, OH);
  const U = (n) => gl.getUniformLocation(prog, n);
  const affine = cv.shaderSourceAffine(view), cu = cv.shaderColorUniforms(color);
  gl.uniform1i(U('uSrc'), 0); gl.uniform1f(U('uAmt'), 0); gl.uniform2f(U('uRes'), OW, OH); gl.uniform2f(U('uTexel'), 1 / OW, 1 / OH);
  gl.uniform3fv(U('uSrcX'), affine.x); gl.uniform3fv(U('uSrcY'), affine.y); gl.uniformMatrix3fv(U('uCamM'), false, cu.uCamM);
  gl.uniform3fv(U('uCamB'), cu.uCamB); gl.uniform1f(U('uCamExp'), cu.uCamExp);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  const gRaw = new Uint8Array(OW * OH * 4); gl.readPixels(0, 0, OW, OH, gl.RGBA, gl.UNSIGNED_BYTE, gRaw);
  gl.getExtension('WEBGL_lose_context')?.loseContext(); gc.width = 0;
  const stats = (diffAt) => { const hist = new Uint32Array(256); let sum = 0, n = 0;
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) for (let ch = 0; ch < 3; ch++) { const dd = Math.min(255, Math.round(diffAt(x, y, ch))); hist[dd]++; sum += dd; n++; }
    let acc = 0, p99 = 0; for (let i = 0; i < 256; i++) { acc += hist[i]; if (acc >= n * 0.99) { p99 = i; break; } }
    return { mean: +(sum / n).toFixed(3), p99 }; };
  const at = (x, y) => (y * OW + x) * 4, atG = (x, y) => ((OH - 1 - y) * OW + x) * 4;
  // b ↔ 기준식(a)
  const ref = new Float32Array(OW * OH * 3);
  for (let i = 0, j = 0; i < a.length; i += 4, j += 3) { const o = cv.applyCameraColor([a[i] / 255, a[i + 1] / 255, a[i + 2] / 255], color); ref[j] = o[0] * 255; ref[j + 1] = o[1] * 255; ref[j + 2] = o[2] * 255; }
  const svgVsRef = stats((x, y, ch) => Math.abs(b[at(x, y) + ch] - ref[(y * OW + x) * 3 + ch]));
  const glVs2d = stats((x, y, ch) => Math.abs(gRaw[atG(x, y) + ch] - b[at(x, y) + ch]));
  // 격자(18x32) 밝기 평균 차이: 화소 필터(축소·보간) 차이를 넘는 기하·색 어긋남을 본다
  const GW = 18, GH = 32, luma = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
  const gridOf = (d, pos) => { const g = new Float64Array(GW * GH), n = new Float64Array(GW * GH);
    for (let y = 0; y < OH; y++) for (let x = 0; x < OW; x++) { const k = Math.floor(y * GH / OH) * GW + Math.floor(x * GW / OW); g[k] += luma(d, pos(x, y)); n[k]++; }
    return g.map((s, k) => s / n[k]); };
  const g2d = gridOf(b, at), gGl = gridOf(gRaw, atG), gRaw2d = gridOf(a, at);
  const gridMax = (p, q) => +Math.max(...p.map((x, k) => Math.abs(x - q[k]))).toFixed(2);
  // 색 보정이 실제로 걸렸는지: 보정 전후 격자 차이
  v.close();
  return { size: OW + 'x' + OH, video: video.videoWidth + 'x' + video.videoHeight, filter: appFilter, zoom: +view.zoom.toFixed(3), autoZoom: view.autoZoom,
    svgVsRef, glVs2d, gridGlVs2d: gridMax(gGl, g2d), colorEffect: gridMax(g2d, gRaw2d) };
})()`;

// 방향 판정: 비대칭 성분 상관이 같은 방향이면 이 값 이상, 거울 방향이면 −이 값 이하 (가안, 측정값은 로그 2026-10-26-02)
const MIRROR_ANTI = 0.3;
const oriented = (o, mirrored) => (mirrored ? o.anti <= -MIRROR_ANTI : o.anti >= MIRROR_ANTI);
const facesOf = (text) => text.split('\n').filter((l) => /^ {2}face \d+/.test(l))
  .map((l) => Number(/center (-?[\d.]+),/.exec(l)?.[1] ?? NaN));
const facesXY = (text) => text.split('\n').filter((l) => /^ {2}face \d+/.test(l))
  .map((l) => { const m = /center (-?[\d.]+),(-?[\d.]+)/.exec(l); return { x: Number(m?.[1] ?? NaN), y: Number(m?.[2] ?? NaN) }; });

// ---------- 시나리오 ----------

const results = [];
let diagApp = null; // 실패 진단용 (runScenarios가 정한다)
async function scenario(name, run) {
  if (options.only.length > 0 && results.length > 0 && !options.only.some((text) => name.includes(text))) return;
  const started = Date.now();
  try {
    const detail = await run();
    results.push({ name, ok: true, detail: detail ?? '', ms: Date.now() - started });
    log('PASS', name, detail ? `-- ${detail}` : '');
  } catch (error) {
    results.push({ name, ok: false, detail: error.message, ms: Date.now() - started });
    log('FAIL', name, '--', error.message);
    await logDiagnostics();
  }
}

// 실패하면 그 순간의 D 화면 글자 전체, 관람객 안내, 최근 콘솔·조절값 API 기록을 남긴다 (사진·영상은 남기지 않는다)
async function logDiagnostics() {
  if (!diagApp || diagApp.cdp.closed()) return;
  try {
    const state = await diagApp.evaluate(`({ url: location.href, ready: document.readyState, devHidden: document.getElementById('dev-info').hidden,
      panel: !document.getElementById('operator-panel').hidden, status: document.getElementById('status').hidden ? '' : document.getElementById('status').textContent })`);
    log('DIAG page', JSON.stringify(state));
    log(`DIAG D screen\n${await diagApp.devText()}`);
  } catch (error) {
    log('DIAG page unreadable:', error.message);
  }
  log(`DIAG recent events (${diagApp.events.tail.length})\n${diagApp.events.tail.join('\n')}`);
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitReady(app) {
  await app.waitFor('camera ready', async () => /^ready/.test((await app.dev()).get('status') ?? ''), 20000);
  await app.waitFor('detector running', async () => /^running, health ok/.test((await app.dev()).get('detector') ?? ''), 20000);
  await app.waitFor('settings loaded', async () => !/^loading/.test((await app.dev()).get('settings') ?? 'loading'), 10000);
  await app.waitFor('timing settings loaded', async () => !/\(loading, /.test((await app.dev()).get('timing') ?? '(loading, '), 10000);
}

async function runScenarios(app, origin) {
  diagApp = app;
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
    // 반응 속도 (2026-10-27): 시간 파일이 없으면(옮길 옛 값도 없으면) 기본값 인식·이탈 250ms. 10단계부터 E 시간 섹션의 보이는 묶음에, 초로 보인다
    const timing = /hold (\d+)ms, grace (\d+)ms/.exec(dev.get('criteria') ?? '');
    if (/\(defaults \(no file\), /.test(dev.get('timing') ?? '')) {
      expect(timing?.[1] === '250' && timing?.[2] === '250', `criteria ${dev.get('criteria')}`);
    }
    const timingUi = await app.evaluate(`['presentHoldMs', 'absentGraceMs'].map((key) => {
      const input = document.querySelector('#timing-panel input[data-key="' + key + '"]');
      return { key, inDetails: !!input.closest('details'), range: input.min + '~' + input.max + '/' + input.step,
        shown: document.querySelector('#timing-panel output[data-key="' + key + '"]').textContent,
        inPresence: !!document.querySelector('#tuning-panel [data-key="' + key + '"]') };
    })`);
    expect(timingUi.every((t) => !t.inDetails && !t.inPresence && t.range === '0~2000/50'), `timing sliders ${JSON.stringify(timingUi)}`);
    return `camera "${dev.get('camera')}", delegate ${dev.get('delegate')}, ${dev.get('video')}, detect @ ${parseFps(dev.get('detect'))}fps, settings ${dev.get('settings')},`
      + ` timing ${/\(([^,]+), \/local-api/.exec(dev.get('timing') ?? '')?.[1] ?? '?'};`
      + ` hold ${timing?.[1]}ms grace ${timing?.[2]}ms (panel shows ${timingUi.map((t) => t.shown).join('/')}s);`
      + ` fonts loaded, ${assets.files.length} assets 200`;
  });

  await scenario('S 수동 한 사이클 (결과 사진 표시 → 쿨타임 → 대기), 사진 자원 0', async () => {
    const { completedDelta, resources, dev, image } = await withAutoPaused(app, () => manualCycle(app));
    expect(completedDelta === 1, `completed +${completedDelta}`);
    expect(photoFree(resources), `resources ${dev.get('resources')}`);
    return `${dev.get('capture')?.split(',')[0]}; result image ${image}; ${dev.get('resources')}`;
  });

  // 결과 사진 준비 (첫 촬영 멈춤 수정): 처리 해상도가 1이 아니면 대기 중에 결과 크기로 한 번 미리 그린다. D time 줄의 `result … ready (ms)`
  const resultReady = (label) => app.waitFor(label, async () => /result 1080x1920 ready(?: \(([\d.]+)ms\))?$/.exec(subLine(await app.devText(), 'time'))?.[0], 5000);

  await scenario('사진 효과 미리보기: 캔버스 표시, 기본값 540x960·초당 그림 12, 초당 그림 = fps, 결과 크기 미리 준비, 컨텍스트 손실 → 원본 미리보기 → 복구 → 다시 준비', async () => {
    const line = await app.waitFor('effect running', async () => {
      const value = (await app.dev()).get('effect') ?? '';
      return /^running, \d+x\d+/.test(value) ? value : null;
    }, 10000);
    await sleep(2500); // 초당 그림 수는 최근 1초로 잰다
    const running = (await app.dev()).get('effect') ?? '';
    const m = /fps (\d+) -> (\d+) drawings\/s/.exec(running);
    expect(m && Math.abs(Number(m[2]) - Number(m[1])) <= 1, `drawings/s: ${running}`);
    // 조절값 파일이 없으면 기본값: 처리 해상도 0.5 → 540x960, 초당 그림 12 (사용자 결정 2026-10-19)
    expect(/^running, 540x960 \(preview x0\.5,/.test(running) && m[1] === '12', `defaults: ${running}`);
    // 강도 0.3·붓 크기 1.3·보완 층 문턱 0.3·밝기 -0.05·대비 1.5·감마 1.3 (사용자 결정 2026-10-26). 좌우 반전은 9-1부터 카메라 설정(D mirror 줄)
    const values = subLine(await app.devText(), 'values');
    expect(/^strength 0\.3 size 1\.3 boil 0\.05 fps 12 grade 1 refine 0\.3 scale 0\.5 \| output gray-oil /.test(values)
      && /brightness -0\.05 contrast 1\.5 gamma 1\.3 \(defaults\b/.test(values), `default values: ${values}`);
    const ready = await resultReady('result prepared');
    const layout = await app.evaluate(`(() => { const c = document.getElementById('effect'), v = document.getElementById('preview');
      const box = (e) => { const r = e.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map(Math.round).join(','); };
      const raw = document.getElementById('camera-raw');
      return { hidden: c.hidden, canvas: box(c), video: box(v), canvasTransform: getComputedStyle(c).transform, rawHidden: raw.hidden }; })()`);
    expect(!layout.hidden && layout.canvas === layout.video, `canvas ${JSON.stringify(layout)}`);
    expect(layout.rawHidden && /^off \(effect running\)/.test((await app.dev()).get('raw-view') ?? ''), `raw preview while effect runs ${JSON.stringify(layout)}`);
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
    const readyAgain = await resultReady('result prepared after restore');
    return `${line.split(', fps')[0]}; ${m[2]} drawings/s at fps ${m[1]}; ${ready}; context lost → camera preview → restored → ${readyAgain}`;
  });

  await scenario('촬영 결과(회색조 유화 기본값): 1080x1920 JPEG = 셔터 순간 미리보기 그림(540x960, 같은 영역 블록 비교), 미리보기·결과 무채색, 인쇄 데이터 576x1024 1비트(블루 노이즈, GPU = CPU), 결과 폭 1/2', async () => withAutoPaused(app, async () => {
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
      // 원본 미리보기 (9-1): 카메라 처리 경로를 거친 캔버스가 효과 대신 보이고 계속 그린다
      const raw1 = await app.waitFor('raw preview shown', async () => /^shown \d+x\d+, draws (\d+)/.exec((await app.dev()).get('raw-view') ?? ''), 5000);
      await sleep(600);
      const raw2 = /^shown (\d+x\d+), draws (\d+)/.exec((await app.dev()).get('raw-view') ?? '');
      expect(raw2 && Number(raw2[2]) > Number(raw1[1]), `raw preview keeps drawing: ${raw1?.[0]} -> ${raw2?.[0]}`);
      expect(await app.evaluate("!document.getElementById('camera-raw').hidden"), 'raw preview canvas hidden in fallback');
      expect((await app.status()) === '', 'visitor status message shown in fallback');
      const { completedDelta, resources, dev: after } = await withAutoPaused(app, () => manualCycle(app));
      // 회색조 유화 기본값: 원본 사진(결과 크기)을 입력 회색조·레벨로, 인쇄 데이터도 그 사진에서 (8단계)
      expect(/^RAW PHOTO gray-oil 1080x1920 /.test(after.get('photo-fx') ?? ''), `photo-fx ${after.get('photo-fx')}`);
      expect(/^576x1024 1-bit/.test(after.get('print') ?? ''), `print ${after.get('print')}`);
      expect(completedDelta === 1, `S completed +${completedDelta}`);
      expect(resources && resources.urls === 0 && resources.canvases === 0 && resources.pending === 0, 'resources not released');
      return `${effect}; raw preview ${raw2[1]} (${raw2[2]} draws); camera ready, detector ok, S cycle ok`;
    } finally {
      await app.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    }
  });

  await scenario('출력 모드 전환(E, 기본값 밖의 세 모드, 처리 해상도 1): 끔 1080x1920 JPEG, 회색조 1080x1920 JPEG, 감열지 Atkinson(CPU) PNG = 미리보기, 용지 384점·감마 저장 → 새로고침 유지', async () => {
    const details = [];
    try {
      await app.open();
      await waitReady(app);
      await app.openSection('effect');
      await previewScaleOne(app);
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
      // 용지 384점(58mm), 감마 1.6(기본값 1.3과 다르게) → 저장 → 새로고침
      await app.choose('paperDots', '384');
      await app.evaluate(`(() => { const i = document.querySelector('#effect-panel input[data-key="gamma"]'); i.value = '1.6'; i.dispatchEvent(new Event('input')); return true; })()`);
      await app.waitFor('paper 384', async () => /^thermal 384x683 atkinson/.test(subLine(await app.devText(), 'output')), 5000);
      await app.evaluate("document.querySelector('#effect-panel button[data-action=\"save\"]').click(); true");
      await app.waitFor('saved message', () => app.evaluate("document.querySelector('#effect-panel [data-message]').textContent === '파일에 저장했습니다.'"), 5000);
      await app.closePanel();
      await app.open(); // 새로고침
      await waitReady(app);
      const kept = await app.waitFor('kept after reload', async () => {
        const text = await app.devText();
        return /^thermal 384x683 atkinson/.test(subLine(text, 'output')) && /output thermal atkinson paper 384 .*gamma 1\.6/.test(subLine(text, 'values'))
          ? subLine(text, 'output') : null;
      }, 10000);
      const canvas = await app.evaluate("(() => { const c = document.getElementById('effect'); return c.width + 'x' + c.height + ' ' + getComputedStyle(c).imageRendering; })()");
      expect(canvas === '1080x1920 auto', `canvas after reload ${canvas}`);
      const api = await app.evaluate(`(async () => (await (await fetch('${EFFECT_SETTINGS_API}', { cache: 'no-store' })).json()))()`);
      expect(api.version === 1 && api.settings.outputMode === 'thermal' && api.settings.dither === 'atkinson' && api.settings.paperDots === 384
        && api.settings.gamma === 1.6, `file ${JSON.stringify(api)}`);
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

  await scenario('흑백 스타일 4가지(E, 감열지, 처리 해상도 1): 미리보기 캔버스 1080x1920·D 표시, 붓 결 선·흐름 선·질감 강조 점 결과 = 셔터 순간 그림(화면용 PNG 화소까지, 인쇄 576x1024), 저장 → 새로고침 유지 (파일은 원래대로)', async () => {
    const details = [];
    try {
      await app.open();
      await waitReady(app);
      await app.openSection('effect');
      await app.choose('outputMode', 'thermal'); // 흑백 스타일은 감열지에서만 (8단계부터 기본 모드는 회색조 유화)
      await previewScaleOne(app);
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
      await app.closePanel();
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
      await app.openSection('effect');
      await app.slide('fps', 18); // 기본값(12)과 다른 값
      await sleep(2000);
      const live = (await app.dev()).get('effect') ?? '';
      expect(/fps 18 -> 1[7-9] drawings\/s/.test(live), `after slider: ${live}`);
      await app.evaluate("document.querySelector('#effect-panel button[data-action=\"save\"]').click(); true");
      await app.waitFor('saved message', () => app.evaluate("document.querySelector('#effect-panel [data-message]').textContent === '파일에 저장했습니다.'"), 5000);
      await app.closePanel();
      await app.open(); // 새로고침
      await waitReady(app);
      const kept = await app.waitFor('fps 18 after reload', async () => {
        const value = (await app.dev()).get('effect') ?? '';
        return /fps 18 ->/.test(value) ? value : null;
      }, 10000);
      const api = await app.evaluate(`(async () => {
        const url = '${EFFECT_SETTINGS_API}';
        const get = await fetch(url, { cache: 'no-store' });
        const body = await get.json();
        const noHeader = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
        const other = await fetch('/local-api/Effect-Settings', { cache: 'no-store' });
        return { get: get.status, fps: body.settings.fps, version: body.version, noHeader: noHeader.status, other: other.status };
      })()`);
      expect(api.get === 200 && api.fps === 18 && api.version === 1, `GET ${JSON.stringify(api)}`);
      expect(api.noHeader === 403 && api.other === 404, `rejects ${JSON.stringify(api)}`);
      return `slider fps 18 applied live; saved; after reload ${kept.split(', boil')[0].replace(/^running, /, '')}; API GET 200, no header 403, other case 404`;
    } finally {
      const restored = restoreSettings('after effect settings scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
    }
  });

  // ---- 카메라 처리 경로 (9-1): 카메라 설정은 지금 파일·API로만 바꾼다(운영자 화면은 9-2). 파일을 쓰고 새로고침해 그 값으로 시작한다 ----
  const putCamera = async (patch) => {
    const body = JSON.stringify({ version: 1, settings: { ...CAMERA_DEFAULTS, ...patch } }, null, 2);
    const status = await app.evaluate(`(async () => (await fetch('${CAMERA_SETTINGS_API}', { method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Photobooth': '1' }, body: ${JSON.stringify(body)} })).status)()`);
    expect(status === 204, `PUT camera settings ${status}`);
  };
  const openWithCamera = async (patch) => {
    await putCamera(patch);
    await app.open();
    await waitReady(app);
    await app.waitFor('camera settings loaded', async () => /^file\b/.test((await app.dev()).get('camera-cfg') ?? ''), 5000);
    await app.evaluate(MIRROR_READER);
  };
  const getJson = (url) => app.evaluate(`(async () => { const r = await fetch('${url}', { cache: 'no-store' }); return r.status === 200 ? r.json() : r.status; })()`);

  await scenario('좌우 반전(카메라 설정, 9-1에 효과 설정에서 옮김) 켬 → 끔: 효과 미리보기·결과 사진 방향(영상과 격자 상관), 얼굴 화면 x, 효과 파일의 예전 mirror 옮기기 (파일은 원래대로)', async () => {
    const details = [];
    // 지금 반전 상태: D mirror 줄, 효과 그림 ↔ 영상 상관(새 그림 8장 이상)
    const look = async (label) => {
      await app.evaluate('window.__mirrorReader.samples.length = 0; true');
      await app.waitFor(`${label}: drawings`, async () => (await app.evaluate('window.__mirrorReader.samples.length')) >= 8, 5000);
      const css = await app.evaluate(`(() => ({ video: getComputedStyle(document.getElementById('preview')).transform,
        canvas: getComputedStyle(document.getElementById('effect')).transform }))()`);
      return { dev: (await app.dev()).get('mirror'), css, preview: await app.evaluate(MIRROR_PREVIEW) };
    };
    const expectLook = (s, on, label) => {
      expect(s.dev === `${on ? 'on' : 'off'} (camera settings)`, `${label}: D mirror ${s.dev}`);
      expect(s.css.video === 'none' && s.css.canvas === 'none', `${label}: no CSS mirroring ${JSON.stringify(s.css)}`);
      expect(s.preview.n >= 8 && oriented(s.preview, on), `${label}: preview vs video ${JSON.stringify(s.preview)} (anti ±${MIRROR_ANTI})`);
      return `${label} preview~video anti ${s.preview.anti} (${s.preview.n} drawings, same ${s.preview.same} / flipped ${s.preview.flipped})`;
    };
    // S 한 장: 결과 ↔ 셔터 순간 그림(같은 방향이어야), 결과 ↔ 그 그림의 영상(반전이면 거울 방향), D capture 줄의 mirrored
    const shot = async (on, label) => {
      await app.evaluate('window.__mirrorReader.shutter = null; true');
      const { completedDelta, resources, dev, extra } = await withAutoPaused(app, () => manualCycle(app, { onResult: () => app.evaluate(MIRROR_RESULT) }));
      expect(completedDelta === 1 && photoFree(resources), `${label}: S +${completedDelta}, ${dev.get('resources')}`);
      const fx = dev.get('photo-fx') ?? '';
      expect(/^applied gray-oil 1080x1920 /.test(fx), `${label}: photo-fx ${fx}`);
      expect(/, mirrored\)/.test(dev.get('capture') ?? '') === on, `${label}: capture ${dev.get('capture')}`);
      expect(extra.drawing && oriented(extra.drawing, false), `${label}: result vs shutter drawing ${JSON.stringify(extra)}`);
      expect(oriented(extra.video, on), `${label}: result vs video at shutter ${JSON.stringify(extra)}`);
      return `${label} result~drawing anti ${extra.drawing.anti} (same ${extra.drawing.same}), result~video anti ${extra.video.anti}`
        + `${fx.includes('same drawing as preview') ? ', same drawing as preview' : ', new drawing'}`;
    };
    try {
      await openWithCamera({ mirror: true });
      const on = await look('on');
      details.push(expectLook(on, true, 'on'));
      details.push(await shot(true, 'on'));
      const facesOn = facesOf(await app.devText()); // 바꾸기 바로 전 얼굴 위치 (화면 좌표 x)
      await openWithCamera({ mirror: false });
      // 얼굴이 하나 보였으면(실제 카메라 앞 사람) 바꾼 뒤 화면 좌표 x가 1 - x 근처로 바뀐다. 없으면 미검증으로 남긴다
      const facesOff = facesOn.length === 0 ? [] : await app.waitFor('faces after mirror off', async () => {
        const list = facesOf(await app.devText());
        return list.length > 0 ? list : null;
      }, 4000).catch(() => []);
      const off = await look('off');
      details.push(expectLook(off, false, 'off'));
      if (facesOn.length === 1 && facesOff.length === 1) {
        expect(Math.abs(facesOff[0] - (1 - facesOn[0])) < 0.1, `face center x on ${facesOn[0]} -> off ${facesOff[0]}`);
        details.push(`face center x on ${facesOn[0]} -> off ${facesOff[0]}`);
      } else {
        details.push(`face position not checked (faces on ${facesOn.length}, off ${facesOff.length})`);
      }
      details.push(await shot(false, 'off'));

      // 예전 효과 파일(2026-10-26 ~ 9-1)의 mirror: 카메라 파일이 없으면 처음 읽을 때 카메라 파일로 옮기고 효과 파일에서 뺀다
      const effectNow = await getJson(EFFECT_SETTINGS_API);
      const effectOld = { version: 1, settings: { ...(typeof effectNow === 'object' ? effectNow.settings : {}), fps: 12, mirror: false } };
      const putEffect = await app.evaluate(`(async () => (await fetch('${EFFECT_SETTINGS_API}', { method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Photobooth': '1' }, body: ${JSON.stringify(JSON.stringify(effectOld, null, 2))} })).status)()`);
      expect(putEffect === 204, `PUT old effect file ${putEffect}`);
      rmSync(CAMERA_SETTINGS_FILE, { force: true });
      await app.open();
      await waitReady(app);
      const cfg = await app.waitFor('camera settings migrated', async () => {
        const value = (await app.dev()).get('camera-cfg') ?? '';
        return /^migrated/.test(value) ? value : null;
      }, 5000);
      expect((await app.dev()).get('mirror') === 'off (camera settings)', `after migration D mirror ${(await app.dev()).get('mirror')}`);
      const cameraFile = await getJson(CAMERA_SETTINGS_API);
      const effectFile = await getJson(EFFECT_SETTINGS_API);
      expect(cameraFile.version === 1 && cameraFile.settings.mirror === false, `camera file ${JSON.stringify(cameraFile)}`);
      expect(!('mirror' in effectFile.settings) && effectFile.settings.fps === 12, `effect file still has mirror ${JSON.stringify(effectFile)}`);
      details.push(`migration: ${cfg.split(' (/local-api')[0]}; camera file mirror false; effect file without mirror`);
      return details.join('; ');
    } finally {
      const restored = restoreSettings('after mirror scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
    }
  });

  // 화면 갱신(2초 rAF), 감지 빈도, 효과 초당 그림
  const measureSpeed = async () => {
    const raf = await app.evaluate(`new Promise((resolve) => { let n = 0; const t0 = performance.now();
      const step = () => { n += 1; if (performance.now() - t0 < 2000) requestAnimationFrame(step); else resolve(+(n * 1000 / (performance.now() - t0)).toFixed(1)); };
      requestAnimationFrame(step); })`);
    const dev = await app.dev();
    return { raf, detect: parseFps(dev.get('detect')), drawings: Number(/-> (\d+) drawings\/s/.exec(dev.get('effect') ?? '')?.[1] ?? NaN),
      input: /input (\S+)/.exec(dev.get('detect') ?? '')?.[1] ?? '-' };
  };

  await scenario('카메라 변환·색 보정(가로 카메라 90°·세로 카메라 0°에 미세 회전 3°·확대 1.3·이동·밝기·대비·채도·감마·색온도·색조, 9-1): 2D(감지·캡처·원본) = 기준식 = 효과 셰이더 입력, 미리보기·결과 = 변환한 영상, 얼굴 위치, 화면·감지·효과 속도 (파일은 원래대로)', async () => {
    const details = [];
    try {
      // 변환 없는 상태: 얼굴(있으면, 바꾼 뒤 위치를 예측한다)과 속도 기준
      await openWithCamera({ mirror: false });
      await sleep(1500); // 감지·효과 빈도는 최근 1초로 잰다
      const videoSize = /^(\d+)x(\d+)/.exec((await app.dev()).get('video') ?? '');
      const facesBefore = facesXY(await app.devText());
      const base = await measureSpeed();
      // 옆으로 세운 가로 카메라(가짜 카메라 정사각형 포함)를 90° 돌리는 쓰임: 카메라 기준 1920x1080으로 요청.
      // 세로 카메라(OBS 9:16 출력)는 90° 돌리면 가로 그림이 되므로 0°에 미세 회전만
      const landscape = videoSize && Number(videoSize[1]) >= Number(videoSize[2]);
      const T = {
        mirror: false, rotation: landscape ? 90 : 0, rotationFine: 3, zoom: 1.3, panX: 0.05, panY: -0.04,
        brightness: 0.06, contrast: 1.15, saturation: 0.6, gamma: 1.2, temperature: 0.3, tint: -0.2, resolution: landscape ? '1920x1080' : 'auto',
      };
      const camera = { ...CAMERA_DEFAULTS, ...T };
      await openWithCamera(T);
      const dev = await app.dev();
      const transform = dev.get('transform') ?? '';
      expect(new RegExp(`^rotate ${T.rotation}\\+3deg, zoom 1\\.3 \\(used [\\d.]+(?: auto)?\\), pan 0\\.05,-0\\.04, source \\d+x\\d+px$`).test(transform), `D transform ${transform}`);
      expect(/^brightness 0\.06 contrast 1\.15 saturation 0\.6 gamma 1\.2 temperature 0\.3 tint -0\.2$/.test(dev.get('color') ?? ''), `D color ${dev.get('color')}`);
      expect(/^\d+x\d+ @/.test(dev.get('track') ?? '') && new RegExp(`resolution ${T.resolution}\\)$`).test(dev.get('track') ?? ''), `D track ${dev.get('track')}`);
      details.push(`video ${videoSize?.[0]} -> ${dev.get('video')} (resolution ${T.resolution})`);
      details.push(`D ${transform}; caps ${dev.get('caps')}`);

      // ① 같은 프레임의 2D(앱 SVG 필터) = core 기준식, ② 효과 셰이더 입력 = 2D (화소·격자)
      const path = await app.evaluate(cameraPathCheck(camera));
      expect(path.filter.startsWith('url(#camera-color-'), `app filter ${path.filter}`);
      expect(path.svgVsRef.p99 <= 3 && path.svgVsRef.mean <= 1.5, `2D SVG filter vs reference ${JSON.stringify(path)}`);
      expect(path.glVs2d.mean <= 3 && path.gridGlVs2d <= 3, `shader input vs 2D ${JSON.stringify(path)}`);
      expect(path.colorEffect >= 3, `color correction had no effect ${JSON.stringify(path)}`);
      details.push(`path ${path.size} from ${path.video}: 2D filter~reference mean ${path.svgVsRef.mean} p99 ${path.svgVsRef.p99},`
        + ` shader~2D mean ${path.glVs2d.mean} p99 ${path.glVs2d.p99} grid max ${path.gridGlVs2d}, color change ${path.colorEffect}`);

      // ③ 효과 미리보기 ↔ 같은 순간 변환한 영상 (변환 전 cover 영상보다 뚜렷이 높아야)
      await app.evaluate(`(async () => { const cv = await import('/core/camera-view.js'); const r = window.__mirrorReader, v = document.getElementById('preview');
        r.canvasTransform = cv.canvasTransform; r.view = cv.computeCameraView({ videoWidth: v.videoWidth, videoHeight: v.videoHeight, stageAspect: 9 / 16, camera: ${JSON.stringify(camera)} });
        r.samples.length = 0; return true; })()`);
      await app.waitFor('transformed drawings', async () => (await app.evaluate(CAMERA_PREVIEW)).n >= 8, 5000);
      const preview = await app.evaluate(CAMERA_PREVIEW);
      expect(preview.stage >= 0.6 && preview.stage - preview.cover >= 0.1, `preview vs transformed video ${JSON.stringify(preview)}`);
      details.push(`preview~transformed video ${preview.stage} (min ${preview.stageMin}) vs untransformed ${preview.cover}`);

      // ④ 결과 사진 = 셔터 순간 그림, 결과 ↔ 그 순간 변환한 영상. D capture 줄에 회전·배율·색 보정
      await app.evaluate('window.__mirrorReader.shutter = null; true');
      const { completedDelta, resources, dev: after, extra } = await withAutoPaused(app, () => manualCycle(app, { onResult: () => app.evaluate(MIRROR_RESULT) }));
      expect(completedDelta === 1 && photoFree(resources), `S +${completedDelta}, ${after.get('resources')}`);
      const capture = after.get('capture') ?? '';
      expect(new RegExp(`^\\d+x\\d+ from video \\d+x\\d+ \\(rotate ${T.rotation + 3} zoom [\\d.]+(?: auto)?, color\\)`).test(capture), `capture ${capture}`);
      expect(/^applied gray-oil 1080x1920 /.test(after.get('photo-fx') ?? ''), `photo-fx ${after.get('photo-fx')}`);
      expect(extra.drawing && extra.drawing.same >= 0.9, `result vs shutter drawing ${JSON.stringify(extra)}`);
      expect(extra.stage && extra.stage.same >= 0.6, `result vs transformed video ${JSON.stringify(extra)}`);
      details.push(`capture ${capture.split(', image')[0].split(' grab')[0]}; result~drawing ${extra.drawing.same}, result~transformed video ${extra.stage.same}`);

      // ⑤ 얼굴(실제 카메라 앞 사람): 변환 전 화면 위치 → 원본 → 변환 뒤 화면 위치로 예측한 곳에 있다. 없으면 미검증
      const facesAfter = facesXY(await app.devText());
      if (facesBefore.length === 1 && facesAfter.length === 1 && videoSize) {
        const [W, H] = [Number(videoSize[1]), Number(videoSize[2])];
        const v0 = computeCameraView({ videoWidth: W, videoHeight: H, stageAspect: 9 / 16, camera: { ...CAMERA_DEFAULTS, mirror: false } });
        const v1 = computeCameraView({ videoWidth: W, videoHeight: H, stageAspect: 9 / 16, camera });
        const predicted = mapPoint(v1.sourceToStage, mapPoint(v0.stageToSource, facesBefore[0]));
        const off = Math.hypot(predicted.x - facesAfter[0].x, predicted.y - facesAfter[0].y);
        expect(off < 0.1, `face before ${JSON.stringify(facesBefore[0])} -> predicted ${JSON.stringify(predicted)}, seen ${JSON.stringify(facesAfter[0])}`);
        details.push(`face ${facesBefore[0].x},${facesBefore[0].y} -> predicted ${predicted.x.toFixed(2)},${predicted.y.toFixed(2)}, seen ${facesAfter[0].x},${facesAfter[0].y}`);
      } else {
        details.push(`face position not checked (faces before ${facesBefore.length}, after ${facesAfter.length})`);
      }

      // ⑥ 속도: 변환·색 보정을 켠 상태가 변환 없는 같은 환경보다 떨어지지 않는다 (화면 −10% 안, 감지 12fps·효과 11장/초 이상)
      const speed = await measureSpeed();
      expect(speed.raf >= base.raf * 0.9 && speed.detect >= 12 && speed.drawings >= 11,
        `speed ${JSON.stringify(speed)} vs without transform ${JSON.stringify(base)}`);
      details.push(`speed: screen ${speed.raf}fps (without transform ${base.raf}), detect ${speed.detect}fps (${base.detect}, input ${speed.input}),`
        + ` effect ${speed.drawings} drawings/s (${base.drawings})`);
      return details.join('; ');
    } finally {
      const restored = restoreSettings('after camera transform scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
      await app.open();
      await waitReady(app);
    }
  });

  await scenario('카메라 장치·해상도(9-1): 해상도 프리셋 요청 → 실제 트랙·캡처, 다른 카메라가 있으면 그 라벨로 열기, 없는 라벨이면 OBS·기본 규칙 (파일은 원래대로)', async () => {
    const details = [];
    try {
      // 해상도 프리셋: ideal로만 요청하므로 장치가 고른 값을 그대로 보고, 그 크기로 캡처·결과가 돈다
      await openWithCamera({ resolution: '1280x720' });
      let dev = await app.dev();
      // 장치가 고른 크기를 그대로 보고한다 (OBS 가상카메라는 자기 출력 1080x1920을 1280x720 비율로 잘라 1080x720을 준다, 9-1 실측)
      const track = dev.get('track') ?? '';
      expect(/\(ideal 1280x720, resolution 1280x720\)$/.test(track), `D track ${track}`);
      const video = /^(\d+)x(\d+)$/.exec(dev.get('video') ?? '');
      expect(video && Number(video[1]) > 0, `video ${dev.get('video')}`);
      const { completedDelta, resources, dev: shot } = await withAutoPaused(app, () => manualCycle(app));
      expect(completedDelta === 1 && photoFree(resources), `S +${completedDelta}, ${shot.get('resources')}`);
      details.push(`preset 1280x720 -> video ${dev.get('video')}, track ${track.split(' (')[0]}; S ok (${(shot.get('capture') ?? '').split(' (')[0]})`);
      // 다른 카메라: 지금 장치와 라벨이 다른 장치가 있으면 그 라벨로 연다 (deviceId가 아니라 라벨로 저장)
      const labels = await app.evaluate(`(async () => (await navigator.mediaDevices.enumerateDevices())
        .filter((d) => d.kind === 'videoinput').map((d) => d.label))()`);
      // 다른 프로그램이 쓰는 장치(예: OBS가 소스로 잡은 웹캠)는 열리지 않는다(NotReadableError → unavailable, 간격 재시도). 기록하고 다음 장치로
      const current = dev.get('camera');
      const busy = [];
      let switched = null;
      for (const label of labels.filter((l) => l && l !== current)) {
        await putCamera({ deviceLabel: label });
        await app.open();
        const seen = await app.waitFor(`camera "${label}"`, async () => {
          const d = await app.dev();
          if (/^ready/.test(d.get('status') ?? '')) return { ready: true, d };
          const attempts = Number(/^(\d+) total/.exec(d.get('attempts') ?? '')?.[1] ?? 0);
          return /^(unavailable|not-found|no-frames)/.test(d.get('status') ?? '') && attempts >= 2 ? { ready: false, d } : null;
        }, 15000);
        if (!seen.ready) {
          busy.push(`"${label}" ${seen.d.get('status')} / ${seen.d.get('reason')}`);
          continue;
        }
        await waitReady(app);
        dev = await app.dev();
        expect(dev.get('camera') === label && /^device /.test(dev.get('selected') ?? ''), `camera ${dev.get('camera')}, selected ${dev.get('selected')}`);
        switched = `device "${label}" -> ${dev.get('video')} (selected device)`;
        break;
      }
      if (busy.length) details.push(`not opened (kept retrying, as designed): ${busy.join(', ')}`);
      details.push(switched ?? `no other camera could be opened (${labels.join(', ')}): device switch not checked`);
      // 없는 라벨: OBS 규칙(있으면 preferred) 또는 기본 카메라
      await putCamera({ deviceLabel: 'No Such Camera 9-1' });
      await app.open();
      await waitReady(app);
      dev = await app.dev();
      expect(/^(preferred|default) \(device "No Such Camera 9-1"/.test(dev.get('selected') ?? ''), `selected ${dev.get('selected')}`);
      details.push(`missing label -> ${(dev.get('selected') ?? '').split(' (')[0]} "${dev.get('camera')}"`);
      return details.join('; ');
    } finally {
      const restored = restoreSettings('after camera device scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
      await app.open();
      await waitReady(app);
    }
  });

  await scenario('운영자 패널(E 하나, 9-2): R 없음·섹션 넷, 카메라 값 실행 중 즉시 반영(해상도 다시 열기·회전·확대·반전·색 보정 → 미리보기·원본 창·D), 섹션별 저장 → 새로고침 유지·닫을 때 되돌리기·섹션별 기본값, 원본 창 켬/끔 속도 (파일은 원래대로)', async () => {
    const details = [];
    const cam = '#camera-panel';
    const shown = (id) => `!document.getElementById('${id}').hidden`;
    const setView = (camera) => app.evaluate(`(async () => { const cv = await import('/core/camera-view.js'); const r = window.__mirrorReader, v = document.getElementById('preview');
      r.canvasTransform = cv.canvasTransform; r.view = cv.computeCameraView({ videoWidth: v.videoWidth, videoHeight: v.videoHeight, stageAspect: 9 / 16, camera: ${JSON.stringify(camera)} });
      r.samples.length = 0; return true; })()`);
    const message = (scope) => app.evaluate(`document.querySelector('${scope} [data-message]').textContent`);
    try {
      await openWithCamera({});
      const videoSize = /^(\d+)x(\d+)$/.exec((await app.dev()).get('video') ?? '');
      const landscape = videoSize && Number(videoSize[1]) >= Number(videoSize[2]);
      // R은 아무것도 열지 않는다 (9-2: 인식 범위는 E의 인식 섹션)
      await app.key('KeyR');
      await sleep(300);
      expect(await app.evaluate(`document.getElementById('operator-panel').hidden && document.getElementById('tuning-layer').hidden`), 'R opened a panel');
      // E: 처음 섹션은 카메라, 원본 창이 보이고 영역 편집 층은 숨김, OBS 중복 적용 주의
      await app.key('KeyE');
      await app.waitFor('operator panel open', () => app.evaluate(shown('operator-panel')), 5000);
      const first = await app.evaluate(`(() => ({ camera: ${shown('camera-panel')}, presence: ${shown('tuning-panel')}, effect: ${shown('effect-panel')},
        layer: ${shown('tuning-layer')}, raw: ${shown('raw-window')}, note: document.querySelector('#camera-panel .op-note').textContent }))()`);
      expect(first.camera && !first.presence && !first.effect && !first.layer && first.raw && /중복 적용 주의/.test(first.note), `first section ${JSON.stringify(first)}`);
      await app.waitFor('raw window drawing', async () => /^shown \d+x\d+, draws [1-9]/.test((await app.dev()).get('raw-window') ?? ''), 5000);
      details.push('R: nothing; E: camera section first, raw window shown');

      // 해상도를 실행 중에 바꾼다 → 카메라를 다시 연다 (그동안 관람객 화면 "준비 중")
      const resolution = landscape ? '1920x1080' : '1080x1920';
      await app.evaluate(`(() => { window.__statusSeen = []; const s = document.getElementById('status');
        new MutationObserver(() => { if (!s.hidden && s.textContent) window.__statusSeen.push(s.textContent); })
          .observe(s, { attributes: true, childList: true, subtree: true, characterData: true }); return true; })()`);
      const attempts = async () => Number(/^(\d+) total/.exec((await app.dev()).get('attempts') ?? '')?.[1] ?? NaN);
      const before = await attempts();
      await app.choose('resolution', resolution, cam);
      await app.waitFor('camera reopened', async () => {
        const d = await app.dev();
        return (await attempts()) > before && /^ready/.test(d.get('status') ?? '') && new RegExp(`resolution ${resolution}\\)$`).test(d.get('track') ?? '');
      }, 15000);
      const seen = await app.evaluate('window.__statusSeen');
      expect(seen.some((t) => t.startsWith('준비 중입니다.')), `guest status during reopen ${JSON.stringify(seen)}`);
      details.push(`resolution ${resolution} live -> video ${(await app.dev()).get('video')} (reopened, guest saw "${seen.find((t) => t.startsWith('준비 중')).replace(/\s+/g, ' ')}")`);

      // 회전·확대·반전·색 보정을 실행 중에 바꾼다 (새로고침 없이)
      if (landscape) await app.press('rotate-right', cam);
      else await app.slide('rotationFine', 3, cam);
      await app.slide('zoom', 1.3, cam);
      await app.choose('mirror', 'false', cam);
      await app.slide('brightness', 0.08, cam);
      await app.slide('saturation', 0.5, cam);
      const T = { ...CAMERA_DEFAULTS, resolution, rotation: landscape ? 90 : 0, rotationFine: landscape ? 0 : 3, zoom: 1.3, mirror: false, brightness: 0.08, saturation: 0.5 };
      let dev = await app.dev();
      expect(new RegExp(`^rotate ${T.rotation}${T.rotationFine ? '\\+3' : ''}deg, zoom 1\\.3 `).test(dev.get('transform') ?? '')
        && dev.get('mirror') === 'off (camera settings)' && /^brightness 0\.08 contrast 1 saturation 0\.5 /.test(dev.get('color') ?? ''),
      `D after live change: ${dev.get('transform')} / ${dev.get('mirror')} / ${dev.get('color')}`);
      expect(/\+ unsaved changes/.test(dev.get('camera-cfg') ?? ''), `camera-cfg ${dev.get('camera-cfg')}`);
      // 미리보기·원본 창 = 같은 순간 변환한 영상
      await setView(T);
      await app.waitFor('transformed drawings', async () => (await app.evaluate(CAMERA_PREVIEW)).n >= 6, 6000);
      const preview = await app.evaluate(CAMERA_PREVIEW);
      const raw = await app.evaluate(RAW_WINDOW_CHECK);
      expect(preview.stage >= 0.6 && preview.stage - preview.cover >= 0.1, `preview vs transformed video ${JSON.stringify(preview)}`);
      expect(!raw.hidden && raw.stage >= 0.8 && raw.stage - raw.cover >= 0.1, `raw window vs transformed video ${JSON.stringify(raw)}`);
      details.push(`live change: ${dev.get('transform')}; preview~transformed ${preview.stage} (untransformed ${preview.cover}),`
        + ` raw window ${raw.size} ~transformed ${raw.stage} (untransformed ${raw.cover})`);

      // 섹션별 저장: 카메라 저장 → 인식 바꿔 저장 → 필터는 바꾸고 저장하지 않음
      await app.press('save', cam);
      await app.waitFor('camera saved', async () => (await message(cam)) === '파일에 저장했습니다.', 5000);
      await app.openSection('presence');
      const inPresence = await app.evaluate(`({ raw: ${shown('raw-window')}, layer: ${shown('tuning-layer')} })`);
      expect(inPresence.raw && inPresence.layer, `presence section ${JSON.stringify(inPresence)}`);
      await app.slide('minScore', 0.8, '#tuning-panel');
      await app.press('save', '#tuning-panel');
      await app.waitFor('presence saved', async () => (await message('#tuning-panel')) === '파일에 저장했습니다.', 5000);
      await app.openSection('effect');
      const inEffect = await app.evaluate(`({ raw: ${shown('raw-window')}, layer: ${shown('tuning-layer')} })`);
      expect(!inEffect.raw && !inEffect.layer, `effect section ${JSON.stringify(inEffect)}`);
      await app.slide('fps', 18);
      const tabs = await app.waitFor('tab dots', async () => {
        const text = await app.evaluate(`[...document.querySelectorAll('#operator-panel [data-section]')].map((b) => b.dataset.section + ':' + b.dataset.save).join(' ')`);
        return /^camera:saved presence:saved timing:[\w-]+ effect:dirty$/.test(text) ? text : null;
      }, 3000);
      // 섹션별 기본값: 카메라 섹션 "기본값으로"는 카메라 값만 (인식 값 그대로)
      await app.openSection('camera');
      await app.press('defaults', cam);
      // D 표는 0.5초마다 다시 그린다
      await app.waitFor('camera defaults only', async () => {
        const d = await app.dev();
        return /^rotate 0deg, zoom 1 /.test(d.get('transform') ?? '') && /min score 0\.8,/.test(d.get('criteria') ?? '')
          && /fps 18 /.test(subLine(await app.devText(), 'values'));
      }, 3000);
      // 닫으면 저장하지 않은 섹션(카메라 기본값·필터 fps)만 되돌린다
      await app.closePanel();
      dev = await app.dev();
      const values = subLine(await app.devText(), 'values');
      expect(new RegExp(`^rotate ${T.rotation}`).test(dev.get('transform') ?? '') && /fps 12 /.test(values) && /min score 0\.8,/.test(dev.get('criteria') ?? '')
        && dev.get('raw-window')?.startsWith('off') && (await app.evaluate("document.getElementById('raw-window').hidden")),
      `after close: ${dev.get('transform')} / ${values} / ${dev.get('criteria')} / ${dev.get('raw-window')}`);
      const cameraFile = await getJson(CAMERA_SETTINGS_API);
      const presenceFile = await getJson(SETTINGS_API);
      expect(cameraFile.settings.rotation === T.rotation && cameraFile.settings.zoom === 1.3 && cameraFile.settings.mirror === false
        && cameraFile.settings.resolution === resolution && presenceFile.settings.minScore === 0.8, `files ${JSON.stringify({ cameraFile, presenceFile })}`);
      details.push(`sections: ${tabs}; camera defaults -> only camera; close -> camera ${dev.get('transform').split(',')[0]} kept, filter fps 12 reverted`);
      // 새로고침 뒤 유지
      await app.open();
      await waitReady(app);
      dev = await app.dev();
      expect(new RegExp(`^rotate ${T.rotation}`).test(dev.get('transform') ?? '') && /^file/.test(dev.get('camera-cfg') ?? '') && /min score 0\.8,/.test(dev.get('criteria') ?? ''),
        `after reload: ${dev.get('transform')} / ${dev.get('camera-cfg')} / ${dev.get('criteria')}`);
      details.push('reload: camera & presence kept');

      // 장치를 실행 중에 바꾼다 (카메라 섹션 목록). 다른 프로그램이 쓰는 장치는 열리지 않으므로 기록하고 다음 장치로. 저장하지 않고 닫아 되돌린다
      await app.openSection('camera');
      const startLabel = (await app.dev()).get('camera');
      await app.waitFor('device list', async () => (await app.evaluate(`document.querySelectorAll('#camera-panel select[data-key="deviceLabel"] option').length`)) > 1, 5000);
      const labels = await app.evaluate(`[...document.querySelectorAll('#camera-panel select[data-key="deviceLabel"] option')].map((o) => o.value).filter(Boolean)`);
      const busyDevices = [];
      let switched = null;
      for (const label of labels.filter((l) => l !== startLabel)) {
        const tried = await attempts();
        await app.choose('deviceLabel', label, cam);
        // 이 장치로 연 시도가 끝난 상태만 본다 (연결 중에는 앞 장치의 상태가 남아 있다)
        const seen = await app.waitFor(`live device "${label}"`, async () => {
          const d = await app.dev();
          if ((await attempts()) <= tried || /connecting/.test(d.get('status') ?? '')) return null;
          if (/^ready/.test(d.get('status') ?? '') && d.get('camera') === label) return { ready: true, d };
          return /^(unavailable|not-found|no-frames)/.test(d.get('status') ?? '') ? { ready: false, d } : null;
        }, 15000);
        if (!seen.ready) {
          busyDevices.push(`"${label}" ${seen.d.get('status')}`);
          continue;
        }
        switched = `live device "${label}" -> ${seen.d.get('video')} (${(seen.d.get('selected') ?? '').split(' (')[0]})`;
        break;
      }
      await app.closePanel();
      await app.waitFor('device reverted', async () => { const d = await app.dev(); return /^ready/.test(d.get('status') ?? '') && d.get('camera') === startLabel; }, 15000);
      details.push(`${switched ?? `no other device opened (${labels.join(', ')})`}${busyDevices.length ? `; not opened: ${busyDevices.join(', ')}` : ''}; close -> back to "${startLabel}"`);

      // 원본 창 켬(카메라 섹션) / 끔(필터 섹션) 속도
      await app.openSection('camera');
      await sleep(1500);
      const on = await measureSpeed();
      await app.openSection('effect');
      await sleep(1500);
      const off = await measureSpeed();
      await app.closePanel();
      expect(on.raf >= off.raf * 0.9 && on.detect >= 12 && on.drawings >= 11, `speed raw window on ${JSON.stringify(on)} / off ${JSON.stringify(off)}`);
      details.push(`speed raw window on: screen ${on.raf}fps, detect ${on.detect}, effect ${on.drawings}/s; off: ${off.raf}fps, ${off.detect}, ${off.drawings}/s`);
      return details.join('; ');
    } finally {
      await app.closePanel().catch(() => {});
      const restored = restoreSettings('after operator panel scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
      await app.open();
      await waitReady(app);
    }
  });

  // 촬영 흐름 시간 (10단계): D 화면은 상태 기계가 바뀔 때마다 바로 다시 그려지므로(renderSession) session 줄의 상태 변화를 페이지 안에서
  // 시각과 함께 기록한다. 카운트다운 숫자, 진행선 애니메이션 길이도 함께. 영상·사진은 읽지 않는다
  const TIMELINE = `(() => {
    if (!window.__timeline) {
      const dev = document.getElementById('dev-info');
      const num = document.getElementById('countdown-number');
      const tl = window.__timeline = { t0: performance.now(), events: [], last: '' };
      const now = () => Math.round(performance.now() - tl.t0);
      new MutationObserver(() => {
        const line = dev.textContent.split('\\n').find((l) => l.startsWith('session'));
        const state = /:\\s?(\\S+)/.exec(line ?? '')?.[1] ?? '';
        if (!state || state === tl.last) return;
        tl.last = state;
        const bar = state === 'countdown' ? document.getElementById('countdown-progress-fill').getAnimations()[0]?.effect.getTiming().duration : undefined;
        tl.events.push({ state, at: now(), bar });
      }).observe(dev, { childList: true, subtree: true, characterData: true });
      new MutationObserver(() => tl.events.push({ number: num.textContent, at: now() })).observe(num, { childList: true, subtree: true, characterData: true });
    }
    window.__timeline.events.length = 0;
    return true; })()`;
  // S를 누르거나(press) 이미 누른 회차가 대기로 돌아올 때까지 기다리고 단계별 시간을 돌려준다
  const timedRound = async ({ during } = {}) => {
    await app.evaluate(TIMELINE);
    await app.key('KeyS');
    await app.waitFor('round countdown', async () => (await app.evaluate('window.__timeline.events')).some((e) => e.state === 'countdown'), 3000);
    const extra = during ? await during() : undefined;
    const events = await app.waitFor('round back to idle', async () => {
      const list = await app.evaluate('window.__timeline.events');
      return list.some((e) => e.state === 'idle') ? list : null;
    }, 90000);
    const at = (state) => events.find((e) => e.state === state)?.at ?? NaN;
    return {
      countdown: at('capturing') - at('countdown'), result: at('cooldown') - at('result'), cooldown: at('idle') - at('cooldown'),
      numbers: events.filter((e) => e.number !== undefined).map((e) => e.number).join(''), bar: events.find((e) => e.state === 'countdown')?.bar, extra,
    };
  };
  const near = (value, target, tolerance) => Math.abs(value - target) <= tolerance;
  const expectRound = (r, { countdown, result, cooldown }, label) => {
    const numbers = Array.from({ length: countdown }, (_, i) => String(countdown - i)).join('');
    expect(near(r.countdown, countdown * 1000, 250) && r.numbers === numbers && r.bar === countdown * 1000
      && near(r.result, result, 300) && near(r.cooldown, cooldown, 250), `${label}: ${JSON.stringify(r)}`);
    return `${label} countdown ${r.countdown}ms (${r.numbers}, bar ${r.bar}ms), result ${r.result}ms, cooldown ${r.cooldown}ms`;
  };

  await scenario('시간 섹션(E, 10단계): 인식 섹션에 시간 설정 없음, 조절 → 즉시 반영(반응 시간)·저장 → 새로고침 유지, 카운트다운·결과·쿨타임이 바뀐 값대로, 회차 도중 바꾸면 다음 회차부터, 인식 파일의 옛 시간 키 옮기기·옮기기 실패(저장 필요·인식 파일 그대로·인식 저장해도 남음) (파일은 원래대로)', async () => {
    const details = [];
    const tp = '#timing-panel';
    const shown = (id) => `!document.getElementById('${id}').hidden`;
    const message = (scope) => app.evaluate(`document.querySelector('${scope} [data-message]').textContent`);
    const timingLine = async () => (await app.dev()).get('timing') ?? '';
    const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
    const stage9 = { region: { x: 0.12, y: 0.1, width: 0.76, height: 0.8 }, minFaceHeight: 0.185, maxFaceHeight: 0.47, minScore: 0.65 };
    const legacy = { presentHoldMs: 300, absentGraceMs: 350,
      cameraRecovery: { retryIntervalMs: 3500, firstFrameTimeoutMs: 6000, stallTimeoutMs: 2500, staffNoticeMs: 45000 } };
    const stage9Text = JSON.stringify({ version: 1, settings: { ...stage9, ...legacy } }, null, 2);
    const reload = async () => { await app.open(); await waitReady(app); };
    try {
      // 시간·인식 파일 없음에서 시작 → 기본값
      rmSync(TIMING_SETTINGS_FILE, { force: true });
      rmSync(SETTINGS_FILE, { force: true });
      await reload();
      let line = await timingLine();
      expect(/^countdown 3s result 10s cooldown 5s, hold 250ms grace 250ms, recovery retry 3s first 5s stall 3s staff 30s \(defaults \(no file\), \/local-api\/timing-settings\)$/.test(line),
        `defaults: timing ${line}`);

      await withAutoPaused(app, async () => {
        // 시간 섹션: 원본 창·영역 층 없음, 기본값 표시, 인식 섹션에 시간 항목 없음
        await app.openSection('timing');
        const look = await app.evaluate(`(() => ({ raw: ${shown('raw-window')}, layer: ${shown('tuning-layer')}, save: document.getElementById('timing-panel').dataset.save,
          shown: ['countdownSeconds', 'resultMs', 'cooldownMs', 'presentHoldMs', 'absentGraceMs', 'retryIntervalMs', 'firstFrameTimeoutMs', 'stallTimeoutMs', 'staffNoticeMs']
            .map((k) => document.querySelector('#timing-panel output[data-key="' + k + '"]').textContent).join(' '),
          presenceKeys: [...document.querySelectorAll('#tuning-panel [data-key]')].map((e) => e.dataset.key).filter((k, i, a) => a.indexOf(k) === i).join(',') }))()`);
        expect(!look.raw && !look.layer && look.save === 'defaults' && look.shown === '3 10 5.0 0.25 0.25 3.0 5.0 3.0 30'
          && look.presenceKeys === 'minFaceHeight,maxFaceHeight,minScore', `timing section ${JSON.stringify(look)}`);
        details.push(`section: no raw window, ${look.shown}s, presence keys ${look.presenceKeys}`);

        // 조절 → 반응 시간은 바로 감지 루프에, 저장 → 파일
        await app.slide('countdownSeconds', 5, tp);
        await app.slide('resultMs', 4000, tp);
        await app.slide('cooldownMs', 1000, tp);
        await app.slide('absentGraceMs', 300, tp);
        await app.slide('retryIntervalMs', 4000, tp);
        const live = await app.waitFor('timing live', async () => {
          const d = await app.dev();
          return /^countdown 5s result 4s cooldown 1s, hold 250ms grace 300ms, recovery retry 4s .*\+ unsaved changes/.test(d.get('timing') ?? '')
            && /grace 300ms$/.test(d.get('criteria') ?? '') ? d.get('criteria') : null;
        }, 3000);
        await app.press('save', tp);
        await app.waitFor('timing saved', async () => (await message(tp)) === '파일에 저장했습니다.', 5000);
        const file = await getJson(TIMING_SETTINGS_API);
        expect(file.version === 1 && file.settings.countdownSeconds === 5 && file.settings.resultMs === 4000 && file.settings.cooldownMs === 1000
          && file.settings.absentGraceMs === 300 && file.settings.cameraRecovery.retryIntervalMs === 4000, `timing file ${JSON.stringify(file)}`);
        // 섹션 버튼의 점은 패널이 300ms마다 섹션의 data-save를 옮겨 그린다(operator-panel.js TAB_REFRESH_MS). 저장 직후 한 번만 읽으면
        // 이전 값(defaults)을 볼 수 있어 기다린다 (10단계: 원인 확인된 간헐 실패 "timing tab defaults", 로그 2026-11-03-01)
        const tab = await app.waitFor('timing tab dot saved', async () => {
          const value = await app.evaluate(`document.querySelector('#operator-panel [data-section="timing"]').dataset.save`);
          return value === 'saved' ? value : null;
        }, 1500);
        expect(tab === 'saved', `timing tab ${tab}`);
        details.push(`live: criteria "${live.split(', ').at(-1)}" before saving; saved -> timing.local.json`);
        await app.closePanel();
      });

      // 새로고침 뒤 유지 → S 한 회차가 바뀐 값대로
      await reload();
      line = await timingLine();
      expect(/^countdown 5s result 4s cooldown 1s, hold 250ms grace 300ms, recovery retry 4s first 5s stall 3s staff 30s \(file, /.test(line), `after reload: timing ${line}`);
      await withAutoPaused(app, async () => {
        details.push(expectRound(await timedRound(), { countdown: 5, result: 4000, cooldown: 1000 }, 'reload+S'));

        // 회차 도중(카운트다운 중) 바꾸면 이 회차는 시작할 때의 값, 다음 회차부터 새 값. 패널이 열려 있어도 S는 된다
        await app.openSection('timing');
        const first = await timedRound({ during: async () => {
          await app.slide('countdownSeconds', 2, tp);
          await app.slide('resultMs', 3000, tp);
          return app.waitFor('this round note', async () => {
            const value = await timingLine();
            return /^countdown 2s result 3s cooldown 1s \(this round countdown 5s\),/.test(value) ? value.split(',')[0] : null;
          }, 3000);
        } });
        details.push(`${expectRound(first, { countdown: 5, result: 4000, cooldown: 1000 }, 'changed during countdown')} (D "${first.extra}")`);
        details.push(expectRound(await timedRound(), { countdown: 2, result: 3000, cooldown: 1000 }, 'next round'));
        // 저장하지 않고 닫으면 저장된 값으로
        await app.closePanel();
        line = await timingLine();
        expect(/^countdown 5s result 4s cooldown 1s,/.test(line) && !/unsaved/.test(line), `after close without saving: ${line}`);
      });
      details.push('close without saving -> 5s/4s/1s');

      // 옮기기: 9단계 인식 파일(시간 키 포함) + 시간 파일 없음 → 시간 파일로, 인식 파일에서는 그 키만 뺀다
      writeFileSync(SETTINGS_FILE, stage9Text);
      rmSync(TIMING_SETTINGS_FILE, { force: true });
      await reload();
      line = await timingLine();
      expect(/^countdown 3s result 10s cooldown 5s, hold 300ms grace 350ms, recovery retry 3.5s first 6s stall 2.5s staff 45s \(migrated \(presentHoldMs, absentGraceMs, cameraRecovery from presence file \(removed from presence file\)\), /.test(line),
        `migration: timing ${line}`);
      let dev = await app.dev();
      expect(/hold 300ms, grace 350ms$/.test(dev.get('criteria') ?? '') && /^file/.test(dev.get('settings') ?? ''), `migration: criteria ${dev.get('criteria')} / ${dev.get('settings')}`);
      let timingFile = readJson(TIMING_SETTINGS_FILE);
      let presenceFile = readJson(SETTINGS_FILE);
      expect(timingFile.settings.presentHoldMs === 300 && timingFile.settings.cameraRecovery.staffNoticeMs === 45000 && timingFile.settings.countdownSeconds === 3,
        `migration: timing file ${JSON.stringify(timingFile)}`);
      expect(JSON.stringify(Object.keys(presenceFile.settings)) === JSON.stringify(Object.keys(stage9)) && presenceFile.settings.region.x === 0.12,
        `migration: presence file ${JSON.stringify(presenceFile)}`);
      details.push('migration: stage-9 presence file -> timing file (300/350ms, recovery 3.5/6/2.5/45s), presence file keeps only region·face·score');

      // 옮기기 실패: 시간 파일 자리에 폴더를 두어 서버 쓰기를 실패시킨다 → 이번엔 옛 값, 인식 파일은 바이트 그대로, 시간 섹션 "저장 필요"
      writeFileSync(SETTINGS_FILE, stage9Text);
      rmSync(TIMING_SETTINGS_FILE, { force: true });
      mkdirSync(TIMING_SETTINGS_FILE);
      await reload();
      line = await timingLine();
      expect(/hold 300ms grace 350ms, recovery retry 3.5s first 6s stall 2.5s staff 45s \(presence file \(.*migration to timing file failed: HTTP 500/.test(line), `failed migration: timing ${line}`);
      expect(readFileSync(SETTINGS_FILE, 'utf8') === stage9Text, 'failed migration: presence file changed');
      await withAutoPaused(app, async () => {
        await app.openSection('timing');
        const state = await app.evaluate(`({ save: document.getElementById('timing-panel').dataset.save, text: document.querySelector('#timing-panel [data-state]').textContent,
          message: document.querySelector('#timing-panel [data-message]').textContent, tab: document.querySelector('#operator-panel [data-section="timing"]').dataset.save })`);
        expect(state.save === 'adjusted' && state.text === '파일 값을 고쳐 사용 · 저장 필요' && /옮기지 못했습니다/.test(state.message), `failed migration: section ${JSON.stringify(state)}`);
        details.push(`migration failed (HTTP 500): old values used, presence file untouched, section "${state.text}" (tab ${state.tab})`);
        // 그동안 인식 섹션을 저장해도 옛 시간 키는 인식 파일에 남는다 (값이 사라지지 않게)
        await app.openSection('presence');
        await app.slide('minScore', 0.75, '#tuning-panel');
        await app.press('save', '#tuning-panel');
        await app.waitFor('presence saved', async () => (await message('#tuning-panel')) === '파일에 저장했습니다.', 5000);
        presenceFile = readJson(SETTINGS_FILE);
        expect(presenceFile.settings.minScore === 0.75 && presenceFile.settings.presentHoldMs === 300 && presenceFile.settings.cameraRecovery?.staffNoticeMs === 45000,
          `presence save kept old keys? ${JSON.stringify(presenceFile)}`);
        // 쓰기가 다시 되면 시간 섹션 저장 → 시간 파일
        rmdirSync(TIMING_SETTINGS_FILE);
        await app.openSection('timing');
        await app.press('save', tp);
        await app.waitFor('timing saved after failure', async () => (await message(tp)) === '파일에 저장했습니다.', 5000);
        await app.closePanel();
      });
      timingFile = readJson(TIMING_SETTINGS_FILE);
      expect(timingFile.settings.presentHoldMs === 300 && timingFile.settings.absentGraceMs === 350, `timing file after save ${JSON.stringify(timingFile)}`);
      // 다시 시작: 시간 파일 값(옛 키는 무시하고 인식 파일에서 정리), 인식 섹션 저장값은 그대로
      await reload();
      line = await timingLine();
      dev = await app.dev();
      presenceFile = readJson(SETTINGS_FILE);
      expect(/hold 300ms grace 350ms, .*\(file \(old timing keys removed from presence file\), /.test(line), `after recovery: timing ${line}`);
      expect(!('presentHoldMs' in presenceFile.settings) && !('cameraRecovery' in presenceFile.settings) && presenceFile.settings.minScore === 0.75
        && /min score 0\.75, hold 300ms, grace 350ms$/.test(dev.get('criteria') ?? ''), `after recovery: presence ${JSON.stringify(presenceFile)} / ${dev.get('criteria')}`);
      details.push('presence save kept old keys; timing saved later -> next start: timing file wins, old keys removed, min score 0.75 kept');
      return details.join('; ');
    } finally {
      await app.closePanel().catch(() => {});
      const restored = restoreSettings('after timing scenario');
      if (!restored.ok) throw new Error(`could not restore settings files: ${restored.detail}`);
      await app.open();
      await waitReady(app);
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

  await scenario('조절값 API GET·PUT 왕복: 인식·시간(10단계) (저장 파일은 원래대로)', async () => {
    try {
      const probes = [
        [SETTINGS_API, { region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, minFaceHeight: 0.05, maxFaceHeight: 0.6, minScore: 0.71 }],
        [TIMING_SETTINGS_API, { ...config.timing, countdownSeconds: 4 }],
      ];
      const lines = [];
      for (const [url, settings] of probes) {
        const probe = JSON.stringify({ version: 1, settings, browserCheck: new Date().toISOString() }, null, 2);
        const outcome = await app.evaluate(`(async () => {
          const url = '${url}';
          const before = (await fetch(url, { cache: 'no-store' })).status;
          const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Photobooth': '1' }, body: ${JSON.stringify(probe)} });
          const back = await fetch(url, { cache: 'no-store' });
          const noHeader = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          const big = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'X-Photobooth': '1' },
            body: JSON.stringify({ version: 1, pad: 'x'.repeat(17000) }) });
          return { before, put: put.status, back: back.status, same: (await back.text()) === ${JSON.stringify(probe)}, noHeader: noHeader.status, big: big.status };
        })()`);
        // GET before: 앞 시나리오가 원래대로 되돌렸으므로 시작할 때의 파일 유무와 같다
        const existed = (url === SETTINGS_API ? owned.settingsBackup : owned.timingBackup).existed;
        expect(outcome.before === (existed ? 200 : 404), `${url} GET before ${outcome.before}`);
        expect(outcome.put === 204 && outcome.back === 200 && outcome.same, `${url} PUT ${outcome.put}, GET ${outcome.back}, same ${outcome.same}`);
        expect(outcome.noHeader === 403 && outcome.big === 413, `${url} PUT without X-Photobooth ${outcome.noHeader}, 17KB ${outcome.big}`);
        lines.push(`${url}: GET ${outcome.before} → PUT ${outcome.put} → GET ${outcome.back} same; no header → ${outcome.noHeader}; 17KB → ${outcome.big}`);
      }
      return lines.join('; ');
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

  await scenario('운영자 화면 캡처 (--screens, 가짜 카메라): 섹션 넷·원본 창, 1080x1920·1920x1080', async () => {
    if (!options.screens) return 'skipped (no --screens)';
    mkdirSync(options.screens, { recursive: true });
    const files = [];
    try {
      for (const [w, h] of [[1080, 1920], [1920, 1080]]) {
        await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
        await app.open();
        await waitReady(app);
        await app.key('KeyD'); // open()이 켠 D를 끈다 (패널·원본 창만)
        for (const section of ['camera', 'presence', 'timing', 'effect']) {
          await app.openSection(section);
          await sleep(1500);
          const shot = await app.cdp.send('Page.captureScreenshot', { format: 'png' });
          const file = join(options.screens, `panel-${w}x${h}-${section}.png`);
          writeFileSync(file, Buffer.from(shot.data, 'base64'));
          files.push(file);
        }
        await app.closePanel();
      }
    } finally {
      await app.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1080, height: 1920, deviceScaleFactor: 1, mobile: false });
      await app.open();
      await waitReady(app);
    }
    return `${files.length} files in ${options.screens}`;
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
  owned.cameraBackup = backupFile(CAMERA_SETTINGS_FILE);
  log(`camera settings file backup: ${owned.cameraBackup.existed ? `${owned.cameraBackup.bytes.length} bytes` : 'none (will stay absent)'}`);
  if (existsSync(TIMING_SETTINGS_FILE) && statSync(TIMING_SETTINGS_FILE).isDirectory()) throw new Error(`${TIMING_SETTINGS_FILE} is a folder`);
  owned.timingBackup = backupFile(TIMING_SETTINGS_FILE);
  log(`timing settings file backup: ${owned.timingBackup.existed ? `${owned.timingBackup.bytes.length} bytes` : 'none (will stay absent)'}`);
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
