# 2026-10-15-02 — 1-1 정적 서버와 9:16 반전 미리보기

브랜치 `stage1-camera-web`. 작업 에이전트(Opus 5.5 high)가 오케스트레이터 지시 범위(1-1)만 진행했다.

## 작업 내용

- `.gitignore`: `settings.ini`, `/logs/`, `*.log`, `Thumbs.db`, `desktop.ini`, `.DS_Store`. `paseo.json`(사용자 파일)은 넣지 않고 커밋하지도 않았다.
- `.gitattributes`: `* text=auto`, `*.ps1`·`*.bat`·`*.cmd`는 `eol=crlf`, `*.wasm`·`*.tflite`·`*.task`와 이미지(png·jpg·jpeg·webp·gif·ico)는 `binary`. 기존 문서는 재정규화 변경이 없었다.
- `bin/server/serve.ps1`: PS 5.1 `Net.HttpListener` 정적 서버. 기본 포트 8765, `http://localhost:<Port>/`에만 바인딩. 경로 매핑·탈출 차단·MIME·`no-store`·Ctrl+C 종료. ASCII 전용.
- `src/web/`: `index.html`, `css/app.css`, `js/main.js`, `js/config.js`, `js/camera.js`. 9:16 영역 가운데 최대 크기 + 검정 여백, `cover` 채우기, `scaleX(-1)` 반전, `D` 키 개발용 정보.
- 문서: `README.md`(개발용 실행 방법), `docs/SYSTEM.md`(구현됨/가안 구분, 정적 서버, 스크립트 인코딩 규칙, 화면 배치, 카메라 오류 종류).

## 결정과 이유

- **기본 포트 8765:** 개발 PC에서 8080은 이미 다른 프로그램이 쓰고 있었다. `-Port`로 바꿀 수 있다.
- **`.gitignore`의 `/logs/`:** `logs/`로 쓰면 `docs/logs/`(작업 로그)까지 무시된다. 루트 실행 로그만 제외하도록 앞에 `/`를 붙였다.
- **경로 탈출 차단을 두 겹으로:** 디코딩 후 위험 문자·점으로 시작/끝나는 경로 조각을 먼저 거절(400)하고, 마지막에 실제 경로가 루트 안인지 다시 확인(403)한다. 숨김 파일(`.git` 등)도 이 규칙으로 막힌다. 실제로는 루트를 벗어나는 URL 일부를 http.sys가 스크립트보다 먼저 403으로 막는다.
- **Ctrl+C 처리:** `GetContext()`는 PowerShell에서 Ctrl+C로 끊기지 않으므로 `GetContextAsync()`를 250ms 단위로 기다리고, `finally`에서 리스너를 닫는다.
- **권한 확인 스트림 재사용:** 라벨이 비어 있어 권한 요청용으로 연 스트림이 고른 장치(OBS 또는 기본 카메라)와 같으면 다시 열지 않는다. 참고 프로젝트는 항상 닫고 다시 열었다.
- **해상도는 권장값(`ideal`) 2160×3840으로 요청 (1-1 보완, 오케스트레이터 결정):** 처음에는 해상도를 지정하지 않았으나, 제약이 없으면 Chrome이 낮은 기본 형식(640×480 등)을 고를 수 있다(참고 프로젝트 `camera.js` 주석에도 같은 기록). 현장은 FHD~4K 세로이고 OBS 출력은 PC 해상도에 맞추므로 현장 최대인 4K 세로를 권장값으로 둔다. Chrome은 지원 범위에서 가장 가까운 값을 고르고 원본보다 키우지 않는다. `exact`·`min`은 장치가 지원하지 않으면 실패하므로 쓰지 않는다. 권한 확인용 스트림에도 같은 권장값을 적용해, 그 스트림을 재사용할 때도 해상도 요청이 빠지지 않게 했다.
- **오류 문구:** `unsupported`·`permission-denied`·`not-found`·`in-use`·`unknown` 종류별로 한 줄 문구만 둔다. 상세 안내는 1-2.
- **`pagehide`에서 스트림 정지는 넣지 않음:** 페이지 종료 시 브라우저가 카메라를 해제하고, bfcache 복원 시 검은 화면이 될 수 있어서다.

## 검증

### 서버 (자동 확인)

`powershell -NoProfile -ExecutionPolicy Bypass -File bin\server\serve.ps1`로 실행 후 `curl.exe`, `Invoke-WebRequest`로 확인했다.

| 요청 | 결과 |
|---|---|
| `/`, `/index.html` | 200 `text/html; charset=utf-8` |
| `/js/main.js`, `/js/camera.js`, `/js/config.js` | 200 `text/javascript; charset=utf-8` |
| `/css/app.css` | 200 `text/css; charset=utf-8` |
| `/nope.js`, `/lib/x.js`, `/lib`, `/js/` | 404 (`lib/` 폴더 없음) |
| `HEAD /` | 200, `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` |
| `POST /` (본문 포함) | 405 |
| `-Port 8800` | 200 |
| `http://127.0.0.1:8765/` | 400 (http.sys, `localhost` 바인딩) |

경로 탈출(`curl.exe --path-as-is`, 원본 URL 그대로 전송) — 모두 차단, 응답에 `AGENTS.md`·`win.ini` 내용 없음:

