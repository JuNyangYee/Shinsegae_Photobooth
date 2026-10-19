// 감열지 흑백 출력 단계의 순수 계산 (6-1): 회색조·레벨, 인쇄 해상도, 면적 평균 축소, 1비트 디더링, 인쇄용 비트·1비트 PNG.
// 브라우저 API를 쓰지 않는다 (PNG 압축 함수는 주입받는다). Node 테스트: test/core/thermal.test.mjs
//
// 감열지는 흰 바탕에 검은 점(1비트)으로 찍힌다. 화면에 보이는 점 이미지가 곧 인쇄 데이터다 (docs/SYSTEM.md 6절 "출력 단계").
// 처리 순서: 합성 결과 → 회색조 → 밝기·대비·감마 → 인쇄 해상도로 면적 평균 축소 → 8비트 회색 → 1비트 디더링.
// GPU 셰이더(effect/oil-shaders.js FS_THERMAL_*)도 같은 순서·같은 식이다. 문턱값 디더(bayer·blue-noise)는
// 8비트 회색과 8비트 문턱의 정수 비교라 GPU와 CPU 결과가 비트 단위로 같다.
//
// 마스크(mask): 인쇄 해상도의 1바이트/점 배열, 위 줄부터. 1 = 흰 점(종이), 0 = 검은 점(잉크).

// 회색조 가중치 (Rec.601. 셰이더의 lum()과 같다)
const LUMA = [0.299, 0.587, 0.114];

/**
 * 회색조 값(0~1)에 대비 → 밝기 → 감마를 적용한다. 셰이더 levels()와 같은 식.
 * contrast: 0.5 기준을 중심으로 늘리는 배율, brightness: 더하는 값, gamma: 1보다 크면 중간 밝기를 밝게.
 */
export function applyLevels(gray, { brightness, contrast, gamma }) {
  const v = Math.min(1, Math.max(0, (gray - 0.5) * contrast + 0.5 + brightness));
  return v ** (1 / gamma);
}

/** RGB(0~255) → 회색조(0~1) → 레벨 */
export function levelOf(r, g, b, levels) {
  return applyLevels((LUMA[0] * r + LUMA[1] * g + LUMA[2] * b) / 255, levels);
}

/**
 * 인쇄 해상도: 가로 = 용지 점 수(80mm 576, 58mm 384), 세로 = 결과 사진 비율 그대로 (9:16이면 576 → 1024).
 * 가로는 8의 배수라야 한다(한 바이트에 8점, 프린터 래스터 형식).
 */
export function printSizeFor(paperDots, resultWidth, resultHeight) {
  if (!(Number.isInteger(paperDots) && paperDots > 0 && paperDots % 8 === 0)) throw new Error(`paper dots must be a multiple of 8: ${paperDots}`);
  return { width: paperDots, height: Math.max(1, Math.round((paperDots * resultHeight) / resultWidth)) };
}

// 면적 평균 가중치: 출력 칸 i가 덮는 원본 구간 [i·s, (i+1)·s)와 원본 칸 [k, k+1)의 겹친 길이 (s = 원본/출력)
function areaSpans(srcN, dstN) {
  const s = srcN / dstN;
  const spans = [];
  for (let i = 0; i < dstN; i += 1) {
    const a = i * s;
    const b = (i + 1) * s;
    const k0 = Math.floor(a);
    const k1 = Math.min(Math.ceil(b), srcN);
    const weights = [];
    for (let k = k0; k < k1; k += 1) weights.push(Math.min(b, k + 1) - Math.max(a, k));
    const sum = weights.reduce((t, w) => t + w, 0);
    spans.push({ start: k0, weights: weights.map((w) => w / sum) });
  }
  return spans;
}

/**
 * RGBA(위 줄부터, W×H) → 회색조·레벨 → 인쇄 해상도(Pw×Ph)로 면적 평균 → 8비트 회색(위 줄부터).
 * GPU 경로(FS_THERMAL_REDUCE)와 같은 계산이지만 부동소수점 순서가 달라 1 정도 다를 수 있다. 효과를 그리지 못해
 * 원본 사진으로 대신할 때(photo-effect.js) 쓴다.
 */
