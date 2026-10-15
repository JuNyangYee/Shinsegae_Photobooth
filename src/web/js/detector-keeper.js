// 감지기 생성·재생성 관리. 생성에 실패하거나, 만든 감지기가 계속 실패해 버려지면 정해진 간격 뒤 다시 만든다.
// MediaPipe를 직접 알지 않는다 (생성 함수를 받는다). Node 테스트: tests/detector-keeper.test.mjs

/**
 * @param {{ create: () => Promise<{ close: () => void }>, retryMs: number,
 *   onChange?: () => void, timers?: { setTimeout: Function, clearTimeout: Function } }} options
 */
export function createDetectorKeeper({ create, retryMs, onChange = () => {}, timers = globalThis }) {
  let detector = null;
  let creating = null; // 진행 중인 생성 Promise. 생성은 한 번에 하나만
  let retryTimer = null;
  let attempts = 0;
  let lastError = '';

  function scheduleRetry() {
    timers.clearTimeout(retryTimer);
    retryTimer = timers.setTimeout(() => {
      retryTimer = null;
      ensure();
    }, retryMs);
  }

  /**
   * 감지기가 없으면 바로 만든다 (예약된 재시도가 있어도 앞당긴다). 생성 중이면 그 생성을 기다린다.
   * 예외를 던지지 않는다. 결과는 get()·getError()로 본다.
   */
  function ensure() {
    if (detector !== null) return Promise.resolve();
    if (creating !== null) return creating;
    timers.clearTimeout(retryTimer);
    retryTimer = null;
    attempts += 1;
    creating = (async () => {
      try {
        detector = await create();
        lastError = '';
      } catch (error) {
        lastError = error?.message ?? String(error);
        console.warn('[detector] create failed; retry in', retryMs, 'ms', error);
        scheduleRetry();
      } finally {
        creating = null;
        onChange();
      }
    })();
    onChange();
    return creating;
  }

  /** 계속 실패하는 감지기를 닫고 버린다. retryMs 뒤 새로 만든다. */
  function discard(reason) {
    if (detector === null) return;
    try {
      detector.close();
    } catch (error) {
      console.warn('[detector] close failed', error);
    }
    detector = null;
    lastError = reason;
    scheduleRetry();
    onChange();
  }

  return {
    ensure,
    discard,
    get: () => detector,
    isCreating: () => creating !== null,
    isRetryScheduled: () => retryTimer !== null,
    getError: () => lastError,
    getAttempts: () => attempts,
  };
}
