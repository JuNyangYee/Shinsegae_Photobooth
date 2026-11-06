// 크로마 그린 키 (14단계, 가안): 관람객 화면 전경(캐릭터·들보)이 단색 그린(#00FF00) 위에 그려진 생성 이미지라 알파가 없다.
// 화소마다 그린 우세 d = G − max(R, B)로 투명도를 정한다: d ≤ low면 그대로(불투명), d ≥ high면 투명, 사이는 비례.
// 반투명이 된 가장자리 화소는 G를 max(R, B)로 눌러 초록 번짐을 지운다. 폭(width)을 주면 키가 빠진 화소에서 EDGE_RADIUS 안의
// 불투명 화소도 G를 max(R, B)로 눌러 캐릭터 둘레의 연두빛 테두리를 지운다(둘레만이라 안쪽 옷 색은 그대로). 캐릭터의 어두운·탁한 초록(깨또 목도리, 후트 바지)은
// G가 R·B보다 조금만 높아 low 아래에 머문다. 나중의 알파 없는 캐릭터 영상도 같은 키 색·같은 함수(또는 같은 식의 셰이더)로 뺀다.
// 순수 함수 (RGBA 배열을 제자리에서 고친다). Node 테스트: test/core/chroma-key.test.mjs

/** 그린 우세 d에 대한 알파(0~255). 순수 함수 */
export function greenKeyAlpha(r, g, b, { low, high }) {
  const d = g - Math.max(r, b);
  if (d <= low) return 255;
  if (d >= high) return 0;
  return Math.round((255 * (high - d)) / (high - low));
}

export const EDGE_RADIUS = 2;

/**
 * RGBA 화소 배열(ImageData.data)에서 그린 배경을 투명하게 만든다. 원래 알파보다 커지지 않는다.
 * @param {Uint8ClampedArray | Uint8Array} data
 * @param {{ low: number, high: number }} key
 * @param {number} [width] 한 줄 화소 수. 주면 키 둘레(EDGE_RADIUS)의 불투명 화소도 초록 번짐을 지운다
 * @returns {{ cleared: number, edge: number, despilled: number }} 완전히 투명해진 화소 수, 반투명 가장자리 화소 수, 둘레에서 번짐을 지운 불투명 화소 수
 */
export function applyGreenKey(data, key, width = 0) {
  if (!(key.low >= 0 && key.high > key.low && key.high <= 255)) throw new RangeError(`bad green key ${key.low}~${key.high}`);
  let cleared = 0;
  let edge = 0;
  for (let i = 0; i < data.length; i += 4) {
    const alpha = greenKeyAlpha(data[i], data[i + 1], data[i + 2], key);
    if (alpha === 255) continue;
    if (alpha === 0) cleared += 1;
    else edge += 1;
    data[i + 1] = Math.max(data[i], data[i + 2]);
    data[i + 3] = Math.min(data[i + 3], alpha);
  }
  return { cleared, edge, despilled: width > 0 ? despillRim(data, width) : 0 };
}

// 키가 빠진(알파 < 255) 화소에서 EDGE_RADIUS 안의 불투명 화소: G > max(R, B)면 max(R, B)로 누른다
function despillRim(data, width) {
  const n = data.length / 4;
  const height = Math.floor(n / width);
  const keyed = new Uint8Array(n);
  for (let p = 0; p < n; p += 1) keyed[p] = data[p * 4 + 3] < 255 ? 1 : 0;
  let count = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const p = y * width + x;
      const i = p * 4;
      if (keyed[p] || data[i + 1] <= Math.max(data[i], data[i + 2])) continue;
      let near = false;
      for (let dy = -EDGE_RADIUS; dy <= EDGE_RADIUS && !near; dy += 1) {
        const yy = y + dy;
        if (yy < 0 || yy >= height) continue;
        for (let dx = -EDGE_RADIUS; dx <= EDGE_RADIUS; dx += 1) {
          const xx = x + dx;
          if (xx >= 0 && xx < width && keyed[yy * width + xx]) { near = true; break; }
        }
      }
      if (!near) continue;
      data[i + 1] = Math.max(data[i], data[i + 2]);
      count += 1;
    }
  }
  return count;
}