export function reduceToPrintGray(rgba, W, H, Pw, Ph, levels) {
  const xs = areaSpans(W, Pw);
  const ys = areaSpans(H, Ph);
  const rows = new Float32Array(Pw * H); // 가로만 줄인 회색
  const line = new Float32Array(W);
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      line[x] = levelOf(rgba[i], rgba[i + 1], rgba[i + 2], levels);
    }
    for (let px = 0; px < Pw; px += 1) {
      const { start, weights } = xs[px];
      let sum = 0;
      for (let k = 0; k < weights.length; k += 1) sum += line[start + k] * weights[k];
      rows[y * Pw + px] = sum;
    }
  }
  const gray = new Uint8Array(Pw * Ph);
  for (let py = 0; py < Ph; py += 1) {
    const { start, weights } = ys[py];
    for (let px = 0; px < Pw; px += 1) {
      let sum = 0;
      for (let k = 0; k < weights.length; k += 1) sum += rows[(start + k) * Pw + px] * weights[k];
      gray[py * Pw + px] = Math.round(Math.min(1, Math.max(0, sum)) * 255);
    }
  }
  return gray;
}

/** RGBA를 같은 크기의 회색조·레벨 RGBA로 바꾼다 (제자리). 회색조 모드에서 원본 사진으로 대신할 때 */
export function grayLevelsInPlace(rgba, levels) {
  for (let i = 0; i < rgba.length; i += 4) {
    const v = Math.round(levelOf(rgba[i], rgba[i + 1], rgba[i + 2], levels) * 255);
    rgba[i] = v;
    rgba[i + 1] = v;
    rgba[i + 2] = v;
  }
  return rgba;
}

// ---------- 문턱값 디더 (GPU와 같은 결과) ----------

/** 순서 디더 Bayer 행렬 (n은 2의 거듭제곱). 값은 0..n²-1 순위, 위 줄부터 */
export function bayerRanks(n) {
  if (n === 1) return new Uint16Array([0]);
  const half = bayerRanks(n / 2);
  const h = n / 2;
  const out = new Uint16Array(n * n);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < h; x += 1) {
      const v = half[y * h + x] * 4;
      out[y * n + x] = v;
      out[y * n + x + h] = v + 2;
      out[(y + h) * n + x] = v + 3;
      out[(y + h) * n + x + h] = v + 1;
    }
  }
  return out;
}

// 결정적인 의사 난수 (mulberry32). 블루 노이즈 처음 배치에만 쓴다
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 블루 노이즈 문턱 순위 (void-and-cluster, Ulichney 1993). size×size, 값은 0..size²-1 순위, 위 줄부터. 가장자리는 이어진다(타일).
 * 같은 size·sigma·seed면 늘 같은 결과다 (처음 배치는 고정 seed 의사 난수, 같은 값이면 앞 번호를 고른다).
 * 64×64는 개발 PC에서 약 0.1초 걸린다. 같은 인자는 한 번만 만든다.
 */
