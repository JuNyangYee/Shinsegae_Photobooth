import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenFilterState, createPhotoSource, createScreenCompositor } from '../../src/web/effect/screen-compositor.js';

const fakeCanvas = () => {
  const c = {
    width: 0, height: 0, hidden: true, dataset: {}, addEventListener() {}, removeEventListener() {},
    getContext: () => ({ drawImage() {}, fillRect() {}, fillStyle: '', globalAlpha: 1, globalCompositeOperation: '' }),
  };
  return c;
};
const log = { warn() {}, clear() {} };

function setup({ outputMode = 'gray-oil', renderError = null, settings = { enabled: true, filter: { fps: 12, previewScale: 0.5 } } } = {}) {
  const canvas = fakeCanvas();
  const dotsCanvas = fakeCanvas();
  const stage = { dataset: {} };
  const created = [];
  let frameFn = null;
  let t = 0;
  const events = [];
  const effect = {
    outputMode,
    bundle: { id: 'b' },
    getBundle() { return this.bundle; },
    getSettings() { return { outputMode: this.outputMode }; },
    setCompositeMode(on) { events.push(['composite', on]); },
    drawCompositeFrame() { events.push(['camera']); return 'camera-image'; },
  };
  const layers = { drawUnderScene() { events.push(['under']); }, drawOverScene() { events.push(['over']); }, resultOpacity: () => 1 };
  const compositor = createScreenCompositor({
    canvas, dotsCanvas, stage, effect, plateCanvas: fakeCanvas(), layers, createCanvas: fakeCanvas, log, isHidden: () => false, idle() {},
    createRenderer: ({ bundle, canvas: target }) => {
      const r = {
        target, bundle, renders: [], disposed: false, dispose() { this.disposed = true; }, getStats: () => ({ strokes: 7 }), gl: { isContextLost: () => false },
        render(source, options) { if (renderError) throw renderError; r.renders.push({ source, options }); return { pixels: new Uint8ClampedArray(4) }; },
      };
      created.push(r);
      return r;
    },
    raf: (fn) => { frameFn = fn; return 1; }, cancelRaf() {}, now: () => t,
  });
  compositor.setSettings(settings);
  compositor.setPlateReady(true);
  compositor.setFallbackBundle({ id: 'builtin' });
  compositor.start();
  const screen = () => created.filter((r) => r.target === canvas);
  const photo = () => created.filter((r) => r.target !== canvas);
  return { compositor, canvas, dotsCanvas, stage, effect, created, screen, photo, events, tick: (ms = 100) => { t += ms; frameFn(); } };
}

