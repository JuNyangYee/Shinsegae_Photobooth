// 실행: npm test
// 관람객 문구(guest-text.js)와 두 서체(IMPRINT 시안): 세리프 Noto Serif KR 부분 집합은 영어 줄·숫자와 준비 중 첫 줄의 한글만 담고,
// 한국어 줄은 Pretendard(KS X 1001 부분 집합)로 보인다. 문구를 바꾸고
// 서체를 다시 줄이지 않으면 여기서 실패한다. WOFF(zlib) 표에서 cmap만 읽는다 (서체 도구 의존성 없음).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { brotliDecompressSync, inflateSync } from 'node:zlib';

import { guestText } from '../../src/web/config/guest-text.js';

const SERIF = new URL('../../src/web/assets/fonts/NotoSerifKR-Light.subset.woff', import.meta.url);
const SANS = ['Regular', 'Medium'].map((w) => new URL(`../../src/web/assets/fonts/Pretendard-${w}.subset.woff2`, import.meta.url));

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

/**
 * WOFF2(Brotli 한 덩어리)에서 표 하나를 꺼낸다. 표 목록의 길이는 UIntBase128, 변환된 표(glyf·loca 변환 0, 그 밖 변환 1 이상)는
 * transformLength가 붙는다. 풀린 데이터는 목록 순서대로 이어져 있고 cmap은 변환되지 않는다 (W3C WOFF2 5.2·5.3절)
 */
function woff2Table(bytes, wanted) {
  assert.equal(bytes.toString('latin1', 0, 4), 'wOF2');
  const KNOWN = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep'];
  const count = bytes.readUInt16BE(12);
  const compressed = bytes.readUInt32BE(20);
  let p = 48;
  const base128 = () => {
    let value = 0;
    for (let i = 0; i < 5; i += 1) {
      const b = bytes[p++];
      value = value * 128 + (b & 0x7f);
      if (!(b & 0x80)) return value;
    }
    throw new Error('bad UIntBase128');
  };
  const tables = [];
  for (let i = 0; i < count; i += 1) {
    const flags = bytes[p++];
    let tag = KNOWN[flags & 0x3f] ?? `#${flags & 0x3f}`;
    if ((flags & 0x3f) === 63) { tag = bytes.toString('latin1', p, p + 4); p += 4; }
    const version = flags >> 6;
    const origLength = base128();
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0;
    tables.push({ tag, length: transformed ? base128() : origLength });
  }
  const data = brotliDecompressSync(bytes.subarray(p, p + compressed));
  let offset = 0;
  for (const table of tables) {
    if (table.tag === wanted) return data.subarray(offset, offset + table.length);
    offset += table.length;
  }
  throw new Error(`no ${wanted} table`);
}

// 세리프로 보이는 글자: 영어 줄(en), 인쇄 쪽 꼬리 문장, 숫자(3·2·1), 준비 중·직원 문의 첫 줄(::first-line)
const firstLine = (t) => t.split('\n')[0];
const serifText = [
  ...Object.values(guestText).filter((v) => typeof v === 'object' && 'en' in v).map((v) => v.en),
  guestText.print.line, firstLine(guestText.preparing), firstLine(guestText.staff), '0123456789',
].join('');
// Pretendard로 보이는 글자: 한국어 줄(ko), 준비 중 둘째 줄, 운영자 표시, 머리·인쇄 쪽 날짜·시각·요일·용지 폭(라틴 대문자·숫자·기호)
const sansText = [
  ...Object.values(guestText).filter((v) => typeof v === 'object' && 'ko' in v).map((v) => v.ko),
  guestText.preparing, guestText.staff, guestText.paused, '0123456789.:ABCDEFGHIJKLMNOPQRSTUVWXYZ',
].join('');
const needed = (t) => [...new Set([...t].filter((c) => !/\s/.test(c)))];

describe('guest-text와 서체 부분 집합', () => {
  it('Noto Serif KR 부분 집합이 세리프로 보이는 글자(영어 줄·숫자·준비 중 첫 줄)를 모두 담는다', () => {
    const covered = coveredCodePoints(woffTable(readFileSync(SERIF), 'cmap'));
    const missing = needed(serifText).filter((c) => !covered.has(c.codePointAt(0)));
    assert.deepEqual(missing, [], '세리프 문구를 바꿨으면 세리프 서체를 다시 줄인다 (docs/SYSTEM.md 3절 "관람객 화면 → 서체")');
    assert.ok(covered.size < 400, `부분 집합이 아닌 것 같다: ${covered.size}자`);
  });

  it('Pretendard 400·500 부분 집합이 한국어 줄과 머리·인쇄 쪽 글자를 모두 담는다 (시스템 서체로 떨어지지 않게)', () => {
    for (const file of SANS) {
      const covered = coveredCodePoints(woff2Table(readFileSync(file), 'cmap'));
      assert.ok(covered.has('가'.codePointAt(0)) && covered.size > 2000, `${file}: cmap ${covered.size}자`);
      const missing = needed(sansText).filter((c) => !covered.has(c.codePointAt(0)));
      assert.deepEqual(missing, [], `${file}`);
    }
  });

  it('영어 줄은 세리프 부분 집합(U+0020–007E)만 쓴다 (세리프 한글 없이)', () => {
    for (const value of Object.values(guestText)) {
      if (typeof value === 'object' && 'en' in value) assert.match(value.en, /^[\x20-\x7e]+$/, value.en);
    }
    assert.match(guestText.print.line, /^[\x20-\x7e]+$/);
  });
});
