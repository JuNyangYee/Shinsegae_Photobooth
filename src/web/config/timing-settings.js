// 운영자 시간 설정 (10단계, E "시간" 섹션): 촬영 흐름(카운트다운·결과 표시·쿨타임), 인식 반응(인식까지·이탈까지),
// 카메라 회복(다시 시도·첫 프레임·정지 판정·직원 문의)의 범위·정규화·저장 형식과, 인식 조절값 파일에서 옮기기.
// 브라우저 API를 쓰지 않는다. Node 테스트: test/config/timing-settings.test.mjs
//
// 저장 형식 (서버 파일 config/timing.local.json, API /local-api/timing-settings, settings-file.js):
//   { "version": 1, "settings": { "countdownSeconds", "resultMs", "cooldownMs", "presentHoldMs", "absentGraceMs",
//     "cameraRecovery": { "retryIntervalMs", "firstFrameTimeoutMs", "stallTimeoutMs", "staffNoticeMs" } } }
// presentHoldMs·absentGraceMs(2026-10-27)·cameraRecovery(9-1)는 9단계까지 인식 조절값 파일(presence.local.json)에 있었다.
// 시간 파일이 없을 때 한 번 옮기고(extractLegacyTiming), 옮긴 뒤에는 인식 파일에서 그 키만 뺀다.

export const TIMING_SETTINGS_VERSION = 1;

// 운영자가 조절할 수 있는 범위 (ms, 카운트다운만 초). 저장값을 불러올 때도 이 범위로 맞춘다. 촬영 흐름 범위는 가안
export const timingLimits = Object.freeze({
  // 촬영 흐름 (10단계, 가안). 카운트다운 0은 상태 기계가 받지만(바로 촬영) 관람객이 준비할 틈이 없어 1부터
  countdownSeconds: Object.freeze({ min: 1, max: 10, step: 1 }),
  resultMs: Object.freeze({ min: 3000, max: 60000, step: 1000 }),
  cooldownMs: Object.freeze({ min: 0, max: 30000, step: 500 }),
  // 판정 시간. 0은 감지 한 프레임으로 바로 바뀐다. 2초보다 길면 떠난 사람이 찍히거나 자동 시작이 굼떠 상한을 둔다 (2026-10-27)
  presentHoldMs: Object.freeze({ min: 0, max: 2000, step: 50 }),
  absentGraceMs: Object.freeze({ min: 0, max: 2000, step: 50 }),
  // 카메라 회복 시간 (9-1, 가안). 프레임 정지 판정의 하한(1초)은 촬영 직전 정지 화면 검사(config.capture.maxFrameAgeMs 0.5초)보다 길다:
  // 정지 판정이 그보다 짧으면 끊김으로 먼저 끊어 정지 화면 검사가 뜻이 없어진다 (test/config/timing-settings.test.mjs가 확인)
  cameraRecovery: Object.freeze({
    retryIntervalMs: Object.freeze({ min: 1000, max: 30000, step: 500 }), // 실패·끊김 뒤 다시 시도하는 간격
    firstFrameTimeoutMs: Object.freeze({ min: 2000, max: 30000, step: 500 }), // 첫 프레임 제한 시간
    stallTimeoutMs: Object.freeze({ min: 1000, max: 10000, step: 500 }), // 프레임 정지를 끊김으로 보는 시간
    staffNoticeMs: Object.freeze({ min: 5000, max: 300000, step: 1000 }), // 직원 문의 문구로 바꾸는 시간
  }),
});

export const TIMING_FLOW_KEYS = Object.freeze(['countdownSeconds', 'resultMs', 'cooldownMs']);
export const TIMING_PRESENCE_KEYS = Object.freeze(['presentHoldMs', 'absentGraceMs']);
export const CAMERA_RECOVERY_KEYS = Object.freeze(['retryIntervalMs', 'firstFrameTimeoutMs', 'stallTimeoutMs', 'staffNoticeMs']);
// 9단계까지 인식 조절값 파일(presence.local.json의 settings)에 있던 키
export const LEGACY_PRESENCE_TIMING_KEYS = Object.freeze(['presentHoldMs', 'absentGraceMs', 'cameraRecovery']);

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** 정수로, 범위 안으로. 숫자가 아니거나 없으면 기본값 (issues에 이름 붙여 남긴다) */
function integerIn(value, { min, max }, fallback, name, issues) {
  if (!isFiniteNumber(value)) {
    issues.push(`${name}: ${value === undefined ? 'missing' : 'not a number'} -> default`);
    return fallback;
  }
  const adjusted = Math.round(clamp(value, min, max));
  if (adjusted !== value) issues.push(`${name}: ${value} -> ${adjusted}`);
  return adjusted;
}

/** 카메라 회복 시간. 키가 없으면(9-1 전 인식 파일에서 옮긴 값) 알리지 않고 기본값, 형식이 틀리면 그 항목만 기본값 */
function normalizeCameraRecovery(raw, defaults, issues) {
  if (raw === undefined) return Object.freeze({ ...defaults });
  if (!isObject(raw)) {
    issues.push('cameraRecovery: invalid -> default');
    return Object.freeze({ ...defaults });
  }
  const out = {};
  for (const key of CAMERA_RECOVERY_KEYS) {
    out[key] = integerIn(raw[key], timingLimits.cameraRecovery[key], defaults[key], `cameraRecovery.${key}`, issues);
  }
  return Object.freeze(out);
}

