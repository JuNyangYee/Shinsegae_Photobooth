// IMPRINT 시안 데모 (검토용, 관람객 화면 아님): 카메라 없이 시안의 흐름·모션·결과·인쇄 데이터를 본다.
// - 관람객 화면: 앱 index.html의 #stage 마크업을 그대로 불러오고(fetch '/'), 같은 style.css·ui/guest-screen.js·config/guest-text.js를 쓴다.
// - 영상: 합성 장면(scene.js, 도형)을 captureStream()으로 <video>에 넣어 실제 카메라 처리 경로(camera-frame.js)·회색조 유화 미리보기
//   (effect-preview.js)·촬영(capture.js)·결과 효과·사진 틀·인쇄 쪽(photo-effect.js)을 그대로 돌린다.
// - 흐름: 실제 상태 기계(core/session.js)와 자동 시작 판정(core/auto-start.js). 다른 점은 "인식됨"이 감지기 대신 검토 조작이라는 것뿐이다.
// - 안내 상태(준비 중·직원 문의)와 "인쇄 연동 뒤 흐름"은 화면 흉내다(카메라 장애·프린터가 없다).
// 조절값 파일(config/*.local.json)을 읽거나 쓰지 않고 기본값으로 돈다. 사진·인쇄 데이터는 메모리에만 두고 회차가 끝나면 놓는다.

import { config } from '../config/config.js';
import { guestText } from '../config/guest-text.js';
import { normalizeCameraSettings } from '../config/camera-settings.js';
import { createCameraFrame } from '../camera/camera-frame.js';
import { createCapture } from '../camera/capture.js';
import { createRawPreview } from '../camera/raw-preview.js';
import { createAutoStart } from '../core/auto-start.js';
import { Guidance } from '../core/guidance.js';
import { SessionState, createSession } from '../core/session.js';
import { EffectStatus, createEffectPreview } from '../effect/effect-preview.js';
import { IMPRINT_FONTS } from '../effect/imprint-page.js';
import { createPhotoEffect } from '../effect/photo-effect.js';
import { createGuestScreen } from '../ui/guest-screen.js';
import { createScene } from './scene.js';

const AUTOPLAY = Object.freeze({ firstArriveMs: 2200, idleMs: 3800, leaveAfterCooldownMs: 1600 });
const PRINT_FLOW_MS = 2500; // "인쇄 연동 뒤 흐름" 흉내: 결과 처음 이만큼 출력 중
const rootEl = document.documentElement;
const stageAspect = config.aspectRatio.width / config.aspectRatio.height;

// ---- 관람객 화면 마크업: 앱과 같은 것을 불러온다 ----
const html = await (await fetch('/', { cache: 'no-store' })).text();
const stage = document.importNode(new DOMParser().parseFromString(html, 'text/html').getElementById('stage'), true);
document.getElementById('stage-slot').replaceWith(stage);
rootEl.style.setProperty('--stage-ratio-w', String(config.aspectRatio.width));
rootEl.style.setProperty('--stage-ratio-h', String(config.aspectRatio.height));
rootEl.style.setProperty('--frame-top-frac', String(config.photoFrame.top));
rootEl.style.setProperty('--frame-height-frac', String(config.photoFrame.height));
const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let forceReduced = false;
const applyMotion = () => { rootEl.dataset.motion = forceReduced || systemReduced.matches ? 'reduce' : 'full'; };
applyMotion();
systemReduced.addEventListener('change', applyMotion);
await Promise.all([IMPRINT_FONTS.sans(22), IMPRINT_FONTS.serif(30)].map((font) => document.fonts.load(font, '0123456789.:AMSTUWDHNOEFRI'))).catch(() => {});

// 검토용 패널 (관람객 화면 밖)
const panel = document.querySelector('.demo-panel');
const stateText = panel.querySelector('[data-demo-state]');
const printImage = document.getElementById('demo-print-image');
const printCaption = panel.querySelector('[data-demo-print]');
let printUrl = null;

