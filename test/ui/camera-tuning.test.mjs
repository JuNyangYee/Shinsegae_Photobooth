// 실행: npm test
// 운영자 조절 화면의 카메라 섹션 (9-2, camera-tuning.js): 즉시 반영(applySettings), 장치 목록, 회전 버튼, 섹션 단위 저장·되돌리기·기본값,
// 받은 크기·지원 범위·OBS 안내 줄. DOM은 필요한 만큼만 흉내 낸다.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import { normalizeCameraSettings } from '../../src/web/config/camera-settings.js';
import { SettingsSource } from '../../src/web/config/settings-file.js';
import { createCameraTuning, describeCameraInfo } from '../../src/web/ui/camera-tuning.js';
import { flush } from '../helpers.mjs';

const defaults = config.camera;
const base = normalizeCameraSettings(defaults, defaults).settings;

function fakeElement() {
  const listeners = new Map();
  const el = {
    hidden: true, textContent: '', value: '', min: '', max: '', step: '', disabled: false, dataset: {},
    classList: { toggle() {} },
    options: [],
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, event = {}) => listeners.get(type)?.(event),
    replaceChildren(...nodes) { el.options = [...nodes]; },
    append(node) { el.options.push(node); },
    ownerDocument: { createElement: () => ({ value: '', textContent: '' }) },
  };
  return el;
}

function setup({ loaded = {}, state = {}, devices = ['OBS Virtual Camera', 'USB Cam'] } = {}) {
  const elements = new Map();
  const element = (selector) => {
    if (!elements.has(selector)) elements.set(selector, fakeElement());
    return elements.get(selector);
  };
  element('select[data-key="deviceLabel"]').options = [{ value: '', textContent: '자동' }];
  const panel = { ...fakeElement(), querySelector: element };
  const applied = [];
  const saves = [];
  const opens = [];
  const cameraState = { status: 'ready', label: 'OBS Virtual Camera', selection: 'preferred', capabilities: null, ...state };
  const tuning = createCameraTuning({
    panel,
    camera: { getState: () => cameraState, listDevices: async () => devices.map((label, i) => ({ label, deviceId: String(i) })) },
    frame: { getView: () => ({ zoom: 1, autoZoom: false }) },
    video: { videoWidth: 1080, videoHeight: 1920 },
    defaults,
    initial: { settings: base, issues: [], source: SettingsSource.FILE, note: '', ...loaded },
    applySettings: (s) => applied.push(s),
    saveSettings: (settings) => new Promise((resolve, reject) => saves.push({ settings, resolve, reject })),
    onOpenChange: (open) => opens.push(open),
    timers: { setInterval: () => 1, clearInterval: () => {} },
  });
  const click = (action) => panel.fire('click', { target: { closest: () => ({ dataset: { action }, disabled: false }) } });
  return {
    tuning, panel, element, applied, saves, opens, click,
    running: () => applied.at(-1),
    slide(key, value) { const i = element(`input[data-key="${key}"]`); i.value = String(value); i.fire('input'); },
    choose(key, value) { const s = element(`select[data-key="${key}"]`); s.value = String(value); s.fire('change'); },
    message: () => element('[data-message]').textContent,
  };
}

let current = null;
afterEach(() => current?.tuning.close());

describe('camera-tuning: 즉시 반영', () => {
  it('슬라이더 범위는 cameraLimits, 움직이면 바로 applySettings(정규화된 설정)로', () => {
    const t = current = setup();
    const zoom = t.element('input[data-key="zoom"]');
    assert.deepEqual([zoom.min, zoom.max, zoom.step], ['1', '4', '0.01']);
    t.tuning.open();
    t.slide('zoom', 1.5);
    t.slide('brightness', 0.12);
    assert.deepEqual([t.running().zoom, t.running().brightness], [1.5, 0.12]);
    assert.equal(t.element('output[data-key="zoom"]').textContent, '1.50');
    assert.equal(t.panel.dataset.save, 'dirty');
  });

  it('반전·해상도·장치 선택 상자도 바로 반영 (해상도·장치는 "다시 엽니다")', async () => {
    const t = current = setup();
    t.tuning.open();
    await flush();
    t.choose('mirror', 'false');
    assert.equal(t.running().mirror, false);
    t.choose('resolution', '1920x1080');
    assert.equal(t.running().resolution, '1920x1080');
    assert.match(t.message(), /다시 엽니다/);
    t.choose('deviceLabel', 'USB Cam');
    assert.equal(t.running().deviceLabel, 'USB Cam');
  });

  it('회전 버튼은 90° 단위로 돌고(시계·반시계), 자동 해상도면 다시 연다고 알린다', () => {
    const t = current = setup();
    t.tuning.open();
    t.click('rotate-right');
    assert.equal(t.running().rotation, 90);
    assert.match(t.message(), /다시 엽니다/);
    t.click('rotate-left');
    t.click('rotate-left');
    assert.equal(t.running().rotation, 270);
    assert.equal(t.element('output[data-key="rotation"]').textContent, '270');
  });
});

