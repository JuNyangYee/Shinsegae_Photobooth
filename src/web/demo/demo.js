// WISHFUL HOLIDAY 시안 데모 (검토용, 관람객 화면 아님, IMPRINT 데모를 이어받음): 카메라 없이 시안의 흐름·모션·결과·인쇄 데이터를 본다.
// - 필터 시험 조합: 운영자 E 필터 섹션과 같은 값(유화 켬/끔 × 흑백 켬/끔, 흑백 방식)을 효과 미리보기에 넣고, "4조합 비교 촬영"은
//   같은 합성 장면을 네 조합으로 실제 촬영 경로(capture.take → 결과 효과 → 사진 틀)에서 한 장씩 만들어 나란히 보인다(메모리만).
// - 관람객 화면: 앱 index.html의 #stage 마크업을 그대로 불러오고(fetch '/'), 같은 style.css·ui/guest-screen.js·config/guest-text.js를 쓴다.
// - 영상: 합성 장면(scene.js, 도형)을 captureStream()으로 <video>에 넣어 실제 카메라 처리 경로(camera-frame.js)·회색조 유화 미리보기
//   (effect-preview.js)·촬영(capture.js)·결과 효과·사진 틀·인쇄 쪽(photo-effect.js)을 그대로 돌린다.
// - 흐름: 실제 상태 기계(core/session.js)와 자동 시작 판정(core/auto-start.js). 다른 점은 "인식됨"이 감지기 대신 검토 조작이라는 것뿐이다.
// - 안내 상태(준비 중·직원 문의)와 "인쇄 연동 뒤 흐름"은 화면 흉내다(카메라 장애·프린터가 없다).
// 조절값 파일(config/*.local.json)을 읽거나 쓰지 않고 기본값으로 돈다. 사진·인쇄 데이터는 메모리에만 두고 회차가 끝나면 놓는다.

import { config } from '../config/config.js';
import { guestText } from '../config/guest-text.js';
import { normalizeCameraSettings } from '../config/camera-settings.js';
import { applyEffectTunables, comboTunables, effectCombo, normalizeEffectSettings } from '../config/effect-settings.js';
import { createCameraFrame } from '../camera/camera-frame.js';
import { createCapture } from '../camera/capture.js';
import { createRawPreview } from '../camera/raw-preview.js';
import { createAutoStart } from '../core/auto-start.js';
import { Guidance } from '../core/guidance.js';
import { SessionState, createSession } from '../core/session.js';
import { EffectStatus, createEffectPreview } from '../effect/effect-preview.js';
import { IMPRINT_FONT_LOADS } from '../effect/imprint-page.js';
import { createPhotoEffect } from '../effect/photo-effect.js';
import { createGuestScreen } from '../ui/guest-screen.js';
import { createScenePlate } from '../ui/scene-plate.js';
import { createScenePainter } from '../effect/scene-paint.js';
import { createScene } from './scene.js';

const AUTOPLAY = Object.freeze({ firstArriveMs: 2200, idleMs: 3800, leaveAfterCooldownMs: 1600 });
const PRINT_FLOW_MS = 2500; // "인쇄 연동 뒤 흐름" 흉내: 결과 처음 이만큼 출력 중
// 현장 저장값 대조본 (검토용): 현장 PC config/filter.local.json(revision 3)의 적용 수치를 2026-11-06에 부모 에이전트가 읽기 전용으로 확인해 전한 내용.
// 데모는 파일을 읽거나 쓰지 않는다 (예전 effect.local.json의 강도 0.05·붓 0.7·세부 0.09 대조본은 이것으로 바꿨다)
const SITE_EFFECT = Object.freeze({
  strength: 0.29, size: 1.23, boil: 0.02, fps: 15, grade: 1, refineThreshold: 0.1, previewScale: 1, outputMode: 'gray',
  dither: 'blue-noise', brightness: -0.03, contrast: 1.45, gamma: 0.85, paperDots: 576, bwStyle: 'stroke', bwTexture: 1, lineSpacing: 4,
});
const COMBOS = Object.freeze([[false, false], [false, true], [true, false], [true, true]]);
const comboName = (oil, mono) => `${oil ? '유화' : '원본'} · ${mono ? '흑백' : '컬러'}`;
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
rootEl.style.setProperty('--frame-left-frac', String(config.photoFrame.left ?? 0));
rootEl.style.setProperty('--frame-width-frac', String(config.photoFrame.width ?? 1));
const systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)');
let forceReduced = false;
const applyMotion = () => { rootEl.dataset.motion = forceReduced || systemReduced.matches ? 'reduce' : 'full'; };
applyMotion();
systemReduced.addEventListener('change', applyMotion);
await Promise.all(IMPRINT_FONT_LOADS.map(([font, sample]) => document.fonts.load(font, sample))).catch(() => {});

