// 실행: npm test  (또는 node --test tests/)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  classifyFaces,
  computeCoverMapping,
  initialPresenceState,
  isPointInRegion,
  presenceProgress,
  stepPresence,
  videoBoxToStage,
} from '../src/web/js/presence.js';

const STAGE = 9 / 16;

function assertBoxClose(actual, expected, epsilon = 1e-9) {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.ok(Math.abs(actual[key] - expected[key]) < epsilon,
      `${key}: expected ${expected[key]}, got ${actual[key]} (${JSON.stringify(actual)})`);
  }
}

describe('computeCoverMapping / videoBoxToStage', () => {
  const box = { x: 0.2, y: 0.3, width: 0.1, height: 0.05 };

  it('9:16 영상은 반전하지 않으면 그대로', () => {
    const mapping = computeCoverMapping({ videoWidth: 1080, videoHeight: 1920, stageAspect: STAGE, mirror: false });
    assert.equal(mapping.visibleWidth, 1);
    assert.equal(mapping.visibleHeight, 1);
    assertBoxClose(videoBoxToStage(box, mapping), box);
  });

  it('9:16 영상 + 반전: x가 오른쪽 끝 기준으로 뒤집힌다', () => {
    const mapping = computeCoverMapping({ videoWidth: 2160, videoHeight: 3840, stageAspect: STAGE, mirror: true });
    assertBoxClose(videoBoxToStage(box, mapping), { x: 0.7, y: 0.3, width: 0.1, height: 0.05 });
  });

  it('가로 영상(16:9)은 가운데 세로 띠만 보인다', () => {
    const mapping = computeCoverMapping({ videoWidth: 1920, videoHeight: 1080, stageAspect: STAGE, mirror: false });
    // 보이는 폭 = (9/16) / (16/9) = 81/256
    assert.equal(mapping.visibleWidth, 81 / 256);
    assert.equal(mapping.visibleHeight, 1);
    assert.equal(mapping.offsetX, (1 - 81 / 256) / 2);
    // 보이는 띠의 왼쪽 끝 → 화면 왼쪽 끝, 폭은 보이는 폭 대비로 커진다
    const atLeftEdge = { x: mapping.offsetX, y: 0.5, width: 81 / 256 / 4, height: 0.1 };
    assertBoxClose(videoBoxToStage(atLeftEdge, mapping), { x: 0, y: 0.5, width: 0.25, height: 0.1 });
    // 영상 가운데 → 화면 가운데
    const centered = { x: 0.5 - 0.05, y: 0.4, width: 0.1, height: 0.2 };
    const stage = videoBoxToStage(centered, mapping);
    assert.ok(Math.abs(stage.x + stage.width / 2 - 0.5) < 1e-9);
  });

  it('가로 영상 + 반전: 영상 왼쪽(보이는 부분)의 얼굴이 화면 오른쪽에 온다', () => {
    const mapping = computeCoverMapping({ videoWidth: 1920, videoHeight: 1080, stageAspect: STAGE, mirror: true });
    const atLeftEdge = { x: mapping.offsetX, y: 0.5, width: 81 / 256 / 4, height: 0.1 };
    assertBoxClose(videoBoxToStage(atLeftEdge, mapping), { x: 0.75, y: 0.5, width: 0.25, height: 0.1 });
  });

  it('9:16보다 세로로 긴 영상은 위아래가 잘린다', () => {
    // 1080x2400: 비율 0.45, 보이는 높이 = 0.45 / 0.5625 = 0.8
    const mapping = computeCoverMapping({ videoWidth: 1080, videoHeight: 2400, stageAspect: STAGE, mirror: false });
    assert.equal(mapping.visibleWidth, 1);
    assert.ok(Math.abs(mapping.visibleHeight - 0.8) < 1e-12);
    assertBoxClose(videoBoxToStage({ x: 0.5, y: 0.1, width: 0.1, height: 0.08 }, mapping),
      { x: 0.5, y: 0, width: 0.1, height: 0.1 });
  });

  it('영상 크기가 0이면 null', () => {
    assert.equal(computeCoverMapping({ videoWidth: 0, videoHeight: 1920, stageAspect: STAGE, mirror: true }), null);
  });
});

