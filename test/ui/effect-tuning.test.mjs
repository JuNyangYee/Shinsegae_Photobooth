// 실행: npm test
// 효과 조절 화면(effect-tuning.js, E)의 즉시 반영·저장·되돌리기·저장 중 닫기. 인식 섹션과 같은 규칙. DOM은 필요한 만큼만 흉내 낸다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { normalizeEffectSettings } from '../../src/web/config/effect-settings.js';
import { SettingsSource } from '../../src/web/config/settings-file.js';
import { createEffectTuning, describeComboKo, isUnusedTunable } from '../../src/web/ui/effect-tuning.js';
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

function setup({ initialSettings = normalizeEffectSettings(defaults, defaults).settings, loaded = {} } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  };
  const comboButtons = [[false, false], [false, true], [true, false], [true, true]].map(([oil, mono]) => ({
    dataset: { action: 'combo', oil: String(oil), mono: String(mono) }, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const panel = { ...fakeElement(), querySelector: element, querySelectorAll: () => comboButtons };
  const applied = []; // 미리보기에 넣은 값 (실행 중인 값)
  const preview = {
    setSettings: (settings) => applied.push(settings),
    getState: () => ({ status: 'running', width: 1080, height: 1920, drawingsPerSecond: 24, fps: 24, cpuAvgMs: 6.5, fault: '' }),
  };
  const saves = [];
  const opens = [];
  const tuning = createEffectTuning({
    panel, preview, defaults,
    initial: { settings: initialSettings, issues: [], source: SettingsSource.FILE, note: '', ...loaded },
    saveSettings: (settings) => new Promise((resolve, reject) => saves.push({ settings, resolve, reject })),
    onOpenChange: (open) => opens.push(open),
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  const saveButton = { dataset: { action: 'save' }, disabled: false };
  const click = (action) => panel.fire('click', { target: { closest: () => (action === 'save' ? saveButton : { dataset: { action } }) } });
  const pressCombo = (oil, mono) => {
    const button = comboButtons.find((b) => b.dataset.oil === String(oil) && b.dataset.mono === String(mono));
    panel.fire('click', { target: { closest: () => button } });
  };
  const flip = (key, checked) => {
    const input = element(`input[data-key="${key}"]`);
    input.checked = checked;
    input.fire('change');
  };
  return {
    tuning, saves, saveButton, opens, panel, comboButtons, pressCombo, flip,
    comboInfo: () => element('[data-combo-info]').textContent,
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
    assert.equal(t.tuning.isOpen(), true); // 패널 표시는 operator-panel.js가 한다 (9-2)
    t.slide('fps', 18);
    t.slide('refineThreshold', 0.4);
    assert.equal(t.running().fps, 18);
    assert.deepEqual(t.running().refine, [3.5, 3, 10, 0.6, 0.4]);
    assert.equal(t.output('fps'), '18');
  });

  it('저장하지 않고 닫으면 저장된 값으로 되돌린다', () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('boil', 0.5);
    assert.equal(t.running().boil, 0.5);
    t.tuning.close();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().boil, 0.05);
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
    assert.equal(t.running().size, 1.3);
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
    assert.equal(t.running().fps, 12);
    assert.match(t.tuning.describeSettingsSource(), /unsaved changes/);
    t.click('revert');
    assert.equal(t.running().fps, 10);
    assert.equal(t.tuning.describeSettingsSource(), 'file');
  });

  it('좌우 반전은 E에 없다 (9-1에 카메라 설정으로 옮김, 운영자 화면은 9-2): 저장 값에도 mirror가 없다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('fps', 18);
    t.click('save');
    assert.ok(!('mirror' in t.saves[0].settings));
    t.saves[0].resolve();
    await flush();
    assert.ok(!('mirror' in t.running()));
  });

  it('출력 단계 (6-1): 모드·점 방식·용지 폭은 선택 상자, 밝기·대비·감마는 슬라이더로 바로 반영, 저장에 들어간다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    assert.equal(t.select('outputMode').value, 'gray-oil', '기본값은 회색조 유화 (8단계)');
    assert.equal(t.select('paperDots').value, '576');
    // 회색조 유화: 점 방식·용지 폭은 결과의 인쇄 데이터에 쓰여 열고, 흑백 스타일 항목은 막는다. 레벨은 쓴다
    assert.deepEqual([t.select('dither').disabled, t.select('paperDots').disabled, t.input('gamma').disabled], [false, false, false]);
    assert.deepEqual([t.select('bwStyle').disabled, t.input('bwTexture').disabled, t.input('lineSpacing').disabled], [true, true, true]);
    t.choose('outputMode', 'thermal');
    assert.deepEqual([t.input('gamma').min, t.input('gamma').max, t.input('brightness').min], ['0.4', '2.5', '-0.5']);
    t.choose('bwStyle', 'tone'); // 점 방식은 톤 점·질감 강조 점에서 쓴다 (7-1)
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

  it('흑백 스타일 (7-1): 스타일 선택 상자, 질감 세기·선 간격 슬라이더. 스타일·모드에 따라 쓰지 않는 항목을 막고 저장에 들어간다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    assert.equal(t.select('bwStyle').value, 'stroke', '감열지를 고를 때의 기본값 (7-1 사용자 결정)');
    t.choose('outputMode', 'thermal'); // 흑백 스타일은 감열지에서만 쓴다 (8단계부터 기본 모드는 회색조 유화)
    assert.deepEqual([t.input('lineSpacing').min, t.input('lineSpacing').max, t.input('bwTexture').max], ['2', '8', '2']);
    assert.equal(t.output('lineSpacing'), '4.0');
    // 붓 결 선·흐름 선: 점 방식은 쓰지 않는다
    assert.deepEqual([t.select('dither').disabled, t.input('lineSpacing').disabled, t.input('bwTexture').disabled], [true, false, false]);
    t.choose('bwStyle', 'texture');
    assert.deepEqual([t.select('dither').disabled, t.input('lineSpacing').disabled, t.input('bwTexture').disabled], [false, true, false]);
    // 톤 점 (14단계): 질감 세기는 유화 획을 섞는 세기, 블루 노이즈면 붓 결 주기로 선 간격도 쓴다
    t.choose('bwStyle', 'tone');
    assert.equal(t.select('dither').value, 'blue-noise');
    assert.deepEqual([t.select('dither').disabled, t.input('lineSpacing').disabled, t.input('bwTexture').disabled], [false, false, false]);
    t.choose('dither', 'bayer');
    assert.deepEqual([t.select('dither').disabled, t.input('lineSpacing').disabled, t.input('bwTexture').disabled], [false, true, false]);
    t.choose('dither', 'blue-noise');
    t.choose('bwStyle', 'flow');
    t.slide('lineSpacing', 6);
    t.slide('bwTexture', 1.5);
    assert.deepEqual([t.running().bwStyle, t.running().lineSpacing, t.running().bwTexture], ['flow', 6, 1.5]);
    t.choose('outputMode', 'gray');
    assert.deepEqual([t.select('bwStyle').disabled, t.input('lineSpacing').disabled, t.input('bwTexture').disabled], [true, true, true]);
    t.choose('outputMode', 'gray-oil');
    assert.deepEqual([t.select('bwStyle').disabled, t.input('lineSpacing').disabled, t.select('dither').disabled], [true, true, false],
      '회색조 유화는 선 스타일이 골라져 있어도 점 방식을 쓴다(인쇄 데이터)');
    t.choose('outputMode', 'thermal');
    t.click('save');
    const saved = t.saves[0].settings;
    assert.deepEqual([saved.bwStyle, saved.lineSpacing, saved.bwTexture], ['flow', 6, 1.5]);
    t.saves[0].resolve();
    await flush();
  });
});

