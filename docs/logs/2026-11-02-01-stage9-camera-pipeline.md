# 2026-11-02-01 — 9-1 카메라 처리 경로 (카메라 설정·변환 하나·파일·장치 선택)

브랜치 `stage9-camera-options`(`master` `5daddf4`에서 분기). 작업 에이전트(Opus 5.5). 병합·push는 오케스트레이터가 한다. 9-2(운영자 화면 통합)는 범위 밖.

## 요청 (사용자 결정 2026-11-02, 오케스트레이터 전달)

- 운영자 옵션을 **카메라 / 카메라 인식 / 필터** 세 섹션으로 나눈다. 카메라 = 미디어파이프가 인식하는 카메라 원본을 고치는 값(선택·해상도·색 보정·반전·위치·회전·확대).
- 카메라 보정·변환은 **전부에 같게**(인식, 필터 미리보기, 원본 미리보기, 촬영 결과, 인쇄 데이터). 운영자 화면은 키 하나로 열고 섹션으로 나누며, 카메라 섹션 조절 중에는 구석에 필터 없는 원본 창 — 둘 다 9-2.
- 9-1: 카메라 설정 모델·파일·API, 변환 하나를 모든 소비자에, 장치·해상도 바꾸면 다시 열기, UI는 최소.

## 결정과 이유

