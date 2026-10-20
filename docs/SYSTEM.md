# SYSTEM — 시스템 구조와 규칙

> 지금 시스템이 어떻게 동작하는지 적는다. 결정 경위·측정값·검수 기록은 [logs/](logs/)에 있고 근거가 필요한 곳에 링크했다. 기획·결정 현황은 [PROJECT.md](PROJECT.md). 인쇄 연동은 아직 없다("(이후)"로 표시).

**목차**

1. 전체 구성 — 구성도, 폴더 구성, 정적 서버, 조절값 파일 API, CSP, 스크립트 인코딩, 현장 실행 스크립트, 브라우저 확인 도구
2. 코드 책임 구분 — 모듈 경계, 폴더 규칙, 반복 오류 로그 제한
3. 카메라와 영상 — OBS 가상카메라, 화면 배치, 관람객 화면(서체), 좌우 반전, 권한, 카메라 상태와 자동 회복
4. 촬영 상태 — 촬영 한 사이클, 실패와 취소 경계, 운영자 단축키, 운영자 화면, 자동 시작과 이탈 취소, 출력 연동 시 참고 흐름
5. 촬영 시작 인식 — 얼굴 감지와 인식 상태, 감지기 상태와 장애 안내, 설정값, 인식 범위 조절, 다인원과 성능, MediaPipe 로컬 라이브러리
6. 사진 처리 — 캡처와 결과 이미지, 사진 효과(유화 · 획), 회색조 유화, 출력 단계(감열지 흑백), 흑백 스타일
7. 참고 자료

## 1. 전체 구성

```text
웹캠 ──▶ OBS (9:16 크롭·회전·보정) ──▶ OBS 가상카메라
                                              │ getUserMedia()
로컬 정적 서버 (localhost) ──▶ 같은 PC 브라우저 (세로 9:16 전체화면)
  <video> ─┬─▶ 효과 캔버스 (WebGL2: 회색조 → 유화 → 출력 단계, <video> 위를 덮음. 실패하면 원본 미리보기)
           └─▶ 얼굴 감지 (MediaPipe) ─▶ 인식 상태 ─┐
                                 키보드 S·X·P ────┤
                                                   ▼
  촬영 진행 (상태 기계) ─▶ 캡처(반전·9:16) ─▶ 결과 사진(셔터 순간 미리보기와 같은 그림) + 인쇄용 1비트 ─▶ 결과 화면
                                                                     (이후) ─▶ 로컬 인쇄 서비스
```

- 서버는 파일 제공과 조절값 파일 API만 맡고, 촬영 진행 상태는 브라우저 안에서 관리한다. WebSocket·게임 서버·원격 제어는 없다. `file://`로 열지 않는다(카메라 권한·WASM 로딩이 막힌다).
- 이전 프로젝트 PickPod_FaceReading의 로컬 실행 구조에서 최소 뼈대(bat → PowerShell, `settings.ini`, 정적 서버, OBS·Chrome 실행, 시작 프로그램 바로가기, 저장소 안 MediaPipe, 빌드 없는 ES 모듈)만 이 저장소에 새로 작성했다. 참고 저장소 경로에 의존하지 않는다. Git 자동 업데이트, NAS·AI·결제·Firebase, 워치독·자동 재시작, 야간 스케줄, 지점 인증, 다중 실행 모드·레인, 보정용 패널, 단일 거대 `main.js`는 가져오지 않았다.

### 폴더 구성

```text
Launch.bat · Shutdown.bat · Setup-Startup.bat   현장 실행·종료·시작 프로그램 등록 → bin/launch.ps1 · shutdown.ps1 · setup-startup.ps1
settings.example.ini        현장 설정 예시. settings.ini는 여기서 만들어지고 Git 제외
config/*.local.json         운영자 조절값 파일(presence = R, effect = E). 서버 API만 쓴다. Git 제외. src/web/config/와 다른 폴더
bin/common.ps1              실행 스크립트 공용 (로그, 설정, 프로그램 탐색, 프로세스 식별·종료)
bin/server/serve.ps1        정적 서버, 조절값 파일 API
src/web/                    index.html(진입점 /) · main.js(화면 조립·단축키·D 정보·연결) · style.css
  assets/fonts/             서체 부분 집합과 OFL 라이선스 (3절 "서체")
  config/   config.js(바꿀 수 있는 값) · presence-settings.js · effect-settings.js(검증·정규화·저장 형식)
            settings-file.js(조절값 파일 API 클라이언트·불러오기 순서) · guest-text.js(관람객 문구)
  core/     session.js(촬영 상태 기계) · auto-start.js · presence.js(인식 판정) · guidance.js(관람객 안내 규칙)
            log-limit.js · oil-paint.js(획 목록·해상도 비례·tick) · thermal.js(감열지 출력 단계·입력 회색조 계수)
  camera/   camera.js(장치·스트림) · camera-monitor.js(상태 감시·자동 회복) · capture.js(캡처·결과 이미지·자원 정리)
  vision/   face-detector.js · detector-keeper.js(재생성·감지기 상태) · presence-monitor.js(감지 루프)
  effect/   oil-shaders.js · oil-renderer.js(WebGL2) · effect-preview.js(실시간 미리보기) · photo-effect.js(결과 사진 효과)
  ui/       guest-screen.js · presence-tuning.js(R) · effect-tuning.js(E) · region-drag.js · dev-panel.js(D) · save-state.js
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
| `/local-api/presence-settings` | `config/presence.local.json` | `R` (5절) |
| `/local-api/effect-settings` | `config/effect.local.json` | `E` (6절) |

- `GET`: 있으면 200 `application/json; charset=utf-8`(저장한 바이트 그대로), 없으면 404. `PUT`: 아래 조건을 모두 만족하면 원자적으로 쓰고 204, 아니면 4xx와 짧은 이유. 그 밖은 405 `Allow: GET, PUT`. 두 경로가 같은 함수(`Invoke-SettingsApi`)를 쓴다. 파일 이름은 클라이언트가 정할 수 없다.
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
2. OBS에서 웹캠 소스, 9:16 크롭·회전·보정, 출력 해상도(화면에 맞춤)를 설정하고 가상카메라를 한 번 켜 본다. 반전은 하지 않는다. 트레이 시작은 OBS 설정 "시스템 트레이 사용".
3. `Launch.bat`을 실행한다(`settings.ini`가 만들어진다). 다른 값이 필요하면 고치고 다시 실행한다.
4. 키오스크에 카메라 권한 창이 뜨면 마우스로 "허용"(전용 프로필에 저장, 포트·프로필을 바꾸면 다시).
5. 카메라와 발자국 매트를 설치한 뒤 `R`로 인식 범위를 조절·저장한다(개발 PC 인식 값은 쓰지 않는다).
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

`tools/browser-check.mjs` (`npm run check:browser`): 개발 PC에서 실제 앱을 headless Chrome으로 띄워 시나리오 16개를 확인한다(한 번에 약 4분). Windows, Chrome, Node 22 이상, 설치 필요 없음.

```powershell
npm run check:browser                              # 가짜 카메라
npm run check:browser -- --camera real             # 실제 카메라 (OBS 가상카메라 우선)
npm run check:browser -- --soak --camera real      # 장시간 실측 기본 10분 (20초마다 S, 1분마다 → logs\soak_*.csv)
npm run check:browser -- --soak 60 --camera real   # 분 지정
```

- **구조:** Node 내장 `WebSocket`으로 CDP에 직접 붙는다. `serve.ps1`을 빈 포트로, Chrome을 `%TEMP%\photobooth-check-*` 임시 프로필·`--headless=new`·`--remote-debugging-port=0`으로 띄운다(늘 `--user-data-dir`이라 사용자 Chrome에 붙지 않는다). 카메라는 기본 가짜 장치(`--use-fake-device-for-media-stream`), 권한은 CDP `Browser.setPermission`.
- **앱 상태:** D 화면 글자를 줄 머리말로, 관람객 안내를 `#status`로 읽는다. **앱에 확인 전용 훅이 없다** — D 줄 형식·확정 문구를 바꾸면 도구도 고친다. 조작은 CDP 키 입력·`Fetch`(모델 404). 외부 요청·CSP 위반·페이지 예외를 기록한다(MediaPipe 통계 차단은 따로 세고 실패로 보지 않음). 생성 실패 시나리오용으로 `setInterval`·`clearInterval`을 페이지보다 먼저 감싸 센다.
- **정리:** 어떤 끝이든 자신이 띄운 Chrome·서버·임시 프로필만 정리한다(`--keep-profile`이면 프로필을 남김). 사진을 저장하지 않는다. 결과 표를 출력하고 하나라도 실패하면 종료 코드 1.
- **조절값 파일:** 시작할 때 `config/*.local.json`을 바이트 그대로(또는 "없음") 백업하고, 시나리오 뒤와 마지막에 **파일 시스템으로 직접** 되돌린다(없던 파일·빈 `config/`는 지운다). 그사이 몇 초 시험 값이 들어 있으므로 **현장 키오스크가 같은 저장소에서 도는 PC에서는 실행하지 않는다.**
- **CDP:** 요청마다 제한 시간 15초. 연결이 끊기면 모든 요청이 바로 실패해 몇 초 안에 끝나고 정리한다(`browser-check-lib.mjs`).
- **시나리오:** 페이지 로드(서체 포함) · `S` 한 사이클과 자원 정리 · 조절값 API · 감지기 생성 실패 정리 · 권한 거절 → 허용 · 모델 차단 · 효과 미리보기(기본값, 결과 사진 준비, 컨텍스트 손실·복구) · 회색조 유화 기본 촬영(결과 = 셔터 직전 그림, 무채색, 인쇄 576×1024 1비트, 출력물 폭 1/2) · 출력 모드 전환 · 흑백 스타일 4가지 · 흑백 스타일 GPU = CPU · GPU 디더 = CPU·1비트 PNG · 효과 WebGL2 생성 실패 · `E` 저장 유지 · 결과 효과 렌더 실패 · 외부 요청·CSP 위반·예외 0. 확인 값은 `tools/browser-check.mjs`에 있다. 화소 일치 시나리오는 `E`에서 처리 해상도를 1로 두고 실제 `1080x1920`으로 그린 뒤 시작한다.
- **범위 밖:** 가짜 카메라에 얼굴이 없어 자동 시작·이탈 취소·인식 중 `P`는 확인하지 않는다(Node 테스트 `test/core/auto-start.test.mjs`·`test/vision/presence-monitor.test.mjs`와 사람 실측). 키오스크, OBS 시작·중지, 절전 복귀, 4K도 범위 밖. `S` 사이클은 `P`를 켜고 돌려 실제 카메라 앞에 사람이 있어도 된다.
- **장시간 실측:** `--interval`(기본 20초)마다 대기면 `S`. 1분마다 CSV에 JS 힙·DOM 노드·리스너·문서 수(`Performance.getMetrics`), D 화면 값, 이 프로필 `chrome.exe` 메모리(`PrivatePageCount`·`WorkingSetSize` 합), 콘솔·예외 수. 끝나면 항목별 통계와 시간당 기울기(처음 5분 제외 포함). 통과: 모든 기록에서 카메라 `ready`·감지기 `ok`, `S` 직전마다 사진 자원 0·`taken = released`, 측정값을 모두 읽음, 외부 요청·CSP 위반·예외 0, 완료 1회 이상.

