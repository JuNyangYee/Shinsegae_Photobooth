import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { carveRowScale, carveRowSource, carveRowTarget, screenFilterBypass, screenRenderSize } from '../../src/web/core/screen-layout.js';

describe('screen-layout (17단계)', () => {
  it('처리 크기는 1080x1920에 배율', () => {
    assert.deepEqual({ ...screenRenderSize(0.75) }, { width: 810, height: 1440 });
    assert.deepEqual({ ...screenRenderSize(1) }, { width: 1080, height: 1920 });
  });

  it('우회: 끔은 disabled, 감열지(1비트 점)는 thermal, 나머지는 합성', () => {
    assert.equal(screenFilterBypass({ enabled: false, outputMode: 'gray-oil' }), 'disabled');
    assert.equal(screenFilterBypass({ enabled: true, outputMode: 'thermal' }), 'thermal');
    assert.equal(screenFilterBypass({ enabled: true, outputMode: 'gray-oil' }), null);
    assert.equal(screenFilterBypass({ enabled: true, outputMode: 'off' }), null);
  });

  it('눈 글씨 원근: 역변환이 정변환을 되돌리고 윗변은 그대로, 아래는 커진다', () => {
    const d = 972;
    for (const y of [0, 30, 120, 230]) assert.ok(Math.abs(carveRowSource(carveRowTarget(y, d, 24), d, 24) - y) < 1e-9);
    assert.equal(carveRowTarget(0, d, 24), 0);
    assert.equal(carveRowScale(0, d, 24), 1);
    assert.ok(carveRowScale(200, d, 24) > 1);
  });
});
