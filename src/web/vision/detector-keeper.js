// 감지기 생성·재생성 관리와 감지기 상태. 생성에 실패하거나, 만든 감지기가 계속 실패해 버려지면 간격을 늘려 가며 다시 만든다.
// MediaPipe를 직접 알지 않는다 (생성 함수를 받는다). Node 테스트: tests/detector-keeper.test.mjs

import { errorLog } from './log-limit.js';

// 감지기 자체의 상태. 인식 상태(present)와 별개다. 좌표·점수는 담지 않는다.
export const DetectorHealth = Object.freeze({
  STARTING: 'starting', // 아직 실패한 적 없이 만드는 중 (앱 시작 직후)
  OK: 'ok', // 감지기가 있다 (감지 중이거나, 카메라 미준비·페이지 숨김으로 쉬는 중)
  RETRYING: 'retrying', // 실패했고 다시 만들기를 기다리거나 만드는 중
  FAULT: 'fault', // 장애: 스스로 풀리기 어려운 원인이거나 연속 실패가 기준 이상. 재시도는 간격대로 계속한다
});

/**
 * @param {{ create: () => Promise<{ close: () => void }>, retryMs: number, retryMaxMs?: number,
 *   faultAfterFailures?: number, isPermanent?: (cause: string) => boolean,
 *   onChange?: () => void, timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number,
 *   log?: { warn: Function, clear: Function } }} options
 *   retryMs: 첫 재시도 간격. 연속 실패마다 두 배, 최대 retryMaxMs(없으면 retryMs 고정)
 *   isPermanent: 첫 실패부터 장애로 볼 원인(오류의 code)인지
 */
export function createDetectorKeeper({
  create, retryMs, retryMaxMs = retryMs, faultAfterFailures = 3, isPermanent = () => false,
  onChange = () => {}, timers = globalThis, now = () => performance.now(), log = errorLog,
}) {
  let detector = null;
  let creating = null; // 진행 중인 생성 Promise. 생성은 한 번에 하나만
  let retryTimer = null;
  let retryAt = null; // 예약된 재시도 시각 (now() 기준)
  let attempts = 0;
  let failures = 0; // 연속 실패 수 (생성 실패 + 버림). 감지가 한 번 성공하면(markHealthy) 0
  let lastError = '';
  let lastCause = '';
  let unavailableSince = now(); // 감지기가 없게 된 시각 (now() 기준). 있으면 null

  /** 다음 재시도까지의 간격: retryMs × 2^(연속 실패 - 1), 최대 retryMaxMs */
  function retryDelay() {
    return Math.min(retryMs * 2 ** Math.max(0, failures - 1), Math.max(retryMs, retryMaxMs));
  }

  function scheduleRetry() {
    timers.clearTimeout(retryTimer);
    const delay = retryDelay();
    retryAt = now() + delay;
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      retryAt = null;
      ensure();
    }, delay);
  }

  function recordFailure(message, cause) {
    failures += 1;
    lastError = message;
    lastCause = cause;
    if (unavailableSince === null) unavailableSince = now();
    scheduleRetry();
  }

  function health() {
    if (detector !== null) return DetectorHealth.OK;
    if (failures === 0) return DetectorHealth.STARTING;
    if (isPermanent(lastCause) || failures >= faultAfterFailures) return DetectorHealth.FAULT;
    return DetectorHealth.RETRYING;
  }

  /**
   * 감지기가 없으면 바로 만든다 (예약된 재시도가 있어도 앞당긴다). 생성 중이면 그 생성을 기다린다.
   * 예외를 던지지 않는다. 결과는 get()·getStatus()로 본다.
   */
  function ensure() {
    if (detector !== null) return Promise.resolve();
    if (creating !== null) return creating;
    timers.clearTimeout(retryTimer);
    retryTimer = null;
    retryAt = null;
    attempts += 1;
    creating = (async () => {
      try {
        detector = await create();
        lastError = '';
        lastCause = '';
        unavailableSince = null;
        log.clear('detector');
      } catch (error) {
        const cause = error?.code ?? 'create-failed';
        recordFailure(error?.message ?? String(error), cause);
        // 같은 원인이 재시도마다 반복되면 처음 한 번과 주기적인 요약만 남긴다.
        log.warn('detector', `${cause}: ${lastError}`, `(retry in ${Math.round((retryAt - now()) / 1000)}s)`);
      } finally {
        creating = null;
        onChange();
      }
    })();
    onChange();
    return creating;
  }

  /** 계속 실패하거나 WebGL 컨텍스트를 잃은 감지기를 닫고 버린다. 재시도 간격 뒤 새로 만든다. */
  function discard(reason, cause = 'detect-failing') {
    if (detector === null) return;
    const old = detector;
    detector = null;
    try {
      old.close();
    } catch (error) {
      log.warn('detector-close', `close failed: ${error?.message ?? error}`);
    }
    recordFailure(reason, cause);
    log.warn('detector', `${cause}: ${reason}`, `(retry in ${Math.round((retryAt - now()) / 1000)}s)`);
    onChange();
  }

  /** 감지가 성공했다: 재시도 간격을 처음으로 되돌린다. 매 프레임 불러도 된다. */
  function markHealthy() {
    failures = 0;
  }

  return {
    ensure,
    discard,
    markHealthy,
    get: () => detector,
    isCreating: () => creating !== null,
    isRetryScheduled: () => retryTimer !== null,
    getError: () => lastError,
    getAttempts: () => attempts,
    getHealth: health,
    /** 감지기 상태 (D 화면·안내 규칙). 좌표·점수는 없다 */
    getStatus: () => ({
      health: health(),
      cause: lastCause,
      error: lastError,
      failures,
      attempts,
      creating: creating !== null,
      retryAt,
      unavailableSince,
    }),
  };
}
