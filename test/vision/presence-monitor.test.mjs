// 실행: npm test
// 실제 presence-monitor.js 감지 루프를 가짜 시계·가짜 감지기·가짜 document로 돌린다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAutoStart } from '../../src/web/core/auto-start.js';
import { createPresenceMonitor } from '../../src/web/vision/presence-monitor.js';
import { sameCriteria } from '../../src/web/core/presence.js';
import { SessionState, createSession } from '../../src/web/core/session.js';
import { fakeClock, flush, timing } from '../helpers.mjs';

const defaults = Object.freeze({
  region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
  minFaceHeight: 0.05, maxFaceHeight: 0.6, minScore: 0.7, presentHoldMs: 500, absentGraceMs: 1000,
});
// 영상 기준 얼굴 하나: 화면 기준 중심 (0.5, 0.36), 높이 0.12, 점수 0.95 → 기본 기준으로 인정
const FACE = Object.freeze({ x: 0.4, y: 0.3, width: 0.2, height: 0.12, score: 0.95 });

async function setupMonitor({ settings = defaults } = {}) {
  const clock = fakeClock(1000);
  const doc = {
    hidden: false,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }),
    addEventListener() {},
  };
  const frames = { count: 0, at: null, flowing: true };
  const camera = {
    isReady: () => true,
    subscribe(listener) { listener({}); return () => {}; },
    getFrameInfo: () => ({ at: frames.at, count: frames.count }),
  };
  let detected = [FACE];
  let detectCalls = 0;
  const detector = {
    delegate: 'FAKE', failures: [],
    detect() { detectCalls += 1; return detected; },
    close() {},
  };
  const monitor = createPresenceMonitor({
    video: { videoWidth: 1080, videoHeight: 1920 },
    camera,
    detection: { maxFps: 15, inputMaxSize: 640, detectorRetryMs: 15000 },
    presence: settings,
    stageAspect: 9 / 16,
    mirror: true,
    createDetector: async () => detector,
    timers: clock.timers,
    now: clock.now,
    doc,
  });
  monitor.start();
  await flush(); // 감지기 생성 → 루프 시작
  // 카메라가 30fps로 새 프레임을 내는 동안(frames.flowing) 시간을 진행한다
  async function run(ms) {
    for (let t = 0; t < ms; t += 33) {
      if (frames.flowing) {
        frames.count += 1;
        frames.at = clock.now();
      }
      clock.advance(33);
      await flush();
    }
  }
  return {
    clock, monitor, frames, run,
    setDetected: (faces) => { detected = faces; },
    detectCalls: () => detectCalls,
  };
}

describe('presence.sameCriteria', () => {
  it('기준 항목이 모두 같을 때만 같다', () => {
    assert.equal(sameCriteria(defaults, { ...defaults, region: { ...defaults.region } }), true);
    for (const change of [{ minScore: 0.8 }, { minFaceHeight: 0.1 }, { maxFaceHeight: 0.5 }, { presentHoldMs: 600 },
      { absentGraceMs: 900 }, { region: { ...defaults.region, x: 0.2 } }]) {
      assert.equal(sameCriteria(defaults, { ...defaults, ...change }), false);
    }
  });
});

