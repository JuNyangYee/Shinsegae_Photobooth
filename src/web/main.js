import { config } from './config/config.js';
import { createAutoStart } from './core/auto-start.js';
import { CameraStatus, createCameraMonitor } from './camera/camera-monitor.js';
import { createCameraFrame } from './camera/camera-frame.js';
import { createCapture } from './camera/capture.js';
import { createRawPreview } from './camera/raw-preview.js';
import { normalizeCameraSettings, resolutionRequest, serializeCameraSettings } from './config/camera-settings.js';
import { cameraGeometryKey } from './core/camera-view.js';
import { DetectorHealth } from './vision/detector-keeper.js';
import { Guidance, decideGuidance } from './core/guidance.js';
import { createPresenceMonitor } from './vision/presence-monitor.js';
import { serializePresenceSettings } from './config/presence-settings.js';
import { createPresenceTuning } from './ui/presence-tuning.js';
import { SessionState, createSession } from './core/session.js';
import {
  createSettingsFileClient, loadInitialCameraSettings, loadInitialEffectSettings, loadInitialPresenceSettings, loadInitialTimingSettings,
  presenceTextForSave,
} from './config/settings-file.js';
import { normalizeTimingSettings, serializeTimingSettings } from './config/timing-settings.js';
import { createTimingTuning } from './ui/timing-tuning.js';
import { effectCombo, effectTunables, serializeEffectSettings } from './config/effect-settings.js';
import { EffectStatus, createEffectPreview } from './effect/effect-preview.js';
import { createFilterUpdates } from './effect/filter-updates.js';
import { createPhotoSource, createScreenCompositor } from './effect/screen-compositor.js';
import { validateBundle } from './config/filter-source.js';
import { loadInitialScreenSettings, serializeScreenSettings } from './config/screen-settings.js';
import { createScreenLayers } from './ui/screen-layers.js';
import { createScreenTuning } from './ui/screen-tuning.js';
import { createPhotoEffect } from './effect/photo-effect.js';
import { createEffectTuning } from './ui/effect-tuning.js';
import { createCameraTuning } from './ui/camera-tuning.js';
import { PanelSection, createOperatorPanel, showsPresenceEditing, showsRawWindow } from './ui/operator-panel.js';
import { renderDevPanel } from './ui/dev-panel.js';
import { guestText } from './config/guest-text.js';
import { createGuestScreen } from './ui/guest-screen.js';
import { createScenePlate } from './ui/scene-plate.js';
import { clipRegionToFrame, photoFrameAspect, photoFrameRect } from './core/photo-frame.js';
import { IMPRINT_FONT_LOADS } from './effect/imprint-page.js';

const stage = document.getElementById('stage');
const video = document.getElementById('preview');
const effectCanvas = document.getElementById('effect');
const rawCanvas = document.getElementById('camera-raw');
const rawWindow = document.getElementById('raw-window');
const rawWindowCanvas = document.getElementById('raw-window-canvas');
const rawWindowOverlay = document.getElementById('raw-window-overlay');
const devInfo = document.getElementById('dev-info');
const devOverlay = document.getElementById('dev-overlay');
const pauseBadge = document.getElementById('pause-badge');

// 운영자 단축키 (관람객용 아님): D 개발용 정보, E 운영자 조절 화면(카메라·인식·시간·필터, 9-2·10. 예전 R은 인식 섹션으로 합쳤다),
// S 수동 촬영 시작, X 강제 초기화, P 자동 촬영 일시정지
const Keys = Object.freeze({ devInfo: 'KeyD', operatorPanel: 'KeyE', start: 'KeyS', reset: 'KeyX', pause: 'KeyP' });

// 동작 줄이기: 시스템 설정(prefers-reduced-motion)을 :root[data-motion]으로 옮긴다. CSS와 관람객 화면(guest-screen.js)이 이 값 하나를 본다
const reducedMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
const applyMotionPreference = () => { document.documentElement.dataset.motion = reducedMotionQuery.matches ? 'reduce' : 'full'; };
applyMotionPreference();
reducedMotionQuery.addEventListener('change', applyMotionPreference);

// 관람객 화면 표현 (IMPRINT에서 시작, 14단계 눈 마을 장면). 문구는 config/guest-text.js 한곳에 있고, 상태 상세는 D 키 개발용 정보에만 보인다.
// 카운트다운 진행선 길이는 회차마다 상태 기계 스냅숏(countdownSeconds)을 따른다
const guest = createGuestScreen({
  root: document, text: guestText, countdownSeconds: config.timing.countdownSeconds,
  stageAspect: config.aspectRatio.width / config.aspectRatio.height,
  reducedMotion: () => document.documentElement.dataset.motion === 'reduce',
});

// 관람객 화면 장면 (14단계, 가안): 생성 장면 한 장을 그리고 사진 창 줄의 그린만 뺀다. 못 읽으면 대체 배경과 글자만 보인다 (D 화면에 결과)
let sceneInfo = 'loading';
const scenePlateReady = createScenePlate({
  canvas: document.getElementById('scene-plate'), src: config.scene.plate, frame: config.photoFrame,
  key: config.scene.key, keyMarginFrac: config.scene.keyMarginFrac, layout: config.scene.layout,
  size: config.scene.size,
}).ready.then((r) => {
  sceneInfo = r.ok ? `${r.width}x${r.height}${r.bands ? `, bands top ${r.bands.topShift} bottom ${r.bands.bottomShift >= 0 ? '+' : ''}${r.bands.bottomShift}` : ''}, keyed ${r.keyed.width}x${r.keyed.height}@${r.keyed.left},${r.keyed.top}${r.fit ? `, fit x${r.fit.scale.toFixed(3)} gap ${r.gapFilled} sealed ${r.sealed}` : ""} (clear ${r.cleared}, edge ${r.edge}, rim ${r.despilled})`
    : `fallback background (${r.error})`;
  if (!r.ok) console.warn(`[scene] ${r.error}`);
  return r;
});

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