## 2. 코드 책임 구분

| 영역 | 경계 |
|---|---|
| 카메라 | 장치 선택·스트림(`camera.js`), 첫 프레임·끊김·자동 회복(`camera-monitor.js`) |
| 얼굴 감지 | `face-detector.js`는 사전 확인·생성·실패 정리·감지·종료만 하고 영상 기준 정규화 박스·점수만 돌려준다(MediaPipe 자료형을 내보내지 않음). `detector-keeper.js`가 재생성·감지기 상태 |
| 인식 판정 | `presence.js` 순수 함수, `presence-monitor.js`는 "인식됨 / 인식 안됨"과 감지기 상태(`{ health, cause, since }`)만 밖에 알린다. 좌표·점수는 `getDebugSnapshot()`(D 전용)으로만 |
| 촬영 시작 입력 | 키보드(`main.js`)와 인식(`auto-start.js`)이 `session.request('start' \| 'cancel' \| 'reset')` 한 입구로 요청만 보낸다. 시작 여부는 상태 기계가 정한다 |
| 촬영 진행 | `session.js`: 상태 전환·타이머·회차·취소·초기화·결과 종료 시계. DOM·카메라를 모르고 시계·타이머·사진 함수를 주입받는다 |
| 이미지 | `capture.js`: 반전 캡처, 효과 단계 호출, 인코딩, 인쇄 데이터 붙이기, Object URL 생성·정리, 남은 자원 수 |
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
| `assets/` | 서체(JS 없음). 밖에서 가져온 파일은 라이선스 파일과 함께 | — |
| `effect/` | 사진 효과 WebGL 렌더와 실시간 미리보기 | `effect`, `core`, `config` |

- **`core` 규칙(`test/core-deps.test.mjs`가 검사):** `core`와 거기서 전이적으로 닿는 파일은 `core/`·`config/` 안에 있고, 브라우저 전역(`document`, `window`, `navigator`, `location`, `localStorage`, `fetch`, `WebSocket`, 캔버스·이미지·미디어 생성자, `requestAnimationFrame` 등)을 쓰지 않는다. 동적 `import()`는 문자열 경로만. 타이머·`performance`·`Date`·`console`·`URL`은 허용. `globalThis`·`window`·`self`는 어느 형태로든 쓰면 위반이고, 예외는 매개변수 기본값 `timers = globalThis`(`core/session.js`)를 타이머 네 함수 호출로만 쓸 때뿐이다. 검사기는 완전한 파서가 아니다(범위를 추적하지 않아 한 파일의 지역·전역 같은 이름은 놓칠 수 있고, 애매한 `/`는 나눗셈으로 본다).
- `config/settings-file.js`는 기본 `fetch`가 전역이라 순수하지 않으므로 `core`에서 부르면 검사가 실패한다.
- `camera`·`vision`·`ui`·`effect`끼리는 서로 부르지 않고 `main.js`가 잇는다(효과 미리보기는 `camera`의 `isReady`와 `<video>`를 주입받는다). `ui`는 `core/session`의 상태 이름을 쓴다. `config`·`core`는 바깥 폴더를 부르지 않는다. 자동 검사는 `core` 행뿐이고 나머지는 규칙으로 지킨다.
- 테스트는 `test/` 아래 소스와 같은 이름 폴더에, 주 대상 모듈 위치를 따라 둔다(1개짜리라도 둔다: `test/camera/`, `test/tools/`).

### 반복 오류 로그 제한

`core/log-limit.js`의 `errorLog`가 분류(`camera`, `detector`, `detection`, `capture`, `effect`, `effect-capture`, `effect-prepare` 등)마다 마지막 오류를 기억한다. 숫자만 다른 오류는 같은 오류다. 처음·바뀐 오류는 바로 남기고, 이어지면 세기만 하다가 60초(`LOG_SUMMARY_MS`, 가안)가 지나면 `[camera] 같은 오류 20회 더 (마지막 10:01:00): ...` 한 줄을 남긴다. 회복하면 요약하고 기억을 지운다. 별도 타이머는 없다. 브라우저가 직접 찍는 메시지(404, CSP)는 포함되지 않는다.

## 3. 카메라와 영상

### OBS 가상카메라

- 9:16 크롭·회전·색 보정은 OBS가 하고, 출력 해상도는 화면에 맞춘다(1080×1920 ~ 2160×3840). 캡처 해상도 상한은 OBS 출력이다.
- 라벨에 `OBS Virtual Camera`(`config.preferredCameraLabel`, 대소문자 무시)가 있는 장치를, 없으면 기본 카메라를 쓴다. 라벨이 비어 있으면(권한 전) 권한을 한 번 요청하고 다시 읽으며, 그 스트림이 고른 장치면 그대로 쓴다. 기본 카메라로 연결된 뒤 OBS가 나타나면 OBS로 바꾼다.
- 해상도는 **`ideal`로만** 요청한다(`config.idealResolution` 2160×3840). `exact`·`min`은 지원하지 않는 장치에서 실패하고, 제약이 없으면 640×480 같은 낮은 형식이 올 수 있다. Chrome은 장치 범위에서 가장 가까운 값을 원본보다 키우지 않고 고르며 잘라 줄일 수 있다(가짜 카메라 2160×2160). 실제 크기는 D `video`·`track`.
- OBS 없이 일반 웹캠도 동작한다(9:16이 아니면 가운데 기준으로 잘라 채운다).

### 화면 배치

- 9:16 영역(`#stage`)을 뷰포트 가운데에 최대 크기로 두고 밖은 검정(꾸미지 않음), 영역 바탕은 차콜(`--charcoal`). 비율은 `config.aspectRatio`.
- `<video>`는 `object-fit: cover`(가운데 기준). 효과 캔버스(`#effect`)가 그 바로 위를 같은 크롭으로 덮고, 효과를 못 쓰면 숨긴다.
- D 정보는 기본 숨김이고 관람객 화면에 노출하지 않는다.

### 관람객 화면

**미니멀·에디토리얼·갤러리 느낌.** 세부 모양·문구·수치는 가안이다. 디자인 이유는 [로그 2026-10-19-05](logs/2026-10-19-05-stage7-minimal-ui.md).