describe('camera-tuning: 장치 목록', () => {
  it('열면 장치 라벨을 읽어 "자동" 뒤에 넣고, 저장된 라벨이 목록에 없으면 "(연결 안 됨)"으로 남긴다', async () => {
    const t = current = setup({ loaded: { settings: { ...base, deviceLabel: 'Old Cam' } } });
    t.tuning.open();
    await flush();
    const options = t.element('select[data-key="deviceLabel"]').options;
    assert.deepEqual(options.map((o) => o.value), ['', 'OBS Virtual Camera', 'USB Cam', 'Old Cam']);
    assert.equal(options.at(-1).textContent, 'Old Cam (연결 안 됨)');
    assert.equal(t.element('select[data-key="deviceLabel"]').value, 'Old Cam');
  });
});

describe('camera-tuning: 섹션 단위 저장 규칙', () => {
  it('저장하지 않고 닫으면 저장된 값으로 되돌려 다시 적용한다', () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('panX', 0.1);
    t.tuning.close();
    assert.equal(t.running().panX, 0);
    assert.deepEqual(t.opens, [true, false]);
  });

  it('저장 → 파일 값, 저장 중 닫기는 끝난 뒤 닫는다', async () => {
    const t = current = setup();
    t.tuning.open();
    t.slide('contrast', 1.2);
    t.click('save');
    assert.equal(t.panel.dataset.save, 'saving');
    t.tuning.close();
    assert.equal(t.tuning.isOpen(), true);
    assert.match(t.message(), /저장이 끝나면 닫습니다/);
    t.saves[0].resolve();
    await flush();
    assert.equal(t.tuning.isOpen(), false);
    assert.equal(t.running().contrast, 1.2, '저장된 값이 남는다');
    assert.equal(t.tuning.describeSettingsSource(), 'saved');
  });

  it('"기본값으로"는 카메라 값만 기본값으로, "취소"는 저장된 값으로', () => {
    const saved = normalizeCameraSettings({ ...base, rotation: 90, zoom: 2, mirror: false }, defaults).settings;
    const t = current = setup({ loaded: { settings: saved } });
    t.tuning.open();
    t.click('defaults');
    assert.deepEqual({ ...t.running() }, { ...base });
    assert.match(t.message(), /카메라 기본값/);
    t.click('revert');
    assert.deepEqual([t.running().rotation, t.running().zoom, t.running().mirror], [90, 2, false]);
  });

  it('D 출처: file, + unsaved changes, defaults (no file)', () => {
    const t = current = setup();
    t.tuning.open();
    assert.equal(t.tuning.describeSettingsSource(), 'file');
    t.slide('tint', 0.2);
    assert.equal(t.tuning.describeSettingsSource(), 'file + unsaved changes');
    const d = setup({ loaded: { source: SettingsSource.DEFAULTS, note: 'no file' } });
    assert.equal(d.tuning.describeSettingsSource(), 'defaults (no file)');
  });
});

describe('describeCameraInfo: 받은 크기·지원 범위·OBS 안내', () => {
  const caps = { width: { min: 1, max: 1080 }, height: { min: 1, max: 1920 } };
  it('OBS 가상카메라면 자동 권장, 요청 프리셋과 받은 크기가 다르면 알리고 비율이 다르면 "잘림"', () => {
    const state = { status: 'ready', label: 'OBS Virtual Camera', capabilities: caps };
    assert.equal(describeCameraInfo({ state, video: { videoWidth: 1080, videoHeight: 1920 }, settings: base }),
      '받은 크기 1080×1920 · 지원 가로 1–1080 · 세로 1–1920 · OBS 가상카메라는 자동 권장');
    assert.match(describeCameraInfo({ state, video: { videoWidth: 1080, videoHeight: 720 }, settings: { ...base, resolution: '1280x720' } }),
      /요청 1280×720과 다름 \(장치가 고른 값, 잘림\)/);
  });
  it('준비되지 않았으면 상태와 원인', () => {
    assert.equal(describeCameraInfo({ state: { status: 'unavailable', reason: 'in-use', errorName: 'NotReadableError' }, video: {}, settings: base }),
      '카메라 unavailable (in-use / NotReadableError)');
  });
});