export function blueNoiseRanks(size = 64, { sigma = 1.5, seed = 1 } = {}) {
  const key = `${size}/${sigma}/${seed}`;
  if (blueNoiseCache.has(key)) return blueNoiseCache.get(key);
  const N = size * size;
  const kernel = new Float64Array(N); // 토러스 거리의 가우스 에너지 (dx, dy)
  for (let dy = 0; dy < size; dy += 1) {
    for (let dx = 0; dx < size; dx += 1) {
      const ax = Math.min(dx, size - dx);
      const ay = Math.min(dy, size - dy);
      kernel[dy * size + dx] = Math.exp(-(ax * ax + ay * ay) / (2 * sigma * sigma));
    }
  }
  const energy = new Float64Array(N);
  const on = new Uint8Array(N);
  const toggle = (p, sign) => {
    const px = p % size;
    const py = (p - px) / size;
    on[p] = sign > 0 ? 1 : 0;
    for (let y = 0; y < size; y += 1) {
      const krow = ((y - py + size) % size) * size;
      const row = y * size;
      // x - px를 나머지 없이 두 구간으로
      for (let x = 0; x < px; x += 1) energy[row + x] += sign * kernel[krow + x - px + size];
      for (let x = px; x < size; x += 1) energy[row + x] += sign * kernel[krow + x - px];
    }
  };
  const tightestCluster = () => { // 켜진 점 중 에너지가 가장 큰 곳
    let best = -1;
    for (let p = 0; p < N; p += 1) if (on[p] && (best < 0 || energy[p] > energy[best])) best = p;
    return best;
  };
  const largestVoid = () => { // 꺼진 점 중 에너지가 가장 작은 곳
    let best = -1;
    for (let p = 0; p < N; p += 1) if (!on[p] && (best < 0 || energy[p] < energy[best])) best = p;
    return best;
  };

  // 처음 배치: 10%를 의사 난수로 켜고, 가장 뭉친 점을 가장 빈 곳으로 옮기기를 더 바뀌지 않을 때까지
  const rng = mulberry32(seed);
  const initial = Math.max(1, Math.floor(N / 10));
  for (let placed = 0; placed < initial;) {
    const p = Math.floor(rng() * N);
    if (on[p]) continue;
    toggle(p, 1);
    placed += 1;
  }
  for (let guard = 0; guard < N; guard += 1) {
    const c = tightestCluster();
    toggle(c, -1);
    const v = largestVoid();
    toggle(v, 1);
    if (v === c) break;
  }
  const protoOn = on.slice();
  const protoEnergy = energy.slice();
  const ranks = new Uint16Array(N);

  // 1단계: 처음 배치에서 가장 뭉친 점부터 빼며 높은 순위부터 매긴다
  for (let r = initial - 1; r >= 0; r -= 1) {
    const c = tightestCluster();
    toggle(c, -1);
    ranks[c] = r;
  }
  // 2·3단계: 처음 배치로 돌아가 가장 빈 곳부터 채운다 (꺼진 점의 뭉침 = 켜진 점 에너지의 최소, 같은 식)
  on.set(protoOn);
  energy.set(protoEnergy);
  for (let r = initial; r < N; r += 1) {
    const v = largestVoid();
    toggle(v, 1);
    ranks[v] = r;
  }
  blueNoiseCache.set(key, ranks);
  return ranks;
}
const blueNoiseCache = new Map();

export const BAYER_SIZE = 8;
export const BLUE_NOISE_SIZE = 64;

/**
 * 문턱 지도: 순위 r(0..N-1) → 8비트 문턱 t = 1 + floor(r·255/N) (1..255). 회색 g(0..255)가 t 이상이면 흰 점.
 * 그래서 흰 점 비율은 ceil(g·N/255)/N ≈ g/255이고, 0은 모두 검정, 255는 모두 흰색이다.
 * @returns {{ size: number, thresholds: Uint8Array }} thresholds는 위 줄부터 size×size
 */
export function thresholdMap(method) {
  if (thresholdCache.has(method)) return thresholdCache.get(method);
  let size;
  let ranks;
  if (method === 'bayer') {
    size = BAYER_SIZE;
    ranks = bayerRanks(size);
  } else if (method === 'blue-noise') {
    size = BLUE_NOISE_SIZE;
    ranks = blueNoiseRanks(size);
  } else {
    throw new Error(`no threshold map for ${method}`);
  }
  const N = size * size;
  const thresholds = new Uint8Array(N);
  for (let i = 0; i < N; i += 1) thresholds[i] = 1 + Math.floor((ranks[i] * 255) / N);
  const map = Object.freeze({ size, thresholds });
  thresholdCache.set(method, map);
  return map;
}
const thresholdCache = new Map();

/** 문턱값 디더: 점 (x, y)는 gray >= thresholds[(y % n)·n + x % n]이면 흰 점. GPU FS_THERMAL_DITHER와 같다 */
export function ditherThreshold(gray, w, h, { size, thresholds }) {
  const mask = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    const trow = (y % size) * size;
    for (let x = 0; x < w; x += 1) {
      const i = y * w + x;
      mask[i] = gray[i] >= thresholds[trow + (x % size)] ? 1 : 0;
    }
  }
  return mask;
}

// ---------- 오차 확산 (CPU 순차) ----------

