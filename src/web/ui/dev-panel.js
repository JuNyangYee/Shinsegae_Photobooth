// 운영자 개발 정보 화면 (D 키) 표현 (6-3). 무엇을 보일지(줄 내용)는 main.js가 정하고, 이 모듈은 구역·표 모양과 상태 색만 맡는다.
// 요소의 textContent는 예전 <pre>와 같은 글자다: 줄은 \n, 구역 사이는 빈 줄. 브라우저 확인 도구가 이 글자를 줄 머리말로 읽는다.
// 구역 제목은 data-title(CSS ::before)로 보여 textContent에 들어가지 않는다. Node 테스트: test/ui/dev-panel.test.mjs

/** "status     : ready" → { key: 'status     ', value: 'ready' }. ': '가 없으면 줄 전체가 값 */
export function splitDevLine(line) {
  const i = line.indexOf(': ');
  return i < 0 ? { key: '', value: line } : { key: line.slice(0, i), value: line.slice(i + 2) };
}

// 줄 머리말 → 값으로 정상(ok)·주의(warn)·오류(error)를 고른다. 없으면 색 없음
const TONES = {
  status: (v) => (v.startsWith('ready') ? 'ok' : v.startsWith('starting') ? 'warn' : 'error'),
  reason: (v) => (v === '-' ? '' : 'warn'),
  permission: (v) => (v === 'granted' ? 'ok' : v === 'denied' ? 'error' : ''),
  preferred: (v) => (v.includes('not found') ? 'warn' : ''),
  webgl: (v) => (v.includes('(software)') ? 'warn' : ''),
  detector: (v) => (v.includes('health ok') ? 'ok' : v.includes('health fault') ? 'error' : 'warn'),
  failure: () => 'error',
  retry: () => 'warn',
  guidance: (v) => (v.startsWith('none') ? 'ok' : v.startsWith('staff') ? 'error' : 'warn'),
  presence: (v) => (v.startsWith('PRESENT') ? 'ok' : ''),
  errors: () => 'error',
  settings: (v) => (v.includes('unsaved') ? 'warn' : ''),
  effect: (v) => (v.startsWith('running') ? 'ok' : v.startsWith('disabled') ? '' : v.startsWith('waiting') ? 'warn' : 'error'),
  values: (v) => (v.includes('unsaved') ? 'warn' : ''),
  'photo-fx': (v) => (v.startsWith('applied') ? 'ok' : v.startsWith('RAW') ? 'warn' : ''),
  print: (v) => (v === '-' ? '' : 'ok'),
  auto: (v) => (v.startsWith('PAUSED') ? 'warn' : ''),
  failures: (v) => (v.startsWith('0 ') ? '' : 'warn'),
};

/** @returns {'ok' | 'warn' | 'error' | ''} */
export function devLineTone(key, value) {
  return TONES[key.trim()]?.(value) ?? '';
}

/**
 * @param {HTMLElement} root  #dev-info
 * @param {Array<[string, string[]]>} sections  [구역 제목, 줄 목록]
 */
export function renderDevPanel(root, sections) {
  const doc = root.ownerDocument;
  const nodes = [];
  sections.forEach(([title, lines], index) => {
    if (index > 0) nodes.push(doc.createTextNode('\n\n'));
    const section = doc.createElement('div');
    section.className = 'dev-section';
    section.dataset.title = title;
    lines.forEach((line, i) => {
      if (i > 0) section.append(doc.createTextNode('\n'));
      const { key, value } = splitDevLine(line);
      const row = doc.createElement('div');
      const tone = devLineTone(key, value);
      row.className = `dev-row${/^\s/.test(key) ? ' is-sub' : ''}${tone ? ` is-${tone}` : ''}`;
      const k = doc.createElement('span');
      k.className = 'dev-key';
      k.textContent = key ? `${key}: ` : '';
      const v = doc.createElement('span');
      v.className = 'dev-val';
      v.textContent = value;
      row.append(k, v);
      section.append(row);
    });
    nodes.push(section);
  });
  root.replaceChildren(...nodes);
}
