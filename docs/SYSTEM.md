# SYSTEM — 시스템 구조와 규칙

> 지금 시스템이 어떻게 동작하는지 적는다. 결정 경위·측정값·검수 기록은 [logs/](logs/)에 있고 근거가 필요한 곳에 링크했다. 기획·결정 현황은 [PROJECT.md](PROJECT.md). 인쇄 연동은 아직 없다("(이후)"로 표시).

**목차**

1. 전체 구성 — 구성도, 폴더 구성, 정적 서버, 조절값 파일 API, CSP, 스크립트 인코딩, 현장 실행 스크립트, 브라우저 확인 도구
2. 코드 책임 구분 — 모듈 경계, 폴더 규칙, 반복 오류 로그 제한
3. 카메라와 영상 — OBS 가상카메라, 카메라 처리 경로(장치·해상도·색 보정·반전·회전·확대·이동), 화면 배치(사진 틀), 관람객 화면(WISHFUL HOLIDAY, 서체, 카메라 없는 데모), 좌우 반전, 권한, 카메라 상태와 자동 회복
4. 촬영 상태 — 촬영 한 사이클, 실패와 취소 경계, 시간 설정(E 시간 섹션), 운영자 단축키, 운영자 화면, 자동 시작과 이탈 취소, 출력 연동 시 참고 흐름
5. 촬영 시작 인식 — 얼굴 감지와 인식 상태, 감지기 상태와 장애 안내, 설정값, 인식 범위 조절, 다인원과 성능, MediaPipe 로컬 라이브러리
6. 사진 처리 — 캡처와 결과 이미지(사진 틀·인쇄 쪽), 사진 효과(유화 · 획), 시험 조합(유화·흑백 켬/끔, WISHFUL 시안), 회색조 유화, 출력 단계(감열지 흑백), 흑백 스타일
7. 참고 자료

## 1. 전체 구성

```text
웹캠 ──▶ OBS (9:16 크롭·회전·보정, 9-1부터 웹에서도 가능) ──▶ OBS 가상카메라 (또는 웹캠 직접)
                                              │ getUserMedia() (장치·해상도: 카메라 설정)
로컬 정적 서버 (localhost) ──▶ 같은 PC 브라우저 (세로 9:16 전체화면)
  <video> ─▶ 카메라 처리 경로 (색 보정 → 반전·회전·확대·이동 → 9:16, 설정 하나·계산 하나)
             ├─▶ 효과 캔버스 (WebGL2 첫 패스: 회색조 → 유화 → 출력 단계. 실패하면 원본 미리보기 캔버스)
             └─▶ 얼굴 감지 (MediaPipe, 9:16 화면 영역 그대로) ─▶ 인식 상태 ─┐
                                                    키보드 S·X·P ────┤
                                                                      ▼
  촬영 진행 (상태 기계) ─▶ 캡처(카메라 처리 경로) ─▶ 결과 사진(셔터 순간 미리보기와 같은 그림) + 인쇄용 1비트 ─▶ 결과 화면
                                                                     (이후) ─▶ 로컬 인쇄 서비스
```

- 서버는 파일 제공·조절값 API·명시적 필터 다운로드만 맡고, 촬영 진행 상태는 브라우저 안에서 관리한다. WebSocket·게임 서버·원격 제어는 없다. `file://`로 열지 않는다(카메라 권한·WASM 로딩이 막힌다).
- 이전 프로젝트 PickPod_FaceReading의 로컬 실행 구조에서 최소 뼈대(bat → PowerShell, `settings.ini`, 정적 서버, OBS·Chrome 실행, 시작 프로그램 바로가기, 저장소 안 MediaPipe, 빌드 없는 ES 모듈)만 이 저장소에 새로 작성했다. 참고 저장소 경로에 의존하지 않는다. Git 자동 업데이트, NAS·AI·결제·Firebase, 워치독·자동 재시작, 야간 스케줄, 지점 인증, 다중 실행 모드·레인, 보정용 패널, 단일 거대 `main.js`는 가져오지 않았다.

### 폴더 구성

```text
Launch.bat · Shutdown.bat · Setup-Startup.bat   현장 실행·종료·시작 프로그램 등록 → bin/launch.ps1 · shutdown.ps1 · setup-startup.ps1
settings.example.ini        현장 설정 예시. settings.ini는 여기서 만들어지고 Git 제외
config/*.local.json         운영자 조절값 파일(E 섹션마다 하나: camera·presence·timing·effect·filter). 서버 API만 쓴다. Git 제외. src/web/config/와 다른 폴더
bin/common.ps1              실행 스크립트 공용 (로그, 설정, 프로그램 탐색, 프로세스 식별·종료)
bin/server/serve.ps1        정적 서버, 조절값 파일 API · filter-api.ps1(수동 필터 갱신)
src/web/                    index.html(진입점 /) · main.js(화면 조립·단축키·D 정보·연결) · style.css
  assets/fonts/             서체 부분 집합과 OFL 라이선스 (3절 "서체")
  config/   config.js(바꿀 수 있는 값) · presence-settings.js · effect-settings.js · camera-settings.js · timing-settings.js(검증·정규화·저장 형식)
            settings-file.js(조절값 파일 API 클라이언트·불러오기 순서) · guest-text.js(관람객 문구)
  core/     session.js(촬영 상태 기계) · auto-start.js · presence.js(인식 판정) · guidance.js(관람객 안내 규칙)
            log-limit.js · oil-paint.js(획 목록·해상도 비례·tick) · thermal.js(감열지 출력 단계·입력 회색조 계수)
            camera-view.js(카메라 처리 경로의 변환·색 보정 계수)
            photo-frame.js(사진 틀 줄·인식 영역 줄이기) · imprint.js(촬영 시각 표기·인쇄 쪽 배치·1비트 합치기) — IMPRINT에서 도입
            chroma-key.js(장면 이미지의 그린 키·둘레 번짐 제거, 14단계)
  camera/   camera.js(장치·스트림) · camera-monitor.js(상태 감시·자동 회복·다시 열기) · capture.js(캡처·결과 이미지·자원 정리)
            camera-frame.js(카메라 처리 경로 2D 그리기·색 보정 SVG 필터) · raw-preview.js(원본 미리보기 캔버스)
  vision/   face-detector.js · detector-keeper.js(재생성·감지기 상태) · presence-monitor.js(감지 루프)
  effect/   oil-shaders.js · oil-renderer.js(WebGL2) · effect-preview.js(실시간 미리보기) · photo-effect.js(결과 사진 효과·사진 틀 자르기·인쇄 데이터)
            imprint-page.js(인쇄 쪽 글자를 캔버스에 그려 1비트로, 글자는 WISHFUL 시안)
  ui/       guest-screen.js · scene-plate.js(관람객 화면 장면 그리기·띠 맞춤·창 줄 키, 14단계) · operator-panel.js(E 패널·섹션) · camera-tuning.js · presence-tuning.js · timing-tuning.js · effect-tuning.js(카메라·인식·시간·필터 섹션)
            region-drag.js · dev-panel.js(D) · save-state.js
  demo/     index.html · demo.js · scene.js(합성 장면) · demo.css — 카메라 없는 시안 데모 (검토용, 관람객 화면 아님, WISHFUL HOLIDAY)
test/                       Node 테스트 (npm test = node --test "test/**/*.test.mjs", glob 인자 때문에 Node 22 이상, 개발 PC는 Node 24.19.0으로 확인). 하위 폴더는 src/web과 같은 이름. core-deps.test.mjs(core 의존 검사), helpers.mjs(공용 흉내),
                            fixtures/(fake-vision-bundle.mjs: 번들 파일 이름으로 판별하므로 별도 파일, fake-webgl2.mjs)
lib/mediapipe/              MediaPipe 런타임·모델 (커밋, 스크립트로만 갱신, 5절)
tools/                      vendor-mediapipe.mjs · browser-check.mjs · browser-check-lib.mjs (개발 PC 전용)
package.json · package-lock.json · .npmrc   개발 PC 전용. @mediapipe/tasks-vision 정확 버전 고정(save-exact=true)
```

- `node_modules/`는 Git 제외이고 현장 PC에는 Node가 필요 없다. `lib/mediapipe/**`는 `.gitattributes`에서 `-text`(받은 바이트 그대로, CRLF 변환 없음).
- `.gitignore`: `settings.ini`, `/config/*.local.json`·`*.tmp`, `/logs/`·`*.log`, 촬영 산출물(`/artifacts/`·`/captures/`·`/runtime/`), `node_modules/`, 도구별 로컬 설정.

### 정적 서버

- `powershell -NoProfile -ExecutionPolicy Bypass -File bin\server\serve.ps1 [-Port 8765]`. Ctrl+C로 바로 종료(리스너를 닫는다). 요청은 한 번에 하나씩, 한 요청이 실패해도 500으로 답하고 계속한다.
- `Net.HttpListener`에 `http://localhost:<Port>/`만 등록한다(관리자 권한 불필요). `127.0.0.1`은 http.sys가 400. 요청한 쪽 주소(`RemoteEndPoint.Address`)가 루프백(`127.0.0.0/8`, `::1`, IPv4-mapped)이 아니면 403.
- 경로: `/` → `src/web/index.html`, `/lib/*` → `lib/`, `/local-api/*` → 조절값 파일 API, 나머지 → `src/web/`. URL 디코딩 후 역슬래시·`:`·제어 문자·와일드카드, `.`으로 시작하거나 `.`·공백으로 끝나는 조각은 400, 실제 경로가 루트 밖이면 403.
- MIME: html, js, mjs, css, json, svg, png, jpg/jpeg, webp, woff, woff2, wasm, tflite, task(그 외 `application/octet-stream`). 모든 응답에 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. 정적 파일은 GET·HEAD만(그 외 405).

### 조절값 파일 API

운영자 조절값을 브라우저 프로필이 아니라 저장소 안 파일에 둔다(프로필과 무관, PC를 옮길 때 파일만 복사).

| 경로 (서수 비교로 정확히 같을 때만, 변형·그 밖의 `/local-api/*`는 404) | 파일 | 쓰는 쪽 |
|---|---|---|
| `/local-api/presence-settings` | `config/presence.local.json` | `E` 인식 섹션 (5절) |
| `/local-api/effect-settings` | `config/effect.local.json` | `E` 필터 섹션 (6절) |
| `/local-api/camera-settings` | `config/camera.local.json` | `E` 카메라 섹션 (3절 "카메라 처리 경로") |
| `/local-api/timing-settings` | `config/timing.local.json` | `E` 시간 섹션 (4절 "시간 설정", 10단계) |

- `GET`: 있으면 200 `application/json; charset=utf-8`(저장한 바이트 그대로), 없으면 404. `PUT`: 아래 조건을 모두 만족하면 원자적으로 쓰고 204, 아니면 4xx와 짧은 이유. 그 밖은 405 `Allow: GET, PUT`. 네 경로가 같은 함수(`Invoke-SettingsApi`)를 쓴다. 파일 이름은 클라이언트가 정할 수 없다.
- **CSRF 방어** (루프백 제한은 같은 PC의 다른 웹페이지 요청을 막지 못하므로): `X-Photobooth: 1` 헤더(없으면 403), `Content-Type: application/json`(charset은 `utf-8`만, 아니면 415), `Host`가 `localhost:<port>`(403), `Origin`이 있으면 `http://localhost:<port>`(403), `Sec-Fetch-Site`가 있으면 `same-origin`(403). 다른 출처는 사전 요청 `OPTIONS`가 405이고 CORS 허용 헤더(`Access-Control-Allow-*`)를 보내지 않아 `PUT`이 나가지 않고, 헤더 없는 단순 요청(`no-cors`)은 위 조건에서 거절된다. `Origin`·`Sec-Fetch-Site`가 없는 같은 PC 프로그램은 받는다. DNS 리바인딩은 `Host` 검사로 막는다.
- **본문:** 상한 16KB(16384바이트, 넘으면 413, chunked 포함). 엄격한 UTF-8이 아니거나 `JavaScriptSerializer`로 푼 결과가 JSON **객체**가 아니면 400. 값의 의미는 검사하지 않는다(클라이언트 정규화가 맡아 어떤 내용이든 안전하게 불러온다).
- **원자적 쓰기:** 같은 폴더 `<파일 이름>.<guid>.tmp`에 쓰고 flush한 뒤 `File.Replace`(처음이면 `File.Move`). 잠겨 있으면 50ms 간격 5번 재시도, 끝내 실패하면 500. 임시 파일은 늘 지운다. PowerShell 5.1이 `$null`을 빈 문자열로 바꾸므로 백업 경로는 `[NullString]::Value`.

### 외부 전송 차단: CSP

`src/web/index.html`의 `<meta http-equiv="Content-Security-Policy">`(스크립트보다 먼저):

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'
```

- `connect-src 'self'`로 MediaPipe 사용 통계 전송(5절)을 브라우저가 보내기 전에 막는다. `wasm-unsafe-eval`은 MediaPipe WASM에 필요하다(`unsafe-eval`·`unsafe-inline` 없음). `blob:`은 결과 사진 Object URL용이다(`data:` 없음). 서체는 같은 출처 파일이고, 인라인 `<style>`·`style=""`는 쓰지 않는다.
- 콘솔의 `Connecting to 'https://odml.pa.googleapis.com/v1/log' violates the following Content Security Policy directive` 오류가 감지기마다 한 번(생성 약 60초 뒤) 찍히는 것은 정상이다.
- 새 기능이 다른 출처를 써야 하면 이 정책을 함께 고친다. 넓히지 않는 것이 원칙이다.

### 스크립트 인코딩 규칙

- `.ps1`·`.bat`·`.cmd`는 **ASCII만**(주석도 영어). Windows PowerShell 5.1은 BOM 없는 UTF-8을 시스템 코드 페이지로 읽는다. 이 파일들과 `.ini`는 `.gitattributes`에서 `eol=crlf`. 웹 파일은 UTF-8, 서버가 `charset=utf-8`로 준다.

### 현장 실행 스크립트

`Launch.bat` → `powershell -NoProfile -ExecutionPolicy Bypass -File bin\launch.ps1`. 순서 **설정 → OBS → 서버 → Chrome**. 실패하면 단계 이름과 원인을 콘솔과 `logs/launch_*.log`에 남기고 종료 코드 1, 창을 멈추고 `logs\`를 안내한다. 앞 단계에서 띄운 것은 되돌리지 않는다(다음 실행이나 `Shutdown.bat`이 정리).

- 중복 실행: mutex `Local\ShinsegaePhotoboothLaunch`를 못 잡으면 실패. 로그: `launch_*`·`shutdown_*`는 종류별 최근 20개, 서버 출력 `server_*.out.log`·`.err.log`는 최근 20회분. 로그에 촬영 이미지는 없다(서버 출력은 요청 경로와 상태 코드뿐).
- 설정: `settings.ini`가 없으면 예시를 복사하고, 있으면 빠진 키만 끝에 덧붙인다(있는 값은 그대로). 포트 범위·`true`/`false`·`x,y` 형식·절대 경로·프로필이 저장소 밖인지 검증해 틀리면 `settings` 단계에서 실패. 시험용 `-SettingsPath <파일>`(파일을 고치지 않음). bat는 인자를 그대로 넘긴다.
- **콘솔에서 실행한다.** 서버가 표준 출력 핸들을 물려받아, 출력을 파이프로 받으면 서버가 끝날 때까지 닫히지 않는다.

**설정 키** (`settings.ini`, `key=value`). 비우면 자동·기본값, 경로에 `%LOCALAPPDATA%` 같은 환경 변수를 쓸 수 있다.

| 키 | 기본값 | 뜻 |
|---|---|---|
| `server_port` | `8765` | 로컬 서버 포트. 카메라 권한은 출처별로 저장되므로 바꾸면 다시 허용 |
| `chrome_path` | 비움(자동) | `chrome.exe`. App Paths(HKLM·HKCU) → Program Files → (x86) → LocalAppData 순서로 찾는다 |
| `chrome_profile_dir` | `%LOCALAPPDATA%\ShinsegaePhotobooth\ChromeProfile` | 키오스크 전용 프로필(카메라 권한 저장). 저장소 안이면 실패 |
| `kiosk` | `true` | `--kiosk` 전체화면. `false`면 `--app=<url>` 일반 창(시험용) |
| `window_position` | 비움 | `x,y` → `--window-position`. 띄울 모니터(예: 두 번째 모니터 `1920,0`) |
| `window_size` | 비움 | `너비,높이` → `--window-size`. `kiosk=false`일 때만 |
| `obs_path` | 비움(자동) | `obs64.exe`. `HKLM\SOFTWARE\OBS Studio` → Program Files → (x86) |
| `obs_autostart` | `true` | OBS가 꺼져 있으면 가상카메라를 켜고 트레이로 시작 |
| `obs_stop_on_shutdown` | `false` | `Shutdown.bat`이 OBS도 종료할지 |

**첫 설치 (현장 PC)**

1. Chrome과 OBS Studio를 설치한다(확인한 버전 Chrome 155, OBS 32.2.1).
2. OBS에서 웹캠 소스와 출력 해상도를 설정하고 가상카메라를 한 번 켜 본다. 반전은 하지 않는다. 트레이 시작은 OBS 설정 "시스템 트레이 사용". **크롭·회전·색 보정은 한 곳에서만** 한다(둘 다 하면 두 번 적용된다):
   - **권장 — 웹(`E` 카메라 섹션):** OBS는 원본만 넘긴다(크롭·회전·색 보정을 하지 않고 출력은 카메라 그대로 또는 9:16). 웹에서 회전(90° 단위 + 미세)·확대·이동·색 보정을 하고 원본 창으로 확인한다. 웹캠을 OBS 없이 바로 써도 된다(장치 선택).
   - OBS: 예전처럼 OBS에서 9:16 크롭·회전·보정을 하고 출력 해상도를 화면에 맞춘다. 웹 카메라 섹션은 중립(기본값)으로 둔다.
   - OBS 가상카메라는 해상도 `auto`로 둔다(다른 비율 프리셋은 잘려서 온다).
3. `Launch.bat`을 실행한다(`settings.ini`가 만들어진다). 다른 값이 필요하면 고치고 다시 실행한다.
4. 키오스크에 카메라 권한 창이 뜨면 마우스로 "허용"(전용 프로필에 저장, 포트·프로필을 바꾸면 다시).
5. 카메라와 발자국 매트를 설치한 뒤 `E`의 카메라 섹션(방향·위치·색)과 인식 섹션(인식 범위)을 조절하고 섹션마다 저장한다(개발 PC 값은 쓰지 않는다). 카운트다운·결과·쿨타임·반응 속도를 바꾸려면 시간 섹션에서 저장한다.
6. 부팅 자동 실행은 `Setup-Startup.bat`. 로그인할 때 실행되므로 무인 운영이면 Windows 자동 로그인을 따로 설정한다.

**OBS 단계:** `obs64`가 하나라도 있으면 아무것도 하지 않는다. 꺼져 있고 `obs_autostart=true`면 파일 버전을 기록하고 `obs64.exe` 폴더에서 `--startvirtualcam --minimize-to-tray --disable-updater --disable-missing-files-check`로 시작하며(32.2.1 `--help`로 확인한 플래그만), 3초 뒤 끝나 있으면 실패. 가상카메라가 늦어도 웹 자동 회복이 연결한다. OBS 32에는 `--disable-shutdown-check`가 없어, 비정상 종료 표식 `%APPDATA%\obs-studio\.sentinel\run_*`가 남으면 "안전 모드" 대화상자로 가상카메라가 시작되지 않는다. 그래서 **OBS가 하나도 없을 때만** 남은 표식을 지우고 시작한다. 32.x가 아니면 경고를 남긴다.

**서버 단계:** 이 저장소 `bin\server\serve.ps1`을 `-File <전체 경로>`로 실행 중인 PowerShell만(명령줄 일치) 이전 서버로 보고 종료한다. 그 뒤 포트에 무엇이든 응답하면 실패. 창 없이(`-WindowStyle Hidden`) 띄우고 출력은 `logs/server_*.log`. `GET /` 200을 최대 15초 기다리고, 그 사이 서버가 끝나면 오류 출력 끝을 원인에 붙인다. `Launch.bat` 창이 닫혀도 서버는 돈다.

**Chrome 단계 (Chrome flags)**

- 같은 전용 프로필의 Chrome은 먼저 닫는다(닫기 요청 → 5초 뒤 강제). 같은 프로필로 다시 띄우면 기존 인스턴스에 창만 생기기 때문이다.
- 하드웨어 가속: 프로필 `Local State`에 `"hardware_acceleration_mode":{"enabled":false}`가 있으면 그 값만 `true`로 바꾼 임시 파일을 JSON 확인 뒤 `File.Replace`로 원자적으로 바꾸고 경고한다. 문제가 있으면 원본을 두고 경고만(실행 계속). GPU를 끄는 플래그는 쓰지 않는다.
- 플래그: `--user-data-dir="<chrome_profile_dir>"`(일반 Chrome과 분리·종료 대상 식별), `--kiosk <url>`(또는 `--app=<url>`·`--window-size`), `--no-first-run`, `--no-default-browser-check`, `--hide-crash-restore-bubble`(복원 말풍선. `--disable-session-crashed-bubble`은 Chrome 155에 없음), `--disable-features=Translate`, `--disable-pinch`, `--overscroll-history-navigation=0`, 설정했을 때 `--window-position=x,y`. Chrome 155 `chrome.dll` 문자열로 이름을 확인했고 경고 막대가 없고 WebGL이 GPU로 동작한다. 각 플래그가 막는 화면이 실제로 안 나오는지는 **미검증**.
- **카메라 권한:** 전용 프로필에서 운영자가 처음 한 번 "허용". 쓰지 않은 방법: `--use-fake-ui-for-media-stream`(Chrome 155에서 경고 막대가 화면 위를 가리고 모든 요청을 자동 수락), 프로필 `Preferences` 미리 기록(내부 형식 의존), 정책 레지스트리(HKCU는 일반 Chrome에도 적용, HKLM은 관리자 권한). 허용 전에도 앱은 "준비 중"으로 기다린다.

**종료 (`Shutdown.bat`):** 명령줄 `--user-data-dir`이 `chrome_profile_dir`과 같은 Chrome과 그 자식만(닫기 요청 → 5초 뒤 강제), 서버는 같은 명령줄 일치로, OBS는 `obs_stop_on_shutdown=true`일 때 경로가 같은 `obs64.exe`만(트레이면 10초 뒤 강제, 남는 표식은 다음 실행이 지움). 한 항목이 실패해도 계속하고 하나라도 실패하면 종료 코드 1. 키오스크 화면은 `Shutdown.bat`으로 닫는다(`Alt+F4`는 키오스크에서 **미검증**).

**부팅 자동 실행 (`Setup-Startup.bat`):** 현재 사용자 시작 프로그램 폴더(`shell:startup`)에 `Shinsegae Photobooth.lnk`(대상 `Launch.bat`, 작업 폴더 저장소 루트)를 만들고 `-Remove`로 지운다. 관리자 권한·작업 스케줄러 없음. 이름이 같아도 설명·대상이 다르면 건드리지 않고 실패한다.

### 브라우저 확인 도구

`tools/browser-check.mjs` (`npm run check:browser`): 개발 PC에서 실제 앱을 headless Chrome으로 띄워 시나리오 25개를 확인한다(한 번에 약 10분, 화면 캡처는 `--screens`일 때만). Windows, Chrome, Node 22 이상, 설치 필요 없음.

```powershell
npm run check:browser                              # 가짜 카메라
npm run check:browser -- --camera real             # 실제 카메라 (OBS 가상카메라 우선)
npm run check:browser -- --soak --camera real      # 장시간 실측 기본 10분 (20초마다 S, 1분마다 → logs\soak_*.csv)
npm run check:browser -- --soak 60 --camera real   # 분 지정
npm run check:browser -- --camera real --only "카메라 변환|카메라 장치"   # 이름에 그 글자가 든 시나리오만 (첫 페이지 로드는 늘)
npm run check:browser -- --camera real --camera-label "Logitech StreamCam (046d:0893)" --only "카메라"   # 카메라 설정 시나리오를 그 장치로
npm run check:browser -- --only "화면 캡처" --screens "%TEMP%\photobooth-review\9"   # 운영자 화면 PNG (가짜 카메라만)
npm run check:browser -- --only "시험 조합|WISHFUL" --screens artifacts\wishful\screens   # WISHFUL 시안: 4조합·관람객 화면·데모 PNG (가짜 카메라·합성 장면만, artifacts/는 Git 제외)
npm run check:browser -- --only "관람객 화면(14단계|시안 데모|흑백 스타일 4가지" --screens artifacts\stage14\screens   # 14단계 장면·눈 바닥 글자·톤 점 × 유화 (가짜 카메라·합성 장면만)
```

- **구조:** Node 내장 `WebSocket`으로 CDP에 직접 붙는다. `serve.ps1`을 빈 포트로, Chrome을 `%TEMP%\photobooth-check-*` 임시 프로필·`--headless=new`·`--remote-debugging-port=0`으로 띄운다(늘 `--user-data-dir`이라 사용자 Chrome에 붙지 않는다). 카메라는 기본 가짜 장치(`--use-fake-device-for-media-stream`), 권한은 CDP `Browser.setPermission`.
- **앱 상태:** D 화면 글자를 줄 머리말로, 관람객 안내를 `#status`로 읽는다. **앱에 확인 전용 훅이 없다** — D 줄 형식·확정 문구를 바꾸면 도구도 고친다. 카메라 처리 경로 확인은 페이지 안에서 앱의 순수 모듈(`/core/camera-view.js`)과 셰이더 문자열(`/effect/oil-shaders.js`)을 `import()`해 같은 계산을 따로 그려 비교한다(앱 상태를 바꾸지 않는다). 조작은 CDP 키 입력·`Fetch`(모델 404). 외부 요청·CSP 위반·페이지 예외를 기록한다(MediaPipe 통계 차단은 따로 세고 실패로 보지 않음). 생성 실패 시나리오용으로 `setInterval`·`clearInterval`을 페이지보다 먼저 감싸 센다. 시나리오가 실패하면 그 순간의 페이지 상태·D 화면 글자 전체·최근 기록 80줄(페이지 이동, 조절값 API 요청과 응답 상태, 콘솔·로그 경고/오류, 예외)을 `DIAG` 줄로 남긴다(글자만, 영상·사진 없음). 새로고침(`open()`)은 이전 문서에 표시를 남기고 새 문서가 다 불러와질 때까지 기다린다.
- **정리:** 어떤 끝이든 자신이 띄운 Chrome·서버·임시 프로필만 정리한다(`--keep-profile`이면 프로필을 남김). 사진을 저장하지 않는다. 결과 표를 출력하고 하나라도 실패하면 종료 코드 1.
- **조절값 파일:** 시작할 때 `config/*.local.json`(인식·효과·카메라·시간)을 바이트 그대로(또는 "없음") 백업하고, 시나리오 뒤와 마지막에 **파일 시스템으로 직접** 되돌린다(없던 파일·빈 `config/`는 지운다). 그사이 몇 초 시험 값이 들어 있으므로 **현장 키오스크가 같은 저장소에서 도는 PC에서는 실행하지 않는다.**
- **기다림 시간 초과:** 메시지 끝에 그때의 D `status`·`reason`·`video`·`effect`·`raw-view`를 붙인다(실제 카메라에서 원인을 바로 보이게).
- **CDP:** 요청마다 제한 시간 15초. 연결이 끊기면 모든 요청이 바로 실패해 몇 초 안에 끝나고 정리한다(`browser-check-lib.mjs`).
- **시나리오:** (WISHFUL 시안에서 더함: **시험 조합 4가지** — `E` 조합 버튼 → 처리 해상도 1에서 S, 결과 사진 = 셔터 직전 미리보기 그림의 틀 줄(블록 차 1/255 미만), 흑백이면 미리보기·결과 무채색·컬러면 색, 유화 끔이면 획 0·30장/초, 인쇄 데이터는 흑백만, 유화 수치 유지, 닫으면 저장 조합. 관람객 화면 시나리오는 14단계부터 틀 8/64~53/64, 관람객 글자·숫자·진행선·`P` 표시가 눈 바닥에만 있는지(위 띠 없음)·없앤 제목·날짜 요소가 없는지·장면 읽음 여부, 데모 시나리오는 4조합 비교 촬영과 `--screens`면 감열지 톤 점 질감 세기 0·1·2 화면, 흑백 스타일 시나리오는 톤 점 × 유화(`stroke-tone`) 셔터 순간 그림 = 결과·`gpu=cpu`도 본다) 페이지 로드(서체 포함) · `S` 한 사이클과 자원 정리 · 조절값 API(인식·시간: 왕복, 헤더 없음 403, 16KB 초과 413) · 감지기 생성 실패 정리 · 권한 거절 → 허용 · 모델 차단 · 효과 미리보기(기본값, 결과 사진 준비, 컨텍스트 손실·복구) · 회색조 유화 기본 촬영(결과 = 셔터 직전 그림, 무채색, 결과 1080×1350, 인쇄 쪽 576×912 1비트, 결과 폭 = 사진 틀 폭) · 출력 모드 전환 · 흑백 스타일 4가지 · 흑백 스타일 GPU = CPU · GPU 디더 = CPU·1비트 PNG · 효과 WebGL2 생성 실패(원본 미리보기 캔버스가 계속 그림) · `E` 필터 섹션 저장 유지 · 운영자 패널(9-2: `R` 없음·첫 섹션 카메라·원본 창, 실행 중 해상도 바꾸기 → 다시 열기·관람객 "준비 중", 회전·확대·반전·색 보정 즉시 반영 → 미리보기·원본 창 = 변환한 영상, 섹션별 저장·닫을 때 되돌리기·섹션별 기본값·새로고침 유지, 실행 중 장치 바꾸기(사용 중인 장치는 기록하고 다음 장치로, 닫으면 원래 장치), 원본 창 켬/끔 속도) · 시간 섹션(10단계: 인식 섹션에 시간 항목 없음, 조절 → 반응 시간 즉시 반영·저장 → 새로고침 유지, `S` 회차의 카운트다운·결과·쿨타임을 페이지 안에서 D `session` 줄 상태 변화 시각으로 재 바뀐 값과 비교(숫자 순서·진행선 길이 포함. 기록기는 설치·초기화 순간의 상태에서 시작하고, 실패하면 단계 순서와 대기로 돌아온 이유(D `last end`·`status`)를 남긴다), 카운트다운 도중 바꾸면 그 회차는 시작할 때 값·다음 회차부터 새 값, 저장하지 않고 닫으면 되돌림, 9단계 모양 인식 파일 → 시간 파일 옮기기, 시간 파일 자리에 폴더를 두어 서버 쓰기 실패 → 옛 값 사용·인식 파일 바이트 그대로·"저장 필요"·그동안 인식 섹션을 저장해도 옛 키 유지 → 시간 섹션 저장 → 다음 시작에 옛 키 정리) · 관람객 화면 WISHFUL HOLIDAY(글자·숫자의 화면 위치가 사진 틀(4:5) 밖인지 대기·카운트다운·결과·쿨타임마다, 결과 `<img>` 자리 = 틀, D `capture` 1080x1350·`photo-fx` `frame`·`print` `576x912 1-bit (imprint: photo 576x720 at row 84)`·`frame` 줄·인식 영역 줄임, 결과 동안 머리 시각 멈춤, 숫자 넘김 애니메이션, `Emulation.setEmulatedMedia`로 동작 줄이기 → `data-motion` reduce·바닥 쪽 선 멈춤·숫자 위치 움직임 없음, `--screens`면 대기·카운트다운·결과·쿨타임·준비 중 화면) · 시안 데모(`/demo/index.html`: 관람객 화면 id 목록 = 앱, 합성 장면 → 효과 540x960 → 결과 1080x1350·인쇄 PNG 576x912·머리·꼬리 글자, 출력 중 흉내, 준비 중·직원 문의 흉내, 동작 줄이기 전환, `--screens`면 상태별 화면·패널 포함 화면·인쇄 데이터 PNG) · 운영자 화면 캡처(`--screens`, 가짜 카메라 전용) · 좌우 반전 켬·끔(카메라 설정 파일 → 새로고침. CSS 반전 없음, 효과 미리보기·결과 사진 방향, 얼굴이 보이면 화면 x가 `1 - x`로, 효과 파일의 예전 `mirror` 옮기기) · 카메라 장치·해상도(프리셋 요청 → 실제 트랙·캡처, 다른 카메라가 있으면 그 라벨로, 없는 라벨이면 OBS·기본 규칙) · 카메라 변환·색 보정(회전 90°+3°·확대·이동·색 보정 6개: 같은 프레임의 2D 그림(앱 SVG 필터) = core 기준식, 효과 셰이더 입력(`FS_GRADE` uAmt 0) = 2D, 미리보기·결과 = 변환한 영상, 얼굴이 보이면 예측 위치, 화면·감지·효과 속도) · 결과 효과 렌더 실패 · 외부 요청·CSP 위반·예외 0. 확인 값은 `tools/browser-check.mjs`에 있다. 좌우 방향은 효과 그림·결과 사진·같은 순간의 영상을 페이지 안에서 18×32 밝기 격자로 줄여 비대칭 성분(`g - flip(g)`)의 상관 부호로 본다(같은 방향 +, 거울 −, 기준 ±0.3. 가짜 카메라 화면은 거의 좌우 대칭이라 그냥 상관으로는 갈리지 않는다). 페이지 로드 줄에 쓰인 카메라 라벨이 나온다. 화소 일치 시나리오는 `E`에서 처리 해상도를 1로 두고 실제 `1080x1920`으로 그린 뒤 시작한다.
- **범위 밖:** 가짜 카메라에 얼굴이 없어 자동 시작·이탈 취소·인식 중 `P`는 확인하지 않는다(Node 테스트 `test/core/auto-start.test.mjs`·`test/vision/presence-monitor.test.mjs`와 사람 실측). 키오스크, OBS 시작·중지, 절전 복귀, 4K도 범위 밖. `S` 사이클은 `P`를 켜고 돌려 실제 카메라 앞에 사람이 있어도 된다.
- **장시간 실측:** `--interval`(기본 20초)마다 대기면 `S`. 1분마다 CSV에 JS 힙·DOM 노드·리스너·문서 수(`Performance.getMetrics`), D 화면 값, 이 프로필 `chrome.exe` 메모리(`PrivatePageCount`·`WorkingSetSize` 합), 콘솔·예외 수. 끝나면 항목별 통계와 시간당 기울기(처음 5분 제외 포함). 통과: 모든 기록에서 카메라 `ready`·감지기 `ok`, `S` 직전마다 사진 자원 0·`taken = released`, 측정값을 모두 읽음, 외부 요청·CSP 위반·예외 0, 완료 1회 이상.