/**
 * 오차 확산 디더. 128 이상이면 흰 점, 오차를 이웃에 나눈다(화면 밖은 버림). Float32 계산이라 같은 입력이면 늘 같은 결과다.
 * - floyd-steinberg: 7/16 앞, 3/16 아래 뒤, 5/16 아래, 1/16 아래 앞. 줄마다 방향을 바꾼다(serpentine, 지렁이 무늬 줄임)
 * - atkinson: 오차의 6/8만 1/8씩 앞 2칸·아래 3칸·두 줄 아래 1칸. 대비가 강하고 밝은·어두운 끝이 잘 날아간다 (감열지·초기 Mac)
 * @param {Float32Array} [work] w·h 크기 작업 버퍼 (미리보기에서 그림마다 새로 만들지 않게)
 */
export function ditherErrorDiffusion(gray, w, h, method, work) {
  const buf = work && work.length >= w * h ? work : new Float32Array(w * h);
  for (let i = 0; i < w * h; i += 1) buf[i] = gray[i];
  const mask = new Uint8Array(w * h);
  if (method === 'floyd-steinberg') {
    for (let y = 0; y < h; y += 1) {
      const ltr = (y & 1) === 0;
      const dir = ltr ? 1 : -1;
      const below = y + 1 < h;
      for (let k = 0; k < w; k += 1) {
        const x = ltr ? k : w - 1 - k;
        const i = y * w + x;
        const v = buf[i];
        const white = v >= 128;
        mask[i] = white ? 1 : 0;
        const e = v - (white ? 255 : 0);
        const xf = x + dir;
        const xb = x - dir;
        if (xf >= 0 && xf < w) buf[i + dir] += (e * 7) / 16;
        if (below) {
          const j = i + w;
          if (xb >= 0 && xb < w) buf[j - dir] += (e * 3) / 16;
          buf[j] += (e * 5) / 16;
          if (xf >= 0 && xf < w) buf[j + dir] += e / 16;
        }
      }
    }
  } else if (method === 'atkinson') {
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const i = y * w + x;
        const v = buf[i];
        const white = v >= 128;
        mask[i] = white ? 1 : 0;
        const e = (v - (white ? 255 : 0)) / 8;
        if (x + 1 < w) buf[i + 1] += e;
        if (x + 2 < w) buf[i + 2] += e;
        if (y + 1 < h) {
          const j = i + w;
          if (x > 0) buf[j - 1] += e;
          buf[j] += e;
          if (x + 1 < w) buf[j + 1] += e;
        }
        if (y + 2 < h) buf[i + 2 * w] += e;
      }
    }
  } else {
    throw new Error(`unknown error diffusion: ${method}`);
  }
  return mask;
}

/** 문턱값 디더는 GPU에서도 같은 결과를 낼 수 있다. 오차 확산은 순차라 CPU에서만 한다 */
export const isGpuDither = (method) => method === 'bayer' || method === 'blue-noise';

// ---------- 흑백 스타일 (7-1) ----------

/** 흑백 스타일: 'tone' 톤 점(6-1) / 'texture' 질감 강조 점 / 'flow' 흐름 선 / 'stroke' 붓 결 선. 없으면 'tone' */
export const bwStyleOf = (settings) => settings.bwStyle ?? 'tone';

/**
 * 점을 무엇으로 정하는지(D 화면·결과 표시용): 톤 점·질감 강조 점은 점 방식(dither) 그대로,
 * 흐름 선은 'flow-lines', 붓 결 선은 'stroke-lines'(GPU가 만든 점별 문턱)
 */
export function screenOf(settings) {
  const style = bwStyleOf(settings);
  if (style === 'flow') return 'flow-lines';
  if (style === 'stroke') return 'stroke-lines';
  return settings.dither;
}

/**
 * 점별 문턱 디더: gray[i] >= thr[i]면 흰 점. 흐름 선·붓 결 선의 문턱(GPU FS_THERMAL_SCREEN)을 읽어 GPU 점 그림을
 * 다시 확인할 때 쓴다(GPU FS_THERMAL_DITHER uFull 1과 같은 정수 비교라 비트 단위로 같아야 한다)
 */
