// 실행: npm test  (또는 node --test test/core/oil-paint.test.mjs)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  REFERENCE_SHORT_SIDE,
  createStrokeBuilder,
  drawingSeed,
  drawingTick,
  ihash,
  isBoilingStroke,
  layerSeedBase,
  pxScaleFor,
  resolveOilDrawing,
  resultSizeFor,
  seedForTick,
} from '../../src/web/core/oil-paint.js';
import { config } from '../../src/web/config/config.js';
import { normalizeEffectSettings } from '../../src/web/config/effect-settings.js';

const oil2f = normalizeEffectSettings(config.effect, config.effect).settings;

/** 비교 기준: 모든 획을 새로 만들어 (열쇠, 번호) 순으로 정렬한다 (캐시·합치기 없이) */
function naiveStrokes({ layer, spacing, width, height, boil, seed }) {
  const gw = Math.ceil(width / spacing);
  const gh = Math.ceil(height / spacing);
  const base = layerSeedBase(layer);
  const items = [];
  for (let i = 0; i < gw * gh; i += 1) {
    const sd = ihash(i, base, 1) >= boil ? base : drawingSeed(layer, seed);
    items.push({
      i,
      key: Math.fround(ihash(i, sd, 6)),
      v: [((i % gw) + ihash(i, sd, 2)) * spacing / width, (Math.floor(i / gw) + ihash(i, sd, 3)) * spacing / height,
        ihash(i, sd, 4), ihash(i, sd, 5)],
    });
  }
  items.sort((a, b) => a.key - b.key || a.i - b.i);
  return Float32Array.from(items.flatMap((item) => item.v));
}

const sameArray = (a, b) => a.length === b.length && a.every((v, i) => Object.is(v, b[i]));

describe('ihash', () => {
  it('원본 ihash와 같은 값 (원본 페이지에서 잰 값, 2026-10-16)', () => {
    // 비교 하네스에서 원본 페이지의 전역 ihash를 불러 잰 값. 마지막은 보완 층의 큰 번호·큰 seed 근처
    assert.equal(ihash(0, 0, 0), 0);
    assert.equal(ihash(1, 2, 3), 0.5767206135205925);
    assert.equal(ihash(123456, 1000, 6), 0.472850501537323);
    assert.equal(ihash(7, 8926, 2), 0.2712772742379457);
    assert.equal(ihash(230399, 7920291, 5), 0.8360181709285825);
  });
});

