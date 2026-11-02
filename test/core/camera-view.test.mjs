// 실행: npm test
// 카메라 처리 경로 (9-1): 변환 하나가 감지 입력(2D)·화면·효과 입력(셰이더)·캡처(2D)에 같은 점·같은 색을 주는지
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import {
  applyCameraColor, cameraColorKey, cameraColorMatrix, cameraGeometryKey, canvasTransform, computeCameraView, invertAffine, mapPoint,
  shaderColorUniforms, shaderSourceAffine, svgColorMatrixValues,
} from '../../src/web/core/camera-view.js';
import { computeCoverMapping, videoBoxToStage } from '../../src/web/core/presence.js';

const A = 9 / 16;
const neutral = Object.freeze({ ...config.camera, mirror: false });
const view = (videoWidth, videoHeight, camera = {}) => computeCameraView({ videoWidth, videoHeight, stageAspect: A, camera: { ...neutral, ...camera } });
const close = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const closePoint = (p, q, eps = 1e-9, label = '') => assert.ok(close(p.x, q.x, eps) && close(p.y, q.y, eps), `${label} ${JSON.stringify(p)} != ${JSON.stringify(q)}`);
// canvas setTransform(a, b, c, d, e, f): X = a x + c y + e, Y = b x + d y + f
const applyCanvas = ([a, b, c, d, e, f], p) => ({ x: a * p.x + c * p.y + e, y: b * p.x + d * p.y + f });
// 원본 화소 → 화면 정규화
const sourcePxToStage = (v, px) => mapPoint(v.sourceToStage, { x: px.x / v.videoWidth, y: px.y / v.videoHeight });
// 화면 네 모서리가 원본 [0,1]² 안에 있는지 (빈 영역 없음)
const corners = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }];
const covers = (v) => corners.every((c) => { const s = mapPoint(v.stageToSource, c); return s.x >= -1e-9 && s.x <= 1 + 1e-9 && s.y >= -1e-9 && s.y <= 1 + 1e-9; });

describe('computeCameraView: 변환 없음 = 지금까지의 cover 크롭·반전', () => {
  it('OBS 1080x1920: 캔버스 변환이 정확히 단위 행렬, 원본 화소 그대로 (캡처 1080x1920)', () => {
    const v = view(1080, 1920);
    assert.deepEqual(canvasTransform(v, 1080, 1920), [1, 0, 0, 1, 0, 0]);
    assert.deepEqual([v.visibleWidthPx, v.visibleHeightPx, v.zoom, v.autoZoom], [1080, 1920, 1, false]);
    assert.ok(covers(v));
  });

  it('반전 켬: 캔버스 변환이 translate(width) + scale(-1, 1)과 같다 (예전 capture.js)', () => {
    assert.deepEqual(canvasTransform(view(1080, 1920, { mirror: true }), 1080, 1920), [-1, 0, 0, 1, 1080, 0]);
  });

  it('여러 영상 비율·반전에서 원본 점 → 화면 점이 computeCoverMapping·videoBoxToStage(예전 판정 좌표)와 같다', () => {
    for (const [w, h] of [[1080, 1920], [2160, 3840], [1920, 1080], [2160, 2160], [640, 480], [1000, 3000]]) {
      for (const mirror of [false, true]) {
        const v = view(w, h, { mirror });
        const m = computeCoverMapping({ videoWidth: w, videoHeight: h, stageAspect: A, mirror });
        for (const box of [{ x: 0.4, y: 0.3, width: 0.1, height: 0.1 }, { x: 0.1, y: 0.7, width: 0.2, height: 0.05 }]) {
          const old = videoBoxToStage(box, m);
          const a = mapPoint(v.sourceToStage, { x: box.x, y: box.y });
          const b = mapPoint(v.sourceToStage, { x: box.x + box.width, y: box.y + box.height });
          closePoint({ x: Math.min(a.x, b.x), y: a.y }, { x: old.x, y: old.y }, 1e-9, `${w}x${h} mirror ${mirror}`);
          assert.ok(close(Math.abs(b.x - a.x), old.width) && close(b.y - a.y, old.height));
        }
        assert.ok(close(v.visibleWidthPx, m.visibleWidth * w) && close(v.visibleHeightPx, m.visibleHeight * h), `${w}x${h} visible`);
      }
    }
  });

  it('가로 1920x1080: 가운데 세로 띠 607.5x1080 (캡처 608x1080)', () => {
    const v = view(1920, 1080);
    assert.ok(close(v.visibleWidthPx, 607.5) && close(v.visibleHeightPx, 1080));
    closePoint(mapPoint(v.stageToSource, { x: 0, y: 0 }), { x: (1920 - 607.5) / 2 / 1920, y: 0 });
  });
});