const stageAspect = config.aspectRatio.width / config.aspectRatio.height;

// 카메라 처리 경로 (9-1): 카메라 원본 → 색 보정 → 좌우 반전·회전·확대·이동 → 9:16 화면 영역. 설정은 이 한 곳(cameraFrame)에 있고
// 감지 입력·원본 미리보기·캡처(2D 캔버스)와 효과 미리보기·결과 사진(셰이더)이 모두 같은 설정·같은 계산(core/camera-view.js)으로 그린다.
// 시작할 때 카메라 조절값 파일(config/camera.local.json)을 읽은 뒤 카메라를 연다 (loadCameraSettings).
const cameraFrame = createCameraFrame({ doc: document, stageAspect, settings: normalizeCameraSettings(config.camera, config.camera).settings });
// 카메라 조절값의 출처 (D 화면, 9-2 운영자 화면): loadInitialCameraSettings 결과
let cameraSettingsInfo = { source: 'loading', note: '', issues: [] };

const cameraRequestFor = (settings) => ({
  deviceLabel: settings.deviceLabel, idealResolution: resolutionRequest(settings, config.idealResolution),
});

// 시간 설정 (10단계, E 시간 섹션, config/timing.local.json): 촬영 흐름·인식 반응·카메라 회복. 불러오기 전에는 기본값이다.
// 바꾸는 곳은 applyTimingSettings 하나 (촬영 흐름은 다음 회차부터, 인식 반응은 다음 감지부터, 카메라 회복은 다음 재시도·판정부터)
let timingNow = normalizeTimingSettings(config.timing, config.timing).settings;
// 인식 섹션의 판정값(영역·얼굴 크기·신뢰도). 감지 루프에는 시간 섹션의 반응 시간과 합쳐 넣는다 (presenceSettingsFor)
let presenceCriteria = config.presence;
// 사진 틀 (IMPRINT 시안): 얼굴 중심이 사진 틀 밖이면 찍혀도 사진에 얼굴이 없으므로, 인식 영역을 틀 안으로 줄여 판정한다.
// 저장하는 값(인식 섹션)은 운영자가 정한 영역 그대로이고, 감지 루프에 넣는 값만 줄인다 (D criteria 줄 = 줄인 영역)
let presenceRegionClipped = false;
const presenceSettingsFor = () => {
  const { region, clipped } = clipRegionToFrame(presenceCriteria.region, config.photoFrame);
  presenceRegionClipped = clipped;
  return { ...presenceCriteria, region, presentHoldMs: timingNow.presentHoldMs, absentGraceMs: timingNow.absentGraceMs };
};

const camera = createCameraMonitor({
  video,
  preferredLabel: config.preferredCameraLabel,
  request: cameraRequestFor(cameraFrame.getSettings()),
  // 회복 시간은 시간 설정의 cameraRecovery (9-1은 인식 조절값, 10단계부터 시간 섹션). 쓸 때마다 지금 값을 읽는다
  recovery: () => timingNow.cameraRecovery,
});

// 감지 입력은 카메라 처리 경로를 거친 9:16 화면 영역이라 감지 박스가 곧 화면 좌표다. 기하 설정이 바뀌면 인식을 처음부터 다시 잰다
const presence = createPresenceMonitor({
  video,
  camera,
  detection: config.faceDetection,
  presence: presenceSettingsFor(),
  stageAspect,
  cameraKey: cameraGeometryKey(cameraFrame.getSettings()),
  drawFrame: (ctx, width, height) => cameraFrame.draw(ctx, video, width, height),
});

// 사진 효과 미리보기: 영상 → 유화 효과 캔버스. 효과를 쓸 수 없으면 원본 미리보기 (카메라·감지·촬영은 그대로)
const effect = createEffectPreview({
  canvas: effectCanvas,
  video,
  camera,
  stageAspect,
  settings: config.effect,
  cameraFrame,
  onChange: () => {
    updateRawPreview();
    if (!devInfo.hidden) renderDevInfo();
  },
});
const isMirrored = () => cameraFrame.getSettings().mirror;

// 원본 미리보기 (9-1): 효과를 끄거나 쓸 수 없을 때 카메라 처리 경로를 거친 그림을 캔버스에 그린다(원본 대체 사진과 같은 함수).
// 크기는 화면에 보이는 장치 화소와 원본 화소 수 중 작은 쪽 (4K 원본을 매 프레임 그대로 그리지 않는다)
const rawPreview = createRawPreview({
  canvas: rawCanvas,
  video,
  camera,
  frame: cameraFrame,
  getSize(view) {
    const rect = stage.getBoundingClientRect();
    const width = Math.max(2, Math.round(Math.min(rect.width * window.devicePixelRatio, view.visibleWidthPx)));
    return { width, height: Math.max(2, Math.round(width / stageAspect)) };
  },
});

// 효과 미리보기가 그리고 있으면 원본 미리보기를 멈추고, 아니면(끔·장애·손실·카메라 대기) 켠다. 효과 상태가 바뀔 때마다 부른다
function updateRawPreview() {
  rawPreview.setActive(effect.getState().status !== EffectStatus.RUNNING);
}

// 최종 화면 필터 (17단계): 합성된 관람객 화면 전체에 oil2f를 마지막에 한 번. 조절값은 E 화면 섹션. 끔·장애면 기존 화면으로 돌아간다
const screenCompositor = createScreenCompositor({
  canvas: document.getElementById('screen-filter'), dotsCanvas: document.getElementById('screen-dots'), stage, effect,
  display: config.thermalDisplay,
  plateCanvas: document.getElementById('scene-plate'),
  layers: createScreenLayers({ doc: document, stage, frame: config.photoFrame }),
  cameraFallback: () => (effect.getState().status !== EffectStatus.RUNNING && rawCanvas.width > 2 ? rawCanvas : null),
  onChange: () => { if (!devInfo.hidden) renderDevInfo(); },
});
scenePlateReady.then((r) => screenCompositor.setPlateReady(r.ok));

