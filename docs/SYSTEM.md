# SYSTEM — 기술 구조와 제약

> 실제로 만든 부분은 "구현됨"으로, 아직 만들지 않은 계획은 "가안"으로 표시한다. 구현 범위는 1단계(정적 서버, 9:16 반전 미리보기, 카메라 상태·자동 회복), 2-1(MediaPipe 로컬 라이브러리 배치), 2-2(얼굴 감지와 인식 상태), 2-3(운영자용 인식 범위 조절), 3-1(촬영 상태 기계와 키보드 수동 시작 한 사이클), 3-2(인식 결과로 자동 시작·이탈 취소), 3-3(3단계 검수 반영), 4-1(감지기 안정성·장애 안내), 4-2(현장 실행 스크립트), 4-3(조절값 파일 저장·자동 촬영 일시정지), 4-4(브라우저 확인 도구·장시간 실측), 4-5(4단계 검수 반영), 5-1(사진 효과 "유화 · 획" 이식과 실시간 미리보기), 5-2(촬영 결과에 효과, 효과 조절 화면 `E`, 효과 조절값 파일), 6-2(관람객 화면 디자인)까지다. 감열지용 흑백 단계와 인쇄는 이 브랜치에 아직 없다.

**목차**

1. 전체 구성 — 구성도, 참고 구조, 폴더, 정적 서버, 조절값 파일 API, CSP, 스크립트 인코딩, 현장 실행 스크립트, 브라우저 확인 도구
2. 코드 책임 구분 — 폴더 규칙, 반복 오류 로그 제한
3. 카메라와 영상 — OBS, 화면 배치, 관람객 화면(6-2), 좌우 반전, 권한, 카메라 상태와 자동 회복
4. 촬영 상태 — 촬영 한 사이클, 실패와 취소 경계, 운영자 단축키, 자동 시작과 이탈 취소, 출력 연동 참고
5. 촬영 시작 인식 — 얼굴 감지와 인식 상태, 감지기 상태와 장애 안내, 인식 범위 조절, 다인원, 성능, MediaPipe 로컬 라이브러리
6. 사진 처리 — 캡처와 결과 이미지, 사진 효과(유화 · 획)
7. 참고 자료

## 1. 전체 구성

```text
웹캠 ──▶ OBS (9:16 크롭·회전·보정) ──▶ OBS 가상카메라
                                              │ getUserMedia()
로컬 정적 서버 (localhost) ──▶ 같은 PC 브라우저 (세로 9:16 전체화면)
                                 카메라 → 미리보기(<video>, 반전) → 촬영 진행 → Canvas 캡처(반전) → 결과 화면
                                   │             ▲                                 │
                                   │  감지 결과 또는 개발용 키      사진 효과 (유화, 미리보기와 같은 그림, 5-2)
                                   └→ 효과 미리보기(WebGL2 유화 캔버스, <video> 위를 덮음. 실패하면 원본 미리보기)
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
| 실행 래퍼 (구현됨, 4-2) | `Launch.bat`(ASCII 전용) → `powershell -NoProfile -ExecutionPolicy Bypass -File bin\launch.ps1`. 아래 "현장 실행 스크립트" |
| 설정 (구현됨, 4-2) | `settings.example.ini` → `settings.ini` (`key=value`). 없는 키만 예시에서 채움. `settings.ini`는 Git에서 제외 |
| 정적 서버 (구현됨) | `bin/server/serve.ps1`. 아래 "정적 서버" 참고 |
| OBS 실행 (구현됨, 4-2) | OBS가 실행 중이 아니면 `--startvirtualcam --minimize-to-tray` 등으로 실행 |
| 브라우저 실행 (구현됨, 4-2) | 서버 준비 확인(`GET /` 응답 대기) 후 Chrome 전용 `--user-data-dir` 프로필, `--kiosk`로 실행 (사용자 결정 2026-10-15) |
| 프런트엔드 (구현됨) | 빌드 없는 바닐라 ES 모듈. `package.json`은 라이브러리 받기(`vendor:mediapipe`)에만 쓰고 빌드 스크립트·번들러는 없다 |
| MediaPipe (구현됨) | CDN이 아닌 저장소 `lib/mediapipe/`에 `tasks-vision` 번들·WASM·모델을 둠 (5절 "MediaPipe 로컬 라이브러리") |
| 상태 관리 | 고정된 상태 목록 + 상태 변경 알림 정도의 작은 상태 모듈 |
| 자동 시작 (구현됨, 4-2) | 시작 프로그램 폴더에 `Launch.bat` 바로가기 생성 (`Setup-Startup.bat`) |
| 인쇄 (이후) | 브라우저 → `localhost` HTTP 인쇄 서비스로 요청, 작업 상태를 조회하는 사이드카 패턴 |

**가져오지 않을 것:** Git 자동 업데이트, NAS·AI·결제·Firebase 연동, 워치독·자동 재시작, 야간 스케줄, 지점 인증, 다중 실행 모드 메뉴, 다중 레인 서버, 보정용 패널, 수천 줄 단일 `main.js` 구조.

### 폴더 구성

```text
Launch.bat                  현장 실행 (OBS → 서버 → Chrome 키오스크) → bin/launch.ps1
Shutdown.bat                키오스크 Chrome·서버 종료 → bin/shutdown.ps1
Setup-Startup.bat           시작 프로그램 바로가기 등록·제거(-Remove) → bin/setup-startup.ps1
settings.example.ini        현장 설정 예시 (커밋). settings.ini는 여기서 만들어지고 Git에서 제외
config/presence.local.json  운영자 조절값 파일 (4-3). 서버 API만 쓴다. Git에서 제외. 현장 PC를 옮길 때 복사 (src/web/config/와 다른 폴더)
config/effect.local.json    효과 조절값 파일 (5-2, E 화면). 같은 규칙 (Git 제외, 현장 PC를 옮길 때 복사)
bin/
  common.ps1                실행 스크립트 공용 (로그, 설정, 프로그램 탐색, 프로세스 식별·종료)
  launch.ps1                현장 실행
  shutdown.ps1              종료
  setup-startup.ps1         시작 프로그램 등록
  server/serve.ps1          정적 서버, 조절값 파일 API (구현됨)
src/web/                    (구현됨) 폴더 규칙은 2절 "폴더 규칙"
  index.html                진입점 (`/`)
  main.js                   화면 조립, 관람객 화면에 보일 것 정하기(안내 규칙·인식 표시·쿨타임), 단축키, 개발용 정보·감지 박스 겹쳐 그리기(D 키), 효과 미리보기 연결
  style.css                 페이지 스타일 (서체, 관람객 화면, 운영자 화면)
  assets/                   (6-2) 관람객 화면 서체·이미지. 3절 "관람객 화면"
    fonts/                  GowunBatang-Bold.woff, GowunDodum-Regular.woff, OFL-GowunBatang.txt, OFL-GowunDodum.txt (ThrowSnow에서 복사)
    paper.webp              종이 결 (ThrowSnow에서 복사)
    garland-top.svg         위쪽 솔가지 가랜드·리본, garland-bottom.svg 아래쪽 가랜드
    icon-*.svg              안내 아이콘 (발자국, 별, 방울)
  config/
    config.js               바꿀 수 있는 값 (반전, 화면 비율, 카메라, 회복 시간, 감지기, 인식 판정, 촬영 시간, 사진 효과, 결과 이미지 형식)
    presence-settings.js    판정 설정 검증·정규화·저장 형식, 영역 이동·크기 조절 계산 (순수 함수)
    settings-file.js        조절값 파일 API 클라이언트, 시작할 때 불러오기 순서(인식: 파일 → localStorage 옮기기 → 기본값, 효과: 파일 → 기본값)
    effect-settings.js      사진 효과 설정 범위·정규화, 조절값 저장 형식 (순수 함수, 5-1·5-2)
    guest-text.js           관람객 화면 문구 모음 (6-2, 확정 문구 외 가안)
  core/
    session.js              촬영 한 사이클 상태 기계 (상태 전이·타이머·회차, 시작·취소·초기화 입구)
    auto-start.js           인식 상태 → 상태 기계 연결 (자동 시작 레벨 판정 순수 함수, 이탈 취소)
    presence.js             인식 판정 순수 함수 (좌표 변환, 인정 조건, 시간 안정화)
    guidance.js             관람객 안내 규칙: 카메라·감지기 상태 → "준비 중"/"직원 문의" (순수 함수)
    log-limit.js            반복 오류 로그 제한 (처음 한 번과 주기적인 요약)
    oil-paint.js            유화 효과 순수 계산: 획 목록(ihash·boil·seed), 해상도 비례 규칙, 그림 번호(tick)·seed (5-1)
  camera/
    camera.js               카메라 장치 선택·스트림 시작·종료
    camera-monitor.js       카메라 상태 감시(첫 프레임·끊김)·자동 회복·상태 구독
    capture.js              9:16 보이는 영역 캡처(원본 해상도, 반전), 사진 효과 자리, 결과 이미지(Object URL) 정리
  vision/
    face-detector.js        MediaPipe Face Detector 사전 확인(WebGL·모델 SHA-256)·생성(GPU→CPU)·실패 정리·감지·종료
    detector-keeper.js      감지기 생성·재시도(간격 늘림·상한)·폐기 후 재생성 (한 번에 하나만), 감지기 상태(DetectorHealth)
    presence-monitor.js     감지 루프, 인식 상태 구독 (isPresent·subscribe), 판정 설정 교체 (setSettings)
  effect/                   (5-1) 사진 효과 "유화 · 획" (6절)
    oil-shaders.js          GLSL ES 3.00 셰이더 (원본 oil2f 경로 + 출력 단계)
    oil-renderer.js         WebGL2 렌더러: 텍스처·패스·획 그리기, 소스 한 장 → 효과 그림, GPU 시간
    effect-preview.js       실시간 미리보기: 카메라 영상 → 효과 캔버스, 반전·크롭, fps, 장애 시 원본 미리보기, 결과 사진용 같은 그림(renderStill)
    photo-effect.js         촬영 결과 효과 단계: capture.js의 effect 자리. 실패하면 원본 사진 (5-2)
  ui/
    presence-tuning.js      운영자용 인식 범위 조절 화면 (R 키), 저장은 조절값 파일로
    region-drag.js          인식 영역 마우스 끌기 (이동·크기 조절, 끌기 종료 조건)
    effect-tuning.js        운영자용 사진 효과 조절 화면 (E 키, 5-2), 저장은 효과 조절값 파일로
    guest-screen.js         관람객 화면 표현 (6-2): 3·2·1 숫자·원형 진행, 플래시, 결과 출력물 카드·남은 시간, 안내 문구, 인식 빛
test/                       Node 테스트 (개발 PC 전용, `npm test`). 하위 폴더는 src/web과 같은 이름, 주 대상 모듈 위치를 따른다
  core-deps.test.mjs        core 의존 규칙 검사 (2절 "폴더 규칙")
  helpers.mjs               테스트 공용 흉내 (가짜 시계·타이머, 인식 상태, 캔버스·Object URL). npm test가 직접 실행하지 않는다
  fixtures/fake-vision-bundle.mjs  face-detector 테스트용 MediaPipe 흉내 (번들 파일 이름으로 라이브러리 코드를 알아보므로 별도 파일)
  fixtures/fake-webgl2.mjs  렌더러 테스트용 가짜 WebGL2 (만든·지운 객체 수, 손실·오류·실패 주입)
  core/
    presence.test.mjs       판정 모듈
    session.test.mjs        촬영 상태 기계 (가짜 시계)
    auto-start.test.mjs     자동 시작·이탈 취소 (실제 상태 기계 + 가짜 시계·인식 상태)
    guidance.test.mjs       안내 규칙
    log-limit.test.mjs      로그 제한
    oil-paint.test.mjs      획 목록 결정성·boil 비율·캐시 합치기 = 전부 새로 만들기·원본 ihash 값, 해상도 비례, tick·seed
  camera/
    capture.test.mjs        캡처 영역 계산·자원 정리 (캔버스·Object URL 흉내)
  vision/
    face-detector.test.mjs  사전 확인·생성 실패 정리 (가짜 bundle·fetch·캔버스·document), 모델 SHA-256 기록 대조
    detector-keeper.test.mjs  감지기 재생성·재시도 간격·상태 전이
    presence-monitor.test.mjs  감지 루프 (실제 presence-monitor + 가짜 감지기·document·카메라 프레임)
  config/
    presence-settings.test.mjs  설정 검증·영역 편집 계산
    settings-file.test.mjs  조절값 불러오기 순서·마이그레이션·시간 초과(본문 멈춤 포함), API 클라이언트
    effect-settings.test.mjs  효과 설정 범위·정규화
  effect/
    effect-preview.test.mjs  미리보기 상태·fps·장애(생성 실패·그리기 실패·컨텍스트 손실·복구)·반전·크롭·renderStill (가짜 렌더러·캔버스·화면 갱신)
    photo-effect.test.mjs   결과 효과·실패 시 원본 사진(결과 크기)·효과 끔·취소
    oil-renderer.test.mjs   렌더러 GPU 자원 정리·GL 오류·컨텍스트 손실 판정 (5단계 검수, 가짜 WebGL2)
  ui/
    presence-tuning.test.mjs  조절 화면 저장 중 닫기 (최소한의 가짜 DOM)
    region-drag.test.mjs    영역 끌기 종료 조건 (EventTarget으로 흉내)
    effect-tuning.test.mjs  효과 조절 화면 즉시 반영·저장·되돌리기·저장 중 닫기
    guest-screen.test.mjs   관람객 화면 표현: 카운트다운·원형 진행, 플래시, 결과 카드·남은 시간, 안내 문구 (6-2)
  tools/
    browser-check-lib.test.mjs  확인 도구의 조절값 파일 백업·복원, CDP 제한 시간·끊김
lib/mediapipe/              MediaPipe 런타임·모델 (구현됨, 커밋 대상. 직접 고치지 않고 스크립트로 갱신)
  tasks-vision/vision_bundle.mjs
  tasks-vision/wasm/        vision_wasm_internal.{js,wasm}, vision_wasm_nosimd_internal.{js,wasm}
  tasks-vision/LICENSE      Apache-2.0
  models/blaze_face_short_range.tflite
tools/vendor-mediapipe.mjs  node_modules → lib/mediapipe 복사, 모델·LICENSE 다운로드·SHA-256 검증 (개발 PC 전용)
tools/browser-check.mjs     브라우저 확인 도구·장시간 실측 (개발 PC 전용, `npm run check:browser`, 4-4)
tools/browser-check-lib.mjs 확인 도구 부품: 파일 백업·복원, CDP 세션(제한 시간·끊김) (4-5)
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
- 경로 매핑: `/` → `src/web/index.html`, `/lib/*` → 저장소 `lib/`(폴더가 없으면 404), `/local-api/*` → 아래 "조절값 파일 API", 나머지 → `src/web/`.
- 경로 탈출 차단: URL 디코딩 후 역슬래시·`:`·제어 문자·와일드카드 문자, `.`으로 시작하거나 `.`·공백으로 끝나는 경로 조각(`..`, 숨김 파일 포함)을 400으로 거절한다. 마지막으로 실제 경로가 루트 안에 있는지 다시 확인한다(벗어나면 403). 루트를 벗어나는 일부 URL은 http.sys가 스크립트보다 먼저 403으로 막는다.
- MIME: html, js, mjs, css, json, svg, png, jpg/jpeg, webp, woff(6-2), woff2, wasm, tflite, task. 그 외는 `application/octet-stream`.
- 모든 응답에 `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`. 정적 파일은 GET·HEAD만 허용(그 외 405).
- Ctrl+C로 종료한다. 요청 대기를 짧게 끊어 기다리므로 Ctrl+C가 바로 반영되고 리스너를 닫는다.
- 요청은 한 번에 하나씩 처리한다(단일 루프). 한 요청이 실패해도 500으로 답하고 다음 요청을 받는다.

### 조절값 파일 API (구현됨, 4-3·5-2)

운영자 조절값(5절 "인식 범위 조절", 6절 "사진 효과"의 `E` 화면)을 브라우저 프로필이 아니라 저장소 안 파일에 둔다. 프로필을 바꾸거나 새로 만들어도 같은 값을 쓰고, 현장 PC를 옮길 때 파일만 복사하면 되게 하기 위해서다(사용자 결정 2026-10-15, 효과는 2026-10-16).

| 경로 (고정 표) | 저장 파일 | 쓰는 쪽 |
|---|---|---|
| `/local-api/presence-settings` | `config/presence.local.json` | 인식 범위 조절 `R` (4-3) |
| `/local-api/effect-settings` | `config/effect.local.json` | 사진 효과 조절 `E` (5-2) |

| 항목 | 내용 |
|---|---|
| 경로 | 위 표의 URL과 **정확히 같을 때만**(서수 비교 사전. 대소문자·쿼리·끝 `/`·퍼센트 인코딩 변형은 404). 그 밖의 `/local-api/*`도 404 |
| 저장 파일 | 경로마다 파일 하나로 고정. 클라이언트가 파일 이름·경로를 정할 수 없다. `.gitignore`의 `/config/*.local.json`, 임시 파일 `/config/*.tmp` |
| 공용 처리 | 두 경로가 아래 쓰기 검사(CSRF 방어)·16KB 상한·JSON 객체 검사·원자적 쓰기를 같은 함수로 쓴다(`Invoke-SettingsApi`, 5-2에서 경로 표로 묶음) |
| `GET` | 파일이 있으면 200 `application/json; charset=utf-8`(저장한 바이트 그대로), 없으면 404 |
| `PUT` | 아래 조건을 모두 만족하면 원자적으로 쓰고 204. 아니면 4xx와 짧은 이유(본문·서버 로그) |
| 그 밖 | 405 `Allow: GET, PUT` (`OPTIONS`·`POST`·`DELETE`·`HEAD` 포함) |

**CSRF 방어.** 루프백 제한(위)은 같은 PC의 다른 웹페이지가 브라우저를 통해 `localhost`로 요청을 보내는 것을 막지 못한다. 그래서 `PUT`은 이 페이지의 같은 출처 `fetch`처럼 보일 때만 받는다.

| 조건 | 거절 |
|---|---|
| `X-Photobooth: 1` 헤더 | 403 |
| `Content-Type: application/json` (`charset`이 있으면 `utf-8`만) | 415 |
| `Host`가 `localhost:<port>` | 403 (그 밖의 호스트 이름은 http.sys가 먼저 400) |
| `Origin`이 있으면 `http://localhost:<port>`와 같음 | 403 |
| `Sec-Fetch-Site`가 있으면 `same-origin` | 403 |

