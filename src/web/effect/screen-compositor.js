// 최종 화면 합성 (17단계): 카메라 창(또는 셔터 고정 그림) → 장면 → 눈 글씨·눈송이를 한 장(2D)으로 합성하고,
// 그 한 장에 oil2f를 한 번 입혀 #screen-filter(불투명)에 보인다. Mirror의 "장면 전체를 소스 한 장으로 만들어 엔진 한 번" 구조와 같다.
// 필터 정의는 카메라 필터의 활성 번들(13단계 검증 경계)을 그대로 쓰고, 없으면 기본 제공판이다. 원격 코드는 실행하지 않는다.
// 합성 그림 자체는 사진·인쇄에 들어가지 않는다(장식 없음). 사진은 같은 엔진·수치·seed로 셔터 순간 카메라 층만 칠한다(renderStill, 사용자 확정 2026-11-09).
// 끔·우회·장애면 캔버스를 숨겨 기존 화면(DOM 레이어)으로 돌아간다. 카메라 필터는 합성 중 표시용만 유화 없이 그린다(유화 1회).
// Node 테스트: test/effect/screen-compositor.test.mjs

import { errorLog } from '../core/log-limit.js';
import { drawingTick, seedForTick } from '../core/oil-paint.js';
import { screenFilterBypass, screenPhotoSettings, screenRenderSize } from '../core/screen-layout.js';
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
  dotsCanvas = null, display = undefined, idle = (fn) => requestIdleCallback(fn, { timeout: 2000 }),
}) {
  let settings = null;
  let fallbackBundle = null;
  let plateReady = false;
  let renderer = null;
  let rendererBundle = null;
  let photoRenderer = null; // 사진·감열지 점 전용 (화면 렌더러와 대상이 달라 서로의 소스·크기를 건드리지 않는다)
  let warmedKey = '';
  let warming = false;
  let layerIsCamera = false; // 카메라 층이 효과 경로의 카메라 그림인지 (대체 그림이면 사진에 쓰지 않는다)
  let frozenTick = null;
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
  const photoCanvas = createCanvas();
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
    if (!visible && dotsCanvas) dotsCanvas.hidden = true;
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
    try { photoRenderer?.dispose(); } catch { /* 이미 망가진 상태 */ }
    renderer = null;
    photoRenderer = null;
    rendererBundle = null;
    warmedKey = '';
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
    let used = bundle;
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
        used = fallbackBundle;
      } catch (fallbackError) {
        fail(fallbackError);
        return false;
      }
    }
    // 사진은 화면과 같은 엔진(같은 번들)으로. 못 만들면 화면은 그대로 두고 사진은 카메라 효과 경로로 돌아간다 (createPhotoSource)
    try {
      photoRenderer = createRenderer({ canvas: photoCanvas, bundle: used, ...(display ? { display } : {}) });
    } catch (error) {
      photoRenderer = null;
      log.warn('screen-filter', `photo renderer unavailable -> camera effect path (${error?.message ?? error})`);
    }
    rendererBundle = bundle; // 실패 판이어도 같은 판으로 되풀이하지 않는다 (판이 바뀌면 다시 만든다)
    lastTick = null;
    return true;
  }

  // 카메라 층: 유화 없이 출력 단계만 거친 결과 크기 그림 (합성에서 줄여 쓰고, 사진은 이 그림을 그대로 칠한다)
  function updateCameraLayer(width, height) {
    const image = effect.drawCompositeFrame({ previewScale: 1 });
    layerIsCamera = image !== null;
    const drawn = image ?? cameraFallback();
    const w = drawn?.width || width;
    const h = drawn?.height || height;
    if (cameraLayer.width !== w || cameraLayer.height !== h) {
      cameraLayer.width = w;
      cameraLayer.height = h;
    }
    const ctx = cameraLayer.getContext('2d');
    if (drawn) {
      ctx.drawImage(drawn, 0, 0, w, h);
    } else {
      ctx.fillStyle = NIGHT;
      ctx.fillRect(0, 0, w, h);
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
    const why = screenFilterBypass({ enabled: settings.enabled });
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
      const seed = seedForTick(frozenTick ?? tick); // 고정 중에는 셔터 순간 그림의 seed (결과 사진과 같다)
      renderer.render(source, { settings: settings.filter, width, height, seed });
      drawDots(seed);
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
      scheduleWarm();
    } catch (error) {
      if (renderer?.gl?.isContextLost?.()) return; // 곧 webglcontextlost 이벤트가 온다
      fail(error);
    }
  }

  const photoSettings = () => screenPhotoSettings(settings.filter, effect.getSettings());

  // 감열지 시험: 사진과 같은 유화 결과를 1비트로 바꾼 점을 창 자리에만 보인다 (유화를 점 위에 다시 입히지 않는다).
  // 장면이 불투명한 곳(틀·캐릭터)은 지워 화면 필터 그림이 그대로 보인다
  function drawDots(seed) {
    if (!dotsCanvas) return;
    const photo = photoSettings();
    if (photo.outputMode !== 'thermal' || !photoRenderer) {
      dotsCanvas.hidden = true;
      return;
    }
    const layer = frozen ?? cameraLayer;
    photoRenderer.render(layer, {
      settings: photo, width: layer.width, height: layer.height, seed, displayWidth: layer.width, displayHeight: layer.height,
    });
    if (dotsCanvas.width !== layer.width || dotsCanvas.height !== layer.height) {
      dotsCanvas.width = layer.width;
      dotsCanvas.height = layer.height;
    }
    const ctx = dotsCanvas.getContext('2d');
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(photoCanvas, 0, 0);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(plateCanvas, 0, 0, dotsCanvas.width, dotsCanvas.height);
    ctx.globalCompositeOperation = 'source-over';
    dotsCanvas.hidden = false;
  }

  // 첫 셔터 멈춤 방지: 결과 크기 대상을 한가할 때 미리 만든다 (설정·크기가 바뀌면 다시)
  function scheduleWarm() {
    if (warming || !photoRenderer || !layerIsCamera) return;
    const photo = photoSettings();
    const key = `${cameraLayer.width}x${cameraLayer.height} ${JSON.stringify(photo)}`;
    if (key === warmedKey) return;
    warming = true;
    idle(() => {
      warming = false;
      warmedKey = key;
      if (!active || !photoRenderer || cameraLayer.width === 0) return;
      try {
        photoRenderer.render(cameraLayer, { settings: photoSettings(), width: cameraLayer.width, height: cameraLayer.height, seed: seedForTick(lastTick ?? 0), output: 'warm' });
      } catch (error) {
        log.warn('screen-filter', `photo prepare failed -> made at shutter (${error?.message ?? error})`);
      }
    });
  }

  function onContextLost(event) {
    event.preventDefault();
    renderer = null;
    photoRenderer = null;
    rendererBundle = null;
    warmedKey = '';
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
        frozenTick = lastTick;
      } else {
        frozenTick = null;
        frozen.width = 0;
        frozen.height = 0;
        frozen = null;
      }
      dirty = true;
    },
    /** 사진을 이 경로로 만들 수 있는지: 합성 중이고 사진 렌더러와 카메라 층이 있다 */
    isActive: () => active && shown && photoRenderer !== null && (frozen !== null || layerIsCamera),
    getPhotoSettings: photoSettings,
    /**
     * 결과 사진 (사용자 확정 2026-11-09): 화면과 같은 엔진·유화 수치·seed로 셔터 순간 카메라 층만 칠한다. 장식은 입력에 없다.
     * 동기다. 형식은 effect-preview.js renderStill과 같다 (photo-effect.js가 그대로 쓴다)
     */
    renderStill() {
      const layer = frozen ?? cameraLayer;
      if (!active || !photoRenderer || layer.width === 0 || (frozen === null && !layerIsCamera)) {
        throw new EffectError(EffectFault.NOT_RUNNING, `screen filter is ${state}`);
      }
      const t0 = now();
      const photo = photoSettings();
      const tick = frozenTick ?? lastTick;
      const seed = seedForTick(tick);
      const out = photoRenderer.render(layer, {
        settings: photo, width: layer.width, height: layer.height, seed, output: photo.outputMode === 'thermal' ? 'print' : 'pixels',
      });
      return {
        mode: photo.outputMode, settings: photo, width: layer.width, height: layer.height, seed, tick, sameAsPreview: true, ms: now() - t0,
        pixels: out.pixels, gray: out.gray, mask: out.mask, thr: out.thr, printWidth: out.printWidth, printHeight: out.printHeight, printError: out.printError,
      };
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

/**
 * 사진 효과(photo-effect.js)가 부르는 입구. 화면 필터가 합성 중이면 그 경로, 아니면(끔·장애·못 만듦) 기존 카메라 효과 경로다.
 * @param {{ effect: object, getCompositor: () => (object | null), log?: object }} options
 */
export function createPhotoSource({ effect, getCompositor, log = errorLog }) {
  const active = () => getCompositor()?.isActive() ?? false;
  return {
    isEnabled: () => effect.isEnabled(),
    getSettings: () => (active() ? getCompositor().getPhotoSettings() : effect.getSettings()),
    renderStill() {
      if (active()) {
        try {
          return getCompositor().renderStill();
        } catch (error) {
          log.warn('screen-filter', `screen photo failed -> camera effect path (${error?.message ?? error})`);
        }
      }
      return effect.renderStill();
    },
  };
}