/**
 * 시간 설정을 검사해 항상 쓸 수 있는 값으로 만든다. 예외를 던지지 않는다.
 * 숫자가 아니거나 없는 항목은 그 항목만 기본값, 범위 밖은 범위 안으로, 모두 정수로.
 * @returns {{ settings: object, issues: string[] }} issues는 바꾼 항목 설명 (운영자 확인용)
 */
export function normalizeTimingSettings(input, defaults) {
  const source = isObject(input) ? input : {};
  const issues = [];
  const settings = {};
  for (const key of [...TIMING_FLOW_KEYS, ...TIMING_PRESENCE_KEYS]) {
    settings[key] = integerIn(source[key], timingLimits[key], defaults[key], key, issues);
  }
  settings.cameraRecovery = normalizeCameraRecovery(source.cameraRecovery, defaults.cameraRecovery, issues);
  return { settings: Object.freeze(settings), issues };
}

/** 저장할 값만 (키 순서 고정) */
export function timingTunables(settings) {
  return {
    ...Object.fromEntries([...TIMING_FLOW_KEYS, ...TIMING_PRESENCE_KEYS].map((key) => [key, settings[key]])),
    cameraRecovery: Object.fromEntries(CAMERA_RECOVERY_KEYS.map((key) => [key, settings.cameraRecovery?.[key]])),
  };
}

export function serializeTimingSettings(settings) {
  return JSON.stringify({ version: TIMING_SETTINGS_VERSION, settings: timingTunables(settings) }, null, 2);
}

export function sameTimingSettings(a, b) {
  return JSON.stringify(timingTunables(a)) === JSON.stringify(timingTunables(b));
}

/**
 * 저장된 문자열을 읽는다. 어떤 값이 들어 있어도 예외를 던지지 않는다.
 * @returns {{ settings: object, issues: string[], source: 'stored' | 'default' }}
 */
export function parseStoredTimingSettings(text, defaults) {
  const fallback = (issue) => ({
    settings: normalizeTimingSettings(defaults, defaults).settings, issues: issue ? [issue] : [], source: 'default',
  });
  if (text === null || text === undefined) return fallback(null);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback('stored value is not valid JSON -> defaults');
  }
  if (!isObject(parsed)) return fallback('stored value is not an object -> defaults');
  if (parsed.version !== TIMING_SETTINGS_VERSION) {
    return fallback(`stored version ${JSON.stringify(parsed.version)} != ${TIMING_SETTINGS_VERSION} -> defaults`);
  }
  const { settings, issues } = normalizeTimingSettings(parsed.settings, defaults);
  return { settings, issues, source: 'stored' };
}

/**
 * 인식 조절값 파일(presence.local.json) 내용에 남은 9단계까지의 시간 키를 꺼낸다.
 * 형식이 맞고(version 1, settings 객체) 그 키가 하나라도 있으면 { legacy, strippedText }: legacy는 있는 키의 원래 값(검사 전),
 * strippedText는 그 키만 뺀 같은 파일 내용(다른 값은 손대지 않는다). 없거나 형식이 다르면 { legacy: null, strippedText: null }.
 */
export function extractLegacyTiming(presenceText) {
  let parsed;
  try {
    parsed = JSON.parse(presenceText);
  } catch {
    return { legacy: null, strippedText: null };
  }
  const settings = parsed?.settings;
  if (parsed?.version !== 1 || !isObject(settings)) return { legacy: null, strippedText: null };
  const legacy = {};
  const rest = {};
  for (const [key, value] of Object.entries(settings)) {
    if (LEGACY_PRESENCE_TIMING_KEYS.includes(key)) legacy[key] = value;
    else rest[key] = value;
  }
  if (Object.keys(legacy).length === 0) return { legacy: null, strippedText: null };
  return { legacy, strippedText: JSON.stringify({ ...parsed, settings: rest }, null, 2) };
}

/**
 * 옛 인식 파일의 시간 키를 시간 설정으로: 촬영 흐름은 기본값, 있는 키는 그 값(검사는 normalizeTimingSettings).
 * cameraRecovery가 없던 파일(9-1 전)은 예전처럼 알리지 않고 기본값이다.
 */
export function timingFromLegacy(legacy, defaults) {
  return normalizeTimingSettings({ ...timingTunables(defaults), cameraRecovery: undefined, ...legacy }, defaults);
}

/**
 * 인식 섹션이 저장하는 내용(serializePresenceSettings)에 옛 시간 키를 그대로 다시 붙인다.
 * 시간 값이 아직 시간 파일에 없는 동안(옮기기 실패·시간 파일 읽기 실패) 인식 섹션을 저장해도 그 값이 사라지지 않게 한다.
 */
export function withLegacyTiming(presenceText, legacy) {
  if (!legacy) return presenceText;
  const parsed = JSON.parse(presenceText);
  return JSON.stringify({ ...parsed, settings: { ...parsed.settings, ...legacy } }, null, 2);
}