// 검토용 패널 (관람객 화면 밖)
const panel = document.querySelector('.demo-panel');
const stateText = panel.querySelector('[data-demo-state]');
const printImage = document.getElementById('demo-print-image');
const printCaption = panel.querySelector('[data-demo-print]');
const monoModeSelect = panel.querySelector('[data-demo="mono-mode"]');
const bwStyleSelect = panel.querySelector('[data-demo="bw-style"]');
const bwTextureSelect = panel.querySelector('[data-demo="bw-texture"]');
const compareBox = panel.querySelector('[data-demo-compare]');
let printUrl = null;
let preset = 'defaults'; // 세부 수치: 'defaults'(config.effect) | 'site'(현장 저장값 대조본)
let comparing = false;
let compareShots = []; // 4조합 비교 촬영 결과 (capture.take의 사진, 다음 비교·페이지를 떠날 때 놓는다)

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
  root: document, text: guestText, countdownSeconds: t.countdownSeconds, stageAspect, reducedMotion: () => rootEl.dataset.motion === 'reduce',
});
// 장면 (14단계): 앱과 같은 이미지·같은 창 키. 데모 페이지 기준 경로라 앱 루트로 바꿔 읽는다
createScenePlate({
  canvas: document.getElementById('scene-plate'), src: new URL(`../${config.scene.plate}`, import.meta.url).href,
  frame: config.photoFrame, key: config.scene.key, keyMarginFrac: config.scene.keyMarginFrac, layout: config.scene.layout,
  size: config.scene.size, paint: config.scene.paint ? createScenePainter() : null,
}).ready.then((r) => { if (!r.ok) console.warn(`[scene] ${r.error}`); });

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
  printCaption.textContent = `실제로 만든 1비트 PNG ${p.width}×${p.height}점 (${(p.height / 8).toFixed(0)}mm) · 사진 ${p.photo.width ?? p.width}×${p.photo.height}`
    + ` · ${p.layout === 'imprint' ? '머리·꼬리 글자 포함' : '사진만'}${p.fontsReady === false ? ' · 서체 미적재' : ''} · 합성 장면 · 프린터 미연동`;
}

function renderPanel(s) {
  const e = effect.getState();
  stateText.textContent = `${s.state}${s.state === SessionState.COUNTDOWN ? ` ${s.countdown}` : ''} · 회차 ${s.round} · 완료 ${s.completed}`
    + `\n사람 ${present ? '있음' : '없음'} · 효과 ${e.status}${e.status === EffectStatus.RUNNING ? ` ${e.width}×${e.height}` : ''}`;
  const fx = effect.getSettings();
  const combo = effectCombo(fx);
  stateText.textContent += `\n조합 ${comboName(combo.oil, combo.mono)} (출력 모드 ${fx.outputMode}, 흑백 방식 ${fx.monoMode}) · 세부 수치 ${preset === 'site' ? '현장 저장값' : '기본값'}`;
  monoModeSelect.value = fx.monoMode;
  bwStyleSelect.value = fx.bwStyle;
  bwTextureSelect.value = String(fx.bwTexture);
  const pressed = (name, value) => panel.querySelectorAll(`[data-demo="${name}"]`).forEach((b) => b.setAttribute('aria-pressed', String(value(b))));
  pressed('combo', (b) => b.dataset.oil === String(combo.oil) && b.dataset.mono === String(combo.mono));
  pressed('preset', (b) => b.dataset.value === preset);
  pressed('compare', () => comparing);
  pressed('autoplay', () => autoplay);
  pressed('presence', () => present);
  pressed('guidance', (b) => b.dataset.value === guidance);
  pressed('motion', () => rootEl.dataset.motion === 'reduce');
  pressed('print-flow', () => printFlow);
  panel.querySelector('[data-demo="presence"]').textContent = present ? '사람 나감' : '사람 들어옴';
}

// ---- 필터 시험 조합 (운영자 E 필터 섹션과 같은 계산: config/effect-settings.js comboTunables) ----

function setEffect(patch) {
  const now = effect.getSettings();
  effect.setSettings(applyEffectTunables(now, patch, config.effect).settings);
}

