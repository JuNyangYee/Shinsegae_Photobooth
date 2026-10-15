// 실행: npm test
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createDetectorKeeper } from '../src/web/js/detector-keeper.js';

// 손으로 진행시키는 타이머
function manualTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, ms) {
      const id = nextId++;
      pending.set(id, { callback, ms });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pending,
    runAll() {
      const due = [...pending.values()];
      pending.clear();
      due.forEach(({ callback }) => callback());
    },
  };
}

function fakeDetector(name) {
  return { name, closed: 0, close() { this.closed += 1; } };
}

// console.warn 출력은 테스트 결과를 어지럽히므로 잠시 막는다
async function quiet(fn) {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
}

describe('createDetectorKeeper', () => {
  it('생성 실패 → 원인 제거 → 재시도 간격 뒤 재생성 성공', () => quiet(async () => {
    const timers = manualTimers();
    let broken = true;
    let calls = 0;
    const keeper = createDetectorKeeper({
      retryMs: 15000,
      timers,
      create: async () => {
        calls += 1;
        if (broken) throw new Error('bundle unavailable');
        return fakeDetector('ok');
      },
    });

    await keeper.ensure();
    assert.equal(keeper.get(), null);
    assert.equal(keeper.getError(), 'bundle unavailable');
    assert.equal(keeper.isRetryScheduled(), true);
    assert.equal([...timers.pending.values()][0].ms, 15000);

    broken = false; // 원인 제거
    timers.runAll(); // 재시도 간격 경과
    assert.equal(keeper.isCreating(), true);
    await keeper.ensure(); // 진행 중인 생성을 기다린다
    assert.equal(keeper.get()?.name, 'ok');
    assert.equal(keeper.getError(), '');
    assert.equal(keeper.isRetryScheduled(), false);
    assert.equal(calls, 2);
  }));

  it('생성 중에 여러 번 시작해도 생성은 1회만', () => quiet(async () => {
    let calls = 0;
    let release;
    const keeper = createDetectorKeeper({
      retryMs: 15000,
      timers: manualTimers(),
      create: () => {
        calls += 1;
        return new Promise((resolve) => { release = () => resolve(fakeDetector('one')); });
      },
    });
    const first = keeper.ensure();
    const second = keeper.ensure();
    keeper.ensure();
    assert.equal(first, second);
    assert.equal(calls, 1);
    release();
    await first;
    await keeper.ensure(); // 이미 있으면 다시 만들지 않는다
    assert.equal(calls, 1);
    assert.equal(keeper.getAttempts(), 1);
  }));

  it('예약된 재시도가 있어도 ensure()로 앞당기면 예약은 지운다', () => quiet(async () => {
    const timers = manualTimers();
    let fail = true;
    const keeper = createDetectorKeeper({
      retryMs: 15000,
      timers,
      create: async () => {
        if (fail) throw new Error('x');
        return fakeDetector('early');
      },
    });
    await keeper.ensure();
    assert.equal(timers.pending.size, 1);
    fail = false;
    await keeper.ensure(); // 카메라 재연결·페이지 복귀 같은 계기
    assert.equal(keeper.get()?.name, 'early');
    assert.equal(timers.pending.size, 0);
  }));

  it('계속 실패하는 감지기는 닫고 버린 뒤 재시도 간격 뒤 새로 만든다', () => quiet(async () => {
    const timers = manualTimers();
    const made = [];
    const keeper = createDetectorKeeper({
      retryMs: 15000,
      timers,
      create: async () => {
        const detector = fakeDetector(`d${made.length + 1}`);
        made.push(detector);
        return detector;
      },
    });
    await keeper.ensure();
    const first = keeper.get();
    keeper.discard('detection kept failing: context lost');
    assert.equal(first.closed, 1);
    assert.equal(keeper.get(), null);
    assert.match(keeper.getError(), /context lost/);
    assert.equal(keeper.isRetryScheduled(), true);
    keeper.discard('again'); // 이미 버렸으면 아무것도 하지 않는다
    assert.equal(first.closed, 1);

    timers.runAll();
    await keeper.ensure();
    assert.equal(keeper.get()?.name, 'd2');
    assert.equal(made.length, 2);
  }));

  it('close()가 예외를 던져도 버리고 재생성을 예약한다', () => quiet(async () => {
    const timers = manualTimers();
    const keeper = createDetectorKeeper({
      retryMs: 1000,
      timers,
      create: async () => ({ close() { throw new Error('already lost'); } }),
    });
    await keeper.ensure();
    keeper.discard('lost');
    assert.equal(keeper.get(), null);
    assert.equal(keeper.isRetryScheduled(), true);
  }));

  it('상태가 바뀔 때마다 onChange를 부른다 (생성 시작·끝, 버림)', () => quiet(async () => {
    let changes = 0;
    const keeper = createDetectorKeeper({
      retryMs: 1000,
      timers: manualTimers(),
      onChange: () => { changes += 1; },
      create: async () => fakeDetector('x'),
    });
    await keeper.ensure();
    assert.equal(changes, 2);
    keeper.discard('r');
    assert.equal(changes, 3);
  }));
});
