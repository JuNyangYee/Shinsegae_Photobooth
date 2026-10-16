// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAutoStart, decideAutoRequest } from '../../src/web/core/auto-start.js';
import { createCapture } from '../../src/web/camera/capture.js';
import { SessionState, createSession } from '../../src/web/core/session.js';
import { fakeCanvasEnvironment, fakeClock, fakePresence, flush, quiet, timing } from '../helpers.mjs';


function setup({ present = false, cameraReady = true, tuningOpen = false, paused = false, settingsReady = true } = {}) {
  const clock = fakeClock();
  const session = createSession({
    timing,
    takePhoto: async () => ({ id: 'photo' }),
    releasePhoto: () => {},
    cameraReady,
    timers: clock.timers,
    now: clock.now,
  });
  // 시작 요청 수를 센다 (받아들여진 것과 무시된 것)
  const requests = [];
  const request = session.request;
  session.request = (type, source) => {
    const result = request(type, source);
    requests.push({ type, source, accepted: result.accepted, at: clock.now() });
    return result;
  };
  const presence = fakePresence(present);
  const tuning = { open: tuningOpen };
  const ops = { paused, settingsReady }; // 운영자 일시정지(P), 조절값 불러오기 완료
  const auto = createAutoStart({
    session, presence, isTuningOpen: () => tuning.open, isPaused: () => ops.paused, isSettingsReady: () => ops.settingsReady,
    now: clock.now,
  });
  auto.start();
  return {
    clock, session, presence, tuning, ops, auto, requests,
    state: () => session.getState(),
    starts: () => requests.filter((r) => r.type === 'start' && r.accepted),
    // 카운트다운 3초 → 결과 → 결과 10초 → 쿨타임 5초 끝까지
    async runToCooldownEnd() {
      clock.advance(3000);
      await flush();
      assert.equal(session.getState().state, SessionState.RESULT);
      clock.advance(10000);
      assert.equal(session.getState().state, SessionState.COOLDOWN);
      clock.advance(5000);
    },
  };
}

describe('decideAutoRequest (레벨 판정)', () => {
  const base = { state: 'idle', source: '', cameraReady: true, pageVisible: true, present: true, tuningOpen: false };
  it('대기 + 카메라 준비 + 페이지 보임 + 인식됨 + 조절 화면 닫힘이면 시작', () => {
    assert.equal(decideAutoRequest(base).action, 'start');
  });
  it('하나라도 빠지면 시작하지 않는다', () => {
    assert.deepEqual(decideAutoRequest({ ...base, failureBackoff: true }), { action: null, reason: 'blocked: capture-failed (retry wait)' });
    assert.deepEqual(decideAutoRequest({ ...base, present: false }), { action: null, reason: 'idle, not present' });
    assert.deepEqual(decideAutoRequest({ ...base, cameraReady: false }), { action: null, reason: 'blocked: camera-not-ready' });
    assert.deepEqual(decideAutoRequest({ ...base, pageVisible: false }), { action: null, reason: 'blocked: page-hidden' });
    assert.deepEqual(decideAutoRequest({ ...base, tuningOpen: true }), { action: null, reason: 'blocked: tuning-open' });
  });
  it('인식으로 시작한 카운트다운에서 인식 안됨이면 취소, 수동 회차는 그대로', () => {
    assert.equal(decideAutoRequest({ ...base, state: 'countdown', source: 'presence', present: false }).action, 'cancel');
    assert.equal(decideAutoRequest({ ...base, state: 'countdown', source: 'presence', present: true }).action, null);
    assert.equal(decideAutoRequest({ ...base, state: 'countdown', source: 'key', present: false }).action, null);
  });
  it('촬영·결과·쿨타임 중에는 인식 결과를 보지 않는다', () => {
    for (const state of ['capturing', 'result', 'cooldown']) {
      assert.equal(decideAutoRequest({ ...base, state, source: 'presence', present: false }).action, null);
      assert.equal(decideAutoRequest({ ...base, state, source: 'presence', present: true }).action, null);
    }
  });
});

