// 감지 루프와 인식 상태.
// 카메라가 준비되고 페이지가 보일 때만 축소 캔버스로 감지하고, presence.js로 판정한다.
// 촬영 진행 코드는 isPresent()와 subscribe()로 "인식됨 / 인식 안됨"만 본다.
// 좌표·점수는 밖으로 알리지 않는다. getDebugSnapshot()은 D 개발용 화면 전용이다.

import { createFaceDetector } from './face-detector.js';
import {
  classifyFaces,
  computeCoverMapping,
  initialPresenceState,
  presenceProgress,
  stepPresence,
} from './presence.js';

export const DetectorStatus = Object.freeze({
  LOADING: 'loading', // 감지기 생성 중
  RUNNING: 'running', // 감지 중
  PAUSED: 'paused', // 카메라 준비 안 됨 또는 페이지 숨김
  ERROR: 'error', // 감지기 생성 실패, 또는 감지가 계속 실패함 (미리보기는 계속 동작)
});

// 감지가 이 횟수(15fps 기준 약 1초) 연속 실패하면 오류 상태로 두고 느린 간격으로 다시 시도한다.
// 예: WebGL을 쓸 수 없으면 CPU delegate도 생성은 되지만 매 프레임 감지에 실패한다.
const MAX_CONSECUTIVE_FAILURES = 15;
const FAILED_RETRY_MS = 1000;
const FPS_WINDOW_MS = 1000;
const AVERAGE_WEIGHT = 0.1; // 감지 시간 이동 평균 가중치

/**
 * @param {{ video: HTMLVideoElement,
 *   camera: { isReady: () => boolean, subscribe: (listener: Function) => Function },
 *   detection: { bundlePath: string, wasmPath: string, modelPath: string, delegates: string[],
 *     detectorMinConfidence: number, maxFps: number, inputMaxSize: number },
 *   presence: { region: object, minFaceHeight: number, minScore: number, presentHoldMs: number, absentGraceMs: number },
 *   stageAspect: number, mirror: boolean }} options
 */
export function createPresenceMonitor({ video, camera, detection, presence: settings, stageAspect, mirror }) {
  const listeners = new Set();
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });

  let started = false;
  let detector = null;
  let status = DetectorStatus.LOADING;
  let error = '';
  let timer = null;
  let lastTimestamp = 0;
  let presence = initialPresenceState;
  let publicState = Object.freeze({ present: false });

  // 개발용 정보
  let faces = [];
  let detectMs = 0;
  let averageDetectMs = 0;
  let drawMs = 0;
  let detectionErrors = 0;
  let consecutiveFailures = 0;
  let lastDetectionError = '';
  let recentTicks = [];

  function notify() {
    if (publicState.present === presence.present) return;
    publicState = Object.freeze({ present: presence.present });
    listeners.forEach((listener) => listener(publicState));
  }

  function canRun() {
    return detector !== null && camera.isReady() && !document.hidden
      && video.videoWidth > 0 && video.videoHeight > 0;
  }

  // 카메라·페이지 상태가 바뀔 때마다 부른다.
  function sync() {
    if (canRun()) {
      if (timer === null) {
        status = DetectorStatus.RUNNING;
        timer = setTimeout(tick, 0);
      }
    } else {
      pause();
    }
  }

  // 감지를 멈추면 인식 상태는 바로 인식 안됨으로 둔다.
  function pause() {
    clearTimeout(timer);
    timer = null;
    if (detector !== null) status = DetectorStatus.PAUSED;
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
    const tickStart = performance.now();
    try {
      detectOnce();
      consecutiveFailures = 0;
      if (status === DetectorStatus.ERROR) status = DetectorStatus.RUNNING;
    } catch (detectionError) {
      // 실패한 프레임은 "없음"으로 판정한다. 계속 실패하면 유예 시간 뒤 인식 안됨이 된다.
      detectionErrors += 1;
      consecutiveFailures += 1;
      lastDetectionError = detectionError?.message ?? String(detectionError);
      faces = [];
      presence = stepPresence(presence, false, performance.now(), settings);
      notify();
      if (consecutiveFailures === 1 || consecutiveFailures === MAX_CONSECUTIVE_FAILURES) {
        console.warn('[presence] detection failed', consecutiveFailures, detectionError);
      }
      if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) status = DetectorStatus.ERROR;
    }
    const interval = status === DetectorStatus.ERROR ? FAILED_RETRY_MS : 1000 / detection.maxFps;
    timer = setTimeout(tick, Math.max(0, interval - (performance.now() - tickStart)));
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

    const drawStart = performance.now();
    context.drawImage(video, 0, 0, width, height);
    const detectStart = performance.now();
    // detectForVideo 타임스탬프는 항상 증가해야 한다.
    const timestamp = Math.max(detectStart, lastTimestamp + 1);
    lastTimestamp = timestamp;
    const detected = detector.detect(canvas, timestamp);
    const now = performance.now();

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

  async function start() {
    if (started) return;
    started = true;
    try {
      detector = await createFaceDetector({ ...detection, minDetectionConfidence: detection.detectorMinConfidence });
      status = DetectorStatus.PAUSED;
    } catch (createError) {
      status = DetectorStatus.ERROR;
      error = createError?.message ?? String(createError);
      console.warn('[presence] face detector unavailable', createError);
      return;
    }
    camera.subscribe(sync);
    document.addEventListener('visibilitychange', sync);
    sync();
  }

  return {
    start,
    isPresent: () => publicState.present,
    /** 인식 상태가 바뀔 때마다 { present }로 호출한다. 등록 즉시 한 번 호출한다. 해제 함수를 돌려준다. */
    subscribe(listener) {
      listeners.add(listener);
      listener(publicState);
      return () => listeners.delete(listener);
    },
    /** D 개발용 화면 전용. 촬영 진행 코드에서 쓰지 않는다. */
    getDebugSnapshot() {
      const now = performance.now();
      return {
        status,
        error,
        delegate: detector?.delegate ?? '-',
        delegateFailures: detector?.failures ?? [],
        input: `${canvas.width}x${canvas.height}`,
        detectMs,
        averageDetectMs,
        drawMs,
        fps: status === DetectorStatus.RUNNING ? recentTicks.length * (1000 / FPS_WINDOW_MS) : 0,
        maxFps: detection.maxFps,
        detectionErrors,
        consecutiveFailures,
        lastDetectionError,
        faces,
        region: settings.region,
        present: presence.present,
        raw: presence.raw,
        progress: presenceProgress(presence, now, settings),
      };
    },
  };
}
