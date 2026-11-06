// 현장·개발 환경에 따라 바꿀 수 있는 값

export const config = Object.freeze({
  // 화면 비율 (가로:세로). 카메라 처리 경로·감지 입력·효과 미리보기는 이 9:16 화면 영역 전체를 다룬다
  aspectRatio: Object.freeze({ width: 9, height: 16 }),

  // 사진 틀 (IMPRINT에서 도입, 16단계 나무틀 — 가안): 9:16 화면 안에서 실제로 찍히는 직사각형(화면 비율). 16단계부터 사방 inset이다.
  // 16단계: 가로 1/8 ~ 7/8, 세로 3/16 ~ 3/4 = 정확한 3:4 (1080x1920 → x135~945·y360~1440, 810x1080). 좌우 135px 여백에 나무 기둥과 눈 마을이 보인다.
  // 모든 해상도에서 정수: 4K 2160x3840 → 270~1890·720~2880, 인쇄 격자 576x1024 → 열 72~504·줄 192~768(사진 432x576점, 용지 가운데),
  // 감지 360x640 → 45~315·120~480. 결과 사진·인쇄 데이터는 이 틀로 자르고, 인식 영역은 이 틀 안으로 줄여 판정한다 (core/photo-frame.js).
  // 예전 틀(14단계 8/64 ~ 53/64, 화면 폭 전체 4:5)은 left·width 없이 top·height만 있었다.
  // 관람객 화면의 배경·캐릭터 전경(scene)은 화면용 장식이라 사진·인쇄 데이터에 섞이지 않는다
  photoFrame: Object.freeze({ left: 1 / 8, top: 3 / 16, width: 3 / 4, height: 9 / 16 }),

  // 관람객 화면 장면 (14단계, 가안): 생성 이미지 한 장(9:16, 불투명). 창 밖은 DOF 눈 마을·나무 창틀·캐릭터·얼음벽·눈 바닥이 그려져 있고
  // 사진 창 자리(photoFrame 줄)만 단색 크로마 그린(#00FF00)이다. 브라우저가 처음 한 번 창 줄(위아래 keyMarginFrac만큼 여유)에서만
  // 그린을 빼서(core/chroma-key.js) 카메라·결과 위에 덮는다. 창 밖 배경의 초록(나무 등)은 키를 빼지 않는다. 캐릭터가 창에 걸친 부분은
  // 그린이 아니라 그대로 덮는다. 나중의 알파 없는 캐릭터 영상도 같은 9:16 좌표·같은 창 키로 바꿔 끼운다 (docs/SYSTEM.md 3절).
  // 장면을 못 읽으면 창 밖 띠에 배경 사진(style.css, assets/scene/snow-village-bg.png)과 글자만 보인다
  scene: Object.freeze({
    plate: 'assets/scene/snow-frame-plate.png',
    // 그린 우세 d = G − max(R, B): d ≤ low면 불투명, d ≥ high면 투명, 사이는 비례 + 초록 번짐 제거
    key: Object.freeze({ low: 60, high: 140 }),
    keyMarginFrac: 1 / 64,
    // 띠 맞춤 (원본 이미지는 그대로 두고 그릴 때만 옮긴다, 가안): 생성 이미지는 들보 위치를 정확히 맞추지 못하므로, 장면 높이 비율로
    // 위 띠 = 원본 0 ~ topCut 줄을 topShift만큼, 아래 띠 = 원본 bottomCut ~ 끝 줄을 bottomShift만큼 평행이동해 그린다(크기 그대로).
    // 자르는 줄은 전부 그린인 줄이라 캐릭터가 잘리지 않고, 빈 줄은 그린으로 채워 키로 빠진다. 위 들보 중심 → 8/64(240), 아래 들보 중심 → 53/64(1590).
    // 나중의 캐릭터 영상도 같은 규격(같은 넷 값)으로 그린다. null이면 그대로 그린다.
    // 3차 장면(exec-931e0f16, 1920 환산): 전부 그린인 줄 285~1257, 들보 중심 248·1543 → 위 −8, 아래 +47 (눈 바닥은 1710부터)
    layout: Object.freeze({ topCut: 285 / 1920, topShift: -8 / 1920, bottomCut: 1258 / 1920, bottomShift: 47 / 1920 }),
    // 그리는 크기 (15단계): 화면 기준 1080x1920으로 그려 유화 붓 크기가 화면에 맞게 한다 (띠 맞춤도 이 높이 기준 비율 그대로)
    size: Object.freeze({ width: 1080, height: 1920 }),
    // 장면 유화 (15단계, 가안, effect/scene-paint.js): 장면을 읽을 때 한 번 기존 oil2f(기본 제공판 원본 기본값, 출력 끔)로 칠한다.
    // 카메라 효과와 렌더러·설정을 나누지 않는다. settings는 장면에만 얹는 덮어쓰기(가안), seed 고정. false면 칠하지 않는다
    paint: Object.freeze({ seed: 7, settings: Object.freeze({}) }),
  }),

  // 이 문자열이 라벨에 포함된 카메라를 우선 사용한다 (대소문자 무시). 없으면 기본 카메라.
  preferredCameraLabel: 'OBS Virtual Camera',

  // 카메라 해상도 권장값 (ideal, 강제 아님). 장치가 지원하는 범위에서 가장 가까운 값을 받는다.
  // 현장 최대(4K 세로)로 두어 OBS 출력(FHD~4K 세로)을 그대로 받고, 낮은 기본값으로 떨어지는 것을 막는다.
  idealResolution: Object.freeze({ width: 2160, height: 3840 }),

  // 카메라 설정 기본값 (9-1). 카메라 원본 자체를 고치는 값이라 감지·미리보기·결과·인쇄에 모두 같게 적용된다.
  // 운영자가 저장한 값(config/camera.local.json)이 있으면 그 값이다. 범위·정규화는 config/camera-settings.js, 계산은 core/camera-view.js
  camera: Object.freeze({
    deviceLabel: '', // 쓸 카메라의 라벨 (deviceId는 바뀔 수 있어 라벨로 저장). 비우거나 그 라벨이 없으면 preferredCameraLabel 규칙
    resolution: 'auto', // 'auto'(idealResolution) 또는 카메라 기준 '가로x세로' 프리셋. ideal로만 요청한다
    // 색 보정 (중립값)
    brightness: 0,
    contrast: 1,
    saturation: 1,
    gamma: 1,
    temperature: 0,
    tint: 0,
    // 좌우 반전 (거울). 미리보기와 결과 사진 모두. 반전은 웹에서만 하고 OBS에서는 하지 않는다.
    // 2026-10-26부터 효과 조절값의 mirror였고 9-1에서 카메라 설정으로 옮겼다 (예전 effect.local.json 값은 처음 읽을 때 옮긴다)
    mirror: true,
    rotation: 0, // 90° 단위 (0·90·180·270), 화면에서 시계 방향
    rotationFine: 0, // 미세 회전 (도)
    zoom: 1, // cover 크롭 위에 곱하는 확대 (1 이상). 회전·이동으로 빈 영역이 생기면 자동으로 더 키운다
    panX: 0, // 화면 폭 대비 가로 이동
    panY: 0, // 화면 높이 대비 세로 이동
  }),

  // 카메라 조절값 파일 API (서버 bin/server/serve.ps1 → config/camera.local.json, 9-1).
  // 카메라를 열기 전에 읽는다. 이 시간 안에 읽지 못하면 기본값으로 연다 (가안)
  cameraSettingsFile: Object.freeze({
    url: '/local-api/camera-settings',
    timeoutMs: 3000,
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

  // 인식 판정 기본값. 개발 PC에서 인식 범위 조절 화면(당시 R, 9-2부터 E 인식 섹션)으로 조절·저장한 값이다 (사용자 결정 2026-10-19, 로그 2026-10-19-07. 현장에서 다시 조절).
  // 운영자가 E 인식 섹션에서 바꾸고 저장한 값이 있으면 그 값을 쓴다.
  // 좌표·크기는 9:16 영역 기준 0~1, 관람객이 보는 화면(반전 후) 기준.
  presence: Object.freeze({
    region: Object.freeze({ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }), // 얼굴 박스 중심이 이 안에 있어야 한다
    minFaceHeight: 0.185, // 얼굴 박스 높이 / 9:16 영역 높이 최소값 (거리 대신)
    maxFaceHeight: 0.47, // 같은 비율의 최대값. 화면을 덮는 큰 오검출 박스를 거른다
    // 최소 신뢰도 (실제 얼굴 0.95. 가짜 카메라 640x480 오검출 최고 0.663 관찰 — 0.65는 그보다 낮아 영역·얼굴 크기가 함께 거른다)
    minScore: 0.65,
    // 인식·이탈 반응 시간(presentHoldMs·absentGraceMs)과 카메라 회복 시간(cameraRecovery)은 10단계부터 timing (E 시간 섹션)
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

  // 운영자 시간 설정 기본값 (10단계, E "시간" 섹션). 운영자가 저장한 값(config/timing.local.json)이 있으면 그 값이다.
  // 범위·정규화는 config/timing-settings.js. 9단계까지 presentHoldMs·absentGraceMs·cameraRecovery는 인식 조절값 파일에 있었고
  // 처음 읽을 때 옮긴다 (settings-file.js loadInitialTimingSettings)
  timing: Object.freeze({
    // 촬영 흐름 (단위 ms, 카운트다운만 초. 사용자 확정 2026-10-15). 회차가 시작될 때의 값을 그 회차 끝(쿨타임 포함)까지 쓴다
    countdownSeconds: 3, // 3·2·1 뒤 한 장
    resultMs: 10000, // 결과 표시 시간. 인쇄 연동 뒤에는 "출력 완료 확인 후" 시간이 된다
    cooldownMs: 5000, // 대기로 돌아온 뒤 시작 요청을 무시하는 시간
    // 인식·이탈 반응 시간 (사용자 결정 2026-10-27, 로그 2026-10-27-01). 감지 15fps면 약 4프레임
    presentHoldMs: 250, // "있음"이 이만큼 이어져야 인식됨
    absentGraceMs: 250, // "없음"이 이만큼 이어져야 인식 안됨
    // 카메라 준비·끊김·회복 시간 (단위 ms, 사용자 확정 2026-10-15). 카메라 감시·관람객 안내가 쓸 때마다 지금 값을 읽는다
    cameraRecovery: Object.freeze({
      retryIntervalMs: 3000, // 실패·끊김 뒤 다시 시도하는 간격
      firstFrameTimeoutMs: 5000, // 스트림을 얻은 뒤 첫 프레임을 기다리는 시간
      stallTimeoutMs: 3000, // 새 프레임이 이 시간 동안 없으면 끊김으로 본다 (capture.maxFrameAgeMs보다 길어야 한다)
      staffNoticeMs: 30000, // 준비되지 않은 상태가 이 시간 이상 이어지면 직원 문의 문구로 바꾼다
    }),
  }),

  // 시간 설정 파일 API (서버 bin/server/serve.ps1 → config/timing.local.json, 10단계).
  // 시작할 때 이 시간 안에 읽지 못하면 기본값으로 시작한다 (가안)
  timingSettingsFile: Object.freeze({
    url: '/local-api/timing-settings',
    timeoutMs: 3000,
  }),

  // 촬영 한 사이클의 운영자가 만지지 않는 시간 (단위 ms, 가안). 카운트다운·결과·쿨타임은 위 timing
  session: Object.freeze({
    captureTimeoutMs: 5000, // 결과 이미지 만들기(효과·인코딩) 제한 시간. 넘으면 대기로 (가안)
    // 촬영 실패 뒤 자동 시작을 쉬는 시간 (가안). 연속 실패마다 두 배(5→10→20→40→60초), 성공하면 처음으로. S 수동 시작은 막지 않는다.
    failureRetryMs: 5000,
    failureRetryMaxMs: 60000,
  }),

  // 사진 효과 "유화 · 획 (세부 보존)" (사용자 결정 2026-10-16). 출처: https://nau-filter-gallery.vercel.app/ 프리셋 oil2f.
  // 기본값은 사용자가 고른 세팅이다. size·boil·fps·previewScale은 개발 PC에서 E 조절 화면으로 조절·저장한 값으로 바꿨다
  // (사용자 결정 2026-10-19, 로그 2026-10-19-07). strength·size·보완 층 문턱·밝기·대비·감마는 개발 PC 저장값
  // (사용자 결정 2026-10-26, 로그 2026-10-26-01). 범위·정규화는 config/effect-settings.js, 단위는 docs/SYSTEM.md 6절.
  // px 값은 짧은 변 1080px 그림 기준이고, 다른 해상도에서는 비례로 맞춘다 (core/oil-paint.js).
  effect: Object.freeze({
    enabled: true, // false면 효과 없이 원본 미리보기
    strength: 0.3, // 강도 (요철·광택·색 흔들림). 개발 PC 저장값 (사용자 결정 2026-10-26, oil2f·이전 0.1)
    size: 1.3, // 붓 크기 배율. 개발 PC 저장값 (사용자 결정 2026-10-26, oil2f 1.25·이전 1.1)
    // 획 다시 그리기: 그림마다 새로 배치하는 획 비율 (0 고정 ~ 1 전부). oil2f 원본 값 0.1. 7-1에서 0.05로 낮췄다가 8단계에서
    // 0.1로 되돌렸고, 개발 PC 저장값 0.05를 기본값으로 삼았다 (사용자 결정 2026-10-19, 로그 2026-10-19-07).
    // 조절값 파일에 값이 있으면 파일 값을 쓴다
    boil: 0.05,
    fps: 12, // 초당 그림 수 (스톱모션 느낌, oil2f 24). 그림 사이에는 앞 그림을 그대로 보인다
    grade: 1, // 색 보정 (따뜻한 색·약한 대비 압축) 섞는 정도
    // 붓 층 (큰 붓 → 작은 붓): [굵기px, 간격px, 길이px, 색 밉 단계, 세부 문턱, 불투명도(유화에서 안 씀)]
    layers: Object.freeze([
      Object.freeze([36, 15, 84, 3.8, 0, 1]),
      Object.freeze([18, 8, 44, 2.6, 0.02, 1]),
      Object.freeze([8, 4, 20, 1.4, 0.06, 1]),
    ]),
    // 보완 층 (세부 보존): [굵기px, 칸 간격px, 길이px, 기준 이미지 밉 단계, 오차 문턱(0~1 RGB 거리)]
    // 오차 문턱(E의 refineThreshold)은 개발 PC 저장값 0.3 (사용자 결정 2026-10-26, oil2f·이전 0.22). 나머지는 oil2f 그대로
    refine: Object.freeze([3.5, 3, 10, 0.6, 0.3]),
    // 미리보기 처리 해상도 배율. 결과 사진 크기(짧은 변 1080, 4K 입력도 1080x1920) 대비.
    // 1이면 미리보기가 결과와 같은 그림이다. 0.5(사용자 결정 2026-10-19, 이전 1)는 구성(획 위치·방향)은 같고
    // 미리보기가 결과 사진보다 조금 부드럽게 보일 수 있다. 결과 사진은 이 값과 관계없이 1080 기준으로 그린다.
    previewScale: 0.5,
    // ---- 출력 단계 (6-1, 8단계에서 기본값을 바꿈) ----
    // 'gray-oil' 회색조 유화: 카메라 → 단순 흑백(입력 회색조) → 유화(oil2f 그대로) → 회색조 화면. 감열지 인쇄용 1비트 데이터는
    //   결과 사진에서 따로 만들어 메모리에만 둔다 (사용자 결정 2026-10-19, 로그 2026-10-19-06)
    // 'thermal' 감열지(1비트 점, 6-1·7-1. 화면 = 출력물) / 'gray' 컬러 유화를 회색조로 / 'off' 컬러 유화 그대로 — 비교·확인용으로 남겨 둔다
    outputMode: 'gray-oil',
    // 점 방식: 'blue-noise'·'bayer'(문턱값, GPU) / 'atkinson'·'floyd-steinberg'(오차 확산, CPU). 기본값은 측정 뒤 제안 (가안, 로그 2026-10-19-01).
    // 감열지 화면과 회색조 유화의 인쇄 데이터에 쓴다
    dither: 'blue-noise',
    // 밝기·대비·감마(레벨): 회색조 유화·회색조의 화면과 결과 사진, 감열지 화면, 인쇄 데이터에 쓴다 (끔에서는 안 씀).
    // 개발 PC 저장값 (사용자 결정 2026-10-26, 이전 0·1·1 = 그대로)
    brightness: -0.05, // 밝기: 회색조에 더한다 (-0.5~0.5)
    contrast: 1.5, // 대비: 0.5를 중심으로 늘린다 (0.5~2)
    gamma: 1.3, // 감마: 1보다 크면 중간 밝기를 밝게 (0.4~2.5)
    // 용지 폭의 점 수 (8의 배수). 80mm 용지 576점(203dpi), 58mm는 384점. 세로는 9:16이면 576 → 1024
    paperDots: 576,
    // ---- 흑백 스타일 (7-1, 사용자 요구 2026-10-19: "유화 느낌이 나는 흑백"). 감열지 모드에서만 쓴다 (8단계부터 화면 기본값이 아님) ----
    // 'tone' 톤 점(6-1) / 'texture' 질감 강조 점 / 'flow' 흐름 선 / 'stroke' 붓 결 선.
    // 기본값 붓 결 선·선 간격 4점·질감 세기 1은 사용자 결정 (2026-10-19, 비교 그림을 보고 고름. 로그 2026-10-19-04)
    bwStyle: 'stroke',
    bwTexture: 1, // 질감 세기: 획 볼록 조명·국소 대비 (0~2). 톤 점이면 획 명암·붓 결을 섞는 세기 (14단계, 0이면 순수 톤 점)
    lineSpacing: 4, // 선 간격: 흐름 선·붓 결 선의 주기 (인쇄 점, 2~8)
    // ---- 시험 조합 (WISHFUL HOLIDAY 시안, 검토 중. 운영자 E 필터 섹션) ----
    // 유화 켬/끔: 끄면 유화 패스(획·합성)를 건너뛰고 카메라 그림에 출력 단계(회색조·레벨·감열지 점)만 입힌다. 유화 수치는 그대로 둔다
    oil: true,
    // 흑백 방식: "흑백 켬"일 때의 출력 모드 (gray-oil·thermal·gray). 흑백을 끄면 outputMode가 'off'(컬러)가 되고 다시 켜면 이 값
    monoMode: 'gray-oil',
  }),

  // 감열지 화면 표시 색 (6-1). 화면에서만 쓴다. 인쇄 데이터는 순수 1비트(검은 점·흰 바탕)다. [R, G, B] 0~255
  thermalDisplay: Object.freeze({
    paper: Object.freeze([246, 242, 233]), // 약간 따뜻한 흰색
    ink: Object.freeze([26, 26, 30]), // 아주 진한 회색
  }),

  // 효과 조절값 파일 API (서버 bin/server/serve.ps1 → config/effect.local.json, 5-2).
  // 시작할 때 이 시간 안에 읽지 못하면 기본값으로 계속한다 (가안). 그 전까지는 기본값으로 그린다.
  effectSettingsFile: Object.freeze({
    url: '/local-api/effect-settings',
    timeoutMs: 3000,
  }),

  // 결과 이미지 형식 (가안). 회색조 유화·회색조·끔 모드는 이 형식이다(회색조 유화는 1비트 인쇄 데이터를 따로 붙인다, 8단계).
  // 감열지 모드는 무손실 PNG(화면용)와 1비트 인쇄 데이터(PNG·래스터 비트)를 만든다 (6-1, effect/photo-effect.js).
  capture: Object.freeze({
    type: 'image/jpeg',
    quality: 0.92,
    // 촬영 직전 이 시간 안에 새 카메라 프레임이 없으면 정지 화면으로 보고 촬영 실패로 처리한다 (가안).
    // 카메라 끊김 판정(stallTimeoutMs 3초)보다 짧아야 그 사이의 정지 화면을 걸러낸다. 30fps면 프레임 간격 약 33ms.
    maxFrameAgeMs: 500,
  }),
});
