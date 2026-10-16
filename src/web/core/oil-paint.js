// 사진 효과 "유화 · 획 (세부 보존)"의 순수 계산: 획 목록, 해상도 비례 규칙, 그림 번호(tick)·seed.
// DOM·WebGL을 쓰지 않는다. Node 테스트: test/core/oil-paint.test.mjs
//
// 출처: 같은 팀 동료가 만든 재료 필터 갤러리 https://nau-filter-gallery.vercel.app/ 프리셋 `oil2f`. 배포 페이지에서 이식했다(원본 소스 저장소는 받지 못함). 원본이 바뀌면 다시 분석·비교한다 (docs/SYSTEM.md 6절)
//   (원본 ihash·makeStrokes·paintStrokes의 매개변수 계산·currentTick을 옮겼다. 2026-10-16 받은 페이지 기준)
// 기법: Hertzmann 1998, "Painterly Rendering with Curved Brush Strokes of Multiple Sizes" (SIGGRAPH 98)의
//   큰 붓 → 작은 붓 층 칠하기와, 칠한 결과가 원본과 많이 다른 곳에만 가는 붓을 더하는 보완 층. 원본 주석에 출처 표기.
// 자세한 패스 구조와 매개변수 단위는 docs/SYSTEM.md 6절 "사진 효과(유화 · 획)".

/** 원본이 처리하는 해상도의 짧은 변(px). 원본은 소스와 관계없이 짧은 변을 1080으로 맞춰 그린다. px 매개변수는 이 기준이다. */
export const REFERENCE_SHORT_SIDE = 1080;

/** 보완 층의 seed 층 번호는 붓 층 다음 번호다 (원본 `makeStrokes(P.layers.length, ...)`). */
const SEED_BASE = 1000;
const SEED_LAYER_STEP = 97;
const SEED_DRAWING_STEP = 7919;
/** seed = tick % 997 (원본 frame()) */
const SEED_PERIOD = 997;

