// 실행: npm test  (또는 node --test test/effect/oil-shaders.test.mjs)
// 셰이더 원문 검사 (7단계 검수): smoothstep(edge0, edge1, x)는 edge0 >= edge1이면 GLSL ES 3.00에서 결과가 정의되지 않는다.
// GPU·드라이버마다 다르게 계산할 수 있고 gpu=cpu 확인으로는 잡히지 않으므로, 숫자 경계를 쓴 호출을 원문에서 확인한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as shaders from '../../src/web/effect/oil-shaders.js';

describe('oil-shaders: smoothstep 경계', () => {
  it('숫자 경계를 쓴 smoothstep은 모두 edge0 < edge1 (역순 호출 없음)', () => {
    const literal = /smoothstep\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,/g;
    let count = 0;
    for (const [name, source] of Object.entries(shaders)) {
      if (typeof source !== 'string') continue;
      for (const [call, a, b] of source.matchAll(literal)) {
        count += 1;
        assert.ok(Number(a) < Number(b), `${name}: ${call} (edge0 >= edge1)`);
      }
    }
    assert.ok(count >= 6, `smoothstep 호출을 찾지 못함 (${count})`);
  });
});