describe('isPointInRegion / classifyFaces', () => {
  const identity = computeCoverMapping({ videoWidth: 1080, videoHeight: 1920, stageAspect: STAGE, mirror: false });
  const criteria = {
    region: { x: 0.25, y: 0.25, width: 0.5, height: 0.5 }, minFaceHeight: 0.125, maxFaceHeight: 0.5, minScore: 0.5,
  };
  // 중심이 (cx, cy), 높이 h, 점수 s인 얼굴 (영상 좌표 = 화면 좌표)
  const face = (cx, cy, h = 0.25, s = 0.875) => ({ x: cx - 0.0625, y: cy - h / 2, width: 0.125, height: h, score: s });
  const accepted = (f) => classifyFaces([f], identity, criteria)[0];

  it('영역 경계는 포함한다', () => {
    assert.equal(isPointInRegion({ x: 0.25, y: 0.75 }, criteria.region), true);
    assert.equal(isPointInRegion({ x: 0.75, y: 0.25 }, criteria.region), true);
    assert.equal(isPointInRegion({ x: 0.2499, y: 0.5 }, criteria.region), false);
    assert.equal(isPointInRegion({ x: 0.5, y: 0.7501 }, criteria.region), false);
  });

  it('중심이 영역 안이면 박스가 영역 밖으로 나가도 인정', () => {
    const result = accepted(face(0.25, 0.5));
    assert.equal(result.inRegion, true);
    assert.equal(result.accepted, true);
  });

  it('중심이 영역 밖이면 제외', () => {
    const result = accepted(face(0.2, 0.5));
    assert.equal(result.inRegion, false);
    assert.equal(result.accepted, false);
  });

  it('최소 얼굴 크기: 같으면 인정, 작으면 제외', () => {
    assert.equal(accepted(face(0.5, 0.5, 0.125)).accepted, true);
    const small = accepted(face(0.5, 0.5, 0.124));
    assert.equal(small.bigEnough, false);
    assert.equal(small.accepted, false);
  });

  it('최대 얼굴 크기: 같으면 인정, 크면 제외', () => {
    assert.equal(accepted(face(0.5, 0.5, 0.5)).accepted, true);
    const large = accepted(face(0.5, 0.5, 0.5078125));
    assert.equal(large.smallEnough, false);
    assert.equal(large.bigEnough, true);
    assert.equal(large.accepted, false);
  });

  it('화면을 덮는 큰 박스는 점수가 높아도 제외', () => {
    const [result] = classifyFaces([{ x: 0, y: 0.1, width: 1, height: 0.8, score: 0.99 }], identity, criteria);
    assert.equal(result.inRegion, true);
    assert.equal(result.confident, true);
    assert.equal(result.smallEnough, false);
    assert.equal(result.accepted, false);
  });

  it('최소 크기는 9:16 영역 높이 기준이다 (잘린 영상에서는 커진다)', () => {
    // 세로로 긴 영상(보이는 높이 0.8)에서 영상 높이 0.1 = 화면 높이 0.125
    const tall = computeCoverMapping({ videoWidth: 1080, videoHeight: 2400, stageAspect: STAGE, mirror: false });
    const [result] = classifyFaces([{ x: 0.45, y: 0.45, width: 0.1, height: 0.1, score: 0.9 }], tall, criteria);
    assert.ok(Math.abs(result.box.height - 0.125) < 1e-12);
    assert.equal(result.bigEnough, true);
  });

  it('신뢰도: 같으면 인정, 낮으면 제외', () => {
    assert.equal(accepted(face(0.5, 0.5, 0.25, 0.5)).accepted, true);
    const weak = accepted(face(0.5, 0.5, 0.25, 0.49));
    assert.equal(weak.confident, false);
    assert.equal(weak.accepted, false);
  });

  it('반전 후 화면 기준으로 영역을 비교한다', () => {
    const mirrored = computeCoverMapping({ videoWidth: 1080, videoHeight: 1920, stageAspect: STAGE, mirror: true });
    const leftRegion = { ...criteria, region: { x: 0, y: 0, width: 0.5, height: 1 } };
    // 영상 오른쪽(중심 x 0.8)의 얼굴은 화면 왼쪽(중심 x 0.2)에 보인다
    const [result] = classifyFaces([face(0.8, 0.5)], mirrored, leftRegion);
    assert.ok(Math.abs(result.center.x - 0.2) < 1e-12);
    assert.equal(result.accepted, true);
  });

  it('잘려서 화면에 안 보이는 얼굴은 제외', () => {
    const landscape = computeCoverMapping({ videoWidth: 1920, videoHeight: 1080, stageAspect: STAGE, mirror: false });
    const wide = { ...criteria, region: { x: 0, y: 0, width: 1, height: 1 }, minFaceHeight: 0 };
    const [result] = classifyFaces([{ x: 0.05, y: 0.4, width: 0.05, height: 0.1, score: 0.9 }], landscape, wide);
    assert.ok(result.center.x < 0);
    assert.equal(result.accepted, false);
  });

  it('여러 명 중 한 명만 조건을 만족해도 그 얼굴은 인정', () => {
    const results = classifyFaces([face(0.1, 0.1), face(0.5, 0.5), face(0.5, 0.5, 0.25, 0.1)], identity, criteria);
    assert.deepEqual(results.map((r) => r.accepted), [false, true, false]);
  });
});

