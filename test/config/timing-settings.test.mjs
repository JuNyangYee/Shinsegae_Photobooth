// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEGACY_PRESENCE_TIMING_KEYS,
  extractLegacyTiming,
  normalizeTimingSettings,
  parseStoredTimingSettings,
  sameTimingSettings,
  serializeTimingSettings,
  timingFromLegacy,
  timingLimits,
  withLegacyTiming,
} from '../../src/web/config/timing-settings.js';
import { serializePresenceSettings } from '../../src/web/config/presence-settings.js';
import { config } from '../../src/web/config/config.js';

const defaults = config.timing;

const valid = {
  countdownSeconds: 5, resultMs: 15000, cooldownMs: 2500, presentHoldMs: 700, absentGraceMs: 1500,
  cameraRecovery: { retryIntervalMs: 5000, firstFrameTimeoutMs: 8000, stallTimeoutMs: 2500, staffNoticeMs: 60000 },
};

describe('시간 설정 기본값 (config.timing, 10단계)', () => {
  it('촬영 흐름 3초·10초·5초, 반응 250/250ms, 회복 3·5·3·30초 (모두 9단계까지의 값 그대로)이고 정규화해도 그대로다', () => {
    assert.deepEqual({ ...defaults, cameraRecovery: { ...defaults.cameraRecovery } }, {
      countdownSeconds: 3, resultMs: 10000, cooldownMs: 5000, presentHoldMs: 250, absentGraceMs: 250,
      cameraRecovery: { retryIntervalMs: 3000, firstFrameTimeoutMs: 5000, stallTimeoutMs: 3000, staffNoticeMs: 30000 },
    });
    const { settings, issues } = normalizeTimingSettings(defaults, defaults);
    assert.deepEqual(issues, []);
    assert.equal(sameTimingSettings(settings, defaults), true);
  });

  it('config.session에는 운영자가 만지지 않는 시간만 남는다 (카운트다운·결과·쿨타임은 timing)', () => {
    for (const key of ['countdownSeconds', 'resultMs', 'cooldownMs']) assert.equal(key in config.session, false, key);
    assert.deepEqual(Object.keys(config.session), ['captureTimeoutMs', 'failureRetryMs', 'failureRetryMaxMs']);
  });

  it('기본값은 모두 범위 안이고 단계에 맞는다', () => {
    for (const key of ['countdownSeconds', 'resultMs', 'cooldownMs', 'presentHoldMs', 'absentGraceMs']) {
      const { min, max, step } = timingLimits[key];
      assert.ok(defaults[key] >= min && defaults[key] <= max, key);
      assert.equal((defaults[key] - min) % step, 0, key);
    }
    for (const [key, value] of Object.entries(defaults.cameraRecovery)) {
      const { min, max, step } = timingLimits.cameraRecovery[key];
      assert.ok(value >= min && value <= max, key);
      assert.equal((value - min) % step, 0, key);
    }
  });
});

describe('범위 (촬영 흐름 가안, 반응·회복은 9단계 범위 그대로)', () => {
  it('카운트다운 1~10초(1초), 결과 3~60초(1초), 쿨타임 0~30초(0.5초)', () => {
    const pick = ({ min, max, step }) => [min, max, step];
    assert.deepEqual(pick(timingLimits.countdownSeconds), [1, 10, 1]);
    assert.deepEqual(pick(timingLimits.resultMs), [3000, 60000, 1000]);
    assert.deepEqual(pick(timingLimits.cooldownMs), [0, 30000, 500]);
  });

  it('반응 시간 0~2000ms, 50ms 단위: 250ms와 100ms를 정확히 고를 수 있다', () => {
    for (const key of ['presentHoldMs', 'absentGraceMs']) {
      const { min, max, step } = timingLimits[key];
      assert.deepEqual({ min, max, step }, { min: 0, max: 2000, step: 50 });
      for (const ms of [100, 250]) assert.equal((ms - min) % step, 0, `${key} ${ms}`);
    }
  });

  it('회복: 재시도 1~30초, 첫 프레임 2~30초, 정지 판정 1~10초, 직원 문의 5~300초', () => {
    const r = timingLimits.cameraRecovery;
    assert.deepEqual([r.retryIntervalMs.min, r.retryIntervalMs.max, r.firstFrameTimeoutMs.min, r.firstFrameTimeoutMs.max,
      r.stallTimeoutMs.min, r.stallTimeoutMs.max, r.staffNoticeMs.min, r.staffNoticeMs.max], [1000, 30000, 2000, 30000, 1000, 10000, 5000, 300000]);
  });

  it('정지 판정은 어떤 값이든 촬영 직전 정지 화면 검사(config.capture.maxFrameAgeMs)보다 길다 (파일에 짧은 값을 써도 고쳐진다)', () => {
    assert.ok(timingLimits.cameraRecovery.stallTimeoutMs.min > config.capture.maxFrameAgeMs);
    for (const stallTimeoutMs of [0, 100, config.capture.maxFrameAgeMs, -5]) {
      const { settings } = normalizeTimingSettings({ ...valid, cameraRecovery: { ...valid.cameraRecovery, stallTimeoutMs } }, defaults);
      assert.ok(settings.cameraRecovery.stallTimeoutMs > config.capture.maxFrameAgeMs, String(stallTimeoutMs));
    }
  });
});