describe('createAutoStart: 자동 시작', () => {
  it('인식되면 시작하고 회차 출처는 presence', () => {
    const t = setup();
    assert.equal(t.state().state, SessionState.IDLE);
    t.presence.set(true);
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().source, 'presence');
    assert.equal(t.auto.getDebug().lastStart.trigger, 'presence: present');
  });

  it('처음부터 서 있으면 연결하자마자 시작', () => {
    const t = setup({ present: true });
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.starts().length, 1);
  });

  it('쿨타임이 끝날 때 계속 서 있으면 인식 상태 변화 없이 바로 다음 회차를 시작', async () => {
    const t = setup();
    t.presence.set(true);
    await t.runToCooldownEnd(); // 18000ms: 쿨타임 끝
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().round, 2);
    assert.equal(t.starts().length, 2);
    assert.equal(t.starts()[1].at, 18000);
    assert.equal(t.auto.getDebug().lastStart.trigger, 'entered idle (completed)');
  });

  it('쿨타임이 끝날 때 비어 있으면 대기 유지, 이후 인식되면 시작', async () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(3000);
    await flush();
    t.presence.set(false); // 결과 중 떠남: 무시
    assert.equal(t.state().state, SessionState.RESULT);
    t.clock.advance(15000);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastReason, 'idle, not present');
    t.clock.advance(60000);
    assert.equal(t.state().state, SessionState.IDLE);
    t.presence.set(true);
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().round, 2);
  });

  it('결과·쿨타임 중 인식이 바뀌어도 시작 요청을 보내지 않는다', async () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(3000);
    await flush();
    const before = t.requests.length;
    t.presence.set(false);
    t.presence.set(true);
    t.clock.advance(10000); // 쿨타임
    t.presence.set(false);
    t.presence.set(true);
    assert.equal(t.requests.length, before);
  });

  it('조절 화면이 열려 있으면 막고, 닫으면 시작', () => {
    const t = setup({ tuningOpen: true });
    t.presence.set(true);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastReason, 'blocked: tuning-open');
    t.tuning.open = false;
    t.auto.evaluate('tuning-closed');
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.auto.getDebug().lastStart.trigger, 'tuning-closed');
  });

  it('조절 화면이 열려 있어도 S 수동 시작은 된다', () => {
    const t = setup({ tuningOpen: true, present: true });
    assert.equal(t.session.request('start', 'key').accepted, true);
    assert.equal(t.state().source, 'key');
  });

  it('쿨타임이 끝날 때 조절 화면이 열려 있으면 대기, 닫으면 시작', async () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(3000);
    await flush();
    t.clock.advance(10000);
    t.tuning.open = true;
    t.clock.advance(5000);
    assert.equal(t.state().state, SessionState.IDLE);
    t.tuning.open = false;
    t.auto.evaluate('tuning-closed');
    assert.equal(t.state().state, SessionState.COUNTDOWN);
  });

  it('카메라가 준비되지 않았으면 막고, 준비되면 시작', () => {
    const t = setup({ cameraReady: false });
    t.presence.set(true);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastReason, 'blocked: camera-not-ready');
    t.session.setCameraReady(true);
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.auto.getDebug().lastStart.trigger, 'session update');
  });

  it('페이지가 숨겨져 있으면 막고, 다시 보이면 시작', () => {
    const t = setup();
    t.session.setPageVisible(false);
    t.presence.set(true);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastReason, 'blocked: page-hidden');
    t.session.setPageVisible(true);
    assert.equal(t.state().state, SessionState.COUNTDOWN);
  });

  it('같은 순간 계기가 겹쳐도 시작은 한 번만 (상태 기계 밖에서도 요청 1회)', () => {
    const t = setup({ cameraReady: false });
    t.presence.set(true);
    // 카메라 준비 → (session 알림) 평가, 이어서 인식 변화·조절 화면 닫기·페이지 보임 계기가 같은 순간에 온다
    t.session.setCameraReady(true);
    t.auto.evaluate('presence: present');
    t.auto.evaluate('tuning-closed');
    t.auto.evaluate('page-visible');
    t.session.setPageVisible(true); // 변화 없음
    assert.equal(t.starts().length, 1);
    assert.equal(t.requests.filter((r) => r.type === 'start').length, 1); // 무시된 시작 요청도 없음
    assert.equal(t.state().round, 1);
  });

  it('평가 중 상태 기계 알림으로 다시 불려도(재진입) 시작은 한 번', () => {
    const t = setup();
    let nested = 0;
    t.session.subscribe(() => {
      nested += 1;
      t.auto.evaluate('nested');
    });
    t.presence.set(true);
    assert.equal(t.starts().length, 1);
    assert.ok(nested > 0);
  });
});

