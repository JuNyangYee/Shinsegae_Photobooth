// 실행: npm test  (또는 node --test test/effect/oil-renderer.test.mjs)
// 렌더러의 GPU 자원 정리와 실패 판정 (5단계 검수 1·2·3). 가짜 WebGL2(test/fixtures/fake-webgl2.mjs)로 장애를 주입한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { normalizeEffectSettings } from '../../src/web/config/effect-settings.js';
import { EffectStatus, createEffectPreview } from '../../src/web/effect/effect-preview.js';
import { EffectFault, createOilRenderer } from '../../src/web/effect/oil-renderer.js';
import { createPhotoEffect } from '../../src/web/effect/photo-effect.js';
import { INPUT_LUMA } from '../../src/web/core/thermal.js';
import { createFakeWebGL2 } from '../fixtures/fake-webgl2.mjs';

// 5단계 검수 테스트는 컬러 출력(outputMode off) 경로로 본다. 감열지 경로는 아래 6-1 테스트
const settings = normalizeEffectSettings({ ...config.effect, outputMode: 'off' }, config.effect).settings;
const small = { settings, width: 20, height: 36, seed: 3 };
const ZERO = { program: 0, shader: 0, texture: 0, framebuffer: 0, buffer: 0, vertexArray: 0 };

describe('oil-renderer: GPU 자원 정리 (검수 2·3)', () => {
  it('dispose는 만든 프로그램 14개(유화 8 + 감열지 3 + 흑백 스타일 2 + 입력 회색조 1)를 그 객체로 지우고, 텍스처·프레임버퍼·버퍼·VAO도 모두 지운다', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    renderer.render({}, small); // 미리보기 묶음
    renderer.render(null, { ...small, width: 30, height: 54, output: 'pixels' }); // 결과 묶음 + out
    assert.equal(fake.created.program.length, 14);
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO);
    for (const program of fake.created.program) {
      assert.ok(fake.deletedWith.some(([kind, value]) => kind === 'program' && value === program), `program ${program.id} not deleted`);
    }
    assert.ok(!fake.deletedWith.some(([, value]) => value === undefined || value === null), 'deleteX(undefined)');
    assert.deepEqual(renderer.liveResources(), { programs: 0, textures: 0, framebuffers: 0, buffers: 0, arrays: 0 });
  });

  it('셰이더 컴파일이 실패하면 그때까지 만든 프로그램·버퍼·VAO·셰이더를 모두 지우고 예외', () => {
    for (const at of [1, 7, 16]) {
      const fake = createFakeWebGL2();
      fake.failShaderAt(at);
      assert.throws(() => createOilRenderer({ canvas: fake.canvas }), (e) => e.fault === EffectFault.SHADER_FAILED);
      assert.deepEqual(fake.liveCount(), ZERO, `compile failure at shader ${at}`);
    }
  });

  it('대상 묶음을 만들다 일부에서 실패하면 그 묶음의 텍스처·프레임버퍼를 모두 지운다', () => {
    for (const at of [1, 4, 9]) { // 텍스처 하나째, 흐름장 셋째, 마지막 MRT
      const fake = createFakeWebGL2();
      const renderer = createOilRenderer({ canvas: fake.canvas });
      const afterInit = fake.liveCount();
      const base = fake.framebufferChecks();
      fake.failFramebufferAt(base + at);
      assert.throws(() => renderer.render({}, small), (e) => e.fault === EffectFault.FRAMEBUFFER_INCOMPLETE);
      assert.deepEqual(fake.liveCount(), afterInit, `allocate failure at check ${at}`);
      fake.failFramebufferAt(() => false);
      renderer.render({}, small); // 다시 만들면 된다
      renderer.dispose();
      assert.deepEqual(fake.liveCount(), ZERO);
    }
  });

  it('결과 출력(out) 만들기가 거듭 실패해도 쌓이지 않는다', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    renderer.render({}, small);
    const before = fake.liveCount();
    const base = fake.framebufferChecks();
    fake.failFramebufferAt((i) => i > base);
    for (let i = 0; i < 5; i += 1) {
      assert.throws(() => renderer.render(null, { ...small, output: 'pixels' }), (e) => e.fault === EffectFault.FRAMEBUFFER_INCOMPLETE);
    }
    assert.deepEqual(fake.liveCount(), before);
    fake.failFramebufferAt(() => false);
    assert.ok(renderer.render(null, { ...small, output: 'pixels' }).pixels);
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO);
  });
});

