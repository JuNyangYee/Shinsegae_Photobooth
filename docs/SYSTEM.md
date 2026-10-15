# SYSTEM — 기술 구조와 제약

> 실제로 만든 부분은 "구현됨"으로, 아직 만들지 않은 계획은 "가안"으로 표시한다. 구현 범위는 1단계(정적 서버, 9:16 반전 미리보기, 카메라 상태·자동 회복), 2-1(MediaPipe 로컬 라이브러리 배치), 2-2(얼굴 감지와 인식 상태), 2-3(운영자용 인식 범위 조절), 3-1(촬영 상태 기계와 키보드 수동 시작 한 사이클), 3-2(인식 결과로 자동 시작·이탈 취소), 3-3(3단계 검수 반영)까지다. 사진 효과·인쇄·현장 실행은 아직 없다.

**목차**

1. 전체 구성 — 구성도, 참고 구조, 폴더, 정적 서버, CSP, 스크립트 인코딩
2. 코드 책임 구분
3. 카메라와 영상 — OBS, 화면 배치, 좌우 반전, 권한, 카메라 상태와 자동 회복
4. 촬영 상태 — 촬영 한 사이클, 실패와 취소 경계, 운영자 단축키, 자동 시작과 이탈 취소, 출력 연동 참고
5. 촬영 시작 인식 — 얼굴 감지와 인식 상태, 인식 범위 조절, 다인원, 성능, MediaPipe 로컬 라이브러리
6. 사진 처리 — 캡처와 결과 이미지
7. 참고 자료

## 1. 전체 구성

```text
웹캠 ──▶ OBS (9:16 크롭·회전·보정) ──▶ OBS 가상카메라
                                              │ getUserMedia()
로컬 정적 서버 (localhost) ──▶ 같은 PC 브라우저 (세로 9:16 전체화면)
                                 카메라 → 미리보기(<video>, 반전) → 촬영 진행 → Canvas 캡처(반전) → 결과 화면
                                                 ▲                                 │
                                      감지 결과 또는 개발용 키      사진 효과 연결 지점 (TBD)
                                                                                    │
                                                              (이후 범위) 로컬 인쇄 서비스
```

- 서버는 화면 파일과 라이브러리·모델 파일 제공만 맡는다. 촬영 진행 상태는 브라우저 안에서 관리한다.
- WebSocket, 별도 게임 서버, 원격 제어는 사용하지 않는다.
- `file://`로 직접 열지 않는다. 카메라 권한과 모델·WASM 로딩이 불안정하거나 막힌다.

### 참고 프로젝트에서 가져올 구조 (가안)

이전 프로젝트 PickPod_FaceReading(MediaPipe 관상 + 감열지 출력)의 로컬 실행 구조를 참고한다. 그 프로젝트는 AI·결제·NAS 등으로 복잡해졌으므로 **최소 뼈대만** 가져온다. 참고 저장소는 개인 PC 경로에 있으므로 코드가 그 경로에 의존하지 않게 하고, 필요한 부분은 이 저장소에 새로 작성한다.

| 가져올 것 | 내용 |
|---|---|
| 실행 래퍼 | `Launch.bat`(ASCII 전용) → `powershell -NoProfile -ExecutionPolicy Bypass -File bin\launch.ps1` |
| 설정 | `settings.example.ini` → `settings.ini` (`key=value`). 없는 키만 예시에서 채움. `settings.ini`는 Git에서 제외 |
| 정적 서버 (구현됨) | `bin/server/serve.ps1`. 아래 "정적 서버" 참고 |
| OBS 실행 | OBS가 실행 중이 아니면 `--startvirtualcam --minimize-to-tray` 등으로 실행 |
| 브라우저 실행 | 서버 준비 확인(`GET /` 응답 대기) 후 Chrome `--app=<url>` 전용 `--user-data-dir` 프로필로 실행. 전체화면·키오스크 플래그는 1단계 이후 확정 |
| 프런트엔드 (구현됨) | 빌드 없는 바닐라 ES 모듈. `package.json`은 라이브러리 받기(`vendor:mediapipe`)에만 쓰고 빌드 스크립트·번들러는 없다 |
| MediaPipe (구현됨) | CDN이 아닌 저장소 `lib/mediapipe/`에 `tasks-vision` 번들·WASM·모델을 둠 (5절 "MediaPipe 로컬 라이브러리") |
| 상태 관리 | 고정된 상태 목록 + 상태 변경 알림 정도의 작은 상태 모듈 |
| 자동 시작 | 시작 프로그램 폴더에 `Launch.bat` 바로가기 생성 (4단계) |
| 인쇄 (이후) | 브라우저 → `localhost` HTTP 인쇄 서비스로 요청, 작업 상태를 조회하는 사이드카 패턴 |

**가져오지 않을 것:** Git 자동 업데이트, NAS·AI·결제·Firebase 연동, 워치독·자동 재시작, 야간 스케줄, 지점 인증, 다중 실행 모드 메뉴, 다중 레인 서버, 보정용 패널, 수천 줄 단일 `main.js` 구조.

### 폴더 구성

```text
Launch.bat                  (가안, 4단계)
settings.example.ini        (가안)
bin/
  launch.ps1                (가안, 4단계)
  server/serve.ps1          개발용 정적 서버 (구현됨)
src/web/                    (구현됨)
  index.html
  css/app.css
  js/main.js                화면 조립, 인식 상태 임시 표시, 촬영 사이클 화면·단축키, 개발용 정보·감지 박스 겹쳐 그리기(D 키)
  js/config.js              바꿀 수 있는 값 (반전, 화면 비율, 카메라, 회복 시간, 감지기, 인식 판정, 촬영 시간, 결과 이미지 형식)
  js/camera.js              카메라 장치 선택·스트림 시작·종료
  js/camera-monitor.js      카메라 상태 감시(첫 프레임·끊김)·자동 회복·상태 구독
  js/face-detector.js       MediaPipe Face Detector 생성(GPU→CPU)·감지·종료
  js/presence.js            인식 판정 순수 함수 (좌표 변환, 인정 조건, 시간 안정화)
  js/presence-monitor.js    감지 루프, 인식 상태 구독 (isPresent·subscribe), 판정 설정 교체 (setSettings)
  js/presence-settings.js   판정 설정 검증·정규화·저장 형식, 영역 이동·크기 조절 계산 (순수 함수)
  js/presence-tuning.js     운영자용 인식 범위 조절 화면 (R 키), localStorage 저장
  js/region-drag.js         인식 영역 마우스 끌기 (이동·크기 조절, 끌기 종료 조건)
  js/detector-keeper.js     감지기 생성·재시도·폐기 후 재생성 (한 번에 하나만)
  js/session.js             촬영 한 사이클 상태 기계 (상태 전이·타이머·회차, 시작·취소·초기화 입구)
  js/auto-start.js          인식 상태 → 상태 기계 연결 (자동 시작 레벨 판정 순수 함수, 이탈 취소)
  js/capture.js             9:16 보이는 영역 캡처(원본 해상도, 반전), 사진 효과 자리, 결과 이미지(Object URL) 정리
tests/presence.test.mjs     판정 모듈 Node 테스트 (개발 PC 전용, `npm test`)
tests/session.test.mjs      촬영 상태 기계 Node 테스트 (가짜 시계)
tests/auto-start.test.mjs   자동 시작·이탈 취소 Node 테스트 (실제 상태 기계 + 가짜 시계·인식 상태)
tests/capture.test.mjs      캡처 영역 계산·자원 정리 Node 테스트 (캔버스·Object URL 흉내)
tests/presence-settings.test.mjs  설정 검증·영역 편집 계산 Node 테스트
tests/region-drag.test.mjs  영역 끌기 종료 조건 Node 테스트 (EventTarget으로 흉내)
tests/presence-monitor.test.mjs  감지 루프 Node 테스트 (실제 presence-monitor + 가짜 감지기·document·카메라 프레임)
tests/helpers.mjs           테스트 공용 흉내 (가짜 시계·타이머, 인식 상태, 캔버스·Object URL). npm test가 직접 실행하지 않는다
tests/detector-keeper.test.mjs    감지기 재생성 Node 테스트
lib/mediapipe/              MediaPipe 런타임·모델 (구현됨, 커밋 대상. 직접 고치지 않고 스크립트로 갱신)
  tasks-vision/vision_bundle.mjs
  tasks-vision/wasm/        vision_wasm_internal.{js,wasm}, vision_wasm_nosimd_internal.{js,wasm}
  tasks-vision/LICENSE      Apache-2.0
  models/blaze_face_short_range.tflite
tools/vendor-mediapipe.mjs  node_modules → lib/mediapipe 복사, 모델·LICENSE 다운로드·SHA-256 검증 (개발 PC 전용)
package.json                private, type module, @mediapipe/tasks-vision 정확 버전 고정, test·vendor:mediapipe 스크립트 (개발 PC 전용)
package-lock.json
.npmrc                      save-exact=true
```

- `node_modules/`는 Git에서 제외한다. 현장 PC에는 Node와 `node_modules/`가 필요 없다.
- `lib/mediapipe/**`는 `.gitattributes`에서 `-text`로 지정해 줄바꿈 변환 없이 받은 바이트 그대로 둔다(`core.autocrlf=true` 환경에서 bundle·wasm 로더 JS가 CRLF로 바뀌지 않게).

### 정적 서버 (구현됨)