describe('createStrokeBuilder', () => {
  const W = 1080;
  const H = 1920;

  it('같은 seed·매개변수면 같은 목록 (빌더를 새로 만들어도)', () => {
    const a = createStrokeBuilder().build({ layer: 1, spacing: 10, width: W, height: H, boil: 0.1, seed: 42 });
    const b = createStrokeBuilder().build({ layer: 1, spacing: 10, width: W, height: H, boil: 0.1, seed: 42 });
    assert.equal(a.n, 108 * 192);
    assert.ok(sameArray(a.data, b.data));
  });

  it('캐시로 합친 목록 = 전부 새로 만들어 정렬한 목록 (층·boil·seed 여러 가지)', () => {
    const builder = createStrokeBuilder();
    for (const [layer, spacing, boil, seed] of [[0, 18.75, 0.1, 0], [1, 10, 0.1, 5], [2, 5, 0, 3], [3, 3.75, 0.1, 996],
      [0, 18.75, 1, 7], [1, 10, 0.5, 12], [0, 9.375, 0.1, 0]]) {
      const width = spacing === 9.375 ? 540 : W;
      const height = spacing === 9.375 ? 960 : H;
      const got = builder.build({ layer, spacing, width, height, boil, seed });
      const want = naiveStrokes({ layer, spacing, width, height, boil, seed });
      assert.ok(sameArray(got.data.subarray(0, got.n * 4), want), `layer ${layer} boil ${boil} seed ${seed}`);
    }
  });

  it('같은 빌더로 seed를 바꿔 불러도 앞 결과에 영향을 받지 않는다', () => {
    const builder = createStrokeBuilder();
    const first = Float32Array.from(builder.build({ layer: 2, spacing: 5, width: W, height: H, boil: 0.1, seed: 1 }).data);
    builder.build({ layer: 2, spacing: 5, width: W, height: H, boil: 0.1, seed: 2 });
    const again = builder.build({ layer: 2, spacing: 5, width: W, height: H, boil: 0.1, seed: 1 }).data;
    assert.ok(sameArray(first, again));
  });

  it('boil 비율만큼의 획만 그림마다 바뀐다', () => {
    const builder = createStrokeBuilder();
    const spacing = 5;
    const gw = Math.ceil(W / spacing);
    const n = gw * Math.ceil(H / spacing);
    // 획 번호 i의 값 (칸 i의 획). 빌더 결과가 이 값들을 정렬한 것과 같은지는 위 테스트가 본다
    const stroke = (i, boil, seed) => {
      const sd = ihash(i, layerSeedBase(2), 1) >= boil ? layerSeedBase(2) : drawingSeed(2, seed);
      return [2, 3, 4, 5, 6].map((c) => ihash(i, sd, c)).join(',');
    };
    for (const boil of [0, 0.1, 0.5, 1]) {
      let boiling = 0;
      let changed = 0;
      for (let i = 0; i < n; i += 1) {
        const moves = stroke(i, boil, 10) !== stroke(i, boil, 11);
        if (moves) changed += 1;
        if (isBoilingStroke(i, 2, boil)) boiling += 1;
        assert.equal(moves, isBoilingStroke(i, 2, boil), `stroke ${i}`);
      }
      assert.equal(changed, boiling);
      assert.ok(Math.abs(boiling / n - boil) < 0.005, `boil ${boil}: ${boiling / n}`);
      // 빌더 결과도 그림 사이에 바뀐 값의 수가 같다 (순서와 관계없이 값 묶음으로 비교)
      const bag = (data) => {
        const m = new Map();
        for (let o = 0; o < n; o += 1) {
          const k = Array.from(data.subarray(o * 4, o * 4 + 4)).join(',');
          m.set(k, (m.get(k) ?? 0) + 1);
        }
        return m;
      };
      const a = bag(Float32Array.from(builder.build({ layer: 2, spacing, width: W, height: H, boil, seed: 10 }).data));
      const b = bag(builder.build({ layer: 2, spacing, width: W, height: H, boil, seed: 11 }).data);
      let kept = 0;
      for (const [k, count] of a) kept += Math.min(count, b.get(k) ?? 0);
      assert.equal(n - kept, changed, `boil ${boil}`);
    }
  });

  it('boil 0이면 seed와 관계없이 같은 목록', () => {
    const builder = createStrokeBuilder();
    const a = Float32Array.from(builder.build({ layer: 0, spacing: 18.75, width: W, height: H, boil: 0, seed: 1 }).data);
    const b = builder.build({ layer: 0, spacing: 18.75, width: W, height: H, boil: 0, seed: 900 }).data;
    assert.ok(sameArray(a, b));
  });

  it('해상도를 2배·절반으로 바꾸고 간격도 비례로 바꾸면 같은 목록 (정규화 좌표)', () => {
    const builder = createStrokeBuilder();
    const ref = Float32Array.from(builder.build({ layer: 3, spacing: 3.75, width: W, height: H, boil: 0.1, seed: 9 }).data);
    for (const s of [0.5, 2]) {
      const got = builder.build({ layer: 3, spacing: 3.75 * s, width: W * s, height: H * s, boil: 0.1, seed: 9 });
      assert.ok(sameArray(got.data, ref), `scale ${s}`);
    }
  });

  it('캐시는 정해진 수만 남긴다', () => {
    const builder = createStrokeBuilder({ maxCacheEntries: 2 });
    for (const seedLayer of [0, 1, 2, 3]) builder.build({ layer: seedLayer, spacing: 50, width: 200, height: 300, boil: 0.1, seed: 0 });
    assert.equal(builder.cacheSize(), 2);
  });
});

