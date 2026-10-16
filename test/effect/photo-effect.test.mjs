// 실행: npm test  (또는 node --test test/effect/photo-effect.test.mjs)
// 촬영 결과 효과 단계: 효과 사진, 실패 시 원본 사진(결과 크기), 효과 끔, 취소. 캔버스·ImageData는 흉내 낸다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createPhotoEffect } from '../../src/web/effect/photo-effect.js';
import { EffectError, EffectFault } from '../../src/web/effect/oil-renderer.js';

function fakeCanvas(width = 0, height = 0, { noContext = false } = {}) {
  const ops = [];
  return {
    width, height, ops,
    getContext: () => (noContext ? null : {
      putImageData: (image, x, y) => ops.push(['put', image, x, y]),
      drawImage: (source, x, y, w, h) => ops.push(['draw', source, x, y, w, h]),
      set imageSmoothingQuality(v) { ops.push(['quality', v]); },
    }),
  };
}

function setup({ still, enabled = true, canvasOptions } = {}) {
  const created = [];
  const warnings = [];
  const cleared = [];
  const preview = {
    isEnabled: () => enabled,
    renderStill: () => {
      if (still instanceof Error) throw still;
      return still;
    },
  };
  const effect = createPhotoEffect({
    preview,
    createCanvas: () => { const c = fakeCanvas(0, 0, canvasOptions); created.push(c); return c; },
    createImageData: (pixels, w, h) => ({ pixels, w, h }),
    log: { warn: (category, message) => warnings.push([category, message]), clear: (category) => cleared.push(category) },
    now: () => 0,
  });
  return { effect, created, warnings, cleared };
}

const pixels = new Uint8ClampedArray(1080 * 1920 * 4);
const goodStill = { pixels, width: 1080, height: 1920, seed: 7, tick: 1234, sameAsPreview: true, ms: 9 };

describe('createPhotoEffect', () => {
  it('효과 사진: 미리보기와 같은 그림을 새 캔버스(결과 크기)에 넣는다', () => {
    const t = setup({ still: goodStill });
    const raw = fakeCanvas(2160, 3840);
    const out = t.effect.apply(raw);
    assert.notEqual(out, raw);
    assert.deepEqual([out.width, out.height], [1080, 1920]);
    assert.equal(out.ops[0][0], 'put');
    assert.equal(out.ops[0][1].pixels, pixels);
    assert.deepEqual(t.effect.getStats(), {
      last: { status: 'applied', width: 1080, height: 1920, seed: 7, tick: 1234, sameAsPreview: true, ms: 0 }, applied: 1, fellBack: 0,
    });
    assert.deepEqual(t.cleared, ['effect-capture']);
    assert.equal(t.warnings.length, 0);
  });

  it('효과를 그리지 못하면 원본 사진을 결과 크기로 줄여 대신하고 경고를 남긴다 (흐름은 계속)', () => {
    const t = setup({ still: new EffectError(EffectFault.NOT_RUNNING, 'preview effect is fallback') });
    const raw = fakeCanvas(2160, 3840);
    const out = t.effect.apply(raw);
    assert.notEqual(out, raw);
    assert.deepEqual([out.width, out.height], [1080, 1920]);
    assert.deepEqual(out.ops.find((op) => op[0] === 'draw'), ['draw', raw, 0, 0, 1080, 1920]);
    const stats = t.effect.getStats();
    assert.equal(stats.last.status, 'raw');
    assert.match(stats.last.reason, /not-running: preview effect is fallback/);
    assert.equal(stats.fellBack, 1);
    assert.equal(t.warnings[0][0], 'effect-capture');
  });

  it('원본이 이미 결과 크기면 그 캔버스를 그대로 돌려준다', () => {
    const t = setup({ still: new Error('readPixels failed') });
    const raw = fakeCanvas(1080, 1920);
    assert.equal(t.effect.apply(raw), raw);
    assert.equal(t.created.length, 0);
  });

  it('효과 사진 캔버스를 만들다 실패하면 그 캔버스를 비우고 원본으로 대신한다', () => {
    const t = setup({ still: goodStill, canvasOptions: { noContext: true } });
    const raw = fakeCanvas(1080, 1920);
    assert.equal(t.effect.apply(raw), raw);
    assert.deepEqual([t.created[0].width, t.created[0].height], [0, 0]);
    assert.match(t.effect.getStats().last.reason, /2d context unavailable/);
  });

  it('효과를 끈 설정(enabled false)이면 원본 그대로 (예전 동작)', () => {
    const t = setup({ still: goodStill, enabled: false });
    const raw = fakeCanvas(2160, 3840);
    assert.equal(t.effect.apply(raw), raw);
    assert.equal(t.effect.getStats().last.status, 'disabled');
  });

  it('이미 취소된 회차면 그리지 않고 예외', () => {
    const t = setup({ still: goodStill });
    const controller = new AbortController();
    controller.abort(new Error('capture timeout'));
    assert.throws(() => t.effect.apply(fakeCanvas(1080, 1920), { signal: controller.signal }), /capture timeout/);
    assert.equal(t.created.length, 0);
  });
});
