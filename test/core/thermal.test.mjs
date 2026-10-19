// 실행: npm test  (또는 node --test test/core/thermal.test.mjs)
// 감열지 출력 단계 순수 계산 (6-1): 레벨, 인쇄 해상도, 면적 평균 축소, 디더링 결정성·알려진 결과, 인쇄 비트, 1비트 PNG.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateSync, inflateSync } from 'node:zlib';

import {
  applyLevels, bayerRanks, blueNoiseRanks, bwStyleOf, crc32, dither, ditherErrorDiffusion, ditherThreshold, ditherWithThresholds,
  encodeOneBitPng, grayLevelsInPlace, isGpuDither, levelOf, maskToRgba, packPrintBits, printSizeFor, readPngHeader, reduceToPrintGray,
  screenOf, sharpAxis, thresholdMap, upscaleSharp,
} from '../../src/web/core/thermal.js';

const NEUTRAL = { brightness: 0, contrast: 1, gamma: 1 };
const deflate = async (raw) => deflateSync(raw);

describe('회색조·레벨', () => {
  it('중립 레벨은 Rec.601 회색조 그대로', () => {
    assert.equal(levelOf(255, 255, 255, NEUTRAL), 1);
    assert.equal(levelOf(0, 0, 0, NEUTRAL), 0);
    assert.ok(Math.abs(levelOf(255, 0, 0, NEUTRAL) - 0.299) < 1e-12);
    assert.ok(Math.abs(levelOf(0, 255, 0, NEUTRAL) - 0.587) < 1e-12);
  });

  it('대비는 0.5를 중심으로, 밝기는 더하고, 0~1로 자른 뒤 감마', () => {
    assert.equal(applyLevels(0.5, { brightness: 0, contrast: 2, gamma: 1 }), 0.5);
    assert.equal(applyLevels(0.75, { brightness: 0, contrast: 2, gamma: 1 }), 1);
    assert.equal(applyLevels(0.25, { brightness: 0, contrast: 2, gamma: 1 }), 0);
    assert.equal(applyLevels(0.5, { brightness: 0.25, contrast: 1, gamma: 1 }), 0.75);
    assert.equal(applyLevels(1, { brightness: 0.4, contrast: 1, gamma: 1 }), 1);
    assert.equal(applyLevels(0.25, { brightness: 0, contrast: 1, gamma: 2 }), 0.5); // 0.25^(1/2)
    assert.equal(applyLevels(0, { brightness: 0, contrast: 1, gamma: 0.5 }), 0);
  });

  it('grayLevelsInPlace: RGB를 같은 회색으로, 알파는 그대로', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 200, 10, 10, 10, 255]);
    grayLevelsInPlace(rgba, NEUTRAL);
    assert.deepEqual([...rgba], [76, 76, 76, 200, 10, 10, 10, 255]);
  });
});

describe('인쇄 해상도', () => {
  it('80mm 576점 → 1080x1920 결과에서 576x1024, 58mm 384점 → 384x683', () => {
    assert.deepEqual(printSizeFor(576, 1080, 1920), { width: 576, height: 1024 });
    assert.deepEqual(printSizeFor(384, 1080, 1920), { width: 384, height: 683 });
    assert.deepEqual(printSizeFor(576, 540, 960), { width: 576, height: 1024 }, '미리보기 처리 해상도와 관계없이 같다');
  });

  it('용지 점 수는 8의 배수라야 한다 (한 바이트 8점)', () => {
    assert.throws(() => printSizeFor(500, 1080, 1920), /multiple of 8/);
    assert.throws(() => printSizeFor(0, 1080, 1920), /multiple of 8/);
  });
});

