// 운영자용 인식 범위 조절 화면 (숨김 단축키로 연다, 관람객용 아님).
// 조절하는 즉시 감지 루프에 반영하고, "저장"을 눌러야 localStorage에 기록한다.
// 저장하지 않고 닫으면 저장된 값으로 되돌린다: 실행 중인 값과 다시 시작했을 때의 값이 항상 같게 하기 위해서다.

import {
  loadPresenceSettings,
  normalizePresenceSettings,
  presenceLimits,
  samePresenceSettings,
  savePresenceSettings,
  serializePresenceSettings,
} from './presence-settings.js';
import { createRegionDrag } from './region-drag.js';

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
 * @param {{ stage: HTMLElement, panel: HTMLElement, layer: HTMLElement, monitor: object,
 *   defaults: object, storage: Storage | undefined, onOpenChange?: (open: boolean) => void }} options
 */
export function createPresenceTuning({ stage, panel, layer, monitor, defaults, storage, onOpenChange }) {
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

  const loaded = loadPresenceSettings(storage, defaults);
  if (loaded.issues.length > 0) console.warn('[presence-tuning] stored settings adjusted:', loaded.issues);
  let saved = clone(loaded.settings);
  // 저장값의 출처: 'stored'(시작할 때 저장소에서 읽음), 'defaults'(저장값 없음·사용 불가), 'saved'(이번 실행 중 저장함)
  let savedSource = loaded.source;
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

  function setOpen(next) {
    if (open === next) return;
    open = next;
    panel.hidden = !open;
    layer.hidden = !open;
    clearInterval(liveTimer);
    liveTimer = null;
    if (open) {
      render();
      renderLive();
      liveTimer = setInterval(renderLive, 200);
      showMessage(loaded.issues.length > 0 && samePresenceSettings(current, saved)
        ? `시작할 때 저장값을 고쳐 불러왔습니다: ${loaded.issues.join(', ')}`
        : '');
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
      const error = savePresenceSettings(storage, current);
      if (error === null) {
        saved = clone(current);
        savedSource = 'saved';
        render();
        showMessage('저장했습니다.');
      } else {
        showMessage(`저장하지 못했습니다: ${error}`);
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
     * D 화면용: 지금 판정에 쓰는 값의 출처. 예: 'stored', 'saved', 'defaults', 'stored + unsaved changes'.
     * 저장하기 전까지는 시작할 때 저장값을 고친 내용도 붙인다.
     */
    describeSettingsSource() {
      const dirty = !samePresenceSettings(current, saved);
      const issues = savedSource !== 'saved' && loaded.issues.length > 0
        ? ` (adjusted on load: ${loaded.issues.join('; ')})` : '';
      return `${savedSource}${dirty ? ' + unsaved changes' : ''}${issues}`;
    },
  };
}
