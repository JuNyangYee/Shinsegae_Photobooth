import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { carveRowScale, carveRowSource, carveRowTarget, screenFilterBypass, screenPhotoSettings, screenRenderSize } from '../../src/web/core/screen-layout.js';

describe('screen-layout (17단계)', () => {
  it('처리 크기는 1080x1920에 배율', () => {
    assert.deepEqual({ ...screenRenderSize(0.75) }, { width: 810, height: 1440 });
    assert.deepEqual({ ...screenRenderSize(1) }, { width: 1080, height: 1920 });
  });

  it('우회는 끔일 때만 (감열지 시험도 화면 필터는 그대로)', () => {
    assert.equal(screenFilterBypass({ enabled: false }), 'disabled');
    assert.equal(screenFilterBypass({ enabled: true }), null);
  });

  it('사진 설정: 유화 수치는 화면 필터, 출력 단계는 카메라. 유화는 늘 켜고 카메라 층에 입힌 레벨은 다시 쓰지 않는다', () => {
    const filter = { strength: 0.3, size: 1.2, fps: 15, outputMode: 'off', oil: true };
    const camera = { outputMode: 'gray-oil', monoMode: 'gray-oil', oil: false, strength: 0.9, dither: 'blue-noise', paperDots: 576, bwStyle: 'tone', bwTexture: 1, lineSpacing: 4, brightness: -0.05, contrast: 1.5, gamma: 1.3 };
    const s = screenPhotoSettings(filter, camera);
    assert.deepEqual([s.strength, s.size, s.oil, s.outputMode, s.dither, s.paperDots], [0.3, 1.2, true, 'gray-oil', 'blue-noise', 576]);
    assert.deepEqual([s.brightness, s.contrast, s.gamma], [0, 1, 1]);
    const t = screenPhotoSettings(filter, { ...camera, outputMode: 'thermal' });
    assert.deepEqual([t.outputMode, t.brightness, t.contrast, t.gamma], ['thermal', -0.05, 1.5, 1.3]);
  });

  it('눈 글씨 원근: 역변환이 정변환을 되돌리고 윗변은 그대로, 아래는 커진다', () => {
    const d = 972;
    for (const y of [0, 30, 120, 230]) assert.ok(Math.abs(carveRowSource(carveRowTarget(y, d, 24), d, 24) - y) < 1e-9);
    assert.equal(carveRowTarget(0, d, 24), 0);
    assert.equal(carveRowScale(0, d, 24), 1);
    assert.ok(carveRowScale(200, d, 24) > 1);
  });
});