## 2. 코드 책임 구분

| 영역 | 경계 |
|---|---|
| 카메라 | 장치 선택·스트림(`camera.js`), 첫 프레임·끊김·자동 회복·설정이 바뀌면 다시 열기(`camera-monitor.js`), 카메라 처리 경로(계산 `core/camera-view.js`, 2D 그리기 `camera-frame.js`, 원본 미리보기 `raw-preview.js`) |
| 얼굴 감지 | `face-detector.js`는 사전 확인·생성·실패 정리·감지·종료만 하고 영상 기준 정규화 박스·점수만 돌려준다(MediaPipe 자료형을 내보내지 않음). `detector-keeper.js`가 재생성·감지기 상태 |
| 인식 판정 | `presence.js` 순수 함수, `presence-monitor.js`는 "인식됨 / 인식 안됨"과 감지기 상태(`{ health, cause, since }`)만 밖에 알린다. 좌표·점수는 `getDebugSnapshot()`(D 전용)으로만 |
| 촬영 시작 입력 | 키보드(`main.js`)와 인식(`auto-start.js`)이 `session.request('start' \| 'cancel' \| 'reset')` 한 입구로 요청만 보낸다. 시작 여부는 상태 기계가 정한다 |
| 촬영 진행 | `session.js`: 상태 전환·타이머·회차·취소·초기화·결과 종료 시계. DOM·카메라를 모르고 시계·타이머·사진 함수를 주입받는다 |
| 이미지 | `capture.js`: 카메라 처리 경로로 캡처, 효과 단계 호출, 인코딩, 인쇄 데이터 붙이기, Object URL 생성·정리, 남은 자원 수 |
| 관람객 화면 | 무엇을 보일지는 `main.js`(안내 규칙·인식 표시 조건·쿨타임), 어떻게 보일지는 `ui/guest-screen.js`, 문구는 `config/guest-text.js`. 결과가 끝나면 `<img>`의 `src`를 먼저 지운 뒤 상태 기계가 Object URL을 정리한다(같은 알림 안, 동기) |
| 사진 효과 | `oil-paint.js`·`thermal.js`(core 계산), `oil-renderer.js`(WebGL2), `effect-preview.js`(미리보기·결과용 같은 그림), `photo-effect.js`(결과·인쇄 데이터·실패 대체), `effect-tuning.js`(`E`). 카메라·감지·촬영 상태는 모르고 `camera.isReady()`와 `<video>`만 받는다 |

사진 효과는 "캡처 이미지 → 결과 화면" 사이에 끼우는 함수 경계만 두고 범용 플러그인 구조는 만들지 않는다.

### 폴더 규칙

`src/web/`의 모듈은 책임과 의존 방향으로 하위 폴더에 둔다. 깊이는 1단계, 파일이 1개뿐인 소스 폴더는 만들지 않는다. 순수한 모듈이라도 책임이 분명히 다른 폴더에 속하면 그 폴더에 둔다(예: `vision/detector-keeper.js`). 분류 이유는 [로그 2026-10-16-01](logs/2026-10-16-01-folder-structure.md).

| 폴더 | 담는 것 | 불러와도 되는 것 |
|---|---|---|
| (최상위) | `index.html`, `main.js`(화면 조립), `style.css` | 모든 폴더 |
| `config/` | 설정값, 조절값 검증·정규화·저장 형식, 조절값 파일 불러오기·저장 | `config` |
| `core/` | DOM·카메라·캔버스·MediaPipe·네트워크에 의존하지 않는 계산·상태 | `core`, `config`의 순수한 파일 |
| `camera/` | 카메라 스트림, 상태 감시, 캔버스 캡처 | `camera`, `core`, `config` |
| `vision/` | MediaPipe 감지기 생성·재생성, 감지 루프 | `vision`, `core`, `config` |
| `ui/` | DOM 화면 표현: 관람객 화면, 운영자 화면(조절 패널·D 표·저장 상태) | `ui`, `core`, `config` |
| `assets/` | 서체·관람객 화면 장면 이미지(`assets/scene/`, 14단계 생성 이미지)(JS 없음). 밖에서 가져온 파일은 라이선스 파일과 함께 | — |
| `effect/` | 사진 효과 WebGL 렌더와 실시간 미리보기, 결과 사진·인쇄 데이터 | `effect`, `core`, `config` |
| `demo/` | 카메라 없는 시안 데모 (검토용 페이지, 최상위 `main.js`처럼 조립한다. WISHFUL HOLIDAY) | 모든 폴더 |

- **`core` 규칙(`test/core-deps.test.mjs`가 검사):** `core`와 거기서 전이적으로 닿는 파일은 `core/`·`config/` 안에 있고, 브라우저 전역(`document`, `window`, `navigator`, `location`, `localStorage`, `fetch`, `WebSocket`, 캔버스·이미지·미디어 생성자, `requestAnimationFrame` 등)을 쓰지 않는다. 동적 `import()`는 문자열 경로만. 타이머·`performance`·`Date`·`console`·`URL`은 허용. `globalThis`·`window`·`self`는 어느 형태로든 쓰면 위반이고, 예외는 매개변수 기본값 `timers = globalThis`(`core/session.js`)를 타이머 네 함수 호출로만 쓸 때뿐이다. 검사기는 완전한 파서가 아니다(범위를 추적하지 않아 한 파일의 지역·전역 같은 이름은 놓칠 수 있고, 애매한 `/`는 나눗셈으로 본다).
- `config/settings-file.js`는 기본 `fetch`가 전역이라 순수하지 않으므로 `core`에서 부르면 검사가 실패한다.
- `camera`·`vision`·`ui`·`effect`끼리는 서로 부르지 않고 `main.js`가 잇는다(효과 미리보기는 `camera`의 `isReady`·`<video>`·카메라 처리 경로 객체를, 감지 루프는 그 2D 그리기 함수 `drawFrame`을 주입받는다). `ui`는 `core/session`의 상태 이름을 쓴다. `config`·`core`는 바깥 폴더를 부르지 않는다. 자동 검사는 `core` 행뿐이고 나머지는 규칙으로 지킨다.
- 테스트는 `test/` 아래 소스와 같은 이름 폴더에, 주 대상 모듈 위치를 따라 둔다(1개짜리라도 둔다: `test/camera/`, `test/tools/`).

### 반복 오류 로그 제한

`core/log-limit.js`의 `errorLog`가 분류(`camera`, `detector`, `detection`, `capture`, `effect`, `effect-capture`, `effect-prepare` 등)마다 마지막 오류를 기억한다. 숫자만 다른 오류는 같은 오류다. 처음·바뀐 오류는 바로 남기고, 이어지면 세기만 하다가 60초(`LOG_SUMMARY_MS`, 가안)가 지나면 `[camera] 같은 오류 20회 더 (마지막 10:01:00): ...` 한 줄을 남긴다. 회복하면 요약하고 기억을 지운다. 별도 타이머는 없다. 브라우저가 직접 찍는 메시지(404, CSP)는 포함되지 않는다.

## 3. 카메라와 영상

### OBS 가상카메라

- 9:16 크롭·회전·색 보정은 OBS에서 하고 출력 해상도를 화면에 맞춰 왔다(1080×1920 ~ 2160×3840). 9-1부터는 같은 일을 웹의 카메라 처리 경로(아래, `E` 카메라 섹션)로도 할 수 있다(OBS 세로 회전 대신 90° 회전, 색 보정). 둘 다에서 하면 두 번 적용되므로 현장에서 한 곳만 쓴다. **기본 안내(사용자 결정 2026-11-02): 웹에서 카메라 옵션을 쓰고 OBS는 원본만 넘긴다**(카메라 섹션 맨 위 "OBS 보정과 중복 적용 주의" 한 줄, 1절 첫 설치). 어디서 할지 최종은 현장에서 정한다. 캡처 해상도 상한은 카메라(OBS) 출력이다.
- 장치는 카메라 설정의 **장치 라벨**(`deviceLabel`, 정확히 같은 라벨, 앞뒤 공백·대소문자 무시)을 먼저, 없거나 비어 있으면 라벨에 `OBS Virtual Camera`(`config.preferredCameraLabel`, 포함)가 있는 장치를, 그것도 없으면 기본 카메라를 쓴다(`camera.js` `pickCamera`). `deviceId`는 다시 연결·재부팅 때 바뀔 수 있어 저장하지 않는다. 같은 라벨의 장치가 둘이면 앞의 것(구분하지 못한다). 라벨이 비어 있으면(권한 전) 권한을 한 번 요청하고 다시 읽으며, 그 스트림이 고른 장치면 그대로 쓴다. 더 우선인 장치가 없어 대신 연결된 뒤 그 장치가 나타나면(`devicechange`) 바꾼다. D `selected`(`device`·`preferred`·`default`).
- 해상도는 **`ideal`로만** 요청한다. 카메라 설정 `resolution`이 `auto`면 `config.idealResolution`(2160×3840, 90°·270° 회전이면 3840×2160), 프리셋이면 그 값(카메라 기준 가로×세로). `exact`·`min`은 지원하지 않는 장치에서 실패하고, 제약이 없으면 640×480 같은 낮은 형식이 올 수 있다. Chrome은 장치 범위에서 가장 가까운 값을 원본보다 키우지 않고 고르며 잘라 줄일 수 있다(가짜 카메라 2160×2160). **OBS 가상카메라(출력 1080×1920)에 다른 비율을 요청하면 그 비율로 잘라 준다**(실측: 1280×720 → 1080×720, 1920×1080 → 1080×1080, 2160×3840·1080×1920 → 1080×1920). 그래서 OBS는 `auto`(또는 OBS 출력과 같은 프리셋)로 둔다. 실제 크기는 D `video`·`track`, 트랙이 지원하는 범위(`getCapabilities`)는 D `caps`.
- 다른 프로그램이 쓰는 장치(예: OBS가 소스로 잡은 웹캠)를 장치 라벨로 고르면 `NotReadableError`로 열리지 않아 `unavailable`(`in-use`)로 간격 재시도한다. 있는 장치라 OBS·기본 카메라로 대신하지 않는다(운영자가 고른 장치이고, 화면 D·안내로 드러난다).
- OBS 없이 일반 웹캠도 동작한다(9:16이 아니면 가운데 기준으로 잘라 채운다. 옆으로 세운 웹캠은 90° 회전).

### 카메라 처리 경로 (9-1)

카메라 설정은 **카메라 원본 자체를 고치는 값**이다. 그래서 감지(MediaPipe) 입력, 인식 좌표·D 박스, 효과 미리보기, 원본 미리보기, 촬영 결과, 인쇄 데이터가 모두 **같은 변환 하나**를 거친 같은 그림을 본다. 결정 경위는 [로그 2026-11-02-01](logs/2026-11-02-01-stage9-camera-pipeline.md).

```text
카메라 원본 (videoWidth × videoHeight)
  → 색 보정: c' = clamp(M·c + b, 0, 1) ^ (1/감마)        M = 대비 · 채도 · 화이트밸런스(색온도·색조), b = 0.5 − 0.5·대비 + 밝기
  → 원본 가운데 기준 회전(90° 단위 × 미세) → 덮기 배율 × 확대 → 좌우 반전(화면 기준) → 이동(화면 기준)
  → 9:16 화면 영역 (u, v ∈ 0~1, 관람객이 보는 그대로)
```

- **계산 한 곳:** `core/camera-view.js`(순수). `computeCameraView`가 영상 크기·화면 비율·설정으로 화면 → 원본(`stageToSource`)·원본 → 화면(`sourceToStage`) 아핀과 실제 배율을, `cameraColorMatrix`가 색 행렬·b·지수를 만든다. 이 값에서 2D 캔버스용(`canvasTransform`, `svgColorMatrixValues`)과 셰이더용(`shaderSourceAffine`, `shaderColorUniforms`)을 꺼낸다.
- **구현 방식:** 소비자마다 같은 계수를 쓴다(한 번 처리한 프레임을 공유하지 않는다). 효과는 초당 12장, 감지는 15장, 원본 미리보기는 효과가 없을 때만 그리므로, 매 카메라 프레임을 화면 크기(4K면 2160×3840)로 한 번 더 그려 두는 비용과 지연이 없다. 일치는 두 구현이 같은 순수 함수의 계수만 받도록 해서 보장하고, Node 테스트(`test/core/camera-view.test.mjs`)가 같은 원본 점이 감지 입력(360×640)·캡처 캔버스·셰이더 소스 uv에서 같은 화면 점이 되는지, SVG 필터 값·셰이더 uniform이 기준식과 같은 색을 내는지 확인한다. 브라우저 확인은 실제 Chrome에서 같은 프레임의 2D 그림(앱 SVG 필터)·기준식·셰이더 그림을 비교한다(1절).
- **2D 캔버스** (`camera/camera-frame.js` `draw`: 감지 입력, 캡처, 원본 미리보기): 검게 칠한 뒤 `setTransform(canvasTransform)` + `ctx.filter = url(#camera-color-N)` + `drawImage(video, 0, 0)`. 색 보정은 문서 안 SVG 필터(`feColorMatrix` → `feComponentTransfer` gamma, `color-interpolation-filters="sRGB"`)이고, 값이 바뀌면 새 id로 다시 만든다(같은 url로는 캔버스가 바뀐 필터를 다시 읽는다는 보장이 없다). 중립이면 필터를 걸지 않는다. 변환이 없을 때 변환 행렬이 정확히 단위(반전이면 `[-1, 0, 0, 1, 폭, 0]`)라 원본 화소 그대로 옮긴다.
- **셰이더** (`effect/oil-shaders.js` `CAMERA_INPUT`, 효과 첫 패스 `FS_INPUT_GRAY`·`FS_GRADE`): 소스 uv = (`uSrcX`·p, `uSrcY`·p), p = (출력 uv, 1). 색은 `uCamM`(mat3)·`uCamB`·`uCamExp`. 변환·보정이 없으면 계산이 예전과 같다(지수 1이면 거듭제곱을 하지 않는다).
- **순서를 이렇게 둔 이유:** 반전을 회전 뒤(화면 기준)에 두어 90° 회전해도 반전은 늘 화면의 좌우다(회전 전에 두면 회전한 화면에서 위아래가 뒤집힌다). 이동도 화면 기준이라 반전과 관계없이 민 방향으로 움직이고, 확대는 화면 가운데 기준이다. 회전 양수는 화면에서 시계 방향.
- **빈 영역:** 회전·이동으로 화면에 카메라 밖이 보이게 되면 **확대를 자동으로 키워 늘 덮는다**(네 모서리가 원본 안에 드는 최소 배율). 검정 칸이 사진·인쇄·감지 입력에 남지 않는다. 요청한 확대가 이미 충분하면 그대로. D `transform`의 `used … auto`.
- **크기:** 캡처는 화면 영역이 덮는 원본 화소 수(`visibleWidthPx`×`visibleHeightPx`, 변환이 없으면 예전 cover 크롭과 같다. 확대 2면 절반). 효과 결과는 그것을 짧은 변 1080으로(확대해 작아져도 1080×1920). 감지 입력은 9:16 화면 영역을 긴 변 640으로(360×640, 영상 비율과 관계없이). 원본 미리보기는 화면 장치 화소와 원본 화소 수 중 작은 쪽.
- **바꾸는 순간:** `main.js` `applyCameraSettings(settings)` 한 입구. 다음 그림부터 모든 경로가 새 값이다. 기하(반전·회전·확대·이동)가 바뀌면 인식을 처음부터 다시 잰다(`presence-monitor.js` `setCameraGeometry`, 바뀌는 순간 "인식 안됨"·박스 지움·D `criteria resets` +1, 인식으로 시작한 카운트다운은 "떠남"으로 취소). 색 보정만 바뀌면 다시 재지 않는다. 장치·해상도 요청이 바뀌면 카메라를 다시 연다(아래 "카메라 상태와 자동 회복"). 캡처·결과 사진은 **셔터 순간**의 값이고, 셔터 직전 그림을 그린 뒤 설정이 바뀌었으면 결과는 지금 프레임·지금 설정으로 새로 그린다(D `photo-fx` `new drawing`). 이미 보이는 결과 사진은 다시 만들지 않는다.
- **D:** `selected`, `video`·`track`(요청 ideal·`resolution`), `caps`, `mirror`, `transform`(회전·요청 배율·실제 배율·이동·덮는 원본 화소), `color`(`neutral`), `raw-view`, `camera-cfg`(출처). `capture` 줄에 회전·배율·`color`·`mirrored`.

