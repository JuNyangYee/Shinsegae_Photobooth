// 실행: npm test
// 원본 미리보기 (raw-preview.js): 켜져 있을 때만, 새 카메라 프레임·설정·크기가 바뀐 화면 갱신에만 카메라 처리 경로로 그린다
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createCameraFrame } from '../../src/web/camera/camera-frame.js';
import { createRawPreview } from '../../src/web/camera/raw-preview.js';
import { config } from '../../src/web/config/config.js';

function setup() {
  let queued = null;
  const frames = { count: 1 };
  const camera = { ready: true, isReady: () => camera.ready, getFrameInfo: () => ({ at: 0, count: frames.count }) };
  const video = { videoWidth: 1080, videoHeight: 1920 };
  const draws = [];
  const canvas = {
    hidden: true, width: 0, height: 0,
    getContext: () => ({ save() {}, restore() {}, setTransform() {}, fillRect() {}, drawImage: () => draws.push([canvas.width, canvas.height]) }),
  };
  const frame = createCameraFrame({ doc: {}, stageAspect: 9 / 16, settings: config.camera });
  const size = { width: 540, height: 960 };
  const preview = createRawPreview({
    canvas, video, camera, frame, getSize: () => size,
    raf: (fn) => { queued = fn; return 1; }, cancelRaf: () => { queued = null; },
  });
  const tick = (n = 1) => { for (let i = 0; i < n; i += 1) { const fn = queued; queued = null; fn?.(); } };
  return { preview, camera, video, canvas, draws, frames, frame, size, tick, queued: () => queued };
}

describe('createRawPreview', () => {
  it('켜기 전에는 돌지 않고, 켜면 다음 화면 갱신에 그려 보인다', () => {
    const t = setup();
    assert.equal(t.queued(), null);
    t.preview.setActive(true);
    t.tick();
    assert.deepEqual(t.draws, [[540, 960]]);
    assert.equal(t.canvas.hidden, false);
  });

  it('새 프레임이 없으면 다시 그리지 않고, 새 프레임·설정·크기가 바뀌면 그린다', () => {
    const t = setup();
    t.preview.setActive(true);
    t.tick(3);
    assert.equal(t.draws.length, 1);
    t.frames.count += 1;
    t.tick();
    assert.equal(t.draws.length, 2);
    t.frame.setSettings({ ...t.frame.getSettings(), zoom: 2 });
    t.tick();
    assert.equal(t.draws.length, 3);
    t.size.width = 1080;
    t.size.height = 1920;
    t.tick();
    assert.deepEqual(t.draws.at(-1), [1080, 1920]);
  });

  it('카메라가 준비되지 않으면 숨긴다(멈춘 그림이 남지 않게), 다시 준비되면 바로 그린다', () => {
    const t = setup();
    t.preview.setActive(true);
    t.tick();
    t.camera.ready = false;
    t.tick();
    assert.equal(t.canvas.hidden, true);
    t.camera.ready = true;
    t.tick();
    assert.equal(t.canvas.hidden, false);
    assert.equal(t.draws.length, 2);
  });

  it('끄면 숨기고 멈춘다 (효과 미리보기가 그리는 동안 비용 없음)', () => {
    const t = setup();
    t.preview.setActive(true);
    t.tick();
    t.preview.setActive(false);
    assert.equal(t.canvas.hidden, true);
    assert.equal(t.queued(), null);
    assert.deepEqual(t.preview.getStats(), { active: false, draws: 1, width: 540, height: 960, shown: false });
  });
});
