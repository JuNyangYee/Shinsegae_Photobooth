// 운영자용 인식 범위 조절 화면 (숨김 단축키로 연다, 관람객용 아님).
// 조절하는 즉시 감지 루프에 반영하고, "저장"을 눌러야 조절값 파일(서버 config/presence.local.json)에 기록한다.
// 저장하지 않고 닫으면 저장된 값으로 되돌린다: 실행 중인 값과 다시 시작했을 때의 값이 항상 같게 하기 위해서다.

import {
  normalizePresenceSettings,
  presenceLimits,
  samePresenceSettings,
  serializePresenceSettings,
} from '../config/presence-settings.js';
import { createRegionDrag } from './region-drag.js';
import { SettingsSource } from '../config/settings-file.js';

// 슬라이더 항목: [설정 키, 범위, 표시 소수 자릿수, 단위]
const SLIDERS = [
  ['minFaceHeight', presenceLimits.faceHeight, 3, ''],
  ['maxFaceHeight', presenceLimits.faceHeight, 3, ''],
  ['minScore', presenceLimits.minScore, 2, ''],
  ['presentHoldMs', presenceLimits.presentHoldMs, 0, 'ms'],
  ['absentGraceMs', presenceLimits.absentGraceMs, 0, 'ms'],
];

const clone = (settings) => ({ ...settings, region: { ...settings.region } });

/**
 * @param {{ stage: HTMLElement, panel: HTMLElement, layer: HTMLElement, monitor: object, defaults: object,
 *   initial: { settings: object, issues: string[], source: string, note: string },  시작할 때 정한 값 (settings-file.js)
 *   saveSettings: (settings: object) => Promise<void>,  파일에 쓴다. 실패하면 예외
 *   onOpenChange?: (open: boolean) => void }} options
 */
