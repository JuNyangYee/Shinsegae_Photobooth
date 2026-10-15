// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeCaptureCrop, createCapture } from '../src/web/js/capture.js';
import { fakeCanvasEnvironment as fakeEnvironment, flush } from './helpers.mjs';

const STAGE = 9 / 16;

describe('computeCaptureCrop', () => {
  it('9:16 영상은 자르지 않고 원본 크기 그대로 (OBS 1080x1920, 2160x3840)', () => {
    assert.deepEqual(computeCaptureCrop({ videoWidth: 1080, videoHeight: 1920, stageAspect: STAGE }),
      { x: 0, y: 0, width: 1080, height: 1920 });
    assert.deepEqual(computeCaptureCrop({ videoWidth: 2160, videoHeight: 3840, stageAspect: STAGE }),
      { x: 0, y: 0, width: 2160, height: 3840 });
  });

  it('가로 영상은 가운데 9:16만 (높이 유지)', () => {
    // 1920x1080: 보이는 폭 1080 * 9/16 = 607.5 → 608
    assert.deepEqual(computeCaptureCrop({ videoWidth: 1920, videoHeight: 1080, stageAspect: STAGE }),
      { x: 656, y: 0, width: 608, height: 1080 });
    assert.deepEqual(computeCaptureCrop({ videoWidth: 2160, videoHeight: 2160, stageAspect: STAGE }),
      { x: 473, y: 0, width: 1215, height: 2160 });
  });

  it('9:16보다 더 세로로 긴 영상은 가운데 위아래를 자름 (폭 유지)', () => {
    assert.deepEqual(computeCaptureCrop({ videoWidth: 1080, videoHeight: 2400, stageAspect: STAGE }),
      { x: 0, y: 240, width: 1080, height: 1920 });
  });

  it('영상 크기가 0이면 null', () => {
    assert.equal(computeCaptureCrop({ videoWidth: 0, videoHeight: 0, stageAspect: STAGE }), null);
  });
});


function setup({ videoWidth = 1920, videoHeight = 1080, mirror = true, context, blob, effect, frameAge = 10 } = {}) {
  const env = fakeEnvironment({ context, blob });
  const video = { videoWidth, videoHeight };
  let time = 100000;
  const frame = { at: time - frameAge, count: 42 };
  const capture = createCapture({
    video, stageAspect: STAGE, mirror, type: 'image/jpeg', quality: 0.92,
    maxFrameAgeMs: 500, getFrameInfo: () => frame,
    effect, createCanvas: env.createCanvas, urls: env.urls, now: () => time,
  });
  return { env, video, capture, frame, setTime: (t) => { time = t; } };
}

describe('createCapture', () => {
  it('보이는 영역을 원본 해상도로 잘라 좌우 반전해 그리고, 캔버스는 인코딩 뒤 비운다', async () => {
    const { env, capture } = setup();
    const photo = await capture.take();
    assert.deepEqual(photo, { url: 'blob:fake/1', width: 608, height: 1080 });
    const [canvas] = env.canvases;
    assert.deepEqual(canvas.calls, [
      ['translate', 608, 0],
      ['scale', -1, 1],
      ['drawImage', 656, 0, 608, 1080, 0, 0, 608, 1080],
      ['toBlob', 'image/jpeg', 0.92],
    ]);
    assert.equal(canvas.width, 0); // 비움
    const stats = capture.getStats();
    assert.equal(stats.liveCanvases, 0);
    assert.equal(stats.liveUrls, 1);
    assert.equal(stats.pending, 0);
    assert.equal(stats.last.width, 608);
    assert.equal(stats.last.source, '1920x1080');
  });

  it('mirror false면 반전하지 않는다', async () => {
    const { env, capture } = setup({ mirror: false });
    await capture.take();
    assert.deepEqual(env.canvases[0].calls[0], ['drawImage', 656, 0, 608, 1080, 0, 0, 608, 1080]);
  });

  it('release는 Object URL을 한 번만 revoke한다', async () => {
    const { env, capture } = setup();
    const first = await capture.take();
    const second = await capture.take();
    capture.release(first);
    capture.release(first);
    assert.deepEqual(env.revoked, ['blob:fake/1']);
    assert.equal(capture.getStats().liveUrls, 1);
    capture.release(second);
    const stats = capture.getStats();
    assert.equal(stats.taken, 2);
    assert.equal(stats.released, 2);
    assert.equal(stats.liveUrls, 0);
    assert.equal(stats.liveCanvases, 0);
  });

  it('영상이 없으면 바로 예외, 캔버스를 만들지 않는다', () => {
    const { env, capture } = setup({ videoWidth: 0, videoHeight: 0 });
    assert.throws(() => capture.take(), /no frame/);
    assert.equal(env.canvases.length, 0);
  });

  it('인코딩이 실패해도 캔버스는 비우고 URL은 만들지 않는다', async () => {
    const { env, capture } = setup({ blob: 'null' });
    await assert.rejects(capture.take(), /toBlob returned null/);
    assert.equal(env.canvases[0].width, 0);
    assert.equal(capture.getStats().liveCanvases, 0);
    assert.equal(capture.getStats().liveUrls, 0);
  });
});