**카메라 설정** (`config.camera` 기본값, 범위·정규화 `config/camera-settings.js`, 저장 `config/camera.local.json`)

| 값 | 기본값 | 범위 (단계) | 뜻 |
|---|---|---|---|
| `deviceLabel` | `''` (자동) | 문자열, 앞뒤 공백 제거, 256자까지 | 쓸 카메라 라벨. 없거나 비면 OBS → 기본 카메라 |
| `resolution` | `'auto'` | `auto`·`2160x3840`·`1080x1920`·`720x1280`·`3840x2160`·`1920x1080`·`1280x720` | 카메라 기준 요청 해상도(ideal) |
| `brightness` / `contrast` | 0 / 1 | −0.5~0.5 (0.01) / 0.5~2 (0.05) | 밝기(더함)·대비(0.5 중심). 효과 레벨과 같은 뜻 |
| `saturation` | 1 | 0~2 (0.05) | 채도. 0은 Rec.709 밝기 회색 |
| `gamma` | 1 | 0.4~2.5 (0.05) | 지수 1/감마. 1보다 크면 중간 밝기를 밝게 |
| `temperature` / `tint` | 0 / 0 | −1~1 (0.05) | 색온도(빨강 × 1 + 0.2t, 파랑 × 1 − 0.2t) / 색조(초록 × 1 − 0.2t, 양수 자홍) (세기 가안) |
| `mirror` | `true` | 참·거짓 | 좌우 반전(아래 "좌우 반전") |
| `rotation` / `rotationFine` | 0 / 0 | 0·90·180·270 / −15~15° (0.1) | 90° 단위 + 미세 회전, 화면에서 시계 방향 |
| `zoom` | 1 | 1~4 (0.01) | cover 크롭 위에 곱하는 확대(빈 영역이 생기면 자동으로 더 키운다) |
| `panX` / `panY` | 0 / 0 | −0.5~0.5 (0.005) | 화면 폭·높이 대비 이동. 양수면 그림이 오른쪽·아래로 |

- **파일** `config/camera.local.json`: `{ "version": 1, "settings": { deviceLabel, resolution, brightness, contrast, saturation, gamma, temperature, tint, mirror, rotation, rotationFine, zoom, panX, panY } }`(2칸 들여쓰기). 숫자가 아니거나 없는 항목은 그 항목만 기본값, 범위 밖은 범위로·단계 자릿수로 반올림, 회전·해상도는 목록에 없으면 기본값(알림 `adjusted`, D `camera-cfg`). 손상·`version` ≠ 1은 전체 기본값.
- **불러오기** (`settings-file.js` `loadInitialCameraSettings`, **카메라를 열기 전에** 읽는다 — 장치·해상도 요청이 이 값이라 기본 장치로 먼저 열었다가 다시 여는 일이 없게. 제한 `config.cameraSettingsFile.timeoutMs` 3초, 가안, 넘으면 기본값으로 연다):

| 상황 | 쓰는 값 | D `camera-cfg` |
|---|---|---|
| 카메라 파일 200 | 파일 값(형식이 틀리면 기본값, 파일은 그대로) | `file` / `defaults (file is invalid)` |
| 카메라 파일 404 + 효과 파일에 `mirror`(참·거짓) | 기본값에 그 반전을 얹어 카메라 파일로 옮기고(`PUT` → 다시 `GET`해 확인) 효과 파일에서 **그 키만** 뺀다 | `migrated (mirror off from effect file (removed from effect file))` |
| 위에서 카메라 파일 쓰기 실패 | 이번엔 옮긴 값, 효과 파일은 그대로(다음 시작에 다시 옮긴다) | `effect file (…; migration to camera file failed: …)` |
| 위에서 효과 파일 키 빼기만 실패 | 옮긴 값(카메라 파일이 있으니 다시 옮기지 않는다. 그 키는 효과 쪽에서 읽지 않는다) | `migrated (… not removed from effect file: …)` |
| 둘 다 없음·효과 파일에 `mirror` 없음 | 기본값(파일을 만들지 않음) | `defaults (no file)` |
| 카메라 파일 읽기 실패·시간 초과 | 기본값, 옮기지 않음(파일이 있는데 못 읽었을 수 있다) | `defaults (file read failed: …)` |

- 효과 파일에서 키를 빼는 이유: 남겨 두면 운영자가 카메라를 초기화하려고 `camera.local.json`을 지웠을 때 옛 반전 값이 말없이 다시 옮겨진다(인식 조절값의 `localStorage` 옮기기와 같은 이유). 다른 효과 값은 건드리지 않고 같은 내용으로 다시 쓴다.
- **운영자 화면 (9-2):** `E` 카메라 섹션(`ui/camera-tuning.js`)이 `applyCameraSettings`로 바로 반영하고 섹션 저장으로 `camera.local.json`에 쓴다. 장치 목록 `camera.listDevices()`, 받은 크기·지원 범위(`capabilities`)·OBS 안내 줄, 실제 배율 `cameraFrame.getView(w, h)`. 원본 창은 4절 "운영자 화면".

### 화면 배치

- 9:16 영역(`#stage`)을 뷰포트 가운데에 최대 크기로 두고 밖은 검정(꾸미지 않음), 영역 바탕은 차콜(`--charcoal`). 비율은 `config.aspectRatio`.
- `<video>`는 `object-fit: cover`(가운데 기준)로 깔려 계속 재생되지만(감지·캡처·프레임 감시용) 직접 보이지 않는다. 그 위에 원본 미리보기 캔버스(`#camera-raw`)와 효과 캔버스(`#effect`)가 같은 영역을 덮는다. 둘 다 카메라 처리 경로를 거친 9:16 그림이다. 효과가 그리고 있으면 효과 캔버스만, 효과를 끄거나 쓸 수 없으면(장애·손실) 원본 미리보기 캔버스만 보인다(`main.js` `updateRawPreview`). 카메라가 준비되지 않으면 둘 다 숨긴다.
- **사진 틀 (IMPRINT에서 도입):** 미리보기는 9:16 전체에 그리고, 실제로 찍히는 곳은 그 안의 **사진 틀** `config.photoFrame`(화면 폭 전체 × 화면 높이 **8/64 ~ 53/64** = **4:5**, 1080×1920에서 240~1590줄. 14단계에서 위 제목을 없애고 WISHFUL의 10/64 ~ 55/64에서 60줄 올렸다. IMPRINT는 7/64 ~ 52/64)이다. 결과 사진·인쇄 데이터는 이 줄로 자르고(6절), 인식 영역은 틀 안으로 줄여 판정한다(5절). `main.js`가 같은 값을 CSS 변수 `--frame-top-frac`·`--frame-height-frac`로 넘긴다. 64분의 몇이라 결과 1920·인쇄 1024·4K 3840·감지 입력 640줄에서 모두 정수 줄이다(`core/photo-frame.js`, Node 테스트).
- D 정보는 기본 숨김이고 관람객 화면에 노출하지 않는다.

### 관람객 화면 (14단계 눈 마을 장면, 가안)

> 2026-11-06 사용자 요청으로 WISHFUL HOLIDAY의 위·아래 UI를 다시 디자인했다. 이전 판은 태그 `backup/wishful-filter-2026-11-06`(`475b890`)에 보존한다. 촬영·인식·취소·복구·저장·인쇄 경로와 현장 저장값은 그대로다. [구현 기록](logs/2026-11-06-06-snow-frame-ui-filter.md) · [이미지 제작 기록](logs/2026-11-06-08-snow-image-production.md).

**생각:** 화면 한 장을 눈 덮인 마을의 **나무 창틀**로 만든다. 위에는 조금 내려다본 DOF 눈 마을과 위 들보에 걸친 푸빌라·후트, 가운데는 사진 창(4:5), 아래는 들보 위의 깨또·포코, 그 아래 얼음벽과 **눈 바닥**이다. 제목·날짜·시각은 없고, **위 띠에는 관람객 UI를 두지 않는다**(사용자 확정). 안내 글과 3·2·1은 모두 눈 바닥에 새긴 글씨로 같은 자리에서 바뀐다. 창 안에는 글자·눈송이를 두지 않는다(보이는 그대로 찍힌다).

- **사진 창:** `config.photoFrame` 8/64 ~ 53/64(4:5, 1080×1920에서 240~1590줄). 결과 사진 1080×1350·인쇄 사진 576×720·인식 영역 줄이기는 그대로(값만 새 줄).
- **장면 이미지(`#scene-plate`, `ui/scene-plate.js`, `config.scene`):** 생성 이미지 한 장 `assets/scene/snow-frame-plate.png`(941×1672, 9:16과 0.05% 차이라 9:16 화면에 그대로 늘린다). 창 밖은 배경·창틀·캐릭터·얼음벽·눈 바닥이 그려진 불투명 그림이고, 창 자리만 단색 그린이다. 처음 한 번만 그린다(미리보기·감지 성능과 무관).
  - **띠 맞춤 `config.scene.layout`:** 생성 도구가 들보 줄을 정확히 맞추지 못해 원본은 그대로 두고 그릴 때만 **위 띠**(원본 0 ~ `topCut`)와 **아래 띠**(`bottomCut` ~ 끝)를 각각 평행이동한다(크기 그대로, 찌그러짐 없음). 자르는 줄은 전부 그린인 줄이라 캐릭터가 잘리지 않고, 빈 줄은 그린으로 채운다. 값은 장면 높이 비율: 현재 장면은 1920 환산 `topCut 285 · topShift −8 · bottomCut 1258 · bottomShift +47`(위 들보 중심 248 → 240, 아래 1543 → 1590, 눈 바닥은 1710부터). 새 장면이면 전부 그린인 첫·끝 줄과 두 들보 중심을 재서 네 값을 바꾼다.
  - **키:** 창 줄 ± `keyMarginFrac`(1/64, 1920에서 210~1620줄)에서만 그린 우세 d = G − max(R, B)로 투명도를 정한다(d ≤ 60 불투명, d ≥ 140 투명, 사이 비례, 반투명 화소는 G를 max(R, B)로). 키가 빠진 화소에서 2화소 안의 불투명 화소도 초록 번짐을 누른다(`core/chroma-key.js`). 창 밖의 초록(배경 나무 등)과 캐릭터의 탁한 초록은 그대로다. 캐릭터가 창에 걸친 부분은 화면에서만 사진을 가린다(사진·인쇄 데이터에는 없다).
  - **나중 영상:** 알파 없는 캐릭터 영상도 같은 9:16 좌표·같은 띠 맞춤 네 값·같은 키 식·같은 레이어(`#scene-plate` 자리)로 바꿔 끼운다(이번 범위에는 영상 없음, 프레임마다 키를 빼는 구현은 그때 한다).
  - **대체:** 장면을 못 읽으면 캔버스를 숨기고 창 밖 띠(`.frame-margin`)에 1차 배경 사진 `assets/scene/snow-village-bg.png`와 글자만 보인다. D `frame` 줄 끝에 `scene 941x1672, bands top -7 bottom +41, keyed rows …` 또는 `scene fallback background (…)`.
- **쌓임:** 카메라 미리보기·결과 사진·준비 중 막(z 없음) < 장면(z 1) < 눈송이·글자·바닥 진행선·준비 중 글자·D 겹쳐 그리기·`P` 표시(z 2). 셔터 빛은 장면 아래(창 안만).
- **눈 바닥 글자:** 바닥 위끝 = 화면 높이 57/64(1710) + 3.33cqw. 짙은 남보라(`--snow-ink`) 글자에 아래 흰 빛·위 그늘(`--carve`)로 새긴 홈처럼, 바닥 원근으로 24° 눕힌다(`perspective`). 한국어 Pretendard 500 5.19cqw, 영어 Cinzel 400 2.41cqw(자간 0.2em). 3·2·1은 Cinzel 600 15.7cqw를 같은 바닥 가운데에 새기고 한 칸 창 안에서 넘어간다. 숫자 동안 안내 줄(`#countdown-caption`)은 문구만 두고 숨긴다(숫자와 글이 겹치지 않게).
- **바닥 진행선:** 바닥 맨 아래 가운데 40cqw 홈(1920에서 1880줄). 카운트다운·쿨타임은 왼쪽에서 차오르고, 결과는 줄어든다. 사람이 서면 홈이 밝아진다(`#stage.is-present`).
- **눈송이:** 창 위·아래 띠에서만 장면 위로 두 겹 내린다(15초·10초 반복).
- **동작 줄이기:** 눈송이·준비 중 선을 멈춘다. 숫자는 위치 움직임 없이 투명도만, 진행선은 그대로.

| 상태 | 보이는 것 (위 띠에는 장면 그림만) |
|---|---|
| 대기 | 장면 + 눈 바닥 "발자국 위에 서 주세요" / "Step onto the footprints" |
| 인식 | 바닥 진행선 홈이 밝아진다 |
| 카운트다운 | 눈 바닥 가운데 새긴 숫자 3·2·1(안내 줄 숨김), 바닥 진행선이 차오름 |
| 촬영 순간 | 창 안에만 따뜻한 흰 빛(최대 0.7, 동작 줄이기 0.3) |
| 결과 | 사진은 창 자리 그대로(캐릭터가 걸친 부분은 화면에서만 가림), 눈 바닥 뒤 따뜻한 빛(`#result-paper`) + "사진이 완성되었습니다" / "Your holiday portrait is ready", 바닥 진행선이 남은 시간. 끝나기 0.7초 전 걷힌다(`data-leaving`) |
| 결과 (출력 중, 이후) | 종료 시계가 멈추면 선을 숨기고 "사진을 출력하고 있습니다" / "Printing your portrait" |
| 쿨타임 | 눈 바닥 "다음 촬영을 준비하고 있습니다" / "Preparing the next portrait"(한 단계 작게), 바닥 진행선이 차오름 |
| 준비 중·직원 문의 | 창 자리에 깊은 밤빛 막(`#status-veil`, 장면 아래라 창틀·캐릭터는 그대로), 창 가운데 `#status` 두 줄: "준비 중입니다."(Noto Serif KR Light 7.4cqw) / 둘째 줄(Pretendard 3.5cqw). 위 가는 빛이 준비 중이면 숨 쉬고 직원 문의면 멈춘다 |

- **운영자 표시 `#pause-badge`:** 눈 바닥 오른쪽 아래, 1.5cqw (위 띠에는 두지 않는다). `D`·`E` 운영자 화면 기능은 그대로다.
- **확인 도구가 쓰는 id·문구:** `#guide`·`#countdown-number`·`#countdown-ghost`·`#countdown-caption`·`#result-*`·`#status`는 그대로이고 `.title`·`.puff`·`.masthead`·`#masthead-*`·`.frame-corner`는 없앴다. 확인 도구는 관람객 글자·숫자·진행선·`P` 표시가 창 아랫선 아래(눈 바닥)에만 있는지와 없앤 요소가 없는지를 본다. "준비 중"·"직원 문의" 문구는 확정 그대로.
- **카메라 없는 데모 (검토용, 관람객 화면 아님):** `http://localhost:<포트>/demo/index.html`(`src/web/demo/`). 앱 `#stage` 마크업·CSS·`guest-screen.js`·`scene-plate.js`와 합성 장면(`demo/scene.js`, 얼굴 특징 없는 도형)을 실제 카메라 처리 경로·효과·촬영·사진 틀·인쇄 쪽 경로에 넣는다. 패널 조작: 흐름(자동 시연·사람·S·X), **필터 시험 조합**(네 조합 버튼, 흑백 방식, 감열지 흑백 스타일·질감 세기(14단계 톤 점 × 유화 비교), 세부 수치 "기본값" / "현장 저장값 (대조본)" — 2026-11-06에 현장 `filter.local.json`(revision 3)의 적용 수치를 읽기 전용으로 대조한 값을 코드에 적은 것, 파일을 읽거나 쓰지 않음), **4조합 비교 촬영**, 안내 상태 흉내, 동작 줄이기, 인쇄 연동 뒤 흐름 흉내, 마지막 인쇄 데이터 PNG. 앱과 같은 CSP.

**서체** (`src/web/assets/fonts/`, 바꾸지 않음)

| 서체 | 쓰는 곳 | 파일 | 출처 | 라이선스 |
|---|---|---|---|---|
| Pretendard 400·500 | 한국어 줄(500, 14단계), 인쇄 쪽 날짜·시각(500), 운영자 패널 | `Pretendard-Regular.subset.woff2`(267,096바이트), `Pretendard-Medium.subset.woff2`(268,324바이트) | GitHub `orioncactus/pretendard` v1.3.9 `web/static/woff2-subset/` 그대로 | SIL OFL 1.1, `OFL-Pretendard.txt` |
| Noto Serif KR 300 | 준비 중·직원 문의 첫 줄 | `NotoSerifKR-Light.subset.woff`(30,988바이트) | `notofonts/noto-cjk` `Serif2.003` 부분 집합 (IMPRINT 때 줄인 것 그대로) | SIL OFL 1.1, `OFL-NotoSerifKR.txt` |
| Cinzel 400·600 (WISHFUL) | 영어 줄(400), 3·2·1(600, 14단계), 인쇄 쪽 표제(600) | `Cinzel-Regular.latin.woff2`(14,128바이트, SHA-256 `b873cdd9…3dcf1217`), `Cinzel-SemiBold.latin.woff2`(15,204바이트, `61efc27c…2f28e4`) | npm `@fontsource/cinzel` 5.3.0(tarball SHA-256 `b80629f7…ee6d53c28`)의 `files/cinzel-latin-{400,600}-normal.woff2` 그대로. 원저작 NDISCOVER/Cinzel | SIL OFL 1.1, `OFL-Cinzel.txt`(패키지 LICENSE 그대로) |
| Pinyon Script 400 (WISHFUL) | 인쇄 쪽 꼬리 (14단계부터 화면에는 없음) | `PinyonScript-Regular.latin.woff2`(39,044바이트, `3e1f69a2…3e42`) | npm `@fontsource/pinyon-script` 5.3.0(tarball `7b4064f2…231dbe`)의 `files/pinyon-script-latin-400-normal.woff2` 그대로. 원저작 SorkinType/Pinyon | SIL OFL 1.1, `OFL-PinyonScript.txt` |

- `index.html`이 Pretendard 400·Noto Serif·Cinzel 400·600·Pinyon을 `<link rel="preload">`로 미리 받는다. 인쇄 쪽 글자는 캔버스에 그리므로 `main.js`·`demo.js`가 시작할 때 `IMPRINT_FONT_LOADS`(Cinzel 600·Pinyon·Pretendard 500)를 `document.fonts.load()`로 부른다(못 불렀으면 D `print` 줄 `FONTS NOT LOADED (system font)`).
- **서체 검사 (`test/config/guest-text.test.mjs`):** 영어 줄·숫자·표제·인쇄 표제가 Cinzel 400·600 WOFF2 `cmap`에, 필기체 줄이 Pinyon `cmap`에, 준비 중 첫 줄이 Noto Serif `cmap`에, 한국어 줄·날짜 글자가 Pretendard 400·500 `cmap`에 모두 있는지, 영어·인쇄 글자가 U+0020–007E만 쓰는지 본다. Cinzel·Pinyon은 latin 부분 집합(U+0000–00FF 등)이라 그 밖의 글자를 쓰려면 다른 부분 집합을 받는다. Noto Serif 한글은 준비 중 첫 줄뿐이라 그 문구를 바꿀 때만 다시 줄인다(IMPRINT 때와 같은 `fontTools` 명령, `master` 문서 참고).

### 좌우 반전

- 기본은 미리보기와 결과 모두 반전(켬)이다(현장 카메라 배치·OBS 설정에 따라 필요 없을 수 있다). 값은 **카메라 설정의 `mirror` 한 곳**(기본값 `config.camera.mirror` `true`, 저장 `config/camera.local.json`, 위 "카메라 처리 경로")이고, 효과를 끄거나(`enabled: false`) 쓸 수 없어도 이 값을 따른다. 2026-10-26 ~ 9-1에는 효과 조절값(`E` "카메라", `effect.local.json`)에 있었고, 그 값은 처음 읽을 때 카메라 파일로 옮긴다. 운영자는 `E` 카메라 섹션 "좌우 반전"에서 바꾼다(9-2).
- 반전은 **웹에서만**(OBS에서 하지 않음, 이중 반전 방지), 카메라 처리 경로의 한 단계로 경로마다 한 번:

| 경로 | 반전하는 곳 | 값을 읽는 때 |
|---|---|---|
| 효과 미리보기 | 입력을 읽을 때(셰이더 소스 uv, `shaderSourceAffine`). 효과 캔버스에는 CSS 반전 없음. 획이 좌우 대칭이 아니므로 반전된 그림에 칠한다 | 설정이 바뀌면 다음 화면 갱신에 다시 그린다 |
| 원본 미리보기(`#camera-raw`, 효과 끔·장애) | 2D 그리기 변환(`camera-frame.js` `draw`). CSS 반전 없음 | 다음 그림부터 |
| 촬영 결과·인쇄용 1비트 | 효과 결과는 `renderStill`이 그림의 소스 uv로, 원본 대체 사진은 `capture.js`가 같은 2D 그리기로. 인쇄 데이터는 결과 그림에서 만든다 | **셔터 순간**(프레임을 잡는 순간) |
| 인식 판정·D 겹쳐 그리기 | 감지 입력을 그릴 때(2D 그리기). 감지 박스가 곧 화면 좌표 | 다음 감지부터. 바뀌면 인식을 처음부터(`setCameraGeometry`) |

- **바꾸는 순간·미리보기 = 결과:** 위 "카메라 처리 경로"의 "바꾸는 순간"과 같다(반전은 기하 설정이라 인식을 처음부터 다시 잰다).
- 보이는 영역과 캡처 영역이 일치한다. D 카메라 구역 `mirror`(`on`·`off`, `(camera settings)`), `capture`의 `mirrored`.

### 권한과 보안 컨텍스트

- `getUserMedia()`는 보안 컨텍스트가 필요하고 `http://localhost`는 허용된다. 영상만 요청한다(마이크 없음). 현장은 전용 프로필에 한 번 허용해 둔다(1절).

### 카메라 상태와 자동 회복

무인 키오스크라 버튼 없이 스스로 회복한다(`camera-monitor.js`).

| 상태 (`CameraStatus`) | 뜻 | 회복 |
|---|---|---|
| `starting` | 준비 중(권한 대기 포함), 우선 장치로 전환 중 | — |
| `ready` | 실제 프레임이 들어오고 영상 크기가 0이 아님 | — |
| `permission-denied` | 권한 거절 | 권한이 `denied`면 권한 `change`를 기다린다. `prompt`·Permissions API 없음이면 간격 재시도 |
| `not-found` | 카메라 없음, 고른 장치가 사라짐 | 간격 재시도, `devicechange` 즉시 |
| `unavailable` | 사용 중·열 수 없음(`in-use`, `unknown`) | 간격 재시도, `devicechange` 즉시 |
| `unsupported` | 미지원 브라우저, 비보안 컨텍스트, `requestVideoFrameCallback` 없음 | 없음 |
| `no-frames` | 스트림은 얻었지만 제한 시간 안에 첫 프레임이 없음 | 정리 후 간격 재시도 |
| `disconnected` | 정상 이후 끊김: 트랙 `ended`, 장치 제거, 프레임 정지(`frame-stall`) | 정리 후 즉시 재시도, 실패하면 그 상태로 간격 재시도 |

