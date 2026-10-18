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
    // 생성 전 모델 사전 확인값. tools/vendor-mediapipe.mjs의 기록과 같아야 한다 (test/vision/face-detector.test.mjs가 실제 파일과 비교)
    modelBytes: 229746,
    modelSha256: 'b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f',
    delegates: Object.freeze(['GPU', 'CPU']), // 앞에서부터 시도한다
    // 감지기 자체 기준은 낮게 두고, 신뢰도는 presence.minScore로 거른다 (다시 생성하지 않고 조절하기 위해)
    detectorMinConfidence: 0.3,
    maxFps: 15, // 감지 최대 빈도 (가안)
    inputMaxSize: 640, // 감지 입력 캔버스의 긴 변 최대 크기 px (가안)
    // 감지기 생성 실패, 또는 감지가 계속 실패해 감지기를 버린 뒤 다시 만들기까지의 간격 (가안).
    // 연속 실패마다 두 배(15→30→60→120→240→300초), 감지가 한 번 성공하면 처음으로.
    // 생성은 메인 스레드를 약 1초 막으므로 너무 짧게 두지 않는다. 카메라 재연결·페이지 복귀 때는 바로 다시 만든다(장애 상태 제외).
    detectorRetryMs: 15000,
    detectorRetryMaxMs: 300000,
    // 연속 실패가 이 횟수에 이르면 "장애"로 본다 (가안). WebGL 없음·모델 손상은 첫 실패부터 장애다.
    detectorFaultAfterFailures: 3,
  }),

  // 인식 판정 기본값 (가안). 운영자가 R 조절 화면에서 바꾸고 저장한 값이 있으면 그 값을 쓴다.
  // 좌표·크기는 9:16 영역 기준 0~1, 관람객이 보는 화면(반전 후) 기준.
  presence: Object.freeze({
    region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }), // 얼굴 박스 중심이 이 안에 있어야 한다
    minFaceHeight: 0.05, // 얼굴 박스 높이 / 9:16 영역 높이 최소값 (거리 대신)
    maxFaceHeight: 0.6, // 같은 비율의 최대값. 화면을 덮는 큰 오검출 박스를 거른다
    minScore: 0.7, // 최소 신뢰도 (실제 얼굴 0.95, 가짜 카메라 오검출 최고 0.663 관찰)
    presentHoldMs: 500, // "있음"이 이만큼 이어져야 인식됨
    absentGraceMs: 1000, // "없음"이 이만큼 이어져야 인식 안됨
  }),

  // 인식 표시: 인식되면 관람객 화면 테두리가 따뜻하게 밝아진다 (6-2). 끄면 대기 안내만 보인다
  showPresenceIndicator: true,

  // 자동 촬영 일시정지(P) 중 화면 구석의 작은 운영자 표시 (가안). D 화면에는 항상 보인다.
  showPauseIndicator: true,

  // 운영자 조절값 파일 API (서버 bin/server/serve.ps1 → config/presence.local.json).
  // 시작할 때 이 시간 안에 읽지 못하면 기본값으로 시작한다 (가안).
  settingsFile: Object.freeze({
    url: '/local-api/presence-settings',
    timeoutMs: 3000,
  }),

  // 촬영 한 사이클 시간 (단위 ms, captureTimeoutMs 외 사용자 확정 2026-10-15)
  session: Object.freeze({
    countdownSeconds: 3, // 3·2·1 뒤 한 장
    resultMs: 10000, // 결과 표시 시간. 인쇄 연동 뒤에는 "출력 완료 확인 후" 시간이 된다
    cooldownMs: 5000, // 대기로 돌아온 뒤 시작 요청을 무시하는 시간
    captureTimeoutMs: 5000, // 결과 이미지 만들기(효과·인코딩) 제한 시간. 넘으면 대기로 (가안)
    // 촬영 실패 뒤 자동 시작을 쉬는 시간 (가안). 연속 실패마다 두 배(5→10→20→40→60초), 성공하면 처음으로. S 수동 시작은 막지 않는다.
    failureRetryMs: 5000,
    failureRetryMaxMs: 60000,
  }),

  // 사진 효과 "유화 · 획 (세부 보존)" (사용자 결정 2026-10-16). 출처: https://nau-filter-gallery.vercel.app/ 프리셋 oil2f.
  // 기본값은 사용자가 고른 세팅 그대로다. 범위·정규화는 config/effect-settings.js, 단위는 docs/SYSTEM.md 6절.
  // px 값은 짧은 변 1080px 그림 기준이고, 다른 해상도에서는 비례로 맞춘다 (core/oil-paint.js).
  effect: Object.freeze({
    enabled: true, // false면 효과 없이 원본 미리보기
    strength: 0.1, // 강도 (요철·광택·색 흔들림)
    size: 1.25, // 붓 크기 배율
    boil: 0.1, // 획 다시 그리기: 그림마다 새로 배치하는 획 비율 (0 고정 ~ 1 전부)
    fps: 24, // 초당 그림 수 (스톱모션 느낌). 그림 사이에는 앞 그림을 그대로 보인다
    grade: 1, // 색 보정 (따뜻한 색·약한 대비 압축) 섞는 정도
    // 붓 층 (큰 붓 → 작은 붓): [굵기px, 간격px, 길이px, 색 밉 단계, 세부 문턱, 불투명도(유화에서 안 씀)]
    layers: Object.freeze([
      Object.freeze([36, 15, 84, 3.8, 0, 1]),
      Object.freeze([18, 8, 44, 2.6, 0.02, 1]),
      Object.freeze([8, 4, 20, 1.4, 0.06, 1]),
    ]),
    // 보완 층 (세부 보존): [굵기px, 칸 간격px, 길이px, 기준 이미지 밉 단계, 오차 문턱(0~1 RGB 거리)]
    refine: Object.freeze([3.5, 3, 10, 0.6, 0.22]),
    // 미리보기 처리 해상도 배율. 결과 사진 크기(짧은 변 1080, 4K 입력도 1080x1920) 대비 (사용자 결정 2026-10-16).
    // 1이면 미리보기가 결과와 같은 그림이다. 현장 PC가 느리면 먼저 fps를 낮추고, 그래도 느리면 이 값을 낮춘다.
    previewScale: 1,
  }),

  // 효과 조절값 파일 API (서버 bin/server/serve.ps1 → config/effect.local.json, 5-2).
  // 시작할 때 이 시간 안에 읽지 못하면 기본값으로 계속한다 (가안). 그 전까지는 기본값으로 그린다.
  effectSettingsFile: Object.freeze({
    url: '/local-api/effect-settings',
    timeoutMs: 3000,
  }),

  // 결과 이미지 형식 (가안). 크기는 미리보기에 보이는 9:16 영역의 원본 해상도 그대로다.
  capture: Object.freeze({
    type: 'image/jpeg',
    quality: 0.92,
    // 촬영 직전 이 시간 안에 새 카메라 프레임이 없으면 정지 화면으로 보고 촬영 실패로 처리한다 (가안).
    // 카메라 끊김 판정(stallTimeoutMs 3초)보다 짧아야 그 사이의 정지 화면을 걸러낸다. 30fps면 프레임 간격 약 33ms.
    maxFrameAgeMs: 500,
  }),
});