describe('면적 평균 축소 (원본 사진으로 대신할 때의 CPU 경로)', () => {
  const solid = (w, h, v) => new Uint8ClampedArray(w * h * 4).fill(v);

  it('단색은 단색, 정수배면 블록 평균', () => {
    assert.ok(reduceToPrintGray(solid(30, 40, 200), 30, 40, 8, 10, NEUTRAL).every((v) => v === 200));
    // 4x2 → 2x1: 왼쪽 2x2 블록은 0과 255 반반 → 128 (127.5 반올림)
    const rgba = new Uint8ClampedArray(4 * 2 * 4);
    const px = (x, y, v) => rgba.fill(v, (y * 4 + x) * 4, (y * 4 + x) * 4 + 4);
    px(0, 0, 0); px(1, 0, 255); px(0, 1, 255); px(1, 1, 0);
    px(2, 0, 255); px(3, 0, 255); px(2, 1, 255); px(3, 1, 255);
    assert.deepEqual([...reduceToPrintGray(rgba, 4, 2, 2, 1, NEUTRAL)], [128, 255]);
  });

  it('1.875배(1080 → 576)처럼 정수가 아닌 배율은 겹친 넓이로 나눈다', () => {
    // 15열(0..14): 0~6열 0, 7~14열 255 → 8칸으로 줄이면 칸 3이 [5.625, 7.5): 0이 1.375, 255가 0.5 → 255·0.5/1.875 = 68
    const W = 15;
    const rgba = new Uint8ClampedArray(W * 4);
    for (let x = 7; x < W; x += 1) rgba.fill(255, x * 4, x * 4 + 4);
    const gray = reduceToPrintGray(rgba, W, 1, 8, 1, NEUTRAL);
    assert.deepEqual([...gray], [0, 0, 0, 68, 255, 255, 255, 255]);
  });
});

describe('문턱값 디더 (GPU와 같은 식)', () => {
  it('Bayer 행렬: 2x2 = [0 2; 3 1], 8x8은 0..63 순열', () => {
    assert.deepEqual([...bayerRanks(2)], [0, 2, 3, 1]);
    const b8 = bayerRanks(8);
    assert.deepEqual([...b8].sort((a, b) => a - b), Array.from({ length: 64 }, (_, i) => i));
    assert.deepEqual([...b8.slice(0, 8)], [0, 32, 8, 40, 2, 34, 10, 42]);
  });

  it('블루 노이즈(void-and-cluster): 64x64 순열, 같은 인자면 같은 결과, 고르게 퍼진다', () => {
    const a = blueNoiseRanks(64);
    assert.deepEqual([...a].sort((x, y) => x - y), Array.from({ length: 4096 }, (_, i) => i));
    assert.equal(blueNoiseRanks(64), a, '한 번만 만든다');
    const fresh = blueNoiseRanks(64, { seed: 1, sigma: 1.5 + 1e-12 }); // 캐시를 피해 다시 계산해도
    assert.deepEqual([...fresh.slice(0, 64)].map((v) => Math.round(v / 64)), [...a.slice(0, 64)].map((v) => Math.round(v / 64)));
    // 50% 점: 이웃이 같은 비율이 무작위(0.5)보다 확실히 낮고, 8x8 칸마다 켜진 점 수가 고르다
    const N = 64;
    let same = 0;
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) same += (a[y * N + x] < 2048) === (a[y * N + (x + 1) % N] < 2048) ? 1 : 0;
    assert.ok(same / (N * N) < 0.42, `equal neighbours ${same / (N * N)}`);
    for (let ty = 0; ty < 8; ty += 1) {
      for (let tx = 0; tx < 8; tx += 1) {
        let on = 0;
        for (let y = 0; y < 8; y += 1) for (let x = 0; x < 8; x += 1) on += a[(ty * 8 + y) * N + tx * 8 + x] < 2048 ? 1 : 0;
        assert.ok(on >= 26 && on <= 38, `tile ${tx},${ty}: ${on}/64`);
      }
    }
  });

  it('문턱 t = 1 + floor(순위·255/N): 회색 0은 모두 검정, 255는 모두 흰색, g면 흰 점 ceil(g·N/255)개', () => {
    for (const method of ['bayer', 'blue-noise']) {
      const map = thresholdMap(method);
      const N = map.size * map.size;
      assert.equal(Math.min(...map.thresholds), 1);
      for (const g of [0, 1, 64, 127, 128, 200, 254, 255]) {
        const gray = new Uint8Array(N).fill(g);
        const mask = ditherThreshold(gray, map.size, map.size, map);
        assert.equal(mask.reduce((t, v) => t + v, 0), Math.ceil((g * N) / 255), `${method} gray ${g}`);
      }
    }
  });

  it('문턱 지도는 타일처럼 반복되고 위 줄부터 (점 x, y → 지도 x % n, y % n)', () => {
    const map = thresholdMap('bayer');
    const gray = new Uint8Array(16 * 9).fill(100);
    const mask = ditherThreshold(gray, 16, 9, map);
    for (let y = 0; y < 9; y += 1) {
      for (let x = 0; x < 16; x += 1) assert.equal(mask[y * 16 + x], 100 >= map.thresholds[(y % 8) * 8 + (x % 8)] ? 1 : 0);
    }
  });
});