// ---- 합성 영상 → 카메라 처리 경로 ----
const video = document.getElementById('preview');
const scene = createScene();
scene.start();
video.srcObject = scene.canvas.captureStream(30);
video.muted = true;
await video.play().catch(() => {});
let guidance = Guidance.NONE; // 안내 상태 흉내 (정상이 아니면 카메라 준비 해제처럼)
const frameInfo = { at: null, count: 0 };
const onFrame = () => { frameInfo.at = performance.now(); frameInfo.count += 1; video.requestVideoFrameCallback(onFrame); };
video.requestVideoFrameCallback(onFrame);
const camera = {
  isReady: () => video.readyState >= 2 && video.videoWidth > 0 && guidance === Guidance.NONE,
  getFrameInfo: () => frameInfo,
};

const cameraFrame = createCameraFrame({ doc: document, stageAspect, settings: normalizeCameraSettings(config.camera, config.camera).settings });
let rawPreview = null;
const effect = createEffectPreview({
  canvas: document.getElementById('effect'), video, camera, stageAspect, settings: config.effect, cameraFrame,
  onChange: () => rawPreview?.setActive(effect.getState().status !== EffectStatus.RUNNING),
});
const rawCanvas = document.getElementById('camera-raw');
rawPreview = createRawPreview({
  canvas: rawCanvas, video, camera, frame: cameraFrame,
  getSize: () => ({ width: 540, height: 960 }),
});
const photoEffect = createPhotoEffect({ preview: effect });
const capture = createCapture({ video, frame: cameraFrame, ...config.capture, getFrameInfo: camera.getFrameInfo, effect: photoEffect.apply });

// ---- 흐름: 실제 상태 기계와 자동 시작 판정, 인식은 검토 조작 ----
const t = config.timing;
const session = createSession({
  timing: { ...config.session, countdownSeconds: t.countdownSeconds, resultMs: t.resultMs, cooldownMs: t.cooldownMs },
  takePhoto: capture.take, releasePhoto: capture.release, cameraReady: camera.isReady(), pageVisible: !document.hidden,
});
let present = false;
const presenceListeners = new Set();
const presence = {
  isPresent: () => present,
  subscribe(listener) { presenceListeners.add(listener); return () => presenceListeners.delete(listener); },
};
const autoStart = createAutoStart({ session, presence, isTuningOpen: () => false, isPaused: () => false, isSettingsReady: () => true });

const guest = createGuestScreen({
  root: document, text: guestText, countdownSeconds: t.countdownSeconds, reducedMotion: () => rootEl.dataset.motion === 'reduce',
});

let printFlow = false;
let printFlowTimer = null;
let printFlowRound = null;
let autoplay = true;
let autoplayTimer = null;

const roundActive = (s) => [SessionState.COUNTDOWN, SessionState.CAPTURING, SessionState.RESULT].includes(s.state);

// "인쇄 연동 뒤 흐름" 흉내: 결과 처음 PRINT_FLOW_MS 동안 종료 시계가 멈춘 것처럼(endsAt null) 보인다. 상태 기계의 시계는 그대로 돈다
function shownSnapshot(s) {
  if (!printFlow || s.state !== SessionState.RESULT) return s;
  if (printFlowRound !== s.round) {
    printFlowRound = s.round;
    clearTimeout(printFlowTimer);
    printFlowTimer = setTimeout(() => { printFlowTimer = null; render(session.getState()); }, PRINT_FLOW_MS);
  }
  return printFlowTimer !== null ? { ...s, endsAt: null } : s;
}

function render(s) {
  guest.renderSession(shownSnapshot(s));
  const normal = guidance === Guidance.NONE;
  guest.setStatus({ message: normal ? '' : guestText[guidance], kind: guidance, visible: !normal && !roundActive(s) });
  guest.setNotice(s.state === SessionState.COOLDOWN && normal);
  const showingPhoto = s.state === SessionState.RESULT;
  guest.setPresence(normal && present && !showingPhoto);
  guest.setGuide(normal && !showingPhoto && s.state === SessionState.IDLE);
  renderPanel(s);
}

function setPresent(value) {
  if (present === value) return;
  present = value;
  scene.setPeople(value);
  presenceListeners.forEach((listener) => listener({ present }));
  render(session.getState());
}

// 사람 도형이 걸어 들어온 뒤 "인식됨" (실제 감지기의 인식까지 시간을 흉내 내지 않는다: 들어오는 1.2초가 그 자리)
function arrive() {
  scene.setPeople(true);
  clearTimeout(autoplayTimer);
  autoplayTimer = setTimeout(() => setPresent(true), 1100);
}