describe('createAutoStart: 이탈 취소', () => {
  it('인식으로 시작한 회차는 카운트다운 중 인식 안됨이면 취소', () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(1500);
    t.presence.set(false);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.state().lastEnd, 'cancelled: presence');
    assert.equal(t.auto.getDebug().lastCancel.trigger, 'presence: absent');
    t.clock.advance(10000);
    assert.equal(t.state().state, SessionState.IDLE); // 촬영하지 않았다
  });

  it('취소 직후 다시 시작하지 않고(반복 없음), 다시 인식되면 새 회차', () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(1500);
    t.presence.set(false);
    assert.equal(t.starts().length, 1);
    t.clock.advance(5000);
    assert.equal(t.starts().length, 1);
    assert.equal(t.requests.filter((r) => r.type === 'start').length, 1);
    t.presence.set(true);
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().countdown, 3);
    assert.equal(t.starts().length, 2);
  });

  it('S로 시작한 수동 회차는 인식 안됨이어도 끝까지 찍는다', async () => {
    const t = setup({ present: false });
    t.session.request('start', 'key');
    t.presence.set(true);
    t.presence.set(false);
    t.clock.advance(3000);
    await flush();
    assert.equal(t.state().state, SessionState.RESULT);
    assert.equal(t.state().source, 'key');
    assert.equal(t.auto.getDebug().lastCancel, null);
  });

  it('촬영 순간에 떠나도 그대로 찍는다', async () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(3000); // capturing
    t.presence.set(false);
    await flush();
    assert.equal(t.state().state, SessionState.RESULT);
  });

  it('수동 회차 쿨타임이 끝날 때 서 있으면 다음 회차는 자동(presence)으로 시작', async () => {
    const t = setup();
    t.session.request('start', 'key');
    t.presence.set(true);
    await t.runToCooldownEnd();
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().source, 'presence');
  });

  it('강제 초기화 뒤 서 있으면 바로 자동 시작 (쿨타임 없음)', () => {
    const t = setup();
    t.presence.set(true);
    t.clock.advance(1000);
    t.session.request('reset', 'key');
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().round, 3); // 시작 1, 초기화 2, 다시 시작 3
    assert.equal(t.auto.getDebug().lastStart.trigger, 'entered idle (reset: key)');
  });
});

// 실제 상태 기계 + 자동 시작 + 캡처를 묶는다. 브라우저 API(캔버스·Object URL)만 흉내.
function setupWithCapture({ context = 'ok', blob = 'ok', present = true } = {}) {
  const clock = fakeClock(1000);
  const env = fakeCanvasEnvironment({ context, blob });
  const capture = createCapture({
    video: { videoWidth: 1080, videoHeight: 1920 }, stageAspect: 9 / 16, mirror: true, type: 'image/jpeg', quality: 0.92,
    maxFrameAgeMs: 500, getFrameInfo: () => ({ at: clock.now() - 10, count: 1 }), // 늘 새 프레임
    createCanvas: env.createCanvas, urls: env.urls, now: clock.now,
  });
  const session = createSession({
    timing, takePhoto: capture.take, releasePhoto: capture.release, cameraReady: true, timers: clock.timers, now: clock.now,
  });
  const presence = fakePresence(present);
  const tuning = { open: false };
  const auto = createAutoStart({ session, presence, isTuningOpen: () => tuning.open, now: clock.now });
  auto.start();
  // 가짜 시계를 100ms씩 진행하며 Promise도 돌린다
  async function run(ms) {
    for (let t = 0; t < ms; t += 100) {
      clock.advance(100);
      await flush();
    }
  }
  return { clock, env, capture, session, presence, tuning, auto, run, state: () => session.getState() };
}

describe('검수 A 재현: 캡처가 계속 실패하고 사람이 계속 서 있음', () => {
  it('60초 동안 시도가 대기 시간으로 제한되고(무제한 재시도 없음), 캔버스가 남지 않는다', () => quiet(async () => {
    const t = setupWithCapture({ context: 'draw-throws' });
    await t.run(60000);
    // 대기 없이 반복하면 3초마다(약 20회). 대기 5·10·20초 → 시도는 3000, 11000, 24000, 47000ms 근처의 4회
    assert.equal(t.env.canvases.length, 4);
    assert.equal(t.env.liveCanvasCount(), 0);
    assert.equal(t.capture.getStats().liveCanvases, 0);
    assert.equal(t.state().failures, 4);
    assert.equal(t.auto.getDebug().lastReason, 'blocked: capture-failed (retry wait)');
  }));

  it('대기 중에도 S 수동 시작은 되고, 성공하면 대기가 풀려 정상 연속 촬영으로 돌아간다', () => quiet(async () => {
    const t = setupWithCapture({ context: 'null' });
    await t.run(3500); // 1회 실패, 대기 5초
    assert.equal(t.state().failureBackoff, true);
    t.env.context = 'ok'; // 원인 해결
    assert.equal(t.session.request('start', 'key').accepted, true);
    await t.run(3500);
    assert.equal(t.state().state, SessionState.RESULT);
    assert.equal(t.state().failures, 0);
    await t.run(15000); // 결과 10초 + 쿨타임 5초 → 서 있으므로 바로 자동 시작
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.state().source, 'presence');
  }));
});

