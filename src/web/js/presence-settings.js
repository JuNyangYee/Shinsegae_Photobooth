// 인식 판정 설정값의 검증·정규화·저장 형식과 영역 편집 계산.
// 브라우저 API를 직접 쓰지 않는다 (저장소는 getItem·setItem을 가진 객체로 받는다).
// Node 테스트: tests/presence-settings.test.mjs
//
// 저장 형식 (4-3부터 서버 파일 config/presence.local.json, settings-file.js. 그전에는 localStorage 키 PRESENCE_STORAGE_KEY):
//   { "version": 1, "settings": { "region": {x, y, width, height}, "minFaceHeight", "maxFaceHeight",
//     "minScore", "presentHoldMs", "absentGraceMs" } }
// localStorage는 파일이 없을 때 한 번 옮기기(마이그레이션) 위해 읽기만 하고, 옮긴 뒤 지운다.
// 좌표·크기는 9:16 영역 기준 0~1, 관람객이 보는 화면(반전 후) 기준이다 (presence.js와 같음).

export const PRESENCE_STORAGE_KEY = 'photobooth.presence.v1';
export const PRESENCE_SETTINGS_VERSION = 1;

// 운영자가 조절할 수 있는 범위. 저장값을 불러올 때도 이 범위로 맞춘다.
export const presenceLimits = Object.freeze({
  regionMinSize: 0.1, // 영역 폭·높이 최소값
  faceHeight: Object.freeze({ min: 0.01, max: 1, step: 0.005 }), // 최소·최대 얼굴 크기 공통
  // 감지기 자체 기준(config.faceDetection.detectorMinConfidence 0.3)보다 낮추면 효과가 없으므로 하한을 맞춘다.
  minScore: Object.freeze({ min: 0.3, max: 1, step: 0.01 }),
  presentHoldMs: Object.freeze({ min: 0, max: 5000, step: 50 }),
  absentGraceMs: Object.freeze({ min: 0, max: 5000, step: 50 }),
});

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const round = (value, digits) => Number(value.toFixed(digits));
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** 영역을 9:16 영역 안으로, 최소 크기 이상으로 맞춘다. */
export function clampRegion(region, minSize = presenceLimits.regionMinSize) {
  // 크기를 먼저 반올림한 뒤 위치를 맞춰, 반올림 때문에 x + width가 1을 넘지 않게 한다.
  const width = round(clamp(region.width, minSize, 1), 4);
  const height = round(clamp(region.height, minSize, 1), 4);
  return {
    x: round(clamp(region.x, 0, round(1 - width, 4)), 4),
    y: round(clamp(region.y, 0, round(1 - height, 4)), 4),
    width,
    height,
  };
}

/**
 * 설정값을 검사해 항상 쓸 수 있는 값으로 만든다.
 * - 숫자가 아니거나 없는 항목은 그 항목만 기본값으로 바꾼다.
 * - 범위 밖 값은 범위 안으로 맞춘다. 영역은 9:16 밖으로 나가지 않게 옮기고 줄인다.
 * - 최소 얼굴 크기가 최대보다 크면 최대를 최소에 맞춘다.
 * @returns {{ settings: object, issues: string[] }} issues는 바꾼 항목 설명 (운영자 확인용)
 */
export function normalizePresenceSettings(input, defaults) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const issues = [];

  const number = (key, { min, max }, digits) => {
    const value = source[key];
    if (!isFiniteNumber(value)) {
      if (value !== undefined) issues.push(`${key}: not a number -> default`);
      else issues.push(`${key}: missing -> default`);
      return defaults[key];
    }
    const clamped = round(clamp(value, min, max), digits);
    if (clamped !== value) issues.push(`${key}: ${value} -> ${clamped}`);
    return clamped;
  };

  let region;
  const raw = source.region;
  if (raw === null || typeof raw !== 'object' || !['x', 'y', 'width', 'height'].every((k) => isFiniteNumber(raw[k]))) {
    issues.push(`region: ${raw === undefined ? 'missing' : 'invalid'} -> default`);
    region = clampRegion(defaults.region);
  } else {
    region = clampRegion(raw);
    if (['x', 'y', 'width', 'height'].some((k) => region[k] !== raw[k])) {
      issues.push(`region: adjusted to x${region.x} y${region.y} w${region.width} h${region.height}`);
    }
  }

  const minFaceHeight = number('minFaceHeight', presenceLimits.faceHeight, 3);
  let maxFaceHeight = number('maxFaceHeight', presenceLimits.faceHeight, 3);
  if (minFaceHeight > maxFaceHeight) {
    issues.push(`maxFaceHeight: ${maxFaceHeight} < minFaceHeight ${minFaceHeight} -> ${minFaceHeight}`);
    maxFaceHeight = minFaceHeight;
  }

  const settings = {
    region,
    minFaceHeight,
    maxFaceHeight,
    minScore: number('minScore', presenceLimits.minScore, 2),
    presentHoldMs: number('presentHoldMs', presenceLimits.presentHoldMs, 0),
    absentGraceMs: number('absentGraceMs', presenceLimits.absentGraceMs, 0),
  };
  return { settings, issues };
}