describe('effect-tuning: 저장 상태 표시 (6-3)', () => {
  it('저장 실패는 다시 저장해 성공하거나 값을 바꿀 때까지 실패로 보인다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('fps', 18);
    assert.equal(t.panel.dataset.save, 'dirty');
    t.click('save');
    assert.equal(t.panel.dataset.save, 'saving');
    t.saves[0].reject(new Error('HTTP 500'));
    await flush();
    assert.equal(t.panel.dataset.save, 'failed');
    t.click('save');
    t.saves[1].resolve();
    await flush();
    assert.equal(t.panel.dataset.save, 'saved');
  });
});

describe('effect-tuning: 불러온 결과에 따른 저장 상태 (6단계 검수 1)', () => {
  for (const [loaded, expected] of [
    [{ source: SettingsSource.DEFAULTS, note: 'no file' }, 'defaults'],
    [{ source: SettingsSource.DEFAULTS, note: 'file read failed: timeout 3000ms' }, 'load-failed'],
    [{ source: SettingsSource.FILE, issues: ['outputMode: missing -> default'] }, 'adjusted'],
    [{ source: SettingsSource.FILE }, 'saved'],
  ]) {
    it(`${loaded.source} ${loaded.note ?? ''}${loaded.issues ? ' + issues' : ''} → ${expected}, 저장에 성공하면 saved`, async () => {
      const t = current = setup({ loaded });
      t.tuning.toggle();
      assert.equal(t.panel.dataset.save, expected);
      t.slide('fps', 18);
      assert.equal(t.panel.dataset.save, 'dirty');
      t.slide('fps', 12); // 불러온 값으로 돌아오면 다시 불러온 상태
      assert.equal(t.panel.dataset.save, expected);
      t.click('save');
      t.saves[0].resolve();
      await flush();
      assert.equal(t.panel.dataset.save, 'saved');
    });
  }
});

