// 한 장 캡처: 미리보기에 보이는 9:16 영역을 원본 해상도로 잘라 좌우 반전하고, 결과 이미지(Object URL)로 만든다.
// 이미지는 메모리에만 둔다. 파일·영구 저장소·서버에 저장하지 않는다. 다 쓴 사진은 release()로 정리한다.
// computeCaptureCrop Node 테스트: tests/capture.test.mjs

import { computeCoverMapping } from './presence.js';

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
 * 사진 효과 자리 (TBD). 캡처한 캔버스를 받아 결과로 보일 캔버스를 돌려준다.
 * 지금은 그대로 통과한다. 새 캔버스를 돌려줘도 되며, 캡처 쪽이 둘 다 정리한다.
 */
export async function applyPhotoEffect(canvas) {
  return canvas;
}

/**
 * @param {{ video: HTMLVideoElement, stageAspect: number, mirror: boolean, type: string, quality: number,
 *   createCanvas?: () => HTMLCanvasElement, urls?: { createObjectURL: Function, revokeObjectURL: Function },
 *   now?: () => number }} options
 */
export function createCapture({
  video, stageAspect, mirror, type, quality,
  createCanvas = () => document.createElement('canvas'), urls = URL, now = () => performance.now(),
}) {
  const liveUrls = new Set(); // 아직 revoke하지 않은 결과 이미지
  const liveCanvases = new Set(); // 아직 비우지 않은 캡처 캔버스
  let taken = 0;
  let released = 0;
  let last = null;

  function freeCanvas(canvas) {
    // 크기를 0으로 두어 픽셀 버퍼를 바로 놓는다.
    canvas.width = 0;
    canvas.height = 0;
    liveCanvases.delete(canvas);
  }

  // 호출한 순간의 프레임을 동기로 잡는다.
  function grabFrame() {
    const crop = computeCaptureCrop({ videoWidth: video.videoWidth, videoHeight: video.videoHeight, stageAspect });
    if (crop === null) throw new Error('video has no frame');
    const canvas = createCanvas();
    liveCanvases.add(canvas);
    canvas.width = crop.width;
    canvas.height = crop.height;
    const context = canvas.getContext('2d', { alpha: false });
    if (mirror) {
      // 미리보기의 scaleX(-1)과 같은 반전
      context.translate(crop.width, 0);
      context.scale(-1, 1);
    }
    context.drawImage(video, crop.x, crop.y, crop.width, crop.height, 0, 0, crop.width, crop.height);
    return { canvas, crop, source: `${video.videoWidth}x${video.videoHeight}` };
  }

  function encode(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))), type, quality);
    });
  }

  async function finish({ canvas, crop, source }, grabMs) {
    let output = canvas;
    try {
      // 캡처 이미지 → (사진 효과) → 결과 표시
      output = await applyPhotoEffect(canvas);
      const encodeStart = now();
      const blob = await encode(output);
      const url = urls.createObjectURL(blob);
      liveUrls.add(url);
      last = Object.freeze({
        width: output.width,
        height: output.height,
        source,
        crop,
        bytes: blob.size,
        type: blob.type,
        grabMs,
        encodeMs: now() - encodeStart,
      });
      return Object.freeze({ url, width: last.width, height: last.height });
    } finally {
      freeCanvas(canvas);
      if (output !== canvas) freeCanvas(output);
    }
  }

  return {
    /**
     * 지금 프레임을 동기로 잡고, 결과 이미지 { url, width, height }를 비동기로 돌려준다.
     * 영상이 없으면 바로 예외를 던진다.
     */
    take() {
      const grabStart = now();
      const frame = grabFrame();
      taken += 1;
      return finish(frame, now() - grabStart);
    },
    /** 결과 이미지를 정리한다 (Object URL revoke). 여러 번 불러도 한 번만 정리한다. */
    release(photo) {
      if (!liveUrls.delete(photo.url)) return;
      urls.revokeObjectURL(photo.url);
      released += 1;
    },
    /** D 개발용 화면: 마지막 캡처 크기와 남은 자원 수 */
    getStats: () => ({ taken, released, liveUrls: liveUrls.size, liveCanvases: liveCanvases.size, last }),
  };
}
