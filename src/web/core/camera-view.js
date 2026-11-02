// 카메라 처리 경로의 계산 (9-1): 카메라 원본 → 색 보정 → 좌우 반전·회전·확대·이동 → 9:16 화면 영역.
// "카메라 원본 자체를 고치는 것"이라 감지 입력·인식 좌표·효과 입력·원본 미리보기·촬영 결과·인쇄 데이터가 모두 이 변환 하나를 쓴다.
// 2D 캔버스(감지·캡처·원본 미리보기, camera/camera-frame.js)는 canvasTransform·svgColorMatrixValues를, 효과 셰이더
// (effect/oil-renderer.js)는 shaderSourceAffine·shaderColorUniforms를 쓴다. 둘 다 같은 computeCameraView·cameraColorMatrix에서 나온다.
// 브라우저 API를 쓰지 않는다. Node 테스트: test/core/camera-view.test.mjs
//
// 좌표 (모두 왼쪽 위 원점)
// - 원본 정규화 (x, y): 카메라 프레임 전체 0~1. 원본 화소 = (x·W, y·H)
// - 화면 정규화 (u, v): 9:16 영역 0~1, 관람객이 보는 그대로
// 순서 (원본 → 화면): 원본 가운데 기준으로 회전(90° 단위 × 미세) → 덮기 배율 × 확대 → 좌우 반전(화면 기준) → 이동(화면 기준).
// 반전을 회전 뒤에 두어 90° 회전해도 반전은 늘 화면의 좌우이고, 이동도 반전과 관계없이 화면에서 민 방향으로 움직인다.
// 회전 양수는 화면에서 시계 방향 (CSS rotate와 같다).
//
// 빈 영역: 회전·이동 때문에 화면에 카메라 밖이 보이게 되면 확대를 자동으로 키워 늘 덮는다(검정 칸이 사진·인쇄에 남지 않게).
// 실제 쓰인 배율은 view.zoom, 자동으로 키웠으면 view.autoZoom.

/** 90° 단위 회전 행렬 (행 우선 [m00, m01, m10, m11], y 아래 방향 좌표에서 시계 방향). 정수라 0°·90°에서 오차가 없다 */
const QUARTER_TURNS = Object.freeze({
  0: Object.freeze([1, 0, 0, 1]),
  90: Object.freeze([0, -1, 1, 0]),
  180: Object.freeze([-1, 0, 0, -1]),
  270: Object.freeze([0, 1, -1, 0]),
});

const mul2 = (p, q) => [p[0] * q[0] + p[1] * q[2], p[0] * q[1] + p[1] * q[3], p[2] * q[0] + p[3] * q[2], p[2] * q[1] + p[3] * q[3]];