- 커스텀 헤더와 JSON 형식 때문에 다른 출처의 요청은 브라우저가 먼저 사전 요청(`OPTIONS`)을 보낸다. 서버는 405로 답하고 CORS 허용 헤더(`Access-Control-Allow-*`)를 어떤 응답에도 보내지 않으므로, 브라우저가 실제 `PUT`을 보내지 않는다. 헤더 없이 보낼 수 있는 단순 요청(`no-cors`)은 위 조건에서 거절된다.
- `Origin`·`Sec-Fetch-Site`가 없는 요청(브라우저가 아닌 같은 PC 프로그램)은 받는다. 같은 PC의 프로그램은 파일을 직접 쓸 수도 있으므로 막을 대상이 아니다.
- DNS 리바인딩(다른 도메인 이름을 `127.0.0.1`로 돌리는 공격)은 `Host`가 달라 http.sys가 400으로 막고, 스크립트도 `Host`를 다시 확인한다.

**본문 검사와 쓰기**

- 본문은 16KB(16384바이트) 상한이다. `Content-Length`가 크거나, 길이를 밝히지 않은(chunked) 본문이 상한을 넘으면 413. 읽을 때도 상한까지만 읽는다.
- 엄격한 UTF-8로 풀리지 않으면 400. `JavaScriptSerializer`로 풀어 JSON **객체**가 아니면(배열·문자열·숫자·빈 본문·뒤에 붙은 문자) 400.
- 값의 의미는 검사하지 않는다. 범위·형식은 클라이언트의 `presence-settings.js`·`effect-settings.js` 정규화가 맡는다(아래 "불러오기 검증", 6절). 그래서 어떤 내용이 저장돼 있어도 화면은 안전하게 불러온다. `JavaScriptSerializer`는 표준보다 너그러운 JSON도 받을 수 있는데, 그런 내용은 브라우저 `JSON.parse`에서 실패해 기본값으로 불러온다.
- **원자적 쓰기:** 같은 폴더의 임시 파일(`<파일 이름>.<guid>.tmp`)에 쓰고 디스크까지 flush한 뒤 `File.Replace`(처음이면 `File.Move`)로 바꾼다. 읽는 쪽은 항상 이전 파일이나 새 파일 전체를 본다. 다른 프로세스가 잠깐 잡고 있어 실패하면 50ms 간격으로 5번까지 다시 시도하고, 끝내 실패하면 500으로 답한다. 임시 파일은 성공·실패와 관계없이 지운다.
- PowerShell 5.1은 문자열 매개변수에 넘긴 `$null`을 빈 문자열로 바꾼다. 그래서 `File.Replace`의 백업 경로는 `[NullString]::Value`로 넘긴다(검증 중 발견, 로그 12).

### 외부 전송 차단: CSP (구현됨)

`src/web/index.html`의 `<meta http-equiv="Content-Security-Policy">`(다른 스크립트보다 먼저)로 같은 출처만 허용한다. MediaPipe 1.x의 사용 통계 전송(5절)을 막기 위해 넣었고, 오프라인 원칙의 안전장치이기도 하다(사용자 결정, 2026-10-15).

```text
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'
```

- `connect-src 'self'`: `fetch`·XHR·WebSocket은 `localhost`로만 갈 수 있다. 통계 전송은 브라우저가 보내기 전에 막는다.
- `script-src 'self' 'wasm-unsafe-eval'`: MediaPipe WASM 컴파일에 `wasm-unsafe-eval`이 필요하다. `unsafe-eval`·`unsafe-inline`은 넣지 않았다(필요 없음을 확인).
- `img-src 'self' blob:`: 결과 사진은 메모리 안의 Object URL(`blob:http://localhost:.../...`)로 `<img>`에 보인다. CSP의 `'self'`는 `blob:` 주소를 포함하지 않아, 없으면 결과 사진이 막힌다(3-1 검증에서 `img-src blob` 위반과 `naturalWidth 0`을 확인). `blob:`은 같은 페이지가 만든 메모리 자료만 가리키므로 외부 전송이 아니다. `data:`는 넣지 않았다(3-1, 2026-10-15).
- 나머지(`style`·`font`·`media`·`worker` 등)는 `default-src 'self'`를 따른다. 카메라 영상(`srcObject`), CSSOM으로 바꾸는 CSS 변수, Web Animations, 캔버스는 영향을 받지 않는다.
- 관람객 화면(6-2)의 서체·이미지는 모두 `src/web/assets/`의 같은 출처 파일이라 정책을 넓히지 않았다. 인라인 `<style>`·`style=""`는 쓰지 않고 `style.css`와 JS(Web Animations, CSSOM)만 쓴다.
- 차단 때문에 콘솔에 `Connecting to 'https://odml.pa.googleapis.com/v1/log' violates the following Content Security Policy directive` 오류가 감지기마다 한 번(생성 후 약 60초) 찍힌다. 무해하다. 한 번 실패하면 그 감지기의 통계 로거가 멈추므로 반복되지 않는다.
- 새 기능이 외부 자원이나 다른 출처를 써야 하면 이 정책을 함께 고친다. 넓히지 않는 것이 원칙이다.

### 스크립트 인코딩 규칙

- `.ps1`, `.bat`, `.cmd` 파일은 **ASCII 문자만** 쓴다. 주석도 영어로 쓴다. Windows PowerShell 5.1은 BOM 없는 UTF-8 파일을 시스템 코드 페이지로 읽어 한글이 깨지고 구문 오류가 날 수 있다.
- 이 파일들은 `.gitattributes`에서 `eol=crlf`로 체크아웃한다.
- 웹 파일(html·js·css)은 UTF-8이며, 서버가 `charset=utf-8`로 제공한다.

### 현장 실행 스크립트 (구현됨, 4-2)

`Launch.bat`이 `bin/launch.ps1`을 실행한다. 순서는 **설정 → OBS → 서버 → Chrome**이다. 한 단계라도 실패하면 거기서 멈추고, 단계 이름과 원인을 콘솔과 `logs/launch_*.log`에 남긴 뒤 종료 코드 1로 끝난다. `Launch.bat`은 이때 창을 멈추고 `logs\` 위치를 안내한다. 앞 단계에서 띄운 것은 되돌리지 않는다(다음 실행이나 `Shutdown.bat`이 정리한다).

- **중복 실행:** 이름 있는 mutex `Local\ShinsegaePhotoboothLaunch`를 잡지 못하면 바로 실패한다.
- **로그:** `logs/launch_*.log`, `logs/shutdown_*.log`는 종류별 최근 20개, 서버 출력 `logs/server_*.out.log`·`.err.log`는 최근 20회분만 남긴다. 촬영 이미지는 로그에 들어가지 않는다(서버 출력은 요청 경로와 상태 코드뿐이다).
- **설정:** `settings.ini`가 없으면 `settings.example.ini`를 복사한다. 있으면 예시에만 있는 키를 끝에 덧붙이고 기존 값은 바꾸지 않는다. 값을 검증해(포트 범위, `true`/`false`, `x,y` 형식, 절대 경로, 프로필이 저장소 밖인지) 틀리면 `settings` 단계에서 실패한다. 시험용으로 `-SettingsPath <파일>`을 줄 수 있다(이때는 파일을 만들거나 고치지 않는다). `Launch.bat`·`Shutdown.bat`은 받은 인자를 그대로 넘긴다.

**설정 키** (`settings.example.ini`)

| 키 | 기본값 | 뜻 |
|---|---|---|
| `server_port` | `8765` | 로컬 서버 포트. 카메라 권한은 출처(`http://localhost:<port>`)별로 저장되므로 바꾸면 다시 허용해야 한다 |
| `chrome_path` | 비움(자동) | App Paths 레지스트리(HKLM·HKCU) → Program Files → Program Files (x86) → LocalAppData 순서로 찾는다 |
| `chrome_profile_dir` | `%LOCALAPPDATA%\ShinsegaePhotobooth\ChromeProfile` | 키오스크 전용 프로필. 카메라 권한이 여기에 저장된다. 저장소 안이면 실패한다 |
| `kiosk` | `true` | `--kiosk`(사용자 결정 2026-10-15). `false`면 `--app=<url>` 일반 창(시험용) |
| `window_position` | 비움 | `x,y` → `--window-position`. 키오스크 창을 띄울 모니터를 고른다 |
| `window_size` | 비움 | `너비,높이` → `--window-size`. `kiosk=false`일 때만 |
| `obs_path` | 비움(자동) | `HKLM\SOFTWARE\OBS Studio` 설치 경로 → Program Files → Program Files (x86) |
| `obs_autostart` | `true` | OBS가 꺼져 있으면 시작 |
| `obs_stop_on_shutdown` | `false` | `Shutdown.bat`이 OBS도 종료할지 |

**OBS 단계**

- `obs64` 프로세스가 하나라도 있으면 아무것도 하지 않는다(경로와 무관).
- 꺼져 있고 `obs_autostart=true`면 경로를 찾아 파일 속성의 버전을 로그에 남기고, 작업 폴더를 `obs64.exe` 폴더로 해서 시작한다. 3초 뒤 프로세스가 끝나 있으면 실패로 본다. 가상카메라 장치가 늦게 준비돼도 웹의 카메라 자동 회복이 이어서 연결한다(3절).
- 플래그는 OBS 32.2.1 `obs64.exe`의 `--help` 문구(실행 파일 안 문자열)로 지원을 확인한 것만 쓴다.

| 플래그 | 이유 |
|---|---|
| `--startvirtualcam` | 가상카메라를 켠 채로 시작 |
| `--minimize-to-tray` | OBS 창이 키오스크 화면을 가리지 않게 트레이로 |
| `--disable-updater` | 업데이트 확인 대화상자가 키오스크 위에 뜨지 않게 |
| `--disable-missing-files-check` | "누락된 파일" 대화상자가 시작을 막지 않게 |

- **비정상 종료 뒤 안전 모드 대화상자:** OBS 32에는 `--disable-shutdown-check`가 없다(참고 프로젝트가 쓰던 플래그, 32.2.1 실행 파일에 문자열 없음). OBS 32는 실행 중 `%APPDATA%\obs-studio\.sentinel\run_<id>` 표식을 두고 정상 종료 때 지운다. 표식이 남아 있으면 다음 시작 때 "OBS Studio Crash Detected / 안전 모드로 실행?" 대화상자가 떠 가상카메라가 시작되지 않는다. 그래서 **OBS가 하나도 실행 중이 아닐 때만** 남은 `run_*` 표식을 지우고 시작한다. 이 처리와 플래그는 OBS 32.x에서만 확인했으므로, 다른 버전이면 경고를 로그에 남긴다.

**서버 단계**

- 이 저장소 `bin\server\serve.ps1`을 `-File <전체 경로>`로 실행 중인 PowerShell만 이전 서버로 보고 종료한다(명령줄 일치). 다른 경로나 상대 경로로 띄운 서버는 건드리지 않는다.
- 그 뒤 `http://localhost:<port>/`에 무엇이든 응답하면 다른 프로그램이 포트를 쓰는 것으로 보고 실패한다.
- `powershell.exe -File serve.ps1 -Port <port>`를 창 없이(`-WindowStyle Hidden`) 띄우고 표준 출력·오류를 `logs/server_*.log`로 보낸다. `Launch.bat` 창이 닫혀도 서버는 계속 돈다.
- `GET /`가 200을 돌려줄 때까지 최대 15초 기다린다. 그 사이 서버가 끝나면 오류 출력 끝부분을 실패 원인에 붙인다.
- 제약: 서버가 `Launch.bat`의 표준 출력 핸들을 물려받으므로, `Launch.bat` 출력을 파이프로 받으면 서버가 끝날 때까지 파이프가 닫히지 않는다. 콘솔에서 실행한다.

**Chrome 단계**

- 같은 전용 프로필로 이미 떠 있는 Chrome이 있으면 먼저 닫는다(창 닫기 요청 → 5초 뒤 남은 것만 강제 종료). 같은 프로필로 다시 시작하면 기존 인스턴스에 창만 하나 더 생기기 때문이다.
- 하드웨어 가속: 감지기가 WebGL을 쓰므로 꺼지면 안 된다. 사용자가 Chrome 설정에서 끄면 프로필의 `Local State`에 `"hardware_acceleration_mode":{"enabled":false}`가 남는다. 실행 전에 이 값이 있으면 `true`로 바꾸고 경고를 남긴다. 기본값(키 없음)은 켜짐이다. 고칠 때는 그 값만 바꾼 내용을 같은 폴더의 임시 파일에 쓰고, JSON으로 읽히고 값이 `true`인지 확인한 뒤 `File.Replace`(`[NullString]::Value`)로 원자적으로 바꾼다. 문제가 있으면 원본을 그대로 두고 경고만 남긴다(실행은 계속, 4단계 검수 7). GPU를 끄는 플래그(`--disable-gpu` 등)는 쓰지 않는다. 실행 화면 쪽 WebGL 점검은 4-1이 맡는다.
- `--kiosk <url>`로 연다. `kiosk=false`면 `--app=<url>`과 `--window-size`를 쓴다.

| 플래그 | 이유 |
|---|---|
| `--user-data-dir="<chrome_profile_dir>"` | 일반 Chrome과 분리. 카메라 권한 유지, 종료 대상 식별에 쓴다 |
| `--kiosk` | 주소창·탭 없는 전체화면 (사용자 결정) |
| `--no-first-run` | 새 프로필의 첫 실행 화면을 띄우지 않음 |
| `--no-default-browser-check` | 기본 브라우저 설정 안내를 띄우지 않음 |
| `--hide-crash-restore-bubble` | 강제 종료·정전 뒤 "페이지 복원" 말풍선을 띄우지 않음 (`--disable-session-crashed-bubble`은 Chrome 155에 없음) |
| `--disable-features=Translate` | 번역 제안을 띄우지 않음 |
| `--disable-pinch` | 터치 화면에서 핀치 확대로 화면이 틀어지지 않게 |
| `--overscroll-history-navigation=0` | 가로 밀기 제스처로 뒤로 가기 하지 않게 |
| `--window-position=x,y` | 설정했을 때만. 다중 모니터에서 띄울 화면 선택 |

- 위 스위치 이름은 Chrome 155 `chrome.dll` 안의 문자열로 있는지 확인했다. 이 조합으로 창을 띄웠을 때 경고 막대가 생기지 않고(창 안쪽 높이가 플래그 없는 창과 같음) WebGL이 GPU로 동작하는 것을 확인했다. 각 플래그가 막는 화면(번역 제안, 복원 말풍선, 핀치·제스처)이 실제로 나오지 않는지는 상황을 재현하지 않아 확인하지 않았다.

**카메라 권한: 전용 프로필에서 운영자가 처음 한 번 허용 (4-2 결정)**

| 방법 | 이점 | 위험 |
|---|---|---|
| 전용 프로필에서 한 번 허용 (선택) | Chrome 기본 동작 그대로. 허용한 출처(`http://localhost:<port>`)·카메라에만 적용 | 첫 설치·프로필 삭제·포트 변경 때 운영자가 마우스로 "허용"을 눌러야 한다. 그 전까지 화면은 "준비 중"에 머문다 |
| `--use-fake-ui-for-media-stream` | 묻는 창 자체가 없다 | **Chrome 155에서 "지원되지 않는 명령줄 플래그" 경고 막대가 뜬다**(창 안쪽 높이 56px 감소로 확인). 키오스크 화면 위쪽을 가린다. 시험용 스위치이고 프로필의 모든 출처·카메라·마이크 요청을 자동 수락한다 |
| 프로필 `Preferences`에 권한 미리 기록 | 묻는 창 없음 | Chrome 내부 형식에 의존해 버전마다 달라질 수 있다(시험하지 않음) |
| 정책(레지스트리) | 공식 방식 | HKCU 정책은 같은 사용자의 일반 Chrome에도 적용되고, HKLM은 관리자 권한이 필요하다 |

- 키오스크는 `localhost` 앱만 띄우므로 자동 수락의 보안 위험 자체는 작다. 그래도 경고 막대가 관람객 화면을 가리는 것이 결정적이어서 첫 번째 방법을 골랐다.
- 허용하기 전에도 앱은 멈추지 않는다. 묻는 창이 떠 있는 동안은 카메라 상태가 `starting`("준비 중")이고, 창을 닫거나 거절하면 `permission-denied`가 되어 3절의 회복 규칙을 따른다.

**종료 (`Shutdown.bat` → `bin/shutdown.ps1`)**

- Chrome: 명령줄의 `--user-data-dir`이 `chrome_profile_dir`과 같은 프로세스와 그 자식만 종료한다(창 닫기 요청 → 5초 뒤 강제). 일반 Chrome은 프로필이 달라 대상이 아니다.
- 서버: 위 서버 단계와 같은 명령줄 일치로 찾은 것만 종료한다.
- OBS: `obs_stop_on_shutdown=true`일 때만, 경로가 `obs_path`(또는 자동 탐색 경로)와 같은 `obs64.exe`만 종료한다. 트레이에 있으면 창이 없어 10초 뒤 강제 종료되고, 이때 남는 표식은 다음 실행이 지운다.
- 한 항목이 실패해도 나머지를 계속하고, 하나라도 실패하면 종료 코드 1로 끝난다.

**부팅 시 자동 실행 (`Setup-Startup.bat` → `bin/setup-startup.ps1`)**

- 현재 사용자의 시작 프로그램 폴더(`shell:startup`)에 `Shinsegae Photobooth.lnk`(대상 `Launch.bat`, 작업 폴더 저장소 루트, 보통 창)를 만든다. `-Remove`로 지운다. 관리자 권한·작업 스케줄러는 쓰지 않는다.
- 이름이 같아도 설명·대상이 다른 바로가기는 바꾸거나 지우지 않고 실패한다.
- 로그인할 때 실행되므로 무인 부팅에는 Windows 자동 로그인이 따로 필요하다.

### 브라우저 확인 도구 (구현됨, 4-4)

`tools/browser-check.mjs` (`npm run check:browser`). 개발 PC에서 실제 앱을 headless Chrome으로 띄워 정해진 시나리오를 확인한다. 4-3까지 검증 때마다 저장소 밖에 만들던 임시 하네스를 저장소로 옮긴 것이다. 현장 PC에는 필요 없다(Node가 필요하다).

**구조**