describe('오차 확산 (CPU)', () => {
  it('알려진 작은 입력: Floyd–Steinberg 한 줄 [100 100 100] → 검 흰 검, Atkinson [100 x4] → 검 검 검 흰', () => {
    assert.deepEqual([...ditherErrorDiffusion(new Uint8Array([100, 100, 100]), 3, 1, 'floyd-steinberg')], [0, 1, 0]);
    assert.deepEqual([...ditherErrorDiffusion(new Uint8Array([100, 100, 100, 100]), 4, 1, 'atkinson')], [0, 0, 0, 1]);
  });

  it('Floyd–Steinberg는 둘째 줄을 오른쪽에서 왼쪽으로 (serpentine)', () => {
    // 2x2 [200 200 / 0 0]: (0,0) 흰 e=-55 → (1,0) 200-24.06=175.9 흰 e=-79.06, 아래로 퍼진 오차 때문에 둘째 줄은 모두 검정
    const mask = ditherErrorDiffusion(new Uint8Array([200, 200, 0, 0]), 2, 2, 'floyd-steinberg');
    assert.deepEqual([...mask], [1, 1, 0, 0]);
    // 3x2 [0 0 0 / 200 200 100]: 둘째 줄은 오른쪽부터: 100 검(e=100) → 가운데 200+43.75 흰(e=-11.25) → 왼쪽 195.1 흰
    const m2 = ditherErrorDiffusion(new Uint8Array([0, 0, 0, 200, 200, 100]), 3, 2, 'floyd-steinberg');
    assert.deepEqual([...m2], [0, 0, 0, 1, 1, 0]);
  });

  it('결정성: 같은 입력이면 늘 같은 결과 (작업 버퍼를 다시 써도)', () => {
    const w = 97;
    const h = 61;
    const gray = new Uint8Array(w * h).map((_, i) => (i * 7919) % 256);
    const work = new Float32Array(w * h);
    for (const method of ['atkinson', 'floyd-steinberg', 'bayer', 'blue-noise']) {
      const a = dither(gray, w, h, method, work);
      const b = dither(gray, w, h, method, work);
      const c = dither(gray, w, h, method);
      assert.deepEqual(a, b);
      assert.deepEqual(a, c);
    }
  });

  it('톤 보존: 넓은 단색 회색의 흰 점 비율 ≈ 회색/255 (Atkinson은 끝 톤이 날아간다)', () => {
    const w = 128;
    const h = 128;
    for (const g of [32, 128, 220]) {
      const gray = new Uint8Array(w * h).fill(g);
      for (const method of ['floyd-steinberg', 'bayer', 'blue-noise']) {
        const ratio = dither(gray, w, h, method).reduce((t, v) => t + v, 0) / (w * h);
        assert.ok(Math.abs(ratio - g / 255) < 0.02, `${method} gray ${g}: ${ratio}`);
      }
      const atk = dither(gray, w, h, 'atkinson').reduce((t, v) => t + v, 0) / (w * h);
      assert.ok(Math.abs(atk - g / 255) < 0.13, `atkinson gray ${g}: ${atk}`);
    }
  });

  it('방식 분류: bayer·blue-noise는 GPU에서도, atkinson·floyd-steinberg는 CPU만', () => {
    assert.deepEqual(['bayer', 'blue-noise', 'atkinson', 'floyd-steinberg'].map(isGpuDither), [true, true, false, false]);
    assert.throws(() => dither(new Uint8Array(4), 2, 2, 'stucki'), /unknown error diffusion/);
  });
});

