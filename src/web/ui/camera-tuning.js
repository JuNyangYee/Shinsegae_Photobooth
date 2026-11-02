// 운영자 조절 화면(E, operator-panel.js)의 "카메라" 섹션 (9-2, 관람객용 아님): 장치·해상도·좌우 반전·회전·확대·이동·색 보정.
// 카메라 원본 자체를 고치는 값이라 감지·미리보기·결과·인쇄에 같게 적용된다(main.js applyCameraSettings, core/camera-view.js).
// 조절하는 즉시 반영하고(장치·해상도가 바뀌면 카메라를 다시 연다), "저장"을 눌러야 카메라 조절값 파일(config/camera.local.json)에 기록한다.
// 저장·취소·기본값·닫기 규칙은 인식·필터 섹션과 같다(패널을 닫을 때 저장하지 않은 변경은 저장된 값으로, 저장 중이면 끝난 뒤 닫는다).
// Node 테스트: test/ui/camera-tuning.test.mjs

import {
  CAMERA_ROTATIONS, cameraLimits, normalizeCameraSettings, sameCameraSettings,
} from '../config/camera-settings.js';
import { SettingsSource } from '../config/settings-file.js';
import { loadedSaveState, saveStateOf, showSaveState } from './save-state.js';

// 슬라이더 항목: [설정 키, 표시 소수 자릿수]. 범위는 config/camera-settings.js cameraLimits
const SLIDERS = [
  ['rotationFine', 1], ['zoom', 2], ['panX', 3], ['panY', 3],
  ['brightness', 2], ['contrast', 2], ['saturation', 2], ['gamma', 2], ['temperature', 2], ['tint', 2],
];
const OBS_LABEL = /obs virtual camera/i;

/** 받은 크기·지원 범위·OBS 안내 한 줄 (카메라 섹션 [data-camera-info]) */
export function describeCameraInfo({ state, video, settings }) {
  if (state.status !== 'ready') return `카메라 ${state.status}${state.reason ? ` (${state.reason}${state.errorName ? ` / ${state.errorName}` : ''})` : ''}`;
  const parts = [`받은 크기 ${video.videoWidth}×${video.videoHeight}`];
  const caps = state.capabilities;
  if (caps?.width && caps?.height) parts.push(`지원 가로 ${caps.width.min}–${caps.width.max} · 세로 ${caps.height.min}–${caps.height.max}`);
  if (settings.resolution !== 'auto') {
    const [w, h] = settings.resolution.split('x').map(Number);
    if (w !== video.videoWidth || h !== video.videoHeight) parts.push(`요청 ${w}×${h}과 다름 (장치가 고른 값${w / h !== video.videoWidth / video.videoHeight ? ', 잘림' : ''})`);
  }
  if (OBS_LABEL.test(state.label)) parts.push('OBS 가상카메라는 자동 권장');
  return parts.join(' · ');
}

/**
 * @param {{ panel: HTMLElement, camera: { getState: Function, listDevices: () => Promise<object[]> },
 *   frame: { getView: Function }, video: { videoWidth: number, videoHeight: number }, defaults: object,
 *   initial: { settings: object, issues: string[], source: string, note: string },  시작할 때 정한 값 (settings-file.js)
 *   applySettings: (settings: object) => void,  main.js applyCameraSettings
 *   saveSettings: (settings: object) => Promise<void>, onOpenChange?: (open: boolean) => void,
 *   timers?: { setInterval: Function, clearInterval: Function } }} options  defaults: config.camera
 */