- **주인공은 미리보기.** UI는 최소, 장식·SVG·크리스마스 표현 없음, 무채색만(`style.css` `:root`: `--white` `#f4f2ee`, `--wall` `#eeece7`, `--charcoal` `#1a1a1a`, `--gray`).
- **얼굴·가운데를 가리지 않는다:** 글자·숫자는 9:16 영역 **아래 15%(26.67cqw) 안**에만(3·2·1 묶음 위끝은 높이의 85.66%). 불투명한 원판·카드·알약 없음.
- **대비:** 아래 그라데이션 띠(`.frame-shade`, 영역 아래 18%, 투명도 0.62 → 40% 0.52 → 66% 0.46 → 86% 0.12 → 0)와 글자 그림자(숫자 번짐 0.6). 띠는 대기 안내·카운트다운·쿨타임 문구가 보일 때만.
- **해상도 독립:** 길이·글자는 모두 `cqw`(영역 폭의 1%, `.stage`의 `container-type: inline-size`), px 상·하한 없음. `--hairline` 0.0926cqw(1080 폭 1px). 1080×1920·2160×3840·1920×1080·1200×1080에서 위치 비율이 같다.
- **움직임은 `transform`·`opacity`만.** 늘 도는 애니메이션은 준비 중 가는 선 하나. 결과 사진은 `decoding="async"`.
- **문구:** 모두 `src/web/config/guest-text.js`. "준비 중"·"직원 문의"는 확정이고 확인 도구가 이 글자로 상태를 읽는다.

| 상태 | 보이는 것 (DOM 쌓임 순서: `#result-view`, `#status-veil`, `.frame`, `#guide`, `#countdown`, `#notice`, `#flash`, `#pause-badge`, `#status`) |
|---|---|
| 대기 | 미리보기 + 가는 선 프레임(`.frame-line`, 가장자리 3.6cqw 안쪽, 투명도 0.3) + `#guide` "발자국 위에 서 주세요"(Pretendard 3.1cqw, 자간 0.08em, 아래에서 6.4cqw). 카메라·감지기가 정상일 때만 |
| 인식 | 선이 또렷해진다(0.95, 0.6초, `#stage.is-present`). 대기·카운트다운·쿨타임 중에만. `config.showPresenceIndicator`가 `false`면 늘 흐림 |
| 카운트다운 | `#countdown`: 숫자(Noto Serif KR Light 9.6cqw, 1초마다 조용히 나타났다 흐려짐), 가는 진행선(폭 28cqw, 가운데에서 양쪽으로 차오름), "화면을 보며 웃어 주세요" |
| 촬영 순간 | `#flash` 흰 페이드: 약 40ms에 0.55까지, 0.28초에 사라짐 |
| 결과 | `#result-view`: 오프화이트 벽 위 출력물(`#result-card`, 흰 여백 2.2222cqw·가는 테두리, 기울임·그림자 없음, 0.6초 동안 1.6cqw 떠오름). 사진 폭은 연속 톤이면 **50cqw**(1080 화면 정확히 1/2, 4K 1:1), 1비트 점(감열지, `.is-dots`, 사진의 `dots`)이면 **53.333cqw**(576/1080, 점이 화면 화소와 1:1). 남은 시간 진행선(`#result-timer`)과 "출력된 사진을 받아 가세요" |
| 결과 (출력 중, 이후) | 종료 시계가 멈추면(`endsAt` = `null`) 진행선을 숨기고 "사진을 출력하고 있습니다" |
| 쿨타임 | `#notice` "다음 촬영을 준비하고 있습니다"(대기 안내 자리) |
| 준비 중·직원 문의 | `#status-veil` 차콜 막(0.95) + `#status` 두 줄: "준비 중입니다."(Noto Serif KR Light 6.2cqw) / 둘째 줄(Pretendard 3.3cqw 회색). 위 가는 선이 준비 중이면 숨 쉬고(2.4초) 직원 문의면 멈춘다 |

**서체** (`src/web/assets/fonts/`, 합계 약 566KB)

| 서체 | 쓰는 곳 | 파일 | 출처 | 라이선스 |
|---|---|---|---|---|
| Pretendard 400·500 | 관람객 안내(400), 운영자 패널 본문(400)·제목·주 버튼(500) | `Pretendard-Regular.subset.woff2`(267,096바이트), `Pretendard-Medium.subset.woff2`(268,324바이트) | GitHub `orioncactus/pretendard` v1.3.9 `Pretendard-1.3.9.zip`의 `web/static/woff2-subset/` 그대로(한글 2,780자, KS X 1001 2,350자 포함 + 영숫자·기호) | SIL OFL 1.1, `OFL-Pretendard.txt` |
| Noto Serif KR 300 | 3·2·1 숫자, 준비 중·직원 문의 첫 줄 | `NotoSerifKR-Light.subset.woff`(30,988바이트) | GitHub `notofonts/noto-cjk` `Serif2.003`의 `13_NotoSerifKR.zip` `SubsetOTF/KR/NotoSerifKR-Light.otf`(2.003)를 `fontTools` 4.63 `pyftsubset`으로 줄임: `guest-text.js` 문구 글자 + U+0020–007E + `· – — ‘ ’ “ ” …`, 이름 표·`kern`·`liga`·숫자 기능 유지, woff | SIL OFL 1.1, `OFL-NotoSerifKR.txt`. 부분 집합은 OFL 수정본이고 예약 이름("Source")은 쓰지 않는다 |

- Pretendard 부분 집합은 `src/web`에 쓰인 한글을 모두 담는다(그 밖은 시스템 서체). `index.html`이 Pretendard 400과 세리프를 `<link rel="preload">`로 미리 받는다(Medium은 운영자 패널 전용).
- **세리프는 문구에 묶여 있다.** `test/config/guest-text.test.mjs`가 세리프가 `guestText`의 모든 글자·숫자를 담는지 WOFF `cmap`으로 검사한다. 실패하면 원본 OTF에서 다시 줄인다(저장소에 스크립트 없음, Python `fontTools` 필요. `<문구 글자 파일>`은 `guestText`의 공백 아닌 비ASCII 글자를 UTF-8로 적은 것):
  ```text
  python -m fontTools.subset NotoSerifKR-Light.otf --text-file=<문구 글자 파일> --unicodes="U+0020-007E,U+00B7,U+2013,U+2014,U+2018,U+2019,U+201C,U+201D,U+2026" --flavor=woff --layout-features="kern,liga,lnum,tnum,pnum,onum" --name-IDs="*" --notdef-outline --output-file=NotoSerifKR-Light.subset.woff
  ```

### 좌우 반전

- 미리보기와 결과 모두 반전한다(확정). 반전은 **웹에서만**(OBS에서 하지 않음, 이중 반전 방지), 경로마다 한 번: `<video>`는 `.preview.is-mirrored { transform: scaleX(-1) }`, 효과는 입력을 읽을 때(효과 캔버스에 CSS 반전 없음, 획이 좌우 대칭이 아니므로 반전된 그림에 칠한다), 캡처는 `capture.js`. 모두 `config.mirror`. 보이는 영역과 캡처 영역이 일치한다.

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
- **설정값 (확정, `config.cameraRecovery`):** 재시도 3초, 첫 프레임 제한 5초, 프레임 정지 3초, 직원 문의 전환 30초.
- **관람객 문구 (확정):** 정상이 아니면 "준비 중입니다. 잠시만 기다려 주세요.", 30초 이상이거나 `unsupported`·`permission-denied`면 "준비 중입니다. 직원에게 문의해 주세요." 끊기면 영상을 지우고 문구를 띄운다. 감지기 상태와 합쳐 판정한다(5절).
- **D:** 상태, 원인과 원본 오류 이름, 시도·연속 실패 횟수, 마지막 시도 시각, 정상이 아닌 시간, 권한 상태.
- **경계:** `createCameraMonitor()`의 `isReady()`, `getState()`, `subscribe(listener)`(해제 함수 반환), `getFrameInfo()`(실제 새 프레임의 마지막 시각 `performance.now()` 기준·누적 프레임 수, 영상 내용은 없음)만 쓴다. 캡처는 이 시각으로 정지 화면을 거르고, 감지 루프는 누적 수로 같은 프레임을 다시 세지 않는다.
- 경과 시간은 `performance.now()`, 사람이 읽는 시각(D `lastAttemptAt`, 자동 시작 기록)만 `Date`.

## 4. 촬영 상태

### 촬영 한 사이클

`core/session.js`(상태·타이머), `camera/capture.js`(캡처·자원), `main.js`(화면·입력 연결). 화면 모양은 3절 "관람객 화면".