describe('화면 표시용 확대 (정수배 최근접 + 경계 1화소만 섞음, 화면 전용)', () => {
  const paper = [250, 240, 230];
  const ink = [10, 20, 30];

  it('1배는 그대로, 2배(정수배)는 최근접과 같아 섞인 화소가 없다', () => {
    const mask = new Uint8Array([1, 0, 0, 1, 1, 1]); // 3x2
    const same = upscaleSharp(mask, 3, 2, 3, 2, paper, ink);
    assert.deepEqual([...same], [...maskToRgba(mask, paper, ink)]);
    const two = upscaleSharp(mask, 3, 2, 6, 4, paper, ink);
    for (let y = 0; y < 4; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const c = mask[Math.floor(y / 2) * 3 + Math.floor(x / 2)] ? paper : ink;
        assert.deepEqual([...two.slice((y * 6 + x) * 4, (y * 6 + x) * 4 + 3)], c, `${x},${y}`);
      }
    }
  });

  it('1.875배(576 → 1080): 모든 점의 화면 폭이 1.875화소로 같다 (최근접은 1·2화소)', () => {
    const { bound, weight } = sharpAxis(1080, 576);
    const mass = new Float64Array(576);
    let blended = 0;
    for (let o = 0; o < 1080; o += 1) {
      if (bound[o] - 1 >= 0) mass[bound[o] - 1] += (256 - weight[o]) / 256;
      if (bound[o] < 576) mass[bound[o]] += weight[o] / 256;
      if (weight[o] > 0 && weight[o] < 256) blended += 1;
    }
    for (let i = 0; i < 576; i += 1) assert.ok(Math.abs(mass[i] - 1.875) < 1e-9, `dot ${i}: ${mass[i]}`);
    const nearest = new Float64Array(576);
    for (let o = 0; o < 1080; o += 1) nearest[Math.floor(((o + 0.5) * 576) / 1080)] += 1;
    assert.deepEqual([...new Set(nearest)].sort(), [1, 2]);
    assert.equal(blended, 504, '경계에 걸친 화소만 섞는다 (576 - 72개 경계는 화소 경계와 맞지 않음)');
  });

  it('줄 묶음으로 나눠 채워도 한 번에 만든 것과 같다', () => {
    const mask = new Uint8Array(64 * 114).map((_, i) => (i * 2654435761 >>> 9) & 1);
    const whole = upscaleSharp(mask, 64, 114, 120, 213, paper, ink);
    const out = new Uint8ClampedArray(120 * 213 * 4);
    for (let r = 0; r < 213; r += 50) upscaleSharp(mask, 64, 114, 120, 213, paper, ink, { rows: [r, Math.min(213, r + 50)], out });
    assert.deepEqual(out, whole);
  });

  it('위 줄부터 쓴다: 왼쪽 위 점 하나만 검정이면 화면 왼쪽 위가 잉크색, 오른쪽 아래는 종이색', () => {
    const mask = new Uint8Array(8 * 4).fill(1);
    mask[0] = 0;
    const out = upscaleSharp(mask, 8, 4, 15, 8, paper, ink);
    assert.deepEqual([...out.slice(0, 3)], ink);
    assert.deepEqual([...out.slice(out.length - 4, out.length - 1)], paper);
  });
});

