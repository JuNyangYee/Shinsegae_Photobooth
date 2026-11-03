// 실행: npm test
// 사진 틀 (IMPRINT 시안, core/photo-frame.js): 결과·인쇄·4K·감지 줄이 같은 비율의 정수 줄인지, 인식 영역 줄이기, 줄 자르기
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { clipRegionToFrame, cropRows, isFullFrame, photoFrameAspect, photoFrameRows } from '../../src/web/core/photo-frame.js';

const frame = config.photoFrame;

describe('photo-frame: 줄 범위', () => {
  it('기본 틀(7/64 ~ 52/64)은 9:16 화면에서 4:5이고 결과·인쇄·4K·감지 입력에서 모두 정수 줄이다', () => {
    assert.equal(photoFrameAspect(9 / 16, frame), 0.8);
    assert.deepEqual(photoFrameRows(1920, frame), { top: 210, height: 1350 });
    assert.deepEqual(photoFrameRows(1024, frame), { top: 112, height: 720 });
    assert.deepEqual(photoFrameRows(3840, frame), { top: 420, height: 2700 });
    assert.deepEqual(photoFrameRows(640, frame), { top: 70, height: 450 });
    for (const H of [1920, 1024, 3840, 640]) {
      assert.ok(Number.isInteger(H * frame.top) && Number.isInteger(H * (frame.top + frame.height)), `${H}`);
    }
    // 결과 줄과 인쇄 줄이 같은 화면 줄을 덮는다 (1080 → 576은 1.875배)
    assert.equal(210 / 1920, 112 / 1024);
    assert.equal(1350 / 1920, 720 / 1024);
  });

  it('정수로 안 떨어지는 높이(58mm 384점 → 683줄)는 위·아래 끝을 각각 반올림한다', () => {
    assert.deepEqual(photoFrameRows(683, frame), { top: 75, height: 480 });
    assert.deepEqual(photoFrameRows(2160, frame), { top: 236, height: 1519 });
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
  it('기본 인식 영역(0.1~0.9)은 틀 위·아래 끝에 맞춰 줄어든다 (가로는 그대로)', () => {
    const { region, clipped } = clipRegionToFrame({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, frame);
    assert.equal(clipped, true);
    assert.deepEqual(region, { x: 0.1, y: 7 / 64, width: 0.8, height: 45 / 64 });
  });

  it('이미 틀 안이면 그대로 (같은 객체, 줄이지 않음)', () => {
    const inside = { x: 0.2, y: 0.2, width: 0.6, height: 0.5 };
    const result = clipRegionToFrame(inside, frame);
    assert.equal(result.region, inside);
    assert.equal(result.clipped, false);
  });

  it('틀과 겹치지 않으면 높이 0 (아무 얼굴도 인정하지 않는다)', () => {
    const below = clipRegionToFrame({ x: 0, y: 0.85, width: 1, height: 0.1 }, frame);
    assert.equal(below.clipped, true);
    assert.equal(below.region.height, 0);
    const above = clipRegionToFrame({ x: 0, y: 0, width: 1, height: 0.05 }, frame);
    assert.equal(above.region.height, 0);
  });

  it('틀이 화면 전체면 줄이지 않는다', () => {
    const region = { x: 0.1, y: 0.1, width: 0.8, height: 0.8 };
    assert.equal(clipRegionToFrame(region, null).region, region);
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
