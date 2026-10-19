// 촬영 결과에 유화 효과를 입힌다 (camera/capture.js의 효과 단계 effect(canvas, { signal })에 넣는다, 5-2).
// 결과는 셔터 순간 화면에 보이던 미리보기 그림과 같은 그림이다: 같은 카메라 프레임·그림 번호·seed·설정으로
// 결과 크기(짧은 변 1080, 4K 입력도 1080x1920)에 화면 밖으로 다시 그린다 (effect-preview.js renderStill).
// 효과를 그리지 못하면 원본 사진(결과 크기로 줄임)으로 대신한다. 관람객 흐름을 끊지 않고 D 화면과 로그에만 남긴다.
// 이미지는 메모리에만 둔다. Node 테스트: test/effect/photo-effect.test.mjs
//
// 같은 프레임인 이유: capture.js는 프레임을 잡은 같은 작업의 마이크로태스크에서 이 함수를 부르고, renderStill까지는 동기다.
// 미리보기는 requestAnimationFrame에서만 새 프레임을 올리므로 그 사이에 소스 텍스처가 바뀌지 않는다.
//
// 출력 모드 (6-1, 그 그림의 settings.outputMode):
// - gray-oil (8단계 기본값): 회색조 유화 (결과 크기, JPEG는 capture.js 기본 형식) + 인쇄용 1비트 데이터. 인쇄 데이터는 같은 합성
//   그림을 6-1 톤 점 경로(면적 평균 → 점 방식)로 만든 것이고 화면에는 보이지 않는다. 인쇄 데이터만 실패하면 사진은 그대로 두고 인쇄 데이터 없이
// - off: 컬러 유화 (결과 크기, JPEG는 capture.js 기본 형식)
// - gray: 회색조·레벨 (결과 크기, JPEG)
// - thermal: (a) 인쇄용 1비트 데이터가 정본이다: 인쇄 해상도(576x1024 등)의 래스터 비트(1 = 검은 점)와 1비트 PNG.
//   (b) 화면 표시용은 (a)의 마스크를 결과 크기(1080x1920)로 확대해(정수배 최근접 + 경계 1화소만 섞음) 종이색·잉크색으로 칠한
//   PNG다. 미리보기 캔버스(FS_THERMAL_SHOW)와 같은 정수식이라 화소가 같다. 확대는 화면 표시에만 쓰고 (a)는 그대로다.
// 효과를 그리지 못하면 원본 사진에 같은 출력 단계를 CPU로 적용한다(감열지·회색조 유화면 인쇄 데이터도 만든다).
// 출력 단계 자체가 실패하면 원본 컬러 사진(결과 크기, JPEG)으로 대신한다.

import { config } from '../config/config.js';
import { errorLog } from '../core/log-limit.js';
import { resultSizeFor } from '../core/oil-paint.js';
import {
  bwStyleOf, dither, ditherThreshold, ditherWithThresholds, encodeOneBitPng, grayLevelsInPlace, inputGrayInPlace, isGpuDither,
  packPrintBits, printSizeFor, readPngHeader, reduceToPrintGray, screenOf, thresholdMap, upscaleSharp,
} from '../core/thermal.js';

// 화면용 확대를 한 번에 몇 줄씩 할지 (1080 폭이면 한 묶음 약 2ms)
const UPSCALE_BAND = 240;
// 이미 회색조·레벨을 입힌 화소를 다시 줄일 때 (회색조 유화의 원본 사진 대체 경로)
const NEUTRAL_LEVELS = Object.freeze({ brightness: 0, contrast: 1, gamma: 1 });

