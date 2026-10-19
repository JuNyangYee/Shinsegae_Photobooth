// 운영자용 사진 효과 조절 화면 (숨김 단축키 E, 관람객용 아님, 5-2).
// 조절하는 즉시 미리보기에 반영하고, "저장"을 눌러야 효과 조절값 파일(서버 config/effect.local.json)에 기록한다.
// 저장·취소·기본값·닫기 규칙은 인식 범위 조절(presence-tuning.js, R)과 같다:
// 저장하지 않고 닫으면 저장된 값으로 되돌리고(실행 중인 값 = 다시 시작했을 때의 값), 저장 중에 닫으면 저장이 끝난 뒤 닫는다.
// 출력 단계(6-1): 모드(감열지·회색조·끔)·점 방식·용지 폭은 선택 상자, 밝기·대비·감마는 슬라이더. 기능만 넣었다(디자인은 6-3).
// 흑백 스타일(7-1): 스타일은 선택 상자, 질감 세기·선 간격은 슬라이더. 감열지에서만 쓰고, 스타일에 따라 쓰지 않는 항목을 막는다.
// Node 테스트: test/ui/effect-tuning.test.mjs

import {
  applyEffectTunables,
  effectLimits,
  effectTunables,
  normalizeEffectSettings,
  sameEffectSettings,
} from '../config/effect-settings.js';
import { SettingsSource } from '../config/settings-file.js';
import { loadedSaveState, saveStateOf, showSaveState } from './save-state.js';

// 슬라이더 항목: [조절값 키, 범위, 표시 소수 자릿수]. 범위는 원본 갤러리 슬라이더와 같다 (effect-settings.js)
const SLIDERS = [
  ['strength', effectLimits.strength, 2],
  ['size', effectLimits.size, 2],
  ['boil', effectLimits.boil, 2],
  ['fps', effectLimits.fps, 0],
  ['grade', effectLimits.grade, 2],
  ['refineThreshold', effectLimits.refineThreshold, 2],
  ['previewScale', effectLimits.previewScale, 2],
  ['brightness', effectLimits.brightness, 2],
  ['contrast', effectLimits.contrast, 2],
  ['gamma', effectLimits.gamma, 2],
  ['bwTexture', effectLimits.bwTexture, 2],
  ['lineSpacing', effectLimits.lineSpacing, 1],
];

// 선택 상자 항목: [조절값 키, 값 변환]. 선택지는 index.html에 있다
const SELECTS = [
  ['outputMode', String],
  ['dither', String],
  ['paperDots', Number],
  ['bwStyle', String],
];
const LEVEL_KEYS = new Set(['brightness', 'contrast', 'gamma']); // 회색조·감열지에서 쓴다
const THERMAL_KEYS = new Set(['dither', 'paperDots', 'bwStyle', 'bwTexture', 'lineSpacing']); // 감열지에서만 쓴다
const LINE_STYLES = new Set(['flow', 'stroke']); // 점 방식 대신 선으로 점을 정하는 흑백 스타일 (7-1)

/** 이 값들에서 쓰지 않는 항목인지 (막는다): 회색조·끔이면 감열지 항목, 톤 점이면 질감 세기, 선 스타일이 아니면 선 간격, 선 스타일이면 점 방식 */
export function isUnusedTunable(key, values) {
  if (THERMAL_KEYS.has(key) && values.outputMode !== 'thermal') return true;
  if (key === 'bwTexture') return values.bwStyle === 'tone';
  if (key === 'lineSpacing') return !LINE_STYLES.has(values.bwStyle);
  if (key === 'dither') return LINE_STYLES.has(values.bwStyle);
  return false;
}
const OUTPUT_LABELS = Object.freeze({ thermal: '감열지', gray: '회색조', off: '컬러' });

/**
 * @param {{ panel: HTMLElement, preview: { setSettings: Function, getState: Function }, defaults: object,
 *   initial: { settings: object, issues: string[], source: string, note: string },  시작할 때 정한 값 (settings-file.js)
 *   saveSettings: (settings: object) => Promise<void>,  파일에 쓴다. 실패하면 예외
 *   onOpenChange?: (open: boolean) => void, timers?: { setInterval: Function, clearInterval: Function } }} options
 *   defaults: config.effect
 */
