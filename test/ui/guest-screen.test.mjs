// 실행: npm test
// 관람객 화면 표현(guest-screen.js, IMPRINT 시안): 단계 표시, 머리 시각(멈춤·촬영 시각), 짜 넣기·빠지기, 3·2·1(숫자 넘기기·틀 아래 진행선),
// 셔터 빛, 결과(종이·틀 자리 사진·남은 시간·걷히기), 쿨타임 진행선, 안내 문구, 동작 줄이기.
// DOM은 필요한 만큼만 흉내 내고, 애니메이션은 animate() 호출만 기록한다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { guestText } from '../../src/web/config/guest-text.js';
import { Guidance } from '../../src/web/core/guidance.js';
import { SessionState } from '../../src/web/core/session.js';
import { createGuestScreen } from '../../src/web/ui/guest-screen.js';
import { fakeClock } from '../helpers.mjs';

function fakeDocument(log) {
  const byId = new Map();
  function element(tag, id = '') {
    const classes = new Set();
    const attributes = new Map();
    let ownText = '';
    const el = {
      tag, id, hidden: tag === 'auto' ? true : false, dataset: {}, src: '', animations: [], children: [], parent: null,
      classList: {
        toggle: (name, on) => (on ? classes.add(name) : classes.delete(name)),
        contains: (name) => classes.has(name), add: (name) => classes.add(name),
      },
      get className() { return [...classes].join(' '); },
      set className(value) { classes.clear(); value.split(' ').filter(Boolean).forEach((c) => classes.add(c)); },
      get textContent() { return el.children.length ? el.children.map((c) => c.textContent).join('') : ownText; },
      set textContent(value) { el.children = []; ownText = String(value); },
      setAttribute: (name, value) => attributes.set(name, value),
      getAttribute: (name) => attributes.get(name),
      removeAttribute(name) {
        if (name === 'src') { el.src = ''; log.push(`${el.id}: remove src`); }
        if (name === 'id') el.id = '';
        attributes.delete(name);
      },
      append(...nodes) { nodes.forEach((n) => { n.parent = el; el.children.push(n); }); },
      replaceChildren(...nodes) { el.children = []; ownText = ''; el.append(...nodes); },
      after(node) { log.push(`after ${el.id}`); node.parent = el.parent; el.after.inserted = node; },
      remove() { el.removed = true; },
      cloneNode() {
        const copy = element(tag, el.id);
        copy.className = el.className;
        copy.hidden = el.hidden;
        copy.textContent = ownText;
        copy.append(...el.children.map((c) => c.cloneNode()));
        return copy;
      },
      querySelectorAll(selector) {
        const all = [];
        const walk = (node) => node.children.forEach((c) => { all.push(c); walk(c); });
        walk(el);
        if (selector === '[id]') return all.filter((n) => n.id);
        if (selector === '.is-ghost') return all.filter((n) => n.classList.contains('is-ghost'));
        return all.filter((n) => (n.parent?.classList.contains('line') && n.tag === 'span') || n.classList.contains('countdown-glyph'));
      },
      animate(keyframes, options) {
        let resolveFinished;
        const animation = {
          keyframes, options, cancelled: false, finished: new Promise((r) => { resolveFinished = r; }),
          cancel() { animation.cancelled = true; }, finish: () => resolveFinished(),
        };
        el.animations.push(animation);
        return animation;
      },
    };
    return el;
  }
  const requested = new Set();
  return {
    requested,
    getElementById(id) {
      requested.add(id);
      if (!byId.has(id)) {
        const el = element('auto', id);
        if (['stage', 'flash', 'result-paper', 'result-card', 'result-timer', 'result-timer-fill', 'countdown-progress-fill',
          'cooldown-progress-fill', 'countdown-number', 'countdown-ghost', 'countdown-caption'].includes(id)) el.hidden = false;
        byId.set(id, el);
      }
      return byId.get(id);
    },
    createElement: (tag) => element(tag),
  };
}

