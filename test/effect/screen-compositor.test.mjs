import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScreenFilterState, createScreenCompositor } from '../../src/web/effect/screen-compositor.js';

const fakeCanvas = () => {
  const c = {
    width: 0, height: 0, hidden: true, dataset: {}, addEventListener() {}, removeEventListener() {},
    getContext: () => ({ drawImage() {}, fillRect() {}, fillStyle: '', globalAlpha: 1 }),
  };
  return c;
};
const log = { warn() {}, clear() {} };

function setup({ outputMode = 'gray-oil', renderError = null, settings = { enabled: true, filter: { fps: 12, previewScale: 0.5 } } } = {}) {
  const canvas = fakeCanvas();
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
    canvas, stage, effect, plateCanvas: fakeCanvas(), layers, createCanvas: fakeCanvas, log, isHidden: () => false,
    createRenderer: ({ bundle }) => {
      const r = {
        bundle, renders: [], disposed: false, dispose() { this.disposed = true; }, getStats: () => ({ strokes: 7 }), gl: { isContextLost: () => false },
        render(source, options) { if (renderError) throw renderError; r.renders.push({ source, options }); },
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
  return { compositor, canvas, stage, effect, created, events, tick: (ms = 100) => { t += ms; frameFn(); } };
}

describe('screen-compositor (17단계)', () => {
  it('켜지면 합성 표시로 넘기고 장면 위 층까지 합성한 소스 한 장에 유화 1회, 캔버스 표시·data 속성', () => {
    const t = setup();
    t.tick();
    assert.deepEqual(t.events.slice(0, 4), [['composite', true], ['camera'], ['under'], ['over']]);
    assert.equal(t.created.length, 1);
    assert.equal(t.created[0].renders.length, 1);
    assert.equal(t.canvas.hidden, false);
    assert.equal(t.stage.dataset.screenFilter, 'on');
    assert.equal(t.compositor.getState().state, ScreenFilterState.RUNNING);
  });

  it('같은 틱에는 다시 그리지 않고 다음 틱에 그린다', () => {
    const t = setup();
    t.tick(100);
    t.tick(1);
    assert.equal(t.created[0].renders.length, 1);
    t.tick(100);
    assert.equal(t.created[0].renders.length, 2);
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

  it('감열지 시험은 우회한다 (점 위에 유화를 얹지 않는다, 가안)', () => {
    const t = setup({ outputMode: 'thermal' });
    t.tick();
    assert.equal(t.created.length, 0);
    assert.deepEqual([t.compositor.getState().state, t.compositor.getState().reason], [ScreenFilterState.BYPASS, 'thermal']);
  });

  it('번들이 바뀌면 렌더러를 바꾼다', () => {
    const t = setup();
    t.tick();
    t.effect.bundle = { id: 'new' };
    t.tick();
    assert.equal(t.created.length, 2);
    assert.equal(t.created[0].disposed, true);
    assert.equal(t.created[1].bundle.id, 'new');
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
    assert.equal(t.created.length, 1);
    assert.equal(t.created[0].renders.length, 0);
  });

  it('장면을 못 읽으면 시작하지 않는다', () => {
    const t = setup();
    t.compositor.setPlateReady(false);
    t.tick();
    assert.equal(t.created.length, 0);
    assert.equal(t.compositor.getState().state, ScreenFilterState.FAULT);
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
