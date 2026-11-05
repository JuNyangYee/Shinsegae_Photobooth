// 사진 효과 "유화 · 획 (세부 보존)" 설정값의 범위와 정규화.
// 브라우저 API를 쓰지 않는다. 조절 화면·파일 저장은 5-2 범위이고, 지금은 코드에서 바꾼 값을 검사하는 데 쓴다.
// Node 테스트: test/config/effect-settings.test.mjs
//
// 강도·크기·획 다시 그리기·초당 그림·색 보정의 범위는 같은 팀 동료가 만든 원본 필터 갤러리(배포 페이지에서 이식)
// (https://nau-filter-gallery.vercel.app/, 프리셋 oil2f)의 슬라이더 범위와 같다.
// 붓 층·보완 층 단위는 docs/SYSTEM.md 6절 "사진 효과(유화 · 획)".
//
// 저장 형식 (5-2, 서버 파일 config/effect.local.json, settings-file.js):
//   { "version": 1, "settings": { "strength", "size", "boil", "fps", "grade", "refineThreshold", "previewScale",
//     "outputMode", "dither", "brightness", "contrast", "gamma", "paperDots", "bwStyle", "bwTexture", "lineSpacing" } }
// 운영자가 조절하는 값(EFFECT_TUNABLE_KEYS)만 저장한다. 붓 층 모양 등은 config.effect 기본값을 쓴다.
// 출력 단계 값 6개는 6-1에서, 흑백 스타일 값 3개는 7-1에서 더했다. 버전은 1 그대로이고, 예전 파일(5-2의 앞 7개, 6-1의 13개)을
// 읽으면 없는 값은 기본값으로 채운다. 8단계는 출력 모드에 값 'gray-oil'만 더했다(키·버전 그대로). 파일에 저장된 모드가 있으면 그 값을 쓴다.
// 좌우 반전(mirror)은 2026-10-26부터 이 파일에 있었고 9-1에서 카메라 설정(config/camera-settings.js, camera.local.json)으로 옮겼다.
// 파일에 남은 mirror 키는 여기서 읽지 않는다(카메라 파일이 없을 때 settings-file.js가 한 번 옮기고 이 파일에서 그 키를 뺀다).
//
// 시험 조합 (WISHFUL HOLIDAY 시안, 검토 중): 유화 켬/끔(oil)과 흑백 켬/끔을 따로 바꿔 네 조합(원본 컬러·원본 흑백·유화 컬러·유화 흑백)을
// 실제 영상 처리로 시험한다. 키 두 개만 더했다(버전 1 그대로, 선택 키라 없으면 알리지 않고 채운다 — 예전 16개 키 파일은 바뀌지 않고 같은 값):
//   oil      유화 패스를 쓸지. false면 카메라 그림에 출력 단계만 입힌다. 강도·붓 크기 등 유화 수치는 지우지 않고 그대로 둔다(다시 켜면 그 값).
//   monoMode 흑백일 때의 출력 모드(흑백 방식: gray-oil·thermal·gray). "흑백"은 outputMode가 'off'(컬러)가 아닌 것이고,
//            흑백을 끄면 outputMode = 'off', 다시 켜면 outputMode = monoMode로 돌아온다. outputMode가 흑백이면 monoMode는 늘 같은 값이다.
// outputMode는 예전과 같은 뜻 그대로 저장한다(예전 앱이 이 파일을 읽어도 컬러·흑백은 맞다. 예전 앱은 oil을 모르므로 유화로 보인다).