export function createPresenceTuning({ stage, panel, layer, monitor, defaults, initial, saveSettings, onOpenChange }) {
  const regionEl = layer.querySelector('[data-region]');
  const liveText = panel.querySelector('[data-live]');
  const regionText = panel.querySelector('[data-region-text]');
  const stateText = panel.querySelector('[data-state]');
  const messageText = panel.querySelector('[data-message]');
  const jsonText = panel.querySelector('[data-json]');
  const sliders = new Map(SLIDERS.map(([key, limits, digits, unit]) => {
    const input = panel.querySelector(`input[data-key="${key}"]`);
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.step = String(limits.step);
    return [key, { input, output: panel.querySelector(`output[data-key="${key}"]`), digits, unit }];
  }));

  const loaded = initial;
  if (loaded.issues.length > 0) console.warn('[presence-tuning] stored settings adjusted:', loaded.issues);
  let saved = clone(loaded.settings);
  // 저장값의 출처 (SettingsSource): file·migrated·localStorage·defaults, 이번 실행 중 저장하면 saved
  let savedSource = loaded.source;
  let savedNote = loaded.note;
  let saving = false;
  // 저장 중에 닫기를 요청하면 저장이 끝난 뒤 닫는다 (4단계 검수 4). 닫을 때는 늘 마지막으로 파일에 저장된 값으로 맞추므로
  // 저장이 성공하든 실패하든 "실행 중인 판정값 = 파일 값"이 유지된다.
  let closeAfterSave = false;
  let current = clone(saved);
  let open = false;
  let liveTimer = null;
  monitor.setSettings(current);

  function apply(next) {
    current = normalizePresenceSettings(next, defaults).settings;
    monitor.setSettings(current);
    render();
  }

  function showMessage(text) {
    messageText.textContent = text;
  }

  function render() {
    const { region } = current;
    Object.assign(regionEl.style, {
      left: `${region.x * 100}%`,
      top: `${region.y * 100}%`,
      width: `${region.width * 100}%`,
      height: `${region.height * 100}%`,
    });
    regionText.textContent = `영역 x ${region.x.toFixed(3)}  y ${region.y.toFixed(3)}`
      + `  폭 ${region.width.toFixed(3)}  높이 ${region.height.toFixed(3)}  (화면에서 끌어 옮기고, 모서리·변으로 크기 조절)`;
    for (const [key, { input, output, digits, unit }] of sliders) {
      input.value = String(current[key]);
      output.textContent = `${current[key].toFixed(digits)}${unit}`;
    }
    const dirty = !samePresenceSettings(current, saved);
    stateText.textContent = dirty ? '저장하지 않은 변경이 있습니다 (닫으면 취소됩니다)' : '저장된 값과 같습니다';
    stateText.classList.toggle('is-dirty', dirty);
    jsonText.value = serializePresenceSettings(current);
  }

  function renderLive() {
    const d = monitor.getDebugSnapshot();
    const accepted = d.faces.filter((face) => face.accepted).length;
    const progress = d.progress
      ? ` · ${d.progress.target ? '인식됨' : '인식 안됨'}까지 ${Math.round(d.progress.elapsedMs)}/${d.progress.requiredMs}ms`
      : '';
    liveText.textContent = `${d.present ? '인식됨' : '인식 안됨'}${progress} · 얼굴 ${d.faces.length}개 감지, ${accepted}개 인정`
      + ` · 감지기 ${d.status}${d.status === 'error' ? ' (D 화면 참고)' : ''}`;
    liveText.classList.toggle('is-present', d.present);
  }

  // 조절 화면을 열 때 알릴 것: 파일을 쓰지 못하는 출처(기본값·localStorage)와 불러올 때 고친 내용
  function openingMessage() {
    if (savedSource === SettingsSource.SAVED || !samePresenceSettings(current, saved)) return '';
    const parts = [];
    if (savedSource === SettingsSource.DEFAULTS && savedNote !== 'no file') {
      parts.push(`조절값 파일을 쓰지 못해 기본값으로 시작했습니다 (${savedNote}).`);
    } else if (savedSource === SettingsSource.LOCAL_ONLY) {
      parts.push(`이전 브라우저 저장값을 파일로 옮기지 못했습니다 (${savedNote}). 저장을 눌러 다시 시도하세요.`);
    }
    if (loaded.issues.length > 0) parts.push(`시작할 때 저장값을 고쳐 불러왔습니다: ${loaded.issues.join(', ')}`);
    return parts.join(' ');
  }

  function setOpen(next) {
    if (open === next) return;
    if (!next && saving) {
      closeAfterSave = true;
      showMessage('저장 중입니다. 저장이 끝나면 닫습니다.');
      return;
    }
    open = next;
    panel.hidden = !open;
    layer.hidden = !open;
    clearInterval(liveTimer);
    liveTimer = null;
    if (open) {
      render();
      renderLive();
      liveTimer = setInterval(renderLive, 200);
      showMessage(openingMessage());
    } else {
      regionDrag.end();
      if (!samePresenceSettings(current, saved)) {
        console.info('[presence-tuning] closed without saving; reverted to saved settings');
        apply(saved);
      }
    }
    onOpenChange?.(open);
  }

  // ---- 슬라이더 ----
  for (const [key, { input }] of sliders) {
    input.addEventListener('input', () => {
      let value = Number(input.value);
      // 최대 얼굴 크기가 최소보다 작아지지 않게, 움직인 쪽을 멈춘다.
      if (key === 'minFaceHeight') value = Math.min(value, current.maxFaceHeight);
      if (key === 'maxFaceHeight') value = Math.max(value, current.minFaceHeight);
      apply({ ...current, [key]: value });
      showMessage('');
    });
  }

  // ---- 버튼 ----
  panel.addEventListener('click', async (event) => {
    const action = event.target.closest('button[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'save') {
      if (saving) return;
      saving = true;
      const target = clone(current);
      const button = event.target.closest('button');
      button.disabled = true;
      showMessage('저장 중...');
      try {
        await saveSettings(target);
        saved = target;
        savedSource = SettingsSource.SAVED;
        savedNote = '';
        render();
        showMessage(samePresenceSettings(current, saved) ? '파일에 저장했습니다.' : '파일에 저장했습니다. 저장 중에 바뀐 값은 아직 저장되지 않았습니다.');
      } catch (error) {
        // 저장되지 않은 상태를 그대로 둔다 (닫으면 마지막 저장값으로 돌아간다).
        render();
        showMessage(`저장하지 못했습니다: ${error?.message ?? error}`);
      } finally {
        saving = false;
        button.disabled = false;
        if (closeAfterSave) {
          closeAfterSave = false;
          setOpen(false);
        }
      }
    } else if (action === 'revert') {
      apply(saved);
      showMessage('저장된 값으로 되돌렸습니다.');
    } else if (action === 'defaults') {
      apply(defaults);
      showMessage('기본값을 적용했습니다. 유지하려면 저장하세요.');
    } else if (action === 'dock') {
      panel.dataset.dock = panel.dataset.dock === 'top' ? 'bottom' : 'top';
    } else if (action === 'copy') {
      try {
        await navigator.clipboard.writeText(jsonText.value);
        showMessage('현재값 JSON을 복사했습니다.');
      } catch {
        jsonText.select();
        showMessage('JSON을 선택했습니다. Ctrl+C로 복사하세요.');
      }
    } else if (action === 'close') {
      setOpen(false);
    }
  });

  // ---- 영역 끌기 (region-drag.js) ----
  const regionDrag = createRegionDrag({
    element: regionEl,
    win: window,
    getRegion: () => current.region,
    toStagePoint(event) {
      const rect = stage.getBoundingClientRect();
      return { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height };
    },
    onChange: (region) => apply({ ...current, region }),
    onDragChange(dragging) {
      regionEl.classList.toggle('is-dragging', dragging);
      if (dragging) showMessage('');
    },
  });

  render();

  return {
    isOpen: () => open,
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    /**
     * D 화면용: 지금 판정에 쓰는 값의 출처. 예: 'file', 'saved', 'defaults (no file)', 'file + unsaved changes'.
     * 저장하기 전까지는 출처 설명(실패 이유 등)과 시작할 때 저장값을 고친 내용도 붙인다.
     */
    describeSettingsSource() {
      const dirty = !samePresenceSettings(current, saved);
      const note = savedNote ? ` (${savedNote})` : '';
      const issues = savedSource !== SettingsSource.SAVED && loaded.issues.length > 0
        ? ` (adjusted on load: ${loaded.issues.join('; ')})` : '';
      return `${savedSource}${note}${dirty ? ' + unsaved changes' : ''}${issues}`;
    },
  };
}