| 항목 | 결정 | 이유 |
|---|---|---|
| 변환 정의 | 원본 → 색 보정 → 원본 가운데 기준 회전(90° 단위 × 미세) → 덮기 배율 × 확대 → **좌우 반전(화면 기준)** → **이동(화면 기준)** → 9:16. 회전 양수 = 화면 시계 방향(CSS와 같음) | 반전을 회전 앞에 두면 90° 회전한 화면에서 반전을 바꿀 때 위아래가 뒤집힌다(`R(90)·M = M·R(-90)`, 결과는 상하 반전). 이동도 화면 기준이라 반전과 관계없이 민 방향으로 움직인다. 요청 문장의 순서("반전·회전·확대·이동")와 다른 점은 이 이유로 정했다 |
| 구현 방식 | **같은 순수 함수의 계수를 소비자마다 쓴다**(`core/camera-view.js`). 한 번 처리한 프레임을 공유하지 않는다 | 공유하려면 매 카메라 프레임을 화면 크기(4K면 2160×3840)로 한 번 더 그려 두어야 해 비용·지연이 생긴다. 효과는 초당 12장, 감지는 15장만 쓰고 원본 미리보기는 효과가 없을 때만 필요하다. 어긋날 위험은 2D·셰이더가 같은 계수만 받게 하고, Node 테스트(같은 원본 점 → 감지 입력·캡처 캔버스·셰이더 uv에서 같은 화면 점, SVG 값·셰이더 uniform = 기준식)와 브라우저 확인(같은 프레임의 2D·셰이더 그림 비교)으로 막는다 |
| 2D 색 보정 | 문서 안 SVG 필터(`feColorMatrix` → `feComponentTransfer` gamma, `color-interpolation-filters="sRGB"`)를 `ctx.filter = url(#…)`로 | CSS 필터 함수(`brightness()` 등)에는 감마가 없고 셰이더와 같은 식이라는 보장이 없다. JS 화소 계산은 감지(360×640)·캡처에는 되지만 원본 미리보기 매 프레임에는 느리다. SVG 두 단계는 식이 명세로 정해져 셰이더 `clamp(M·c + b)^e`와 같다. 값이 바뀌면 새 id로 만든다(같은 url로는 캔버스가 바뀐 필터를 다시 읽는다는 보장이 없다) |
| 색 보정 항목 | 밝기(더함)·대비(0.5 중심)·채도(Rec.709 밝기 쪽)·감마(1/감마)·색온도(빨강 ×1+0.2t, 파랑 ×1−0.2t)·색조(초록 ×1−0.2t). 중립 0·1·1·1·0·0 | 밝기·대비·감마는 효과 출력 단계 레벨과 같은 뜻(운영자가 같은 감각으로 쓴다). 화이트밸런스는 행렬 하나에 넣을 수 있는 대각 이득으로. 범위와 세기(±20%)는 가안 |
| 빈 영역 | 회전·이동으로 카메라 밖이 보이면 **확대를 자동으로 키워 늘 덮는다**(네 모서리가 원본 안에 드는 최소 배율, 닫힌 식) | 검정 칸이 사진·인쇄·감지 입력에 남지 않는다. 요청 확대가 충분하면 그대로. D `transform`에 실제 배율·`auto` |
| 회전 | `rotation` 0·90·180·270 + `rotationFine` −15~15°(0.1) | 90° 단위는 정수 행렬이라 0°·90°에서 오차가 없고, 덮기 배율을 90° 돌린 원본으로 정한다. **OBS 세로 회전을 대체할 수 있다**(실제 가로 웹캠 1920×1080 → 90° → 1080×1920 결과, 아래 검증) |
| 확대·이동 | 확대 1~4(cover 위에 곱함), 이동 −0.5~0.5(화면 폭·높이 대비) | 화면 가운데 기준 확대, 확대한 만큼 이동 여유가 생긴다(여유를 넘으면 자동 확대) |
| 해상도 | `auto`(ideal 2160×3840, **90°·270°면 3840×2160**) + 프리셋 6개(카메라 기준 가로×세로), ideal로만 | 세로 권장값을 가로 카메라에 요청하면 Chrome이 세로로 잘라 줄일 수 있다. 실측(아래): OBS 가상카메라는 다른 비율 프리셋을 그 비율로 잘라 준다 → OBS는 `auto` |
| 감지 입력 | **카메라 처리 경로를 거친 9:16 화면 영역**(360×640)을 그려 넣는다. 감지 박스 = 화면 좌표 | 회전한 카메라에서도 감지기가 똑바로 선 얼굴을 보고, 보이는 그대로(색 보정 포함)를 판정한다. 좌표 변환이 필요 없어 박스·영역·D 겹쳐 그리기가 같은 좌표다. 변환이 없을 때는 예전 cover·반전 계산과 같은 결과(Node 테스트) |
| 원본 미리보기 | `<video>` CSS(`scaleX(-1)`) 대신 캔버스 `#camera-raw`(`raw-preview.js`, 캡처와 같은 2D 그리기) | CSS로는 같은 색 계산을 보장하기 어렵고(`<video>`에 SVG 필터의 성능도 모른다), 같은 함수를 쓰면 원본 미리보기 = 원본 대체 사진이다. 효과가 그리고 있으면 멈춰 비용이 없다. 9-2 원본 창도 이 모듈을 다른 캔버스로 쓴다 |
| 좌우 반전 위치·옮기기 | 효과 설정의 `mirror`를 **카메라 설정으로** 옮긴다. 카메라 파일이 없고 효과 파일에 참·거짓 `mirror`가 있으면 그 값으로 카메라 파일을 만들고(PUT → GET 확인) **효과 파일에서 그 키만 뺀다**. 쓰기 실패면 이번엔 옮긴 값, 효과 파일 그대로(다음에 다시) | 인식 조절값의 `localStorage` 옮기기와 같은 이유: 키를 남겨 두면 카메라 파일을 지워 초기화할 때 옛 반전이 말없이 다시 옮겨진다. 다른 효과 값은 건드리지 않는다. 효과 쪽은 그 키를 읽지 않으므로 빼기만 실패해도 해가 없다 |
| 카메라 회복 설정 위치 | **인식 조절값 파일**(`presence.local.json`의 `cameraRecovery`). 카메라 감시는 함수로 받아 쓸 때마다 읽는다 | 9-2에서 "카메라 인식" 섹션에 보이므로 한 섹션 = 한 파일로 저장·취소·기본값 규칙을 그대로 쓴다. 카메라 파일에 두면 카메라 섹션 저장과 인식 섹션 저장이 한 파일을 나눠 쓰게 된다. 키가 없는 예전 파일은 알리지 않고 기본값(그때는 늘 기본값이었다) |
| 불러오는 때 | 카메라 파일은 **카메라를 열기 전에** 읽는다(최대 3초, 가안) | 장치·해상도 요청이 이 값이라, 기본 장치로 먼저 열었다가 다시 여는 일이 없게 |
| 장치 선택 | 라벨 정확히 같음 → OBS 라벨(포함) → 기본. 있는데 열리지 않으면(다른 프로그램이 사용 중) 대신하지 않고 `unavailable`로 재시도 | `deviceId`는 바뀔 수 있다. 고른 장치가 있는데 다른 장치로 몰래 바꾸면 운영자가 설정 실수를 알기 어렵다(D·"준비 중"으로 드러난다) |
| 다시 열기 | 장치 라벨·해상도 요청이 바뀌면 `setRequest()`로 스트림을 닫고 다시 연다. 진행 중 회차는 기존 "카메라 준비 해제" 규칙 | 새 규칙을 만들지 않는다. 색 보정·반전·확대·미세 회전은 다시 열지 않는다 |
| UI | 9-1에는 화면 항목 없음(파일·API + 새로고침). `E` "카메라"(반전) 묶음은 지웠다 | 통합 화면은 9-2. 임시 항목을 만들면 9-2에서 다시 만든다. 그 사이 반전을 화면에서 못 바꾸는 공백이 있다(아래 남은 문제) |
| 해상도 프리셋 실패 대체 | **넣지 않았다** | 처음에 OBS가 1280×720에서 `NotReadableError`로 실패한다고 보고 "자동 해상도로 다시 열기"를 넣었다가, 진단으로 실패 원인이 다른 장치(OBS가 쓰는 웹캠)였고 OBS는 잘라서 연다는 것을 확인해 되돌렸다(실측 근거 없는 기능) |