describe('createPresenceMonitor: 새 프레임만 관측으로 센다 (검수 C)', () => {
  it('프레임이 흐르면 유지 시간 뒤 인식됨', async () => {
    const t = await setupMonitor();
    await t.run(450);
    assert.equal(t.monitor.isPresent(), false);
    await t.run(200);
    assert.equal(t.monitor.isPresent(), true);
  });

  it('프레임이 멈추면 감지를 건너뛰고, 같은 프레임으로는 인식됨이 되지 않는다', async () => {
    const t = await setupMonitor();
    await t.run(40); // 새 프레임 1~2장
    t.frames.flowing = false; // 카메라 정지 (끊김 판정 전)
    await t.run(100); // 멈추기 직전의 마지막 새 프레임은 한 번 감지한다
    const calls = t.detectCalls();
    await t.run(2000);
    assert.equal(t.detectCalls(), calls); // 감지하지 않음
    assert.equal(t.monitor.isPresent(), false); // 같은 프레임이 0.5초 넘게 "있음"으로 쌓이지 않음
    assert.ok(t.monitor.getDebugSnapshot().skippedSameFrame > 20);
    t.frames.flowing = true;
    await t.run(650);
    assert.equal(t.monitor.isPresent(), true);
  });

  it('인식됨 상태에서 프레임이 멈추면 상태를 그대로 둔다 (끊김 판정은 카메라 감시가 한다)', async () => {
    const t = await setupMonitor();
    await t.run(700);
    assert.equal(t.monitor.isPresent(), true);
    t.frames.flowing = false;
    t.setDetected([]); // 감지했다면 없음이었을 상황
    await t.run(2000);
    assert.equal(t.monitor.isPresent(), true);
  });
});

describe('createPresenceMonitor: 기준이 바뀌면 인식 상태를 다시 잰다 (검수 D)', () => {
  it('기준이 바뀌는 순간 인식 안됨을 알리고, 새 기준으로 유지 시간이 지나야 인식됨', async () => {
    const t = await setupMonitor();
    await t.run(700);
    assert.equal(t.monitor.isPresent(), true);
    const seen = [];
    t.monitor.subscribe(({ present }) => seen.push(present));
    t.monitor.setSettings({ ...defaults, minScore: 0.8 }); // 얼굴(0.95)은 새 기준으로도 인정
    assert.equal(t.monitor.isPresent(), false);
    assert.deepEqual(seen, [true, false]);
    await t.run(450);
    assert.equal(t.monitor.isPresent(), false);
    await t.run(200);
    assert.equal(t.monitor.isPresent(), true);
    assert.equal(t.monitor.getDebugSnapshot().criteriaResets, 1);
  });

  it('새 기준으로 인정되지 않으면 인식됨이 되지 않는다', async () => {
    const t = await setupMonitor();
    await t.run(700);
    t.monitor.setSettings({ ...defaults, region: { x: 0.1, y: 0.7, width: 0.2, height: 0.2 } });
    await t.run(3000);
    assert.equal(t.monitor.isPresent(), false);
  });

  it('값이 같은 설정을 다시 넣으면 다시 재지 않는다', async () => {
    const t = await setupMonitor();
    await t.run(700);
    t.monitor.setSettings({ ...defaults, region: { ...defaults.region } });
    assert.equal(t.monitor.isPresent(), true);
    assert.equal(t.monitor.getDebugSnapshot().criteriaResets, 0);
  });
});

describe('검수 D 재현: 조절 화면을 저장하지 않고 닫음 (감지 루프 + 자동 시작 + 상태 기계)', () => {
  async function setupAll() {
    // 저장된 기준: 얼굴이 영역 밖이다 (인정 안 됨)
    const saved = { ...defaults, region: Object.freeze({ x: 0.1, y: 0.7, width: 0.2, height: 0.2 }) };
    const t = await setupMonitor({ settings: saved });
    const session = createSession({
      timing, takePhoto: async () => ({ id: 'p' }), releasePhoto: () => {}, cameraReady: true,
      timers: t.clock.timers, now: t.clock.now,
    });
    const tuning = { open: true };
    const auto = createAutoStart({ session, presence: t.monitor, isTuningOpen: () => tuning.open, now: t.clock.now });
    auto.start();
    // 조절 화면에서 임시로 영역을 얼굴 위로 옮겨 인식됨까지 안정
    t.monitor.setSettings(defaults);
    await t.run(1000);
    assert.equal(t.monitor.isPresent(), true);
    assert.equal(session.getState().state, SessionState.IDLE); // 열려 있어 막힘
    // presence-tuning.js의 닫기 순서: 저장값 복원(setSettings) → onOpenChange → main.js evaluate('tuning-closed')
    function closeWithoutSaving(restored) {
      tuning.open = false;
      t.monitor.setSettings(restored);
      auto.evaluate('tuning-closed');
    }
    return { ...t, session, auto, saved, closeWithoutSaving };
  }

  it('복원된 기준으로 얼굴이 인정되지 않으면 닫아도 시작하지 않는다', async () => {
    const t = await setupAll();
    t.closeWithoutSaving(t.saved);
    assert.equal(t.session.getState().state, SessionState.IDLE);
    await t.run(3000);
    assert.equal(t.session.getState().state, SessionState.IDLE);
    assert.equal(t.session.getState().round, 0);
  });

  it('복원된 기준으로도 인정되면 바로가 아니라 새로 안정된 뒤(유지 시간) 시작한다', async () => {
    const t = await setupAll();
    t.closeWithoutSaving({ ...defaults, minScore: 0.75 });
    assert.equal(t.session.getState().state, SessionState.IDLE);
    await t.run(450);
    assert.equal(t.session.getState().state, SessionState.IDLE);
    await t.run(200);
    assert.equal(t.session.getState().state, SessionState.COUNTDOWN);
    assert.equal(t.auto.getDebug().lastStart.trigger, 'presence: present');
  });
});

