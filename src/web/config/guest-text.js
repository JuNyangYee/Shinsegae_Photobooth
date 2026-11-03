// 관람객 화면 문구 (한곳에 모은다). 확정이라고 적은 것 말고는 모두 가안이다.
// IMPRINT 시안(채택 전): 한국어 줄(ko)은 본문 서체 Pretendard(KS X 1001 완성형 한글을 담는다)로, 영어 줄(en)과 숫자는 세리프
// Noto Serif KR Light의 라틴 글자(부분 집합에 U+0020–007E가 모두 있다)로 보인다. 세리프 한글은 "준비 중" 첫 줄뿐이라
// 그 문구를 바꿀 때만 세리프를 다시 줄인다 (test/config/guest-text.test.mjs가 두 서체의 cmap으로 검사, docs/SYSTEM.md 3절 "서체").

export const guestText = Object.freeze({
  // 카메라·감지기 안내 (확정 2026-10-15). 첫 줄은 세리프 제목으로 보인다. 확인 도구가 이 글자로 상태를 읽는다
  preparing: '준비 중입니다.\n잠시만 기다려 주세요.',
  staff: '준비 중입니다.\n직원에게 문의해 주세요.',
  // 대기: 아래 여백의 큰 한 줄과 영어 한 줄
  idle: Object.freeze({ ko: '발자국 위에 서 주세요', en: 'Step onto the footprints.' }),
  // 카운트다운: 큰 숫자 옆 두 줄
  countdown: Object.freeze({ ko: '화면을 보며\n웃어 주세요', en: 'Look here, and smile.' }),
  // 결과: 종이 위 사진 아래. 종이 시계가 도는 동안(ready)과 멈춘 동안(printing, 인쇄 연동 뒤에 보인다).
  // 인쇄 연동 전에는 출력물이 없으므로 ready는 "출력됨"을 말하지 않는다 (연동 뒤 출력 완료 확인 다음의 문구는 그때 정한다)
  resultReady: Object.freeze({ ko: '사진이 완성되었습니다', en: 'Your portrait is set.' }),
  resultPrinting: Object.freeze({ ko: '사진을 출력하고 있습니다', en: 'Printing your portrait.' }),
  // 쿨타임: 대기 안내와 같은 자리
  cooldown: Object.freeze({ ko: '다음 촬영을 준비하고 있습니다', en: 'Setting up the next portrait.' }),
  // 감열지 인쇄 쪽 꼬리의 세리프 한 줄 (effect/imprint-page.js). 인쇄 데이터에만 있고 화면에는 없다
  print: Object.freeze({ line: 'Set in light, printed in heat.' }),
  // 운영자 표시 (관람객용 아님, P)
  paused: '자동 촬영 일시정지 (P)',
});