- 실행: `powershell -NoProfile -ExecutionPolicy Bypass -File bin\server\serve.ps1 [-Port 8765]`. 기본 포트 8765.
- Windows PowerShell 5.1 `Net.HttpListener`에 `http://localhost:<Port>/` 접두사만 등록한다. `+`·`*` 접두사는 쓰지 않는다(관리자 권한 불필요). 이 접두사는 `Host` 헤더 기준 라우팅일 뿐이어서 `127.0.0.1`로 접속하면 http.sys가 400을 돌려주지만, 이 PC의 다른 IP로 `Host: localhost`를 보내는 요청은 받아들인다.
- 그래서 파일을 제공하기 전에 요청한 쪽 주소(`RemoteEndPoint.Address`)가 루프백(IPv4 `127.0.0.0/8`, IPv6 `::1`, IPv4-mapped 포함)인지 확인하고, 아니면 403으로 거절한다. 같은 PC의 브라우저만 쓸 수 있다.
- 경로 매핑: `/` → `src/web/index.html`, `/lib/*` → 저장소 `lib/`(폴더가 없으면 404), 나머지 → `src/web/`.
- 경로 탈출 차단: URL 디코딩 후 역슬래시·`:`·제어 문자·와일드카드 문자, `.`으로 시작하거나 `.`·공백으로 끝나는 경로 조각(`..`, 숨김 파일 포함)을 400으로 거절한다. 마지막으로 실제 경로가 루트 안에 있는지 다시 확인한다(벗어나면 403). 루트를 벗어나는 일부 URL은 http.sys가 스크립트보다 먼저 403으로 막는다.
- MIME: html, js, mjs, css, json, svg, png, jpg/jpeg, webp, woff2, wasm, tflite, task. 그 외는 `application/octet-stream`.
- 모든 응답에 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. GET·HEAD만 허용(그 외 405).
- Ctrl+C로 종료한다. 요청 대기를 짧게 끊어 기다리므로 Ctrl+C가 바로 반영되고 리스너를 닫는다.

### 외부 전송 차단: CSP (구현됨)

`src/web/index.html`의 `<meta http-equiv="Content-Security-Policy">`(다른 스크립트보다 먼저)로 같은 출처만 허용한다. MediaPipe 1.x의 사용 통계 전송(5절)을 막기 위해 넣었고, 오프라인 원칙의 안전장치이기도 하다(사용자 결정, 2026-10-15).

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'
```

- `connect-src 'self'`: `fetch`·XHR·WebSocket은 `localhost`로만 갈 수 있다. 통계 전송은 브라우저가 보내기 전에 막는다.
- `script-src 'self' 'wasm-unsafe-eval'`: MediaPipe WASM 컴파일에 `wasm-unsafe-eval`이 필요하다. `unsafe-eval`·`unsafe-inline`은 넣지 않았다(필요 없음을 확인).
- `img-src 'self' blob:`: 결과 사진은 메모리 안의 Object URL(`blob:http://localhost:.../...`)로 `<img>`에 보인다. CSP의 `'self'`는 `blob:` 주소를 포함하지 않아, 없으면 결과 사진이 막힌다(3-1 검증에서 `img-src blob` 위반과 `naturalWidth 0`을 확인). `blob:`은 같은 페이지가 만든 메모리 자료만 가리키므로 외부 전송이 아니다. `data:`는 넣지 않았다(3-1, 2026-10-15).
- 나머지(`style`·`media`·`worker` 등)는 `default-src 'self'`를 따른다. 카메라 영상(`srcObject`), CSSOM으로 바꾸는 CSS 변수, 캔버스는 영향을 받지 않는다.
- 차단 때문에 콘솔에 `Connecting to 'https://odml.pa.googleapis.com/v1/log' violates the following Content Security Policy directive` 오류가 감지기마다 한 번(생성 후 약 60초) 찍힌다. 무해하다. 한 번 실패하면 그 감지기의 통계 로거가 멈추므로 반복되지 않는다.
- 새 기능이 외부 자원이나 다른 출처를 써야 하면 이 정책을 함께 고친다. 넓히지 않는 것이 원칙이다.

### 스크립트 인코딩 규칙

- `.ps1`, `.bat`, `.cmd` 파일은 **ASCII 문자만** 쓴다. 주석도 영어로 쓴다. Windows PowerShell 5.1은 BOM 없는 UTF-8 파일을 시스템 코드 페이지로 읽어 한글이 깨지고 구문 오류가 날 수 있다.
- 이 파일들은 `.gitattributes`에서 `eol=crlf`로 체크아웃한다.
- 웹 파일(html·js·css)은 UTF-8이며, 서버가 `charset=utf-8`로 제공한다.

## 2. 코드 책임 구분

| 영역 | 책임 |
|---|---|
| 카메라 | OBS 가상카메라 장치 선택, 스트림 시작·종료, 첫 프레임 준비 확인, 단절 감지 |
| 얼굴 감지 (구현됨) | `face-detector.js`: MediaPipe 생성·감지·종료만. 영상 기준 정규화 박스·점수만 돌려주고 MediaPipe 자료형을 내보내지 않음 |
| 인식 판정 (구현됨) | `presence.js`: 좌표 변환·인정 조건·시간 안정화 순수 함수. `presence-monitor.js`: 감지 루프, "인식됨 / 인식 안됨"만 밖에 알림 |
| 촬영 시작 입력 (구현됨) | 키보드(`main.js`)와 인식 상태(`auto-start.js`)가 `session.request('start' \| 'cancel' \| 'reset')` 한 입구로 요청만 보낸다. 시작할 수 있는지는 상태 기계가 정한다. `auto-start.js`는 "인식됨 / 인식 안됨"(`isPresent`·`subscribe`)만 받는다 |
| 촬영 진행 (구현됨) | `session.js`: 상태 전환, 카운트다운·결과·쿨타임 타이머, 회차 식별자, 취소·강제 초기화, 결과 종료 시계 시작 지점. DOM·카메라를 모르고 시계·타이머·사진 함수를 주입받는다 |
| 이미지 (구현됨) | `capture.js`: 보이는 9:16 영역을 원본 해상도로 잘라 반전 캡처, 사진 효과 자리(지금은 그대로 통과), JPEG 인코딩, Object URL 생성·정리, 남은 자원 수 |
| 결과 화면 (구현됨) | `main.js`: 카운트다운 숫자, 플래시, 결과 사진, 쿨타임 문구. 결과가 끝나면 `<img>`의 `src`를 먼저 지운 뒤 상태 기계가 Object URL을 정리한다 |

- 감지 모델의 세부 출력(좌표, 신뢰도 등)이 촬영 진행 코드나 화면 전체로 퍼지지 않게 한다. 좌표·점수는 `presence-monitor.js`의 `getDebugSnapshot()`(D 개발용 화면 전용)으로만 꺼낸다.
- 사진 효과는 "캡처 이미지 → 결과 화면" 사이에 끼울 수 있는 경계만 둔다. 범용 플러그인 구조는 만들지 않는다.

## 3. 카메라와 영상

### OBS 가상카메라

- 9:16 크롭, 카메라 회전, 색·노출 보정은 OBS에서 처리한다. OBS 출력 해상도는 현장 화면 해상도에 맞춘다(FHD 세로 1080×1920 ~ 4K 세로 2160×3840).
- 캡처 해상도의 상한은 OBS 출력 해상도다. 실제 캡처 크기를 확인해 기록한다.
- 브라우저에서는 장치 라벨(`OBS Virtual Camera` 포함 여부, 대소문자 무시)로 장치를 고르고, 없으면 기본 카메라를 쓴다. 장치 라벨은 카메라 권한이 허용된 뒤에만 읽을 수 있으므로, 라벨이 비어 있으면 권한을 한 번 요청한 뒤 다시 장치 목록을 읽는다(참고 프로젝트 방식). 권한 확인용으로 연 스트림이 고른 장치와 같으면 다시 열지 않고 그대로 쓴다. (구현됨: `js/camera.js`)
- 해상도는 **권장값(`ideal`)으로만** 요청한다: `config.idealResolution` = 2160×3840(4K 세로, 현장 최대). `exact`·`min`은 장치가 지원하지 않으면 실패하므로 쓰지 않는다. 권한 확인용으로 처음 여는 스트림에도 같은 권장값을 적용해, 그 스트림을 그대로 쓰는 경우에도 해상도 요청이 빠지지 않게 한다. (구현됨)
  - 이유: 제약이 없으면 Chrome이 장치의 낮은 기본 형식(흔히 640×480)을 고를 수 있다. Chrome은 장치가 지원하는 범위에서 권장값에 가장 가까운 값을 고르고 원본보다 키우지 않으므로, OBS 출력이 1080×1920이면 1080×1920을 받는 것을 기대한다.
  - Chrome은 권장값에 맞추려고 원본을 잘라 줄일 수 있다. 가짜 카메라(원본 가로 영상)는 2160×2160으로 들어왔다. 실제 OBS 9:16 가상카메라에서는 사용자가 장치 선택·해상도·반전·배치가 정상임을 확인했다(2026-10-15).
  - 실제 수신 크기는 개발용 정보(`D` 키)의 `video`·`track`에서 확인한다.
- `camera.js`는 실패를 종류로 구분해 돌려준다: `unsupported`(미지원·비보안 컨텍스트), `permission-denied`(`NotAllowedError`·`SecurityError`), `not-found`(`NotFoundError`·`OverconstrainedError`), `in-use`(`NotReadableError`), `unknown`.
- 부팅할 때 OBS와 가상카메라가 브라우저보다 먼저 준비되는 것이 좋지만, 늦게 준비되어도 아래 자동 회복으로 연결한다.
- OBS 없이 일반 웹캠을 직접 연결해도 동작해야 한다(개발·비상용). 이 경우 9:16이 아니면 웹에서 가운데 기준으로 잘라 채운다.

