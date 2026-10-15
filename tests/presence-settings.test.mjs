// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  PRESENCE_STORAGE_KEY,
  clampRegion,
  loadPresenceSettings,
  moveRegion,
  normalizePresenceSettings,
  parseStoredPresenceSettings,
  presenceLimits,
  resizeRegion,
  samePresenceSettings,
  savePresenceSettings,
  serializePresenceSettings,
} from '../src/web/js/presence-settings.js';

const defaults = Object.freeze({
  region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
  minFaceHeight: 0.05,
  maxFaceHeight: 0.6,
  minScore: 0.7,
  presentHoldMs: 500,
  absentGraceMs: 1000,
});

const valid = {
  region: { x: 0.2, y: 0.15, width: 0.5, height: 0.6 },
  minFaceHeight: 0.08,
  maxFaceHeight: 0.4,
  minScore: 0.75,
  presentHoldMs: 700,
  absentGraceMs: 1500,
};

function memoryStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key) => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    data,
  };
}

function insideStage(region) {
  return region.x >= 0 && region.y >= 0 && region.x + region.width <= 1 + 1e-12 && region.y + region.height <= 1 + 1e-12;
}

describe('normalizePresenceSettings', () => {
  it('올바른 값은 그대로 두고 문제를 보고하지 않는다', () => {
    const { settings, issues } = normalizePresenceSettings(valid, defaults);
    assert.deepEqual(settings, valid);
    assert.deepEqual(issues, []);
  });

  it('범위 밖 숫자는 범위 안으로 맞춘다', () => {
    const { settings, issues } = normalizePresenceSettings({
      ...valid, minFaceHeight: -1, maxFaceHeight: 5, minScore: 0.1, presentHoldMs: 99999, absentGraceMs: -20,
    }, defaults);
    assert.equal(settings.minFaceHeight, presenceLimits.faceHeight.min);
    assert.equal(settings.maxFaceHeight, presenceLimits.faceHeight.max);
    assert.equal(settings.minScore, presenceLimits.minScore.min);
    assert.equal(settings.presentHoldMs, presenceLimits.presentHoldMs.max);
    assert.equal(settings.absentGraceMs, 0);
    assert.equal(issues.length, 5);
  });

  it('숫자가 아니거나 없는 항목은 그 항목만 기본값', () => {
    const input = { ...valid, minScore: '0.9', presentHoldMs: Number.NaN };
    delete input.absentGraceMs;
    const { settings, issues } = normalizePresenceSettings(input, defaults);
    assert.equal(settings.minScore, defaults.minScore);
    assert.equal(settings.presentHoldMs, defaults.presentHoldMs);
    assert.equal(settings.absentGraceMs, defaults.absentGraceMs);
    assert.equal(settings.minFaceHeight, valid.minFaceHeight); // 나머지는 유지
    assert.deepEqual(settings.region, valid.region);
    assert.equal(issues.length, 3);
  });

  it('최소 얼굴 크기가 최대보다 크면 최대를 최소에 맞춘다', () => {
    const { settings, issues } = normalizePresenceSettings({ ...valid, minFaceHeight: 0.5, maxFaceHeight: 0.2 }, defaults);
    assert.equal(settings.minFaceHeight, 0.5);
    assert.equal(settings.maxFaceHeight, 0.5);
    assert.equal(issues.length, 1);
  });

  it('9:16 밖으로 나간 영역은 안으로 옮기고, 너무 크거나 작은 영역은 줄이거나 늘린다', () => {
    const shifted = normalizePresenceSettings({ ...valid, region: { x: 0.7, y: -0.2, width: 0.5, height: 0.3 } }, defaults);
    assert.deepEqual(shifted.settings.region, { x: 0.5, y: 0, width: 0.5, height: 0.3 });
    const huge = normalizePresenceSettings({ ...valid, region: { x: -1, y: -1, width: 3, height: 3 } }, defaults);
    assert.deepEqual(huge.settings.region, { x: 0, y: 0, width: 1, height: 1 });
    const tiny = normalizePresenceSettings({ ...valid, region: { x: 0.99, y: 0.5, width: 0, height: -1 } }, defaults);
    assert.deepEqual(tiny.settings.region, { x: 0.9, y: 0.5, width: 0.1, height: 0.1 });
    for (const result of [shifted, huge, tiny]) assert.equal(result.issues.length, 1);
  });

  it('영역 형식이 잘못되면 영역만 기본값', () => {
    for (const region of [null, 'x', [], { x: 0.1, y: 0.1, width: 0.5 }, { x: 0.1, y: 0.1, width: '0.5', height: 0.5 }]) {
      const { settings, issues } = normalizePresenceSettings({ ...valid, region }, defaults);
      assert.deepEqual(settings.region, defaults.region);
      assert.equal(settings.minScore, valid.minScore);
      assert.equal(issues.length, 1);
    }
  });

  it('객체가 아니면 모든 항목이 기본값', () => {
    const { settings } = normalizePresenceSettings(42, defaults);
    assert.deepEqual(settings, { ...defaults, region: { ...defaults.region } });
  });

  it('반올림 후에도 영역이 9:16 밖으로 나가지 않는다', () => {
    const region = clampRegion({ x: 0.66665, y: 0.123456, width: 0.33335, height: 0.876544 });
    assert.ok(insideStage(region), JSON.stringify(region));
  });
});

