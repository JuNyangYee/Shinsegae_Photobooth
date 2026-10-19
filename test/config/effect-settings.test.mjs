// 실행: npm test  (또는 node --test test/config/effect-settings.test.mjs)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import {
  BW_STYLES,
  DITHER_METHODS,
  EFFECT_TUNABLE_KEYS,
  OUTPUT_MODES,
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
  it('기본값(oil2f 사용자 세팅 그대로, boil 0.1)은 그대로 통과한다', () => {
    const { settings, issues } = normalizeEffectSettings(defaults, defaults);
    assert.deepEqual(issues, []);
    assert.equal(settings.strength, 0.1);
    assert.equal(settings.size, 1.25);
    assert.equal(settings.boil, 0.1, 'oil2f 원본 값 (7-1의 0.05에서 되돌림, 사용자 결정 2026-10-19 8단계)');
    assert.equal(settings.fps, 24);
    assert.equal(settings.grade, 1);
    assert.deepEqual(settings.layers, [[36, 15, 84, 3.8, 0, 1], [18, 8, 44, 2.6, 0.02, 1], [8, 4, 20, 1.4, 0.06, 1]]);
    assert.deepEqual(settings.refine, [3.5, 3, 10, 0.6, 0.22]);
    assert.equal(settings.previewScale, 1);
    assert.ok(Object.isFrozen(settings) && Object.isFrozen(settings.layers[0]) && Object.isFrozen(settings.refine));
  });

  it('출력 단계 기본값: 회색조 유화(8단계 사용자 결정), 80mm 576점, 레벨 중립 (6-1 사용자 결정)', () => {
    const { settings } = normalizeEffectSettings(defaults, defaults);
    assert.equal(settings.outputMode, 'gray-oil');
    assert.deepEqual([...OUTPUT_MODES], ['gray-oil', 'thermal', 'gray', 'off'], '기존 모드 3개는 남긴다');
    assert.equal(settings.paperDots, 576);
    assert.ok(DITHER_METHODS.includes(settings.dither));
    assert.deepEqual([settings.brightness, settings.contrast, settings.gamma], [0, 1, 1]);
  });

  it('출력 모드·점 방식은 목록에 없으면 기본값, 용지 점 수는 8의 배수·범위로, 레벨은 범위로', () => {
    const { settings, issues } = normalizeEffectSettings({
      ...defaults, outputMode: 'sepia', dither: 7, paperDots: 383, brightness: 2, contrast: 0, gamma: 9,
    }, defaults);
    assert.equal(settings.outputMode, defaults.outputMode);
    assert.equal(settings.dither, defaults.dither);
    assert.equal(settings.paperDots, 384);
    assert.deepEqual([settings.brightness, settings.contrast, settings.gamma], [0.5, 0.5, 2.5]);
    assert.ok(issues.includes('outputMode: "sepia" -> default') && issues.includes('dither: 7 -> default'));
    assert.ok(issues.includes('paperDots: 383 -> 384'));
    for (const mode of OUTPUT_MODES) assert.equal(normalizeEffectSettings({ ...defaults, outputMode: mode }, defaults).settings.outputMode, mode);
    for (const method of DITHER_METHODS) assert.equal(normalizeEffectSettings({ ...defaults, dither: method }, defaults).settings.dither, method);
    assert.equal(normalizeEffectSettings({ ...defaults, paperDots: 5000 }, defaults).settings.paperDots, 1024);
    assert.equal(normalizeEffectSettings({ ...defaults, paperDots: 1 }, defaults).settings.paperDots, 128);
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

  it('조절값은 16개(5-2의 7개 + 출력 단계 6개 + 흑백 스타일 3개), 보완 층 문턱은 refine[4]', () => {
    assert.deepEqual(Object.keys(effectTunables(base)), [...EFFECT_TUNABLE_KEYS]);
    assert.deepEqual(effectTunables(base), {
      strength: 0.1, size: 1.25, boil: 0.1, fps: 24, grade: 1, refineThreshold: 0.22, previewScale: 1,
      outputMode: 'gray-oil', dither: defaults.dither, brightness: 0, contrast: 1, gamma: 1, paperDots: 576,
      bwStyle: defaults.bwStyle, bwTexture: defaults.bwTexture, lineSpacing: defaults.lineSpacing,
    });
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
    const changed = applyEffectTunables(base, {
      fps: 8, boil: 0.4, previewScale: 0.5, outputMode: 'gray', dither: 'atkinson', brightness: 0.1, contrast: 1.3, gamma: 1.4, paperDots: 384,
    }, defaults).settings;
    assert.deepEqual([changed.outputMode, changed.dither, changed.paperDots], ['gray', 'atkinson', 384]);
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
    assert.equal(partial.issues.length, 15);
    for (const [text, issue] of [['{', /not valid JSON/], ['[]', /not an object/], ['{"version":2,"settings":{}}', /version 2/]]) {
      const r = parseStoredEffectSettings(text, defaults);
      assert.equal(r.source, 'default');
      assert.match(r.issues[0], issue);
      assert.ok(sameEffectSettings(r.settings, base));
    }
    assert.deepEqual(parseStoredEffectSettings(null, defaults).issues, []);
  });

  it('5-2 파일(같은 버전 1, 조절값 7개만)을 읽으면 그 값은 쓰고 출력 단계는 기본값(회색조 유화)으로 채운다', () => {
    const old = JSON.stringify({ version: 1, settings: {
      strength: 0.3, size: 1, boil: 0.2, fps: 12, grade: 0.5, refineThreshold: 0.3, previewScale: 0.75,
    } }, null, 2);
    const r = parseStoredEffectSettings(old, defaults);
    assert.equal(r.source, 'stored');
    assert.deepEqual([r.settings.strength, r.settings.fps, r.settings.refine[4], r.settings.previewScale], [0.3, 12, 0.3, 0.75]);
    assert.deepEqual([r.settings.outputMode, r.settings.paperDots, r.settings.dither], ['gray-oil', 576, defaults.dither]);
    assert.deepEqual(r.issues, ['outputMode', 'dither', 'brightness', 'contrast', 'gamma', 'paperDots', 'bwStyle', 'bwTexture', 'lineSpacing']
      .map((k) => `${k}: missing -> default`));
  });

  it('6-1 파일(조절값 13개)을 읽으면 그 값은 쓰고 흑백 스타일 3개는 기본값으로 채워 알린다 (7-1)', () => {
    const old = JSON.stringify({ version: 1, settings: {
      strength: 0.1, size: 1.25, boil: 0.1, fps: 24, grade: 1, refineThreshold: 0.22, previewScale: 1,
      outputMode: 'thermal', dither: 'bayer', brightness: 0.05, contrast: 1.1, gamma: 1.2, paperDots: 384,
    } }, null, 2);
    const r = parseStoredEffectSettings(old, defaults);
    assert.equal(r.source, 'stored');
    assert.deepEqual([r.settings.dither, r.settings.paperDots, r.settings.gamma], ['bayer', 384, 1.2]);
    assert.equal(r.settings.outputMode, 'thermal', '파일에 저장된 모드가 새 기본값(회색조 유화)보다 앞선다 (8단계)');
    assert.equal(r.settings.boil, 0.1, '파일에 저장된 boil을 쓴다');
    assert.deepEqual([r.settings.bwStyle, r.settings.bwTexture, r.settings.lineSpacing], [defaults.bwStyle, defaults.bwTexture, defaults.lineSpacing]);
    assert.deepEqual(r.issues, ['bwStyle', 'bwTexture', 'lineSpacing'].map((k) => `${k}: missing -> default`));
  });
});