- `camera.js` 실패 종류: `unsupported`, `permission-denied`(`NotAllowedError`·`SecurityError`), `not-found`(`NotFoundError`·`OverconstrainedError`), `in-use`(`NotReadableError`), `unknown`.
- `ready`는 `requestVideoFrameCallback`으로 실제 프레임을 받았을 때다. 프레임 정지는 마지막 프레임 시각으로 판정한다(`currentTime`은 쓰지 않음, 페이지가 숨겨져 있으면 판정하지 않음). `devicechange`는 0.5초 묶어 처리한다. 연결 시도는 한 번에 하나(진행 중 요청은 끝난 뒤 한 번 더, 그 사이 스트림은 닫음), 세대 번호로 늦은 결과를 무시한다.
- **설정값 (기본값 확정, `config.timing.cameraRecovery`):** 재시도 3초, 첫 프레임 제한 5초, 프레임 정지 3초, 직원 문의 전환 30초. 10단계부터 시간 설정 파일(`timing.local.json`의 `cameraRecovery`, 4절 "시간 설정")에 저장하고 `E` 시간 섹션 "카메라 회복"에서 조절한다(9-1·9-2에는 인식 조절값 파일·인식 섹션에 있었고, 처음 시작할 때 옮긴다). 카메라 감시는 이 값을 함수로 받아 다음 재시도·첫 프레임 대기·정지 판정부터 쓴다(이미 걸린 재시도 타이머는 그대로). 관람객 안내의 직원 문의 전환도 다음 판정부터.
- **다시 열기 (9-1):** 카메라 설정의 장치 라벨·해상도 요청이 바뀌면 `camera-monitor.js` `setRequest()`가 스트림을 닫고 다시 연다(상태 `starting`, 원인 `camera-settings`). 그동안 `ready`가 아니므로 진행 중인 카운트다운은 "카메라 준비 해제"로 취소되고(4절 기존 규칙), 촬영·결과 준비 중이면 계속, 결과 표시 중이면 그대로 보인다. 색 보정·반전·확대·미세 회전만 바뀐 것은 다시 열지 않는다(자동 해상도에서 90° 단위 회전이 0·180 ↔ 90·270으로 바뀌면 요청이 바뀌어 다시 연다). 시작 전에 부르면 저장만 한다.
- **관람객 문구 (확정):** 정상이 아니면 "준비 중입니다. 잠시만 기다려 주세요.", 30초 이상이거나 `unsupported`·`permission-denied`면 "준비 중입니다. 직원에게 문의해 주세요." 끊기면 영상을 지우고 문구를 띄운다. 감지기 상태와 합쳐 판정한다(5절).
- **D:** 상태, 원인과 원본 오류 이름, 시도·연속 실패 횟수, 마지막 시도 시각, 정상이 아닌 시간, 권한 상태.
- **경계:** `createCameraMonitor()`의 `isReady()`, `getState()`(9-1: `selection`·`capabilities` 포함), `subscribe(listener)`(해제 함수 반환), `getFrameInfo()`(실제 새 프레임의 마지막 시각 `performance.now()` 기준·누적 프레임 수, 영상 내용은 없음), 카메라 설정용 `setRequest()`·`getRequest()`·`listDevices()`만 쓴다. 캡처는 이 시각으로 정지 화면을 거르고, 감지 루프는 누적 수로 같은 프레임을 다시 세지 않는다.
- 경과 시간은 `performance.now()`, 사람이 읽는 시각(D `lastAttemptAt`, 자동 시작 기록)만 `Date`.

## 4. 촬영 상태

### 촬영 한 사이클

`core/session.js`(상태·타이머), `camera/capture.js`(캡처·자원), `main.js`(화면·입력 연결). 화면 모양은 3절 "관람객 화면".

```text
대기 ─(시작 요청: 대기 + 카메라 준비 + 페이지 보임)─▶ 카운트다운 3·2·1      시작 요청 = 키보드 S 또는 인식 레벨 판정
카운트다운 ─(3초)─▶ 촬영·결과 준비(capturing) ─▶ 결과 표시 ─(10초)─▶ 쿨타임 ─(5초)─▶ 대기      시간은 기본값, E 시간 섹션에서 바꾼다
카운트다운 ─(취소 / 카메라 준비 해제 / 페이지 숨김)─▶ 대기 (쿨타임 없음)
촬영·결과 준비 ─(실패·5초 초과·정지 화면)─▶ 대기 (쿨타임 없음, 자동 시작은 실패 대기 동안 쉼)
어느 상태든 ─(강제 초기화 X)─▶ 대기 (쿨타임 없음)
(이후) 결과 표시 = 출력 중(종료 시계 정지) ─(출력 완료 확인)─▶ 결과 표시 시간(10초) ─▶ 쿨타임
```

상태 이름(`SessionState`): `idle`, `countdown`, `capturing`, `result`, `cooldown`.

| 상황 | 처리 |
|---|---|
| 카메라 미준비·페이지 숨김에서 시작 요청 | 무시 (`camera-not-ready`, `page-hidden`) |
| 대기 아닌 상태의 시작 요청 | 무시. 한 회차에 한 장 |
| 촬영·결과 준비 중 카메라 해제·취소 | 계속(프레임은 이미 잡았다) |
| 결과 표시 중 카메라 해제 | 결과를 계속 보이고, 쿨타임 뒤 대기. 준비될 때까지 시작 무시 |
| 결과·쿨타임 중 취소 | 무시 |
| 결과 시간 종료 | 사진을 내리고 Object URL `revoke` 뒤 쿨타임 |
| 사진 만들기 실패·5초 초과 | 쿨타임 없이 대기. 작업에 abort, 실패 수만큼 자동 시작을 쉰다 |
| 촬영 순간 새 프레임 없음(정지 화면) | 촬영 실패. 끊김 판정(3초) 전이라도 `maxFrameAgeMs`(0.5초) 안에 새 프레임이 없으면 찍지 않는다 |
| 취소·초기화 뒤 늦게 끝난 사진 | 회차 식별자로 걸러 바로 정리 |
| 강제 초기화 | 사진·타이머 정리, 회차를 올려 진행 중 결과도 버리고 바로 대기 |

- **입구 하나:** `session.request(type, source)`가 `{ accepted, reason }`을 돌려주고, 무시한 요청은 D `ignored`. 출처(`'key'`·`'presence'`)는 회차의 `source`. 카메라 준비·페이지 보임은 `setCameraReady()`·`setPageVisible()`(`main.js`가 `camera.subscribe`·`visibilitychange`로 연결).
- **회차 식별자** `round`는 시작·강제 초기화마다 오른다. 결과는 회차가 같고 아직 `capturing`일 때만 보이고, 아니면 `releasePhoto()`.
- 카운트다운 숫자는 시작 시각 기준 1초마다(타이머가 늦어도 쌓이지 않음). 결과 종료 시계는 `startResultClock()` 한 곳에서 시작하고, 인쇄 연동 때 "출력 완료 확인" 시점으로 옮긴다.
- **쿨타임이 없는 경우:** 강제 초기화(운영자가 꼬인 진행을 풀거나 시험, 쿨타임 중이면 남은 쿨타임도 없앰)와 카운트다운 취소(사진을 찍지 않음). 쿨타임은 방금 찍힌 사람이 바로 다시 찍히는 것을 막는 장치다. 레벨 판정이라 `X` 직후에도 사람이 있으면 바로 새 회차가 시작된다 — **`X`는 중지 수단이 아니다**(`P`를 쓴다).
- **설정값:** 카운트다운·결과·쿨타임은 시간 설정(`config.timing` `countdownSeconds` 3, `resultMs` 10000, `cooldownMs` 5000 기본값 확정, `E` 시간 섹션, 아래 "시간 설정"). 운영자가 만지지 않는 값은 `config.session`: `captureTimeoutMs` 5000, `failureRetryMs` 5000, `failureRetryMaxMs` 60000(가안).
- 쿨타임(확정, 기본 5초)은 그동안 시작 요청을 무시하는 단순 대기다. 스윗스팟이 비었는지 보지 않으므로 계속 서 있는 사람은 쿨타임이 끝나는 즉시 다음 회차다(`presentHoldMs`는 추가 완충이 되지 않는다).
- 미리보기와 감지는 사이클 내내 돈다(쿨타임이 끝나는 순간의 인식 상태로 바로 판정).

### 실패와 취소 경계

- 촬영마다 `AbortController`를 새로 만들어 `takePhoto({ signal })`로 넘기고, 제한 시간 초과·강제 초기화 때 abort한다. `capture.js`는 abort되면 바로 실패하고 캔버스를 비우며, 효과 단계(`applyPhotoEffect(canvas, { signal })`)도 같은 신호를 받는다. 늦게 온 캔버스는 비우고 늦은 인코딩으로는 Object URL을 만들지 않는다.
- 취소된 회차의 작업이 끝나지 않았으면(`toBlob` 콜백이 안 오는 경우 등) 다음 `take()`는 `capture busy`로 바로 실패한다.
- **실패 뒤 자동 시작 대기:** 실패(예외, 시간 초과, 정지 화면, `capture busy`)마다 연속 실패 수를 세고 자동 시작을 `failureRetryMs`부터 두 배, 최대 `failureRetryMaxMs`(5→10→20→40→60초) 쉰다(`retryAt`). 끝나면 다시 평가하고, 성공하면 기록을 지운다. 이것이 없으면 "실패 → 대기 → 자동 시작"이 약 3초마다 반복된다. `S`는 쉬는 중에도 되고, `X`는 기록을 지우지 않는다.
- **D:** `failures`(연속 실패 수, 자동 시작까지 남은 시간), `last end`(실패 이유), `resources`(남은 Object URL·캔버스·`pending jobs`·인쇄 데이터).

### 시간 설정 (10단계)

`E` 시간 섹션(`ui/timing-tuning.js`)에서 조절하고 `config/timing.local.json`에 저장한다. 범위·정규화·저장 형식은 `config/timing-settings.js`, 기본값은 `config.timing`. 9단계까지 인식 섹션에 있던 반응 속도·카메라 회복 시간을 이리로 옮겨 **인식 섹션에는 시간 설정이 없다.**

| 묶음 | 항목 (`timingLimits`) | 기본값 | 범위 (단계) | 언제부터 쓰이나 |
|---|---|---|---|---|
| 촬영 흐름 | 카운트다운 `countdownSeconds` | 3초 | 1~10초 (1초), 가안 | 다음 회차 |
| | 결과 표시 `resultMs` (인쇄 연동 뒤에는 출력 완료 확인 후 리셋까지) | 10초 | 3~60초 (1초), 가안 | 다음 회차 |
| | 쿨타임 `cooldownMs` | 5초 | 0~30초 (0.5초), 가안 | 다음 회차 |
| 인식 반응 | 인식까지 `presentHoldMs` / 이탈까지 `absentGraceMs` | 0.25초 / 0.25초 | 0~2초 (0.05초) | 바로(감지 루프에 넣고 인식을 처음부터 다시 잰다) |
| 카메라 회복 | 재시도 `retryIntervalMs` · 첫 프레임 `firstFrameTimeoutMs` · 정지 `stallTimeoutMs` · 직원 문의 `staffNoticeMs` | 3 · 5 · 3 · 30초 | 1~30 · 2~30 · 1~10 · 5~300초 (0.5·0.5·0.5·1초), 가안 | 다음 재시도·첫 프레임 대기·정지 판정·안내 판정 (이미 걸린 타이머는 그대로) |

- **넣지 않은 값:** `captureTimeoutMs`(결과 만들기 제한 5초)·`failureRetryMs`·`failureRetryMaxMs`(실패 뒤 자동 시작 쉼)·`maxFrameAgeMs`(촬영 직전 정지 화면 검사 0.5초)·감지기 재생성 간격. 장애 대응용이라 운영 중에 만질 이유가 적고, 잘못 바꾸면 실패를 숨기거나 반복을 빠르게 한다.
- **회차 단위 적용:** 상태 기계(`core/session.js` `setTiming()`)는 회차가 시작될 때 촬영 흐름 값을 복사해 그 회차 끝(카운트다운·결과·쿨타임)까지 쓴다. 카운트다운 도중 길이가 바뀌어 숫자·진행선·셔터가 어긋나거나, 결과·쿨타임이 반쯤 다른 값이 되지 않게 한다. 스냅숏의 `countdownSeconds`는 그 회차의 길이(대기면 다음 회차의 길이)이고 관람객 화면 진행선이 이 값을 쓴다. 패널이 열려 있으면 자동 시작은 그대로 막힌다(`S`는 된다).
- **제약:** 정지 판정 하한(1초)은 촬영 직전 정지 화면 검사(`config.capture.maxFrameAgeMs` 0.5초)보다 길다. 범위 밖 값은 범위로 고치므로 파일에 짧은 값을 써도 깨지지 않는다(Node 테스트).
- **저장 형식** `{ "version": 1, "settings": { "countdownSeconds", "resultMs", "cooldownMs", "presentHoldMs", "absentGraceMs", "cameraRecovery": { "retryIntervalMs", "firstFrameTimeoutMs", "stallTimeoutMs", "staffNoticeMs" } } }`(2칸 들여쓰기, 정수). 숫자 아님·없음 → 그 항목만 기본값(알림), 범위 밖 → 범위로, 소수 → 정수로(알림). `cameraRecovery`가 통째로 없으면 알리지 않고 기본값(9-1 전 인식 파일에서 옮긴 값). 손상·버전 다름 → 전체 기본값.
- 저장·취소·"기본값으로"(시간 섹션 값만)·닫을 때 되돌리기·저장 중 닫기·저장 상태 표시는 다른 섹션과 같다(아래 "운영자 화면"). 실시간 줄은 진행 상태와 "다음 회차부터 적용"을 보인다. D `timing` 줄(촬영 구역): 다음 회차 값, 진행 중인 회차가 다른 값이면 `(this round countdown 5s)`, 반응·회복 시간, 출처.

**시작할 때 불러오기** (`settings-file.js` `loadInitialTimingSettings`, 끝날 때까지 D `timing` `(loading, …)`·자동 시작 `blocked: settings-loading`)

| 상황 | 쓰는 값 | D `timing` 출처 |
|---|---|---|
| 시간 파일 200 | 파일 값(형식이 틀리면 기본값, 파일은 그대로). 인식 파일에 옛 시간 키가 남아 있으면 읽지 않고, 그 키만 뺀다(정리) | `file` / `file (old timing keys removed from presence file)` / `defaults (file is invalid)` |
| 시간 파일 404 + 인식 파일에 옛 키(`presentHoldMs`·`absentGraceMs`·`cameraRecovery`) | 옛 값(촬영 흐름은 기본값)을 시간 파일로 옮기고(`PUT` → 다시 `GET`해 확인) **확인된 뒤에만** 인식 파일에서 그 키를 뺀다(다른 값은 그대로) | `migrated (presentHoldMs, absentGraceMs, cameraRecovery from presence file (removed from presence file))` |
| 위에서 시간 파일 쓰기·확인 실패 | 이번엔 옛 값, **인식 파일은 바이트 그대로**(다음 시작에 다시 옮긴다). 시간 섹션 "파일 값을 고쳐 사용 · 저장 필요"와 열 때 안내 | `presence file (… migration to timing file failed: HTTP 500)` |
| 옮긴 뒤 인식 파일에서 키를 빼지 못함(다시 읽기·쓰기 실패) | 옮긴 값(시간 파일이 있으므로 다음 시작에 옛 키는 무시되고 다시 빼 본다) | `migrated (… not removed from presence file: re-read failed: …)` 등 |
| 시간 파일 404 + 옛 키 없음 | 기본값(파일을 만들지 않음) | `defaults (no file)` |
| 시간 파일 읽기 실패·시간 초과(3초), 인식 파일 읽기 실패 | 기본값, 옮기지 않음 | `defaults (file read failed: …)` 등 |

- 옮긴 뒤 옛 키를 빼는 이유: 남겨 두면 운영자가 초기화하려고 시간 파일을 지웠을 때 옛 값이 말없이 다시 옮겨진다(9-1 좌우 반전 옮기기와 같은 이유). 시간 파일이 있으면 옛 키는 읽지 않으므로 두 번 적용되지 않는다.
- **옛 키 빼기는 최신 내용에서만 (10단계 검수 2):** 옮긴 직후와 시작할 때 정리 모두, 쓰기 직전에 인식 파일을 **다시 읽어** 그 내용에서 시간 키만 빼서 쓴다(앞서 읽은 전체 내용으로 덮어쓰지 않는다 — 옮기는 사이 운영자가 저장한 인식 값이 되돌아갔다). 다시 읽기가 실패하면 빼지 않는다(다음 시작에 다시). 서버 잠금·버전 관리는 두지 않는다: 다시 읽기와 쓰기 사이의 아주 짧은 구간에 인식 저장이 겹치면 그 저장이 덮일 수 있지만, 키오스크는 창 하나로 운영하고 패널은 불러오기가 끝난 뒤에만 열리므로 받아들인다.
- **값이 사라지지 않게 (10단계 검수 1):** 시간 값이 아직 시간 파일에 확인되지 않은 동안(옮기기 실패·시간 파일 읽기 실패·형식 오류) 인식 섹션을 저장하면, 저장 직전에 인식 파일을 다시 읽어 거기 남은 옛 시간 키를 그대로 붙인다(`settings-file.js` `presenceTextForSave`). 시작할 때 인식 로더·시간 로더 중 어느 읽기가 실패했든 옛 값이 지워지지 않는다(예전에는 인식 로더가 읽은 값만 써서, 그 읽기가 실패하면 옛 키가 지워졌다). 다시 읽기도 실패하면 시작할 때 본 옛 키를 쓰고, 그것도 모르면 저장하지 않는다("저장하지 못했습니다: could not check old timing keys …"). 시간 섹션을 저장하면 그 뒤로는 붙이지 않고 다음 시작에 정리된다.
- 인식 판정값과 시간 설정을 **둘 다** 불러와야 자동 시작한다(기본값으로 잠깐 판정하거나 기본 카운트다운으로 시작하지 않게). 4-3 전의 `localStorage` 인식 값에 있던 반응 시간은 옮기지 않는다(인식 파일로 옮길 때 판정값만 남는다).

### 운영자 단축키

수정 키(`Ctrl`·`Alt`·`Meta`) 없이 누른 한 키만(`main.js` `Keys`, `event.code`), 누르고 있을 때의 반복은 무시한다. 관람객 화면에 노출하지 않는다.

| 키 | 동작 |
|---|---|
| `D` | 개발용 정보·감지 박스 겹쳐 그리기 (`E`와 따로) |
| `E` | 운영자 조절 화면: 카메라·인식·시간·필터 섹션, 원본 창 (`Esc`로도 닫음, 아래 "운영자 화면", 3·4·5·6절) |
| `S` | 수동 촬영(`session.request('start', 'key')`). 대기·카메라 준비일 때만. 수동 회차는 사람이 없어도 끝까지 찍는다 |
| `X` | 강제 초기화(`session.request('reset', 'key')`) |
| `P` | 자동 촬영 일시정지·다시 켜기 |

- `Space`·`Enter`는 쓰지 않는다(패널 버튼 포커스와 겹침). `E`가 열려 있어도 `S`는 된다. `R`(인식 범위 조절 화면)은 9-2에 `E`의 인식 섹션으로 합쳐 없앴다(누르면 아무것도 하지 않는다).
- **`P`:** 판정은 `decideAutoRequest()`의 `paused` 하나. 멈추는 순간 인식으로 시작된 카운트다운을 취소하고(쿨타임 없이), 사람이 있어도 다시 시작하지 않는다. `S`와 수동 카운트다운은 그대로다. **저장하지 않아** 새로고침·재시작하면 다시 켜진다(해제를 잊어도 회복). 일시정지 중 영역 오른쪽 위에 "자동 촬영 일시정지 (P)"(`#pause-badge`, 3.6cqw 안쪽, 영역 폭의 1.7%, 가안, `config.showPauseIndicator`), D `auto` 줄 앞에 `PAUSED (P)`.

### 운영자 화면

`E` 패널(섹션 넷)·원본 창, `D`, `P` 표시, 인식 섹션 겹쳐 그리기. WISHFUL 시안에서는 아주 짙은 버건디 바탕에 금색 강조(선택한 섹션 밑줄·주 버튼·켠 스위치·눌린 조합)이고, 상태 색(초록·주황·빨강)은 그대로 작은 점·글자에만 쓴다(주황은 금색과 구분되게 `#eda15f`). 디자인 이유는 [로그 2026-10-19-03](logs/2026-10-19-03-stage6-operator-ui.md).

