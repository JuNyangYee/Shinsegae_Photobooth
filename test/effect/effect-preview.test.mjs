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

function fakeRenderer({ failRender = null, failWarm = null } = {}) {
  const calls = [];
  let lost = false;
  return {
    calls,
    gl: { isContextLost: () => lost },
    lose() { lost = true; },
    render(source, options) {
      if (failRender) throw failRender;
      if (failWarm && options.output === 'warm') throw failWarm;
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
  const idles = []; // requestIdleCallback 흉내: 번호 = 순번 + 1, 취소하면 null
  let lastIdle = 0;
  const preview = createEffectPreview({
    canvas, video, camera, stageAspect: STAGE, settings,
    createRenderer: createRenderer ?? (() => renderer),
    raf: (fn) => { queued = fn; return 1; },
    cancelRaf: () => { queued = null; },
    now: () => time,
    log: { warn: (...args) => warnings.push(args.join(' ')), clear: () => {} },
    onChange: () => { changes += 1; },
    idle: (fn) => idles.push(fn),
    cancelIdle: (id) => { idles[id - 1] = null; },
  });
  return {
    preview, camera, video, canvas, renderer, warnings,
    changes: () => changes,
    /** 아직 돌지 않은 idle 호출 수 */
    pendingIdle: () => idles.slice(lastIdle).filter(Boolean).length,
    /** 브라우저가 한가해졌다: 기다리던 idle 호출을 돌린다 */
    flushIdle() {
      while (lastIdle < idles.length) {
        const fn = idles[lastIdle];
        lastIdle += 1;
        fn?.();
      }
    },
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
  it('카메라가 준비되면 그리고 캔버스를 보인다. 초당 그림 수(기본값 12)만큼만, 처리 해상도(기본값 0.5)로 그린다', () => {
    const t = setup();
    t.preview.start();
    assert.equal(t.canvas.hidden, true);
    t.run(1000);
    const s = t.preview.getState();
    assert.equal(s.status, EffectStatus.RUNNING);
    assert.equal(t.canvas.hidden, false);
    assert.ok(t.renderer.calls.length >= 12 && t.renderer.calls.length <= 13, `${t.renderer.calls.length}`);
    assert.ok(s.drawingsPerSecond >= 12 && s.drawingsPerSecond <= 13, `${s.drawingsPerSecond}`); // 1초 창 양 끝에 걸치면 13
    const call = t.renderer.calls.at(-1);
    assert.equal(call.width, 540);
    assert.equal(call.height, 960);
    assert.deepEqual([call.displayWidth, call.displayHeight], [1080, 1920]);
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
    assert.equal(call.output, 'pixels', '기본 출력 모드는 회색조 유화 (8단계): 결과 크기 화소 + 인쇄 데이터');
    assert.equal(still.mode, 'gray-oil');
    assert.equal(call.seed, shown.seed);
    assert.equal(call.settings, shown.settings);
    assert.deepEqual([call.width, call.height], [1080, 1920]);
    assert.deepEqual(call.sourceScale, shown.sourceScale);
    assert.equal(still.sameAsPreview, true);
    assert.equal(still.seed, shown.seed);
    assert.deepEqual([still.width, still.height], [1080, 1920]);
  });

  it('출력 모드: 화면 크기는 결과 크기로 넘기고(감열지 화면 확대용), 결과는 감열지면 print, 끔·회색조면 pixels (6-1)', () => {
    const t = setup();
    t.preview.start();
    t.preview.setSettings({ previewScale: 0.5 });
    t.run(100);
    const first = t.renderer.calls.at(-1);
    assert.deepEqual([first.width, first.displayWidth, first.displayHeight], [540, 1080, 1920]);
    for (const mode of ['off', 'gray', 'gray-oil']) {
      t.preview.setSettings({ outputMode: mode });
      t.run(50);
      assert.equal(t.renderer.calls.at(-1).settings.outputMode, mode);
      const still = t.preview.renderStill();
      assert.equal(t.renderer.calls.at(-1).output, 'pixels');
      assert.equal(still.mode, mode);
    }
    t.preview.setSettings({ outputMode: 'thermal', dither: 'atkinson', paperDots: 384 });
    t.run(50);
    const shown = t.renderer.calls.at(-1);
    assert.deepEqual([shown.settings.dither, shown.settings.paperDots], ['atkinson', 384]);
    assert.equal(t.canvas.style.imageRendering, '', 'CSS 확대 방식은 건드리지 않는다');
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

  it('좌우 반전은 설정(mirror)을 따른다: 기본값 켬, 끄면 다음 갱신에 반전 없이 다시 읽는다 (CSS 반전 없음)', () => {
    const t = setup();
    t.preview.start();
    t.run(100);
    assert.deepEqual(t.renderer.calls.at(-1).sourceScale, [-1, 1], '기본값 켬: x를 뒤집어 읽는다');
    assert.deepEqual(t.renderer.calls.at(-1).sourceOffset, [1, 0]);
    const drawn = t.renderer.calls.length;
    t.preview.setSettings({ mirror: false });
    assert.equal(t.preview.getSettings().mirror, false);
    t.run(1000 / 60); // 그림 번호가 같아도 설정이 바뀌면 바로 다시 그린다
    assert.equal(t.renderer.calls.length, drawn + 1);
    assert.deepEqual(t.renderer.calls.at(-1).sourceScale, [1, 1]);
    assert.deepEqual(t.renderer.calls.at(-1).sourceOffset, [0, 0]);
    assert.equal(t.canvas.style.transform, undefined, '캔버스에는 CSS 반전을 걸지 않는다');
  });

  it('renderStill: 마지막 그림 뒤 반전이 바뀌었으면 그 그림을 쓰지 않고 지금 프레임·셔터 순간 반전으로 그린다', () => {
    const t = setup();
    t.preview.start();
    t.run(100);
    t.preview.setSettings({ mirror: false }); // 다음 화면 갱신 전에 셔터
    const still = t.preview.renderStill();
    const call = t.renderer.calls.at(-1);
    assert.equal(call.source, t.video, '지금 프레임을 다시 올린다');
    assert.deepEqual(call.sourceScale, [1, 1]);
    assert.equal(still.sameAsPreview, false);
    assert.equal(still.settings.mirror, false);
    // 다음 그림이 반전 없이 그려진 뒤의 셔터는 그 그림을 그대로 쓴다
    t.run(100);
    const again = t.preview.renderStill();
    assert.equal(again.sameAsPreview, true);
    assert.deepEqual(t.renderer.calls.at(-1).sourceScale, [1, 1]);
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

describe('결과 사진 준비 (첫 촬영 멈춤 수정, 로그 2026-10-19-07)', () => {
  const warms = (renderer) => renderer.calls.filter((c) => c.output === 'warm');

  it('미리보기가 그려진 뒤 한가할 때 결과 크기로 한 번 미리 그린다 (같은 소스·seed·설정, 화소는 읽지 않는 warm)', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    assert.equal(warms(t.renderer).length, 0, '그리는 갱신 안에서는 하지 않는다');
    assert.equal(t.pendingIdle(), 1);
    assert.equal(t.preview.getState().resultPrepare, 'pending');
    t.flushIdle();
    const [warm] = warms(t.renderer);
    const shown = t.renderer.calls.filter((c) => c.output !== 'warm').at(-1);
    assert.equal(warm.source, null, '미리보기가 올린 프레임을 다시 쓴다');
    assert.deepEqual([warm.width, warm.height], [1080, 1920]);
    assert.equal(warm.seed, shown.seed);
    assert.equal(warm.settings, shown.settings);
    assert.deepEqual(warm.sourceScale, shown.sourceScale);
    const s = t.preview.getState();
    assert.equal(s.resultPrepare, 'ready');
    assert.equal(typeof s.prepareMs, 'number');
    assert.deepEqual([s.resultWidth, s.resultHeight], [1080, 1920]);
  });

  it('한 번 준비하면 같은 조건으로 다시 하지 않는다 (그림이 바뀌어도, 결과에 영향 없는 설정을 바꿔도)', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    t.flushIdle();
    t.run(1000);
    t.preview.setSettings({ strength: 0.5, fps: 8, grade: 0.5 });
    t.run(500);
    assert.equal(t.pendingIdle(), 0);
    t.flushIdle();
    assert.equal(warms(t.renderer).length, 1);
    t.preview.renderStill();
    assert.equal(warms(t.renderer).length, 1);
  });

  it('처리 해상도(미리보기 크기)·용지 폭·출력 모드·붓 크기·boil이 바뀌면 다시 준비한다', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    t.flushIdle();
    let expected = 1;
    for (const change of [{ previewScale: 0.75 }, { paperDots: 384 }, { outputMode: 'thermal' }, { dither: 'atkinson' }, { bwStyle: 'flow' },
      { size: 1.5 }, { boil: 0.2 }]) {
      t.preview.setSettings(change);
      t.run(100);
      assert.equal(t.preview.getState().resultPrepare, 'pending', JSON.stringify(change));
      t.flushIdle();
      expected += 1;
      assert.equal(warms(t.renderer).length, expected, JSON.stringify(change));
      assert.equal(warms(t.renderer).at(-1).settings, t.preview.getSettings());
    }
    // 영상 크기가 바뀌어도 결과는 9:16 영역의 짧은 변 1080이라 같은 크기다: 다시 준비하지 않는다
    t.video.videoWidth = 1920;
    t.video.videoHeight = 1080;
    t.run(100);
    t.flushIdle();
    assert.equal(warms(t.renderer).length, expected);
  });

  it('처리 해상도 1이면 결과가 미리보기 대상 묶음을 그대로 쓰므로 준비하지 않는다', () => {
    const t = setup();
    t.preview.start();
    t.preview.setSettings({ previewScale: 1 });
    t.run(500);
    t.flushIdle();
    assert.equal(warms(t.renderer).length, 0);
    assert.equal(t.preview.getState().resultPrepare, 'same-size');
  });

  it('컨텍스트를 잃으면 기다리던 준비를 취소하고, 되살아나면 새 렌더러로 다시 준비한다', () => {
    const renderers = [];
    const t = setup({ createRenderer: () => { const r = fakeRenderer(); renderers.push(r); return r; } });
    t.preview.start();
    t.run(200);
    t.flushIdle();
    assert.equal(warms(renderers[0]).length, 1);
    t.preview.setSettings({ paperDots: 384 });
    t.run(100);
    assert.equal(t.pendingIdle(), 1);
    t.canvas.fire('webglcontextlost');
    assert.equal(t.pendingIdle(), 0, '잃은 렌더러로 준비하지 않는다');
    t.flushIdle();
    assert.equal(warms(renderers[0]).length, 1);
    t.canvas.fire('webglcontextrestored');
    t.run(200);
    t.flushIdle();
    assert.equal(renderers.length, 2);
    assert.equal(warms(renderers[1]).length, 1, '같은 설정이어도 새 렌더러는 다시 준비한다');
    assert.equal(t.preview.getState().resultPrepare, 'ready');
  });

  it('준비 전에 셔터가 눌리면 결과 렌더가 그 자리에서 그리고(예전과 같다), 그 뒤 준비는 건너뛴다', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    assert.equal(t.pendingIdle(), 1);
    const still = t.preview.renderStill();
    assert.equal(t.renderer.calls.at(-1).output, 'pixels');
    assert.equal(still.sameAsPreview, true);
    assert.deepEqual([still.width, still.height], [1080, 1920]);
    assert.equal(t.pendingIdle(), 0, '결과를 그렸으니 결과 크기 대상이 이미 있다');
    t.flushIdle();
    assert.equal(warms(t.renderer).length, 0);
    assert.equal(t.preview.getState().resultPrepare, 'ready');
  });

  it('준비가 실패하면 미리보기는 그대로 두고 알린 뒤 되풀이하지 않는다 (셔터 때 결과 렌더가 다시 만든다)', () => {
    const renderer = fakeRenderer({ failWarm: new EffectError(EffectFault.RENDER_FAILED, 'GL error 0x505 during result prepare') });
    const t = setup({ renderer });
    t.preview.start();
    t.run(200);
    t.flushIdle();
    assert.equal(t.preview.getState().status, EffectStatus.RUNNING);
    assert.equal(renderer.disposed, undefined);
    assert.equal(t.warnings.length, 1);
    assert.match(t.warnings[0], /effect-prepare result prepare failed -> made at shutter \(render-failed: GL error 0x505/);
    t.run(500);
    t.flushIdle();
    assert.equal(t.warnings.length, 1);
    assert.equal(t.preview.renderStill().width, 1080);
  });

  it('stop하면 기다리던 준비를 취소한다', () => {
    const t = setup();
    t.preview.start();
    t.run(200);
    t.preview.stop();
    assert.equal(t.pendingIdle(), 0);
  });
});
