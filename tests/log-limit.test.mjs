// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLogLimiter } from '../src/web/js/log-limit.js';

function setup(summaryMs = 60000) {
  let time = 0;
  const lines = [];
  const log = createLogLimiter({
    summaryMs,
    now: () => time,
    wallClock: () => new Date(2026, 9, 15, 10, 0, 0).getTime() + time,
    sink: { warn: (...args) => lines.push(args.map(String).join(' ')) },
  });
  return { log, lines, advance: (ms) => { time += ms; } };
}

describe('createLogLimiter: 반복 오류 로그 제한', () => {
  it('같은 오류가 계속 나면 처음 한 번과 주기적인 요약만 남긴다', () => {
    const { log, lines, advance } = setup();
    // 3초마다 같은 카메라 오류 (재시도 간격), 3분 동안 61번
    for (let i = 0; i <= 60; i += 1) {
      log.warn('camera', 'unavailable / NotReadableError', new Error('busy'));
      advance(3000);
    }
    // 처음 1줄 + 60초마다 요약 3줄 (60·120·180초 시점)
    assert.equal(lines.length, 4);
    assert.match(lines[0], /^\[camera\] unavailable \/ NotReadableError/);
    assert.match(lines[1], /^\[camera\] 같은 오류 20회 더 \(마지막 10:01:00\): unavailable \/ NotReadableError/);
    assert.match(lines[2], /같은 오류 20회 더 \(마지막 10:02:00\)/);
    assert.match(lines[3], /같은 오류 20회 더 \(마지막 10:03:00\)/);
  });

  it('숫자만 다른 오류는 같은 오류로 센다 (경과 ms 등)', () => {
    const { log, lines } = setup();
    log.warn('capture', 'capture failed: stale frame: no new camera frame for 2001ms');
    log.warn('capture', 'capture failed: stale frame: no new camera frame for 2533ms');
    assert.equal(lines.length, 1);
    assert.equal(log.suppressed('capture'), 1);
  });

  it('오류가 바뀌면 바로 남기고, 감춰진 앞 오류 요약을 먼저 남긴다', () => {
    const { log, lines, advance } = setup();
    log.warn('detector', 'model-unavailable: HTTP 404');
    advance(1000);
    log.warn('detector', 'model-unavailable: HTTP 404');
    log.warn('detector', 'webgl-unavailable: no WebGL');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '[detector] model-unavailable: HTTP 404');
    assert.equal(lines[1], '[detector] 같은 오류 1회 더 (마지막 10:00:01): model-unavailable: HTTP 404');
    assert.equal(lines[2], '[detector] webgl-unavailable: no WebGL');
  });

  it('회복(clear)하면 감춰진 횟수를 요약하고, 다음 오류는 처음처럼 바로 남긴다', () => {
    const { log, lines } = setup();
    log.warn('detection', 'detection failed: x');
    log.warn('detection', 'detection failed: x');
    log.warn('detection', 'detection failed: x');
    log.clear('detection');
    log.clear('detection'); // 기억이 없으면 아무것도 하지 않는다
    log.warn('detection', 'detection failed: x');
    assert.equal(lines.length, 3);
    assert.match(lines[1], /같은 오류 2회 더/);
    assert.match(lines[2], /^\[detection\] detection failed: x/);
  });

  it('분류가 다르면 따로 센다', () => {
    const { log, lines } = setup();
    log.warn('camera', 'not-found');
    log.warn('capture', 'not-found');
    log.warn('camera', 'not-found');
    assert.equal(lines.length, 2);
  });
});