describe('oil-renderer: 실패를 성공으로 넘기지 않는다 (검수 1)', () => {
  it('결과 화소를 읽기 직전에 컨텍스트를 잃으면 CONTEXT_LOST', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    fake.onReadPixels((f) => f.lose());
    assert.throws(() => renderer.render({}, { ...small, output: 'pixels' }), (e) => e.fault === EffectFault.CONTEXT_LOST);
  });

  it('결과 화소 읽기에서 INVALID_OPERATION이면 RENDER_FAILED', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    fake.failNextCall('readPixels');
    assert.throws(() => renderer.render({}, { ...small, output: 'pixels' }), (e) => e.fault === EffectFault.RENDER_FAILED && /0x502/.test(e.message));
  });

  it('미리보기 그림 중의 GL 오류도 예외', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    fake.failNextCall('drawArraysInstanced');
    assert.throws(() => renderer.render({}, small), (e) => e.fault === EffectFault.RENDER_FAILED);
    assert.ok(renderer.render({}, small), '다음 그림은 오류가 없으면 된다');
  });

  it('그리기 전에 쌓여 있던 오류는 이번 그림 탓으로 보지 않는다', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    fake.pushError();
    fake.pushError();
    assert.ok(renderer.render({}, { ...small, output: 'pixels' }).pixels);
  });
});

describe('촬영 결과·미리보기 경로 (실제 미리보기·렌더러 + 가짜 WebGL2)', () => {
  function setup() {
    const fake = createFakeWebGL2();
    const listeners = new Map();
    const canvas = Object.assign(fake.canvas, {
      hidden: true,
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    });
    let queued = null;
    let time = 10000;
    const preview = createEffectPreview({
      canvas, video: { videoWidth: 54, videoHeight: 96 }, camera: { isReady: () => true }, stageAspect: 9 / 16, mirror: true,
      settings: { ...config.effect, previewScale: 0.25, outputMode: 'off' },
      raf: (fn) => { queued = fn; return 1; }, cancelRaf: () => {}, now: () => time, log: { warn() {}, clear() {} },
    });
    const run = (frames) => { for (let i = 0; i < frames; i += 1) { time += 1000 / 60; const fn = queued; queued = null; fn?.(); } };
    const canvas2d = () => ({ width: 0, height: 0, getContext: () => ({ putImageData() {}, drawImage() {}, set imageSmoothingQuality(v) {} }) });
    const photo = createPhotoEffect({ preview, createCanvas: canvas2d, createImageData: (p, w, h) => ({ p, w, h }), log: { warn() {}, clear() {} } });
    preview.start();
    run(3);
    assert.equal(preview.getState().status, EffectStatus.RUNNING);
    const raw = { ...canvas2d(), width: 1080, height: 1920 };
    return { fake, preview, photo, run, raw };
  }

  it('결과 화소를 읽기 직전 컨텍스트 손실 → 원본 사진, 상태는 applied가 아님', async () => {
    const t = setup();
    t.fake.onReadPixels((f) => f.lose());
    assert.equal(await t.photo.apply(t.raw), t.raw);
    const { last } = t.photo.getStats();
    assert.equal(last.status, 'raw');
    assert.match(last.reason, /context-lost/);
  });

  it('결과 화소 읽기 INVALID_OPERATION → 원본 사진, 상태는 applied가 아님', async () => {
    const t = setup();
    t.fake.failNextCall('readPixels');
    assert.equal(await t.photo.apply(t.raw), t.raw);
    assert.equal(t.photo.getStats().last.status, 'raw');
    assert.match(t.photo.getStats().last.reason, /render-failed: GL error 0x502/);
    // 오류가 없으면 다음 촬영은 효과 사진
    assert.equal((await t.photo.apply(t.raw)) === t.raw, false);
    assert.equal(t.photo.getStats().last.status, 'applied');
  });

  it('미리보기 그림 중 GL 오류 → 원본 미리보기(fallback)', () => {
    const t = setup();
    t.fake.failNextCall('drawArraysInstanced');
    t.run(5);
    const s = t.preview.getState();
    assert.equal(s.status, EffectStatus.FALLBACK);
    assert.match(s.fault, /GL error 0x502 during preview render/);
    assert.deepEqual(t.fake.liveCount(), ZERO, '버린 렌더러의 자원도 지운다');
  });
});

