// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SessionState, createSession } from '../src/web/js/session.js';

const timing = Object.freeze({ countdownSeconds: 3, resultMs: 10000, cooldownMs: 5000, captureTimeoutMs: 5000 });

// 가짜 시계와 타이머. advance(ms)는 그 사이에 걸린 타이머를 시각 순서대로 실행한다.
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
    pending,
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

// takePhoto: 호출을 기록하고, 테스트가 resolve·reject 시점을 정한다.
function fakeCamera() {
  const shots = [];
  const released = [];
  return {
    shots,
    released,
    takePhoto() {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const shot = { id: shots.length + 1, photo: { id: `photo-${shots.length + 1}` }, promise };
      shot.finish = () => { resolve(shot.photo); return flush(); };
      shot.fail = (error) => { reject(error); return flush(); };
      shots.push(shot);
      return promise;
    },
    releasePhoto(photo) {
      released.push(photo.id);
    },
  };
}

// Promise 콜백이 돌도록 마이크로태스크를 비운다.
const flush = () => new Promise((resolve) => setImmediate(resolve));

function setup(options = {}) {
  const clock = fakeClock();
  const camera = fakeCamera();
  const session = createSession({
    timing,
    takePhoto: camera.takePhoto,
    releasePhoto: camera.releasePhoto,
    cameraReady: true,
    timers: clock.timers,
    now: clock.now,
    ...options,
  });
  const states = [];
  session.subscribe((s) => {
    if (states.at(-1) !== s.state) states.push(s.state);
  });
  return { clock, camera, session, states, state: () => session.getState() };
}

async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

describe('createSession: 정상 한 사이클', () => {
  it('3·2·1 → 3000ms에 촬영 → 결과 10000ms → 쿨타임 5000ms → 대기 (경계 시간)', async () => {
    const { clock, camera, session, states, state } = setup();
    assert.equal(state().state, SessionState.IDLE);

    assert.deepEqual(session.request('start', 'key'), { accepted: true, reason: 'key' });
    assert.equal(state().state, SessionState.COUNTDOWN);
    assert.equal(state().countdown, 3);
    assert.equal(state().round, 1);

    clock.advance(999);
    assert.equal(state().countdown, 3);
    clock.advance(1); // 1000
    assert.equal(state().countdown, 2);
    clock.advance(999);
    assert.equal(state().countdown, 2);
    clock.advance(1); // 2000
    assert.equal(state().countdown, 1);
    clock.advance(999); // 2999
    assert.equal(state().state, SessionState.COUNTDOWN);
    assert.equal(camera.shots.length, 0);
    clock.advance(1); // 3000
    assert.equal(state().state, SessionState.CAPTURING);
    assert.equal(camera.shots.length, 1);

    clock.advance(40); // 인코딩 40ms
    await camera.shots[0].finish();
    assert.equal(state().state, SessionState.RESULT);
    assert.equal(state().photo.id, 'photo-1');
    assert.equal(state().endsAt, 3040 + 10000);

    clock.advance(9999);
    assert.equal(state().state, SessionState.RESULT);
    assert.deepEqual(camera.released, []);
    clock.advance(1); // 13040
    assert.equal(state().state, SessionState.COOLDOWN);
    assert.equal(state().photo, null);
    assert.deepEqual(camera.released, ['photo-1']);
    assert.equal(state().endsAt, 13040 + 5000);

    clock.advance(4999);
    assert.equal(state().state, SessionState.COOLDOWN);
    clock.advance(1); // 18040
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(state().lastEnd, 'completed');
    assert.equal(state().completed, 1);
    assert.equal(clock.pending.size, 0);
    assert.deepEqual(states, ['idle', 'countdown', 'capturing', 'result', 'cooldown', 'idle']);
  });

  it('여러 사이클을 반복하면 회차가 오르고 사진은 회차마다 정리된다', async () => {
    const { clock, camera, session, state } = setup();
    for (let i = 1; i <= 3; i += 1) {
      assert.equal(session.request('start', 'key').accepted, true);
      clock.advance(3000);
      await camera.shots[i - 1].finish();
      assert.equal(state().photo.id, `photo-${i}`);
      clock.advance(15000);
      assert.equal(state().state, SessionState.IDLE);
    }
    assert.equal(state().round, 3);
    assert.deepEqual(camera.released, ['photo-1', 'photo-2', 'photo-3']);
  });

  it('카운트다운 타이머가 늦게 불려도 숫자는 시작 시각 기준으로 바뀐다', () => {
    const { clock, session, state } = setup();
    session.request('start', 'key');
    clock.advance(1300); // 1000ms 타이머가 1300ms에 실행된 것처럼
    assert.equal(state().countdown, 2);
    const next = [...clock.pending.values()][0];
    assert.equal(next.at, 2000); // 다음 숫자는 2300이 아니라 2000
  });
});

