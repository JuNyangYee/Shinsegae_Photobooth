import { config } from './config.js';
import { CameraErrorKind, startCamera } from './camera.js';

const stage = document.getElementById('stage');
const video = document.getElementById('preview');
const statusText = document.getElementById('status');
const devInfo = document.getElementById('dev-info');

// 간단한 문구만 둔다. 상세 안내는 다음 작업(1-2)에서 정한다.
const errorMessages = {
  [CameraErrorKind.UNSUPPORTED]: '이 브라우저에서는 카메라를 사용할 수 없습니다.',
  [CameraErrorKind.PERMISSION_DENIED]: '카메라 권한이 필요합니다.',
  [CameraErrorKind.NOT_FOUND]: '카메라를 찾을 수 없습니다.',
  [CameraErrorKind.IN_USE]: '카메라를 열 수 없습니다. 다른 프로그램이 사용 중인지 확인해 주세요.',
  [CameraErrorKind.UNKNOWN]: '카메라를 시작하지 못했습니다.',
};

let camera = null;
let devInfoTimer = null;

function showStatus(message) {
  statusText.textContent = message;
  statusText.hidden = !message;
}

function applyLayout() {
  const { width, height } = config.aspectRatio;
  document.documentElement.style.setProperty('--stage-ratio-w', String(width));
  document.documentElement.style.setProperty('--stage-ratio-h', String(height));
  video.classList.toggle('is-mirrored', config.mirror);
}

async function start() {
  showStatus('카메라를 준비하고 있습니다.');
  try {
    camera = await startCamera({
      preferredLabel: config.preferredCameraLabel,
      idealResolution: config.idealResolution,
    });
    video.srcObject = camera.stream;
    await video.play();
    showStatus('');
  } catch (error) {
    console.error(error);
    showStatus(errorMessages[error.kind] ?? errorMessages[CameraErrorKind.UNKNOWN]);
  }
}

// ---- 개발용 정보 (D 키 토글, 기본 숨김) ----

function renderDevInfo() {
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const settings = camera?.stream.getVideoTracks()[0]?.getSettings() ?? {};
  const lines = [
    `camera     : ${camera ? camera.label || '(no label)' : '-'}`,
    `preferred  : "${config.preferredCameraLabel}" ${camera ? (camera.preferredFound ? 'found' : 'not found -> default camera') : '-'}`,
    `video      : ${video.videoWidth}x${video.videoHeight}`,
    `track      : ${settings.width ?? '-'}x${settings.height ?? '-'} @ ${settings.frameRate ? settings.frameRate.toFixed(1) : '-'}fps`
      + ` (ideal ${config.idealResolution.width}x${config.idealResolution.height})`,
    `stage 9:16 : ${Math.round(rect.width)}x${Math.round(rect.height)} css px`
      + ` (${Math.round(rect.width * dpr)}x${Math.round(rect.height * dpr)} device px, dpr ${dpr})`,
    `viewport   : ${window.innerWidth}x${window.innerHeight}`,
    `mirror     : ${config.mirror}`,
  ];
  devInfo.textContent = lines.join('\n');
}

function toggleDevInfo() {
  devInfo.hidden = !devInfo.hidden;
  clearInterval(devInfoTimer);
  devInfoTimer = null;
  if (!devInfo.hidden) {
    renderDevInfo();
    devInfoTimer = setInterval(renderDevInfo, 500);
  }
}

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.code === 'KeyD') toggleDevInfo();
});

applyLayout();
start();
