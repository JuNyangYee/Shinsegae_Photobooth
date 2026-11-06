// 관람객 화면 표현 (IMPRINT에서 시작, 14단계 눈 마을 장면): 9:16 화면에서 사진 틀(4:5) 밖 눈 바닥에만 글자를 둔다
// (위 띠에는 관람객 UI 없음). 대기 안내·3·2·1·쿨타임·결과 문구를 눈 바닥 한 자리에서 바꿔 짜 넣고, 바닥 진행선이 카운트다운·쿨타임·결과 남은 시간을 보인다.
// 날짜·시각은 보이지 않는다(14단계). 장면 그림(배경·창틀·캐릭터)은 ui/scene-plate.js.
// 무엇을 보일지는 main.js가 정하고(상태 기계·안내 규칙), 이 모듈은 어떻게 보일지만 맡는다.
//
// 움직임 (transform·opacity만, 미리보기·감지·효과 성능을 건드리지 않게):
// - 짜 넣기: 글자 줄마다 창(.line, overflow hidden) 아래에서 올라와 자리 잡는다. 빠질 때는 같은 자리의 복제본이 위로 빠지고 원본은 바로 숨는다
//   (상태 = hidden 속성은 즉시, 확인 도구·테스트가 읽는다).
// - 3·2·1: 큰 숫자가 한 칸 창 안에서 위로 넘어간다(앞 숫자는 위로, 새 숫자는 아래에서). 바닥 진행선이 그 회차 길이 동안 차오른다.
// - 셔터: 사진 틀 안에만 짧은 흰 빛.
// - 결과: 사진은 틀 자리 그대로 멈춘 그림처럼 놓인다. 끝나기 직전 사진·문구가 걷힌다(사진 src는 상태 기계가 결과를 끝낼 때 지운다).
// 동작 줄이기(reducedMotion)에서는 위치 움직임 없이 짧은 투명도만 쓴다. Node 테스트: test/ui/guest-screen.test.mjs

import { SessionState } from '../core/session.js';

const SET = 'cubic-bezier(0.16, 1, 0.3, 1)'; // CSS --ease-set
const LEAVE = 'cubic-bezier(0.7, 0, 0.84, 0)';
const ROLL = 'cubic-bezier(0.76, 0, 0.24, 1)';
const SET_MS = 900; // 한 줄을 짜 넣는 시간
const SET_STAGGER_MS = 90; // 줄 사이
const LEAVE_MS = 380;
const RESULT_LEAVE_MS = 700; // 결과가 끝나기 전 종이·사진이 걷히는 시간
const PAPER_MS = 900; // 결과 둘레가 종이로 번지는 시간

/**
 * @param {{ root: Document, text: typeof import('../config/guest-text.js').guestText, countdownSeconds: number,
 *   now?: () => number, timers?: { setTimeout: Function, clearTimeout: Function },
 *   reducedMotion?: () => boolean }} options
 *   now: session의 endsAt과 같은 시계 (performance.now). countdownSeconds는 기본값이고,
 *   상태 기계 스냅숏에 그 회차의 countdownSeconds가 있으면 그 값을 쓴다 (10단계 시간 섹션). reducedMotion: 동작 줄이기인지 (부를 때마다 읽는다)
 */
