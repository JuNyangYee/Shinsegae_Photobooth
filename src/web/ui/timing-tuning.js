// 운영자 조절 화면(E, operator-panel.js)의 "시간" 섹션 (10단계, 관람객용 아님): 촬영 흐름(카운트다운·결과 표시·쿨타임),
// 인식 반응(인식까지·이탈까지), 카메라 회복(다시 시도·첫 프레임·정지 판정·직원 문의). 9단계까지 뒤의 둘은 인식 섹션에 있었다.
// 조절하는 즉시 반영하고(main.js applyTimingSettings: 촬영 흐름은 다음 회차부터, 인식 반응은 다음 감지부터, 카메라 회복은 다음 재시도·판정부터),
// "저장"을 눌러야 시간 설정 파일(config/timing.local.json)에 기록한다.
// 저장·취소·기본값·닫기 규칙은 다른 섹션과 같다(패널을 닫을 때 저장하지 않은 변경은 저장된 값으로, 저장 중이면 끝난 뒤 닫는다).
// Node 테스트: test/ui/timing-tuning.test.mjs

import { SettingsSource } from '../config/settings-file.js';
import { normalizeTimingSettings, sameTimingSettings, timingLimits } from '../config/timing-settings.js';
import { loadedSaveState, saveStateOf, showSaveState } from './save-state.js';

// 슬라이더 항목: [설정 키, 표시 소수 자릿수, 표시 배율]. ms로 저장하고 초로 보인다 (카운트다운은 초로 저장). 단위 글자는 index.html
const SLIDERS = [
  ['countdownSeconds', 0, 1], ['resultMs', 0, 1000], ['cooldownMs', 1, 1000],
  ['presentHoldMs', 2, 1000], ['absentGraceMs', 2, 1000],
];
const RECOVERY_SLIDERS = [['retryIntervalMs', 1], ['firstFrameTimeoutMs', 1], ['stallTimeoutMs', 1], ['staffNoticeMs', 0]];

const STATE_TEXT = Object.freeze({
  idle: '대기', countdown: '카운트다운', capturing: '촬영·결과 준비', result: '결과 표시', cooldown: '쿨타임',
});

/**
 * @param {{ panel: HTMLElement, session: { getState: Function }, defaults: object,
 *   initial: { settings: object, issues: string[], source: string, note: string },  시작할 때 정한 값 (settings-file.js)
 *   applySettings: (settings: object) => void,  main.js applyTimingSettings
 *   saveSettings: (settings: object) => Promise<void>, onOpenChange?: (open: boolean) => void,
 *   timers?: { setInterval: Function, clearInterval: Function } }} options  defaults: config.timing
 */