## 한 일

- `core/camera-view.js`(새, 순수): `computeCameraView`(화면↔원본 아핀, 덮기·자동 확대, 캡처 크기), `canvasTransform`, `shaderSourceAffine`, `cameraColorMatrix`·`applyCameraColor`(기준식)·`svgColorMatrixValues`·`shaderColorUniforms`, 기하·색 키.
- `config/camera-settings.js`(새): 범위·정규화·저장 형식·`resolutionRequest`(90°면 가로·세로 바꿈)·`sameCameraRequest`·`migrateMirrorFromEffect`. `config.camera` 기본값, `config.cameraSettingsFile`.
- `config/settings-file.js`: `loadInitialCameraSettings`(카메라 파일 → 효과 파일 반전 옮기기 → 기본값), 출처 `effect file`.
- `config/presence-settings.js`·`config.presence.cameraRecovery`(`config.cameraRecovery`에서 옮김): 범위·정규화, 키 없는 예전 파일은 알리지 않음.
- `config/effect-settings.js`·`ui/effect-tuning.js`·`index.html`: `mirror` 제거(조절값 16개), `E` "카메라" 묶음 삭제.
- `bin/server/serve.ps1`: `/local-api/camera-settings` → `config/camera.local.json`(같은 쓰기 검사·원자적 쓰기, ASCII).
- `camera/camera.js`: `pickCamera`(라벨 → OBS → 기본), `findExactLabel`, `trackCapabilities`, `startCamera({ deviceLabel })`. `camera/camera-monitor.js`: `request`·`setRequest()`(다시 열기, 원인 `camera-settings`)·`getRequest()`·`listDevices()`, 상태 `selection`·`capabilities`, 더 우선인 장치가 나타나면 전환, 회복 시간을 함수로.
- `camera/camera-frame.js`(새): 2D 그리기(`draw`)·SVG 필터 관리·`getView` 캐시. `camera/raw-preview.js`(새): 원본 미리보기 캔버스.
- `camera/capture.js`: 같은 2D 그리기, `captureSizeFor`(`computeCaptureCrop` 대체), D `capture`에 회전·배율·`color`·`mirrored`.
- `vision/presence-monitor.js`: 감지 입력 = `drawFrame`으로 그린 9:16 화면 영역(360×640), `STAGE_MAPPING`, `setMirror` → `setCameraGeometry(key)`.
- `effect/oil-shaders.js` `CAMERA_INPUT`(첫 패스 `FS_INPUT_GRAY`·`FS_GRADE`), `oil-renderer.js` `sourceAffine`·`sourceColor`(mat3 uniform), `effect-preview.js` `cameraFrame` 주입·카메라 키로 다시 그리기·`renderStill` 판단.
- `main.js`: `cameraFrame`·`applyCameraSettings()`·`loadCameraSettings()`(읽은 뒤 `camera.start()`)·`updateRawPreview()`, D 카메라 구역 `selected`·`caps`·`transform`·`color`·`raw-view`·`camera-cfg`, `mirror … (camera settings)`, `values`에서 `mirror` 뺌.
- 테스트: 새 `test/core/camera-view.test.mjs`·`test/config/camera-settings.test.mjs`·`test/camera/camera-frame.test.mjs`·`raw-preview.test.mjs`·`camera-monitor.test.mjs`, 기존 캡처·효과·감지·설정·조절 화면 테스트를 새 구조로.
- `tools/browser-check.mjs`: 카메라 파일 백업·복원, 반전 시나리오를 카메라 설정(파일 → 새로고침)으로 + 효과 파일 `mirror` 옮기기, 새 시나리오 "카메라 변환·색 보정"·"카메라 장치·해상도", 원본 미리보기 캔버스 확인, 새 그림 판정을 가로줄 4개로, 시간 초과에 D 상태, `--only`·`--camera-label`.
- 문서: SYSTEM 1절(구성도·폴더·API·확인 도구), 2절, 3절 "카메라 처리 경로"(새)·화면 배치·좌우 반전·회복·다시 열기, 4·5·6절. PROJECT 확정 "카메라 옵션"·좌우 반전·조절값 저장, 가안 "카메라 처리 경로"·"카메라 회복 설정 저장 위치", 단계 9, 남은 일. README `E`·설정 파일.

