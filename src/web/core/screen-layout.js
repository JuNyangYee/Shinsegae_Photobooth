// 최종 화면 합성 (17단계)의 순수 계산: 처리 크기, 우회 판단, 눈 글씨의 바닥 원근 (DOM·캔버스 없음).
// Node 테스트: test/core/screen-layout.test.mjs

/** 합성·유화 처리 크기: 기준(1080x1920)에 처리 해상도를 곱한다 */
export function screenRenderSize(previewScale, base = { width: 1080, height: 1920 }) {
  return Object.freeze({
    width: Math.max(2, Math.round(base.width * previewScale)),
    height: Math.max(2, Math.round(base.height * previewScale)),
  });
}

/**
 * 화면 필터를 쓰지 않는 이유 (없으면 null).
 * 'thermal': 카메라 출력이 감열지(1비트 점)이면 위에 유화를 얹어 점이 번지지 않게 기존 화면으로 돌아간다 (가안, 출력 계약 답에 따라 정리)
 */
export function screenFilterBypass({ enabled, outputMode }) {
  if (!enabled) return 'disabled';
  if (outputMode === 'thermal') return 'thermal';
  return null;
}

const rad = (degrees) => (degrees * Math.PI) / 180;

/**
 * CSS perspective(d) rotateX(deg), transform-origin 윗변 중앙의 역변환: 화면 줄 yd(윗변 기준) → 요소 안의 줄 y.
 * 정변환은 yd = y·cos·d/(d − y·sin)이다
 */
export function carveRowSource(yd, perspective, degrees) {
  const t = rad(degrees);
  return (yd * perspective) / (perspective * Math.cos(t) + yd * Math.sin(t));
}

/** 요소 안의 줄 y에서의 가로 배율 d/(d − y·sin) (가운데 기준) */
export function carveRowScale(y, perspective, degrees) {
  return perspective / (perspective - y * Math.sin(rad(degrees)));
}

/** 요소 안의 줄 y → 화면 줄 yd (정변환) */
export function carveRowTarget(y, perspective, degrees) {
  return y * Math.cos(rad(degrees)) * carveRowScale(y, perspective, degrees);
}
