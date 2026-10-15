// 인식 상태 → 촬영 상태 기계 연결. 인식으로 자동 시작하고, 인식으로 시작한 회차는 대상이 떠나면 취소한다.
// 인식 상태는 "인식됨 / 인식 안됨"만 받는다. 좌표·점수는 여기로 들어오지 않는다.
// Node 테스트: tests/auto-start.test.mjs

import { SessionState } from './session.js';

export const AUTO_SOURCE = 'presence';

/**
 * 지금 상태만 보고(레벨 판정) 보낼 요청을 정한다. 순수 함수.
 * @param {{ state: string, source: string, cameraReady: boolean, pageVisible: boolean, failureBackoff: boolean,
 *   present: boolean, tuningOpen: boolean, paused?: boolean, settingsReady?: boolean }} input
 *   state·source·cameraReady·pageVisible·failureBackoff는 session 스냅숏
 *   paused: 운영자가 P 키로 자동 촬영을 멈춤 (4-3). settingsReady: 조절값 파일 불러오기가 끝남 (4-3)
 * @returns {{ action: 'start' | 'cancel' | null, reason: string }}
 */
export function decideAutoRequest({
  state, source, cameraReady, pageVisible, failureBackoff = false, present, tuningOpen, paused = false, settingsReady = true,
}) {
  if (state === SessionState.IDLE) {
    // 운영자 일시정지와 조절값 불러오기는 사람이 있든 없든 막는다 (D 화면에 이유가 보이게 먼저 본다).
    if (paused) return { action: null, reason: 'blocked: auto paused (P)' };
    if (!settingsReady) return { action: null, reason: 'blocked: settings-loading' };
    if (!present) return { action: null, reason: 'idle, not present' };
    if (!cameraReady) return { action: null, reason: 'blocked: camera-not-ready' };
    if (!pageVisible) return { action: null, reason: 'blocked: page-hidden' };
    if (tuningOpen) return { action: null, reason: 'blocked: tuning-open' };
    // 오류 복구 정책: 촬영이 실패했으면 정해진 시간 동안 자동 시작을 쉰다 (정상 회차의 쿨타임과 별개).
    if (failureBackoff) return { action: null, reason: 'blocked: capture-failed (retry wait)' };
    return { action: 'start', reason: 'idle and present' };
  }
  if (state === SessionState.COUNTDOWN) {
    if (source !== AUTO_SOURCE) return { action: null, reason: `manual round (${source}), presence ignored` };
    // 일시정지하는 순간 인식으로 시작된 카운트다운은 취소한다. S 수동 회차는 그대로 둔다.
    if (paused) return { action: 'cancel', reason: 'auto paused during countdown' };
    if (!present) return { action: 'cancel', reason: 'left during countdown' };
    return { action: null, reason: 'countdown, present' };
  }
  // 촬영·결과·쿨타임 중에는 인식 결과를 보지 않는다.
  return { action: null, reason: `${state}, presence ignored` };
}

/**
 * @param {{ session: { getState: Function, request: Function, subscribe: Function },
 *   presence: { isPresent: () => boolean, subscribe: Function },
 *   isTuningOpen: () => boolean, isPaused?: () => boolean, isSettingsReady?: () => boolean, now?: () => number }} options
 * 카메라 준비·페이지 보임은 session 스냅숏 값을 쓴다 (session이 먼저 받아 두므로 두 쪽이 어긋나지 않는다).
 * 조절 화면을 닫을 때, 일시정지를 켜고 끌 때, 조절값을 다 불러왔을 때는 밖에서 evaluate(계기)를 부른다.
 * now는 D 화면에 보일 기록 시각(사람이 읽는 시각)에만 쓴다. 판정에는 시간을 쓰지 않는다.
 */
export function createAutoStart({
  session, presence, isTuningOpen, isPaused = () => false, isSettingsReady = () => true, now = () => Date.now(),
}) {
  let lastStart = null; // { at, trigger }
  let lastCancel = null;
  let lastReason = '';
  let running = false;
  let again = null; // 평가 중에 들어온 다음 평가 계기
  let previousState = session.getState().state;

  function evaluateOnce(trigger) {
    const s = session.getState();
    const { action, reason } = decideAutoRequest({
      state: s.state,
      source: s.source,
      cameraReady: s.cameraReady,
      pageVisible: s.pageVisible,
      failureBackoff: s.failureBackoff,
      present: presence.isPresent(),
      tuningOpen: isTuningOpen(),
      paused: isPaused(),
      settingsReady: isSettingsReady(),
    });
    lastReason = reason;
    if (action === null) return;
    const result = session.request(action, AUTO_SOURCE);
    if (!result.accepted) return;
    const record = Object.freeze({ at: now(), trigger, reason });
    if (action === 'start') lastStart = record;
    else lastCancel = record;
  }

  /**
   * 조건을 지금 상태로 다시 평가한다. 여러 계기가 겹쳐도 상태 기계가 대기를 벗어나면 다음 평가는 시작하지 않는다.
   * 요청이 상태를 바꿔 다시 불리면(재진입) 지금 평가가 끝난 뒤 한 번 더 평가한다.
   */
  function evaluate(trigger) {
    if (running) {
      again = trigger;
      return;
    }
    running = true;
    try {
      let next = trigger;
      for (let i = 0; i < 3 && next !== null; i += 1) {
        again = null;
        evaluateOnce(next);
        next = again;
      }
    } finally {
      running = false;
      again = null;
    }
  }

  function start() {
    presence.subscribe(({ present }) => evaluate(present ? 'presence: present' : 'presence: absent'));
    // 대기로 들어올 때(쿨타임 종료·취소·초기화), 카메라 준비·페이지 보임이 바뀔 때 session이 알린다.
    session.subscribe((s) => {
      const entered = s.state !== previousState;
      previousState = s.state;
      evaluate(entered ? `entered ${s.state}${s.state === SessionState.IDLE && s.lastEnd ? ` (${s.lastEnd})` : ''}` : 'session update');
    });
  }

  return {
    start,
    evaluate,
    /** D 개발용 화면 */
    getDebug: () => ({ lastStart, lastCancel, lastReason }),
  };
}