function rotationMatrix(rotation, rotationFine) {
  const quarter = QUARTER_TURNS[rotation] ?? QUARTER_TURNS[0];
  if (!rotationFine) return [...quarter];
  const r = (rotationFine * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return mul2([c, -s, s, c], quarter);
}

/** 아핀 [a, b, c, d, e, f]: x' = a·x + b·y + c, y' = d·x + e·y + f */
export function mapPoint(affine, point) {
  const [a, b, c, d, e, f] = affine;
  return { x: a * point.x + b * point.y + c, y: d * point.x + e * point.y + f };
}

export function invertAffine([a, b, c, d, e, f]) {
  const det = a * e - b * d;
  return [e / det, -b / det, (b * f - c * e) / det, -d / det, a / det, (c * d - a * f) / det];
}

/**
 * 영상 크기·화면 비율·카메라 설정(기하 항목)으로 변환을 만든다. 영상이 없으면 null.
 * @param {{ videoWidth: number, videoHeight: number, stageAspect: number,
 *   camera: { mirror: boolean, rotation: number, rotationFine: number, zoom: number, panX: number, panY: number } }} input
 *   rotation 0·90·180·270, rotationFine 도(°), zoom 1 이상(덮기 배율 위에 곱한다), panX·panY 화면 폭·높이 대비 이동
 * @returns {{ stageToSource: number[], sourceToStage: number[], zoom: number, zoomRequested: number, autoZoom: boolean,
 *   scale: number, visibleWidthPx: number, visibleHeightPx: number, rotation: number, mirror: boolean,
 *   videoWidth: number, videoHeight: number } | null}
 *   scale: 원본 화소 하나가 화면 높이의 몇 배인지. visibleWidthPx·visibleHeightPx: 화면 폭·높이가 덮는 원본 화소 수(캡처 크기)
 */
export function computeCameraView({ videoWidth: W, videoHeight: H, stageAspect: A, camera }) {
  if (!(W > 0 && H > 0 && A > 0)) return null;
  const rotation = QUARTER_TURNS[camera.rotation] ? camera.rotation : 0;
  const fine = Number.isFinite(camera.rotationFine) ? camera.rotationFine : 0;
  const zoomRequested = Number.isFinite(camera.zoom) && camera.zoom >= 1 ? camera.zoom : 1;
  const m = camera.mirror ? -1 : 1;
  const panX = (Number.isFinite(camera.panX) ? camera.panX : 0) * A;
  const panY = Number.isFinite(camera.panY) ? camera.panY : 0;

  const R = rotationMatrix(rotation, fine);
  // 화면(가운데 원점, 화면 높이 단위) → 원본(가운데 원점, 화소)의 선형 부분 × 배율: Rᵀ · 반전
  const L = [R[0] * m, R[2], R[1] * m, R[3]];
  // 덮기 배율: 90° 단위로 돌린 원본이 화면을 가운데 기준으로 채우는 배율 (지금까지의 object-fit: cover와 같다)
  const odd = rotation === 90 || rotation === 270;
  const baseScale = Math.max(A / (odd ? H : W), 1 / (odd ? W : H));
  // 화면 네 모서리가 원본 안에 들어오는 최소 배율 (회전·이동으로 빈 영역이 생기지 않게)
  let coverScale = 0;
  for (const cx of [-A / 2, A / 2]) {
    for (const cy of [-0.5, 0.5]) {
      const px = cx - panX;
      const py = cy - panY;
      coverScale = Math.max(coverScale, (2 * Math.abs(L[0] * px + L[1] * py)) / W, (2 * Math.abs(L[2] * px + L[3] * py)) / H);
    }
  }
  const userScale = baseScale * zoomRequested;
  const autoZoom = coverScale > userScale * (1 + 1e-9);
  const k = autoZoom ? coverScale : userScale;

  const ox = -A / 2 - panX;
  const oy = -0.5 - panY;
  const stageToSource = [
    (L[0] * A) / (k * W), L[1] / (k * W), 0.5 + (L[0] * ox + L[1] * oy) / (k * W),
    (L[2] * A) / (k * H), L[3] / (k * H), 0.5 + (L[2] * ox + L[3] * oy) / (k * H),
  ];
  return Object.freeze({
    stageToSource: Object.freeze(stageToSource),
    sourceToStage: Object.freeze(invertAffine(stageToSource)),
    zoom: k / baseScale,
    zoomRequested,
    autoZoom,
    scale: k,
    visibleWidthPx: A / k,
    visibleHeightPx: 1 / k,
    rotation: rotation + fine,
    mirror: m < 0,
    videoWidth: W,
    videoHeight: H,
  });
}

const snap = (value) => {
  const r = Math.round(value);
  return (Math.abs(value - r) < 1e-9 ? r : value) + 0; // + 0: -0을 0으로
};

/**
 * 2D 캔버스 setTransform(a, b, c, d, e, f) 값: 원본 화소 → 출력 캔버스(화면 영역 전체, outWidth × outHeight) 화소.
 * drawImage(video, 0, 0)과 함께 쓴다. 정수에 아주 가까운 값은 정수로 맞춘다(변환이 없을 때 화소를 그대로 옮기게).
 */
export function canvasTransform(view, outWidth, outHeight) {
  const [A0, A1, A2, A3, A4, A5] = view.sourceToStage;
  const W = view.videoWidth;
  const H = view.videoHeight;
  return [
    (outWidth * A0) / W, (outHeight * A3) / W, (outWidth * A1) / H, (outHeight * A4) / H, outWidth * A2, outHeight * A5,
  ].map(snap);
}

/**
 * 효과 셰이더의 소스 좌표: 출력 uv(왼쪽 아래 원점) → 소스 텍스처 uv(위아래를 뒤집어 올리므로 왼쪽 아래 원점).
 * tex.x = dot(x, (U, V, 1)), tex.y = dot(y, (U, V, 1))
 * @returns {{ x: number[], y: number[] }}
 */
export function shaderSourceAffine(view) {
  const [a, b, c, d, e, f] = view.stageToSource;
  return { x: [a, -b, b + c].map((v) => v + 0), y: [-d, e, 1 - e - f].map((v) => v + 0) };
}

/** 기하 항목만의 키 (같으면 같은 그림 위치). 인식은 이 키가 바뀌면 처음부터 다시 잰다 */
export function cameraGeometryKey(camera) {
  return [camera.mirror ? 'm' : 'n', camera.rotation, camera.rotationFine, camera.zoom, camera.panX, camera.panY].join(' ');
}

/** 색 보정 항목만의 키 */
export function cameraColorKey(camera) {
  return [camera.brightness, camera.contrast, camera.saturation, camera.gamma, camera.temperature, camera.tint].join(' ');
}

// ---- 색 보정 ----
// 원본 sRGB 값(0~1)에 c' = clamp(M·c + b, 0, 1) ^ exponent. 한 번의 색 행렬과 감마라 SVG 필터(feColorMatrix → feComponentTransfer
// gamma, color-interpolation-filters sRGB)와 셰이더가 같은 식이다. 행렬 M = 대비 · 채도 · 화이트밸런스.
// - 색온도 temperature(-1~1): 빨강 × (1 + 0.2t), 파랑 × (1 − 0.2t). 양수가 따뜻하다
// - 색조 tint(-1~1): 초록 × (1 − 0.2t). 양수가 자홍 쪽
// - 채도 saturation(0~2): Rec.709 밝기(core/thermal.js INPUT_LUMA와 같은 계수) 쪽으로 섞는다. 0은 회색, 1은 그대로
// - 대비 contrast(0.5~2): 0.5 중심, 밝기 brightness(-0.5~0.5): 더한다 (효과 출력 단계의 레벨과 같은 뜻)
// - 감마 gamma(0.4~2.5): exponent = 1/gamma. 1보다 크면 중간 밝기를 밝게 (효과 출력 단계와 같은 뜻)
// 모두 중립(0·1)이면 행렬이 단위 행렬·b 0·exponent 1이라 값이 그대로다.

const LUMA = Object.freeze([0.2126, 0.7152, 0.0722]);
const WHITE_BALANCE_RANGE = 0.2;

/**
 * @param {{ brightness: number, contrast: number, saturation: number, gamma: number, temperature: number, tint: number }} color
 * @returns {{ matrix: number[], offset: number[], exponent: number, identity: boolean }} matrix 행 우선 3×3
 */
export function cameraColorMatrix(color) {
  const gains = [1 + WHITE_BALANCE_RANGE * color.temperature, 1 - WHITE_BALANCE_RANGE * color.tint, 1 - WHITE_BALANCE_RANGE * color.temperature];
  const s = color.saturation;
  const matrix = [];
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 3; col += 1) {
      const saturate = (1 - s) * LUMA[col] + (row === col ? s : 0);
      matrix.push(color.contrast * saturate * gains[col]);
    }
  }
  const bias = 0.5 - 0.5 * color.contrast + color.brightness;
  const exponent = 1 / color.gamma;
  const identity = matrix.every((v, i) => v === (i % 4 === 0 ? 1 : 0)) && bias === 0 && exponent === 1;
  return Object.freeze({ matrix: Object.freeze(matrix), offset: Object.freeze([bias, bias, bias]), exponent, identity });
}

