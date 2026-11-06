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
//
// 사진 틀 (IMPRINT에서 도입, config.photoFrame): 위 결과는 9:16 화면 전체의 그림이고, 마지막에 사진 틀 직사각형만 남긴다.
// 16단계(사방 inset, 3:4): 화면용 사진 1080x1920 → 810x1080, 인쇄 격자 576x1024 → 432x576점(용지 가운데, 좌우 흰 여백)이 같은 화면 영역이다.
// 인쇄 데이터는 그 사진을 감열지 한 장으로 짠 것이다: 머리(촬영 날짜·시각) + 사진 + 꼬리(세리프 한 줄·용지 폭), effect/imprint-page.js.
// 촬영 시각(takenAt)은 capture.js가 셔터 순간에 잰 값이고 관람객 화면 머리에 보이는 시각과 같다.

import { config } from '../config/config.js';
import { guestText } from '../config/guest-text.js';
import { imprintStamp, paperLabel } from '../core/imprint.js';
import { errorLog } from '../core/log-limit.js';
import { resultSizeFor } from '../core/oil-paint.js';
import { cropRect, isFullFrame, padColumns, photoFrameRect } from '../core/photo-frame.js';
import {
  bwStyleOf, dither, ditherThreshold, ditherWithThresholds, encodeOneBitPng, grayLevelsInPlace, inputGrayInPlace, isGpuDither,
  packPrintBits, printSizeFor, readPngHeader, reduceToPrintGray, screenOf, thresholdMap, toneOilBlend, upscaleSharp,
} from '../core/thermal.js';
import { createImprintPage } from './imprint-page.js';

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
 *   createBlob?: (bytes: Uint8Array) => Blob, log?: { warn: Function, clear: Function }, now?: () => number,
 *   frame?: { top: number, height: number } | null, imprint?: { render: Function } | null, clock?: () => number }} options
 *   frame: 사진 틀 (null이면 9:16 그대로). imprint: 인쇄 쪽 짜기 (null이면 인쇄 데이터는 사진만). clock: takenAt이 없을 때의 촬영 시각
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
  frame = config.photoFrame,
  imprint = createImprintPage({ createCanvas, text: guestText.print }),
  clock = () => Date.now(),
}) {
  let last = null;
  let lastOil = true;
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

  /**
   * 인쇄 쪽 (IMPRINT 시안): 9:16 인쇄 해상도 마스크(Pw×Ph)에서 사진 틀 직사각형만 남기고, 머리·꼬리 글자와 함께 한 장으로 짠다.
   * 16단계: 틀이 좌우로도 inset이라 사진은 용지 폭보다 좁다(576점 → 432점). 같은 점 격자 그대로 잘라 용지 가운데에 놓고 좌우는 흰 종이(1).
   * 그래서 감열지 화면 미리보기의 점 = 인쇄 점이다. 글자 짜기가 실패하면 사진만으로 (경고, imprintError).
   * photo: 쪽 안의 사진 줄(top·height)·열(left·width)과 원래 마스크에서 가져온 첫 줄·열(sourceTop·sourceLeft)
   */
  function imprintPage(mask, Pw, Ph, takenAt) {
    const rect = photoFrameRect(Pw, Ph, frame);
    const left = Math.floor((Pw - rect.width) / 2);
    const photo = isFullFrame(frame) ? mask : padColumns(cropRect(mask, Pw, rect), rect.width, rect.height, Pw, left, 1);
    const place = { left, width: rect.width, sourceTop: rect.top, sourceLeft: rect.left };
    const photoOnly = { mask: photo, height: rect.height, layout: 'photo', photo: Object.freeze({ top: 0, height: rect.height, ...place }) };
    if (!imprint) return photoOnly;
    try {
      const page = imprint.render({
        photoMask: photo, width: Pw, photoHeight: rect.height, stamp: imprintStamp(takenAt), paper: paperLabel(Pw),
      });
      return {
        mask: page.mask, height: page.height, layout: 'imprint', fontsReady: page.fontsReady,
        photo: Object.freeze({ top: page.photoTop, height: rect.height, ...place }),
      };
    } catch (error) {
      const imprintError = error?.message ?? String(error);
      log.warn('effect-capture', `imprint type not drawn -> print data is the photo only (${imprintError})`);
      return { ...photoOnly, imprintError };
    }
  }

  /** 인쇄용 1비트 데이터: 마스크 → (사진 틀·인쇄 쪽) → 래스터 비트·1비트 PNG(비동기 압축). 메모리에만 둔다. 그 사이 회차가 취소되면 예외 */
  async function printData(mask, Pw, Ph, signal, takenAt) {
    const page = imprintPage(mask, Pw, Ph, takenAt);
    const H = page.height;
    const raster = packPrintBits(page.mask, Pw, H);
    const png = await encodeOneBitPng(page.mask, Pw, H, deflate);
    signal?.throwIfAborted();
    const header = readPngHeader(png);
    return Object.freeze({
      width: Pw, height: H, bytesPerRow: raster.bytesPerRow, bits: raster.bits, png: createBlob(png),
      pngBytes: png.length, pngBitDepth: header?.bitDepth ?? null, pngColorType: header?.colorType ?? null,
      blackRatio: raster.black / (Pw * H),
      layout: page.layout, photo: page.photo, takenAt, fontsReady: page.fontsReady ?? null, imprintError: page.imprintError ?? '',
    });
  }

  /**
   * 감열지 결과: 마스크 → (a) 인쇄 데이터(래스터 비트·1비트 PNG), (b) 화면용 캔버스(결과 크기 Dw×Dh로 확대, 종이색·잉크색).
   * PNG 압축은 비동기이고, 화면 크기 확대는 줄 묶음(UPSCALE_BAND)마다 작업을 양보한다(촬영 순간 화면이 끊기지 않게).
   * 그 사이 회차가 취소되면 화면용 캔버스를 만들지 않고 예외. dots: 화면용 사진이 1비트 점 그림이라는 표시(결과 화면이 1:1로 놓는다)
   */
  async function thermalResult(mask, Pw, Ph, Dw, Dh, signal, takenAt) {
    const print = await printData(mask, Pw, Ph, signal, takenAt);
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
      layout: print.layout, photoTop: print.photo.top, photoHeight: print.photo.height, photoLeft: print.photo.left ?? 0,
      photoWidth: print.photo.width ?? print.width, fontsReady: print.fontsReady,
      imprintError: print.imprintError,
    };
  }

  // 효과를 그리지 못했을 때: 원본 사진에 같은 출력 단계를 CPU로 (감열지면 인쇄 데이터도). 실패하면 원본 컬러 사진.
  // 흑백 스타일(7-1)은 쓰지 않는다: 획·흐름장·획 볼록이 없으므로 톤 점(설정한 점 방식)으로 찍는다
  async function rawResult(canvas, settings, reason, t0, signal, takenAt) {
    log.warn('effect-capture', `photo effect not applied -> raw photo (${reason})`);
    fellBack += 1;
    const mode = settings.outputMode ?? 'off';
    try {
      if (mode === 'thermal') {
        const size = resultSizeFor(canvas.width, canvas.height);
        const { width: Pw, height: Ph } = printSizeFor(settings.paperDots, size.width, size.height);
        const gray = reduceToPrintGray(readRgba(canvas), canvas.width, canvas.height, Pw, Ph, settings);
        const out = await thermalResult(dither(gray, Pw, Ph, settings.dither), Pw, Ph, size.width, size.height, signal, takenAt);
        const style = bwStyleOf(settings) !== 'tone' ? ` (style ${bwStyleOf(settings)} -> tone)` : toneOilBlend(settings) > 0 ? ' (tone oil blend -> tone)' : '';
        last = { status: 'raw', mode, reason: `${reason}${style}`, width: Pw, height: Ph, dither: settings.dither, print: describePrint(out.print), ms: now() - t0 };
        return out;
      }
      if (mode === 'gray-oil') return await rawGrayOil(canvas, settings, reason, t0, signal, takenAt);
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
  async function rawGrayOil(canvas, settings, reason, t0, signal, takenAt) {
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
      print = await printData(dither(gray, Pw, Ph, settings.dither), Pw, Ph, signal, takenAt);
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
  async function applyEffect(canvas, signal, takenAt) {
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
      lastOil = preview.getSettings().oil !== false;
      return rawResult(canvas, preview.getSettings(), error?.message ?? String(error), t0, signal, takenAt);
    }
    lastOil = still.settings.oil !== false; // 시험 조합 (WISHFUL 시안): 그 그림이 유화를 썼는지 (D photo-fx)
    const base = { seed: still.seed, tick: still.tick, sameAsPreview: still.sameAsPreview, renderMs: still.ms }; // renderMs: 동기 구간(셔터 순간)
    if (still.mode !== 'thermal') {
      let output;
      try {
        output = newCanvas(still.width, still.height, (context) => {
          context.putImageData(createImageData(still.pixels, still.width, still.height), 0, 0);
        });
      } catch (error) {
        return rawResult(canvas, still.settings, error?.message ?? String(error), t0, signal, takenAt);
      }
      if (still.mode === 'gray-oil') return grayOilResult(output, still, base, t0, signal, takenAt);
      applied += 1;
      last = { status: 'applied', mode: still.mode, width: still.width, height: still.height, ...base, ms: now() - t0 };
      log.clear('effect-capture');
      return output;
    }

    // 감열지: 화면에 보이던 점 그림(GPU 디더면 GPU가 만든 마스크)이 정본이다
    const { mask, printWidth: Pw, printHeight: Ph } = still;
    const method = screenOf(still.settings); // 점 방식, 또는 흐름 선·붓 결 선 (7-1)·톤 점 × 유화 (14단계)
    // 흐름 선·붓 결 선·톤 점 × 유화는 GPU가 만든 점별 문턱(thr)으로 비교만 다시 한다(문턱 자체는 획·흐름장에서 GPU로만 만든다)
    const check = checkGpuDither(still, method, 'thermal');
    try {
      const out = await thermalResult(mask, Pw, Ph, still.width, still.height, signal, takenAt);
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
   * GPU 인쇄 단계가 실패했으면(still.printError, 8단계 검수 1) 확정된 사진 화소에서 CPU로 같은 계산(면적 평균 → 점 방식)을 해 대신한다:
   * 사진은 이미 회색조·레벨을 입혔으므로 중립 레벨로 줄이면 GPU 경로와 회색이 ±1 안에서 같고, 인쇄 데이터가 화면 사진과 맞는다.
   * 인쇄 처리(GPU = CPU 확인·비트 묶기·PNG) 전에 작업을 한 번 양보한다: 셔터 순간의 동기 구간(효과 렌더·화소 읽기·결과 캔버스)과
   * 한 작업으로 이어지면 실제 OBS에서 50ms 긴 작업이 생겼다. 그 사이 회차가 취소되면 사진 캔버스를 비우고 예외
   */
  async function grayOilResult(output, still, base, t0, signal, takenAt) {
    const method = still.settings.dither;
    let print = null;
    let check = null;
    let printError = '';
    let printFallback = '';
    try {
      await yieldTask();
      signal?.throwIfAborted();
      let mask = still.mask;
      let size = { width: still.printWidth, height: still.printHeight };
      if (still.printError || !mask) {
        printFallback = still.printError || 'no print mask from renderer';
        log.warn('effect-capture', `GPU print data failed -> print data from photo on CPU (${printFallback})`);
        size = printSizeFor(still.settings.paperDots, still.width, still.height);
        const gray = reduceToPrintGray(still.pixels, still.width, still.height, size.width, size.height, NEUTRAL_LEVELS);
        mask = dither(gray, size.width, size.height, method);
        check = 'cpu from photo';
      } else {
        check = checkGpuDither(still, method, 'print');
      }
      print = await printData(mask, size.width, size.height, signal, takenAt);
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
      check: print ? check : 'no print data', print: print ? describePrint(print) : null, printError, printFallback, ms: now() - t0,
    };
    if (!printError && !printFallback) log.clear('effect-capture');
    return print ? { canvas: output, print } : output;
  }

  /**
   * 사진 틀 (IMPRINT 시안, 16단계 사방): 효과 단계가 만든 화면용 사진(9:16 전체)에서 틀 직사각형만 새 캔버스로 남긴다. 들어온 캔버스(capture.js 원본)가 아닌
   * 앞 단계 캔버스는 비운다. 자르기 캔버스를 만들지 못하면 9:16 그대로 둔다(경고) — 관람객 화면은 같은 줄을 CSS(object-position)로 보인다.
   * 사진에 { canvas, … }가 붙어 있으면 canvas만 바꾼다
   */
  function framed(produced, input) {
    if (isFullFrame(frame)) return produced;
    const isWrapped = produced && typeof produced === 'object' && 'canvas' in produced;
    const source = isWrapped ? produced.canvas : produced;
    const rect = photoFrameRect(source.width, source.height, frame);
    let cropped;
    try {
      cropped = newCanvas(rect.width, rect.height, (context) => {
        context.drawImage(source, rect.left, rect.top, rect.width, rect.height, 0, 0, rect.width, rect.height);
      });
    } catch (error) {
      log.warn('effect-capture', `photo frame crop failed -> full 9:16 photo (${error?.message ?? error})`);
      if (last) last = { ...last, frame: `uncropped ${source.width}x${source.height}` };
      return produced;
    }
    if (source !== input) free(source);
    if (last) last = { ...last, frame: `${cropped.width}x${cropped.height} cols ${rect.left}-${rect.left + rect.width} rows ${rect.top}-${rect.top + rect.height}` };
    return isWrapped ? { ...produced, canvas: cropped } : cropped;
  }

  /**
   * @param {HTMLCanvasElement} canvas capture.js가 잡은 원본 사진 (보이는 9:16 영역, 원본 해상도, 반전)
   * @param {{ signal?: AbortSignal, takenAt?: number }} [options] takenAt: 셔터 순간 시각(Date.now() 기준). 인쇄 쪽 머리에 찍힌다
   * @returns 위 applyEffect의 결과를 사진 틀로 자른 것
   */
  async function apply(canvas, { signal, takenAt = clock() } = {}) {
    // 취소는 capture.js가 기다리지 않고 처리하고 늦게 온 캔버스를 비운다 (여기서 예외로 바꾸면 그 캔버스를 놓친다)
    return framed(await applyEffect(canvas, signal, takenAt), canvas);
  }

  return {
    apply,
    /** D 화면용: 마지막 결과의 효과 상태와 누적 수 */
    getStats: () => ({ last: last && last.status !== 'disabled' ? { ...last, oil: lastOil } : last, applied, fellBack }),
  };
}
