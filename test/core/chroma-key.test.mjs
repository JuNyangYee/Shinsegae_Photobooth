import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { config } from '../../src/web/config/config.js';
import { applyGreenKey, greenKeyAlpha } from '../../src/web/core/chroma-key.js';

const key = config.scene.key;

describe('chroma-key: 단색 그린 전경 키', () => {
  it('순수 그린은 투명, 캐릭터 색(흰 털·빨강·주황·핑크·파랑·노랑·회검·탁한 초록)은 불투명', () => {
    assert.equal(greenKeyAlpha(0, 255, 0, key), 0);
    assert.equal(greenKeyAlpha(30, 240, 40, key), 0, '압축·조명 얼룩이 있는 그린');
    for (const [r, g, b] of [[245, 245, 240], [200, 30, 40], [230, 110, 40], [240, 170, 190], [70, 110, 190], [220, 170, 40],
      [40, 40, 45], [80, 100, 75], [35, 85, 50]]) {
      assert.equal(greenKeyAlpha(r, g, b, key), 255, `${r},${g},${b}`);
    }
  });

  it('가장자리(흰 털과 그린이 섞인 화소)는 반투명이 되고 초록 번짐을 지운다. 원래 알파보다 커지지 않는다', () => {
    const data = new Uint8ClampedArray([
      0, 255, 0, 255, // 배경
      170, 255, 170, 255, // 가장자리 d = 85
      240, 240, 235, 255, // 흰 털
      120, 250, 110, 100, // 이미 반투명
    ]);
    const counts = applyGreenKey(data, key);
    assert.deepEqual(counts, { cleared: 1, edge: 2, despilled: 0 });
    assert.equal(data[3], 0);
    assert.ok(data[7] > 0 && data[7] < 255, String(data[7]));
    assert.equal(data[5], 170, '가장자리 G = max(R, B)');
    assert.deepEqual([...data.slice(8, 12)], [240, 240, 235, 255]);
    assert.ok(data[15] <= 100);
  });

  it('잘못된 키 범위는 거부한다', () => {
    assert.throws(() => applyGreenKey(new Uint8ClampedArray(4), { low: 100, high: 50 }), RangeError);
  });
});

describe('chroma-key: 키 둘레의 초록 번짐', () => {
  it('폭을 주면 키가 빠진 화소에서 3화소 안의 불투명 화소만 평균 기준으로 알파를 줄이고 G를 (R+B)/2로 (먼 곳의 같은 색은 그대로, 15단계)', () => {
    // 한 줄 7화소: 그린 | 노란 빛 테(e 46.5) ×3 | 거리 4의 같은 색 | 주황 털 | 흰 털
    const rim = [224, 190, 63, 255];
    const data = new Uint8ClampedArray([0, 255, 0, 255, ...rim, ...rim, ...rim, ...rim, 220, 110, 40, 255, 240, 240, 235, 255]);
    const counts = applyGreenKey(data, key, 7);
    assert.deepEqual(counts, { cleared: 1, edge: 0, despilled: 3 });
    assert.deepEqual([data[5], data[9], data[13], data[17]], [144, 144, 144, 190], '거리 1~3은 G = (R+B)/2, 거리 4는 그대로');
    assert.deepEqual([data[7], data[11], data[15], data[19]], [158, 158, 158, 255], 'e 46.5 → 알파 158 (RIM_KEY 20~90)');
    assert.deepEqual([...data.slice(20, 28)], [220, 110, 40, 255, 240, 240, 235, 255], '털 색은 둘레가 아니어도 둘레여도 그대로');
  });

  it('폭이 없으면 둘레 처리를 하지 않는다', () => {
    const data = new Uint8ClampedArray([0, 255, 0, 255, 150, 190, 120, 255]);
    assert.equal(applyGreenKey(data, key).despilled, 0);
    assert.equal(data[5], 190);
  });
});
