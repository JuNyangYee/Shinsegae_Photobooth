// 최종 화면 합성 (17단계): 카메라 창(또는 셔터 고정 그림) → 장면 → 눈 글씨·눈송이를 한 장(2D)으로 합성하고,
// 그 한 장에 oil2f를 한 번 입혀 #screen-filter(불투명)에 보인다. Mirror의 "장면 전체를 소스 한 장으로 만들어 엔진 한 번" 구조와 같다.
// 필터 정의는 카메라 필터의 활성 번들(13단계 검증 경계)을 그대로 쓰고, 없으면 기본 제공판이다. 원격 코드는 실행하지 않는다.
// 표시 전용이다: 합성 그림은 촬영·인쇄 데이터 경로(capture·photo-effect)에 들어가지 않고 파일·저장소에 남지 않는다.
// 끔·우회·장애면 캔버스를 숨겨 기존 화면(DOM 레이어)으로 돌아간다. 카메라 필터는 합성 중 표시용만 유화 없이 그린다(유화 1회).
// Node 테스트: test/effect/screen-compositor.test.mjs

import { errorLog } from '../core/log-limit.js';
import { drawingTick, seedForTick } from '../core/oil-paint.js';
import { screenFilterBypass, screenRenderSize } from '../core/screen-layout.js';
import { EffectError, EffectFault, createOilRenderer } from './oil-renderer.js';

export const ScreenFilterState = Object.freeze({
  LOADING: 'loading', // 조절값·번들·장면을 기다린다 (기존 화면)
  BYPASS: 'bypass', // 끔 또는 우회 (기존 화면)
  RUNNING: 'running',
  CONTEXT_LOST: 'context-lost',
  FAULT: 'fault', // 쓸 수 없음. 기존 화면 (새로고침 전까지)
});

const NIGHT = '#1c1d52'; // style.css --night

/**
 * @param {{ canvas: HTMLCanvasElement, stage: HTMLElement, effect: object, plateCanvas: HTMLCanvasElement,
 *   layers: { drawUnderScene: Function, drawOverScene: Function, resultOpacity: () => number },
 *   cameraFallback?: () => (CanvasImageSource | null), createCanvas?: () => HTMLCanvasElement, createRenderer?: typeof createOilRenderer,
 *   raf?: Function, cancelRaf?: Function, now?: () => number, log?: object, onChange?: () => void, isHidden?: () => boolean }} options
 *   effect: effect-preview.js (setCompositeMode·drawCompositeFrame·getBundle·getSettings). cameraFallback: 효과를 못 쓸 때의 카메라 그림
 */