describe('createPresenceMonitor: 감지기 상태 알림 (4-1)', () => {
  const silent = { warn() {}, clear() {} };

  // 카메라 준비 여부를 바꿀 수 있고, createDetector가 받은 hooks(onContextLost)를 꺼낼 수 있는 구성
  async function setupHealth({ create }) {
    const clock = fakeClock(0);
    const cameraListeners = new Set();
    let cameraReady = true;
    let frameCount = 0;
    const camera = {
      isReady: () => cameraReady,
      subscribe(listener) { cameraListeners.add(listener); listener({}); return () => cameraListeners.delete(listener); },
      getFrameInfo: () => ({ at: clock.now(), count: (frameCount += 1) }),
    };
    const hooks = [];
    const monitor = createPresenceMonitor({
      video: { videoWidth: 1080, videoHeight: 1920 },
      camera,
      detection: { maxFps: 15, inputMaxSize: 640, detectorRetryMs: 15000, detectorRetryMaxMs: 300000, detectorFaultAfterFailures: 3 },
      presence: defaults,
      stageAspect: 9 / 16,
      mirror: true,
      createDetector: (h) => { hooks.push(h); return create(); },
      timers: clock.timers,
      now: clock.now,
      doc: { hidden: false, createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }), addEventListener() {} },
      log: silent,
    });
    const seen = [];
    monitor.subscribeDetector((h) => seen.push(`${h.health}${h.cause ? `/${h.cause}` : ''}`));
    monitor.start();
    await flush();
    return {
      clock, monitor, seen, hooks,
      setCamera(ready) { cameraReady = ready; cameraListeners.forEach((listener) => listener({})); },
      async advance(ms) {
        for (let t = 0; t < ms; t += 100) {
          clock.advance(100);
          await flush();
        }
      },
    };
  }

  const okDetector = () => ({ delegate: 'FAKE', failures: [], detect: () => [FACE], close() {} });
  const coded = (code) => Object.assign(new Error(code), { code });

  it('시작 중 → 정상. 알림에는 상태·원인·시각만 있다 (좌표·점수 없음)', async () => {
    const t = await setupHealth({ create: async () => okDetector() });
    assert.deepEqual(t.seen, ['starting', 'ok']);
    assert.deepEqual(Object.keys(t.monitor.getDetectorHealth()).sort(), ['cause', 'health', 'since']);
    assert.equal(t.monitor.getDetectorHealth().since, null);
  });

  it('WebGL 없음은 첫 실패부터 장애이고, 인식은 계속 인식 안됨', async () => {
    const t = await setupHealth({ create: async () => { throw coded('webgl-unavailable'); } });
    assert.deepEqual(t.seen, ['starting', 'fault/webgl-unavailable']);
    assert.equal(t.monitor.isPresent(), false);
    assert.equal(t.monitor.getDebugSnapshot().retryInMs, 15000);
  });

  it('장애 중에는 카메라 재연결이 재시도를 앞당기지 않는다 (재시도 중에는 앞당긴다)', async () => {
    let calls = 0;
    const t = await setupHealth({ create: async () => { calls += 1; throw coded('webgl-unavailable'); } });
    t.setCamera(false);
    t.setCamera(true);
    await flush();
    assert.equal(calls, 1);

    let retryCalls = 0;
    const r = await setupHealth({ create: async () => { retryCalls += 1; throw coded('model-unavailable'); } });
    assert.deepEqual(r.seen, ['starting', 'retrying/model-unavailable']);
    r.setCamera(false);
    r.setCamera(true);
    await flush();
    assert.equal(retryCalls, 2);
  });

  it('실행 중 WebGL 컨텍스트를 잃으면 감지 실패를 기다리지 않고 바로 버리고, 재시도 간격 뒤 다시 만든다', async () => {
    const made = [];
    const t = await setupHealth({ create: async () => { const d = { ...okDetector(), closed: 0, close() { this.closed += 1; } }; made.push(d); return d; } });
    await t.advance(700);
    assert.equal(t.monitor.isPresent(), true);
    t.hooks[0].onContextLost();
    assert.equal(made[0].closed, 1);
    assert.equal(t.monitor.isPresent(), false);
    assert.deepEqual(t.seen, ['starting', 'ok', 'retrying/webgl-context-lost']);
    assert.equal(t.monitor.getDetectorHealth().since, t.clock.now());
    await t.advance(15000);
    assert.equal(made.length, 2);
    assert.deepEqual(t.seen.at(-1), 'ok');
    await t.advance(700);
    assert.equal(t.monitor.isPresent(), true);
  });

  it('감지가 계속 실패해 버린 감지기도 같은 경로(재시도 중, detect-failing)로 알린다', async () => {
    let broken = true;
    const t = await setupHealth({
      create: async () => ({ delegate: 'FAKE', failures: [], detect: () => { if (broken) throw new Error('texture upload failed'); return []; }, close() {} }),
    });
    await t.advance(1200); // 15fps × 15회
    assert.deepEqual(t.seen, ['starting', 'ok', 'retrying/detect-failing']);
    broken = false;
    await t.advance(15000);
    assert.equal(t.seen.at(-1), 'ok');
  });
});

