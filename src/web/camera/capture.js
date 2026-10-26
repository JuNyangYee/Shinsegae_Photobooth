// 한 장 캡처: 미리보기에 보이는 9:16 영역을 원본 해상도로 잘라 (반전이 켜져 있으면) 좌우 반전하고, 결과 이미지(Object URL)로 만든다.
// 반전 여부는 셔터 순간(프레임을 잡는 순간) getMirror()로 읽는다 (E 화면 "카메라"에서 바뀔 수 있다).
// 이미지는 메모리에만 둔다. 파일·영구 저장소·서버에 저장하지 않는다. 다 쓴 사진은 release()로 정리한다.
// 감열지·회색조 유화 출력이면 사진에 인쇄 데이터(print: 1비트 래스터·PNG)가 함께 붙는다 (6-1·8단계, effect/photo-effect.js).
// 인쇄 연동 때 넘길 데이터다. dots는 화면용 사진이 1비트 점 그림(감열지)이라는 표시로, 결과 화면이 화소 1:1로 놓는 데 쓴다.
// Node 테스트: test/camera/capture.test.mjs

import { computeCoverMapping } from '../core/presence.js';

/**
 * 미리보기(object-fit: cover, 가운데 기준)에 보이는 영상 영역을 영상 픽셀 좌표로 돌려준다.
 * 판정 좌표 변환(computeCoverMapping)과 같은 계산을 쓴다. 영상이 없으면 null.
 */
export function computeCaptureCrop({ videoWidth, videoHeight, stageAspect }) {
  const mapping = computeCoverMapping({ videoWidth, videoHeight, stageAspect, mirror: false });
  if (mapping === null) return null;
  const width = Math.max(1, Math.round(mapping.visibleWidth * videoWidth));
  const height = Math.max(1, Math.round(mapping.visibleHeight * videoHeight));
  return Object.freeze({
    x: Math.round((videoWidth - width) / 2),
    y: Math.round((videoHeight - height) / 2),
    width,
    height,
  });
}

/**
 * 사진 효과 자리. 캡처한 캔버스를 받아 결과로 보일 캔버스를 돌려준다 (기본값은 그대로 통과, 앱은 photo-effect.js).
 * 새 캔버스를 돌려줘도 되며, 캡처 쪽이 둘 다 정리한다. { canvas, type?, quality?, print, dots? }를 돌려주면 그 형식(없으면 기본 형식)으로
 * 인코딩하고 print(인쇄 데이터)·dots(1비트 점 사진)를 사진에 붙인다.
 * signal이 abort되면(촬영 제한 시간 초과·강제 초기화) 하던 일을 멈춘다. 멈추지 않아도 캡처 쪽이 결과를 버리고 정리한다.
 * @param {HTMLCanvasElement} canvas
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function applyPhotoEffect(canvas, { signal } = {}) {
  signal?.throwIfAborted();
  return canvas;
}

function abortError(signal) {
  return signal.reason ?? new DOMException('capture aborted', 'AbortError');
}

/**
 * @param {{ video: HTMLVideoElement, stageAspect: number, getMirror: () => boolean, type: string, quality: number,
 *   maxFrameAgeMs: number, getFrameInfo: () => { at: number | null, count: number },
 *   effect?: typeof applyPhotoEffect,
 *   createCanvas?: () => HTMLCanvasElement, urls?: { createObjectURL: Function, revokeObjectURL: Function },
 *   now?: () => number }} options
 *   getMirror: 지금 좌우 반전 값 (셔터 순간 읽는다). getFrameInfo: 카메라 감시가 받은 마지막 새 프레임 시각(now() 기준)과 누적 수
 */