describe('screen-compositor (17단계)', () => {
  it('켜지면 합성 표시로 넘기고 장면 위 층까지 합성한 소스 한 장에 유화 1회, 캔버스 표시·data 속성', () => {
    const t = setup();
    t.tick();
    assert.deepEqual(t.events.slice(0, 4), [['composite', true], ['camera'], ['under'], ['over']]);
    assert.equal(t.screen().length, 1);
    assert.equal(t.photo().length, 1, '사진 전용 렌더러도 같은 번들로');
    assert.equal(t.screen()[0].renders.length, 1);
    assert.equal(t.photo()[0].bundle.id, 'b');
    assert.equal(t.canvas.hidden, false);
    assert.equal(t.stage.dataset.screenFilter, 'on');
    assert.equal(t.compositor.getState().state, ScreenFilterState.RUNNING);
  });

  it('같은 틱에는 다시 그리지 않고 다음 틱에 그린다', () => {
    const t = setup();
    t.tick(100);
    t.tick(1);
    assert.equal(t.screen()[0].renders.length, 1);
    t.tick(100);
    assert.equal(t.screen()[0].renders.length, 2);
  });

  it('끄면 기존 화면으로: 캔버스 숨김, 합성 끔, disabled', () => {
    const t = setup();
    t.tick();
    t.compositor.setSettings({ ...t.compositor.getSettings(), enabled: false });
    t.tick();
    assert.equal(t.canvas.hidden, true);
    assert.equal(t.stage.dataset.screenFilter, undefined);
    assert.deepEqual(t.events.at(-1), ['composite', false]);
    assert.deepEqual([t.compositor.getState().state, t.compositor.getState().reason], [ScreenFilterState.BYPASS, 'disabled']);
  });

  it('감열지 시험: 화면 필터는 그대로, 점은 사진 렌더러로 유화 뒤에 만들어 창에만 보인다', () => {
    const t = setup({ outputMode: 'thermal' });
    t.tick();
    assert.equal(t.compositor.getState().state, ScreenFilterState.RUNNING);
    assert.equal(t.screen()[0].renders.length, 1);
    assert.equal(t.photo()[0].renders.length, 1);
    assert.equal(t.photo()[0].renders[0].options.settings.outputMode, 'thermal');
    assert.equal(t.dotsCanvas.hidden, false);
    t.effect.outputMode = 'gray-oil';
    t.tick();
    assert.equal(t.dotsCanvas.hidden, true);
  });

  it('번들이 바뀌면 렌더러를 바꾼다', () => {
    const t = setup();
    t.tick();
    t.effect.bundle = { id: 'new' };
    t.tick();
    assert.equal(t.screen().length, 2);
    assert.equal(t.screen()[0].disposed, true);
    assert.equal(t.screen()[1].bundle.id, 'new');
    assert.equal(t.photo()[1].bundle.id, 'new');
  });

  it('활성 번들이 없으면 기본 제공판', () => {
    const t = setup();
    t.effect.bundle = null;
    t.tick();
    assert.equal(t.created[0].bundle.id, 'builtin');
  });

  it('렌더 실패는 기존 화면으로 돌아가고 다시 시도하지 않는다 (장애)', () => {
    const t = setup({ renderError: new Error('boom') });
    t.tick();
    assert.equal(t.canvas.hidden, true);
    assert.equal(t.stage.dataset.screenFilter, undefined);
    assert.equal(t.compositor.getState().state, ScreenFilterState.FAULT);
    t.tick();
    assert.equal(t.screen().length, 1);
    assert.equal(t.screen()[0].renders.length, 0);
  });

  it('장면을 못 읽으면 시작하지 않는다', () => {
    const t = setup();
    t.compositor.setPlateReady(false);
    t.tick();
    assert.equal(t.created.length, 0);
    assert.equal(t.compositor.getState().state, ScreenFilterState.FAULT);
  });

  it('사진: 화면과 같은 엔진·수치·seed로 고정된 카메라 층만 칠한다 (장식 없음)', () => {
    const t = setup({ settings: { enabled: true, filter: { fps: 12, previewScale: 0.5, strength: 0.4 } } });
    t.tick();
    const seedAtShutter = t.screen()[0].renders.at(-1).options.seed;
    t.compositor.setFreeze(true);
    t.tick(1000);
    assert.equal(t.screen()[0].renders.at(-1).options.seed, seedAtShutter, '고정 중 화면도 셔터 seed');
    const still = t.compositor.renderStill();
    const { source, options } = t.photo()[0].renders.at(-1);
    assert.notEqual(source, t.screen()[0].renders.at(-1).source, '합성 그림이 아니라 카메라 층');
    assert.equal(options.seed, seedAtShutter);
    assert.equal(options.settings.strength, 0.4);
    assert.equal(options.output, 'pixels');
    assert.deepEqual([still.seed, still.sameAsPreview, still.mode], [seedAtShutter, true, 'gray-oil']);
  });

  it('사진 입구: 합성 중이면 화면 경로, 아니면·실패하면 카메라 효과 경로', () => {
    const t = setup();
    t.effect.renderStill = () => 'camera-path';
    t.effect.isEnabled = () => true;
    let compositor = null;
    const source = createPhotoSource({ effect: t.effect, getCompositor: () => compositor, log });
    assert.equal(source.renderStill(), 'camera-path', '합성기 없음');
    compositor = t.compositor;
    assert.equal(source.renderStill(), 'camera-path', '아직 합성 전');
    t.tick();
    assert.equal(source.renderStill().mode, 'gray-oil', '합성 중');
    t.photo()[0].render = () => { throw new Error('boom'); };
    assert.equal(source.renderStill(), 'camera-path', '사진 렌더 실패');
  });

  it('고정 동안 카메라를 다시 그리지 않고 해제하면 사본을 비운다', () => {
    const t = setup();
    t.tick();
    const cameraDraws = () => t.events.filter(([e]) => e === 'camera').length;
    const before = cameraDraws();
    t.compositor.setFreeze(true);
    assert.equal(t.compositor.getState().frozen, true);
    t.tick();
    assert.equal(cameraDraws(), before, '고정 중 카메라 소스를 건드리지 않는다');
    t.compositor.setFreeze(false);
    assert.equal(t.compositor.getState().frozen, false);
    t.tick();
    assert.equal(cameraDraws(), before + 1);
  });
});