```text
대기 ─(시작 요청: 대기 + 카메라 준비 + 페이지 보임)─▶ 카운트다운 3·2·1      시작 요청 = 키보드 S 또는 인식 레벨 판정
카운트다운 ─(3초)─▶ 촬영·결과 준비(capturing) ─▶ 결과 표시 ─(10초)─▶ 쿨타임 ─(5초)─▶ 대기
카운트다운 ─(취소 / 카메라 준비 해제 / 페이지 숨김)─▶ 대기 (쿨타임 없음)
촬영·결과 준비 ─(실패·5초 초과·정지 화면)─▶ 대기 (쿨타임 없음, 자동 시작은 실패 대기 동안 쉼)
어느 상태든 ─(강제 초기화 X)─▶ 대기 (쿨타임 없음)
(이후) 결과 표시 = 출력 중(종료 시계 정지) ─(출력 완료 확인)─▶ 10초 ─▶ 쿨타임
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
- **설정값 (`config.session`):** `countdownSeconds` 3, `resultMs` 10000, `cooldownMs` 5000(확정). `captureTimeoutMs` 5000, `failureRetryMs` 5000, `failureRetryMaxMs` 60000(가안).
- 쿨타임(확정)은 5초 동안 시작 요청을 무시하는 단순 대기다. 스윗스팟이 비었는지 보지 않으므로 계속 서 있는 사람은 쿨타임이 끝나는 즉시 다음 회차다(`presentHoldMs`는 추가 완충이 되지 않는다).
- 미리보기와 감지는 사이클 내내 돈다(쿨타임이 끝나는 순간의 인식 상태로 바로 판정).

### 실패와 취소 경계

- 촬영마다 `AbortController`를 새로 만들어 `takePhoto({ signal })`로 넘기고, 제한 시간 초과·강제 초기화 때 abort한다. `capture.js`는 abort되면 바로 실패하고 캔버스를 비우며, 효과 단계(`applyPhotoEffect(canvas, { signal })`)도 같은 신호를 받는다. 늦게 온 캔버스는 비우고 늦은 인코딩으로는 Object URL을 만들지 않는다.
- 취소된 회차의 작업이 끝나지 않았으면(`toBlob` 콜백이 안 오는 경우 등) 다음 `take()`는 `capture busy`로 바로 실패한다.
- **실패 뒤 자동 시작 대기:** 실패(예외, 시간 초과, 정지 화면, `capture busy`)마다 연속 실패 수를 세고 자동 시작을 `failureRetryMs`부터 두 배, 최대 `failureRetryMaxMs`(5→10→20→40→60초) 쉰다(`retryAt`). 끝나면 다시 평가하고, 성공하면 기록을 지운다. 이것이 없으면 "실패 → 대기 → 자동 시작"이 약 3초마다 반복된다. `S`는 쉬는 중에도 되고, `X`는 기록을 지우지 않는다.
- **D:** `failures`(연속 실패 수, 자동 시작까지 남은 시간), `last end`(실패 이유), `resources`(남은 Object URL·캔버스·`pending jobs`·인쇄 데이터).

### 운영자 단축키

수정 키(`Ctrl`·`Alt`·`Meta`) 없이 누른 한 키만(`main.js` `Keys`, `event.code`), 누르고 있을 때의 반복은 무시한다. 관람객 화면에 노출하지 않는다.

| 키 | 동작 |
|---|---|
| `D` | 개발용 정보·감지 박스 겹쳐 그리기 (`R`과 따로) |
| `R` | 인식 범위 조절 화면 (`Esc`로도 닫음, 5절) |
| `E` | 사진 효과 조절 화면 (`Esc`로도 닫음, 6절) |
| `S` | 수동 촬영(`session.request('start', 'key')`). 대기·카메라 준비일 때만. 수동 회차는 사람이 없어도 끝까지 찍는다 |
| `X` | 강제 초기화(`session.request('reset', 'key')`) |
| `P` | 자동 촬영 일시정지·다시 켜기 |

- `Space`·`Enter`는 쓰지 않는다(패널 버튼 포커스와 겹침). `R`·`E`가 열려 있어도 `S`는 된다. `R`과 `E`는 한 번에 하나만 열리고 다른 쪽 키는 무시한다(저장하지 않은 변경이 말없이 취소되지 않게).
- **`P`:** 판정은 `decideAutoRequest()`의 `paused` 하나. 멈추는 순간 인식으로 시작된 카운트다운을 취소하고(쿨타임 없이), 사람이 있어도 다시 시작하지 않는다. `S`와 수동 카운트다운은 그대로다. **저장하지 않아** 새로고침·재시작하면 다시 켜진다(해제를 잊어도 회복). 일시정지 중 영역 오른쪽 위에 "자동 촬영 일시정지 (P)"(`#pause-badge`, 3.6cqw 안쪽, 영역 폭의 1.7%, 가안, `config.showPauseIndicator`), D `auto` 줄 앞에 `PAUSED (P)`.

### 운영자 화면

`E`·`R` 패널, `D`, `P` 표시, `R` 겹쳐 그리기. 관람객 화면과 같은 무채색이다. 디자인 이유는 [로그 2026-10-19-03](logs/2026-10-19-03-stage6-operator-ui.md).

- **모양:** 차콜 반투명 패널(`--op-bg`), 1px 선, Pretendard 500·400, 숫자는 고정폭 오른쪽 정렬, 채도 낮은 상태 색은 점·글자·왼쪽 선에만, `color-scheme: dark`, 움직임·블러 없음(미리보기 성능). 크기는 `--op-size`(D는 `--op-dev-size`, 둘 다 `clamp(…vmin…)`)에 `em`으로 맞춰 해상도와 관계없이 같은 비율이고, 영역 안 요소는 `cqw`.
- **패널 (`.op-panel`):** 머리(제목, "R·Esc 닫기 · 저장하지 않은 변경은 닫을 때 취소", `위·아래`(`data-action="dock"`)·`닫기`) / 실시간 줄(`[data-live]`, `R` 인식 상태·감지·인정 수, `E` 미리보기 해상도·초당 그림·그리기 시간·인쇄 해상도·점 방식) / 넘기는 몸통(묶음 `fieldset.op-group`, 줄 `.op-row` = 이름·도움말 · 조작 · 값·단위) / 늘 보이는 아래(저장 상태 `[data-state]`·패널 `data-save`, 저장·취소·기본값, 알림 `[data-message]`).
- **묶음:** `E` = 효과(강도·붓 크기·획 다시 그리기·색 보정·세부 보존 문턱) / 출력 단계(출력 모드·점 방식·용지 폭·밝기·대비·감마·흑백 스타일·질감 세기·선 간격) / 미리보기(초당 그림·처리 해상도). `R` = 영역 / 얼굴 크기(가이드 색 견본) / 신뢰도 / 고급: 판정 시간(접힘) / 현재값 JSON(접힘). 쓰지 않는 항목은 흐리게 막힌다.
- **저장 상태 (`ui/save-state.js`, 문구 가안):** 바꾸는 중 `dirty`(저장 안 된 변경, 닫으면 취소)·`saving`·`failed`(파일은 이전 값, 다시 바꾸거나 저장 성공 때 풀림). 바꾸지 않았으면 불러온 결과: `saved`(파일에서 읽음·옮김·이번에 저장), `defaults`(파일 없음), `load-failed`(읽기 실패·시간 초과·형식 오류), `adjusted`(파일 값을 고쳐 씀·옮기지 못함 → 저장 필요). 저장할 것이 없으면 저장 버튼이 차분해진다(누를 수는 있다).
- **위치:** 세로 화면은 아래(기본)·위, 높이 `50vh`까지(얼굴이 있는 위쪽 절반을 가리지 않음). 9:16 옆 빈 폭에 26em이 들어가면 옆(기본 오른쪽, `위·아래`로 왼쪽). `main.js` `updateOperatorRoom`이 창 크기마다 재서 루트에 `.op-side-room`(1920×1080은 옆, 1200×1080은 아래·위).
- **선택자** `#effect-panel`·`#tuning-panel`, `input`·`select[data-key]`, `button[data-action]`, `[data-live]`·`[data-state]`·`[data-message]`·`[data-json]`·`[data-region-text]`는 확인 도구·테스트가 쓰므로 바꾸지 않는다.
- **D (`#dev-info`, `ui/dev-panel.js`):** `main.js`가 정한 줄을 구역(카메라·인식·효과 · 출력·촬영)별 표로 보인다(구역 제목은 CSS `::before`라 글자에 없음). **`textContent`는 줄 글자 그대로**(줄 `\n`, 구역 사이 빈 줄)라 확인 도구가 읽는다. 색은 `devLineTone`(정상 초록·주의 주황·오류 빨강, 예: `status` ready/starting/그 밖, `detector` ok/retrying/fault, `effect` running/waiting/fallback, `photo-fx` applied/RAW, `auto` PAUSED, `failures` 0 아님). 왼쪽 위(옆 공간이 있으면 그 폭), 길면 휠로 넘기고, `R`이 열려 있는 동안은 마우스를 통과시킨다. 줄별 내용은 각 절에 적었다.
- **`R` 겹쳐 그리기 (`main.js` `OVERLAY`):** 편집 사각형(오프화이트 선·어두운 테두리, "인식 영역" 이름표, 핸들 영역 폭의 3.4%), 인식 영역 오프화이트 점선, 최소 얼굴 가이드 파랑 `#8fb6d6`·최대 붉은색 `#e0a39a`, 인정 얼굴 초록·제외 빨강(박스 위 점수, 중심 점). 선 굵기·글자는 영역 폭에 비례한다. D를 켜도 인식 영역과 감지 박스를 같은 색으로 그린다.