// 원본 창 (9-2): 운영자 화면의 카메라·인식 섹션을 연 동안 구석에 필터 없는 카메라 처리 경로 그림(보정·변환 적용)과 감지 박스.
// 원본 미리보기와 같은 모듈을 작은 캔버스로 쓴다. 크기는 창의 장치 화소(긴 변 최대 RAW_WINDOW_MAX_PX), 그리는 빈도는
// 초당 RAW_WINDOW_FPS 이하(가안, 미리보기·감지·효과 속도를 떨어뜨리지 않게. 측정은 로그 2026-11-02-02). 패널을 닫으면 그리지 않는다
const RAW_WINDOW_MAX_PX = 640;
const RAW_WINDOW_FPS = 30;
const rawWindowPreview = createRawPreview({
  canvas: rawWindowCanvas,
  video,
  camera,
  frame: cameraFrame,
  maxFps: RAW_WINDOW_FPS,
  getSize(view) {
    const box = rawWindow.getBoundingClientRect();
    const longest = Math.max(2, Math.min(RAW_WINDOW_MAX_PX, Math.round(box.height * window.devicePixelRatio), view.visibleHeightPx));
    return { width: Math.max(2, Math.round(longest * stageAspect)), height: Math.round(longest) };
  },
});
let rawWindowFrame = null;
const panelView = () => ({ open: operatorPanel.isOpen(), section: operatorPanel.getSection() });

function updateRawWindow() {
  const visible = showsRawWindow(panelView());
  rawWindow.hidden = !visible;
  rawWindowPreview.setActive(visible);
  if (visible && rawWindowFrame === null) {
    drawRawWindowOverlay();
  } else if (!visible && rawWindowFrame !== null) {
    cancelAnimationFrame(rawWindowFrame);
    rawWindowFrame = null;
  }
}

// 원본 창 위 감지 박스·인식 영역 (판정 좌표 = 화면 좌표라 원본 창에도 그대로)
function drawRawWindowOverlay() {
  rawWindowFrame = requestAnimationFrame(drawRawWindowOverlay);
  const { width, height } = rawWindowCanvas;
  if (rawWindowOverlay.width !== width || rawWindowOverlay.height !== height) {
    rawWindowOverlay.width = width;
    rawWindowOverlay.height = height;
  }
  const ctx = rawWindowOverlay.getContext('2d');
  ctx.clearRect(0, 0, width, height);
  if (rawWindowCanvas.hidden) return;
  drawPresenceOverlay(ctx, width, height, { guides: false, scores: false });
}

rawWindow.addEventListener('click', (event) => {
  if (event.target.closest('button[data-action="raw-move"]')) rawWindow.dataset.pos = rawWindow.dataset.pos === 'b' ? 'a' : 'b';
});

/**
 * 카메라 설정을 바꾼다 (시작할 때 불러온 값, 9-2 운영자 화면). 다음 그림부터 감지·미리보기·결과가 모두 이 값이다.
 * 기하(반전·회전·확대·이동)가 바뀌면 인식을 처음부터 다시 재고, 장치·해상도 요청이 바뀌면 카메라 스트림을 다시 연다
 * (진행 중인 카운트다운은 카메라 준비 해제로 취소된다). 셔터 순간의 값으로 찍고, 이미 보이는 결과 사진은 다시 만들지 않는다.
 */
function applyCameraSettings(settings) {
  const changed = cameraFrame.setSettings(settings);
  if (changed.geometry) presence.setCameraGeometry(cameraGeometryKey(settings));
  camera.setRequest(cameraRequestFor(settings));
  if (!devInfo.hidden) renderDevInfo();
  return changed;
}

/**
 * 시간 설정을 바꾼다 (시작할 때 불러온 값, E 시간 섹션). 카운트다운·결과·쿨타임은 다음 회차부터(진행 중인 회차는 시작할 때의 값으로 끝까지),
 * 인식 반응은 감지 루프에 바로 넣어 인식을 처음부터 다시 잰다(값이 바뀐 경우), 카메라 회복은 카메라 감시·관람객 안내가 다음에 읽을 때부터.
 */
function applyTimingSettings(settings) {
  timingNow = settings;
  session.setTiming(flowTiming(settings));
  presence.setSettings(presenceSettingsFor());
  renderStatus(); // 직원 문의 전환 시간
  if (!devInfo.hidden) renderDevInfo();
}

// 인식 섹션(presence-tuning.js)에 넘기는 감지 루프: 판정값을 받아 시간 섹션의 반응 시간과 합쳐 넣는다
const presenceSectionMonitor = {
  setSettings(criteria) {
    presenceCriteria = criteria;
    presence.setSettings(presenceSettingsFor());
  },
  getDebugSnapshot: () => presence.getDebugSnapshot(),
};

// 촬영 결과에도 같은 효과: 셔터 순간 화면의 그림과 같은 프레임·seed로 결과 크기(짧은 변 1080)에 다시 그린다.
// 화면 필터가 켜지면 화면과 같은 엔진·수치로 카메라 층만 칠한다(사용자 확정 2026-11-09). 효과를 그리지 못하면 원본 사진으로 대신한다 (photo-effect.js)
const photoEffect = createPhotoEffect({ preview: createPhotoSource({ effect, getCompositor: () => screenCompositor }) });

const capture = createCapture({
  video, frame: cameraFrame, ...config.capture, getFrameInfo: camera.getFrameInfo,
  effect: photoEffect.apply,
});