export const effectLimits = Object.freeze({
  strength: Object.freeze({ min: 0, max: 1.6, step: 0.05 }), // 강도: 요철·광택·색 흔들림
  size: Object.freeze({ min: 0.6, max: 1.8, step: 0.05 }), // 붓 크기 배율: 획 굵기·간격·길이에 곱한다
  boil: Object.freeze({ min: 0, max: 1, step: 0.05 }), // 획 다시 그리기: 그림마다 새로 배치하는 획 비율
  fps: Object.freeze({ min: 2, max: 30, step: 1 }), // 초당 그림 수
  grade: Object.freeze({ min: 0, max: 1, step: 0.05 }), // 색 보정 섞는 정도
  // 보완 층 오차 문턱 (0~1 RGB 거리). 셰이더에서 0은 "보완 층 아님"이라 0이 되지 않게 한다. 끄려면 refine을 null로
  refineThreshold: Object.freeze({ min: 0.01, max: 1, step: 0.01 }),
  previewScale: Object.freeze({ min: 0.25, max: 1, step: 0.05 }), // 미리보기 처리 해상도 배율 (결과 크기 대비)
  // 출력 단계 (6-1). 레벨 식은 core/thermal.js applyLevels
  brightness: Object.freeze({ min: -0.5, max: 0.5, step: 0.01 }), // 밝기: 회색조에 더한다
  contrast: Object.freeze({ min: 0.5, max: 2, step: 0.05 }), // 대비: 0.5를 중심으로 늘린다
  gamma: Object.freeze({ min: 0.4, max: 2.5, step: 0.05 }), // 감마: 1보다 크면 중간 밝기를 밝게
  paperDots: Object.freeze({ min: 128, max: 1024, step: 8 }), // 용지 폭 점 수. 8의 배수 (80mm 576, 58mm 384)
  // 흑백 스타일 (7-1). 질감 세기: 붓 높이 조명·국소 대비를 1비트 전에 더하는 정도. 선 간격: 선 스타일의 선 주기(인쇄 점)
  bwTexture: Object.freeze({ min: 0, max: 2, step: 0.05 }),
  lineSpacing: Object.freeze({ min: 2, max: 8, step: 0.5 }),
});

/**
 * 출력 모드: 회색조 유화(8단계 기본값: 입력 회색조 → 유화 → 회색조 화면, 인쇄 1비트는 결과에서 따로) /
 * 감열지(1비트 점) / 회색조만(컬러 유화를 회색조로) / 끔(컬러 유화)
 */
export const OUTPUT_MODES = Object.freeze(['gray-oil', 'thermal', 'gray', 'off']);
/** 점 방식: 문턱값(GPU·CPU 같은 결과) 2개, 오차 확산(CPU) 2개 */
export const DITHER_METHODS = Object.freeze(['blue-noise', 'bayer', 'atkinson', 'floyd-steinberg']);
/**
 * 흑백 스타일 (7-1, 감열지에서만): 톤 점(6-1 그대로) / 질감 강조 점(붓 높이 조명·국소 대비 + 점 방식) /
 * 흐름 선(흐름장을 따라 번진 결, GPU) / 붓 결 선(획마다 획 방향 선, GPU). 흐름 선·붓 결 선은 점 방식을 쓰지 않는다
 */
export const BW_STYLES = Object.freeze(['tone', 'texture', 'flow', 'stroke']);
/** 흑백 방식 (시험 조합의 "흑백 켬"이 쓰는 출력 모드). 'off'(컬러)를 뺀 출력 모드 */
export const MONO_MODES = Object.freeze(['gray-oil', 'thermal', 'gray']);
/** 파일에 없어도 알리지 않는 선택 키 (시험 조합). 없으면 기본값·outputMode에서 채운다 */
export const EFFECT_OPTIONAL_KEYS = Object.freeze(['oil', 'monoMode']);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

// 붓 층: [굵기px, 간격px, 길이px, 색 밉 단계, 세부 문턱, 불투명도] — 불투명도는 유화에서 쓰지 않는다(원본도 같음)
const isLayer = (layer) => Array.isArray(layer) && layer.length >= 5 && layer.length <= 6
  && layer.every(isFiniteNumber) && layer[0] > 0 && layer[1] > 0 && layer[2] > 0 && layer[3] >= 0 && layer[4] >= 0;
// 보완 층: [굵기px, 칸 간격px, 길이px, 기준 이미지 밉 단계, 오차 문턱]
const isRefine = (refine) => Array.isArray(refine) && refine.length === 5 && refine.every(isFiniteNumber)
  && refine[0] > 0 && refine[1] > 0 && refine[2] > 0 && refine[3] >= 0;

/**
 * 효과 설정을 검사해 항상 쓸 수 있는 값으로 만든다.
 * - 숫자가 아니거나 없는 항목은 그 항목만 기본값으로 바꾼다. 범위 밖 값은 범위 안으로 맞춘다.
 * - fps는 정수로, 용지 점 수는 8의 배수로 반올림한다. 출력 모드·점 방식은 목록에 없으면 기본값.
 * - 붓 층·보완 층은 모양이 맞지 않으면 기본값. 보완 층 오차 문턱만 범위로 맞춘다. refine이 null이면 보완 층 없음.
 * @returns {{ settings: object, issues: string[] }} issues는 바꾼 항목 설명 (운영자 확인용)
 */