- **모양:** 차콜 반투명 패널(`--op-bg`), 1px 선, Pretendard 500·400, 숫자는 고정폭 오른쪽 정렬, 채도 낮은 상태 색은 점·글자·왼쪽 선에만, `color-scheme: dark`, 움직임·블러 없음(미리보기 성능). 크기는 `--op-size`(D는 `--op-dev-size`, 둘 다 `clamp(…vmin…)`)에 `em`으로 맞춰 해상도와 관계없이 같은 비율이고, 영역 안 요소는 `cqw`.
- **패널 하나 (`#operator-panel`, `ui/operator-panel.js`, 9-2):** `E`로 열고 닫는다(`Esc`·`닫기`로도). 머리(제목 "운영자 조절", "E·Esc 닫기 · 저장하지 않은 섹션은 닫을 때 취소", `위·아래`(`data-action="dock"`)·`닫기`) / 섹션 버튼 넷 `카메라`·`인식`·`시간`·`필터`(`[data-section]`, 밑줄 세그먼트, 섹션의 저장 상태 점: 저장 안 됨·고쳐 씀 호박색, 실패 빨강) / 보이는 섹션 하나(`.op-section`: 실시간 줄 `[data-live]` / 넘기는 몸통 — 묶음 `fieldset.op-group`, 줄 `.op-row` = 이름·도움말 · 조작 · 값·단위 / 늘 보이는 아래 — 저장 상태 `[data-state]`·섹션 `data-save`, 저장·취소·기본값, 알림 `[data-message]`).
- **섹션 = 파일 하나:** 카메라 `#camera-panel`(`camera-tuning.js`, `camera.local.json`) · 인식 `#tuning-panel`(`presence-tuning.js`, `presence.local.json`) · 시간 `#timing-panel`(`timing-tuning.js`, `timing.local.json`, 10단계) · 필터 `#effect-panel`(`effect-tuning.js`, `effect.local.json`). 섹션마다 저장 상태·저장·취소(저장된 값으로)·**기본값으로(그 섹션의 값만)**를 따로 가진다. 패널을 **닫으면 저장하지 않은 섹션만 되돌린다**(실행 중인 값 = 다시 시작했을 때의 값, 섹션마다 이 규칙을 그대로). 저장 중인 섹션이 있으면 그 섹션을 보이고 "저장이 끝나면 닫습니다" 뒤 닫는다. 이유: 파일이 섹션마다 따로라 저장·실패도 섹션마다 따로 일어나고, 한 섹션의 저장 실패나 변경이 다른 섹션의 저장된 값을 건드리지 않게 한다. 패널 전체 "모두 저장"은 두지 않는다(무엇이 저장되는지 섹션 점으로 보인다).
- **열기:** 네 조절값을 다 불러온 뒤에만 열린다(최대 약 3초). 처음은 카메라 섹션, 그 뒤엔 마지막으로 본 섹션(새로고침하면 다시 카메라 — 저장하지 않는다: 현장 PC를 다시 켰을 때 늘 같은 곳에서 시작). 열려 있으면 어느 섹션이든 자동 촬영을 막는다(4절 "자동 시작과 이탈 취소").
- **원본 창 (`#raw-window`, 9-2):** 카메라·인식 섹션이 보이는 동안 구석에 필터 없는 카메라 처리 경로 그림(보정·변환 적용, 9:16)과 감지 박스·인식 영역 점선을 띄운다(`raw-preview.js`를 작은 캔버스로, 감지 박스는 화면 좌표 그대로). 인식 섹션에서도 보이는 이유: 필터(회색조 유화)가 얼굴을 덜 보이게 해도 감지는 필터 전 그림으로 한다는 것을 박스와 함께 보여 준다. 시간·필터 섹션·패널 닫힘이면 그리지 않는다. 위치: 세로 화면은 9:16 영역 오른쪽 위(패널이 위면 아래, 왼쪽 위는 D 표), 옆에 패널이 서는 가로 화면은 패널 반대쪽 빈 곳 아래. "옮기기"는 두 자리(세로: 오른쪽·왼쪽, 가로: 아래·위)를 오간다. 마우스는 통과시키고(옮기기 버튼만 받음) 인식 섹션에서는 반투명이라 아래 영역 핸들을 보고 끌 수 있다. 크기는 창의 장치 화소(긴 변 최대 640), 그리는 빈도는 초당 30 이하(가안, `main.js` `RAW_WINDOW_MAX_PX`·`RAW_WINDOW_FPS`. 측정은 [로그 2026-11-02-02](logs/2026-11-02-02-stage9-operator-panel.md)). D `raw-window`.
- **필터 섹션 맨 위 시험 조합 (WISHFUL 시안):** 네 조합 버튼(`button[data-action="combo"][data-oil][data-mono]`, `aria-pressed`), 스위치 둘(`input[type=checkbox][data-key="oil"|"mono"]`), 안내 한 줄(`[data-combo-info]`: 지금 조합·흑백 방식·인쇄 데이터를 만드는지). 6절 "시험 조합".
- **묶음:** 카메라 = 장치(카메라 선택·목록, 해상도 + 받은 크기·지원 범위·"OBS 가상카메라는 자동 권장" 줄) / 방향·위치(좌우 반전, 회전 ↺·↻ 90° 버튼과 미세 회전, 확대, 가로·세로 이동) / 색 보정(밝기·대비·채도·감마·색온도·색조), 맨 위 "OBS 보정과 중복 적용 주의" 한 줄. 인식 = 영역 / 얼굴 크기(가이드 색 견본) / 신뢰도 / 현재값 JSON(접힘). 시간 = 촬영 흐름(카운트다운·결과 표시·쿨타임, 초, "다음 회차부터 적용") / 인식 반응(인식까지·이탈까지, 초, "바로 적용") / 카메라 회복(다시 시도 간격·첫 프레임 기다림·정지 판정·직원 문의 전환, 초). 필터 = 효과(강도·붓 크기·획 다시 그리기·색 보정·세부 보존 문턱) / 출력 단계(출력 모드·점 방식·용지 폭·밝기·대비·감마·흑백 스타일·질감 세기·선 간격) / 미리보기(초당 그림·처리 해상도). 쓰지 않는 항목은 흐리게 막힌다.
- **저장 상태 (`ui/save-state.js`, 문구 가안):** 바꾸는 중 `dirty`(저장 안 된 변경, 닫으면 취소)·`saving`·`failed`(파일은 이전 값, 다시 바꾸거나 저장 성공 때 풀림). 바꾸지 않았으면 불러온 결과: `saved`(파일에서 읽음·옮김·이번에 저장), `defaults`(파일 없음), `load-failed`(읽기 실패·시간 초과·형식 오류), `adjusted`(파일 값을 고쳐 씀·옮기지 못함 → 저장 필요). 저장할 것이 없으면 저장 버튼이 차분해진다(누를 수는 있다).
- **위치:** 세로 화면은 아래(기본)·위, 높이 `50vh`까지(얼굴이 있는 위쪽 절반을 가리지 않음). 9:16 옆 빈 폭에 26em이 들어가면 옆(기본 오른쪽, `위·아래`로 왼쪽). `main.js` `updateOperatorRoom`이 창 크기마다 재서 루트에 `.op-side-room`(1920×1080은 옆, 1200×1080은 아래·위).
- **선택자** `#operator-panel`·`[data-section]`, 섹션 `#camera-panel`·`#tuning-panel`·`#timing-panel`·`#effect-panel`, `input`·`select[data-key]`, `button[data-action]`, `[data-live]`·`[data-state]`·`[data-message]`·`[data-json]`·`[data-region-text]`·`[data-camera-info]`, `#raw-window`는 확인 도구·테스트가 쓰므로 바꾸지 않는다.
- **D (`#dev-info`, `ui/dev-panel.js`):** `main.js`가 정한 줄을 구역(카메라·인식·효과 · 출력·촬영)별 표로 보인다(구역 제목은 CSS `::before`라 글자에 없음). **`textContent`는 줄 글자 그대로**(줄 `\n`, 구역 사이 빈 줄)라 확인 도구가 읽는다. 색은 `devLineTone`(정상 초록·주의 주황·오류 빨강, 예: `status` ready/starting/그 밖, `detector` ok/retrying/fault, `effect` running/waiting/fallback, `photo-fx` applied/RAW, `auto` PAUSED, `failures` 0 아님). 왼쪽 위(옆 공간이 있으면 그 폭), 길면 휠로 넘기고, 인식 섹션이 보이는 동안은 마우스를 통과시킨다. 줄별 내용은 각 절에 적었다.
- **인식 섹션 겹쳐 그리기 (`main.js` `OVERLAY`·`drawPresenceOverlay`, 원본 창에도 같은 함수):** 편집 사각형(오프화이트 선·어두운 테두리, "인식 영역" 이름표, 핸들 영역 폭의 3.4%), 인식 영역 오프화이트 점선, 최소 얼굴 가이드 파랑 `#8fb6d6`·최대 붉은색 `#e0a39a`, 인정 얼굴 초록·제외 빨강(박스 위 점수, 중심 점). 선 굵기·글자는 영역 폭에 비례한다. D를 켜도 인식 영역과 감지 박스를 같은 색으로 그린다.

### 자동 시작과 이탈 취소

`core/auto-start.js`: 순수 판정 `decideAutoRequest()`를 연결부 `createAutoStart()`가 계기마다 불러 `session.request(..., 'presence')`를 보낸다. 인식 상태는 "인식됨 / 인식 안됨"만 받는다.

**레벨 판정 (확정):** 상태가 바뀌는 순간이 아니라 평가할 때의 상태로 정한다.

| 상태 기계 | 조건 | 요청 |
|---|---|---|
| `idle` | 일시정지 아님 + 조절값(인식·시간) 불러오기 끝남 + 인식됨 + 카메라 준비 + 페이지 보임 + `E` 패널 닫힘 + 촬영 실패 대기 아님 | `start` |
| `idle` | 하나라도 아님 | 없음. D `auto`에 이유(`blocked: auto paused (P)`·`settings-loading`, `idle, not present`, `blocked: camera-not-ready`·`page-hidden`·`tuning-open`·`capture-failed (retry wait)`) |
| `countdown` (출처 `presence`) | 일시정지 또는 인식 안됨 | `cancel`(일시정지면 `auto paused during countdown`) → 쿨타임 없이 대기 |
| `countdown` (출처 `key`) | 무엇이든 | 없음(수동 회차는 인식으로 취소하지 않음) |
| `capturing`·`result`·`cooldown` | 무엇이든 | 없음 |

- **평가 계기:** 인식 상태 변화, 상태 기계 알림(대기 진입, 카메라 준비·페이지 보임 변화), 조절 화면 닫기(`panel-closed`), `P`(`paused (P)`·`resumed (P)`), 조절값 불러오기 끝(`settings-loaded`). 카메라·페이지 값은 상태 기계 스냅숏을 쓴다(따로 구독하면 상태 기계보다 먼저 평가해 시작이 무시될 수 있다). 재진입하면 평가를 끝낸 뒤 한 번 더 한다.
- 이탈 유예는 따로 없다(`absentGraceMs` 기본 0.25초가 흡수). 취소 뒤에는 다시 "인식됨"(`presentHoldMs` 0.25초)이 되어야 새 회차가 시작된다.
- **셔터 직전 이탈:** 취소는 "인식 안됨"이 된 뒤에만 되므로, 셔터까지 남은 시간이 이탈 반응 시간(유예 + 감지 한 프레임 안팎)보다 짧을 때 떠나면 그대로 찍힌다. 셔터 순간에 인식을 따로 다시 확인하지는 않는다(실측·판단은 [로그 2026-10-27-01](logs/2026-10-27-01-presence-timing.md)).
- **조절 화면(`E`)이 열려 있으면** 어느 섹션이든 자동 시작을 막는다(운영자가 범위·카메라·효과를 맞추며 자기 모습을 보는데 자동 회차가 가린다. 결과 사진은 `S`로 본다). 열기만으로 진행 중인 회차를 취소하지는 않고, 닫을 때 사람이 서 있으면 바로 시작될 수 있다.
- **인식 조절값·시간 설정을 불러오는 동안**(최대 약 3초) 막는다. 불러온 값을 넣으면 기준이 바뀌어 인식을 처음부터 다시 잰다.
- **D:** `session`에 출처(`by presence`·`by key`), `auto`에 판정 이유·마지막 자동 시작·취소 시각과 계기(예: `entered idle (completed)`, `presence: absent`). 시작 직후 한 번은 이전 계기가 보이고 다음 갱신(0.5초)에 바뀐다.
- "곧 촬영해요" 같은 인식 문구는 두지 않는다(바로 카운트다운으로 넘어간다).

### 출력 연동 시 참고 흐름 (이후)

참고 프로젝트 방식: ① 결과 화면에 들어가면 로컬 인쇄 서비스에 출력 작업 요청(요청 ID 포함) ② 확인 전까지 "출력 중"을 보이고 종료 시계를 멈춤 ③ 작업 상태(`queued`/`processing`/`succeeded`/`failed`)를 짧은 간격으로 조회 ④ `succeeded`이고 드라이버 전송이 확인되면 10초 종료 시계 재개 ⑤ 실패·시간 초과면 직원 문의 안내, **자동 재출력 없음**, 종료 시계는 재개 ⑥ 끝난 회차의 늦은 응답은 무시. "출력 인식"은 용지 배출이 아니라 드라이버 전송 완료라 프린터 종류에 따라 다시 확인한다. 넘길 데이터는 사진의 `print`(6절)이고, Blob 소유권·해제 시점과 회차 식별자 연결은 그때 정한다.

## 5. 촬영 시작 인식

목적은 신원 식별이 아니라 **스윗스팟에 촬영 대상이 있는지**다. 발자국 매트로 위치·거리(약 2m 이내)가 고정되므로 조건을 단순하게 둔다. 감지기는 MediaPipe Face Detector(short-range, 정면·랜드마크 불필요)이고, 얼굴 누락이 잦으면 Object Detector(`person`)·Pose Landmarker를 비교한다. 프레임 변화량만으로 사람을 가린다고 가정하지 않는다. 아이 키·고개 돌림은 실측이 필요하다.

### 얼굴 감지와 인식 상태

```text
camera-monitor (ready·페이지 보임) ──▶ presence-monitor 감지 루프 (최대 15fps)
  <video> ─카메라 처리 경로(drawFrame)─▶ 9:16 화면 영역 캔버스(360×640) ─▶ face-detector.detect()   박스·점수 (= 화면 좌표)
                                                     ─▶ presence.classifyFaces()   얼굴별 인정 여부
                                                     ─▶ presence.stepPresence()    시간 안정화 ─▶ isPresent() / subscribe({ present })
```

**감지기 (`face-detector.js`)**

- bundle을 동적 `import`로 불러온다(실패한 적이 있으면 `?retry=N`을 붙인다. Chrome이 실패한 `import()`를 기억하기 때문). 성공한 모듈은 재생성 때도 쓴다. `delegates` 순서(`GPU` → `CPU`)로 만든다. 실패해도 미리보기는 계속된다.
- **사전 확인** (실패하면 로더·wasm·통계 타이머를 아예 만들지 않음): ① 1×1 `OffscreenCanvas`에 `webgl2`/`webgl`을 만들어 보고(없으면 `webgl-unavailable`) 바로 놓는다. 렌더러 이름을 D에 보이고, 소프트웨어 렌더러(SwiftShader·Basic Render Driver)는 `(software)` 표시와 콘솔 경고 1줄(`[webgl] software WebGL renderer: ...`)만 — **장애가 아니다**. ② 모델의 HTTP 상태(`model-unavailable`), 크기 `modelBytes`·SHA-256 `modelSha256`(`model-invalid`). 기준값은 `tools/vendor-mediapipe.mjs`의 기록과 같아야 한다(`test/vision/face-detector.test.mjs`가 실제 파일과 대조). 통과한 바이트를 기억해 복사본을 `baseOptions.modelAssetBuffer`로 넘긴다.
- **실패한 생성의 정리:** MediaPipe 1.1.1은 생성마다 wasm 로더 `<script>`를 붙이고 지우지 않으며, 60초 통계 `setInterval`을 모델 설정 전에 만들고 실패해도 닫지 않는다. 그래서 시도마다 WebGL 캔버스를 직접 만들어 넘기고(실패하면 컨텍스트를 놓음), 생성하는 동안만 `setInterval`을 감싸 번들(`vision_bundle.mjs`)이 **직접** 만든 60초 타이머만 기록했다 실패하면 지우고, 끝난 로더 `<script>`를 지운다. 이미 있던 같은 URL 로더와 시도가 겹친 동안의 타이머는 건드리지 않는다. 버전을 올리면 이 동작을 다시 확인한다([로그 10](logs/2026-10-15-10-stage4-detector-health.md)).
- 원인 코드(`DetectorFault`): `bundle-load-failed`, `model-unavailable`, `model-invalid`, `webgl-unavailable`, `create-failed`, 실행 중 `webgl-context-lost`, `detect-failing`.
- `detectorMinConfidence` 0.3으로 낮게 두고 신뢰도는 `presence.minScore`로 거른다(감지기를 다시 만들지 않고 조절). 결과는 `{ x, y, width, height, score }[]`(감지 입력 기준 0~1, 왼쪽 위 원점, 반전 전).
- WebGL이 아예 없으면 CPU delegate도 매 프레임 실패하므로 사전 확인에서 멈춘다. 실행 중 `webglcontextlost`면 15회 실패를 기다리지 않고 바로 버린다. 감지기를 닫을 때 컨텍스트를 놓는다.
- Chrome 155 관찰: `--disable-gpu`만으로는 소프트웨어 렌더러로 감지가 계속되고, `--disable-webgl`은 `OffscreenCanvas`를 끄지 못한다. WebGL이 완전히 없어지는 것은 `--disable-gpu --disable-software-rasterizer`와 `--use-gl=disabled`.

**판정 (`presence.js`)**

- 모든 판정·영역·겹쳐 그리기는 **화면 좌표**(9:16 영역 기준 0~1, 관람객이 보는 그대로)다. 9-1부터 감지 입력이 카메라 처리 경로(색 보정·반전·회전·확대·이동, 3절)를 거친 화면 영역 그대로라 감지 박스가 곧 화면 좌표다(`STAGE_MAPPING`). 화면 밖(cover로 잘리거나 확대·이동으로 밀려난 부분)의 얼굴은 감지기가 보지 않는다. 옆으로 세운 카메라도 회전한 뒤 넣으므로 감지기는 똑바로 선 얼굴을 본다. 변환이 없을 때의 결과는 예전 cover·반전 계산(`computeCoverMapping`·`videoBoxToStage`)과 같다(Node 테스트).
- 얼굴 인정(경계 포함): 박스 중심이 `region` 안(폭이나 높이가 양수가 아닌 빈 영역은 어떤 점도 담지 않는다, `isPointInRegion`), 박스 높이(영역 높이 대비)가 `minFaceHeight` 이상·`maxFaceHeight` 이하(큰 오검출 박스를 거른다), 점수 `minScore` 이상. 인정 얼굴이 1명 이상이면 그 프레임은 "있음".
- 처음은 인식 안됨. "있음"이 `presentHoldMs` 동안 끊기지 않으면 인식됨, "없음"이 `absentGraceMs` 동안이면 인식 안됨. 반대 프레임이 하나라도 나오면 처음부터. 감지 프레임이 올 때만 판정한다(15fps면 최대 약 67ms 늦음). 시간은 첫 반대 프레임부터 재므로 기본 250ms는 15fps에서 첫 반대 프레임 + 4프레임(약 267ms)에 바뀌고, "없음" 4프레임 연속(약 200ms)까지의 누락은 흡수한다.

**감지 루프 (`presence-monitor.js`)**

- 카메라 `ready`·페이지 보임·영상 크기 0 아님일 때만 돌고, 아니면 `paused`로 멈추고 인식 안됨으로 되돌린다.
- 누적 프레임 수가 그대로면 감지를 건너뛴다(D `faces` `same-frame skips`). 판정 기준이 `setSettings()`로, 카메라 기하 설정(반전·회전·확대·이동)이 `setCameraGeometry()`로 바뀌면 인식 상태를 처음으로 돌리고 바로 "인식 안됨"을 알린다(값이 같으면 그대로, D `criteria resets`).
- 입력은 9:16 화면 영역을 긴 변 `inputMaxSize`(640)로 그린 캔버스(360×640, 영상 크기·비율과 관계없이). 그리는 함수는 `main.js`가 넘기는 `drawFrame`(`camera-frame.js` `draw`, 색 보정 포함). 간격은 `1000 / maxFps`에서 처리 시간을 뺀 값, `detectForVideo` 타임스탬프는 `max(performance.now(), 직전 + 1)`.
- 실패한 프레임은 "없음". 15번 연속 실패(약 1초)면 감지기를 버린다. 시계·타이머·document를 주입할 수 있다(테스트용).
- 상태(`DetectorStatus`): `loading`, `running`, `paused`, `error`(감지기 없음). 인식 알림은 감지 한 번 안에서 나가므로 그 안에서 읽어도 `running`이다.

**재생성 (`detector-keeper.js`)**

- 간격 `detectorRetryMs` 15초부터 연속 실패마다 두 배, 최대 `detectorRetryMaxMs` 300초(15·30·60·120·240·300…, 가안). 생성은 메인 스레드를 약 1초 막으므로 짧게 두지 않는다.
- 연속 실패 수는 생성 실패와 버림을 함께 세고, 그 감지기로 감지가 한 번 성공해야(`markHealthy`) 0이 된다. 버릴 때는 `close()`(실패해도 버림).
- 감지기가 없을 때 카메라가 다시 준비되거나(한 번 준비된 적이 있는 카메라) 페이지가 다시 보이면 바로 만든다. **`fault`에서는 앞당기지 않는다.** 생성은 한 번에 하나이고, 감지기가 없는 동안은 인식 안됨이다.

### 감지기 상태와 장애 안내

| `DetectorHealth` | 뜻 |
|---|---|
| `starting` | 실패한 적 없이 만드는 중(시작 직후) |
| `ok` | 감지기가 있다(쉬는 중 포함) |
| `retrying` | 실패했고 다시 만들기를 기다리거나 만드는 중 |
| `fault` | 장애: `webgl-unavailable`·`model-invalid`는 첫 실패부터, 그 밖은 연속 `detectorFaultAfterFailures`(3회, 가안)부터. 재시도는 계속한다 |

- **경계:** 촬영 쪽은 `createPresenceMonitor()`의 `isPresent()`·`subscribe(listener)`(등록 즉시 한 번, 그 뒤 바뀔 때 `{ present }`, 해제 함수 반환)와 `getDetectorHealth()`·`subscribeDetector(listener)`(`{ health, cause, since }`, `since`는 감지기가 없게 된 시각 또는 `null`)만 쓴다. `getDebugSnapshot()`은 D·운영자 화면 전용, `setSettings()`는 인식 섹션 전용.
- **관람객 안내 (`guidance.js`):** 카메라 `ready`·감지기 `ok`면 문구 없음. 하나라도 아니면 "준비 중입니다. 잠시만 기다려 주세요." `staffNoticeMs`(30초) 이상이거나 카메라 `unsupported`·`permission-denied`, 감지기 `fault`면 "준비 중입니다. 직원에게 문의해 주세요." 시간은 둘 중 하나라도 쓸 수 없게 된 때부터 이어서 재고, 둘 다 정상이면 처음으로.
- 감지기를 쓸 수 없으면 인식 표시와 대기 안내를 숨긴다. 쿨타임 문구는 안내 문구가 없을 때만. **`S`는 감지기 장애 중에도 된다**(상태 기계는 카메라만 본다). 회차 진행 중에는 안내 문구를 숨기고 대기에서 다시 보인다.
- **D:** `detector : <루프 상태>, health <상태> / <원인> (<원인 설명>)`(예: `webgl-unavailable` "하드웨어 가속 꺼짐 또는 WebGL 없음", `model-invalid` "모델 파일 손상 (크기·SHA-256 불일치)"), 정상이 아니면 `failure`·`retry`(연속 실패, 시도 수, 다음 재시도 또는 `creating now`, 쓸 수 없던 시간). `webgl`, `model`(`sha256 ok`), `guidance`, `delegate`, 감지·그리기 시간, 감지 빈도·입력 크기, 얼굴·인정 수, 안정화 진행(`-> present 343/500ms`), 현재 기준값과 출처(`settings : file`·`migrated`·`localStorage`·`defaults (이유)`·`saved`·`loading`, `+ unsaved changes`), 얼굴별 점수·높이·중심·제외 이유(`region`·`small`·`large`·`score`), 감지 오류 수. 인식 섹션 실시간 줄은 루프 상태(`loading`·`running`·`paused`·`error`)를 쓴다.

### 설정값 (`config.js`)

| 값 | 기본값 | 뜻 |
|---|---|---|
| `faceDetection.delegates` | `['GPU', 'CPU']` | 시도 순서 |
| `faceDetection.detectorMinConfidence` | 0.3 | 감지기 자체 기준 |
| `faceDetection.maxFps` / `inputMaxSize` | 15 / 640 | 감지 최대 빈도 / 입력 긴 변 px (가안) |
| `faceDetection.modelBytes` / `modelSha256` | 229746 / `b4578f35…0152f` | 모델 사전 확인 (전체 해시는 아래) |
| `faceDetection.detectorRetryMs` / `detectorRetryMaxMs` | 15000 / 300000 | 재시도 첫 간격 / 상한 (가안) |
| `faceDetection.detectorFaultAfterFailures` | 3 | 장애로 보는 연속 실패 수 (가안) |
| `presence.region` | `{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }` | 인식 영역 (화면 좌표) |
| `presence.minFaceHeight` / `maxFaceHeight` | 0.185 / 0.47 | 얼굴 높이 / 영역 높이의 최소·최대 (개발 PC 저장값) |
| `presence.minScore` | 0.65 | 최소 신뢰도 (개발 PC 저장값). 실제 얼굴 0.85~0.95, 가짜 카메라 오검출 최고 0.663이라 영역·크기가 함께 거른다([로그 07](logs/2026-10-19-07-saved-defaults.md)) |
| `timing.presentHoldMs` / `absentGraceMs` | 250 / 250 | 인식됨·인식 안됨까지 유지 시간 (사용자 결정 2026-10-27, [로그 2026-10-27-01](logs/2026-10-27-01-presence-timing.md)). 10단계부터 시간 설정(4절 "시간 설정") |
| `timing.cameraRecovery` | 재시도 3000 / 첫 프레임 5000 / 정지 3000 / 직원 문의 30000 | 카메라 회복 시간 ms (3절). 10단계부터 시간 설정 |
| `showPresenceIndicator` / `showPauseIndicator` | `true` / `true` | 인식 표시 선 / `P` 운영자 표시 (가안) |
| `settingsFile.url` / `timeoutMs` | `/local-api/presence-settings` / 3000 | 인식 조절값 파일 API, 읽기·쓰기 제한 (가안) |

`presence.*`는 기본값이고 `E` 인식 섹션에서 저장한 값이 있으면 그 값이다. 감지 루프에는 인식 섹션의 판정값과 시간 섹션의 반응 시간을 합쳐 넣는다(`main.js` `presenceSettingsFor`). 판정은 매 프레임 현재 설정을 읽어 다음 감지부터 반영된다.

**사진 틀 안으로 (IMPRINT에서 도입):** 감지 루프에 넣는 인식 영역은 운영자가 정한 영역과 사진 틀(3절 "화면 배치", 화면 높이 8/64~53/64, 14단계)의 겹친 부분이다(`core/photo-frame.js` `clipRegionToFrame`). 얼굴 중심이 틀 밖(위·아래 여백)이면 찍혀도 사진에 얼굴이 없으므로 인정하지 않는다. 틀과 전혀 겹치지 않거나 틀 끝에 맞닿기만 한 영역은 높이 0이 되고, 빈 영역은 그 선 위의 얼굴도 인정하지 않는다(독립 검수 P2: 경계 포함 판정이 높이 0 선 위의 얼굴을 인정해 틀 밖 영역으로 인식됨이 되던 것을 막음). 저장하는 값(`presence.local.json`)과 인식 섹션 편집 사각형은 운영자가 정한 영역 그대로이고, D `criteria` 줄은 줄인 영역에 `(clipped to photo frame)`, D `frame` 줄에 틀 줄·줄였는지. 기본 영역(0.1~0.9)은 0.156~0.859로 줄어든다(IMPRINT 틀에서는 0.109~0.8125). D 겹쳐 그리기·원본 창·인식 섹션에는 사진 틀 위·아래 줄(호박색 점선)이 보인다. 좌표계는 바뀌지 않는다(감지 입력 = 9:16 화면 영역, 틀은 그 안의 줄 범위).

### 인식 범위 조절

`E` 운영자 화면의 인식 섹션(마우스·키보드 사용, 9-2 전에는 `R`). 불러오기가 끝나기 전에는 열리지 않는다. 인식 섹션이 보이는 동안 편집 사각형, 감지 박스, 얼굴 크기 가이드(영역 가운데 최소·최대 정사각형)가 보이고, 다른 섹션으로 가거나 닫으면 숨는다(인식 표시·대기 안내는 원래대로).

