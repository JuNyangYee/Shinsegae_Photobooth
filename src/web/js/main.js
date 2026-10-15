import { config } from './config.js';
import { CameraStatus, createCameraMonitor } from './camera-monitor.js';

const stage = document.getElementById('stage');
const video = document.getElementById('preview');
const statusText = document.getElementById('status');
const devInfo = document.getElementById('dev-info');

// 관람객용 문구 (기본 UI 수준, 가안). 상태 상세는 D 키 개발용 정보에만 보인다.
const messages = Object.freeze({
  preparing: '준비 중입니다.\n잠시만 기다려 주세요.',
  staff: '준비 중입니다.\n직원에게 문의해 주세요.',
});

// 기다려도 스스로 풀리기 어려운 상태는 바로 직원 문의 문구를 보인다.
const staffNowStatuses = new Set([CameraStatus.UNSUPPORTED, CameraStatus.PERMISSION_DENIED]);

const camera = createCameraMonitor({
  video,
  preferredLabel: config.preferredCameraLabel,
  idealResolution: config.idealResolution,
  recovery: config.cameraRecovery,
});

let staffNoticeTimer = null;
let devInfoTimer = null;

function showStatus(message) {
  statusText.textContent = message;
  statusText.hidden = !message;
}

function renderStatus() {
  clearTimeout(staffNoticeTimer);
  const state = camera.getState();
  if (state.status === CameraStatus.READY) {
    showStatus('');
    return;
  }
  const waitedMs = Date.now() - state.notReadySince;
  const staffAfterMs = config.cameraRecovery.staffNoticeMs;
  if (staffNowStatuses.has(state.status) || waitedMs >= staffAfterMs) {
    showStatus(messages.staff);
  } else {
    showStatus(messages.preparing);
    staffNoticeTimer = setTimeout(renderStatus, staffAfterMs - waitedMs);
  }
}

function applyLayout() {
  const { width, height } = config.aspectRatio;
  document.documentElement.style.setProperty('--stage-ratio-w', String(width));
  document.documentElement.style.setProperty('--stage-ratio-h', String(height));
  video.classList.toggle('is-mirrored', config.mirror);
}

// ---- 개발용 정보 (D 키 토글, 기본 숨김) ----

function formatTime(timestamp) {
  return timestamp ? new Date(timestamp).toLocaleTimeString('ko-KR', { hour12: false }) : '-';
}

function renderDevInfo() {
  const state = camera.getState();
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const settings = video.srcObject?.getVideoTracks()[0]?.getSettings() ?? {};
  const ready = state.status === CameraStatus.READY;
  const notReadyFor = state.notReadySince ? `${((Date.now() - state.notReadySince) / 1000).toFixed(0)}s` : '-';
  const lines = [
    `status     : ${state.status}${state.connecting ? ' (connecting)' : ''}`,
    `reason     : ${state.reason || '-'}${state.errorName ? ` / ${state.errorName}` : ''}`,
    `attempts   : ${state.attempts} total, ${state.failures} failed since ready, last ${formatTime(state.lastAttemptAt)}`,
    `not ready  : ${notReadyFor}`,
    `permission : ${state.permission}`,
    `camera     : ${ready ? state.label || '(no label)' : '-'}`,
    `preferred  : "${config.preferredCameraLabel}" ${ready ? (state.preferredFound ? 'found' : 'not found -> default camera') : '-'}`,
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
camera.subscribe(() => {
  renderStatus();
  if (!devInfo.hidden) renderDevInfo();
});
camera.start();
