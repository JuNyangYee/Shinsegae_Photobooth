// 실행: npm test  (또는 node --test test/effect/photo-effect.test.mjs)
// 촬영 결과 효과 단계: 효과 사진, 실패 시 원본 사진(결과 크기), 효과 끔, 취소, 출력 모드(6-1). 캔버스·ImageData는 흉내 낸다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';

import { config } from '../../src/web/config/config.js';
import { normalizeEffectSettings } from '../../src/web/config/effect-settings.js';
import { thresholdMap, ditherThreshold } from '../../src/web/core/thermal.js';
import { createPhotoEffect } from '../../src/web/effect/photo-effect.js';
import { EffectError, EffectFault } from '../../src/web/effect/oil-renderer.js';

const colorSettings = normalizeEffectSettings({ ...config.effect, outputMode: 'off' }, config.effect).settings;
const thermalSettings = normalizeEffectSettings({ ...config.effect, outputMode: 'thermal', dither: 'bayer', paperDots: 128, bwStyle: 'tone' }, config.effect).settings;

function fakeCanvas(width = 0, height = 0, { noContext = false, fill = 255 } = {}) {
  const ops = [];
  return {
    width, height, ops,
    getContext: () => (noContext ? null : {
      putImageData: (image, x, y) => ops.push(['put', image, x, y]),
      drawImage: (source, x, y, w, h) => ops.push(['draw', source, x, y, w, h]),
      getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(fill) }),
      set imageSmoothingQuality(v) { ops.push(['quality', v]); },
    }),
  };
}

function setup({ still, enabled = true, canvasOptions, settings = colorSettings, deflate = async (raw) => deflateSync(raw) } = {}) {
  const created = [];
  const warnings = [];
  const cleared = [];
  const preview = {
    isEnabled: () => enabled,
    getSettings: () => settings,
    renderStill: () => {
      if (still instanceof Error) throw still;
      return still;
    },
  };
  const effect = createPhotoEffect({
    preview,
    createCanvas: () => { const c = fakeCanvas(0, 0, canvasOptions); created.push(c); return c; },
    createImageData: (pixels, w, h) => ({ pixels, w, h }),
    display: { paper: [250, 240, 230], ink: [10, 20, 30] },
    deflate,
    createBlob: (bytes) => ({ size: bytes.length, bytes }),
    log: { warn: (category, message) => warnings.push([category, message]), clear: (category) => cleared.push(category) },
    now: () => 0,
  });
  return { effect, created, warnings, cleared };
}

const pixels = new Uint8ClampedArray(1080 * 1920 * 4);
const goodStill = { mode: 'off', settings: colorSettings, pixels, width: 1080, height: 1920, seed: 7, tick: 1234, sameAsPreview: true, ms: 9 };

