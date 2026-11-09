// 관람객 화면 장면 (14단계, 가안): 생성 장면 이미지 한 장을 9:16 캔버스(#scene-plate)에 그리고, 사진 창 자리에서만 단색 그린을 빼서
// 카메라·결과가 비쳐 보이게 한다 (config.scene). 이미지는 처음 한 번만 처리하고 그 뒤 그리지 않는다(미리보기·감지 성능과 무관).
// 17단계: 장면은 필터 없는 생성 원본 그대로 그린다. 유화는 effect/screen-compositor.js가 합성된 화면 전체에 마지막에 한 번 입힌다(여기서 굽지 않는다).
// 16단계: 사방 나무틀. 생성 이미지의 그린 개구부를 균일 배율로 사진 틀 높이에 맞추고(fit), 틀 밖에 남은 그린은 나무틀을 거울로 이어 채운다.
//   키는 사진 틀 직사각형 ± 여유에서만 뺀다(좌우 기둥·여백 배경은 키 밖).
// 장면은 화면 장식이라 촬영 사진·인쇄 데이터 경로(capture·photo-effect)와 만나지 않는다.
// 못 읽거나 처리하지 못하면 캔버스를 숨긴 채 둔다(CSS 대체 배경과 글자만 보인다). Node 테스트: test/ui/scene-plate.test.mjs

import { applyGreenKey } from '../core/chroma-key.js';
import { photoFrameRect } from '../core/photo-frame.js';

/**
 * 띠 맞춤(14단계 config.scene.layout)을 원본 줄 단위로: 위 띠 원본 [0, topCut)을 topShift만큼, 아래 띠 원본 [bottomCut, height)를 bottomShift만큼 옮긴다.
 * 비율은 장면 높이 height 기준으로 반올림한다. layout이 없으면 null(그대로 그린다). 순수 함수
 */
export function bandPlacement(height, layout) {
  if (!layout || layout.fit) return null;
  const r = (f) => Math.round(height * f);
  const topCut = Math.min(height, Math.max(0, r(layout.topCut)));
  const bottomCut = Math.min(height, Math.max(topCut, r(layout.bottomCut)));
  return Object.freeze({ topCut, topShift: r(layout.topShift), bottomCut, bottomShift: r(layout.bottomShift) });
}

/**
 * 맞춤 (16단계, config.scene.layout.fit): 생성 이미지의 그린 개구부(이미지 비율 left·top·right·bottom, right·bottom은 끝 다음)를
 * 균일 배율로 사진 틀 높이에 맞추고 가로는 가운데를 맞춘다(찌그러뜨리지 않는다). 개구부 비율이 틀과 다르면 좌우(또는 위아래)에
 * 그린이 남는데, 그건 fillFrameGap이 나무틀을 거울로 이어 채운다. 순수 함수
 * @returns {{ x: number, y: number, width: number, height: number, scale: number }} 캔버스에 그릴 이미지 자리(화소)
 */
export function fitPlacement(imageWidth, imageHeight, frameRect, fit) {
  const scale = frameRect.height / ((fit.bottom - fit.top) * imageHeight);
  const greenCenter = ((fit.left + fit.right) / 2) * imageWidth;
  const x = frameRect.left + frameRect.width / 2 - greenCenter * scale;
  const y = frameRect.top - fit.top * imageHeight * scale;
  return Object.freeze({ x, y, width: imageWidth * scale, height: imageHeight * scale, scale });
}

/**
 * 장면(width × height)에서 키를 뺄 직사각형: 사진 틀 ± 여유(장면 높이 × marginFrac 화소, 가로·세로 같은 화소, 화면 안으로 자른다).
 * 16단계부터 틀이 사방 inset이라 좌우 기둥·여백 배경은 키 밖이다
 * @returns {{ left: number, top: number, width: number, height: number }}
 */
export function keyRect(width, height, frame, marginFrac) {
  const r = photoFrameRect(width, height, frame);
  const m = Math.round(height * marginFrac);
  const left = Math.max(0, r.left - m);
  const top = Math.max(0, r.top - m);
  const right = Math.min(width, r.left + r.width + m);
  const bottom = Math.min(height, r.top + r.height + m);
  return Object.freeze({ left, top, width: right - left, height: bottom - top });
}

// 틀 밖 채우기에서 "그린"으로 보는 기준: 키의 low 이상(반투명 가장자리 포함)이면 그린. 축이 되는 나무는 그린 기가 없는 화소다
const isGapGreen = (data, i, key) => data[i + 1] - Math.max(data[i], data[i + 2]) > key.low;

const median = (values) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((p, q) => p - q);
  return sorted[Math.floor(sorted.length / 2)];
};