describe('회전·확대·이동', () => {
  it('90°: 가로 1920x1080 카메라가 세로 화면을 가득 덮고(확대 1), 원본 왼쪽 위가 화면 오른쪽 위로 간다 (시계 방향)', () => {
    const v = view(1920, 1080, { rotation: 90 });
    assert.ok(close(v.visibleWidthPx, 1080) && close(v.visibleHeightPx, 1920), `${v.visibleWidthPx}x${v.visibleHeightPx}`);
    assert.deepEqual([v.zoom, v.autoZoom], [1, false]);
    closePoint(mapPoint(v.sourceToStage, { x: 0, y: 0 }), { x: 1, y: 0 });
    closePoint(mapPoint(v.sourceToStage, { x: 1, y: 1 }), { x: 0, y: 1 });
    assert.ok(covers(v));
  });

  it('270°·180°도 화면을 덮고, 0↔180은 점 대칭이다', () => {
    closePoint(mapPoint(view(1920, 1080, { rotation: 270 }).sourceToStage, { x: 0, y: 0 }), { x: 0, y: 1 });
    const a = view(1080, 1920);
    const b = view(1080, 1920, { rotation: 180 });
    const p = { x: 0.3, y: 0.2 };
    const pa = mapPoint(a.sourceToStage, p);
    closePoint(mapPoint(b.sourceToStage, p), { x: 1 - pa.x, y: 1 - pa.y });
  });

  it('반전은 회전과 관계없이 화면의 좌우다 (u → 1 − u, v 그대로)', () => {
    for (const rotation of [0, 90, 180, 270]) {
      for (const rotationFine of [0, 7]) {
        const off = view(1920, 1080, { rotation, rotationFine });
        const on = view(1920, 1080, { rotation, rotationFine, mirror: true });
        const p = { x: 0.45, y: 0.55 };
        const a = mapPoint(off.sourceToStage, p);
        closePoint(mapPoint(on.sourceToStage, p), { x: 1 - a.x, y: a.y }, 1e-9, `rotation ${rotation}+${rotationFine}`);
      }
    }
  });

  it('확대 2: 가운데는 그대로, 덮는 원본 화소가 절반 (캡처 540x960)', () => {
    const v = view(1080, 1920, { zoom: 2 });
    closePoint(mapPoint(v.stageToSource, { x: 0.5, y: 0.5 }), { x: 0.5, y: 0.5 });
    assert.ok(close(v.visibleWidthPx, 540) && close(v.visibleHeightPx, 960));
    closePoint(mapPoint(v.stageToSource, { x: 0, y: 0 }), { x: 0.25, y: 0.25 });
  });

  it('이동: 양수면 그림이 화면 오른쪽·아래로 (반전과 관계없이), 여유 안이면 자동 확대 없음', () => {
    for (const mirror of [false, true]) {
      const v = view(1080, 1920, { zoom: 2, panX: 0.1, panY: -0.05, mirror });
      closePoint(mapPoint(v.sourceToStage, { x: 0.5, y: 0.5 }), { x: 0.6, y: 0.45 }, 1e-9, `mirror ${mirror}`);
      assert.equal(v.autoZoom, false);
      assert.ok(covers(v));
    }
  });

  it('빈 영역 처리: 미세 회전·여유 없는 이동이면 확대를 자동으로 키워 늘 덮는다 (꼭 맞는 최소 배율)', () => {
    for (const camera of [{ rotationFine: 5 }, { rotationFine: -15, rotation: 90 }, { panX: 0.3 }, { panY: -0.5, panX: 0.5, rotationFine: 15 },
      { zoom: 1.2, rotationFine: 3, panX: -0.1 }]) {
      for (const [w, h] of [[1080, 1920], [1920, 1080], [2160, 2160]]) {
        const v = view(w, h, camera);
        assert.ok(covers(v), `${w}x${h} ${JSON.stringify(camera)} covers`);
        // 최소 배율이다: 모서리 하나가 원본 가장자리에 닿는다
        const touching = corners.some((c) => { const s = mapPoint(v.stageToSource, c); return [s.x, s.y].some((t) => close(t, 0, 1e-7) || close(t, 1, 1e-7)); });
        assert.ok(!v.autoZoom || touching, `${w}x${h} ${JSON.stringify(camera)} minimal`);
      }
    }
    const tilted = view(1080, 1920, { rotationFine: 5 });
    assert.ok(tilted.autoZoom && tilted.zoom > 1 && tilted.zoomRequested === 1, `zoom ${tilted.zoom}`);
    // 1080x1920을 5° 돌려 9:16을 덮는 배율 = cos5 + sin5·(16/9) (세로) 와 cos5 + sin5·(9/16) (가로) 중 큰 것
    const r = (5 * Math.PI) / 180;
    assert.ok(close(tilted.zoom, Math.max(Math.cos(r) + Math.sin(r) * (16 / 9), Math.cos(r) + Math.sin(r) * (9 / 16)), 1e-9));
    // 요청 배율이 이미 충분하면 그대로
    const enough = view(1080, 1920, { rotationFine: 5, zoom: 2 });
    assert.deepEqual([enough.autoZoom, enough.zoom], [false, 2]);
  });

  it('stageToSource와 sourceToStage는 서로 역이다', () => {
    const v = view(1920, 1080, { rotation: 90, rotationFine: 4.5, zoom: 1.3, panX: 0.05, panY: 0.1, mirror: true });
    const p = { x: 0.37, y: 0.81 };
    closePoint(mapPoint(v.stageToSource, mapPoint(v.sourceToStage, p)), p);
    closePoint(mapPoint(invertAffine(invertAffine(v.stageToSource)), p), mapPoint(v.stageToSource, p));
  });
});

