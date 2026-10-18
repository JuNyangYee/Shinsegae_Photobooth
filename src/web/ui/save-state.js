// 운영자 조절 화면(R·E)의 저장 상태 표시 (6-3). 상태는 패널의 data-save(CSS 색)와 [data-state] 글자로 보인다.
// 저장 규칙 자체(저장·되돌리기·저장 중 닫기)는 각 조절 화면 모듈이 정한다. 이 모듈은 보이는 방식만 맡는다.
// 바꾸지 않았을 때도 "파일과 같은 값"인지는 시작할 때 불러온 결과(출처·고친 내용)로 가린다 (6단계 검수 1).

import { SettingsSource } from '../config/settings-file.js';

export const SaveState = Object.freeze({
  SAVED: 'saved', // 실행 중인 값 = 파일 값
  DEFAULTS: 'defaults', // 파일이 없어 기본값을 씀 (저장하면 파일이 생긴다)
  LOAD_FAILED: 'load-failed', // 파일을 읽지 못했거나 형식이 틀려 기본값을 씀 (파일은 그대로)
  ADJUSTED: 'adjusted', // 파일 값을 고쳐서 씀(범위·없는 키) 또는 파일에 없는 값(옮기지 못한 브라우저 저장값). 저장해야 같아진다
  DIRTY: 'dirty', // 바꿨지만 저장하지 않음 (닫으면 취소)
  SAVING: 'saving',
  FAILED: 'failed', // 마지막 저장이 실패함 (파일에는 이전 값)
});

// 문구 (가안)
const TEXT = Object.freeze({
  [SaveState.SAVED]: '저장됨 · 파일과 같은 값입니다',
  [SaveState.DEFAULTS]: '기본값 사용 · 저장된 파일 없음',
  [SaveState.LOAD_FAILED]: '불러오기 실패 · 기본값 사용',
  [SaveState.ADJUSTED]: '파일 값을 고쳐 사용 · 저장 필요',
  [SaveState.DIRTY]: '저장 안 된 변경 · 닫으면 취소됩니다',
  [SaveState.SAVING]: '저장 중…',
  [SaveState.FAILED]: '저장 실패 · 파일에는 이전 값이 있습니다',
});

/**
 * 시작할 때 불러온 결과 → 바꾸지 않은 상태에서 보일 상태. 이번 실행 중 저장하면(SAVED) 늘 저장됨.
 * @param {{ source: string, note: string, issues: string[] }} loaded settings-file.js의 불러오기 결과
 */
export function loadedSaveState({ source, note, issues }) {
  if (source === SettingsSource.SAVED) return SaveState.SAVED;
  if (source === SettingsSource.DEFAULTS) return note === 'no file' ? SaveState.DEFAULTS : SaveState.LOAD_FAILED;
  if (source === SettingsSource.LOCAL_ONLY || issues.length > 0) return SaveState.ADJUSTED;
  return SaveState.SAVED; // FILE, MIGRATED (파일에 옮김)
}

/** saving·failed가 dirty보다, dirty가 불러온 상태(base)보다 앞선다 */
export function saveStateOf({ saving, failed, dirty, base = SaveState.SAVED }) {
  if (saving) return SaveState.SAVING;
  if (failed) return SaveState.FAILED;
  return dirty ? SaveState.DIRTY : base;
}

export function showSaveState(panel, stateText, state) {
  panel.dataset.save = state;
  stateText.textContent = TEXT[state];
}