describe('oil-renderer: 감열지 출력 단계 (6-1, 가짜 WebGL2)', () => {
  // 6-1 경로는 흑백 스타일 톤 점으로 본다. 흑백 스타일은 아래 7-1 테스트
  const thermal = (over = {}) => normalizeEffectSettings({ ...config.effect, outputMode: 'thermal', paperDots: 128, bwStyle: 'tone', ...over }, config.effect).settings;
  const P = { w: 128, h: 230 }; // 20x36 그림 → 용지 128점: 세로 round(128 * 36 / 20) = 230

  // readPixels 흉내: 4점씩 묶은 대상(P.w/4 x P.h)을 GL 방향(아래 줄부터)으로 채운다. fill(바이트 = 점 x, 위에서 y) → 값
  function fillReads(fake, ...fills) {
    const reads = [];
    fake.onReadPixels((f, [, , w, h, , , buf]) => {
      reads.push([w, h]);
      const fill = fills[reads.length - 1];
      if (!fill) return;
      for (let row = 0; row < h; row += 1) for (let i = 0; i < w * 4; i += 1) buf[row * w * 4 + i] = fill(i, h - 1 - row);
    });
    return reads;
  }

  it('결과(print): 인쇄 해상도의 회색과 GPU 디더 마스크를 위 줄부터 돌려준다 (읽기 2번, 4점씩 묶어 4분의 1)', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    const reads = fillReads(fake, (x, y) => (x + y) % 256, (x, y) => (y === 0 && x < 3 ? 255 : 0));
    const out = renderer.render({}, { ...small, settings: thermal(), output: 'print' });
    assert.deepEqual(reads, [[P.w / 4, P.h], [P.w / 4, P.h]]);
    assert.deepEqual([out.printWidth, out.printHeight], [P.w, P.h]);
    assert.equal(out.gray[0], 0);
    assert.equal(out.gray[5 * P.w + 7], 12, '위에서 5번째 줄, 7번째 점');
    assert.deepEqual([...out.mask.slice(0, 4)], [1, 1, 1, 0]);
    assert.equal(out.mask.reduce((t, v) => t + v, 0), 3);
    assert.deepEqual([fake.canvas.width, fake.canvas.height], [0, 0], '결과는 화면 캔버스를 건드리지 않는다');
  });

  it('미리보기: 문턱값 디더는 화소를 읽지 않고, 오차 확산은 회색을 읽어 CPU 디더 뒤 마스크를 올린다. 캔버스는 화면 크기', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    const reads = fillReads(fake, () => 200);
    renderer.render({}, { ...small, settings: thermal({ dither: 'blue-noise' }), displayWidth: 270, displayHeight: 480 });
    assert.equal(reads.length, 0);
    assert.deepEqual([fake.canvas.width, fake.canvas.height], [270, 480]);
    assert.equal(renderer.getStats().readMs, null);
    renderer.render({}, { ...small, settings: thermal({ dither: 'atkinson' }) });
    assert.deepEqual(reads, [[P.w / 4, P.h]]);
    const stats = renderer.getStats();
    assert.deepEqual([stats.outputMode, stats.dither, stats.printWidth, stats.printHeight], ['thermal', 'atkinson', P.w, P.h]);
    assert.ok(stats.readMs >= 0 && stats.ditherMs >= 0);
    renderer.render({}, { ...small, settings: thermal({ outputMode: 'off' }) });
    assert.deepEqual([fake.canvas.width, fake.canvas.height], [20, 36], '끄면 그리는 해상도');
  });

  it('출력 모드와 맞지 않는 결과 요청은 예외 (감열지 → print, 끔·회색조 → pixels)', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    assert.throws(() => renderer.render({}, { ...small, settings: thermal(), output: 'pixels' }), /does not fit/);
    assert.throws(() => renderer.render({}, { ...small, output: 'print' }), /does not fit/);
  });

  it('결과 화소 읽기 직전 손실·INVALID_OPERATION은 예외 (빈 마스크를 성공으로 넘기지 않는다)', () => {
    const cases = [
      [(f) => f.onReadPixels((g) => g.lose()), EffectFault.CONTEXT_LOST],
      [(f) => f.failNextCall('readPixels'), EffectFault.RENDER_FAILED],
    ];
    for (const [inject, fault] of cases) {
      const fake = createFakeWebGL2();
      const renderer = createOilRenderer({ canvas: fake.canvas });
      inject(fake);
      assert.throws(() => renderer.render({}, { ...small, settings: thermal(), output: 'print' }), (e) => e.fault === fault);
    }
  });

  it('dispose는 인쇄 대상·문턱 지도·마스크 텍스처까지 모두 지운다. 용지 폭을 바꿔도 인쇄 묶음은 2개까지', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    for (const dither of ['blue-noise', 'bayer', 'atkinson', 'floyd-steinberg']) {
      renderer.render({}, { ...small, settings: thermal({ dither }) });
      renderer.render(null, { ...small, settings: thermal({ dither }), output: 'print' });
    }
    renderer.render({}, { ...small, settings: thermal({ paperDots: 256, dither: 'atkinson' }) });
    const two = fake.liveCount(); // 인쇄 묶음 2개 (128, 256)
    for (const paperDots of [384, 512, 128, 256]) renderer.render({}, { ...small, settings: thermal({ paperDots, dither: 'atkinson' }) });
    const after = fake.liveCount(); // 다시 만든 128 묶음에는 결과용 bits가 없어 같거나 적다
    assert.ok(after.texture <= two.texture && after.framebuffer <= two.framebuffer, `묶음이 쌓인다: ${JSON.stringify(two)} -> ${JSON.stringify(after)}`);
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO);
  });

  it('인쇄 대상 만들기가 거듭 실패해도 쌓이지 않는다', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    renderer.render({}, small); // 유화 묶음 (컬러)
    const before = fake.liveCount();
    const base = fake.framebufferChecks();
    fake.failFramebufferAt((i) => i > base);
    for (let i = 0; i < 5; i += 1) {
      assert.throws(() => renderer.render({}, { ...small, settings: thermal() }), (e) => e.fault === EffectFault.FRAMEBUFFER_INCOMPLETE);
    }
    assert.deepEqual(fake.liveCount(), before);
    fake.failFramebufferAt(() => false);
    renderer.render({}, { ...small, settings: thermal() });
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO);
  });
});