describe('같은 점: 감지 입력(2D) ↔ 화면 ↔ 효과 입력(셰이더) ↔ 캡처(2D)', () => {
  const cases = [
    [1080, 1920, {}], [1080, 1920, { mirror: true }], [1920, 1080, { rotation: 90 }], [1920, 1080, { rotation: 270, mirror: true }],
    [2160, 3840, { zoom: 1.5, panX: -0.1, panY: 0.08 }], [1080, 1920, { rotationFine: -6.3, zoom: 1.1, mirror: true }],
    [2160, 2160, { rotation: 180, rotationFine: 2, panY: 0.2 }],
  ];
  for (const [w, h, camera] of cases) {
    it(`${w}x${h} ${JSON.stringify(camera)}`, () => {
      const v = view(w, h, camera);
      const detection = { width: 360, height: 640 }; // presence-monitor 감지 입력 (긴 변 640)
      const capture = { width: Math.round(v.visibleWidthPx), height: Math.round(v.visibleHeightPx) }; // capture.js
      const shader = shaderSourceAffine(v);
      for (const px of [{ x: w * 0.5, y: h * 0.5 }, { x: w * 0.42, y: h * 0.31 }, { x: w * 0.6, y: h * 0.7 }]) {
        const stage = sourcePxToStage(v, px);
        for (const out of [detection, capture]) {
          const c = applyCanvas(canvasTransform(v, out.width, out.height), px);
          closePoint({ x: c.x / out.width, y: c.y / out.height }, stage, 1e-9, `canvas ${out.width}x${out.height}`);
        }
        // 셰이더: 출력 uv (U, V) = (u, 1 − v) 에서 읽는 소스 텍스처 uv (위아래를 뒤집어 올림) = (x, 1 − y)
        const U = stage.x;
        const V = 1 - stage.y;
        const tex = { x: shader.x[0] * U + shader.x[1] * V + shader.x[2], y: shader.y[0] * U + shader.y[1] * V + shader.y[2] };
        closePoint(tex, { x: px.x / w, y: 1 - px.y / h }, 1e-9, 'shader');
      }
    });
  }

  it('변환이 없으면 셰이더 좌표가 예전 sourceOffset·sourceScale과 같다 (반전 [1, 0]·[-1, 1], 끔 [0, 0]·[1, 1])', () => {
    assert.deepEqual(shaderSourceAffine(view(1080, 1920, { mirror: true })), { x: [-1, 0, 1], y: [0, 1, 0] });
    assert.deepEqual(shaderSourceAffine(view(1080, 1920)), { x: [1, 0, 0], y: [0, 1, 0] });
  });
});

