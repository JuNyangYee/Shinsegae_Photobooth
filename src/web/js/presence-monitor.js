// 감지 루프와 인식 상태.
// 카메라가 준비되고 페이지가 보일 때만 축소 캔버스로 감지하고, presence.js로 판정한다.
// 촬영 진행 코드는 isPresent()와 subscribe()로 "인식됨 / 인식 안됨"만 본다.
// 좌표·점수는 밖으로 알리지 않는다. getDebugSnapshot()은 D 개발용 화면 전용이다.

import { DetectorHealth, createDetectorKeeper } from './detector-keeper.js';
import { DetectorFault, createFaceDetector } from './face-detector.js';
import { errorLog } from './log-limit.js';
import {
  classifyFaces,
  sameCriteria,
  computeCoverMapping,
  initialPresenceState,
  presenceProgress,
  stepPresence,
} from './presence.js';

export const DetectorStatus = Object.freeze({
  LOADING: 'loading', // 감지기 생성 중
  RUNNING: 'running', // 감지 중
  PAUSED: 'paused', // 카메라 준비 안 됨 또는 페이지 숨김
  ERROR: 'error', // 감지기 없음: 생성 실패 또는 계속 실패해 버림. 재생성을 기다린다 (미리보기는 계속 동작)
});

// 첫 실패부터 장애로 보는 원인: 기다려도 풀리지 않고 운영자 조치가 필요하다
const permanentCauses = new Set([DetectorFault.WEBGL_UNAVAILABLE, DetectorFault.MODEL_INVALID]);

// 감지가 이 횟수(15fps 기준 약 1초) 연속 실패하면 감지기를 닫고 다시 만든다.
// WebGL 컨텍스트 손실은 이벤트로 바로 알지만, 그 밖의 이유로 계속 실패하는 경우를 위해 둔다.
const MAX_CONSECUTIVE_FAILURES = 15;
const FPS_WINDOW_MS = 1000;
const AVERAGE_WEIGHT = 0.1; // 감지 시간 이동 평균 가중치

/**
 * @param {{ video: HTMLVideoElement,
 *   camera: { isReady: () => boolean, subscribe: (listener: Function) => Function,
 *     getFrameInfo?: () => { at: number | null, count: number } },  getFrameInfo가 있으면 새 프레임이 있을 때만 감지한다
 *   detection: { bundlePath: string, wasmPath: string, modelPath: string, modelBytes?: number, modelSha256?: string,
 *     delegates: string[], detectorMinConfidence: number, maxFps: number, inputMaxSize: number,
 *     detectorRetryMs: number, detectorRetryMaxMs?: number, detectorFaultAfterFailures?: number },
 *   presence: { region: object, minFaceHeight: number, maxFaceHeight: number, minScore: number,
 *     presentHoldMs: number, absentGraceMs: number },
 *   stageAspect: number, mirror: boolean,
 *   createDetector?: (hooks: { onContextLost: () => void }) => Promise<object>,
 *   timers?: { setTimeout: Function, clearTimeout: Function }, now?: () => number, doc?: Document,
 *   log?: { warn: Function, clear: Function } }} options
 *   createDetector·timers·now·doc·log는 바꿔 끼울 때만 (기본: face-detector.js, 전역 타이머, performance.now, document,
 *   log-limit.js errorLog). Node 테스트용
 */
