// 관람객 안내 규칙: 카메라 상태와 감지기 상태를 하나의 규칙으로 합쳐 "준비 중" / "직원 문의" 문구를 정한다.
// 순수 함수. Node 테스트: tests/guidance.test.mjs

export const Guidance = Object.freeze({
  NONE: 'none', // 둘 다 정상: 문구 없음
  PREPARING: 'preparing', // "준비 중입니다. 잠시만 기다려 주세요."
  STAFF: 'staff', // "준비 중입니다. 직원에게 문의해 주세요."
});

/**
 * 하나라도 쓸 수 없으면 "준비 중", 쓸 수 없는 상태가 staffAfterMs 이상 이어지거나 스스로 풀리기 어려운 상태(staffNow)면 "직원 문의".
 * 이어진 시간은 카메라·감지기 중 하나라도 쓸 수 없게 된 때부터 잰다. 둘 다 정상이 되면 처음으로 돌아간다.
 * @param {{ camera: Part, detector: Part, since: number | null, now: number, staffAfterMs: number }} input
 *   Part = { ok: boolean, staffNow: boolean, since: number | null }  since: 그 부분이 쓸 수 없게 된 시각(같은 시계)
 *   since(바깥): 직전 판정이 돌려준 since. 처음이면 null
 * @returns {{ guidance: string, since: number | null, recheckInMs: number | null }}
 *   since는 다음 판정에 넘긴다. recheckInMs 뒤 다시 판정하면 "직원 문의"로 바뀐다(없으면 null)
 */
export function decideGuidance({ camera, detector, since, now, staffAfterMs }) {
  const unavailable = [camera, detector].filter((part) => !part.ok);
  if (unavailable.length === 0) return { guidance: Guidance.NONE, since: null, recheckInMs: null };
  const start = Math.min(since ?? now, ...unavailable.map((part) => part.since ?? now));
  if (unavailable.some((part) => part.staffNow)) return { guidance: Guidance.STAFF, since: start, recheckInMs: null };
  const waited = now - start;
  if (waited >= staffAfterMs) return { guidance: Guidance.STAFF, since: start, recheckInMs: null };
  return { guidance: Guidance.PREPARING, since: start, recheckInMs: staffAfterMs - waited };
}