- 의존성 없음. Node 22 이상 내장 `WebSocket`으로 Chrome DevTools Protocol(CDP)에 직접 붙는다. Windows 전용(`serve.ps1`).
- **서버:** `bin/server/serve.ps1`을 남는 포트(운영체제가 고른 빈 포트)로 띄운다. 현장 서버(8765)와 겹치지 않는다.
- **Chrome:**
  - `%TEMP%\photobooth-check-*` 임시 프로필, `--headless=new`, `--remote-debugging-port=0`으로 띄운다. 실제 포트는 프로필의 `DevToolsActivePort` 파일에서 읽는다.
  - `--user-data-dir`를 늘 주므로 사용자의 Chrome에 붙지 않는다.
  - 카메라는 기본이 Chrome 가짜 장치(`--use-fake-device-for-media-stream`)이고, `--camera real`이면 실제 장치(OBS 가상카메라 우선)를 쓴다.
  - 카메라 권한은 CDP `Browser.setPermission`으로 준다. `--use-fake-ui-for-media-stream`은 CDP로 거절한 권한까지 자동 수락해서 거절 시나리오를 만들 수 없어 쓰지 않는다(확인함).
- **앱 상태 읽기:** 운영자 D 화면(개발용 정보) 글자를 줄 머리말(`status`, `detector`, `session`, `resources` 등)로 읽고, 관람객 안내는 `#status` 요소로 읽는다. **앱 코드에 확인 전용 훅을 넣지 않았다.** D 화면 줄 형식을 바꾸면 이 도구도 함께 고친다.
- **조작:** 키는 CDP `Input.dispatchKeyEvent`(`D`, `S`), 모델 차단은 CDP `Fetch`(404 응답), 권한은 `Browser.setPermission`
- **기록:** 외부 요청(`Network.requestWillBeSent`), CSP 위반(`Log.entryAdded`), 페이지 예외(`Runtime.exceptionThrown`), 콘솔 메시지 수
  - MediaPipe 사용 통계 전송(`odml.pa.googleapis.com`)의 CSP 차단은 의도된 동작이라 따로 세고 실패로 보지 않는다.
- **결과:** 통과/실패 표를 출력하고, 하나라도 실패하면 종료 코드 1이다.
- **정리:** 성공·실패·Ctrl+C·처리 안 된 예외 모두 자신이 띄운 Chrome(프로세스 트리)·서버·임시 프로필만 정리한다. 사용자 Chrome·OBS·현장 서버는 건드리지 않는다. `--keep-profile`이면 조사용으로 프로필을 남긴다.
- **조절값 파일 복원 (4단계 검수 1):** 시작할 때 `config/presence.local.json`을 바이트 그대로(또는 "없음"으로) 백업하고, 조절값 시나리오 직후와 마지막 정리에서 **파일 시스템으로 직접** 되돌린다(같은 폴더 임시 파일 → rename). 서버 API로 되돌리면 잘못된 JSON·16KB를 넘는 원본이 거절돼 시험 값이 남았다. 없던 파일은 지우고, 도구가 만든 빈 `config/` 폴더도 지운다. 실패하면 결과 표에 실패로 나온다.
- **CDP (4단계 검수 2):** 요청마다 제한 시간(기본 15초)이 있다. 연결이 닫히거나 오류가 나면 기다리던 요청을 모두 실패시키고 이후 요청도 바로 실패한다. 대기 루프도 바로 끝나므로, Chrome이 죽어도 도구가 몇 초 안에 실패로 끝나고 정리한다(`tools/browser-check-lib.mjs`).
- **계측 스크립트:** 생성 실패 정리 시나리오를 위해, 도구가 페이지 스크립트보다 먼저 `setInterval`·`clearInterval`을 감싸 살아 있는 타이머를 센다(`Page.addScriptToEvaluateOnNewDocument`). 앱 코드는 바꾸지 않는다.
- 사진·프레임을 저장하지 않는다.

**시나리오 (한 번에 약 100초, 5-2부터)**

| 시나리오 | 확인 |
|---|---|
| 페이지 로드 | 카메라 `ready`, 감지기 `running, health ok`와 delegate 표시, 조절값 불러오기 끝남, 안내 없음. 서체 두 개(`Gowun Batang`·`Gowun Dodum`)가 `loaded`이고 받은 `/assets/` 파일이 모두 200 (6-2) |
| `S` 수동 한 사이클 | 카운트다운 → 결과 → 쿨타임 → 대기, `completed` +1, 사진 자원(Object URL·캔버스·대기 작업) 0. 결과 상태에서 결과 `<img>`가 보이고(숨김 아님, 크기 0 아님) `naturalWidth`·`naturalHeight`가 D `capture` 줄의 캡처 크기와 같다(4단계 검수 8) |
| 조절값 API | 페이지 안 `fetch`로 `GET` → `PUT` → `GET` 같은 내용, `X-Photobooth` 없는 `PUT` 403. 원본은 위 "조절값 파일 복원"으로 되돌린다. 그사이 몇 초 동안은 시험 값이 들어 있으므로, 현장 서버가 같은 저장소에서 도는 PC에서는 돌리지 않는다 |
| 감지기 생성 실패 정리 | 페이지에서 `createFaceDetector`를 모델 대신 LICENSE 파일(크기·SHA-256은 맞춤)로 3번 불러 실제 MediaPipe 그래프 시작에서 실패시킨다. 60초 타이머·로더 스크립트 수가 늘지 않고, 앱의 감지기는 `ok` 그대로 (4단계 검수 6의 실제 브라우저 확인) |
| 권한 거절 → 허용 | 거절 상태로 열면 카메라 `permission-denied`와 "직원에게 문의해 주세요", 허용하면 권한 `change` 이벤트로 바로 다시 연결해 `ready`(개발 PC 약 0.3초), 안내 사라짐 |
| 모델 차단 | 모델 요청 404 → 감지기 `retrying / model-unavailable`, "준비 중입니다", 인식 표시(`#stage.is-present`)·대기 안내(`#guide`) 숨김, 그 상태에서 `S` 한 사이클과 자원 0 |
| 사진 효과 미리보기 (5-1) | D `effect`가 `running`, 효과 캔버스가 보이고 `<video>`와 같은 자리·크기, CSS 반전 없음. 초당 그림 수 = `fps`(±1). `WEBGL_lose_context`로 컨텍스트를 잃게 하면 `context-lost`·캔버스 숨김·카메라 `ready`·영상 재생 중, 되살리면 다시 `running` |
| 촬영 결과에 효과 (5-2) | 효과 캔버스에 새 그림이 그려질 때마다 화소를 복사해 두고(최근 8장, 페이지 메모리), 카운트다운이 끝나는 순간을 기록한 뒤 `S`. 결과가 1080×1920이고 D `photo-fx`가 `applied … same drawing as preview`. 결과 사진과 각 그림을 10×10 블록 평균으로 비교해, 셔터 직전 그림과의 차이가 1.5/255 미만이고 다른 그림과의 차이가 그 두 배보다 크다 |
| 효과 WebGL2 생성 실패 (5-1) | 페이지 스크립트보다 먼저 효과 캔버스의 `getContext('webgl2')`만 `null`을 돌려주게 하고 연다 → `fallback (webgl2-unavailable…)`, 캔버스 숨김, 안내 문구 없음, 카메라·감지기 정상, `S` 한 사이클과 자원 0, 결과는 원본 사진(`RAW PHOTO`) |
| 효과 조절 `E` (5-2) | `E`로 열어 초당 그림 슬라이더를 12로 → 바로 약 12장/초, 저장 → 새로고침 뒤 `fps 12`, `GET /local-api/effect-settings` 200(`fps` 12), 헤더 없는 `PUT` 403, 대소문자 다른 경로 404. 끝나면 두 조절값 파일을 파일 시스템으로 되돌린다 |
| 결과 효과 렌더 실패 3가지 (5-2, 검수 1) | 페이지 스크립트보다 먼저 `readPixels`를 감싸, 100만 화소 이상 읽기만 한 번 건드린다: 예외, 실제 `INVALID_OPERATION`(RGB 형식으로 읽기), 읽기 직전 실제 컨텍스트 손실(`WEBGL_lose_context`). 셋 다 `S` 한 사이클이 끝까지 돌고 결과는 원본 사진 1080×1920(D `photo-fx`가 `RAW PHOTO`와 원인), 자원 0. 미리보기는 계속 `running`(손실은 되살린 뒤 `running`) |
| 전체 기록 | 외부 요청 0, CSP 위반 0(통계 차단 제외), 페이지 예외 0 |

- **범위 밖:** 가짜 카메라 영상에는 얼굴이 없으므로 **자동 시작·이탈 취소·인식 중 `P`는 확인하지 않는다.** 이것들은 Node 통합 테스트(`test/core/auto-start.test.mjs`, `test/vision/presence-monitor.test.mjs`)와 사람의 실측으로 확인한다. 키오스크 화면, OBS 시작·중지, 절전 복귀, 4K도 범위 밖이다.
- **`S` 사이클은 `P`(자동 촬영 일시정지)를 켜고 돌린다 (5-2).** 실제 카메라 앞에 사람이 있으면 쿨타임 뒤 자동 회차가 시작돼 대기 상태를 기다리다 실패했기 때문이다(로그 02). 켜기 전에 시작된 자동 회차가 끝나 대기가 될 때까지 기다리고, 끝나면 `P`를 되돌린다. 일시정지는 저장되지 않으므로 페이지를 다시 열면 풀린다.
- 조절값 파일은 인식(`presence.local.json`)과 효과(`effect.local.json`) 둘 다 시작할 때 백업하고 같은 방법으로 되돌린다.

**장시간 실측 (`--soak [분]`, 기본 10분)**

- 앱을 한 번 열고, `--interval`(기본 20초)마다 대기 상태면 `S`를 누른다. 자동 회차·쿨타임 중이면 건너뛰고 센다.
- 분을 생략하면 10분이다. 더 길게 돌릴 때만 `--soak 60`처럼 분을 준다.
- 1분마다 다음을 기록해 CSV에 한 줄씩 쓴다. 기본 경로는 `logs/soak_*.csv`이고 Git에서 제외된다.
  - CDP `Performance.getMetrics`: JS 힙, DOM 노드, 이벤트 리스너, 문서 수
  - D 화면: 사진 자원, 완료 회차, 감지 빈도, 카메라·감지기·상태 기계 상태
  - 이 도구 프로필의 `chrome.exe` 전체 메모리: `Win32_Process`의 `PrivatePageCount`·`WorkingSetSize` 합. 작업 관리자 값의 근사치
  - 콘솔 메시지 누적 수, 페이지 예외 수
- 끝나면 항목별 시작·중간·끝·최소·최대와 시간당 기울기(최소제곱)를 출력한다. 처음 5분을 뺀 기울기도 함께 낸다.
- **통과 조건 (4단계 검수 5):** 모든 기록에서 카메라 `ready`와 감지기 `health ok`, `S`를 누르기 직전(대기 상태)마다 사진 자원 0이고 `taken = released`, 측정값을 모두 읽음(숫자가 아니거나 Chrome 메모리를 못 읽으면 실패), 외부 요청·CSP 위반(통계 차단 제외)·페이지 예외 0, 완료 회차 1 이상

## 2. 코드 책임 구분

| 영역 | 책임 |
|---|---|
| 카메라 | OBS 가상카메라 장치 선택, 스트림 시작·종료, 첫 프레임 준비 확인, 단절 감지 |
| 얼굴 감지 (구현됨) | `face-detector.js`: 사전 확인(WebGL·모델), MediaPipe 생성·실패 정리·감지·종료만. 영상 기준 정규화 박스·점수만 돌려주고 MediaPipe 자료형을 내보내지 않음. `detector-keeper.js`: 재생성과 감지기 상태 |
| 관람객 안내 (구현됨, 4-1) | `guidance.js`: 카메라·감지기 상태 → "준비 중"/"직원 문의" 판정. `main.js`가 정하고 `guest-screen.js`가 보인다 |
| 인식 판정 (구현됨) | `presence.js`: 좌표 변환·인정 조건·시간 안정화 순수 함수. `presence-monitor.js`: 감지 루프, "인식됨 / 인식 안됨"과 감지기 상태(`{ health, cause, since }`)만 밖에 알림 |
| 촬영 시작 입력 (구현됨) | 키보드(`main.js`)와 인식 상태(`auto-start.js`)가 `session.request('start' \| 'cancel' \| 'reset')` 한 입구로 요청만 보낸다. 시작할 수 있는지는 상태 기계가 정한다. `auto-start.js`는 "인식됨 / 인식 안됨"(`isPresent`·`subscribe`)만 받는다 |
| 촬영 진행 (구현됨) | `session.js`: 상태 전환, 카운트다운·결과·쿨타임 타이머, 회차 식별자, 취소·강제 초기화, 결과 종료 시계 시작 지점. DOM·카메라를 모르고 시계·타이머·사진 함수를 주입받는다 |
| 이미지 (구현됨) | `capture.js`: 보이는 9:16 영역을 원본 해상도로 잘라 반전 캡처, 사진 효과 단계(`photo-effect.js`, 5-2), JPEG 인코딩, Object URL 생성·정리, 남은 자원 수 |
| 관람객 화면 (구현됨, 6-2) | `main.js`: 무엇을 보일지(안내 규칙, 인식 표시·대기 안내 조건, 쿨타임). `ui/guest-screen.js`: 어떻게 보일지(카운트다운 숫자·원형 진행, 플래시, 결과 출력물 카드·남은 시간, 안내 카드, 인식 빛). 문구는 `config/guest-text.js`. 결과가 끝나면 `<img>`의 `src`를 먼저 지운 뒤 상태 기계가 Object URL을 정리한다(같은 알림 안에서 동기) |
| 사진 효과 (구현됨, 5-1·5-2) | `oil-paint.js`(core): 획 목록·해상도 비례·tick·결과 크기. `oil-renderer.js`: WebGL2 패스. `effect-preview.js`: 카메라 영상 → 효과 캔버스, 장애 시 원본 미리보기, 결과용 같은 그림. `photo-effect.js`: 결과 사진 효과·실패 시 원본. `effect-tuning.js`(ui): `E` 조절 화면. 카메라·감지·촬영 상태는 모르고 `camera.isReady()`와 `<video>`만 받는다 (6절) |

- 감지 모델의 세부 출력(좌표, 신뢰도 등)이 촬영 진행 코드나 화면 전체로 퍼지지 않게 한다. 좌표·점수는 `presence-monitor.js`의 `getDebugSnapshot()`(D 개발용 화면 전용)으로만 꺼낸다.
- 사진 효과는 "캡처 이미지 → 결과 화면" 사이에 끼울 수 있는 경계만 둔다. 범용 플러그인 구조는 만들지 않는다.

### 폴더 규칙 (2026-10-16)

`src/web/`의 모듈은 책임과 의존 방향으로 하위 폴더에 둔다. 깊이는 1단계이고, 파일이 1개뿐인 소스 폴더는 만들지 않는다. 순수한 모듈이라도 책임이 분명히 다른 폴더에 속하면 그 폴더에 둔다(예: `vision/detector-keeper.js`). 분류 이유는 `docs/logs/2026-10-16-01-folder-structure.md`.

| 폴더 | 담는 것 | 불러와도 되는 것 |
|---|---|---|
| (최상위) | `index.html`, `main.js`(화면 조립), `style.css` | 모든 폴더 |
| `config/` | 설정값, 운영자 조절값의 검증·정규화·저장 형식, 조절값 파일 불러오기·저장 | `config` |
| `core/` | DOM·카메라·캔버스·MediaPipe·네트워크에 의존하지 않는 계산·상태 | `core`, `config`의 순수한 파일 |
| `camera/` | 카메라 스트림, 카메라 상태 감시, 캔버스 캡처 | `camera`, `core`, `config` |
| `vision/` | MediaPipe 감지기 생성·재생성, 감지 루프 | `vision`, `core`, `config` |
| `ui/` | DOM 화면 표현: 관람객 화면(6-2)과 운영자용 조절 화면 | `ui`, `core`, `config` |
| `assets/` | 서체·이미지 (JS 없음, 6-2). 다른 프로젝트에서 가져온 파일은 라이선스 파일과 함께 둔다 | — |
| `effect/` | 사진 효과 WebGL 렌더(셰이더·프로그램·텍스처)와 실시간 미리보기 (5-1) | `effect`, `core`, `config` |

- **`core` 규칙(검사함):** `core`의 파일과 거기서 전이적으로 닿는 파일은 `core/`·`config/` 안에 있어야 하고, 브라우저 전역(`document`, `window`, `navigator`, `location`, `localStorage`, `fetch`, `WebSocket`, 캔버스·이미지·미디어 생성자, `requestAnimationFrame` 등)을 쓰지 않는다. 동적 `import()`도 문자열 경로만 허용한다. 타이머·`performance`·`Date`·`console`·`URL`은 Node에도 있어 허용한다. 전역 객체 `globalThis`·`window`·`self`는 대괄호·구조분해·괄호·별칭 등 어느 형태로든 쓰면 위반이다. 예외는 하나뿐이다: 매개변수 기본값 `timers = globalThis`(`core/session.js`의 타이머 주입)는 그 이름을 `setTimeout`·`clearTimeout`·`setInterval`·`clearInterval` 호출로만 쓸 때 허용한다. `test/core-deps.test.mjs`가 검사한다.
  - 검사기는 경계를 지키는 안전장치이고 완전한 JS 파서가 아니다. 파일 안에서 선언된 이름(매개변수, `let`·`const`·`var`, 함수·클래스 이름, 구조분해, `catch`, import)은 전역으로 보지 않는데, 범위를 추적하지 않아 한 파일에 지역 `location`과 전역 `location`이 함께 있으면 전역 쪽을 놓친다. `/`는 직전 토큰으로 정규식·나눗셈을 가르고, 애매하면 나눗셈으로 본다(코드를 건너뛰지 않는 쪽).