describe('createPhotoEffect', () => {
  it('효과 사진: 미리보기와 같은 그림을 새 캔버스(결과 크기)에 넣는다', async () => {
    const t = setup({ still: goodStill });
    const raw = fakeCanvas(2160, 3840);
    const out = await t.effect.apply(raw);
    assert.notEqual(out, raw);
    assert.deepEqual([out.width, out.height], [1080, 1920]);
    assert.equal(out.ops[0][0], 'put');
    assert.equal(out.ops[0][1].pixels, pixels);
    assert.deepEqual(t.effect.getStats(), {
      last: { status: 'applied', mode: 'off', width: 1080, height: 1920, seed: 7, tick: 1234, sameAsPreview: true, renderMs: 9, ms: 0 },
      applied: 1, fellBack: 0,
    });
    assert.deepEqual(t.cleared, ['effect-capture']);
    assert.equal(t.warnings.length, 0);
  });

  it('효과를 그리지 못하면 원본 사진을 결과 크기로 줄여 대신하고 경고를 남긴다 (흐름은 계속)', async () => {
    const t = setup({ still: new EffectError(EffectFault.NOT_RUNNING, 'preview effect is fallback') });
    const raw = fakeCanvas(2160, 3840);
    const out = await t.effect.apply(raw);
    assert.notEqual(out, raw);
    assert.deepEqual([out.width, out.height], [1080, 1920]);
    assert.deepEqual(out.ops.find((op) => op[0] === 'draw'), ['draw', raw, 0, 0, 1080, 1920]);
    const stats = t.effect.getStats();
    assert.equal(stats.last.status, 'raw');
    assert.match(stats.last.reason, /not-running: preview effect is fallback/);
    assert.equal(stats.fellBack, 1);
    assert.equal(t.warnings[0][0], 'effect-capture');
  });

  it('원본이 이미 결과 크기면 그 캔버스를 그대로 돌려준다', async () => {
    const t = setup({ still: new Error('readPixels failed') });
    const raw = fakeCanvas(1080, 1920);
    assert.equal(await t.effect.apply(raw), raw);
    assert.equal(t.created.length, 0);
  });

  it('효과 사진 캔버스를 만들다 실패하면 그 캔버스를 비우고 원본으로 대신한다', async () => {
    const t = setup({ still: goodStill, canvasOptions: { noContext: true } });
    const raw = fakeCanvas(1080, 1920);
    assert.equal(await t.effect.apply(raw), raw);
    assert.deepEqual([t.created[0].width, t.created[0].height], [0, 0]);
    assert.match(t.effect.getStats().last.reason, /2d context unavailable/);
  });

  it('효과를 끈 설정(enabled false)이면 원본 그대로 (예전 동작)', async () => {
    const t = setup({ still: goodStill, enabled: false });
    const raw = fakeCanvas(2160, 3840);
    assert.equal(await t.effect.apply(raw), raw);
    assert.equal(t.effect.getStats().last.status, 'disabled');
  });

  it('이미 취소된 회차면 그리지 않고 예외', async () => {
    const t = setup({ still: goodStill });
    const controller = new AbortController();
    controller.abort(new Error('capture timeout'));
    await assert.rejects(t.effect.apply(fakeCanvas(1080, 1920), { signal: controller.signal }), /capture timeout/);
    assert.equal(t.created.length, 0);
  });
});

