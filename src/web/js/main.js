import { config } from './config.js';
import { createAutoStart } from './auto-start.js';
import { CameraStatus, createCameraMonitor } from './camera-monitor.js';
import { createCapture } from './capture.js';
import { createPresenceMonitor } from './presence-monitor.js';
import { createPresenceTuning } from './presence-tuning.js';
import { SessionState, createSession } from './session.js';

const stage = document.getElementById('stage');
const video = document.getElementById('preview');
const statusText = document.getElementById('status');
const presenceText = document.getElementById('presence');
const devInfo = document.getElementById('dev-info');
const devOverlay = document.getElementById('dev-overlay');
const resultImage = document.getElementById('result');
const countdownText = document.getElementById('countdown');
const flash = document.getElementById('flash');
const noticeText = document.getElementById('notice');

// 운영자 단축키 (관람객용 아님): D 개발용 정보, R 인식 범위 조절, S 수동 촬영 시작, X 강제 초기화
const Keys = Object.freeze({ devInfo: 'KeyD', tuning: 'KeyR', start: 'KeyS', reset: 'KeyX' });

// 관람객용 문구 (사용자 확정 2026-10-15). 상태 상세는 D 키 개발용 정보에만 보인다.
const messages = Object.freeze({
  preparing: '준비 중입니다.\n잠시만 기다려 주세요.',
  staff: '준비 중입니다.\n직원에게 문의해 주세요.',
  present: '인식됨', // 인식 상태 임시 표시 (가안)
  absent: '인식 안됨',
  cooldown: '다음 촬영을 준비 중입니다.', // 쿨타임 문구 (가안)
});

// 기다려도 스스로 풀리기 어려운 상태는 바로 직원 문의 문구를 보인다.
const staffNowStatuses = new Set([CameraStatus.UNSUPPORTED, CameraStatus.PERMISSION_DENIED]);

const camera = createCameraMonitor({
  video,
  preferredLabel: config.preferredCameraLabel,
  idealResolution: config.idealResolution,
  recovery: config.cameraRecovery,
});

const stageAspect = config.aspectRatio.width / config.aspectRatio.height;

const presence = createPresenceMonitor({
  video,
  camera,
  detection: config.faceDetection,
  presence: config.presence,
  stageAspect,
  mirror: config.mirror,
});

const capture = createCapture({
  video, stageAspect, mirror: config.mirror, ...config.capture, getFrameInfo: camera.getFrameInfo,
});

// 촬영 한 사이클. 시작·취소·초기화는 session.request() 한 곳으로 들어간다 (키보드와 auto-start.js).
const session = createSession({
  timing: config.session,
  takePhoto: capture.take,
  releasePhoto: capture.release,
  cameraReady: camera.isReady(),
  pageVisible: !document.hidden,
});

// 저장된 조절값을 읽어 감지 루프에 넣는다. 저장값이 없거나 잘못되면 config.presence 기본값을 쓴다.
const tuning = createPresenceTuning({
  stage,
  panel: document.getElementById('tuning-panel'),
  layer: document.getElementById('tuning-layer'),
  monitor: presence,
  defaults: config.presence,
  storage: getStorage(),
  onOpenChange: handleTuningOpenChange,
});

// 인식 상태로 자동 시작하고, 인식으로 시작한 카운트다운은 대상이 떠나면 취소한다. 조절 화면이 열려 있으면 자동 시작을 막는다.
const autoStart = createAutoStart({ session, presence, isTuningOpen: () => tuning.isOpen() });

let staffNoticeTimer = null;
let devInfoTimer = null;
let devOverlayFrame = null;
let shownPhotoUrl = null;
let lastSessionState = SessionState.IDLE;

// 저장소 접근 자체가 막힌 환경에서도 앱은 기본값으로 동작한다.
function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// 결과 사진을 보이는 동안에는 카메라 상태 문구와 인식 표시를 사진 위에 띄우지 않는다.
function isShowingPhoto() {
  return session.getState().state === SessionState.RESULT;
}

function showStatus(message) {
  statusText.textContent = message;
  statusText.hidden = !message || isShowingPhoto();
}

function renderStatus() {
  clearTimeout(staffNoticeTimer);
  const state = camera.getState();
  if (state.status === CameraStatus.READY) {
    showStatus('');
    return;
  }
  const waitedMs = performance.now() - state.notReadySince;
  const staffAfterMs = config.cameraRecovery.staffNoticeMs;
  if (staffNowStatuses.has(state.status) || waitedMs >= staffAfterMs) {
    showStatus(messages.staff);
  } else {
    showStatus(messages.preparing);
    staffNoticeTimer = setTimeout(renderStatus, staffAfterMs - waitedMs);
  }
}

// 카메라가 준비되지 않았으면 "준비 중" 문구만 보이고 인식 표시는 숨긴다.
function renderPresence() {
  const visible = config.showPresenceIndicator && camera.isReady() && !isShowingPhoto();
  presenceText.hidden = !visible;
  if (!visible) return;
  const present = presence.isPresent();
  presenceText.textContent = present ? messages.present : messages.absent;
  presenceText.classList.toggle('is-present', present);
}