describe('oil-renderer: 흑백 스타일 (7-1, 가짜 WebGL2)', () => {
  const style = (bwStyle, over = {}) => normalizeEffectSettings({ ...config.effect, outputMode: 'thermal', paperDots: 128, bwStyle, ...over }, config.effect).settings;
  const P = { w: 128, h: 230 };
  function countReads(fake) {
    const reads = [];
    fake.onReadPixels((f, [, , w, h, , , buf]) => {
      reads.push([w, h]);
      buf.fill([100, 50, 255][reads.length - 1] ?? 0); // 결과: 회색 100, 문턱 50, GPU 점 흰색
    });
    return reads;
  }

  it('붓 결 선·흐름 선 결과(print): 회색·점별 문턱·GPU 점 그림을 읽는다 (3번, 4점씩 묶음)', () => {
    for (const bwStyle of ['stroke', 'flow']) {
      const fake = createFakeWebGL2();
      const renderer = createOilRenderer({ canvas: fake.canvas });
      const reads = countReads(fake);
      const out = renderer.render({}, { ...small, settings: style(bwStyle), output: 'print' });
      assert.deepEqual(reads, [[P.w / 4, P.h], [P.w / 4, P.h], [P.w / 4, P.h]], bwStyle);
      assert.deepEqual([out.gray[0], out.thr[0], out.mask[0], out.thr.length], [100, 50, 1, P.w * P.h]);
      renderer.dispose();
      assert.deepEqual(fake.liveCount(), ZERO);
    }
  });

  it('미리보기: 흐름 선·붓 결 선·질감 강조 점(블루 노이즈)은 화소를 읽지 않는다. D용 상태에 스타일과 점을 정하는 것', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    const reads = countReads(fake);
    for (const [bwStyle, screen] of [['stroke', 'stroke-lines'], ['flow', 'flow-lines'], ['texture', 'blue-noise']]) {
      renderer.render({}, { ...small, settings: style(bwStyle, { dither: 'blue-noise' }), displayWidth: 270, displayHeight: 480 });
      const stats = renderer.getStats();
      assert.deepEqual([stats.bwStyle, stats.screen, stats.readMs], [bwStyle, screen, null]);
    }
    assert.equal(reads.length, 0);
    renderer.render({}, { ...small, settings: style('texture', { dither: 'atkinson' }) }); // 질감 강조 + 오차 확산은 회색을 읽는다
    assert.deepEqual(reads, [[P.w / 4, P.h]]);
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO, '흑백 스타일 밝기(bw)·점별 문턱(thr)도 지운다');
  });

  it('톤 점이 아닌 스타일은 흑백 준비·문턱 패스를 더 쓰고, 톤 점은 6-1과 같은 패스 수', () => {
    const draws = (bwStyle) => {
      const fake = createFakeWebGL2();
      let n = 0;
      const original = fake.gl.drawArrays;
      fake.gl.drawArrays = (...args) => { n += 1; return original(...args); };
      const renderer = createOilRenderer({ canvas: fake.canvas });
      renderer.render({}, { ...small, settings: style(bwStyle, { dither: 'blue-noise' }) });
      renderer.dispose();
      return n;
    };
    const tone = draws('tone');
    assert.equal(draws('texture'), tone + 1, '흑백 준비(FS_BW_PREP)');
    assert.equal(draws('stroke'), tone + 2, '흑백 준비 + 점별 문턱(FS_THERMAL_SCREEN)');
    assert.equal(draws('flow'), tone + 2);
  });
});

