// 인쇄 쪽 짜기 (IMPRINT, 사용자 채택 2026-11-03): 사진 틀로 자른 1비트 사진을 감열지 한 장의 가운데에 넣고, 위에 촬영 날짜·시각,
// 아래에 세리프 한 줄과 용지 폭을 글자로 찍는다. 글자는 2D 캔버스에 흰 바탕·검은 글자로 그린 뒤 문턱(128)으로 1비트로 바꾼다
// (회색 점 없이 글자 가장자리만 계단이 된다). 배치·표기·마스크 합치기는 core/imprint.js. 서체는 화면과 같은 저장소 서체
// (Pretendard 500, Noto Serif KR 300)이고, 불러오지 못했으면 시스템 서체로 그려지므로 fontsReady로 알린다 (D print 줄).
// 인쇄 데이터는 메모리에만 두고 화면에는 보이지 않는다. Node 테스트: test/effect/photo-effect.test.mjs (흉내 캔버스)

import { imprintLayout, maskFromRgba, placeRows } from '../core/imprint.js';

export const IMPRINT_FONTS = Object.freeze({
  sans: (size) => `500 ${size}px Pretendard`,
  serif: (size) => `300 ${size}px "Noto Serif KR"`,
});

/**
 * @param {{ createCanvas?: () => HTMLCanvasElement, fonts?: { check: (font: string) => boolean } | null,
 *   text: { line: string } }} options text: 꼬리 문장 (config/guest-text.js guestText.print)
 */
export function createImprintPage({ createCanvas = () => document.createElement('canvas'), fonts = globalThis.document?.fonts ?? null, text }) {
  function fontsReady(layout) {
    if (!fonts?.check) return null;
    try {
      return fonts.check(IMPRINT_FONTS.sans(layout.header.size)) && fonts.check(IMPRINT_FONTS.serif(layout.footer.size));
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
        // 머리: 왼쪽 날짜·요일, 오른쪽 시각 (작은 산세리프, 넓은 자간)
        ctx.font = IMPRINT_FONTS.sans(layout.header.size);
        ctx.letterSpacing = `${Math.round(layout.header.size * 0.12)}px`;
        ctx.textAlign = 'left';
        ctx.fillText(`${stamp.date}  ${stamp.weekday}`, layout.marginX, layout.header.baseline);
        ctx.textAlign = 'right';
        ctx.fillText(stamp.time, width - layout.marginX, layout.header.baseline);
        // 꼬리: 왼쪽 세리프 한 줄, 오른쪽 용지 폭
        ctx.font = IMPRINT_FONTS.serif(layout.footer.size);
        ctx.letterSpacing = '0px';
        ctx.textAlign = 'left';
        ctx.fillText(text.line, layout.marginX, layout.footer.baseline);
        ctx.font = IMPRINT_FONTS.sans(layout.footer.labelSize);
        ctx.letterSpacing = `${Math.round(layout.footer.labelSize * 0.14)}px`;
        ctx.textAlign = 'right';
        ctx.fillText(paper, width - layout.marginX, layout.footer.baseline);
        const page = maskFromRgba(ctx.getImageData(0, 0, width, layout.height).data, width, layout.height);
        placeRows(page, photoMask, width, layout.photo.top);
        return { mask: page, height: layout.height, photoTop: layout.photo.top, fontsReady: fontsReady(layout) };
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}