- http.sys가 먼저 403: `/../AGENTS.md`, `/js/../../AGENTS.md`, `/%2e%2e/AGENTS.md`, `/%2E%2E/AGENTS.md`, `/js/%2e%2e/%2e%2e/AGENTS.md`, `/..%2fAGENTS.md`, `/..%5cAGENTS.md`, `/%5c..%5cAGENTS.md`, `/..\AGENTS.md`, `/js\..\..\AGENTS.md`, `/lib/..%5c..%5cAGENTS.md`
- http.sys가 먼저 400: `/%00`
- 스크립트가 400: `/lib/../AGENTS.md`, `/lib/%2e%2e/AGENTS.md`, `/C:/Windows/win.ini`, `/C%3a/Windows/win.ini`, `/index.html::$DATA`, `/index.html.`, `/.git`, `/...%5cAGENTS.md`
- 404: `/%252e%252e/AGENTS.md`(한 번만 디코딩), `/con`

http.sys에 의존하지 않는 확인: `serve.ps1`의 `Resolve-RequestFile` 함수만 따로 불러 `/../AGENTS.md`, `/%2e%2e/AGENTS.md`, `/..%5cAGENTS.md`, `/..\AGENTS.md`, `/lib/..%2f..%2fAGENTS.md`, `/.. /AGENTS.md`, `/... /AGENTS.md` 등을 직접 넣었고 모두 400이었다.

Ctrl+C: 서버 창에 Ctrl+C를 보내자 `Server stopped.`가 출력되고 프로세스 종료, 포트 해제를 확인했다.

### 화면 (자동 확인, 가짜 카메라)

`%TEMP%`의 임시 프로필로 headless Chrome을 `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`과 함께 띄우고 DevTools Protocol로 뷰포트를 바꿔 확인했다. 가짜 카메라는 640×480 가로 영상이다.

| 뷰포트 | 9:16 영역 (left, top, w×h) | 결과 |
|---|---|---|
| 1920×1080 | 656.25, 0, 607.5×1080 (좌우 여백 같음) | 재생 중, `matrix(-1, 0, 0, 1, 0, 0)`, `cover`, 배경 검정, 오류 문구 없음 |
| 1080×1920 | 0, 0, 1080×1920 | 같음 |

- 스크린샷에서 가짜 카메라의 숫자가 좌우 뒤집혀 보이고, 가로 영상이 9:16 영역에 맞게 좌우가 잘려 채워졌다.
- 장치 선택: `OBS Virtual Camera`가 없어 기본 카메라(`fake_device_0`)로 폴백했다.
- `D` 키: 누르면 개발용 정보 표시(라벨, `video 640x480`, `track 640x480 @ 20fps`, `stage 608x1080 css px` 등), 다시 누르면 숨김. 기본은 숨김.
- 검증 후 Chrome 프로세스, 서버, 임시 프로필·스크립트를 정리했다.
- 위 수치(640×480)는 해상도 제약이 없던 첫 구현 기준이다.

### 해상도 권장값 적용 후 재확인 (자동 확인, 가짜 카메라)

같은 방식(임시 프로필, 가짜 카메라, 1920×1080·1080×1920)으로 다시 확인했다.

- 두 뷰포트 모두 재생 중(재생 시간 증가), `matrix(-1, 0, 0, 1, 0, 0)`, 오류 문구 없음. 9:16 영역 위치·크기는 이전과 같음.
- `D` 화면: `video 2160x2160`, `track 2160x2160 @ 20.0fps (ideal 2160x3840)`.
- 640×480 기본값이 아니라 권장값 쪽으로 요청이 반영됐다. 가짜 카메라 원본은 가로 영상이라 Chrome이 너비 2160에 맞추며 정사각형으로 잘라 줄인 것으로 보인다. 화면에서는 `cover`로 다시 9:16에 맞춰 채워진다.
- 가짜 카메라 화면의 타임스탬프 글자가 크롭 범위 밖이라 이번 스크린샷으로는 반전 글자를 볼 수 없었다. 반전은 computed transform으로 확인했다.

## 미검증·사용자 실측

- 작업 에이전트는 실제 OBS 가상카메라·웹캠을 열지 않았다. 아래 항목은 사용자가 실제 OBS 9:16 가상카메라로 확인했다.
  - `OBS Virtual Camera`가 라벨로 선택되는지 — **사용자 확인: 정상 작동**
  - 권장값 2160×3840 요청에서 OBS 출력 해상도가 그대로 들어오는지 — **사용자 확인: 정상 작동**
  - 반전 방향, 9:16 배치 — **사용자 확인: 정상 작동**
- 권한 거절·카메라 없음·사용 중일 때 문구: `--use-fake-ui-for-media-stream`이 권한 설정보다 우선해 거절 상황을 재현하지 못했다. 1-2에서 확인한다(`2026-10-15-03-stage1-camera-errors.md`).

## 다음 작업

**1-2: 권한·오류·첫 프레임·단절 안내**

- 권한 대기·거절, 카메라 없음, 사용 중, 미지원 환경별 안내 화면 (`camera.js`의 오류 종류 사용)
- 첫 프레임 준비 확인(이전에는 촬영 금지 상태 유지), 트랙 `ended`(OBS 종료 등) 단절 감지와 재시도 방식
- 사용자 실측에서 OBS 해상도가 기대와 다르게 들어오면 권장값 조정 검토
- 1단계 완료 후 GPT-6.1-Sol xhigh 단위 검수
