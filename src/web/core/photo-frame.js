// 사진 틀 (IMPRINT 시안, 채택 전): 9:16 화면 안에서 실제로 찍히는 영역 (config.photoFrame, 화면 폭 전체 × 높이의 일부).
// 결과 사진·인쇄 데이터는 이 줄 범위로 자르고(effect/photo-effect.js), 인식 영역은 이 틀 안으로 줄인다(main.js).
// 관람객 화면은 같은 비율을 CSS 변수로 받아 틀 밖 여백에만 글자를 둔다. 순수 함수. Node 테스트: test/core/photo-frame.test.mjs

/** 틀이 화면 전체(자르지 않음)인지 */
export const isFullFrame = (frame) => !frame || (frame.top === 0 && frame.height === 1);

/**
 * 높이 height(줄)인 화면 그림에서 틀이 덮는 줄 범위. 위·아래 끝을 각각 반올림한다
 * (1920 → 210~1560, 1024 → 112~832, 3840 → 420~3120, 683 → 75~555). frame이 없으면 전체
 * @returns {{ top: number, height: number }}
 */
export function photoFrameRows(height, frame) {
  if (isFullFrame(frame)) return Object.freeze({ top: 0, height });
  const top = Math.min(height - 1, Math.max(0, Math.round(height * frame.top)));
  const bottom = Math.min(height, Math.max(top + 1, Math.round(height * (frame.top + frame.height))));
  return Object.freeze({ top, height: bottom - top });
}

/** 틀의 가로:세로 비 (화면 비 stageAspect = 가로/세로). 9:16 화면에서 45/64면 4:5 = 0.8 */
export const photoFrameAspect = (stageAspect, frame) => (isFullFrame(frame) ? stageAspect : stageAspect / frame.height);

/**
 * 인식 영역(화면 좌표)을 사진 틀 안으로 줄인다: 틀 밖에 얼굴 중심이 있으면 사진에 얼굴이 없으므로 인정하지 않는다.
 * 겹치지 않으면 틀 끝에 붙은 높이 0 영역(아무도 인정되지 않음). clipped: 줄었는지 (D 화면)
 * @returns {{ region: {x: number, y: number, width: number, height: number}, clipped: boolean }}
 */
export function clipRegionToFrame(region, frame) {
  if (isFullFrame(frame)) return { region, clipped: false };
  const top = Math.max(region.y, frame.top);
  const bottom = Math.min(region.y + region.height, frame.top + frame.height);
  if (top === region.y && bottom === region.y + region.height) return { region, clipped: false };
  const y = Math.min(top, frame.top + frame.height);
  return { region: Object.freeze({ x: region.x, y, width: region.width, height: Math.max(0, bottom - y) }), clipped: true };
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