describe('촬영 결과 감열지 경로 (실제 미리보기·렌더러·결과 단계 + 가짜 WebGL2, 6-1)', () => {
  const canvas2d = (w = 0, h = 0) => ({
    width: w, height: h, getContext: () => ({
      putImageData() {}, drawImage() {}, set imageSmoothingQuality(v) {},
      getImageData: (x, y, gw, gh) => ({ data: new Uint8ClampedArray(gw * gh * 4).fill(255) }), // 흰 원본
    }),
  });

  function setup(over = {}) {
    const fake = createFakeWebGL2();
    const listeners = new Map();
    const canvas = Object.assign(fake.canvas, {
      hidden: true, style: {},
      addEventListener: (type, fn) => listeners.set(type, fn),
      removeEventListener: (type) => listeners.delete(type),
    });
    let queued = null;
    let time = 10000;
    const preview = createEffectPreview({
      canvas, video: { videoWidth: 54, videoHeight: 96 }, camera: { isReady: () => true }, stageAspect: 9 / 16, mirror: true,
      settings: { ...config.effect, previewScale: 0.25, outputMode: 'thermal', paperDots: 128, bwStyle: 'tone', ...over },
      raf: (fn) => { queued = fn; return 1; }, cancelRaf: () => {}, now: () => time, log: { warn() {}, clear() {} },
    });
    const run = (frames) => { for (let i = 0; i < frames; i += 1) { time += 1000 / 60; const fn = queued; queued = null; fn?.(); } };
    const photo = createPhotoEffect({
      preview, createCanvas: () => canvas2d(), createImageData: (p, w, h) => ({ p, w, h }), log: { warn() {}, clear() {} },
    });
    preview.start();
    run(3);
    assert.equal(preview.getState().status, EffectStatus.RUNNING);
    return { fake, preview, photo, run, raw: canvas2d(1080, 1920), canvas };
  }

  it('효과 사진: 화면용 PNG(인쇄 해상도) + 1비트 인쇄 데이터, GPU 디더와 CPU 같은 식이 비트 단위로 같다', async () => {
    const t = setup();
    // 그리는 해상도 1080x1920 x 0.25 = 270x480 → 용지 128점: 128 x round(128 x 480 / 270) = 128x228. 화면은 결과 크기 1080x1920
    assert.deepEqual([t.canvas.width, t.canvas.height], [1080, 1920]);
    const out = await t.photo.apply(t.raw);
    assert.equal(out.type, 'image/png');
    assert.equal(out.dots, true, '1비트 점 사진 표시 (결과 화면이 1:1 폭으로 놓는다)');
    assert.deepEqual([out.canvas.width, out.canvas.height], [1080, 1920], '화면용 이미지(b)는 결과 크기로 확대');
    assert.deepEqual([out.print.width, out.print.height, out.print.bytesPerRow, out.print.bits.length], [128, 228, 16, 16 * 228]);
    assert.deepEqual([out.print.pngBitDepth, out.print.pngColorType], [1, 0]);
    const { last } = t.photo.getStats();
    assert.equal(last.status, 'applied');
    assert.equal(last.check, 'gpu=cpu');
    assert.equal(last.sameAsPreview, true);
  });

  it('붓 결 선(7-1): 결과는 GPU 점 그림이고, 읽은 점별 문턱으로 CPU가 다시 비교한다 (같으면 gpu=cpu)', async () => {
    const t = setup({ bwStyle: 'stroke' });
    const reads = [];
    t.fake.onReadPixels((f, [, , w, h, , , buf]) => { reads.push(w); buf.fill([100, 50, 255][reads.length - 1] ?? 0); });
    const out = await t.photo.apply(t.raw);
    assert.equal(reads.length, 3);
    assert.equal(out.print.blackRatio, 0);
    const { last } = t.photo.getStats();
    assert.deepEqual([last.status, last.check, last.dither], ['applied', 'gpu=cpu', 'stroke-lines']);
  });

  it('붓 결 선(7-1): 효과를 그리지 못하면 원본 사진에 톤 점(설정한 점 방식)으로 감열지 (획이 없으므로)', async () => {
    const t = setup({ bwStyle: 'stroke', dither: 'bayer' });
    t.fake.onReadPixels((f) => f.lose());
    const out = await t.photo.apply(t.raw);
    assert.deepEqual([out.print.width, out.print.height], [128, 228]);
    const { last } = t.photo.getStats();
    assert.deepEqual([last.status, last.mode, last.dither], ['raw', 'thermal', 'bayer']);
    assert.match(last.reason, /context-lost.*\(style stroke -> tone\)/);
  });

  it('결과 화소 읽기 직전 손실 → 원본 사진에 같은 출력 단계를 CPU로 (인쇄 데이터도 만든다)', async () => {
    const t = setup({ dither: 'floyd-steinberg' });
    t.fake.onReadPixels((f) => f.lose());
    const out = await t.photo.apply(t.raw);
    assert.equal(out.type, 'image/png');
    assert.deepEqual([out.print.width, out.print.height], [128, 228]);
    assert.equal(out.print.blackRatio, 0, '흰 원본 → 흰 종이');
    const { last } = t.photo.getStats();
    assert.deepEqual([last.status, last.mode], ['raw', 'thermal']);
    assert.match(last.reason, /context-lost/);
  });

  it('출력 단계(PNG 압축)가 실패하면 원본 컬러 사진으로 대신한다', async () => {
    const t = setup();
    const photo = createPhotoEffect({
      preview: t.preview, createCanvas: () => canvas2d(), createImageData: (p) => p,
      deflate: async () => { throw new Error('no CompressionStream'); }, log: { warn() {}, clear() {} },
    });
    assert.equal(await photo.apply(t.raw), t.raw);
    const { last } = photo.getStats();
    assert.deepEqual([last.status, last.mode], ['raw', 'off']);
    assert.match(last.reason, /thermal output failed: no CompressionStream/);
  });
});