export function createCameraTuning({
  panel, camera, frame, video, defaults, initial, applySettings, saveSettings, onOpenChange, timers = globalThis,
}) {
  const liveText = panel.querySelector('[data-live]');
  const infoText = panel.querySelector('[data-camera-info]');
  const stateText = panel.querySelector('[data-state]');
  const messageText = panel.querySelector('[data-message]');
  const deviceSelect = panel.querySelector('select[data-key="deviceLabel"]');
  const resolutionSelect = panel.querySelector('select[data-key="resolution"]');
  const mirrorSelect = panel.querySelector('select[data-key="mirror"]');
  const rotationOutput = panel.querySelector('output[data-key="rotation"]');
  const sliders = new Map(SLIDERS.map(([key, digits]) => {
    const input = panel.querySelector(`input[data-key="${key}"]`);
    const { min, max, step } = cameraLimits[key];
    Object.assign(input, { min: String(min), max: String(max), step: String(step) });
    return [key, { input, output: panel.querySelector(`output[data-key="${key}"]`), digits }];
  }));

  const baseDefaults = normalizeCameraSettings(defaults, defaults).settings;
  const loaded = initial;
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
  let devices = []; // 마지막으로 읽은 장치 라벨

  function apply(patch) {
    saveFailed = false;
    current = normalizeCameraSettings({ ...current, ...patch }, defaults).settings;
    applySettings(current);
    render();
  }

  function revert() {
    saveFailed = false;
    current = saved;
    applySettings(current);
    render();
  }

  function renderSaveState() {
    const base = loadedSaveState({ source: savedSource, note: savedNote, issues: loaded.issues });
    showSaveState(panel, stateText, saveStateOf({ saving, failed: saveFailed, dirty: !sameCameraSettings(current, saved), base }));
  }

  function showMessage(text) {
    messageText.textContent = text;
  }

  // 장치 선택지: 자동 + 읽은 장치 라벨 + (지금 값이 목록에 없으면) "연결 안 됨"
  function renderDevices() {
    const labels = devices.filter(Boolean);
    const wanted = [''].concat(labels);
    if (current.deviceLabel && !labels.includes(current.deviceLabel)) wanted.push(current.deviceLabel);
    const have = [...deviceSelect.options].map((o) => o.value);
    if (have.join('\n') !== wanted.join('\n')) {
      const auto = deviceSelect.options[0];
      deviceSelect.replaceChildren(auto);
      for (const label of wanted.slice(1)) {
        const option = deviceSelect.ownerDocument.createElement('option');
        option.value = label;
        option.textContent = labels.includes(label) ? label : `${label} (연결 안 됨)`;
        deviceSelect.append(option);
      }
    }
    deviceSelect.value = current.deviceLabel;
  }

  function render() {
    renderDevices();
    resolutionSelect.value = current.resolution;
    mirrorSelect.value = String(current.mirror);
    rotationOutput.textContent = String(current.rotation);
    for (const [key, { input, output, digits }] of sliders) {
      input.value = String(current[key]);
      output.textContent = current[key].toFixed(digits);
    }
    renderSaveState();
    renderInfo();
  }

  function renderInfo() {
    infoText.textContent = describeCameraInfo({ state: camera.getState(), video, settings: current });
  }

  function renderLive() {
    const s = camera.getState();
    const view = frame.getView(video.videoWidth, video.videoHeight);
    const zoom = view ? ` · 실제 확대 ${view.zoom.toFixed(2)}${view.autoZoom ? ' (빈 곳을 덮으려 자동 확대)' : ''}` : '';
    liveText.textContent = s.status === 'ready'
      ? `카메라 준비됨 · ${s.label || '(라벨 없음)'} (${{ device: '고른 장치', preferred: 'OBS 규칙', default: '기본 카메라' }[s.selection] ?? '-'})${zoom}`
      : `카메라 ${s.status}${s.connecting ? ' (여는 중)' : ''} — 관람객 화면은 "준비 중"입니다`;
    liveText.classList.toggle('is-present', s.status === 'ready');
    renderInfo();
  }

  async function refreshDevices() {
    try {
      devices = (await camera.listDevices()).map((d) => d.label);
    } catch (error) {
      showMessage(`장치 목록을 읽지 못했습니다: ${error?.message ?? error}`);
    }
    renderDevices();
  }

  function openingMessage() {
    if (savedSource === SettingsSource.SAVED || !sameCameraSettings(current, saved)) return '';
    const parts = [];
    if (savedSource === SettingsSource.DEFAULTS && savedNote !== 'no file') parts.push(`카메라 조절값 파일을 쓰지 못해 기본값으로 시작했습니다 (${savedNote}).`);
    if (savedSource === SettingsSource.EFFECT_FILE_ONLY) parts.push(`예전 좌우 반전 값을 카메라 파일로 옮기지 못했습니다 (${savedNote}). 저장을 눌러 다시 시도하세요.`);
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
      refreshDevices();
      showMessage(openingMessage());
    } else if (!sameCameraSettings(current, saved)) {
      console.info('[camera-tuning] closed without saving; reverted to saved settings');
      revert();
    }
    syncLive();
    onOpenChange?.(open);
  }

  for (const [key, { input }] of sliders) {
    input.addEventListener('input', () => {
      apply({ [key]: Number(input.value) });
      showMessage('');
    });
  }
  deviceSelect.addEventListener('change', () => {
    apply({ deviceLabel: deviceSelect.value });
    showMessage('카메라를 다시 엽니다.');
  });
  resolutionSelect.addEventListener('change', () => {
    apply({ resolution: resolutionSelect.value });
    showMessage('카메라를 다시 엽니다.');
  });
  mirrorSelect.addEventListener('change', () => {
    apply({ mirror: mirrorSelect.value === 'true' });
    showMessage('');
  });

  panel.addEventListener('click', async (event) => {
    const button = event.target.closest('button[data-action]');
    const action = button?.dataset.action;
    if (!action) return;
    if (action === 'rotate-left' || action === 'rotate-right') {
      const step = action === 'rotate-right' ? 1 : CAMERA_ROTATIONS.length - 1;
      const index = (CAMERA_ROTATIONS.indexOf(current.rotation) + step) % CAMERA_ROTATIONS.length;
      apply({ rotation: CAMERA_ROTATIONS[index] });
      // 90° 돌리면 0·180 ↔ 90·270이 바뀐다. 자동 해상도는 가로·세로를 바꿔 요청하므로 카메라를 다시 연다
      showMessage(current.resolution === 'auto' ? '방향이 바뀌어 카메라를 다시 엽니다 (자동 해상도는 가로·세로를 바꿔 요청한다).' : '');
    } else if (action === 'refresh-devices') {
      await refreshDevices();
      showMessage(`장치 ${devices.filter(Boolean).length}개`);
    } else if (action === 'save') {
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
        showMessage(sameCameraSettings(current, saved) ? '파일에 저장했습니다.' : '파일에 저장했습니다. 저장 중에 바뀐 값은 아직 저장되지 않았습니다.');
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
      // 이 섹션의 값만 (장치·해상도·방향·위치·색 보정). 인식·필터 섹션은 그대로
      apply(baseDefaults);
      showMessage('카메라 기본값을 적용했습니다. 유지하려면 저장하세요.');
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
    isDirty: () => !sameCameraSettings(current, saved),
    /** 저장하지 않은 변경을 저장된 값으로 되돌린다 (패널이 닫히는 순간, operator-panel.js) */
    discardUnsaved() {
      if (!sameCameraSettings(current, saved)) revert();
    },
    getSettings: () => current,
    /** D 화면용: 지금 카메라에 쓰는 값의 출처 */
    describeSettingsSource() {
      const dirty = !sameCameraSettings(current, saved);
      const note = savedNote && savedNote !== 'no file' ? ` (${savedNote})` : savedSource === SettingsSource.DEFAULTS ? ' (no file)' : '';
      const issues = savedSource !== SettingsSource.SAVED && loaded.issues.length > 0 ? `, adjusted: ${loaded.issues.join('; ')}` : '';
      return `${savedSource}${note}${dirty ? ' + unsaved changes' : ''}${issues}`;
    },
  };
}