### 화면 배치 (구현됨)

- 뷰포트 비율과 무관하게 9:16 영역(`#stage`)을 가운데에 최대 크기로 두고 나머지는 검정으로 채운다. 가로 모니터에서는 좌우가, 세로 화면에서 비율이 다르면 위아래가 검정이 된다.
- 영상은 영역을 `object-fit: cover`로 채운다. 9:16이 아닌 영상은 가운데 기준으로 잘린다.
- 비율 값은 `js/config.js`의 `aspectRatio`에서 CSS 변수로 넘긴다.
- 개발용 정보는 `D` 키로 토글하며 기본 숨김이다. 관람객 화면에는 노출하지 않는다.

### 좌우 반전 (확정)

- 미리보기와 캡처 결과 모두 좌우 반전 상태로 만든다.
- 반전은 **웹 한 곳에서만** 처리하고 OBS에서는 반전하지 않는다(가안). 이중 반전을 막고, OBS 설정과 무관하게 같은 결과를 얻기 위해서다.
- 미리보기 반전은 `css/app.css`의 `.preview.is-mirrored { transform: scaleX(-1) }` 한 곳에서 하고, `config.mirror`로 켜고 끈다(구현됨).
- 미리보기에서 보이는 영역과 캡처 영역(9:16, 잘림 위치)이 일치해야 한다. 캡처 반전은 `js/capture.js`에서 `config.mirror`를 따라 한다(구현됨, 6절).

### 권한과 보안 컨텍스트

- `getUserMedia()`는 보안 컨텍스트가 필요하다. 같은 PC의 `http://localhost`는 허용된다.
- 영상만 요청하고 마이크는 요청하지 않는다.
- 현장에서는 전용 Chrome 프로필에 `localhost` 카메라 권한을 한 번 허용해 두고 유지한다(참고 프로젝트 방식).

### 카메라 상태와 자동 회복 (구현됨)

현장은 무인·비접촉 키오스크이므로 화면에 버튼을 두지 않고 스스로 회복한다. `js/camera-monitor.js`가 상태 감시와 재시도를 맡고, `js/camera.js`는 장치 선택과 스트림 열기·닫기만 맡는다.

| 상태 (`CameraStatus`) | 뜻 | 회복 |
|---|---|---|
| `starting` | 준비 중 (권한 대기 포함), 우선 장치로 전환 중 | — |
| `ready` | 실제 프레임이 들어오고 `videoWidth`·`videoHeight`가 0이 아님 | — |
| `permission-denied` | 권한 거절 | 사이트 권한이 `denied`면 재시도하지 않고 권한 `change`를 기다린다. `prompt`이거나 Permissions API가 없으면 간격 재시도 |
| `not-found` | 카메라 없음, 고른 장치가 사라짐 | 간격 재시도, `devicechange` 즉시 재시도 |
| `unavailable` | 사용 중이거나 열 수 없음 (`in-use`, `unknown`) | 간격 재시도, `devicechange` 즉시 재시도 |
| `unsupported` | 미지원 브라우저, 보안 컨텍스트 아님, `requestVideoFrameCallback` 없음 | 재시도 없음 |
| `no-frames` | 스트림은 얻었지만 제한 시간 안에 첫 프레임이 없음 (영상 준비 실패) | 스트림 정리 후 간격 재시도 |
| `disconnected` | 정상 이후 끊김: 트랙 `ended`, 장치 제거(`devicechange`), 프레임 정지 | 스트림 정리 후 즉시 재시도, 실패하면 해당 오류 상태로 간격 재시도 |

- **첫 프레임:** 스트림을 얻은 것만으로 준비 완료로 보지 않는다. `requestVideoFrameCallback`으로 실제 프레임이 화면에 올라오고 영상 크기가 0이 아닐 때 `ready`가 된다.
- **프레임 정지:** `ready` 이후 `requestVideoFrameCallback`으로 마지막 프레임 시각을 기록하고, 일정 시간 새 프레임이 없으면 `disconnected`(`frame-stall`)로 본다. MediaStream 재생에서는 `currentTime`이 프레임과 무관하게 흐르므로 쓰지 않는다. 페이지가 숨겨져 있으면 프레임 콜백이 멈추므로 판정하지 않는다.
- **`devicechange`:** 0.5초 묶은 뒤 처리한다. 정상이 아니면 즉시 재시도한다. 정상이면 현재 장치가 목록에서 사라졌는지(→ `disconnected`), 기본 카메라로 대신 연결된 상태에서 우선 장치(OBS)가 나타났는지(→ OBS로 전환) 확인한다. 현장은 OBS 사용이 확정이므로 대체 카메라보다 OBS를 우선한다.
- **겹침 방지:** 연결 시도는 한 번에 하나만 진행한다. 진행 중에 새 요청이 오면 끝난 뒤 한 번 더 시도하고, 그 사이에 얻은 스트림은 버린다(닫는다). 연결 세대 번호로 늦게 도착한 이벤트·결과를 무시한다.
- **설정값 (확정):** `config.cameraRecovery` — 재시도 간격 3초, 첫 프레임 제한 5초, 프레임 정지 판정 3초, 직원 문의 문구 전환 30초.
- **관람객 문구 (확정):** 정상이 아니면 "준비 중입니다. 잠시만 기다려 주세요." 정상이 아닌 상태가 30초 이상 이어지거나, 스스로 풀리기 어려운 상태(`unsupported`, `permission-denied`)면 "준비 중입니다. 직원에게 문의해 주세요." 기술 용어는 쓰지 않는다. 끊기면 영상을 지워 검은 화면 위에 문구를 띄운다.
- **운영자용 상세:** `D` 개발용 정보에 상태, 원인(오류 종류·끊김 원인)과 원본 오류 이름, 시도 횟수와 정상 이후 연속 실패 횟수, 마지막 시도 시각, 정상이 아닌 시간, 권한 상태를 보인다.
- **이후 단계용 경계:** `createCameraMonitor()`가 돌려주는 `isReady()`, `getState()`, `subscribe(listener)`(해제 함수 반환), `getFrameInfo()`만 쓴다. 촬영 진행 코드는 `ready`가 아니면 촬영을 시작하지 않고, 카운트다운 중 `ready`가 아니게 되면 회차를 취소한다. 결과 표시 중이면 사진이 이미 있으므로 결과를 계속 보인다(구현됨, 4절). 얼굴 감지(`presence-monitor.js`)도 같은 인터페이스로 카메라 준비 여부를 받는다(구현됨).
- **새 프레임 정보 (구현됨, 3-3):** `getFrameInfo()`는 `requestVideoFrameCallback`으로 실제 새 프레임을 받은 마지막 시각(`performance.now()` 기준, 없으면 `null`)과 누적 프레임 수(세대)를 돌려준다. 영상 내용은 내보내지 않는다. 끊김 판정용 `lastFrameAt`은 페이지가 숨겨진 동안 현재 시각으로 밀어 두므로 따로 둔다. 캡처는 촬영 직전 이 시각으로 정지 화면을 거르고(6절), 감지 루프는 누적 수로 같은 프레임을 다시 세지 않는다(5절).
- **시간 기준 (3-3):** 경과 시간 계산(`notReadySince`, 프레임 시각)은 `performance.now()`를 쓴다. 시스템 시계가 바뀌어도 흔들리지 않게 하기 위해서다. 사람이 읽는 시각(D 화면의 `lastAttemptAt`, 자동 시작 기록 시각)만 `Date`를 쓴다.

## 4. 촬영 상태

### 촬영 한 사이클 (구현됨, 3-1)

`js/session.js`가 상태 전이와 타이머를, `js/capture.js`가 캡처와 결과 이미지 자원을, `js/main.js`가 화면 표시와 입력 연결을 맡는다. `session.js`는 DOM·카메라·캔버스를 모르고, 사진 만들기·정리 함수와 시계·타이머를 주입받는다(Node 테스트 `tests/session.test.mjs`).

```text
대기 ─(시작 요청: 대기 상태 + 카메라 준비 + 페이지 보임)─▶ 카운트다운 3·2·1
      시작 요청 = 키보드 S (수동) 또는 인식 레벨 판정 (자동, 아래 "자동 시작과 이탈 취소")
카운트다운 ─(3초)─▶ 촬영·결과 준비 (프레임을 잡고 효과·인코딩) ─▶ 결과 표시 ─(10초)─▶ 쿨타임 ─(5초)─▶ 대기
카운트다운 ─(취소 요청 / 카메라 준비 해제 / 페이지 숨김)─▶ 대기 (쿨타임 없음)
촬영·결과 준비 ─(실패·5초 초과·정지 화면)─▶ 대기 (쿨타임 없음, 자동 시작은 실패 대기 시간 동안 쉼)
어느 상태든 ─(운영자 강제 초기화)─▶ 대기 (쿨타임 없음)

(인쇄 연동 후) 결과 표시 = 출력 중(종료 시계 정지) ─(출력 완료 확인)─▶ 10초 ─▶ 쿨타임
```

| 상태 (`SessionState`) | 화면 |
|---|---|
| `idle` 대기 | 미리보기, 인식 표시 |
| `countdown` 카운트다운 | 미리보기 위 큰 숫자 3·2·1 |
| `capturing` 촬영·결과 준비 | 흰 화면 플래시(0.4초에 걸쳐 사라짐). 실측 약 30~50ms 뒤 결과로 넘어간다 |
| `result` 결과 표시 | 9:16 영역 전체에 결과 사진. 인식 표시와 카메라 상태 문구는 사진 위에 띄우지 않는다 |
| `cooldown` 쿨타임 | 미리보기로 돌아오고 위쪽에 "다음 촬영을 준비 중입니다." (가안). 카메라가 준비되지 않았으면 이 문구 대신 카메라 상태 문구 |

