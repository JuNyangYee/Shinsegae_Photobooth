// 촬영 결과에 유화 효과를 입힌다 (camera/capture.js의 효과 단계 effect(canvas, { signal })에 넣는다, 5-2).
// 결과는 셔터 순간 화면에 보이던 미리보기 그림과 같은 그림이다: 같은 카메라 프레임·그림 번호·seed·설정으로
// 결과 크기(짧은 변 1080, 4K 입력도 1080x1920)에 화면 밖으로 다시 그린다 (effect-preview.js renderStill).
// 효과를 그리지 못하면 원본 사진(결과 크기로 줄임)으로 대신한다. 관람객 흐름을 끊지 않고 D 화면과 로그에만 남긴다.
// 이미지는 메모리에만 둔다. Node 테스트: test/effect/photo-effect.test.mjs
//
// 같은 프레임인 이유: capture.js는 프레임을 잡은 같은 작업의 마이크로태스크에서 이 함수를 부르고, 이 함수는 끝까지 동기다.
// 미리보기는 requestAnimationFrame에서만 새 프레임을 올리므로 그 사이에 소스 텍스처가 바뀌지 않는다.

import { errorLog } from '../core/log-limit.js';
import { resultSizeFor } from '../core/oil-paint.js';

/**
 * @param {{ preview: { isEnabled: () => boolean, renderStill: Function },
 *   createCanvas?: () => HTMLCanvasElement, createImageData?: (pixels: Uint8ClampedArray, w: number, h: number) => ImageData,
 *   log?: { warn: Function, clear: Function }, now?: () => number }} options
 */
export function createPhotoEffect({
  preview,
  createCanvas = () => document.createElement('canvas'),
  createImageData = (pixels, w, h) => new ImageData(pixels, w, h),
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

  /**
   * @param {HTMLCanvasElement} canvas capture.js가 잡은 원본 사진 (보이는 9:16 영역, 원본 해상도, 반전)
   * @returns {HTMLCanvasElement} 효과 사진(새 캔버스) 또는 원본 사진. 새 캔버스는 capture.js가 정리한다
   */
  function apply(canvas, { signal } = {}) {
    signal?.throwIfAborted();
    if (!preview.isEnabled()) {
      last = { status: 'disabled' };
      return canvas;
    }
    const t0 = now();
    try {
      const still = preview.renderStill();
      const output = newCanvas(still.width, still.height, (context) => {
        context.putImageData(createImageData(still.pixels, still.width, still.height), 0, 0);
      });
      applied += 1;
      last = {
        status: 'applied', width: still.width, height: still.height, seed: still.seed, tick: still.tick,
        sameAsPreview: still.sameAsPreview, ms: now() - t0,
      };
      log.clear('effect-capture');
      return output;
    } catch (error) {
      const reason = error?.message ?? String(error);
      log.warn('effect-capture', `photo effect not applied -> raw photo (${reason})`);
      fellBack += 1;
      const raw = rawAtResultSize(canvas);
      last = { status: 'raw', reason, width: raw.width, height: raw.height, ms: now() - t0 };
      return raw;
    }
  }

  return {
    apply,
    /** D 화면용: 마지막 결과의 효과 상태와 누적 수 */
    getStats: () => ({ last, applied, fellBack }),
  };
}
