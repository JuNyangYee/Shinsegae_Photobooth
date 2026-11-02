// 원본 미리보기 (9-1): 효과를 끄거나 쓸 수 없을 때 보이는 화면. 카메라 처리 경로(camera-frame.js draw)를 거친 그림을 캔버스에 그린다.
// 캡처의 원본 대체 사진과 같은 함수로 그리므로 원본 미리보기 = 원본 사진이다 (색 보정·반전·회전·확대·이동 포함).
// 새 카메라 프레임·설정·크기가 바뀐 화면 갱신에만 그리고, 켜져 있을 때(setActive(true))만 돈다. <video>는 그 아래에서 계속 재생된다.
// 9-2의 "필터 없는 원본 창"도 이 모듈을 다른 캔버스로 쓴다. Node 테스트: test/camera/raw-preview.test.mjs

/**
 * @param {{ canvas: HTMLCanvasElement, video: HTMLVideoElement,
 *   camera: { isReady: () => boolean, getFrameInfo: () => { at: number | null, count: number } },
 *   frame: { draw: Function, getView: Function, getSettings: Function },
 *   getSize: (view: object) => { width: number, height: number }, maxFps?: number,
 *   raf?: Function, cancelRaf?: Function, now?: () => number }} options
 *   getSize: 그릴 캔버스 화소 크기 (화면에 보이는 크기와 원본 화소 수 중 작은 쪽을 권장)
 *   maxFps: 새 프레임이 더 자주 와도 이보다 자주 그리지 않는다 (9-2 원본 창. 설정·크기가 바뀐 것은 바로 그린다)
 */
export function createRawPreview({
  canvas, video, camera, frame, getSize, maxFps = Infinity,
  raf = (fn) => requestAnimationFrame(fn), cancelRaf = (id) => cancelAnimationFrame(id), now = () => performance.now(),
}) {
  const minIntervalMs = 1000 / maxFps;
  let context = null;
  let active = false;
  let frameId = null;
  let drawn = null; // 마지막으로 그린 { count, settings, width, height, at }
  let draws = 0;

  function loop() {
    frameId = raf(loop);
    if (!camera.isReady() || !(video.videoWidth > 0 && video.videoHeight > 0)) {
      canvas.hidden = true; // 멈춘 그림이 남지 않게
      drawn = null;
      return;
    }
    const view = frame.getView(video.videoWidth, video.videoHeight);
    const { width, height } = getSize(view);
    const { count } = camera.getFrameInfo();
    const settings = frame.getSettings();
    const t = now();
    if (drawn && drawn.settings === settings && drawn.width === width && drawn.height === height
      && (drawn.count === count || t - drawn.at < minIntervalMs - 1)) return;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context ??= canvas.getContext('2d', { alpha: false });
    frame.draw(context, video, width, height);
    drawn = { count, settings, width, height, at: t };
    draws += 1;
    canvas.hidden = false;
  }

  return {
    /** 켜면 다음 화면 갱신부터 그리고, 끄면 숨기고 멈춘다 */
    setActive(on) {
      if (on === active) return;
      active = on;
      if (on) {
        drawn = null;
        frameId = raf(loop);
      } else {
        if (frameId !== null) cancelRaf(frameId);
        frameId = null;
        canvas.hidden = true;
      }
    },
    isActive: () => active,
    /** D 화면용: 그린 횟수와 크기 */
    getStats: () => ({ active, draws, width: canvas.width, height: canvas.height, shown: !canvas.hidden }),
  };
}