describe('createSession: 무시되는 시작', () => {
  it('카운트다운·촬영·결과 중 시작 요청은 무시하고 한 장만 찍는다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    assert.deepEqual(session.request('start', 'key'), { accepted: false, reason: 'countdown' });
    clock.advance(1500);
    session.request('start', 'key');
    assert.equal(state().countdown, 2); // 다시 시작하지 않는다
    clock.advance(1500);
    assert.deepEqual(session.request('start', 'key'), { accepted: false, reason: 'capturing' });
    await camera.shots[0].finish();
    assert.deepEqual(session.request('start', 'key'), { accepted: false, reason: 'result' });
    assert.equal(camera.shots.length, 1);
    assert.equal(state().round, 1);
    assert.equal(state().lastIgnored, 'start: result');
  });

  it('쿨타임 중 시작은 무시하고, 쿨타임이 끝나면 받는다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[0].finish();
    clock.advance(10000);
    assert.equal(state().state, SessionState.COOLDOWN);
    assert.deepEqual(session.request('start', 'presence'), { accepted: false, reason: 'cooldown' });
    clock.advance(4999);
    assert.equal(session.request('start', 'key').accepted, false);
    clock.advance(1);
    assert.equal(session.request('start', 'key').accepted, true);
    assert.equal(state().round, 2);
  });

  it('카메라가 준비되지 않았거나 페이지가 숨겨져 있으면 시작하지 않는다', () => {
    const { session, state } = setup({ cameraReady: false });
    assert.deepEqual(session.request('start', 'key'), { accepted: false, reason: 'camera-not-ready' });
    session.setCameraReady(true);
    session.setPageVisible(false);
    assert.deepEqual(session.request('start', 'key'), { accepted: false, reason: 'page-hidden' });
    session.setPageVisible(true);
    assert.equal(session.request('start', 'key').accepted, true);
    assert.equal(state().round, 1); // 무시한 요청은 회차를 올리지 않는다
  });
});

describe('createSession: 카운트다운 취소', () => {
  for (const [name, act, reason] of [
    ['취소 요청', (s) => s.request('cancel', 'presence'), 'cancelled: presence'],
    ['카메라 준비 해제', (s) => s.setCameraReady(false), 'cancelled: camera-not-ready'],
    ['페이지 숨김', (s) => s.setPageVisible(false), 'cancelled: page-hidden'],
  ]) {
    it(`${name} → 타이머 정리, 쿨타임 없이 대기, 촬영 없음`, () => {
      const { clock, camera, session, state } = setup();
      session.request('start', 'key');
      clock.advance(2500);
      act(session);
      assert.equal(state().state, SessionState.IDLE);
      assert.equal(state().lastEnd, reason);
      assert.equal(clock.pending.size, 0);
      clock.advance(10000);
      assert.equal(camera.shots.length, 0);
      assert.equal(state().state, SessionState.IDLE);
    });
  }

  it('취소 뒤 다시 시작하면 3부터 센다', () => {
    const { clock, session, state } = setup();
    session.request('start', 'key');
    clock.advance(2500);
    session.request('cancel', 'key');
    assert.equal(session.request('start', 'key').accepted, true);
    assert.equal(state().countdown, 3);
    assert.equal(state().round, 2);
  });

  it('취소 요청은 결과·쿨타임 중에는 무시한다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[0].finish();
    assert.deepEqual(session.request('cancel', 'presence'), { accepted: false, reason: 'result' });
    assert.equal(state().state, SessionState.RESULT);
  });
});

