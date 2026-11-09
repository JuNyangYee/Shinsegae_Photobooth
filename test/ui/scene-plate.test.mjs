import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../src/web/config/config.js';
import {
  bandPlacement, createScenePlate, fillFrameGap, fitPlacement, keyRect, sealOutsideFrame,
} from '../../src/web/ui/scene-plate.js';

// 14·15단계 키·칠하기 규칙은 화면 폭 전체 틀(예전 기본값)로 본다. 16단계 사방 틀은 아래 맞춤 테스트
const OLD_FRAME = Object.freeze({ top: 8 / 64, height: 45 / 64 });
const BANDS_14 = Object.freeze({ topCut: 285 / 1920, topShift: -8 / 1920, bottomCut: 1258 / 1920, bottomShift: 47 / 1920 }); // 14·15단계 장면

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
    assert.deepEqual(keyRect(1080, 1920, OLD_FRAME, config.scene.keyMarginFrac), { left: 0, top: 210, width: 1080, height: 1410 });
    assert.deepEqual(keyRect(1080, 1920, config.photoFrame, config.scene.keyMarginFrac), { left: 105, top: 330, width: 870, height: 1140 },
      '16단계 사방 틀 ± 30');
    assert.deepEqual(keyRect(64, 64, { top: 0, height: 1 }, 1 / 64), { left: 0, top: 0, width: 64, height: 64 });
  });

  it('창 줄의 그린만 투명, 창 밖의 같은 그린(배경 나무 등)과 창 안 캐릭터 색은 그대로. 처리 뒤에만 보인다', async () => {
    const W = 4;
    const H = 64; // 틀 8/64~53/64 → 8~53줄, 여유 1줄 → 7~54줄 (끝 제외)
    const { canvas, alpha } = fakeCanvas(W, H, (x, y) => (x === 0 && y > 20 && y < 30 ? [240, 240, 235] : [0, 255, 0]));
    const plate = createScenePlate({
      canvas, src: 'plate.png', frame: OLD_FRAME, key: config.scene.key, keyMarginFrac: 1 / 64,
      loadImage: async () => ({ width: W, height: H }),
    });
    assert.equal(canvas.hidden, true);
    const r = await plate.ready;
    assert.equal(r.ok, true);
    assert.deepEqual(r.keyed, { left: 0, top: 7, width: 4, height: 47 });
    assert.equal(canvas.hidden, false);
    assert.equal(alpha(1, 30), 0, '창 안 그린');
    assert.equal(alpha(0, 25), 255, '창에 걸친 캐릭터');
    assert.equal(alpha(1, 3), 255, '창 위 띠');
    assert.equal(alpha(1, 60), 255, '창 아래 띠');
  });

  it('이미지를 못 읽으면 숨긴 채 실패를 알린다', async () => {
    const { canvas } = fakeCanvas(1, 1, () => [0, 0, 0]);
    const r = await createScenePlate({
      canvas, src: 'x.png', frame: OLD_FRAME, key: config.scene.key, keyMarginFrac: 0,
      loadImage: async () => { throw new Error('404'); },
    }).ready;
    assert.deepEqual(r, { ok: false, error: '404' });
    assert.equal(canvas.hidden, true);
  });
});

describe('scene-plate: 띠 맞춤 (원본은 그대로, 그릴 때만 위·아래 띠를 평행이동)', () => {
  it('비율을 장면 높이 줄로 반올림한다. 3차 장면 1920 → 위 0~285줄 −8, 아래 1258줄~ +47 / 실제 1672줄 이미지는 같은 비율', () => {
    assert.deepEqual(bandPlacement(1920, BANDS_14), { topCut: 285, topShift: -8, bottomCut: 1258, bottomShift: 47 });
    assert.deepEqual(bandPlacement(1672, BANDS_14), { topCut: 248, topShift: -7, bottomCut: 1096, bottomShift: 41 });
    assert.equal(bandPlacement(1920, null), null);
    assert.equal(bandPlacement(1920, config.scene.layout), null, '16단계 맞춤(fit)이면 띠 맞춤 아님');
  });

  it('띠 맞춤이 있으면 그린을 깔고 위·아래 띠만 옮겨 그린 뒤 창 줄 키를 뺀다', async () => {
    const draws = [];
    const W = 2;
    const H = 64;
    const data = new Uint8ClampedArray(W * H * 4);
    const canvas = {
      hidden: true, width: 0, height: 0,
      getContext: () => ({
        set fillStyle(v) { draws.push(['fill', v]); },
        fillRect: (...a) => { draws.push(['rect', ...a]); for (let i = 0; i < W * H; i += 1) data.set([0, 255, 0, 255], i * 4); },
        drawImage: (...a) => draws.push(['draw', ...a.slice(1)]),
        getImageData: (x, top, w, h) => ({ data: data.slice(top * w * 4, (top + h) * w * 4) }),
        putImageData: (pixels, x, top) => data.set(pixels.data, top * W * 4),
      }),
    };
    const layout = { topCut: 9 / 64, topShift: -1 / 64, bottomCut: 52 / 64, bottomShift: 1 / 64 };
    const r = await createScenePlate({
      canvas, src: 'p.png', frame: OLD_FRAME, key: config.scene.key, keyMarginFrac: 0, layout,
      loadImage: async () => ({ width: W, height: H }),
    }).ready;
    assert.deepEqual(r.bands, { topCut: 9, topShift: -1, bottomCut: 52, bottomShift: 1 });
    assert.deepEqual(draws, [['fill', '#00ff00'], ['rect', 0, 0, W, H], ['draw', 0, 0, W, 9, 0, -1, W, 9], ['draw', 0, 52, W, 12, 0, 53, W, 12]]);
  });
});

