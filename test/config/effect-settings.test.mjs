// 실행: npm test  (또는 node --test test/config/effect-settings.test.mjs)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import {
  EFFECT_TUNABLE_KEYS,
  applyEffectTunables,
  effectLimits,
  effectTunables,
  normalizeEffectSettings,
  parseStoredEffectSettings,
  sameEffectSettings,
  serializeEffectSettings,
} from '../../src/web/config/effect-settings.js';

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
    assert.equal(settings.previewScale, 1);
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

describe('효과 조절값 (E 화면·파일, 5-2)', () => {
  const base = normalizeEffectSettings(defaults, defaults).settings;

  it('조절값은 7개, 보완 층 문턱은 refine[4]', () => {
    assert.deepEqual(Object.keys(effectTunables(base)), [...EFFECT_TUNABLE_KEYS]);
    assert.deepEqual(effectTunables(base), { strength: 0.1, size: 1.25, boil: 0.1, fps: 24, grade: 1, refineThreshold: 0.22, previewScale: 1 });
  });

  it('조절값을 덮으면 붓 층 모양은 그대로, 범위 밖은 맞춘다', () => {
    const { settings, issues } = applyEffectTunables(base, { fps: 12, refineThreshold: 0.3, strength: 5 }, defaults);
    assert.equal(settings.fps, 12);
    assert.deepEqual(settings.refine, [3.5, 3, 10, 0.6, 0.3]);
    assert.equal(settings.strength, 1.6);
    assert.deepEqual(settings.layers, base.layers);
    assert.deepEqual(issues, ['strength: 5 -> 1.6']);
  });

  it('저장 → 읽기 왕복이 같다', () => {
    const changed = applyEffectTunables(base, { fps: 8, boil: 0.4, previewScale: 0.5 }, defaults).settings;
    const text = serializeEffectSettings(changed);
    assert.deepEqual(JSON.parse(text), { version: 1, settings: effectTunables(changed) });
    const back = parseStoredEffectSettings(text, defaults);
    assert.equal(back.source, 'stored');
    assert.deepEqual(back.issues, []);
    assert.ok(sameEffectSettings(back.settings, changed));
    assert.ok(!sameEffectSettings(back.settings, base));
  });

  it('없는 키는 기본값으로 채우고 알린다, 형식이 틀리면 기본값', () => {
    const partial = parseStoredEffectSettings(JSON.stringify({ version: 1, settings: { fps: 10 } }), defaults);
    assert.equal(partial.source, 'stored');
    assert.equal(partial.settings.fps, 10);
    assert.equal(partial.settings.strength, 0.1);
    assert.equal(partial.issues.length, 6);
    for (const [text, issue] of [['{', /not valid JSON/], ['[]', /not an object/], ['{"version":2,"settings":{}}', /version 2/]]) {
      const r = parseStoredEffectSettings(text, defaults);
      assert.equal(r.source, 'default');
      assert.match(r.issues[0], issue);
      assert.ok(sameEffectSettings(r.settings, base));
    }
    assert.deepEqual(parseStoredEffectSettings(null, defaults).issues, []);
  });
});