| 상황 | 처리 |
|---|---|
| 카메라 미준비·페이지 숨김 상태의 시작 요청 | 무시 (`camera-not-ready`, `page-hidden`) |
| 카운트다운·촬영·결과·쿨타임 중 시작 요청 | 무시. 한 회차에 한 장만 만든다 |
| 카운트다운 중 취소 요청·카메라 준비 해제·페이지 숨김 | 타이머 정리 후 바로 대기 |
| 촬영·결과 준비 중 카메라 준비 해제·취소 요청 | 계속한다. 프레임은 이 상태에 들어가는 순간 이미 잡았다 |
| 결과 표시 중 카메라 준비 해제 | 결과를 계속 보인다(사진이 이미 있음). 쿨타임 뒤 대기로 가고, 카메라가 준비될 때까지 시작 요청은 무시된다 |
| 결과·쿨타임 중 취소 요청 | 무시 |
| 결과 표시 시간 종료 | 사진을 화면에서 내리고 정리(Object URL `revoke`)한 뒤 쿨타임 |
| 쿨타임 중 시작 요청 | 무시. 5초가 지나면 스윗스팟 상태와 관계없이 대기 |
| 사진 만들기 실패·제한 시간(5초) 초과 | 보여 줄 사진이 없으므로 쿨타임 없이 대기. 진행 중인 작업에 취소 신호(abort)를 보내고, 실패 수에 따라 자동 시작을 쉰다(아래 "실패와 취소 경계") |
| 촬영 순간 새 카메라 프레임이 없음 (정지 화면) | 촬영 실패로 처리한다. 카메라 끊김 판정(3초) 전이라도 `maxFrameAgeMs`(0.5초) 안에 새 프레임이 없으면 찍지 않는다 |
| 취소·초기화 뒤 늦게 끝난 사진 만들기 | 회차 식별자로 걸러 화면에 보이지 않고 바로 정리 |
| 운영자 강제 초기화 | 어느 상태든 사진·타이머를 정리하고 바로 대기. 회차를 올려 진행 중이던 결과도 버린다 |

- **입구 하나:** 시작·취소·강제 초기화는 `session.request(type, source)`(`'start' | 'cancel' | 'reset'`) 한 곳으로 들어간다. 결과 `{ accepted, reason }`을 돌려주고, 무시한 요청은 D 화면 `ignored`에 남는다. 키보드(`'key'`)와 인식 결과(`'presence'`)가 같은 입구를 쓴다. 시작이 받아들여지면 출처가 회차의 `source`(`getState().source`)로 남는다. 카메라 준비 여부와 페이지 보임은 `setCameraReady()`·`setPageVisible()`로 따로 받는다(`main.js`가 `camera.subscribe`·`visibilitychange`로 연결).
- **회차 식별자:** 시작과 강제 초기화마다 `round`를 올린다. 사진 만들기 결과가 도착했을 때 회차가 같고 아직 `capturing`일 때만 결과로 보이고, 아니면 바로 `releasePhoto()`로 정리한다.
- **카운트다운 시각:** 숫자는 시작 시각 기준 1초마다 바꾼다. 타이머가 늦게 불려도 늦음이 쌓이지 않는다.
- **결과 종료 시계:** `startResultClock()` 한 곳에서만 시작한다. 지금은 결과 표시에 들어갈 때 부른다. 인쇄를 연동하면 이 호출을 "출력 완료 확인" 시점으로 옮긴다(아래 "출력 연동 시 참고 흐름").
- **강제 초기화에 쿨타임을 두지 않는 이유:** 쿨타임은 방금 결과를 본 사람이 같은 자리에서 바로 다시 찍히는 것을 막는 장치다. 강제 초기화는 운영자가 꼬인 진행을 풀거나 시험할 때 쓰므로, 누른 즉시 다시 시작할 수 있는 편이 낫다고 봤다. 쿨타임 중에 누르면 남은 쿨타임도 없앤다. 단, 자동 시작은 레벨 판정이라 `X` 직후에도 인식된 사람이 있으면 곧바로 새 회차가 시작된다. **`X`는 촬영을 멈추는 수단이 아니다.** 자동 촬영을 막으려면 `R` 조절 화면을 연다(운영자용 일시정지 키는 4단계에서 정한다).
- **카운트다운 취소에 쿨타임을 두지 않는 이유:** 사진을 찍지 않았으므로 다시 찍히는 것을 막을 대상이 없다.
- **설정값 (`config.session`):** `countdownSeconds` 3, `resultMs` 10000, `cooldownMs` 5000 (확정). `captureTimeoutMs` 5000 (가안: 효과·인코딩이 끝나지 않을 때 화면이 멈추지 않게 하는 안전값. 효과가 정해지면 처리 시간 목표에 맞춰 다시 정한다). `failureRetryMs` 5000, `failureRetryMaxMs` 60000 (가안: 촬영 실패 뒤 자동 시작을 쉬는 시간, 아래).
- 결과 표시 시간(확정): 출력 완료 확인 후 10초. 인쇄 연동 전에는 결과 표시 시작 시점부터 10초로 대체한다.
- 쿨타임(확정): 대기 복귀 전 5초 동안 시작 요청을 무시하는 단순 시간 대기다. 스윗스팟이 비었는지는 확인하지 않는다. 자동 시작은 레벨 판정이므로, 같은 사람이 계속 인식된 채 서 있으면 쿨타임이 끝나는 즉시 다음 회차가 시작된다(사용자 확정 2026-10-15). 이때 인식 상태는 이미 안정돼 있어 `presentHoldMs`가 추가 완충이 되지 않는다.
- 미리보기와 감지는 사이클 내내 멈추지 않는다. 결과 표시 중에도 감지 루프는 돈다(쿨타임이 끝나는 순간의 인식 상태로 바로 판정하기 위해).

### 실패와 취소 경계 (구현됨, 3-3 검수 반영)

- **회차별 취소 신호:** 상태 기계는 촬영마다 `AbortController`를 새로 만들어 `takePhoto({ signal })`로 넘긴다. 제한 시간 초과·강제 초기화로 대기로 갈 때 abort한다. 정상으로 끝난 회차의 신호는 abort하지 않는다.
- **받는 쪽(`capture.js`):** abort되면 효과·인코딩이 끝나기를 기다리지 않고 바로 실패하며, 캔버스를 그 자리에서 비운다. 효과 단계(`applyPhotoEffect(canvas, { signal })`)도 같은 신호를 받는다. 효과가 신호를 무시하고 나중에 새 캔버스를 돌려줘도 그 캔버스를 비운다. 늦게 도착한 인코딩 결과로는 Object URL을 만들지 않는다.
- **작업이 쌓이지 않게:** 취소된 회차의 효과·인코딩이 아직 끝나지 않았으면(브라우저가 `toBlob` 콜백을 주지 않는 경우 등) 다음 `take()`는 캔버스를 만들지 않고 `capture busy`로 바로 실패한다. 이 실패에도 아래 대기 시간이 붙는다.
- **실패 뒤 자동 시작 대기 (오류 복구 정책):** 촬영이 실패하면(예외, 제한 시간 초과, 정지 화면, `capture busy`) 상태 기계가 연속 실패 수를 세고 자동 시작을 쉬는 시각(`retryAt`)을 정한다. 쉬는 시간은 `failureRetryMs`부터 실패마다 두 배, 최대 `failureRetryMaxMs`(5→10→20→40→60→60초, 가안)다. 끝나면 상태 기계가 알려 자동 시작이 다시 평가한다. 성공하면 기록을 지운다.
  - 정상 회차의 연속 촬영(쿨타임 뒤 바로 시작)과는 따로 둔다. 실패 없이 서 있는 사람은 지금처럼 쿨타임 뒤 바로 다음 회차다.
  - `S` 수동 시작은 쉬는 중에도 된다. 운영자가 원인을 고친 뒤 바로 시험할 수 있게 하기 위해서다. `X`는 실패 기록을 지우지 않는다.
  - 이 정책이 없으면 사람이 계속 인식된 상태에서 "실패 → 대기 → 자동 시작"이 약 3초마다 반복된다(전체 검수 재현: 60초에 캔버스 20개 누적).
- **D 화면:** `failures` 줄에 연속 실패 수와 자동 시작까지 남은 시간, `last end` 줄에 실패 이유, `resources` 줄에 남은 Object URL·캔버스·끝나지 않은 작업 수(`pending jobs`).

### 운영자 단축키

수정 키(`Ctrl`·`Alt`·`Meta`) 없이 누른 한 키만 받고, 누르고 있을 때의 반복 입력은 무시한다. 관람객 화면에는 노출하지 않는다.

| 키 | 동작 |
|---|---|
| `D` | 개발용 정보·감지 박스 겹쳐 그리기 |
| `R` | 인식 범위 조절 화면 (`Esc`로도 닫음) |
| `S` | 수동 촬영 시작 (`session.request('start', 'key')`). Start/Shoot |
| `X` | 강제 초기화 (`session.request('reset', 'key')`) |

- `Space`·`Enter`는 쓰지 않는다. `R` 조절 화면의 버튼에 포커스가 있으면 그 버튼을 누르게 되기 때문이다.
- `R` 조절 화면이 열려 있어도 `S` 수동 시작은 된다. 인식에 의한 자동 시작만 막는다(아래).

### 자동 시작과 이탈 취소 (구현됨, 3-2)

