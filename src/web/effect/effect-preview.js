// 실시간 효과 미리보기: 카메라 영상 → 유화 효과 → 9:16 화면 캔버스.
// 원본 <video>는 감지·캡처용으로 그대로 두고(캔버스 아래에서 계속 재생), 화면에는 효과 캔버스를 위에 보인다.
// 효과를 쓸 수 없으면(WebGL2 없음·셰이더 실패·컨텍스트 손실) 캔버스를 숨겨 원본 미리보기로 돌아간다.
// 카메라·감지·촬영은 이 모듈과 관계없이 계속 동작한다. Node 테스트: test/effect/effect-preview.test.mjs
//
// 좌우 반전·크롭: 미리보기(<video>, object-fit: cover, CSS scaleX(-1))와 같은 영역을 같은 방향으로 그린다.
// 반전은 효과 입력을 읽을 때 한 번만 하고 캔버스에는 CSS 반전을 걸지 않는다(이중 반전 방지).
// 효과는 반전된 그림에 칠한다 (획 방향이 좌우 대칭이 아니므로, 결과 사진과 같은 그림이 되게).

import { config } from '../config/config.js';
import { normalizeEffectSettings } from '../config/effect-settings.js';
import { errorLog } from '../core/log-limit.js';
import { drawingTick, resultSizeFor, seedForTick } from '../core/oil-paint.js';
import { computeCoverMapping } from '../core/presence.js';
import { EffectError, EffectFault, createOilRenderer } from './oil-renderer.js';

export const EffectStatus = Object.freeze({
  DISABLED: 'disabled', // 설정으로 끔 (원본 미리보기)
  WAITING_CAMERA: 'waiting-camera', // 카메라 준비 전·끊김. 앞 그림을 남기지 않게 캔버스를 숨긴다
  RUNNING: 'running',
  CONTEXT_LOST: 'context-lost', // 원본 미리보기로 보이며 브라우저가 컨텍스트를 되살리기를 기다린다
  FALLBACK: 'fallback', // 효과를 쓸 수 없음. 원본 미리보기 (새로고침 전까지)
});

/**
 * 보이는 9:16 영역 → 결과 사진 크기(짧은 변 1080), 미리보기 해상도(결과 × previewScale), 소스 uv 변환.
 * 소스는 위아래를 뒤집어 올리므로 uv는 왼쪽 아래 원점이다.
 * @returns {{ width: number, height: number, resultWidth: number, resultHeight: number,
 *   sourceOffset: [number, number], sourceScale: [number, number] } | null}
 */
export function computeEffectView({ videoWidth, videoHeight, stageAspect, mirror, previewScale }) {
  const m = computeCoverMapping({ videoWidth, videoHeight, stageAspect, mirror });
  if (m === null) return null;
  const result = resultSizeFor(m.visibleWidth * videoWidth, m.visibleHeight * videoHeight);
  const width = Math.max(2, Math.round(result.width * previewScale));
  const height = Math.max(2, Math.round(result.height * previewScale));
  const v0 = 1 - m.offsetY - m.visibleHeight;
  const sourceOffset = mirror ? [m.offsetX + m.visibleWidth, v0] : [m.offsetX, v0];
  const sourceScale = [mirror ? -m.visibleWidth : m.visibleWidth, m.visibleHeight];
  return { width, height, resultWidth: result.width, resultHeight: result.height, sourceOffset, sourceScale };
}

/**
 * @param {{ canvas: HTMLCanvasElement, video: HTMLVideoElement, camera: { isReady: () => boolean },
 *   stageAspect: number, mirror: boolean, settings?: object,
 *   createRenderer?: typeof createOilRenderer, raf?: Function, cancelRaf?: Function, now?: () => number,
 *   log?: { warn: Function, clear: Function }, onChange?: () => void }} options
 *   settings: config.effect 형식 (enabled 포함). onChange: 상태가 바뀔 때 (D 화면 갱신용)
 */