export function ditherWithThresholds(gray, thr) {
  const mask = new Uint8Array(gray.length);
  for (let i = 0; i < gray.length; i += 1) mask[i] = gray[i] >= thr[i] ? 1 : 0;
  return mask;
}

/** 방식 이름으로 디더링 (8비트 회색 → 마스크). work는 오차 확산용 작업 버퍼 */
export function dither(gray, w, h, method, work) {
  return isGpuDither(method) ? ditherThreshold(gray, w, h, thresholdMap(method)) : ditherErrorDiffusion(gray, w, h, method, work);
}

// ---------- 인쇄 데이터 ----------

/**
 * 마스크 → 프린터 래스터 비트: 줄마다 ceil(w/8)바이트, 왼쪽 점이 최상위 비트, 1 = 검은 점(ESC/POS GS v 0과 같은 뜻).
 * @returns {{ width: number, height: number, bytesPerRow: number, bits: Uint8Array, black: number }} black: 검은 점 수
 */
export function packPrintBits(mask, w, h) {
  const bytesPerRow = Math.ceil(w / 8);
  const bits = new Uint8Array(bytesPerRow * h);
  let black = 0;
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (mask[y * w + x]) continue;
      bits[y * bytesPerRow + (x >> 3)] |= 0x80 >> (x & 7);
      black += 1;
    }
  }
  return { width: w, height: h, bytesPerRow, bits, black };
}

/** 마스크 → 화면 표시용 RGBA (종이색·잉크색). 인쇄 데이터가 아니라 화면에서 감열지처럼 보이게 하는 색이다 */
export function maskToRgba(mask, paper, ink) {
  const rgba = new Uint8ClampedArray(mask.length * 4);
  for (let i = 0; i < mask.length; i += 1) {
    const c = mask[i] ? paper : ink;
    const o = i * 4;
    rgba[o] = c[0];
    rgba[o + 1] = c[1];
    rgba[o + 2] = c[2];
    rgba[o + 3] = 255;
  }
  return rgba;
}

// ---------- 화면 표시용 확대 (인쇄 데이터와 무관) ----------

/**
 * 한 축의 확대 표: 출력 화소 o(0..D-1)가 덮는 구간 [o, o+1)을 인쇄 점 좌표로 옮겨, 가장 가까운 점 경계 b와
 * 그 경계 오른쪽(b번 점)이 차지하는 비율 w(0..256)를 정수로 구한다. 경계에 걸친 화소만 0 < w < 256이고, 나머지는
 * 한 점 안에 있어 최근접과 같다(정수배 최근접 + 경계 1화소만 보간, "sharp bilinear" 계열).
 * 셰이더 FS_THERMAL_SHOW의 axis()와 같은 정수식이라 GPU와 CPU 결과가 같다.
 *   t = (2o+1)·P / 2D (화소 중심의 점 좌표), b = floor(t + 1/2), w = clamp(((t − b)·D/P + 1/2)·256, 0, 256) 반올림
 */
export function sharpAxis(D, P) {
  const bound = new Int32Array(D);
  const weight = new Int32Array(D);
  for (let o = 0; o < D; o += 1) {
    const T = (2 * o + 1) * P;
    const b = Math.floor((T + D) / (2 * D));
    const num = Math.max(0, T - 2 * D * b + P);
    bound[o] = b;
    weight[o] = Math.min(256, Math.floor((256 * num + P) / (2 * P)));
  }
  return { bound, weight };
}

/**
 * 마스크(Pw×Ph, 위 줄부터, 1 = 흰 점) → 화면 크기(Dw×Dh) RGBA. 종이색·잉크색 사이를 경계 화소만 섞는다.
 * 세로 계산은 셰이더와 같게 GL 방향(아래 원점)으로 하고 위 줄부터 쓴다. 결과 사진의 화면용 이미지(b)를 만든다.
 * rows [시작, 끝)과 out(Dw·Dh·4 버퍼)을 주면 그 줄들만 채운다 (긴 작업을 나눠 화면 끊김을 줄일 때).
 */
