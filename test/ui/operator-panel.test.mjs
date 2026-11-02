// 실행: npm test
// 운영자 조절 화면 (9-2, operator-panel.js): 키 하나로 열기, 섹션 셋, 닫을 때 섹션마다 되돌리기, 저장 중 닫기, 섹션 버튼의 저장 상태 점.
// 섹션 모듈은 흉내(open·close·isOpen·setActive)이고, 실제 섹션 모듈의 저장 규칙은 각 섹션 테스트가 본다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { PanelSection, createOperatorPanel, showsPresenceEditing, showsRawWindow } from '../../src/web/ui/operator-panel.js';

function fakeElement(extra = {}) {
  const listeners = new Map();
  return {
    hidden: true, disabled: false, dataset: {}, attrs: {},
    classList: { values: new Set(), toggle(name, on) { if (on) this.values.add(name); else this.values.delete(name); } },
    setAttribute(name, value) { this.attrs[name] = value; },
    addEventListener: (type, fn) => listeners.set(type, fn),
    fire: (type, event) => listeners.get(type)?.(event),
    ...extra,
  };
}

// 섹션 모듈 흉내: saving이면 close()가 미뤄지고, finishSave()에서 닫힘을 알린다
function fakeSection(name, panel) {
  const s = {
    name, opened: 0, closed: 0, active: false, on: false, saving: false, pendingClose: false,
    isOpen: () => s.on,
    open() { s.on = true; s.opened += 1; },
    close() {
      if (!s.on) return;
      if (s.saving) { s.pendingClose = true; return; }
      s.on = false; s.closed += 1; panel().sectionClosed();
    },
    setActive(on) { s.active = on; },
    finishSave() { s.saving = false; if (s.pendingClose) { s.pendingClose = false; s.close(); } },
  };
  return s;
}

function setup({ attach = true } = {}) {
  const sections = new Map(Object.values(PanelSection).map((name) => [name, fakeElement()]));
  const tabs = new Map(Object.values(PanelSection).map((name) => [name, fakeElement({ dataset: { section: name } })]));
  const root = fakeElement({
    dataset: { dock: 'bottom' },
    querySelector(selector) {
      const m = /data-section(-panel)?="(\w+)"/.exec(selector);
      return m[1] ? sections.get(m[2]) : tabs.get(m[2]);
    },
    contains: () => true,
  });
  const intervals = [];
  const events = [];
  const panel = createOperatorPanel({
    root,
    onOpenChange: (open) => events.push(['open', open]),
    onSectionChange: (name) => events.push(['section', name]),
    timers: { setInterval: (fn) => { intervals.push(fn); return intervals.length; }, clearInterval: () => {} },
  });
  const controllers = new Map(Object.values(PanelSection).map((name) => [name, fakeSection(name, () => panel)]));
  if (attach) for (const [name, c] of controllers) panel.attach(name, c);
  const click = (button) => root.fire('click', { target: { closest: () => button } });
  return { panel, root, sections, tabs, controllers, events, click, refreshTabs: () => intervals.at(-1)?.() };
}

describe('operator-panel: 열기·섹션', () => {
  it('세 섹션이 다 붙기 전에는 열리지 않는다 (조절값 불러오는 중)', () => {
    const t = setup({ attach: false });
    t.panel.toggle();
    assert.equal(t.panel.isOpen(), false);
    assert.equal(t.tabs.get('camera').disabled, true);
    t.panel.attach('camera', t.controllers.get('camera'));
    t.panel.attach('presence', t.controllers.get('presence'));
    t.panel.toggle();
    assert.equal(t.panel.isOpen(), false);
    t.panel.attach('effect', t.controllers.get('effect'));
    t.panel.toggle();
    assert.equal(t.panel.isOpen(), true);
  });

  it('열면 모든 섹션이 열리고, 처음엔 카메라 섹션 하나만 보인다(그 섹션만 active)', () => {
    const t = setup();
    t.panel.open();
    assert.equal(t.root.hidden, false);
    assert.deepEqual([...t.controllers.values()].map((c) => [c.on, c.active]), [[true, true], [true, false], [true, false]]);
    assert.deepEqual([...t.sections.values()].map((el) => el.hidden), [false, true, true]);
    assert.equal(t.tabs.get('camera').attrs['aria-selected'], 'true');
    assert.deepEqual(t.events, [['open', true]]);
  });

  it('섹션 버튼을 누르면 그 섹션만 보이고 알린다. 닫았다 다시 열면 마지막 섹션 (저장하지 않으므로 새로고침하면 카메라부터)', () => {
    const t = setup();
    t.panel.open();
    t.click(t.tabs.get('presence'));
    assert.equal(t.panel.getSection(), 'presence');
    assert.deepEqual([...t.sections.values()].map((el) => el.hidden), [true, false, true]);
    assert.deepEqual([...t.controllers.values()].map((c) => c.active), [false, true, false]);
    assert.deepEqual(t.events.at(-1), ['section', 'presence']);
    t.panel.toggle();
    assert.deepEqual([...t.controllers.values()].map((c) => c.active), [false, false, false], '닫으면 어느 섹션도 active 아님');
    assert.equal(t.sections.get('presence').hidden, true);
    t.panel.toggle();
    assert.equal(t.panel.getSection(), 'presence');
    assert.equal(t.sections.get('presence').hidden, false);
  });

  it('위·아래 버튼은 data-dock을 바꾸고, 닫기 버튼은 닫는다', () => {
    const t = setup();
    t.panel.open();
    t.click({ dataset: { action: 'dock' } });
    assert.equal(t.root.dataset.dock, 'top');
    t.click({ dataset: { action: 'close' } });
    assert.equal(t.panel.isOpen(), false);
  });
});