export function createEffectTuning({ panel, preview, defaults, initial, saveSettings, onOpenChange, timers = globalThis }) {
  const liveText = panel.querySelector('[data-live]');
  const stateText = panel.querySelector('[data-state]');
  const messageText = panel.querySelector('[data-message]');
  const sliders = new Map(SLIDERS.map(([key, limits, digits]) => {
    const input = panel.querySelector(`input[data-key="${key}"]`);
    input.min = String(limits.min);
    input.max = String(limits.max);
    input.step = String(limits.step);
    return [key, { input, output: panel.querySelector(`output[data-key="${key}"]`), digits }];
  }));
  const selects = new Map(SELECTS.map(([key, parse]) => [key, {
    select: panel.querySelector(`select[data-key="${key}"]`), output: panel.querySelector(`output[data-key="${key}"]`), parse,
  }]));

  const baseDefaults = normalizeEffectSettings(defaults, defaults).settings;
  const loaded = initial;
  if (loaded.issues.length > 0) console.warn('[effect-tuning] stored settings adjusted:', loaded.issues);
  let saved = loaded.settings;
  let savedSource = loaded.source;
  let savedNote = loaded.note;
  let saving = false;
  let saveFailed = false; // 마지막 저장이 실패함 (값을 다시 바꾸거나 저장에 성공하면 풀린다)
  let closeAfterSave = false;
  let current = saved;
  let open = false;
  let liveTimer = null;
  preview.setSettings(current);

  function apply(next) {
    saveFailed = false;
    current = next;
    preview.setSettings(current);
    render();
  }

  function renderSaveState() {
    // 바꾸지 않았을 때 보일 상태는 시작할 때 불러온 결과로 (파일 없음·불러오기 실패·고쳐 씀, 6단계 검수 1)
    const base = loadedSaveState({ source: savedSource, note: savedNote, issues: loaded.issues });
    showSaveState(panel, stateText, saveStateOf({ saving, failed: saveFailed, dirty: !sameEffectSettings(current, saved), base }));
  }

  function showMessage(text) {
    messageText.textContent = text;
  }

  function render() {
    const values = effectTunables(current);
    for (const [key, { input, output, digits }] of sliders) {
      const value = values[key];
      // 보완 층이 없으면 문턱을 조절할 수 없다. 레벨은 출력 모드가 끔(컬러)이면 쓰지 않는다
      input.disabled = value === null || (LEVEL_KEYS.has(key) && values.outputMode === 'off') || isUnusedTunable(key, values);
      input.value = value === null ? input.min : String(value);
      output.textContent = value === null ? '-' : value.toFixed(digits);
    }
    for (const [key, { select, output }] of selects) {
      select.value = String(values[key]);
      select.disabled = isUnusedTunable(key, values);
      if (output) output.textContent = key === 'paperDots' ? `${values.paperDots}점` : '';
    }
    renderSaveState();
  }

  function renderLive() {
    const e = preview.getState();
    const ms = e.cpuAvgMs === null ? '-' : `${e.cpuAvgMs.toFixed(1)}ms`;
    const fmt = (value) => (value === null || value === undefined ? '-' : `${value.toFixed(1)}ms`);
    const output = e.outputMode === 'thermal' && e.printWidth
      ? ` · 감열지 ${e.printWidth}x${e.printHeight} ${e.screen ?? e.dither}${e.readMs === null ? '' : ` (읽기 ${fmt(e.readMs)}, 디더 ${fmt(e.ditherMs)})`}`
      : ` · ${OUTPUT_LABELS[e.outputMode] ?? ''}`;
    liveText.textContent = e.status === 'running'
      ? `미리보기 ${e.width}x${e.height} · 초당 ${e.drawingsPerSecond}장 (설정 ${e.fps}) · 그리기 ${ms}${output}`
      : `미리보기 효과 ${e.status}${e.fault ? ` (${e.fault})` : ''} — 원본 미리보기 중입니다. 값은 저장할 수 있습니다.`;
  }

  function openingMessage() {
    if (savedSource === SettingsSource.SAVED || !sameEffectSettings(current, saved)) return '';
    const parts = [];
    if (savedSource === SettingsSource.DEFAULTS && savedNote !== 'no file') {
      parts.push(`효과 조절값 파일을 쓰지 못해 기본값으로 시작했습니다 (${savedNote}).`);
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
    timers.clearInterval(liveTimer);
    liveTimer = null;
    if (open) {
      render();
      renderLive();
      liveTimer = timers.setInterval(renderLive, 500);
      showMessage(openingMessage());
    } else if (!sameEffectSettings(current, saved)) {
      console.info('[effect-tuning] closed without saving; reverted to saved settings');
      apply(saved);
    }
    onOpenChange?.(open);
  }

  for (const [key, { input }] of sliders) {
    input.addEventListener('input', () => {
      apply(applyEffectTunables(current, { [key]: Number(input.value) }, defaults).settings);
      showMessage('');
    });
  }

  for (const [key, { select, parse }] of selects) {
    select.addEventListener('change', () => {
      apply(applyEffectTunables(current, { [key]: parse(select.value) }, defaults).settings);
      showMessage('');
    });
  }

  panel.addEventListener('click', async (event) => {
    const action = event.target.closest('button[data-action]')?.dataset.action;
    if (!action) return;
    if (action === 'save') {
      if (saving) return;
      saving = true;
      const target = current;
      const button = event.target.closest('button');
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
        showMessage(sameEffectSettings(current, saved) ? '파일에 저장했습니다.' : '파일에 저장했습니다. 저장 중에 바뀐 값은 아직 저장되지 않았습니다.');
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
      apply(baseDefaults);
      showMessage('기본값을 적용했습니다. 유지하려면 저장하세요.');
    } else if (action === 'dock') {
      panel.dataset.dock = panel.dataset.dock === 'top' ? 'bottom' : 'top';
    } else if (action === 'close') {
      setOpen(false);
    }
  });

  render();

  return {
    isOpen: () => open,
    toggle: () => setOpen(!open),
    close: () => setOpen(false),
    /** D 화면용: 지금 효과에 쓰는 값의 출처. 예: 'file', 'saved', 'defaults (no file)', 'file + unsaved changes' */
    describeSettingsSource() {
      const dirty = !sameEffectSettings(current, saved);
      const note = savedNote ? ` (${savedNote})` : '';
      const issues = savedSource !== SettingsSource.SAVED && loaded.issues.length > 0
        ? ` (adjusted on load: ${loaded.issues.join('; ')})` : '';
      return `${savedSource}${note}${dirty ? ' + unsaved changes' : ''}${issues}`;
    },
  };
}
