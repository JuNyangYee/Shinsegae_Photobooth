// Node 테스트 공용 흉내 (테스트 파일이 아니므로 npm test가 직접 실행하지 않는다)

/** 촬영 시간 설정 (config.session과 같은 값) */
export const timing = Object.freeze({
  countdownSeconds: 3, resultMs: 10000, cooldownMs: 5000, captureTimeoutMs: 5000,
  failureRetryMs: 5000, failureRetryMaxMs: 60000,
});

/**
 * 가짜 시계와 타이머.
 * - advance(ms): 그 사이에 걸린 타이머를 예약 시각 순서대로, 예약 시각에 실행한다 (타이머가 제때 불리는 경우).
 * - skip(ms): 시각만 옮기고 아무것도 실행하지 않는다. 이어서 runDue()를 부르면 밀린 콜백이 늦은 시각(지금)에서 실행된다
 *   (메인 스레드가 막혀 타이머가 늦게 불리는 경우).
 */
export function fakeClock(start = 0) {
  let time = start;
  let nextId = 1;
  const pending = new Map();
  function nextDue(limit) {
    let dueId = null;
    for (const [id, entry] of pending) {
      if (entry.at <= limit && (dueId === null || entry.at < pending.get(dueId).at
        || (entry.at === pending.get(dueId).at && id < dueId))) dueId = id;
    }
    return dueId;
  }
  return {
    now: () => time,
    timers: {
      setTimeout(callback, ms = 0) {
        const id = nextId++;
        pending.set(id, { callback, at: time + Math.max(0, ms) });
        return id;
      },
      clearTimeout(id) {
        pending.delete(id);
      },
    },
    pending,
    advance(ms) {
      const target = time + ms;
      for (let id = nextDue(target); id !== null; id = nextDue(target)) {
        const { callback, at } = pending.get(id);
        pending.delete(id);
        time = at;
        callback();
      }
      time = target;
    },
    skip(ms) {
      time += ms;
    },
    runDue() {
      for (let id = nextDue(time); id !== null; id = nextDue(time)) {
        const { callback } = pending.get(id);
        pending.delete(id);
        callback();
      }
    },
  };
}

/** Promise 콜백이 돌도록 마이크로태스크와 즉시 실행 큐를 비운다. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** 인식 상태 흉내: 바뀔 때만 알리고, 등록 즉시 한 번 알린다 (presence-monitor.js와 같은 규칙). */
export function fakePresence(initial = false) {
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

/**
 * 캔버스·Object URL 흉내
 *   context: 'ok' | 'null'(getContext가 null) | 'draw-throws'(drawImage 예외)
 *   blob: 'ok' | 'null'(toBlob이 null) | 'never'(콜백이 오지 않음) | 'manual'(테스트가 콜백 시점을 정함)
 */
export function fakeCanvasEnvironment({ context = 'ok', blob = 'ok' } = {}) {
  const canvases = [];
  const revoked = [];
  const blobCallbacks = [];
  let nextUrl = 1;
  const env = {
    context,
    blob,
    canvases,
    revoked,
    blobCallbacks,
    createCanvas() {
      const calls = [];
      const canvas = {
        width: 300,
        height: 150,
        calls,
        getContext: () => (env.context === 'null' ? null : {
          translate: (...args) => calls.push(['translate', ...args]),
          scale: (...args) => calls.push(['scale', ...args]),
          drawImage: (...args) => {
            if (env.context === 'draw-throws') throw new Error('drawImage failed');
            calls.push(['drawImage', ...args.slice(1)]);
          },
        }),
        toBlob(callback, type, quality) {
          calls.push(['toBlob', type, quality]);
          const respond = () => callback(env.blob === 'null' ? null : { size: 1234, type });
          if (env.blob === 'ok' || env.blob === 'null') queueMicrotask(respond);
          else if (env.blob === 'manual') blobCallbacks.push(respond);
          // 'never': 콜백이 오지 않는다
        },
      };
      canvases.push(canvas);
      return canvas;
    },
    urls: {
      createObjectURL: () => `blob:fake/${nextUrl++}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
    /** 픽셀 버퍼가 남은 캔버스 수 */
    liveCanvasCount: () => canvases.filter((c) => c.width * c.height > 0).length,
  };
  return env;
}

/** console.warn 출력은 테스트 결과를 어지럽히므로 잠시 막는다 */
export async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}