- `config/settings-file.js`는 기본 `fetch`가 `globalThis.fetch`라 순수하지 않다. 그래서 `config`는 폴더 전체가 순수하지 않고, `core`에서 부르면 위의 검사가 실패한다.
- 지금 실제 의존: `ui` → `config`·`core`(`guest-screen` → `core/session`의 상태 이름), `camera`·`vision` → `core`, `effect` → `core`·`config`, `config`와 `core`는 바깥 폴더를 부르지 않는다. 같은 폴더 안 의존도 있다(`camera-monitor` → `camera`, `presence-monitor` → `detector-keeper`·`face-detector`, `presence-tuning` → `region-drag`, `settings-file` → `presence-settings`, `auto-start` → `session` → `log-limit`, `effect-preview` → `oil-renderer` → `oil-shaders`). `camera`·`vision`·`ui`·`effect`끼리는 서로 부르지 않고 `main.js`가 잇는다(효과 미리보기는 `camera`의 `isReady`와 `<video>`를 주입받는다).
- 표의 "불러와도 되는 것" 중 자동으로 검사하는 것은 `core` 행뿐이다. 다른 행은 규칙으로 지킨다.
- 저장소 루트의 `config/`(운영자 조절값 파일 `presence.local.json`, Git 제외)와 `src/web/config/`(설정 코드)는 다른 폴더다.
- 테스트는 `test/` 아래 소스와 같은 이름의 폴더에, 주 대상 모듈 위치를 따라 둔다. 테스트 폴더는 소스 위치를 비추므로 1개짜리라도 둔다(`test/camera/`, `test/tools/`).

### 반복 오류 로그 제한 (구현됨, 4-1)

무인 키오스크에서는 같은 오류(카메라 재시도, 감지기 재시도, 촬영 실패)가 하루 종일 반복될 수 있다. 콘솔이 같은 줄로 가득 차지 않도록 `core/log-limit.js`의 `errorLog` 하나로 모은다.

- 분류(`camera`, `detector`, `detection`, `capture` 등)마다 마지막 오류를 기억한다. 숫자만 다른 오류(경과 ms 등)는 같은 오류로 센다.
- 처음 나거나 오류가 바뀌면 바로 남긴다. 같은 오류가 이어지면 세기만 한다. 마지막으로 남긴 뒤 60초(`LOG_SUMMARY_MS`, 가안)가 지나면 `[camera] 같은 오류 20회 더 (마지막 10:01:00): ...` 한 줄을 남긴다.
- 회복하면(카메라 `ready`, 감지기 생성 성공, 감지 성공, 촬영 성공) 감춰진 횟수를 요약하고 기억을 지운다. 다음 오류는 다시 처음부터 남긴다.
- 별도 타이머는 없다. 요약은 다음 오류나 회복 때 남는다. 시각 표시는 `Date`, 간격 계산은 `performance.now()`를 쓴다.
- 브라우저가 직접 찍는 메시지(네트워크 404, CSP 위반)는 이 규칙에 포함되지 않는다.

## 3. 카메라와 영상

### OBS 가상카메라

- 9:16 크롭, 카메라 회전, 색·노출 보정은 OBS에서 처리한다. OBS 출력 해상도는 현장 화면 해상도에 맞춘다(FHD 세로 1080×1920 ~ 4K 세로 2160×3840).
- 캡처 해상도의 상한은 OBS 출력 해상도다. 실제 캡처 크기를 확인해 기록한다.
- 브라우저에서는 장치 라벨(`OBS Virtual Camera` 포함 여부, 대소문자 무시)로 장치를 고르고, 없으면 기본 카메라를 쓴다. 장치 라벨은 카메라 권한이 허용된 뒤에만 읽을 수 있으므로, 라벨이 비어 있으면 권한을 한 번 요청한 뒤 다시 장치 목록을 읽는다(참고 프로젝트 방식). 권한 확인용으로 연 스트림이 고른 장치와 같으면 다시 열지 않고 그대로 쓴다. (구현됨: `camera/camera.js`)
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
- 비율 값은 `config/config.js`의 `aspectRatio`에서 CSS 변수로 넘긴다.
- 개발용 정보는 `D` 키로 토글하며 기본 숨김이다. 관람객 화면에는 노출하지 않는다.
- **사진 효과 미리보기 (5-1):** 효과 캔버스(`#effect`)가 `<video>` 바로 위에서 9:16 영역 전체를 덮는다. 보이는 영역은 `<video>`의 cover 크롭과 같다. 효과를 쓸 수 없으면 캔버스를 숨겨 `<video>`가 그대로 보인다(6절 "사진 효과(유화 · 획)").
- 9:16 영역 밖(가로 모니터의 좌우 등)은 검정으로 두고 꾸미지 않는다. 9:16 영역 바탕은 솔잎 그린(`--pine-deep`)이다(영상이 없을 때 보인다).

### 관람객 화면 (구현됨, 6-2)

사용자 요청(2026-10-19): "기초적인 느낌"을 벗고 크리스마스의 따뜻한 톤으로 깔끔하게. 세부 모양·문구·수치는 모두 가안이다. 디자인 결정의 이유와 상태별 화면 설명은 `docs/logs/2026-10-19-02-stage6-guest-ui.md`.

**전제:** 미리보기와 결과 사진은 앞으로 흰 감열지 위의 검은 점(흑백) 이미지가 된다(6-1). 그래서 글자는 늘 불투명한 종이 카드·원판 위에 두고, 색(크림·딥 레드·골드·솔잎 그린)은 장식과 카드에만 쓴다.

**구성 (DOM 순서 = 위로 쌓이는 순서, `index.html`)**

| 요소 | 내용 |
|---|---|
| `#result-view` | 결과 화면: 제목, 출력물 카드(`#result-card` 안 `#result` 사진), 안내, 남은 시간 막대, 돌아가기 안내. 솔잎 그린 바탕 |
| `#status-veil` | 준비 중·직원 문의 때 영상을 덮는 솔잎 그린 막 (장식 프레임은 그 위에 보인다) |
| `.frame` | 장식 프레임: 가장자리 딥 레드 띠(안쪽 금선, 둥근 모서리), 위 솔가지 가랜드·리본, 아래 가랜드, 인식 빛(`.frame-glow`) |
| `#guide` | 대기 안내 "발자국 위에 서 주세요" (크림 종이 알약, 발자국 아이콘, 천천히 떠오름) |
| `#countdown` | 3·2·1: 딥 레드 원판·크림 숫자(고운바탕), 금빛 원형 진행, 안내 알약 |
| `#notice` | 쿨타임 문구 (솔잎 그린 알약, 별 아이콘) |
| `#flash` | 촬영 순간 따뜻한 흰빛 |
| `#pause-badge` | 운영자 표시 (6-3 범위, 그대로) |
| `#status` | 준비 중·직원 문의 카드 (첫 줄은 제목처럼 크게, 위에 금빛 방울) |

**상태별 화면**

| 상태 | 보이는 것 |
|---|---|
| 대기 | 미리보기 + 장식 프레임 + 아래쪽 대기 안내. 카메라·감지기가 정상일 때만 |
| 인식 | 인식되면 테두리 금선이 굵어지고 안쪽이 따뜻하게 밝아진다(0.6초 전환). 대기·카운트다운·쿨타임 중 인식 상태를 따르고, 결과 화면·안내 문구 중에는 끈다. `config.showPresenceIndicator`가 `false`면 빛을 쓰지 않고 대기 안내만 보인다 |
| 카운트다운 | 원판이 커지며 나타나고, 숫자마다 1초 동안 커지며 나타났다 끝 무렵 작아지며 사라진다. 원형 진행은 `countdownSeconds` 동안 한 바퀴를 채운다. 원판 중심은 9:16 영역 높이의 약 52%(원판 아래 안내 알약까지 묶어 가운데보다 조금 아래). 대기 안내 대신 "화면을 보며 웃어 주세요" |
| 촬영 순간 | 따뜻한 흰빛(`#fff8ec`)이 약 50ms에 투명도 0.7까지 올랐다가 0.32초에 사라진다(예전: 흰색 0.9에서 0.4초) |
| 결과 | 출력물 카드가 위에서 내려와 2° 기울어진 채 놓인다(0.7초). 흰 종이·그림자·금빛 테이프. 제목 "특별한 사진이 완성됐어요", 안내 "출력된 사진을 받아 가세요", 남은 시간 막대(종료 시각까지 줄어듦), "잠시 후 처음 화면으로 돌아가요" |
| 결과 (종료 시계 멈춤) | 지금은 생기지 않는다. 인쇄를 연동해 출력 중 종료 시계를 멈추면(`endsAt` = `null`) 막대를 숨기고 "사진이 출력되고 있어요"를 보인다. 시계가 시작되면 막대가 돈다 |
| 쿨타임 | 대기 안내 자리에 "다음 촬영을 준비하고 있어요" |
| 준비 중·직원 문의 | 솔잎 그린 막 위 크림 카드, 첫 줄 "준비 중입니다."는 고운바탕 딥 레드. 준비 중이면 방울이 흔들리고 직원 문의면 멈춘다. 문구와 30초 전환 규칙은 그대로(확정) |

**규칙**

- **해상도 독립:** 관람객 화면의 길이·글자 크기는 모두 `cqw`(9:16 영역 폭의 1%, `.stage`의 `container-type: inline-size`)로 쓴다. px 상한·하한(`clamp`)을 두지 않아 1080×1920과 2160×3840에서 같은 비율이다(확인: 세 창 크기에서 글자 요소의 위치·크기·글자 크기 비율 차이 0.05% 이하, 로그 2026-10-19-02).
- **움직임은 `transform`·`opacity`만:** 원형 진행은 두 반원을 `rotate`로 돌리고, 남은 시간 막대는 `scaleX`, 인식 빛은 `opacity` 전환이다. 큰 블러·필터 애니메이션은 쓰지 않는다. 그림자 블러는 움직이지 않는 요소에만 둔다. 결과 사진은 `decoding="async"`로 디코딩이 화면 갱신을 막지 않게 한다.
- **문구:** 관람객 문구는 모두 `src/web/config/guest-text.js` 한 곳에 있다. "준비 중"·"직원 문의" 두 문구는 확정이고 확인 도구가 이 글자로 상태를 읽는다. 나머지는 가안이다.
- **서체:** 제목·숫자는 고운바탕 Bold(`Gowun Batang`), 본문은 고운돋움(`Gowun Dodum`). ThrowSnow와 같은 파일이다. KS X 1001 완성형 2,350자 + 영숫자·기호로 줄인 woff(합 약 680KB)라, 문구를 바꿀 때 그 밖의 글자는 시스템 서체로 보인다. 숨겨진 화면에서 처음 쓰여도 바로 보이도록 `index.html`에서 미리 받는다(`<link rel="preload">`).
- **색 (CSS 변수, `style.css` `:root`):** `--cream` `#f3e4d6`·`--pine` `#2f5f52`(ThrowSnow와 같은 값), `--paper` `#fbf7ef`, `--ink` `#3a2418`, `--red-deep` `#9b1c26`, `--gold` `#d9a441`, `--gold-light` `#f6d58a`, `--pine-deep` `#1d3f35`. 종이 결은 `--paper-grain`(`assets/paper.webp`).

**에셋 출처와 라이선스**

| 파일 | 출처 | 라이선스 |
|---|---|---|
| `assets/fonts/GowunBatang-Bold.woff`, `GowunDodum-Regular.woff` | 같은 행사의 다른 웹 체험 ThrowSnow(`003_ThrowSnow`, 커밋 `78175c4`)의 `public/common/assets/fonts/`에서 바이트 그대로 복사. 원본은 Gowun Batang·Gowun Dodum 프로젝트(yangheeryu)이고 ThrowSnow가 부분 집합으로 줄였다 | SIL Open Font License 1.1. `assets/fonts/OFL-GowunBatang.txt`·`OFL-GowunDodum.txt`(같이 복사) |
| `assets/paper.webp` | ThrowSnow `public/common/assets/paper.webp` (그 프로젝트가 만든 종이 결, 256×256 반투명) | 같은 팀 제작물 |
| `assets/garland-*.svg`, `assets/icon-*.svg` | 이 작업에서 만듦(6-2). 솔잎 한 묶음 기호(`<symbol id="tuft">`)를 `<use>`로 배치한 것이라 손으로 고칠 수 있다 | — |

- ThrowSnow 쪽 파일은 읽기만 했다. ThrowSnow가 서체·종이 결을 바꾸면 이 저장소에 다시 복사해야 같은 모양이 된다.
- ThrowSnow의 `fonts.css`·`ribbon.css`는 가져오지 않았다. 서체 선언은 `style.css` 맨 위에 새로 썼고(경로가 다름), 리본 모양은 이 화면(세로 키오스크)에 맞게 SVG로 그렸다.

### 좌우 반전 (확정)

- 미리보기와 캡처 결과 모두 좌우 반전 상태로 만든다.
- 반전은 **웹 한 곳에서만** 처리하고 OBS에서는 반전하지 않는다(가안). 이중 반전을 막고, OBS 설정과 무관하게 같은 결과를 얻기 위해서다.
- 미리보기 반전은 `style.css`의 `.preview.is-mirrored { transform: scaleX(-1) }` 한 곳에서 하고, `config.mirror`로 켜고 끈다(구현됨).
- 미리보기에서 보이는 영역과 캡처 영역(9:16, 잘림 위치)이 일치해야 한다. 캡처 반전은 `camera/capture.js`에서 `config.mirror`를 따라 한다(구현됨, 6절).
- 효과 미리보기(5-1)는 효과 입력을 읽을 때 `config.mirror`로 반전하고, 효과 캔버스에는 CSS 반전을 걸지 않는다. 효과는 반전된 그림에 칠한다(6절). 실제 OBS 영상에서 효과 그림과 반전 영상의 밝기 상관은 0.984, 반전하지 않은 영상과는 0.205였다(로그 02).

### 권한과 보안 컨텍스트

- `getUserMedia()`는 보안 컨텍스트가 필요하다. 같은 PC의 `http://localhost`는 허용된다.
- 영상만 요청하고 마이크는 요청하지 않는다.
- 현장에서는 전용 Chrome 프로필에 `localhost` 카메라 권한을 한 번 허용해 두고 유지한다(참고 프로젝트 방식, 4-2 결정). 다른 방법과 비교한 이유는 1절 "현장 실행 스크립트".

### 카메라 상태와 자동 회복 (구현됨)

현장은 무인·비접촉 키오스크이므로 화면에 버튼을 두지 않고 스스로 회복한다. `camera/camera-monitor.js`가 상태 감시와 재시도를 맡고, `camera/camera.js`는 장치 선택과 스트림 열기·닫기만 맡는다.

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
- **관람객 문구 (확정):** 정상이 아니면 "준비 중입니다. 잠시만 기다려 주세요." 정상이 아닌 상태가 30초 이상 이어지거나, 스스로 풀리기 어려운 상태(`unsupported`, `permission-denied`)면 "준비 중입니다. 직원에게 문의해 주세요." 기술 용어는 쓰지 않는다. 끊기면 영상을 지워 검은 화면 위에 문구를 띄운다. 4-1부터 이 규칙은 감지기 상태와 합쳐 하나로 판정한다(5절 "감지기 상태와 장애 안내").
- **운영자용 상세:** `D` 개발용 정보에 상태, 원인(오류 종류·끊김 원인)과 원본 오류 이름, 시도 횟수와 정상 이후 연속 실패 횟수, 마지막 시도 시각, 정상이 아닌 시간, 권한 상태를 보인다.
- **이후 단계용 경계:** `createCameraMonitor()`가 돌려주는 `isReady()`, `getState()`, `subscribe(listener)`(해제 함수 반환), `getFrameInfo()`만 쓴다. 촬영 진행 코드는 `ready`가 아니면 촬영을 시작하지 않고, 카운트다운 중 `ready`가 아니게 되면 회차를 취소한다. 결과 표시 중이면 사진이 이미 있으므로 결과를 계속 보인다(구현됨, 4절). 얼굴 감지(`presence-monitor.js`)도 같은 인터페이스로 카메라 준비 여부를 받는다(구현됨).
- **새 프레임 정보 (구현됨, 3-3):** `getFrameInfo()`는 `requestVideoFrameCallback`으로 실제 새 프레임을 받은 마지막 시각(`performance.now()` 기준, 없으면 `null`)과 누적 프레임 수(세대)를 돌려준다. 영상 내용은 내보내지 않는다. 끊김 판정용 `lastFrameAt`은 페이지가 숨겨진 동안 현재 시각으로 밀어 두므로 따로 둔다. 캡처는 촬영 직전 이 시각으로 정지 화면을 거르고(6절), 감지 루프는 누적 수로 같은 프레임을 다시 세지 않는다(5절).
- **시간 기준 (3-3):** 경과 시간 계산(`notReadySince`, 프레임 시각)은 `performance.now()`를 쓴다. 시스템 시계가 바뀌어도 흔들리지 않게 하기 위해서다. 사람이 읽는 시각(D 화면의 `lastAttemptAt`, 자동 시작 기록 시각)만 `Date`를 쓴다.

## 4. 촬영 상태

### 촬영 한 사이클 (구현됨, 3-1)

`core/session.js`가 상태 전이와 타이머를, `camera/capture.js`가 캡처와 결과 이미지 자원을, `main.js`가 화면 표시와 입력 연결을 맡는다. `session.js`는 DOM·카메라·캔버스를 모르고, 사진 만들기·정리 함수와 시계·타이머를 주입받는다(Node 테스트 `test/core/session.test.mjs`).

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
| `idle` 대기 | 미리보기, 장식 프레임, 대기 안내, 인식 빛 (3절 "관람객 화면") |
| `countdown` 카운트다운 | 미리보기 위 원판 숫자 3·2·1과 원형 진행, 안내 알약 |
| `capturing` 촬영·결과 준비 | 따뜻한 흰빛 플래시(최대 0.7, 0.32초). 실측 약 30~50ms 뒤 결과로 넘어간다 |
| `result` 결과 표시 | 결과 사진을 출력물 카드로, 안내와 남은 시간 막대. 인식 빛과 카메라 상태 문구는 띄우지 않는다 |
| `cooldown` 쿨타임 | 미리보기로 돌아오고 아래쪽에 "다음 촬영을 준비하고 있어요" (가안, 6-2에서 "다음 촬영을 준비 중입니다."에서 바꿈). 카메라가 준비되지 않았으면 이 문구 대신 카메라 상태 문구 |

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
- **강제 초기화에 쿨타임을 두지 않는 이유:** 쿨타임은 방금 결과를 본 사람이 같은 자리에서 바로 다시 찍히는 것을 막는 장치다. 강제 초기화는 운영자가 꼬인 진행을 풀거나 시험할 때 쓰므로, 누른 즉시 다시 시작할 수 있는 편이 낫다고 봤다. 쿨타임 중에 누르면 남은 쿨타임도 없앤다. 단, 자동 시작은 레벨 판정이라 `X` 직후에도 인식된 사람이 있으면 곧바로 새 회차가 시작된다. **`X`는 촬영을 멈추는 수단이 아니다.** 자동 촬영을 멈추려면 `P`(자동 촬영 일시정지, 4-3)를 누른다.
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
| `E` | 사진 효과 조절 화면 (`Esc`로도 닫음, 5-2). Effect |
| `S` | 수동 촬영 시작 (`session.request('start', 'key')`). Start/Shoot |
| `X` | 강제 초기화 (`session.request('reset', 'key')`) |
| `P` | 자동 촬영 일시정지·다시 켜기 (4-3). Pause |