// ---- 촬영 한 사이클 화면 ----

// 조절 화면을 닫으면 그 시점의 인식 상태로 자동 시작을 다시 판단한다.
function handleTuningOpenChange(open) {
  updateOverlay();
  if (!open) autoStart.evaluate('tuning-closed');
}

function renderSession(s) {
  countdownText.hidden = s.state !== SessionState.COUNTDOWN;
  if (s.state === SessionState.COUNTDOWN) countdownText.textContent = String(s.countdown);

  if (s.state === SessionState.CAPTURING && lastSessionState !== SessionState.CAPTURING) {
    flash.animate([{ opacity: 0.9 }, { opacity: 0 }], { duration: 400, easing: 'ease-out' });
  }
  lastSessionState = s.state;

  // 결과 사진. 결과가 끝나면 src를 먼저 지우고, 그 뒤 session이 Object URL을 정리한다.
  const url = s.state === SessionState.RESULT ? s.photo.url : null;
  if (url !== shownPhotoUrl) {
    if (url) resultImage.src = url;
    else resultImage.removeAttribute('src');
    shownPhotoUrl = url;
  }
  resultImage.hidden = url === null;

  const cooling = s.state === SessionState.COOLDOWN && camera.isReady();
  noticeText.hidden = !cooling;
  if (cooling) noticeText.textContent = messages.cooldown;

  renderStatus();
  renderPresence();
  if (!devInfo.hidden) renderDevInfo();
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
  const notReadyFor = state.notReadySince !== null ? `${((performance.now() - state.notReadySince) / 1000).toFixed(0)}s` : '-';
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
    '',
    ...presenceDevLines(),
    '',
    ...sessionDevLines(),
  ];
  devInfo.textContent = lines.join('\n');
}

function presenceDevLines() {
  const d = presence.getDebugSnapshot();
  const { region, minFaceHeight, maxFaceHeight, minScore, presentHoldMs, absentGraceMs } = d.settings;
  const accepted = d.faces.filter((face) => face.accepted).length;
  const progress = d.progress
    ? `-> ${d.progress.target ? 'present' : 'absent'} ${Math.round(d.progress.elapsedMs)}/${d.progress.requiredMs}ms`
    : 'stable';
  const lines = [
    `detector   : ${d.status}${d.error ? ` / ${d.error}` : ''}`,
    `delegate   : ${d.delegate}${d.delegateFailures.length ? ` (failed: ${d.delegateFailures.join('; ')})` : ''}`,
    `detect     : ${d.detectMs.toFixed(1)}ms (avg ${d.averageDetectMs.toFixed(1)}ms, draw ${d.drawMs.toFixed(1)}ms)`
      + ` @ ${d.fps}fps (max ${d.maxFps}), input ${d.input}`,
    `faces      : ${d.faces.length} detected, ${accepted} accepted`
      + ` (same-frame skips ${d.skippedSameFrame}, criteria resets ${d.criteriaResets})`,
    `presence   : ${d.present ? 'PRESENT' : 'absent'} (raw ${d.raw ? 'present' : 'absent'}, ${progress})`,
    `criteria   : region x${region.x} y${region.y} w${region.width} h${region.height},`
      + ` face ${minFaceHeight}~${maxFaceHeight}, min score ${minScore}, hold ${presentHoldMs}ms, grace ${absentGraceMs}ms`,
    `settings   : ${tuning.describeSettingsSource()}`,
  ];
  if (d.detectionErrors > 0) {
    lines.push(`errors     : ${d.detectionErrors} total, ${d.consecutiveFailures} in a row (last: ${d.lastDetectionError})`);
  }
  d.faces.forEach((face, index) => {
    const rejected = [!face.inRegion && 'region', !face.bigEnough && 'small', !face.smallEnough && 'large',
      !face.confident && 'score'].filter(Boolean);
    lines.push(`  face ${index + 1}   : score ${face.score.toFixed(2)}, height ${face.box.height.toFixed(3)},`
      + ` center ${face.center.x.toFixed(2)},${face.center.y.toFixed(2)} -> ${face.accepted ? 'ok' : rejected.join('+')}`);
  });
  return lines;
}

function describeAuto(record) {
  return record ? `${formatTime(record.at)} (${record.trigger})` : '-';
}