function setup({ countdownSeconds = 3, reduced = false } = {}) {
  const log = [];
  const root = fakeDocument(log);
  const clock = fakeClock(1000); // performance.now 쪽 (endsAt)과 타이머
  const motion = { reduced };
  const screen = createGuestScreen({
    root, text: guestText, countdownSeconds, now: clock.now, timers: clock.timers, reducedMotion: () => motion.reduced,
  });
  const el = (id) => root.getElementById(id);
  const snapshot = (state, extra = {}) => ({ state, countdown: 0, endsAt: null, photo: null, ...extra });
  return {
    screen, el, log, snapshot, clock, motion,
    requested: root.requested,
    advance: (ms) => clock.advance(ms),
  };
}

const transforms = (animation) => animation.keyframes.map((k) => k.transform);

describe('guest-screen: 날짜·시각 없음 (14단계)', () => {
  it('머리 날짜·시각 요소를 찾지도 않고, 시계 타이머도 걸지 않는다', () => {
    const t = setup();
    assert.ok(!['masthead-date', 'masthead-day', 'masthead-time'].some((id) => t.requested.has(id)));
    assert.equal(t.clock.pending.size, 0);
    t.screen.renderSession(t.snapshot(SessionState.CAPTURING));
    assert.equal(t.clock.pending.size, 0);
  });
});

describe('guest-screen: 단계·짜 넣기', () => {
  it('9:16 영역에 상태 기계 단계를 data-phase로 둔다 (CSS가 여백 막·모서리를 바꾼다)', () => {
    const t = setup();
    assert.equal(t.el('stage').dataset.phase, 'idle');
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(t.el('stage').dataset.phase, 'countdown');
  });

  it('대기 안내는 한국어 줄 + 영어 줄 (눈 바닥 글씨). 보일 때 줄마다 창 아래에서 올라온다 (차례로)', () => {
    const t = setup();
    const guide = t.el('guide');
    assert.equal(guide.textContent, guestText.idle.ko + guestText.idle.en);
    assert.deepEqual(guide.children.map((c) => c.className), ['line is-ko', 'line is-en']);
    t.screen.setGuide(true);
    t.screen.setGuide(true);
    assert.equal(guide.hidden, false);
    const inners = guide.children.slice(0, 2).map((line) => line.children[0]);
    assert.deepEqual(inners.map((i) => i.animations.length), [1, 1], '나타날 때만');
    assert.deepEqual(transforms(inners[0].animations[0]), ['translateY(108%)', 'translateY(0)']);
    assert.ok(inners[1].animations[0].options.delay > inners[0].animations[0].options.delay);
  });

  it('빠질 때는 원본을 바로 숨기고(상태 즉시), id 없는 복제본이 위로 빠진 뒤 지워진다', async () => {
    const t = setup();
    const guide = t.el('guide');
    t.screen.setGuide(true);
    t.screen.setGuide(false);
    assert.equal(guide.hidden, true, 'hidden은 바로');
    const ghost = guide.after.inserted;
    assert.ok(ghost && ghost.id === '' && ghost.hidden === false && ghost.getAttribute('aria-hidden') === 'true');
    const leaving = ghost.querySelectorAll('.line > span');
    assert.equal(leaving.length, 2);
    assert.deepEqual(transforms(leaving[0].animations[0]), ['translateY(0)', 'translateY(-108%)']);
    leaving.forEach((n) => n.animations[0].finish());
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(ghost.removed, true);
  });

  it('쿨타임 문구: 한국어·영어 줄, 틀 아래 선이 남은 쿨타임 동안 차오르고 끝나면 멈춘다', () => {
    const t = setup();
    assert.equal(t.el('notice').textContent, guestText.cooldown.ko + guestText.cooldown.en);
    t.screen.renderSession(t.snapshot(SessionState.COOLDOWN, { endsAt: 1000 + 5000 }));
    t.screen.setNotice(true);
    t.screen.setNotice(true);
    const fill = t.el('cooldown-progress-fill').animations;
    assert.equal(fill.length, 1);
    assert.equal(fill[0].options.duration, 5000);
    assert.deepEqual(transforms(fill[0]), ['scaleX(0)', 'scaleX(1)']);
    t.screen.renderSession(t.snapshot(SessionState.IDLE));
    t.screen.setNotice(false);
    assert.ok(fill[0].cancelled);
    assert.equal(t.el('notice').hidden, true);
  });
});