| 항목 (`presenceLimits`) | 조작 | 범위 |
|---|---|---|
| 영역 `region` | 안을 끌어 이동, 8개 핸들로 크기 | 9:16 안, 폭·높이 0.1 이상 |
| `minFaceHeight` / `maxFaceHeight` | 슬라이더 0.005 단위, 서로를 넘지 못함 | 0.01~1 |
| `minScore` | 0.01 단위 | 0.3~1 (하한 = 감지기 자체 기준) |

- 반응 속도(인식까지·이탈까지)와 카메라 회복 시간은 10단계부터 **시간 섹션**이다(4절 "시간 설정"). 펼쳐진 묶음이고(2026-10-27 전에는 "고급" 접힘 안) 초로 보인다. 예전 상한(5000)까지의 값은 불러올 때 2000으로 고친다(`adjusted`).
- **저장 파일이 기본값보다 우선한다.** 기본값을 바꾼 뒤에도 그 PC에 예전 값(예: 500/1000)이 저장돼 있으면 그 값으로 돈다. 새 기본값을 쓰려면 시간 섹션 "인식 반응"을 옮기고 다시 저장한다("기본값으로"는 시간 섹션의 다른 항목도 기본값으로 바꾼다).

- 끌기는 시작 위치 대비 이동량, 반대쪽 변 고정. `window`에서 포인터를 받아 영역·화면 밖에서도 이어지고, `pointerup`·`pointercancel`·`blur`·`lostpointercapture`·주 버튼이 떼어진 이동(`(buttons & 1) === 0`, 그 이동은 무시)·화면 닫기로 끝나며 리스너를 모두 푼다(`region-drag.js`).
- **즉시 반영**(`setSettings()`)되고 인식을 다시 잰다(인식으로 시작된 카운트다운은 취소된다).
- **저장**해야 `config/presence.local.json`에 남는다(서버 필요). 형식 `{ "version": 1, "settings": { "region": {...}, "minFaceHeight", "maxFaceHeight", "minScore" } }`(2칸 들여쓰기). 9단계까지의 파일에 있는 `presentHoldMs`·`absentGraceMs`·`cameraRecovery`는 여기서 읽지 않고 알리지도 않으며, 시간 설정이 처음 읽을 때 옮긴다(4절 "시간 설정"). 저장 중에는 버튼을 막고 "저장 중...", 204여야 저장으로 인정. 실패(서버 없음·거절·3초 초과)면 "저장하지 못했습니다: HTTP 500 (...)" 같은 이유를 보이고 저장 안 된 상태로 남는다. 누른 순간의 값만 저장한다.
- **저장 중 닫기**(`E`·`Esc`·닫기)는 응답(최대 3초) 뒤 닫으면서 파일에 마지막으로 저장된 값으로 맞춘다("저장 중입니다. 저장이 끝나면 닫습니다.").
- **취소**는 마지막 저장값(없으면 기본값), **기본값으로**는 `config.presence`(영역·얼굴 크기·신뢰도만, 저장해야 유지). **저장하지 않고 닫으면 저장된 값으로 되돌린다** — 실행 중 값과 재시작 값이 늘 같게. 확인 창 대신 "저장하지 않은 변경이 있습니다 (닫으면 취소됩니다)"를 늘 보인다.
- **현재값 JSON**: 저장 형식 그대로 보이고 "복사"(실패하면 선택만). 불러오기 기능은 없다. 파일을 지우면 기본값, 직접 고친 범위 밖 값은 불러올 때 고쳐진다.

**시작할 때 불러오기** (`settings-file.js` `loadInitialPresenceSettings`, 끝날 때까지 D `settings` `loading`·자동 시작 `blocked: settings-loading`)

| 상황 | 쓰는 값 | D `settings` |
|---|---|---|
| 파일 200 | 파일 값(형식이 틀리면 기본값, 파일은 그대로) | `file` / `defaults (file is invalid)` |
| 파일 404 + `localStorage`(`photobooth.presence.v1`)에 값 | 파일로 옮기고(`PUT` → 다시 `GET`해 확인) `localStorage` 키를 지운다 | `migrated (from localStorage (removed))` |
| 위에서 옮기기 실패 | 이번엔 `localStorage` 값, 지우지 않아 다음에 다시 옮김 | `localStorage (migration to file failed: ...)` |
| 파일 404 + `localStorage` 없음·깨짐 | 기본값(파일을 만들지 않음) | `defaults (no file)` |
| 읽기 실패·시간 초과(3초, 본문이 멈춰도 같은 제한) | 기본값, 옮기지 않음 | `defaults (file read failed: timeout 3000ms)` 등 + 콘솔 경고, 패널에도 |

- 옮긴 뒤 `localStorage`를 지우는 이유: 남겨 두면 운영자가 초기화하려고 파일을 지웠을 때 옛 값이 다시 옮겨진다. 앱은 `localStorage`에 쓰지 않는다. 프로필과 무관하게 같은 값을 쓴다.
- **검증** (`parseStoredPresenceSettings`, `normalizePresenceSettings`, 예외 없음): 손상 JSON·객체 아님·`version` ≠ 1·읽기 실패 → 전체 기본값(형식이 바뀌면 키와 버전을 함께 올린다). 숫자 아님·없음 → 그 항목만 기본값. 범위 밖 → 범위 안으로. 영역 형식 오류 → 영역만 기본값, 9:16 밖·크기 이상 → 0.1~1로 맞춘 뒤 안으로 옮김. 최소 > 최대 → 최대를 최소에. 반올림: 영역 4자리, 크기 3자리, 신뢰도 2자리, 시간 정수. 고친 내용은 콘솔·D `settings`·패널(한 번)에 보이고 파일은 다시 저장할 때까지 그대로.

### 다인원과 성능

- 시작 조건은 "영역 안에 한 명 이상"(가안)이고 카운트다운 중 합류할 수 있다. MediaPipe는 다인원에서 좌표 스무딩이 안 되는 문제가 있었지만, 좌표를 화면에 계속 그리지 않으므로 판정 단계의 시간 필터(유지·유예 시간)로 대신한다. 좌표가 연출에 필요해지면 다시 검토한다.
- 감지는 메인 스레드에서 돌므로 4K를 그대로 넣지 않고 15fps·긴 변 640으로 쓴다(부족하면 Worker 분리 검토). 개발 PC에서 감지 한 번은 수 ms, 미리보기 60fps를 유지하고, 시작할 때 감지기 생성으로 약 1초 긴 작업이 한 번 생긴다([로그 05](logs/2026-10-15-05-stage2-face-presence.md)·[13](logs/2026-10-15-13-stage4-browser-check-soak.md)). 현장 PC에서 다시 잰다.

### MediaPipe 로컬 라이브러리

| 항목 | 내용 |
|---|---|
| 패키지 | `@mediapipe/tasks-vision` **1.1.1** (`devDependencies` 정확 버전, `package-lock.json` 커밋) |
| 위치·서버 경로 | `lib/mediapipe/tasks-vision/`(`vision_bundle.mjs`, `wasm/`, `LICENSE` Apache-2.0), `lib/mediapipe/models/blaze_face_short_range.tflite` → `/lib/mediapipe/...` |
| 모델 | float16, 버전 `1`, 출처 `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`, SHA-256 `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| LICENSE | npm 패키지에 없어 `google-ai-edge/mediapipe` `v1.1.1` 태그 커밋(`50505c8312c7eacb1bd411cecdc4cc9fd08d53cb`)에서 받는다. SHA-256 `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8` |
| wasm | SIMD면 `vision_wasm_internal.*`, 아니면 `vision_wasm_nosimd_internal.*`(`FilesetResolver.forVisionTasks()`가 고름). 둘 다 두고 `vision_wasm_module_internal.*`·`.cjs`·`.map`·`.d.ts`는 복사하지 않는다 |
| 크기 | 약 27.2MB (최대 `vision_wasm_internal.wasm` 13.5MB, GitHub 100MB 제한 이내) |

```js
import { FilesetResolver, FaceDetector } from '/lib/mediapipe/tasks-vision/vision_bundle.mjs';
const fileset = await FilesetResolver.forVisionTasks('/lib/mediapipe/tasks-vision/wasm');
const detector = await FaceDetector.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: '/lib/mediapipe/models/blaze_face_short_range.tflite', delegate: 'GPU' },
  runningMode: 'VIDEO',
});
```

**갱신 (개발 PC 전용, Node 18 이상):** ① `npm install --save-dev @mediapipe/tasks-vision@<버전>`(`save-exact=true`) ② `tools/vendor-mediapipe.mjs`의 LICENSE URL(새 태그 커밋)과 SHA-256을 고친다(모델을 바꿀 때도 URL·해시) ③ `npm run vendor:mediapipe`(`tasks-vision/`를 비우고 다시 채움, 해시가 다르면 실패, 맞는 모델은 다시 받지 않음, `models/`의 관리 밖 파일은 지움) ④ 통계·생성 실패 정리 동작, 로딩·외부 요청·CSP 위반을 다시 확인하고 `lib/mediapipe/`·`package.json`·`package-lock.json`을 커밋한다.

**사용 통계 전송:** `tasks-vision` 1.0.0부터(0.10.35 이하에는 없음) 태스크를 만들면 항상 켜지는 로거가 태스크 종류·실행 모드·OS·버전·처리 횟수·시간 통계를(이미지·좌표를 넣는 코드는 보지 못함, 실제 전송 내용은 해독하지 않음) 생성 후 60초마다와 `close()` 때 `https://odml.pa.googleapis.com/v1/log`로 POST한다. 끄는 옵션이 없어 CSP로 막는다(1절). 버전을 올리면 다른 외부 연결이 생겼는지 다시 본다.

## 6. 사진 처리

- 캡처 이미지와 인쇄 데이터는 현재 회차 결과 표시용으로만 메모리에 두고 대기 복귀·회차 종료 때 정리한다. 파일·브라우저 영구 저장소·서버·Git에 저장하지 않고 로그에 사진·얼굴 데이터를 넣지 않는다. 인쇄 서비스로 넘기는 방식과 임시 파일 정책은 인쇄 범위에서 정한다.

### 캡처와 결과 이미지

`camera/capture.js`의 `createCapture().take()`:

0. **확인:** 이전 작업이 남아 있으면 `capture busy`, 마지막 새 프레임이 `config.capture.maxFrameAgeMs`(500ms, 가안)보다 오래면 `stale frame`으로 캔버스를 만들기 전에 실패.
1. **프레임 잡기(동기):** 셔터 순간의 카메라 설정으로 카메라 처리 경로(3절, `camera-frame.js` `draw`: 색 보정·반전·회전·확대·이동)를 거친 9:16 화면 영역을, 화면이 덮는 원본 화소 수(`captureSizeFor`)의 캔버스에 그린다(변환이 없으면 OBS 1080×1920 → 1080×1920, 2160×3840 → 그대로, 가로 1920×1080 → 608×1080, 확대 2면 절반). 캔버스 생성 뒤 어디서 실패해도 비우고 실패.
2. **사진 효과:** `effect(canvas, { signal, takenAt })` 경계에 `photo-effect.js`의 `apply`. 셔터 순간 미리보기와 같은 그림을 결과 크기로 새 캔버스에 그린다. `{ canvas, type?, print, dots? }`를 돌려주면 그 형식으로 인코딩하고 사진 `{ url, width, height, print, dots, takenAt }`에 인쇄 데이터를 붙인다(`dots` = 1비트 점 사진). `takenAt`은 프레임을 잡는 순간의 `Date.now()`(`clock`)이고 인쇄 쪽 머리와 관람객 화면 머리가 같은 값을 쓴다.
2.5. **사진 틀 (IMPRINT에서 도입):** 효과 단계의 마지막에 화면용 사진(9:16 전체)을 `config.photoFrame` 줄로 잘라 새 캔버스로 남긴다(1080×1920 → **1080×1350**, 14단계 240~1590줄. 효과를 끈 원본 캡처 2160×3840이면 480~3180줄). 어느 경로(효과·원본 대체·감열지·회색조·끔)든 같은 한 곳(`photo-effect.js` `framed`)이다. 자르기 캔버스를 만들지 못하면 9:16 그대로 두고 경고하며, 관람객 화면은 `object-position`으로 같은 줄을 보인다. D `photo-fx`는 효과 그림 크기(9:16)와 `, frame 1080x1350 rows 300-1650`, `capture`는 자른 크기.
3. **인코딩:** `canvas.toBlob()`, 기본 `config.capture` `image/jpeg` 품질 0.92(가안). 감열지는 `image/png`.
4. **정리:** 성공·실패·취소 모두 캔버스 크기를 0으로. 결과는 `URL.createObjectURL(blob)`로만 들고 `release(photo)`가 `revokeObjectURL`과 인쇄 데이터 해제를 한 번만 한다. `release`는 결과 종료·강제 초기화·늦은 결과 폐기 때 불린다.

- D `capture`(결과·원본 크기, 회전·실제 배율(`auto`)·색 보정했으면 `color`·반전했으면 `mirrored`, 형식·용량, 시간)·`resources`(Object URL·캔버스·인쇄 데이터 수 — 대기 상태에서 0).

### 사진 효과(유화 · 획)

필터 **"유화 · 획 (세부 보존)"**을 WebGL2로 실시간 미리보기하고 촬영 결과도 같은 그림으로 만든다. 기본 출력은 **회색조 유화**(아래)이고 감열지·회색조·컬러는 `E`에서 고르는 모드다.

- **결과 크기는 짧은 변 1080**(9:16이면 1080×1920). 4K 입력은 효과 전에 1080 기준으로 줄인다.
- **처리 해상도 기본 0.5**(결과 대비). 결과는 늘 1080으로 다시 그리므로 미리보기가 조금 부드러울 수 있다(1이면 화소까지 같다).
- **느린 PC**(D `effect`의 초당 그림이 설정보다 적거나 화면이 끊기면): **먼저 `fps`, 그다음 처리 해상도**를 낮춘다. 그리기 시간은 대부분 획 목록 만들기(CPU, 그림마다 바뀌는 획 정렬·전체 약 33만 개를 GPU로 올림)라 해상도로는 거의 줄지 않는다. 개발 PC 기본값은 화면 60fps·감지 15fps·12장/초, 긴 작업 없음([로그 07](logs/2026-10-19-07-saved-defaults.md), 해상도·fps별 [로그 2026-10-16-02](logs/2026-10-16-02-stage5-oil-effect-port.md)).

**출처와 라이선스**

- 원본: **같은 팀 동료가 만든 필터 갤러리** `https://nau-filter-gallery.vercel.app/`(사용자 지정)의 프리셋 `oil2f`. 배포 페이지 HTML 한 파일(92,403바이트, SHA-256 `c0020911aea7bdcb…0d739a77`, 2026-10-16 받음)에서 이식했다(원본 소스 저장소는 받지 못함, HTML은 저장소에 넣지 않음). 원본이 바뀌면 다시 받아 합성 시험 이미지·같은 매개변수·seed로 화소 비교한다. 원본 저장소를 받으면 그쪽이 기준이다.
- **라이선스 표기 없음**(본문 문구 없음, `LICENSE`·`LICENSE.md`·`license.txt` 404, 페이지의 MIT 언급은 수채 v4 MNPR 출처라 무관). 사용 권한은 확인 중(PROJECT TBD).
- 기법: Hertzmann 1998 "Painterly Rendering with Curved Brush Strokes of Multiple Sizes"(큰 붓 → 작은 붓, 원본과 많이 다른 곳에만 가는 붓). 셰이더 `hash12`는 Dave Hoskins "Hash without Sine"(MIT)과 같은 식이다. 이식 파일 머리말(`core/oil-paint.js`, `config/effect-settings.js`, `effect/oil-shaders.js`, `effect/oil-renderer.js`)에 출처를 적었다.
- 이식 범위: `PRESETS.oil2f` → `renderDrawing` → `needFlow` 흐름장 → `paintStrokes`(`sbr: 1`), `makeStrokes`, `ihash`, `currentTick`만. 다른 프리셋(`akf`·수채·드로잉·로토스코핑), `split`, `flick`, 스틸·MP4 내보내기, `localStorage`, 쓰지 않는 셰이더 분기(`uMedium` 2~5)·함수(`fbm`, `boilOff` 등)는 없다.

**패스 순서** (그리는 해상도 W×H, 흐름장은 절반 해상도. 식과 상수는 `effect/oil-shaders.js`)

0 소스 올리기(`src`, `UNPACK_FLIP_Y`) → 0.5 `FS_INPUT_GRAY`(회색조 유화만: 보이는 9:16 영역을 반전해 읽어 Rec.709 luma) → 1 `FS_GRADE` 색 보정(`grade`, 밉. 회색조 유화가 아니면 여기서 보이는 영역을 반전해 읽는다) → 2~4 `FS_SST` 구조 텐서 + `FS_BLUR` ×2(RGBA16F) → 5 `FS_TFM` 흐름장(`tfm`) → 6 `FS_UNDER` 밑칠(`paint` + 높이 `hgt`, MRT) → 7 붓 층 3개 `VS_STROKE`·`FS_STROKE`(획 = 인스턴스, `hgt`의 G·B는 흑백 스타일용이고 합성은 R만 읽는다) → 8 보완 층(오차가 문턱 이상인 칸에만 가는 붓) → 9 `FS_COMPOSE` 합성(`composed`: 법선 조명·광택·캔버스 결·가장자리 어둡게) → 10 `FS_OUTPUT` 출력 단계(화면 캔버스 또는 결과용 화면 밖 `out`. 끔은 그대로, 회색조·회색조 유화는 회색조·레벨, 회색조 유화 결과면 이어서 인쇄용 1비트). **감열지는 10 대신 "출력 단계" 패스 3개 + 흑백 스타일 1~2개.**

**획 생성** (`core/oil-paint.js` `createStrokeBuilder`, 원본 `makeStrokes` 그대로)

- 층마다 간격 `spacing` 격자의 **칸마다 획 하나**. 획의 중심·난수·그리는 순서는 `ihash(획 번호, sd, …)`로 정한다. **`ihash(i, base, 1) < boil`인 획만** 그림마다 seed에 따라 `sd`가 바뀌고 나머지는 고정이다. 그래서 같은 seed·매개변수면 같은 목록이고 boil 비율의 획만 그림마다 다시 놓인다.
- **캐시:** 고정 획 순서는 해상도와 관계없으므로 (층, 획 수, boil)마다 한 번만 정렬하고(캐시 16개) 해상도가 다르면 위치만 다시 계산한다. 바뀌는 획만 새로 만들어 합친다. 결과는 전부 새로 만든 것과 같다(Node 테스트).
- 획은 흐름장을 따라 휘고 양 끝이 가늘어지며, 세부 문턱이 있는 층은 평평한 곳의 획을 버린다(작은 붓은 세밀한 곳에만). 원본의 거꾸로 된 `smoothstep` 하나는 명세상 정의된 같은 뜻으로 바꿨다.

**기본 제공판 매개변수** (수동 업데이트 적용 뒤에는 아래 받은 정의가 우선. `config.effect`, 범위·단계 `config/effect-settings.js`, px는 짧은 변 1080 그림 기준)

| 값 | 기본값 | 범위 (단계) | 뜻 |
|---|---|---|---|
| `strength` 강도 | 0.3 (개발 PC 저장값, `oil2f` 0.1) | 0~1.6 (0.05) | 요철·광택·캔버스 결·획 색 흔들림 |
| `size` 붓 크기 | 1.3 (개발 PC 저장값, `oil2f` 1.25) | 0.6~1.8 (0.05) | 모든 층의 굵기·간격·길이에 곱함 |
| `boil` 획 다시 그리기 | 0.05 (개발 PC 저장값, `oil2f` 0.1) | 0~1 (0.05) | 그림마다 새로 놓는 획 비율. 화면을 휘지 않고 획만 다시 놓는다 |
| `fps` 초당 그림 | 12 (개발 PC 저장값, `oil2f` 24) | 2~30 (1) | 사이에는 앞 그림을 그대로(스톱모션 느낌) |
| `grade` 색 보정 | 1 | 0~1 (0.05) | 색 보정 섞는 정도 |
| `layers` 붓 층 | `[36,15,84,3.8,0,1]`, `[18,8,44,2.6,0.02,1]`, `[8,4,20,1.4,0.06,1]` | 모양 검사 | `[굵기px, 간격px, 길이px, 색 밉, 세부 문턱, 불투명도(안 씀)]` |
| `refine` 보완 층 | `[3.5, 3, 10, 0.6, 0.3]` (문턱만 개발 PC 저장값, `oil2f` 0.22) | 문턱 `refineThreshold` 0.01~1 (0.01), `null`이면 없음 | `[굵기px, 칸px, 길이px, 기준 밉, 오차 문턱]`. 문턱 0은 "보완 층 아님"이라 쓰지 않는다 |
| `previewScale` 처리 해상도 | 0.5 (개발 PC 저장값) | 0.25~1 (0.05) | 결과 크기 대비 미리보기 해상도 (원본의 `q`는 `akf` 전용이라 무관, 이 프로젝트에서 둔 값) |
| `enabled` | `true` | | `false`면 원본 미리보기, 결과도 원본 해상도 그대로(출력 단계 없음) |

`createEffectPreview(...).setSettings({ fps: 12 })`처럼 일부만 넘기면 정규화해 다음 갱신 때 반영하고 범위로 맞춘 항목을 돌려준다(`E`가 쓰는 입구).

**해상도 비례** (`resolveOilDrawing`): `s = 짧은 변 / 1080`(결과는 늘 1, 미리보기는 `previewScale`, s = 2는 없음). 획 굵기·간격·길이·보완 층 칸 × s(칸 수와 정규화 획 목록이 해상도와 관계없이 같다), 색 밉 + log2(s)(0 아래는 0), 법선 세기 `relief = 강도 × s`, 캔버스 결 주기 × s, 붓털 주기·흐름장은 그대로.

**시간:** `tick = floor(t초 × fps + 1e-6)`, `seed = tick % 997`, 시계는 `performance.now()`(카메라에는 재생 시각이 없다). `tick`이 바뀔 때(또는 설정·크기 변경) 그 순간의 최신 프레임으로 새로 그리고, 사이 60Hz 갱신은 앞 그림 그대로다. seed는 획 목록에만 쓰인다.

**원본과의 차이:** 기준 해상도(s = 1)에서 같은 입력·매개변수·seed면 **원본과 화소가 완전히 같다**(boil 0~1, 반전 포함). 다른 해상도는 구성(획 위치·색·방향)이 같고 화소는 다르며 더 부드럽게 보인다(흐름장·보완 층 판정이 더 거친 그림에서, 가는 획이 화소보다 작아짐). 수치는 [로그 2026-10-16-02](logs/2026-10-16-02-stage5-oil-effect-port.md).

**실시간 미리보기** (`effect/effect-preview.js`)

- `<video>`는 감지·캡처·카메라 감시가 계속 쓰고, 그 위를 `#effect`가 덮는다(결과·카운트다운·D·조절 화면은 그 위). 첫 패스(`FS_INPUT_GRAY`·`FS_GRADE`의 `CAMERA_INPUT`)가 카메라 처리 경로(3절: 색 보정·반전·회전·확대·이동)로 화면 영역을 읽는다. 설정은 `main.js`가 넘긴 `cameraFrame`에서 그릴 때마다 읽고, 바뀌면 그림 번호가 같아도 다음 화면 갱신에 다시 그린다.
- 그리는 해상도 = 결과 크기(`resultSizeFor`, 화면이 덮는 원본 영역을 짧은 변 1080으로) × `previewScale`. OBS 1080×1920·4K·가짜 카메라 2160×2160 모두 결과 1080×1920, 기본 540×960. CSS로 늘려 보인다.
- 카메라가 준비되지 않거나 끊기면 그리지 않고 숨긴다(멈춘 그림이 남지 않게). 결과 표시 중에도 그린다.

| 장애 | 처리 |
|---|---|
| WebGL2 없음(`webgl2-unavailable`), `EXT_color_buffer_float` 없음, 셰이더·프레임버퍼 실패 | 캔버스를 숨기고 원본 미리보기(`fallback`), 새로고침 전까지 재시도 없음, 경고 한 번(`effect`) |
| 그리기 예외, 그림 뒤 GL 오류(`getError`)·`isContextLost()` | 렌더러를 버리고 `fallback`(손실이면 `context-lost` 대기). 이 확인이 GPU를 한 번 동기화해 그림당 약 1ms 든다 |
| `webglcontextlost` | `preventDefault()` 후 원본 미리보기(`context-lost`), `webglcontextrestored`면 렌더러를 새로 만든다 |