export function upscaleSharp(mask, Pw, Ph, Dw, Dh, paper, ink, { rows = [0, Dh], out = null } = {}) {
  const xs = sharpAxis(Dw, Pw);
  const ys = sharpAxis(Dh, Ph);
  const clampX = (v) => Math.min(Pw - 1, Math.max(0, v));
  const clampY = (v) => Math.min(Ph - 1, Math.max(0, v));
  const x0 = new Int32Array(Dw);
  const x1 = new Int32Array(Dw);
  for (let o = 0; o < Dw; o += 1) {
    x0[o] = clampX(xs.bound[o] - 1);
    x1[o] = clampX(xs.bound[o]);
  }
  const rgba = out ?? new Uint8ClampedArray(Dw * Dh * 4);
  for (let r = rows[0]; r < rows[1]; r += 1) {
    const g = Dh - 1 - r; // GL 방향 출력 줄
    const wy = ys.weight[g];
    const row0 = (Ph - 1 - clampY(ys.bound[g] - 1)) * Pw; // GL 줄 b-1 → 위 줄부터의 번호
    const row1 = (Ph - 1 - clampY(ys.bound[g])) * Pw;
    for (let o = 0; o < Dw; o += 1) {
      const wx = xs.weight[o];
      const lo = mask[row0 + x0[o]] * (256 - wx) + mask[row0 + x1[o]] * wx;
      const hi = mask[row1 + x0[o]] * (256 - wx) + mask[row1 + x1[o]] * wx;
      const v = lo * (256 - wy) + hi * wy; // 0..65536 (흰 점 비율)
      const i = (r * Dw + o) * 4;
      rgba[i] = (ink[0] * (65536 - v) + paper[0] * v + 32768) >> 16;
      rgba[i + 1] = (ink[1] * (65536 - v) + paper[1] * v + 32768) >> 16;
      rgba[i + 2] = (ink[2] * (65536 - v) + paper[2] * v + 32768) >> 16;
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

// PNG CRC-32 (ISO 3309)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes, start = 0, end = bytes.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

/**
 * 마스크 → 1비트 회색조 PNG (비트 깊이 1, 색 형식 0: 0 = 검정, 1 = 흰색). 무손실, 메모리에만 둔다.
 * @param {(raw: Uint8Array) => Promise<Uint8Array>} deflate zlib 형식(RFC 1950) 압축. 브라우저는 CompressionStream('deflate')
 * @returns {Promise<Uint8Array>}
 */
export async function encodeOneBitPng(mask, w, h, deflate) {
  const rowBytes = Math.ceil(w / 8);
  const raw = new Uint8Array((rowBytes + 1) * h); // 줄마다 필터 바이트 0(없음) + 비트
  for (let y = 0; y < h; y += 1) {
    const o = y * (rowBytes + 1) + 1;
    for (let x = 0; x < w; x += 1) if (mask[y * w + x]) raw[o + (x >> 3)] |= 0x80 >> (x & 7);
  }
  const idat = await deflate(raw);
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, w);
  view.setUint32(4, h);
  ihdr.set([1, 0, 0, 0, 0], 8); // 비트 깊이 1, 회색조, deflate, 필터 방식 0, 인터레이스 없음
  const chunks = [['IHDR', ihdr], ['IDAT', idat], ['IEND', new Uint8Array(0)]];
  const total = 8 + chunks.reduce((t, [, data]) => t + 12 + data.length, 0);
  const png = new Uint8Array(total);
  png.set(PNG_SIGNATURE, 0);
  let p = 8;
  const out = new DataView(png.buffer);
  for (const [type, data] of chunks) {
    out.setUint32(p, data.length);
    for (let i = 0; i < 4; i += 1) png[p + 4 + i] = type.charCodeAt(i);
    png.set(data, p + 8);
    out.setUint32(p + 8 + data.length, crc32(png, p + 4, p + 8 + data.length));
    p += 12 + data.length;
  }
  return png;
}

/** PNG 머리(IHDR)를 읽는다. PNG가 아니면 null. D 화면·확인용 */
export function readPngHeader(bytes) {
  if (bytes.length < 33 || PNG_SIGNATURE.some((b, i) => bytes[i] !== b)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
  if (type !== 'IHDR') return null;
  return { width: view.getUint32(16), height: view.getUint32(20), bitDepth: bytes[24], colorType: bytes[25] };
}