export function createGuestScreen({
  root, text, countdownSeconds, now = () => performance.now(), timers = globalThis, reducedMotion = () => false,
}) {
  const $ = (id) => root.getElementById(id);
  const stage = $('stage');
  const guide = $('guide');
  const countdown = $('countdown');
  const countdownNumber = $('countdown-number');
  const countdownGhost = $('countdown-ghost');
  const countdownCaption = $('countdown-caption');
  const countdownFill = $('countdown-progress-fill');
  const cooldownFill = $('cooldown-progress-fill');
  const flash = $('flash');
  const resultView = $('result-view');
  const resultPaper = $('result-paper');
  const resultCard = $('result-card');
  const resultImage = $('result');
  const resultNote = $('result-note');
  const resultTimer = $('result-timer');
  const resultTimerFill = $('result-timer-fill');
  const notice = $('notice');
  const statusVeil = $('status-veil');
  const status = $('status');

  // ---- 글자 줄 ----

  /** 묶음 안을 줄(.line > span)로 다시 짠다: 한국어(줄바꿈마다 한 줄) 다음 영어 한 줄. 안쪽 span 목록을 돌려준다 */
  function setLines(container, { ko, en }, extra = []) {
    const inners = [];
    const lines = [...ko.split('\n').map((t) => ['is-ko', t]), ...(en ? [['is-en', en]] : [])].map(([kind, t]) => {
      const line = root.createElement('span');
      line.className = `line ${kind}`;
      const inner = root.createElement('span');
      inner.textContent = t;
      line.append(inner);
      inners.push(inner);
      return line;
    });
    container.replaceChildren(...lines, ...extra);
    return inners;
  }

  const lineSets = new Map([
    [guide, setLines(guide, text.idle)],
    [countdownCaption, setLines(countdownCaption, text.countdown)],
    [notice, setLines(notice, text.cooldown)],
  ]);

  /** 짜 넣기: 숨겨져 있던 묶음을 보이고 줄마다 창 아래에서 올라오게 한다 */
  function setIn(element, inners, { delay = 0 } = {}) {
    element.hidden = false;
    if (reducedMotion()) {
      element.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 200, delay, fill: 'backwards' });
      return;
    }
    inners.forEach((inner, i) => {
      inner.animate([{ transform: 'translateY(108%)' }, { transform: 'translateY(0)' }],
        { duration: SET_MS, delay: delay + i * SET_STAGGER_MS, easing: SET, fill: 'backwards' });
    });
  }

  /**
   * 빠지기: 원본은 바로 숨기고(상태는 즉시), 같은 자리에 id 없는 복제본을 두어 줄이 위로 빠지게 한 뒤 지운다.
   * 동작 줄이기에서는 복제본 없이 바로 숨긴다
   */
  function setOut(element) {
    if (element.hidden) return;
    element.hidden = true;
    if (reducedMotion() || typeof element.cloneNode !== 'function') return;
    const ghost = element.cloneNode(true);
    ghost.removeAttribute('id');
    for (const node of ghost.querySelectorAll('[id]')) node.removeAttribute('id');
    // 3·2·1의 앞 숫자 자리(이미 창 위로 빠져 있던 것)는 복제하면 제자리에 겹쳐 보이므로 뺀다
    for (const node of ghost.querySelectorAll('.is-ghost')) node.remove();
    ghost.setAttribute('aria-hidden', 'true');
    ghost.hidden = false;
    element.after(ghost);
    const inners = [...ghost.querySelectorAll('.line > span, .countdown-glyph')];
    const animations = (inners.length ? inners : [ghost]).map((node, i) => node.animate(
      [{ transform: 'translateY(0)', opacity: 1 }, { transform: 'translateY(-108%)', opacity: 0 }],
      { duration: LEAVE_MS, delay: i * 40, easing: LEAVE, fill: 'forwards' },
    ));
    Promise.all(animations.map((a) => a.finished)).then(() => ghost.remove(), () => ghost.remove());
  }

  function show(element, visible, inners, options) {
    if (visible && element.hidden) setIn(element, inners, options);
    else if (!visible) setOut(element);
  }

  // ---- 3·2·1 ----

  let lastState = SessionState.IDLE;
  let shownNumber = null;
  let progressAnimation = null;

  function rollTo(number) {
    const previous = countdownNumber.textContent;
    countdownNumber.textContent = String(number);
    countdownGhost.textContent = previous;
    if (reducedMotion()) {
      countdownGhost.textContent = '';
      countdownNumber.animate([{ opacity: 0.2 }, { opacity: 1 }], { duration: 160 });
      return;
    }
    countdownNumber.animate([{ transform: 'translateY(100%)' }, { transform: 'translateY(0)' }], { duration: 640, easing: ROLL });
    if (previous) {
      countdownGhost.animate([{ transform: 'translateY(0)' }, { transform: 'translateY(-100%)' }],
        { duration: 640, easing: ROLL, fill: 'forwards' });
    }
  }

  function renderCountdown(s) {
    const counting = s.state === SessionState.COUNTDOWN;
    if (counting && lastState !== SessionState.COUNTDOWN) {
      // 바닥 진행선: 그 회차의 카운트다운 길이(기본 3초) 동안 왼쪽에서 차오른다 (transform만)
      progressAnimation = countdownFill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
        { duration: (s.countdownSeconds ?? countdownSeconds) * 1000, fill: 'forwards' });
      countdownNumber.textContent = '';
      countdownGhost.textContent = '';
      setIn(countdown, lineSets.get(countdownCaption), { delay: 60 });
    } else if (!counting && lastState === SessionState.COUNTDOWN) {
      progressAnimation?.cancel();
      progressAnimation = null;
      // 셔터면 바로 끊는다(빛과 함께). 취소(떠남·초기화)면 위로 빠진다
      if (s.state === SessionState.CAPTURING) countdown.hidden = true;
      else setOut(countdown);
    }
    if (!counting) {
      countdown.hidden = true;
      shownNumber = null;
      return;
    }
    if (s.countdown === shownNumber) return;
    shownNumber = s.countdown;
    rollTo(s.countdown);
  }

  // ---- 결과 ----

  let shownUrl = null;
  let shownEndsAt; // 막대를 맞춘 종료 시각. undefined = 아직 맞추지 않음 (null은 "시계 멈춤")
  let timerAnimation = null;
  let leaveTimer = null;
  let leaveAnimations = [];

  function stopLeaving() {
    timers.clearTimeout(leaveTimer);
    leaveTimer = null;
    leaveAnimations.forEach((a) => a.cancel());
    leaveAnimations = [];
    delete stage.dataset.leaving;
  }

  // 결과가 끝나기 RESULT_LEAVE_MS 전부터 바닥 빛·사진·문구를 걷는다 (data-leaving은 CSS가 읽는다)
  function scheduleLeaving(endsAt) {
    stopLeaving();
    if (endsAt === null) return;
    const leave = () => {
      leaveTimer = null;
      stage.dataset.leaving = '';
      leaveAnimations = [resultPaper, resultCard, resultNote, resultTimer].map((node) => node.animate(
        [{ opacity: 1 }, { opacity: 0 }], { duration: RESULT_LEAVE_MS, easing: 'ease-in-out', fill: 'forwards' },
      ));
    };
    leaveTimer = timers.setTimeout(leave, Math.max(0, endsAt - now() - RESULT_LEAVE_MS));
  }

  function renderResult(s) {
    // 결과 사진. 결과가 끝나면 src를 먼저 지우고, 그 뒤 session이 Object URL을 정리한다.
    const url = s.state === SessionState.RESULT ? s.photo.url : null;
    if (url !== shownUrl) {
      if (url) resultImage.src = url;
      else resultImage.removeAttribute('src');
      // 1비트 점 사진(감열지) 표시. 사진 틀 폭 = 화면 폭이라 연속 톤·점 사진 모두 같은 크기다 (점 사진도 결과 크기로 확대된 화면용)
      resultCard.classList.toggle('is-dots', url !== null && s.photo.dots === true);
      shownUrl = url;
      shownEndsAt = undefined;
      stopLeaving();
      if (url) {
        // 사진은 틀 자리에 그대로 (멈춘 그림처럼, 움직이지 않는다: 회전·확대·이동이 없어 화소 그대로 놓인다). 눈 바닥 글자 뒤에 빛이 번진다
        resultPaper.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotion() ? 200 : PAPER_MS, easing: 'ease-out' });
      }
    }
    resultImage.hidden = url === null;
    resultView.hidden = url === null;
    if (url === null) {
      timerAnimation?.cancel();
      timerAnimation = null;
      return;
    }
    // 남은 시간: 종료 시계가 돌면(endsAt) 사진 아래 선이 줄어든다. 시계가 멈춘 동안(인쇄 연동 뒤 출력 중)은 선을 숨기고 출력 중 문구
    if (s.endsAt === shownEndsAt) return;
    const first = shownEndsAt === undefined;
    shownEndsAt = s.endsAt;
    timerAnimation?.cancel();
    timerAnimation = null;
    resultTimer.hidden = s.endsAt === null;
    resultNote.hidden = true;
    setIn(resultNote, setLines(resultNote, s.endsAt === null ? text.resultPrinting : text.resultReady), { delay: first ? 280 : 0 });
    if (s.endsAt !== null) {
      timerAnimation = resultTimerFill.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
        { duration: Math.max(0, s.endsAt - now()), fill: 'forwards' });
    }
    scheduleLeaving(s.endsAt);
  }

  // ---- 쿨타임 진행선 ----

  let cooldownEndsAt = null;
  let cooldownAnimation = null;

  function renderCooldownFill(visible) {
    if (visible && cooldownAnimation === null && cooldownEndsAt !== null) {
      const total = Math.max(1, cooldownEndsAt - now());
      cooldownAnimation = cooldownFill.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }], { duration: total, fill: 'forwards' });
    } else if (!visible && cooldownAnimation !== null) {
      cooldownAnimation.cancel();
      cooldownAnimation = null;
    }
  }

  stage.dataset.phase = SessionState.IDLE;

  return {
    /** 상태 기계 스냅숏(session.getState())을 화면에 옮긴다: 단계, 카운트다운, 셔터 빛, 결과 */
    renderSession(s) {
      stage.dataset.phase = s.state;
      if (s.state === SessionState.CAPTURING && lastState !== SessionState.CAPTURING) {
        // 촬영 순간: 사진 틀 안에만 짧은 흰 빛 (눈부시지 않게, 동작 줄이기면 더 약하게)
        const peak = reducedMotion() ? 0.3 : 0.7;
        flash.animate([{ opacity: 0 }, { opacity: peak, offset: 0.12 }, { opacity: 0 }], { duration: 320, easing: 'ease-out' });
      }
      renderCountdown(s);
      renderResult(s);
      cooldownEndsAt = s.state === SessionState.COOLDOWN ? s.endsAt : null;
      if (s.state !== SessionState.COOLDOWN) renderCooldownFill(false);
      lastState = s.state;
    },

    /** 준비 중·직원 문의 안내. kind: 'preparing' | 'staff' (준비 중이면 위 가는 선이 천천히 숨 쉰다) */
    setStatus({ message, kind, visible }) {
      status.textContent = message;
      status.dataset.kind = kind;
      statusVeil.hidden = !visible;
      const appearing = visible && status.hidden;
      status.hidden = !visible;
      if (!appearing) return;
      const motion = reducedMotion() ? [{ opacity: 0 }, { opacity: 1 }]
        : [{ opacity: 0, transform: 'translateY(1.2cqw)' }, { opacity: 1, transform: 'translateY(0)' }];
      status.animate(motion, { duration: 600, easing: SET });
    },

    /** 인식 표시: 9:16 영역의 is-present 클래스 (바닥 진행선이 밝아진다, CSS) */
    setPresence(present) {
      stage.classList.toggle('is-present', present);
    },

    /** 대기 안내 "발자국 위에 서 주세요" */
    setGuide(visible) {
      show(guide, visible, lineSets.get(guide), { delay: 120 });
    },

    /** 쿨타임 문구와 바닥 진행선 (쿨타임 남은 시간 동안 차오른다) */
    setNotice(visible) {
      show(notice, visible, lineSets.get(notice));
      renderCooldownFill(visible);
    },

    /** 남은 타이머를 정리한다 (데모·테스트 정리용) */
    dispose() {
      stopLeaving();
    },
  };
}
