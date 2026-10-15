// 카메라 상태 감시와 자동 회복.
// camera.js로 스트림을 열고, 첫 프레임 확인·끊김 감지·재시도를 맡는다.
// 촬영 진행 코드는 isReady()와 subscribe()로 "카메라 준비됨" 여부와 상태 변화만 본다.

import {
  CameraError,
  CameraErrorKind,
  findByLabel,
  listVideoInputs,
  startCamera,
  stopStream,
} from './camera.js';

export const CameraStatus = Object.freeze({
  STARTING: 'starting', // 준비 중 (권한 대기 포함)
  READY: 'ready', // 실제 프레임이 들어오는 정상 상태
  PERMISSION_DENIED: 'permission-denied',
  NOT_FOUND: 'not-found',
  UNAVAILABLE: 'unavailable', // 사용 중이거나 열 수 없음
  UNSUPPORTED: 'unsupported', // 미지원 브라우저·보안 컨텍스트 아님
  NO_FRAMES: 'no-frames', // 스트림은 얻었지만 첫 프레임이 오지 않음 (영상 준비 실패)
  DISCONNECTED: 'disconnected', // 정상 이후 끊김 (트랙 종료·장치 제거·프레임 정지)
});

const statusByErrorKind = {
  [CameraErrorKind.UNSUPPORTED]: CameraStatus.UNSUPPORTED,
  [CameraErrorKind.PERMISSION_DENIED]: CameraStatus.PERMISSION_DENIED,
  [CameraErrorKind.NOT_FOUND]: CameraStatus.NOT_FOUND,
  [CameraErrorKind.IN_USE]: CameraStatus.UNAVAILABLE,
  [CameraErrorKind.UNKNOWN]: CameraStatus.UNAVAILABLE,
};

const DEVICE_CHANGE_DEBOUNCE_MS = 500; // USB 연결·분리 때 이벤트가 몰려 오므로 묶어서 처리
const STALL_CHECK_INTERVAL_MS = 500;

/**
 * @param {{ video: HTMLVideoElement, preferredLabel: string,
 *   idealResolution: {width: number, height: number},
 *   recovery: {retryIntervalMs: number, firstFrameTimeoutMs: number, stallTimeoutMs: number} }} options
 */
