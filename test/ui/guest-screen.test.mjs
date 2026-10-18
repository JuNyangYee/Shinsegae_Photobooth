// 실행: npm test
// 관람객 화면 표현(guest-screen.js, 6-2): 카운트다운 숫자·원형 진행, 플래시, 결과 카드·남은 시간, 안내 문구 표시.
// DOM은 필요한 만큼만 흉내 내고, 애니메이션은 animate() 호출만 기록한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { guestText } from '../../src/web/config/guest-text.js';
import { Guidance } from '../../src/web/core/guidance.js';
import { SessionState } from '../../src/web/core/session.js';
import { createGuestScreen } from '../../src/web/ui/guest-screen.js';

function fakeElement(id, log) {
  const classes = new Set();
  const element = {
    id, hidden: true, textContent: '', dataset: {}, src: '', animations: [],
    classList: { toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)), contains: (name) => classes.has(name) },
    removeAttribute(name) {
      if (name === 'src') element.src = '';
      log.push(`${id}: remove ${name}`);
    },
    animate(keyframes, options) {
      const animation = { keyframes, options, cancelled: false, cancel() { animation.cancelled = true; } };
      element.animations.push(animation);
      return animation;
    },
  };
  return element;
}

function setup({ countdownSeconds = 3 } = {}) {
  const log = [];
  const elements = new Map();
  const root = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, fakeElement(id, log));
      return elements.get(id);
    },
  };
  let clock = 1000;
  const screen = createGuestScreen({ root, text: guestText, countdownSeconds, now: () => clock });
  const el = (id) => root.getElementById(id);
  const snapshot = (state, extra = {}) => ({ state, countdown: 0, endsAt: null, photo: null, ...extra });
  return { screen, el, log, snapshot, setNow: (value) => { clock = value; } };
}