- `Space`·`Enter`는 쓰지 않는다. `R` 조절 화면의 버튼에 포커스가 있으면 그 버튼을 누르게 되기 때문이다.
- `R`·`E` 조절 화면이 열려 있어도 `S` 수동 시작은 된다. 인식에 의한 자동 시작만 막는다(아래).
- `R`과 `E`는 한 번에 하나만 열린다. 한쪽이 열려 있으면 다른 쪽 키는 무시한다(저장하지 않은 변경이 말없이 취소되지 않게).

**자동 촬영 일시정지 `P` (구현됨, 4-3, 사용자 결정 2026-10-15)**

- 누르면 자동 촬영을 멈추고, 다시 누르면 켠다. 판정은 `decideAutoRequest()`의 `paused` 조건 하나다(아래 표).
- 멈추는 순간 인식으로 시작된 카운트다운이 있으면 취소한다(쿨타임 없이 대기). 사람이 계속 서 있어도 다시 시작하지 않는다.
- `S` 수동 촬영은 일시정지 중에도 된다. 수동 카운트다운 중에 멈춰도 그 회차는 이어진다.
- **저장하지 않는다.** 새로고침·재시작하면 자동 촬영이 다시 켜진다. 무인 현장에서 운영자가 해제를 잊어도 재시작으로 회복되게 하기 위해서다.
- 일시정지 중에는 9:16 영역 오른쪽 위에 작은 운영자 표시 "자동 촬영 일시정지 (P)"를 둔다(가안, `config.showPauseIndicator`로 끈다). D 화면 `auto` 줄 앞에 `PAUSED (P)`가 붙는다.

### 자동 시작과 이탈 취소 (구현됨, 3-2)

`core/auto-start.js`가 인식 상태와 상태 기계를 잇는다. 판정은 순수 함수 `decideAutoRequest()`이고, 연결부 `createAutoStart()`는 계기마다 이 함수를 불러 `session.request(..., 'presence')`를 보낸다(Node 테스트 `test/core/auto-start.test.mjs`). 인식 상태는 "인식됨 / 인식 안됨"만 받고, 좌표·점수는 들어오지 않는다.

**레벨 판정 (사용자 확정 2026-10-15):** 인식 상태가 바뀌는 순간(엣지)이 아니라, 평가할 때의 상태를 보고 정한다. 쿨타임이 끝났을 때 스윗스팟이 비어 있지 않아도 그대로 진행하기로 했으므로, 사람이 계속 서 있으면 쿨타임이 끝나는 즉시 다음 회차가 시작된다.

| 상태 기계 | 조건 | 요청 |
|---|---|---|
| `idle` | 일시정지 아님 + 조절값 불러오기 끝남 + 인식됨 + 카메라 준비 + 페이지 보임 + 조절 화면(`R`·`E`) 닫힘 + 촬영 실패 대기 아님 | `start` |
| `idle` | 하나라도 아님 | 없음. D `auto` 줄에 이유(`blocked: auto paused (P)`·`settings-loading`, `idle, not present`, `blocked: camera-not-ready`·`page-hidden`·`tuning-open`·`capture-failed (retry wait)`). 일시정지·불러오기 중은 사람이 없어도 그 이유를 먼저 보인다 |
| `countdown` (출처 `presence`) | 일시정지 | `cancel` (`auto paused during countdown`) → 쿨타임 없이 대기 |
| `countdown` (출처 `presence`) | 인식 안됨 | `cancel` → 쿨타임 없이 대기 |
| `countdown` (출처 `key`) | 무엇이든 | 없음. 수동 회차는 인식 상태로 취소하지 않는다(사람 없이 시험 촬영) |
| `capturing`·`result`·`cooldown` | 무엇이든 | 없음. 감지는 돌지만 결과를 보지 않는다. 촬영 순간에는 인식과 관계없이 찍는다 |

- **평가 계기:**
  - 인식 상태가 바뀔 때(`presence.subscribe`)
  - 상태 기계가 알릴 때(`session.subscribe`): 대기 진입(쿨타임 종료·취소·초기화), 카메라 준비 변화, 페이지 보임 변화
  - 조절 화면을 닫을 때(`main.js`가 `evaluate('tuning-closed')`, `E`는 `effect-tuning-closed`)
  - 일시정지를 켜고 끌 때(`paused (P)`·`resumed (P)`), 조절값을 다 불러왔을 때(`settings-loaded`) (4-3)
- **카메라 준비·페이지 보임은 상태 기계 스냅숏 값을 쓴다.** 카메라 모듈을 따로 구독하면, 상태 기계가 카메라 준비를 받기 전에 평가해 시작 요청이 무시되고 다시 평가되지 않을 수 있다. 그래서 상태 기계가 먼저 받아 알린 값으로 판정한다.
- **시작은 한 번만:** 시작이 받아들여지면 상태가 `countdown`이 되어 같은 순간의 다른 계기는 요청을 보내지 않는다. 판정과 상태 기계가 같은 값을 보므로 무시되는 시작 요청도 보내지 않는다(테스트로 확인). 요청이 상태 기계 알림을 일으켜 다시 불리면(재진입) 지금 평가를 끝낸 뒤 한 번 더 평가한다.
- **이탈 유예를 따로 두지 않는다.** "인식 안됨"이 되는 데 이미 `absentGraceMs`(기본 1초)가 걸린다. 짧은 누락은 여기서 흡수하고, 설정값을 늘리지 않는다.
- **취소 뒤 반복 없음:** 취소는 "인식 안됨"이 된 순간에 일어나므로, 대기에서 다시 평가해도 인식 안됨이라 시작하지 않는다. 다시 "인식됨"(`presentHoldMs`, 기본 0.5초)이 되어야 새 회차가 시작된다.
- **조절 화면:** 열려 있는 동안 자동 시작을 막는다. 운영자가 범위를 맞추는 중에 촬영이 시작되지 않게 하기 위해서다. 효과 조절 `E`(5-2)도 같은 규칙이다. 효과는 판정에 영향이 없지만, 운영자가 화면 앞에 서서 자기 모습에 입혀진 효과를 보며 맞추므로 자동 회차가 시작되면 카운트다운·결과 사진이 미리보기를 가린다. 결과 사진을 확인하려면 `S`를 누른다. 열기만으로 진행 중인 회차를 취소하지는 않는다(자동 회차는 이탈하면 그대로 취소된다). 닫을 때 사람이 서 있으면 바로 시작될 수 있다.
- **강제 초기화(`X`) 뒤:** 대기로 들어오며 평가하므로, 사람이 서 있으면 바로 자동으로 다시 시작한다. `X`는 촬영 중지 수단이 아니다. 자동 촬영을 멈추려면 `P`를 누른다.
- **조절값 불러오기 (4-3):** 시작할 때 조절값 파일을 다 불러올 때까지(최대 약 3초) 자동 시작을 막는다. 그 사이 감지 루프는 기본값으로 돌지만, 불러온 값을 넣는 순간 기준이 바뀌어 인식 상태를 처음부터 다시 잰다. 그래서 기본값으로 잠깐 인식됐다가 시작되는 일이 없다.
- **D 화면:** `session` 줄에 회차 출처(`by presence`·`by key`), `auto` 줄에 마지막 판정 이유, 마지막 자동 시작·취소 시각과 계기(예: `entered idle (completed)`, `presence: absent`, `tuning-closed`)를 보인다. 계기 기록은 시작이 받아들여진 뒤 남으므로, 시작 직후 한 번은 이전 값이 보이고 다음 갱신(0.5초)에 바뀐다.
- 3-2에서는 관람객 화면을 바꾸지 않았다. 대기 안내와 인식 표시는 6-2에서 다시 디자인했다(3절 "관람객 화면"). "곧 촬영해요" 같은 인식 문구는 두지 않았다. 인식되면 자동 시작이 바로 카운트다운으로 넘어가 문구가 한순간만 보이기 때문이다.

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

- bundle을 동적 `import`로 불러온다. 불러오기나 생성에 실패해도 카메라 미리보기는 계속 동작하고, 실패 사실은 `D` 화면 `detector` 줄에 보인다. 실패하면 아래 "감지기 재생성" 규칙으로 다시 만든다.
- **생성 전 사전 확인 (4-1):** MediaPipe 생성을 시작하기 전에 비용이 적은 확인부터 한다. 확인이 실패하면 로더·wasm·통계 타이머를 아예 만들지 않는다.
  1. WebGL: 1×1 `OffscreenCanvas`에 `webgl2` 컨텍스트를, 없으면 `webgl` 컨텍스트를 만들어 본다. 둘 다 없으면 `webgl-unavailable`("하드웨어 가속 꺼짐 또는 WebGL 없음")이다. 확인용 컨텍스트는 `WEBGL_lose_context`로 바로 놓는다. 렌더러 이름(`WEBGL_debug_renderer_info`)은 D 화면에 보이고, SwiftShader·Basic Render Driver 같은 소프트웨어 렌더러는 `(software)`로 표시한다. 소프트웨어 렌더러는 감지가 되므로 **장애로 보지 않고**, 감지기를 만들 때 콘솔 경고 1줄(`[webgl] software WebGL renderer: ...`, 반복 오류 로그 제한 적용)만 남긴다. 현장 실행 스크립트가 시작할 때 하드웨어 가속을 다시 켜기 때문이다(사용자 결정 2026-10-15).
  2. 모델: `modelPath`를 받아 HTTP 상태(실패하면 `model-unavailable`), 크기 `modelBytes`, SHA-256 `modelSha256`(다르면 `model-invalid`)을 확인한다. 기준값은 `config.faceDetection`에 있고 `tools/vendor-mediapipe.mjs`의 기록과 같아야 한다(`test/vision/face-detector.test.mjs`가 실제 파일과 대조한다). 통과한 바이트는 기억해 두고 다음 생성 때 다시 받지 않는다.
  - 확인한 바이트를 `baseOptions.modelAssetBuffer`(복사본)로 넘긴다. 그래서 생성 중에 모델 받기가 실패할 수 없다.
- **실패한 생성의 정리 (4-1):** 사전 확인을 통과하고도 MediaPipe 생성이 실패할 수 있다(아래 "MediaPipe 1.1.1 생성 실패 누적"). 그래서 delegate 시도마다 다음을 한다.
  - MediaPipe가 쓸 WebGL 캔버스(1×1 `OffscreenCanvas`)를 직접 만들어 `canvas` 옵션으로 넘긴다. 라이브러리 기본값과 같은 종류다. 실패하면 그 캔버스의 컨텍스트를 놓는다.
  - 생성하는 동안만 `setInterval`을 감싸, 그 시도가 만든 통계 타이머를 기록했다가 실패하면 지운다. 생성이 끝나면 원래 함수로 되돌린다.
  - 실행이 끝난 wasm 로더 `<script>`(`fileset.wasmLoaderPath`) 요소를 성공·실패와 관계없이 지운다.
  - **소유자 구분 (4단계 검수 6):** 정리는 그 시도가 만든 자원으로 한정한다.
    - 타이머는 진행 중인 시도가 하나뿐일 때, 라이브러리 번들이 **직접** 부른(호출 스택에서 바로 위 프레임이 번들 파일 `vision_bundle.mjs`) 60초 간격만 그 시도의 것으로 기록한다. 같은 시간에 다른 코드가 만든 60초 타이머는 지우지 않는다.
    - 로더 요소는 첫 시도가 시작될 때 이미 있던 같은 URL의 요소를 기억해 두고 건드리지 않는다.
    - 시도가 겹치면(앱은 `detector-keeper`가 하나씩만 만든다) 감싼 `setInterval`은 하나만 두고 마지막 시도가 끝날 때 되돌린다. 로더 요소도 모두 끝난 뒤에만 지운다(불러오는 중인 로더를 지우면 그 시도가 멈춘다). 겹친 동안 생긴 타이머는 누구 것인지 몰라 지우지 않는다.
    - 확인: Node 테스트(가짜 번들은 `test/fixtures/`의 별도 파일)와 확인 도구의 실제 MediaPipe 시나리오. 판별을 끄면 실제 브라우저에서 60초 타이머가 1→7로 늘어 시나리오가 실패했다.
  - 실패 원인은 오류의 `code`(`DetectorFault`)로 붙인다: `bundle-load-failed`, `model-unavailable`, `model-invalid`, `webgl-unavailable`, `create-failed`. 실행 중 원인은 `webgl-context-lost`, `detect-failing`이다.
- Chrome은 실패한 동적 `import()` 결과를 기억해, 원인이 없어져도 같은 URL로는 다시 받지 않는다(2단계 검수 수정 중 확인). 그래서 불러오기에 실패한 적이 있으면 다음 시도에 `?retry=N`을 붙여 새로 받는다. 한 번 성공한 bundle 모듈은 감지기를 다시 만들 때도 그대로 쓴다.
- `config.faceDetection.delegates` 순서(`GPU` → `CPU`)로 생성을 시도한다. 앞선 delegate가 실패한 이유는 `D` 화면 `delegate` 줄에 보인다.
- 감지기 자체의 `minDetectionConfidence`(`detectorMinConfidence` 0.3)는 낮게 둔다. 신뢰도는 판정 쪽 `presence.minScore`로 거른다. 2-3에서 감지기를 다시 만들지 않고 실시간으로 조절하기 위해서다.
- 결과: `{ x, y, width, height, score }[]`. 감지 입력(영상 프레임 전체를 축소한 캔버스) 기준 0~1 정규화, 왼쪽 위 원점, 반전 전.
- WebGL을 전혀 쓸 수 없으면 CPU delegate도 생성은 되지만 매 프레임 감지에 실패한다(MediaPipe가 입력을 WebGL 텍스처로 올리기 때문, `ImageData` 입력도 같음). 4-1부터는 사전 확인에서 `webgl-unavailable` 장애로 멈추고 생성하지 않는다.
- **실행 중 WebGL 컨텍스트 손실 (4-1):** 넘긴 캔버스에서 `webglcontextlost`를 받으면, 감지 실패 15회를 기다리지 않고 바로 감지기를 버린다(`webgl-context-lost`). 재생성은 재시도 간격을 따른다. 닫은 감지기에서는 알리지 않는다. 감지기를 닫을 때도 그 컨텍스트를 놓는다.
- **Chrome 플래그 관찰 (4-1, Chrome 155, 개발 PC):**
  - `--disable-gpu`만으로는 WebGL이 꺼지지 않았다. 소프트웨어 렌더러(`Microsoft Basic Render Driver`)로 감지가 계속 동작했다.
  - `--disable-webgl`은 `<canvas>` 요소의 WebGL만 끄고, MediaPipe가 쓰는 `OffscreenCanvas`의 WebGL은 끄지 못했다.
  - WebGL이 완전히 없어진 경우는 `--disable-gpu --disable-software-rasterizer`와 `--use-gl=disabled`였다.

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
- 시계·타이머·document를 주입할 수 있다(`timers`, `now`, `doc`). 기본은 전역 타이머, `performance.now()`, `document`이고, Node 테스트(`test/vision/presence-monitor.test.mjs`)에서 실제 감지 루프를 돌리는 데 쓴다.
- 4K 영상을 그대로 넣지 않는다. 긴 변을 `inputMaxSize`(640px) 이하로 줄인 캔버스에 그려 감지한다(OBS 1080×1920 → 360×640).
- 호출 간격은 `1000 / maxFps`에서 처리 시간을 뺀 값이다. `detectForVideo` 타임스탬프는 `max(performance.now(), 직전 + 1)`로 항상 증가시킨다.
- 감지가 실패한 프레임은 "없음"으로 판정한다. 15번 연속 실패하면(약 1초) 감지기를 버리고 다시 만든다(아래, `detect-failing`). 콘솔 경고는 반복 오류 로그 제한(2절)을 따른다. 감지가 성공하면 재시도 간격을 처음으로 돌린다.
- 상태(`DetectorStatus`): `loading`(생성 중), `running`, `paused`(카메라 미준비·페이지 숨김), `error`(감지기 없음: 생성 실패 또는 계속 실패해 버림, 재생성을 기다리는 중). 인식 알림은 감지 한 번(`tick`) 안에서 나가므로, 알림을 받은 쪽이 그 안에서 상태를 읽어도 `running`으로 보이게 한다(3-2에서 발견: 이탈 취소가 D 화면을 다시 그릴 때 `paused`·0fps로 잘못 보였다).

**감지기 재생성 (`detector-keeper.js`, 2단계 검수 반영, 4-1 간격 늘림)**

- 생성에 실패하면 다시 만든다. 간격은 `faceDetection.detectorRetryMs`(15초)에서 시작해 연속 실패마다 두 배로 늘고, 최대 `detectorRetryMaxMs`(300초)다: 15·30·60·120·240·300·300…초 (가안). 생성은 메인 스레드를 약 1초 막으므로 간격을 너무 짧게 두지 않는다.
- 연속 실패 수는 생성 실패와 버림을 함께 센다. 생성에 성공해도 0으로 돌리지 않고, 그 감지기로 감지가 한 번 성공해야(`markHealthy`) 0이 된다. 만들자마자 컨텍스트를 잃는 일이 반복될 때도 간격이 늘어나게 하기 위해서다.
- 감지가 15번 연속 실패하거나 WebGL 컨텍스트를 잃으면, 감지기를 `close()`로 닫고 버린 뒤 재시도 간격 뒤 새로 만든다. `close()`가 실패해도 버린다.
- **바로 다시 만드는 계기:** 감지기가 없을 때 카메라가 다시 준비되거나(한 번 준비된 적이 있는 카메라의 재연결. 처음 준비되는 것은 계기가 아니다) 페이지가 다시 보이면, 간격을 기다리지 않고 바로 만든다. 예약된 재시도는 지운다. **장애(`fault`) 상태에서는 앞당기지 않는다** (4-1). 카메라가 자주 끊겨도 생성이 몰리지 않게 하기 위해서다.
- 생성은 한 번에 하나만 진행한다. 생성 중에 다시 요청하면 진행 중인 생성을 기다린다.
- 재생성과 관계없이 감지기가 없는 동안 인식 상태는 **인식 안됨**이고, 카메라 미리보기는 그대로 동작한다.
- `D` 화면: 아래 "감지기 상태와 장애 안내".
- 검증: 번들 차단 → 해제 후 재시도 간격 뒤 회복, 번들 차단 → 해제 + 카메라 트랙 종료 후 즉시 회복, WebGL 없음 흉내 → 감지기 폐기 → WebGL 복구 흉내 후 재생성으로 회복(로그 06 "2단계 단위 검수"). 4-1 검증은 로그 10.

