// 카메라 설정 (9-1): 장치·해상도·색 보정·좌우 반전·회전·확대·이동의 범위·정규화·저장 형식.
// "카메라 원본 자체를 고치는 것"이라 감지·미리보기·결과·인쇄가 모두 이 값을 따른다 (변환 계산은 core/camera-view.js).
// 브라우저 API를 쓰지 않는다. Node 테스트: test/config/camera-settings.test.mjs
//
// 저장 형식 (서버 파일 config/camera.local.json, API /local-api/camera-settings, settings-file.js):
//   { "version": 1, "settings": { "deviceLabel", "resolution", "brightness", "contrast", "saturation", "gamma", "temperature", "tint",
//     "mirror", "rotation", "rotationFine", "zoom", "panX", "panY" } }
// 좌우 반전은 2026-10-26부터 효과 조절값(effect.local.json)의 mirror였다. 카메라 파일이 없을 때 한 번 옮긴다 (migrateMirrorFromEffect).

export const CAMERA_SETTINGS_VERSION = 1;

/** 회전의 90° 단위. 미세 회전(rotationFine)은 그 위에 더한다 */
export const CAMERA_ROTATIONS = Object.freeze([0, 90, 180, 270]);

/**
 * 해상도: 'auto'(config.idealResolution, 90°·270° 회전이면 가로·세로를 바꿔 요청) 또는 카메라 기준 '가로x세로'.
 * 모두 ideal로만 요청한다(장치가 지원하지 않아도 실패하지 않고 가장 가까운 값을 받는다). 실제 받은 크기는 D video·track
 */
export const RESOLUTION_PRESETS = Object.freeze(['auto', '2160x3840', '1080x1920', '720x1280', '3840x2160', '1920x1080', '1280x720']);

export const cameraLimits = Object.freeze({
  // 색 보정 (중립: 0·1·1·1·0·0). 식은 core/camera-view.js cameraColorMatrix
  brightness: Object.freeze({ min: -0.5, max: 0.5, step: 0.01 }), // 밝기: 더한다
  contrast: Object.freeze({ min: 0.5, max: 2, step: 0.05 }), // 대비: 0.5를 중심으로 늘린다
  saturation: Object.freeze({ min: 0, max: 2, step: 0.05 }), // 채도: 0 회색, 1 그대로
  gamma: Object.freeze({ min: 0.4, max: 2.5, step: 0.05 }), // 감마: 1보다 크면 중간 밝기를 밝게
  temperature: Object.freeze({ min: -1, max: 1, step: 0.05 }), // 색온도: 양수가 따뜻하게 (빨강↑ 파랑↓)
  tint: Object.freeze({ min: -1, max: 1, step: 0.05 }), // 색조: 양수가 자홍, 음수가 초록
  // 변환 (중립: 0·0·1·0·0). 회전 양수 = 화면에서 시계 방향, 이동 = 화면 폭·높이 대비
  rotationFine: Object.freeze({ min: -15, max: 15, step: 0.1 }), // 미세 회전 (도)
  zoom: Object.freeze({ min: 1, max: 4, step: 0.01 }), // 확대: cover 크롭 위에 곱한다
  panX: Object.freeze({ min: -0.5, max: 0.5, step: 0.005 }), // 가로 이동: 양수면 그림이 오른쪽으로
  panY: Object.freeze({ min: -0.5, max: 0.5, step: 0.005 }), // 세로 이동: 양수면 그림이 아래로
  deviceLabelMaxLength: 256,
});

// 저장할 때의 자릿수 (단계에 맞춤)
const DIGITS = Object.freeze({
  brightness: 2, contrast: 2, saturation: 2, gamma: 2, temperature: 2, tint: 2, rotationFine: 1, zoom: 2, panX: 3, panY: 3,
});

export const CAMERA_SETTING_KEYS = Object.freeze([
  'deviceLabel', 'resolution',
  'brightness', 'contrast', 'saturation', 'gamma', 'temperature', 'tint',
  'mirror', 'rotation', 'rotationFine', 'zoom', 'panX', 'panY',
]);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const describe = (value) => (value === undefined ? 'missing' : JSON.stringify(value));

/**
 * 카메라 설정을 검사해 항상 쓸 수 있는 값으로 만든다. 예외를 던지지 않는다.
 * - 숫자가 아니거나 없는 항목은 그 항목만 기본값. 범위 밖은 범위 안으로, 단계 자릿수로 반올림
 * - 회전은 90° 단위 목록, 해상도는 프리셋 목록에 없으면 기본값. 장치 라벨은 문자열(앞뒤 공백 제거, 256자까지)
 * @returns {{ settings: object, issues: string[] }} issues는 바꾼 항목 설명 (운영자 확인용)
 */