describe('createPhotoEffect: 출력 모드 (6-1)', () => {
  // 16x4 인쇄 해상도: 위 두 줄 회색 0·255 줄무늬, 아래 두 줄 128
  const Pw = 16;
  const Ph = 4;
  const gray = new Uint8Array(Pw * Ph).map((_, i) => (i < 2 * Pw ? (i % 2 ? 255 : 0) : 128));
  const gpuMask = ditherThreshold(gray, Pw, Ph, thresholdMap('bayer'));
  const thermalStill = (mask = gpuMask) => ({
    mode: 'thermal', settings: thermalSettings, width: 1080, height: 1920, seed: 3, tick: 9, sameAsPreview: true, ms: 1,
    gray, mask, printWidth: Pw, printHeight: Ph,
  });

  it('감열지: (a) 1비트 인쇄 데이터(래스터 1 = 검정, PNG 깊이 1)와 (b) 같은 마스크를 종이색·잉크색으로 칠한 화면용 PNG', async () => {
    const t = setup({ still: thermalStill(), settings: thermalSettings });
    const out = await t.effect.apply(fakeCanvas(1080, 1920));
    assert.equal(out.type, 'image/png');
    assert.deepEqual([out.canvas.width, out.canvas.height], [1080, 1920], '화면용은 결과 크기로 확대');
    const { print } = out;
    assert.deepEqual([print.width, print.height, print.bytesPerRow, print.pngBitDepth, print.pngColorType], [Pw, Ph, 2, 1, 0]);
    // 첫 줄: 0·255 줄무늬 → 짝수 점 검정 → 래스터 1010 1010 = 0xaa
    assert.deepEqual([...print.bits.slice(0, 2)], [0xaa, 0xaa]);
    // PNG IDAT를 풀면 줄마다 필터 0 + 비트(1 = 흰색)이고, 래스터 비트의 반전이다
    const png = print.png.bytes;
    const idatLength = new DataView(png.buffer, png.byteOffset).getUint32(33);
    const rows = inflateSync(png.subarray(41, 41 + idatLength));
    for (let y = 0; y < Ph; y += 1) {
      assert.equal(rows[y * 3], 0);
      for (let b = 0; b < 2; b += 1) assert.equal(rows[y * 3 + 1 + b], ~print.bits[y * 2 + b] & 0xff);
    }
    // 화면용: 마스크를 확대해 종이색·잉크색 (upscaleSharp). 왼쪽 위 화소는 첫 점(검정) 안이라 잉크색
    const put = out.canvas.ops.find((op) => op[0] === 'put')[1];
    assert.deepEqual([...put.pixels.slice(0, 4)], [10, 20, 30, 255]);
    assert.deepEqual([put.w, put.h, put.pixels.length], [1080, 1920, 1080 * 1920 * 4]);
    const { last } = t.effect.getStats();
    assert.deepEqual([last.status, last.mode, last.check, last.dither], ['applied', 'thermal', 'gpu=cpu', 'bayer']);
    assert.equal(last.print.rasterBytes, 8);
  });

  it('GPU 디더가 CPU 같은 식과 다르면 경고하고 화면에 보이던 GPU 마스크를 쓴다', async () => {
    const changed = gpuMask.slice();
    changed[0] ^= 1;
    const t = setup({ still: thermalStill(changed), settings: thermalSettings });
    const out = await t.effect.apply(fakeCanvas(1080, 1920));
    assert.equal(t.effect.getStats().last.check, 'GPU != CPU (1 dots)');
    assert.match(t.warnings[0][1], /differ in 1 dots/);
    assert.equal(out.print.bits[0] & 0x80, changed[0] ? 0 : 0x80);
  });

  it('효과를 그리지 못하면 원본 사진에 감열지 단계를 CPU로 (인쇄 데이터 포함, 결과 크기 기준 인쇄 해상도)', async () => {
    const t = setup({ still: new Error('not-running'), settings: thermalSettings });
    const out = await t.effect.apply(fakeCanvas(2160, 3840, { fill: 0 }));
    assert.deepEqual([out.print.width, out.print.height], [128, 228]); // 1080x1920 기준, 용지 128점(최소값) → 228줄
    assert.equal(out.print.blackRatio, 1, '검은 원본 → 모두 검은 점');
    const { last } = t.effect.getStats();
    assert.deepEqual([last.status, last.mode, last.dither], ['raw', 'thermal', 'bayer']);
  });

  it('회색조: 효과 실패 시 원본 사진(결과 크기)을 회색조·레벨로', async () => {
    const graySettings = normalizeEffectSettings({ ...config.effect, outputMode: 'gray' }, config.effect).settings;
    const t = setup({ still: new Error('not-running'), settings: graySettings });
    const raw = fakeCanvas(1080, 1920);
    assert.equal(await t.effect.apply(raw), raw);
    assert.equal(raw.ops.find((op) => op[0] === 'put')[1].data.length, 1080 * 1920 * 4);
    assert.deepEqual([t.effect.getStats().last.status, t.effect.getStats().last.mode], ['raw', 'gray']);
  });

  it('PNG 압축 중 회차가 취소되면 화면용 캔버스를 만들지 않고 예외', async () => {
    let release;
    const t = setup({ still: thermalStill(), settings: thermalSettings, deflate: (raw) => new Promise((r) => { release = () => r(deflateSync(raw)); }) });
    const controller = new AbortController();
    const result = t.effect.apply(fakeCanvas(1080, 1920), { signal: controller.signal });
    await Promise.resolve();
    controller.abort(new Error('reset'));
    release();
    await assert.rejects(result, /reset/);
    assert.equal(t.created.length, 0);
  });
});
