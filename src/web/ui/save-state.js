// 운영자 조절 화면(R·E)의 저장 상태 표시 (6-3). 상태는 패널의 data-save(CSS 색)와 [data-state] 글자로 보인다.
// 저장 규칙 자체(저장·되돌리기·저장 중 닫기)는 각 조절 화면 모듈이 정한다. 이 모듈은 보이는 방식만 맡는다.

export const SaveState = Object.freeze({
  SAVED: 'saved', // 실행 중인 값 = 파일 값
  DIRTY: 'dirty', // 바꿨지만 저장하지 않음 (닫으면 취소)
  SAVING: 'saving',
  FAILED: 'failed', // 마지막 저장이 실패함 (파일에는 이전 값)
});

const TEXT = Object.freeze({
  [SaveState.SAVED]: '저장됨 · 파일과 같은 값입니다',
  [SaveState.DIRTY]: '저장 안 된 변경 · 닫으면 취소됩니다',
  [SaveState.SAVING]: '저장 중…',
  [SaveState.FAILED]: '저장 실패 · 파일에는 이전 값이 있습니다',
});

/** saving·failed가 dirty보다 앞선다 */
export function saveStateOf({ saving, failed, dirty }) {
  if (saving) return SaveState.SAVING;
  if (failed) return SaveState.FAILED;
  return dirty ? SaveState.DIRTY : SaveState.SAVED;
}

export function showSaveState(panel, stateText, state) {
  panel.dataset.save = state;
  stateText.textContent = TEXT[state];
}
