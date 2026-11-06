// 관람객 화면 장면 (14단계, 가안): 생성 장면 이미지 한 장을 9:16 캔버스(#scene-plate)에 그리고, 사진 창 줄에서만 단색 그린을 빼서
// 카메라·결과가 비쳐 보이게 한다 (config.scene). 이미지는 처음 한 번만 처리하고 그 뒤 그리지 않는다(미리보기·감지 성능과 무관).
// 장면은 화면 장식이라 촬영 사진·인쇄 데이터 경로(capture·photo-effect)와 만나지 않는다.
// 못 읽거나 처리하지 못하면 캔버스를 숨긴 채 둔다(CSS 대체 배경과 글자만 보인다). Node 테스트: test/ui/scene-plate.test.mjs

import { applyGreenKey } from '../core/chroma-key.js';
import { photoFrameRows } from '../core/photo-frame.js';

/** 장면 높이 height에서 키를 뺄 줄 범위: 사진 틀 줄 ± marginFrac (화면 안으로 자른다) */
export function keyRows(height, frame, marginFrac) {
  const rows = photoFrameRows(height, frame);
  const margin = Math.round(height * marginFrac);
  const top = Math.max(0, rows.top - margin);
  const bottom = Math.min(height, rows.top + rows.height + margin);
  return Object.freeze({ top, height: bottom - top });
}

/**
 * @param {{ canvas: HTMLCanvasElement, src: string, frame: { top: number, height: number },
 *   key: { low: number, high: number }, keyMarginFrac: number, loadImage?: (src: string) => Promise<CanvasImageSource & { width: number, height: number }> }} options
 * @returns {{ ready: Promise<{ ok: boolean, width?: number, height?: number, keyed?: { top: number, height: number }, cleared?: number, edge?: number, despilled?: number, error?: string }> }}
 */
export function createScenePlate({ canvas, src, frame, key, keyMarginFrac, loadImage = defaultLoadImage }) {
  canvas.hidden = true;
  const ready = loadImage(src).then((image) => {
    const { width, height } = image;
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(image, 0, 0);
    const rows = keyRows(height, frame, keyMarginFrac);
    const pixels = ctx.getImageData(0, rows.top, width, rows.height);
    const counts = applyGreenKey(pixels.data, key, width);
    ctx.putImageData(pixels, 0, rows.top);
    canvas.hidden = false;
    return { ok: true, width, height, keyed: rows, ...counts };
  }).catch((error) => ({ ok: false, error: String(error?.message ?? error) }));
  return { ready };
}

function defaultLoadImage(src) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`scene image failed: ${src}`));
    image.src = src;
  });
}