### 자동 시작과 이탈 취소

`core/auto-start.js`: 순수 판정 `decideAutoRequest()`를 연결부 `createAutoStart()`가 계기마다 불러 `session.request(..., 'presence')`를 보낸다. 인식 상태는 "인식됨 / 인식 안됨"만 받는다.

**레벨 판정 (확정):** 상태가 바뀌는 순간이 아니라 평가할 때의 상태로 정한다.

| 상태 기계 | 조건 | 요청 |
|---|---|---|
| `idle` | 일시정지 아님 + 조절값 불러오기 끝남 + 인식됨 + 카메라 준비 + 페이지 보임 + `R`·`E` 닫힘 + 촬영 실패 대기 아님 | `start` |
| `idle` | 하나라도 아님 | 없음. D `auto`에 이유(`blocked: auto paused (P)`·`settings-loading`, `idle, not present`, `blocked: camera-not-ready`·`page-hidden`·`tuning-open`·`capture-failed (retry wait)`) |
| `countdown` (출처 `presence`) | 일시정지 또는 인식 안됨 | `cancel`(일시정지면 `auto paused during countdown`) → 쿨타임 없이 대기 |
| `countdown` (출처 `key`) | 무엇이든 | 없음(수동 회차는 인식으로 취소하지 않음) |
| `capturing`·`result`·`cooldown` | 무엇이든 | 없음 |

- **평가 계기:** 인식 상태 변화, 상태 기계 알림(대기 진입, 카메라 준비·페이지 보임 변화), 조절 화면 닫기(`tuning-closed`·`effect-tuning-closed`), `P`(`paused (P)`·`resumed (P)`), 조절값 불러오기 끝(`settings-loaded`). 카메라·페이지 값은 상태 기계 스냅숏을 쓴다(따로 구독하면 상태 기계보다 먼저 평가해 시작이 무시될 수 있다). 재진입하면 평가를 끝낸 뒤 한 번 더 한다.
- 이탈 유예는 따로 없다(`absentGraceMs` 1초가 흡수). 취소 뒤에는 다시 "인식됨"(`presentHoldMs` 0.5초)이 되어야 새 회차가 시작된다.
- **조절 화면이 열려 있으면** 자동 시작을 막는다(`R`은 범위를 맞추는 중, `E`는 운영자가 자기 모습에 입힌 효과를 보는데 자동 회차가 가린다. 결과 사진은 `S`로 본다). 열기만으로 진행 중인 회차를 취소하지는 않고, 닫을 때 사람이 서 있으면 바로 시작될 수 있다.
- **인식 조절값 불러오는 동안**(최대 약 3초) 막는다. 불러온 값을 넣으면 기준이 바뀌어 인식을 처음부터 다시 잰다.
- **D:** `session`에 출처(`by presence`·`by key`), `auto`에 판정 이유·마지막 자동 시작·취소 시각과 계기(예: `entered idle (completed)`, `presence: absent`). 시작 직후 한 번은 이전 계기가 보이고 다음 갱신(0.5초)에 바뀐다.
- "곧 촬영해요" 같은 인식 문구는 두지 않는다(바로 카운트다운으로 넘어간다).

### 출력 연동 시 참고 흐름 (이후)

참고 프로젝트 방식: ① 결과 화면에 들어가면 로컬 인쇄 서비스에 출력 작업 요청(요청 ID 포함) ② 확인 전까지 "출력 중"을 보이고 종료 시계를 멈춤 ③ 작업 상태(`queued`/`processing`/`succeeded`/`failed`)를 짧은 간격으로 조회 ④ `succeeded`이고 드라이버 전송이 확인되면 10초 종료 시계 재개 ⑤ 실패·시간 초과면 직원 문의 안내, **자동 재출력 없음**, 종료 시계는 재개 ⑥ 끝난 회차의 늦은 응답은 무시. "출력 인식"은 용지 배출이 아니라 드라이버 전송 완료라 프린터 종류에 따라 다시 확인한다. 넘길 데이터는 사진의 `print`(6절)이고, Blob 소유권·해제 시점과 회차 식별자 연결은 그때 정한다.

## 5. 촬영 시작 인식

목적은 신원 식별이 아니라 **스윗스팟에 촬영 대상이 있는지**다. 발자국 매트로 위치·거리(약 2m 이내)가 고정되므로 조건을 단순하게 둔다. 감지기는 MediaPipe Face Detector(short-range, 정면·랜드마크 불필요)이고, 얼굴 누락이 잦으면 Object Detector(`person`)·Pose Landmarker를 비교한다. 프레임 변화량만으로 사람을 가린다고 가정하지 않는다. 아이 키·고개 돌림은 실측이 필요하다.

### 얼굴 감지와 인식 상태

```text
camera-monitor (ready·페이지 보임) ──▶ presence-monitor 감지 루프 (최대 15fps)
  <video> ─drawImage─▶ 축소 캔버스(긴 변 ≤ 640px) ─▶ face-detector.detect()   영상 좌표 박스·점수
                                                     ─▶ presence.classifyFaces()   화면 좌표, 얼굴별 인정 여부
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

- 모든 판정·영역·겹쳐 그리기는 **화면 좌표**(9:16 영역 기준 0~1, cover 크롭·반전 후)다. 영상이 9:16보다 넓으면 가운데 세로 띠(폭 `(9/16) / 영상 비율`), 좁으면 가로 띠만 보이고, `config.mirror`면 `x' = 1 - x - width`. 잘려 안 보이는 얼굴은 제외된다.
- 얼굴 인정(경계 포함): 박스 중심이 `region` 안, 박스 높이(영역 높이 대비)가 `minFaceHeight` 이상·`maxFaceHeight` 이하(큰 오검출 박스를 거른다), 점수 `minScore` 이상. 인정 얼굴이 1명 이상이면 그 프레임은 "있음".
- 처음은 인식 안됨. "있음"이 `presentHoldMs` 동안 끊기지 않으면 인식됨, "없음"이 `absentGraceMs` 동안이면 인식 안됨. 반대 프레임이 하나라도 나오면 처음부터. 감지 프레임이 올 때만 판정한다(15fps면 최대 약 67ms 늦음).

**감지 루프 (`presence-monitor.js`)**

- 카메라 `ready`·페이지 보임·영상 크기 0 아님일 때만 돌고, 아니면 `paused`로 멈추고 인식 안됨으로 되돌린다.
- 누적 프레임 수가 그대로면 감지를 건너뛴다(D `faces` `same-frame skips`). 판정 기준이 `setSettings()`로 바뀌면 인식 상태를 처음으로 돌리고 바로 "인식 안됨"을 알린다(값이 같으면 그대로, D `criteria resets`).
- 입력은 긴 변 `inputMaxSize`(640) 이하(OBS 1080×1920 → 360×640). 간격은 `1000 / maxFps`에서 처리 시간을 뺀 값, `detectForVideo` 타임스탬프는 `max(performance.now(), 직전 + 1)`.
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

