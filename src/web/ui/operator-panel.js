// 운영자 조절 화면 (9-2, 숨김 단축키 E 하나, 관람객용 아님): 패널 하나에 섹션 넷 — 카메라·인식·시간(10단계)·필터.
// 섹션마다 파일 하나(camera·presence·timing·effect)와 저장 상태·저장·취소·기본값을 따로 가진다(각 섹션 모듈: camera-tuning.js,
// presence-tuning.js, timing-tuning.js, effect-tuning.js). 이 모듈은 열기·닫기, 보이는 섹션 고르기, 위·아래, 섹션 버튼의 저장 상태 점만 맡는다.
// - 열면 모든 섹션이 "열림"(저장하지 않은 변경을 셀 수 있게)이고 고른 섹션 하나만 보인다(실시간 줄·영역 편집은 보이는 섹션만 돈다).
// - 닫으면 섹션마다 저장하지 않은 변경을 되돌린다(실행 중인 값 = 다시 시작했을 때의 값). 저장 중인 섹션이 있으면 그 섹션을 보이고
//   저장이 끝난 뒤 닫는다(섹션 모듈이 닫힘을 알릴 때 다시 확인한다). 그동안 패널은 비활성(inert, data-closing: 입력·섹션 이동 없음)이고,
//   실제로 닫히는 순간 모든 섹션의 저장하지 않은 변경을 다시 확인해 되돌린다 (9단계 검수 1: 기다리는 동안 다른 섹션을 바꾸면 남았다).
// - 마지막으로 본 섹션은 기억하지만 저장하지 않는다(새로고침하면 카메라 섹션부터). Node 테스트: test/ui/operator-panel.test.mjs

export const PanelSection = Object.freeze({ CAMERA: 'camera', PRESENCE: 'presence', TIMING: 'timing', EFFECT: 'effect', SCREEN: 'screen' });
const ORDER = Object.freeze([PanelSection.CAMERA, PanelSection.PRESENCE, PanelSection.TIMING, PanelSection.EFFECT, PanelSection.SCREEN]);

/**
 * 원본 창(9-2)을 보일지: 패널이 열려 있고 카메라·인식 섹션이 보일 때. 필터 섹션에서는 효과 미리보기 자체를 보므로 숨기고,
 * 시간 섹션은 그림과 관계없는 값이라 숨긴다(카운트다운·결과를 화면 그대로 확인).
 * 인식 섹션에서도 보이는 이유: 필터(회색조 유화)가 얼굴을 덜 보이게 해도 감지는 필터 전 그림으로 한다는 것을 박스와 함께 보여 준다
 */
export function showsRawWindow({ open, section }) {
  return open && (section === PanelSection.CAMERA || section === PanelSection.PRESENCE);
}

/** 인식 영역 편집 층·얼굴 크기 가이드를 보일지: 패널이 열려 있고 인식 섹션이 보일 때 */
export function showsPresenceEditing({ open, section }) {
  return open && section === PanelSection.PRESENCE;
}
const TAB_REFRESH_MS = 300;

/**
 * @param {{ root: HTMLElement, onOpenChange?: (open: boolean) => void, onSectionChange?: (section: string) => void,
 *   timers?: { setInterval: Function, clearInterval: Function } }} options
 *   root: #operator-panel. 섹션 요소는 [data-section-panel], 섹션 버튼은 [data-section]
 */