`js/auto-start.js`가 인식 상태와 상태 기계를 잇는다. 판정은 순수 함수 `decideAutoRequest()`이고, 연결부 `createAutoStart()`는 계기마다 이 함수를 불러 `session.request(..., 'presence')`를 보낸다(Node 테스트 `tests/auto-start.test.mjs`). 인식 상태는 "인식됨 / 인식 안됨"만 받고, 좌표·점수는 들어오지 않는다.

**레벨 판정 (사용자 확정 2026-10-15):** 인식 상태가 바뀌는 순간(엣지)이 아니라, 평가할 때의 상태를 보고 정한다. 쿨타임이 끝났을 때 스윗스팟이 비어 있지 않아도 그대로 진행하기로 했으므로, 사람이 계속 서 있으면 쿨타임이 끝나는 즉시 다음 회차가 시작된다.

| 상태 기계 | 조건 | 요청 |
|---|---|---|
| `idle` | 인식됨 + 카메라 준비 + 페이지 보임 + 조절 화면 닫힘 + 촬영 실패 대기 아님 | `start` |
| `idle` | 하나라도 아님 | 없음. D `auto` 줄에 이유(`idle, not present`, `blocked: camera-not-ready`·`page-hidden`·`tuning-open`·`capture-failed (retry wait)`) |
| `countdown` (출처 `presence`) | 인식 안됨 | `cancel` → 쿨타임 없이 대기 |
| `countdown` (출처 `key`) | 무엇이든 | 없음. 수동 회차는 인식 상태로 취소하지 않는다(사람 없이 시험 촬영) |
| `capturing`·`result`·`cooldown` | 무엇이든 | 없음. 감지는 돌지만 결과를 보지 않는다. 촬영 순간에는 인식과 관계없이 찍는다 |

- **평가 계기:**
  - 인식 상태가 바뀔 때(`presence.subscribe`)
  - 상태 기계가 알릴 때(`session.subscribe`): 대기 진입(쿨타임 종료·취소·초기화), 카메라 준비 변화, 페이지 보임 변화
  - 조절 화면을 닫을 때(`main.js`가 `evaluate('tuning-closed')`)
- **카메라 준비·페이지 보임은 상태 기계 스냅숏 값을 쓴다.** 카메라 모듈을 따로 구독하면, 상태 기계가 카메라 준비를 받기 전에 평가해 시작 요청이 무시되고 다시 평가되지 않을 수 있다. 그래서 상태 기계가 먼저 받아 알린 값으로 판정한다.
- **시작은 한 번만:** 시작이 받아들여지면 상태가 `countdown`이 되어 같은 순간의 다른 계기는 요청을 보내지 않는다. 판정과 상태 기계가 같은 값을 보므로 무시되는 시작 요청도 보내지 않는다(테스트로 확인). 요청이 상태 기계 알림을 일으켜 다시 불리면(재진입) 지금 평가를 끝낸 뒤 한 번 더 평가한다.
- **이탈 유예를 따로 두지 않는다.** "인식 안됨"이 되는 데 이미 `absentGraceMs`(기본 1초)가 걸린다. 짧은 누락은 여기서 흡수하고, 설정값을 늘리지 않는다.
- **취소 뒤 반복 없음:** 취소는 "인식 안됨"이 된 순간에 일어나므로, 대기에서 다시 평가해도 인식 안됨이라 시작하지 않는다. 다시 "인식됨"(`presentHoldMs`, 기본 0.5초)이 되어야 새 회차가 시작된다.
- **조절 화면:** 열려 있는 동안 자동 시작을 막는다. 운영자가 범위를 맞추는 중에 촬영이 시작되지 않게 하기 위해서다. 열기만으로 진행 중인 회차를 취소하지는 않는다(자동 회차는 이탈하면 그대로 취소된다). 닫을 때 사람이 서 있으면 바로 시작될 수 있다.
- **강제 초기화(`X`) 뒤:** 대기로 들어오며 평가하므로, 사람이 서 있으면 바로 자동으로 다시 시작한다. `X`는 촬영 중지 수단이 아니다. 자동 촬영을 멈추려면 `R` 조절 화면을 연다.
- **D 화면:** `session` 줄에 회차 출처(`by presence`·`by key`), `auto` 줄에 마지막 판정 이유, 마지막 자동 시작·취소 시각과 계기(예: `entered idle (completed)`, `presence: absent`, `tuning-closed`)를 보인다. 계기 기록은 시작이 받아들여진 뒤 남으므로, 시작 직후 한 번은 이전 값이 보이고 다음 갱신(0.5초)에 바뀐다.
- 관람객 화면은 바꾸지 않았다. 대기 중 안내 문구는 넣지 않았다.

### 출력 연동 시 참고 흐름 (이후 범위)

참고 프로젝트(PickPod_FaceReading)의 결과·출력 흐름을 따른다.

1. 결과 화면에 들어가면 브라우저가 로컬 인쇄 서비스에 출력 작업을 요청한다(요청 ID 포함).
2. 출력 확인 전까지 "출력 중"을 표시하고 결과 종료 시계를 멈춘다.
3. 브라우저가 인쇄 서비스의 작업 상태를 짧은 간격으로 조회한다(`queued` / `processing` / `succeeded` / `failed`).
4. `succeeded`이고 프린터 드라이버로 전송된 것이 확인되면 "출력 인식"으로 보고 10초 종료 시계를 재개한다.
5. 실패하거나 제한 시간 안에 확인되지 않으면 직원 문의 안내를 띄우고 **자동 재출력은 하지 않는다.** 화면이 멈추지 않도록 종료 시계는 재개한다.
6. 응답이 늦게 도착해도 이미 끝난 회차라면 무시한다.

참고 프로젝트에서 "출력 인식"은 실제 용지 배출이 아니라 인쇄 서비스가 드라이버 전송 완료를 확인한 시점이다. 이 프로젝트의 프린터 종류에 따라 기준을 다시 확인한다.
- 카운트다운 시간, 결과 표시 시간, 쿨타임, 감지 관련 시간·임계값은 설정값으로 분리한다.
- 현장 운영자용 키보드 단축키(강제 초기화 등)는 관람객 화면에 노출하지 않는다.

## 5. 촬영 시작 인식

목적은 신원 식별이 아니라 **스윗스팟에 촬영 대상이 있는지** 판단하는 것이다. 발자국 매트로 위치와 거리(약 2m 이내)가 고정되므로 감지 조건을 단순하게 둔다.

| 후보 | 역할 | 메모 |
|---|---|---|
| 개발용 키 입력 | 감지 구현 전 촬영 흐름 검증, 현장 운영자 수동 조작 | 관람객용 입력이 아님 |
| MediaPipe Face Detector | **2단계 감지기(사용자 결정).** 화면 내 지정 영역에 최소 크기 이상의 얼굴이 있는지 판정 | 정면 여부·랜드마크 불필요. 웹 모델은 short-range(공식 문서 기준 약 2m 이내 얼굴)로 요구 거리와 맞음. 아이 키·고개 돌림은 실측 필요 |
| MediaPipe Object Detector (`person`) | 대안 | 얼굴이 작거나 돌아선 경우에도 사람 단위로 감지. 얼굴 누락이 잦을 때 비교 |
| MediaPipe Pose Landmarker | 대안 | 신체 위치 조건이 필요할 때만 비교 |
| 프레임 변화량 | 보조 시험 | 변화량만으로 사람 여부를 구분한다고 가정하지 않음 |

### 얼굴 감지와 인식 상태 (구현됨, 2-2)

```text
camera-monitor (ready·페이지 표시) ──▶ presence-monitor 감지 루프 (최대 15fps)
  <video> ─drawImage─▶ 축소 캔버스(긴 변 ≤ 640px) ─▶ face-detector.detect()  영상 좌표 박스·점수
                                                     ─▶ presence.classifyFaces()  화면 좌표 변환, 얼굴별 인정 여부
                                                     ─▶ presence.stepPresence()  시간 안정화
                                                     ─▶ isPresent() / subscribe({ present })
```

**감지기 (`face-detector.js`)**

- bundle을 동적 `import`로 불러온다. 불러오기나 생성에 실패해도 카메라 미리보기는 계속 동작하고, 실패 사실은 `D` 화면 `detector : error / ...`에 보인다. 실패하면 아래 "감지기 재생성" 규칙으로 다시 만든다.
- Chrome은 실패한 동적 `import()` 결과를 기억해, 원인이 없어져도 같은 URL로는 다시 받지 않는다(2단계 검수 수정 중 확인). 그래서 불러오기에 실패한 적이 있으면 다음 시도에 `?retry=N`을 붙여 새로 받는다. 한 번 성공한 bundle 모듈은 감지기를 다시 만들 때도 그대로 쓴다.
- `config.faceDetection.delegates` 순서(`GPU` → `CPU`)로 생성을 시도한다. 앞선 delegate가 실패한 이유는 `D` 화면 `delegate` 줄에 보인다.
- 감지기 자체의 `minDetectionConfidence`(`detectorMinConfidence` 0.3)는 낮게 둔다. 신뢰도는 판정 쪽 `presence.minScore`로 거른다. 2-3에서 감지기를 다시 만들지 않고 실시간으로 조절하기 위해서다.
- 결과: `{ x, y, width, height, score }[]`. 감지 입력(영상 프레임 전체를 축소한 캔버스) 기준 0~1 정규화, 왼쪽 위 원점, 반전 전.
- WebGL을 전혀 쓸 수 없으면 CPU delegate도 생성은 되지만 매 프레임 감지에 실패한다(MediaPipe가 입력을 WebGL 텍스처로 올리기 때문, `ImageData` 입력도 같음). 이때 감지 루프가 감지기를 버리고 다시 만든다(아래). WebGL이 끝내 없으면 이를 되풀이하므로, 현장 Chrome의 하드웨어 가속 점검은 4단계에서 다룬다.