- **경계:** 촬영 쪽은 `createPresenceMonitor()`의 `isPresent()`·`subscribe(listener)`(등록 즉시 한 번, 그 뒤 바뀔 때 `{ present }`, 해제 함수 반환)와 `getDetectorHealth()`·`subscribeDetector(listener)`(`{ health, cause, since }`, `since`는 감지기가 없게 된 시각 또는 `null`)만 쓴다. `getDebugSnapshot()`은 D 전용, `setSettings()`는 `R` 전용.
- **관람객 안내 (`guidance.js`):** 카메라 `ready`·감지기 `ok`면 문구 없음. 하나라도 아니면 "준비 중입니다. 잠시만 기다려 주세요." `staffNoticeMs`(30초) 이상이거나 카메라 `unsupported`·`permission-denied`, 감지기 `fault`면 "준비 중입니다. 직원에게 문의해 주세요." 시간은 둘 중 하나라도 쓸 수 없게 된 때부터 이어서 재고, 둘 다 정상이면 처음으로.
- 감지기를 쓸 수 없으면 인식 표시와 대기 안내를 숨긴다. 쿨타임 문구는 안내 문구가 없을 때만. **`S`는 감지기 장애 중에도 된다**(상태 기계는 카메라만 본다). 회차 진행 중에는 안내 문구를 숨기고 대기에서 다시 보인다.
- **D:** `detector : <루프 상태>, health <상태> / <원인> (<원인 설명>)`(예: `webgl-unavailable` "하드웨어 가속 꺼짐 또는 WebGL 없음", `model-invalid` "모델 파일 손상 (크기·SHA-256 불일치)"), 정상이 아니면 `failure`·`retry`(연속 실패, 시도 수, 다음 재시도 또는 `creating now`, 쓸 수 없던 시간). `webgl`, `model`(`sha256 ok`), `guidance`, `delegate`, 감지·그리기 시간, 감지 빈도·입력 크기, 얼굴·인정 수, 안정화 진행(`-> present 343/500ms`), 현재 기준값과 출처(`settings : file`·`migrated`·`localStorage`·`defaults (이유)`·`saved`·`loading`, `+ unsaved changes`), 얼굴별 점수·높이·중심·제외 이유(`region`·`small`·`large`·`score`), 감지 오류 수. `R` 패널은 루프 상태(`loading`·`running`·`paused`·`error`)를 쓴다.

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
| `presence.presentHoldMs` / `absentGraceMs` | 500 / 1000 | 인식됨·인식 안됨까지 유지 시간 |
| `showPresenceIndicator` / `showPauseIndicator` | `true` / `true` | 인식 표시 선 / `P` 운영자 표시 (가안) |
| `settingsFile.url` / `timeoutMs` | `/local-api/presence-settings` / 3000 | 인식 조절값 파일 API, 읽기·쓰기 제한 (가안) |

`presence.*`는 기본값이고 `R`에서 저장한 값이 있으면 그 값이다. 판정은 매 프레임 현재 설정을 읽어 다음 감지부터 반영된다.

### 인식 범위 조절

`R` 운영자 화면(마우스·키보드 사용). 불러오기가 끝나기 전에는 열리지 않는다. 열면 패널, 편집 사각형, 감지 박스, 얼굴 크기 가이드(영역 가운데 최소·최대 정사각형)가 보이고, 닫으면 모두 숨는다(인식 표시·대기 안내는 원래대로).

| 항목 (`presenceLimits`) | 조작 | 범위 |
|---|---|---|
| 영역 `region` | 안을 끌어 이동, 8개 핸들로 크기 | 9:16 안, 폭·높이 0.1 이상 |
| `minFaceHeight` / `maxFaceHeight` | 슬라이더 0.005 단위, 서로를 넘지 못함 | 0.01~1 |
| `minScore` | 0.01 단위 | 0.3~1 (하한 = 감지기 자체 기준) |
| 고급 `presentHoldMs` / `absentGraceMs` | 50ms 단위 | 0~5000ms |

- 끌기는 시작 위치 대비 이동량, 반대쪽 변 고정. `window`에서 포인터를 받아 영역·화면 밖에서도 이어지고, `pointerup`·`pointercancel`·`blur`·`lostpointercapture`·주 버튼이 떼어진 이동(`(buttons & 1) === 0`, 그 이동은 무시)·화면 닫기로 끝나며 리스너를 모두 푼다(`region-drag.js`).
- **즉시 반영**(`setSettings()`)되고 인식을 다시 잰다(인식으로 시작된 카운트다운은 취소된다).
- **저장**해야 `config/presence.local.json`에 남는다(서버 필요). 형식 `{ "version": 1, "settings": { "region": {...}, "minFaceHeight", "maxFaceHeight", "minScore", "presentHoldMs", "absentGraceMs" } }`(2칸 들여쓰기). 저장 중에는 버튼을 막고 "저장 중...", 204여야 저장으로 인정. 실패(서버 없음·거절·3초 초과)면 "저장하지 못했습니다: HTTP 500 (...)" 같은 이유를 보이고 저장 안 된 상태로 남는다. 누른 순간의 값만 저장한다.
- **저장 중 닫기**(`R`·`Esc`·닫기)는 응답(최대 3초) 뒤 닫으면서 파일에 마지막으로 저장된 값으로 맞춘다("저장 중입니다. 저장이 끝나면 닫습니다.").
- **취소**는 마지막 저장값(없으면 기본값), **기본값으로**는 `config.presence`(저장해야 유지). **저장하지 않고 닫으면 저장된 값으로 되돌린다** — 실행 중 값과 재시작 값이 늘 같게. 확인 창 대신 "저장하지 않은 변경이 있습니다 (닫으면 취소됩니다)"를 늘 보인다.
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
1. **프레임 잡기(동기):** 미리보기와 같은 cover 계산(`computeCoverMapping` → `computeCaptureCrop`)으로 보이는 9:16 영역을 원본 화소 그대로 반전(`translate` + `scale(-1, 1)`)해 그린다(OBS 1080×1920 → 1080×1920, 2160×3840 → 그대로, 가로 1920×1080 → 608×1080). 캔버스 생성 뒤 어디서 실패해도 비우고 실패.
2. **사진 효과:** `effect(canvas, { signal })` 경계에 `photo-effect.js`의 `apply`. 셔터 순간 미리보기와 같은 그림을 결과 크기로 새 캔버스에 그린다. `{ canvas, type?, print, dots? }`를 돌려주면 그 형식으로 인코딩하고 사진 `{ url, width, height, print, dots }`에 인쇄 데이터를 붙인다(`dots` = 1비트 점 사진, 결과 출력물 폭을 고른다).
3. **인코딩:** `canvas.toBlob()`, 기본 `config.capture` `image/jpeg` 품질 0.92(가안). 감열지는 `image/png`.
4. **정리:** 성공·실패·취소 모두 캔버스 크기를 0으로. 결과는 `URL.createObjectURL(blob)`로만 들고 `release(photo)`가 `revokeObjectURL`과 인쇄 데이터 해제를 한 번만 한다. `release`는 결과 종료·강제 초기화·늦은 결과 폐기 때 불린다.

- D `capture`(캡처·원본 크기, 잘라낸 위치, 형식·용량, 시간)·`resources`(Object URL·캔버스·인쇄 데이터 수 — 대기 상태에서 0).

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

**매개변수** (`config.effect`, 범위·단계 `config/effect-settings.js`, px는 짧은 변 1080 그림 기준)

| 값 | 기본값 | 범위 (단계) | 뜻 |
|---|---|---|---|
| `strength` 강도 | 0.1 | 0~1.6 (0.05) | 요철·광택·캔버스 결·획 색 흔들림 |
| `size` 붓 크기 | 1.1 (개발 PC 저장값, `oil2f` 1.25) | 0.6~1.8 (0.05) | 모든 층의 굵기·간격·길이에 곱함 |
| `boil` 획 다시 그리기 | 0.05 (개발 PC 저장값, `oil2f` 0.1) | 0~1 (0.05) | 그림마다 새로 놓는 획 비율. 화면을 휘지 않고 획만 다시 놓는다 |
| `fps` 초당 그림 | 12 (개발 PC 저장값, `oil2f` 24) | 2~30 (1) | 사이에는 앞 그림을 그대로(스톱모션 느낌) |
| `grade` 색 보정 | 1 | 0~1 (0.05) | 색 보정 섞는 정도 |
| `layers` 붓 층 | `[36,15,84,3.8,0,1]`, `[18,8,44,2.6,0.02,1]`, `[8,4,20,1.4,0.06,1]` | 모양 검사 | `[굵기px, 간격px, 길이px, 색 밉, 세부 문턱, 불투명도(안 씀)]` |
| `refine` 보완 층 | `[3.5, 3, 10, 0.6, 0.22]` | 문턱 `refineThreshold` 0.01~1 (0.01), `null`이면 없음 | `[굵기px, 칸px, 길이px, 기준 밉, 오차 문턱]`. 문턱 0은 "보완 층 아님"이라 쓰지 않는다 |
| `previewScale` 처리 해상도 | 0.5 (개발 PC 저장값) | 0.25~1 (0.05) | 결과 크기 대비 미리보기 해상도 (원본의 `q`는 `akf` 전용이라 무관, 이 프로젝트에서 둔 값) |
| `enabled` | `true` | | `false`면 원본 미리보기, 결과도 원본 해상도 그대로(출력 단계 없음) |

`createEffectPreview(...).setSettings({ fps: 12 })`처럼 일부만 넘기면 정규화해 다음 갱신 때 반영하고 범위로 맞춘 항목을 돌려준다(`E`가 쓰는 입구).

