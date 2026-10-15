// 현장·개발 환경에 따라 바꿀 수 있는 값

export const config = Object.freeze({
  // 미리보기 좌우 반전 (거울). 반전은 웹에서만 하고 OBS에서는 하지 않는다.
  mirror: true,

  // 화면·사진 비율 (가로:세로)
  aspectRatio: Object.freeze({ width: 9, height: 16 }),

  // 이 문자열이 라벨에 포함된 카메라를 우선 사용한다 (대소문자 무시). 없으면 기본 카메라.
  preferredCameraLabel: 'OBS Virtual Camera',

  // 카메라 해상도 권장값 (ideal, 강제 아님). 장치가 지원하는 범위에서 가장 가까운 값을 받는다.
  // 현장 최대(4K 세로)로 두어 OBS 출력(FHD~4K 세로)을 그대로 받고, 낮은 기본값으로 떨어지는 것을 막는다.
  idealResolution: Object.freeze({ width: 2160, height: 3840 }),

  // 카메라 준비·끊김·회복 시간 (단위 ms, 사용자 확정 2026-10-15)
  cameraRecovery: Object.freeze({
    retryIntervalMs: 3000, // 실패·끊김 뒤 다시 시도하는 간격
    firstFrameTimeoutMs: 5000, // 스트림을 얻은 뒤 첫 프레임을 기다리는 시간
    stallTimeoutMs: 3000, // 새 프레임이 이 시간 동안 없으면 끊김으로 본다
    staffNoticeMs: 30000, // 준비되지 않은 상태가 이 시간 이상 이어지면 직원 문의 문구로 바꾼다
  }),

  // 얼굴 감지기 (MediaPipe Face Detector short-range). 경로는 저장소 lib/ 기준.
  faceDetection: Object.freeze({
    bundlePath: '/lib/mediapipe/tasks-vision/vision_bundle.mjs',
    wasmPath: '/lib/mediapipe/tasks-vision/wasm',
    modelPath: '/lib/mediapipe/models/blaze_face_short_range.tflite',
    delegates: Object.freeze(['GPU', 'CPU']), // 앞에서부터 시도한다
    // 감지기 자체 기준은 낮게 두고, 신뢰도는 presence.minScore로 거른다 (다시 생성하지 않고 조절하기 위해)
    detectorMinConfidence: 0.3,
    maxFps: 15, // 감지 최대 빈도 (가안)
    inputMaxSize: 640, // 감지 입력 캔버스의 긴 변 최대 크기 px (가안)
  }),

  // 인식 판정 (가안, 2-3에서 운영자 조절). 좌표·크기는 9:16 영역 기준 0~1, 관람객이 보는 화면(반전 후) 기준.
  presence: Object.freeze({
    region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }), // 얼굴 박스 중심이 이 안에 있어야 한다
    minFaceHeight: 0.05, // 얼굴 박스 높이 / 9:16 영역 높이 최소값 (거리 대신)
    minScore: 0.6, // 최소 신뢰도
    presentHoldMs: 500, // "있음"이 이만큼 이어져야 인식됨
    absentGraceMs: 1000, // "없음"이 이만큼 이어져야 인식 안됨
  }),

  // "인식됨 / 인식 안됨" 임시 표시 (최종 디자인 전 기본 UI)
  showPresenceIndicator: true,
});