/** 기준 구현 (테스트·확인 도구용): sRGB 0~1 [r, g, b] → 보정 값 */
export function applyCameraColor(rgb, { matrix, offset, exponent }) {
  const out = [];
  for (let row = 0; row < 3; row += 1) {
    const v = matrix[row * 3] * rgb[0] + matrix[row * 3 + 1] * rgb[1] + matrix[row * 3 + 2] * rgb[2] + offset[row];
    const clamped = Math.min(1, Math.max(0, v));
    out.push(exponent === 1 ? clamped : clamped ** exponent);
  }
  return out;
}

/** SVG feColorMatrix type="matrix"의 values (4×5 행 우선, 알파 그대로) */
export function svgColorMatrixValues({ matrix, offset }) {
  const m = matrix;
  return [
    m[0], m[1], m[2], 0, offset[0],
    m[3], m[4], m[5], 0, offset[1],
    m[6], m[7], m[8], 0, offset[2],
    0, 0, 0, 1, 0,
  ].map(String).join(' ');
}

/** 셰이더 uniform: uCamM(mat3, 열 우선 — uniformMatrix3fv transpose false), uCamB, uCamExp */
export function shaderColorUniforms({ matrix: m, offset, exponent }) {
  return { uCamM: [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]], uCamB: [...offset], uCamExp: exponent };
}