## 검증

### Node 테스트

`npm test` **492개 모두 통과**(이전 419 + 73, `core-deps` 포함: `core/camera-view.js`가 core 규칙 안). 주요 확인:
- 변환 없음 = 예전 cover·반전(6가지 영상 비율 × 반전, 박스 좌표·보이는 크기), OBS 1080×1920 캔버스 변환이 정확히 단위 행렬, 반전 `[-1, 0, 0, 1, 1080, 0]`.
- 90°(가로 1920×1080이 확대 1로 세로 화면을 덮고 왼쪽 위 → 오른쪽 위), 반전은 회전과 관계없이 `u → 1 − u`, 확대 2·이동, 자동 확대가 최소 배율(5° 회전의 닫힌 식과 같음).
- 같은 점: 7가지 조합에서 원본 점 → 감지 입력(360×640)·캡처 캔버스·셰이더 소스 uv가 같은 화면 점(1e-9).
- 색: 중립 = 단위, 밝기·대비·감마·채도 0·색온도·색조 값, SVG 값과 GLSL 열 우선 행렬이 기준식과 1e-12 안.
- 설정 정규화·저장·해상도 요청·`migrateMirrorFromEffect`, 파일 불러오기·옮기기(성공·쓰기 실패·빼기 실패·초기화 뒤 다시 옮기지 않음·읽기 실패), `cameraRecovery` 정규화.
- 장치 선택·`setRequest`·장치가 나타나면 전환·`listDevices`·회복 시간 함수(가짜 `mediaDevices`, `mock.timers`), `camera-frame` SVG 필터 생성·교체·제거, 원본 미리보기 그리기 조건, 감지 입력 크기·기하 키 재측정, 효과·캡처가 셔터 순간 설정을 쓰는지.

### `npm run check:browser`

| 카메라 | 결과 |
|---|---|
| 가짜 카메라(`fake_device_0`) | **19개 모두 통과**, 약 378초 |
| 실제 `OBS Virtual Camera` 1080×1920 (OBS 실행 중, 가상카메라 켬) | **19개 모두 통과**, 약 388초 |
| 실제 `Logitech StreamCam (046d:0893)` (OBS 끔, `--camera-label` + `--only` 카메라 시나리오 3개 + 외부 요청) | **5개 모두 통과**, 약 100초 |

카메라 시나리오 측정 (이미지는 저장하지 않음. 페이지 안에서 격자·화소 차이로만):

| 항목 | 가짜 (2160² → 1920×1080) | OBS 1080×1920 | StreamCam (→ 1920×1080) |
|---|---|---|---|
| 변환 | 90°+3°, 확대 1.3, 이동 0.05/−0.04, 색 6개 | 0°+3° (세로 카메라라 90° 대신), 같은 나머지 | 90°+3°, 같은 나머지 |
| 2D(앱 SVG 필터) ↔ 기준식, 화소 평균 / 99% | 0.92 / 1 | 0.48 / 1 | 0.37 / 1 |
| 효과 셰이더 입력(`FS_GRADE` uAmt 0) ↔ 2D, 화소 평균 / 99% / 18×32 격자 최대 | 0.31 / 1 / 0.72 | 0.49 / 2 / 0.91 | 0.41 / 2 / 0.78 |
| 미리보기 ↔ 같은 순간 변환한 영상 (변환 전 영상) | 0.97 (0.33) | 0.961 (0.467) | 0.962 (−0.047) |
| 결과 ↔ 셔터 그림 / 변환한 영상 | 1 / 0.867 | 1 / 0.962 | 1 / 0.964 |
| 캡처 | 1080×1920 from 1920×1080 (rotate 93 zoom 1.30, color) | 1080×1920 from 1080×1920 (rotate 3) | 1080×1920 from 1920×1080 (rotate 93) |
| 화면 / 감지 / 효과 (변환 없음) | 60.3fps (60.4) / 12 (13) / 12장 (12) | 60.2 (59.7) / 14 (13) / 12 (12) | 60.3 (59.8) / 13 (5) / 12 (12) |