- 어느 경우든 카메라·감지·촬영은 계속되고 관람객 안내는 바뀌지 않는다(D에만). 렌더러는 만든 GPU 객체를 `owned` 목록에 넣고, 해상도별 대상 묶음(`allocate`)은 최근 2개까지 둔다. 만들다 실패하면 그때까지 만든 것을, `dispose()`는 전부 지운다(`liveResources()`는 테스트용).
- **D `effect`:** 상태, 그리는 해상도(배율, s), `fps` → 실제 초당 그림, `boil`, seed, 손실 횟수, 장애면 `fallback (원인) -> camera preview`. **`time`:** 그리기 CPU(마지막·평균), GPU(`EXT_disjoint_timer_query_webgl2`가 있을 때), 획 수, 렌더러, 결과 사진 준비(`result 1080x1920 ready (ms)`·`preparing`·`same targets as preview`).

**결과 사진** (`photo-effect.js`, `effect-preview.js` `renderStill`)

- **셔터 순간 미리보기와 같은 그림:** 같은 프레임(마지막으로 올린 소스 텍스처를 그대로, `render(null, …)`)·tick·seed·설정으로 결과 크기에 화면 밖으로 다시 그린다. 캡처한 작업의 마이크로태스크에서 동기로 끝까지 그리고, 미리보기는 `requestAnimationFrame`에서만 프레임을 올리므로 끼어들 수 없다. 처리 해상도 1이면 같은 묶음이라 화소까지 같고(JPEG 전), 아니면 같은 구성을 1080으로 다시 그린 것이다. 보이는 그림이 없거나 영상 크기·카메라 설정이 바뀌었으면 지금 프레임으로 새로 그린다(D `new drawing`). `out`을 `readPixels`로 읽어 2D 캔버스에 넣고 나머지는 캡처 순서를 따른다.
- **결과 사진 준비:** 처리 해상도가 1이 아니면, 미리보기가 그린 뒤 `requestIdleCallback`(최대 2초, 가안)으로 마지막 그림을 결과 크기로 한 번 그린다(렌더러 `output: 'warm'`: 결과와 같은 대상·패스·획 목록, 감열지면 흑백 스타일 대상·인쇄 대상·문턱 지도, 회색조 유화면 인쇄 경로. 화소를 읽지 않고 화면·D 통계를 건드리지 않음). 안 하면 첫 촬영 때 만들어 셔터 순간 화면이 한 번 멈춘다([로그 07](logs/2026-10-19-07-saved-defaults.md)). 결과·미리보기 크기, 출력 모드·용지 폭·점 방식·흑백 스타일, 붓 크기·boil이 바뀌거나 렌더러를 새로 만들면 다시 준비하고, 손실·실패·`stop` 때 기다리던 준비를 취소한다. 준비 전 셔터는 그 자리에서 만들고(그 뒤 준비는 건너뜀), 준비 실패는 경고(`effect-prepare`)만 하고 되풀이하지 않는다. 처리 해상도 1이면 준비하지 않는다. 준비하면 GPU 메모리가 결과 묶음 하나만큼 는다.
- **효과를 그리지 못하면 원본 사진으로 대신한다**(결과 크기로 줄이고 모드의 출력 단계를 CPU로, 아래 각 모드). 촬영 실패로 처리하지 않는다 — 관람객은 이미 찍혔고 다시 찍을 방법이 없다. 경고(`effect-capture`)와 D `photo-fx` `RAW PHOTO … (원인)`. 원인 예: `not-running`(미리보기 장애·손실 중), 화소 읽기 실패, 읽은 뒤 `render-failed: GL error …`·`context-lost: …`(읽은 화소를 쓰지 않음), 2D 캔버스 실패.
- **D `photo-fx`:** `applied [모드] 크기 [점 방식] seed … tick … (same drawing as preview[, gpu=cpu]), render ms, total ms` 또는 `RAW PHOTO …`, 누적 수. **`print`:** 마지막 인쇄 데이터, 없으면 `none (원인)`.

**운영자 조절 화면 `E`의 필터 섹션** (`ui/effect-tuning.js`)

- 효과 7개(강도, 붓 크기, 획 다시 그리기, 초당 그림, 색 보정, 세부 보존 문턱, 처리 해상도), 출력 단계(출력 모드·점 방식·용지 폭 선택, 밝기·대비·감마 슬라이더), 흑백 스타일(스타일·질감 세기·선 간격). 범위는 원본 갤러리 슬라이더와 같다. 좌우 반전(2026-10-26 ~ 9-1에는 여기 "카메라")은 카메라 설정으로 옮겼다(3절).
- 출력 모드 첫 선택지는 회색조 유화. 감열지가 아니면 흑백 스타일을, 회색조·끔이면 점 방식·용지 폭도, 끔이면 레벨도 막는다(회색조 유화에서 점 방식·용지 폭은 인쇄 데이터용으로 열림). 질감 세기는 톤 점에서, 선 간격은 선 스타일이 아니면 막힌다.
- 즉시 반영. 저장·취소·기본값(필터 값만)·저장 없이 닫으면 되돌리기·저장 중 닫기는 인식·카메라 섹션과 같은 규칙이고, 패널이 열려 있는 동안 자동 촬영을 막는다.
- **파일** `config/effect.local.json`: `{ "version": 1, "settings": { strength, size, boil, fps, grade, refineThreshold, previewScale, outputMode, dither, brightness, contrast, gamma, paperDots, bwStyle, bwTexture, lineSpacing, oil, monoMode } }`(조절하는 값만. 끝의 `oil`·`monoMode`는 WISHFUL 시안의 시험 조합 선택 키로, 없으면 알리지 않고 채운다 — 아래 "시험 조합"). 파일 값이 있으면 그 값이다(예: 예전에 `thermal`로 저장한 파일은 감열지로 시작하므로 회색조 유화로 바꾸려면 `E`에서 고르고 저장). 일부 키만 있으면 나머지를 기본값으로 채우고 알린다(`adjusted`). 예전 파일(2026-10-26 ~ 9-1)에 남은 `mirror`는 읽지 않고 알리지도 않는다(카메라 파일이 없을 때 카메라 설정으로 한 번 옮기고 이 파일에서 그 키를 뺀다, 3절).
- **불러오기: 파일 → 기본값**(`localStorage` 없음). 404·읽기 실패·`effectSettingsFile.timeoutMs`(3초, 가안) 초과·형식 오류면 기본값이고 파일은 그대로. 불러오는 동안은 기본값으로 그리고 **13단계부터 로컬 필터 복원이 끝날 때까지 새 촬영을 막는다**. 업데이트 적용 뒤의 파일/우선순위는 다음 절을 따른다. D `values`에 값과 출처(`file`·`saved`·`defaults (no file)`·`+ unsaved changes`).

### 카메라 유화 수동 업데이트 (13단계)

독립 검수 지적 4건과 후속 N1/N2를 수정하고 재검수를 거쳐 로컬 `master`에 통합했다. 기존 현장 설정은 유지한다. 검수 범위와 통합 검증은 [통합 로그](logs/2026-11-06-04-filter-integration.md)에 기록했다.

운영자 `E` → **필터**에서 `oil2f`만 갱신한다. 기존 기본 제공판(`oil-shaders.js`)은 첫 명시 적용 전까지 유지하며, 받은 판을 적용하면 엔진과 수치 정의를 함께 쓴다. 관람객 디자인·감지·카메라 보정·출력 경로는 공통이다. 인식은 계속 필터 전 원본을 읽는다.

**운영 순서**

1. 촬영 회차가 끝난 뒤 `E` 필터 → **업데이트 확인**. 후보 버전과 변경 항목만 표시하며 실행판/저장판/미저장 조절값은 바뀌지 않는다. 정상 확인·통신/호환 실패·연속 확인 모두 같은 규칙이다. 시험 중 다시 확인해도 시험 엔진·정의·수치를 유지하고 새 후보는 다시 시험해야 적용할 수 있다. 확인 실패 뒤에도 가져온 기본값은 현재 시험판 기준이다.
2. **후보 시험**. 현재 카메라로 결과 해상도까지 GPU 시험한 후 미리보기에 쓴다. 기존 현장값은 보존한다. 처음 생긴 항목만 원본 기본값으로 채운다. 시험 중에는 자동·수동 새 촬영을 막는다.
3. 원본 수치 전체를 비교하려면 **가져온 기본값 적용**. 이 버튼만으로 저장되지는 않는다. 출력 모드·인쇄·카메라 값은 유지한다.
4. **필터 적용·저장**. 엔진·정의·현재값·이전판을 한 파일로 저장한다. 이후 일반 **저장**은 이 파일의 현재값만 갱신한다. 일반 **기본값으로**는 해당 필터의 받은 기본 수치와 프로젝트 출력 기본값을 함께 시험한다.
5. 시험을 취소하거나 `E`/`Esc`로 닫으면 저장된 엔진·수치로 돌아간다. **이전판 복원**은 직전 엔진과 당시 수치를 즉시 시험·저장하고, 재시작에도 유지한다. 직전판 한 개를 보존하며 다시 누르면 양쪽을 바꾼다. 처음 적용의 이전판은 기존 기본 제공 엔진과 기존 현장값이다.

시작할 때 로컬 필터 복원이 끝나기 전, 업데이트 처리 중에는 새 촬영을 막는다. 회차 진행 중의 확인·시험·적용·복원·조절은 거절한다. 저장/다운로드 도중 닫기를 누르면 작업이 끝난 뒤 닫고 미저장값을 되돌린다. 처리 중 저장·복원·취소·기본값·중복 확인은 서로 겹치지 않으며, 예전 효과 파일을 저장하는 동안에도 업데이트 동작을 막는다.

**출처와 지원 경계**

