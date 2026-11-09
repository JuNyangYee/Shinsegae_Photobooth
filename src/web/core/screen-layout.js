// 최종 화면 합성 (17단계)의 순수 계산: 처리 크기, 우회 판단, 눈 글씨의 바닥 원근 (DOM·캔버스 없음).
// Node 테스트: test/core/screen-layout.test.mjs

/** 합성·유화 처리 크기: 기준(1080x1920)에 처리 해상도를 곱한다 */
export function screenRenderSize(previewScale, base = { width: 1080, height: 1920 }) {
  return Object.freeze({
    width: Math.max(2, Math.round(base.width * previewScale)),
    height: Math.max(2, Math.round(base.height * previewScale)),
  });
}

/** 화면 필터를 쓰지 않는 이유 (없으면 null) */
export function screenFilterBypass({ enabled }) {
  return enabled ? null : 'disabled';
}

/**
 * 화면 필터가 켜진 동안의 사진·인쇄 설정 (사용자 확정 2026-11-09: 화면에서 본 유화 느낌을 사진에도).
 * 유화 수치는 화면 필터, 출력 단계(흑백 방식·점·용지)는 카메라 설정이다. 유화는 늘 켠다(입력은 유화 없는 카메라 층이라 1회다).
 * 카메라 층에 이미 레벨을 입힌 회색 계열은 레벨을 다시 쓰지 않는다. 감열지는 컬러 층에 유화를 입힌 뒤 레벨 → 점이다.
 */
export function screenPhotoSettings(filter, camera) {
  const thermal = camera.outputMode === 'thermal';
  return Object.freeze({
    ...filter,
    oil: true,
    outputMode: camera.outputMode,
    monoMode: camera.monoMode,
    dither: camera.dither,
    paperDots: camera.paperDots,
    bwStyle: camera.bwStyle,
    bwTexture: camera.bwTexture,
    lineSpacing: camera.lineSpacing,
    brightness: thermal ? camera.brightness : 0,
    contrast: thermal ? camera.contrast : 1,
    gamma: thermal ? camera.gamma : 1,
  });
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