describe('normalizeTimingSettings', () => {
  it('올바른 값은 그대로 두고 문제를 보고하지 않는다', () => {
    const { settings, issues } = normalizeTimingSettings(valid, defaults);
    assert.deepEqual({ ...settings, cameraRecovery: { ...settings.cameraRecovery } }, valid);
    assert.deepEqual(issues, []);
  });

  it('범위 밖은 범위 안으로, 소수는 정수로 (알린다)', () => {
    const { settings, issues } = normalizeTimingSettings({
      ...valid, countdownSeconds: 0, resultMs: 999999, cooldownMs: -1, presentHoldMs: 5000, absentGraceMs: 249.6,
    }, defaults);
    assert.deepEqual([settings.countdownSeconds, settings.resultMs, settings.cooldownMs, settings.presentHoldMs, settings.absentGraceMs],
      [1, 60000, 0, 2000, 250]);
    assert.deepEqual(issues, ['countdownSeconds: 0 -> 1', 'resultMs: 999999 -> 60000', 'cooldownMs: -1 -> 0',
      'presentHoldMs: 5000 -> 2000', 'absentGraceMs: 249.6 -> 250']);
    assert.deepEqual(normalizeTimingSettings({ ...valid, countdownSeconds: 2.5 }, defaults).issues, ['countdownSeconds: 2.5 -> 3']);
  });

  it('숫자가 아니거나 없는 항목은 그 항목만 기본값 (알린다)', () => {
    const input = { ...valid, resultMs: '15000', cooldownMs: Number.NaN };
    delete input.countdownSeconds;
    const { settings, issues } = normalizeTimingSettings(input, defaults);
    assert.deepEqual([settings.countdownSeconds, settings.resultMs, settings.cooldownMs], [3, 10000, 5000]);
    assert.equal(settings.presentHoldMs, valid.presentHoldMs);
    assert.deepEqual(issues, ['countdownSeconds: missing -> default', 'resultMs: not a number -> default', 'cooldownMs: not a number -> default']);
  });

  it('cameraRecovery: 없으면 알리지 않고 기본값, 형식이 틀리면 기본값, 항목이 틀리면 그 항목만 (알린다)', () => {
    const { cameraRecovery, ...noRecovery } = valid;
    assert.ok(cameraRecovery);
    const missing = normalizeTimingSettings(noRecovery, defaults);
    assert.deepEqual({ ...missing.settings.cameraRecovery }, { ...defaults.cameraRecovery });
    assert.deepEqual(missing.issues, []);
    assert.deepEqual(normalizeTimingSettings({ ...valid, cameraRecovery: 'x' }, defaults).issues, ['cameraRecovery: invalid -> default']);
    const { settings, issues } = normalizeTimingSettings({
      ...valid, cameraRecovery: { retryIntervalMs: 100, firstFrameTimeoutMs: 'slow', stallTimeoutMs: 99999, staffNoticeMs: 45000.4 },
    }, defaults);
    assert.deepEqual({ ...settings.cameraRecovery }, { retryIntervalMs: 1000, firstFrameTimeoutMs: 5000, stallTimeoutMs: 10000, staffNoticeMs: 45000 });
    assert.deepEqual(issues, [
      'cameraRecovery.retryIntervalMs: 100 -> 1000', 'cameraRecovery.firstFrameTimeoutMs: not a number -> default',
      'cameraRecovery.stallTimeoutMs: 99999 -> 10000', 'cameraRecovery.staffNoticeMs: 45000.4 -> 45000',
    ]);
  });

  it('객체가 아니면 모든 항목이 기본값', () => {
    for (const input of [null, 42, 'x', [1]]) {
      assert.equal(sameTimingSettings(normalizeTimingSettings(input, defaults).settings, defaults), true);
    }
  });
});

