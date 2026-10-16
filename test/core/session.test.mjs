// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { SessionState, createSession } from '../src/web/js/session.js';
import { fakeClock, flush, quiet, timing } from './helpers.mjs';

// takePhoto: 호출을 기록하고, 테스트가 resolve·reject 시점을 정한다.
function fakeCamera() {
  const shots = [];
  const released = [];
  return {
    shots,
    released,
    takePhoto({ signal } = {}) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
      const shot = { id: shots.length + 1, photo: { id: `photo-${shots.length + 1}` }, promise, signal };
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

  it('카운트다운 타이머가 늦게 불려도 숫자는 시작 시각 기준으로 바뀐다 (늦음이 쌓이지 않음)', () => {
    const { clock, camera, session, state } = setup();
    session.request('start', 'key');
    clock.skip(1300); // 메인 스레드가 막혀 1000ms 타이머가 1300ms에야 불린다
    clock.runDue();
    assert.equal(clock.now(), 1300);
    assert.equal(state().countdown, 2);
    assert.equal([...clock.pending.values()][0].at, 2000); // 상대 1000ms로 예약하면 2300
    clock.skip(900); // 2200ms에 불린다
    clock.runDue();
    assert.equal(state().countdown, 1);
    assert.equal([...clock.pending.values()][0].at, 3000); // 늦음이 쌓였다면 3200 이후
    clock.advance(799);
    assert.equal(camera.shots.length, 0);
    clock.advance(1); // 3000ms
    assert.equal(camera.shots.length, 1);
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
    assert.equal(state().failures, 1);
    assert.equal(state().failureBackoff, true);
    assert.equal(clock.pending.size, 1); // 자동 시작 대기 타이머만 남는다

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

  it('회차 출처를 기록하고, 무시된 시작은 출처를 바꾸지 않는다', () => {
    const { session, state } = setup();
    assert.equal(state().source, '');
    session.request('start', 'presence');
    assert.equal(state().source, 'presence');
    session.request('start', 'key'); // 무시
    assert.equal(state().source, 'presence');
    session.request('reset', 'key');
    session.request('start', 'key');
    assert.equal(state().source, 'key');
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

describe('createSession: 회차별 취소 경계 (검수 B)', () => {
  it('제한 시간이 지나면 진행 중인 사진 만들기에 abort를 보낸다', () => quiet(async () => {
    const { clock, camera, session } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    const { signal } = camera.shots[0];
    assert.equal(signal.aborted, false);
    clock.advance(5000);
    assert.equal(signal.aborted, true);
    assert.match(signal.reason.message, /capture aborted: capture-failed/);
  }));

  it('촬영·결과 준비 중 강제 초기화하면 abort를 보낸다', () => {
    const { clock, camera, session } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    session.request('reset', 'key');
    assert.equal(camera.shots[0].signal.aborted, true);
    assert.match(camera.shots[0].signal.reason.message, /reset: key/);
  });

  it('정상으로 끝난 회차의 신호는 abort하지 않는다 (결과 뒤 초기화해도)', async () => {
    const { clock, camera, session } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    await camera.shots[0].finish();
    session.request('reset', 'key');
    assert.equal(camera.shots[0].signal.aborted, false);
  });

  it('회차마다 새 신호를 쓴다', async () => {
    const { clock, camera, session } = setup();
    session.request('start', 'key');
    clock.advance(3000);
    session.request('reset', 'key');
    session.request('start', 'key');
    clock.advance(3000);
    assert.notEqual(camera.shots[0].signal, camera.shots[1].signal);
    assert.equal(camera.shots[1].signal.aborted, false);
  });
});

describe('createSession: 실패 뒤 자동 시작 대기 기록 (검수 A)', () => {
  async function failOnce(t) {
    t.session.request('start', 'key');
    t.clock.advance(3000);
    await t.camera.shots.at(-1).fail(new Error('boom'));
  }

  it('연속 실패마다 대기 시간이 두 배로 늘고 상한에서 멈춘다 (5·10·20·40·60·60초)', () => quiet(async () => {
    const t = setup();
    const waits = [];
    for (let i = 0; i < 6; i += 1) {
      await failOnce(t);
      waits.push(t.state().retryAt - t.clock.now());
      assert.equal(t.state().failures, i + 1);
    }
    assert.deepEqual(waits, [5000, 10000, 20000, 40000, 60000, 60000]);
  }));

  it('대기 시간이 끝나면 알리고(failureBackoff false), 실패 수는 남는다', () => quiet(async () => {
    const t = setup();
    await failOnce(t);
    let notified = 0;
    t.session.subscribe(() => { notified += 1; });
    notified = 0;
    t.clock.advance(4999);
    assert.equal(t.state().failureBackoff, true);
    t.clock.advance(1);
    assert.equal(t.state().failureBackoff, false);
    assert.equal(t.state().retryAt, null);
    assert.equal(t.state().failures, 1);
    assert.equal(notified, 1);
  }));

  it('대기 중에도 상태 기계의 시작(수동)은 막지 않고, 성공하면 기록을 지운다', () => quiet(async () => {
    const t = setup();
    await failOnce(t);
    await failOnce(t);
    assert.equal(t.state().failureBackoff, true);
    assert.equal(t.session.request('start', 'key').accepted, true);
    t.clock.advance(3000);
    await t.camera.shots.at(-1).finish();
    assert.equal(t.state().failures, 0);
    assert.equal(t.state().failureBackoff, false);
    t.clock.advance(15000);
    assert.equal(t.clock.pending.size, 0);
    await failOnce(t);
    assert.equal(t.state().retryAt - t.clock.now(), 5000); // 처음부터 다시
  }));
});
