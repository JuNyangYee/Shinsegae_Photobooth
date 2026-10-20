import { config } from './config/config.js';
import { createAutoStart } from './core/auto-start.js';
import { CameraStatus, createCameraMonitor } from './camera/camera-monitor.js';
import { createCapture } from './camera/capture.js';
import { DetectorHealth } from './vision/detector-keeper.js';
import { Guidance, decideGuidance } from './core/guidance.js';
import { createPresenceMonitor } from './vision/presence-monitor.js';
import { serializePresenceSettings } from './config/presence-settings.js';
import { createPresenceTuning } from './ui/presence-tuning.js';
import { SessionState, createSession } from './core/session.js';
import { createSettingsFileClient, loadInitialEffectSettings, loadInitialPresenceSettings } from './config/settings-file.js';
import { effectTunables, serializeEffectSettings } from './config/effect-settings.js';
import { EffectStatus, createEffectPreview } from './effect/effect-preview.js';
import { createPhotoEffect } from './effect/photo-effect.js';
import { createEffectTuning } from './ui/effect-tuning.js';
import { renderDevPanel } from './ui/dev-panel.js';
import { guestText } from './config/guest-text.js';
import { createGuestScreen } from './ui/guest-screen.js';

const stage = document.getElementById('stage');
const video = document.getElementById('preview');
const effectCanvas = document.getElementById('effect');
const devInfo = document.getElementById('dev-info');
const devOverlay = document.getElementById('dev-overlay');
const pauseBadge = document.getElementById('pause-badge');

// 운영자 단축키 (관람객용 아님): D 개발용 정보, R 인식 범위 조절, E 사진 효과 조절, S 수동 촬영 시작, X 강제 초기화,
// P 자동 촬영 일시정지
const Keys = Object.freeze({ devInfo: 'KeyD', tuning: 'KeyR', effectTuning: 'KeyE', start: 'KeyS', reset: 'KeyX', pause: 'KeyP' });

// 관람객 화면 표현 (6-2, 7-2 미니멀). 문구는 config/guest-text.js 한곳에 있고, 상태 상세는 D 키 개발용 정보에만 보인다.
const guest = createGuestScreen({ root: document, text: guestText, countdownSeconds: config.session.countdownSeconds });

// 기다려도 스스로 풀리기 어려운 카메라 상태는 바로 직원 문의 문구를 보인다. 감지기는 장애(fault)가 그렇다.
const staffNowStatuses = new Set([CameraStatus.UNSUPPORTED, CameraStatus.PERMISSION_DENIED]);

// D 화면용 감지기 장애 원인 설명 (face-detector.js DetectorFault)
const detectorCauseLabels = Object.freeze({
  'bundle-load-failed': '라이브러리 파일을 불러오지 못함',
  'model-unavailable': '모델 파일을 받지 못함',
  'model-invalid': '모델 파일 손상 (크기·SHA-256 불일치)',
  'webgl-unavailable': '하드웨어 가속 꺼짐 또는 WebGL 없음',
  'webgl-context-lost': '실행 중 WebGL 컨텍스트 손실',
  'create-failed': '감지기 생성 실패',
  'detect-failing': '감지가 계속 실패',
});

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

// 사진 효과 미리보기: 영상 → 유화 효과 캔버스. 효과를 쓸 수 없으면 원본 미리보기 (카메라·감지·촬영은 그대로)
const effect = createEffectPreview({
  canvas: effectCanvas,
  video,
  camera,
  stageAspect,
  mirror: config.mirror,
  settings: config.effect,
  onChange: () => {
    if (!devInfo.hidden) renderDevInfo();
  },
});

// 촬영 결과에도 같은 효과: 셔터 순간 화면의 그림과 같은 프레임·seed로 결과 크기(짧은 변 1080)에 다시 그린다.
// 효과를 그리지 못하면 원본 사진으로 대신한다 (photo-effect.js)
const photoEffect = createPhotoEffect({ preview: effect });

const capture = createCapture({
  video, stageAspect, mirror: config.mirror, ...config.capture, getFrameInfo: camera.getFrameInfo,
  effect: photoEffect.apply,
});

