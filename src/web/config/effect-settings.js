// 사진 효과 "유화 · 획 (세부 보존)" 설정값의 범위와 정규화.
// 브라우저 API를 쓰지 않는다. 조절 화면·파일 저장은 5-2 범위이고, 지금은 코드에서 바꾼 값을 검사하는 데 쓴다.
// Node 테스트: test/config/effect-settings.test.mjs
//
// 강도·크기·획 다시 그리기·초당 그림·색 보정의 범위는 원본 필터 갤러리
// (https://nau-filter-gallery.vercel.app/, 프리셋 oil2f)의 슬라이더 범위와 같다.
// 붓 층·보완 층 단위는 docs/SYSTEM.md 6절 "사진 효과(유화 · 획)".

export const effectLimits = Object.freeze({
  strength: Object.freeze({ min: 0, max: 1.6, step: 0.05 }), // 강도: 요철·광택·색 흔들림
  size: Object.freeze({ min: 0.6, max: 1.8, step: 0.05 }), // 붓 크기 배율: 획 굵기·간격·길이에 곱한다
  boil: Object.freeze({ min: 0, max: 1, step: 0.05 }), // 획 다시 그리기: 그림마다 새로 배치하는 획 비율
  fps: Object.freeze({ min: 2, max: 30, step: 1 }), // 초당 그림 수
  grade: Object.freeze({ min: 0, max: 1, step: 0.05 }), // 색 보정 섞는 정도
  // 보완 층 오차 문턱 (0~1 RGB 거리). 셰이더에서 0은 "보완 층 아님"이라 0이 되지 않게 한다. 끄려면 refine을 null로
  refineThreshold: Object.freeze({ min: 0.01, max: 1, step: 0.01 }),
  previewScale: Object.freeze({ min: 0.25, max: 1, step: 0.05 }), // 미리보기 처리 해상도 배율 (보이는 9:16 영역 원본 대비)
});

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
 * - fps는 정수로 반올림한다.
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
  });
  return { settings, issues };
}
