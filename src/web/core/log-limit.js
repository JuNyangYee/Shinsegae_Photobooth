// 반복 오류 로그 제한. 무인 운영 중 같은 오류가 계속 나도 콘솔에는 처음 한 번과 주기적인 요약만 남긴다.
// 카메라·감지기·캡처 오류가 같은 규칙을 쓴다. Node 테스트: tests/log-limit.test.mjs

export const LOG_SUMMARY_MS = 60000; // 같은 오류가 이어지면 이 간격마다 한 번 요약을 남긴다 (가안)

// 숫자(경과 ms, 시도 횟수 등)만 다른 오류는 같은 오류로 본다.
const sameKind = (signature) => String(signature).replace(/\d+(?:\.\d+)?/g, '#');

function formatClock(wallMs) {
  const d = new Date(wallMs);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((n) => String(n).padStart(2, '0')).join(':');
}

/**
 * 분류(`category`)마다 마지막 오류의 서명(`signature`, 예: 상태·오류 이름)을 기억한다. 숫자만 다른 서명은 같은 오류로 본다.
 * - 처음 나거나 서명이 바뀌면 바로 남긴다 (바뀌기 전 오류가 감춰져 있었으면 그 요약을 먼저 남긴다).
 * - 같은 서명이 이어지면 세기만 하고, 마지막으로 남긴 뒤 summaryMs가 지나면 "같은 오류 N회, 마지막 시각"을 남긴다.
 * - 회복되면 `clear(category)`: 감춰진 횟수가 있으면 요약을 남기고 기억을 지운다. 다음 오류는 다시 처음부터 남긴다.
 * 별도 타이머는 없다. 요약은 다음 오류나 회복 때 남는다.
 * @param {{ summaryMs?: number, now?: () => number, wallClock?: () => number,
 *   sink?: { warn: Function } }} [options] now는 간격 계산용(performance.now), wallClock은 사람이 읽는 시각용(Date.now)
 */
export function createLogLimiter({
  summaryMs = LOG_SUMMARY_MS, now = () => performance.now(), wallClock = () => Date.now(), sink = console,
} = {}) {
  const entries = new Map(); // category -> { kind, signature(마지막 원문), printedAt, suppressed, lastWall }

  function summarize(category, entry) {
    if (entry.suppressed === 0) return;
    sink.warn(`[${category}] 같은 오류 ${entry.suppressed}회 더 (마지막 ${formatClock(entry.lastWall)}): ${entry.signature}`);
    entry.suppressed = 0;
    entry.printedAt = now();
  }

  return {
    /** 오류를 남긴다. 같은 분류에서 같은 서명이 이어지면 요약만 남긴다. 실제로 콘솔에 남겼으면 true */
    warn(category, signature, ...details) {
      const entry = entries.get(category);
      const kind = sameKind(signature);
      if (entry && entry.kind === kind) {
        entry.signature = signature;
        entry.suppressed += 1;
        entry.lastWall = wallClock();
        if (now() - entry.printedAt < summaryMs) return false;
        summarize(category, entry);
        return true;
      }
      if (entry) summarize(category, entry);
      entries.set(category, { kind, signature, printedAt: now(), suppressed: 0, lastWall: wallClock() });
      sink.warn(`[${category}]`, signature, ...details);
      return true;
    },
    /** 회복: 감춰진 횟수가 있으면 요약을 남기고 기억을 지운다. 기억이 없으면 아무것도 하지 않는다 (매 프레임 불러도 된다). */
    clear(category) {
      const entry = entries.get(category);
      if (!entry) return;
      summarize(category, entry);
      entries.delete(category);
    },
    /** D 화면·테스트용: 분류별 감춰진 횟수 */
    suppressed: (category) => entries.get(category)?.suppressed ?? 0,
  };
}

/** 앱 전체가 함께 쓰는 기본 인스턴스 */
export const errorLog = createLogLimiter();