**감지기 상태와 장애 안내 (구현됨, 4-1)**

인식 상태(`present`)와 별도로 감지기 자체의 상태를 알린다. "사람 없음"과 "감지기를 쓸 수 없음"을 구분하기 위해서다.

| 상태 (`DetectorHealth`) | 뜻 |
|---|---|
| `starting` | 아직 실패한 적 없이 만드는 중 (앱 시작 직후) |
| `ok` | 감지기가 있다 (감지 중이거나, 카메라 미준비·페이지 숨김으로 쉬는 중) |
| `retrying` | 실패했고 다시 만들기를 기다리거나 만드는 중 |
| `fault` | 장애. 스스로 풀리기 어려운 원인(`webgl-unavailable`, `model-invalid`)이면 첫 실패부터, 그 밖의 원인은 연속 실패 `detectorFaultAfterFailures`(3회, 가안)부터. 재시도는 간격대로 계속한다 |

- **경계:** `createPresenceMonitor()`의 `getDetectorHealth()`와 `subscribeDetector(listener)`는 `{ health, cause, since }`만 준다. `subscribeDetector`는 등록 즉시 한 번, 그 뒤로는 상태나 원인이 바뀔 때마다 부른다. `since`는 감지기가 없게 된 시각(`performance.now()` 기준, 감지기가 있으면 `null`)이다. 좌표·점수는 여전히 `getDebugSnapshot()`(D 전용)으로만 꺼낸다.
- **관람객 안내 (`guidance.js`):** 카메라 상태와 감지기 상태를 하나의 규칙으로 판정한다.
  - 둘 다 정상(카메라 `ready`, 감지기 `ok`)이면 문구가 없다.
  - 하나라도 쓸 수 없으면 "준비 중입니다. 잠시만 기다려 주세요."를 보인다.
  - 쓸 수 없는 상태가 `cameraRecovery.staffNoticeMs`(30초) 이상 이어지거나, 스스로 풀리기 어려운 상태(카메라 `unsupported`·`permission-denied`, 감지기 `fault`)면 "준비 중입니다. 직원에게 문의해 주세요."로 바꾼다.
  - 이어진 시간은 둘 중 하나라도 쓸 수 없게 된 때부터 잰다. 카메라가 돌아왔는데 감지기가 아직 없으면, 처음부터 다시 재지 않고 이어서 잰다. 둘 다 정상이 되면 처음으로 돌아간다.
  - 감지기를 쓸 수 없으면 인식 표시(테두리 빛)와 대기 안내를 숨긴다(6-2 전에는 "인식됨/인식 안됨" 임시 표시). 쿨타임 문구도 안내 문구가 없을 때만 보인다.
- **`S` 수동 촬영은 감지기 장애 중에도 된다.** 상태 기계는 카메라 준비만 본다. 회차가 진행되는 동안(카운트다운·촬영·결과)은 안내 문구를 숨기고, 대기로 돌아오면 다시 보인다. 카메라가 끊기면 카운트다운은 바로 취소되므로, 이때 숨는 것은 감지기 쪽 안내뿐이다.
- **`D` 화면:**
  - `detector : <루프 상태>, health <상태> / <원인> (<원인 설명>)`
  - 정상이 아니면 두 줄을 더한다. `failure`(실패 메시지)와 `retry`(연속 실패 수, 생성 시도 수, 다음 재시도까지 남은 시간 또는 `creating now`, 쓸 수 없던 시간)다.
  - `webgl`(버전·렌더러·소프트웨어 여부), `model`(크기, `sha256 ok`), `guidance`(안내 상태와 이어진 시간)
  - 원인 설명의 예: `webgl-unavailable` → "하드웨어 가속 꺼짐 또는 WebGL 없음", `model-invalid` → "모델 파일 손상 (크기·SHA-256 불일치)". 관람객 화면에는 기술 용어를 보이지 않는다.
- 인식 범위 조절(`R`) 패널의 감지기 표시는 루프 상태(`loading`·`running`·`paused`·`error`)를 그대로 쓴다.

**이후 단계용 경계**

- `createPresenceMonitor()`가 돌려주는 `isPresent()`와 `subscribe(listener)`만 쓴다. `listener`는 등록 즉시 한 번, 그 뒤로는 인식 상태가 바뀔 때만 `{ present }`로 호출된다. 해제 함수를 돌려준다.
- 좌표·점수·감지 시간은 `getDebugSnapshot()`으로만 꺼내며 `D` 개발용 화면에서만 쓴다. 촬영 진행 코드는 쓰지 않는다.
- 촬영 진행과의 연결(구현됨, 3-2): `auto-start.js`가 `isPresent()`·`subscribe()`만으로 자동 시작·이탈 취소를 정한다. 시작은 인식 상태가 바뀌는 순간이 아니라 그때의 상태를 보는 레벨 판정이다(4절 "자동 시작과 이탈 취소").

**화면**

- 인식 표시 (6-2): 인식되면 9:16 영역 테두리가 따뜻하게 밝아진다(`#stage.is-present`). 카메라·감지기를 쓸 수 없거나 결과 화면이면 끈다. `config.showPresenceIndicator`로 끈다. 2-2~5단계의 "인식됨"(초록)·"인식 안됨" 글자 표시는 없앴다(3절 "관람객 화면").
- `D` 화면에 추가된 정보: 감지기 상태와 오류, delegate(실패한 delegate 이유), 감지 시간(마지막·평균)과 그리기 시간, 실제 감지 빈도, 감지 입력 크기, 감지된 얼굴 수와 인정된 얼굴 수, 판정과 안정화 진행(`-> present 343/500ms`), 현재 기준값(조절 화면에서 바꾼 값 포함), 기준값 출처(`settings : file`·`migrated`·`localStorage`·`defaults (이유)`·`saved`·`loading`, 저장하지 않은 변경이 있으면 `+ unsaved changes`, 4-3. 아래 "반영과 저장")와 저장 전까지는 불러올 때 고친 내용, 얼굴별 점수·높이·중심과 제외 이유(`region`·`small`·`large`·`score`), 감지 오류 횟수.
- `D` 화면을 켜면 9:16 영역 위에 인식 영역(노란 점선)과 감지 박스를 겹쳐 그린다. 인정된 얼굴은 초록, 제외된 얼굴은 빨강이며, 박스 위에 점수, 중심에 점을 찍는다.

**설정값 (`config.js`, 가안)**

| 값 | 기본값 | 뜻 |
|---|---|---|
| `faceDetection.delegates` | `['GPU', 'CPU']` | 시도 순서 |
| `faceDetection.detectorMinConfidence` | 0.3 | 감지기 자체 기준 (낮게) |
| `faceDetection.maxFps` | 15 | 감지 최대 빈도 |
| `faceDetection.inputMaxSize` | 640 | 감지 입력 캔버스 긴 변 최대 px |
| `faceDetection.modelBytes` | 229746 | 모델 사전 확인: 크기 (4-1) |
| `faceDetection.modelSha256` | `b4578f35…0152f` | 모델 사전 확인: SHA-256 (4-1, 전체 값은 아래 "MediaPipe 로컬 라이브러리") |
| `faceDetection.detectorRetryMs` | 15000 | 감지기 생성 실패·폐기 후 첫 재시도 간격. 연속 실패마다 두 배 (4-1) |
| `faceDetection.detectorRetryMaxMs` | 300000 | 재시도 간격 상한 (4-1) |
| `faceDetection.detectorFaultAfterFailures` | 3 | 이 횟수만큼 연속 실패하면 장애 (4-1) |
| `presence.region` | `{ x: 0.1, y: 0.1, width: 0.8, height: 0.8 }` | 인식 영역 (화면 좌표, 가운데 넓은 사각형) |
| `presence.minFaceHeight` | 0.05 | 최소 얼굴 높이 / 9:16 영역 높이 |
| `presence.maxFaceHeight` | 0.6 | 최대 얼굴 높이 / 9:16 영역 높이 (2-3 추가) |
| `presence.minScore` | 0.7 | 최소 신뢰도 (2-3에서 0.6 → 0.7. 실제 얼굴 0.85~0.95, 가짜 카메라 오검출 최고 0.663) |
| `presence.presentHoldMs` | 500 | 인식됨까지 "있음" 유지 시간 |
| `presence.absentGraceMs` | 1000 | 인식 안됨까지 "없음" 유지 시간 |
| `showPresenceIndicator` | `true` | 인식 상태 임시 표시 |
| `showPauseIndicator` | `true` | 자동 촬영 일시정지(P) 운영자 표시 (4-3, 가안) |
| `settingsFile.url` | `/local-api/presence-settings` | 조절값 파일 API (4-3) |
| `settingsFile.timeoutMs` | 3000 | 조절값 파일 읽기·쓰기 제한 시간. 시작할 때 넘기면 기본값 (4-3, 가안) |

위 `presence.*` 값은 **기본값**이다. 운영자가 조절 화면(아래)에서 저장한 값이 있으면 그 값을 쓴다. 판정은 매 프레임 현재 설정 객체를 읽으므로, 감지기를 다시 만들지 않고 다음 감지부터 반영된다.

**테스트:** `npm test`(`node --test "test/**/*.test.mjs"`, glob 인자 때문에 Node 22 이상, 의존성 없음).

- `test/core/presence.test.mjs`: 좌표 변환(반전, 가로 영상·9:16·세로로 긴 영상의 cover 크롭), 영역 경계·최소/최대 크기·신뢰도, 안정화(유지 시간 경계, 깜빡임, 짧은 끊김, 시간값 0)
- `test/config/presence-settings.test.mjs`: 설정 검증(아래)과 영역 이동·크기 조절 계산
- `test/ui/region-drag.test.mjs`: 끌기 종료 조건(놓기, `blur`, `lostpointercapture`, 버튼 떼어짐)과 리스너 해제
- `test/vision/detector-keeper.test.mjs`: 생성 실패 → 원인 제거 → 재생성, 생성 중 중복 시작 1회, 폐기 후 재생성, 재시도 간격(15·30·60·120·240·300·300초), 상태 전이, 영구 원인, 버림과 `markHealthy`
- `test/vision/face-detector.test.mjs`: 모델 사전 확인(404·네트워크 오류·크기·SHA-256), WebGL 확인, 사전 확인 실패 시 생성 미시작, 생성 5회 실패 뒤 타이머·로더 스크립트·GL 컨텍스트 0, GPU 실패 → CPU 성공, 컨텍스트 손실 알림, config와 실제 모델 파일 대조
- `test/vision/presence-monitor.test.mjs`(4-1 추가): 감지기 상태 알림 전이, 장애 중 재시도 앞당김 금지, 컨텍스트 손실 즉시 버림 → 재생성
- `test/core/guidance.test.mjs`, `test/core/log-limit.test.mjs`: 안내 규칙(카메라·감지기 조합, 30초 전환, 이어 재기), 로그 제한

감지 루프와 화면은 브라우저 하네스로 확인한다(로그 05·06).

### 인식 범위 조절 (구현됨, 2-3)

운영자용 숨김 화면이다. 관람객용이 아니며, 현장 PC에 마우스와 키보드를 연결해 조작한다고 가정한다.

**열고 닫기**

- `R` 키로 열고 닫는다. 열려 있으면 `Esc`로도 닫는다. `D`(개발용 정보)와는 따로 켜고 끈다. 키 정의는 `main.js`의 `Keys`에 있다.
- 열면 다음이 보인다.
  - 조절 패널(화면 아래, "패널 위·아래" 버튼으로 위로 옮길 수 있음)
  - 9:16 영역 위의 편집 사각형
  - 감지 박스(인정 초록, 제외 빨강)와 얼굴 크기 가이드(영역 가운데에 최소 파랑, 최대 보라 정사각형)
- 닫으면 패널·편집 사각형·겹쳐 그리기가 모두 숨겨진다. `D`가 켜져 있으면 `D` 정보와 그 겹쳐 그리기만 남는다. 둘 다 꺼져 있으면 관람객 화면에 흔적이 없다. 인식 표시(`showPresenceIndicator`, 테두리 빛)와 대기 안내는 조절 화면과 무관하게 원래대로 보인다.

**조절 항목과 범위** (`config/presence-settings.js`의 `presenceLimits`)

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
- **저장**을 눌러야 조절값 파일(`config/presence.local.json`, 1절 "조절값 파일 API")에 기록한다 (4-3. 2-3~4-2는 `localStorage`).
  - 값: `{ "version": 1, "settings": { "region": {...}, "minFaceHeight", "maxFaceHeight", "minScore", "presentHoldMs", "absentGraceMs" } }` (2칸 들여쓴 JSON. 메모장으로 열어 볼 수 있다)
  - 저장 중에는 버튼을 막고 "저장 중..."을 보인다. 서버가 204로 답해야 저장된 값으로 인정한다.
  - **저장 중에 닫으면(`R`·`Esc`·닫기) 저장이 끝난 뒤 닫는다** (4단계 검수 4). "저장 중입니다. 저장이 끝나면 닫습니다."를 보이고, 응답(최대 3초)을 받은 뒤 닫으면서 마지막으로 파일에 저장된 값으로 맞춘다. 성공하면 저장한 값, 실패하면 이전 파일 값이다. 그래서 실행 중인 판정값과 파일 값이 늘 같다. 닫기를 아예 막으면 운영자가 키를 다시 눌러야 하므로 미루는 쪽을 골랐다.
  - 실패하면(서버 없음·거절·시간 초과 3초) 패널에 "저장하지 못했습니다: HTTP 500 (...)" 같은 이유를 보이고 **저장되지 않은 상태를 유지**한다. 닫으면 마지막으로 저장된 값으로 돌아간다.
  - 저장 중에 슬라이더를 더 움직였으면, 누른 순간의 값만 저장하고 그 뒤 변경은 저장하지 않은 변경으로 남긴다.
- **취소 (저장된 값으로)**: 마지막 저장값(없으면 기본값)으로 되돌린다.
- **기본값으로**: `config.presence` 기본값을 적용한다. 저장하지 않으면 유지되지 않는다.
- **저장하지 않고 닫으면 저장된 값으로 되돌린다.**
  - 이유: 실행 중인 판정값과 다시 시작(새로고침·재부팅)했을 때의 값이 항상 같아야 한다. 저장하지 않은 값이 무인 운영 중에 남아 있다가 재시작 때 말없이 바뀌는 일을 막는다.
  - 현장은 확인 창을 띄우지 않는 키오스크이므로 묻지 않는다. 대신 패널에 "저장하지 않은 변경이 있습니다 (닫으면 취소됩니다)"를 늘 보인다.
- **현재값 JSON (복사용)**: 현재 조절값을 저장 형식 그대로 보이고 "복사" 버튼으로 클립보드에 넣는다(실패하면 선택만 한다). 불러오기 기능은 없다.

**시작할 때 불러오는 순서 (4-3, `settings-file.js` `loadInitialPresenceSettings`)**

| 순서 | 상황 | 쓰는 값 | D `settings` |
|---|---|---|---|
| 1 | 파일 `GET` 200 | 파일 값 (아래 검증) | `file` (형식이 잘못됐으면 기본값, `defaults (file is invalid)`. 파일은 운영자가 다시 저장할 때까지 그대로) |
| 2 | 파일 404 + `localStorage`(`photobooth.presence.v1`)에 쓸 수 있는 값 | 그 값을 파일로 옮긴다(`PUT` → 다시 `GET`해 같은지 확인) → 확인되면 `localStorage` 키를 지운다 | `migrated (from localStorage (removed))` |
| 2-1 | 옮기기 실패 | 이번 실행은 `localStorage` 값. 지우지 않으므로 다음 시작에 다시 옮긴다 | `localStorage (migration to file failed: ...)` |
| 3 | 파일 404 + `localStorage` 없음·깨짐 | 기본값 (파일을 만들지 않는다) | `defaults (no file)` |
| — | 파일 읽기 실패(서버 오류·연결 실패)·시간 초과(`config.settingsFile.timeoutMs` 3초, 가안. 응답 헤더 뒤 본문이 멈춰도 같은 제한 시간 안에 끝난다, 4단계 검수 3) | 기본값. 파일이 있는데 못 읽었을 수 있으므로 옮기지 않는다 | `defaults (file read failed: timeout 3000ms)` 등. 콘솔 경고 1줄, 조절 화면을 열면 패널에도 |

- 불러오기가 끝날 때까지 `R`은 열리지 않고, D `settings` 줄은 `loading`, 자동 시작은 `blocked: settings-loading`이다.
- **`localStorage`를 옮긴 뒤 지우는 이유:** 파일이 생긴 뒤에는 `localStorage`를 읽지 않는다. 남겨 두면, 운영자가 초기화하려고 파일을 지웠을 때 옛 값이 말없이 다시 옮겨진다. 다시 읽어 파일 내용을 확인한 뒤에만 지우므로 값을 잃지 않는다. 앱은 `localStorage`에 더 쓰지 않는다.
- 브라우저 프로필과 무관하므로, 키오스크 전용 프로필(4-2)이든 개발용 임시 프로필이든 같은 값을 쓴다. 다른 PC의 브라우저에 남아 있던 `localStorage`는 그 PC에서 처음 시작할 때만 옮겨진다.

**불러오기 검증** (`parseStoredPresenceSettings`, `normalizePresenceSettings`)

파일(또는 옮길 `localStorage`) 값을 읽어 검사한다. 어떤 값이 들어 있어도 예외를 던지지 않고 앱은 계속 동작한다.

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
- 고친 내용은 콘솔 경고와 `D` 화면 `settings` 줄에 보인다. 조절 화면을 열면 패널에도 한 번 보인다. 파일의 값은 운영자가 다시 저장하기 전까지 그대로 둔다.

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
- 사진 효과 미리보기를 켠 상태 (5-1, 실제 OBS 1080×1920, 효과 540×960·24fps. 5-2부터 기본은 1080×1920이고 1배 측정값도 6절에 있다): 감지 15fps·3.8ms, rAF 60fps(25ms 넘는 간격 0), 긴 작업 0. 메인 스레드 사용률은 효과 끔 12.4% → 30% 안팎. 상세는 6절 "사진 효과(유화 · 획)"의 성능.
- 장시간 실측 (4-4, **10분**, 개발 PC, 실제 OBS 1080×1920, 20초마다 `S`): 완료 30회, 사진 `taken = released`, 카메라·감지기 정상 유지, 15fps, 예외 0. 리스너·문서 수는 평평했고, JS 힙 4.0~5.5MB, Chrome 커밋 메모리 합 663→684MB(1분 이후)였다. 10분은 누수 판단에 짧다(로그 13). 더 길게는 `npm run check:browser -- --soak 60 --camera real`.

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