**좌표 기준 (`presence.js`)**

- 판정·영역·최소 크기·겹쳐 그리기는 모두 **화면 좌표**를 쓴다. 9:16 영역(`#stage`) 기준 0~1, 관람객이 보는 그대로(cover 크롭·좌우 반전 후)다.
- 변환: 영상 비율이 9:16보다 넓으면 가운데 세로 띠(폭 = `(9/16) / 영상 비율`)만 보이고, 좁으면 가운데 가로 띠만 보인다(미리보기 `object-fit: cover`, `object-position` 기본값 가운데). 보이는 띠 기준으로 늘린 뒤 `config.mirror`면 `x' = 1 - x - width`로 뒤집는다.
- 잘려서 화면에 보이지 않는 얼굴은 중심이 영역 밖이 되어 제외된다.

**인정 조건과 안정화**

- 얼굴 하나가 인정되려면 네 조건을 모두 만족해야 한다. 경계값은 포함한다.
  - 박스 중심이 `presence.region` 안
  - 박스 높이(9:16 영역 높이 대비)가 `presence.minFaceHeight` 이상
  - 박스 높이가 `presence.maxFaceHeight` 이하 (2-3 추가. 가짜 카메라에서 화면 높이의 0.38~1.0인 큰 오검출 박스가 관찰됐다. 실제 얼굴은 약 0.18~0.24)
  - 점수가 `presence.minScore` 이상
- 인정된 얼굴이 1명 이상이면 그 프레임은 "있음"이다.
- 처음은 **인식 안됨**이다. "있음"이 `presentHoldMs` 동안 끊기지 않고 이어지면 **인식됨**, "없음"이 `absentGraceMs` 동안 이어지면 **인식 안됨**이 된다. 도중에 한 프레임이라도 반대가 나오면 그 시간을 처음부터 다시 잰다.
- 시간은 감지 프레임이 들어올 때만 판정한다(별도 타이머 없음). 따라서 전환은 기준 시간을 넘긴 뒤 다음 감지 프레임(15fps면 최대 약 67ms 늦게)에 일어난다.

**감지 루프 (`presence-monitor.js`)**

- 카메라가 `ready`이고 페이지가 보이며 영상 크기가 0이 아닐 때만 돈다. 아니면 즉시 멈추고(`paused`) 인식 상태를 **인식 안됨**으로 되돌린다. 카메라 감시 모듈의 `subscribe()`와 `visibilitychange`로 시작·중지한다.
- **새 프레임만 관측으로 센다 (3-3):** 감지할 때마다 카메라의 누적 프레임 수(`getFrameInfo().count`)를 보고, 직전 감지 이후 새 프레임이 없으면 감지를 건너뛴다. 카메라 프레임이 멈춘 뒤 끊김으로 판정되기까지(약 3초) 같은 프레임이 "있음"으로 쌓여 인식됨이 되는 일을 막는다. 건너뛰는 동안 인식 상태는 그대로 두고, 끊김 판정은 카메라 감시가 맡는다. D `faces` 줄에 `same-frame skips` 수.
- **판정 기준이 바뀌면 다시 잰다 (3-3):** `setSettings()`로 영역·얼굴 크기·신뢰도·시간 중 하나라도 바뀌면(조절 중 변경, 취소·닫기 복원, 기본값으로) 인식 상태를 처음 상태로 돌리고 바로 "인식 안됨"을 알린다. 새 기준으로 `presentHoldMs` 동안 다시 확인돼야 인식됨이 된다. 조절 화면을 저장 없이 닫았을 때 임시 기준으로 안정된 인식됨이 남아 바로 자동 시작되던 문제를 막는다(단위 검수). 값이 같으면 다시 재지 않는다. D `faces` 줄에 `criteria resets` 수.
- 시계·타이머·document를 주입할 수 있다(`timers`, `now`, `doc`). 기본은 전역 타이머, `performance.now()`, `document`이고, Node 테스트(`tests/presence-monitor.test.mjs`)에서 실제 감지 루프를 돌리는 데 쓴다.
- 4K 영상을 그대로 넣지 않는다. 긴 변을 `inputMaxSize`(640px) 이하로 줄인 캔버스에 그려 감지한다(OBS 1080×1920 → 360×640).
- 호출 간격은 `1000 / maxFps`에서 처리 시간을 뺀 값이다. `detectForVideo` 타임스탬프는 `max(performance.now(), 직전 + 1)`로 항상 증가시킨다.
- 감지가 실패한 프레임은 "없음"으로 판정한다. 15번 연속 실패하면(약 1초) 감지기를 버리고 다시 만든다(아래). 콘솔 경고는 연속 실패의 첫 번째와 15번째에만 남긴다.
- 상태(`DetectorStatus`): `loading`(생성 중), `running`, `paused`(카메라 미준비·페이지 숨김), `error`(감지기 없음: 생성 실패 또는 계속 실패해 버림, 재생성을 기다리는 중). 인식 알림은 감지 한 번(`tick`) 안에서 나가므로, 알림을 받은 쪽이 그 안에서 상태를 읽어도 `running`으로 보이게 한다(3-2에서 발견: 이탈 취소가 D 화면을 다시 그릴 때 `paused`·0fps로 잘못 보였다).

**감지기 재생성 (`detector-keeper.js`, 2단계 검수 반영)**

- 생성에 실패하면 `faceDetection.detectorRetryMs`(15초, 가안) 뒤 다시 만든다. 생성은 메인 스레드를 약 1초 막으므로 간격을 너무 짧게 두지 않는다.
- 감지가 15번 연속 실패하면(예: 실행 중 WebGL 컨텍스트 손실) 감지기를 `close()`로 닫고 버린 뒤, 같은 간격 뒤 새로 만든다. `close()`가 실패해도 버린다.
- **바로 다시 만드는 계기:** 감지기가 없을 때 카메라가 다시 준비되거나(한 번 준비된 적이 있는 카메라의 재연결. 처음 준비되는 것은 계기가 아니다) 페이지가 다시 보이면, 간격을 기다리지 않고 바로 만든다. 예약된 재시도는 지운다.
- 생성은 한 번에 하나만 진행한다. 생성 중에 다시 요청하면 진행 중인 생성을 기다린다.
- 재생성과 관계없이 감지기가 없는 동안 인식 상태는 **인식 안됨**이고, 카메라 미리보기는 그대로 동작한다.
- `D` 화면: `detector : loading`(생성 중) / `error / <이유>`(재시도 대기) / `running`·`paused`.
- 검증: 번들 차단 → 해제 후 재시도 간격 뒤 회복, 번들 차단 → 해제 + 카메라 트랙 종료 후 즉시 회복, WebGL 없음 흉내 → 감지기 폐기 → WebGL 복구 흉내 후 재생성으로 회복(로그 06 "2단계 단위 검수").

**이후 단계용 경계**

- `createPresenceMonitor()`가 돌려주는 `isPresent()`와 `subscribe(listener)`만 쓴다. `listener`는 등록 즉시 한 번, 그 뒤로는 인식 상태가 바뀔 때만 `{ present }`로 호출된다. 해제 함수를 돌려준다.
- 좌표·점수·감지 시간은 `getDebugSnapshot()`으로만 꺼내며 `D` 개발용 화면에서만 쓴다. 촬영 진행 코드는 쓰지 않는다.
- 촬영 진행과의 연결(구현됨, 3-2): `auto-start.js`가 `isPresent()`·`subscribe()`만으로 자동 시작·이탈 취소를 정한다. 시작은 인식 상태가 바뀌는 순간이 아니라 그때의 상태를 보는 레벨 판정이다(4절 "자동 시작과 이탈 취소").

**화면**

- 인식 상태 임시 표시: 9:16 영역 아래쪽 가운데에 "인식됨"(초록 배경)·"인식 안됨". 카메라가 준비되지 않았으면 숨긴다(이때는 "준비 중" 문구). `config.showPresenceIndicator`로 끈다. 최종 디자인 전 기본 UI다(가안).
- `D` 화면에 추가된 정보: 감지기 상태와 오류, delegate(실패한 delegate 이유), 감지 시간(마지막·평균)과 그리기 시간, 실제 감지 빈도, 감지 입력 크기, 감지된 얼굴 수와 인정된 얼굴 수, 판정과 안정화 진행(`-> present 343/500ms`), 현재 기준값(조절 화면에서 바꾼 값 포함), 기준값 출처(`settings : stored`(시작할 때 읽음)·`saved`(이번 실행 중 저장)·`defaults`, 저장하지 않은 변경이 있으면 `+ unsaved changes`)와 저장 전까지는 불러올 때 고친 내용, 얼굴별 점수·높이·중심과 제외 이유(`region`·`small`·`large`·`score`), 감지 오류 횟수.
- `D` 화면을 켜면 9:16 영역 위에 인식 영역(노란 점선)과 감지 박스를 겹쳐 그린다. 인정된 얼굴은 초록, 제외된 얼굴은 빨강이며, 박스 위에 점수, 중심에 점을 찍는다.

**설정값 (`config.js`, 가안)**

