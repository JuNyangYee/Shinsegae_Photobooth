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

const owned = { server: null, chrome: null, profile: null, cdp: null, settingsBackup: null };
let cleaning = null;

// 조절값 파일은 시작할 때 바이트 그대로(또는 "없음") 백업하고, 모든 정리 경로에서 파일 시스템으로 직접 되돌린다
// (4단계 검수 1: 서버 API로 되돌리면 잘못된 JSON·16KB 초과 원본이 거절돼 시험 값이 남았다).
function restoreSettings(reason) {
  if (!owned.settingsBackup) return { ok: true, detail: 'no backup' };
  const result = restoreFile(owned.settingsBackup);
  if (!result.ok || result.detail !== 'unchanged') log(`settings file ${result.ok ? 'OK' : 'FAIL'} (${reason}): ${result.detail}`);
  return result;
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
  return m ? { urls: +m[1], canvases: +m[2], pending: +m[3], taken: +m[4], released: +m[5] } : null;
};
const parseCompleted = (line = '') => Number(/completed (\d+)/.exec(line)?.[1] ?? NaN);
const parseFps = (line = '') => Number(/@ (\d+(?:\.\d+)?)fps/.exec(line)?.[1] ?? NaN);
const sessionState = (line = '') => line.split(' ')[0];

/** S 한 사이클: 카운트다운 → 결과 → 쿨타임 → 대기. 끝나면 D 값을 돌려준다 */
async function manualCycle(app) {
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
  await app.waitFor('cooldown', async () => sessionState((await app.dev()).get('session')) === 'cooldown', 13000);
  await app.waitFor('idle', async () => sessionState((await app.dev()).get('session')) === 'idle', 8000);
  const dev = await app.dev();
  return { completedDelta: parseCompleted(dev.get('session')) - before, resources: parseResources(dev.get('resources')), dev,
    image: `${shown.w}x${shown.h} shown ${shown.boxW}x${shown.boxH}css` };
}

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
    return `delegate ${dev.get('delegate')}, ${dev.get('video')}, detect @ ${parseFps(dev.get('detect'))}fps, settings ${dev.get('settings')}`;
  });

  await scenario('S 수동 한 사이클 (결과 사진 표시 → 쿨타임 → 대기), 사진 자원 0', async () => {
    const { completedDelta, resources, dev, image } = await manualCycle(app);
    expect(completedDelta === 1, `completed +${completedDelta}`);
    expect(resources && resources.urls === 0 && resources.canvases === 0 && resources.pending === 0, `resources ${dev.get('resources')}`);
    return `${dev.get('capture')?.split(',')[0]}; result image ${image}; ${dev.get('resources')}`;
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
      const m = await import('/js/face-detector.js');
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
      const presenceHidden = await app.evaluate("document.getElementById('presence').hidden");
      expect(presenceHidden, 'presence indicator visible during detector fault');
      const dev = await app.dev();
      const { completedDelta, resources } = await manualCycle(app);
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