describe('흑백 스타일 설정 (7-1)', () => {
  it('boil이 없는 파일은 기본값 0.1(8단계에서 되돌림), 있으면 파일 값이 앞선다 (7단계에 저장한 0.05도 그대로)', () => {
    const missing = parseStoredEffectSettings(JSON.stringify({ version: 1, settings: { fps: 12 } }), defaults);
    assert.equal(missing.settings.boil, 0.1);
    assert.ok(missing.issues.includes('boil: missing -> default'));
    for (const boil of [0.05, 0, 0.3]) {
      assert.equal(parseStoredEffectSettings(JSON.stringify({ version: 1, settings: { boil } }), defaults).settings.boil, boil);
    }
  });

  it('기본값은 붓 결 선·질감 세기 1·선 간격 4점(사용자 결정), 스타일은 목록에 없으면 기본값, 세기·간격은 범위로', () => {
    const { settings, issues } = normalizeEffectSettings(defaults, defaults);
    assert.deepEqual(issues, []);
    assert.deepEqual([settings.bwStyle, settings.bwTexture, settings.lineSpacing], ['stroke', 1, 4]);
    assert.deepEqual([...BW_STYLES], ['tone', 'texture', 'flow', 'stroke']);
    for (const style of BW_STYLES) assert.equal(normalizeEffectSettings({ ...defaults, bwStyle: style }, defaults).settings.bwStyle, style);
    const bad = normalizeEffectSettings({ ...defaults, bwStyle: 'oil', bwTexture: 9, lineSpacing: 0 }, defaults);
    assert.deepEqual([bad.settings.bwStyle, bad.settings.bwTexture, bad.settings.lineSpacing], ['stroke', 2, 2]);
    assert.deepEqual(bad.issues, ['bwStyle: "oil" -> default', 'bwTexture: 9 -> 2', 'lineSpacing: 0 -> 2']);
  });

  it('저장 → 읽기 왕복에 흑백 스타일 값이 들어간다', () => {
    const base = normalizeEffectSettings(defaults, defaults).settings;
    const changed = applyEffectTunables(base, { bwStyle: 'flow', bwTexture: 0.5, lineSpacing: 6 }, defaults).settings;
    const back = parseStoredEffectSettings(serializeEffectSettings(changed), defaults);
    assert.deepEqual(back.issues, []);
    assert.deepEqual([back.settings.bwStyle, back.settings.bwTexture, back.settings.lineSpacing], ['flow', 0.5, 6]);
    assert.ok(!sameEffectSettings(back.settings, base));
  });
});