// 촬영 한 사이클. 시작·취소·초기화는 session.request() 한 곳으로 들어간다 (키보드와 auto-start.js).
// 카운트다운·결과·쿨타임은 시간 설정(setTiming, 회차가 시작될 때의 값을 그 회차 끝까지), 나머지는 config.session
const flowTiming = (t) => ({ countdownSeconds: t.countdownSeconds, resultMs: t.resultMs, cooldownMs: t.cooldownMs });
const session = createSession({
  timing: { ...config.session, ...flowTiming(timingNow) },
  takePhoto: capture.take,
  releasePhoto: capture.release,
  cameraReady: camera.isReady(),
  pageVisible: !document.hidden,
});

// 조절값 파일 (서버 config/presence.local.json). 불러오기가 끝나면 조절 화면을 만들고 그 값을 감지 루프에 넣는다.
// 그 전까지 감지 루프는 config.presence 기본값으로 돌지만, 자동 시작은 막는다(기본값으로 잠깐 판정해 시작하지 않게).
const settingsFile = createSettingsFileClient(config.settingsFile);
let tuning = null; // 인식 섹션. 불러오기가 끝나면 만든다
// 시작할 때 인식 로더·시간 로더가 인식 파일에서 본 9단계까지의 시간 키 (null 없음, undefined 모름). 인식 섹션을 저장할 때는
// 저장 직전에 인식 파일을 다시 읽어 옛 키를 붙이고(presenceTextForSave), 다시 읽기가 실패할 때만 이 값을 쓴다
let presenceLegacyTiming;
let timingLegacyTiming;
const knownLegacyTiming = () => presenceLegacyTiming ?? timingLegacyTiming
  ?? (presenceLegacyTiming === null || timingLegacyTiming === null ? null : undefined);
// 시간 설정 파일 (서버 config/timing.local.json, 10단계). 없으면 인식 파일의 옛 시간 키를 옮긴다
const timingSettingsFile = createSettingsFileClient(config.timingSettingsFile);
let timingTuning = null; // 시간 섹션. 불러오기가 끝나면 만든다
// 인식 판정값과 시간 설정을 모두 불러와야 자동 시작한다 (기본값으로 잠깐 판정하거나, 기본 카운트다운으로 시작하지 않게)
let presenceLoaded = false;
let timingLoaded = false;
let filterLoaded = false;
const settingsReady = () => presenceLoaded && timingLoaded && filterLoaded;
// 효과 조절값 파일 (서버 config/effect.local.json). 불러오기 전에는 config.effect 기본값으로 그린다 (필터와 수치를 함께 복원할 때까지 새 촬영은 대기)
const effectSettingsFile = createSettingsFileClient(config.effectSettingsFile);
// 카메라 조절값 파일 (서버 config/camera.local.json, 9-1). 카메라를 열기 전에 읽는다
const cameraSettingsFile = createSettingsFileClient(config.cameraSettingsFile);
let filterUpdates = null;
let effectTuning = null; // 필터 섹션. 불러오기가 끝나면 만든다
let cameraTuning = null; // 카메라 섹션. 불러오기가 끝나면 만든다
// 운영자 조절 화면 (9-2, E): 섹션 넷(10단계에 시간). 섹션 모듈은 각 조절값을 불러온 뒤 붙는다(다 붙어야 열린다)
const operatorPanel = createOperatorPanel({
  root: document.getElementById('operator-panel'),
  onOpenChange: handlePanelOpenChange,
  onSectionChange: handlePanelSectionChange,
});
// 자동 촬영 일시정지 (P). 저장하지 않는다: 새로고침·재시작하면 다시 켜진다(운영자가 해제를 잊어도 회복되게).
let autoPaused = false;