| 값 | 기본값 | 뜻 |
|---|---|---|
| `faceDetection.delegates` | `['GPU', 'CPU']` | 시도 순서 |
| `faceDetection.detectorMinConfidence` | 0.3 | 감지기 자체 기준 (낮게) |
| `faceDetection.maxFps` | 15 | 감지 최대 빈도 |
| `faceDetection.inputMaxSize` | 640 | 감지 입력 캔버스 긴 변 최대 px |
| `faceDetection.detectorRetryMs` | 15000 | 감지기 생성 실패·폐기 후 다시 만들기까지의 간격 |
| `presence.region` | `{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }` | 인식 영역 (화면 좌표, 가운데 넓은 사각형) |
| `presence.minFaceHeight` | 0.05 | 최소 얼굴 높이 / 9:16 영역 높이 |
| `presence.maxFaceHeight` | 0.6 | 최대 얼굴 높이 / 9:16 영역 높이 (2-3 추가) |
| `presence.minScore` | 0.7 | 최소 신뢰도 (2-3에서 0.6 → 0.7. 실제 얼굴 0.85~0.95, 가짜 카메라 오검출 최고 0.663) |
| `presence.presentHoldMs` | 500 | 인식됨까지 "있음" 유지 시간 |
| `presence.absentGraceMs` | 1000 | 인식 안됨까지 "없음" 유지 시간 |
| `showPresenceIndicator` | `true` | 인식 상태 임시 표시 |

위 `presence.*` 값은 **기본값**이다. 운영자가 조절 화면(아래)에서 저장한 값이 있으면 그 값을 쓴다. 판정은 매 프레임 현재 설정 객체를 읽으므로, 감지기를 다시 만들지 않고 다음 감지부터 반영된다.

**테스트:** `npm test`(`node --test "tests/**/*.test.mjs"`, glob 인자 때문에 Node 22 이상, 의존성 없음).

- `tests/presence.test.mjs`: 좌표 변환(반전, 가로 영상·9:16·세로로 긴 영상의 cover 크롭), 영역 경계·최소/최대 크기·신뢰도, 안정화(유지 시간 경계, 깜빡임, 짧은 끊김, 시간값 0)
- `tests/presence-settings.test.mjs`: 설정 검증(아래)과 영역 이동·크기 조절 계산
- `tests/region-drag.test.mjs`: 끌기 종료 조건(놓기, `blur`, `lostpointercapture`, 버튼 떼어짐)과 리스너 해제
- `tests/detector-keeper.test.mjs`: 생성 실패 → 원인 제거 → 재생성, 생성 중 중복 시작 1회, 폐기 후 재생성

감지 루프와 화면은 브라우저 하네스로 확인한다(로그 05·06).

### 인식 범위 조절 (구현됨, 2-3)

운영자용 숨김 화면이다. 관람객용이 아니며, 현장 PC에 마우스와 키보드를 연결해 조작한다고 가정한다.

**열고 닫기**

- `R` 키로 열고 닫는다. 열려 있으면 `Esc`로도 닫는다. `D`(개발용 정보)와는 따로 켜고 끈다. 키 정의는 `js/main.js`의 `Keys`에 있다.
- 열면 다음이 보인다.
  - 조절 패널(화면 아래, "패널 위·아래" 버튼으로 위로 옮길 수 있음)
  - 9:16 영역 위의 편집 사각형
  - 감지 박스(인정 초록, 제외 빨강)와 얼굴 크기 가이드(영역 가운데에 최소 파랑, 최대 보라 정사각형)
- 닫으면 패널·편집 사각형·겹쳐 그리기가 모두 숨겨진다. `D`가 켜져 있으면 `D` 정보와 그 겹쳐 그리기만 남는다. 둘 다 꺼져 있으면 관람객 화면에 흔적이 없다. 인식 상태 임시 표시(`showPresenceIndicator`)는 조절 화면과 무관하게 원래대로 보인다.

**조절 항목과 범위** (`js/presence-settings.js`의 `presenceLimits`)

| 항목 | 조작 | 범위 |
|---|---|---|
| 영역 `region` | 사각형 안을 끌어 이동, 모서리·변의 8개 핸들로 크기 조절 | 9:16 영역 안, 폭·높이 0.1 이상 |
| 최소 얼굴 크기 `minFaceHeight` | 슬라이더 (0.005 단위) | 0.01~1, 최대 이하 |
| 최대 얼굴 크기 `maxFaceHeight` | 슬라이더 (0.005 단위) | 0.01~1, 최소 이상 |
| 최소 신뢰도 `minScore` | 슬라이더 (0.01 단위) | 0.3~1 (하한은 감지기 자체 기준 0.3과 같다. 더 낮추면 효과가 없다) |
| 고급: 인식됨까지 유지 시간 `presentHoldMs` | 슬라이더 (50ms 단위) | 0~5000ms |
| 고급: 인식 안됨까지 유예 시간 `absentGraceMs` | 슬라이더 (50ms 단위) | 0~5000ms |

- 영역 끌기는 시작 위치 대비 이동량으로 계산하고, 반대쪽 변은 고정한다. 끌기 동안에는 `window`에서 포인터 이동·놓기를 받는다. 그래서 포인터가 영역·화면 밖이나 패널 위로 나가도 끌기가 이어진다(검증용 headless Chrome에서는 포인터 캡처가 적용되지 않아 이렇게 바꿨다).
- 끌기는 다음 중 하나가 오면 끝나고, 창과 요소에 붙인 리스너를 모두 해제한다(`region-drag.js`): 주 버튼 놓기(`pointerup`), `pointercancel`, 창 포커스 상실(`blur`), 포인터 캡처 상실(`lostpointercapture`), 놓기 이벤트를 놓친 채 이동 중 주 버튼이 떼어져 있음(`(buttons & 1) === 0`, 이때 그 이동은 반영하지 않음), 조절 화면 닫기.
- 최소·최대 얼굴 크기 슬라이더는 서로를 넘지 못하게, 움직인 쪽이 멈춘다.
- 패널에 실시간 인식 상태(인식됨/인식 안됨, 안정화 진행, 감지·인정 얼굴 수, 감지기 상태), 영역 수치, 저장 여부를 보인다.

**반영과 저장**

- 조절하는 즉시 판정에 반영한다(`createPresenceMonitor()`가 돌려주는 `setSettings()`. 조절 화면 전용이며 촬영 진행 코드는 쓰지 않는다). 기준을 바꾸면 인식 상태를 처음부터 다시 재므로, 조절하는 동안 인식 표시가 잠깐 "인식 안됨"이 되었다가 유지 시간 뒤 돌아온다. 인식으로 시작된 카운트다운 중에 기준을 바꾸면 "인식 안됨"이 되어 그 회차는 취소된다.
- **저장**을 눌러야 `localStorage`에 기록한다.
  - 키: `photobooth.presence.v1`
  - 값: `{ "version": 1, "settings": { "region": {...}, "minFaceHeight", "maxFaceHeight", "minScore", "presentHoldMs", "absentGraceMs" } }`
  - 저장에 실패하면(저장소 차단·용량) 패널에 이유를 보이고 저장값은 그대로 둔다.
- **취소 (저장된 값으로)**: 마지막 저장값(없으면 기본값)으로 되돌린다.
- **기본값으로**: `config.presence` 기본값을 적용한다. 저장하지 않으면 유지되지 않는다.
- **저장하지 않고 닫으면 저장된 값으로 되돌린다.**
  - 이유: 실행 중인 판정값과 다시 시작(새로고침·재부팅)했을 때의 값이 항상 같아야 한다. 저장하지 않은 값이 무인 운영 중에 남아 있다가 재시작 때 말없이 바뀌는 일을 막는다.
  - 현장은 확인 창을 띄우지 않는 키오스크이므로 묻지 않는다. 대신 패널에 "저장하지 않은 변경이 있습니다 (닫으면 취소됩니다)"를 늘 보인다.
- **현재값 JSON (복사용)**: 현재 조절값을 저장 형식 그대로 보이고 "복사" 버튼으로 클립보드에 넣는다(실패하면 선택만 한다). 불러오기 기능은 없다. 4단계에서 파일 저장을 검토할 때 기준으로 쓴다.

**불러오기 검증** (`parseStoredPresenceSettings`, `normalizePresenceSettings`)

시작할 때 저장값을 읽어 검사한다. 어떤 값이 들어 있어도 예외를 던지지 않고 앱은 계속 동작한다.

| 저장값 | 처리 |
|---|---|
| 없음 | 기본값 |
| 손상된 JSON, 객체가 아님 | 전체 기본값 |
| `version`이 1이 아님 | 전체 기본값 (형식이 바뀌면 키와 버전을 함께 올린다) |
| 저장소 읽기 자체가 실패 | 전체 기본값 |
| 숫자가 아니거나 없는 항목 | 그 항목만 기본값 |
| 범위 밖 숫자 | 범위 안으로 맞춤 |
| 영역 형식이 잘못됨 | 영역만 기본값 |
| 영역이 9:16 밖이거나 너무 크거나 작음 | 크기를 0.1~1로 맞춘 뒤 9:16 안으로 옮김 |
| 최소 얼굴 크기 > 최대 | 최대를 최소에 맞춤 |

- 값은 영역 4자리, 크기 3자리, 신뢰도 2자리, 시간은 정수로 반올림한다.
- 고친 내용은 콘솔 경고와 `D` 화면 `settings` 줄에 보인다. 조절 화면을 열면 패널에도 한 번 보인다. 저장소의 값은 운영자가 다시 저장하기 전까지 그대로 둔다.

### 다인원과 스무딩

- 사용자 경험상 MediaPipe는 여러 명을 감지할 때 좌표 스무딩(보간)이 적용되지 않는 문제가 있었다.
- 이 프로젝트는 감지 좌표를 화면에 계속 그리지 않으므로 좌표 스무딩이 필요 없다. 대신 **판정 단계에서 시간 필터**를 쓴다.
  - 영역 안 감지가 일정 시간 유지되면 시작
  - 짧은 누락은 유예
  - 카운트다운 중 일정 시간 계속 비면 취소