export function createScreenCompositor({
  canvas, stage, effect, plateCanvas, layers, cameraFallback = () => null,
  createCanvas = () => document.createElement('canvas'), createRenderer = createOilRenderer,
  raf = (fn) => requestAnimationFrame(fn), cancelRaf = (id) => cancelAnimationFrame(id),
  now = () => performance.now(), log = errorLog, onChange = () => {}, isHidden = () => document.hidden,
}) {
  let settings = null;
  let fallbackBundle = null;
  let plateReady = false;
  let renderer = null;
  let rendererBundle = null;
  let active = false; // 합성 중 (카메라 효과가 표시 경로를 넘겼다)
  let shown = false;
  let state = ScreenFilterState.LOADING;
  let reason = '';
  let frameId = null;
  let lastTick = null;
  let dirty = true;
  let frozen = null; // 셔터 순간 카메라 층 (그 회차 동안만 메모리에)
  let frameAvg = null;
  let lastSize = null;
  let lastFrameMs = null;
  const drawTimes = [];
  const source = createCanvas();
  const cameraLayer = createCanvas();
  let sourceCtx = null;

  function setState(next, why = '') {
    if (state === next && reason === why) return;
    state = next;
    reason = why;
    onChange();
  }

  function setShown(visible) {
    if (shown === visible) return;
    shown = visible;
    canvas.hidden = !visible;
    if (visible) stage.dataset.screenFilter = 'on';
    else delete stage.dataset.screenFilter;
  }

  function deactivate(nextState, why) {
    setShown(false);
    if (active) {
      active = false;
      effect.setCompositeMode(false);
    }
    lastTick = null;
    dirty = true;
    setState(nextState, why);
  }

  function disposeRenderer() {
    try { renderer?.dispose(); } catch { /* 이미 망가진 상태 */ }
    renderer = null;
    rendererBundle = null;
  }

  function fail(error) {
    const message = error instanceof EffectError ? error.message : `${EffectFault.RENDER_FAILED}: ${error?.message ?? error}`;
    log.warn('screen-filter', `screen filter unavailable -> plain screen (${message})`);
    disposeRenderer();
    deactivate(ScreenFilterState.FAULT, message);
  }

  function ensureRenderer() {
    const bundle = effect.getBundle() ?? fallbackBundle;
    if (!bundle) return false;
    if (renderer && rendererBundle === bundle) return true;
    disposeRenderer();
    try {
      renderer = createRenderer({ canvas, bundle });
    } catch (error) {
      if (!fallbackBundle || bundle === fallbackBundle) {
        fail(error);
        return false;
      }
      log.warn('screen-filter', `applied filter failed -> built-in (${error?.message ?? error})`);
      try {
        renderer = createRenderer({ canvas, bundle: fallbackBundle });
      } catch (fallbackError) {
        fail(fallbackError);
        return false;
      }
    }
    rendererBundle = bundle; // 실패 판이어도 같은 판으로 되풀이하지 않는다 (판이 바뀌면 다시 만든다)
    lastTick = null;
    return true;
  }

  function updateCameraLayer(width, height) {
    if (cameraLayer.width !== width || cameraLayer.height !== height) {
      cameraLayer.width = width;
      cameraLayer.height = height;
    }
    const ctx = cameraLayer.getContext('2d');
    const image = effect.drawCompositeFrame({ previewScale: settings.filter.previewScale }) ?? cameraFallback();
    if (image) {
      ctx.drawImage(image, 0, 0, width, height);
    } else {
      ctx.fillStyle = NIGHT;
      ctx.fillRect(0, 0, width, height);
    }
  }

  function compose(t, width, height) {
    if (source.width !== width || source.height !== height) {
      source.width = width;
      source.height = height;
      sourceCtx = null;
    }
    sourceCtx ??= source.getContext('2d', { alpha: false });
    const ctx = sourceCtx;
    ctx.globalAlpha = 1;
    ctx.fillStyle = NIGHT;
    ctx.fillRect(0, 0, width, height);
    const opacity = frozen ? layers.resultOpacity() : 1;
    // 고정 중에는 효과의 소스 프레임을 건드리지 않는다 (결과 렌더가 같은 프레임을 읽는다). 결과가 걷히기 시작하면 다시 읽어 아래에 깐다
    if (!frozen || opacity < 1) updateCameraLayer(width, height);
    ctx.drawImage(cameraLayer, 0, 0, width, height);
    if (frozen) {
      ctx.globalAlpha = opacity;
      ctx.drawImage(frozen, 0, 0, width, height);
      ctx.globalAlpha = 1;
    }
    layers.drawUnderScene(ctx, width, height);
    ctx.drawImage(plateCanvas, 0, 0, width, height);
    layers.drawOverScene(ctx, width, height, t);
  }

  function frame() {
    frameId = raf(frame);
    if (state === ScreenFilterState.FAULT || state === ScreenFilterState.CONTEXT_LOST) return;
    if (!settings || !plateReady) return;
    const why = screenFilterBypass({ enabled: settings.enabled, outputMode: effect.getSettings().outputMode });
    if (why) {
      deactivate(ScreenFilterState.BYPASS, why);
      return;
    }
    if (isHidden()) return;
    if (!ensureRenderer()) return;
    const t = now();
    const tick = drawingTick(t, settings.filter.fps);
    if (active && !dirty && tick === lastTick) return;
    if (!active) {
      active = true;
      effect.setCompositeMode(true);
    }
    const { width, height } = screenRenderSize(settings.filter.previewScale);
    try {
      const t0 = now();
      compose(t, width, height);
      renderer.render(source, { settings: settings.filter, width, height, seed: seedForTick(tick) });
      lastTick = tick;
      dirty = false;
      lastSize = { width, height };
      lastFrameMs = now() - t0;
      frameAvg = frameAvg === null ? lastFrameMs : frameAvg * 0.9 + lastFrameMs * 0.1;
      drawTimes.push(t);
      while (drawTimes.length && t - drawTimes[0] >= 1000) drawTimes.shift();
      setShown(true);
      setState(ScreenFilterState.RUNNING, '');
      log.clear('screen-filter');
    } catch (error) {
      if (renderer?.gl?.isContextLost?.()) return; // 곧 webglcontextlost 이벤트가 온다
      fail(error);
    }
  }

  function onContextLost(event) {
    event.preventDefault();
    renderer = null;
    rendererBundle = null;
    log.warn('screen-filter', 'webgl context lost -> plain screen');
    deactivate(ScreenFilterState.CONTEXT_LOST, 'webglcontextlost, waiting for restore');
  }

  function onContextRestored() {
    if (state === ScreenFilterState.CONTEXT_LOST) setState(ScreenFilterState.LOADING, '');
  }

  return {
    start() {
      if (frameId !== null) return;
      canvas.addEventListener('webglcontextlost', onContextLost);
      canvas.addEventListener('webglcontextrestored', onContextRestored);
      frameId = raf(frame);
    },
    stop() {
      if (frameId !== null) cancelRaf(frameId);
      frameId = null;
      canvas.removeEventListener('webglcontextlost', onContextLost);
      canvas.removeEventListener('webglcontextrestored', onContextRestored);
      deactivate(ScreenFilterState.LOADING, '');
      disposeRenderer();
    },
    setFallbackBundle(bundle) { fallbackBundle = bundle; },
    setPlateReady(ok) {
      plateReady = ok;
      if (!ok) deactivate(ScreenFilterState.FAULT, 'scene plate unavailable');
    },
    /** 조절값 (다음 틱에 반영) */
    setSettings(next) {
      settings = next;
      dirty = true;
      onChange();
    },
    getSettings: () => settings,
    /** 표시 경로 고정: 셔터부터 결과가 끝날 때까지 카메라 층을 멈춘다. 끝나면 사본을 바로 놓는다 */
    setFreeze(on) {
      if (on === (frozen !== null)) return;
      if (on) {
        if (!active || cameraLayer.width === 0) return;
        frozen = createCanvas();
        frozen.width = cameraLayer.width;
        frozen.height = cameraLayer.height;
        frozen.getContext('2d').drawImage(cameraLayer, 0, 0);
      } else {
        frozen.width = 0;
        frozen.height = 0;
        frozen = null;
      }
      dirty = true;
    },
    /** D 화면용 (이미지 내용은 내보내지 않는다) */
    getState() {
      const t = now();
      return {
        state, reason, frozen: frozen !== null,
        enabled: settings?.enabled ?? null,
        width: lastSize?.width ?? 0, height: lastSize?.height ?? 0, fps: settings?.filter.fps ?? 0,
        drawingsPerSecond: drawTimes.filter((at) => t - at < 1000).length,
        frameMs: lastFrameMs, frameAvgMs: frameAvg,
        strokes: renderer?.getStats().strokes ?? 0,
        bundle: rendererBundle?.meta?.commit ?? (rendererBundle ? 'built-in' : ''),
      };
    },
  };
}
