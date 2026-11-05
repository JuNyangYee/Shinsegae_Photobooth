// 인쇄 쪽 짜기 (IMPRINT에서 도입, WISHFUL HOLIDAY 시안에서 글자만 바꿈 — 검토 중): 사진 틀로 자른 1비트 사진을 감열지 한 장의 가운데에 넣고,
// 위에 캠페인 표제(Cinzel 600 "A WISHFUL HOLIDAY", 왼쪽)와 촬영 날짜(오른쪽), 아래에 필기체 한 줄(Pinyon Script "Puuvilla Story Begins", 왼쪽)과
// 촬영 시각·용지 폭(오른쪽)을 글자로 찍는다. 배치(줄 위치·높이 576x912)는 core/imprint.js 그대로다.
// 글자는 2D 캔버스에 흰 바탕·검은 글자로 그린 뒤 문턱(128)으로 1비트로 바꾼다 (회색 점 없이 글자 가장자리만 계단이 된다).
// 서체는 화면과 같은 저장소 서체이고, 불러오지 못했으면 시스템 서체로 그려지므로 fontsReady로 알린다 (D print 줄).
// 필기체의 가는 획이 203dpi에서 끊기는지는 실제 감열지로 확인해야 한다 (미검증).
// 인쇄 데이터는 메모리에만 두고 화면에는 보이지 않는다. Node 테스트: test/effect/imprint-page.test.mjs (흉내 캔버스)

import { imprintLayout, maskFromRgba, placeRows } from '../core/imprint.js';

export const IMPRINT_FONTS = Object.freeze({
  sans: (size) => `500 ${size}px Pretendard`,
  display: (size) => `600 ${size}px Cinzel`,
  script: (size) => `400 ${size}px "Pinyon Script"`,
});

/** 인쇄 쪽 글자 크기 (점): 배치의 머리·꼬리 크기에서 정한다 (576점 기준 표제 24, 날짜 20, 필기체 34, 시각 16) */
export function imprintTypeSizes(layout) {
  const s = layout.width / 576;
  const r = (v) => Math.max(1, Math.round(v * s));
  return Object.freeze({ title: r(24), date: r(20), script: r(34), time: r(16) });
}

/** 인쇄 쪽 글자를 미리 불러올 때 쓰는 서체 목록 (main.js·demo.js가 document.fonts.load로) */
export const IMPRINT_FONT_LOADS = Object.freeze([
  [IMPRINT_FONTS.display(24), 'AWISHFULHOLDY'],
  [IMPRINT_FONTS.script(34), 'Puuvilla Story Begins'],
  [IMPRINT_FONTS.sans(20), '0123456789.: MSUNTWEDHFRIA'],
]);

/**
 * @param {{ createCanvas?: () => HTMLCanvasElement, fonts?: { check: (font: string) => boolean } | null,
 *   text: { title: string, script: string } }} options text: 머리 표제·꼬리 필기체 (config/guest-text.js guestText.print)
 */
export function createImprintPage({ createCanvas = () => document.createElement('canvas'), fonts = globalThis.document?.fonts ?? null, text }) {
  function fontsReady(sizes) {
    if (!fonts?.check) return null;
    try {
      return fonts.check(IMPRINT_FONTS.display(sizes.title)) && fonts.check(IMPRINT_FONTS.script(sizes.script))
        && fonts.check(IMPRINT_FONTS.sans(sizes.date));
    } catch {
      return false;
    }
  }

  return {
    /**
     * @param {{ photoMask: Uint8Array, width: number, photoHeight: number, stamp: { date: string, weekday: string, time: string },
     *   paper: string }} input photoMask: 폭 width × photoHeight 줄 (1 = 흰 종이), paper: 용지 폭 표기 ('80 MM')
     * @returns {{ mask: Uint8Array, height: number, photoTop: number, fontsReady: boolean | null }}
     */
    render({ photoMask, width, photoHeight, stamp, paper }) {
      const layout = imprintLayout(width, photoHeight);
      const canvas = createCanvas();
      try {
        canvas.width = width;
        canvas.height = layout.height;
        const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
        if (!ctx) throw new Error('2d context unavailable');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, width, layout.height);
        ctx.fillStyle = '#000000';
        ctx.textBaseline = 'alphabetic';
        const sizes = imprintTypeSizes(layout);
        // 머리: 왼쪽 캠페인 표제(대문자 세리프), 오른쪽 촬영 날짜
        ctx.font = IMPRINT_FONTS.display(sizes.title);
        ctx.letterSpacing = `${Math.round(sizes.title * 0.06)}px`;
        ctx.textAlign = 'left';
        ctx.fillText(text.title, layout.marginX, layout.header.baseline);
        ctx.font = IMPRINT_FONTS.sans(sizes.date);
        ctx.letterSpacing = `${Math.round(sizes.date * 0.12)}px`;
        ctx.textAlign = 'right';
        ctx.fillText(stamp.date, width - layout.marginX, layout.header.baseline);
        // 꼬리: 왼쪽 필기체 한 줄, 오른쪽 촬영 시각 · 용지 폭
        ctx.font = IMPRINT_FONTS.script(sizes.script);
        ctx.letterSpacing = '0px';
        ctx.textAlign = 'left';
        ctx.fillText(text.script, layout.marginX, layout.footer.baseline);
        ctx.font = IMPRINT_FONTS.sans(sizes.time);
        ctx.letterSpacing = `${Math.round(sizes.time * 0.14)}px`;
        ctx.textAlign = 'right';
        ctx.fillText(`${stamp.time}  ·  ${paper}`, width - layout.marginX, layout.footer.baseline);
        const page = maskFromRgba(ctx.getImageData(0, 0, width, layout.height).data, width, layout.height);
        placeRows(page, photoMask, width, layout.photo.top);
        return { mask: page, height: layout.height, photoTop: layout.photo.top, fontsReady: fontsReady(sizes) };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}