기본 사용 형태 (앱에서는 `vision/face-detector.js`가 이렇게 부르고, 경로는 `config.faceDetection`에 있다):

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

**MediaPipe 1.1.1 생성 실패 누적 (4-1에서 대응, 버전을 올리면 다시 확인):** 번들 코드(`createFromOptions` → 내부 `createTaskRunner`)를 읽고 브라우저에서 잰 결과다.

- 생성할 때마다 wasm 로더 JS를 `<script>`로 `body`에 붙이고 지우지 않는다. 로더가 만든 전역 `ModuleFactory`를 라이브러리가 바로 지우므로, 같은 로더·wasm 인스턴스를 다음 생성에 다시 쓸 공개 방법이 없다. `FilesetResolver`는 경로만 돌려주므로, 한 번만 불러와도 줄지 않는다.
- 사용 통계 로거(60초 `setInterval`)를 모델 설정(`setOptions`: 모델 받기·그래프 시작) **전에** 만들고, 그 뒤 실패하면 닫지 않는다. `createFromOptions`가 클래스를 고정해 부르므로, 실패한 인스턴스를 받아 `close()`할 수도 없다.
- 수정 전 측정(실패 1회는 GPU·CPU 두 번 시도):
  - 모델 404·손상 모델: 15초마다 60초 타이머 +2, `<script>` +2
  - WebGL 없음: 15초마다 GPU 실패분 타이머 +1, `<script>` +2. 콘솔 경고 56건/64초
- 대응은 위 "생성 전 사전 확인"과 "실패한 생성의 정리"다. 수정 후 같은 조건에서 증가는 0이었다(로그 10). 성공한 감지기의 통계 타이머는 `close()` 때 라이브러리가 지운다.

**사용 통계 전송 (CSP로 차단, 구현됨):** `tasks-vision` 1.0.0부터 번들에 사용 통계 로거가 들어 있다(0.10.35 이하에는 없음). 태스크를 만들면 항상 켜지며 끄는 옵션이 없다. 번들 코드상 태스크 종류·실행 모드·OS 종류·라이브러리 버전·처리 횟수와 시간 통계를 모으며(이미지·감지 좌표를 넣는 코드는 보지 못했다. 실제 전송 내용을 해독해 확인하지는 않았다) 생성 후 60초마다, 그리고 `close()` 때 `fetch`로 `https://odml.pa.googleapis.com/v1/log`에 POST한다. 전송이 한 번 실패하면 그 인스턴스의 로거는 멈춘다. 현장이 오프라인이면 실패로 끝나지만, 인터넷이 연결된 PC에서는 실제로 전송된다. 그래서 `index.html`의 CSP(`connect-src 'self'`, 1절 "외부 전송 차단: CSP")로 브라우저가 보내기 전에 막는다(사용자 결정, 2026-10-15). 앱에서 외부 요청 0건을 확인했다(로그 05). 버전을 올릴 때는 다른 외부 연결이 생겼는지 다시 확인한다.

## 6. 사진 처리

- 캡처 이미지는 현재 회차의 결과 표시용으로만 메모리에 둔다.
- 대기 복귀·회차 종료 시 이미지 참조와 관련 자원(Object URL 등)을 정리한다.

### 캡처와 결과 이미지 (구현됨, 3-1)

`camera/capture.js`의 `createCapture().take()`가 다음 순서로 만든다.

0. **확인 (3-3):** 이전 회차의 효과·인코딩이 끝나지 않았으면 `capture busy`, 마지막 새 카메라 프레임이 `config.capture.maxFrameAgeMs`(500ms, 가안)보다 오래됐으면 `stale frame`으로 캔버스를 만들기 전에 실패한다. 500ms는 30fps 프레임 간격(약 33ms)보다 충분히 길고, 끊김 판정(3초)보다 짧다.
1. **프레임 잡기 (동기):** 미리보기와 같은 `object-fit: cover` 계산(`presence.js`의 `computeCoverMapping`)으로 영상에서 보이는 9:16 영역을 픽셀 단위로 구한다(`computeCaptureCrop`). 그 크기 그대로의 캔버스에 좌우 반전(`translate` + `scale(-1, 1)`, 미리보기의 `scaleX(-1)`과 같음)으로 그린다. 축소·확대하지 않으므로 OBS 1080×1920이면 1080×1920, 2160×3840이면 2160×3840이다. 가로 영상이면 가운데를 잘라 높이를 유지한다(예: 1920×1080 → 608×1080). 캔버스를 만든 직후부터 크기 지정·`getContext`(null 포함)·`drawImage` 중 어디서 실패해도 그 캔버스를 비우고 실패한다(3-3).
2. **사진 효과 (5-2):** `effect(canvas, { signal })` 한 함수 경계에 `photo-effect.js`의 `apply`를 넣었다(기본값 `applyPhotoEffect`는 그대로 통과). 셔터 순간 화면의 미리보기 그림과 같은 그림을 결과 크기(짧은 변 1080)로 새 캔버스에 그린다. 실패하면 원본 사진을 결과 크기로 줄여 대신한다(아래 "사진 효과(유화 · 획)"의 "결과 사진"). 새 캔버스를 돌려줘도 캡처 쪽이 둘 다 정리한다. `signal`은 회차별 취소 신호다(4절 "실패와 취소 경계").
3. **인코딩:** `canvas.toBlob()`으로 `config.capture`(가안: `image/jpeg`, 품질 0.92). 인쇄 연동 때 넘길 형태를 미리 둔 것이다. 1080×1920 실측은 효과 없는 사진 약 130~150KB, 16~31ms, 효과 사진 약 316KB, 35~50ms(5-2, 실제 OBS).
4. **정리:** 성공·실패·취소 모두 캔버스 크기를 0으로 만들어 픽셀 버퍼를 바로 놓는다. `toBlob`은 호출할 때 픽셀을 복사하므로 인코딩 중에 비워도 된다. 결과는 `URL.createObjectURL(blob)`로만 들고, `release(photo)`가 `revokeObjectURL`한다(여러 번 불려도 한 번만).

- `release`는 상태 기계가 결과 표시를 끝낼 때, 강제 초기화할 때, 늦게 도착한 결과를 버릴 때 부른다.
- D 화면 `capture`·`resources` 줄에 실제 캡처 크기, 원본 영상 크기, 잘라낸 위치, 형식·용량, 시간, 남은 Object URL·캔버스 수를 보인다. 대기 상태에서 둘 다 0이어야 한다.
- 미리보기와 캡처가 같은지는 3-1 로그의 픽셀 비교 수치로 확인했다.
- 파일·브라우저 영구 저장소·서버·Git에 자동 저장하지 않는다. 로그에 실제 사진이나 얼굴 데이터를 넣지 않는다.
- 인쇄가 범위에 들어오면 인쇄 서비스로 넘기는 방식과 임시 파일 정리 정책을 그때 정한다.

### 사진 효과(유화 · 획) (구현됨, 5-1 미리보기·5-2 촬영 결과·조절 화면)

사용자 결정(2026-10-16): 사진 효과는 **"유화 · 획 (세부 보존)"** 필터다. 최종 출력에 쓸 이미지를 WebGL로 실시간으로 보여 주고, 촬영 결과도 같은 필터를 적용한다. 이후 감열지 출력에 맞춰 흑백 단계를 덧씌운다(이후 범위).

- **결과 크기는 원본처럼 짧은 변 1080**(9:16이면 1080×1920)이다. 4K로 들어오면 효과를 입히기 전에 1080 기준으로 줄인다. 미리보기·원본 갤러리와 같은 그림이어야 하고, 출력할 감열지의 해상도가 이보다 훨씬 낮기 때문이다(사용자 결정 2026-10-16).
- **미리보기 처리 해상도 기본값은 1**(결과 크기 대비)이다. 미리보기와 결과가 같은 그림이어야 하기 때문이다(사용자 결정 2026-10-16).
- **현장 PC가 느리면 먼저 `fps`(초당 그림)를 낮추고, 그래도 느리면 미리보기 처리 해상도를 낮춘다.** 그리기 시간은 대부분 획 목록 만들기(CPU)라 해상도를 낮춰도 거의 줄지 않고, 해상도를 낮추면 미리보기가 결과보다 부드러워진다(아래 "성능"·"원본과의 차이").

**출처와 라이선스**

- 원본: **같은 팀 동료가 만든 필터 갤러리** `https://nau-filter-gallery.vercel.app/`(사용자 지정)의 프리셋 `oil2f`. 페이지 HTML 한 파일(92,403바이트, SHA-256 `c0020911aea7bdcb…0d739a77`, 2026-10-16 받음)에 셰이더와 JS가 모두 들어 있다. 원본 HTML은 저장소에 넣지 않았다.
- **원본 소스 저장소는 받지 못했고, 배포된 페이지에서 이식했다.** 기준 해상도(짧은 변 1080)에서 원본 페이지와 화소가 같음을 확인했다(아래 "원본과의 차이", 로그 02).
- **원본이 바뀌면** 배포 페이지를 다시 받아 분석하고 같은 방법(합성 시험 이미지, 같은 매개변수·seed, 화소 비교)으로 비교한다. 원본 저장소를 받으면 그쪽을 기준으로 한다.
- **라이선스 표기 없음.** 페이지 본문에 라이선스·저작권 문구가 없고, 사이트의 `LICENSE`·`LICENSE.md`·`license.txt`는 404다. 페이지 안의 MIT 언급은 다른 프리셋(수채 v4의 MNPR) 출처라 `oil2f`와 관계없다. 사용 권한은 오케스트레이터가 사용자에게 확인 중이다(로그 03).
- 원본이 밝힌 기법 출처: Hertzmann 1998, "Painterly Rendering with Curved Brush Strokes of Multiple Sizes"(SIGGRAPH 98). 큰 붓에서 작은 붓으로 층을 칠하고, 칠한 결과가 원본과 많이 다른 곳에만 가는 붓을 더한다.
- 원본에 표기는 없지만 셰이더의 `hash12`는 Dave Hoskins "Hash without Sine"(MIT)과 같은 식이다.
- 이식한 파일 머리말에 출처 URL·프리셋 이름·기법 출처를 적었다: `core/oil-paint.js`, `config/effect-settings.js`, `effect/oil-shaders.js`, `effect/oil-renderer.js`.

**이식 범위:** `oil2f`가 실제로 지나는 경로만 옮겼다. `PRESETS.oil2f` → `renderDrawing` → `needFlow` 흐름장 → `paintStrokes`(`sbr: 1` 유화 분기), `makeStrokes`, `ihash`, `currentTick`이다.

- 가져오지 않은 것: 다른 프리셋(쿠와하라 `akf`, 수채, 드로잉, 로토스코핑), 비교 위치(`split`), 노출 깜빡임(`flick`, 값 1), 스틸·MP4 내보내기, `localStorage` 기억.
- 원본 셰이더 중 유화에서 쓰지 않는 분기(`uMedium` 2~5)와 함수(`fbm`, `boilOff` 등)는 뺐다.

**패스 순서** (그리는 해상도 W×H, 흐름장은 절반 해상도 `round(W/2)`×`round(H/2)`)

| # | 패스 (셰이더) | 입력 | 출력 텍스처 | 하는 일 |
|---|---|---|---|---|
| 0 | 소스 올리기 | 카메라 `<video>` 프레임 | `src` (영상 원본 크기, RGBA8, LINEAR, 밉 없음) | `UNPACK_FLIP_Y`로 위아래를 뒤집어 올린다(원본과 같음) |
| 1 | 색 보정 `FS_GRADE` | `src` | `grade` (W×H, RGBA8, 밉) | 보이는 9:16 영역을 좌우 반전해 읽는다(이식에서 더함). 따뜻한 쪽으로 조금(R×1.035, B×0.94), 밝은 곳 압축 `g(1+k)/(1+kg)`(k 0.08), 갈색 3%. `grade`(0~1)만큼 원본과 섞는다 |
| 2 | 구조 텐서 `FS_SST` | `grade` | `sst` (W/2×H/2, RGBA16F) | Sobel 기울기 → (gx², gy², gx·gy) |
| 3·4 | 가우스 흐림 `FS_BLUR` ×2 | `sst` → `sst2` → `sst` | `sst` | 가로·세로 σ 2.5 텍셀(절반 해상도 기준), 반경 ceil(2σ) |
| 5 | 흐름장 `FS_TFM` | `sst` | `tfm` (W/2×H/2, RGBA16F) | 작은 고유값 방향(형태를 따라가는 방향)과 이방성 A. 평평한 곳은 60도 방향으로 기운다. 출력 (cos, sin, 각도, A·세기) |
| 6 | 밑칠 `FS_UNDER` | `grade` 밉 4.5 | `paint`(W×H, RGBA8, 밉) + `hgt`(W×H) — 두 출력(MRT) | 아주 흐린 색으로 칠하고 높이 0.5 |
| 7 | 붓 층 3개 `VS_STROKE`·`FS_STROKE` | `grade`, `tfm`, 획 목록 | `paint`·`hgt`에 알파 섞기(`SRC_ALPHA, ONE_MINUS_SRC_ALPHA`) | 획 하나 = 인스턴스 하나(삼각형 띠 14점). 아래 "획 생성 규칙" |
| 8 | 보완 층 | `paint`를 `paintC`로 복사(blit), `grade`, `tfm` | `paint`·`hgt`에 섞기 | 칸의 3×3 표본 평균 오차(밉 0.6의 `grade`와 `paintC`의 RGB 거리)가 문턱 0.22 이상인 칸에만, 오차가 가장 큰 표본 위치에 가는 붓. 끝나면 `paint` 밉을 만든다 |
| 9 | 합성 `FS_COMPOSE` | `paint`, `hgt` | `composed` (W×H, RGBA8, NEAREST) | 높이의 한 텍셀 차이로 법선 → 왼쪽 위 빛 `c(0.84+0.26·diff)` + 광택(지수 22, 0.1×강도), 캔버스 결(주기 4.6px, 진폭 0.02×강도), 가장자리 어둡게(최대 12%) |
| 10 | 출력 단계 `FS_OUTPUT` | `composed` | 화면 캔버스, 또는 결과 사진용 화면 밖 `out`(RGBA8, 위아래를 뒤집어 그려 `readPixels`가 위 줄부터 읽힌다, 5-2) | **지금은 그대로 통과.** 감열지용 흑백·디더링 패스를 여기에 둔다(이식에서 더함. 원본은 9에서 바로 화면) |

**획 생성 규칙** (`core/oil-paint.js`의 `createStrokeBuilder`, 원본 `makeStrokes` 그대로)

- 층마다 간격 `spacing` px의 격자를 깔고 **칸마다 획 하나**를 둔다(`gw = ceil(W/spacing)`, `gh = ceil(H/spacing)`). 기본값의 획 수는 붓 층 5,974 / 20,736 / 82,944개, 보완 층 147,456개, 합계 257,110개다. 보완 층은 그중 문턱을 넘는 칸만 실제로 그린다.
- 획 i의 값
  - 중심: `x = (i % gw + ihash(i, sd, 2)) · spacing / W`, `y = (floor(i / gw) + ihash(i, sd, 3)) · spacing / H` (칸 안에서 흔든다)
  - 난수: `z = ihash(i, sd, 4)`, `w = ihash(i, sd, 5)`
  - 그리는 순서: 열쇠 `fround(ihash(i, sd, 6))`의 오름차순(같으면 번호 순)
- seed: 층 기준 `base = 1000 + 층 번호 × 97`(보완 층 번호 = 붓 층 수 3).
  - **`ihash(i, base, 1) < boil`인 획만** 그림마다 `sd = base + (seed + 1) × 7919`를 쓴다. 나머지는 `sd = base`로 고정이다.
  - 그래서 같은 seed·매개변수면 같은 목록이고, boil 비율의 획만 그림마다 위치·난수·순서가 바뀐다.
- 고정 획은 한 번만 만들어 정렬해 두고(캐시 16개), 바뀌는 획만 새로 만들어 정렬해 합친다. 결과는 전부 새로 만들어 정렬한 것과 같다(Node 테스트).
- 정점 셰이더
  - 길이 `L = 길이 × (0.75 + 0.5z)`, 굵기 `W = 굵기 × (0.8 + 0.4w)`
  - 중심에서 흐름장을 따라 앞뒤로 6마디씩 휜다(새 방향을 앞 방향과 0.7로 섞음). 양 끝은 굵기 0.55배까지 가늘어진다.
  - 색은 `grade`의 밉 단계 `lod`에서 읽고, `jitter = 0.05 × 강도`만큼 밝기·색을 흔든다.
  - 세부 문턱이 0보다 큰 층은 `|lum(lod) − lum(lod + 2.5)|`가 문턱보다 작은 곳(평평한 곳)의 획을 버린다. 작은 붓은 세밀한 곳에만 간다.
- 조각 셰이더(유화): 길이 방향 붓털 홈(`vnoise`, 주기 2.2px), 가장자리 0.72~1에서 흐려짐, 끝 30%에서 물감이 갈라짐, 색 0.92~1.08배, 높이 `0.3 + 0.6·붓털·가장자리`.

**매개변수** (`config.effect`, 범위는 `config/effect-settings.js`. px는 아래 "해상도 비례 규칙"의 기준 해상도 px)