describe('operator-panel: 닫기 (섹션마다 되돌리기)', () => {
  it('닫으면 모든 섹션의 close()(저장하지 않은 변경을 되돌림)를 부르고 숨긴다', () => {
    const t = setup();
    t.panel.open();
    t.panel.close();
    assert.equal(t.root.hidden, true);
    assert.deepEqual([...t.controllers.values()].map((c) => c.closed), [1, 1, 1]);
    assert.deepEqual(t.events.at(-1), ['open', false]);
  });

  it('저장 중인 섹션이 있으면 그 섹션을 보이고 기다렸다가, 저장이 끝나 그 섹션이 닫히면 패널을 닫는다', () => {
    const t = setup();
    t.panel.open();
    const effect = t.controllers.get('effect');
    effect.saving = true;
    t.panel.close();
    assert.equal(t.panel.isOpen(), true, '아직 열림');
    assert.equal(t.panel.getSection(), 'effect', '저장 중인 섹션을 보인다');
    assert.deepEqual([t.controllers.get('camera').on, t.controllers.get('presence').on], [false, false], '다른 섹션은 이미 되돌리고 닫힘');
    effect.finishSave();
    assert.equal(t.panel.isOpen(), false);
    assert.equal(t.root.hidden, true);
    assert.deepEqual(t.events.filter(([k]) => k === 'open'), [['open', true], ['open', false]]);
  });
});

describe('operator-panel: 섹션 버튼의 저장 상태 점', () => {
  it('섹션 요소의 data-save(save-state.js)를 버튼에 옮긴다 (열려 있는 동안 주기적으로)', () => {
    const t = setup();
    t.panel.open();
    t.sections.get('presence').dataset.save = 'dirty';
    t.refreshTabs();
    assert.equal(t.tabs.get('presence').dataset.save, 'dirty');
    assert.equal(t.tabs.get('camera').classList.values.has('is-active'), true);
  });
});

describe('operator-panel: 원본 창·영역 편집 표시 조건', () => {
  it('원본 창은 패널이 열려 있고 카메라·인식 섹션일 때만 (필터 섹션·닫힘이면 그리지 않는다)', () => {
    assert.equal(showsRawWindow({ open: true, section: 'camera' }), true);
    assert.equal(showsRawWindow({ open: true, section: 'presence' }), true);
    assert.equal(showsRawWindow({ open: true, section: 'effect' }), false);
    assert.equal(showsRawWindow({ open: false, section: 'camera' }), false);
  });
  it('영역 편집 층·얼굴 크기 가이드는 인식 섹션이 보일 때만', () => {
    assert.equal(showsPresenceEditing({ open: true, section: 'presence' }), true);
    assert.equal(showsPresenceEditing({ open: true, section: 'camera' }), false);
    assert.equal(showsPresenceEditing({ open: false, section: 'presence' }), false);
  });
});

describe('운영자 화면 마크업·단축키 (9-2): 패널 하나, R 없음', () => {
  const html = readFileSync(new URL('../../src/web/index.html', import.meta.url), 'utf8');
  const main = readFileSync(new URL('../../src/web/main.js', import.meta.url), 'utf8');
  it('#operator-panel 안에 섹션 버튼 셋과 섹션 셋(확인 도구가 쓰는 id), 카메라 섹션에 OBS 중복 적용 주의', () => {
    const panel = html.slice(html.indexOf('<section id="operator-panel"'), html.indexOf('<figure id="raw-window"'));
    for (const name of ['camera', 'presence', 'effect']) assert.ok(panel.includes(`data-section="${name}"`), name);
    for (const id of ['camera-panel', 'tuning-panel', 'effect-panel']) assert.ok(panel.includes(`id="${id}"`), id);
    assert.match(panel, /OBS 보정과 중복 적용 주의/);
    assert.equal((html.match(/data-action="save"/g) ?? []).length, 3, '섹션마다 저장 버튼');
  });
  it('R 키·R 패널이 없다 (E 하나)', () => {
    assert.ok(!/KeyR/.test(main));
    assert.ok(!/R·Esc/.test(html));
    assert.match(main, /operatorPanel: 'KeyE'/);
  });
});
