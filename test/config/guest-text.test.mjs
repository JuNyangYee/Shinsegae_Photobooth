// 실행: npm test
// 관람객 문구(guest-text.js)와 세리프 부분 집합 서체(7-2): Noto Serif KR은 이 파일의 글자와 영숫자만 담으므로, 문구를 바꾸고
// 서체를 다시 줄이지 않으면 여기서 실패한다. WOFF(zlib) 표에서 cmap만 읽는다 (서체 도구 의존성 없음).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { inflateSync } from 'node:zlib';

import { guestText } from '../../src/web/config/guest-text.js';

const SERIF = new URL('../../src/web/assets/fonts/NotoSerifKR-Light.subset.woff', import.meta.url);

function woffTable(bytes, wanted) {
  assert.equal(bytes.toString('latin1', 0, 4), 'wOFF');
  const count = bytes.readUInt16BE(12);
  for (let i = 0; i < count; i += 1) {
    const entry = 44 + i * 20;
    if (bytes.toString('latin1', entry, entry + 4) !== wanted) continue;
    const offset = bytes.readUInt32BE(entry + 4);
    const compressed = bytes.readUInt32BE(entry + 8);
    const original = bytes.readUInt32BE(entry + 12);
    const data = bytes.subarray(offset, offset + compressed);
    return compressed < original ? inflateSync(data) : data;
  }
  throw new Error(`no ${wanted} table`);
}

/** cmap의 유니코드 하위 표(형식 4·12)에서 글리프가 있는 코드 포인트 집합 */
function coveredCodePoints(cmap) {
  const covered = new Set();
  const tables = cmap.readUInt16BE(2);
  for (let i = 0; i < tables; i += 1) {
    const platform = cmap.readUInt16BE(4 + i * 8);
    const encoding = cmap.readUInt16BE(6 + i * 8);
    if (!(platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10)))) continue;
    const at = cmap.readUInt32BE(8 + i * 8);
    const format = cmap.readUInt16BE(at);
    if (format === 4) {
      const segments = cmap.readUInt16BE(at + 6) / 2;
      const ends = at + 14;
      const starts = ends + segments * 2 + 2;
      const deltas = starts + segments * 2;
      const rangeOffsets = deltas + segments * 2;
      for (let s = 0; s < segments; s += 1) {
        const start = cmap.readUInt16BE(starts + s * 2);
        const end = cmap.readUInt16BE(ends + s * 2);
        const delta = cmap.readInt16BE(deltas + s * 2);
        const rangeOffset = cmap.readUInt16BE(rangeOffsets + s * 2);
        for (let c = start; c <= end && c !== 0xffff; c += 1) {
          let glyph = (c + delta) & 0xffff;
          if (rangeOffset !== 0) {
            const raw = cmap.readUInt16BE(rangeOffsets + s * 2 + rangeOffset + (c - start) * 2);
            glyph = raw === 0 ? 0 : (raw + delta) & 0xffff;
          }
          if (glyph !== 0) covered.add(c);
        }
      }
    } else if (format === 12) {
      const groups = cmap.readUInt32BE(at + 12);
      for (let g = 0; g < groups; g += 1) {
        const start = cmap.readUInt32BE(at + 16 + g * 12);
        const end = cmap.readUInt32BE(at + 20 + g * 12);
        for (let c = start; c <= end; c += 1) covered.add(c);
      }
    }
  }
  return covered;
}

describe('guest-text와 세리프 부분 집합 서체', () => {
  it('Noto Serif KR 부분 집합이 관람객 문구의 모든 글자와 숫자·영문을 담는다', () => {
    const covered = coveredCodePoints(woffTable(readFileSync(SERIF), 'cmap'));
    const needed = new Set([...Object.values(guestText).join(''), ...'0123456789'].filter((c) => !/\s/.test(c)));
    const missing = [...needed].filter((c) => !covered.has(c.codePointAt(0)));
    assert.deepEqual(missing, [], '문구를 바꿨으면 세리프 서체를 다시 줄인다 (docs/SYSTEM.md 3절 "관람객 화면 → 서체")');
    assert.ok(covered.size < 400, `부분 집합이 아닌 것 같다: ${covered.size}자`);
  });
});