export function createPresenceMonitor({
  video, camera, detection, presence: initialSettings, stageAspect, mirror,
  createDetector = (hooks) => createFaceDetector({
    ...detection, minDetectionConfidence: detection.detectorMinConfidence, ...hooks,
  }),
  timers = globalThis, now: nowMs = () => performance.now(), doc = globalThis.document, log = errorLog,
}) {
  const listeners = new Set();
  const healthListeners = new Set();
  const canvas = doc.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });

  let settings = initialSettings; // 판정 설정. setSettings()로 바꾸면 다음 감지부터 반영된다
  let started = false;
  let timer = null;
  let ticking = false; // tick() 실행 중. 인식 알림을 받은 쪽(촬영 진행·D 화면)이 이 안에서 상태를 읽어도 running으로 보이게
  let cameraWasReady = false;
  let cameraEverReady = false; // 처음 준비되는 것은 재연결이 아니다
  let pageWasVisible = true;
  let lastTimestamp = 0;
  let lastFrameCount = -1; // 마지막으로 감지한 카메라 프레임 번호. 같은 프레임은 다시 관측으로 세지 않는다
  let presence = initialPresenceState;
  let publicState = Object.freeze({ present: false });
  let publicHealth = null; // 감지기 상태 알림 { health, cause, since }. 좌표·점수는 담지 않는다

  // 개발용 정보
  let faces = [];
  let detectMs = 0;
  let averageDetectMs = 0;
  let drawMs = 0;
  let detectionErrors = 0;
  let consecutiveFailures = 0;
  let lastDetectionError = '';
  let recentTicks = [];
  let skippedSameFrame = 0; // 새 프레임이 없어 건너뛴 감지 수
  let criteriaResets = 0; // 판정 기준이 바뀌어 인식 상태를 처음부터 다시 잰 횟수

  // 생성에 실패하거나 감지기를 버리면 간격을 늘려 가며 다시 만든다. 결과가 나오면 루프 상태를 다시 맞추고 감지기 상태를 알린다.
  const keeper = createDetectorKeeper({
    create: () => createDetector({ onContextLost: handleContextLost }),
    retryMs: detection.detectorRetryMs,
    retryMaxMs: detection.detectorRetryMaxMs,
    faultAfterFailures: detection.detectorFaultAfterFailures,
    isPermanent: (cause) => permanentCauses.has(cause),
    onChange: () => {
      sync();
      notifyHealth();
      warnSoftwareWebGL();
    },
    timers,
    now: nowMs,
    log,
  });
  publicHealth = makeHealth();

  // 실행 중 WebGL 컨텍스트를 잃으면 감지가 실패하기를 기다리지 않고 바로 버린다. 재생성은 재시도 간격을 따른다.
  function handleContextLost() {
    keeper.discard('WebGL context lost', DetectorFault.WEBGL_LOST);
  }

  function makeHealth() {
    const { health, cause, unavailableSince } = keeper.getStatus();
    return Object.freeze({ health, cause, since: unavailableSince });
  }

  // 소프트웨어 WebGL(하드웨어 가속 꺼짐 등)은 감지가 되므로 장애로 보지 않는다. D 화면 표시와 콘솔 경고만 둔다(사용자 결정 2026-10-15).
  // 다시 만들 때마다 같은 경고가 나오면 로그 제한이 요약으로 묶는다.
  let warnedDetector = null;
  function warnSoftwareWebGL() {
    const detector = keeper.get();
    if (detector === null || detector === warnedDetector || !detector.webgl?.software) return;
    warnedDetector = detector;
    log.warn('webgl', `software WebGL renderer: ${detector.webgl.renderer} (hardware acceleration may be off; detection still runs)`);
  }

  function notifyHealth() {
    const next = makeHealth();
    if (next.health === publicHealth.health && next.cause === publicHealth.cause) return;
    publicHealth = next;
    healthListeners.forEach((listener) => listener(publicHealth));
  }

  function status() {
    if (keeper.isCreating()) return DetectorStatus.LOADING;
    if (keeper.get() === null) return keeper.getError() ? DetectorStatus.ERROR : DetectorStatus.LOADING;
    return timer !== null || ticking ? DetectorStatus.RUNNING : DetectorStatus.PAUSED;
  }

  function notify() {
    if (publicState.present === presence.present) return;
    publicState = Object.freeze({ present: presence.present });
    listeners.forEach((listener) => listener(publicState));
  }

  function canRun() {
    return started && keeper.get() !== null && camera.isReady() && !doc.hidden
      && video.videoWidth > 0 && video.videoHeight > 0;
  }

  // 카메라·페이지·감지기 상태가 바뀔 때마다 부른다.
  function sync() {
    if (!started) return;
    // 카메라가 다시 준비되거나 페이지가 다시 보이면, 감지기가 없을 때 재시도 간격을 기다리지 않고 바로 만든다.
    const cameraReady = camera.isReady();
    const pageVisible = !doc.hidden;
    const recovered = (cameraReady && !cameraWasReady && cameraEverReady) || (pageVisible && !pageWasVisible);
    cameraWasReady = cameraReady;
    if (cameraReady) cameraEverReady = true;
    pageWasVisible = pageVisible;
    // 장애 상태에서는 간격을 앞당기지 않는다 (카메라가 자주 끊겨도 생성이 몰리지 않게).
    if (recovered && keeper.get() === null && !keeper.isCreating() && keeper.getHealth() !== DetectorHealth.FAULT) {
      keeper.ensure();
    }

    if (canRun()) {
      if (timer === null && !ticking) timer = timers.setTimeout(tick, 0); // tick 중이면 tick이 다음 감지를 예약한다
    } else {
      pause();
    }
  }

  // 감지를 멈추면 인식 상태는 바로 인식 안됨으로 둔다.
  function pause() {
    timers.clearTimeout(timer);
    timer = null;
    presence = initialPresenceState;
    faces = [];
    recentTicks = [];
    notify();
  }

  function tick() {
    timer = null;
    if (!canRun()) {
      pause();
      return;
    }
    ticking = true;
    try {
      tickOnce();
    } finally {
      ticking = false;
    }
  }

  function scheduleNext(tickStart) {
    const interval = 1000 / detection.maxFps;
    timer = timers.setTimeout(tick, Math.max(0, interval - (nowMs() - tickStart)));
  }

  function tickOnce() {
    const tickStart = nowMs();
    // 카메라 프레임이 멈춰 있으면(끊김 판정 전 약 3초) 같은 프레임을 새 관측으로 세지 않는다. 인식 상태는 그대로 둔다.
    const frame = camera.getFrameInfo?.();
    if (frame && frame.count === lastFrameCount) {
      skippedSameFrame += 1;
      scheduleNext(tickStart);
      return;
    }
    if (frame) lastFrameCount = frame.count;
    try {
      detectOnce();
      consecutiveFailures = 0;
      keeper.markHealthy();
      log.clear('detection');
    } catch (detectionError) {
      // 실패한 프레임은 "없음"으로 판정한다. 계속 실패하면 유예 시간 뒤 인식 안됨이 된다.
      detectionErrors += 1;
      consecutiveFailures += 1;
      lastDetectionError = detectionError?.message ?? String(detectionError);
      faces = [];
      presence = stepPresence(presence, false, nowMs(), settings);
      notify();
      log.warn('detection', `detection failed: ${lastDetectionError}`, detectionError);
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
        // 감지기를 닫고 버린다. keeper가 재시도 간격 뒤 새로 만들고, onChange(sync)로 루프가 멈춘다.
        consecutiveFailures = 0;
        keeper.discard(`detection kept failing: ${lastDetectionError}`, DetectorFault.DETECT);
        return;
      }
    }
    scheduleNext(tickStart);
  }

  function detectOnce() {
    const { videoWidth, videoHeight } = video;
    // 4K 영상을 그대로 넣지 않는다. 긴 변을 inputMaxSize 이하로 줄인 캔버스로 감지한다.
    const scale = Math.min(1, detection.inputMaxSize / Math.max(videoWidth, videoHeight));
    const width = Math.max(1, Math.round(videoWidth * scale));
    const height = Math.max(1, Math.round(videoHeight * scale));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    const drawStart = nowMs();
    context.drawImage(video, 0, 0, width, height);
    const detectStart = nowMs();
    // detectForVideo 타임스탬프는 항상 증가해야 한다.
    const timestamp = Math.max(detectStart, lastTimestamp + 1);
    lastTimestamp = timestamp;
    const detected = keeper.get().detect(canvas, timestamp);
    const now = nowMs();

    drawMs = detectStart - drawStart;
    detectMs = now - detectStart;
    averageDetectMs = averageDetectMs === 0 ? detectMs : averageDetectMs + (detectMs - averageDetectMs) * AVERAGE_WEIGHT;
    recentTicks.push(now);
    while (recentTicks.length > 0 && now - recentTicks[0] > FPS_WINDOW_MS) recentTicks.shift();

    const mapping = computeCoverMapping({ videoWidth, videoHeight, stageAspect, mirror });
    faces = classifyFaces(detected, mapping, settings);
    presence = stepPresence(presence, faces.some((face) => face.accepted), now, settings);
    notify();
  }

  function start() {
    if (started) return;
    started = true;
    cameraWasReady = camera.isReady();
    cameraEverReady = cameraWasReady;
    pageWasVisible = !doc.hidden;
    camera.subscribe(sync);
    doc.addEventListener('visibilitychange', sync);
    keeper.ensure();
  }

  return {
    start,
    isPresent: () => publicState.present,
    /**
     * 판정 설정을 바꾼다 (운영자 조절 화면: 조절 중 변경, 취소·닫기 복원, 기본값). 감지기를 다시 만들지 않고 다음 감지부터 반영된다.
     * 기준(영역·크기·신뢰도·시간)이 바뀌면 인식 상태를 처음부터 다시 잰다. 이전 기준으로 안정된 "인식됨"이 남아
     * 새 기준으로 확인되기 전에 자동 시작되지 않게 하기 위해서다. 바뀌는 순간 "인식 안됨"을 알린다.
     */
    setSettings(next) {
      const changed = !sameCriteria(settings, next);
      settings = next;
      if (!changed) return;
      criteriaResets += 1;
      presence = initialPresenceState;
      faces = [];
      notify();
    },
    getSettings: () => settings,
    /** 감지기 상태 { health, cause, since }. health는 DetectorHealth, since는 감지기가 없게 된 시각(now 기준, 있으면 null) */
    getDetectorHealth: () => publicHealth,
    /** 감지기 상태가 바뀔 때(health·cause)마다 호출한다. 등록 즉시 한 번 호출한다. 해제 함수를 돌려준다. */
    subscribeDetector(listener) {
      healthListeners.add(listener);
      listener(publicHealth);
      return () => healthListeners.delete(listener);
    },
    /** 인식 상태가 바뀔 때마다 { present }로 호출한다. 등록 즉시 한 번 호출한다. 해제 함수를 돌려준다. */
    subscribe(listener) {
      listeners.add(listener);
      listener(publicState);
      return () => listeners.delete(listener);
    },
    /** D 개발용 화면 전용. 촬영 진행 코드에서 쓰지 않는다. */
    getDebugSnapshot() {
      const now = nowMs();
      const detector = keeper.get();
      const currentStatus = status();
      const keeperStatus = keeper.getStatus();
      return {
        status: currentStatus,
        health: keeperStatus.health,
        cause: keeperStatus.cause,
        error: keeperStatus.error,
        failuresInRow: keeperStatus.failures,
        createAttempts: keeperStatus.attempts,
        creating: keeperStatus.creating,
        retryInMs: keeperStatus.retryAt === null ? null : Math.max(0, keeperStatus.retryAt - now),
        unavailableMs: keeperStatus.unavailableSince === null ? null : now - keeperStatus.unavailableSince,
        delegate: detector?.delegate ?? '-',
        delegateFailures: detector?.failures ?? [],
        webgl: detector?.webgl ?? null,
        model: detector?.model ?? null,
        input: `${canvas.width}x${canvas.height}`,
        detectMs,
        averageDetectMs,
        drawMs,
        fps: currentStatus === DetectorStatus.RUNNING ? recentTicks.length * (1000 / FPS_WINDOW_MS) : 0,
        maxFps: detection.maxFps,
        detectionErrors,
        consecutiveFailures,
        lastDetectionError,
        skippedSameFrame,
        criteriaResets,
        faces,
        settings,
        present: presence.present,
        raw: presence.raw,
        progress: presenceProgress(presence, now, settings),
      };
    },
  };
}