describe('scene-plate: 장면 유화 (15단계, 칠하기는 주입)', () => {
  // Node에는 ImageData가 없어 같은 모양으로 흉내 낸다 (화면에서는 브라우저 것)
  globalThis.ImageData ??= class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };

  function plateCanvas(W, H, paint) {
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set([...paint(x, y), 255], (y * W + x) * 4);
    const canvas = {
      hidden: true, width: 0, height: 0,
      getContext: () => ({
        drawImage() {},
        getImageData: (x, top, w, h) => ({ data: data.slice(top * w * 4, (top + h) * w * 4) }),
        putImageData: (pixels, x, top) => data.set(pixels.data, top * W * 4),
      }),
    };
    return { canvas, data };
  }

  it('장면은 칠하지 않은 생성 원본 그대로: 창 안 그린만 투명, 창 밖 색은 변하지 않는다 (17단계)', async () => {
    const { canvas, data } = plateCanvas(2, 64, (x, y) => (y >= 8 && y < 53 ? [0, 255, 0] : [90, 80, 160]));
    const r = await createScenePlate({
      canvas, src: 'p.png', frame: OLD_FRAME, key: config.scene.key, keyMarginFrac: 0, loadImage: async () => ({ width: 2, height: 64 }),
    }).ready;
    assert.equal(r.ok, true);
    assert.equal(data[(20 * 2) * 4 + 3], 0, '창 안은 투명');
    assert.deepEqual([...data.slice(12, 16)], [90, 80, 160, 255], '창 밖은 원본 색·불투명');
  });
});

describe('scene-plate: 16단계 사방 나무틀 맞춤', () => {
  it('fitPlacement: 채택 장면(982x1602, 키 x124~845·y339~1240)의 개구부를 고정 3:4 창에 균일 배율로 맞춘다 (17단계)', () => {
    const frame = { left: 135, top: 360, width: 810, height: 1080 };
    assert.equal(frame.width / frame.height, 3 / 4, '창은 3:4로 고정');
    const fit = fitPlacement(982, 1602, frame, config.scene.layout.fit);
    assert.ok(Math.abs(fit.scale - 1080 / 902) < 1e-9, '실측 키 높이 902 → 1080');
    assert.ok(Math.abs(fit.y + 339 * fit.scale - 360) < 1e-9, '그린 위끝 → 360');
    assert.ok(Math.abs(fit.y + 1241 * fit.scale - 1440) < 1e-9, '그린 아래끝 → 1440');
    assert.ok(Math.abs(fit.x + 485 * fit.scale - 540) < 1e-9, '그린 가운데 → 540');
    assert.ok(722 * fit.scale >= frame.width, '그린 폭이 창 폭 이상: 3:4 창이 틀에 가려지지 않는다');
    assert.ok(Math.abs(fit.width / fit.height - 982 / 1602) < 1e-12, '찌그러뜨리지 않는다');
  });

  it('fillFrameGap: 틀 밖에 남은 그린을 나무 경계(줄마다 잰 가운데값) 축 거울로 채우고, 캐릭터 화소는 그대로', () => {
    // 12x6: 나무(N) 0~2열 | 그린 3~4열(틀 밖 남는 곳) | 틀 5~11열(그린). 2번 줄은 캐릭터(C)가 3열을 덮는다
    const W = 12;
    const H = 6;
    const N = [150, 90, 40, 255];
    const G = [0, 255, 0, 255];
    const C = [230, 110, 40, 255];
    const data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) data.set(x <= 2 ? N : (y === 2 && x === 3 ? C : G), (y * W + x) * 4);
    data.set([140, 80, 30, 255], (0 * W + 1) * 4); // 거울 원본 구분용
    const rect = { left: 5, top: 0, width: 7, height: H };
    const { filled, edges } = fillFrameGap(data, W, H, rect, config.scene.key, 8);
    assert.equal(edges.left, 2);
    const px = (x, y) => [...data.slice((y * W + x) * 4, (y * W + x) * 4 + 4)];
    assert.deepEqual(px(3, 0), [140, 80, 30, 255], '3열 ← 1열 (2열 축 거울)');
    assert.deepEqual(px(4, 0), [150, 90, 40, 255], '4열 ← 0열');
    assert.deepEqual(px(3, 2), C, '캐릭터는 그대로');
    assert.deepEqual(px(4, 2), [150, 90, 40, 255], '캐릭터 옆 그린도 같은 축으로 채운다(줄마다 끊기지 않게)');
    assert.deepEqual(px(5, 0), G, '틀 안은 그대로 (키로 빠진다)');
    assert.equal(filled, 2 * H - 1);
  });

  it('sealOutsideFrame: 키 직사각형 중 틀 밖 화소는 불투명으로 (카메라가 비치지 않게), 틀 안은 그대로', () => {
    const part = new Uint8ClampedArray(4 * 1 * 4).fill(0); // 4x1, 모두 투명
    const keyed = { left: 3, top: 0, width: 4, height: 1 };
    const sealed = sealOutsideFrame(part, keyed, { left: 5, top: 0, width: 10, height: 1 });
    assert.equal(sealed, 2);
    assert.deepEqual([part[3], part[7], part[11], part[15]], [255, 255, 0, 0]);
  });
});