- 반전(카메라 설정): OBS 켬 미리보기 ↔ 영상 `anti` −0.986, 끔 +0.985, 결과 ↔ 영상 −0.986 / +0.986, 둘 다 `same drawing as preview`. 효과 파일 `mirror: false` → 카메라 파일 없음 → 새로고침: `migrated (mirror off from effect file (removed from effect file))`, 카메라 파일 `mirror false`, 효과 파일에 `mirror` 없음.
- 장치·해상도 (OBS 실행 중): 1280×720 요청 → OBS가 **1080×720**(잘라서)으로 열고 S 정상. `Logitech StreamCam`은 OBS가 소스로 쓰고 있어 `unavailable / in-use / NotReadableError`로 재시도(설계대로), `SpoutCam` 라벨로 전환 → 640×480(`selected device`), 없는 라벨 → `preferred "OBS Virtual Camera"`. StreamCam(OBS 끔): 1280×720 → 1280×720 @30fps.
- 효과 WebGL2 생성 실패: 원본 미리보기 캔버스(1080×1920)가 보이고 0.6초 사이에도 그린 수가 늘어난다(OBS 확인 때 35장째, 가짜 13장째).
- 진단(임시 시나리오, 커밋하지 않음): 빈 페이지에서 장치별 ideal 4가지로 `getUserMedia`. OBS 1280×720 → 1080×720, 2160×3840 → 1080×1920, 1080×1920 → 1080×1920, 1920×1080 → 1080×1080. StreamCam(OBS가 사용 중) 모두 `NotReadableError`.
- 확인 도구에서 고친 것: (1) 셰이더 ↔ 2D 비교에서 `<video>`를 세 번 읽으면 그 사이 프레임이 바뀌어 한 격자가 98 차이 → 같은 `ImageBitmap` 한 장에서 그림. `ImageBitmap`에는 `UNPACK_FLIP_Y`가 듣지 않아 `imageOrientation: 'flipY'` 비트맵으로 올림. (2) 새 그림 판정을 가운데 8×8로 하면 레벨 뒤 가운데가 순수 검정인 OBS 장면에서 새 그림을 못 셈 → 가로줄 4개. (3) 속도를 고정 기준(50fps) 대신 "변환 없는 같은 환경 대비"로: 첫 판(자동 해상도 + 90°)에서 가짜 카메라가 **3840×2160**으로 열려 헤드리스 화면이 47.4fps였다(변환 없는 2160×2160은 60). 실제 쓰임(옆으로 세운 가로 웹캠)에 맞춰 1920×1080 프리셋으로 바꿨다.
- 정리: OBS는 꺼져 있어 `--startvirtualcam --minimize-to-tray --disable-updater --disable-missing-files-check`로 직접 띄웠고, 끝난 뒤 그 프로세스만 종료하고 그 실행이 남긴 `%APPDATA%\obs-studio\.sentinel\run_*` 한 개만 지웠다. 확인 도구가 띄운 서버·Chrome·임시 프로필은 남지 않았고 `config/`는 없던 상태로 돌아갔다.

### 미검증

- **실행 중 바꾸기(새로고침 없이)**: `applyCameraSettings`·`setRequest`(장치·해상도 다시 열기)·`setCameraGeometry`(인식 다시 재기)는 Node 테스트로만 확인했다. 브라우저에서는 화면 항목이 없어 파일 → 새로고침으로만 바꿨다(9-2 화면에서 확인).
- **얼굴 좌표**: 실제 카메라 실행에서 얼굴이 바꾸기 전후 모두 보인 적이 없어(전 1·후 0 또는 전 0·후 1) 반전 `1 − x`·변환 예측 위치 확인은 하지 못했다. 감지 입력 = 화면 영역이라는 구조와 Node 테스트로 대신했다.
- 4K(2160×3840) 원본에서의 비용·원본 미리보기(SVG 필터 2D 그리기) 성능. 가짜 카메라 3840×2160에서 헤드리스 화면 47.4fps를 한 번 봤다(위).
- 인쇄 데이터 방향·색은 결과 그림에서 만들므로 결과로 대신했다.
- 실제 모니터 화면을 눈으로 보지 않았다(headless). D 겹쳐 그리기 박스는 판정 좌표 그대로 그린다.

