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
//     "outputMode", "dither", "brightness", "contrast", "gamma", "paperDots" } }
// 운영자가 조절하는 값(EFFECT_TUNABLE_KEYS)만 저장한다. 붓 층 모양 등은 config.effect 기본값을 쓴다.
// 출력 단계 값 6개는 6-1에서 더했다. 버전은 1 그대로이고, 5-2 파일(앞 7개만)을 읽으면 없는 값은 기본값(감열지)으로 채운다.

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
});

/** 출력 모드: 감열지(1비트 점) / 회색조만 / 끔(컬러 유화) */
export const OUTPUT_MODES = Object.freeze(['thermal', 'gray', 'off']);
/** 점 방식: 문턱값(GPU·CPU 같은 결과) 2개, 오차 확산(CPU) 2개 */
export const DITHER_METHODS = Object.freeze(['blue-noise', 'bayer', 'atkinson', 'floyd-steinberg']);

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

  const settings = Object.freeze({
    strength: number('strength', effectLimits.strength),
    size: number('size', effectLimits.size),
    boil: number('boil', effectLimits.boil),
    fps: number('fps', effectLimits.fps, Math.round),
    grade: number('grade', effectLimits.grade),
    layers: Object.freeze(layers.map((layer) => Object.freeze([...layer]))),
    refine: refine === null ? null : Object.freeze([...refine]),
    previewScale: number('previewScale', effectLimits.previewScale),
    outputMode: oneOf('outputMode', OUTPUT_MODES),
    dither: oneOf('dither', DITHER_METHODS),
    brightness: number('brightness', effectLimits.brightness),
    contrast: number('contrast', effectLimits.contrast),
    gamma: number('gamma', effectLimits.gamma),
    paperDots: number('paperDots', effectLimits.paperDots, (v) => Math.round(v / 8) * 8),
  });
  return { settings, issues };
}

export const EFFECT_SETTINGS_VERSION = 1;

/** 운영자 조절 화면(E)에서 바꾸고 파일에 저장하는 값. 원본 갤러리 UI에 있는 것 + 미리보기 처리 해상도 + 출력 단계(6-1) */
export const EFFECT_TUNABLE_KEYS = Object.freeze([
  'strength', 'size', 'boil', 'fps', 'grade', 'refineThreshold', 'previewScale',
  'outputMode', 'dither', 'brightness', 'contrast', 'gamma', 'paperDots',
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
  };
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
  const missing = EFFECT_TUNABLE_KEYS.filter((key) => !(key in stored)).map((key) => `${key}: missing -> default`);
  const { settings, issues } = applyEffectTunables(base, stored, defaults);
  return { settings, issues: [...missing, ...issues], source: 'stored' };
}

export function sameEffectSettings(a, b) {
  return JSON.stringify(effectTunables(a)) === JSON.stringify(effectTunables(b));
}
