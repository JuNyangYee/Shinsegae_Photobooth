// 실행: npm test
// 효과 조절 화면(effect-tuning.js, E)의 즉시 반영·저장·되돌리기·저장 중 닫기. R 화면과 같은 규칙. DOM은 필요한 만큼만 흉내 낸다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { normalizeEffectSettings } from '../../src/web/config/effect-settings.js';
import { SettingsSource } from '../../src/web/config/settings-file.js';
import { createEffectTuning } from '../../src/web/ui/effect-tuning.js';
import { flush } from '../helpers.mjs';

const defaults = config.effect;

function fakeElement() {
  const listeners = new Map();
  return {
    hidden: true, textContent: '', value: '', min: '', max: '', step: '', disabled: false,
    dataset: {}, classList: { toggle() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    fire: (type, event = {}) => listeners.get(type)?.(event),
  };
}

function setup({ initialSettings = normalizeEffectSettings(defaults, defaults).settings } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  };
  const panel = { ...fakeElement(), querySelector: element };
  const applied = []; // 미리보기에 넣은 값 (실행 중인 값)
  const preview = {
    setSettings: (settings) => applied.push(settings),
    getState: () => ({ status: 'running', width: 1080, height: 1920, drawingsPerSecond: 24, fps: 24, cpuAvgMs: 6.5, fault: '' }),
  };
  const saves = [];
  const opens = [];
  const tuning = createEffectTuning({
    panel, preview, defaults,
    initial: { settings: initialSettings, issues: [], source: SettingsSource.FILE, note: '' },
    saveSettings: (settings) => new Promise((resolve, reject) => saves.push({ settings, resolve, reject })),
    onOpenChange: (open) => opens.push(open),
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  const saveButton = { dataset: { action: 'save' }, disabled: false };
  const click = (action) => panel.fire('click', { target: { closest: () => (action === 'save' ? saveButton : { dataset: { action } }) } });
  return {
    tuning, saves, saveButton, opens, panel,
    running: () => applied.at(-1),
    message: () => element('[data-message]').textContent,
    output: (key) => element(`output[data-key="${key}"]`).textContent,
    input: (key) => element(`input[data-key="${key}"]`),
    select: (key) => element(`select[data-key="${key}"]`),
    choose(key, value) {
      const select = element(`select[data-key="${key}"]`);
      select.value = String(value);
      select.fire('change');
    },
    slide(key, value) {
      const input = element(`input[data-key="${key}"]`);
      input.value = String(value);
      input.fire('input');
    },
    click,
  };
}

let current = null;
afterEach(() => current?.tuning.close());

describe('effect-tuning (E)', () => {
  it('슬라이더 범위는 원본 갤러리와 같고, 움직이면 바로 미리보기에 반영된다', () => {
    const t = current = setup();
    assert.deepEqual([t.input('fps').min, t.input('fps').max, t.input('fps').step], ['2', '30', '1']);
    assert.deepEqual([t.input('strength').min, t.input('strength').max], ['0', '1.6']);
    assert.deepEqual([t.input('previewScale').min, t.input('previewScale').max], ['0.25', '1']);
    t.tuning.toggle();
    assert.equal(t.panel.hidden, false);
    t.slide('fps', 12);
    t.slide('refineThreshold', 0.3);
    assert.equal(t.running().fps, 12);
    assert.deepEqual(t.running().refine, [3.5, 3, 10, 0.6, 0.3]);
    assert.equal(t.output('fps'), '12');
  });

  it('저장하지 않고 닫으면 저장된 값으로 되돌린다', () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('boil', 0.5);
    assert.equal(t.running().boil, 0.5);
    t.tuning.close();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().boil, 0.1);
    assert.deepEqual(t.opens, [true, false]);
  });

  it('저장하면 그 값이 남고 출처가 saved', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('strength', 0.4);
    t.click('save');
    assert.equal(t.saves[0].settings.strength, 0.4);
    t.saves[0].resolve();
    await flush();
    assert.equal(t.message(), '파일에 저장했습니다.');
    t.tuning.close();
    assert.equal(t.running().strength, 0.4);
    assert.equal(t.tuning.describeSettingsSource(), 'saved');
  });

  it('저장 중에 닫으면 저장이 끝난 뒤 닫는다. 실패하면 이전 파일 값으로 돌아간다 (4-5 규칙)', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('size', 1.5);
    t.click('save');
    assert.equal(t.saveButton.disabled, true);
    t.tuning.close();
    assert.equal(t.tuning.isOpen(), true);
    assert.match(t.message(), /저장이 끝나면 닫습니다/);
    t.saves[0].reject(new Error('HTTP 500'));
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().size, 1.25);
    assert.equal(t.tuning.describeSettingsSource(), 'file');
  });

  it('저장 중에 값을 더 바꾸고 닫으면, 닫힌 뒤 값은 저장된 값이다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('grade', 0.5);
    t.click('save');
    t.slide('grade', 0.2);
    t.tuning.close();
    t.saves[0].resolve();
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().grade, 0.5);
  });

  it('취소는 저장된 값, 기본값은 config.effect 값 (저장 전까지 dirty)', () => {
    const t = current = setup({ initialSettings: normalizeEffectSettings({ ...defaults, fps: 10 }, defaults).settings });
    t.tuning.toggle();
    assert.equal(t.running().fps, 10);
    t.click('defaults');
    assert.equal(t.running().fps, 24);
    assert.match(t.tuning.describeSettingsSource(), /unsaved changes/);
    t.click('revert');
    assert.equal(t.running().fps, 10);
    assert.equal(t.tuning.describeSettingsSource(), 'file');
  });

  it('출력 단계 (6-1): 모드·점 방식·용지 폭은 선택 상자, 밝기·대비·감마는 슬라이더로 바로 반영, 저장에 들어간다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    assert.equal(t.select('outputMode').value, 'thermal', '기본값은 감열지');
    assert.equal(t.select('paperDots').value, '576');
    assert.deepEqual([t.input('gamma').min, t.input('gamma').max, t.input('brightness').min], ['0.4', '2.5', '-0.5']);
    t.choose('dither', 'atkinson');
    t.choose('paperDots', 384);
    t.slide('gamma', 1.6);
    t.slide('contrast', 1.25);
    assert.deepEqual([t.running().dither, t.running().paperDots, t.running().gamma, t.running().contrast], ['atkinson', 384, 1.6, 1.25]);
    assert.equal(t.output('paperDots'), '384점');
    // 회색조: 점 방식·용지 폭은 쓰지 않아 막고, 레벨은 그대로 쓴다. 끔(컬러): 레벨도 막는다
    t.choose('outputMode', 'gray');
    assert.equal(t.running().outputMode, 'gray');
    assert.deepEqual([t.select('dither').disabled, t.select('paperDots').disabled, t.input('gamma').disabled], [true, true, false]);
    t.choose('outputMode', 'off');
    assert.deepEqual([t.input('gamma').disabled, t.input('brightness').disabled, t.input('fps').disabled], [true, true, false]);
    t.choose('outputMode', 'thermal');
    assert.equal(t.select('dither').disabled, false);
    t.click('save');
    const saved = t.saves[0].settings;
    assert.deepEqual([saved.outputMode, saved.dither, saved.paperDots, saved.gamma], ['thermal', 'atkinson', 384, 1.6]);
    t.saves[0].resolve();
    await flush();
    t.tuning.close();
    assert.equal(t.running().dither, 'atkinson');
  });
});