/** 정수 → 0~1. 같은 입력이면 항상 같은 값 (원본 ihash 그대로) */
export function ihash(a, b, c) {
  let h = (a * 374761393 + b * 668265263 + c * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 획 seed 층 기준값 (원본 `base = 1000 + li * 97`) */
export function layerSeedBase(layer) {
  return SEED_BASE + layer * SEED_LAYER_STEP;
}

/** 이 그림(seed)에서 다시 배치되는 획의 seed (원본 `base + (state.seed + 1) * 7919`) */
export function drawingSeed(layer, seed) {
  return layerSeedBase(layer) + (seed + 1) * SEED_DRAWING_STEP;
}

/** i번 획이 그림마다 다시 배치되는지. boil 비율만큼 (원본 `ihash(i, base, 1) < boil`) */
export function isBoilingStroke(index, layer, boil) {
  return ihash(index, layerSeedBase(layer), 1) < boil;
}

/**
 * 획 목록을 만든다. 칸(spacing px 격자)마다 획 하나: 위치는 칸 안에서 흔들고 그리는 순서는 섞는다.
 * 획마다 [중심 x(0~1), 중심 y(0~1), 난수 z, 난수 w]이고, 그리는 순서 열쇠(ihash 6번, float32) 순으로 놓는다.
 * boil 비율의 획은 그림(seed)마다 새 위치·난수·순서를 쓰고, 나머지는 그림과 상관없이 고정이다.
 *
 * 원본처럼 고정 획은 한 번만 만들어 정렬해 두고(캐시), 그림마다 바뀌는 획만 새로 만들어 정렬한 뒤 합친다.
 * 결과는 모든 획을 새로 만들어 (열쇠, 번호) 순으로 정렬한 것과 같다 (테스트로 확인).
 * 돌려주는 data는 다음 build 호출 때 다시 쓰는 버퍼일 수 있다. 바로 GPU에 올리고 들고 있지 않는다.
 */
export function createStrokeBuilder({ maxCacheEntries = 16 } = {}) {
  const cache = new Map();

  function cached(layer, spacing, width, height, boil) {
    const key = `${layer}|${spacing}|${width}|${height}|${boil}`;
    let entry = cache.get(key);
    if (entry) return entry;
    const gw = Math.ceil(width / spacing);
    const gh = Math.ceil(height / spacing);
    const n = gw * gh;
    const base = layerSeedBase(layer);
    const fixed = [];
    const vary = [];
    for (let i = 0; i < n; i += 1) (ihash(i, base, 1) >= boil ? fixed : vary).push(i);
    const m = fixed.length;
    const d = new Float32Array(m * 4);
    const k = new Float32Array(m);
    const ord = new Uint32Array(m);
    for (let j = 0; j < m; j += 1) {
      k[j] = put(fixed[j], base, d, j * 4, gw, spacing, width, height);
      ord[j] = j;
    }
    ord.sort((a, b) => k[a] - k[b] || a - b);
    const F = { data: new Float32Array(m * 4), key: new Float32Array(m), id: new Uint32Array(m) };
    for (let j = 0; j < m; j += 1) {
      const s = ord[j];
      F.key[j] = k[s];
      F.id[j] = fixed[s];
      for (let c = 0; c < 4; c += 1) F.data[j * 4 + c] = d[s * 4 + c];
    }
    entry = { F, vary: Uint32Array.from(vary), out: new Float32Array(n * 4), n, gw };
    cache.set(key, entry);
    if (cache.size > maxCacheEntries) cache.delete(cache.keys().next().value);
    return entry;
  }

  /**
   * @param {{ layer: number, spacing: number, width: number, height: number, boil: number, seed: number }} options
   *   spacing·width·height는 같은 단위(그리는 해상도 px). seed는 그림 seed(0~996)
   * @returns {{ data: Float32Array, n: number }}
   */
  function build({ layer, spacing, width, height, boil, seed }) {
    const { F, vary, out, n, gw } = cached(layer, spacing, width, height, boil);
    const m = vary.length;
    if (!m) return { data: F.data, n };
    const sd = drawingSeed(layer, seed);
    const vd = new Float32Array(m * 4);
    const vk = new Float32Array(m);
    const vo = new Uint32Array(m);
    for (let j = 0; j < m; j += 1) {
      vk[j] = put(vary[j], sd, vd, j * 4, gw, spacing, width, height);
      vo[j] = j;
    }
    vo.sort((a, b) => vk[a] - vk[b] || a - b);
    // 정렬된 두 목록을 열쇠(같으면 번호) 순으로 합친다
    for (let a = 0, b = 0, o = 0; o < n; o += 1) {
      const useF = b >= m || (a < F.key.length && (F.key[a] < vk[vo[b]] || (F.key[a] === vk[vo[b]] && F.id[a] < vary[vo[b]])));
      if (useF) {
        for (let c = 0; c < 4; c += 1) out[o * 4 + c] = F.data[a * 4 + c];
        a += 1;
      } else {
        const s = vo[b];
        for (let c = 0; c < 4; c += 1) out[o * 4 + c] = vd[s * 4 + c];
        b += 1;
      }
    }
    return { data: out, n };
  }

  return { build, cacheSize: () => cache.size };
}

/** i번 획 → d[o..o+3]. 돌려주는 값 = 그리는 순서 열쇠(float32). 원본 put 그대로 */
function put(i, sd, d, o, gw, spacing, width, height) {
  d[o] = ((i % gw) + ihash(i, sd, 2)) * spacing / width;
  d[o + 1] = (Math.floor(i / gw) + ihash(i, sd, 3)) * spacing / height;
  d[o + 2] = ihash(i, sd, 4);
  d[o + 3] = ihash(i, sd, 5);
  return Math.fround(ihash(i, sd, 6));
}

// ---- 해상도 비례 ----
// 원본의 px 매개변수(획 굵기·간격·길이, 캔버스 결)는 짧은 변 1080px 그림 기준이다.
// 다른 해상도(미리보기 축소, 4K 캡처)에서 같은 그림이 되도록 다음과 같이 맞춘다. s = 짧은 변 / 1080.
// - 길이(px): × s. 획 간격도 같이 줄어 칸 수(획 수)는 해상도와 관계없이 같다.
// - 밉 단계(색을 얼마나 흐린 곳에서 읽는지): + log2(s). 같은 크기의 영역을 평균한다.
// - 붓털 무늬 주기: 획 안 좌표 기준이라 기준 해상도 값(× s 하지 않은 값)을 쓴다.
// - 높이 → 법선 세기: 한 칸(텍셀) 차이로 기울기를 재므로 × s.
// - 흐름장(구조 텐서)은 그리는 해상도의 절반에서 텍셀 단위로 재므로 따로 바꾸지 않아도 비례한다.

/**
 * 결과(촬영 사진) 크기: 원본 allocate()처럼 짧은 변을 기준(1080)으로 맞추고 짝수로 반올림한다.
 * 보이는 영역이 4K(2160x3840)여도 1080x1920으로 줄여 효과를 입힌다 (사용자 결정 2026-10-16).
 * 미리보기는 이 크기 × previewScale로 그린다. 1이면 미리보기와 결과가 같은 크기·같은 그림이다.
 */
export function resultSizeFor(width, height, referenceShortSide = REFERENCE_SHORT_SIDE) {
  const sc = referenceShortSide / Math.min(width, height);
  return { width: Math.round((width * sc) / 2) * 2, height: Math.round((height * sc) / 2) * 2 };
}

/** 그리는 해상도의 px 비례값 s (짧은 변 / 기준 짧은 변) */
export function pxScaleFor(width, height, referenceShortSide = REFERENCE_SHORT_SIDE) {
  return Math.min(width, height) / referenceShortSide;
}

/**
 * 정규화된 효과 설정(config/effect-settings.js)과 그리는 해상도로 패스마다 쓸 값을 만든다.
 * 기준 해상도(s = 1)에서는 원본과 같은 값이다.
 * @param {{ strength: number, size: number, boil: number, grade: number,
 *   layers: number[][], refine: number[] | null }} settings
 * @param {{ width: number, height: number, referenceShortSide?: number }} target
 */
export function resolveOilDrawing(settings, { width, height, referenceShortSide = REFERENCE_SHORT_SIDE }) {
  const s = pxScaleFor(width, height, referenceShortSide);
  const sz = settings.size;
  const lodShift = Math.log2(s);
  const brush = ([wid, sp, len, lod], layer) => ({
    layer,
    spacing: sp * sz * s,
    length: len * sz * s,
    width: wid * sz * s,
    lod: lod + lodShift,
    brisLength: len * sz,
    brisWidth: wid * sz,
  });
  const layers = settings.layers.map((L, li) => ({ ...brush(L, li), detailMin: L[4] }));
  let refine = null;
  if (settings.refine) {
    const [, sp, , , errT] = settings.refine;
    refine = { ...brush(settings.refine, settings.layers.length), errorThreshold: errT, cell: sp * sz * s };
  }
  return Object.freeze({
    width,
    height,
    pxScale: s,
    flowWidth: Math.round(width / 2),
    flowHeight: Math.round(height / 2),
    flowSigma: 2.5,
    grade: settings.grade,
    boil: settings.boil,
    underLod: 4.5 + lodShift,
    jitter: 0.05 * settings.strength,
    layers,
    refine,
    strength: settings.strength,
    relief: settings.strength * s,
  });
}

// ---- 시간 ----

/** 그림 번호. fps = 초당 그림 수. 번호가 바뀔 때만 새로 그린다 (원본 currentTick, 시간은 ms로 받는다) */
export function drawingTick(nowMs, fps) {
  return Math.floor((nowMs / 1000) * fps + 1e-6);
}

/** 그림 seed (원본 `tick % 997`). 음수 tick은 쓰지 않는다 */
export function seedForTick(tick) {
  return ((tick % SEED_PERIOD) + SEED_PERIOD) % SEED_PERIOD;
}
