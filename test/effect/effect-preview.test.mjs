// 실행: npm test  (또는 node --test test/effect/effect-preview.test.mjs)
// 실제 WebGL 없이 렌더러·캔버스·화면 갱신을 흉내 내 미리보기의 상태·장애 처리·그리는 시점을 본다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { computeCaptureCrop } from '../../src/web/camera/capture.js';
import { EffectStatus, computeEffectView, createEffectPreview } from '../../src/web/effect/effect-preview.js';
import { EffectError, EffectFault } from '../../src/web/effect/oil-renderer.js';

const STAGE = 9 / 16;

function fakeCanvas() {
  const listeners = new Map();
  return {
    hidden: true,
    style: { imageRendering: '' },
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    fire(type) {
      const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
      listeners.get(type)?.(event);
      return event;
    },
    listeners,
  };
}

function fakeRenderer({ failRender = null } = {}) {
  const calls = [];
  let lost = false;
  return {
    calls,
    gl: { isContextLost: () => lost },
    lose() { lost = true; },
    render(source, options) {
      if (failRender) throw failRender;
      calls.push({ source, ...options });
      return { strokes: 10, cpuMs: 1 };
    },
    dispose() { this.disposed = true; },
    getStats: () => ({ pxScale: 0.5, cpuMs: 1, gpuMs: null, timer: false, strokes: 10 }),
    renderer: () => 'fake',
  };
}

function setup({ ready = true, renderer = fakeRenderer(), createRenderer, settings = config.effect } = {}) {
  let time = 10000;
  let queued = null;
  const camera = { ready, isReady: () => camera.ready };
  const video = { videoWidth: 1080, videoHeight: 1920 };
  const canvas = fakeCanvas();
  const warnings = [];
  let changes = 0;
  const preview = createEffectPreview({
    canvas, video, camera, stageAspect: STAGE, mirror: true, settings,
    createRenderer: createRenderer ?? (() => renderer),
    raf: (fn) => { queued = fn; return 1; },
    cancelRaf: () => { queued = null; },
    now: () => time,
    log: { warn: (...args) => warnings.push(args.join(' ')), clear: () => {} },
    onChange: () => { changes += 1; },
  });
  return {
    preview, camera, video, canvas, renderer, warnings,
    changes: () => changes,
    /** ms만큼 지나며 60Hz 화면 갱신을 돌린다 */
    run(ms, step = 1000 / 60) {
      for (let t = 0; t < ms; t += step) {
        time += step;
        const fn = queued;
        queued = null;
        fn?.();
      }
    },
  };
}

describe('computeEffectView', () => {
  it('9:16 영상 + 반전: 전체를 좌우로 뒤집어 읽는다 (uv 왼쪽 아래 원점). 미리보기 = 결과 × 배율', () => {
    const view = computeEffectView({ videoWidth: 1080, videoHeight: 1920, stageAspect: STAGE, mirror: true, previewScale: 0.5 });
    assert.deepEqual(view, { width: 540, height: 960, resultWidth: 1080, resultHeight: 1920, sourceOffset: [1, 0], sourceScale: [-1, 1] });
  });

  it('반전 없음, 4K 입력: 결과는 1080x1920으로 줄인다 (짧은 변 1080)', () => {
    const view = computeEffectView({ videoWidth: 2160, videoHeight: 3840, stageAspect: STAGE, mirror: false, previewScale: 1 });
    assert.deepEqual(view, { width: 1080, height: 1920, resultWidth: 1080, resultHeight: 1920, sourceOffset: [0, 0], sourceScale: [1, 1] });
  });

  it('가로 영상: 캡처와 같은 가운데 영역을 읽는다 (cover)', () => {
    for (const [videoWidth, videoHeight] of [[1920, 1080], [640, 480], [1080, 1080], [1080, 2400]]) {
      const crop = computeCaptureCrop({ videoWidth, videoHeight, stageAspect: STAGE });
      for (const mirror of [false, true]) {
        const view = computeEffectView({ videoWidth, videoHeight, stageAspect: STAGE, mirror, previewScale: 1 });
        // 출력 왼쪽(u=0)·오른쪽(u=1)이 읽는 영상 x, 아래(v=0)·위(v=1)가 읽는 영상 y (위가 0인 영상 좌표로)
        const xAt = (u) => (view.sourceOffset[0] + u * view.sourceScale[0]) * videoWidth;
        const yTopAt = (v) => (1 - (view.sourceOffset[1] + v * view.sourceScale[1])) * videoHeight;
        const left = mirror ? xAt(1) : xAt(0);
        const right = mirror ? xAt(0) : xAt(1);
        assert.ok(Math.abs(left - crop.x) <= 0.5 && Math.abs(right - (crop.x + crop.width)) <= 0.5, `${videoWidth}x${videoHeight} x`);
        assert.ok(Math.abs(yTopAt(1) - crop.y) <= 0.5 && Math.abs(yTopAt(0) - (crop.y + crop.height)) <= 0.5, `${videoWidth}x${videoHeight} y`);
        assert.equal(Math.min(view.resultWidth, view.resultHeight), 1080);
        assert.ok(Math.abs(view.resultWidth / view.resultHeight - crop.width / crop.height) < 0.01);
        assert.deepEqual([view.width, view.height], [view.resultWidth, view.resultHeight]); // 배율 1
        // 반전이면 화면 왼쪽이 영상 오른쪽이다
        assert.equal(xAt(0) > xAt(1), mirror);
      }
    }
  });
});