describe('stepPresence', () => {
  const timing = { presentHoldMs: 500, absentGraceMs: 1000 };
  // [시각, raw] 목록을 차례로 넣고 각 단계의 present를 돌려준다
  function run(samples, options = timing, start = initialPresenceState) {
    let state = start;
    return samples.map(([now, raw]) => {
      state = stepPresence(state, raw, now, options);
      return state.present;
    });
  }

  it('처음 상태는 인식 안됨', () => {
    assert.equal(initialPresenceState.present, false);
    assert.deepEqual(run([[0, false], [5000, false]]), [false, false]);
  });

  it('"있음"이 presentHoldMs 이어지면 인식됨 (경계 포함)', () => {
    assert.deepEqual(run([[0, true], [250, true], [499, true], [500, true]]), [false, false, false, true]);
  });

  it('유지 시간 중 한 번 끊기면 처음부터 다시 잰다 (깜빡임)', () => {
    const result = run([[0, true], [400, true], [450, false], [500, true], [900, true], [1000, true]]);
    assert.deepEqual(result, [false, false, false, false, false, true]);
  });

  it('인식됨에서 absentGraceMs보다 짧게 끊기면 유지', () => {
    const result = run([[0, true], [500, true], [600, false], [1500, false], [1599, false], [1600, true], [3000, true]]);
    assert.deepEqual(result, [false, true, true, true, true, true, true]);
  });

  it('"없음"이 absentGraceMs 이어지면 인식 안됨 (경계 포함)', () => {
    const result = run([[0, true], [500, true], [600, false], [1599, false], [1600, false]]);
    assert.deepEqual(result, [false, true, true, true, false]);
  });

  it('유예 중 다시 "있음"이 오면 유예 시간을 처음부터 다시 잰다', () => {
    const result = run([[0, true], [500, true], [600, false], [1400, false], [1450, true], [1500, false], [2400, false], [2500, false]]);
    assert.deepEqual(result, [false, true, true, true, true, true, true, false]);
  });

  it('시간값 0이면 바로 바뀐다', () => {
    assert.deepEqual(run([[0, true], [10, false]], { presentHoldMs: 0, absentGraceMs: 0 }), [true, false]);
  });

  it('presenceProgress: 바뀌는 중일 때만 진행 상황을 준다', () => {
    let state = stepPresence(initialPresenceState, true, 100, timing);
    assert.deepEqual(presenceProgress(state, 300, timing), { target: true, elapsedMs: 200, requiredMs: 500 });
    state = stepPresence(state, true, 600, timing);
    assert.equal(state.present, true);
    assert.equal(presenceProgress(state, 600, timing), null);
    state = stepPresence(state, false, 700, timing);
    assert.deepEqual(presenceProgress(state, 1000, timing), { target: false, elapsedMs: 300, requiredMs: 1000 });
  });
});
