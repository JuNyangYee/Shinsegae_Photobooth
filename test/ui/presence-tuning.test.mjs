// 실행: npm test
// 조절 화면(presence-tuning.js)의 저장·닫기 순서. DOM은 필요한 만큼만 흉내 낸다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createPresenceTuning } from '../src/web/js/presence-tuning.js';
import { SettingsSource } from '../src/web/js/settings-file.js';
import { flush } from './helpers.mjs';

const defaults = Object.freeze({
  region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }),
  minFaceHeight: 0.05, maxFaceHeight: 0.6, minScore: 0.7, presentHoldMs: 500, absentGraceMs: 1000,
});

function fakeElement() {
  const listeners = new Map();
  return {
    hidden: true, textContent: '', value: '', min: '', max: '', step: '', disabled: false,
    style: {}, dataset: {}, classList: { toggle() {} },
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
    fire: (type, event = {}) => listeners.get(type)?.(event),
    select() {},
  };
}

function setup() {
  globalThis.window ??= new EventTarget(); // region-drag가 끌기 동안 창 이벤트를 받는다
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  };
  const panel = { ...fakeElement(), querySelector: element };
  const layer = { ...fakeElement(), querySelector: element };
  const applied = []; // 감지 루프에 넣은 판정값 (실행 중인 값)
  const monitor = {
    setSettings: (settings) => applied.push(settings),
    getDebugSnapshot: () => ({ faces: [], present: false, progress: null, status: 'running' }),
  };
  const saves = [];
  const tuning = createPresenceTuning({
    stage: { getBoundingClientRect: () => ({ left: 0, top: 0, width: 1080, height: 1920 }) },
    panel, layer, monitor, defaults,
    initial: { settings: defaults, issues: [], source: SettingsSource.FILE, note: '' },
    // 저장 요청은 손으로 끝낸다
    saveSettings: (settings) => new Promise((resolve, reject) => saves.push({ settings, resolve, reject })),
  });
  const saveButton = { dataset: { action: 'save' }, disabled: false };
  return {
    tuning, saves, saveButton,
    running: () => applied.at(-1),
    message: () => element('[data-message]').textContent,
    slide(key, value) {
      const input = element(`input[data-key="${key}"]`);
      input.value = String(value);
      input.fire('input');
    },
    clickSave: () => panel.fire('click', { target: { closest: () => saveButton } }),
  };
}

let current = null;
afterEach(() => current?.tuning.close()); // 조절 화면의 갱신 타이머를 남기지 않는다

describe('presence-tuning: 저장 중 닫기 (4단계 검수 4)', () => {
  it('저장 중에 닫으면 저장이 끝난 뒤 닫고, 성공한 값이 판정에 남는다 (실행 값 = 파일 값)', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('minScore', 0.8);
    t.clickSave();
    assert.equal(t.saves.length, 1);
    assert.equal(t.saveButton.disabled, true);
    t.tuning.close(); // R·Esc·닫기
    assert.equal(t.tuning.isOpen(), true);
    assert.match(t.message(), /저장이 끝나면 닫습니다/);
    t.saves[0].resolve();
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().minScore, 0.8);
    assert.equal(t.tuning.describeSettingsSource(), 'saved');
  });

  it('저장이 실패하면 닫으면서 이전 파일 값으로 돌아간다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('minScore', 0.8);
    t.clickSave();
    t.tuning.close();
    t.saves[0].reject(new Error('HTTP 500'));
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().minScore, 0.7);
    assert.equal(t.tuning.describeSettingsSource(), 'file');
  });

  it('저장 중에 값을 더 바꾸고 닫으면, 닫힌 뒤 판정값은 저장된(파일) 값이다', async () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('minScore', 0.8);
    t.clickSave();
    t.slide('minScore', 0.9); // 저장 요청에는 0.8이 들어갔다
    t.tuning.close();
    assert.equal(t.running().minScore, 0.9); // 아직 열려 있고 조절 중인 값
    t.saves[0].resolve();
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.saves[0].settings.minScore, 0.8);
    assert.equal(t.running().minScore, 0.8);
  });

  it('저장 중이 아니면 바로 닫고 저장된 값으로 되돌린다 (기존 동작)', () => {
    const t = current = setup();
    t.tuning.toggle();
    t.slide('minScore', 0.85);
    t.tuning.close();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().minScore, 0.7);
  });
});
