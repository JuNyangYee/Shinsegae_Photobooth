// 운영자 조절 화면(E)의 "화면" 섹션 (17단계, 관람객용 아님): 최종 화면 필터 켬/끔(끄면 원본 보기)·처리 해상도·oil2f 조절값.
// 조절 항목·범위·기본값은 활성 번들의 정의로 만든다(필터 섹션과 같다). 조절하는 즉시 반영하고 "저장"을 눌러야 config/screen.local.json에 남는다.
// 저장·취소·기본값·닫기 규칙은 다른 섹션과 같다. 필터 업데이트는 필터 섹션에서 하고, 여기는 수치만 바꾼다. Node 테스트: test/ui/screen-tuning.test.mjs

import { SettingsSource } from '../config/settings-file.js';
import { effectLimits } from '../config/effect-settings.js';
import { filterValues, setFilterValue } from '../config/filter-values.js';
import { defaultScreenSettings, normalizeScreenFilter, sameScreenSettings } from '../config/screen-settings.js';
import { loadedSaveState, saveStateOf, showSaveState } from './save-state.js';

const STATE_TEXT = Object.freeze({
  loading: '준비 중', bypass: '꺼짐', running: '합성 중', 'context-lost': '그래픽 복구 대기', fault: '장애 · 기존 화면',
});

/**
 * @param {{ panel: HTMLElement, compositor: { getState: Function }, getBundle: () => object,
 *   initial: { settings: object, issues: string[], source: string, note: string },
 *   applySettings: (settings: object) => void, saveSettings: (settings: object) => Promise<void>,
 *   onOpenChange?: (open: boolean) => void, timers?: { setInterval: Function, clearInterval: Function } }} options
 */
export function createScreenTuning({
  panel, compositor, getBundle, initial, applySettings, saveSettings, onOpenChange, timers = globalThis,
}) {
  const doc = panel.ownerDocument;
  const liveText = panel.querySelector('[data-live]');
  const stateText = panel.querySelector('[data-state]');
  const messageText = panel.querySelector('[data-message]');
  const enabledInput = panel.querySelector('input[data-key="enabled"]');
  const enabledOutput = panel.querySelector('output[data-key="enabled"]');
  const scaleInput = panel.querySelector('input[data-key="previewScale"]');
  const scaleOutput = panel.querySelector('output[data-key="previewScale"]');
  const controlsHost = panel.querySelector('[data-screen-controls]');
  Object.assign(scaleInput, { min: String(effectLimits.previewScale.min), max: String(effectLimits.previewScale.max), step: String(effectLimits.previewScale.step) });

  let saved = initial.settings;
  let savedSource = initial.source;
  let savedNote = initial.note;
  let current = saved;
  let saving = false;
  let saveFailed = false;
  let closeAfterSave = false;
  let open = false;
  let active = false;
  let liveTimer = null;
  let controlsFor = null;
  let inputs = [];

  applySettings(current);

  function apply(next) {
    saveFailed = false;
    current = next;
    applySettings(current);
    render();
  }

  const setFilter = (filter) => apply({ ...current, filter: normalizeScreenFilter(filter, getBundle()).settings });

  function buildControls(bundle) {
    controlsFor = bundle;
    controlsHost.replaceChildren();
    inputs = [];
    for (const control of bundle.controls) {
      const row = doc.createElement('label');
      row.className = 'op-row';
      const label = doc.createElement('span');
      label.className = 'op-label';
      label.textContent = control.label;
      const help = doc.createElement('small');
      help.textContent = `받은 기본값 ${control.default}`;
      label.append(help);
      let input;
      if (control.kind === 'select') {
        input = doc.createElement('select');
        for (const option of control.options) {
          const element = doc.createElement('option');
          element.value = option.value;
          element.textContent = option.label;
          input.append(element);
        }
      } else {
        input = doc.createElement('input');
        input.type = 'range';
        Object.assign(input, { min: String(control.min), max: String(control.max), step: String(control.step) });
      }
      input.dataset.control = control.id;
      const value = doc.createElement('span');
      value.className = 'op-value';
      const output = doc.createElement('output');
      value.append(output);
      row.append(label, input, value);
      controlsHost.append(row);
      inputs.push({ control, input, output });
      input.addEventListener('input', () => {
        setFilter(setFilterValue(bundle, current.filter, control.id, control.kind === 'select' ? input.value : Number(input.value)));
        showMessage('');
      });
    }
  }

  function renderSaveState() {
    const base = loadedSaveState({ source: savedSource, note: savedNote, issues: initial.issues });
    showSaveState(panel, stateText, saveStateOf({ saving, failed: saveFailed, dirty: !sameScreenSettings(current, saved), base }));
  }

  function showMessage(text) {
    messageText.textContent = text;
  }

  function render() {
    enabledInput.checked = current.enabled;
    enabledOutput.textContent = current.enabled ? '켬' : '끔 (원본 보기)';
    scaleInput.value = String(current.filter.previewScale);
    scaleOutput.textContent = current.filter.previewScale.toFixed(2);
    const bundle = getBundle();
    if (bundle !== controlsFor) buildControls(bundle);
    const values = filterValues(bundle, current.filter);
    for (const { control, input, output } of inputs) {
      input.value = String(values[control.id]);
      output.textContent = control.kind === 'select' ? control.options.find((o) => o.value === values[control.id])?.label ?? ''
        : String(Number(values[control.id].toFixed(6)));
    }
    renderSaveState();
  }

  function renderLive() {
    const s = compositor.getState();
    const why = s.state === 'fault' ? ` (${s.reason})` : '';
    liveText.textContent = `${STATE_TEXT[s.state] ?? s.state}${why} · ${s.width}x${s.height} · 초당 ${s.drawingsPerSecond}장 · 프레임 ${s.frameAvgMs === null ? '-' : s.frameAvgMs.toFixed(1)}ms · 필터판 ${s.bundle || '-'}`;
    liveText.classList.toggle('is-present', s.state === 'running');
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
    if (open) render();
    else if (!sameScreenSettings(current, saved)) apply(saved);
    syncLive();
    onOpenChange?.(open);
  }

  enabledInput.addEventListener('change', () => {
    apply({ ...current, enabled: enabledInput.checked });
    showMessage('');
  });
  scaleInput.addEventListener('input', () => {
    setFilter({ ...current.filter, previewScale: Number(scaleInput.value) });
    showMessage('');
  });

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
        showMessage('파일에 저장했습니다.');
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
      apply(defaultScreenSettings(getBundle()));
      showMessage('받은 기본값을 적용했습니다. 유지하려면 저장하세요.');
    }
  });

  render();

  return {
    isOpen: () => open,
    open: () => setOpen(true),
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    setActive(next) {
      if (active === next) return;
      active = next;
      syncLive();
    },
    isDirty: () => !sameScreenSettings(current, saved),
    discardUnsaved() {
      if (!sameScreenSettings(current, saved)) apply(saved);
    },
  };
}
