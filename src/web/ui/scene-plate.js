// 관람객 화면 장면 (14단계, 가안): 생성 장면 이미지 한 장을 9:16 캔버스(#scene-plate)에 그리고, 사진 창 줄에서만 단색 그린을 빼서
// 카메라·결과가 비쳐 보이게 한다 (config.scene). 이미지는 처음 한 번만 처리하고 그 뒤 그리지 않는다(미리보기·감지 성능과 무관).
// 15단계: 장면 전체(배경·캐릭터·창틀·눈벽·바닥)에 유화를 한 번 입힌다(paint, main.js가 effect/scene-paint.js를 넘긴다).
//   키 알파를 먼저 구해 두고, 창 자리 색을 중립 밤빛으로 채운 불투명 그림을 칠한 뒤 알파를 다시 씌운다(그린이 획으로 번지지 않게).
//   칠하기는 카메라 효과와 다른 렌더러·설정이라 카메라 미리보기·결과·인쇄에 겹쳐 적용되지 않는다. 실패하면 칠하지 않은 장면을 쓴다.
// 장면은 화면 장식이라 촬영 사진·인쇄 데이터 경로(capture·photo-effect)와 만나지 않는다.
// 못 읽거나 처리하지 못하면 캔버스를 숨긴 채 둔다(CSS 대체 배경과 글자만 보인다). Node 테스트: test/ui/scene-plate.test.mjs

import { applyGreenKey } from '../core/chroma-key.js';
import { photoFrameRows } from '../core/photo-frame.js';

// 칠하기 전에 창 자리(키로 빠지는 화소)를 채우는 색: 장면 밤빛에 가까운 중립색 (가장자리 획이 이 색과 섞인다)
export const PAINT_FILL = Object.freeze([46, 44, 86]);

/**
 * 띠 맞춤(config.scene.layout)을 원본 줄 단위로: 위 띠 원본 [0, topCut)을 topShift만큼, 아래 띠 원본 [bottomCut, height)를 bottomShift만큼 옮긴다.
 * 비율은 장면 높이 height 기준으로 반올림한다. layout이 없으면 null(그대로 그린다). 순수 함수
 */
export function bandPlacement(height, layout) {
  if (!layout) return null;
  const r = (f) => Math.round(height * f);
  const topCut = Math.min(height, Math.max(0, r(layout.topCut)));
  const bottomCut = Math.min(height, Math.max(topCut, r(layout.bottomCut)));
  return Object.freeze({ topCut, topShift: r(layout.topShift), bottomCut, bottomShift: r(layout.bottomShift) });
}

/** 장면 높이 height에서 키를 뺄 줄 범위: 사진 틀 줄 ± marginFrac (화면 안으로 자른다) */
export function keyRows(height, frame, marginFrac) {
  const rows = photoFrameRows(height, frame);
  const margin = Math.round(height * marginFrac);
  const top = Math.max(0, rows.top - margin);
  const bottom = Math.min(height, rows.top + rows.height + margin);
  return Object.freeze({ top, height: bottom - top });
}

/**
 * 칠할 그림 준비 (제자리): 키로 반투명·투명이 된 화소의 색을 알파만큼 fill 쪽으로 섞고 알파를 255로 (불투명 그림). 순수 함수
 * @param {Uint8ClampedArray} data RGBA
 */
export function flattenForPaint(data, fill = PAINT_FILL) {
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 255) continue;
    const t = a / 255;
    for (let c = 0; c < 3; c += 1) data[i + c] = Math.round(data[i + c] * t + fill[c] * (1 - t));
    data[i + 3] = 255;
  }
}

/**
 * @param {{ canvas: HTMLCanvasElement, src: string, frame: { top: number, height: number },
 *   key: { low: number, high: number }, keyMarginFrac: number,
 *   layout?: { topCut: number, topShift: number, bottomCut: number, bottomShift: number } | null,
 *   size?: { width: number, height: number } | null,
 *   paint?: ((source: HTMLCanvasElement, width: number, height: number) => Promise<Uint8ClampedArray>) | null,
 *   loadImage?: (src: string) => Promise<CanvasImageSource & { width: number, height: number }> }} options
 *   size: 그리는 크기(기본: 이미지 크기). 띠 맞춤은 이 높이 기준. paint: 불투명 RGBA 그림(캔버스)을 받아 같은 크기의 칠한 RGBA(위 줄부터)를 돌려준다
 * @returns {{ ready: Promise<{ ok: boolean, width?: number, height?: number, keyed?: { top: number, height: number }, cleared?: number,
 *   edge?: number, despilled?: number, painted?: boolean, paintMs?: number, paintError?: string, error?: string }> }}
 */
export function createScenePlate({
  canvas, src, frame, key, keyMarginFrac, layout = null, size = null, paint = null, loadImage = defaultLoadImage,
}) {
  canvas.hidden = true;
  const ready = loadImage(src).then(async (image) => {
    const width = size?.width ?? image.width;
    const height = size?.height ?? image.height;
    const sy = (row) => Math.round((row * image.height) / height); // 그리는 줄 → 원본 줄
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const bands = bandPlacement(height, layout);
    if (bands) {
      // 가운데는 그린(키로 빠진다), 위·아래 띠만 옮겨 그린다 (크기 그대로)
      ctx.fillStyle = '#00ff00';
      ctx.fillRect(0, 0, width, height);
      if (bands.topCut > 0) ctx.drawImage(image, 0, 0, image.width, sy(bands.topCut), 0, bands.topShift, width, bands.topCut);
      const rest = height - bands.bottomCut;
      if (rest > 0) {
        ctx.drawImage(image, 0, sy(bands.bottomCut), image.width, image.height - sy(bands.bottomCut),
          0, bands.bottomCut + bands.bottomShift, width, rest);
      }
    } else {
      ctx.drawImage(image, 0, 0, width, height);
    }
    const rows = keyRows(height, frame, keyMarginFrac);
    const keyed = ctx.getImageData(0, rows.top, width, rows.height);
    const counts = applyGreenKey(keyed.data, key, width);
    let painted = false;
    let paintMs;
    let paintError;
    if (paint) {
      try {
        const t0 = performance.now();
        const alpha = keyed.data.filter((_, i) => i % 4 === 3);
        const flat = new Uint8ClampedArray(keyed.data);
        flattenForPaint(flat);
        ctx.putImageData(new ImageData(flat, width, rows.height), 0, rows.top);
        const out = await paint(canvas, width, height);
        if (!out || out.length !== width * height * 4) throw new Error(`painted size ${out?.length} != ${width * height * 4}`);
        for (let p = 0; p < alpha.length; p += 1) out[(rows.top * width + p) * 4 + 3] = alpha[p];
        ctx.putImageData(new ImageData(out, width, height), 0, 0);
        painted = true;
        paintMs = Math.round(performance.now() - t0);
      } catch (error) {
        paintError = String(error?.message ?? error);
      }
    }
    if (!painted) ctx.putImageData(keyed, 0, rows.top);
    canvas.hidden = false;
    return { ok: true, width, height, bands, keyed: rows, ...counts, painted, ...(paintMs === undefined ? {} : { paintMs }), ...(paintError ? { paintError } : {}) };
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
