// 실행: npm test
// 운영자 조절 화면의 시간 섹션 (10단계, timing-tuning.js): 즉시 반영(applySettings), 초 표시, 섹션 단위 저장·되돌리기·기본값,
// 옮기지 못한 옛 값의 "저장 필요" 표시, 실시간 줄. DOM은 필요한 만큼만 흉내 낸다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { normalizeTimingSettings, sameTimingSettings } from '../../src/web/config/timing-settings.js';
import { SettingsSource } from '../../src/web/config/settings-file.js';
import { createTimingTuning } from '../../src/web/ui/timing-tuning.js';
import { flush } from '../helpers.mjs';

const defaults = config.timing;
const base = normalizeTimingSettings(defaults, defaults).settings;

function fakeElement() {
  const listeners = new Map();
  return {
    hidden: true, textContent: '', value: '', min: '', max: '', step: '', disabled: false, dataset: {},
    classList: { toggle() {} },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, event = {}) => listeners.get(type)?.(event),
  };
}

function setup({ loaded = {}, sessionState = 'idle' } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  };
  const panel = { ...fakeElement(), querySelector: element };
  const applied = [];
  const saves = [];
  const opens = [];
  const session = { state: sessionState };
  const intervals = [];
  const tuning = createTimingTuning({
    panel,
    session: { getState: () => session },
    defaults,
    initial: { settings: base, issues: [], source: SettingsSource.FILE, note: '', ...loaded },
    applySettings: (s) => applied.push(s),
    saveSettings: (settings) => new Promise((resolve, reject) => saves.push({ settings, resolve, reject })),
    onOpenChange: (open) => opens.push(open),
    timers: { setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {} },
  });
  const click = (action) => panel.fire('click', { target: { closest: () => ({ dataset: { action }, disabled: false }) } });
  return {
    tuning, panel, element, applied, saves, opens, click, session,
    running: () => applied.at(-1),
    slide(key, value) { const i = element(`input[data-key="${key}"]`); i.value = String(value); i.fire('input'); },
    output: (key) => element(`output[data-key="${key}"]`).textContent,
    message: () => element('[data-message]').textContent,
  };
}

let current = null;
afterEach(() => current?.tuning.close());

describe('timing-tuning: 항목·표시', () => {
  it('만들 때 불러온 값을 바로 넣는다 (main.js applyTimingSettings)', () => {
    const t = current = setup();
    assert.equal(t.applied.length, 1);
    assert.equal(sameTimingSettings(t.running(), base), true);
  });

  it('슬라이더 범위는 timingLimits, 초로 보인다 (카운트다운 정수, 결과 정수, 쿨타임 0.1, 반응 0.01, 회복 0.1·직원 문의 정수)', () => {
    const t = current = setup();
    const range = (key) => { const i = t.element(`input[data-key="${key}"]`); return [i.min, i.max, i.step, i.value]; };
    assert.deepEqual(range('countdownSeconds'), ['1', '10', '1', '3']);
    assert.deepEqual(range('resultMs'), ['3000', '60000', '1000', '10000']);
    assert.deepEqual(range('cooldownMs'), ['0', '30000', '500', '5000']);
    assert.deepEqual(range('presentHoldMs'), ['0', '2000', '50', '250']);
    assert.deepEqual(range('absentGraceMs'), ['0', '2000', '50', '250']);
    assert.deepEqual(range('retryIntervalMs'), ['1000', '30000', '500', '3000']);
    assert.deepEqual(range('stallTimeoutMs'), ['1000', '10000', '500', '3000']);
    assert.deepEqual(range('staffNoticeMs'), ['5000', '300000', '1000', '30000']);
    assert.deepEqual(['countdownSeconds', 'resultMs', 'cooldownMs', 'presentHoldMs', 'absentGraceMs', 'retryIntervalMs', 'firstFrameTimeoutMs',
      'stallTimeoutMs', 'staffNoticeMs'].map(t.output), ['3', '10', '5.0', '0.25', '0.25', '3.0', '5.0', '3.0', '30']);
  });
});

describe('timing-tuning: 즉시 반영', () => {
  it('촬영 흐름·반응·회복 슬라이더를 움직이면 바로 applySettings(정규화된 설정)로', () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('countdownSeconds', 5);
    t.slide('resultMs', 15000);
    t.slide('cooldownMs', 2500);
    t.slide('absentGraceMs', 100);
    t.slide('retryIntervalMs', 5500);
    const r = t.running();
    assert.deepEqual([r.countdownSeconds, r.resultMs, r.cooldownMs, r.absentGraceMs, r.presentHoldMs], [5, 15000, 2500, 100, 250]);
    assert.deepEqual({ ...r.cameraRecovery }, { ...defaults.cameraRecovery, retryIntervalMs: 5500 });
    assert.deepEqual([t.output('countdownSeconds'), t.output('resultMs'), t.output('cooldownMs'), t.output('absentGraceMs'), t.output('retryIntervalMs')],
      ['5', '15', '2.5', '0.10', '5.5']);
    assert.equal(t.panel.dataset.save, 'dirty');
  });

  it('범위 밖 값(직접 넣은 값)도 정규화해서 넣는다', () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('countdownSeconds', 0);
    t.slide('stallTimeoutMs', 200);
    assert.equal(t.running().countdownSeconds, 1);
    assert.equal(t.running().cameraRecovery.stallTimeoutMs, 1000);
  });

  it('실시간 줄: 대기면 "다음 회차부터·바로 적용", 진행 중이면 그 단계와 "다음 회차부터 적용"', () => {
    const t = current = setup({ sessionState: 'result' });
    t.tuning.open();
    t.tuning.setActive(true);
    assert.match(t.element('[data-live]').textContent, /^결과 표시 중 · 바꾼 카운트다운·결과·쿨타임은 다음 회차부터 적용/);
    t.session.state = 'idle';
    t.tuning.setActive(false);
    t.tuning.setActive(true);
    assert.match(t.element('[data-live]').textContent, /^대기 · .*인식 반응·카메라 회복은 바로 적용/);
  });
});

