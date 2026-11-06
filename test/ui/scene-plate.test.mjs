import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../src/web/config/config.js';
import { createScenePlate, keyRows } from '../../src/web/ui/scene-plate.js';

function fakeCanvas(width, height, paint) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) data.set([...paint(x, y), 255], (y * width + x) * 4);
  }
  const canvas = {
    hidden: false, width: 0, height: 0,
    getContext: () => ({
      drawImage() {},
      getImageData: (x, top, w, h) => ({ data: data.slice(top * w * 4, (top + h) * w * 4) }),
      putImageData: (pixels, x, top) => data.set(pixels.data, top * width * 4),
    }),
  };
  return { canvas, alpha: (x, y) => data[(y * width + x) * 4 + 3] };
}

describe('scene-plate: 장면 이미지의 창 줄 키', () => {
  it('키 줄 = 사진 틀 줄 ± 여유 (1920 → 240~1590 ± 30)', () => {
    assert.deepEqual(keyRows(1920, config.photoFrame, config.scene.keyMarginFrac), { top: 210, height: 1410 });
    assert.deepEqual(keyRows(64, { top: 0, height: 1 }, 1 / 64), { top: 0, height: 64 });
  });

  it('창 줄의 그린만 투명, 창 밖의 같은 그린(배경 나무 등)과 창 안 캐릭터 색은 그대로. 처리 뒤에만 보인다', async () => {
    const W = 4;
    const H = 64; // 틀 8/64~53/64 → 8~53줄, 여유 1줄 → 7~54줄 (끝 제외)
    const { canvas, alpha } = fakeCanvas(W, H, (x, y) => (x === 0 && y > 20 && y < 30 ? [240, 240, 235] : [0, 255, 0]));
    const plate = createScenePlate({
      canvas, src: 'plate.png', frame: config.photoFrame, key: config.scene.key, keyMarginFrac: 1 / 64,
      loadImage: async () => ({ width: W, height: H }),
    });
    assert.equal(canvas.hidden, true);
    const r = await plate.ready;
    assert.equal(r.ok, true);
    assert.deepEqual(r.keyed, { top: 7, height: 47 });
    assert.equal(canvas.hidden, false);
    assert.equal(alpha(1, 30), 0, '창 안 그린');
    assert.equal(alpha(0, 25), 255, '창에 걸친 캐릭터');
    assert.equal(alpha(1, 3), 255, '창 위 띠');
    assert.equal(alpha(1, 60), 255, '창 아래 띠');
  });

  it('이미지를 못 읽으면 숨긴 채 실패를 알린다', async () => {
    const { canvas } = fakeCanvas(1, 1, () => [0, 0, 0]);
    const r = await createScenePlate({
      canvas, src: 'x.png', frame: config.photoFrame, key: config.scene.key, keyMarginFrac: 0,
      loadImage: async () => { throw new Error('404'); },
    }).ready;
    assert.deepEqual(r, { ok: false, error: '404' });
    assert.equal(canvas.hidden, true);
  });
});
