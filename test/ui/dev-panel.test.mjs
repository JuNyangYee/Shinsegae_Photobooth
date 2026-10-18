// 실행: npm test  (또는 node --test test/ui/dev-panel.test.mjs)
// D 개발 정보 표 (6-3): 줄 나누기·상태 색, textContent가 예전 <pre> 글자와 같은지(확인 도구가 읽는다). 저장 상태 표시.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { devLineTone, renderDevPanel, splitDevLine } from '../../src/web/ui/dev-panel.js';
import { SaveState, loadedSaveState, saveStateOf, showSaveState } from '../../src/web/ui/save-state.js';
import { SettingsSource } from '../../src/web/config/settings-file.js';

// 필요한 만큼만 흉내 낸 DOM: 요소·글자 노드, textContent는 자식 글자를 이어 붙인다
function fakeDocument() {
  const doc = {
    createTextNode: (text) => ({ text, get textContent() { return text; } }),
    createElement(tag) {
      const el = {
        tag, className: '', dataset: {}, children: [], ownerDocument: doc, own: '',
        append(...nodes) { el.children.push(...nodes); },
        replaceChildren(...nodes) { el.children = nodes; el.own = ''; },
        get textContent() { return el.own + el.children.map((c) => c.textContent).join(''); },
        set textContent(value) { el.own = value; el.children = []; },
      };
      return el;
    },
  };
  return doc;
}

const sections = [
  ['카메라', ['status     : ready', 'reason     : -', 'preferred  : "OBS" not found -> default camera']],
  ['효과 · 출력', ['effect     : fallback (webgl2-unavailable) -> camera preview', '  time     : cpu 7.5ms', 'photo-fx   : RAW PHOTO thermal 576x1024 (x)']],
  ['촬영', ['session    : idle (round 0, completed 0)', 'auto       : PAUSED (P) | -']],
];

describe('dev-panel (D)', () => {
  it('줄을 머리말·값으로 나눈다 (첫 ": " 기준, 들여쓴 하위 줄 포함)', () => {
    assert.deepEqual(splitDevLine('status     : ready'), { key: 'status     ', value: 'ready' });
    assert.deepEqual(splitDevLine('  time     : cpu 7.5ms: x'), { key: '  time     ', value: 'cpu 7.5ms: x' });
    assert.deepEqual(splitDevLine('no colon'), { key: '', value: 'no colon' });
  });

  it('상태 색: 정상·주의·오류', () => {
    assert.equal(devLineTone('status     ', 'ready'), 'ok');
    assert.equal(devLineTone('status', 'starting (connecting)'), 'warn');
    assert.equal(devLineTone('status', 'permission-denied'), 'error');
    assert.equal(devLineTone('detector', 'running, health ok'), 'ok');
    assert.equal(devLineTone('detector', 'error, health retrying / model-unavailable'), 'warn');
    assert.equal(devLineTone('detector', 'error, health fault / webgl-unavailable'), 'error');
    assert.equal(devLineTone('guidance', 'staff for 31.0s'), 'error');
    assert.equal(devLineTone('effect', 'running, 1080x1920'), 'ok');
    assert.equal(devLineTone('effect', 'context-lost (x) -> camera preview'), 'error');
    assert.equal(devLineTone('photo-fx', 'RAW PHOTO thermal 576x1024 (x)'), 'warn');
    assert.equal(devLineTone('auto', 'PAUSED (P) | -'), 'warn');
    assert.equal(devLineTone('failures', '0 in a row'), '');
    assert.equal(devLineTone('session', 'idle'), '');
  });

  it('textContent는 예전 글자와 같다: 줄은 \\n, 구역 사이 빈 줄. 구역 제목은 data-title(글자에 없음)', () => {
    const doc = fakeDocument();
    const root = doc.createElement('section');
    renderDevPanel(root, sections);
    const expected = sections.map(([, lines]) => lines.join('\n')).join('\n\n');
    assert.equal(root.textContent, expected);
    const [first, , second] = root.children;
    assert.equal(first.dataset.title, '카메라');
    assert.equal(second.dataset.title, '효과 · 출력');
    const rows = second.children.filter((c) => c.className);
    assert.deepEqual(rows.map((r) => r.className), ['dev-row is-error', 'dev-row is-sub', 'dev-row is-warn']);
    // 다시 그리면 바꿔 넣는다 (쌓이지 않는다)
    renderDevPanel(root, sections);
    assert.equal(root.textContent, expected);
  });
});

describe('save-state (R·E 저장 상태)', () => {
  it('저장 중 > 실패 > 저장 안 된 변경 > 저장됨', () => {
    assert.equal(saveStateOf({ saving: true, failed: true, dirty: true }), SaveState.SAVING);
    assert.equal(saveStateOf({ saving: false, failed: true, dirty: true }), SaveState.FAILED);
    assert.equal(saveStateOf({ saving: false, failed: false, dirty: true }), SaveState.DIRTY);
    assert.equal(saveStateOf({ saving: false, failed: false, dirty: false }), SaveState.SAVED);
  });

  it('바꾸지 않은 상태는 불러온 결과를 따른다: 파일 없음·불러오기 실패·고쳐 씀·파일 (6단계 검수 1)', () => {
    const base = (source, note = '', issues = []) => loadedSaveState({ source, note, issues });
    assert.equal(base(SettingsSource.DEFAULTS, 'no file'), SaveState.DEFAULTS);
    assert.equal(base(SettingsSource.DEFAULTS, 'file is invalid', ['not valid JSON']), SaveState.LOAD_FAILED);
    assert.equal(base(SettingsSource.DEFAULTS, 'file read failed: timeout 3000ms'), SaveState.LOAD_FAILED);
    assert.equal(base(SettingsSource.FILE, '', ['fps: 99 -> 30']), SaveState.ADJUSTED);
    assert.equal(base(SettingsSource.LOCAL_ONLY, 'migration to file failed'), SaveState.ADJUSTED);
    assert.equal(base(SettingsSource.FILE), SaveState.SAVED);
    assert.equal(base(SettingsSource.MIGRATED), SaveState.SAVED);
    assert.equal(base(SettingsSource.SAVED, '', ['old issue']), SaveState.SAVED, '이번 실행에 저장했으면 저장됨');
    assert.equal(saveStateOf({ saving: false, failed: false, dirty: false, base: SaveState.DEFAULTS }), SaveState.DEFAULTS);
    assert.equal(saveStateOf({ saving: false, failed: false, dirty: true, base: SaveState.DEFAULTS }), SaveState.DIRTY);
  });

  it('패널 data-save와 상태 글자를 함께 바꾼다', () => {
    const panel = { dataset: {} };
    const text = { textContent: '' };
    showSaveState(panel, text, SaveState.FAILED);
    assert.equal(panel.dataset.save, 'failed');
    assert.match(text.textContent, /저장 실패/);
  });
});