describe('oil-renderer: 회색조 유화 (8단계, 가짜 WebGL2)', () => {
  const grayOil = (over = {}) => normalizeEffectSettings({ ...config.effect, outputMode: 'gray-oil', paperDots: 128, ...over }, config.effect).settings;
  const P = { w: 128, h: 230 }; // 20x36 그림 → 용지 128점

  // uniform 값을 프로그램(패스)마다 기록한다: 마지막 useProgram 이후의 uniform 이름 → 값
  function recordPasses(fake) {
    const passes = [];
    const wrap = (name) => {
      const original = fake.gl[name];
      fake.gl[name] = (loc, ...v) => { passes.at(-1)?.set(loc?.name, v.length === 1 ? v[0] : v); return original(loc, ...v); };
    };
    const use = fake.gl.useProgram;
    fake.gl.useProgram = (p) => { passes.push(new Map()); return use(p); };
    for (const name of ['uniform1f', 'uniform2fv', 'uniform3fv']) wrap(name);
    return passes;
  }

  it('미리보기: 색 보정 앞에 입력 회색조 패스 하나(Rec.709 계수, 크롭·반전은 이 패스가), 색 보정은 회색 그림을 그대로 읽고, 출력은 회색조', () => {
    const fake = createFakeWebGL2();
    const passes = recordPasses(fake);
    const renderer = createOilRenderer({ canvas: fake.canvas });
    const mirror = { sourceOffset: [0.9, 0], sourceScale: [-0.8, 1] };
    renderer.render({}, { ...small, ...mirror, settings: grayOil() });
    const input = passes.find((p) => p.has('uLuma'));
    assert.deepEqual([...input.get('uLuma')], [...INPUT_LUMA]);
    assert.deepEqual([input.get('uSrcOffset'), input.get('uSrcScale')], [[0.9, 0], [-0.8, 1]]);
    const grade = passes.find((p) => p.has('uAmt'));
    assert.deepEqual([grade.get('uSrcOffset'), grade.get('uSrcScale'), grade.get('uAmt')], [[0, 0], [1, 1], 1], '원본 색 보정 그대로, 크롭·반전 없이');
    assert.ok(passes.indexOf(input) < passes.indexOf(grade), '입력 회색조가 색 보정보다 먼저');
    assert.equal(passes.at(-1).get('uGray'), 1, '출력 단계 회색조 (무채색)');
    assert.deepEqual([fake.canvas.width, fake.canvas.height], [20, 36]);
    assert.equal(renderer.getStats().outputMode, 'gray-oil');

    // 다른 모드는 입력 회색조 패스가 없고, 색 보정이 크롭·반전을 한다 (6-1·7-1 그대로)
    for (const outputMode of ['off', 'gray', 'thermal']) {
      passes.length = 0;
      renderer.render({}, { ...small, ...mirror, settings: grayOil({ outputMode, bwStyle: 'tone' }) });
      assert.ok(!passes.some((p) => p.has('uLuma')), outputMode);
      assert.deepEqual(passes.find((p) => p.has('uAmt')).get('uSrcScale'), [-0.8, 1], outputMode);
    }
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO, '입력 회색조 텍스처도 지운다');
  });

  it('미리보기 패스 수: 회색조 유화 = 회색조 + 1 (입력 회색조만 더한다), 화소는 읽지 않는다', () => {
    const draws = (outputMode) => {
      const fake = createFakeWebGL2();
      let n = 0;
      let reads = 0;
      const original = fake.gl.drawArrays;
      fake.gl.drawArrays = (...args) => { n += 1; return original(...args); };
      fake.onReadPixels(() => { reads += 1; });
      const renderer = createOilRenderer({ canvas: fake.canvas });
      renderer.render({}, { ...small, settings: grayOil({ outputMode }) });
      renderer.dispose();
      assert.equal(reads, 0, outputMode);
      return n;
    };
    assert.equal(draws('gray-oil'), draws('gray') + 1);
  });

  it('결과(pixels): 결과 크기 화소 + 같은 합성 그림에서 만든 인쇄용 회색·GPU 점(톤 점 경로). 흑백 스타일은 쓰지 않는다', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    const reads = [];
    fake.onReadPixels((f, [, , w, h, , , buf]) => { reads.push([w, h]); buf.fill([7, 100, 255][reads.length - 1] ?? 0); });
    const out = renderer.render({}, { ...small, settings: grayOil({ bwStyle: 'stroke' }), output: 'pixels' });
    assert.deepEqual(reads, [[20, 36], [P.w / 4, P.h], [P.w / 4, P.h]], '화소 1번 + 인쇄 회색 + GPU 점 (붓 결 선 문턱은 읽지 않는다)');
    assert.equal(out.pixels.length, 20 * 36 * 4);
    assert.deepEqual([out.printWidth, out.printHeight, out.gray[0], out.mask[0], out.thr], [P.w, P.h, 100, 1, null]);
    assert.deepEqual([fake.canvas.width, fake.canvas.height], [0, 0], '결과는 화면 캔버스를 건드리지 않는다');
    // 오차 확산이면 회색만 읽어 CPU로
    reads.length = 0;
    const fs = renderer.render(null, { ...small, settings: grayOil({ dither: 'floyd-steinberg' }), output: 'pixels' });
    assert.deepEqual(reads, [[20, 36], [P.w / 4, P.h]]);
    assert.equal(fs.mask.length, P.w * P.h);
    // 끔·회색조 결과에는 인쇄 데이터가 없다
    for (const outputMode of ['off', 'gray']) {
      const plain = renderer.render(null, { ...small, settings: grayOil({ outputMode }), output: 'pixels' });
      assert.deepEqual([plain.mask, plain.gray], [undefined, undefined], outputMode);
    }
    assert.throws(() => renderer.render(null, { ...small, settings: grayOil(), output: 'print' }), /does not fit/);
    renderer.dispose();
    assert.deepEqual(fake.liveCount(), ZERO);
  });

  it('결과 인쇄 데이터를 읽기 직전 손실·INVALID_OPERATION은 예외', () => {
    for (const [inject, fault] of [
      [(f) => { let n = 0; f.onReadPixels((g) => { n += 1; if (n === 2) g.lose(); }); }, EffectFault.CONTEXT_LOST],
      [(f) => f.failNextCall('readPixels'), EffectFault.RENDER_FAILED],
    ]) {
      const fake = createFakeWebGL2();
      const renderer = createOilRenderer({ canvas: fake.canvas });
      inject(fake);
      assert.throws(() => renderer.render({}, { ...small, settings: grayOil(), output: 'pixels' }), (e) => e.fault === fault);
    }
  });
});

