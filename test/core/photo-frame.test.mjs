// 실행: npm test
// 사진 틀 (IMPRINT 시안, core/photo-frame.js): 결과·인쇄·4K·감지 줄이 같은 비율의 정수 줄인지, 인식 영역 줄이기, 줄 자르기
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import {
  clipRegionToFrame, cropRect, cropRows, isFullFrame, padColumns, photoFrameAspect, photoFrameCols, photoFrameRect, photoFrameRows,
} from '../../src/web/core/photo-frame.js';
import { STAGE_MAPPING, classifyFaces, initialPresenceState, stepPresence } from '../../src/web/core/presence.js';

const frame = config.photoFrame;
// 판정 로직 테스트(반올림·빈 영역·검수 P2 재현)는 IMPRINT 틀 값을 명시해 둔다 (기본값이 WISHFUL 시안에서 10/64로 바뀌어도 같은 재현)
const IMPRINT_FRAME = Object.freeze({ top: 7 / 64, height: 45 / 64 });

describe('photo-frame: 줄 범위', () => {
  it('기본 틀(16단계 가로 1/8~7/8 · 세로 3/16~3/4)은 9:16 화면에서 정확한 3:4이고 결과·인쇄·4K·감지 입력에서 모두 정수 열·줄이다', () => {
    assert.equal(photoFrameAspect(9 / 16, frame), 0.75);
    assert.deepEqual(photoFrameRect(1080, 1920, frame), { left: 135, top: 360, width: 810, height: 1080 });
    assert.deepEqual(photoFrameRect(576, 1024, frame), { left: 72, top: 192, width: 432, height: 576 });
    assert.deepEqual(photoFrameRect(2160, 3840, frame), { left: 270, top: 720, width: 1620, height: 2160 });
    assert.deepEqual(photoFrameRect(360, 640, frame), { left: 45, top: 120, width: 270, height: 360 });
    for (const [W, H] of [[1080, 1920], [576, 1024], [2160, 3840], [360, 640]]) {
      assert.ok(Number.isInteger(H * frame.top) && Number.isInteger(H * (frame.top + frame.height)), `${H}`);
      assert.ok(Number.isInteger(W * frame.left) && Number.isInteger(W * (frame.left + frame.width)), `${W}`);
      const r = photoFrameRect(W, H, frame);
      assert.equal(r.width * 4, r.height * 3, `${W}x${H} 3:4`);
    }
    // 결과 직사각형과 인쇄 직사각형이 같은 화면 영역을 덮는다 (1080 → 576은 1.875배)
    assert.equal(135 / 1080, 72 / 576);
    assert.equal(360 / 1920, 192 / 1024);
  });

  it('left·width가 없는 예전 틀(14단계)은 화면 폭 전체', () => {
    const old = { top: 8 / 64, height: 45 / 64 };
    assert.deepEqual(photoFrameCols(1080, old), { left: 0, width: 1080 });
    assert.deepEqual(photoFrameRect(1080, 1920, old), { left: 0, top: 240, width: 1080, height: 1350 });
    assert.equal(photoFrameAspect(9 / 16, old), 0.8);
  });

  it('정수로 안 떨어지는 높이(58mm 384점 → 683줄)는 위·아래 끝을 각각 반올림한다', () => {
    assert.deepEqual(photoFrameRows(683, IMPRINT_FRAME), { top: 75, height: 480 });
    assert.deepEqual(photoFrameRows(2160, IMPRINT_FRAME), { top: 236, height: 1519 });
  });

  it('틀이 없거나 화면 전체면 자르지 않는다', () => {
    assert.equal(isFullFrame(null), true);
    assert.equal(isFullFrame({ top: 0, height: 1 }), true);
    assert.equal(isFullFrame(frame), false);
    assert.deepEqual(photoFrameRows(1920, null), { top: 0, height: 1920 });
    assert.equal(photoFrameAspect(9 / 16, null), 9 / 16);
  });
});