## 남은 문제

- **9-1 ~ 9-2 사이 공백**: 좌우 반전을 운영자 화면에서 바꿀 수 없다(`E` "카메라" 삭제). 파일·API로는 된다. 9-2와 함께 병합하는 것을 권한다.
- `R` "기본값으로"가 화면에 없는 `cameraRecovery`도 기본값으로 바꾼다(9-2에서 같은 섹션이 되면 자연스럽다).
- OBS 가상카메라에 다른 비율 프리셋을 고르면 잘린 영상(1080×720 등)이 온다. 9-2 화면에 `caps`·실제 크기를 함께 보이고 OBS면 `auto`를 권하는 안내가 필요하다.
- StreamCam을 `auto`로 열면 2160×1296이 오고 그때 감지가 5fps였다(카메라가 그 모드에서 낮은 fps로 보내는 것으로 보이나 fps 자체는 확인하지 않음). 가로 웹캠은 1920×1080 프리셋이 낫다 — 9-2 안내·현장 확인.
- 같은 라벨 장치 둘(같은 모델 웹캠 2대)은 구분하지 못한다(앞의 것).
- 크롭·회전·색 보정을 OBS와 웹 둘 다에서 하면 두 번 적용된다(현장에서 한쪽만, PROJECT 남은 일).
- 색 보정 범위·색온도/색조 세기, 해상도 프리셋 목록, 카메라 파일 읽기 제한 3초, 회복 시간 범위는 가안.

## 9-2에 넘기는 인터페이스

- 설정 바꾸기: `main.js` `applyCameraSettings(settings)` — 정규화된 카메라 설정(`normalizeCameraSettings`). 기하가 바뀌면 인식 재측정, 장치·해상도면 다시 열기. 반환 `{ geometry, color }`.
- 저장: `cameraSettingsFile.write(serializeCameraSettings(settings))`(`/local-api/camera-settings`), 출처 `cameraSettingsInfo`(`source`·`note`·`issues`), 범위 `cameraLimits`·`CAMERA_ROTATIONS`·`RESOLUTION_PRESETS`.
- 장치: `camera.listDevices()` → `{ label, deviceId, current }[]`, `camera.getState()`의 `label`·`selection`·`capabilities`(가로·세로·fps 범위), 실제 크기 `video.videoWidth/Height`·트랙 `getSettings()`.
- 변환 결과: `cameraFrame.getView(w, h)`(실제 배율 `zoom`·`autoZoom`·덮는 원본 화소), 색 `cameraFrame.getColor().identity`.
- 원본 창: `createRawPreview({ canvas, video, camera, frame: cameraFrame, getSize })`를 구석 캔버스로, `setActive(true)` — 효과가 돌아도 함께 그릴 수 있다(비용은 9-2에서 잰다). 감지 박스는 `presence.getDebugSnapshot().faces`(화면 좌표, 원본 창에 그대로 그리면 된다).
- 회복 시간: 인식 설정 `cameraRecovery`(`presenceLimits.cameraRecovery`). 인식 화면에서 `monitor.setSettings`로 바꾸면 카메라 감시·직원 문의 시간이 바로 따른다(함수로 읽음).

## 다음 작업

- 오케스트레이터: 검수 → (9-2와 함께) `master` 병합.
- 9-2: 운영자 화면 통합(키 하나, 카메라·카메라 인식·필터 섹션), 카메라 섹션 항목·저장, 원본 창, 인식 섹션에 회복 시간. 위 남은 문제(반전 공백, OBS 프리셋 안내, `R` 기본값과 회복 시간) 함께.

## 커밋

| 커밋 | 내용 |
|---|---|
| `a517ead` | 카메라 처리 경로·카메라 설정·파일·옮기기·장치 선택/다시 열기·원본 미리보기, Node 테스트 |
| `5166e7e` | 브라우저 확인: 카메라 파일 백업, 반전 시나리오 카메라 설정으로, 변환·색 보정·장치·해상도 시나리오 |
| `2c397d9` | 브라우저 확인: 어두운 장면 새 그림 판정, 사용 중인 장치, 시간 초과 D 상태, `--only`·`--camera-label` |
| (이 커밋) | 문서: SYSTEM·PROJECT·README, 이 로그 |