function sessionDevLines() {
  const s = session.getState();
  const left = s.endsAt === null ? '' : ` ${Math.max(0, (s.endsAt - performance.now()) / 1000).toFixed(1)}s left`;
  const detail = s.state === SessionState.COUNTDOWN ? ` ${s.countdown}` : left;
  const c = capture.getStats();
  const last = c.last;
  const a = autoStart.getDebug();
  return [
    `session    : ${s.state}${detail} (round ${s.round}${s.source ? ` by ${s.source}` : ''}, completed ${s.completed})`,
    `auto       : ${a.lastReason || '-'} | last start ${describeAuto(a.lastStart)} | last cancel ${describeAuto(a.lastCancel)}`,
    `last end   : ${s.lastEnd || '-'}${s.lastError ? ` / ${s.lastError}` : ''}`,
    `failures   : ${s.failures} in a row${s.retryAt === null ? '' : `, auto start waits ${Math.max(0, (s.retryAt - performance.now()) / 1000).toFixed(1)}s`}`,
    `ignored    : ${s.lastIgnored || '-'}`,
    last
      ? `capture    : ${last.width}x${last.height} from video ${last.source}`
        + ` (crop x${last.crop.x} y${last.crop.y}), ${last.type} ${Math.round(last.bytes / 1024)}KB,`
        + ` grab ${last.grabMs.toFixed(1)}ms, encode ${last.encodeMs.toFixed(1)}ms`
      : 'capture    : -',
    `resources  : object URLs ${c.liveUrls}, canvases ${c.liveCanvases}, pending jobs ${c.pending}`
      + ` (taken ${c.taken}, released ${c.released}, stale results ${s.staleResults})`,
  ];
}

// 감지 박스와 인식 영역을 9:16 영역 위에 겹쳐 그린다. 인정된 얼굴은 초록, 제외된 얼굴은 빨강.
// 판정 좌표가 이미 관람객 화면 기준(반전 후)이므로 그대로 그린다.
// 조절 화면이 열려 있으면 영역은 편집 사각형이 대신 보이고, 얼굴 크기 기준 가이드를 영역 가운데에 그린다.
function drawDevOverlay() {
  devOverlayFrame = requestAnimationFrame(drawDevOverlay);
  const rect = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio;
  const width = Math.round(rect.width * dpr);
  const height = Math.round(rect.height * dpr);
  if (devOverlay.width !== width || devOverlay.height !== height) {
    devOverlay.width = width;
    devOverlay.height = height;
  }
  const ctx = devOverlay.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  const d = presence.getDebugSnapshot();
  const line = Math.max(2, Math.round(2 * dpr));
  ctx.lineWidth = line;
  ctx.font = `${Math.round(14 * dpr)}px Consolas, monospace`;

  const { region } = d.settings;
  ctx.setLineDash([line * 4, line * 3]);
  if (tuning.isOpen()) {
    // 얼굴 박스는 거의 정사각형이므로 한 변 = 기준 높이 x 9:16 영역 높이(px)인 정사각형으로 보인다.
    const cx = (region.x + region.width / 2) * width;
    const cy = (region.y + region.height / 2) * height;
    for (const [size, color] of [[d.settings.maxFaceHeight, 'rgb(200, 90, 255)'], [d.settings.minFaceHeight, 'rgb(60, 170, 255)']]) {
      const side = size * height;
      ctx.strokeStyle = color;
      ctx.strokeRect(cx - side / 2, cy - side / 2, side, side);
    }
  } else {
    ctx.strokeStyle = 'rgba(255, 220, 0, 0.9)';
    ctx.strokeRect(region.x * width, region.y * height, region.width * width, region.height * height);
  }
  ctx.setLineDash([]);

  for (const face of d.faces) {
    const color = face.accepted ? 'rgb(0, 230, 90)' : 'rgb(255, 60, 60)';
    const x = face.box.x * width;
    const y = face.box.y * height;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, face.box.width * width, face.box.height * height);
    ctx.fillStyle = color;
    ctx.fillRect(face.center.x * width - line * 2, face.center.y * height - line * 2, line * 4, line * 4);
    ctx.fillText(face.score.toFixed(2), x, Math.max(y - line * 2, 14 * dpr));
  }
}

// 겹쳐 그리기는 D 화면이나 조절 화면이 열려 있을 때만 그린다. 둘 다 닫히면 흔적 없이 지운다.
function updateOverlay() {
  const visible = !devInfo.hidden || tuning.isOpen();
  devOverlay.hidden = !visible;
  if (visible && devOverlayFrame === null) {
    drawDevOverlay();
  } else if (!visible) {
    cancelAnimationFrame(devOverlayFrame);
    devOverlayFrame = null;
  }
}

function toggleDevInfo() {
  devInfo.hidden = !devInfo.hidden;
  clearInterval(devInfoTimer);
  devInfoTimer = null;
  if (!devInfo.hidden) {
    renderDevInfo();
    devInfoTimer = setInterval(renderDevInfo, 500);
  }
  updateOverlay();
}

window.addEventListener('keydown', (event) => {
  if (event.repeat || event.ctrlKey || event.altKey || event.metaKey) return;
  if (event.code === Keys.devInfo) toggleDevInfo();
  else if (event.code === Keys.tuning) tuning.toggle();
  else if (event.code === Keys.start) session.request('start', 'key');
  else if (event.code === Keys.reset) session.request('reset', 'key');
  else if (event.code === 'Escape' && tuning.isOpen()) tuning.close();
});

applyLayout();
camera.subscribe(() => {
  session.setCameraReady(camera.isReady());
  renderStatus();
  renderPresence();
  if (!devInfo.hidden) renderDevInfo();
});
presence.subscribe(renderPresence);
session.subscribe(renderSession);
document.addEventListener('visibilitychange', () => session.setPageVisible(!document.hidden));
autoStart.start();
camera.start();
presence.start();