export function createTimingTuning({
  panel, session, defaults, initial, applySettings, saveSettings, onOpenChange, timers = globalThis,
}) {
  const liveText = panel.querySelector('[data-live]');
  const stateText = panel.querySelector('[data-state]');
  const messageText = panel.querySelector('[data-message]');
  const sliderOf = (key, limits, digits, scale) => {
    const input = panel.querySelector(`input[data-key="${key}"]`);
    Object.assign(input, { min: String(limits.min), max: String(limits.max), step: String(limits.step) });
    return [key, { input, output: panel.querySelector(`output[data-key="${key}"]`), digits, scale }];
  };
  const sliders = new Map(SLIDERS.map(([key, digits, scale]) => sliderOf(key, timingLimits[key], digits, scale)));
  const recoverySliders = new Map(RECOVERY_SLIDERS.map(([key, digits]) => sliderOf(key, timingLimits.cameraRecovery[key], digits, 1000)));

  const baseDefaults = normalizeTimingSettings(defaults, defaults).settings;
  const loaded = initial;
  if (loaded.issues.length > 0) console.warn('[timing-tuning] stored settings adjusted:', loaded.issues);
  let saved = loaded.settings;
  let savedSource = loaded.source;
  let savedNote = loaded.note;
  let saving = false;
  let saveFailed = false;
  let closeAfterSave = false;
  let current = saved;
  let open = false;
  let active = false;
  let liveTimer = null;
  applySettings(current);

  function apply(next) {
    saveFailed = false;
    current = normalizeTimingSettings(next, defaults).settings;
    applySettings(current);
    render();
  }

  function renderSaveState() {
    const base = loadedSaveState({ source: savedSource, note: savedNote, issues: loaded.issues });
    showSaveState(panel, stateText, saveStateOf({ saving, failed: saveFailed, dirty: !sameTimingSettings(current, saved), base }));
  }

  function showMessage(text) {
    messageText.textContent = text;
  }

  function render() {
    for (const [key, { input, output, digits, scale }] of sliders) {
      input.value = String(current[key]);
      output.textContent = (current[key] / scale).toFixed(digits);
    }
    for (const [key, { input, output, digits, scale }] of recoverySliders) {
      input.value = String(current.cameraRecovery[key]);
      output.textContent = (current.cameraRecovery[key] / scale).toFixed(digits);
    }
    renderSaveState();
  }

  // 지금 진행 상태와, 바꾼 촬영 흐름 값이 언제부터 쓰이는지
  function renderLive() {
    const s = session.getState();
    const running = s.state !== 'idle';
    liveText.textContent = running
      ? `${STATE_TEXT[s.state] ?? s.state} 중 · 바꾼 카운트다운·결과·쿨타임은 다음 회차부터 적용`
      : '대기 · 카운트다운·결과·쿨타임은 다음 회차부터, 인식 반응·카메라 회복은 바로 적용';
    liveText.classList.toggle('is-present', !running);
  }

  function openingMessage() {
    if (savedSource === SettingsSource.SAVED || !sameTimingSettings(current, saved)) return '';
    const parts = [];
    if (savedSource === SettingsSource.DEFAULTS && savedNote !== 'no file') parts.push(`시간 설정 파일을 쓰지 못해 기본값으로 시작했습니다 (${savedNote}).`);
    if (savedSource === SettingsSource.PRESENCE_FILE_ONLY) {
      parts.push(`예전 인식 파일의 시간 값을 시간 파일로 옮기지 못했습니다 (${savedNote}). 저장을 눌러 다시 시도하세요.`);
    }
    if (loaded.issues.length > 0) parts.push(`시작할 때 저장값을 고쳐 불러왔습니다: ${loaded.issues.join(', ')}`);
    return parts.join(' ');
  }

  function syncLive() {
    timers.clearInterval(liveTimer);
    liveTimer = null;
    if (open && active) {
      renderLive();
      liveTimer = timers.setInterval(renderLive, 500);
    }
  }

  function setOpen(next) {
    if (open === next) return;
    if (!next && saving) {
      closeAfterSave = true;
      showMessage('저장 중입니다. 저장이 끝나면 닫습니다.');
      return;
    }
    open = next;
    if (open) {
      render();
      showMessage(openingMessage());
    } else if (!sameTimingSettings(current, saved)) {
      console.info('[timing-tuning] closed without saving; reverted to saved settings');
      apply(saved);
    }
    syncLive();
    onOpenChange?.(open);
  }

  for (const [key, { input }] of sliders) {
    input.addEventListener('input', () => {
      apply({ ...current, [key]: Number(input.value) });
      showMessage('');
    });
  }
  for (const [key, { input }] of recoverySliders) {
    input.addEventListener('input', () => {
      apply({ ...current, cameraRecovery: { ...current.cameraRecovery, [key]: Number(input.value) } });
      showMessage('');
    });
  }

  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    const action = button?.dataset.action;
    if (!action) return;
    if (action === 'save') {
      if (saving) return;
      saving = true;
      const target = current;
      button.disabled = true;
      renderSaveState();
      showMessage('저장 중...');
      try {
        await saveSettings(target);
        saved = target;
        savedSource = SettingsSource.SAVED;
        savedNote = '';
        saveFailed = false;
        render();
        showMessage(sameTimingSettings(current, saved) ? '파일에 저장했습니다.' : '파일에 저장했습니다. 저장 중에 바뀐 값은 아직 저장되지 않았습니다.');
      } catch (error) {
        saveFailed = true;
        render();
        showMessage(`저장하지 못했습니다: ${error?.message ?? error}`);
      } finally {
        saving = false;
        button.disabled = false;
        renderSaveState();
        if (closeAfterSave) {
          closeAfterSave = false;
          setOpen(false);
        }
      }
    } else if (action === 'revert') {
      apply(saved);
      showMessage('저장된 값으로 되돌렸습니다.');
    } else if (action === 'defaults') {
      // 이 섹션의 값만 (촬영 흐름·인식 반응·카메라 회복). 다른 섹션은 그대로
      apply(baseDefaults);
      showMessage('시간 기본값을 적용했습니다. 유지하려면 저장하세요.');
    }
  });

  render();

  return {
    isOpen: () => open,
    open: () => setOpen(true),
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    /** 패널에서 이 섹션이 보이는지 (operator-panel.js). 보이는 동안만 실시간 줄 */
    setActive(next) {
      if (active === next) return;
      active = next;
      syncLive();
    },
    isDirty: () => !sameTimingSettings(current, saved),
    /** 저장하지 않은 변경을 저장된 값으로 되돌린다 (패널이 닫히는 순간, operator-panel.js) */
    discardUnsaved() {
      if (!sameTimingSettings(current, saved)) apply(saved);
    },
    getSettings: () => current,
    /** 시간 파일에 값이 있는지: 시작할 때 파일에서 읽었거나 옮겼거나, 이번 실행 중 저장함 (main.js가 인식 파일의 옛 시간 키를 남길지 정한다) */
    isStoredInFile: () => [SettingsSource.FILE, SettingsSource.MIGRATED, SettingsSource.SAVED].includes(savedSource),
    /** D 화면용: 지금 쓰는 시간 값의 출처 */
    describeSettingsSource() {
      const dirty = !sameTimingSettings(current, saved);
      const note = savedNote && savedNote !== 'no file' ? ` (${savedNote})` : savedSource === SettingsSource.DEFAULTS ? ' (no file)' : '';
      const issues = savedSource !== SettingsSource.SAVED && loaded.issues.length > 0 ? `, adjusted: ${loaded.issues.join('; ')}` : '';
      return `${savedSource}${note}${dirty ? ' + unsaved changes' : ''}${issues}`;
    },
  };
}