describe('guest-screen: 3·2·1', () => {
  it('카운트다운에 들어가면 틀 아래 선이 카운트다운 시간 동안 차오르고, 숫자마다 한 칸 창 안에서 위로 넘어간다', () => {
    const t = setup({ countdownSeconds: 3 });
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(t.el('countdown').hidden, false);
    assert.equal(t.el('countdown-number').textContent, '3');
    assert.equal(t.el('countdown-caption').textContent, guestText.countdown.ko.replace('\n', '') + guestText.countdown.en);
    assert.deepEqual(t.el('countdown-caption').children.map((c) => c.className), ['line is-ko', 'line is-en'], 'WISHFUL: 안내 한 줄 + 영어 줄 (숫자는 위 띠)');
    const progress = t.el('countdown-progress-fill').animations;
    assert.equal(progress.length, 1);
    assert.equal(progress[0].options.duration, 3000);
    assert.equal(progress[0].options.fill, 'forwards');
    assert.deepEqual(transforms(progress[0]), ['scaleX(0)', 'scaleX(1)'], 'transform만 움직인다');
    assert.equal(t.el('countdown-number').animations.length, 1);
    assert.equal(t.el('countdown-ghost').animations.length, 0, '첫 숫자는 앞 숫자가 없다');

    // 같은 숫자로 다시 알려도(다른 상태 변화) 다시 움직이지 않는다
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(t.el('countdown-number').animations.length, 1);
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 2 }));
    assert.equal(t.el('countdown-number').textContent, '2');
    assert.equal(t.el('countdown-ghost').textContent, '3', '앞 숫자는 위로 빠진다');
    assert.deepEqual(transforms(t.el('countdown-number').animations[1]), ['translateY(100%)', 'translateY(0)']);
    assert.deepEqual(transforms(t.el('countdown-ghost').animations[0]), ['translateY(0)', 'translateY(-100%)']);
    assert.equal(t.el('countdown-progress-fill').animations.length, 1, '진행선은 회차에 한 번만 시작한다');
  });

  it('진행선 길이는 상태 기계 스냅숏의 그 회차 countdownSeconds를 따른다 (10단계 시간 섹션, 없으면 만들 때 값)', () => {
    const t = setup({ countdownSeconds: 3 });
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 5, countdownSeconds: 5 }));
    assert.equal(t.el('countdown-number').textContent, '5');
    assert.equal(t.el('countdown-progress-fill').animations[0].options.duration, 5000);
    t.screen.renderSession(t.snapshot(SessionState.IDLE, { countdownSeconds: 2 }));
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 2, countdownSeconds: 2 }));
    assert.equal(t.el('countdown-progress-fill').animations[1].options.duration, 2000);
  });

  it('셔터면 숫자 묶음을 바로 끊고(복제본 없음), 취소면 위로 빠진다. 다음 회차는 처음부터', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 1 }));
    t.screen.renderSession(t.snapshot(SessionState.CAPTURING));
    assert.equal(t.el('countdown').hidden, true);
    assert.equal(t.el('countdown').after.inserted, undefined, '셔터는 끊는다');
    assert.ok(t.el('countdown-progress-fill').animations[0].cancelled);

    t.screen.renderSession(t.snapshot(SessionState.IDLE));
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 2 }));
    t.screen.renderSession(t.snapshot(SessionState.IDLE)); // 취소 (떠남)
    assert.equal(t.el('countdown').hidden, true);
    const ghost = t.el('countdown').after.inserted;
    assert.ok(ghost, '취소는 복제본이 빠진다');
    assert.equal(ghost.querySelectorAll('.is-ghost').length, 0, '앞 숫자 자리는 복제하지 않는다');
    assert.equal(ghost.querySelectorAll('[id]').length, 0, '복제본에 id가 없다');
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    assert.equal(t.el('countdown-progress-fill').animations.length, 3);
    assert.equal(t.el('countdown-ghost').textContent, '', '새 회차는 앞 숫자 없이');
  });
});