describe('effect-tuning: 패널이 닫히는 순간 되돌리기 (9단계 검수 1)', () => {
  it('discardUnsaved: 저장하지 않은 변경을 저장된 값으로', () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('boil', 0.5);
    assert.equal(t.tuning.isDirty(), true);
    t.tuning.discardUnsaved();
    assert.deepEqual([t.tuning.isDirty(), t.running().boil], [false, 0.05]);
  });
});

describe('effect-tuning 시험 조합 (WISHFUL 시안)', () => {
  // 현장 저장값과 같은 내용 (유화 켬, 흑백 gray)
  const site = normalizeEffectSettings({
    ...defaults, strength: 0.05, size: 0.7, boil: 0, fps: 12, refine: [3.5, 3, 10, 0.6, 0.09], previewScale: 1, outputMode: 'gray',
    brightness: 0.03, contrast: 1.4, gamma: 1.2,
  }, defaults).settings;

  it('네 조합 버튼·스위치가 바로 미리보기에 들어가고, 유화 수치·레벨은 그대로이며 눌린 버튼이 표시된다', () => {
    const t = current = setup({ initialSettings: site });
    t.tuning.toggle();
    assert.equal(t.input('oil').checked, true);
    assert.equal(t.input('mono').checked, true);
    assert.deepEqual(t.comboButtons.map((b) => b.attributes['aria-pressed']), ['false', 'false', 'false', 'true']);
    for (const [oil, mono] of [[false, false], [false, true], [true, false], [true, true]]) {
      t.pressCombo(oil, mono);
      const r = t.running();
      assert.deepEqual([r.oil, r.outputMode, r.monoMode], [oil, mono ? 'gray' : 'off', 'gray'], `${oil} ${mono}`);
      assert.deepEqual([r.strength, r.size, r.boil, r.fps, r.refine[4], r.previewScale, r.brightness, r.contrast, r.gamma],
        [0.05, 0.7, 0, 12, 0.09, 1, 0.03, 1.4, 1.2]);
      assert.equal(t.output('oil'), oil ? '켬' : '끔');
      assert.equal(t.comboButtons.filter((b) => b.attributes['aria-pressed'] === 'true').length, 1);
    }
  });

  it('유화를 끄면 유화 수치·흑백 스타일 슬라이더를 막고(값은 그대로), 다시 켜면 풀린다', () => {
    const t = current = setup({ initialSettings: site });
    t.tuning.toggle();
    t.flip('oil', false);
    assert.equal(t.running().oil, false);
    for (const key of ['strength', 'size', 'boil', 'grade', 'refineThreshold', 'fps']) {
      assert.equal(t.input(key).disabled, true, key);
    }
    assert.equal(t.output('strength'), '0.05', '값은 보인다');
    assert.equal(t.input('brightness').disabled, false, '레벨은 흑백에 계속 쓴다');
    t.flip('oil', true);
    assert.equal(t.input('strength').disabled, false);
    assert.equal(t.running().strength, 0.05);
  });

  it('흑백 스위치를 끄면 컬러(off), 다시 켜면 그 전 흑백 방식. 저장하지 않고 닫으면 저장된 조합으로 되돌린다', () => {
    const t = current = setup({ initialSettings: site });
    t.tuning.toggle();
    t.flip('mono', false);
    assert.deepEqual([t.running().outputMode, t.running().monoMode], ['off', 'gray']);
    assert.match(t.comboInfo(), /화면 시험용 컬러\. 인쇄 데이터를 만들지 않는다/);
    t.flip('mono', true);
    assert.equal(t.running().outputMode, 'gray');
    t.pressCombo(false, false);
    t.tuning.close();
    assert.deepEqual([t.running().oil, t.running().outputMode], [true, 'gray'], '저장 안 한 조합은 닫으면 취소');
  });

  it('조합을 저장하면 파일 값에 oil·monoMode가 들어가고, 취소는 저장된 조합·기본값은 유화 흑백(회색조 유화)', async () => {
    const t = current = setup({ initialSettings: site });
    t.tuning.toggle();
    t.pressCombo(false, true);
    t.click('save');
    assert.deepEqual([t.saves[0].settings.oil, t.saves[0].settings.outputMode], [false, 'gray']);
    t.saves[0].resolve();
    await flush();
    t.pressCombo(true, false);
    t.click('revert');
    assert.deepEqual([t.running().oil, t.running().outputMode], [false, 'gray']);
    t.click('defaults');
    assert.deepEqual([t.running().oil, t.running().outputMode, t.running().strength], [true, 'gray-oil', 0.3]);
  });

  it('안내 문구: 인쇄 데이터는 회색조 유화·감열지만 만든다', () => {
    const v = (over) => normalizeEffectSettings({ ...defaults, ...over }, defaults).settings;
    assert.match(describeComboKo(v({})), /^유화 · 흑백 \(입력 흑백 \+ 인쇄 데이터\) — 촬영 때 인쇄 데이터/);
    assert.match(describeComboKo(v({ oil: false, outputMode: 'thermal' })), /^원본 · 흑백 \(감열지 1비트 점\)/);
    assert.match(describeComboKo(v({ outputMode: 'gray' })), /인쇄 데이터 없음/);
    assert.match(describeComboKo(v({ outputMode: 'off', monoMode: 'gray' })), /^유화 · 컬러 — 화면 시험용 컬러.*흑백을 켜면 회색조\)$/);
    // 유화 끔 감열지: 붓 결 선이 저장돼 있어도 점 방식은 쓴다 (톤 점)
    assert.equal(isUnusedTunable('dither', v({ oil: false, outputMode: 'thermal', bwStyle: 'stroke' })), false);
    assert.equal(isUnusedTunable('dither', v({ oil: true, outputMode: 'thermal', bwStyle: 'stroke' })), true);
  });
});
