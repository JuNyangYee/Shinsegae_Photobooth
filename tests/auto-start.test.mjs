// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createAutoStart, decideAutoRequest } from '../src/web/js/auto-start.js';
import { SessionState, createSession } from '../src/web/js/session.js';

const timing = Object.freeze({ countdownSeconds: 3, resultMs: 10000, cooldownMs: 5000, captureTimeoutMs: 5000 });

function fakeClock() {
  let time = 0;
  let nextId = 1;
  const pending = new Map();
  return {
    now: () => time,
    timers: {
      setTimeout(callback, ms) {
        const id = nextId++;
        pending.set(id, { callback, at: time + ms });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    advance(ms) {
      const target = time + ms;
      for (;;) {
        let dueId = null;
        for (const [id, entry] of pending) {
          if (entry.at <= target && (dueId === null || entry.at < pending.get(dueId).at)) dueId = id;
        }
        if (dueId === null) break;
        const { callback, at } = pending.get(dueId);
        pending.delete(dueId);
        time = at;
        callback();
      }
      time = target;
    },
  };
}

// 인식 상태 흉내: 바뀔 때만 알리고, 등록 즉시 한 번 알린다 (presence-monitor.js와 같은 규칙).
function fakePresence(initial = false) {
  let present = initial;
  const listeners = new Set();
  return {
    isPresent: () => present,
    subscribe(listener) {
      listeners.add(listener);
      listener({ present });
      return () => listeners.delete(listener);
    },
    set(next) {
      if (next === present) return;
      present = next;
      listeners.forEach((listener) => listener({ present }));
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup({ present = false, cameraReady = true, tuningOpen = false } = {}) {
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
  const auto = createAutoStart({ session, presence, isTuningOpen: () => tuning.open, now: clock.now });
  auto.start();
  return {
    clock, session, presence, tuning, auto, requests,
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
