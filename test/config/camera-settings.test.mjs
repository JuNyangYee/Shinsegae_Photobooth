// 실행: npm test
// 카메라 설정 (9-1): 정규화·저장 형식·해상도 요청·효과 파일의 좌우 반전 옮기기
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { config } from '../../src/web/config/config.js';
import {
  CAMERA_ROTATIONS, CAMERA_SETTING_KEYS, RESOLUTION_PRESETS, cameraLimits, migrateMirrorFromEffect, normalizeCameraSettings,
  parseStoredCameraSettings, resolutionRequest, sameCameraRequest, sameCameraSettings, serializeCameraSettings,
} from '../../src/web/config/camera-settings.js';
import { effectTunables, normalizeEffectSettings } from '../../src/web/config/effect-settings.js';

const defaults = config.camera;
const base = normalizeCameraSettings(defaults, defaults).settings;

describe('카메라 설정 기본값', () => {
  it('중립값(색 보정 0·1·1·1·0·0, 회전 0, 확대 1, 이동 0), 반전 켬, 장치 자동, 해상도 자동이고 정규화해도 그대로', () => {
    const { settings, issues } = normalizeCameraSettings(defaults, defaults);
    assert.deepEqual(issues, []);
    assert.deepEqual({ ...settings }, {
      deviceLabel: '', resolution: 'auto', brightness: 0, contrast: 1, saturation: 1, gamma: 1, temperature: 0, tint: 0,
      mirror: true, rotation: 0, rotationFine: 0, zoom: 1, panX: 0, panY: 0,
    });
    assert.deepEqual(Object.keys(settings), [...CAMERA_SETTING_KEYS]);
  });

  it('기본값은 모두 범위 안이고, 효과 설정에는 mirror가 없다 (9-1에 옮김)', () => {
    for (const [key, limit] of Object.entries(cameraLimits)) {
      if (typeof limit === 'object') assert.ok(defaults[key] >= limit.min && defaults[key] <= limit.max, key);
    }
    assert.ok(CAMERA_ROTATIONS.includes(defaults.rotation) && RESOLUTION_PRESETS.includes(defaults.resolution));
    assert.ok(!('mirror' in config.effect));
  });
});

describe('normalizeCameraSettings', () => {
  it('범위 밖은 범위로, 단계 자릿수로 반올림하고 알린다', () => {
    const { settings, issues } = normalizeCameraSettings({
      ...defaults, brightness: 0.9, contrast: 0.1, saturation: 1.234, gamma: 9, temperature: -3, tint: 0.333,
      rotationFine: 20, zoom: 0.5, panX: 0.12345, panY: -2,
    }, defaults);
    assert.deepEqual([settings.brightness, settings.contrast, settings.saturation, settings.gamma, settings.temperature, settings.tint],
      [0.5, 0.5, 1.23, 2.5, -1, 0.33]);
    assert.deepEqual([settings.rotationFine, settings.zoom, settings.panX, settings.panY], [15, 1, 0.123, -0.5]);
    assert.equal(issues.length, 10);
    assert.ok(issues.includes('zoom: 0.5 -> 1'));
  });

  it('숫자가 아니거나 없으면 그 항목만 기본값, 회전은 90° 단위만, 해상도는 프리셋만, 반전은 참·거짓만', () => {
    const { settings, issues } = normalizeCameraSettings({
      ...defaults, brightness: '0.2', zoom: undefined, rotation: 45, resolution: '999x999', mirror: 'false', contrast: 1.2,
    }, defaults);
    assert.deepEqual([settings.brightness, settings.zoom, settings.rotation, settings.resolution, settings.mirror, settings.contrast],
      [0, 1, 0, 'auto', true, 1.2]);
    assert.deepEqual(issues, [
      'mirror: "false" -> default', 'resolution: "999x999" -> default', 'brightness: not a number -> default', 'rotation: 45 -> default',
      'zoom: missing -> default',
    ]);
    for (const rotation of CAMERA_ROTATIONS) assert.equal(normalizeCameraSettings({ ...defaults, rotation }, defaults).settings.rotation, rotation);
    for (const resolution of RESOLUTION_PRESETS) {
      assert.equal(normalizeCameraSettings({ ...defaults, resolution }, defaults).settings.resolution, resolution);
    }
  });

  it('장치 라벨은 문자열(앞뒤 공백 제거, 256자까지), 아니면 기본값(자동)', () => {
    assert.equal(normalizeCameraSettings({ ...defaults, deviceLabel: '  OBS Virtual Camera ' }, defaults).settings.deviceLabel, 'OBS Virtual Camera');
    assert.equal(normalizeCameraSettings({ ...defaults, deviceLabel: 'x'.repeat(300) }, defaults).settings.deviceLabel.length, 256);
    const r = normalizeCameraSettings({ ...defaults, deviceLabel: 7 }, defaults);
    assert.deepEqual([r.settings.deviceLabel, r.issues], ['', ['deviceLabel: 7 -> default']]);
  });

  it('입력이 객체가 아니면 전부 기본값', () => {
    const { settings, issues } = normalizeCameraSettings(null, defaults);
    assert.ok(sameCameraSettings(settings, base));
    assert.equal(issues.length, CAMERA_SETTING_KEYS.length);
  });
});