- 다인원은 "영역 안에 한 명 이상"을 시작 조건으로 둔다(가안). 카운트다운 중 다른 사람이 합류할 수 있다.
- 감지 좌표가 화면 연출(박스·스티커 추적 등)에 필요해지면 스무딩 문제를 다시 검토한다.

### 성능

- MediaPipe 웹 감지 호출은 메인 스레드를 막을 수 있다. 미리보기·카운트다운이 끊기는지 측정한다.
- 4K 영상을 그대로 감지에 넣지 않는다. 감지 빈도와 분석 해상도를 낮춰 쓰고, 그래도 부족할 때 Worker 분리를 검토한다.
- 측정 (2-2, 개발 PC RTX 5090, headless Chrome 155): OBS 1080×1920 60fps에서 GPU delegate 감지 약 3ms, 그리기 약 3ms, 15fps. 미리보기 60fps, rAF 60을 유지했고 실행 중 50ms 넘는 긴 작업은 없었다. 시작할 때 감지기 생성(wasm 컴파일·그래프 초기화)으로 0.7~1.0초짜리 긴 작업이 한 번 생긴다. 현장 PC에서 다시 잰다.

### MediaPipe 로컬 라이브러리 (구현됨, 2-1)

| 항목 | 내용 |
|---|---|
| 패키지 | `@mediapipe/tasks-vision` **1.1.1** (`devDependencies`, `^`·`~` 없이 고정, `package-lock.json` 커밋) |
| 위치 | `lib/mediapipe/tasks-vision/` (번들·wasm·LICENSE), `lib/mediapipe/models/` (모델) |
| 서버 경로 | `/lib/mediapipe/tasks-vision/vision_bundle.mjs`, `/lib/mediapipe/tasks-vision/wasm`, `/lib/mediapipe/models/blaze_face_short_range.tflite` |
| 모델 | `blaze_face_short_range.tflite` (float16, 버전 `1`), 출처 `https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite`, SHA-256 `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| LICENSE | npm 패키지에 라이선스 파일이 없어 공식 저장소 `google-ai-edge/mediapipe`의 `v1.1.1` 태그 커밋(`50505c8312c7eacb1bd411cecdc4cc9fd08d53cb`)에서 받는다. SHA-256 `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8` |
| wasm | `FilesetResolver.forVisionTasks()`는 WebAssembly SIMD를 지원하면 `vision_wasm_internal.*`, 아니면 `vision_wasm_nosimd_internal.*`를 고른다. 둘 다 둔다. `vision_wasm_module_internal.*`(`forVisionTasks(path, true)` 전용)과 `.cjs`·`.map`·`.d.ts`는 복사하지 않는다 |
| 크기 | 합계 약 27.2MB (가장 큰 파일 `vision_wasm_internal.wasm` 13.5MB, GitHub 100MB 단일 파일 제한 이내) |

기본 사용 형태 (앱에서는 `js/face-detector.js`가 이렇게 부르고, 경로는 `config.faceDetection`에 있다):

```js
import { FilesetResolver, FaceDetector } from '/lib/mediapipe/tasks-vision/vision_bundle.mjs';
const fileset = await FilesetResolver.forVisionTasks('/lib/mediapipe/tasks-vision/wasm');
const detector = await FaceDetector.createFromOptions(fileset, {
  baseOptions: { modelAssetPath: '/lib/mediapipe/models/blaze_face_short_range.tflite', delegate: 'GPU' },
  runningMode: 'VIDEO',
});
```

**갱신 방법 (개발 PC 전용, 현장 불필요):** Node 18 이상에서 실행한다.

1. `npm install --save-dev @mediapipe/tasks-vision@<버전>` (`.npmrc`의 `save-exact=true`로 정확 버전이 기록된다)
2. 버전을 바꾸면 `tools/vendor-mediapipe.mjs`의 LICENSE URL(새 태그의 커밋)과 SHA-256도 함께 고친다. 모델을 바꿀 때도 URL과 SHA-256을 같이 고친다.
3. `npm run vendor:mediapipe` — `lib/mediapipe/tasks-vision/`를 비우고 다시 채우며, 다운로드 파일은 SHA-256이 다르면 실패한다. 이미 맞는 해시의 모델은 다시 받지 않는다. `models/`의 관리 대상이 아닌 파일은 지운다.
4. 텔레메트리 코드 변화(아래)를 확인하고, 앱으로 로딩·외부 요청·CSP 위반을 다시 검증한 뒤 `lib/mediapipe/`, `package.json`, `package-lock.json`을 커밋한다.

**사용 통계 전송 (CSP로 차단, 구현됨):** `tasks-vision` 1.0.0부터 번들에 사용 통계 로거가 들어 있다(0.10.35 이하에는 없음). 태스크를 만들면 항상 켜지며 끄는 옵션이 없다. 번들 코드상 태스크 종류·실행 모드·OS 종류·라이브러리 버전·처리 횟수와 시간 통계를 모으며(이미지·감지 좌표를 넣는 코드는 보지 못했다. 실제 전송 내용을 해독해 확인하지는 않았다) 생성 후 60초마다, 그리고 `close()` 때 `fetch`로 `https://odml.pa.googleapis.com/v1/log`에 POST한다. 전송이 한 번 실패하면 그 인스턴스의 로거는 멈춘다. 현장이 오프라인이면 실패로 끝나지만, 인터넷이 연결된 PC에서는 실제로 전송된다. 그래서 `index.html`의 CSP(`connect-src 'self'`, 1절 "외부 전송 차단: CSP")로 브라우저가 보내기 전에 막는다(사용자 결정, 2026-10-15). 앱에서 외부 요청 0건을 확인했다(로그 05). 버전을 올릴 때는 다른 외부 연결이 생겼는지 다시 확인한다.

## 6. 사진 처리

- 캡처 이미지는 현재 회차의 결과 표시용으로만 메모리에 둔다.
- 대기 복귀·회차 종료 시 이미지 참조와 관련 자원(Object URL 등)을 정리한다.

### 캡처와 결과 이미지 (구현됨, 3-1)

`js/capture.js`의 `createCapture().take()`가 다음 순서로 만든다.

0. **확인 (3-3):** 이전 회차의 효과·인코딩이 끝나지 않았으면 `capture busy`, 마지막 새 카메라 프레임이 `config.capture.maxFrameAgeMs`(500ms, 가안)보다 오래됐으면 `stale frame`으로 캔버스를 만들기 전에 실패한다. 500ms는 30fps 프레임 간격(약 33ms)보다 충분히 길고, 끊김 판정(3초)보다 짧다.
1. **프레임 잡기 (동기):** 미리보기와 같은 `object-fit: cover` 계산(`presence.js`의 `computeCoverMapping`)으로 영상에서 보이는 9:16 영역을 픽셀 단위로 구한다(`computeCaptureCrop`). 그 크기 그대로의 캔버스에 좌우 반전(`translate` + `scale(-1, 1)`, 미리보기의 `scaleX(-1)`과 같음)으로 그린다. 축소·확대하지 않으므로 OBS 1080×1920이면 1080×1920, 2160×3840이면 2160×3840이다. 가로 영상이면 가운데를 잘라 높이를 유지한다(예: 1920×1080 → 608×1080). 캔버스를 만든 직후부터 크기 지정·`getContext`(null 포함)·`drawImage` 중 어디서 실패해도 그 캔버스를 비우고 실패한다(3-3).
2. **사진 효과 (TBD):** `applyPhotoEffect(canvas, { signal })` 한 함수 경계만 둔다. 지금은 그대로 돌려준다. 새 캔버스를 돌려줘도 캡처 쪽이 둘 다 정리한다. `signal`은 회차별 취소 신호다(4절 "실패와 취소 경계").
3. **인코딩:** `canvas.toBlob()`으로 `config.capture`(가안: `image/jpeg`, 품질 0.92). 인쇄 연동 때 넘길 형태를 미리 둔 것이다. 1080×1920 실측은 약 130~150KB, 16~31ms.
4. **정리:** 성공·실패·취소 모두 캔버스 크기를 0으로 만들어 픽셀 버퍼를 바로 놓는다. `toBlob`은 호출할 때 픽셀을 복사하므로 인코딩 중에 비워도 된다. 결과는 `URL.createObjectURL(blob)`로만 들고, `release(photo)`가 `revokeObjectURL`한다(여러 번 불려도 한 번만).

- `release`는 상태 기계가 결과 표시를 끝낼 때, 강제 초기화할 때, 늦게 도착한 결과를 버릴 때 부른다.
- D 화면 `capture`·`resources` 줄에 실제 캡처 크기, 원본 영상 크기, 잘라낸 위치, 형식·용량, 시간, 남은 Object URL·캔버스 수를 보인다. 대기 상태에서 둘 다 0이어야 한다.
- 미리보기와 캡처가 같은지는 3-1 로그의 픽셀 비교 수치로 확인했다.
- 파일·브라우저 영구 저장소·서버·Git에 자동 저장하지 않는다. 로그에 실제 사진이나 얼굴 데이터를 넣지 않는다.
- 인쇄가 범위에 들어오면 인쇄 서비스로 넘기는 방식과 임시 파일 정리 정책을 그때 정한다.

## 7. 참고 자료

- MDN, [MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- MDN, [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
- MDN, [Taking still photos with getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos)
- Google AI Edge, [Face detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)
- Google AI Edge, [Object detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- Google AI Edge, [Pose landmark detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)

구현할 때 실제 버전과 대상 브라우저에서 다시 확인한다.