describe('색 보정 계수: SVG 필터(2D)와 셰이더가 같은 식', () => {
  const color = (patch = {}) => cameraColorMatrix({ ...neutral, ...patch });

  it('중립이면 단위 행렬·0·지수 1 (identity), 값이 그대로', () => {
    const c = color();
    assert.equal(c.identity, true);
    assert.deepEqual([...c.matrix], [1, 0, 0, 0, 1, 0, 0, 0, 1]);
    assert.deepEqual([...c.offset, c.exponent], [0, 0, 0, 1]);
    assert.deepEqual(applyCameraColor([0.2, 0.5, 0.9], c), [0.2, 0.5, 0.9]);
    assert.equal(svgColorMatrixValues(c), '1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 1 0');
  });

  it('밝기는 더하고, 대비는 0.5 중심, 감마는 1/감마 거듭제곱 (효과 출력 단계의 레벨과 같은 뜻), 0~1로 자른다', () => {
    assert.deepEqual(applyCameraColor([0.2, 0.5, 0.9], color({ brightness: 0.1 })).map((v) => +v.toFixed(9)), [0.3, 0.6, 1]);
    assert.deepEqual(applyCameraColor([0.2, 0.5, 0.9], color({ contrast: 2 })).map((v) => +v.toFixed(9)), [0, 0.5, 1]);
    const g = applyCameraColor([0.25, 0.5, 1], color({ gamma: 2 }));
    assert.ok(close(g[0], 0.5) && close(g[1], Math.SQRT1_2) && close(g[2], 1));
    assert.equal(color({ gamma: 2 }).identity, false);
  });

  it('채도 0은 Rec.709 밝기 회색, 색온도 양수는 빨강↑ 파랑↓, 색조 양수는 초록↓', () => {
    const gray = applyCameraColor([1, 0, 0], color({ saturation: 0 }));
    assert.ok(gray.every((v) => close(v, 0.2126)), `${gray}`);
    const warm = applyCameraColor([0.5, 0.5, 0.5], color({ temperature: 1 }));
    assert.ok(close(warm[0], 0.6) && close(warm[1], 0.5) && close(warm[2], 0.4), `${warm}`);
    const tint = applyCameraColor([0.5, 0.5, 0.5], color({ tint: 1 }));
    assert.ok(close(tint[1], 0.4) && close(tint[0], 0.5), `${tint}`);
  });

  it('SVG feColorMatrix 값과 셰이더 uniform(열 우선 mat3)이 같은 행렬·같은 b를 담는다', () => {
    const c = color({ brightness: -0.07, contrast: 1.35, saturation: 0.6, gamma: 1.4, temperature: 0.3, tint: -0.45 });
    const svg = svgColorMatrixValues(c).split(' ').map(Number);
    const u = shaderColorUniforms(c);
    // GLSL: (uCamM * c)[row] = Σ_col uCamM[col * 3 + row] · c[col]
    const glsl = (rgb) => [0, 1, 2].map((row) => Math.min(1, Math.max(0, [0, 1, 2].reduce((s, col) => s + u.uCamM[col * 3 + row] * rgb[col], 0) + u.uCamB[row])) ** u.uCamExp);
    // SVG: 행마다 [m0 m1 m2 0 b], 그 뒤 gamma (amplitude 1, offset 0, exponent)
    const svgf = (rgb) => [0, 1, 2].map((row) => Math.min(1, Math.max(0, svg[row * 5] * rgb[0] + svg[row * 5 + 1] * rgb[1] + svg[row * 5 + 2] * rgb[2] + svg[row * 5 + 4])) ** c.exponent);
    for (const rgb of [[0, 0, 0], [1, 1, 1], [0.2, 0.5, 0.9], [0.8, 0.1, 0.4], [0.33, 0.33, 0.33]]) {
      const ref = applyCameraColor(rgb, c);
      glsl(rgb).forEach((v, i) => assert.ok(close(v, ref[i], 1e-12), `glsl ${rgb}`));
      svgf(rgb).forEach((v, i) => assert.ok(close(v, ref[i], 1e-12), `svg ${rgb}`));
    }
    assert.deepEqual(svg.slice(15), [0, 0, 0, 1, 0], '알파 그대로');
  });

  it('키: 기하와 색은 따로 바뀐다', () => {
    assert.notEqual(cameraGeometryKey({ ...neutral, zoom: 2 }), cameraGeometryKey(neutral));
    assert.equal(cameraGeometryKey({ ...neutral, brightness: 0.2 }), cameraGeometryKey(neutral));
    assert.notEqual(cameraColorKey({ ...neutral, brightness: 0.2 }), cameraColorKey(neutral));
    assert.equal(cameraColorKey({ ...neutral, mirror: true }), cameraColorKey(neutral));
  });
});