describe('guest-screen: 셔터 빛', () => {
  it('촬영 상태에 들어갈 때 한 번만, 눈부시지 않게 짧게 (사진 틀 안, CSS)', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 1 }));
    t.screen.renderSession(t.snapshot(SessionState.CAPTURING));
    t.screen.renderSession(t.snapshot(SessionState.CAPTURING));
    const flashes = t.el('flash').animations;
    assert.equal(flashes.length, 1);
    assert.ok(flashes[0].options.duration <= 400);
    assert.ok(Math.max(...flashes[0].keyframes.map((k) => k.opacity)) <= 0.8);
  });
});

describe('guest-screen: 결과', () => {
  it('결과 사진을 틀 자리에 움직임 없이 놓고 둘레 종이가 번진다. 문구가 짜 넣어지고 사진 아래 선이 종료 시각까지 줄어든다', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    assert.equal(t.el('result').src, 'blob:a');
    assert.equal(t.el('result').hidden, false);
    assert.equal(t.el('result-view').hidden, false);
    assert.equal(t.el('result-card').animations.length, 0, '사진은 움직이지 않는다 (화소 그대로, 멈춘 그림처럼)');
    assert.deepEqual(t.el('result-paper').animations[0].keyframes.map((k) => k.opacity), [0, 1]);
    assert.equal(t.el('result-note').textContent, guestText.resultReady.ko + guestText.resultReady.en);
    assert.equal(t.el('result-note').hidden, false);
    assert.equal(t.el('result-timer').hidden, false);
    assert.equal(t.el('result-timer-fill').animations.length, 1);
    assert.equal(t.el('result-timer-fill').animations[0].options.duration, 10000);

    // 같은 결과로 다시 알려도 종이·선을 다시 시작하지 않는다
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    assert.equal(t.el('result-paper').animations.length, 1);
    assert.equal(t.el('result-timer-fill').animations.length, 1);
  });

  it('끝나기 0.7초 전 종이·사진·문구가 걷히고 머리가 흰색으로 돌아갈 표시(data-leaving), 결과가 끝나면 지운다', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    t.advance(9200);
    assert.equal(t.el('stage').dataset.leaving, undefined);
    t.advance(200);
    assert.equal(t.el('stage').dataset.leaving, '');
    const fade = t.el('result-paper').animations.at(-1);
    assert.deepEqual(fade.keyframes.map((k) => k.opacity), [1, 0]);
    assert.ok(t.el('result-card').animations[0], '사진도 걷힌다');
    t.screen.renderSession(t.snapshot(SessionState.COOLDOWN, { endsAt: 16000 }));
    assert.equal(t.el('stage').dataset.leaving, undefined);
    assert.ok(fade.cancelled, '다음 결과에 남지 않게');
    t.screen.dispose();
  });

  it('1비트 점 사진(감열지)만 is-dots, 결과가 끝나면 지운다', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a', dots: false }, endsAt: 11000 }));
    assert.equal(t.el('result-card').classList.contains('is-dots'), false);
    t.screen.renderSession(t.snapshot(SessionState.COOLDOWN, { endsAt: 16000 }));
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:b', dots: true }, endsAt: 31000 }));
    assert.equal(t.el('result-card').classList.contains('is-dots'), true);
    t.screen.renderSession(t.snapshot(SessionState.COOLDOWN, { endsAt: 36000 }));
    assert.equal(t.el('result-card').classList.contains('is-dots'), false, '결과가 끝나면 지운다');
  });

  it('결과가 끝나면 사진 src를 지우고 결과 화면·선을 내린다', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 11000 }));
    t.screen.renderSession(t.snapshot(SessionState.COOLDOWN, { endsAt: 16000 }));
    assert.equal(t.el('result').src, '');
    assert.deepEqual(t.log.filter((l) => l.includes('src')), ['result: remove src']);
    assert.equal(t.el('result').hidden, true);
    assert.equal(t.el('result-view').hidden, true);
    assert.ok(t.el('result-timer-fill').animations[0].cancelled);
  });

  it('종료 시계가 멈춰 있으면(인쇄 연동 뒤 출력 중) 선을 숨기고 출력 중 문구, 시계가 시작되면 선이 돈다', () => {
    const t = setup();
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: null }));
    assert.equal(t.el('result-timer').hidden, true);
    assert.equal(t.el('result-note').textContent, guestText.resultPrinting.ko + guestText.resultPrinting.en);
    assert.equal(t.el('result-timer-fill').animations.length, 0);
    t.clock.advance(4000);
    t.screen.renderSession(t.snapshot(SessionState.RESULT, { photo: { url: 'blob:a' }, endsAt: 15000 }));
    assert.equal(t.el('result-timer').hidden, false);
    assert.equal(t.el('result-note').textContent, guestText.resultReady.ko + guestText.resultReady.en);
    assert.equal(t.el('result-timer-fill').animations[0].options.duration, 10000);
  });
});