export function normalizeEffectSettings(input, defaults) {
  const source = input !== null && typeof input === 'object' ? input : {};
  const issues = [];

  const number = (key, { min, max }, round = (v) => v) => {
    const value = source[key];
    if (!isFiniteNumber(value)) {
      issues.push(`${key}: ${value === undefined ? 'missing' : 'not a number'} -> default`);
      return defaults[key];
    }
    const adjusted = round(clamp(value, min, max));
    if (adjusted !== value) issues.push(`${key}: ${value} -> ${adjusted}`);
    return adjusted;
  };

  const oneOf = (key, allowed) => {
    const value = source[key];
    if (allowed.includes(value)) return value;
    issues.push(`${key}: ${value === undefined ? 'missing' : JSON.stringify(value)} -> default`);
    return defaults[key];
  };

  let layers = defaults.layers;
  if (source.layers === undefined) issues.push('layers: missing -> default');
  else if (!Array.isArray(source.layers) || source.layers.length === 0 || !source.layers.every(isLayer)) {
    issues.push('layers: invalid -> default');
  } else layers = source.layers;

  let refine = defaults.refine;
  if (source.refine === undefined) issues.push('refine: missing -> default');
  else if (source.refine === null) refine = null;
  else if (!isRefine(source.refine)) issues.push('refine: invalid -> default');
  else {
    const { min, max } = effectLimits.refineThreshold;
    const threshold = clamp(source.refine[4], min, max);
    if (threshold !== source.refine[4]) issues.push(`refine threshold: ${source.refine[4]} -> ${threshold}`);
    refine = [...source.refine.slice(0, 4), threshold];
  }

  // 시험 조합: 유화 켬/끔. 없으면 기본값(알리지 않음), 참·거짓이 아니면 기본값(알림)
  let oil = defaults.oil ?? true;
  if (typeof source.oil === 'boolean') oil = source.oil;
  else if (source.oil !== undefined) issues.push(`oil: ${JSON.stringify(source.oil)} -> default`);
  const outputMode = oneOf('outputMode', OUTPUT_MODES);
  // 흑백 방식: 출력 모드가 흑백이면 늘 그 값(파일에 다른 값이 있어도 출력 모드가 기준). 컬러('off')면 기억해 둔 값, 없거나 틀리면 기본값
  let monoMode = MONO_MODES.includes(defaults.monoMode) ? defaults.monoMode : 'gray-oil';
  if (outputMode !== 'off') monoMode = outputMode;
  else if (MONO_MODES.includes(source.monoMode)) monoMode = source.monoMode;
  else if (source.monoMode !== undefined) issues.push(`monoMode: ${JSON.stringify(source.monoMode)} -> default`);

  const settings = Object.freeze({
    strength: number('strength', effectLimits.strength),
    size: number('size', effectLimits.size),
    boil: number('boil', effectLimits.boil),
    fps: number('fps', effectLimits.fps, Math.round),
    grade: number('grade', effectLimits.grade),
    layers: Object.freeze(layers.map((layer) => Object.freeze([...layer]))),
    refine: refine === null ? null : Object.freeze([...refine]),
    previewScale: number('previewScale', effectLimits.previewScale),
    outputMode,
    dither: oneOf('dither', DITHER_METHODS),
    brightness: number('brightness', effectLimits.brightness),
    contrast: number('contrast', effectLimits.contrast),
    gamma: number('gamma', effectLimits.gamma),
    paperDots: number('paperDots', effectLimits.paperDots, (v) => Math.round(v / 8) * 8),
    bwStyle: oneOf('bwStyle', BW_STYLES),
    bwTexture: number('bwTexture', effectLimits.bwTexture),
    lineSpacing: number('lineSpacing', effectLimits.lineSpacing),
    oil,
    monoMode,
  });
  return { settings, issues };
}

export const EFFECT_SETTINGS_VERSION = 1;

/**
 * 운영자 조절 화면(E)에서 바꾸고 파일에 저장하는 값. 원본 갤러리 UI에 있는 것 + 미리보기 처리 해상도 + 출력 단계(6-1) + 흑백 스타일(7-1)
 */
