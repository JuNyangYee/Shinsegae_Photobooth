// 임프린트 (IMPRINT 시안, 채택 전): 촬영 시각 표기와 감열지 인쇄 쪽 배치. 인쇄 데이터는 "머리(날짜·시각) + 사진 틀 + 꼬리(한 줄)"를
// 한 장의 1비트 래스터로 짠다. 글자를 그리는 일(캔버스)은 effect/imprint-page.js, 여기는 숫자·글자·배치·마스크 합치기만 한다.
// 관람객 화면 머리(ui/guest-screen.js)도 같은 표기를 써서 화면에 보이는 촬영 시각 = 인쇄되는 시각이다.
// 순수 함수. Node 테스트: test/core/imprint.test.mjs

export const WEEKDAYS = Object.freeze(['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT']);

const pad = (n) => String(n).padStart(2, '0');

/**
 * 시각(ms, Date.now() 기준) → 표기. 현장 PC의 지역 시각이다.
 * @returns {{ date: string, weekday: string, time: string }} 예: '2026.11.03', 'TUE', '18:42:07'
 */
export function imprintStamp(ms) {
  const d = new Date(ms);
  return Object.freeze({
    date: `${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())}`,
    weekday: WEEKDAYS[d.getDay()],
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`,
  });
}

/** 용지 폭 표기 (203dpi 감열지): 576점 80 MM, 384점 58 MM, 그 밖은 점 수 */
export function paperLabel(paperDots) {
  if (paperDots === 576) return '80 MM';
  if (paperDots === 384) return '58 MM';
  return `${paperDots} DOTS`;
}

/**
 * 인쇄 쪽 배치 (점 단위, 203dpi에서 8점 = 1mm). 기준 용지 576점의 값을 용지 폭에 비례해 쓴다 (가안).
 *   위 여백 → 머리 한 줄(왼쪽 날짜·요일, 오른쪽 시각) → 사진(용지 폭 전체 × photoHeight) → 꼬리 한 줄(왼쪽 세리프 문장, 오른쪽 용지 폭) → 아래 여백
 * 576점·사진 720줄이면 912줄 = 약 114mm (예전 사진만 1024줄보다 짧다).
 * @returns {{ width: number, height: number, marginX: number, header: { baseline: number, size: number },
 *   photo: { top: number, height: number }, footer: { baseline: number, size: number, labelSize: number } }}
 */
export function imprintLayout(paperDots, photoHeight) {
  const s = paperDots / 576;
  const r = (v) => Math.max(1, Math.round(v * s));
  const photoTop = r(84);
  const footerBaseline = photoTop + photoHeight + r(56);
  return Object.freeze({
    width: paperDots,
    height: footerBaseline + r(52),
    marginX: r(24),
    header: Object.freeze({ baseline: r(58), size: r(22) }),
    photo: Object.freeze({ top: photoTop, height: photoHeight }),
    footer: Object.freeze({ baseline: footerBaseline, size: r(30), labelSize: r(16) }),
  });
}

/**
 * 글자를 그린 캔버스 화소(RGBA, 흰 바탕·검은 글자) → 1비트 마스크 (1 = 흰 종이, 0 = 검은 점, thermal.js 마스크와 같은 뜻).
 * 빨강 채널이 threshold 미만이면 검정 (회색조로 그리므로 R = G = B)
 */
export function maskFromRgba(rgba, width, height, threshold = 128) {
  const mask = new Uint8Array(width * height);
  for (let i = 0; i < mask.length; i += 1) mask[i] = rgba[i * 4] < threshold ? 0 : 1;
  return mask;
}

/** 쪽 마스크(page, 폭 width)의 top줄부터 사진 마스크를 그대로 넣는다 (같은 폭). page를 고쳐 돌려준다 */
export function placeRows(page, photo, width, top) {
  if (photo.length % width !== 0) throw new Error(`photo mask length ${photo.length} is not a multiple of width ${width}`);
  if (top * width + photo.length > page.length) throw new Error('photo rows do not fit the page');
  page.set(photo, top * width);
  return page;
}