**해상도 비례** (`resolveOilDrawing`): `s = 짧은 변 / 1080`(결과는 늘 1, 미리보기는 `previewScale`, s = 2는 없음). 획 굵기·간격·길이·보완 층 칸 × s(칸 수와 정규화 획 목록이 해상도와 관계없이 같다), 색 밉 + log2(s)(0 아래는 0), 법선 세기 `relief = 강도 × s`, 캔버스 결 주기 × s, 붓털 주기·흐름장은 그대로.

**시간:** `tick = floor(t초 × fps + 1e-6)`, `seed = tick % 997`, 시계는 `performance.now()`(카메라에는 재생 시각이 없다). `tick`이 바뀔 때(또는 설정·크기 변경) 그 순간의 최신 프레임으로 새로 그리고, 사이 60Hz 갱신은 앞 그림 그대로다. seed는 획 목록에만 쓰인다.

**원본과의 차이:** 기준 해상도(s = 1)에서 같은 입력·매개변수·seed면 **원본과 화소가 완전히 같다**(boil 0~1, 반전 포함). 다른 해상도는 구성(획 위치·색·방향)이 같고 화소는 다르며 더 부드럽게 보인다(흐름장·보완 층 판정이 더 거친 그림에서, 가는 획이 화소보다 작아짐). 수치는 [로그 2026-10-16-02](logs/2026-10-16-02-stage5-oil-effect-port.md).

**실시간 미리보기** (`effect/effect-preview.js`)

- `<video>`는 감지·캡처·카메라 감시가 계속 쓰고, 그 바로 뒤의 `#effect`가 덮는다(결과·카운트다운·D·조절 화면은 그 위). 첫 패스가 보이는 영역(`computeCoverMapping`)을 `config.mirror`로 반전해 읽는다.
- 그리는 해상도 = 결과 크기(`resultSizeFor`, 보이는 영역을 짧은 변 1080으로) × `previewScale`. OBS 1080×1920·4K·가짜 카메라 2160×2160 모두 결과 1080×1920, 기본 540×960. CSS로 늘려 보인다.
- 카메라가 준비되지 않거나 끊기면 그리지 않고 숨긴다(멈춘 그림이 남지 않게). 결과 표시 중에도 그린다.

| 장애 | 처리 |
|---|---|
| WebGL2 없음(`webgl2-unavailable`), `EXT_color_buffer_float` 없음, 셰이더·프레임버퍼 실패 | 캔버스를 숨기고 원본 미리보기(`fallback`), 새로고침 전까지 재시도 없음, 경고 한 번(`effect`) |
| 그리기 예외, 그림 뒤 GL 오류(`getError`)·`isContextLost()` | 렌더러를 버리고 `fallback`(손실이면 `context-lost` 대기). 이 확인이 GPU를 한 번 동기화해 그림당 약 1ms 든다 |
| `webglcontextlost` | `preventDefault()` 후 원본 미리보기(`context-lost`), `webglcontextrestored`면 렌더러를 새로 만든다 |

- 어느 경우든 카메라·감지·촬영은 계속되고 관람객 안내는 바뀌지 않는다(D에만). 렌더러는 만든 GPU 객체를 `owned` 목록에 넣고, 해상도별 대상 묶음(`allocate`)은 최근 2개까지 둔다. 만들다 실패하면 그때까지 만든 것을, `dispose()`는 전부 지운다(`liveResources()`는 테스트용).
- **D `effect`:** 상태, 그리는 해상도(배율, s), `fps` → 실제 초당 그림, `boil`, seed, 손실 횟수, 장애면 `fallback (원인) -> camera preview`. **`time`:** 그리기 CPU(마지막·평균), GPU(`EXT_disjoint_timer_query_webgl2`가 있을 때), 획 수, 렌더러, 결과 사진 준비(`result 1080x1920 ready (ms)`·`preparing`·`same targets as preview`).

**결과 사진** (`photo-effect.js`, `effect-preview.js` `renderStill`)

- **셔터 순간 미리보기와 같은 그림:** 같은 프레임(마지막으로 올린 소스 텍스처를 그대로, `render(null, …)`)·tick·seed·설정으로 결과 크기에 화면 밖으로 다시 그린다. 캡처한 작업의 마이크로태스크에서 동기로 끝까지 그리고, 미리보기는 `requestAnimationFrame`에서만 프레임을 올리므로 끼어들 수 없다. 처리 해상도 1이면 같은 묶음이라 화소까지 같고(JPEG 전), 아니면 같은 구성을 1080으로 다시 그린 것이다. 보이는 그림이 없거나 영상 크기가 바뀌었으면 지금 프레임으로 새로 그린다(D `new drawing`). `out`을 `readPixels`로 읽어 2D 캔버스에 넣고 나머지는 캡처 순서를 따른다.
- **결과 사진 준비:** 처리 해상도가 1이 아니면, 미리보기가 그린 뒤 `requestIdleCallback`(최대 2초, 가안)으로 마지막 그림을 결과 크기로 한 번 그린다(렌더러 `output: 'warm'`: 결과와 같은 대상·패스·획 목록, 감열지면 흑백 스타일 대상·인쇄 대상·문턱 지도, 회색조 유화면 인쇄 경로. 화소를 읽지 않고 화면·D 통계를 건드리지 않음). 안 하면 첫 촬영 때 만들어 셔터 순간 화면이 한 번 멈춘다([로그 07](logs/2026-10-19-07-saved-defaults.md)). 결과·미리보기 크기, 출력 모드·용지 폭·점 방식·흑백 스타일, 붓 크기·boil이 바뀌거나 렌더러를 새로 만들면 다시 준비하고, 손실·실패·`stop` 때 기다리던 준비를 취소한다. 준비 전 셔터는 그 자리에서 만들고(그 뒤 준비는 건너뜀), 준비 실패는 경고(`effect-prepare`)만 하고 되풀이하지 않는다. 처리 해상도 1이면 준비하지 않는다. 준비하면 GPU 메모리가 결과 묶음 하나만큼 는다.
- **효과를 그리지 못하면 원본 사진으로 대신한다**(결과 크기로 줄이고 모드의 출력 단계를 CPU로, 아래 각 모드). 촬영 실패로 처리하지 않는다 — 관람객은 이미 찍혔고 다시 찍을 방법이 없다. 경고(`effect-capture`)와 D `photo-fx` `RAW PHOTO … (원인)`. 원인 예: `not-running`(미리보기 장애·손실 중), 화소 읽기 실패, 읽은 뒤 `render-failed: GL error …`·`context-lost: …`(읽은 화소를 쓰지 않음), 2D 캔버스 실패.
- **D `photo-fx`:** `applied [모드] 크기 [점 방식] seed … tick … (same drawing as preview[, gpu=cpu]), render ms, total ms` 또는 `RAW PHOTO …`, 누적 수. **`print`:** 마지막 인쇄 데이터, 없으면 `none (원인)`.

**운영자 조절 화면 `E`** (`ui/effect-tuning.js`)

- 효과 7개(강도, 붓 크기, 획 다시 그리기, 초당 그림, 색 보정, 세부 보존 문턱, 처리 해상도), 출력 단계(출력 모드·점 방식·용지 폭 선택, 밝기·대비·감마 슬라이더), 흑백 스타일(스타일·질감 세기·선 간격). 범위는 원본 갤러리 슬라이더와 같다.
- 출력 모드 첫 선택지는 회색조 유화. 감열지가 아니면 흑백 스타일을, 회색조·끔이면 점 방식·용지 폭도, 끔이면 레벨도 막는다(회색조 유화에서 점 방식·용지 폭은 인쇄 데이터용으로 열림). 질감 세기는 톤 점에서, 선 간격은 선 스타일이 아니면 막힌다.
- 즉시 반영. 저장·취소·기본값·저장 없이 닫으면 되돌리기·저장 중 닫기는 `R`과 같은 규칙이고, 열려 있는 동안 자동 촬영을 막는다.
- **파일** `config/effect.local.json`: `{ "version": 1, "settings": { strength, size, boil, fps, grade, refineThreshold, previewScale, outputMode, dither, brightness, contrast, gamma, paperDots, bwStyle, bwTexture, lineSpacing } }`(조절하는 16개 값만). 파일 값이 있으면 그 값이다(예: 예전에 `thermal`로 저장한 파일은 감열지로 시작하므로 회색조 유화로 바꾸려면 `E`에서 고르고 저장). 일부 키만 있으면 나머지를 기본값으로 채우고 알린다(`adjusted`).
- **불러오기: 파일 → 기본값**(`localStorage` 없음). 404·읽기 실패·`effectSettingsFile.timeoutMs`(3초, 가안) 초과·형식 오류면 기본값이고 파일은 그대로. 불러오는 동안은 기본값으로 그리고 **자동 촬영을 막지 않는다**(판정과 무관, 그사이 촬영돼도 미리보기와 결과는 같은 값). D `values`에 값과 출처(`file`·`saved`·`defaults (no file)`·`+ unsaved changes`).