describe('resolveOilDrawing (해상도 비례)', () => {
  it('기준 해상도(짧은 변 1080)에서는 원본 oil2f 값 그대로', () => {
    const D = resolveOilDrawing(oil2f, { width: 1080, height: 1920 });
    assert.equal(D.pxScale, 1);
    assert.equal(D.flowWidth, 540);
    assert.equal(D.flowHeight, 960);
    assert.equal(D.underLod, 4.5);
    assert.equal(D.jitter, 0.05 * 0.1);
    assert.deepEqual(D.layers.map((L) => [L.width, L.spacing, L.length, L.lod, L.detailMin, L.layer]),
      [[45, 18.75, 105, 3.8, 0, 0], [22.5, 10, 55, 2.6, 0.02, 1], [10, 5, 25, 1.4, 0.06, 2]]);
    assert.deepEqual([D.refine.width, D.refine.spacing, D.refine.length, D.refine.lod, D.refine.errorThreshold, D.refine.cell, D.refine.layer],
      [4.375, 3.75, 12.5, 0.6, 0.22, 3.75, 3]);
    assert.equal(D.relief, D.strength);
    for (const L of [...D.layers, D.refine]) {
      assert.equal(L.brisLength, L.length);
      assert.equal(L.brisWidth, L.width);
    }
  });

  it('미리보기 절반(540x960): px는 절반, 밉 단계는 -1, 붓털 주기와 획 수는 그대로', () => {
    const ref = resolveOilDrawing(oil2f, { width: 1080, height: 1920 });
    const D = resolveOilDrawing(oil2f, { width: 540, height: 960 });
    assert.equal(D.pxScale, 0.5);
    assert.equal(D.underLod, 3.5);
    assert.equal(D.relief, 0.05);
    D.layers.forEach((L, i) => {
      assert.equal(L.spacing, ref.layers[i].spacing / 2);
      assert.equal(L.length, ref.layers[i].length / 2);
      assert.equal(L.width, ref.layers[i].width / 2);
      assert.equal(L.lod, ref.layers[i].lod - 1);
      assert.equal(L.brisLength, ref.layers[i].brisLength);
      assert.equal(Math.ceil(540 / L.spacing) * Math.ceil(960 / L.spacing),
        Math.ceil(1080 / ref.layers[i].spacing) * Math.ceil(1920 / ref.layers[i].spacing));
    });
    assert.equal(D.refine.cell, ref.refine.cell / 2);
  });

  it('4K 세로(2160x3840): px 2배, 밉 단계 +1', () => {
    const D = resolveOilDrawing(oil2f, { width: 2160, height: 3840 });
    assert.equal(D.pxScale, 2);
    assert.equal(D.underLod, 5.5);
    assert.equal(D.layers[0].spacing, 37.5);
    assert.equal(D.layers[0].lod, 4.8);
  });

  it('짧은 변 기준이라 가로·세로 어느 쪽이든 같다', () => {
    assert.equal(pxScaleFor(1920, 1080), 1);
    assert.equal(pxScaleFor(1080, 1920), 1);
    assert.equal(pxScaleFor(608, 1080), 608 / REFERENCE_SHORT_SIDE);
  });

  it('보완 층이 없으면 refine null', () => {
    const D = resolveOilDrawing({ ...oil2f, refine: null }, { width: 1080, height: 1920 });
    assert.equal(D.refine, null);
  });
});

describe('resultSizeFor (결과 사진 크기, 5-2)', () => {
  it('짧은 변을 1080으로, 짝수로 반올림 (원본 allocate)', () => {
    assert.deepEqual(resultSizeFor(1080, 1920), { width: 1080, height: 1920 });
    assert.deepEqual(resultSizeFor(2160, 3840), { width: 1080, height: 1920 });
    assert.deepEqual(resultSizeFor(540, 960), { width: 1080, height: 1920 });
    assert.deepEqual(resultSizeFor(608, 1080), { width: 1080, height: 1918 });
    assert.deepEqual(resultSizeFor(1215, 2160), { width: 1080, height: 1920 });
    assert.deepEqual(resultSizeFor(1920, 1080), { width: 1920, height: 1080 });
  });

  it('결과 크기에서는 px 비례값이 1 (원본과 같은 값)', () => {
    const { width, height } = resultSizeFor(2160, 3840);
    assert.equal(pxScaleFor(width, height), 1);
  });
});

describe('drawingTick / seedForTick', () => {
  it('초당 그림 수만큼 번호가 바뀐다', () => {
    const ticks = new Set();
    for (let ms = 10000; ms < 11000; ms += 1) ticks.add(drawingTick(ms, 24));
    assert.equal(ticks.size, 24);
    const slow = new Set();
    for (let ms = 10000; ms < 11000; ms += 1) slow.add(drawingTick(ms, 2));
    assert.equal(slow.size, 2);
  });

  it('원본처럼 경계에서 아주 작은 오차를 넘긴다 (floor(t * fps + 1e-6))', () => {
    assert.equal(drawingTick(1000, 24), 24);
    assert.equal(drawingTick(1000 / 24 * 5, 24), 5);
  });

  it('seed = tick % 997', () => {
    assert.equal(seedForTick(0), 0);
    assert.equal(seedForTick(996), 996);
    assert.equal(seedForTick(997), 0);
    assert.equal(seedForTick(24 * 3600 * 10), (24 * 3600 * 10) % 997);
  });
});