| 값 | 기본값 (oil2f) | 범위 | 뜻 |
|---|---|---|---|
| `strength` 강도 | 0.1 | 0~1.6 | 요철(법선 세기)·광택·캔버스 결·획 색 흔들림 |
| `size` 붓 크기 | 1.25 | 0.6~1.8 | 모든 층·보완 층의 굵기·간격·길이에 곱한다 |
| `boil` 획 다시 그리기 | 0.1 | 0~1 | 그림마다 새로 배치하는 획의 비율 (0 고정 ~ 1 전부) |
| `fps` 초당 그림 | 24 | 2~30 (정수) | 1초에 새로 그리는 그림 수. 사이에는 앞 그림을 그대로 보인다(스톱모션 느낌) |
| `grade` 색 보정 | 1 | 0~1 | 색 보정 이미지를 원본과 섞는 정도 |
| `layers` 붓 층 | `[36,15,84,3.8,0,1]`, `[18,8,44,2.6,0.02,1]`, `[8,4,20,1.4,0.06,1]` | 모양 검사 | `[굵기px, 간격px, 길이px, 색 밉 단계, 세부 문턱, 불투명도]`. 불투명도는 유화에서 쓰지 않는다(원본도 같음) |
| `refine` 보완 층 | `[3.5, 3, 10, 0.6, 0.22]` | 문턱 0.01~1, `null`이면 없음 | `[굵기px, 칸 간격px, 길이px, 기준 이미지 밉 단계, 오차 문턱(0~1 RGB 거리)]`. 문턱 0은 셰이더에서 "보완 층 아님"이라 쓰지 않는다 |
| `previewScale` | 1 (사용자 결정) | 0.25~1 | 미리보기 처리 해상도. 결과 사진 크기(짧은 변 1080) 대비. 5-1에서는 보이는 영역 원본 대비였고 기본값 0.5였다 |
| `enabled` | true | | false면 효과 없이 원본 미리보기 |

- 원본의 "처리 해상도(q ½·¾·1)"는 쿠와하라(`akf`) 텍스처에만 쓰여 `oil2f`에는 영향이 없다. 그래서 가져오지 않았고, `previewScale`은 이 프로젝트에서 새로 둔 값이다.
- **코드에서 값을 바꾸는 입구:** `createEffectPreview(...).setSettings({ fps: 12 })`처럼 일부만 넘긴다. 정규화해서 다음 화면 갱신 때 새로 그리고, 범위로 맞춘 항목 설명을 돌려준다. 운영자 조절 화면 `E`(아래)가 이 입구를 쓴다.

**해상도 비례 규칙** (`resolveOilDrawing`)

원본은 소스와 관계없이 **짧은 변을 1080px**로 맞춰 그린다. 그래서 px 매개변수는 "짧은 변 1080px 그림의 px"다. 그리는 해상도의 `s = 짧은 변 / 1080`으로 아래처럼 맞춘다. 결과 사진은 늘 짧은 변 1080이라 s = 1(원본과 같은 값)이고, 미리보기는 `previewScale`이 1이면 s = 1, 0.5면 0.5다. 4K 입력도 결과는 1080 기준이라 s = 2로 그리는 경우는 없다(5-2).

| 대상 | 규칙 | 이유 |
|---|---|---|
| 획 굵기·간격·길이, 보완 층 칸 | × s | 간격도 같이 줄어 칸 수(획 수)가 해상도와 관계없이 같고, 정규화 좌표의 획 목록이 같다(배율이 2의 거듭제곱이면 비트 단위로 같음, Node 테스트) |
| 색을 읽는 밉 단계(층·보완 층·밑칠 4.5) | + log2(s) | 같은 크기의 영역을 평균한다. 0 아래는 0으로 잘린다(s 0.5에서 보완 층 0.6 → −0.4 → 0) |
| 붓털 무늬 주기 | 기준값 그대로 | 획 안 좌표 기준이라 해상도와 관계없이 같은 무늬 |
| 높이 → 법선 세기 | × s (`relief = 강도 × s`) | 한 텍셀 차이로 기울기를 재므로, 해상도가 낮으면 기울기가 커진다 |
| 캔버스 결 주기 4.6px | × s | |
| 흐름장(구조 텐서·흐림 σ) | 그대로 | 절반 해상도 텍셀 단위라 이미 비례한다 |

**시간에 따라 변하는 요소**

- 그림 번호 `tick = floor(t초 × fps + 1e-6)`, `seed = tick % 997`(원본 `currentTick`·`frame`). 원본은 영상의 `currentTime`을 쓰지만 카메라에는 재생 시각이 없어 `performance.now()`를 쓴다(원본의 정지 이미지 경로와 같음).
- `tick`이 바뀔 때만(또는 설정·크기가 바뀌면) 새로 그린다. 그 순간의 최신 카메라 프레임을 쓴다. 사이의 화면 갱신(60Hz)에서는 앞 그림이 그대로 보인다.
- seed는 획 목록에만 쓰인다. `oil2f` 경로의 셰이더에는 그림마다 바뀌는 값이 없다(원본 셰이더의 `uSeed`·`uBoil`은 다른 프리셋용).
- `boil`은 화면을 휘게 하지 않고 획만 다시 배치한다. 정지 이미지에서 이웃한 그림 사이에 바뀌는 화소는 boil 0 → 0%, 0.1 → 29.8%, 0.5 → 81.5%, 1 → 99.7%다(원본·이식본 같음, 로그 02).

**실시간 미리보기** (`effect/effect-preview.js`)

- `<video>`는 그대로 두고(감지·캡처·카메라 상태 감시가 계속 쓴다) 그 위에 효과 캔버스 `#effect`를 덮는다. 캔버스는 `<video>` 바로 뒤에 있어 결과 사진·카운트다운·D 겹쳐 그리기·조절 화면이 그 위에 온다.
- **반전·크롭:** 미리보기와 같은 `computeCoverMapping`(cover, 가운데 기준)으로 보이는 영역을 정하고, 색 보정 패스가 그 영역을 `config.mirror`에 따라 좌우 반전해 읽는다.
  - 효과는 반전된 그림에 칠한다. 획 방향이 좌우 대칭이 아니므로, 결과 사진과 같은 그림이 되게 하기 위해서다.
  - 효과 캔버스에는 CSS 반전을 걸지 않는다. 반전은 여전히 웹에서만, 경로마다 한 번씩 한다(미리보기 `<video>`는 CSS, 효과는 입력 uv, 캡처는 `capture.js`).
- 그리는 해상도 = 결과 크기(보이는 영역을 짧은 변 1080으로 맞춤, `resultSizeFor`) × `previewScale`. 기본값 1이면 OBS 1080×1920·4K 2160×3840·가짜 카메라 2160×2160(보이는 영역 1215×2160) 모두 1080×1920이다. CSS로 9:16 영역에 늘려 보인다.
- 카메라가 준비되지 않았거나 끊기면 그리지 않고 캔버스를 숨긴다(멈춘 앞 그림이 남지 않게). 다시 준비되면 첫 그림을 그린 뒤 보인다.
- 결과 표시 중에도 계속 그린다(결과 사진이 위를 덮는다).

**장애 처리**

| 상황 | 처리 |
|---|---|
| WebGL2 컨텍스트를 만들지 못함(`webgl2-unavailable`), `EXT_color_buffer_float` 없음(흐름장이 음수를 담지 못함), 셰이더·프레임버퍼 실패 | 캔버스를 숨기고 원본 미리보기(`fallback`). 새로고침 전까지 다시 시도하지 않는다. 콘솔 경고 한 번(`errorLog`의 `effect` 분류) |
| 그리기 중 예외, **그림을 마친 뒤 GL 오류**(`getError`)·컨텍스트 손실 (5단계 검수 1) | 렌더러를 버리고 `fallback`(손실이면 `context-lost`를 기다린다). 그림마다 시작 전에 쌓인 오류를 비우고, 그림이 끝나면 `isContextLost()`·`getError()`를 확인한다. 이 확인이 GPU 명령을 한 번 동기화해 그림당 CPU 약 0.8~1ms가 더 든다(실제 OBS 1배: 6.5~6.7ms → 7.4~7.6ms, 로그 03) |
| 컨텍스트 손실(`webglcontextlost`) | `preventDefault()`로 되살릴 수 있게 하고 원본 미리보기(`context-lost`). `webglcontextrestored`가 오면 렌더러를 새로 만들어 다시 효과 |

- 어느 경우든 카메라·감지·촬영은 이 모듈과 관계없이 계속 돈다(브라우저 확인 시나리오, 실제 OBS 확인).
- **GPU 자원 (5단계 검수 2·3):** 렌더러는 프로그램·텍스처·프레임버퍼·버퍼·VAO를 만드는 즉시 한 목록(`owned`)에 넣는다. 텍스처 하나(`tex`)·대상 묶음(`allocate`)·초기화(셰이더 컴파일 등)가 만들다 실패하면 그때까지 만든 것을 지우고, `dispose()`는 목록 전체를 지운다. 버린 렌더러(장애)도 `dispose()`한다. 살아 있는 자원 수는 `liveResources()`로 볼 수 있다(테스트용).
- 관람객 안내 문구는 바꾸지 않는다. 효과 장애는 관람객이 할 일이 없고, 원본 미리보기로 촬영은 계속되므로 D 화면에만 보인다.
- **D 화면 `effect` 줄:** 상태, 그리는 해상도(배율, px 비례 s), `fps` → 실제 초당 그림 수, `boil`, 마지막 seed, 컨텍스트 손실 횟수. 아래 `time` 줄은 그리기 CPU 시간(마지막·평균), GPU 시간(`EXT_disjoint_timer_query_webgl2`가 있을 때), 획 수, 렌더러 이름. 장애면 `fallback (원인) -> camera preview`.

**성능** (개발 PC RTX 5090, headless Chrome 155, 실제 OBS 1080×1920 60fps, 각 10~15초, 로그 02)

| | 효과 끔 | 미리보기 0.5배 (540×960) | 미리보기 1배 (1080×1920) |
|---|---|---|---|
| 그리기 CPU (평균) | — | 6.9~7.2ms | 6.3ms |
| 그리기 GPU (타이머 질의 평균, 최대) | — | 0.8ms, 2.9ms | 1.2ms, 3.3ms |
| 초당 그림 | — | 24 | 24 |
| 감지 | 15fps, 3.2ms | 15fps, 3.8ms | 15fps, 3.3ms |
| rAF | 60fps, 25ms 넘는 간격 0 | 60fps, 0 | 60fps, 0 |
| 긴 작업(50ms 이상) | 0 | 0 | 0 |
| 메인 스레드 사용률 | 12.4% | 29.4~30.6% | 27.3% |

- 그리기 시간은 해상도보다 **획 목록 만들기(CPU)**가 대부분이다. 그림마다 바뀌는 획 약 2만 6천 개를 만들어 정렬하고, 25만 개를 합쳐 GPU로 약 4MB를 올린다. 해상도를 낮춰도 획 수가 같아 CPU 시간은 줄지 않는다. 현장 PC가 느리면 `previewScale`보다 `fps`를 낮추는 쪽이 효과가 크다(fps 8: 메인 스레드 16.4%).
- 0.5배와 1배의 GPU 차이가 작아 개발 PC에서는 1배(기본값, 5-2)도 여유가 있다. 현장 PC에서 다시 잰다. 느린 PC에서의 대응 순서는 이 절 처음(먼저 `fps`, 그다음 처리 해상도).
- 결과 사진(5-2, 실제 OBS 1080×1920, 3회): 효과 렌더·화소 읽기 14.7~18.3ms(메인 스레드, 동기), JPEG 인코딩 35~50ms(비동기). 촬영 순간 rAF 간격은 3회 중 1회에 33.3ms(한 프레임) 한 번, 나머지 16.9ms 이하, 50ms 넘는 긴 작업 0.

**원본과의 차이** (합성 시험 이미지, 로그 02)

- 기준 해상도(1080×1920, s = 1)에서 같은 입력·매개변수·seed면 **원본과 화소가 완전히 같다.** 매개변수·seed 8가지, boil 0·0.1·0.5·1, 좌우 반전 모두 최대 차이 0이다.
- 다른 해상도는 구성(획 위치·색·방향)이 같고 화소는 다르다.
  - 540×960을 원본 1080의 2×2 평균과 비교: 평균 차이 10.1/255, PSNR 22.3dB. 비례 규칙 없이 px를 그대로 쓰면 18.4/255, 18.7dB.
  - 4K(s = 2)를 2×2 평균으로 줄여 원본과 비교: 9.3/255, 22.9dB.
  - 이유: 낮은 해상도에서는 흐름장을 더 거친 이미지로 재고, 보완 층의 오차 판정이 더 흐린 칠과 비교하며, 가는 획·붓털이 화소보다 작아진다. 눈으로는 같은 그림이 더 부드럽게 보인다.

**결과 사진** (5-2, `effect/photo-effect.js`, `effect-preview.js`의 `renderStill`)

- **셔터 순간 관람객이 본 미리보기와 같은 그림:** 같은 카메라 프레임·그림 번호(tick)·seed·설정으로, 결과 크기(짧은 변 1080)에 화면 밖으로 다시 그린다.
  - 같은 프레임: 미리보기가 마지막으로 올린 소스 텍스처를 다시 올리지 않고 그대로 쓴다(`render(null, …)`). 그 텍스처가 화면에 보이는 그림의 프레임이다.
  - 그 사이에 바뀌지 않는 이유: `capture.js`가 프레임을 잡은 같은 작업의 마이크로태스크에서 효과 단계를 부르고, 효과 단계는 끝까지 동기다. 미리보기는 `requestAnimationFrame`에서만 새 프레임을 올리므로 끼어들 수 없다.
  - 미리보기 처리 해상도가 1이 아니어도 결과는 따로 1080 기준으로 그린다. 렌더러는 해상도별 텍스처 묶음을 최근 2개까지 두므로 미리보기 묶음을 덮지 않는다. 1이면 같은 묶음을 쓰고 결과는 화면 그림과 같은 화소다(JPEG 전).
  - 보이는 그림이 없거나(카메라 준비 직후) 영상 크기가 바뀌었으면 지금 프레임으로 새로 그린다(D `new drawing`).
- 화면 밖 대상 `out`에 그리고 `readPixels`로 읽어 새 2D 캔버스에 넣는다. 그 뒤는 기존 캡처 순서(인코딩·Object URL·정리)다. 새 프레임 확인(500ms), 회차 취소 시 즉시 정리, 늦게 도착한 결과 폐기, 자원 해제 규칙은 그대로다(4절, 위 "캡처와 결과 이미지").
- **효과를 그리지 못하면 원본 사진으로 대신한다.** 원본 사진도 결과 크기(짧은 변 1080)로 줄인다. 관람객 흐름은 끊지 않고 콘솔 경고(`errorLog`의 `effect-capture` 분류, 반복은 요약)와 D 화면 `photo-fx` 줄(`RAW PHOTO … (원인)`)로 남긴다.
  - 원인 예: 미리보기 효과가 장애·컨텍스트 손실 중(`not-running`), 화소 읽기 실패, 화소를 읽은 뒤 GL 오류(`render-failed: GL error …`)·컨텍스트 손실(`context-lost: …`) — 이때 읽은 화소는 비어 있을 수 있어 효과 사진으로 쓰지 않는다(5단계 검수 1), 2D 캔버스 실패.
  - 촬영 실패로 처리하지 않은 이유: 관람객은 이미 3·2·1을 거쳐 찍혔고 다시 찍을 방법이 없다(비접촉). 원본 사진이라도 받는 편이 낫고, 효과 장애는 미리보기에서 이미 원본으로 보이고 있던 경우가 대부분이다.
- `config.effect.enabled`가 false면 결과도 효과 없이 예전처럼 원본 해상도 그대로다.
- **D 화면 `photo-fx` 줄:** 마지막 결과의 상태(`applied 1080x1920 seed … tick … (same drawing as preview), 시간` 또는 `RAW PHOTO …`), 누적 효과·원본 수.

**운영자 조절 화면 `E`와 조절값 파일** (5-2, `ui/effect-tuning.js`)

- 조절하는 값: 강도, 붓 크기, 획 다시 그리기, 초당 그림, 색 보정, 세부 보존 문턱(보완 층 오차 문턱), 미리보기 처리 해상도. 범위·단계는 원본 갤러리 슬라이더와 같다(위 "매개변수" 표). 붓 층 모양 등 나머지는 `config.effect` 그대로다.
- 조절하는 즉시 미리보기에 반영된다. 저장·취소(저장된 값으로)·기본값·저장하지 않고 닫으면 되돌리기·저장 중 닫기(저장이 끝난 뒤 닫고, 실패하면 이전 파일 값)는 `R` 화면(5절 "인식 범위 조절")과 같은 규칙이다. 화면 위쪽 줄에 미리보기 상태(해상도·초당 그림·그리기 시간)를 보인다.
- 열려 있는 동안 자동 촬영을 막는다(4절 "자동 시작과 이탈 취소"의 조절 화면 규칙). `R`과 `E`는 한 번에 하나만 열린다.
- **파일:** `config/effect.local.json`(1절 "조절값 파일 API"). 형식 `{ "version": 1, "settings": { strength, size, boil, fps, grade, refineThreshold, previewScale } }`. 운영자가 조절하는 7개 값만 저장한다.
- **불러오기 순서: 파일 → 기본값.** `localStorage`는 쓰지 않는다(옮겨 올 예전 값이 없다). 파일이 없거나(404), 읽기 실패·제한 시간(3초, 가안) 초과, 형식이 틀리면 기본값이고 파일은 운영자가 다시 저장할 때까지 그대로 둔다. 없는 키는 기본값으로 채우고 알린다.
- 불러오기가 끝나기 전에는 `config.effect` 기본값으로 그리고, 끝나면 불러온 값을 넣는다. 인식 조절값과 달리 자동 촬영을 막지 않는다. 효과는 판정에 영향을 주지 않기 때문이다. 시작 직후 3초 안에 촬영되면 기본값 그림일 수 있지만, 미리보기와 결과는 같은 값이다.
- D 화면 `effect` 아래 `values` 줄에 지금 값과 출처(`file`·`saved`·`defaults (no file)`·`+ unsaved changes`)를 보인다.

## 7. 참고 자료

- 사진 효과 원본: 필터 갤러리 [nau-filter-gallery.vercel.app](https://nau-filter-gallery.vercel.app/) 프리셋 `oil2f` (6절)
- A. Hertzmann, "Painterly Rendering with Curved Brush Strokes of Multiple Sizes", SIGGRAPH 98 (원본이 밝힌 기법 출처)
- MDN, [MediaDevices.getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- MDN, [Secure contexts](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts)
- MDN, [Taking still photos with getUserMedia()](https://developer.mozilla.org/en-US/docs/Web/API/Media_Capture_and_Streams_API/Taking_still_photos)
- Google AI Edge, [Face detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/face_detector/web_js)
- Google AI Edge, [Object detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector/web_js)
- Google AI Edge, [Pose landmark detection guide for Web](https://developers.google.com/edge/mediapipe/solutions/vision/pose_landmarker/web_js)

구현할 때 실제 버전과 대상 브라우저에서 다시 확인한다.