export function normalizeCameraSettings(input, defaults) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const issues = [];

  const number = (key) => {
    const value = source[key];
    if (!isFiniteNumber(value)) {
      issues.push(`${key}: ${value === undefined ? 'missing' : 'not a number'} -> default`);
      return defaults[key];
    }
    const { min, max } = cameraLimits[key];
    const adjusted = Number(clamp(value, min, max).toFixed(DIGITS[key]));
    if (adjusted !== value) issues.push(`${key}: ${value} -> ${adjusted}`);
    return adjusted;
  };

  const oneOf = (key, allowed) => {
    const value = source[key];
    if (allowed.includes(value)) return value;
    issues.push(`${key}: ${describe(value)} -> default`);
    return defaults[key];
  };

  let mirror = source.mirror;
  if (typeof mirror !== 'boolean') {
    issues.push(`mirror: ${describe(mirror)} -> default`);
    mirror = defaults.mirror;
  }

  let deviceLabel = source.deviceLabel;
  if (typeof deviceLabel !== 'string') {
    issues.push(`deviceLabel: ${describe(deviceLabel)} -> default`);
    deviceLabel = defaults.deviceLabel;
  } else {
    const trimmed = deviceLabel.trim().slice(0, cameraLimits.deviceLabelMaxLength);
    if (trimmed !== deviceLabel) issues.push('deviceLabel: trimmed');
    deviceLabel = trimmed;
  }

  const settings = Object.freeze({
    deviceLabel,
    resolution: oneOf('resolution', RESOLUTION_PRESETS),
    brightness: number('brightness'),
    contrast: number('contrast'),
    saturation: number('saturation'),
    gamma: number('gamma'),
    temperature: number('temperature'),
    tint: number('tint'),
    mirror,
    rotation: oneOf('rotation', CAMERA_ROTATIONS),
    rotationFine: number('rotationFine'),
    zoom: number('zoom'),
    panX: number('panX'),
    panY: number('panY'),
  });
  return { settings, issues };
}

/** 저장할 값만 (키 순서 고정) */
export function cameraTunables(settings) {
  return Object.fromEntries(CAMERA_SETTING_KEYS.map((key) => [key, settings[key]]));
}

export function serializeCameraSettings(settings) {
  return JSON.stringify({ version: CAMERA_SETTINGS_VERSION, settings: cameraTunables(settings) }, null, 2);
}

export function sameCameraSettings(a, b) {
  return JSON.stringify(cameraTunables(a)) === JSON.stringify(cameraTunables(b));
}

/**
 * 저장된 문자열을 읽는다. 어떤 값이 들어 있어도 예외를 던지지 않는다.
 * @returns {{ settings: object, issues: string[], source: 'stored' | 'default' }}
 */
export function parseStoredCameraSettings(text, defaults) {
  const fallback = (issue) => ({
    settings: normalizeCameraSettings(defaults, defaults).settings, issues: issue ? [issue] : [], source: 'default',
  });
  if (text === null || text === undefined) return fallback(null);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback('stored value is not valid JSON -> defaults');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback('stored value is not an object -> defaults');
  if (parsed.version !== CAMERA_SETTINGS_VERSION) {
    return fallback(`stored version ${JSON.stringify(parsed.version)} != ${CAMERA_SETTINGS_VERSION} -> defaults`);
  }
  const { settings, issues } = normalizeCameraSettings(parsed.settings, defaults);
  return { settings, issues, source: 'stored' };
}

/**
 * getUserMedia에 넘길 해상도 권장값 (ideal, 카메라 기준 가로×세로).
 * 'auto'는 autoIdeal(config.idealResolution, 세로 4K)이고, 90°·270° 회전이면 카메라가 가로로 내보내므로 가로·세로를 바꾼다
 * (세로 권장값을 가로 카메라에 요청하면 Chrome이 세로로 잘라 줄일 수 있다).
 */
export function resolutionRequest(settings, autoIdeal) {
  if (settings.resolution !== 'auto') {
    const [width, height] = settings.resolution.split('x').map(Number);
    return { width, height };
  }
  const odd = settings.rotation === 90 || settings.rotation === 270;
  return odd ? { width: autoIdeal.height, height: autoIdeal.width } : { width: autoIdeal.width, height: autoIdeal.height };
}

/** 장치·해상도 요청이 같은지 (다르면 카메라 스트림을 다시 연다) */
export function sameCameraRequest(a, b, autoIdeal) {
  const ra = resolutionRequest(a, autoIdeal);
  const rb = resolutionRequest(b, autoIdeal);
  return a.deviceLabel === b.deviceLabel && ra.width === rb.width && ra.height === rb.height;
}

/**
 * 효과 조절값 파일(effect.local.json)에 남은 좌우 반전(mirror, 2026-10-26 ~ 9-1)을 꺼낸다.
 * 형식이 맞고(version 1, settings.mirror가 참·거짓) 값이 있으면 { mirror, strippedText }: strippedText는 그 키만 뺀 같은 파일 내용
 * (다른 값은 손대지 않는다). 없거나 형식이 다르면 { mirror: null }.
 */
export function migrateMirrorFromEffect(effectText) {
  let parsed;
  try {
    parsed = JSON.parse(effectText);
  } catch {
    return { mirror: null, strippedText: null };
  }
  const settings = parsed?.settings;
  if (parsed?.version !== 1 || settings === null || typeof settings !== 'object' || typeof settings.mirror !== 'boolean') {
    return { mirror: null, strippedText: null };
  }
  const { mirror, ...rest } = settings;
  return { mirror, strippedText: JSON.stringify({ ...parsed, settings: rest }, null, 2) };
}