// 인식 상태로 자동 시작하고, 인식으로 시작한 카운트다운은 대상이 떠나면 취소한다.
// 조절 화면이 열려 있거나, 일시정지 중이거나, 조절값을 아직 불러오지 않았으면 자동 시작을 막는다.
const autoStart = createAutoStart({
  session, presence,
  // 운영자 조절 화면(E, 어느 섹션이든)이 열려 있으면 막는다. 조절하는 운영자가 화면 앞에 서서 보므로,
  // 자동 회차가 끼어들면 결과 사진이 미리보기를 가린다.
  isTuningOpen: () => operatorPanel.isOpen(),
  isPaused: () => autoPaused,
  isSettingsReady: settingsReady,
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
    staffAfterMs: timingNow.cameraRecovery.staffNoticeMs,
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

// 조절 화면을 닫으면 그 시점의 인식 상태로 자동 시작을 다시 판단한다 (어느 섹션이든 열려 있는 동안은 막는다).
function handlePanelOpenChange(open) {
  updateOverlay();
  updateRawWindow();
  if (!open) autoStart.evaluate('panel-closed');
  if (!devInfo.hidden) renderDevInfo();
}

function handlePanelSectionChange() {
  updateOverlay();
  updateRawWindow();
}

// 섹션 모듈이 닫혔다고 알리면(저장 중 닫기가 끝난 경우 포함) 패널이 다 닫혔는지 본다
const handleSectionOpenChange = (open) => {
  if (!open) operatorPanel.sectionClosed();
};

// 인식 섹션이 보이는지 (영역 편집 층·얼굴 크기 가이드)
const isPresenceSectionShown = () => showsPresenceEditing(panelView());

// 카운트다운·플래시·결과 사진은 guest-screen이 보인다. 결과가 끝나면 그 안에서 <img>의 src를 먼저 지우고,
// 그 뒤 session이 Object URL을 정리한다 (같은 알림 안에서 동기로).
function renderSession(s) {
  // 결과 사진은 Blob 경로로 따로 만들어지고, 화면 합성은 셔터 순간 카메라 층을 그 회차 동안 멈춰 보인다 (표시 전용)
  screenCompositor.setFreeze(s.state === SessionState.CAPTURING || s.state === SessionState.RESULT);
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
  document.documentElement.style.setProperty('--frame-top-frac', String(config.photoFrame.top));
  document.documentElement.style.setProperty('--frame-height-frac', String(config.photoFrame.height));
  document.documentElement.style.setProperty('--frame-left-frac', String(config.photoFrame.left ?? 0));
  document.documentElement.style.setProperty('--frame-width-frac', String(config.photoFrame.width ?? 1));
  scaleSnowCarve();
  updateOperatorRoom();
}

// 눈 바닥 글씨 필터(15단계, index.html #snow-carve)의 길이 값은 1080 폭 기준이다. 4K 등 다른 화면 폭에서도 홈 모양이 같게 곱한다
function scaleSnowCarve() {
  const k = stage.getBoundingClientRect().width / 1080;
  if (!(k > 0)) return;
  for (const el of document.querySelectorAll('.snow-carve-defs [data-base]')) {
    el.setAttribute(el.localName === 'feMorphology' ? 'radius' : 'stdDeviation', String(Number(el.dataset.base) * k));
  }
  for (const el of document.querySelectorAll('.snow-carve-defs [data-base-scale]')) {
    el.setAttribute('surfaceScale', String(Number(el.dataset.baseScale) * k));
  }
}

// 운영자 패널(E)을 9:16 영역 옆 빈 곳에 세울 공간이 실제로 있는지 (6단계 검수 2). 화면 비율만 보면 좁은 가로 창
// (예: 1200×1080)에서 패널이 영상을 가린다. 옆 빈 폭에 패널 최소 폭(24em)과 여백(2em)이 들어갈 때만 옆으로 세운다
// (style.css의 .op-side-room). 1080×1920·2160×3840(세로)은 공간이 없어 아래·위, 1920×1080은 옆이다.
const OPERATOR_PANEL_ROOM_EM = 26;

function updateOperatorRoom() {
  const side = (window.innerWidth - stage.getBoundingClientRect().width) / 2;
  const em = parseFloat(getComputedStyle(document.getElementById('operator-panel')).fontSize);
  document.documentElement.classList.toggle('op-side-room', side >= OPERATOR_PANEL_ROOM_EM * em);
}

// ---- 개발용 정보 (D 키 토글, 기본 숨김) ----

function describeCameraSource() {
  const { source, note, issues } = cameraSettingsInfo;
  return `${source}${note && note !== 'no file' ? ` (${note})` : source === 'defaults' ? ' (no file)' : ''}`
    + `${issues.length ? `, adjusted: ${issues.join('; ')}` : ''}`;
}

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
  const cam = cameraFrame.getSettings();
  const view = cameraFrame.getView(video.videoWidth, video.videoHeight);
  const request = camera.getRequest();
  const caps = state.capabilities;
  const range = (r) => (r ? `${r.min}-${r.max}` : '-');
  const raw = rawPreview.getStats();
  const cameraLines = [
    `status     : ${state.status}${state.connecting ? ' (connecting)' : ''}`,
    `reason     : ${state.reason || '-'}${state.errorName ? ` / ${state.errorName}` : ''}`,
    `attempts   : ${state.attempts} total, ${state.failures} failed since ready, last ${formatTime(state.lastAttemptAt)}`,
    `not ready  : ${notReadyFor}`,
    `permission : ${state.permission}`,
    `camera     : ${ready ? state.label || '(no label)' : '-'}`,
    `selected   : ${ready ? state.selection : '-'} (device "${request.deviceLabel || '(auto)'}", preferred "${config.preferredCameraLabel}"`
      + `${ready && state.selection === 'default' ? ' not found -> default camera' : ''})`,
    `video      : ${video.videoWidth}x${video.videoHeight}`,
    `track      : ${settings.width ?? '-'}x${settings.height ?? '-'} @ ${settings.frameRate ? settings.frameRate.toFixed(1) : '-'}fps`
      + ` (ideal ${request.idealResolution?.width ?? '-'}x${request.idealResolution?.height ?? '-'}, resolution ${cam.resolution})`,
    `caps       : ${caps ? `width ${range(caps.width)}, height ${range(caps.height)}, fps ${range(caps.frameRate)}` : '-'}`,
    `stage 9:16 : ${Math.round(rect.width)}x${Math.round(rect.height)} css px`
      + ` (${Math.round(rect.width * dpr)}x${Math.round(rect.height * dpr)} device px, dpr ${dpr})`,
    `viewport   : ${window.innerWidth}x${window.innerHeight}`,
    `mirror     : ${isMirrored() ? 'on' : 'off'} (camera settings)`,
    `transform  : rotate ${cam.rotation}${cam.rotationFine ? `${cam.rotationFine > 0 ? '+' : ''}${cam.rotationFine}` : ''}deg,`
      + ` zoom ${cam.zoom}${view ? ` (used ${view.zoom.toFixed(3)}${view.autoZoom ? ' auto' : ''})` : ''},`
      + ` pan ${cam.panX},${cam.panY}${view ? `, source ${Math.round(view.visibleWidthPx)}x${Math.round(view.visibleHeightPx)}px` : ''}`,
    `color      : brightness ${cam.brightness} contrast ${cam.contrast} saturation ${cam.saturation} gamma ${cam.gamma}`
      + ` temperature ${cam.temperature} tint ${cam.tint}${cameraFrame.getColor().identity ? ' (neutral)' : ''}`,
    `raw-view   : ${raw.active ? (raw.shown ? `shown ${raw.width}x${raw.height}` : 'waiting camera') : 'off (effect running)'}, draws ${raw.draws}`,
    `camera-cfg : ${cameraTuning ? cameraTuning.describeSettingsSource() : describeCameraSource()} (${config.cameraSettingsFile.url})`,
    `raw-window : ${rawWindow.hidden ? 'off' : `shown ${rawWindowCanvas.width}x${rawWindowCanvas.height}, draws ${rawWindowPreview.getStats().draws}`}`
      + ` (max ${RAW_WINDOW_FPS}fps)`,
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
    `criteria   : region x${region.x} y${+region.y.toFixed(4)} w${region.width} h${+region.height.toFixed(4)}`
      + `${presenceRegionClipped ? ' (clipped to photo frame)' : ''},`
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
  // 시험 조합 (WISHFUL 시안): 유화를 끈 그림이면 모드 뒤에 [no oil]
  const mode = `${p.last?.mode && p.last.mode !== 'off' ? `${p.last.mode} ` : ''}${p.last?.oil === false ? '[no oil] ' : ''}`;
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
  // 사진 틀 (IMPRINT 시안): 화면용 사진은 위 그림(9:16)을 틀 줄로 자른 것, 인쇄 데이터는 그 사진 + 머리·꼬리 글자 한 장
  const photoLine = `photo-fx   : ${photo}${p.last?.frame ? `, frame ${p.last.frame}` : ''} (applied ${p.applied}, raw ${p.fellBack})`;
  const pr = p.last?.print;
  const layout = pr?.layout === 'imprint'
    ? ` (imprint: photo ${pr.photoWidth}x${pr.photoHeight} at row ${pr.photoTop} col ${pr.photoLeft}${pr.fontsReady === false ? ', FONTS NOT LOADED (system font)' : ''})`
    : pr ? ` (photo only${pr.imprintError ? `, imprint failed: ${pr.imprintError}` : ''})` : '';
  const printLine = `print      : ${pr
    ? `${pr.width}x${pr.height} 1-bit${layout}, raster ${pr.bytesPerRow}B/row ${pr.rasterBytes}B, png ${pr.pngBytes}B`
      + ` (IHDR depth ${pr.pngBitDepth} color ${pr.pngColorType}), black ${(pr.blackRatio * 100).toFixed(1)}%`
      + `${p.last.printFallback ? `, from photo on CPU (GPU print failed: ${p.last.printFallback})` : ''}`
    : p.last?.printError ? `none (${p.last.printError})` : '-'}`;
  if (e.status === EffectStatus.DISABLED) return ['effect     : disabled (config.effect.enabled) -> camera preview', screenLine(), photoLine, printLine];
  if (e.status === EffectStatus.FALLBACK || e.status === EffectStatus.CONTEXT_LOST) {
    return [`effect     : ${e.status} (${e.fault || '-'}) -> camera preview${losses}`, values, screenLine(), photoLine, printLine];
  }
  return [
    `effect     : ${e.status}${e.shown ? '' : ' (hidden)'}, ${e.width}x${e.height} (preview x${e.previewScale}, px scale ${e.pxScale.toFixed(3)}),`
      + ` fps ${e.fps} -> ${e.drawingsPerSecond} drawings/s, boil ${e.boil}, seed ${e.seed ?? '-'}${losses}`,
    `  time     : cpu ${ms(e.cpuMs)} (avg ${ms(e.cpuAvgMs)}), gpu ${e.gpuTimer ? ms(e.gpuMs) : 'n/a'},`
      + ` strokes ${e.strokes}, ${e.renderer || '-'}, result ${prepare}`,
    `  output   : ${output}`,
    `  combo    : ${describeCombo(effect.getSettings())}`,
    values,
    screenLine(),
    photoLine,
    printLine,
  ];
}

// 최종 화면 필터 (17단계): 상태·처리 크기·속도
function screenLine() {
  const s = screenCompositor.getState();
  return `screen     : ${s.state}${s.reason ? ` (${s.reason})` : ''}, ${s.width}x${s.height}, fps ${s.fps} -> ${s.drawingsPerSecond} drawings/s, frame ${s.frameAvgMs === null ? '-' : s.frameAvgMs.toFixed(1)}ms, strokes ${s.strokes}, filter ${s.bundle || '-'}${s.frozen ? ', frozen' : ''}`;
}

// 시험 조합 (WISHFUL 시안): 유화·흑백 켬/끔, 흑백 방식, 인쇄 데이터를 만드는지 (회색조 유화·감열지만 만든다)
function describeCombo(settings) {
  const { oil, mono } = effectCombo(settings);
  const print = settings.outputMode === 'gray-oil' || settings.outputMode === 'thermal';
  return `oil ${oil ? 'on' : 'off'}, mono ${mono ? `on (${settings.outputMode})` : `off (color, mono mode ${settings.monoMode})`},`
    + ` print data ${print ? 'yes' : `no (${mono ? 'gray makes none' : 'color is a screen test'})`}`;
}

function describeAuto(record) {
  return record ? `${formatTime(record.at)} (${record.trigger})` : '-';
}

// 시간 설정 (10단계): 다음 회차 값, 진행 중인 회차가 다른 값이면 그 값, 반응·회복 시간, 출처
function describeTiming() {
  const t = timingNow;
  const sec = (ms) => `${ms / 1000}s`;
  const s = session.getState();
  const round = s.state !== SessionState.IDLE && s.countdownSeconds !== t.countdownSeconds ? ` (this round countdown ${s.countdownSeconds}s)` : '';
  const r = t.cameraRecovery;
  return `countdown ${t.countdownSeconds}s result ${sec(t.resultMs)} cooldown ${sec(t.cooldownMs)}${round},`
    + ` hold ${t.presentHoldMs}ms grace ${t.absentGraceMs}ms, recovery retry ${sec(r.retryIntervalMs)} first ${sec(r.firstFrameTimeoutMs)}`
    + ` stall ${sec(r.stallTimeoutMs)} staff ${sec(r.staffNoticeMs)}`
    + ` (${timingTuning ? timingTuning.describeSettingsSource() : 'loading'}, ${config.timingSettingsFile.url})`;
}

// 사진 틀 (IMPRINT에서 도입, 16단계부터 사방 inset 3:4): 화면 비율의 열·줄, 결과 1080x1920·인쇄 격자 576x1024에서의 직사각형
function describePhotoFrame() {
  const f = config.photoFrame;
  const aspect = photoFrameAspect(stageAspect, f);
  const named = { 0.75: '3:4', 0.8: '4:5' }[aspect.toFixed(4).replace(/0+$/, '')] ?? aspect.toFixed(3);
  const rect = (r) => `${r.width}x${r.height}@${r.left},${r.top}`;
  const left = f.left ?? 0;
  const width = f.width ?? 1;
  return `photo ${named} = stage cols ${+left.toFixed(4)}-${+(left + width).toFixed(4)} rows ${+f.top.toFixed(4)}-${+(f.top + f.height).toFixed(4)}`
    + ` (result 1080x1920 -> ${rect(photoFrameRect(1080, 1920, f))}, print 576x1024 -> ${rect(photoFrameRect(576, 1024, f))}),`
    + ` presence region ${presenceRegionClipped ? 'clipped to frame' : 'inside frame'}, scene ${sceneInfo}`;
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
    `timing     : ${describeTiming()}`,
    `frame      : ${describePhotoFrame()}`,
    last
      ? `capture    : ${last.width}x${last.height} from video ${last.source}`
        + ` (rotate ${last.view.rotation} zoom ${last.view.zoom.toFixed(2)}${last.view.autoZoom ? ' auto' : ''}`
        + `${last.view.color ? ', color' : ''}${last.mirror ? ', mirrored' : ''}), ${last.type} ${Math.round(last.bytes / 1024)}KB,`
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
  frame: '#d6c08a', // 사진 틀 (IMPRINT 시안: 실제로 찍히는 줄. 인식 영역은 이 안으로 줄여 판정한다)
  outline: 'rgba(16, 16, 16, 0.85)',
});

// 감지 박스와 인식 영역을 9:16 화면 크기(width × height) 캔버스에 겹쳐 그린다. 인정된 얼굴은 초록, 제외된 얼굴은 빨강.
// 판정 좌표가 이미 관람객 화면 기준(카메라 처리 경로를 거친 감지 입력)이므로 그대로 그린다 — 원본 창에도 같다.
// guides: 인식 섹션이 보이면 영역은 편집 사각형이 대신 보이고 얼굴 크기 기준 가이드를 영역 가운데에 그린다
function drawPresenceOverlay(ctx, width, height, { guides, scores = true }) {
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
  // 사진 틀 직사각형 (16단계 사방). 감지 박스와 같은 화면 좌표라 원본 창에도 같은 자리
  ctx.setLineDash([line * 1.5, line * 2.5]);
  const fr = photoFrameRect(width, height, config.photoFrame);
  strokeBox(fr.left, fr.top, fr.width, fr.height, OVERLAY.frame);
  ctx.setLineDash([line * 4, line * 3]);
  if (guides) {
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
    if (!scores) continue;
    const ty = Math.max(y - line * 3, width * 0.03);
    ctx.lineWidth = line * 2;
    ctx.strokeStyle = OVERLAY.outline;
    ctx.strokeText(face.score.toFixed(2), x, ty);
    ctx.fillText(face.score.toFixed(2), x, ty);
  }
}

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
  drawPresenceOverlay(ctx, width, height, { guides: isPresenceSectionShown() });
}