function leave() {
  clearTimeout(autoplayTimer);
  setPresent(false);
}

let lastState = SessionState.IDLE;
session.subscribe((s) => {
  render(s);
  if (s.state !== lastState && autoplay) {
    clearTimeout(autoplayTimer);
    if (s.state === SessionState.COOLDOWN) autoplayTimer = setTimeout(leave, AUTOPLAY.leaveAfterCooldownMs);
    if (s.state === SessionState.IDLE && !present) autoplayTimer = setTimeout(arrive, AUTOPLAY.idleMs);
  }
  if (s.state === SessionState.RESULT && s.photo && s.state !== lastState) showPrint(s.photo);
  lastState = s.state;
});
video.addEventListener('playing', () => { session.setCameraReady(camera.isReady()); render(session.getState()); });
document.addEventListener('visibilitychange', () => session.setPageVisible(!document.hidden));
autoStart.start();
effect.start();
rawPreview.setActive(true);
session.setCameraReady(camera.isReady());

// ---- 패널 ----

function showPrint(photo) {
  if (printUrl) URL.revokeObjectURL(printUrl);
  printUrl = null;
  const p = photo.print;
  if (!p?.png) {
    printImage.hidden = true;
    printCaption.textContent = '이 촬영에는 인쇄 데이터가 없다 (출력 모드 확인).';
    return;
  }
  printUrl = URL.createObjectURL(p.png);
  printImage.src = printUrl;
  printImage.hidden = false;
  printCaption.textContent = `실제로 만든 1비트 PNG ${p.width}×${p.height}점 (${(p.height / 8).toFixed(0)}mm) · 사진 ${p.width}×${p.photo.height}`
    + ` · ${p.layout === 'imprint' ? '머리·꼬리 글자 포함' : '사진만'}${p.fontsReady === false ? ' · 서체 미적재' : ''} · 합성 장면 · 프린터 미연동`;
}

function renderPanel(s) {
  const e = effect.getState();
  stateText.textContent = `${s.state}${s.state === SessionState.COUNTDOWN ? ` ${s.countdown}` : ''} · 회차 ${s.round} · 완료 ${s.completed}`
    + `\n사람 ${present ? '있음' : '없음'} · 효과 ${e.status}${e.status === EffectStatus.RUNNING ? ` ${e.width}×${e.height}` : ''}`;
  const pressed = (name, value) => panel.querySelectorAll(`[data-demo="${name}"]`).forEach((b) => b.setAttribute('aria-pressed', String(value(b))));
  pressed('autoplay', () => autoplay);
  pressed('presence', () => present);
  pressed('guidance', (b) => b.dataset.value === guidance);
  pressed('motion', () => rootEl.dataset.motion === 'reduce');
  pressed('print-flow', () => printFlow);
  panel.querySelector('[data-demo="presence"]').textContent = present ? '사람 나감' : '사람 들어옴';
}

panel.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-demo]');
  if (!button) return;
  const action = button.dataset.demo;
  if (action === 'autoplay') {
    autoplay = !autoplay;
    clearTimeout(autoplayTimer);
    if (autoplay && session.getState().state === SessionState.IDLE && !present) autoplayTimer = setTimeout(arrive, 600);
  } else if (action === 'presence') {
    autoplay = false;
    if (present) leave();
    else arrive();
  } else if (action === 'start') {
    session.request('start', 'key');
  } else if (action === 'reset') {
    session.request('reset', 'key');
  } else if (action === 'guidance') {
    guidance = button.dataset.value;
    session.setCameraReady(camera.isReady());
  } else if (action === 'motion') {
    forceReduced = !forceReduced;
    applyMotion();
  } else if (action === 'print-flow') {
    printFlow = !printFlow;
  }
  render(session.getState());
});

window.addEventListener('pagehide', () => {
  scene.stop();
  guest.dispose();
  if (printUrl) URL.revokeObjectURL(printUrl);
});

render(session.getState());
autoplayTimer = setTimeout(arrive, AUTOPLAY.firstArriveMs);
// 확인 도구가 데모가 준비됐는지 본다 (검토용 페이지에만 있는 표시, 앱에는 없다)
document.body.dataset.demoReady = 'true';
