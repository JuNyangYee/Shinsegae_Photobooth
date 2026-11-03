// 실행: npm test
// 임프린트 (IMPRINT 시안, core/imprint.js): 촬영 시각 표기, 인쇄 쪽 배치, 글자 화소 → 1비트, 사진 줄 넣기
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { imprintLayout, imprintStamp, maskFromRgba, paperLabel, placeRows } from '../../src/web/core/imprint.js';

describe('imprint: 표기', () => {
  it('지역 시각으로 날짜·요일·시각 (두 자리 채움)', () => {
    assert.deepEqual(imprintStamp(new Date(2026, 10, 3, 18, 42, 7).getTime()), { date: '2026.11.03', weekday: 'TUE', time: '18:42:07' });
    assert.deepEqual(imprintStamp(new Date(2027, 0, 1, 0, 0, 9).getTime()), { date: '2027.01.01', weekday: 'FRI', time: '00:00:09' });
  });

  it('용지 폭: 80 MM, 58 MM, 그 밖은 점 수', () => {
    assert.equal(paperLabel(576), '80 MM');
    assert.equal(paperLabel(384), '58 MM');
    assert.equal(paperLabel(128), '128 DOTS');
  });
});

describe('imprint: 인쇄 쪽 배치', () => {
  it('576점·사진 720줄: 머리 → 사진 84~804줄 → 꼬리, 912줄 = 약 114mm (예전 사진만 1024줄보다 짧다)', () => {
    const layout = imprintLayout(576, 720);
    assert.equal(layout.width, 576);
    assert.equal(layout.height, 912);
    assert.deepEqual(layout.photo, { top: 84, height: 720 });
    assert.ok(layout.header.baseline < layout.photo.top, '머리 글자는 사진 위');
    assert.ok(layout.footer.baseline > layout.photo.top + layout.photo.height, '꼬리 글자는 사진 아래');
    assert.ok(layout.footer.baseline + layout.footer.size * 0.3 < layout.height, '꼬리 아래 여백');
  });

  it('58mm(384점)는 같은 배치를 폭에 비례해 줄인다', () => {
    const layout = imprintLayout(384, 480);
    assert.equal(layout.photo.top, 56);
    assert.equal(layout.height, 56 + 480 + 37 + 35);
    assert.equal(layout.marginX, 16);
  });
});

describe('imprint: 마스크', () => {
  it('RGBA(흰 바탕·검은 글자) → 1 = 흰 종이, 0 = 검은 점 (빨강 128 미만이 검정)', () => {
    const rgba = Uint8ClampedArray.from([255, 255, 255, 255, 0, 0, 0, 255, 127, 127, 127, 255, 128, 128, 128, 255]);
    assert.deepEqual([...maskFromRgba(rgba, 2, 2)], [1, 0, 0, 1]);
  });

  it('쪽 마스크의 top줄부터 사진 줄을 그대로 넣는다. 폭이 안 맞거나 넘치면 예외', () => {
    const page = new Uint8Array(3 * 5).fill(1);
    placeRows(page, Uint8Array.from([0, 0, 0, 0, 1, 0]), 3, 2);
    assert.deepEqual([...page], [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 1]);
    assert.throws(() => placeRows(page, new Uint8Array(4), 3, 0), /multiple of width/);
    assert.throws(() => placeRows(page, new Uint8Array(9), 3, 3), /do not fit/);
  });
});