describe('검수 B 재현: toBlob 콜백이 오지 않음', () => {
  it('제한 시간 뒤 캔버스를 바로 비우고, 이후 시도는 캔버스를 새로 만들지 않으며 대기 시간으로 제한된다', () => quiet(async () => {
    const t = setupWithCapture({ blob: 'never' });
    await t.run(3100); // 1회차 촬영 시작, 인코딩 중
    assert.equal(t.env.liveCanvasCount(), 1);
    await t.run(5000); // 제한 시간 5초
    assert.equal(t.state().lastEnd, 'capture-failed');
    assert.match(t.state().lastError, /capture timeout/);
    assert.equal(t.env.liveCanvasCount(), 0);
    await t.run(60000);
    assert.equal(t.env.canvases.length, 1); // 그 뒤 시도는 'capture busy'로 실패, 캔버스 없음
    assert.equal(t.env.liveCanvasCount(), 0);
    assert.match(t.state().lastError, /capture busy/);
    assert.ok(t.state().failures <= 5);
  }));
});

describe('자동 촬영 일시정지(P)와 조절값 불러오기 (4-3)', () => {
  const base = { state: 'idle', source: '', cameraReady: true, pageVisible: true, present: true, tuningOpen: false };

  it('decideAutoRequest: 일시정지·불러오기 중이면 대기에서 시작하지 않는다 (사람이 없어도 이유는 일시정지)', () => {
    assert.deepEqual(decideAutoRequest({ ...base, paused: true }), { action: null, reason: 'blocked: auto paused (P)' });
    assert.deepEqual(decideAutoRequest({ ...base, paused: true, present: false }), { action: null, reason: 'blocked: auto paused (P)' });
    assert.deepEqual(decideAutoRequest({ ...base, settingsReady: false }), { action: null, reason: 'blocked: settings-loading' });
  });

  it('decideAutoRequest: 일시정지하면 인식으로 시작한 카운트다운은 취소, 수동(S) 카운트다운은 그대로', () => {
    assert.deepEqual(decideAutoRequest({ ...base, state: 'countdown', source: 'presence', paused: true }),
      { action: 'cancel', reason: 'auto paused during countdown' });
    assert.equal(decideAutoRequest({ ...base, state: 'countdown', source: 'key', paused: true }).action, null);
    assert.equal(decideAutoRequest({ ...base, state: 'result', source: 'presence', paused: true }).action, null);
  });

  it('통합: 사람이 서 있어도 일시정지 중에는 시작하지 않고, 해제하면 바로 시작한다', async () => {
    const t = setup({ present: true, paused: true });
    t.clock.advance(5000);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastReason, 'blocked: auto paused (P)');
    t.ops.paused = false;
    t.auto.evaluate('resumed (P)');
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    assert.equal(t.auto.getDebug().lastStart.trigger, 'resumed (P)');
  });

  it('통합: 인식 카운트다운 중 일시정지 → 바로 취소, 쿨타임 없이 대기에 머문다. S는 일시정지 중에도 촬영한다', async () => {
    const t = setup({ present: true });
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    t.clock.advance(1000);
    t.ops.paused = true;
    t.auto.evaluate('paused (P)');
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastCancel.reason, 'auto paused during countdown');
    t.clock.advance(20000);
    assert.equal(t.state().state, SessionState.IDLE); // 계속 서 있어도 다시 시작하지 않음
    assert.equal(t.session.request('start', 'key').accepted, true);
    t.clock.advance(3000);
    await flush();
    assert.equal(t.state().state, SessionState.RESULT);
    assert.equal(t.state().source, 'key');
  });

  it('통합: 수동 카운트다운 중 일시정지해도 그 회차는 이어진다', async () => {
    const t = setup({ present: false });
    t.session.request('start', 'key');
    t.ops.paused = true;
    t.auto.evaluate('paused (P)');
    assert.equal(t.state().state, SessionState.COUNTDOWN);
    t.clock.advance(3000);
    await flush();
    assert.equal(t.state().state, SessionState.RESULT);
  });

  it('통합: 조절값 불러오기가 끝날 때까지 시작하지 않고, 끝나면 그때 상태로 판단한다', async () => {
    const t = setup({ present: true, settingsReady: false });
    t.clock.advance(3000);
    assert.equal(t.state().state, SessionState.IDLE);
    assert.equal(t.auto.getDebug().lastReason, 'blocked: settings-loading');
    t.ops.settingsReady = true;
    t.auto.evaluate('settings-loaded');
    assert.equal(t.state().state, SessionState.COUNTDOWN);
  });
});
