// 관람객 화면 표현 (6-2, 7-2 미니멀): 대기 안내, 인식 표시(가는 선), 3·2·1(숫자·진행선), 셔터 페이드, 결과 출력물·남은 시간,
// 쿨타임 문구, 준비 중·직원 문의 안내. 무엇을 보일지는 main.js가 정하고(상태 기계·안내 규칙), 이 모듈은 어떻게 보일지만 맡는다.
// 애니메이션은 transform·opacity만 움직인다 (미리보기·감지·효과 성능을 건드리지 않게). Node 테스트: test/ui/guest-screen.test.mjs

import { SessionState } from '../core/session.js';

const SETTLE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';

/**
 * @param {{ root: Document, text: typeof import('../config/guest-text.js').guestText, countdownSeconds: number,
 *   now?: () => number }} options  now: session의 endsAt과 같은 시계 (performance.now)
 */
export function createGuestScreen({ root, text, countdownSeconds, now = () => performance.now() }) {
  const $ = (id) => root.getElementById(id);
  const stage = $('stage');
  const guide = $('guide');
  const countdown = $('countdown');
  const countdownNumber = $('countdown-number');
  const progress = $('countdown-progress-fill');
  const flash = $('flash');
  const resultView = $('result-view');
  const resultCard = $('result-card');
  const resultImage = $('result');
  const resultNote = $('result-note');
  const resultTimer = $('result-timer');
  const resultTimerFill = $('result-timer-fill');
  const notice = $('notice');
  const statusVeil = $('status-veil');
  const status = $('status');

  guide.textContent = text.idle;
  $('countdown-caption').textContent = text.countdown;
  notice.textContent = text.cooldown;

  let lastState = SessionState.IDLE;
  let shownNumber = null;
  let shownUrl = null;
  let shownEndsAt; // 막대를 맞춘 종료 시각. undefined = 아직 맞추지 않음 (null은 "시계 멈춤")
  let progressAnimation = null;
  let timerAnimation = null;

  // 숨겨져 있다가 보이게 될 때만 짧게 나타나는 움직임을 준다.
  function reveal(element, visible, keyframes, options) {
    const appearing = visible && element.hidden;
    element.hidden = !visible;
    if (appearing) element.animate(keyframes, options);
  }

  const fadeUp = [{ opacity: 0, transform: 'translateY(0.8cqw)' }, { opacity: 1, transform: 'translateY(0)' }];

  function renderCountdown(s) {
    const counting = s.state === SessionState.COUNTDOWN;
    if (counting && lastState !== SessionState.COUNTDOWN) {
      // 진행선: 3초(countdownSeconds) 동안 가운데에서 양쪽으로 차오른다 (transform만)
      progressAnimation = progress.animate([{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
        { duration: countdownSeconds * 1000, fill: 'forwards' });
      countdown.animate(fadeUp, { duration: 400, easing: SETTLE });
    } else if (!counting && lastState === SessionState.COUNTDOWN) {
      progressAnimation?.cancel();
      progressAnimation = null;
    }
    countdown.hidden = !counting;
    if (!counting) {
      shownNumber = null;
      return;
    }
    if (s.countdown === shownNumber) return;
    shownNumber = s.countdown;
    countdownNumber.textContent = String(s.countdown);
    // 숫자마다 1초: 조용히 나타났다가 끝 무렵 흐려진다. 다음 숫자가 늦게 와도 진행선은 남는다(fill)
    countdownNumber.animate([
      { opacity: 0, transform: 'translateY(0.6cqw)', easing: SETTLE },
      { opacity: 1, transform: 'translateY(0)', offset: 0.25 },
      { opacity: 1, transform: 'translateY(0)', offset: 0.82, easing: 'ease-in' },
      { opacity: 0, transform: 'translateY(0)' },
    ], { duration: 1000, fill: 'forwards' });
  }

  function renderResult(s) {
    // 결과 사진. 결과가 끝나면 src를 먼저 지우고, 그 뒤 session이 Object URL을 정리한다.
    const url = s.state === SessionState.RESULT ? s.photo.url : null;
    if (url !== shownUrl) {
      if (url) resultImage.src = url;
      else resultImage.removeAttribute('src');
      shownUrl = url;
      shownEndsAt = undefined;
      if (url) {
        // 출력물이 조용히 떠오른다. 회전·확대는 쓰지 않는다: 흑백 점 사진을 회전·비정수 배율로 그리면 다시 보간돼
        // 점이 뭉개진다 (6-3, CSS .result-card). 끝나면 변형이 없어 사진 폭이 화면 화소와 1:1로 놓인다
        resultCard.animate([
          { opacity: 0, transform: 'translateY(1.6cqw)' },
          { opacity: 1, transform: 'translateY(0)' },
        ], { duration: 600, easing: SETTLE });
      }
    }
    resultImage.hidden = url === null;
    resultView.hidden = url === null;
    if (url === null) {
      timerAnimation?.cancel();
      timerAnimation = null;
      return;
    }
    // 남은 시간: 종료 시계가 돌면(endsAt) 막대가 줄어든다. 시계가 멈춘 동안(인쇄 연동 뒤 출력 중)은 막대를 숨기고 출력 중 문구
    if (s.endsAt === shownEndsAt) return;
    shownEndsAt = s.endsAt;
    timerAnimation?.cancel();
    timerAnimation = null;
    resultTimer.hidden = s.endsAt === null;
    resultNote.textContent = s.endsAt === null ? text.resultPrinting : text.resultReady;
    if (s.endsAt !== null) {
      timerAnimation = resultTimerFill.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }],
        { duration: Math.max(0, s.endsAt - now()), fill: 'forwards' });
    }
  }

  return {
    /** 상태 기계 스냅숏(session.getState())을 화면에 옮긴다: 카운트다운, 플래시, 결과 */
    renderSession(s) {
      renderCountdown(s);
      if (s.state === SessionState.CAPTURING && lastState !== SessionState.CAPTURING) {
        // 촬영 순간: 짧은 흰 페이드 (눈부시지 않게 최대 0.55, 약 0.28초)
        flash.animate([{ opacity: 0 }, { opacity: 0.55, offset: 0.14 }, { opacity: 0 }], { duration: 280, easing: 'ease-out' });
      }
      renderResult(s);
      lastState = s.state;
    },

    /** 준비 중·직원 문의 안내. kind: 'preparing' | 'staff' (준비 중이면 가는 선이 천천히 숨 쉰다) */
    setStatus({ message, kind, visible }) {
      status.textContent = message;
      status.dataset.kind = kind;
      statusVeil.hidden = !visible;
      reveal(status, visible, fadeUp, { duration: 500, easing: SETTLE });
    },

    /** 인식 표시: 가장자리 가는 선이 또렷해진다 (CSS 전환, opacity) */
    setPresence(present) {
      stage.classList.toggle('is-present', present);
    },

    /** 대기 안내 "발자국 위에 서 주세요" */
    setGuide(visible) {
      reveal(guide, visible, fadeUp, { duration: 500, easing: SETTLE });
    },

    /** 쿨타임 문구 */
    setNotice(visible) {
      reveal(notice, visible, fadeUp, { duration: 500, easing: SETTLE });
    },
  };
}