function applyPreset(value) {
  preset = value;
  const keep = effectCombo(effect.getSettings()); // 세부 수치만 바꾸고 지금 조합은 그대로
  const base = normalizeEffectSettings(config.effect, config.effect).settings;
  const next = value === 'site' ? applyEffectTunables(base, SITE_EFFECT, config.effect).settings : base;
  effect.setSettings(applyEffectTunables(next, comboTunables(next, keep), config.effect).settings);
}

function releaseCompare() {
  for (const shot of compareShots) capture.release(shot.photo);
  compareShots = [];
  compareBox.replaceChildren();
}

const nextFrames = (n) => new Promise((resolve) => {
  const step = (left) => (left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1)));
  step(n);
});

function renderCompare(error = '') {
  compareBox.replaceChildren(...compareShots.map(({ oil, mono, photo, stats }) => {
    const figure = document.createElement('figure');
    const img = document.createElement('img');
    img.src = photo.url;
    img.alt = `${comboName(oil, mono)} 결과 (합성 장면)`;
    const caption = document.createElement('figcaption');
    const name = document.createElement('b');
    name.textContent = comboName(oil, mono);
    const print = photo.print ? `인쇄 데이터 ${photo.print.width}×${photo.print.height} 1비트` : '인쇄 데이터 없음';
    caption.append(name, ` — ${stats?.mode ?? '?'}${stats?.oil === false ? ' · 유화 끔' : ''} · 결과 ${photo.width}×${photo.height}`
      + ` · ${stats?.sameAsPreview ? '셔터 순간 미리보기와 같은 그림' : '새 그림'} · ${print}`);
    figure.append(img, caption);
    return figure;
  }));
  if (error) {
    const p = document.createElement('p');
    p.className = 'demo-hint';
    p.textContent = `비교 촬영 실패: ${error}`;
    compareBox.append(p);
  }
}

// 같은 합성 장면을 네 조합으로 한 장씩: 조합을 넣고 미리보기가 그 조합으로 그린 뒤(화면 갱신 3번) 실제 촬영 경로로 찍는다. 끝나면 원래 조합으로
async function compareCombos() {
  if (comparing || session.getState().state !== SessionState.IDLE) return;
  comparing = true;
  autoplay = false;
  clearTimeout(autoplayTimer);
  if (present) leave(); // 비교 중 자동 회차가 끼어들지 않게
  releaseCompare();
  render(session.getState());
  const saved = effect.getSettings();
  let error = '';
  try {
    for (const [oil, mono] of COMBOS) {
      effect.setSettings(applyEffectTunables(saved, comboTunables(saved, { oil, mono }), config.effect).settings);
      await nextFrames(3);
      const photo = await capture.take();
      compareShots.push({ oil, mono, photo, stats: photoEffect.getStats().last });
      renderCompare();
    }
  } catch (e) {
    error = e?.message ?? String(e);
  } finally {
    effect.setSettings(saved);
    comparing = false;
    renderCompare(error);
    render(session.getState());
  }
}

// 감열지 흑백 스타일·질감 세기 (14단계 톤 점 × 유화 비교용, 운영자 E와 같은 값)
bwStyleSelect.addEventListener('change', () => { setEffect({ bwStyle: bwStyleSelect.value }); render(session.getState()); });
bwTextureSelect.addEventListener('change', () => { setEffect({ bwTexture: Number(bwTextureSelect.value) }); render(session.getState()); });
monoModeSelect.addEventListener('change', () => {
  const mono = effectCombo(effect.getSettings()).mono;
  setEffect(mono ? { outputMode: monoModeSelect.value, monoMode: monoModeSelect.value } : { monoMode: monoModeSelect.value });
  render(session.getState());
});

panel.addEventListener('click', (event) => {
  const button = event.target.closest('button[data-demo]');
  if (!button) return;
  const action = button.dataset.demo;
  if (action === 'combo') {
    setEffect(comboTunables(effect.getSettings(), { oil: button.dataset.oil === 'true', mono: button.dataset.mono === 'true' }));
  } else if (action === 'preset') {
    applyPreset(button.dataset.value);
  } else if (action === 'compare') {
    compareCombos();
  } else if (action === 'autoplay') {
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
  releaseCompare();
});

render(session.getState());
autoplayTimer = setTimeout(arrive, AUTOPLAY.firstArriveMs);
// 확인 도구가 데모가 준비됐는지 본다 (검토용 페이지에만 있는 표시, 앱에는 없다)
document.body.dataset.demoReady = 'true';
