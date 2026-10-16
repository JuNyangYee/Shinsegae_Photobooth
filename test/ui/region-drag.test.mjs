// 실행: npm test
// DOM 대신 Node의 EventTarget으로 영역 사각형(element)과 창(win)을 흉내 낸다.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createRegionDrag } from '../../src/web/ui/region-drag.js';

const SIZE = 1000; // 9:16 영역을 1000x1000 px로 가정 (좌표 → 0~1)

function pointer(type, { x = 0, y = 0, buttons = 1, button = 0, pointerId = 1 } = {}) {
  const event = new Event(type);
  Object.assign(event, { clientX: x, clientY: y, buttons, button, pointerId });
  return event;
}

// win에 붙은 리스너 수를 센다 (해제 확인용)
function countingTarget() {
  const target = new EventTarget();
  const counts = new Map();
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  target.addEventListener = (type, fn, options) => { counts.set(type, (counts.get(type) ?? 0) + 1); add(type, fn, options); };
  target.removeEventListener = (type, fn, options) => { counts.set(type, (counts.get(type) ?? 0) - 1); remove(type, fn, options); };
  target.active = () => [...counts.entries()].filter(([, n]) => n > 0).map(([type]) => type);
  return target;
}

function setup() {
  const element = countingTarget();
  const win = countingTarget();
  let region = { x: 0.2, y: 0.2, width: 0.4, height: 0.4 };
  const dragging = [];
  const drag = createRegionDrag({
    element,
    win,
    getRegion: () => region,
    toStagePoint: (event) => ({ x: event.clientX / SIZE, y: event.clientY / SIZE }),
    onChange: (next) => { region = next; },
    onDragChange: (value) => dragging.push(value),
  });
  return { element, win, drag, dragging, region: () => region };
}

describe('createRegionDrag', () => {
  it('끌면 영역이 이동하고, 놓으면 끝나며 창 리스너를 모두 해제한다', () => {
    const t = setup();
    t.element.dispatchEvent(pointer('pointerdown', { x: 400, y: 400 }));
    assert.equal(t.drag.isDragging(), true);
    t.win.dispatchEvent(pointer('pointermove', { x: 500, y: 450 }));
    assert.deepEqual(t.region(), { x: 0.3, y: 0.25, width: 0.4, height: 0.4 });
    t.win.dispatchEvent(pointer('pointerup', { x: 500, y: 450, buttons: 0 }));
    assert.equal(t.drag.isDragging(), false);
    assert.deepEqual(t.win.active(), []);
    assert.deepEqual(t.element.active(), ['pointerdown']);
    assert.deepEqual(t.dragging, [true, false]);
  });

  it('창 포커스를 잃으면(blur) 끝나고, 그 뒤 버튼을 뗀 채 움직여도 영역이 바뀌지 않는다', () => {
    const t = setup();
    t.element.dispatchEvent(pointer('pointerdown', { x: 400, y: 400 }));
    t.win.dispatchEvent(pointer('pointermove', { x: 450, y: 400 }));
    const before = t.region();
    t.win.dispatchEvent(new Event('blur')); // 놓기 이벤트는 오지 않음
    assert.equal(t.drag.isDragging(), false);
    assert.deepEqual(t.win.active(), []);
    t.win.dispatchEvent(pointer('pointermove', { x: 900, y: 900, buttons: 0 }));
    t.win.dispatchEvent(pointer('pointermove', { x: 100, y: 100, buttons: 1 }));
    assert.deepEqual(t.region(), before);
  });

  it('포인터 캡처를 잃으면(lostpointercapture) 끝나고, 그 뒤 움직여도 영역이 바뀌지 않는다', () => {
    const t = setup();
    t.element.dispatchEvent(pointer('pointerdown', { x: 400, y: 400 }));
    t.win.dispatchEvent(pointer('pointermove', { x: 420, y: 420 }));
    const before = t.region();
    t.element.dispatchEvent(pointer('lostpointercapture', { buttons: 0 }));
    assert.equal(t.drag.isDragging(), false);
    assert.deepEqual(t.win.active(), []);
    assert.deepEqual(t.element.active(), ['pointerdown']);
    t.win.dispatchEvent(pointer('pointermove', { x: 900, y: 900, buttons: 0 }));
    assert.deepEqual(t.region(), before);
  });

  it('놓기 이벤트를 놓쳐도, 이동 중 주 버튼이 떼어져 있으면 영역을 바꾸지 않고 끝낸다', () => {
    const t = setup();
    t.element.dispatchEvent(pointer('pointerdown', { x: 400, y: 400 }));
    t.win.dispatchEvent(pointer('pointermove', { x: 430, y: 400 }));
    const before = t.region();
    t.win.dispatchEvent(pointer('pointermove', { x: 900, y: 900, buttons: 0 }));
    assert.deepEqual(t.region(), before);
    assert.equal(t.drag.isDragging(), false);
    assert.deepEqual(t.win.active(), []);
  });

  it('다른 포인터의 이벤트와 주 버튼이 아닌 누름은 무시한다', () => {
    const t = setup();
    t.element.dispatchEvent(pointer('pointerdown', { x: 400, y: 400, button: 2 }));
    assert.equal(t.drag.isDragging(), false);
    t.element.dispatchEvent(pointer('pointerdown', { x: 400, y: 400, pointerId: 1 }));
    t.win.dispatchEvent(pointer('pointermove', { x: 900, y: 900, pointerId: 2 }));
    t.win.dispatchEvent(pointer('pointerup', { pointerId: 2, buttons: 0 }));
    assert.equal(t.drag.isDragging(), true);
    assert.deepEqual(t.region(), { x: 0.2, y: 0.2, width: 0.4, height: 0.4 });
    t.drag.end(); // 조절 화면을 닫을 때
    assert.equal(t.drag.isDragging(), false);
    assert.deepEqual(t.win.active(), []);
  });
});