describe('photo-frame: 인식 영역을 틀 안으로', () => {
  it('기본 인식 영역(0.1~0.9)은 틀 가로·세로 끝에 맞춰 줄어든다 (16단계: 가로도)', () => {
    const { region, clipped } = clipRegionToFrame({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, frame);
    assert.equal(clipped, true);
    assert.deepEqual(region, { x: 1 / 8, y: 3 / 16, width: 3 / 4, height: 9 / 16 });
  });

  it('예전 틀(화면 폭 전체)이면 가로는 그대로', () => {
    const { region } = clipRegionToFrame({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, { top: 8 / 64, height: 45 / 64 });
    assert.deepEqual(region, { x: 0.1, y: 8 / 64, width: 0.8, height: 45 / 64 });
  });

  it('이미 틀 안이면 그대로 (같은 객체, 줄이지 않음)', () => {
    const inside = { x: 0.2, y: 0.25, width: 0.6, height: 0.4 };
    const result = clipRegionToFrame(inside, frame);
    assert.equal(result.region, inside);
    assert.equal(result.clipped, false);
  });

  it('틀과 겹치지 않으면 높이 0 (아무 얼굴도 인정하지 않는다)', () => {
    const below = clipRegionToFrame({ x: 0, y: 0.85, width: 1, height: 0.1 }, IMPRINT_FRAME);
    assert.equal(below.clipped, true);
    assert.equal(below.region.height, 0);
    const above = clipRegionToFrame({ x: 0, y: 0, width: 1, height: 0.05 }, IMPRINT_FRAME);
    assert.equal(above.region.height, 0);
  });

  it('틀이 화면 전체면 줄이지 않는다', () => {
    const region = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    assert.equal(clipRegionToFrame(region, null).region, region);
  });
});

describe('photo-frame: 직사각형 자르기·용지 가운데 넣기 (16단계)', () => {
  it('cropRect: 열·줄 범위만 새 배열로, padColumns: 좁은 사진을 넓은 폭 가운데에 (나머지 fill)', () => {
    const data = Uint8Array.from({ length: 4 * 3 }, (_, i) => i); // 4x3
    const crop = cropRect(data, 4, { left: 1, top: 1, width: 2, height: 2 });
    assert.deepEqual([...crop], [5, 6, 9, 10]);
    assert.deepEqual([...padColumns(crop, 2, 2, 4, 1, 1)], [1, 5, 6, 1, 1, 9, 10, 1]);
    assert.equal(padColumns(crop, 2, 2, 2, 0, 1), crop, '같은 폭이면 그대로');
  });
});

describe('photo-frame: 줄 자르기', () => {
  it('한 줄에 width칸인 배열에서 그 줄만 새 배열로', () => {
    const data = Uint8Array.from({ length: 4 * 6 }, (_, i) => i);
    const out = cropRows(data, 4, { top: 2, height: 3 });
    assert.deepEqual([...out], [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    out[0] = 99;
    assert.equal(data[8], 8, '원본은 그대로');
  });
});

// 독립 검수 P2 (IMPRINT): 틀과 겹치지 않는 인식 영역은 높이 0이 되는데, 경계를 포함하는 판정이 그 선 위의 얼굴 중심을 인정했다.
// 실제 경로(틀 교차 → 얼굴 분류 → 시간 판정)로 감지 15fps 흉내 1초 동안 같은 얼굴을 넣어 본다
describe('photo-frame + presence: 틀 교차 → 얼굴 분류 → 시간 판정 (검수 P2)', () => {
  const timing = { presentHoldMs: 250, absentGraceMs: 250 };
  const criteriaFor = (stored) => ({ region: clipRegionToFrame(stored, IMPRINT_FRAME).region, minFaceHeight: 0.185, maxFaceHeight: 0.47, minScore: 0.65 });
  // 얼굴 박스: 중심 (cx, cy), 높이 0.25 (최소·최대 얼굴 크기 안), 점수 0.99
  const faceAt = (cx, cy) => ({ x: cx - 0.1, y: cy - 0.125, width: 0.2, height: 0.25, score: 0.99 });
  function run(stored, face) {
    const criteria = criteriaFor(stored);
    let state = initialPresenceState;
    let presentAt = null;
    for (let t = 0; t <= 1000; t += 66) {
      const faces = classifyFaces([face], STAGE_MAPPING, criteria);
      state = stepPresence(state, faces.some((f) => f.accepted), t, timing);
      if (state.present && presentAt === null) presentAt = t;
    }
    return { region: criteria.region, accepted: classifyFaces([face], STAGE_MAPPING, criteria)[0].accepted, present: state.present, presentAt };
  }

  it('검수 재현: 틀 아래에만 있는 영역(y 0.85, 높이 0.1)은 높이 0으로 줄고, 그 선 위(틀 아래끝 0.8125)의 얼굴은 인정되지 않는다', () => {
    const stored = { x: 0.1, y: 0.85, width: 0.8, height: 0.1 };
    const face = faceAt(0.5, 0.8125);
    assert.equal(classifyFaces([face], STAGE_MAPPING, { ...criteriaFor(stored), region: stored })[0].accepted, false, '원래 영역에서도 거부');
    const r = run(stored, face);
    assert.deepEqual(r.region, { x: 0.1, y: 0.8125, width: 0.8, height: 0 });
    assert.equal(r.accepted, false);
    assert.equal(r.present, false, `present at ${r.presentAt}ms`);
  });

  it('틀 아래끝에 맞닿은 영역(y 0.8125부터)·틀 위에만 있는 영역도 빈 영역이라 그 선 위의 얼굴을 인정하지 않는다', () => {
    const touching = run({ x: 0.1, y: 0.8125, width: 0.8, height: 0.1 }, faceAt(0.5, 0.8125));
    assert.equal(touching.region.height, 0);
    assert.equal(touching.present, false);
    const above = run({ x: 0.1, y: 0, width: 0.8, height: 0.05 }, faceAt(0.5, 7 / 64));
    assert.deepEqual(above.region, { x: 0.1, y: 7 / 64, width: 0.8, height: 0 });
    assert.equal(above.present, false);
  });

  it('틀과 겹치는 양수 영역은 그대로 경계 포함: 줄어든 영역의 아래끝·위끝 위 얼굴도 인정되고 0.25초 뒤 인식됨', () => {
    const stored = { x: 0.1, y: 0.6875, width: 0.8, height: 0.2 }; // 틀과 0.6875 ~ 0.8125만 겹친다 (이진 소수로 정확한 경계)
    const bottom = run(stored, faceAt(0.5, 0.8125));
    assert.deepEqual(bottom.region, { x: 0.1, y: 0.6875, width: 0.8, height: 0.125 });
    assert.equal(bottom.accepted, true);
    assert.equal(bottom.present, true);
    assert.ok(bottom.presentAt >= 250 && bottom.presentAt <= 330, `${bottom.presentAt}`);
    assert.equal(run(stored, faceAt(0.5, 0.6875)).present, true, '위끝');
    assert.equal(run(stored, faceAt(0.5, 0.82)).present, false, '틀 밖(아래 여백)');
    // 기본 영역(틀 안으로 줄어듦)의 가운데 얼굴
    assert.equal(run({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, faceAt(0.5, 0.4)).present, true);
  });
});