/**
 * 사진 틀 밖에 남은 그린(생성 개구부가 틀보다 넓은 곳)을 바로 바깥 나무틀을 거울로 이어 채운다 (제자리, 전체 RGBA, 순수 함수).
 * 변마다 나무 안쪽 경계 한 줄·열을 먼저 정한다: 틀 가장자리부터 바깥쪽(margin 안)으로 그린이 이어지다 처음 그린이 아닌 곳을 줄(열)마다 재서
 * 가운데값을 쓴다(캐릭터가 걸친 줄 때문에 흔들리지 않게). 그 경계와 틀 사이의 그린 화소를 경계 축 거울 자리에서 복사한다.
 * 캐릭터 화소(그린 아님)는 그대로 둔다. 끝으로 채운 띠와 축 둘레의 초록 기를 누른다. 채운 화소 수와 변별 경계를 돌려준다
 */
export function fillFrameGap(data, width, height, rect, key, margin) {
  let filled = 0;
  const right = rect.left + rect.width;
  const bottom = rect.top + rect.height;
  const at = (x, y) => (y * width + x) * 4;
  const green = (x, y) => isGapGreen(data, at(x, y), key);
  // 한 변: 틀 안쪽 경계 start에서 dir 방향(바깥)으로 margin까지, cross 범위의 줄(열)마다 처음 그린 아닌 위치
  const findEdge = (horizontal, start, dir, crossFrom, crossTo, limit) => {
    const found = [];
    for (let c = crossFrom; c < crossTo; c += 1) {
      let v = start;
      let steps = 0;
      while (v >= 0 && v < limit && steps < margin && (horizontal ? green(v, c) : green(c, v))) { v += dir; steps += 1; }
      if (steps > 0 && steps < margin && v >= 0 && v < limit) found.push(v);
    }
    return median(found);
  };
  const edges = {
    left: findEdge(true, rect.left - 1, -1, rect.top, bottom, width),
    right: findEdge(true, right, 1, rect.top, bottom, width),
    top: findEdge(false, rect.top - 1, -1, rect.left, right, height),
    bottom: findEdge(false, bottom, 1, rect.left, right, height),
  };
  const fill = (x, y, sx, sy) => {
    if (!green(x, y) || sx < 0 || sy < 0 || sx >= width || sy >= height || green(sx, sy)) return;
    data.set(data.subarray(at(sx, sy), at(sx, sy) + 4), at(x, y));
    filled += 1;
  };
  for (let y = Math.max(0, rect.top - margin); y < Math.min(height, bottom + margin); y += 1) {
    if (edges.left !== null) for (let x = edges.left + 1; x < rect.left; x += 1) fill(x, y, 2 * edges.left - x, y);
    if (edges.right !== null) for (let x = right; x < edges.right; x += 1) fill(x, y, 2 * edges.right - x, y);
  }
  for (let x = Math.max(0, rect.left - margin); x < Math.min(width, right + margin); x += 1) {
    if (edges.top !== null) for (let y = edges.top + 1; y < rect.top; y += 1) fill(x, y, x, 2 * edges.top - y);
    if (edges.bottom !== null) for (let y = bottom; y < edges.bottom; y += 1) fill(x, y, x, 2 * edges.bottom - y);
  }
  // 채운 띠와 축 둘레(±RIM)의 초록 기(원본 가장자리 화소, 캐릭터 털 테)를 (R+B)/2로 누른다 — 유화로 칠하면 초록 줄로 번진다
  const RIM = 3;
  const despill = (x, y) => {
    const i = at(x, y);
    const avg = Math.round((data[i] + data[i + 2]) / 2);
    if (data[i + 1] > avg) data[i + 1] = avg;
  };
  for (let y = Math.max(0, rect.top - margin); y < Math.min(height, bottom + margin); y += 1) {
    if (edges.left !== null) for (let x = Math.max(0, edges.left - RIM); x < rect.left; x += 1) despill(x, y);
    if (edges.right !== null) for (let x = right; x < Math.min(width, edges.right + RIM + 1); x += 1) despill(x, y);
  }
  for (let x = Math.max(0, rect.left - margin); x < Math.min(width, right + margin); x += 1) {
    if (edges.top !== null) for (let y = Math.max(0, edges.top - RIM); y < rect.top; y += 1) despill(x, y);
    if (edges.bottom !== null) for (let y = bottom; y < Math.min(height, edges.bottom + RIM + 1); y += 1) despill(x, y);
  }
  return { filled, edges };
}

/**
 * 사진 틀 밖은 늘 불투명 (16단계): 키 직사각형 중 틀 밖 화소의 알파를 255로 되돌리고 남은 초록 기를 (R+B)/2로 누른다.
 * 틀 밖에서 카메라가 비쳐 보이지 않게 한다(채우기가 못 메운 화소의 안전장치). part는 keyRect의 RGBA. 고친 화소 수를 돌려준다
 */