describe('createPresenceMonitor: 소프트웨어 WebGL 경고 (4-1 결정)', () => {
  it('소프트웨어 렌더러 감지기는 정상(ok)으로 두고 경고를 감지기마다 한 번 로그 제한기로 보낸다', async () => {
    const clock = fakeClock(0);
    const warns = [];
    const monitor = createPresenceMonitor({
      video: { videoWidth: 1080, videoHeight: 1920 },
      camera: { isReady: () => true, subscribe(listener) { listener({}); return () => {}; } },
      detection: { maxFps: 15, inputMaxSize: 640, detectorRetryMs: 15000 },
      presence: defaults,
      stageAspect: 9 / 16,
      mirror: true,
      createDetector: async () => ({
        delegate: 'GPU', failures: [], webgl: { version: 2, renderer: 'Microsoft Basic Render Driver', software: true },
        detect: () => [], close() {},
      }),
      timers: clock.timers,
      now: clock.now,
      doc: { hidden: false, createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }) }), addEventListener() {} },
      log: { warn: (category, signature) => warns.push([category, signature]), clear() {} },
    });
    monitor.start();
    await flush();
    clock.advance(500);
    assert.equal(monitor.getDetectorHealth().health, 'ok');
    assert.equal(warns.length, 1);
    assert.equal(warns[0][0], 'webgl');
    assert.match(warns[0][1], /software WebGL renderer: Microsoft Basic Render Driver/);
  });
});