describe('저장 형식 (config/timing.local.json)', () => {
  it('키 순서가 고정된 { version: 1, settings } (2칸 들여쓰기)이고 그대로 다시 읽는다', () => {
    const text = serializeTimingSettings(normalizeTimingSettings(valid, defaults).settings);
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, 1);
    assert.deepEqual(Object.keys(parsed.settings), ['countdownSeconds', 'resultMs', 'cooldownMs', 'presentHoldMs', 'absentGraceMs', 'cameraRecovery']);
    assert.deepEqual(Object.keys(parsed.settings.cameraRecovery), ['retryIntervalMs', 'firstFrameTimeoutMs', 'stallTimeoutMs', 'staffNoticeMs']);
    assert.match(text, /\n {2}"settings"/);
    const result = parseStoredTimingSettings(text, defaults);
    assert.equal(result.source, 'stored');
    assert.deepEqual(result.issues, []);
    assert.equal(sameTimingSettings(result.settings, valid), true);
  });

  it('없음·손상·객체 아님·버전 다름은 예외 없이 기본값', () => {
    assert.deepEqual(parseStoredTimingSettings(null, defaults).issues, []);
    for (const text of ['{', '', 'null', '42', '[1]', JSON.stringify({ version: 2, settings: valid }), JSON.stringify({ settings: valid })]) {
      const result = parseStoredTimingSettings(text, defaults);
      assert.equal(result.source, 'default', text);
      assert.equal(result.issues.length, 1, text);
      assert.equal(sameTimingSettings(result.settings, defaults), true);
    }
  });
});

describe('인식 파일의 옛 시간 키 (9단계까지 presence.local.json)', () => {
  const presenceCriteria = { region: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 }, minFaceHeight: 0.185, maxFaceHeight: 0.47, minScore: 0.65 };
  // 사용자 PC에 있을 수 있는 9단계 파일 모양 (250/250 + cameraRecovery)
  const stage9Text = JSON.stringify({ version: 1, settings: {
    ...presenceCriteria, presentHoldMs: 250, absentGraceMs: 250,
    cameraRecovery: { retryIntervalMs: 3500, firstFrameTimeoutMs: 5000, stallTimeoutMs: 3000, staffNoticeMs: 45000 },
  } }, null, 2);

  it('옛 키를 꺼내고, 그 키만 뺀 내용(다른 값은 그대로)을 돌려준다', () => {
    const { legacy, strippedText } = extractLegacyTiming(stage9Text);
    assert.deepEqual(Object.keys(legacy), LEGACY_PRESENCE_TIMING_KEYS);
    assert.equal(legacy.presentHoldMs, 250);
    assert.equal(legacy.cameraRecovery.staffNoticeMs, 45000);
    assert.equal(strippedText, serializePresenceSettings(presenceCriteria));
  });

  it('옛 키가 없거나 형식이 다르면 legacy null', () => {
    for (const text of [serializePresenceSettings(presenceCriteria), '{', 'null', JSON.stringify({ version: 2, settings: { presentHoldMs: 1 } }),
      JSON.stringify({ version: 1, settings: [1] })]) {
      assert.deepEqual(extractLegacyTiming(text), { legacy: null, strippedText: null }, text);
    }
  });

  it('옛 키 값을 시간 설정으로: 촬영 흐름은 기본값, 있는 키는 그 값(범위 검사), cameraRecovery가 없던 파일은 알리지 않고 기본값', () => {
    const { settings, issues } = timingFromLegacy(extractLegacyTiming(stage9Text).legacy, defaults);
    assert.deepEqual([settings.countdownSeconds, settings.resultMs, settings.cooldownMs, settings.presentHoldMs, settings.absentGraceMs],
      [3, 10000, 5000, 250, 250]);
    assert.equal(settings.cameraRecovery.retryIntervalMs, 3500);
    assert.equal(settings.cameraRecovery.staffNoticeMs, 45000);
    assert.deepEqual(issues, []);
    const before91 = timingFromLegacy({ presentHoldMs: 500, absentGraceMs: 5000 }, defaults);
    assert.deepEqual({ ...before91.settings.cameraRecovery }, { ...defaults.cameraRecovery });
    assert.deepEqual(before91.issues, ['absentGraceMs: 5000 -> 2000']);
  });

  it('인식 섹션 저장 내용에 옛 키를 다시 붙인다 (시간 파일에 아직 없을 때). 없으면 그대로', () => {
    const { legacy } = extractLegacyTiming(stage9Text);
    const text = withLegacyTiming(serializePresenceSettings({ ...presenceCriteria, minScore: 0.8 }), legacy);
    const parsed = JSON.parse(text);
    assert.equal(parsed.settings.minScore, 0.8);
    assert.deepEqual(extractLegacyTiming(text).legacy, legacy);
    const plain = serializePresenceSettings(presenceCriteria);
    assert.equal(withLegacyTiming(plain, null), plain);
  });
});