describe('guest-screen: 안내 문구', () => {
  it('준비 중·직원 문의는 바탕 막과 함께 보이고, 나타날 때만 움직인다', () => {
    const t = setup();
    t.screen.setStatus({ message: guestText.preparing, kind: Guidance.PREPARING, visible: true });
    assert.equal(t.el('status').hidden, false);
    assert.equal(t.el('status-veil').hidden, false);
    assert.equal(t.el('status').textContent, guestText.preparing);
    assert.equal(t.el('status').dataset.kind, 'preparing');
    t.screen.setStatus({ message: guestText.staff, kind: Guidance.STAFF, visible: true });
    assert.equal(t.el('status').textContent, guestText.staff);
    assert.equal(t.el('status').dataset.kind, 'staff');
    assert.equal(t.el('status').animations.length, 1);
    t.screen.setStatus({ message: guestText.staff, kind: Guidance.STAFF, visible: false }); // 회차 진행 중
    assert.equal(t.el('status').hidden, true);
    assert.equal(t.el('status-veil').hidden, true);
  });

  it('인식 표시는 9:16 영역의 is-present 클래스 하나로 켜고 끈다 (바닥 진행선, CSS)', () => {
    const t = setup();
    t.screen.setPresence(true);
    assert.ok(t.el('stage').classList.contains('is-present'));
    t.screen.setPresence(false);
    assert.ok(!t.el('stage').classList.contains('is-present'));
  });

  it('안내 규칙의 모든 안내에 문구가 있다 (확정 문구 그대로)', () => {
    for (const guidance of Object.values(Guidance).filter((g) => g !== Guidance.NONE)) {
      assert.equal(typeof guestText[guidance], 'string', guidance);
    }
    assert.equal(guestText.preparing, '준비 중입니다.\n잠시만 기다려 주세요.');
    assert.equal(guestText.staff, '준비 중입니다.\n직원에게 문의해 주세요.');
  });
});

describe('guest-screen: 동작 줄이기', () => {
  it('위치 움직임 없이 짧은 투명도만: 짜 넣기·숫자·빠지기 복제본·머리 글자·셔터 빛(더 약하게)', () => {
    const t = setup({ reduced: true });
    t.screen.setGuide(true);
    assert.deepEqual(t.el('guide').animations[0].keyframes, [{ opacity: 0 }, { opacity: 1 }]);
    assert.ok(t.el('guide').children[0].children[0].animations.length === 0, '줄은 움직이지 않는다');
    t.screen.setGuide(false);
    assert.equal(t.el('guide').after.inserted, undefined, '복제본 없이 바로 숨김');
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 3 }));
    t.screen.renderSession(t.snapshot(SessionState.COUNTDOWN, { countdown: 2 }));
    const rolls = t.el('countdown-number').animations;
    assert.ok(rolls.every((a) => a.keyframes.every((k) => k.transform === undefined)), JSON.stringify(rolls.map((a) => a.keyframes)));
    assert.equal(t.el('countdown-ghost').textContent, '');
    assert.equal(t.el('countdown-progress-fill').animations.length, 1, '정보가 되는 진행선은 그대로');
    t.screen.renderSession(t.snapshot(SessionState.CAPTURING));
    assert.ok(Math.max(...t.el('flash').animations[0].keyframes.map((k) => k.opacity)) <= 0.3);
    t.screen.dispose();
  });
});
