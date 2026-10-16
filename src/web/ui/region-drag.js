// 인식 영역 사각형의 마우스 끌기 (이동, 모서리·변 핸들로 크기 조절).
// DOM은 이벤트 대상(element, win)으로만 받는다. Node 테스트: tests/region-drag.test.mjs
//
// 끌기 동안에는 win에서 이동·놓기를 받는다. 포인터가 영역 밖(패널·화면 가장자리)으로 나가도 끊기지 않게 하고,
// 포인터 캡처가 적용되지 않는 환경(검증용 headless Chrome에서 확인)에서도 동작하게 한다.
// 놓기 이벤트를 놓쳐도 끌기가 남지 않게, 창 포커스를 잃거나(blur) 캡처를 잃거나(lostpointercapture)
// 이동 중 주 버튼이 이미 떼어져 있으면 끌기를 끝낸다.

import { moveRegion, resizeRegion } from './presence-settings.js';

/**
 * @param {{ element: EventTarget, win: EventTarget, getRegion: () => object,
 *   toStagePoint: (event: PointerEvent) => { x: number, y: number },
 *   onChange: (region: object) => void, onDragChange?: (dragging: boolean) => void }} options
 */
export function createRegionDrag({ element, win, getRegion, toStagePoint, onChange, onDragChange = () => {} }) {
  let drag = null; // { pointerId, handle, startRegion, startPoint }

  function onMove(event) {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if ((event.buttons & 1) === 0) {
      end();
      return;
    }
    const point = toStagePoint(event);
    const dx = point.x - drag.startPoint.x;
    const dy = point.y - drag.startPoint.y;
    const start = drag.startRegion;
    if (drag.handle === 'move') {
      onChange(moveRegion(start, dx, dy));
      return;
    }
    // 핸들 안쪽 어디를 잡았든 변이 튀지 않게, 잡은 변의 시작 위치에 이동량을 더한다.
    const edge = {
      x: (drag.handle.includes('w') ? start.x : start.x + start.width) + dx,
      y: (drag.handle.includes('n') ? start.y : start.y + start.height) + dy,
    };
    onChange(resizeRegion(start, drag.handle, edge));
  }

  function onPointerEnd(event) {
    if (drag && event.pointerId === drag.pointerId) end();
  }

  function end() {
    if (!drag) return;
    const { pointerId } = drag;
    drag = null;
    win.removeEventListener('pointermove', onMove);
    win.removeEventListener('pointerup', onPointerEnd);
    win.removeEventListener('pointercancel', onPointerEnd);
    win.removeEventListener('blur', end);
    element.removeEventListener('lostpointercapture', onPointerEnd);
    try {
      if (element.hasPointerCapture?.(pointerId)) element.releasePointerCapture(pointerId);
    } catch {
      // 이미 풀린 포인터
    }
    onDragChange(false);
  }

  element.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = {
      pointerId: event.pointerId,
      handle: event.target?.dataset?.handle ?? 'move',
      startRegion: { ...getRegion() },
      startPoint: toStagePoint(event),
    };
    win.addEventListener('pointermove', onMove);
    win.addEventListener('pointerup', onPointerEnd);
    win.addEventListener('pointercancel', onPointerEnd);
    win.addEventListener('blur', end);
    element.addEventListener('lostpointercapture', onPointerEnd);
    try {
      element.setPointerCapture?.(event.pointerId);
    } catch {
      // 캡처가 안 되어도 win 이벤트로 끌기를 이어 간다.
    }
    onDragChange(true);
  });

  return {
    /** 끌기를 강제로 끝낸다 (조절 화면을 닫을 때). */
    end,
    isDragging: () => drag !== null,
  };
}