describe('촬영 결과 회색조 유화 경로 (실제 미리보기·렌더러·결과 단계 + 가짜 WebGL2, 8단계)', () => {
  const canvas2d = (w = 0, h = 0, fill = 255) => ({
    width: w, height: h, getContext: () => ({
      putImageData() {}, drawImage() {}, set imageSmoothingQuality(v) {},
      getImageData: (x, y, gw, gh) => ({ data: new Uint8ClampedArray(gw * gh * 4).fill(fill) }),
    }),
  });

  function setup(over = {}, photoOver = {}) {
    const fake = createFakeWebGL2();
    const canvas = Object.assign(fake.canvas, { hidden: true, style: {}, addEventListener() {}, removeEventListener() {} });
    let queued = null;
    let time = 10000;
    const preview = createEffectPreview({
      canvas, video: { videoWidth: 54, videoHeight: 96 }, camera: { isReady: () => true }, stageAspect: 9 / 16, mirror: true,
      settings: { ...config.effect, previewScale: 0.25, paperDots: 128, ...over },
      raf: (fn) => { queued = fn; return 1; }, cancelRaf: () => {}, now: () => time, log: { warn() {}, clear() {} },
    });
    const run = (frames) => { for (let i = 0; i < frames; i += 1) { time += 1000 / 60; const fn = queued; queued = null; fn?.(); } };
    const warnings = [];
    const photo = createPhotoEffect({
      preview, createCanvas: () => canvas2d(), createImageData: (p, w, h) => ({ p, w, h }),
      log: { warn: (k, m) => warnings.push(m), clear() {} }, ...photoOver,
    });
    preview.start();
    run(3);
    assert.equal(preview.getState().status, EffectStatus.RUNNING);
    return { fake, preview, photo, run, raw: canvas2d(1080, 1920), canvas, warnings };
  }

  it('기본 설정(회색조 유화): 사진은 결과 크기 캔버스(형식 없음 = JPEG), 인쇄 데이터 1비트·GPU 디더 = CPU, 점 사진 표시 없음', async () => {
    const t = setup();
    assert.equal(t.preview.getSettings().outputMode, 'gray-oil');
    // 결과는 1080x1920으로 그리므로 인쇄 해상도는 128 x round(128 x 1920 / 1080) = 128x228
    const out = await t.photo.apply(t.raw);
    assert.equal(out.type, undefined, 'capture.js 기본 형식(JPEG)');
    assert.equal(out.dots, undefined);
    assert.deepEqual([out.canvas.width, out.canvas.height], [1080, 1920]);
    assert.deepEqual([out.print.width, out.print.height, out.print.bytesPerRow, out.print.bits.length], [128, 228, 16, 16 * 228]);
    assert.deepEqual([out.print.pngBitDepth, out.print.pngColorType], [1, 0]);
    const { last } = t.photo.getStats();
    assert.deepEqual([last.status, last.mode, last.dither, last.check, last.sameAsPreview], ['applied', 'gray-oil', 'print blue-noise', 'gpu=cpu', true]);
    assert.deepEqual([last.print.width, last.print.height], [128, 228]);
  });

  it('인쇄 데이터만 실패하면(PNG 압축) 회색조 유화 사진은 그대로, 인쇄 데이터 없이 경고', async () => {
    const t = setup({}, { deflate: async () => { throw new Error('no CompressionStream'); } });
    const out = await t.photo.apply(t.raw);
    assert.deepEqual([out.width, out.height], [1080, 1920], '캔버스 그대로 (인쇄 데이터 없음)');
    assert.equal(out.print, undefined);
    const { last } = t.photo.getStats();
    assert.deepEqual([last.status, last.mode, last.print, last.check], ['applied', 'gray-oil', null, 'no print data']);
    assert.match(last.printError, /no CompressionStream/);
    assert.ok(t.warnings.some((m) => /print data not made/.test(m)));
  });

  it('인쇄 데이터를 만드는 중 회차가 취소되면 사진 캔버스를 비우고 예외', async () => {
    const controller = new AbortController();
    let made = null;
    const t = setup({}, {
      createCanvas: () => { made = canvas2d(); return made; },
      deflate: async (raw) => { controller.abort(new Error('cancelled')); return raw; },
    });
    await assert.rejects(t.photo.apply(t.raw, { signal: controller.signal }), /cancelled/);
    assert.deepEqual([made.width, made.height], [0, 0]);
  });

  it('효과를 그리지 못하면 원본 사진(결과 크기)을 입력 회색조·레벨로, 인쇄 데이터도 그 사진에서', async () => {
    const t = setup({ dither: 'atkinson' });
    t.fake.onReadPixels((f) => f.lose());
    const out = await t.photo.apply(t.raw);
    assert.equal(out.canvas, t.raw, '이미 결과 크기인 원본 캔버스를 회색으로');
    assert.deepEqual([out.print.width, out.print.height], [128, 228]);
    assert.equal(out.print.blackRatio, 0, '흰 원본 → 흰 종이');
    const { last } = t.photo.getStats();
    assert.deepEqual([last.status, last.mode, last.dither], ['raw', 'gray-oil', 'print atkinson']);
    assert.match(last.reason, /context-lost/);
  });
});
