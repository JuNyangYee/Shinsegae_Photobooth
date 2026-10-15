// 얼굴 감지 결과로 "인식됨 / 인식 안됨"을 판정한다.
// 브라우저 API를 쓰지 않는 순수 함수만 둔다. Node 테스트: tests/presence.test.mjs
//
// 좌표 기준 (모두 0~1 정규화, 왼쪽 위 원점)
// - 영상 좌표: 카메라 프레임 전체 기준, 반전 전. face-detector.js가 돌려주는 값.
// - 화면 좌표: 9:16 영역(#stage) 기준, 관람객이 보는 그대로(cover 크롭·좌우 반전 후).
//   인식 영역, 최소 얼굴 크기, 개발용 겹쳐 그리기는 모두 화면 좌표를 쓴다.

/**
 * 영상 좌표를 화면 좌표로 바꾸는 값을 만든다.
 * 미리보기는 `object-fit: cover`(가운데 기준)로 9:16 영역을 채우므로 영상의 가운데 부분만 보인다.
 * @returns {{ visibleWidth: number, visibleHeight: number, offsetX: number, offsetY: number, mirror: boolean } | null}
 */
export function computeCoverMapping({ videoWidth, videoHeight, stageAspect, mirror }) {
  if (!(videoWidth > 0 && videoHeight > 0 && stageAspect > 0)) return null;
  const videoAspect = videoWidth / videoHeight;
  // 화면에 보이는 영상 부분의 폭·높이 (영상 좌표 기준)
  const visibleWidth = videoAspect > stageAspect ? stageAspect / videoAspect : 1;
  const visibleHeight = videoAspect > stageAspect ? 1 : videoAspect / stageAspect;
  return Object.freeze({
    visibleWidth,
    visibleHeight,
    offsetX: (1 - visibleWidth) / 2,
    offsetY: (1 - visibleHeight) / 2,
    mirror: Boolean(mirror),
  });
}

/** 영상 좌표의 박스 { x, y, width, height }를 화면 좌표로 바꾼다. */
export function videoBoxToStage(box, mapping) {
  const width = box.width / mapping.visibleWidth;
  const height = box.height / mapping.visibleHeight;
  let x = (box.x - mapping.offsetX) / mapping.visibleWidth;
  const y = (box.y - mapping.offsetY) / mapping.visibleHeight;
  if (mapping.mirror) x = 1 - x - width;
  return { x, y, width, height };
}

/** 경계를 포함한다. */
export function isPointInRegion(point, region) {
  return point.x >= region.x && point.x <= region.x + region.width
    && point.y >= region.y && point.y <= region.y + region.height;
}

/**
 * 감지된 얼굴마다 인정 여부를 정한다. 세 조건을 모두 만족해야 인정된다.
 * - 박스 중심이 인식 영역 안
 * - 박스 높이(9:16 영역 높이 대비)가 minFaceHeight 이상
 * - 점수가 minScore 이상
 * @param {{ x: number, y: number, width: number, height: number, score: number }[]} faces 영상 좌표
 * @param {{ region: {x: number, y: number, width: number, height: number}, minFaceHeight: number, minScore: number }} criteria
 */
export function classifyFaces(faces, mapping, criteria) {
  return faces.map((face) => {
    const box = videoBoxToStage(face, mapping);
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const inRegion = isPointInRegion(center, criteria.region);
    const bigEnough = box.height >= criteria.minFaceHeight;
    const confident = face.score >= criteria.minScore;
    return { box, center, score: face.score, inRegion, bigEnough, confident, accepted: inRegion && bigEnough && confident };
  });
}

// ---- 안정화 ----
// 프레임마다 "있음/없음"(raw)이 흔들려도 상태가 깜빡이지 않게 시간으로 거른다.
// - 인식 안됨 → 인식됨: "있음"이 presentHoldMs 동안 끊기지 않고 이어질 때
// - 인식됨 → 인식 안됨: "없음"이 absentGraceMs 동안 끊기지 않고 이어질 때
// 시간값은 호출할 때마다 받으므로 실행 중에 바꿔도 다음 감지부터 반영된다.

export const initialPresenceState = Object.freeze({
  present: false, // 안정화된 판정 (밖에 알리는 값)
  raw: false, // 마지막 감지 프레임의 판정
  pendingSince: null, // raw가 present와 달라지기 시작한 시각. 같으면 null
});

export function stepPresence(state, raw, now, { presentHoldMs, absentGraceMs }) {
  if (raw === state.present) {
    return Object.freeze({ present: state.present, raw, pendingSince: null });
  }
  const pendingSince = state.pendingSince ?? now;
  const requiredMs = raw ? presentHoldMs : absentGraceMs;
  if (now - pendingSince >= requiredMs) {
    return Object.freeze({ present: raw, raw, pendingSince: null });
  }
  return Object.freeze({ present: state.present, raw, pendingSince });
}

/** 판정이 바뀌는 중이면 { target, elapsedMs, requiredMs }, 아니면 null. 개발용 표시에 쓴다. */
export function presenceProgress(state, now, { presentHoldMs, absentGraceMs }) {
  if (state.pendingSince === null) return null;
  const target = !state.present;
  return { target, elapsedMs: now - state.pendingSince, requiredMs: target ? presentHoldMs : absentGraceMs };
}
