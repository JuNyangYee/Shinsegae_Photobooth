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

async function listVideoInputs() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === 'videoinput');
}

function findByLabel(devices, label) {
  const wanted = label.trim().toLowerCase();
  if (!wanted) return null;
  return devices.find((device) => device.label.toLowerCase().includes(wanted)) ?? null;
}

function openStream(deviceId) {
  // 해상도는 지정하지 않는다. 장치(OBS) 출력을 그대로 받는다.
  const video = deviceId ? { deviceId: { exact: deviceId } } : true;
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export function stopStream(stream) {
  stream?.getTracks().forEach((track) => track.stop());
}

/**
 * 우선 라벨과 일치하는 카메라를 열고, 없으면 기본 카메라를 연다.
 * 실패하면 CameraError(kind)를 던진다.
 * @returns {Promise<{stream: MediaStream, label: string, deviceId: string,
 *   preferredFound: boolean, settings: MediaTrackSettings}>}
 */
export async function startCamera({ preferredLabel = '' } = {}) {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    throw new CameraError(CameraErrorKind.UNSUPPORTED);
  }

  let stream = null;
  try {
    let devices = await listVideoInputs();

    // 장치 라벨은 권한이 허용된 뒤에만 보인다. 비어 있으면 한 번 열어 권한을 받고 다시 읽는다.
    if (devices.length === 0 || devices.every((device) => !device.label)) {
      stream = await openStream(null);
      devices = await listVideoInputs();
    }

    const preferred = findByLabel(devices, preferredLabel);
    const currentId = stream?.getVideoTracks()[0]?.getSettings().deviceId;

    // 권한 확인용으로 연 스트림이 원하는 장치면 그대로 쓴다.
    if (!stream || (preferred && preferred.deviceId !== currentId)) {
      stopStream(stream);
      stream = await openStream(preferred?.deviceId ?? null);
    }

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    return {
      stream,
      label: track.label,
      deviceId: settings.deviceId ?? '',
      preferredFound: Boolean(preferred),
      settings,
    };
  } catch (error) {
    stopStream(stream);
    throw toCameraError(error);
  }
}