describe('guest-screen: 3·2·1', () => {
  it('카운트다운에 들어가면 원형 진행 두 반원이 카운트다운 시간 동안 돌고, 숫자마다 한 번 나타난다', () => {
    const { screen, el, snapshot } = setup({ countdownSeconds: 3 });
    screen.renderSession(snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(el('countdown').hidden, false);
    assert.equal(el('countdown-number').textContent, '3');
    for (const id of ['countdown-ring-a', 'countdown-ring-b']) {
      assert.equal(el(id).animations.length, 1);
      assert.equal(el(id).animations[0].options.duration, 3000);
      assert.equal(el(id).animations[0].options.fill, 'forwards');
    }
    assert.equal(el('countdown-number').animations.length, 1);

    // 같은 숫자로 다시 알려도(다른 상태 변화) 다시 움직이지 않는다
    screen.renderSession(snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(el('countdown-number').animations.length, 1);
    screen.renderSession(snapshot(SessionState.COUNTDOWN, { countdown: 2 }));
    assert.equal(el('countdown-number').textContent, '2');
    assert.equal(el('countdown-number').animations.length, 2);
    assert.equal(el('countdown-ring-a').animations.length, 1, '원형 진행은 회차에 한 번만 시작한다');
  });

  it('카운트다운이 끝나거나 취소되면 원형 진행을 멈추고, 다음 회차는 처음부터 돈다', () => {
    const { screen, el, snapshot } = setup();
    screen.renderSession(snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    screen.renderSession(snapshot(SessionState.IDLE)); // 취소
    assert.equal(el('countdown').hidden, true);
    assert.ok(el('countdown-ring-a').animations[0].cancelled);
    assert.ok(el('countdown-ring-b').animations[0].cancelled);
    screen.renderSession(snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(el('countdown-ring-a').animations.length, 2);
    assert.equal(el('countdown-number').animations.length, 2, '같은 숫자 3이라도 새 회차면 다시 나타난다');
  });
});

describe('guest-screen: 플래시', () => {
  it('촬영 상태에 들어갈 때 한 번만, 눈부시지 않게 짧게', () => {
    const { screen, el, snapshot } = setup();
    screen.renderSession(snapshot(SessionState.COUNTDOWN, { countdown: 1 }));
    screen.renderSession(snapshot(SessionState.CAPTURING));
    screen.renderSession(snapshot(SessionState.CAPTURING));
    const flashes = el('flash').animations;
    assert.equal(flashes.length, 1);
    assert.ok(flashes[0].options.duration <= 400);
    assert.ok(Math.max(...flashes[0].keyframes.map((k) => k.opacity)) <= 0.8);
  });
});

describe('guest-screen: 결과 출력물 카드', () => {
  it('결과 사진을 카드에 보이고, 남은 시간 막대가 종료 시각까지 줄어든다', () => {
    const { screen, el, snapshot } = setup();
    screen.renderSession(snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    assert.equal(el('result').src, 'blob:a');
    assert.equal(el('result').hidden, false);
    assert.equal(el('result-view').hidden, false);
    assert.equal(el('result-card').animations.length, 1);
    assert.equal(el('result-note').textContent, guestText.resultReady);
    assert.equal(el('result-timer').hidden, false);
    assert.equal(el('result-timer-fill').animations.length, 1);
    assert.equal(el('result-timer-fill').animations[0].options.duration, 10000);

    // 같은 결과로 다시 알려도 카드·막대를 다시 시작하지 않는다
    screen.renderSession(snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    assert.equal(el('result-card').animations.length, 1);
    assert.equal(el('result-timer-fill').animations.length, 1);
  });

  it('결과가 끝나면 사진 src를 지우고 카드·막대를 내린다', () => {
    const { screen, el, log, snapshot } = setup();
    screen.renderSession(snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    screen.renderSession(snapshot(SessionState.COOLDOWN, { endsAt: 16000 }));
    assert.equal(el('result').src, '');
    assert.deepEqual(log, ['result: remove src']);
    assert.equal(el('result').hidden, true);
    assert.equal(el('result-view').hidden, true);
    assert.ok(el('result-timer-fill').animations[0].cancelled);
  });

  it('종료 시계가 멈춰 있으면(인쇄 연동 뒤 출력 중) 막대를 숨기고 출력 중 문구, 시계가 시작되면 막대가 돈다', () => {
    const { screen, el, snapshot, setNow } = setup();
    screen.renderSession(snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: null }));
    assert.equal(el('result-timer').hidden, true);
    assert.equal(el('result-note').textContent, guestText.resultPrinting);
    assert.equal(el('result-timer-fill').animations.length, 0);
    setNow(5000);
    screen.renderSession(snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 15000 }));
    assert.equal(el('result-timer').hidden, false);
    assert.equal(el('result-note').textContent, guestText.resultReady);
    assert.equal(el('result-timer-fill').animations[0].options.duration, 10000);
  });
});

describe('guest-screen: 안내 문구', () => {
  it('준비 중·직원 문의는 바탕 막과 함께 보이고, 나타날 때만 움직인다', () => {
    const { screen, el } = setup();
    screen.setStatus({ message: guestText.preparing, kind: Guidance.PREPARING, visible: true });
    assert.equal(el('status').hidden, false);
    assert.equal(el('status-veil').hidden, false);
    assert.equal(el('status').textContent, guestText.preparing);
    assert.equal(el('status').dataset.kind, 'preparing');
    screen.setStatus({ message: guestText.staff, kind: Guidance.STAFF, visible: true });
    assert.equal(el('status').textContent, guestText.staff);
    assert.equal(el('status').dataset.kind, 'staff');
    assert.equal(el('status').animations.length, 1);
    screen.setStatus({ message: guestText.staff, kind: Guidance.STAFF, visible: false }); // 회차 진행 중
    assert.equal(el('status').hidden, true);
    assert.equal(el('status-veil').hidden, true);
  });

  it('대기 안내·쿨타임 문구는 정해진 글자로, 나타날 때만 움직인다', () => {
    const { screen, el } = setup();
    assert.equal(el('guide').textContent, guestText.idle);
    assert.equal(el('notice').textContent, guestText.cooldown);
    assert.equal(el('countdown-caption').textContent, guestText.countdown);
    screen.setGuide(true);
    screen.setGuide(true);
    assert.equal(el('guide').hidden, false);
    assert.equal(el('guide').animations.length, 1);
    screen.setGuide(false);
    assert.equal(el('guide').hidden, true);
    screen.setNotice(true);
    assert.equal(el('notice').hidden, false);
    assert.equal(el('notice').animations.length, 1);
  });

  it('인식 표시는 9:16 영역의 is-present 클래스 하나로 켜고 끈다', () => {
    const { screen, el } = setup();
    screen.setPresence(true);
    assert.ok(el('stage').classList.contains('is-present'));
    screen.setPresence(false);
    assert.ok(!el('stage').classList.contains('is-present'));
  });

  it('안내 규칙의 모든 안내에 문구가 있다 (확정 문구 그대로)', () => {
    for (const guidance of Object.values(Guidance).filter((g) => g !== Guidance.NONE)) {
      assert.equal(typeof guestText[guidance], 'string', guidance);
    }
    assert.equal(guestText.preparing, '준비 중입니다.\n잠시만 기다려 주세요.');
    assert.equal(guestText.staff, '준비 중입니다.\n직원에게 문의해 주세요.');
  });
});
