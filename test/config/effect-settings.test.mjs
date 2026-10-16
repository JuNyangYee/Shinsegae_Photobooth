// 실행: npm test  (또는 node --test test/config/effect-settings.test.mjs)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { effectLimits, normalizeEffectSettings } from '../../src/web/config/effect-settings.js';

const defaults = config.effect;

describe('normalizeEffectSettings', () => {
  it('기본값(oil2f 사용자 세팅)은 그대로 통과한다', () => {
    const { settings, issues } = normalizeEffectSettings(defaults, defaults);
    assert.deepEqual(issues, []);
    assert.equal(settings.strength, 0.1);
    assert.equal(settings.size, 1.25);
    assert.equal(settings.boil, 0.1);
    assert.equal(settings.fps, 24);
    assert.equal(settings.grade, 1);
    assert.deepEqual(settings.layers, [[36, 15, 84, 3.8, 0, 1], [18, 8, 44, 2.6, 0.02, 1], [8, 4, 20, 1.4, 0.06, 1]]);
    assert.deepEqual(settings.refine, [3.5, 3, 10, 0.6, 0.22]);
    assert.equal(settings.previewScale, 0.5);
    assert.ok(Object.isFrozen(settings) && Object.isFrozen(settings.layers[0]) && Object.isFrozen(settings.refine));
  });

  it('범위 밖은 범위로, fps는 정수로', () => {
    const { settings, issues } = normalizeEffectSettings({ ...defaults, strength: 9, size: 0.1, boil: -1, fps: 12.6, grade: 2, previewScale: 3 }, defaults);
    assert.deepEqual([settings.strength, settings.size, settings.boil, settings.fps, settings.grade, settings.previewScale],
      [effectLimits.strength.max, effectLimits.size.min, 0, 13, 1, 1]);
    assert.equal(issues.length, 6);
  });

  it('숫자가 아니거나 없으면 그 항목만 기본값', () => {
    const { settings, issues } = normalizeEffectSettings({ strength: 'x', fps: NaN, boil: 0.3 }, defaults);
    assert.equal(settings.strength, 0.1);
    assert.equal(settings.fps, 24);
    assert.equal(settings.boil, 0.3);
    assert.ok(issues.includes('strength: not a number -> default'));
    assert.ok(issues.includes('size: missing -> default'));
    assert.ok(issues.includes('layers: missing -> default'));
  });

  it('붓 층·보완 층 모양이 틀리면 기본값, 보완 층 문턱은 범위로, null이면 보완 층 없음', () => {
    const bad = normalizeEffectSettings({ ...defaults, layers: [[1, 2]], refine: [1, 2, 3] }, defaults);
    assert.deepEqual(bad.settings.layers, defaults.layers);
    assert.deepEqual(bad.settings.refine, defaults.refine);
    assert.ok(bad.issues.includes('layers: invalid -> default') && bad.issues.includes('refine: invalid -> default'));
    const zero = normalizeEffectSettings({ ...defaults, layers: [[0, 15, 84, 3.8, 0, 1]] }, defaults);
    assert.deepEqual(zero.settings.layers, defaults.layers, '굵기 0은 쓸 수 없다');
    const threshold = normalizeEffectSettings({ ...defaults, refine: [3.5, 3, 10, 0.6, 0] }, defaults);
    assert.equal(threshold.settings.refine[4], 0.01, '0은 셰이더에서 "보완 층 아님"이라 쓰지 않는다');
    const off = normalizeEffectSettings({ ...defaults, refine: null }, defaults);
    assert.equal(off.settings.refine, null);
    assert.deepEqual(off.issues, []);
  });

  it('입력이 객체가 아니면 전부 기본값', () => {
    const { settings } = normalizeEffectSettings(null, defaults);
    assert.equal(settings.fps, 24);
    assert.deepEqual(settings.refine, defaults.refine);
  });
});
