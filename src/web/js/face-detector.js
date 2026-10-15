// MediaPipe Face Detector 생성·감지·종료만 맡는다.
// MediaPipe 자료형은 이 파일 밖으로 내보내지 않고, 영상 기준 정규화 박스와 점수만 돌려준다.

/**
 * @typedef {{ x: number, y: number, width: number, height: number, score: number }} DetectedFace
 *   영상(감지 입력) 기준 0~1 정규화, 왼쪽 위 원점, 반전 전
 */

/**
 * delegate 목록을 차례로 시도해 처음 성공한 감지기를 돌려준다. 모두 실패하면 오류를 던진다.
 * bundle은 동적 import로 불러온다. 불러오기에 실패해도 카메라 미리보기 모듈에는 영향이 없다.
 * @param {{ bundlePath: string, wasmPath: string, modelPath: string, delegates: string[], minDetectionConfidence: number }} options
 */
export async function createFaceDetector({ bundlePath, wasmPath, modelPath, delegates, minDetectionConfidence }) {
  const { FilesetResolver, FaceDetector } = await import(bundlePath);
  const fileset = await FilesetResolver.forVisionTasks(wasmPath);
  const failures = [];
  for (const delegate of delegates) {
    try {
      const detector = await FaceDetector.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: modelPath, delegate },
        runningMode: 'VIDEO',
        minDetectionConfidence,
      });
      return wrap(detector, delegate, failures);
    } catch (error) {
      console.warn('[face-detector]', `${delegate} delegate failed`, error);
      failures.push(`${delegate}: ${error?.message ?? error}`);
    }
  }
  throw new Error(`no delegate could be created (${failures.join('; ')})`);
}

function wrap(detector, delegate, failures) {
  let closed = false;
  return Object.freeze({
    delegate,
    /** 앞서 실패한 delegate와 이유 (예: GPU 실패 후 CPU 사용) */
    failures: Object.freeze([...failures]),
    /**
     * @param {HTMLCanvasElement | OffscreenCanvas} image 감지 입력
     * @param {number} timestampMs 호출마다 증가해야 한다
     * @returns {DetectedFace[]}
     */
    detect(image, timestampMs) {
      const { width, height } = image;
      const result = detector.detectForVideo(image, timestampMs);
      return result.detections.flatMap(({ boundingBox, categories }) => (boundingBox ? [{
        x: boundingBox.originX / width,
        y: boundingBox.originY / height,
        width: boundingBox.width / width,
        height: boundingBox.height / height,
        score: categories[0]?.score ?? 0,
      }] : []));
    },
    close() {
      if (closed) return;
      closed = true;
      detector.close();
    },
  });
}