describe('createCapture: 예외 경로 정리 (검수 A)', () => {
  for (const context of ['null', 'draw-throws']) {
    it(`캔버스를 만든 뒤 그리기 단계에서 실패해도(${context}) 캔버스를 비운다`, () => {
      const { env, capture } = setup({ context });
      for (let i = 0; i < 20; i += 1) {
        assert.throws(() => capture.take(), context === 'null' ? /2d context unavailable/ : /drawImage failed/);
      }
      assert.equal(env.canvases.length, 20);
      assert.equal(env.liveCanvasCount(), 0);
      assert.equal(capture.getStats().liveCanvases, 0);
      assert.match(capture.getStats().lastError, context === 'null' ? /2d context/ : /drawImage/);
    });
  }
});

describe('createCapture: 취소 경계 (검수 B)', () => {
  it('인코딩 중 abort되면 기다리지 않고 실패하고 캔버스를 바로 비운다. 늦은 콜백은 URL을 만들지 않는다', async () => {
    const { env, capture } = setup({ blob: 'manual' });
    const controller = new AbortController();
    const result = capture.take({ signal: controller.signal });
    await flush();
    assert.equal(env.liveCanvasCount(), 1); // 인코딩 중
    controller.abort(new Error('capture timeout'));
    await assert.rejects(result, /capture timeout/);
    assert.equal(env.liveCanvasCount(), 0);
    assert.equal(capture.getStats().pending, 1); // toBlob 콜백은 아직
    env.blobCallbacks[0](); // 늦게 도착
    await flush();
    assert.equal(capture.getStats().pending, 0);
    assert.equal(capture.getStats().liveUrls, 0);
  });

  it('toBlob 콜백이 오지 않으면 abort 뒤 캔버스는 비우고, 다음 촬영은 캔버스를 만들지 않고 실패한다 (쌓이지 않음)', async () => {
    const { env, capture } = setup({ blob: 'never' });
    const controller = new AbortController();
    const result = capture.take({ signal: controller.signal });
    await flush();
    controller.abort(new Error('timeout'));
    await assert.rejects(result);
    for (let i = 0; i < 8; i += 1) assert.throws(() => capture.take(), /capture busy/);
    assert.equal(env.canvases.length, 1);
    assert.equal(env.liveCanvasCount(), 0);
  });

  it('효과 단계도 같은 신호를 받고, 신호를 무시해 늦게 새 캔버스를 돌려줘도 그 캔버스를 비운다', async () => {
    const env2 = fakeEnvironment();
    let received = null;
    let finishEffect;
    const effect = (canvas, { signal }) => {
      received = signal;
      return new Promise((resolve) => {
        finishEffect = () => {
          const out = env2.createCanvas();
          out.width = canvas.width || 608;
          out.height = 1080;
          resolve(out);
        };
      });
    };
    const { env, capture } = setup({ effect });
    const controller = new AbortController();
    const result = capture.take({ signal: controller.signal });
    await flush();
    assert.equal(received, controller.signal);
    controller.abort(new Error('reset'));
    await assert.rejects(result, /reset/);
    assert.equal(env.liveCanvasCount(), 0);
    finishEffect();
    await flush();
    assert.equal(env2.liveCanvasCount(), 0);
    assert.equal(capture.getStats().pending, 0);
  });

  it('이미 abort된 신호면 효과·인코딩 전에 실패하고 정리한다', async () => {
    const { env, capture } = setup();
    const controller = new AbortController();
    controller.abort(new Error('already'));
    await assert.rejects(capture.take({ signal: controller.signal }), /already/);
    await flush();
    assert.equal(env.liveCanvasCount(), 0);
    assert.equal(capture.getStats().liveUrls, 0);
  });
});

describe('createCapture: 정지 프레임 거부 (검수 C)', () => {
  it('마지막 새 프레임이 maxFrameAgeMs보다 오래되면 캔버스를 만들지 않고 실패한다', () => {
    const { env, capture, frame, setTime } = setup({ frameAge: 10 });
    setTime(frame.at + 501);
    assert.throws(() => capture.take(), /stale frame: no new camera frame for 501ms/);
    assert.equal(env.canvases.length, 0);
    setTime(frame.at + 500);
    assert.doesNotThrow(() => capture.take());
  });

  it('프레임을 한 번도 받지 않았으면 실패한다', () => {
    const { capture, frame } = setup();
    frame.at = null;
    assert.throws(() => capture.take(), /stale frame/);
  });
});