/**
 * 저장된 문자열을 읽는다. 어떤 값이 들어 있어도 예외를 던지지 않는다.
 * @param {string | null} text localStorage.getItem 결과
 * @returns {{ settings: object, issues: string[], source: 'stored' | 'default' }}
 */
export function parseStoredPresenceSettings(text, defaults) {
  const fallback = (issue) => ({
    settings: normalizePresenceSettings(defaults, defaults).settings,
    issues: issue ? [issue] : [],
    source: 'default',
  });
  if (text === null || text === undefined) return fallback(null);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback('stored value is not valid JSON -> defaults');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fallback('stored value is not an object -> defaults');
  }
  if (parsed.version !== PRESENCE_SETTINGS_VERSION) {
    return fallback(`stored version ${JSON.stringify(parsed.version)} != ${PRESENCE_SETTINGS_VERSION} -> defaults`);
  }
  const { settings, issues } = normalizePresenceSettings(parsed.settings, defaults);
  return { settings, issues, source: 'stored' };
}

export function serializePresenceSettings(settings) {
  return JSON.stringify({ version: PRESENCE_SETTINGS_VERSION, settings }, null, 2);
}

/** 저장소 접근 자체가 실패해도(차단·용량 등) 기본값으로 시작한다. */
export function loadPresenceSettings(storage, defaults) {
  let text = null;
  try {
    text = storage?.getItem(PRESENCE_STORAGE_KEY) ?? null;
  } catch (error) {
    const result = parseStoredPresenceSettings(null, defaults);
    return { ...result, issues: [`storage read failed: ${error?.message ?? error}`] };
  }
  return parseStoredPresenceSettings(text, defaults);
}

/** localStorage 저장값을 지운다 (파일로 옮긴 뒤). @returns {string | null} 실패하면 오류 설명, 성공하면 null */
export function removeStoredPresenceSettings(storage) {
  try {
    storage?.removeItem(PRESENCE_STORAGE_KEY);
    return null;
  } catch (error) {
    return error?.message ?? String(error);
  }
}

export function samePresenceSettings(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- 영역 편집 계산 (마우스 드래그) ----

/** 시작 영역을 (dx, dy)만큼 옮긴다. 크기는 그대로 두고 9:16 안에 머물게 한다. */
export function moveRegion(start, dx, dy) {
  return clampRegion({ ...start, x: start.x + dx, y: start.y + dy });
}

/**
 * 핸들(n, s, e, w, ne, nw, se, sw)을 point(0~1, 9:16 영역 기준)로 끌었을 때의 영역.
 * 반대쪽 변은 고정하고, 9:16 밖으로 나가거나 최소 크기보다 작아지지 않게 한다.
 */
export function resizeRegion(start, handle, point, minSize = presenceLimits.regionMinSize) {
  let left = start.x;
  let top = start.y;
  let right = start.x + start.width;
  let bottom = start.y + start.height;
  if (handle.includes('w')) left = clamp(point.x, 0, right - minSize);
  if (handle.includes('e')) right = clamp(point.x, left + minSize, 1);
  if (handle.includes('n')) top = clamp(point.y, 0, bottom - minSize);
  if (handle.includes('s')) bottom = clamp(point.y, top + minSize, 1);
  return clampRegion({ x: left, y: top, width: right - left, height: bottom - top }, minSize);
}