describe('createSession: 카메라 해제 후 결과·쿨타임', () => {
  it('결과 표시 중 카메라가 풀려도 결과를 계속 보이고, 쿨타임 뒤 대기에서는 카메라가 준비될 때까지 시작을 막는다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[0].finish();
    clock.advance(2000);
    session.setCameraReady(false);
    assert.equal(state().state, SessionState.RESULT);
    assert.equal(state().photo.id, 'photo-1');
    assert.deepEqual(camera.released, []);
    clock.advance(8000); // 결과 10초 그대로
    assert.equal(state().state, SessionState.COOLDOWN);
    clock.advance(5000);
    assert.equal(state().state, SessionState.IDLE);
    assert.deepEqual(session.request('start', 'key'), { accepted: false, reason: 'camera-not-ready' });
    session.setCameraReady(true);
    assert.equal(session.request('start', 'key').accepted, true);
  });

  it('촬영·결과 준비 중 카메라가 풀려도 이미 잡은 프레임으로 결과를 보인다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    session.setCameraReady(false);
    assert.equal(state().state, SessionState.CAPTURING);
    await camera.shots[0].finish();
    assert.equal(state().state, SessionState.RESULT);
  });
});

describe('createSession: 늦게 끝난 사진 만들기', () => {
  it('강제 초기화 뒤 도착한 결과는 보이지 않고 바로 정리한다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    session.request('reset', 'key');
    assert.equal(state().state, SessionState.IDLE);
    await camera.shots[0].finish();
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(state().photo, null);
    assert.deepEqual(camera.released, ['photo-1']);
    assert.equal(state().staleResults, 1);
  });

  it('초기화 뒤 새 회차가 촬영 중일 때 이전 회차 결과가 도착해도 새 회차에 끼어들지 않는다', async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000); // 1회차 촬영 중
    session.request('reset', 'key');
    session.request('start', 'key');
    clock.advance(3000); // 2회차 촬영 중
    assert.equal(state().state, SessionState.CAPTURING);
    await camera.shots[0].finish(); // 1회차 결과가 늦게 도착
    assert.equal(state().state, SessionState.CAPTURING);
    assert.deepEqual(camera.released, ['photo-1']);
    await camera.shots[1].finish();
    assert.equal(state().state, SessionState.RESULT);
    assert.equal(state().photo.id, 'photo-2');
  });

  it('제한 시간 안에 결과가 없으면 쿨타임 없이 대기로 가고, 그 뒤 도착한 결과는 정리한다', () => quiet(async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    clock.advance(4999);
    assert.equal(state().state, SessionState.CAPTURING);
    clock.advance(1);
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(state().lastEnd, 'capture-failed');
    assert.match(state().lastError, /timeout/);
    await camera.shots[0].finish();
    assert.equal(state().state, SessionState.IDLE);
    assert.deepEqual(camera.released, ['photo-1']);
  }));

  it('사진 만들기가 실패하면 쿨타임 없이 대기로 간다 (동기 예외·비동기 실패)', () => quiet(async () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[0].fail(new Error('encode failed'));
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(state().lastError, 'encode failed');
    assert.equal(clock.pending.size, 0);

    const throwing = setup({ takePhoto: () => { throw new Error('video not ready'); } });
    throwing.session.request('start', 'key');
    throwing.clock.advance(3000);
    await flush();
    assert.equal(throwing.state().state, SessionState.IDLE);
    assert.equal(throwing.state().lastError, 'video not ready');
  }));
});

describe('createSession: 강제 초기화', () => {
  it('어느 상태에서든 사진·타이머를 정리하고 쿨타임 없이 대기로 간다', async () => {
    const { clock, camera, session, state } = setup();
    // 카운트다운 중
    session.request('start', 'key');
    clock.advance(1000);
    session.request('reset', 'key');
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(clock.pending.size, 0);

    // 결과 중
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[0].finish();
    clock.advance(1000);
    session.request('reset', 'key');
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(state().photo, null);
    assert.deepEqual(camera.released, ['photo-1']);
    assert.equal(clock.pending.size, 0);
    assert.equal(session.request('start', 'key').accepted, true); // 쿨타임 없이 바로 시작 가능
    session.request('reset', 'key');

    // 쿨타임 중
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[1].finish();
    clock.advance(10000);
    assert.equal(state().state, SessionState.COOLDOWN);
    session.request('reset', 'key');
    assert.equal(state().state, SessionState.IDLE);
    assert.equal(clock.pending.size, 0);
    assert.equal(session.request('start', 'key').accepted, true);
    assert.deepEqual(camera.released, ['photo-1', 'photo-2']); // 이미 정리된 사진은 다시 정리하지 않는다
  });

  it('대기 중 초기화도 안전하다', () => {
    const { session, state } = setup();
    assert.equal(session.request('reset', 'key').accepted, true);
    assert.equal(state().state, SessionState.IDLE);
  });

  it('알 수 없는 요청은 예외', () => {
    const { session } = setup();
    assert.throws(() => session.request('shoot'), /unknown session request/);
  });
});