describe('인쇄 데이터', () => {
  const mask = new Uint8Array([
    1, 0, 1, 1, 1, 1, 1, 1, 0, 1, // 10점: 8의 배수가 아니면 마지막 바이트를 0으로 채운다
    0, 0, 0, 0, 0, 0, 0, 0, 1, 1,
  ]);

  it('래스터 비트: 줄마다 ceil(w/8)바이트, 왼쪽 점이 최상위 비트, 1 = 검은 점', () => {
    const r = packPrintBits(mask, 10, 2);
    assert.deepEqual([r.width, r.height, r.bytesPerRow], [10, 2, 2]);
    assert.deepEqual([...r.bits], [0b01000000, 0b10000000, 0b11111111, 0b00000000]);
    assert.equal(r.black, 10);
  });

  it('화면 표시용 RGBA: 흰 점은 종이색, 검은 점은 잉크색', () => {
    const rgba = maskToRgba(new Uint8Array([1, 0]), [250, 240, 230], [10, 20, 30]);
    assert.deepEqual([...rgba], [250, 240, 230, 255, 10, 20, 30, 255]);
  });

  it('1비트 PNG: 서명·IHDR(깊이 1, 회색조)·CRC가 맞고, 압축을 풀면 줄마다 필터 0 + 비트(1 = 흰색)', async () => {
    const png = await encodeOneBitPng(mask, 10, 2, deflate);
    assert.deepEqual(readPngHeader(png), { width: 10, height: 2, bitDepth: 1, colorType: 0 });
    const view = new DataView(png.buffer, png.byteOffset);
    let p = 8;
    const types = [];
    let idat = null;
    while (p < png.length) {
      const length = view.getUint32(p);
      const type = String.fromCharCode(...png.subarray(p + 4, p + 8));
      assert.equal(view.getUint32(p + 8 + length), crc32(png, p + 4, p + 8 + length), `${type} CRC`);
      if (type === 'IDAT') idat = png.subarray(p + 8, p + 8 + length);
      types.push(type);
      p += 12 + length;
    }
    assert.deepEqual(types, ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual([...inflateSync(idat)], [0, 0b10111111, 0b01000000, 0, 0b00000000, 0b11000000]);
    assert.equal(readPngHeader(new Uint8Array(40)), null);
  });

  it('CRC-32 알려진 값 ("IEND" → 0xae426082)', () => {
    assert.equal(crc32(new TextEncoder().encode('IEND')), 0xae426082);
  });
});

describe('흑백 스타일 (7-1)', () => {
  it('스타일이 없으면 톤 점. 점을 정하는 것: 톤 점·질감 강조 점은 점 방식, 흐름 선·붓 결 선은 선', () => {
    assert.equal(bwStyleOf({}), 'tone');
    assert.equal(screenOf({ dither: 'atkinson' }), 'atkinson', '6-1 설정(스타일 없음)은 그대로');
    assert.equal(screenOf({ bwStyle: 'texture', dither: 'floyd-steinberg' }), 'floyd-steinberg');
    assert.equal(screenOf({ bwStyle: 'flow', dither: 'atkinson' }), 'flow-lines');
    assert.equal(screenOf({ bwStyle: 'stroke', dither: 'bayer' }), 'stroke-lines');
  });

  it('점별 문턱 디더: g >= t면 흰 점 (알려진 작은 입력), 문턱 255·회색 255는 흰 점, 문턱 1·회색 0은 검은 점, 같은 입력이면 같은 결과', () => {
    const gray = Uint8Array.from([0, 0, 1, 128, 127, 255, 254, 255]);
    const thr = Uint8Array.from([1, 255, 1, 128, 128, 255, 255, 1]);
    assert.deepEqual([...ditherWithThresholds(gray, thr)], [0, 0, 1, 1, 0, 1, 0, 1]);
    assert.deepEqual(ditherWithThresholds(gray, thr), ditherWithThresholds(gray, thr));
    // 타일 문턱 지도를 인쇄 크기로 펼치면 ditherThreshold와 같다 (GPU uFull 0과 1이 같은 비교)
    const map = thresholdMap('bayer');
    const w = 20;
    const h = 11;
    const g = Uint8Array.from({ length: w * h }, (_, i) => (i * 37) % 256);
    const full = Uint8Array.from({ length: w * h }, (_, i) => map.thresholds[(Math.floor(i / w) % map.size) * map.size + ((i % w) % map.size)]);
    assert.deepEqual(ditherWithThresholds(g, full), ditherThreshold(g, w, h, map));
  });
});