export function createEffectPreview({
  canvas, video, camera, stageAspect, mirror, settings: initialSettings = config.effect,
  createRenderer = createOilRenderer,
  raf = (fn) => requestAnimationFrame(fn), cancelRaf = (id) => cancelAnimationFrame(id),
  now = () => performance.now(), log = errorLog, onChange = () => {},
}) {
  const enabled = initialSettings.enabled !== false;
  let settings = normalizeEffectSettings(initialSettings, config.effect).settings;
  let renderer = null;
  let status = enabled ? EffectStatus.WAITING_CAMERA : EffectStatus.DISABLED;
  let fault = '';
  let contextLosses = 0;
  let frameId = null;
  let lastTick = null;
  let lastSeed = null;
  // 화면에 보이는 마지막 그림: 그 그림의 카메라 프레임은 렌더러의 소스 텍스처에 남아 있다 (다음 그림에서 바뀐다)
  let lastDrawing = null;
  let dirty = true;
  let view = null;
  let shown = false;
  let renderFailures = 0;
  const drawTimes = []; // 최근 1초 그린 시각 (초당 그림 수 측정)
  let cpuAvg = null;

  function setStatus(next, reason = fault) {
    const changed = next !== status || reason !== fault;
    status = next;
    fault = reason;
    if (status !== EffectStatus.RUNNING) show(false);
    if (changed) onChange();
  }

  function show(visible) {
    if (visible === shown) return;
    shown = visible;
    canvas.hidden = !visible;
  }

  function createNow() {
    try {
      renderer = createRenderer({ canvas });
      log.clear('effect');
      return true;
    } catch (error) {
      renderer = null;
      const reason = error instanceof EffectError ? error.message : `${EffectFault.RENDER_FAILED}: ${error?.message ?? error}`;
      log.warn('effect', `effect unavailable -> camera preview (${reason})`);
      setStatus(EffectStatus.FALLBACK, reason);
      return false;
    }
  }

  function onContextLost(event) {
    event.preventDefault(); // 브라우저가 컨텍스트를 되살릴 수 있게 한다 (webglcontextrestored)
    contextLosses += 1;
    renderer = null; // 잃은 컨텍스트의 자원은 지울 수 없고 지울 필요도 없다
    lastDrawing = null;
    log.warn('effect', 'webgl context lost -> camera preview');
    setStatus(EffectStatus.CONTEXT_LOST, 'webglcontextlost, waiting for restore');
  }

  function onContextRestored() {
    if (status !== EffectStatus.CONTEXT_LOST) return;
    if (!createNow()) return;
    dirty = true;
    lastTick = null;
    setStatus(EffectStatus.WAITING_CAMERA, '');
  }

  function frame() {
    frameId = raf(frame);
    if (status !== EffectStatus.RUNNING && status !== EffectStatus.WAITING_CAMERA) return;
    if (!camera.isReady() || !(video.videoWidth > 0 && video.videoHeight > 0)) {
      if (status !== EffectStatus.WAITING_CAMERA) setStatus(EffectStatus.WAITING_CAMERA, '');
      dirty = true;
      return;
    }
    const next = computeEffectView({
      videoWidth: video.videoWidth, videoHeight: video.videoHeight, stageAspect, mirror, previewScale: settings.previewScale,
    });
    const sizeChanged = !view || next.width !== view.width || next.height !== view.height
      || next.sourceOffset.some((v, i) => v !== view.sourceOffset[i]) || next.sourceScale.some((v, i) => v !== view.sourceScale[i]);
    const t = now();
    const tick = drawingTick(t, settings.fps);
    if (!dirty && !sizeChanged && tick === lastTick && status === EffectStatus.RUNNING) return;
    view = next;
    const seed = seedForTick(tick);
    try {
      const { cpuMs } = renderer.render(video, {
        settings, width: view.width, height: view.height, seed, sourceOffset: view.sourceOffset, sourceScale: view.sourceScale,
      });
      lastTick = tick;
      lastSeed = seed;
      lastDrawing = { tick, seed, settings, view, videoWidth: video.videoWidth, videoHeight: video.videoHeight, at: t };
      dirty = false;
      renderFailures = 0;
      cpuAvg = cpuAvg === null ? cpuMs : cpuAvg * 0.9 + cpuMs * 0.1;
      drawTimes.push(t);
      while (drawTimes.length && t - drawTimes[0] >= 1000) drawTimes.shift();
      if (status !== EffectStatus.RUNNING) {
        log.clear('effect');
        setStatus(EffectStatus.RUNNING, '');
      }
      show(true);
    } catch (error) {
      if (renderer?.gl?.isContextLost?.()) return; // 곧 webglcontextlost 이벤트가 온다
      renderFailures += 1;
      const reason = error instanceof EffectError ? error.message : `${EffectFault.RENDER_FAILED}: ${error?.message ?? error}`;
      log.warn('effect', `effect render failed -> camera preview (${reason})`);
      try { renderer?.dispose(); } catch { /* 이미 망가진 상태 */ }
      renderer = null;
      lastDrawing = null;
      setStatus(EffectStatus.FALLBACK, reason);
    }
  }

  /**
   * 결과 사진: 지금 화면에 보이는 그림과 같은 카메라 프레임·그림 번호·seed·설정으로, 결과 크기(짧은 변 1080)에 화면 밖으로 그린다.
   * 동기로 끝난다. 미리보기가 다음 그림을 그리기 전(같은 작업 안)에 불러야 같은 프레임이다 (capture.js가 그렇게 부른다).
   * 보이는 그림이 없으면(카메라 준비 직후) 지금 프레임으로 그린다. 효과를 쓸 수 없으면 EffectError.
   * @returns {{ pixels: Uint8ClampedArray, width: number, height: number, seed: number, tick: number,
   *   sameAsPreview: boolean, ms: number }}
   */
  function renderStill() {
    if (!renderer || (status !== EffectStatus.RUNNING && status !== EffectStatus.WAITING_CAMERA)) {
      throw new EffectError(EffectFault.NOT_RUNNING, `preview effect is ${status}${fault ? ` (${fault})` : ''}`);
    }
    const t0 = now();
    const reuse = lastDrawing !== null && lastDrawing.videoWidth === video.videoWidth && lastDrawing.videoHeight === video.videoHeight;
    let drawing = lastDrawing;
    if (!reuse) {
      const v = computeEffectView({
        videoWidth: video.videoWidth, videoHeight: video.videoHeight, stageAspect, mirror, previewScale: settings.previewScale,
      });
      if (v === null) throw new EffectError(EffectFault.RENDER_FAILED, 'video has no frame');
      const tick = drawingTick(t0, settings.fps);
      drawing = { tick, seed: seedForTick(tick), settings, view: v };
    }
    const { view: v } = drawing;
    const { pixels } = renderer.render(reuse ? null : video, {
      settings: drawing.settings, width: v.resultWidth, height: v.resultHeight, seed: drawing.seed,
      sourceOffset: v.sourceOffset, sourceScale: v.sourceScale, output: 'pixels',
    });
    return { pixels, width: v.resultWidth, height: v.resultHeight, seed: drawing.seed, tick: drawing.tick, sameAsPreview: reuse, ms: now() - t0 };
  }

  return {
    start() {
      if (!enabled || frameId !== null) return;
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);
      show(false);
      if (!createNow()) return;
      frameId = raf(frame);
    },
    stop() {
      if (frameId !== null) cancelRaf(frameId);
      frameId = null;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      try { renderer?.dispose(); } catch { /* 무시 */ }
      renderer = null;
      show(false);
    },
    /**
     * 효과 설정을 바꾼다 (일부만 줘도 된다). 다음 화면 갱신 때 새로 그린다. 조절 화면(5-2)이 쓸 입구다.
     * @returns {string[]} 범위로 맞추거나 기본값으로 바꾼 항목
     */
    setSettings(partial) {
      const { settings: next, issues } = normalizeEffectSettings({ ...settings, ...partial }, config.effect);
      settings = next;
      dirty = true;
      onChange();
      return issues;
    },
    getSettings: () => settings,
    /** config.effect.enabled. false면 결과 사진에도 효과를 입히지 않는다 */
    isEnabled: () => enabled,
    renderStill,
    /** D 화면용 상태 (이미지 내용은 내보내지 않는다) */
    getState() {
      const s = renderer?.getStats() ?? null;
      const t = now();
      return {
        status,
        fault,
        shown,
        contextLosses,
        renderFailures,
        width: view?.width ?? 0,
        height: view?.height ?? 0,
        pxScale: s?.pxScale ?? 0,
        previewScale: settings.previewScale,
        fps: settings.fps,
        boil: settings.boil,
        drawingsPerSecond: drawTimes.filter((at) => t - at < 1000).length,
        seed: lastSeed,
        cpuMs: s?.cpuMs ?? null,
        cpuAvgMs: cpuAvg,
        gpuMs: s?.gpuMs ?? null,
        gpuTimer: s?.timer ?? false,
        strokes: s?.strokes ?? 0,
        renderer: renderer?.renderer?.() ?? '',
      };
    },
  };
}