### 회색조 유화

**화면 기본값**(`outputMode: 'gray-oil'`). 감열지 인쇄용 1비트는 결과 사진에서 따로 만들어 메모리에만 둔다. 결정과 측정은 [로그 2026-10-19-06](logs/2026-10-19-06-stage8-gray-oil.md).

```text
카메라 프레임 → 크롭·반전 + 입력 회색조(Rec.709, FS_INPUT_GRAY) → 유화 oil2f 패스 그대로(1~9) → 회색조·레벨(Rec.601, FS_OUTPUT) → 화면 / 결과 1080×1920
결과만: 같은 합성 그림 → 회색조·레벨 → 인쇄 해상도 면적 평균 → 점 방식(톤 점 경로) → 인쇄용 1비트 576×1024 (화면에 보이지 않음)
```

- **입력 회색조 Rec.709 luma**(0.2126, 0.7152, 0.0722, `core/thermal.js` `INPUT_LUMA`): 카메라·OBS의 sRGB/BT.709 원색에 맞는 감마 영역 luma다. 색 보정은 이 회색 그림을 크롭·반전 없이 읽는다(원본에 "회색 이미지"를 넣는 것과 같다). 유화 패스·매개변수는 바꾸지 않는다.
- **마지막에 다시 회색조:** `oil2f`는 회색 입력에도 색 보정·획 색 흔들림으로 색을 더하므로(`grade` 0으로도 무채색이 안 되고 톤이 바뀐다) 출력 단계에서 R=G=B로 만든다.
- 결과는 "GPU 입력 회색 그림을 컬러 유화 경로에 넣은 것"의 회색조와 같다(합성 이미지로 최대 차이 1). 원본 페이지 직접 비교는 **미검증**. CPU `inputGrayOf`는 반올림 차이로 획 배치가 바뀔 수 있어 대체 경로에만 쓴다.
- **결과:** 화면용 1080×1920 **JPEG**(`config.capture`). 인쇄용 1비트(`print`, 아래 (a) 형식)는 결과 렌더(`output: 'pixels'`)에서 같은 합성 그림을 톤 점 경로로 만든다(흑백 스타일 선은 안 씀, 레벨은 화면과 같음, `dither`·`paperDots`를 따름). 블루 노이즈·Bayer는 결과마다 CPU로 다시 계산해 비트 단위로 같은지 본다(`gpu=cpu`). 인쇄 데이터 미리보기는 없다(D `print` 숫자만).
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
- 종이색·잉크색 `config.thermalDisplay`(가안: `[246, 242, 233]`, `[26, 26, 30]`)는 화면 전용. 감지는 원본 컬러 `<video>`로 한다.

**결과와 인쇄용 데이터** (`renderStill` → 렌더러 `output: 'print'`)

- **(a) 인쇄용 1비트 (정본)**, 사진의 `print`: `bits` 래스터 비트(줄마다 `ceil(Pw/8)`바이트, 위 줄부터, 왼쪽 점이 최상위 비트, **1 = 검은 점**, ESC/POS `GS v 0`과 같은 뜻, 576×1024면 73,728바이트), `png` 1비트 회색조 PNG Blob(비트 깊이 1, 색 형식 0, 브라우저 `CompressionStream('deflate')`), `width`·`height`·`bytesPerRow`·`blackRatio` 등. 메모리에만 두고 `release` 때 놓는다. 인쇄 연동 때 이것을 넘긴다.
- **(b) 화면용:** (a)를 결과 크기로 확대해 칠한 PNG(미리보기와 화소가 같음). 확대는 240줄씩 나눠 양보한다(촬영 순간 긴 작업 방지). 처리 중 취소되면 만들지 않는다.
- **형식:** 감열지 → PNG + 인쇄 데이터, 회색조 유화 → JPEG + 인쇄 데이터, 회색조·끔 → JPEG만(JPEG는 1비트 점을 뭉갠다).
- **장애:** 효과를 못 그리면 원본 사진에 같은 출력 단계를 CPU로(인쇄 데이터 포함, D `RAW PHOTO thermal 576x1024 (원인)`, 회색조 모드면 원본을 회색조·레벨로). 출력 단계 자체가 실패하면(PNG 압축, 캔버스) 원본 컬러 JPEG, 인쇄 데이터 없음.

**설정** (`config.effect`, `E`에서 조절·저장)

| 값 | 기본값 | 범위 (단계) | 뜻 |
|---|---|---|---|
| `outputMode` | `'gray-oil'` | `gray-oil`·`thermal`·`gray`·`off` | 회색조 유화 / 감열지 / 회색조 / 끔 |
| `dither` | `'blue-noise'` (가안) | `blue-noise`·`bayer`·`atkinson`·`floyd-steinberg` | 감열지 화면과 회색조 유화 인쇄 데이터의 점 방식 |
| `brightness` / `contrast` / `gamma` | 0 / 1 / 1 | −0.5~0.5 (0.01) / 0.5~2 (0.05) / 0.4~2.5 (0.05) | 레벨(끔이 아니면 쓴다). 감마 1 초과는 중간 밝기를 밝게 |
| `paperDots` | 576 (80mm·203dpi) | 128~1024 (8의 배수) | 용지 폭 점 수, 58mm는 384 |
| `bwStyle` | `'stroke'` | `tone`·`texture`·`flow`·`stroke` | 흑백 스타일(감열지에서만) |
| `bwTexture` | 1 | 0~2 (0.05) | 질감 세기(톤 점에서는 안 씀) |
| `lineSpacing` | 4 | 2~8 (0.5) | 흐름 선·붓 결 선의 주기(인쇄 점) |
| `config.thermalDisplay` | 종이 `[246,242,233]`, 잉크 `[26,26,30]` | — | 화면 표시 색(조절 화면 밖) |

### 흑백 스타일: 유화 느낌 1비트

감열지 1비트는 **유화 느낌이 나야 한다.** 576 축소 뒤 균일한 점 잡음이 획 방향을 덮어 질감이 사라지므로 1비트로 바꾸는 방식을 고른다. 분석은 [로그 2026-10-19-04](logs/2026-10-19-04-stage7-painterly-bw.md).

| `bwStyle` | 원리 | 점을 정하는 것 |
|---|---|---|
| `tone` 톤 점 | 위 "출력 단계" 그대로 | `dither` |
| `texture` 질감 강조 점 | 합성 밝기에 획 볼록 조명(`FS_BW_PREP`)을 곱하고 축소 때 국소 대비 | `dither` |
| `flow` 흐름 선 | 회색은 질감 강조와 같고, 문턱을 흐름장을 따라 블루 노이즈를 평균한 값(LIC)으로 → 흐름 방향의 결 | 점별 문턱(GPU) |
| `stroke` 붓 결 선 (기본) | 회색은 질감 강조와 같고, 문턱을 획마다 획 방향 선(삼각파)으로 → 획이 선 묶음으로 보이고 어두울수록 굵다 | 점별 문턱(GPU) |

- 획 패스가 `hgt`의 G에 붓 결 선, B에 획 볼록을 쓴다. 합성은 R만 읽으므로 **컬러 유화는 원본과 같다.** 점별 문턱(`FS_THERMAL_SCREEN`)은 8비트 정수라 CPU `ditherWithThresholds(gray, thr)`와 비트 단위로 같고 톤이 거의 보존된다.
- 식과 내부 상수(조명 배율·국소 대비·노이즈 비율·LIC 길이 등)는 `effect/oil-shaders.js`·`effect/oil-renderer.js`에 있고 합성 시험 이미지로 정한 값(가안)이다. 운영자가 바꾸는 것은 스타일·질감 세기·선 간격뿐이다.
- **일치:** 같은 프레임·seed면 같은 점 그림이고 미리보기와 결과는 같은 패스다. 선 문턱은 획·흐름장이 GPU에만 있어 GPU에서만 만들고, 결과마다 GPU 회색·문턱을 읽어 CPU가 다시 비교한다(`gpu=cpu`). 효과를 못 그리면 획이 없으므로 **톤 점**으로 찍는다(D `(style stroke -> tone)`).
- 선 스타일·질감 강조(블루 노이즈)는 비용이 톤 점과 같다. 붓 결 선은 boil에 비례해 깜빡이고, 흐름 선은 boil 영향이 작다. 선 스타일은 평균이 조금 어두우므로 실제 용지에서는 밝기·감마로 맞춘다.

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