describe('createEffectPreview', () => {
  it('카메라가 준비되면 그리고 캔버스를 보인다. 초당 그림 수만큼만 그린다', () => {
    const t = setup();
    t.preview.start();
    assert.equal(t.canvas.hidden, true);
    t.run(1000);
    const s = t.preview.getState();
    assert.equal(s.status, EffectStatus.RUNNING);
    assert.equal(t.canvas.hidden, false);
    assert.ok(t.renderer.calls.length >= 24 && t.renderer.calls.length <= 25, `${t.renderer.calls.length}`);
    assert.ok(s.drawingsPerSecond >= 24 && s.drawingsPerSecond <= 25, `${s.drawingsPerSecond}`); // 1초 창 양 끝에 걸치면 25
    const call = t.renderer.calls.at(-1);
    assert.equal(call.width, 1080);
    assert.equal(call.height, 1920);
    assert.deepEqual(call.sourceScale, [-1, 1]);
    assert.ok(call.seed >= 0 && call.seed < 997);
  });

  it('fps를 바꾸면 다음 갱신부터 그 빈도로 그린다 (setSettings)', () => {
    const t = setup();
    t.preview.start();
    t.run(1000);
    const issues = t.preview.setSettings({ fps: 8 });
    assert.deepEqual(issues, []);
    const before = t.renderer.calls.length;
    t.run(2000);
    const drawn = t.renderer.calls.length - before;
    assert.ok(drawn >= 16 && drawn <= 18, `${drawn}`);
    assert.equal(t.preview.getState().fps, 8);
  });

  it('범위 밖 설정은 맞춰서 쓰고 알려 준다', () => {
    const t = setup();
    t.preview.start();
    const issues = t.preview.setSettings({ boil: 3, previewScale: 0.1 });
    assert.deepEqual(issues, ['boil: 3 -> 1', 'previewScale: 0.1 -> 0.25']);
    t.run(100);
    assert.equal(t.renderer.calls.at(-1).settings.boil, 1);
    assert.equal(t.renderer.calls.at(-1).width, 270); // 결과 1080 x 0.25
  });

  it('카메라가 준비되지 않으면 그리지 않고 캔버스를 숨긴다 (앞 그림이 남지 않게)', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    assert.equal(t.canvas.hidden, false);
    t.camera.ready = false;
    const before = t.renderer.calls.length;
    t.run(500);
    assert.equal(t.renderer.calls.length, before);
    assert.equal(t.canvas.hidden, true);
    assert.equal(t.preview.getState().status, EffectStatus.WAITING_CAMERA);
    t.camera.ready = true;
    t.run(100);
    assert.equal(t.canvas.hidden, false);
  });

  it('WebGL2를 만들지 못하면 원본 미리보기 (캔버스 숨김, 그리기 없음)', () => {
    const t = setup({
      createRenderer: () => { throw new EffectError(EffectFault.WEBGL_UNAVAILABLE, 'getContext("webgl2") returned null'); },
    });
    t.preview.start();
    t.run(500);
    const s = t.preview.getState();
    assert.equal(s.status, EffectStatus.FALLBACK);
    assert.match(s.fault, /webgl2-unavailable/);
    assert.equal(t.canvas.hidden, true);
    assert.equal(t.warnings.length, 1);
  });

  it('그리기가 실패하면 원본 미리보기로 돌아가고 렌더러를 버린다', () => {
    const renderer = fakeRenderer({ failRender: new Error('boom') });
    const t = setup({ renderer });
    t.preview.start();
    t.run(500);
    assert.equal(t.preview.getState().status, EffectStatus.FALLBACK);
    assert.match(t.preview.getState().fault, /render-failed: boom/);
    assert.equal(renderer.disposed, true);
    assert.equal(t.canvas.hidden, true);
  });

  it('컨텍스트를 잃으면 원본 미리보기, 되살아나면 새 렌더러로 다시 효과', () => {
    let made = 0;
    const renderers = [];
    const t = setup({ createRenderer: () => { made += 1; const r = fakeRenderer(); renderers.push(r); return r; } });
    t.preview.start();
    t.run(200);
    assert.equal(t.canvas.hidden, false);
    const lost = t.canvas.fire('webglcontextlost');
    assert.equal(lost.defaultPrevented, true, '되살릴 수 있게 preventDefault');
    assert.equal(t.preview.getState().status, EffectStatus.CONTEXT_LOST);
    assert.equal(t.canvas.hidden, true);
    const drawsBefore = renderers[0].calls.length;
    t.run(500);
    assert.equal(renderers[0].calls.length, drawsBefore, '잃은 동안 그리지 않는다');
    t.canvas.fire('webglcontextrestored');
    t.run(200);
    assert.equal(made, 2);
    assert.equal(t.preview.getState().status, EffectStatus.RUNNING);
    assert.equal(t.preview.getState().contextLosses, 1);
    assert.equal(t.canvas.hidden, false);
    assert.ok(renderers[1].calls.length > 0);
  });

  it('renderStill: 화면의 마지막 그림과 같은 프레임(소스 다시 쓰기)·seed·설정으로 결과 크기에 화면 밖으로 그린다', () => {
    const t = setup();
    t.preview.start();
    t.preview.setSettings({ previewScale: 0.5 });
    t.run(200);
    const shown = t.renderer.calls.at(-1);
    assert.equal(shown.width, 540);
    const still = t.preview.renderStill();
    const call = t.renderer.calls.at(-1);
    assert.equal(call.source, null, '소스를 다시 올리지 않는다 = 미리보기가 그린 프레임');
    assert.equal(call.output, 'print', '기본 출력 모드는 감열지 (6-1)');
    assert.equal(still.mode, 'thermal');
    assert.equal(call.seed, shown.seed);
    assert.equal(call.settings, shown.settings);
    assert.deepEqual([call.width, call.height], [1080, 1920]);
    assert.deepEqual(call.sourceScale, shown.sourceScale);
    assert.equal(still.sameAsPreview, true);
    assert.equal(still.seed, shown.seed);
    assert.deepEqual([still.width, still.height], [1080, 1920]);
  });

  it('출력 모드: 감열지면 캔버스를 최근접 확대(pixelated), 결과는 print. 끔·회색조면 브라우저 기본 확대, 결과는 pixels (6-1)', () => {
    const t = setup();
    t.preview.start();
    t.run(100);
    assert.equal(t.canvas.style.imageRendering, 'pixelated');
    for (const mode of ['off', 'gray']) {
      t.preview.setSettings({ outputMode: mode });
      t.run(50);
      assert.equal(t.renderer.calls.at(-1).settings.outputMode, mode);
      assert.equal(t.canvas.style.imageRendering, '');
      const still = t.preview.renderStill();
      assert.equal(t.renderer.calls.at(-1).output, 'pixels');
      assert.equal(still.mode, mode);
    }
    t.preview.setSettings({ outputMode: 'thermal', dither: 'atkinson', paperDots: 384 });
    t.run(50);
    const shown = t.renderer.calls.at(-1);
    assert.deepEqual([shown.settings.dither, shown.settings.paperDots], ['atkinson', 384]);
    assert.equal(t.canvas.style.imageRendering, 'pixelated');
    const still = t.preview.renderStill();
    assert.equal(t.renderer.calls.at(-1).output, 'print');
    assert.equal(still.settings, shown.settings, '결과는 화면에 보이던 그림의 설정 그대로');
  });

  it('renderStill: 영상 크기가 바뀌었으면 지금 프레임으로 새로 그린다', () => {
    const t = setup();
    t.preview.start();
    t.run(100);
    t.video.videoWidth = 2160;
    t.video.videoHeight = 3840;
    const still = t.preview.renderStill();
    assert.equal(t.renderer.calls.at(-1).source, t.video);
    assert.equal(still.sameAsPreview, false);
    assert.deepEqual([still.width, still.height], [1080, 1920]);
  });

  it('renderStill: 효과가 돌고 있지 않으면 not-running 오류', () => {
    const t = setup({ createRenderer: () => { throw new EffectError(EffectFault.WEBGL_UNAVAILABLE, 'no'); } });
    t.preview.start();
    t.run(100);
    assert.throws(() => t.preview.renderStill(), (e) => e.fault === EffectFault.NOT_RUNNING && /fallback/.test(e.message));
  });

  it('enabled false면 시작하지 않는다', () => {
    const t = setup({ settings: { ...config.effect, enabled: false } });
    t.preview.start();
    t.run(500);
    assert.equal(t.preview.getState().status, EffectStatus.DISABLED);
    assert.equal(t.renderer.calls.length, 0);
    assert.equal(t.canvas.listeners.size, 0);
  });

  it('stop은 화면 갱신·이벤트를 풀고 렌더러를 정리한다', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    t.preview.stop();
    assert.equal(t.canvas.hidden, true);
    assert.equal(t.canvas.listeners.size, 0);
    assert.equal(t.renderer.disposed, true);
  });
});