describe('회색조 유화 설정 (8단계)', () => {
  it('7단계 파일(조절값 16개, 감열지·붓 결 선)은 그대로 읽는다: 모드는 파일 값, 알림 없음', () => {
    const stage7 = JSON.stringify({ version: 1, settings: {
      strength: 0.1, size: 1.25, boil: 0.05, fps: 24, grade: 1, refineThreshold: 0.22, previewScale: 1,
      outputMode: 'thermal', dither: 'blue-noise', brightness: 0, contrast: 1, gamma: 1, paperDots: 576,
      bwStyle: 'stroke', bwTexture: 1, lineSpacing: 4,
    } }, null, 2);
    const r = parseStoredEffectSettings(stage7, defaults);
    assert.equal(r.source, 'stored');
    assert.deepEqual(r.issues, []);
    assert.deepEqual([r.settings.outputMode, r.settings.bwStyle], ['thermal', 'stroke']);
    assert.equal(r.settings.boil, 0.05, '7단계에 저장한 boil은 새 기본값(0.1)보다 앞선다');
    for (const mode of ['gray', 'off']) {
      const file = JSON.stringify({ version: 1, settings: { ...JSON.parse(stage7).settings, outputMode: mode } });
      assert.equal(parseStoredEffectSettings(file, defaults).settings.outputMode, mode);
    }
  });

  it('회색조 유화 저장 → 읽기 왕복, 버전은 1 그대로', () => {
    const base = normalizeEffectSettings({ ...defaults, outputMode: 'thermal' }, defaults).settings;
    const changed = applyEffectTunables(base, { outputMode: 'gray-oil', dither: 'atkinson', paperDots: 384 }, defaults).settings;
    const text = serializeEffectSettings(changed);
    assert.equal(JSON.parse(text).version, 1);
    assert.equal(JSON.parse(text).settings.outputMode, 'gray-oil');
    const back = parseStoredEffectSettings(text, defaults);
    assert.deepEqual(back.issues, []);
    assert.deepEqual([back.settings.outputMode, back.settings.dither, back.settings.paperDots], ['gray-oil', 'atkinson', 384]);
  });

  it('모드 값이 틀린 파일은 그 항목만 기본값(회색조 유화)으로', () => {
    const r = parseStoredEffectSettings(JSON.stringify({ version: 1, settings: { outputMode: 'grey-oil', fps: 12 } }), defaults);
    assert.equal(r.settings.outputMode, 'gray-oil');
    assert.equal(r.settings.fps, 12);
    assert.ok(r.issues.includes('outputMode: "grey-oil" -> default'));
  });
});
