// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Guidance, decideGuidance } from '../src/web/js/guidance.js';

const ok = Object.freeze({ ok: true, staffNow: false, since: null });
const down = (since, staffNow = false) => ({ ok: false, staffNow, since });
const STAFF_MS = 30000;

describe('decideGuidance: 카메라·감지기 안내 규칙', () => {
  it('둘 다 정상이면 문구 없음, since는 지운다', () => {
    assert.deepEqual(decideGuidance({ camera: ok, detector: ok, since: 5000, now: 9000, staffAfterMs: STAFF_MS }),
      { guidance: Guidance.NONE, since: null, recheckInMs: null });
  });

  it('카메라·감지기 조합: 하나라도 쓸 수 없으면 준비 중', () => {
    const cases = [
      { camera: down(1000), detector: ok },
      { camera: ok, detector: down(1000) },
      { camera: down(1000), detector: down(1000) },
    ];
    for (const { camera, detector } of cases) {
      const result = decideGuidance({ camera, detector, since: null, now: 11000, staffAfterMs: STAFF_MS });
      assert.equal(result.guidance, Guidance.PREPARING);
      assert.equal(result.since, 1000);
      assert.equal(result.recheckInMs, 20000);
    }
  });

  it('30초 전환: 29.999초 준비 중 → 30초 직원 문의', () => {
    const at = (now) => decideGuidance({ camera: ok, detector: down(0), since: null, now, staffAfterMs: STAFF_MS });
    assert.equal(at(29999).guidance, Guidance.PREPARING);
    assert.equal(at(29999).recheckInMs, 1);
    assert.equal(at(30000).guidance, Guidance.STAFF);
    assert.equal(at(30000).recheckInMs, null);
  });

  it('스스로 풀리기 어려운 상태(카메라 권한 거절·감지기 장애)는 바로 직원 문의', () => {
    assert.equal(decideGuidance({ camera: down(0, true), detector: ok, since: null, now: 1, staffAfterMs: STAFF_MS }).guidance,
      Guidance.STAFF);
    assert.equal(decideGuidance({ camera: ok, detector: down(0, true), since: null, now: 1, staffAfterMs: STAFF_MS }).guidance,
      Guidance.STAFF);
    // 정상인 쪽의 staffNow는 보지 않는다
    assert.equal(decideGuidance({ camera: { ok: true, staffNow: true, since: null }, detector: ok, since: null, now: 1,
      staffAfterMs: STAFF_MS }).guidance, Guidance.NONE);
  });

  it('시간은 둘 중 하나라도 쓸 수 없게 된 때부터 이어서 잰다 (카메라 20초 → 감지기로 넘어가도 이어짐)', () => {
    // 0초: 카메라 끊김
    let r = decideGuidance({ camera: down(0), detector: ok, since: null, now: 0, staffAfterMs: STAFF_MS });
    // 19초: 감지기도 버려짐(컨텍스트 손실)
    r = decideGuidance({ camera: down(0), detector: down(19000), since: r.since, now: 19000, staffAfterMs: STAFF_MS });
    // 20초: 카메라는 돌아왔지만 감지기는 아직 없음 → 0초부터 잰다
    r = decideGuidance({ camera: ok, detector: down(19000), since: r.since, now: 20000, staffAfterMs: STAFF_MS });
    assert.equal(r.guidance, Guidance.PREPARING);
    assert.equal(r.since, 0);
    r = decideGuidance({ camera: ok, detector: down(19000), since: r.since, now: 30000, staffAfterMs: STAFF_MS });
    assert.equal(r.guidance, Guidance.STAFF);
    // 둘 다 정상 → 처음으로. 다시 끊기면 새로 잰다
    r = decideGuidance({ camera: ok, detector: ok, since: r.since, now: 31000, staffAfterMs: STAFF_MS });
    r = decideGuidance({ camera: down(40000), detector: ok, since: r.since, now: 40000, staffAfterMs: STAFF_MS });
    assert.equal(r.since, 40000);
    assert.equal(r.recheckInMs, 30000);
  });

  it('부분의 since가 판정 시각보다 이르면 그 시각부터 잰다 (판정이 늦게 불려도)', () => {
    const r = decideGuidance({ camera: down(2000), detector: ok, since: null, now: 33000, staffAfterMs: STAFF_MS });
    assert.equal(r.guidance, Guidance.STAFF);
    assert.equal(r.since, 2000);
  });
});
