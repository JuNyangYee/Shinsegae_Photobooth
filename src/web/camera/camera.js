// 카메라 장치 선택, 스트림 시작·종료, 실제 트랙 설정 반환만 맡는다.
// 화면 표시와 안내 문구는 호출하는 쪽이 정한다.

export const CameraErrorKind = Object.freeze({
  UNSUPPORTED: 'unsupported', // 브라우저가 getUserMedia를 지원하지 않거나 보안 컨텍스트가 아님
  PERMISSION_DENIED: 'permission-denied',
  NOT_FOUND: 'not-found', // 카메라 없음, 또는 고른 장치가 사라짐
  IN_USE: 'in-use', // 다른 프로그램이 사용 중이거나 장치를 열 수 없음
  UNKNOWN: 'unknown',
});

export class CameraError extends Error {
  constructor(kind, cause) {
    super(`camera error: ${kind}${cause?.name ? ` (${cause.name})` : ''}`, { cause });
    this.name = 'CameraError';
    this.kind = kind;
  }
}

function toCameraError(error) {
  if (error instanceof CameraError) return error;
  switch (error?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new CameraError(CameraErrorKind.PERMISSION_DENIED, error);
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new CameraError(CameraErrorKind.NOT_FOUND, error);
    case 'NotReadableError':
      return new CameraError(CameraErrorKind.IN_USE, error);
    default:
      return new CameraError(CameraErrorKind.UNKNOWN, error);
  }
}

export async function listVideoInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput');
}

export function findByLabel(devices, label) {
  const wanted = (label ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return devices.find((device) => device.label.toLowerCase().includes(wanted)) ?? null;
}

/** 라벨이 정확히 같은 장치 (앞뒤 공백·대소문자 무시). 같은 라벨이 둘이면 앞의 것 */
export function findExactLabel(devices, label) {
  const wanted = (label ?? '').trim().toLowerCase();
  if (!wanted) return null;
  return devices.find((device) => device.label.trim().toLowerCase() === wanted) ?? null;
}

/** 장치를 고른 방법. 앞의 것이 우선 (대신 연결된 뒤 더 우선인 장치가 나타나면 바꾼다) */
export const CameraSelection = Object.freeze({ DEVICE: 'device', PREFERRED: 'preferred', DEFAULT: 'default' });
const selectionRank = { device: 2, preferred: 1, default: 0 };
export const selectionPriority = (selection) => selectionRank[selection] ?? 0;

/**
 * 쓸 장치를 고른다: 카메라 설정의 장치 라벨(정확히 같음) → 우선 라벨(포함, OBS) → 기본 카메라(null).
 * deviceId는 다시 연결·재부팅 때 바뀔 수 있어 라벨로 고른다.
 * @returns {{ device: MediaDeviceInfo | null, selection: string }}
 */
export function pickCamera(devices, { deviceLabel = '', preferredLabel = '' } = {}) {
  const exact = findExactLabel(devices, deviceLabel);
  if (exact) return { device: exact, selection: CameraSelection.DEVICE };
  const preferred = findByLabel(devices, preferredLabel);
  if (preferred) return { device: preferred, selection: CameraSelection.PREFERRED };
  return { device: null, selection: CameraSelection.DEFAULT };
}

/** 트랙이 지원하는 가로·세로·fps 범위 (getCapabilities가 없으면 null). 운영자 화면에 보이는 정보 */
export function trackCapabilities(track) {
  let caps;
  try {
    caps = track?.getCapabilities?.();
  } catch {
    return null;
  }
  if (!caps) return null;
  const range = (r) => (r && Number.isFinite(r.max) ? { min: r.min ?? 0, max: r.max } : null);
  return { width: range(caps.width), height: range(caps.height), frameRate: range(caps.frameRate) };
}

function openStream(deviceId, idealResolution) {
  // 해상도는 ideal로만 요청한다. exact·min은 장치가 지원하지 않으면 실패하므로 쓰지 않는다.
  const video = {};
  if (deviceId) video.deviceId = { exact: deviceId };
  if (idealResolution) {
    video.width = { ideal: idealResolution.width };
    video.height = { ideal: idealResolution.height };
  }
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * 고른 카메라(pickCamera: 장치 라벨 → 우선 라벨 → 기본)를 연다. 실패하면 CameraError(kind)를 던진다.
 * @returns {Promise<{stream: MediaStream, label: string, deviceId: string, selection: string,
 *   preferredFound: boolean, settings: MediaTrackSettings, capabilities: object | null}>}
 */
export async function startCamera({ deviceLabel = '', preferredLabel = '', idealResolution = null } = {}) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(CameraErrorKind.UNSUPPORTED);
  }

  let stream = null;
  try {
    let devices = await listVideoInputs();

    // 장치 라벨은 권한이 허용된 뒤에만 보인다. 비어 있으면 한 번 열어 권한을 받고 다시 읽는다.
    // 아래에서 이 스트림을 그대로 쓸 수 있으므로 같은 해상도 권장값으로 연다.
    if (devices.length === 0 || devices.every((device) => !device.label)) {
      stream = await openStream(null, idealResolution);
      devices = await listVideoInputs();
    }

    const { device, selection } = pickCamera(devices, { deviceLabel, preferredLabel });
    const currentId = stream?.getVideoTracks()[0]?.getSettings().deviceId;

    // 권한 확인용으로 연 스트림이 원하는 장치면 그대로 쓴다.
    if (!stream || (device && device.deviceId !== currentId)) {
      stopStream(stream);
      stream = await openStream(device?.deviceId ?? null, idealResolution);
    }

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    return {
      stream,
      label: track.label,
      deviceId: settings.deviceId ?? '',
      selection,
      preferredFound: selection !== CameraSelection.DEFAULT,
      settings,
      capabilities: trackCapabilities(track),
    };
  } catch (error) {
    stopStream(stream);
    throw toCameraError(error);
  }
}
