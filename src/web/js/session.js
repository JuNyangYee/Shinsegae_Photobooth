// 촬영 한 사이클 상태 기계: 대기 → 카운트다운 → 촬영·결과 준비 → 결과 표시 → 쿨타임 → 대기.
// DOM·카메라·캔버스를 직접 알지 않는다. 사진 만들기·정리 함수와 시계·타이머를 주입받는다.
// Node 테스트: tests/session.test.mjs

export const SessionState = Object.freeze({
  IDLE: 'idle', // 대기. 시작 요청을 받는다
  COUNTDOWN: 'countdown', // 3·2·1
  CAPTURING: 'capturing', // 프레임을 잡았고 결과 이미지를 만드는 중 (효과·인코딩)
  RESULT: 'result', // 결과 표시
  COOLDOWN: 'cooldown', // 미리보기로 돌아왔지만 시작 요청을 무시하는 시간
});

/**
 * @param {{
 *   timing: { countdownSeconds: number, resultMs: number, cooldownMs: number, captureTimeoutMs: number },
 *   takePhoto: () => Promise<object>,  호출 순간 프레임을 동기로 잡고, 결과 이미지(photo)를 비동기로 돌려준다
 *   releasePhoto: (photo: object) => void,  photo의 자원(Object URL 등)을 정리한다. 여러 번 불려도 안전해야 한다
 *   cameraReady?: boolean, pageVisible?: boolean,
 *   timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number,
 * }} options
 */
