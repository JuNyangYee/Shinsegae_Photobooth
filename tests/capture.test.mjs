// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { computeCaptureCrop, createCapture } from '../src/web/js/capture.js';

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

// 캔버스·Object URL 흉내
function fakeEnvironment({ blobOk = true } = {}) {
  const canvases = [];
  const revoked = [];
  let nextUrl = 1;
  return {
    canvases,
    revoked,
    createCanvas() {
      const calls = [];
      const canvas = {
        width: 300,
        height: 150,
        calls,
        getContext: () => ({
          translate: (...args) => calls.push(['translate', ...args]),
          scale: (...args) => calls.push(['scale', ...args]),
          drawImage: (...args) => calls.push(['drawImage', ...args.slice(1)]),
        }),
        toBlob(callback, type, quality) {
          calls.push(['toBlob', type, quality]);
          queueMicrotask(() => callback(blobOk ? { size: 1234, type } : null));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
    urls: {
      createObjectURL: () => `blob:fake/${nextUrl++}`,
      revokeObjectURL: (url) => revoked.push(url),
    },
  };
}

function setup({ videoWidth = 1920, videoHeight = 1080, mirror = true, blobOk } = {}) {
  const env = fakeEnvironment({ blobOk });
  const video = { videoWidth, videoHeight };
  const capture = createCapture({
    video, stageAspect: STAGE, mirror, type: 'image/jpeg', quality: 0.92,
    createCanvas: env.createCanvas, urls: env.urls,
  });
  return { env, video, capture };
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
    assert.deepEqual(capture.getStats(), { ...capture.getStats(), taken: 2, released: 2, liveUrls: 0, liveCanvases: 0 });
  });

  it('영상이 없으면 바로 예외, 캔버스를 만들지 않는다', () => {
    const { env, capture } = setup({ videoWidth: 0, videoHeight: 0 });
    assert.throws(() => capture.take(), /no frame/);
    assert.equal(env.canvases.length, 0);
  });

  it('인코딩이 실패해도 캔버스는 비우고 URL은 만들지 않는다', async () => {
    const { env, capture } = setup({ blobOk: false });
    await assert.rejects(capture.take(), /toBlob returned null/);
    assert.equal(env.canvases[0].width, 0);
    assert.equal(capture.getStats().liveCanvases, 0);
    assert.equal(capture.getStats().liveUrls, 0);
  });
});