describe('parseStoredPresenceSettings', () => {
  it('저장값이 없으면 기본값, 문제 없음', () => {
    const result = parseStoredPresenceSettings(null, defaults);
    assert.equal(result.source, 'default');
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.settings, { ...defaults, region: { ...defaults.region } });
  });

  it('손상된 JSON이어도 예외 없이 기본값', () => {
    for (const text of ['{', 'undefined', '', '{"version":1,"settings":']) {
      const result = parseStoredPresenceSettings(text, defaults);
      assert.equal(result.source, 'default');
      assert.equal(result.issues.length, 1);
    }
  });

  it('객체가 아닌 JSON은 기본값', () => {
    for (const text of ['null', '42', '"text"', '[1,2]']) {
      assert.equal(parseStoredPresenceSettings(text, defaults).source, 'default');
    }
  });

  it('버전이 다르면 기본값', () => {
    for (const version of [0, 2, '1', undefined]) {
      const result = parseStoredPresenceSettings(JSON.stringify({ version, settings: valid }), defaults);
      assert.equal(result.source, 'default');
      assert.match(result.issues[0], /version/);
    }
  });

  it('저장 형식을 그대로 다시 읽는다', () => {
    const result = parseStoredPresenceSettings(serializePresenceSettings(valid), defaults);
    assert.equal(result.source, 'stored');
    assert.deepEqual(result.settings, valid);
    assert.deepEqual(result.issues, []);
  });

  it('settings 안의 잘못된 항목만 바꾼다', () => {
    const result = parseStoredPresenceSettings(JSON.stringify({ version: 1, settings: { ...valid, minScore: 3 } }), defaults);
    assert.equal(result.source, 'stored');
    assert.equal(result.settings.minScore, 1);
    assert.equal(result.settings.presentHoldMs, valid.presentHoldMs);
  });
});

describe('loadPresenceSettings / savePresenceSettings', () => {
  it('저장 후 불러오면 같은 값', () => {
    const storage = memoryStorage();
    assert.equal(savePresenceSettings(storage, valid), null);
    assert.ok(storage.data.has(PRESENCE_STORAGE_KEY));
    assert.deepEqual(loadPresenceSettings(storage, defaults).settings, valid);
  });

  it('저장소 읽기·쓰기가 실패해도 예외를 던지지 않는다', () => {
    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('quota'); } };
    const loaded = loadPresenceSettings(broken, defaults);
    assert.equal(loaded.source, 'default');
    assert.match(loaded.issues[0], /denied/);
    assert.equal(savePresenceSettings(broken, valid), 'quota');
  });

  it('samePresenceSettings', () => {
    assert.equal(samePresenceSettings(valid, { ...valid, region: { ...valid.region } }), true);
    assert.equal(samePresenceSettings(valid, { ...valid, minScore: 0.8 }), false);
  });
});

describe('moveRegion / resizeRegion', () => {
  const start = { x: 0.2, y: 0.2, width: 0.4, height: 0.5 };

  it('이동: 크기를 유지하고 9:16 안에 머문다', () => {
    assert.deepEqual(moveRegion(start, 0.1, -0.05), { x: 0.3, y: 0.15, width: 0.4, height: 0.5 });
    assert.deepEqual(moveRegion(start, 1, 1), { x: 0.6, y: 0.5, width: 0.4, height: 0.5 });
    assert.deepEqual(moveRegion(start, -1, -1), { x: 0, y: 0, width: 0.4, height: 0.5 });
  });

  it('변 핸들: 반대쪽 변은 고정', () => {
    assert.deepEqual(resizeRegion(start, 'e', { x: 0.9, y: 0.9 }), { x: 0.2, y: 0.2, width: 0.7, height: 0.5 });
    assert.deepEqual(resizeRegion(start, 'w', { x: 0.1, y: 0.9 }), { x: 0.1, y: 0.2, width: 0.5, height: 0.5 });
    assert.deepEqual(resizeRegion(start, 'n', { x: 0.9, y: 0.05 }), { x: 0.2, y: 0.05, width: 0.4, height: 0.65 });
    assert.deepEqual(resizeRegion(start, 's', { x: 0.9, y: 0.95 }), { x: 0.2, y: 0.2, width: 0.4, height: 0.75 });
  });

  it('모서리 핸들: 두 변을 함께 옮긴다', () => {
    assert.deepEqual(resizeRegion(start, 'nw', { x: 0.1, y: 0.1 }), { x: 0.1, y: 0.1, width: 0.5, height: 0.6 });
    assert.deepEqual(resizeRegion(start, 'se', { x: 0.8, y: 0.9 }), { x: 0.2, y: 0.2, width: 0.6, height: 0.7 });
  });

  it('9:16 밖으로 끌어도 경계에서 멈춘다', () => {
    assert.deepEqual(resizeRegion(start, 'nw', { x: -0.5, y: -0.5 }), { x: 0, y: 0, width: 0.6, height: 0.7 });
    assert.deepEqual(resizeRegion(start, 'se', { x: 1.5, y: 1.5 }), { x: 0.2, y: 0.2, width: 0.8, height: 0.8 });
  });

  it('최소 크기보다 작아지지 않고, 반대쪽 변을 넘어가지 않는다', () => {
    assert.deepEqual(resizeRegion(start, 'e', { x: 0, y: 0.5 }), { x: 0.2, y: 0.2, width: 0.1, height: 0.5 });
    assert.deepEqual(resizeRegion(start, 'n', { x: 0.5, y: 1 }), { x: 0.2, y: 0.6, width: 0.4, height: 0.1 });
  });
});