export function createCameraMonitor({ video, preferredLabel, idealResolution, recovery }) {
  const listeners = new Set();
  let state = Object.freeze({
    status: CameraStatus.STARTING,
    reason: '', // 운영자용: 오류 종류 또는 끊김 원인
    errorName: '', // 운영자용: 원본 오류 이름 (NotAllowedError 등)
    label: '',
    preferredFound: false,
    attempts: 0, // 연결 시도 누적 횟수
    failures: 0, // 마지막 정상 이후 연속 실패 횟수
    lastAttemptAt: null, // Date.now() 값 (사람이 읽는 시각, D 화면 표시용)
    notReadySince: performance.now(), // 정상이 아니게 된 시각 (performance.now(), 경과 시간 계산용). 정상이면 null
    connecting: false,
    permission: 'unknown', // Permissions API camera 상태
  });

  let started = false;
  let current = null; // 현재 연결 { stream, deviceId, preferredFound }
  let generation = 0; // 연결이 무효화될 때마다 증가. 늦게 끝난 처리·이벤트를 걸러낸다
  let connecting = false;
  let reconnectQueued = false;
  let retryTimer = null;
  let deviceChangeTimer = null;
  let stallTimer = null;
  let lastFrameAt = 0; // 프레임 정지 판정용. 페이지가 숨겨진 동안에는 판정하지 않으려고 현재 시각으로 밀어 둔다
  let presentedAt = null; // 실제로 새 프레임을 받은 마지막 시각 (performance.now()). 촬영 직전 확인용
  let presentedFrames = 0; // 받은 새 프레임 누적 수 (프레임 세대). 감지 루프가 같은 프레임을 다시 세지 않게
  let frameCallbackId = null;
  let cancelFirstFrameWait = null;
  let permissionStatus = null;

  function update(patch) {
    const next = { ...state, ...patch };
    if (next.status === CameraStatus.READY) {
      next.notReadySince = null;
    } else if (state.status === CameraStatus.READY || next.notReadySince === null) {
      next.notReadySince = performance.now();
    }
    state = Object.freeze(next);
    listeners.forEach((listener) => listener(state));
  }

  // 프레임 콜백은 한 번에 하나만 걸어 두고, 정리할 때 반드시 취소한다.
  // 취소하지 않으면 프레임이 오지 않는 동안 등록이 남아 재시도마다 쌓인다.
  function requestFrame(callback) {
    frameCallbackId = video.requestVideoFrameCallback(() => {
      frameCallbackId = null;
      presentedAt = performance.now();
      presentedFrames += 1;
      callback();
    });
  }

  function cancelFrame() {
    if (frameCallbackId === null) return;
    video.cancelVideoFrameCallback(frameCallbackId);
    frameCallbackId = null;
  }

  function teardown() {
    generation += 1;
    cancelFrame();
    cancelFirstFrameWait?.();
    clearInterval(stallTimer);
    stallTimer = null;
    if (current) {
      stopStream(current.stream);
      current = null;
    }
    video.srcObject = null;
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, recovery.retryIntervalMs);
  }

  // 시도는 한 번에 하나만 진행한다. 진행 중에 요청이 오면 끝난 뒤 한 번 더 시도한다.
  async function connect() {
    clearTimeout(retryTimer);
    retryTimer = null;
    if (connecting) {
      reconnectQueued = true;
      return;
    }
    connecting = true;
    teardown();
    const gen = generation;
    const patch = { connecting: true, attempts: state.attempts + 1, lastAttemptAt: Date.now() };
    // 스트림을 정리했으므로 ready였다면 해제하고 구독자에게 알린다.
    if (state.status === CameraStatus.READY) {
      Object.assign(patch, { status: CameraStatus.STARTING, reason: 'reconnect', errorName: '' });
    }
    update(patch);

    try {
      const camera = await startCamera({ preferredLabel, idealResolution });
      if (gen !== generation || reconnectQueued) {
        stopStream(camera.stream);
      } else {
        await attach(camera, gen);
      }
    } catch (error) {
      if (gen === generation && !reconnectQueued) fail(error);
    } finally {
      connecting = false;
      update({ connecting: false });
      if (reconnectQueued) {
        reconnectQueued = false;
        connect();
      }
    }
  }

  async function attach(camera, gen) {
    current = { stream: camera.stream, deviceId: camera.deviceId, preferredFound: camera.preferredFound };
    const track = camera.stream.getVideoTracks()[0];
    track.addEventListener('ended', () => {
      if (gen === generation) lose('track-ended');
    }, { once: true });

    video.srcObject = camera.stream;
    // 재생 실패는 따로 다루지 않고 첫 프레임 제한 시간으로 판정한다.
    video.play().catch(() => {});

    const gotFrame = await waitForFirstFrame();
    // 기다리는 동안 연결이 무효화됐거나 재연결이 예약됐으면 이 스트림으로 ready를 알리지 않는다.
    // 예약된 재연결은 connect()의 finally에서 이어진다.
    if (gen !== generation || reconnectQueued) return;
    if (!gotFrame) {
      teardown();
      update({ status: CameraStatus.NO_FRAMES, reason: 'first-frame-timeout', errorName: '', failures: state.failures + 1 });
      scheduleRetry();
      return;
    }

    update({
      status: CameraStatus.READY,
      reason: '',
      errorName: '',
      label: camera.label,
      preferredFound: camera.preferredFound,
      failures: 0,
    });
    watchFrames(gen);
  }

  function fail(error) {
    const cameraError = error instanceof CameraError ? error : new CameraError(CameraErrorKind.UNKNOWN, error);
    const status = statusByErrorKind[cameraError.kind] ?? CameraStatus.UNAVAILABLE;
    console.warn('[camera]', status, cameraError.cause ?? cameraError);
    update({
      status,
      reason: cameraError.kind,
      errorName: cameraError.cause?.name ?? '',
      failures: state.failures + 1,
    });

    // 미지원 환경은 재시도로 바뀌지 않는다.
    if (status === CameraStatus.UNSUPPORTED) return;
    // 사이트 권한이 차단(denied)이면 재시도해도 풀리지 않으므로 권한 변경 이벤트를 기다린다.
    // 프롬프트를 닫기만 한 경우(prompt)나 Permissions API가 없으면 일정 간격으로 다시 시도한다.
    if (status === CameraStatus.PERMISSION_DENIED && state.permission === 'denied') return;
    scheduleRetry();
  }

  function lose(reason) {
    teardown();
    update({ status: CameraStatus.DISCONNECTED, reason, errorName: '' });
    connect();
  }

  // requestVideoFrameCallback은 새 프레임이 화면에 올라갈 때만 호출된다.
  // MediaStream 재생에서는 currentTime이 프레임과 무관하게 흐르므로 정지 판정에 쓸 수 없다.
  function waitForFirstFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        cancelFrame();
        cancelFirstFrameWait = null;
        resolve(ok);
      };
      const timer = setTimeout(() => finish(false), recovery.firstFrameTimeoutMs);
      cancelFirstFrameWait = () => finish(false);
      const check = () => {
        if (done) return;
        if (video.videoWidth > 0 && video.videoHeight > 0) finish(true);
        else requestFrame(check);
      };
      requestFrame(check);
    });
  }

  function watchFrames(gen) {
    lastFrameAt = performance.now();
    const onFrame = () => {
      if (gen !== generation) return;
      lastFrameAt = performance.now();
      requestFrame(onFrame);
    };
    requestFrame(onFrame);

    stallTimer = setInterval(() => {
      if (gen !== generation) return;
      // 페이지가 숨겨지면 프레임 콜백이 멈추므로 판정하지 않는다.
      if (document.hidden) {
        lastFrameAt = performance.now();
        return;
      }
      if (performance.now() - lastFrameAt > recovery.stallTimeoutMs) lose('frame-stall');
    }, STALL_CHECK_INTERVAL_MS);
  }

  async function onDeviceChange() {
    if (state.status === CameraStatus.UNSUPPORTED) return;
    if (state.status !== CameraStatus.READY || !current) {
      connect();
      return;
    }

    const gen = generation;
    let devices;
    try {
      devices = await listVideoInputs();
    } catch {
      return;
    }
    if (gen !== generation || !current) return;

    if (!devices.some((device) => device.deviceId === current.deviceId)) {
      lose('device-removed');
    } else if (!current.preferredFound && findByLabel(devices, preferredLabel)) {
      // 기본 카메라로 대신 연결된 상태에서 우선 장치(OBS)가 나타나면 전환한다.
      update({ status: CameraStatus.STARTING, reason: 'switch-to-preferred', errorName: '' });
      connect();
    }
  }

  async function watchPermission() {
    try {
      permissionStatus = await navigator.permissions.query({ name: 'camera' });
    } catch {
      return; // 지원하지 않으면 일정 간격 재시도에 맡긴다.
    }
    update({ permission: permissionStatus.state });
    permissionStatus.addEventListener('change', () => {
      update({ permission: permissionStatus.state });
      // 허용되거나 다시 묻는 상태가 되면 곧바로 시도한다. 차단되면 트랙 종료로 처리된다.
      if (permissionStatus.state !== 'denied' && state.status !== CameraStatus.READY) connect();
    });
  }

  async function start() {
    if (started) return;
    started = true;
    if (!('requestVideoFrameCallback' in HTMLVideoElement.prototype)
      || !('cancelVideoFrameCallback' in HTMLVideoElement.prototype)) {
      update({ status: CameraStatus.UNSUPPORTED, reason: 'no-video-frame-callback' });
      return;
    }
    navigator.mediaDevices?.addEventListener?.('devicechange', () => {
      clearTimeout(deviceChangeTimer);
      deviceChangeTimer = setTimeout(onDeviceChange, DEVICE_CHANGE_DEBOUNCE_MS);
    });
    await watchPermission();
    connect();
  }

  return {
    start,
    getState: () => state,
    isReady: () => state.status === CameraStatus.READY,
    /** 마지막 새 프레임 시각(performance.now() 기준, 없으면 null)과 누적 프레임 수. 영상 내용은 내보내지 않는다. */
    getFrameInfo: () => ({ at: presentedAt, count: presentedFrames }),
    /** 상태가 바뀔 때마다 호출한다. 등록 즉시 현재 상태로 한 번 호출한다. 해제 함수를 돌려준다. */
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
  };
}
