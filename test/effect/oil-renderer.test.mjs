// 실행: npm test  (또는 node --test test/effect/oil-renderer.test.mjs)
// 렌더러의 GPU 자원 정리와 실패 판정 (5단계 검수 1·2·3). 가짜 WebGL2(test/fixtures/fake-webgl2.mjs)로 장애를 주입한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { normalizeEffectSettings } from '../../src/web/config/effect-settings.js';
import { EffectStatus, createEffectPreview } from '../../src/web/effect/effect-preview.js';
import { EffectFault, createOilRenderer } from '../../src/web/effect/oil-renderer.js';
import { createPhotoEffect } from '../../src/web/effect/photo-effect.js';
import { createFakeWebGL2 } from '../fixtures/fake-webgl2.mjs';

const settings = normalizeEffectSettings(config.effect, config.effect).settings;
const small = { settings, width: 20, height: 36, seed: 3 };
const ZERO = { program: 0, shader: 0, texture: 0, framebuffer: 0, buffer: 0, vertexArray: 0 };

describe('oil-renderer: GPU 자원 정리 (검수 2·3)', () => {
  it('dispose는 만든 프로그램 8개를 그 객체로 지우고, 텍스처·프레임버퍼·버퍼·VAO도 모두 지운다', () => {
    const fake = createFakeWebGL2();
    const renderer = createOilRenderer({ canvas: fake.canvas });
    renderer.render({}, small); // 미리보기 묶음
    renderer.render(null, { ...small, width: 30, height: 54, output: 'pixels' }); // 결과 묶음 + out
    assert.equal(fake.created.program.length, 8);
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
      settings: { ...config.effect, previewScale: 0.25 },
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

  it('결과 화소를 읽기 직전 컨텍스트 손실 → 원본 사진, 상태는 applied가 아님', () => {
    const t = setup();
    t.fake.onReadPixels((f) => f.lose());
    assert.equal(t.photo.apply(t.raw), t.raw);
    const { last } = t.photo.getStats();
    assert.equal(last.status, 'raw');
    assert.match(last.reason, /context-lost/);
  });

  it('결과 화소 읽기 INVALID_OPERATION → 원본 사진, 상태는 applied가 아님', () => {
    const t = setup();
    t.fake.failNextCall('readPixels');
    assert.equal(t.photo.apply(t.raw), t.raw);
    assert.equal(t.photo.getStats().last.status, 'raw');
    assert.match(t.photo.getStats().last.reason, /render-failed: GL error 0x502/);
    // 오류가 없으면 다음 촬영은 효과 사진
    assert.equal(t.photo.apply(t.raw) === t.raw, false);
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