// 겹쳐 그리기는 D 화면이 켜져 있거나 운영자 화면의 인식 섹션이 보일 때만 그린다. 둘 다 아니면 흔적 없이 지운다.
function updateOverlay() {
  const visible = !devInfo.hidden || isPresenceSectionShown();
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

// 카메라 설정 (9-1): 파일 → (없으면) 효과 파일의 좌우 반전을 옮김 → 기본값. 카메라를 열기 전에 읽는다(장치·해상도 요청이 이 값이라
// 기본 장치로 먼저 열었다가 다시 여는 일이 없게). 실패하거나 시간 초과(3초)면 기본값으로 연다.
async function loadCameraSettings() {
  try {
    const initial = await loadInitialCameraSettings({ file: cameraSettingsFile, effectFile: effectSettingsFile, defaults: config.camera });
    if (initial.note && initial.note !== 'no file') console.warn('[camera-settings]', `${initial.source}: ${initial.note}`);
    if (initial.issues.length) console.warn('[camera-settings]', `adjusted: ${initial.issues.join('; ')}`);
    cameraSettingsInfo = { source: initial.source, note: initial.note, issues: initial.issues };
    applyCameraSettings(initial.settings);
    cameraTuning = createCameraTuning({
      panel: document.getElementById('camera-panel'),
      camera,
      frame: cameraFrame,
      video,
      defaults: config.camera,
      initial,
      applySettings: applyCameraSettings,
      saveSettings: (settings) => cameraSettingsFile.write(serializeCameraSettings(settings)),
      onOpenChange: handleSectionOpenChange,
    });
    operatorPanel.attach(PanelSection.CAMERA, cameraTuning);
  } catch (error) {
    console.error('[camera-settings] setup failed; continuing with defaults', error);
    cameraSettingsInfo = { source: 'defaults', note: `setup failed: ${error?.message ?? error}`, issues: [] };
  }
  camera.start();
}

// 시작할 때 조절값: 파일 → (없으면) localStorage에서 옮김 → 기본값. 실패하거나 시간 초과면 기본값 (settings-file.js).
async function loadSettings() {
  try {
    const initial = await loadInitialPresenceSettings({ file: settingsFile, storage: getStorage(), defaults: config.presence });
    if (initial.note && initial.note !== 'no file') console.warn('[settings]', `${initial.source}: ${initial.note}`);
    presenceLegacyTiming = initial.legacyTiming;
    tuning = createPresenceTuning({
      stage,
      panel: document.getElementById('tuning-panel'),
      layer: document.getElementById('tuning-layer'),
      monitor: presenceSectionMonitor,
      defaults: config.presence,
      initial,
      // 시간 값이 아직 시간 파일에 확인되지 않았으면(옮기기 실패·시간 파일 읽기 실패) 인식 파일의 옛 시간 키를 그대로 남긴다 (10단계 검수 1)
      saveSettings: async (settings) => settingsFile.write(await presenceTextForSave({
        text: serializePresenceSettings(settings),
        timingStored: timingTuning?.isStoredInFile() ?? false,
        presenceFile: settingsFile,
        knownLegacy: knownLegacyTiming(),
      })),
      onOpenChange: handleSectionOpenChange,
    });
    operatorPanel.attach(PanelSection.PRESENCE, tuning);
  } catch (error) {
    // 여기까지 오면 코드 오류다. 자동 촬영이 영영 막히지 않게 기본값으로 계속한다.
    console.error('[settings] setup failed; continuing with defaults', error);
  }
  presenceLoaded = true;
  settingsLoaded();
}

// 인식 판정값·시간 설정을 모두 불러오면 자동 시작을 다시 판단한다
function settingsLoaded() {
  if (settingsReady()) autoStart.evaluate('settings-loaded');
  if (!devInfo.hidden) renderDevInfo();
}

// 시간 설정: 파일 → (없으면) 인식 파일의 옛 시간 키를 옮김 → 기본값 (settings-file.js). 끝나면 시간 섹션을 만들고 그 값을 넣는다.
async function loadTimingSettings() {
  try {
    const initial = await loadInitialTimingSettings({ file: timingSettingsFile, presenceFile: settingsFile, defaults: config.timing });
    timingLegacyTiming = initial.legacyTiming;
    if (initial.note && initial.note !== 'no file') console.warn('[timing-settings]', `${initial.source}: ${initial.note}`);
    timingTuning = createTimingTuning({
      panel: document.getElementById('timing-panel'),
      session,
      defaults: config.timing,
      initial,
      applySettings: applyTimingSettings,
      saveSettings: (settings) => timingSettingsFile.write(serializeTimingSettings(settings)),
      onOpenChange: handleSectionOpenChange,
    });
    operatorPanel.attach(PanelSection.TIMING, timingTuning);
  } catch (error) {
    console.error('[timing-settings] setup failed; continuing with defaults', error);
  }
  timingLoaded = true;
  settingsLoaded();
}

// 효과 조절값: 파일 → 기본값 (settings-file.js). 끝나면 조절 화면을 만들고 그 값을 미리보기에 넣는다.
async function loadEffectSettings() {
  try {
    let initial = await loadInitialEffectSettings({ file: effectSettingsFile, defaults: config.effect });
    if (initial.note && initial.note !== 'no file') console.warn('[effect-settings]', `${initial.source}: ${initial.note}`);
    const canChange = () => session.getState().state === SessionState.IDLE;
    const updates = await createFilterUpdates({preview:effect,defaults:config.effect,initial,canChange});
    filterUpdates=updates;
    initial=updates.initial;
    effectTuning = createEffectTuning({
      updates, canChange,
      panel: document.getElementById('effect-panel'),
      preview: effect,
      defaults: config.effect,
      initial,
      saveSettings: async (settings) => {
        if(!await updates.save(settings))await effectSettingsFile.write(serializeEffectSettings(settings));
        updates.remember(settings);
      },
      onOpenChange: handleSectionOpenChange,
    });
    operatorPanel.attach(PanelSection.EFFECT, effectTuning);
  } catch (error) {
    console.error('[effect-settings] setup failed; continuing with defaults', error);
  }
  filterLoaded=true;
  settingsLoaded();
}

// 화면 필터 조절값 (17단계): 기본 제공판을 대체 번들로 두고 파일 → 받은 기본값. 실패해도 나머지 앱은 그대로 돈다(화면 섹션은 안내만)
const screenSettingsFile = createSettingsFileClient(config.screenSettingsFile);
async function loadScreenSettings() {
  try {
    const response = await fetch('/config/filter-builtin.json', { cache: 'no-store', signal: AbortSignal.timeout(3000) });
    const builtin = validateBundle(await response.json());
    screenCompositor.setFallbackBundle(builtin);
    const getBundle = () => effect.getBundle() ?? builtin;
    const initial = await loadInitialScreenSettings({ file: screenSettingsFile, bundle: getBundle() });
    if (initial.note && initial.note !== 'no file') console.warn('[screen-settings]', `${initial.source}: ${initial.note}`);
    operatorPanel.attach(PanelSection.SCREEN, createScreenTuning({
      panel: document.getElementById('screen-panel'), compositor: screenCompositor, getBundle, initial,
      applySettings: (settings) => screenCompositor.setSettings(settings),
      saveSettings: (settings) => screenSettingsFile.write(serializeScreenSettings(settings)),
      onOpenChange: handleSectionOpenChange,
    }));
  } catch (error) {
    console.error('[screen-settings] setup failed; screen filter stays off', error);
    operatorPanel.attach(PanelSection.SCREEN, { open() {}, close() {}, isOpen: () => false, setActive() {}, isDirty: () => false, discardUnsaved() {} });
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
  else if (event.code === Keys.operatorPanel) operatorPanel.toggle();
  else if (event.code === Keys.start && filterLoaded && !filterUpdates?.getInfo().busy && !filterUpdates?.getInfo().trial) session.request('start', 'key');
  else if (event.code === Keys.reset) session.request('reset', 'key');
  else if (event.code === Keys.pause) togglePause();
  else if (event.code === 'Escape' && operatorPanel.isOpen()) operatorPanel.close();
});

applyLayout();
// 인쇄 쪽 글자(IMPRINT 시안, effect/imprint-page.js)는 캔버스에 그리므로 서체가 미리 불려 있어야 한다 (관람객 화면에는 아직 안 쓰인 크기도)
Promise.all(IMPRINT_FONT_LOADS.map(([font, sample]) => document.fonts.load(font, sample)))
  .catch((error) => console.warn('[imprint] print fonts not loaded; print type uses system fonts', error));
window.addEventListener('resize', () => { scaleSnowCarve(); updateOperatorRoom(); });
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
loadTimingSettings();
loadEffectSettings().then(loadScreenSettings);
loadCameraSettings(); // 읽은 뒤 camera.start()
presence.start();
effect.start();
screenCompositor.start();
updateRawPreview();