export function sealOutsideFrame(part, keyed, frameRect) {
  let sealed = 0;
  for (let y = 0; y < keyed.height; y += 1) {
    const sy = keyed.top + y;
    for (let x = 0; x < keyed.width; x += 1) {
      const sx = keyed.left + x;
      if (sx >= frameRect.left && sx < frameRect.left + frameRect.width && sy >= frameRect.top && sy < frameRect.top + frameRect.height) continue;
      const i = (y * keyed.width + x) * 4;
      if (part[i + 3] === 255) continue;
      part[i + 1] = Math.min(part[i + 1], Math.round((part[i] + part[i + 2]) / 2));
      part[i + 3] = 255;
      sealed += 1;
    }
  }
  return sealed;
}

/** 전체 RGBA(폭 width)에서 직사각형 rect를 새 배열로 */
function readRect(data, width, rect) {
  const out = new Uint8ClampedArray(rect.width * rect.height * 4);
  for (let y = 0; y < rect.height; y += 1) {
    const from = ((rect.top + y) * width + rect.left) * 4;
    out.set(data.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }
  return out;
}

/** 전체 RGBA(폭 width)의 직사각형 rect에 part를 넣는다 */
function writeRect(data, width, rect, part) {
  for (let y = 0; y < rect.height; y += 1) {
    data.set(part.subarray(y * rect.width * 4, (y + 1) * rect.width * 4), ((rect.top + y) * width + rect.left) * 4);
  }
}

/**
 * @param {{ canvas: HTMLCanvasElement, src: string, frame: { left?: number, top: number, width?: number, height: number },
 *   key: { low: number, high: number }, keyMarginFrac: number,
 *   layout?: { fit: { left: number, top: number, right: number, bottom: number } }
 *     | { topCut: number, topShift: number, bottomCut: number, bottomShift: number } | null,
 *   size?: { width: number, height: number } | null,
 *   loadImage?: (src: string) => Promise<CanvasImageSource & { width: number, height: number }> }} options
 *   size: 그리는 크기(기본: 이미지 크기). layout: 16단계 맞춤(fit) 또는 14단계 띠 맞춤.
 * @returns {{ ready: Promise<{ ok: boolean, width?: number, height?: number, keyed?: { left: number, top: number, width: number, height: number },
 *   cleared?: number, edge?: number, despilled?: number, gapFilled?: number, gapEdges?: object, sealed?: number, fit?: object,
 *   error?: string }> }}
 */
export function createScenePlate({
  canvas, src, frame, key, keyMarginFrac, layout = null, size = null, loadImage = defaultLoadImage,
}) {
  canvas.hidden = true;
  const ready = loadImage(src).then(async (image) => {
    const width = size?.width ?? image.width;
    const height = size?.height ?? image.height;
    const sy = (row) => Math.round((row * image.height) / height); // 그리는 줄 → 원본 줄
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const frameRect = photoFrameRect(width, height, frame);
    const fit = layout?.fit ? fitPlacement(image.width, image.height, frameRect, layout.fit) : null;
    const bands = bandPlacement(height, layout);
    if (fit) {
      // 균일 배율·가운데 맞춤. 캔버스에 못 미치는 가장자리는 이미지를 거울로 뒤집어 잇는다 (눈 바닥·하늘)
      const draw = () => ctx.drawImage(image, fit.x, fit.y, fit.width, fit.height);
      const mirror = (sx, sy2, tx, ty) => { ctx.save(); ctx.translate(tx, ty); ctx.scale(sx, sy2); draw(); ctx.restore(); };
      draw();
      if (fit.y + fit.height < height) mirror(1, -1, 0, 2 * (fit.y + fit.height));
      if (fit.y > 0) mirror(1, -1, 0, 2 * fit.y);
      if (fit.x + fit.width < width) mirror(-1, 1, 2 * (fit.x + fit.width), 0);
      if (fit.x > 0) mirror(-1, 1, 2 * fit.x, 0);
    } else if (bands) {
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
    const all = ctx.getImageData(0, 0, width, height);
    const rect = keyRect(width, height, frame, keyMarginFrac);
    const gap = fit ? fillFrameGap(all.data, width, height, frameRect, key, Math.round(height * keyMarginFrac) * 3) : null;
    const keyed = readRect(all.data, width, rect);
    const counts = applyGreenKey(keyed, key, rect.width);
    const sealed = fit ? sealOutsideFrame(keyed, rect, frameRect) : 0;
    writeRect(all.data, width, rect, keyed);
    ctx.putImageData(all, 0, 0);
    canvas.hidden = false;
    return {
      ok: true, width, height, bands, ...(fit ? { fit, gapFilled: gap.filled, gapEdges: gap.edges, sealed } : {}), keyed: rect, ...counts,
    };
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