- 고정 출처: [공식 모듈](https://nau-filter-gallery.vercel.app/nau-filter/nau-filter.js), [공식 갤러리 UI](https://nau-filter-gallery.vercel.app/). `/show/`는 모듈 소비 화면이라 정의 추출에는 루트 UI를 쓴다. 2026-11-06 실제 HTTP 재확인: `7f58eaa`(원본 표기 2026-11-05), JS 135462바이트, SHA-256 `51816e9146ea1d90af0cd89a0faf2078a4b68ea023784b7ac3da70e495bde4ae`. UI SHA-256 `a84c03395506577aef92c023dfe0a06f40be9c79f282a35d5917ce0bad87965e`.
- 공식 manifest/서명은 없다. SHA-256은 동일판 식별·무결성 확인용이다. `filter-builtin.json`에 이 판의 필수 정의·GLSL 조각을 포함하므로 다른 프로젝트 폴더가 없어도 동작한다. 원본 JS/HTML을 eval/import/script 태그로 실행하지 않는다.
- 지원 GLSL 슬롯은 방향장 본문, 획 경로, 획 폭, 획 도움 함수, 합성 본문, 덩이 지도 셰이더/함수의 7개다(viewer port spec2의 6개 역할에서 덩이 셰이더·함수를 분리). 슬롯 밖 실행코드는 정규화 fingerprint로 고정한다. 범위·기본값·지원 preset/level 데이터·지원 슬롯만 자동 갱신 가능하다. `PRESETS.oil2f`는 label/sbr/layers/refine/strength/size/boil/fps/grade/level/tune만 지원하고 sbr은 현재 해석 가능한 1만 허용한다. 새로운 최상위 키·sbr 의미 변경은 검토 필요다.
- 모듈과 UI의 preset·OIL/PER/SLIDER 기본값·level 행·관련 GLSL을 대조한다. HTML은 `const PER =`부터 해당 script 끝까지의 설정 controller도 별도 `uiFingerprint`로 검사한다. applyValues/applyTune/levelApply·보간·memo 우선순위·이벤트·공유값 로딩·초기화·embed 재적용을 포함한다. 마스킹 전에는 PRESETS/PER/SLIDER_DEF/PER_DEF/CTRL_BASE/CTRL/TUNE_ROWS/GRADE_ROW/LEVELS 및 참조 선언 전체를 끝까지 판독한다. 식별자·작은/큰따옴표·지원 Unicode escape로 적힌 동등 키, 명시 속성과 spread 사이 중복, 선언 중복은 거부한다. 계산 키·getter·알 수 없는 참조·선언 뒤 표현식은 검토 필요다. 공식 원문의 SLIDER_DEF/NO_MATERIAL/CRAYON_ROWS/CRAYON_NORMAL/CRAYON_FLOW와 set/rows 참조만 제한적으로 정적 해석한다. 알려진 참조를 사용한 다른 매체의 정상 정적 데이터는 거부하지 않는다. oil2f 관련 키·PER/PER_DEF/CTRL_BASE의 지원 목록을 확인한 다음, 검증한 PER_DEF/CTRL_BASE/CTRL/TUNE_ROWS/GRADE_ROW/LEVELS 선언의 정확한 위치만 마스킹하므로 지원 수치 변경을 수용하고, 주변 CSS/마크업 변경은 이 지문에 포함하지 않는다. 이 영역의 지원 밖 동작 변경은 보수적으로 보류한다. 혼합 배포, 알려지지 않은 조절 키/삭제/중복, 지원 정적 참조 밖 표현식, 잘린 응답, 지원 밖 코드 변경은 **검토 필요**로 보류한다. 받은 범위 밖의 현장값도 잘라 저장하지 않고 보류한다. 기존판을 유지한 채 현장값을 조절하거나 원본 변경을 검토해야 한다.
- 제외: 다른 재료 프리셋, 별도 색 톤 후처리 `MOODS`/`moodK`, 소스 관리·재생·내보내기·split. 캐릭터 `normal`과 마스크·조명은 사전 캐릭터 번호 마스크가 필요한 별도 경로이며 카메라 원본에는 없다. `CR.nosilw` 행은 원본 그대로 보존하지만 마스크 없는 카메라에서 사용하지 않는다. `state.style`은 마스크 없이도 level 기준점을 바꾸므로 포함한다. 갤러리는 소스 메타데이터로 그림체를 선택하며, 카메라의 초기 그림체는 공식 모듈 `state.style=flat`이다.

**원본 조절 항목 대응표**

총 **22개 = 숫자 21개 + 선택 1개**. `OIL.w` 벡터는 세 성분을 각각 센다. 숫자 21개는 공통 6개 + 유화 14개 + 색 보정 1개다. 원본에서 level 아래 숨기는 strength/size도 기존 현장 조절 호환을 위해 노출한다. 숫자 범위·간격·라벨은 `CTRL_BASE` + `CTRL.oil2f` 및 `TUNE_ROWS.oil` + `GRADE_ROW`, 선택은 UI option에서 추출한다. 기본값은 `PRESETS.oil2f`/`.tune`, 없으면 `PER_DEF`/`SLIDER_DEF`이고 style은 모듈 state다. HTML input의 임시 value를 기본값으로 쓰지 않는다.

| 원본 식별자 | 원본 라벨 | 범위 / step 또는 options | 받은 기본값 | 앱 연결 |
|---|---|---|---|---|
| `state.strength` | 강도 | 0~1.6 / 0.01 | `0.29` | strength · 합성 요철/광택/결과 획 색 |
| `state.size` | 붓·코 크기 | 0.6~1.8 / 0.01 | `1.23` | size · 붓 굵기/간격/길이 |
| `state.boil` | 획 다시 놓기 | 0~1 / 0.01 | `0.02` | boil · seed에 따른 획 재배치 |
| `state.fps` | 초당 그림 | 2~30 / 1 | `15` | fps · 그림 tick |
| `state.grade` | 색 보정 | 0~1 / 0.01 | `1` | grade · FS_GRADE |
| `state.level` | 필터 세기 | 0~100 / 1 | `50` | gallery.level · LEVELS.oil2f |
| `OIL.w.0` | 굵은 붓 굵기 | 0.4~2 / 0.05 | `1.01` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.w.1` | 중간 붓 굵기 | 0.4~2 / 0.05 | `1.23` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.w.2` | 가는 붓 굵기 | 0.4~2 / 0.05 | `0.72` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.len` | 획 길이 | 0.4~2 / 0.05 | `1.68` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.jit` | 획 색 흔들림 | 0~0.3 / 0.01 | `0.096` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.bump` | 물감 요철 | 0~20 / 0.5 | `5.3` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.spec` | 광택 | 0~0.5 / 0.01 | `0.178` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.canvas` | 캔버스 결 | 0~0.1 / 0.005 | `0.023` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.refineT` | 세부 보존 문턱 | 0.05~0.6 / 0.01 | `0.1` | refine[4] · 보완 층 문턱 |
| `OIL.eye` | 눈·코 테 정리 | 0~1 / 0.05 | `1` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.edge` | 경계 밖 잔획 정리 | 0~1 / 0.05 | `1` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.spill` | 경계 옆 번짐 띠 정리 | 0~1 / 0.05 | `1` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.slope` | 그늘 띠 붓 방향 | 0~1 / 0.05 | `1` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `OIL.halo` | 경계 둘레 테 정리 | 0~1 / 0.05 | `0` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `GRADE.keepW` | 흰색 지키기 | 0~1 / 0.05 | `1` | gallery.values의 같은 원본 키 → 해당 uniform/붓 배율 |
| `state.style` | 소스 그림체 | flat(평면 그림책), 3d(3D) | `flat` | gallery.style · flat/3d level 기준점 |

추가 데이터(독립 UI 항목 수에는 세지 않음): 붓 층 `[[36,15,84,3.8,0,1],[18,8,44,2.6,0.02,1],[8,4,20,1.4,0.06,1]]`, 보완 층 `[3.5,3,10,0.6,0.22]`. 원본 `OIL.refineT=0.10`이 보완 문턱 0.22보다 우선한다. `CR.tfmE` 기본 `0.00004`도 원본에서 받는다. 업데이트마다 붓 층과 보완 층 앞 네 값을 새 엔진과 함께 가져오고 현장 문턱은 보존한다.

| LEVELS.oil2f.rows 키 | flat 0 / 50 / 100 | 3d 0 / 50 / 100 |
|---|---|---|
| state.strength | 0.12 / preset(0.29) / 0.75 | 0.10 / 0.22 / 0.55 |
| state.size | 1 / preset(1.23) / 1.7 | flat과 같음 |
| OIL.canvas | 0.01 / preset(0.023) / 0.05 | 0.01 / 0.02 / 0.04 |
| OIL.jit | 0.04 / preset(0.096) / 0.15 | 0.03 / 0.07 / 0.11 |
| CR.nosilw | 10 / 원본 기준 / 17 | flat과 같음(마스크 전용, 적용 안 함) |
| CR.tfmE | 0.00004 / CR 기본(0.00004) / 0.00004 | 0.001 / 0.001 / 0.001 |

원본 `applyTune`: 초기 tune snapshot → preset.tune → levelApply → 사용자가 기억한 tune. level은 0~50·50~100 사이를 선형 보간하고 null 중간값은 해당 preset 기본값을 참조한다. 앱도 이 순서를 따른다. level/style을 움직이면 strength/size를 다시 계산하고, OIL.jit/canvas의 명시 세부값은 level보다 우선한다. 현장 호환상 strength/size 직접 조절은 다음 level/style 조절까지 유지한다. 새 기본값이 바뀌어도 기존 유효 세부값은 현장 덮어쓰기로 보존하며, 받은 기본값 적용이 이를 지운다.

**파일·API·실패 처리**

- `config/filter.local.json` 한 문서: `{revision,active:{bundle,settings},previous:{bundle,settings}}`. settings는 기존 version 1 형식 + 선택 `gallery:{level,style,values}`다. 필터 파일이 있으면 effect.local.json보다 우선한다(기본 엔진으로 복원한 상태도 포함). 예전 effect.local.json은 지우거나 덮지 않는다. 카메라·인식·시간 파일은 별도 그대로다.
- 같은 폴더 임시 파일→flush→File.Replace/Move로 엔진/정의/현장값/이전판이 함께 바뀐다. 모듈 hash와 UI hash를 묶은 후보 ID를 사용하며 revision 충돌은 409. 파일 잠금/쓰기 실패면 원판 유지, 응답만 끊기면 state를 다시 읽어 저장 여부를 확인한다. 서버 연결도 잃으면 화면은 이전 저장판으로 되돌리고 재시작 때 디스크 판을 검증한다. 전원 차단 자체의 실장 시험은 미검증이다.
- 붓 schema는 브라우저 validateBundle과 서버 C# Bundle에서 같은 규칙을 쓴다. layers는 정확히 3×6, 각 층 앞 3개는 0 초과·200 미만, 나머지는 0 이상·200 미만이다. refine은 정확히 5개, 앞 4개는 0 초과·200 미만, 마지막은 0 이상·200 미만이다. null/문자열/bool/NaN/Infinity는 허용하지 않는다. level 중간 기준점의 null 허용은 별도 규칙이다. 서버 Extract 결과·후보 제출·적용 직전·현재값 저장·복원 대상 모두 같은 C# 검증 함수를 거친다. GET은 손상판에서 이전판으로 복구할 수 있도록 저장 문서를 전달하고, 브라우저는 읽은 각 엔트리를 실행 전에 같은 schema로 검증한다.
- 시작 시 저장판 컴파일에 실패하면 저장된 이전판을 시험해 자동 복원한다. 둘 다 손상되면 기본 제공판으로 열고 저장을 보류한다. 이 경우 앱 종료 후 filter.local.json을 백업한 다음 제거하면 예전 effect.local.json + 기본 제공 엔진으로 시작한다. 복원 전 파일은 폐기하지 않는다.
- GET `/local-api/filter-state`, POST `filter-check`(본문 `{}`만), PUT `filter-candidate`, POST `filter-apply`/`filter-rollback`, PUT `filter-state`. 변경 요청은 기존 Host/Origin/Sec-Fetch-Site/X-Photobooth/JSON 방어를 공유한다. 후보 128KiB·기타 32KiB 상한, 정확한 고정 경로만 허용한다. 후보의 22개 정의·숫자·곡선·층·GLSL 크기/슬롯을 검사한 뒤, 서버가 받은 원문에서 별도 제한 판독기로 전체 묶음을 독립 재생성한다. 서버가 계산한 source hash·엔진/UI 호환지문·metadata·controls(종류/label/help/range/options/default)·preset·levels·flowDefault·GLSL을 제출 JSON과 모든 속성/배열 위치/종류/수치/문자열까지 대조한다. 빈 GLSL이나 단순 substring은 허용하지 않는다. 통과해도 제출 객체가 아니라 서버 생성 객체만 후보로 보관한다. 검산 결과는 해당 다운로드 동안만 메모리에 재사용하며 새 확인 때 비운다.
- 서버 다운로드는 운영자의 확인 요청 때만 고정 HTTPS 두 곳으로 GET한다. redirect 거절, 타입·UTF-8·길이·500KB/800KB·시간 상한을 검사한다. 후보/원본은 서버·브라우저 메모리에만 있고 서버 재시작 시 다시 확인한다. 사진/프레임/현장값을 원격 요청에 싣지 않는다. CSP connect-src self는 그대로이고 평상시·재시작·복원·촬영에는 인터넷이 필요 없다.
- 책임: `config/filter-source.js` 비실행 판독/검증, `filter-values.js` 수치 매핑/이행, `filter-builtin.json` 동봉 데이터, `effect/filter-shaders.js` 지원 GLSL 연결, `filter-updates.js` GPU와 저장 흐름, `ui/filter-tuning.js` 데이터 기반 UI, `bin/server/filter-api.ps1` 고정 다운로드/검산/원자 저장, `bin/server/filter-source.cs` 서버 독립 비실행 원문 판독. 후자는 Windows PowerShell 5.1의 기본 .NET `Add-Type`으로 저장소 로컬 코드만 컴파일한다(원격 코드 컴파일·실행 없음). Node·별도 서버·설치 도구가 필요 없다. 처음 후보 검산 때 컴파일에 실패하면 기존판을 유지하고 후보를 거부한다. 기존 schema 1 저장판에 uiFingerprint가 없더라도 오프라인 복원은 유지하며, 새 후보에는 두 지문을 모두 요구한다.

검증 명령: `node tools/filter-browser-check.mjs --capture`(합성), `--real --capture`(실제 장치, OBS 우선). 자기 서버·임시 프로필에서 시험하고 작업 폴더 설정을 백업/복원한다. 실제 프레임은 파일에 쓰지 않는다. 개발용 Node만 필요하며 현장 실행에는 Node가 필요 없다. 카메라/GPU를 열지 않는 HTTP 경계 검증은 `node tools/filter-api-check.mjs`로 실행한다. 서버 독립 판독 검증은 공식 원문을 ignored runtime 하위 폴더의 module.txt/gallery.html로 받은 뒤 `node tools/filter-source-check.mjs runtime/stage13-review`로 실행한다(개발 전용, 실제 PS 함수 + 모의 요청 stream, HTTP는 앞 명령으로 별도 검증). 자세한 실측·한계는 [13단계 로그](logs/2026-11-06-01-filter-updates.md), [검수 보완 로그](logs/2026-11-06-02-filter-review-fixes.md), [선언·schema 재검수 로그](logs/2026-11-06-03-filter-boundary-review.md).

### 시험 조합: 유화 켬/끔 × 흑백 켬/끔 (WISHFUL HOLIDAY)

사용자 요청(2026-11-05): 유화 필터와 흑백을 **따로 켜고 꺼서** 네 조합(원본 컬러·원본 흑백·유화 컬러·유화 흑백)을 운영자가 시험한다. 관람객 조작이 아니라 `E` 필터 섹션 맨 위(네 조합 버튼, "유화 필터"·"흑백" 스위치, 안내 한 줄)와 카메라 없는 데모 패널에 있다. 표시만 바꾸는 것이 아니라 **실제 영상 처리**가 바뀌고, 미리보기와 셔터 결과는 같은 설정 객체·같은 프레임·같은 카메라 좌표로 그린다(기존 `renderStill` 규칙 그대로).

| 값 (`config.effect`, 파일 선택 키) | 기본값 | 뜻 |
|---|---|---|
| `oil` | `true` | 유화 패스를 쓸지. `false`면 렌더러가 구조 텐서·흐름장·밑칠·붓 층·보완 층·합성을 건너뛰고, 같은 카메라 처리 경로 입력(회색조 유화면 `FS_INPUT_GRAY`, 아니면 `FS_GRADE` `uAmt` 0 = 카메라 그림 그대로)을 합성 그림 자리(`composed`)에 그려 **기존 출력 단계를 그대로** 입힌다. 강도·붓 크기·boil·색 보정·세부 보존·초당 그림 값은 **지우지 않고** 막아 둘 뿐이다(다시 켜면 그 값) |
| `monoMode` | `'gray-oil'` | "흑백"일 때의 출력 모드(흑백 방식: `gray-oil`·`thermal`·`gray`). **흑백 = `outputMode`가 `off`가 아님.** 흑백을 끄면 지금 흑백 방식을 `monoMode`에 남기고 `outputMode = 'off'`(컬러), 켜면 `outputMode = monoMode`. 출력 모드가 흑백이면 `monoMode`는 늘 같은 값이다(정규화) |

- **기존 출력 모드와의 관계:** `outputMode`는 예전 뜻 그대로다(회색조 유화·감열지·회색조·끔). 시험 조합은 그 위의 두 스위치일 뿐이라, 유화 켬이면 네 출력 모드가 예전과 화소까지 같다(Node 렌더러 테스트). 현장 저장값 `outputMode: "gray"`는 "유화 켬 · 흑백 켬(회색조)"으로 읽힌다.
- **조합별 처리:**

| 조합 | 미리보기·결과 화면용 | 인쇄 데이터 |
|---|---|---|
| 원본 · 컬러 | 카메라 처리 경로 그림 그대로(출력 단계 `off`, 레벨 없음), 획 0 | 없음 (화면 시험용) |
| 원본 · 흑백 | 흑백 방식대로: 회색조 유화 = 입력 회색조(Rec.709) → 회색조·레벨, 회색조 = 컬러 → 회색조·레벨, 감열지 = 1비트 톤 점(흑백 스타일은 획이 없어 늘 톤 점, `bwStyleOf`) | 회색조 유화·감열지만 (회색조는 예전처럼 없음) |
| 유화 · 컬러 | 컬러 유화(예전 `off`) | 없음 (화면 시험용) |
| 유화 · 흑백 | 예전 그대로(기본 회색조 유화, 현장값 회색조) | 회색조 유화·감열지만 |

- **화면 컬러 시험과 인쇄용 흑백 데이터는 구분한다:** 컬러 조합은 인쇄 데이터를 만들지 않는다(D `combo` 줄 `print data no (color is a screen test)`, `print` 줄 `-`). 인쇄 데이터는 늘 감열지 1비트이고 흑백 방식이 회색조 유화·감열지일 때만 만든다. 실제 프린터 연동은 없다(인쇄 완료를 말하지 않는다).
- **초당 그림:** 유화 끔은 획이 없어 스톱모션으로 둘 이유가 없으므로 `OIL_OFF_FPS` 30장(가안, `effect-preview.js` `drawFpsOf`). 유화 `fps` 값은 그대로 남는다. 결과 사진 준비 키에 `oil`이 들어 있어 바꾸면 다시 준비한다.
- **저장·취소·기본값·재시작:** 다른 필터 값과 같은 규칙이다. 조합은 즉시 반영되고 **저장해야** `effect.local.json`에 남으며, 저장하지 않고 패널을 닫으면 저장된 조합으로 돌아간다(재시작해도 저장된 조합). "취소"는 저장된 조합, "기본값으로"는 유화 켬·흑백 켬(회색조 유화)과 필터 기본 수치(개발 PC 값)다 — 현장 수치로 돌아가는 것이 아니므로 현장에서는 "취소"를 쓴다.
- **파일 호환:** 버전 1 그대로 두 키만 더했다. **둘 다 선택 키**라 없으면 알리지 않고 채운다(`EFFECT_OPTIONAL_KEYS`, `oil` 켬, `monoMode`는 흑백이면 출력 모드·컬러면 기본값). 그래서 예전 16개 키 파일(현장 저장값 포함)은 저장 상태가 "고쳐 씀"이 되지 않고 같은 값으로 읽힌다(2026-11-05 현장 4개 파일 복사본으로 확인, Node 테스트). 새로 저장한 파일을 예전 앱(IMPRINT `master`)이 읽으면 `outputMode`는 맞게 읽고 `oil`은 모르므로 유화 켬으로 보인다.
- **D:** `effect` 줄 `fps 30 -> …`(유화 끔), `time` 줄 `strokes 0`, `combo` 줄(`oil on|off, mono on (모드)|off (color, mono mode …), print data yes|no (…)`), `photo-fx` 줄 모드 뒤 `[no oil]`.

### 회색조 유화

**화면 기본값**(`outputMode: 'gray-oil'`). 감열지 인쇄용 1비트는 결과 사진에서 따로 만들어 메모리에만 둔다. 결정과 측정은 [로그 2026-10-19-06](logs/2026-10-19-06-stage8-gray-oil.md).

```text
카메라 프레임 → 크롭·반전 + 입력 회색조(Rec.709, FS_INPUT_GRAY) → 유화 oil2f 패스 그대로(1~9) → 회색조·레벨(Rec.601, FS_OUTPUT) → 화면 / 결과 1080×1920
결과만: 같은 합성 그림 → 회색조·레벨 → 인쇄 해상도 면적 평균 → 점 방식(톤 점 경로) → 인쇄용 1비트 576×1024 (화면에 보이지 않음)
```

- **입력 회색조 Rec.709 luma**(0.2126, 0.7152, 0.0722, `core/thermal.js` `INPUT_LUMA`): 카메라·OBS의 sRGB/BT.709 원색에 맞는 감마 영역 luma다. 카메라 처리 경로(카메라 색 보정 포함)를 거친 값에서 잰다. 효과의 색 보정(`grade`)은 이 회색 그림을 변환 없이 읽는다(원본에 "회색 이미지"를 넣는 것과 같다). 유화 패스·매개변수는 바꾸지 않는다.
- **마지막에 다시 회색조:** `oil2f`는 회색 입력에도 색 보정·획 색 흔들림으로 색을 더하므로(`grade` 0으로도 무채색이 안 되고 톤이 바뀐다) 출력 단계에서 R=G=B로 만든다.
- 결과는 "GPU 입력 회색 그림을 컬러 유화 경로에 넣은 것"의 회색조와 같다(합성 이미지로 최대 차이 1). 원본 페이지 직접 비교는 **미검증**. CPU `inputGrayOf`는 반올림 차이로 획 배치가 바뀔 수 있어 대체 경로에만 쓴다.
- **결과:** 화면용 1080×1920 **JPEG**(`config.capture`, IMPRINT 시안에서는 사진 틀로 자른 1080×1350). 인쇄용 1비트(`print`, 아래 (a) 형식)는 결과 렌더(`output: 'pixels'`)에서 같은 합성 그림을 톤 점 경로로 만든다(흑백 스타일 선은 안 씀, 레벨은 화면과 같음, `dither`·`paperDots`를 따름). 블루 노이즈·Bayer는 결과마다 CPU로 다시 계산해 비트 단위로 같은지 본다(`gpu=cpu`). 앱에는 인쇄 데이터 미리보기가 없다(D `print` 숫자만, 카메라 없는 데모 패널에서만 보인다).
- **실패:** GPU 인쇄 단계만 실패하면 사진은 `applied` 그대로, 인쇄 데이터는 확정된 사진에서 CPU로 만든다(`cpu from photo`, `print`에 `from photo on CPU (GPU print failed: 원인)`). 그다음(PNG 압축 등)까지 실패하면 사진만 보이고 `print`는 `none (원인)`. 효과를 못 그리면 원본 사진에 CPU 입력 회색조·레벨과 그 사진의 인쇄 데이터(`RAW PHOTO gray-oil 1080x1920 (원인)`), 회색 변환까지 실패하면 원본 컬러.
- 촬영 순간 끊김 방지: 용지·점 방식이 바뀔 때 인쇄 대상·문턱 지도를 미리 만들어 두고, 인쇄 처리 앞에서 작업을 한 번 양보한다.

### 출력 단계: 감열지 흑백

`E`에서 **감열지**를 고를 때의 모드다(비교·실제 출력 확인용). 이 모드에서는 **화면에 보이는 것이 곧 출력물**이다(미리보기와 결과가 같은 1비트 점 그림). 용지 80mm·가로 576점(203dpi), 58mm는 384점. 출력 모드는 **회색조 유화(기본)** / 감열지 / 회색조(컬러 유화를 회색으로) / 끔(컬러 유화). 근거는 [로그 2026-10-19-01](logs/2026-10-19-01-stage6-thermal-bw.md).

```text
composed → 회색조(Rec.601) → 대비(0.5 중심) → 밝기 → 0~1 → 감마  →  인쇄 해상도 면적 평균 → 8비트 회색 (FS_THERMAL_REDUCE)
  → 1비트: 문턱값 FS_THERMAL_DITHER (GPU) / 오차 확산 (CPU)          (톤 점이 아니면 축소 전 FS_BW_PREP, 선은 FS_THERMAL_SCREEN 문턱)
  → 화면: 결과 크기로 확대 + 종이색·잉크색 (FS_THERMAL_SHOW) / 결과: 인쇄용 1비트(정본) + 같은 식으로 확대한 화면용 PNG (upscaleSharp)
```

- 레벨 `v = clamp((lum − 0.5)·contrast + 0.5 + brightness, 0, 1)^(1/gamma)`(`core/thermal.js`와 셰이더가 같음), 축소 **앞에** 둔다.
- **인쇄 해상도:** 가로 = 용지 점 수(8의 배수), 세로 = 결과 비율대로: 576 → **576×1024**, 384 → 384×683. 처리 해상도와 무관.
- **면적 평균:** 인쇄 점이 덮는 원본 구간과 겹친 넓이로 가중 평균한다(1080 → 576은 1.875배라 최근접·쌍선형은 모아레·톤 오차). GPU 결과는 가로 4점씩 (Pw/4)×Ph RGBA8에 묶는다.

| 점 방식 (`dither`, 기본 `blue-noise` 가안) | 어디서 | 특징 |
|---|---|---|
| `blue-noise` | GPU (CPU 같은 식) | 64×64 void-and-cluster 문턱 지도(처음 쓸 때 한 번). 고른 점, 그림 사이에 거의 안 바뀜, 비용이 효과 끔과 같음 |
| `bayer` | GPU (CPU 같은 식) | 8×8. 가장 싸지만 격자 무늬 |
| `atkinson` | CPU | 대비가 강하고 끝 톤이 날아감 |
| `floyd-steinberg` | CPU | serpentine, 톤이 가장 정확 |

- 오차 확산은 그림마다 점이 크게 바뀌어 미리보기가 지글거리고, 동기 화소 읽기·CPU 디더로 메인 스레드를 더 써 감지가 15fps 아래로 떨어질 수 있다. 미리보기에서는 CPU 마스크를 GPU 결과와 같은 형식으로 올려 같은 셰이더로 그린다.
- **문턱값 규칙:** 순위 r(0..N−1) → `t = 1 + floor(r·255/N)`, `g ≥ t`면 흰 점(0은 모두 검정, 255는 모두 흰색). 8비트 정수 비교라 **GPU = CPU 비트 단위**이고 결과마다 확인한다(`gpu=cpu`, 다르면 경고 후 GPU 쪽). 문턱 지도가 고정이라 같은 프레임·seed면 같은 점 그림이다.
- **화면 확대(화면 전용):** 점 그림을 "정수배 최근접 + 경계 1화소만 섞음"(sharp bilinear 계열, `sharpAxis`)으로 결과 크기에 그린다. 576점이 1080 폭에서 모두 같은 폭이 된다(최근접이면 1·2화소로 들쭉날쭉). GPU(`FS_THERMAL_SHOW`)와 CPU(`upscaleSharp`)가 같은 정수식이라 화소가 같다. 미리 확대하므로 CSS `image-rendering`을 쓰지 않는다. 인쇄 데이터는 그대로다.
- 종이색·잉크색 `config.thermalDisplay`(가안: `[246, 242, 233]`, `[26, 26, 30]`)는 화면 전용. 감지는 효과 전 컬러 영상(카메라 처리 경로까지 거친 것)으로 한다.

**결과와 인쇄용 데이터** (`renderStill` → 렌더러 `output: 'print'`)

- **(a) 인쇄용 1비트 (정본)**, 사진의 `print`: `bits` 래스터 비트(줄마다 `ceil(Pw/8)`바이트, 위 줄부터, 왼쪽 점이 최상위 비트, **1 = 검은 점**, ESC/POS `GS v 0`과 같은 뜻), `png` 1비트 회색조 PNG Blob(비트 깊이 1, 색 형식 0, 브라우저 `CompressionStream('deflate')`), `width`·`height`·`bytesPerRow`·`blackRatio`·`layout`·`photo`(쪽 안의 사진 줄)·`takenAt`·`fontsReady`·`imprintError`. 메모리에만 두고 `release` 때 놓는다. 인쇄 연동 때 이것을 넘긴다.
- **인쇄 쪽 (IMPRINT에서 도입, 글자는 WISHFUL 시안):** 인쇄 데이터는 9:16 인쇄 해상도 마스크(576×1024)에서 사진 틀 줄(14단계 128~848)만 남긴 576×720 사진을 감열지 한 장으로 짠 것이다(`photo-effect.js` `imprintPage` → `effect/imprint-page.js`, 배치 `core/imprint.js` `imprintLayout`, 가안). 위 여백 → **머리**(왼쪽 캠페인 표제 `A WISHFUL HOLIDAY` Cinzel 600 24점, 오른쪽 촬영 날짜 `2026.11.03` Pretendard 500 20점) → **사진**(84줄부터, 용지 폭 전체) → **꼬리**(왼쪽 필기체 "Puuvilla Story Begins" Pinyon Script 34점, 오른쪽 `18:42:07  ·  80 MM` Pretendard 500 16점) → 아래 여백. 글자 크기는 `imprintTypeSizes`(576점 기준을 폭에 비례). 필기체의 가는 획이 203dpi 감열지에서 끊기지 않는지는 **미검증**(실제 프린터 없음). 576점이면 **576×912 = 약 114mm**(예전 사진만 1024줄보다 짧다, 래스터 65,664바이트), 384점(58mm)은 같은 배치를 폭에 비례(384×608). 글자는 2D 캔버스에 흰 바탕·검은 글자로 그려 빨강 128 문턱으로 1비트로 바꾸고(회색 점 없이 가장자리만 계단), 사진 줄은 마스크 그대로 넣는다(점 방식·GPU = CPU 확인은 사진 쪽 그대로). 글자 짜기가 실패하면 인쇄 데이터는 틀 사진만(경고 `imprint type not drawn`, D `print` `(photo only, imprint failed: …)`). 시각은 현장 PC의 지역 시각. 화면에는 인쇄 데이터를 보이지 않는다(관람객 화면의 결과 종이는 같은 쪽 모양을 화면 서체로 짠 것이고 인쇄 데이터가 아니다). D `print` `576x912 1-bit (imprint: photo 576x720 at row 84), …`.
- **(b) 화면용:** (a)를 결과 크기로 확대해 칠한 PNG(미리보기와 화소가 같음). 확대는 240줄씩 나눠 양보한다(촬영 순간 긴 작업 방지). 처리 중 취소되면 만들지 않는다.
- **형식:** 감열지 → PNG + 인쇄 데이터, 회색조 유화 → JPEG + 인쇄 데이터, 회색조·끔 → JPEG만(JPEG는 1비트 점을 뭉갠다). IMPRINT 시안에서는 화면용 사진 모두 사진 틀로 자른 크기, 인쇄 데이터 모두 인쇄 쪽.
- **장애:** 효과를 못 그리면 원본 사진에 같은 출력 단계를 CPU로(인쇄 데이터 포함, D `RAW PHOTO thermal 576x1024 (원인)`, 회색조 모드면 원본을 회색조·레벨로). 출력 단계 자체가 실패하면(PNG 압축, 캔버스) 원본 컬러 JPEG, 인쇄 데이터 없음.

**설정** (`config.effect`, `E`에서 조절·저장)

| 값 | 기본값 | 범위 (단계) | 뜻 |
|---|---|---|---|
| `outputMode` | `'gray-oil'` | `gray-oil`·`thermal`·`gray`·`off` | 회색조 유화 / 감열지 / 회색조 / 끔 |
| `dither` | `'blue-noise'` (가안) | `blue-noise`·`bayer`·`atkinson`·`floyd-steinberg` | 감열지 화면과 회색조 유화 인쇄 데이터의 점 방식 |
| `brightness` / `contrast` / `gamma` | −0.05 / 1.5 / 1.3 (개발 PC 저장값, 중립은 0 / 1 / 1) | −0.5~0.5 (0.01) / 0.5~2 (0.05) / 0.4~2.5 (0.05) | 레벨(끔이 아니면 쓴다). 회색조 유화는 화면 미리보기·결과 사진(`FS_OUTPUT`)과 인쇄 데이터(`FS_THERMAL_REDUCE`)에 같은 값, 효과를 못 그린 원본 사진 대체도 같다(CPU `grayLevelsInPlace`). 감마 1 초과는 중간 밝기를 밝게 |
| `paperDots` | 576 (80mm·203dpi) | 128~1024 (8의 배수) | 용지 폭 점 수, 58mm는 384 |
| `bwStyle` | `'stroke'` | `tone`·`texture`·`flow`·`stroke` | 흑백 스타일(감열지에서만) |
| `bwTexture` | 1 | 0~2 (0.05) | 질감 세기. 톤 점이면 유화 획을 섞는 세기(14단계, 0이면 순수 톤 점) |
| `lineSpacing` | 4 | 2~8 (0.5) | 흐름 선·붓 결 선의 주기(인쇄 점) |
| `config.thermalDisplay` | 종이 `[246,242,233]`, 잉크 `[26,26,30]` | — | 화면 표시 색(조절 화면 밖) |

### 흑백 스타일: 유화 느낌 1비트

감열지 1비트는 **유화 느낌이 나야 한다.** 576 축소 뒤 균일한 점 잡음이 획 방향을 덮어 질감이 사라지므로 1비트로 바꾸는 방식을 고른다. 분석은 [로그 2026-10-19-04](logs/2026-10-19-04-stage7-painterly-bw.md).

| `bwStyle` | 원리 | 점을 정하는 것 |
|---|---|---|
| `tone` 톤 점 | 위 "출력 단계" 그대로. 14단계: 유화 켬·질감 세기 > 0이면 아래 "톤 점 × 유화" | `dither` (블루 노이즈 + 섞기면 `stroke-tone`) |
| `texture` 질감 강조 점 | 합성 밝기에 획 볼록 조명(`FS_BW_PREP`)을 곱하고 축소 때 국소 대비 | `dither` |
| `flow` 흐름 선 | 회색은 질감 강조와 같고, 문턱을 흐름장을 따라 블루 노이즈를 평균한 값(LIC)으로 → 흐름 방향의 결 | 점별 문턱(GPU) |
| `stroke` 붓 결 선 (기본) | 회색은 질감 강조와 같고, 문턱을 획마다 획 방향 선(삼각파)으로 → 획이 선 묶음으로 보이고 어두울수록 굵다 | 점별 문턱(GPU) |

- 획 패스가 `hgt`의 G에 붓 결 선, B에 획 볼록을 쓴다. 합성은 R만 읽으므로 **컬러 유화는 원본과 같다.** 점별 문턱(`FS_THERMAL_SCREEN`)은 8비트 정수라 CPU `ditherWithThresholds(gray, thr)`와 비트 단위로 같고 톤이 거의 보존된다.
- 식과 내부 상수(조명 배율·국소 대비·노이즈 비율·LIC 길이 등)는 `effect/oil-shaders.js`·`effect/oil-renderer.js`에 있고 합성 시험 이미지로 정한 값(가안)이다. 운영자가 바꾸는 것은 스타일·질감 세기·선 간격뿐이다.
- **일치:** 같은 프레임·seed면 같은 점 그림이고 미리보기와 결과는 같은 패스다. 선 문턱은 획·흐름장이 GPU에만 있어 GPU에서만 만들고, 결과마다 GPU 회색·문턱을 읽어 CPU가 다시 비교한다(`gpu=cpu`). 효과를 못 그리면 획이 없으므로 **톤 점**으로 찍는다(D `(style stroke -> tone)`).
- 선 스타일·질감 강조(블루 노이즈)는 비용이 톤 점과 같다. 붓 결 선은 boil에 비례해 깜빡이고, 흐름 선은 boil 영향이 작다. 선 스타일은 평균이 조금 어두우므로 실제 용지에서는 밝기·감마로 맞춘다.

**톤 점 × 유화 (14단계, 가안)** — 사용자 요청 "감열지 톤 점이 유화와 더 잘 섞이게". 예전 톤 점은 합성 밝기만 보고 576점으로 줄인 뒤 블루 노이즈를 찍어 획이 거의 사라졌다.

- **언제:** 감열지(`outputMode 'thermal'`) · 흑백 스타일 톤 점 · 유화 켬 · 질감 세기 b = `bwTexture` > 0 (`core/thermal.js` `toneOilBlend`, 0~2로 자른다). 유화 끔·b 0·다른 스타일·회색조 유화의 인쇄 데이터는 예전 그대로다.
- **명암·질감:** 회색을 질감 강조 점과 같은 `FS_BW_PREP`(획 볼록 조명) + 축소 때 국소 대비로 만들되 세기는 b × `TONE_OIL_TEXTURE`(0.6, 질감 강조 점의 6할).
- **획 방향:** 점 방식이 블루 노이즈면 문턱을 `FS_THERMAL_SCREEN` 붓 결(획 방향 선)과 블루 노이즈를 b × `TONE_OIL_LINE`(0.25) : 나머지로 섞는다(`screenOf` = `stroke-tone`, 같은 톤 보존 누적함수, 선 주기는 `lineSpacing`). 점은 고른 톤 점으로 남고 획 방향으로 조금 모인다. 베이어·오차 확산은 명암·질감만 섞는다.
- **일치:** 미리보기·결과·인쇄가 같은 `thermalStage` 패스이고, `stroke-tone`은 붓 결 선처럼 GPU 문턱을 읽어 CPU가 비트 단위로 다시 비교한다(`gpu=cpu`). 효과를 못 그리면 순수 톤 점(D `(tone oil blend -> tone)`).
- **조절:** `E` 질감 세기·선 간격이 톤 점에서도 열린다(선 간격은 블루 노이즈일 때만). 원격 필터 업데이트 형식·저장 항목은 바뀌지 않았다. 상수는 합성 장면으로 질감 세기 0·1·2를 비교해 정한 가안이고 실제 용지는 **미검증**이다.


## 7. 참고 자료

- 사진 효과 원본: 필터 갤러리 [nau-filter-gallery.vercel.app](https://nau-filter-gallery.vercel.app/) 프리셋 `oil2f`
- A. Hertzmann, "Painterly Rendering with Curved Brush Strokes of Multiple Sizes", SIGGRAPH 98
- R. Ulichney, "The void-and-cluster method for dither array generation", SPIE 1913, 1993 (블루 노이즈)
- R. W. Floyd, L. Steinberg, "An adaptive algorithm for spatial greyscale", 1976 / Bill Atkinson의 오차 확산(Apple MacPaint)
- B. Cabral, L. Leedom, "Imaging Vector Fields Using Line Integral Convolution", SIGGRAPH 93 (흐름 선)
- PNG 명세 (W3C), 1비트 회색조·CRC-32·zlib
- MDN, [MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts), [Taking still photos with getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos)
- Google AI Edge, [Face detection](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js), [Object detection](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js), [Pose landmark detection](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js) guide for Web

구현할 때 실제 버전과 대상 브라우저에서 다시 확인한다.