/** zlib 형식 압축 (PNG IDAT). 브라우저 내장 CompressionStream, 외부 전송 없음 */
export async function deflateZlib(raw) {
  const stream = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * @param {{ preview: { isEnabled: () => boolean, renderStill: Function, getSettings: () => object },
 *   createCanvas?: () => HTMLCanvasElement, createImageData?: (pixels: Uint8ClampedArray, w: number, h: number) => ImageData,
 *   display?: { paper: number[], ink: number[] }, deflate?: (raw: Uint8Array) => Promise<Uint8Array>,
 *   createBlob?: (bytes: Uint8Array) => Blob, log?: { warn: Function, clear: Function }, now?: () => number }} options
 */
export function createPhotoEffect({
  preview,
  createCanvas = () => document.createElement('canvas'),
  createImageData = (pixels, w, h) => new ImageData(pixels, w, h),
  display = config.thermalDisplay,
  deflate = deflateZlib,
  createBlob = (bytes) => new Blob([bytes], { type: 'image/png' }),
  yieldTask = () => new Promise((resolve) => { setTimeout(resolve, 0); }),
  log = errorLog,
  now = () => performance.now(),
}) {
  let last = null;
  let applied = 0;
  let fellBack = 0;

  function free(canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }

  function newCanvas(width, height, draw) {
    const canvas = createCanvas();
    try {
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('2d context unavailable');
      draw(context);
      return canvas;
    } catch (error) {
      free(canvas);
      throw error;
    }
  }

  // 원본 사진을 결과 크기로 (효과를 입힌 사진과 크기를 같게). 이미 그 크기면 그대로 돌려준다
  function rawAtResultSize(canvas) {
    const size = resultSizeFor(canvas.width, canvas.height);
    if (size.width === canvas.width && size.height === canvas.height) return canvas;
    return newCanvas(size.width, size.height, (context) => {
      context.imageSmoothingQuality = 'high';
      context.drawImage(canvas, 0, 0, size.width, size.height);
    });
  }

  function readRgba(canvas) {
    const context = canvas.getContext('2d', { alpha: false });
    if (!context) throw new Error('2d context unavailable');
    return context.getImageData(0, 0, canvas.width, canvas.height).data;
  }

  /** 인쇄용 1비트 데이터: 마스크 → 래스터 비트·1비트 PNG(비동기 압축). 메모리에만 둔다. 그 사이 회차가 취소되면 예외 */
  async function printData(mask, Pw, Ph, signal) {
    const raster = packPrintBits(mask, Pw, Ph);
    const png = await encodeOneBitPng(mask, Pw, Ph, deflate);
    signal?.throwIfAborted();
    const header = readPngHeader(png);
    return Object.freeze({
      width: Pw, height: Ph, bytesPerRow: raster.bytesPerRow, bits: raster.bits, png: createBlob(png),
      pngBytes: png.length, pngBitDepth: header?.bitDepth ?? null, pngColorType: header?.colorType ?? null,
      blackRatio: raster.black / (Pw * Ph),
    });
  }

  /**
   * 감열지 결과: 마스크 → (a) 인쇄 데이터(래스터 비트·1비트 PNG), (b) 화면용 캔버스(결과 크기 Dw×Dh로 확대, 종이색·잉크색).
   * PNG 압축은 비동기이고, 화면 크기 확대는 줄 묶음(UPSCALE_BAND)마다 작업을 양보한다(촬영 순간 화면이 끊기지 않게).
   * 그 사이 회차가 취소되면 화면용 캔버스를 만들지 않고 예외. dots: 화면용 사진이 1비트 점 그림이라는 표시(결과 화면이 1:1로 놓는다)
   */
  async function thermalResult(mask, Pw, Ph, Dw, Dh, signal) {
    const print = await printData(mask, Pw, Ph, signal);
    const rgba = new Uint8ClampedArray(Dw * Dh * 4);
    for (let r = 0; r < Dh; r += UPSCALE_BAND) {
      await yieldTask();
      signal?.throwIfAborted();
      upscaleSharp(mask, Pw, Ph, Dw, Dh, display.paper, display.ink, { rows: [r, Math.min(Dh, r + UPSCALE_BAND)], out: rgba });
    }
    await yieldTask();
    signal?.throwIfAborted();
    const canvas = newCanvas(Dw, Dh, (context) => {
      context.putImageData(createImageData(rgba, Dw, Dh), 0, 0);
    });
    return { canvas, type: 'image/png', print, dots: true };
  }

  /**
   * GPU 문턱값 디더(또는 GPU 점별 문턱)가 CPU 같은 식과 비트 단위로 같은지. 다르면 경고하고 GPU 쪽을 쓴다(화면에 보이던 것, 6-1).
   * 오차 확산은 이미 CPU가 디더했으므로 'cpu dither'
   */
  function checkGpuDither({ mask, gray, thr, printWidth: Pw, printHeight: Ph }, method, what) {
    if (!((thr || isGpuDither(method)) && gray)) return 'cpu dither';
    const cpu = thr ? ditherWithThresholds(gray, thr) : ditherThreshold(gray, Pw, Ph, thresholdMap(method));
    let diff = 0;
    for (let i = 0; i < cpu.length; i += 1) if (cpu[i] !== mask[i]) diff += 1;
    if (diff > 0) log.warn('effect-capture', `${what} ${method}: GPU and CPU dither differ in ${diff} dots (using GPU)`);
    return diff === 0 ? 'gpu=cpu' : `GPU != CPU (${diff} dots)`;
  }

  function describePrint(print) {
    return {
      width: print.width, height: print.height, bytesPerRow: print.bytesPerRow, rasterBytes: print.bits.length,
      pngBytes: print.pngBytes, pngBitDepth: print.pngBitDepth, pngColorType: print.pngColorType, blackRatio: print.blackRatio,
    };
  }

  // 효과를 그리지 못했을 때: 원본 사진에 같은 출력 단계를 CPU로 (감열지면 인쇄 데이터도). 실패하면 원본 컬러 사진.
  // 흑백 스타일(7-1)은 쓰지 않는다: 획·흐름장·획 볼록이 없으므로 톤 점(설정한 점 방식)으로 찍는다
  async function rawResult(canvas, settings, reason, t0, signal) {
    log.warn('effect-capture', `photo effect not applied -> raw photo (${reason})`);
    fellBack += 1;
    const mode = settings.outputMode ?? 'off';
    try {
      if (mode === 'thermal') {
        const size = resultSizeFor(canvas.width, canvas.height);
        const { width: Pw, height: Ph } = printSizeFor(settings.paperDots, size.width, size.height);
        const gray = reduceToPrintGray(readRgba(canvas), canvas.width, canvas.height, Pw, Ph, settings);
        const out = await thermalResult(dither(gray, Pw, Ph, settings.dither), Pw, Ph, size.width, size.height, signal);
        const style = bwStyleOf(settings) === 'tone' ? '' : ` (style ${bwStyleOf(settings)} -> tone)`;
        last = { status: 'raw', mode, reason: `${reason}${style}`, width: Pw, height: Ph, dither: settings.dither, print: describePrint(out.print), ms: now() - t0 };
        return out;
      }
      if (mode === 'gray-oil') return await rawGrayOil(canvas, settings, reason, t0, signal);
      if (mode === 'gray') {
        const raw = rawAtResultSize(canvas);
        try {
          const context = raw.getContext('2d', { alpha: false });
          const image = context.getImageData(0, 0, raw.width, raw.height);
          grayLevelsInPlace(image.data, settings);
          context.putImageData(image, 0, 0);
        } catch (error) {
          if (raw !== canvas) free(raw);
          throw error;
        }
        last = { status: 'raw', mode, reason, width: raw.width, height: raw.height, ms: now() - t0 };
        return raw;
      }
    } catch (error) {
      signal?.throwIfAborted();
      reason = `${reason}; ${mode} output on raw photo failed: ${error?.message ?? error}`;
      log.warn('effect-capture', `output stage failed -> raw color photo (${reason})`);
    }
    const raw = rawAtResultSize(canvas);
    last = { status: 'raw', mode: 'off', reason, width: raw.width, height: raw.height, ms: now() - t0 };
    return raw;
  }

  // 회색조 유화에서 효과를 그리지 못했을 때: 원본 사진(결과 크기) → 입력 회색조(Rec.709) → 레벨. 인쇄 데이터는 그 사진에서
  // 면적 평균 → 점 방식으로(유화가 없으므로 원본 사진의 회색). 인쇄 데이터만 실패하면 회색 사진은 그대로 두고 인쇄 데이터 없이
  async function rawGrayOil(canvas, settings, reason, t0, signal) {
    const raw = rawAtResultSize(canvas);
    let image;
    try {
      const context = raw.getContext('2d', { alpha: false });
      image = context.getImageData(0, 0, raw.width, raw.height);
      grayLevelsInPlace(inputGrayInPlace(image.data), settings);
      context.putImageData(image, 0, 0);
    } catch (error) {
      if (raw !== canvas) free(raw);
      throw error;
    }
    const { width: Pw, height: Ph } = printSizeFor(settings.paperDots, raw.width, raw.height);
    let print = null;
    let printError = '';
    try {
      const gray = reduceToPrintGray(image.data, raw.width, raw.height, Pw, Ph, NEUTRAL_LEVELS);
      print = await printData(dither(gray, Pw, Ph, settings.dither), Pw, Ph, signal);
    } catch (error) {
      if (signal?.aborted) {
        if (raw !== canvas) free(raw);
        throw error;
      }
      printError = error?.message ?? String(error);
      log.warn('effect-capture', `print data not made -> gray photo without print data (${printError})`);
    }
    last = {
      status: 'raw', mode: 'gray-oil', reason, width: raw.width, height: raw.height, dither: `print ${settings.dither}`,
      print: print ? describePrint(print) : null, printError, ms: now() - t0,
    };
    return print ? { canvas: raw, print } : raw;
  }

  /**
   * @param {HTMLCanvasElement} canvas capture.js가 잡은 원본 사진 (보이는 9:16 영역, 원본 해상도, 반전)
   * @returns {Promise<HTMLCanvasElement | { canvas: HTMLCanvasElement, type?: string, print: object, dots?: boolean }>}
   *   효과 사진(새 캔버스)·원본 사진, 감열지면 { 화면용 캔버스, 형식 'image/png', 인쇄 데이터, dots: true },
   *   회색조 유화면 { 사진 캔버스(형식은 capture.js 기본 JPEG), 인쇄 데이터 }. 새 캔버스는 capture.js가 정리한다
   */
  async function apply(canvas, { signal } = {}) {
    signal?.throwIfAborted();
    if (!preview.isEnabled()) {
      last = { status: 'disabled' };
      return canvas;
    }
    const t0 = now();
    let still;
    try {
      still = preview.renderStill(); // 동기 (셔터 순간 화면의 그림)
    } catch (error) {
      return rawResult(canvas, preview.getSettings(), error?.message ?? String(error), t0, signal);
    }
    const base = { seed: still.seed, tick: still.tick, sameAsPreview: still.sameAsPreview, renderMs: still.ms }; // renderMs: 동기 구간(셔터 순간)
    if (still.mode !== 'thermal') {
      let output;
      try {
        output = newCanvas(still.width, still.height, (context) => {
          context.putImageData(createImageData(still.pixels, still.width, still.height), 0, 0);
        });
      } catch (error) {
        return rawResult(canvas, still.settings, error?.message ?? String(error), t0, signal);
      }
      if (still.mode === 'gray-oil') return grayOilResult(output, still, base, t0, signal);
      applied += 1;
      last = { status: 'applied', mode: still.mode, width: still.width, height: still.height, ...base, ms: now() - t0 };
      log.clear('effect-capture');
      return output;
    }

    // 감열지: 화면에 보이던 점 그림(GPU 디더면 GPU가 만든 마스크)이 정본이다
    const { mask, printWidth: Pw, printHeight: Ph } = still;
    const method = screenOf(still.settings); // 점 방식, 또는 흐름 선·붓 결 선 (7-1)
    // 흐름 선·붓 결 선은 GPU가 만든 점별 문턱(thr)으로 비교만 다시 한다(문턱 자체는 획·흐름장에서 GPU로만 만든다)
    const check = checkGpuDither(still, method, 'thermal');
    try {
      const out = await thermalResult(mask, Pw, Ph, still.width, still.height, signal);
      applied += 1;
      last = {
        status: 'applied', mode: 'thermal', width: Pw, height: Ph, display: `${still.width}x${still.height}`, ...base, dither: method, check,
        print: describePrint(out.print),
        ms: now() - t0,
      };
      log.clear('effect-capture');
      return out;
    } catch (error) {
      signal?.throwIfAborted();
      const reason = `thermal output failed: ${error?.message ?? error}`;
      log.warn('effect-capture', `photo effect not applied -> raw color photo (${reason})`);
      fellBack += 1;
      const raw = rawAtResultSize(canvas);
      last = { status: 'raw', mode: 'off', reason, width: raw.width, height: raw.height, ms: now() - t0 };
      return raw;
    }
  }

  /**
   * 회색조 유화 결과 (8단계): 사진은 미리보기와 같은 회색조 유화 그대로(output), 인쇄 데이터는 렌더러가 같은 합성 그림에서 만든
   * 인쇄 해상도 마스크(6-1 톤 점 경로)로. 인쇄 데이터만 실패하면 사진은 그대로 두고 인쇄 데이터 없이(사진은 인쇄 데이터와 관계없이 맞다).
   * 그 사이 회차가 취소되면 사진 캔버스를 비우고 예외
   */
  async function grayOilResult(output, still, base, t0, signal) {
    const method = still.settings.dither;
    let print = null;
    let check = null;
    let printError = '';
    try {
      if (!still.mask) throw new Error('no print mask from renderer');
      check = checkGpuDither(still, method, 'print');
      print = await printData(still.mask, still.printWidth, still.printHeight, signal);
    } catch (error) {
      if (signal?.aborted) {
        free(output);
        throw error;
      }
      printError = error?.message ?? String(error);
      log.warn('effect-capture', `print data not made -> gray oil photo without print data (${printError})`);
    }
    applied += 1;
    last = {
      status: 'applied', mode: 'gray-oil', width: still.width, height: still.height, ...base, dither: `print ${method}`,
      check: print ? check : 'no print data', print: print ? describePrint(print) : null, printError, ms: now() - t0,
    };
    if (!printError) log.clear('effect-capture');
    return print ? { canvas: output, print } : output;
  }

  return {
    apply,
    /** D 화면용: 마지막 결과의 효과 상태와 누적 수 */
    getStats: () => ({ last, applied, fellBack }),
  };
}
