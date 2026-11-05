// 실행: npm test
// 인쇄 쪽 짜기 (IMPRINT 시안, effect/imprint-page.js): 글자를 흉내 캔버스에 그린 순서·서체·자리, 문턱으로 1비트, 사진 줄 넣기, 캔버스 정리.
// 실제 글자 모양(서체 래스터)은 브라우저 확인 도구에서 본다 (tools/browser-check.mjs)
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { guestText } from '../../src/web/config/guest-text.js';
import { imprintLayout } from '../../src/web/core/imprint.js';
import { IMPRINT_FONTS, createImprintPage, imprintTypeSizes } from '../../src/web/effect/imprint-page.js';

// fillText마다 글자 자리 한 화소(기준선 바로 위)를 검게 칠하는 흉내 2D 캔버스
function fakeTextCanvas(log) {
  const canvas = { width: 0, height: 0 };
  let pixels = null;
  const ctx = {
    fillStyle: '', font: '', textAlign: '', textBaseline: '', letterSpacing: '',
    fillRect(x, y, w, h) { log.push(['fillRect', x, y, w, h, ctx.fillStyle]); pixels = new Uint8ClampedArray(canvas.width * canvas.height * 4).fill(255); },
    fillText(t, x, y) {
      log.push(['fillText', t, x, y, ctx.font, ctx.textAlign, ctx.letterSpacing]);
      const px = Math.min(canvas.width - 1, Math.max(0, ctx.textAlign === 'right' ? x - 1 : x));
      const i = ((y - 1) * canvas.width + px) * 4;
      pixels[i] = pixels[i + 1] = pixels[i + 2] = 0;
    },
    getImageData: (x, y, w, h) => ({ data: pixels.slice(0, w * h * 4) }),
  };
  canvas.getContext = () => ctx;
  return canvas;
}

const stamp = { date: '2026.11.03', weekday: 'TUE', time: '18:42:07' };

describe('createImprintPage', () => {
  it('머리(표제 왼쪽, 날짜 오른쪽) → 사진 줄 → 꼬리(필기체 왼쪽, 시각·용지 폭 오른쪽)를 한 장의 1비트로 짠다 (WISHFUL 시안)', () => {
    const log = [];
    const canvases = [];
    const page = createImprintPage({
      createCanvas: () => { const c = fakeTextCanvas(log); canvases.push(c); return c; },
      fonts: { check: () => true }, text: guestText.print,
    });
    const photo = new Uint8Array(576 * 720).fill(0); // 모두 검은 사진
    const out = page.render({ photoMask: photo, width: 576, photoHeight: 720, stamp, paper: '80 MM' });
    const layout = imprintLayout(576, 720);
    assert.equal(out.height, 912);
    assert.equal(out.photoTop, layout.photo.top);
    assert.equal(out.mask.length, 576 * 912);
    assert.equal(out.fontsReady, true);
    // 사진 줄은 그대로(검정), 사진 위·아래는 글자 자리 말고 흰 종이
    assert.ok(out.mask.subarray(84 * 576, 804 * 576).every((v) => v === 0));
    assert.equal(out.mask[0], 1);
    assert.equal(out.mask[(layout.header.baseline - 1) * 576 + layout.marginX], 0, '머리 왼쪽 글자 자리');
    assert.equal(out.mask[(layout.footer.baseline - 1) * 576 + layout.marginX], 0, '꼬리 왼쪽 글자 자리');
    const texts = log.filter((op) => op[0] === 'fillText');
    assert.deepEqual(texts.map((op) => [op[1], op[5]]), [
      ['A WISHFUL HOLIDAY', 'left'], ['2026.11.03', 'right'], ['Puuvilla Story Begins', 'left'], ['18:42:07  ·  80 MM', 'right'],
    ]);
    assert.deepEqual(imprintTypeSizes(layout), { title: 24, date: 20, script: 34, time: 16 });
    assert.deepEqual(texts.map((op) => op[4]), [
      IMPRINT_FONTS.display(24), IMPRINT_FONTS.sans(20), IMPRINT_FONTS.script(34), IMPRINT_FONTS.sans(16),
    ]);
    assert.deepEqual(log[0], ['fillRect', 0, 0, 576, 912, '#ffffff']);
    assert.deepEqual([canvases[0].width, canvases[0].height], [0, 0], '캔버스는 비운다');
  });

  it('서체를 아직 불러오지 않았으면 fontsReady false (시스템 서체로 그려진다), fonts가 없으면 null', () => {
    const photo = new Uint8Array(128 * 160).fill(1);
    const notLoaded = createImprintPage({ createCanvas: () => fakeTextCanvas([]), fonts: { check: () => false }, text: guestText.print });
    assert.equal(notLoaded.render({ photoMask: photo, width: 128, photoHeight: 160, stamp, paper: '128 DOTS' }).fontsReady, false);
    const unknown = createImprintPage({ createCanvas: () => fakeTextCanvas([]), fonts: null, text: guestText.print });
    assert.equal(unknown.render({ photoMask: photo, width: 128, photoHeight: 160, stamp, paper: '128 DOTS' }).fontsReady, null);
  });

  it('2D 컨텍스트를 못 만들면 예외, 캔버스는 비운다', () => {
    const canvas = { width: 0, height: 0, getContext: () => null };
    const page = createImprintPage({ createCanvas: () => canvas, fonts: null, text: guestText.print });
    assert.throws(() => page.render({ photoMask: new Uint8Array(576 * 720), width: 576, photoHeight: 720, stamp, paper: '80 MM' }), /2d context/);
    assert.deepEqual([canvas.width, canvas.height], [0, 0]);
  });
});