describe('저장 형식 (config/camera.local.json)', () => {
  it('{ version: 1, settings: { 14개 } } 2칸 들여쓰기, 읽으면 그대로', () => {
    const changed = normalizeCameraSettings({ ...defaults, deviceLabel: 'USB Cam', resolution: '1920x1080', rotation: 90, zoom: 1.25, mirror: false }, defaults).settings;
    const text = serializeCameraSettings(changed);
    const parsed = JSON.parse(text);
    assert.equal(parsed.version, 1);
    assert.deepEqual(Object.keys(parsed.settings), [...CAMERA_SETTING_KEYS]);
    assert.ok(text.includes('\n  "settings": {\n    "deviceLabel": "USB Cam"'));
    const back = parseStoredCameraSettings(text, defaults);
    assert.equal(back.source, 'stored');
    assert.deepEqual(back.issues, []);
    assert.ok(sameCameraSettings(back.settings, changed));
    assert.ok(!sameCameraSettings(changed, base));
  });

  it('손상 JSON·객체 아님·version 다름·없음은 전체 기본값', () => {
    for (const [text, issue] of [['{oops', /not valid JSON/], ['[1]', /not an object/], ['{"version":2,"settings":{}}', /version 2/]]) {
      const r = parseStoredCameraSettings(text, defaults);
      assert.equal(r.source, 'default');
      assert.match(r.issues[0], issue);
      assert.ok(sameCameraSettings(r.settings, base));
    }
    assert.deepEqual(parseStoredCameraSettings(null, defaults).issues, []);
  });
});

describe('해상도 요청 (ideal)', () => {
  const ideal = config.idealResolution;
  it('자동은 config.idealResolution(2160x3840), 90°·270° 회전이면 가로·세로를 바꾼다 (가로 카메라에 세로 권장값을 요청하지 않게)', () => {
    assert.deepEqual(resolutionRequest(base, ideal), { width: 2160, height: 3840 });
    assert.deepEqual(resolutionRequest({ ...base, rotation: 90 }, ideal), { width: 3840, height: 2160 });
    assert.deepEqual(resolutionRequest({ ...base, rotation: 270 }, ideal), { width: 3840, height: 2160 });
    assert.deepEqual(resolutionRequest({ ...base, rotation: 180 }, ideal), { width: 2160, height: 3840 });
  });

  it('프리셋은 카메라 기준 가로x세로 그대로 (회전과 관계없이)', () => {
    assert.deepEqual(resolutionRequest({ ...base, resolution: '1920x1080', rotation: 90 }, ideal), { width: 1920, height: 1080 });
    assert.deepEqual(resolutionRequest({ ...base, resolution: '720x1280' }, ideal), { width: 720, height: 1280 });
  });

  it('장치·해상도 요청이 같으면 다시 열지 않는다: 색 보정·반전·확대만 바뀐 것은 같은 요청, 자동 해상도에서 90° 단위 회전은 다른 요청', () => {
    assert.ok(sameCameraRequest(base, { ...base, brightness: 0.3, mirror: false, zoom: 2, rotationFine: 4 }, ideal));
    assert.ok(!sameCameraRequest(base, { ...base, deviceLabel: 'USB Cam' }, ideal));
    assert.ok(!sameCameraRequest(base, { ...base, resolution: '1080x1920' }, ideal));
    assert.ok(!sameCameraRequest(base, { ...base, rotation: 90 }, ideal));
    assert.ok(sameCameraRequest(base, { ...base, rotation: 180 }, ideal));
    assert.ok(sameCameraRequest({ ...base, resolution: '1920x1080' }, { ...base, resolution: '1920x1080', rotation: 90 }, ideal));
  });
});

describe('migrateMirrorFromEffect: 효과 파일(effect.local.json)에 남은 좌우 반전', () => {
  const effectFile = (settings, version = 1) => JSON.stringify({ version, settings }, null, 2);
  const tunables = effectTunables(normalizeEffectSettings(config.effect, config.effect).settings);

  it('참·거짓이 있으면 그 값과, 그 키만 뺀 같은 내용을 돌려준다 (다른 값·순서 그대로)', () => {
    for (const mirror of [false, true]) {
      const r = migrateMirrorFromEffect(effectFile({ ...tunables, fps: 18, mirror }));
      assert.equal(r.mirror, mirror);
      assert.deepEqual(JSON.parse(r.strippedText), { version: 1, settings: { ...tunables, fps: 18 } });
      assert.ok(!r.strippedText.includes('mirror'));
    }
  });

  it('키가 없거나·참·거짓이 아니거나·형식이 다르면 옮길 것이 없다', () => {
    for (const text of [effectFile(tunables), effectFile({ ...tunables, mirror: 'off' }), effectFile({ mirror: false }, 2), '{oops', 'null', '[]']) {
      assert.deepEqual(migrateMirrorFromEffect(text), { mirror: null, strippedText: null }, text.slice(0, 30));
    }
  });
});