// 촬영 한 사이클. 시작·취소·초기화는 session.request() 한 곳으로 들어간다 (키보드와 auto-start.js).
const session = createSession({
  timing: config.session,
  takePhoto: capture.take,
  releasePhoto: capture.release,
  cameraReady: camera.isReady(),
  pageVisible: !document.hidden,
});

// 조절값 파일 (서버 config/presence.local.json). 불러오기가 끝나면 조절 화면을 만들고 그 값을 감지 루프에 넣는다.
// 그 전까지 감지 루프는 config.presence 기본값으로 돌지만, 자동 시작은 막는다(기본값으로 잠깐 판정해 시작하지 않게).
const settingsFile = createSettingsFileClient(config.settingsFile);
let tuning = null; // 불러오기가 끝나면 만든다
let settingsReady = false;
// 효과 조절값 파일 (서버 config/effect.local.json). 불러오기 전에는 config.effect 기본값으로 그린다 (판정과 무관하므로 막지 않는다)
const effectSettingsFile = createSettingsFileClient(config.effectSettingsFile);
let effectTuning = null; // 불러오기가 끝나면 만든다
// 자동 촬영 일시정지 (P). 저장하지 않는다: 새로고침·재시작하면 다시 켜진다(운영자가 해제를 잊어도 회복되게).
let autoPaused = false;

// 인식 상태로 자동 시작하고, 인식으로 시작한 카운트다운은 대상이 떠나면 취소한다.
// 조절 화면이 열려 있거나, 일시정지 중이거나, 조절값을 아직 불러오지 않았으면 자동 시작을 막는다.
const autoStart = createAutoStart({
  session, presence,
  // 인식 범위(R)·효과(E) 조절 화면이 열려 있으면 막는다. 효과를 조절하는 운영자가 화면 앞에 서서 보므로,
  // 자동 회차가 끼어들면 결과 사진이 미리보기를 가린다.
  isTuningOpen: () => (tuning?.isOpen() ?? false) || (effectTuning?.isOpen() ?? false),
  isPaused: () => autoPaused,
  isSettingsReady: () => settingsReady,
});

let staffNoticeTimer = null;
let guidanceSince = null; // 카메라·감지기 중 하나라도 쓸 수 없게 된 시각 (performance.now). 둘 다 정상이면 null
let guidanceNow = Guidance.NONE;
let devInfoTimer = null;
let devOverlayFrame = null;