export function createOperatorPanel({ root, onOpenChange = () => {}, onSectionChange = () => {}, timers = globalThis }) {
  const sectionEls = new Map(ORDER.map((name) => [name, root.querySelector(`[data-section-panel="${name}"]`)]));
  const tabs = new Map(ORDER.map((name) => [name, root.querySelector(`[data-section="${name}"]`)]));
  const controllers = new Map(); // 섹션 이름 → 섹션 모듈 (불러오기가 끝나면 붙는다)
  let section = PanelSection.CAMERA;
  let open = false;
  let closing = false; // 닫기를 요청했지만 저장 중인 섹션이 있어 기다리는 중
  let closingAll = false; // 섹션마다 close()를 부르는 중 (그 사이의 닫힘 알림은 루프가 끝난 뒤 한 번에 본다)
  let tabTimer = null;

  function renderTabs() {
    for (const [name, tab] of tabs) {
      const active = name === section;
      tab.setAttribute('aria-selected', String(active));
      tab.classList.toggle('is-active', active);
      // 섹션의 저장 상태(data-save, save-state.js)를 버튼 점 색으로
      tab.dataset.save = sectionEls.get(name).dataset.save ?? '';
      tab.disabled = !controllers.has(name);
    }
  }

  function showSection(name) {
    section = name;
    for (const [key, el] of sectionEls) el.hidden = !open || key !== name;
    for (const [key, controller] of controllers) controller.setActive(open && key === name);
    renderTabs();
  }

  function select(name) {
    if (closing) return; // 저장이 끝나 닫히기를 기다리는 동안은 섹션을 바꾸지 않는다
    if (!ORDER.includes(name) || !controllers.has(name)) return;
    const changed = name !== section;
    showSection(name);
    if (changed) onSectionChange(name);
  }

  // 닫기를 기다리는 동안: 입력·섹션 이동을 막고 "닫는 중"을 보인다 (style.css [data-closing])
  function setClosingUi(on) {
    root.inert = on;
    if (on) root.dataset.closing = 'true';
    else delete root.dataset.closing;
  }

  function finishClose() {
    closing = false;
    setClosingUi(false);
    // 닫히는 순간 저장하지 않은 변경이 남은 섹션이 있으면(기다리는 동안 생긴 것 포함) 되돌린다
    for (const controller of controllers.values()) {
      if (controller.isDirty?.()) controller.discardUnsaved();
    }
    open = false;
    root.hidden = true;
    timers.clearInterval(tabTimer);
    tabTimer = null;
    showSection(section);
    onOpenChange(false);
  }

  /** 섹션이 닫혔다고 알릴 때(저장 중 닫기가 끝난 경우 포함) 모두 닫혔으면 패널을 닫는다 */
  function checkClosed() {
    if (!closing || closingAll) return;
    const saving = ORDER.find((name) => controllers.get(name)?.isOpen());
    if (saving) {
      if (saving !== section) {
        showSection(saving);
        onSectionChange(saving);
      }
      setClosingUi(true);
      return;
    }
    finishClose();
  }

  function setOpen(next) {
    if (next === open && !closing) return;
    if (next) {
      if (!isReady()) return; // 조절값을 다 불러오기 전에는 열지 않는다 (최대 약 3초)
      if (closing) return; // 저장이 끝나 닫히기를 기다리는 중
      open = true;
      root.hidden = false;
      for (const controller of controllers.values()) controller.open();
      showSection(section);
      timers.clearInterval(tabTimer);
      tabTimer = timers.setInterval(renderTabs, TAB_REFRESH_MS);
      onOpenChange(true);
      return;
    }
    if (!open) return;
    closing = true;
    closingAll = true;
    for (const controller of controllers.values()) controller.close();
    closingAll = false;
    checkClosed();
  }

  function isReady() {
    return ORDER.every((name) => controllers.has(name));
  }

  root.addEventListener('click', (event) => {
    const button = event.target.closest('button');
    if (!button || !root.contains(button)) return;
    const name = button.dataset.section;
    if (name) {
      select(name);
      return;
    }
    if (button.dataset.action === 'dock') root.dataset.dock = root.dataset.dock === 'top' ? 'bottom' : 'top';
    else if (button.dataset.action === 'close') setOpen(false);
  });

  renderTabs();

  return {
    /**
     * 섹션 모듈을 붙인다 (불러오기가 끝나면). 모듈은 open()·close()·isOpen()·setActive(active)·isDirty()·discardUnsaved()를 가진다.
     * 모듈의 onOpenChange(false)에서 sectionClosed()를 불러야 저장 중 닫기가 끝난다.
     */
    attach(name, controller) {
      controllers.set(name, controller);
      renderTabs();
    },
    sectionClosed: checkClosed,
    isReady,
    isOpen: () => open,
    /** 저장 중인 섹션이 끝나 닫히기를 기다리는 중 */
    isClosing: () => closing,
    getSection: () => section,
    select,
    toggle: () => setOpen(!open),
    open: () => setOpen(true),
    close: () => setOpen(false),
  };
}