export function createCapture({
  video, stageAspect, getMirror, type, quality, maxFrameAgeMs, getFrameInfo,
  effect = applyPhotoEffect,
  createCanvas = () => document.createElement('canvas'), urls = URL, now = () => performance.now(),
}) {
  const liveUrls = new Set(); // 아직 revoke하지 않은 결과 이미지
  const liveCanvases = new Set(); // 아직 비우지 않은 캡처 캔버스
  const livePrints = new Set(); // 아직 release하지 않은 사진의 인쇄 데이터 (감열지)
  let pending = 0; // 끝나지 않은 효과·인코딩 작업 수 (취소된 회차의 것 포함)
  let taken = 0;
  let released = 0;
  let last = null;
  let lastError = '';

  function freeCanvas(canvas) {
    // 크기를 0으로 두어 픽셀 버퍼를 바로 놓는다.
    canvas.width = 0;
    canvas.height = 0;
    liveCanvases.delete(canvas);
  }

  // 정지 화면을 사진으로 만들지 않는다. 카메라가 끊김으로 판정하기(약 3초) 전이라도 새 프레임이 없으면 실패다.
  function checkFrameFresh() {
    const { at } = getFrameInfo();
    const age = at === null ? Infinity : now() - at;
    if (age > maxFrameAgeMs) {
      throw new Error(`stale frame: no new camera frame for ${Number.isFinite(age) ? Math.round(age) : '-'}ms`);
    }
  }

  // 호출한 순간의 프레임을 동기로 잡는다.
  function grabFrame() {
    const crop = computeCaptureCrop({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, stageAspect });
    if (crop === null) throw new Error('video has no frame');
    const mirror = Boolean(getMirror());
    const canvas = createCanvas();
    liveCanvases.add(canvas);
    // 만든 직후부터 어느 단계에서 실패해도 캔버스를 비운다.
    try {
      canvas.width = crop.width;
      canvas.height = crop.height;
      const context = canvas.getContext('2d', { alpha: false });
      if (!context) throw new Error('2d context unavailable');
      if (mirror) {
        // 미리보기의 scaleX(-1)과 같은 반전
        context.translate(crop.width, 0);
        context.scale(-1, 1);
      }
      context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    } catch (error) {
      freeCanvas(canvas);
      throw error;
    }
    return { canvas, crop, mirror, source: `${video.videoWidth}x${video.videoHeight}` };
  }

  /**
   * work의 결과를 기다리되, signal이 abort되면 기다리지 않고 바로 실패한다.
   * work 자체는 멈출 수 없으므로 끝날 때까지 pending으로 세고, 늦게 도착한 결과는 onLate로 넘겨 정리한다.
   */
  function untilAborted(work, signal, onLate = () => {}) {
    pending += 1;
    return new Promise((resolve, reject) => {
      let settled = false;
      const onAbort = () => {
        if (settled) return;
        settled = true;
        reject(abortError(signal));
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          pending -= 1;
          signal?.removeEventListener('abort', onAbort);
          if (settled) {
            onLate(value);
            return;
          }
          settled = true;
          resolve(value);
        },
        (error) => {
          pending -= 1;
          signal?.removeEventListener('abort', onAbort);
          if (settled) return;
          settled = true;
          reject(error);
        },
      );
    });
  }

  function encode(canvas, as = type, asQuality = quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), as, asQuality);
    });
  }

  // 효과 단계 결과: 캔버스 하나, 또는 { canvas, type, quality, print }
  const outputCanvas = (result) => (result && typeof result === 'object' && 'canvas' in result ? result.canvas : result);

  async function finish({ canvas, crop, mirror, source }, grabMs, signal) {
    let output = canvas;
    try {
      // 캡처 이미지 → (사진 효과) → 결과 표시
      const produced = await untilAborted(
        Promise.resolve().then(() => effect(canvas, { signal })),
        signal,
        (late) => { const lateCanvas = outputCanvas(late); if (lateCanvas && lateCanvas !== canvas) freeCanvas(lateCanvas); },
      );
      output = outputCanvas(produced);
      const custom = produced !== output ? produced : {};
      const encodeStart = now();
      const blob = await untilAborted(encode(output, custom.type ?? type, custom.quality ?? quality), signal);
      signal?.throwIfAborted();
      const url = urls.createObjectURL(blob);
      liveUrls.add(url);
      const print = custom.print ?? null;
      if (print) livePrints.add(print);
      last = Object.freeze({
        width: output.width,
        height: output.height,
        source,
        crop,
        mirror,
        bytes: blob.size,
        type: blob.type,
        grabMs,
        encodeMs: now() - encodeStart,
      });
      return Object.freeze({ url, width: last.width, height: last.height, print, dots: custom.dots === true });
    } finally {
      // 성공·실패·취소 모두 여기서 바로 비운다. toBlob은 호출할 때 픽셀을 복사하므로 인코딩 중에 비워도 된다.
      freeCanvas(canvas);
      if (output !== canvas) freeCanvas(output);
    }
  }

  return {
    /**
     * 지금 프레임을 동기로 잡고, 결과 이미지 { url, width, height }를 비동기로 돌려준다.
     * 새 프레임이 없거나(정지), 영상이 없거나, 이전 작업이 아직 끝나지 않았으면 바로 예외를 던진다.
     * signal이 abort되면 기다리지 않고 실패하며 캔버스를 바로 비운다.
     * @param {{ signal?: AbortSignal }} [options]
     */
    take({ signal } = {}) {
      try {
        // 취소된 회차의 효과·인코딩이 끝나지 않았으면 새 작업을 쌓지 않는다.
        if (pending > 0) throw new Error(`capture busy: ${pending} previous image job(s) not finished`);
        checkFrameFresh();
        const grabStart = now();
        const frame = grabFrame();
        taken += 1;
        lastError = '';
        const result = finish(frame, now() - grabStart, signal);
        result.catch((error) => { lastError = error?.message ?? String(error); });
        return result;
      } catch (error) {
        lastError = error?.message ?? String(error);
        throw error;
      }
    },
    /** 결과 이미지를 정리한다 (Object URL revoke, 인쇄 데이터 놓기). 여러 번 불러도 한 번만 정리한다. */
    release(photo) {
      if (photo.print) livePrints.delete(photo.print);
      if (!liveUrls.delete(photo.url)) return;
      urls.revokeObjectURL(photo.url);
      released += 1;
    },
    /** D 개발용 화면: 마지막 캡처 크기와 남은 자원 수 */
    getStats: () => ({
      taken, released, liveUrls: liveUrls.size, liveCanvases: liveCanvases.size, livePrints: livePrints.size, pending, last, lastError,
    }),
  };
}
