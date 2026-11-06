// 사진 틀 (IMPRINT에서 도입, 16단계부터 사방 inset): 9:16 화면 안에서 실제로 찍히는 직사각형 (config.photoFrame, 화면 비율 left·top·width·height).
// left·width가 없으면 화면 폭 전체(예전 틀). 결과 사진·인쇄 데이터는 이 열·줄 범위로 자르고(effect/photo-effect.js),
// 인식 영역은 이 틀 안으로 줄인다(main.js). 관람객 화면은 같은 비율을 CSS 변수로 받아 창·장면 키를 맞춘다. 순수 함수. Node 테스트: test/core/photo-frame.test.mjs

/** left·width를 채운 틀 (없으면 0·1) */
const edges = (frame) => ({ left: frame.left ?? 0, top: frame.top, width: frame.width ?? 1, height: frame.height });

/** 틀이 화면 전체(자르지 않음)인지 */
export const isFullFrame = (frame) => !frame || (frame.top === 0 && frame.height === 1 && (frame.left ?? 0) === 0 && (frame.width ?? 1) === 1);

/** 길이 size인 축에서 비율 [start, start + length)이 덮는 범위. 두 끝을 각각 반올림한다 */
function span(size, start, length) {
  const a = Math.min(size - 1, Math.max(0, Math.round(size * start)));
  const b = Math.min(size, Math.max(a + 1, Math.round(size * (start + length))));
  return [a, b - a];
}

/**
 * 높이 height(줄)인 화면 그림에서 틀이 덮는 줄 범위. 위·아래 끝을 각각 반올림한다
 * (16단계 기본 3/16~3/4: 1920 → 360~1440, 1024 → 192~768, 3840 → 720~2880, 640 → 120~480). frame이 없으면 전체
 * @returns {{ top: number, height: number }}
 */
export function photoFrameRows(height, frame) {
  if (isFullFrame(frame)) return Object.freeze({ top: 0, height });
  const [top, h] = span(height, frame.top, frame.height);
  return Object.freeze({ top, height: h });
}

/**
 * 폭 width(열)인 화면 그림에서 틀이 덮는 열 범위 (16단계 기본 1/8~7/8: 1080 → 135~945, 576 → 72~504, 2160 → 270~1890, 360 → 45~315)
 * @returns {{ left: number, width: number }}
 */
export function photoFrameCols(width, frame) {
  if (isFullFrame(frame)) return Object.freeze({ left: 0, width });
  const e = edges(frame);
  const [left, w] = span(width, e.left, e.width);
  return Object.freeze({ left, width: w });
}

/** 화면 그림(width × height)에서 틀 직사각형 {left, top, width, height} (화소) */
export function photoFrameRect(width, height, frame) {
  const c = photoFrameCols(width, frame);
  const r = photoFrameRows(height, frame);
  return Object.freeze({ left: c.left, top: r.top, width: c.width, height: r.height });
}

/** 틀의 가로:세로 비 (화면 비 stageAspect = 가로/세로). 9:16 화면에서 3/4 × 9/16이면 3:4 = 0.75 */
export function photoFrameAspect(stageAspect, frame) {
  if (isFullFrame(frame)) return stageAspect;
  const e = edges(frame);
  return (stageAspect * e.width) / e.height;
}

/**
 * 인식 영역(화면 좌표)을 사진 틀 안으로 줄인다(가로·세로 모두): 틀 밖에 얼굴 중심이 있으면 사진에 얼굴이 없으므로 인정하지 않는다.
 * 겹치지 않으면 틀 끝에 붙은 넓이 0 영역(아무도 인정되지 않음). clipped: 줄었는지 (D 화면)
 * @returns {{ region: {x: number, y: number, width: number, height: number}, clipped: boolean }}
 */
export function clipRegionToFrame(region, frame) {
  if (isFullFrame(frame)) return { region, clipped: false };
  const e = edges(frame);
  const inside = (start, length, fStart, fLength) => start >= fStart && start + length <= fStart + fLength;
  if (inside(region.x, region.width, e.left, e.width) && inside(region.y, region.height, e.top, e.height)) return { region, clipped: false };
  const clip = (start, length, fStart, fLength) => {
    const a = Math.max(start, fStart);
    const b = Math.min(start + length, fStart + fLength);
    const s = Math.min(a, fStart + fLength);
    return [s, Math.max(0, b - s)];
  };
  const [x, w] = clip(region.x, region.width, e.left, e.width);
  const [y, h] = clip(region.y, region.height, e.top, e.height);
  if (x === region.x && w === region.width && y === region.y && h === region.height) return { region, clipped: false };
  return { region: Object.freeze({ x, y, width: w, height: h }), clipped: true };
}

/**
 * 한 줄에 width개씩 담긴 배열(마스크·회색, 화소당 1칸)에서 rows 범위만 새 배열로 복사한다.
 * @param {Uint8Array | Uint8ClampedArray} data
 * @param {number} width
 * @param {{ top: number, height: number }} rows
 */
export function cropRows(data, width, rows) {
  return data.slice(rows.top * width, (rows.top + rows.height) * width);
}

/** 한 줄에 width개씩 담긴 배열에서 직사각형 rect만 새 배열(rect.width × rect.height)로 복사한다 */
export function cropRect(data, width, rect) {
  if (rect.left === 0 && rect.width === width) return cropRows(data, width, rect);
  const out = new data.constructor(rect.width * rect.height);
  for (let y = 0; y < rect.height; y += 1) {
    const from = (rect.top + y) * width + rect.left;
    out.set(data.subarray(from, from + rect.width), y * rect.width);
  }
  return out;
}

/** 폭 width인 배열을 폭 toWidth로 넓힌다: left열부터 그대로 넣고 나머지는 fill (인쇄 쪽: 좁은 사진을 용지 가운데에 흰 여백과 함께) */
export function padColumns(data, width, height, toWidth, left, fill) {
  if (width === toWidth) return data;
  const out = new data.constructor(toWidth * height).fill(fill);
  for (let y = 0; y < height; y += 1) out.set(data.subarray(y * width, (y + 1) * width), y * toWidth + left);
  return out;
}