describe('timing-tuning: 저장·되돌리기·기본값 (섹션 하나 = timing.local.json)', () => {
  it('저장하면 누른 순간의 값을 쓰고 saved, 닫아도 그 값이 남는다', async () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('resultMs', 20000);
    t.click('save');
    assert.equal(t.saves[0].settings.resultMs, 20000);
    assert.equal(t.panel.dataset.save, 'saving');
    t.saves[0].resolve();
    await flush();
    assert.equal(t.panel.dataset.save, 'saved');
    assert.equal(t.tuning.describeSettingsSource(), 'saved');
    assert.equal(t.tuning.isStoredInFile(), true);
    t.tuning.close();
    assert.equal(t.running().resultMs, 20000);
  });

  it('저장하지 않고 닫으면 저장된 값으로 되돌린다 (실행 중인 값 = 다시 시작했을 때의 값)', () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('countdownSeconds', 7);
    t.tuning.close();
    assert.equal(t.running().countdownSeconds, 3);
    assert.equal(t.tuning.isDirty(), false);
  });

  it('저장 중에 닫으면 저장이 끝난 뒤 닫고, 실패하면 이전 파일 값으로 돌아간다', async () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('cooldownMs', 1000);
    t.click('save');
    t.tuning.close();
    assert.equal(t.tuning.isOpen(), true);
    assert.match(t.message(), /저장이 끝나면 닫습니다/);
    t.saves[0].reject(new Error('HTTP 500'));
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().cooldownMs, 5000);
    assert.deepEqual(t.opens, [true, false]);
  });

  it('"기본값으로"는 이 섹션의 값만, 취소는 저장된 값으로, discardUnsaved는 저장하지 않은 변경만', () => {
    const stored = { ...base, countdownSeconds: 5, presentHoldMs: 500, cameraRecovery: { ...base.cameraRecovery, staffNoticeMs: 60000 } };
    const t = current = setup({ loaded: { settings: stored } });
    t.tuning.open();
    t.click('defaults');
    assert.equal(sameTimingSettings(t.running(), base), true);
    assert.match(t.message(), /시간 기본값을 적용했습니다/);
    t.click('revert');
    assert.equal(sameTimingSettings(t.running(), stored), true);
    t.slide('countdownSeconds', 9);
    t.tuning.discardUnsaved();
    assert.deepEqual([t.tuning.isDirty(), t.running().countdownSeconds], [false, 5]);
  });
});

describe('timing-tuning: 불러온 결과 표시', () => {
  it('옛 인식 파일 값을 옮기지 못함(presence file): "파일 값을 고쳐 사용 · 저장 필요" + 열 때 안내, 저장하면 saved', async () => {
    const note = 'presentHoldMs, absentGraceMs, cameraRecovery from presence file; migration to timing file failed: HTTP 500';
    const t = current = setup({ loaded: { source: SettingsSource.PRESENCE_FILE_ONLY, note } });
    assert.equal(t.panel.dataset.save, 'adjusted');
    assert.equal(t.element('[data-state]').textContent, '파일 값을 고쳐 사용 · 저장 필요');
    assert.equal(t.tuning.isStoredInFile(), false);
    t.tuning.open();
    assert.match(t.message(), /예전 인식 파일의 시간 값을 시간 파일로 옮기지 못했습니다/);
    assert.match(t.tuning.describeSettingsSource(), /^presence file \(.*HTTP 500\)$/);
    t.click('save');
    t.saves[0].resolve();
    await flush();
    assert.equal(t.panel.dataset.save, 'saved');
    assert.equal(t.tuning.isStoredInFile(), true);
  });

  it('출처별: 파일·옮김 = saved(파일에 있음), 파일 없음 = defaults, 읽기 실패 = load-failed, 고쳐 씀 = adjusted', () => {
    const cases = [
      [{ source: SettingsSource.FILE }, 'saved', true],
      [{ source: SettingsSource.MIGRATED, note: 'presentHoldMs from presence file (removed from presence file)' }, 'saved', true],
      [{ source: SettingsSource.DEFAULTS, note: 'no file' }, 'defaults', false],
      [{ source: SettingsSource.DEFAULTS, note: 'file read failed: timeout 3000ms' }, 'load-failed', false],
      [{ source: SettingsSource.FILE, issues: ['countdownSeconds: 30 -> 10'] }, 'adjusted', true],
    ];
    for (const [loaded, state, stored] of cases) {
      const t = setup({ loaded });
      assert.equal(t.panel.dataset.save, state, JSON.stringify(loaded));
      assert.equal(t.tuning.isStoredInFile(), stored, JSON.stringify(loaded));
    }
  });
});