export const EFFECT_TUNABLE_KEYS = Object.freeze([
  'strength', 'size', 'boil', 'fps', 'grade', 'refineThreshold', 'previewScale',
  'outputMode', 'dither', 'brightness', 'contrast', 'gamma', 'paperDots',
  'bwStyle', 'bwTexture', 'lineSpacing', 'oil', 'monoMode',
]);

/** 정규화된 설정에서 조절값만 꺼낸다. 보완 층이 없으면 refineThreshold는 null */
export function effectTunables(settings) {
  return {
    strength: settings.strength,
    size: settings.size,
    boil: settings.boil,
    fps: settings.fps,
    grade: settings.grade,
    refineThreshold: settings.refine ? settings.refine[4] : null,
    previewScale: settings.previewScale,
    outputMode: settings.outputMode,
    dither: settings.dither,
    brightness: settings.brightness,
    contrast: settings.contrast,
    gamma: settings.gamma,
    paperDots: settings.paperDots,
    bwStyle: settings.bwStyle,
    bwTexture: settings.bwTexture,
    lineSpacing: settings.lineSpacing,
    oil: settings.oil,
    monoMode: settings.monoMode,
  };
}

/** 시험 조합 (WISHFUL 시안): 유화 켬/끔, 흑백 켬/끔(출력 모드가 컬러 'off'가 아님) */
export function effectCombo(settings) {
  return { oil: settings.oil !== false, mono: settings.outputMode !== 'off' };
}

/**
 * 시험 조합을 바꾸는 조절값 조각 (applyEffectTunables에 넘긴다). 주지 않은 쪽은 지금 값 그대로.
 * 흑백을 끄면 지금 흑백 방식을 monoMode에 남기고 outputMode = 'off', 켜면 outputMode = monoMode. 유화 수치는 건드리지 않는다
 */
export function comboTunables(settings, { oil, mono } = {}) {
  const now = effectCombo(settings);
  const monoMode = settings.outputMode !== 'off' ? settings.outputMode : settings.monoMode;
  const nextMono = mono ?? now.mono;
  return { oil: oil ?? now.oil, monoMode, outputMode: nextMono ? monoMode : 'off' };
}

/**
 * base 설정(정규화된 것)에 조절값을 덮어 정규화한다. tunables에 없는 키는 base 값을 그대로 쓴다.
 * @returns {{ settings: object, issues: string[] }}
 */
export function applyEffectTunables(base, tunables, defaults) {
  const input = { ...base };
  for (const key of EFFECT_TUNABLE_KEYS) {
    if (key === 'refineThreshold' || !(key in tunables)) continue;
    input[key] = tunables[key];
  }
  if (base.refine && 'refineThreshold' in tunables) input.refine = [...base.refine.slice(0, 4), tunables.refineThreshold];
  return normalizeEffectSettings(input, defaults);
}

export function serializeEffectSettings(settings) {
  return JSON.stringify({ version: EFFECT_SETTINGS_VERSION, settings: effectTunables(settings) }, null, 2);
}

/**
 * 저장된 문자열을 읽는다. 어떤 값이 들어 있어도 예외를 던지지 않는다. 없는 키는 기본값으로 채우고 issues에 남긴다.
 * @returns {{ settings: object, issues: string[], source: 'stored' | 'default' }}
 */
export function parseStoredEffectSettings(text, defaults) {
  const base = normalizeEffectSettings(defaults, defaults).settings;
  const fallback = (issue) => ({ settings: base, issues: issue ? [issue] : [], source: 'default' });
  if (text === null || text === undefined) return fallback(null);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fallback('stored value is not valid JSON -> defaults');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return fallback('stored value is not an object -> defaults');
  if (parsed.version !== EFFECT_SETTINGS_VERSION) {
    return fallback(`stored version ${JSON.stringify(parsed.version)} != ${EFFECT_SETTINGS_VERSION} -> defaults`);
  }
  const stored = parsed.settings !== null && typeof parsed.settings === 'object' ? parsed.settings : {};
  const missing = EFFECT_TUNABLE_KEYS.filter((key) => !(key in stored) && !EFFECT_OPTIONAL_KEYS.includes(key))
    .map((key) => `${key}: missing -> default`);
  const { settings, issues } = applyEffectTunables(base, stored, defaults);
  return { settings, issues: [...missing, ...issues], source: 'stored' };
}

export function sameEffectSettings(a, b) {
  return JSON.stringify(effectTunables(a)) === JSON.stringify(effectTunables(b));
}