// 저장소 접근 자체가 막힌 환경에서도 앱은 기본값으로 동작한다.
function getStorage() {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

// 결과 사진을 보이는 동안에는 상태 문구와 인식 표시를 사진 위에 띄우지 않는다.
function isShowingPhoto() {
  return session.getState().state === SessionState.RESULT;
}

// 회차가 진행 중(카운트다운·촬영·결과)이면 상태 문구를 숨긴다. 카메라가 끊기면 카운트다운은 바로 취소되므로,
// 여기서 숨는 것은 감지기 장애 중 S 수동 촬영의 안내뿐이다.
function isRoundActive() {
  const { state } = session.getState();
  return state === SessionState.COUNTDOWN || state === SessionState.CAPTURING || state === SessionState.RESULT;
}

function showStatus(message) {
  guest.setStatus({ message, kind: guidanceNow, visible: Boolean(message) && !isRoundActive() });
}

// 카메라와 감지기 상태를 하나의 안내 규칙으로 판정한다 (guidance.js). 감지기를 쓸 수 없어도 S 수동 촬영은 된다.
function renderStatus() {
  clearTimeout(staffNoticeTimer);
  const cameraState = camera.getState();
  const detector = presence.getDetectorHealth();
  const decision = decideGuidance({
    camera: {
      ok: cameraState.status === CameraStatus.READY,
      staffNow: staffNowStatuses.has(cameraState.status),
      since: cameraState.notReadySince,
    },
    detector: {
      ok: detector.health === DetectorHealth.OK,
      staffNow: detector.health === DetectorHealth.FAULT,
      since: detector.since,
    },
    since: guidanceSince,
    now: performance.now(),
    staffAfterMs: config.cameraRecovery.staffNoticeMs,
  });
  guidanceSince = decision.since;
  guidanceNow = decision.guidance;
  showStatus(decision.guidance === Guidance.NONE ? '' : guestText[decision.guidance]);
  if (decision.recheckInMs !== null) staffNoticeTimer = setTimeout(renderStatus, decision.recheckInMs);
}

// 카메라나 감지기를 쓸 수 없으면 "준비 중" 문구만 보이고 인식 표시(가장자리 가는 선)·대기 안내는 숨긴다.
// 인식 표시는 config.showPresenceIndicator로 끈다. 대기 안내는 대기 상태에서만 보인다(카운트다운·쿨타임은 각자 문구).
function renderPresence() {
  const visible = camera.isReady() && guidanceNow === Guidance.NONE && !isShowingPhoto();
  guest.setPresence(config.showPresenceIndicator && visible && presence.isPresent());
  guest.setGuide(visible && session.getState().state === SessionState.IDLE);
}

// ---- 촬영 한 사이클 화면 ----

// 조절 화면을 닫으면 그 시점의 인식 상태로 자동 시작을 다시 판단한다.
function handleTuningOpenChange(open) {
  updateOverlay();
  if (!open) autoStart.evaluate('tuning-closed');
}

function handleEffectTuningOpenChange(open) {
  if (!open) autoStart.evaluate('effect-tuning-closed');
  if (!devInfo.hidden) renderDevInfo();
}

// 카운트다운·플래시·결과 사진은 guest-screen이 보인다. 결과가 끝나면 그 안에서 <img>의 src를 먼저 지우고,
// 그 뒤 session이 Object URL을 정리한다 (같은 알림 안에서 동기로).
function renderSession(s) {
  guest.renderSession(s);
  renderStatus();
  guest.setNotice(s.state === SessionState.COOLDOWN && guidanceNow === Guidance.NONE);
  renderPresence();
  if (!devInfo.hidden) renderDevInfo();
}

function applyLayout() {
  const { width, height } = config.aspectRatio;
  document.documentElement.style.setProperty('--stage-ratio-w', String(width));
  document.documentElement.style.setProperty('--stage-ratio-h', String(height));
  video.classList.toggle('is-mirrored', config.mirror);
  updateOperatorRoom();
}

// 운영자 패널(R·E)을 9:16 영역 옆 빈 곳에 세울 공간이 실제로 있는지 (6단계 검수 2). 화면 비율만 보면 좁은 가로 창
// (예: 1200×1080)에서 패널이 영상을 가린다. 옆 빈 폭에 패널 최소 폭(24em)과 여백(2em)이 들어갈 때만 옆으로 세운다
// (style.css의 .op-side-room). 1080×1920·2160×3840(세로)은 공간이 없어 아래·위, 1920×1080은 옆이다.
const OPERATOR_PANEL_ROOM_EM = 26;

function updateOperatorRoom() {
  const side = (window.innerWidth - stage.getBoundingClientRect().width) / 2;
  const em = parseFloat(getComputedStyle(document.getElementById('effect-panel')).fontSize);
  document.documentElement.classList.toggle('op-side-room', side >= OPERATOR_PANEL_ROOM_EM * em);
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
  const cameraLines = [
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
  // 구역별 표 (ui/dev-panel.js). 글자는 예전과 같다(구역 사이 빈 줄) — 확인 도구가 줄 머리말로 읽는다
  renderDevPanel(devInfo, [
    ['카메라', cameraLines],
    ['인식', presenceDevLines()],
    ['효과 · 출력', effectDevLines()],
    ['촬영', sessionDevLines()],
  ]);
}

function presenceDevLines() {
  const d = presence.getDebugSnapshot();
  const { region, minFaceHeight, maxFaceHeight, minScore, presentHoldMs, absentGraceMs } = d.settings;
  const accepted = d.faces.filter((face) => face.accepted).length;
  const progress = d.progress
    ? `-> ${d.progress.target ? 'present' : 'absent'} ${Math.round(d.progress.elapsedMs)}/${d.progress.requiredMs}ms`
    : 'stable';
  const seconds = (ms) => `${(ms / 1000).toFixed(1)}s`;
  const lines = [
    `detector   : ${d.status}, health ${d.health}${d.cause ? ` / ${d.cause} (${detectorCauseLabels[d.cause] ?? '-'})` : ''}`,
  ];
  if (d.health !== DetectorHealth.OK) {
    lines.push(`  failure  : ${d.error || '-'}`);
    lines.push(`  retry    : ${d.failuresInRow} in a row, ${d.createAttempts} attempts,`
      + ` next ${d.creating ? 'creating now' : d.retryInMs === null ? '-' : `in ${seconds(d.retryInMs)}`},`
      + ` unavailable ${d.unavailableMs === null ? '-' : seconds(d.unavailableMs)}`);
  }
  lines.push(
    `webgl      : ${d.webgl ? `webgl${d.webgl.version} ${d.webgl.renderer || '(renderer hidden)'}${d.webgl.software ? ' (software)' : ''}` : '-'}`,
    `model      : ${d.model ? `${d.model.bytes} bytes, ${d.model.hashChecked ? 'sha256 ok' : 'size only'}` : '-'}`,
    `guidance   : ${guidanceNow}${guidanceSince === null ? '' : ` for ${seconds(performance.now() - guidanceSince)}`}`,
    `delegate   : ${d.delegate}${d.delegateFailures.length ? ` (failed: ${d.delegateFailures.join('; ')})` : ''}`,
    `detect     : ${d.detectMs.toFixed(1)}ms (avg ${d.averageDetectMs.toFixed(1)}ms, draw ${d.drawMs.toFixed(1)}ms)`
      + ` @ ${d.fps}fps (max ${d.maxFps}), input ${d.input}`,
    `faces      : ${d.faces.length} detected, ${accepted} accepted`
      + ` (same-frame skips ${d.skippedSameFrame}, criteria resets ${d.criteriaResets})`,
    `presence   : ${d.present ? 'PRESENT' : 'absent'} (raw ${d.raw ? 'present' : 'absent'}, ${progress})`,
    `criteria   : region x${region.x} y${region.y} w${region.width} h${region.height},`
      + ` face ${minFaceHeight}~${maxFaceHeight}, min score ${minScore}, hold ${presentHoldMs}ms, grace ${absentGraceMs}ms`,
    `settings   : ${tuning ? tuning.describeSettingsSource() : 'loading'} (${config.settingsFile.url})`,
  );
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

function effectDevLines() {
  const e = effect.getState();
  const ms = (value) => (value === null ? '-' : `${value.toFixed(1)}ms`);
  const losses = e.contextLosses ? `, context lost ${e.contextLosses}x` : '';
  // 결과 사진 준비 (첫 촬영 멈춤 수정): 처리 해상도가 1이 아니면 대기 중에 결과 크기로 미리 한 번 그린다
  const resultSize = `${e.resultWidth}x${e.resultHeight}`;
  const prepare = {
    'same-size': 'same targets as preview', ready: `${resultSize} ready${e.prepareMs === null ? '' : ` (${ms(e.prepareMs)})`}`,
    pending: `${resultSize} preparing`,
  }[e.resultPrepare] ?? '-';
  const t = effectTunables(effect.getSettings());
  const values = `  values   : strength ${t.strength} size ${t.size} boil ${t.boil} fps ${t.fps} grade ${t.grade}`
    + ` refine ${t.refineThreshold ?? '-'} scale ${t.previewScale} | output ${t.outputMode} ${t.dither} paper ${t.paperDots}`
    + ` style ${t.bwStyle} texture ${t.bwTexture} lines ${t.lineSpacing}`
    + ` brightness ${t.brightness} contrast ${t.contrast} gamma ${t.gamma}`
    + ` (${effectTuning ? effectTuning.describeSettingsSource() : 'loading'}, ${config.effectSettingsFile.url})`;
  // 출력 단계 (6-1): 감열지면 인쇄 해상도, 점을 정하는 것(점 방식 또는 흐름·붓 결 선, 7-1)·흑백 스타일, 화소 읽기·CPU 디더 시간(오차 확산만).
  // 회색조 유화(8단계)는 입력 회색조 계수와, 촬영 결과에서 만드는 인쇄 데이터의 용지 폭·점 방식
  let output = e.outputMode;
  if (e.outputMode === 'thermal') {
    output = `thermal ${e.printWidth}x${e.printHeight} ${e.screen} (style ${e.bwStyle}), read ${ms(e.readMs)}, dither ${ms(e.ditherMs)}`;
  } else if (e.outputMode === 'gray-oil') {
    output = `gray-oil (input luma Rec.709 -> oil2f -> gray), print data on photo: paper ${t.paperDots} ${t.dither}`;
  }
  const p = photoEffect.getStats();
  let photo = '-';
  const mode = p.last?.mode && p.last.mode !== 'off' ? `${p.last.mode} ` : '';
  if (p.last?.status === 'applied') {
    photo = `applied ${mode}${p.last.width}x${p.last.height}${p.last.dither ? ` ${p.last.dither}` : ''}`
      + ` seed ${p.last.seed} tick ${p.last.tick}`
      + ` (${p.last.sameAsPreview ? 'same drawing as preview' : 'new drawing'}${p.last.check ? `, ${p.last.check}` : ''}),`
      + ` render ${ms(p.last.renderMs)}, total ${ms(p.last.ms)}`;
  } else if (p.last?.status === 'raw') {
    photo = `RAW PHOTO ${mode}${p.last.width}x${p.last.height} (${p.last.reason})`;
  } else if (p.last) {
    photo = p.last.status;
  }
  const photoLine = `photo-fx   : ${photo} (applied ${p.applied}, raw ${p.fellBack})`;
  const pr = p.last?.print;
  const printLine = `print      : ${pr
    ? `${pr.width}x${pr.height} 1-bit, raster ${pr.bytesPerRow}B/row ${pr.rasterBytes}B, png ${pr.pngBytes}B`
      + ` (IHDR depth ${pr.pngBitDepth} color ${pr.pngColorType}), black ${(pr.blackRatio * 100).toFixed(1)}%`
      + `${p.last.printFallback ? `, from photo on CPU (GPU print failed: ${p.last.printFallback})` : ''}`
    : p.last?.printError ? `none (${p.last.printError})` : '-'}`;
  if (e.status === EffectStatus.DISABLED) return ['effect     : disabled (config.effect.enabled) -> camera preview', photoLine, printLine];
  if (e.status === EffectStatus.FALLBACK || e.status === EffectStatus.CONTEXT_LOST) {
    return [`effect     : ${e.status} (${e.fault || '-'}) -> camera preview${losses}`, values, photoLine, printLine];
  }
  return [
    `effect     : ${e.status}${e.shown ? '' : ' (hidden)'}, ${e.width}x${e.height} (preview x${e.previewScale}, px scale ${e.pxScale.toFixed(3)}),`
      + ` fps ${e.fps} -> ${e.drawingsPerSecond} drawings/s, boil ${e.boil}, seed ${e.seed ?? '-'}${losses}`,
    `  time     : cpu ${ms(e.cpuMs)} (avg ${ms(e.cpuAvgMs)}), gpu ${e.gpuTimer ? ms(e.gpuMs) : 'n/a'},`
      + ` strokes ${e.strokes}, ${e.renderer || '-'}, result ${prepare}`,
    `  output   : ${output}`,
    values,
    photoLine,
    printLine,
  ];
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
    `auto       : ${autoPaused ? 'PAUSED (P) | ' : ''}${a.lastReason || '-'} | last start ${describeAuto(a.lastStart)} | last cancel ${describeAuto(a.lastCancel)}`,
    `last end   : ${s.lastEnd || '-'}${s.lastError ? ` / ${s.lastError}` : ''}`,
    `failures   : ${s.failures} in a row${s.retryAt === null ? '' : `, auto start waits ${Math.max(0, (s.retryAt - performance.now()) / 1000).toFixed(1)}s`}`,
    `ignored    : ${s.lastIgnored || '-'}`,
    last
      ? `capture    : ${last.width}x${last.height} from video ${last.source}`
        + ` (crop x${last.crop.x} y${last.crop.y}), ${last.type} ${Math.round(last.bytes / 1024)}KB,`
        + ` grab ${last.grabMs.toFixed(1)}ms, encode ${last.encodeMs.toFixed(1)}ms`
      : 'capture    : -',
    `resources  : object URLs ${c.liveUrls}, canvases ${c.liveCanvases}, pending jobs ${c.pending}`
      + ` (taken ${c.taken}, released ${c.released}, stale results ${s.staleResults}), print data ${c.livePrints}`,
  ];
}

// 겹쳐 그리기 색 (6-3, 7-2 무채색 화면에 맞춰 채도를 낮춤). 흑백 점 미리보기 위에서도 보이게 선마다 어두운 테두리를 먼저 그린다
const OVERLAY = Object.freeze({
  region: '#f4f2ee', // 인식 영역 (오프화이트)
  maxGuide: '#e0a39a', // 최대 얼굴 크기 가이드 (붉은색)
  minGuide: '#8fb6d6', // 최소 얼굴 크기 가이드 (파란색)
  accepted: '#7fcf9c', // 인정된 얼굴
  rejected: '#ff7a6e', // 제외된 얼굴
  outline: 'rgba(16, 16, 16, 0.85)',
});

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
  const line = Math.max(2, Math.round(width * 0.003)); // 9:16 영역 폭에 비례 (1080 → 3px)
  ctx.font = `${Math.round(width * 0.022)}px Consolas, monospace`;
  const strokeBox = (x, y, w, h, color) => {
    ctx.lineWidth = line * 2.2;
    ctx.strokeStyle = OVERLAY.outline;
    ctx.strokeRect(x, y, w, h);
    ctx.lineWidth = line;
    ctx.strokeStyle = color;
    ctx.strokeRect(x, y, w, h);
  };

  const { region } = d.settings;
  ctx.setLineDash([line * 4, line * 3]);
  if (tuning?.isOpen()) {
    // 얼굴 박스는 거의 정사각형이므로 한 변 = 기준 높이 x 9:16 영역 높이(px)인 정사각형으로 보인다.
    const cx = (region.x + region.width / 2) * width;
    const cy = (region.y + region.height / 2) * height;
    for (const [size, color] of [[d.settings.maxFaceHeight, OVERLAY.maxGuide], [d.settings.minFaceHeight, OVERLAY.minGuide]]) {
      const side = size * height;
      strokeBox(cx - side / 2, cy - side / 2, side, side, color);
    }
  } else {
    strokeBox(region.x * width, region.y * height, region.width * width, region.height * height, OVERLAY.region);
  }
  ctx.setLineDash([]);

  for (const face of d.faces) {
    const color = face.accepted ? OVERLAY.accepted : OVERLAY.rejected;
    const x = face.box.x * width;
    const y = face.box.y * height;
    strokeBox(x, y, face.box.width * width, face.box.height * height, color);
    ctx.fillStyle = color;
    ctx.fillRect(face.center.x * width - line * 2, face.center.y * height - line * 2, line * 4, line * 4);
    const ty = Math.max(y - line * 3, width * 0.03);
    ctx.lineWidth = line * 2;
    ctx.strokeStyle = OVERLAY.outline;
    ctx.strokeText(face.score.toFixed(2), x, ty);
    ctx.fillText(face.score.toFixed(2), x, ty);
  }
}

// 겹쳐 그리기는 D 화면이나 조절 화면이 열려 있을 때만 그린다. 둘 다 닫히면 흔적 없이 지운다.
function updateOverlay() {
  const visible = !devInfo.hidden || (tuning?.isOpen() ?? false);
  devOverlay.hidden = !visible;
  if (visible && devOverlayFrame === null) {
    drawDevOverlay();
  } else if (!visible) {
    cancelAnimationFrame(devOverlayFrame);
    devOverlayFrame = null;
  }
}

// 일시정지하면 인식으로 시작한 카운트다운은 auto-start가 취소한다. S 수동 촬영은 그대로 된다.
function togglePause() {
  autoPaused = !autoPaused;
  renderPauseBadge();
  autoStart.evaluate(autoPaused ? 'paused (P)' : 'resumed (P)');
  if (!devInfo.hidden) renderDevInfo();
}

function renderPauseBadge() {
  pauseBadge.hidden = !(autoPaused && config.showPauseIndicator);
  pauseBadge.textContent = guestText.paused;
}

// 시작할 때 조절값: 파일 → (없으면) localStorage에서 옮김 → 기본값. 실패하거나 시간 초과면 기본값 (settings-file.js).
async function loadSettings() {
  try {
    const initial = await loadInitialPresenceSettings({ file: settingsFile, storage: getStorage(), defaults: config.presence });
    if (initial.note && initial.note !== 'no file') console.warn('[settings]', `${initial.source}: ${initial.note}`);
    tuning = createPresenceTuning({
      stage,
      panel: document.getElementById('tuning-panel'),
      layer: document.getElementById('tuning-layer'),
      monitor: presence,
      defaults: config.presence,
      initial,
      saveSettings: (settings) => settingsFile.write(serializePresenceSettings(settings)),
      onOpenChange: handleTuningOpenChange,
    });
  } catch (error) {
    // 여기까지 오면 코드 오류다. 자동 촬영이 영영 막히지 않게 기본값으로 계속한다.
    console.error('[settings] setup failed; continuing with defaults', error);
  }
  settingsReady = true;
  autoStart.evaluate('settings-loaded');
  if (!devInfo.hidden) renderDevInfo();
}

// 효과 조절값: 파일 → 기본값 (settings-file.js). 끝나면 조절 화면을 만들고 그 값을 미리보기에 넣는다.
async function loadEffectSettings() {
  try {
    const initial = await loadInitialEffectSettings({ file: effectSettingsFile, defaults: config.effect });
    if (initial.note && initial.note !== 'no file') console.warn('[effect-settings]', `${initial.source}: ${initial.note}`);
    effectTuning = createEffectTuning({
      panel: document.getElementById('effect-panel'),
      preview: effect,
      defaults: config.effect,
      initial,
      saveSettings: (settings) => effectSettingsFile.write(serializeEffectSettings(settings)),
      onOpenChange: handleEffectTuningOpenChange,
    });
  } catch (error) {
    console.error('[effect-settings] setup failed; continuing with defaults', error);
  }
  if (!devInfo.hidden) renderDevInfo();
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
  // R·E 조절 화면은 한 번에 하나만 연다 (다른 쪽이 열려 있으면 키를 무시한다)
  if (event.code === Keys.devInfo) toggleDevInfo();
  else if (event.code === Keys.tuning) {
    if (!effectTuning?.isOpen()) tuning?.toggle();
  } else if (event.code === Keys.effectTuning) {
    if (!tuning?.isOpen()) effectTuning?.toggle();
  }
  else if (event.code === Keys.start) session.request('start', 'key');
  else if (event.code === Keys.reset) session.request('reset', 'key');
  else if (event.code === Keys.pause) togglePause();
  else if (event.code === 'Escape' && tuning?.isOpen()) tuning.close();
  else if (event.code === 'Escape' && effectTuning?.isOpen()) effectTuning.close();
});

applyLayout();
window.addEventListener('resize', updateOperatorRoom);
camera.subscribe(() => {
  session.setCameraReady(camera.isReady());
  renderStatus();
  renderPresence();
  if (!devInfo.hidden) renderDevInfo();
});
presence.subscribe(renderPresence);
presence.subscribeDetector(() => {
  renderStatus();
  renderPresence();
  if (!devInfo.hidden) renderDevInfo();
});
session.subscribe(renderSession);
document.addEventListener('visibilitychange', () => session.setPageVisible(!document.hidden));
autoStart.start();
loadSettings();
loadEffectSettings();
camera.start();
presence.start();
effect.start();