export function createSession({
  timing, takePhoto, releasePhoto,
  cameraReady: initialCameraReady = false, pageVisible: initialPageVisible = true,
  timers = globalThis, now = () => performance.now(),
}) {
  const listeners = new Set();

  let state = SessionState.IDLE;
  let round = 0; // 회차 식별자. 시작·강제 초기화마다 올린다. 늦게 끝난 사진 만들기 결과를 거른다
  let timer = null; // 지금 상태의 타이머 하나만 둔다
  let countdownStartedAt = 0;
  let countdown = 0; // 화면에 보일 남은 숫자
  let endsAt = null; // 결과·쿨타임이 끝나는 시각 (now() 기준)
  let photo = null;
  let cameraReady = initialCameraReady;
  let pageVisible = initialPageVisible;

  // 개발용 정보 (D 화면)
  let lastEnd = ''; // 마지막 회차가 끝난 방식
  let lastIgnored = ''; // 마지막으로 무시한 요청과 이유
  let lastError = '';
  let staleResults = 0; // 회차가 바뀐 뒤 도착해 버린 결과 수
  let completed = 0;

  let snapshot = makeSnapshot();

  function makeSnapshot() {
    return Object.freeze({
      state, round, countdown, endsAt, photo, cameraReady, pageVisible,
      lastEnd, lastIgnored, lastError, staleResults, completed,
    });
  }

  function notify() {
    snapshot = makeSnapshot();
    listeners.forEach((listener) => listener(snapshot));
  }

  function setTimer(ms, callback) {
    timers.clearTimeout(timer);
    timer = timers.setTimeout(() => {
      timer = null;
      callback();
    }, Math.max(0, ms));
  }

  function clearTimer() {
    timers.clearTimeout(timer);
    timer = null;
  }

  // 사진을 손에서 놓고 정리한다. 화면이 먼저 사진을 내리도록 notify() 뒤에 부른다.
  function release(old) {
    if (old === null) return;
    try {
      releasePhoto(old);
    } catch (error) {
      console.warn('[session] release failed', error);
    }
  }

  function goIdle(reason) {
    clearTimer();
    const old = photo;
    photo = null;
    state = SessionState.IDLE;
    countdown = 0;
    endsAt = null;
    lastEnd = reason;
    notify();
    release(old);
  }

  function ignore(type, reason) {
    lastIgnored = `${type}: ${reason}`;
    notify();
    return { accepted: false, reason };
  }

  // ---- 카운트다운 ----

  function start(source) {
    if (state !== SessionState.IDLE) return ignore('start', state);
    if (!cameraReady) return ignore('start', 'camera-not-ready');
    if (!pageVisible) return ignore('start', 'page-hidden');
    round += 1;
    lastError = '';
    lastEnd = '';
    if (timing.countdownSeconds <= 0) {
      capture();
      return { accepted: true, reason: source };
    }
    state = SessionState.COUNTDOWN;
    countdownStartedAt = now();
    countdown = timing.countdownSeconds;
    scheduleCountdownStep();
    notify();
    return { accepted: true, reason: source };
  }

  // 숫자는 시작 시각 기준 1초마다 바꾼다 (타이머가 늦어도 누적되지 않게).
  function scheduleCountdownStep() {
    const step = timing.countdownSeconds - countdown + 1;
    setTimer(countdownStartedAt + step * 1000 - now(), () => {
      countdown -= 1;
      if (countdown > 0) {
        scheduleCountdownStep();
        notify();
      } else {
        capture();
      }
    });
  }

  // ---- 촬영·결과 준비 ----

  function capture() {
    const myRound = round;
    state = SessionState.CAPTURING;
    countdown = 0;
    let pending;
    try {
      pending = Promise.resolve(takePhoto()); // 여기서 프레임을 잡는다
    } catch (error) {
      pending = Promise.reject(error);
    }
    setTimer(timing.captureTimeoutMs, () => fail(new Error(`capture timeout ${timing.captureTimeoutMs}ms`)));
    notify();
    pending.then(
      (result) => {
        if (round !== myRound || state !== SessionState.CAPTURING) {
          staleResults += 1;
          release(result);
          notify();
          return;
        }
        showResult(result);
      },
      (error) => {
        if (round !== myRound || state !== SessionState.CAPTURING) return;
        fail(error);
      },
    );
  }

  // 사진을 만들지 못하면 보여 줄 것이 없으므로 쿨타임 없이 대기로 돌아간다.
  function fail(error) {
    lastError = error?.message ?? String(error);
    console.warn('[session] capture failed', error);
    goIdle('capture-failed');
  }

  // ---- 결과 표시 ----

  function showResult(result) {
    photo = result;
    state = SessionState.RESULT;
    startResultClock();
    notify();
  }

  // 결과 종료 시계를 시작하는 유일한 지점.
  // 인쇄를 연동하면 결과 표시에 들어갈 때 대신 "출력 완료 확인" 시점에 이 함수를 부른다 (docs/SYSTEM.md 4절).
  function startResultClock() {
    endsAt = now() + timing.resultMs;
    setTimer(timing.resultMs, finishResult);
  }

  function finishResult() {
    const old = photo;
    photo = null;
    completed += 1;
    state = SessionState.COOLDOWN;
    endsAt = now() + timing.cooldownMs;
    setTimer(timing.cooldownMs, () => {
      state = SessionState.IDLE;
      endsAt = null;
      lastEnd = 'completed';
      notify();
    });
    notify();
    release(old);
  }

  // ---- 취소 ----

  // 취소는 카운트다운만 되돌린다. 촬영·결과 준비 중이면 프레임을 이미 잡았으므로 결과를 보여 준다.
  function cancel(reason) {
    if (state !== SessionState.COUNTDOWN) return ignore('cancel', state);
    goIdle(`cancelled: ${reason}`);
    return { accepted: true, reason };
  }

  // 운영자 강제 초기화: 어느 상태에서든 사진과 타이머를 정리하고 바로 대기로 간다 (쿨타임 없음).
  // 회차를 올려 진행 중인 사진 만들기 결과는 도착해도 버린다.
  function reset(source) {
    round += 1;
    goIdle(`reset: ${source}`);
    return { accepted: true, reason: source };
  }

  return {
    /**
     * 시작·취소·강제 초기화 요청의 유일한 입구. 키보드와 (3-2의) 인식 결과가 모두 이것을 쓴다.
     * @param {'start' | 'cancel' | 'reset'} type
     * @param {string} [source] 요청한 쪽 (예: 'key', 'presence'). 개발용 기록에만 쓴다
     * @returns {{ accepted: boolean, reason: string }}
     */
    request(type, source = 'unknown') {
      if (type === 'start') return start(source);
      if (type === 'cancel') return cancel(source);
      if (type === 'reset') return reset(source);
      throw new Error(`unknown session request: ${type}`);
    },
    /** 카메라 준비 여부. 카운트다운 중 준비가 풀리면 취소한다. 결과·쿨타임은 계속한다. */
    setCameraReady(ready) {
      if (cameraReady === ready) return;
      cameraReady = ready;
      if (!ready && state === SessionState.COUNTDOWN) goIdle('cancelled: camera-not-ready');
      else notify();
    },
    /** 페이지가 보이는지. 숨겨지면 카운트다운을 취소한다. */
    setPageVisible(visible) {
      if (pageVisible === visible) return;
      pageVisible = visible;
      if (!visible && state === SessionState.COUNTDOWN) goIdle('cancelled: page-hidden');
      else notify();
    },
    getState: () => snapshot,
    /** 상태가 바뀔 때마다 호출한다. 등록 즉시 한 번 호출한다. 해제 함수를 돌려준다. */
    subscribe(listener) {
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
  };
}
