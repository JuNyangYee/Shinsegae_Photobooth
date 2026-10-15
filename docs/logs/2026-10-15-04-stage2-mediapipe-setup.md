# 2026-10-15-04 — 2-1 MediaPipe 로컬 라이브러리 설정

브랜치 `stage2-face-detect`(1단계 병합 후 `master`에서 분기). 작업 에이전트(Opus 5.5 high)가 오케스트레이터 지시 범위(2-1)만 진행했다. 앱 화면 코드에는 감지를 넣지 않았다(2-2 범위).

## 전제 (사용자 결정, 2026-10-15)

- 단계 순서 변경: 2단계 얼굴 감지 → 3단계 촬영 한 사이클 → 4단계 안정화·현장 실행.
- 감지기는 MediaPipe Face Detector(short-range), 약 2m면 충분.
- 인식 범위는 화면 영역(스윗스팟)과 최소 얼굴 크기 두 가지. 운영자가 숨김 화면에서 조절하고 `localStorage`에 저장.
- npm은 라이브러리를 받아오는 용도로만 쓴다. 런타임 파일은 `lib/`에 커밋하고, 현장 PC는 Node 없이 clone만으로 오프라인 동작.

## 작업 내용

- `package.json`: `private: true`, 빌드 스크립트 없음, `scripts.vendor:mediapipe`만 있음. `devDependencies`에 `@mediapipe/tasks-vision` `1.1.1`을 정확 버전으로 고정. `package-lock.json` 커밋. `.npmrc`에 `save-exact=true`.
- `tools/vendor-mediapipe.mjs`(Node 내장 모듈만 사용):
  - 설치된 버전이 `package.json` 고정 버전과 같은지 확인한다.
  - `lib/mediapipe/tasks-vision/`를 비우고 런타임 파일만 복사한다.
  - LICENSE와 모델을 고정 URL에서 받아 SHA-256을 검증한다(다르면 실패). 이미 맞는 해시의 파일은 다시 받지 않는다.
  - `models/`의 관리 대상이 아닌 파일은 지운다.
  - 끝에 파일 목록과 크기를 출력한다.
- `lib/mediapipe/` 런타임·모델 커밋.
- `.gitignore`: `node_modules/`, `*.download`(스크립트 임시 파일). `.gitattributes`: `lib/mediapipe/** -text`.
- `bin/server/serve.ps1`: 고치지 않았다. MIME 표에 `mjs`·`wasm`·`tflite`가 이미 있다.
- 문서:
  - `docs/PROJECT.md`: 확정 표에 감지기·라이브러리 관리를, 가안 표에 인식 범위·조절값 저장을 넣고 오프라인 항목을 보완했다. 4절 단계표는 새 순서로 고쳤다.
  - `docs/SYSTEM.md`: 1절 폴더 구성과 참고 구조 표, 5절 "MediaPipe 로컬 라이브러리"를 고쳤다.
  - `README.md`: 현재 상태와 "라이브러리 갱신 방법"을 고쳤다.

## 결정과 이유

- **버전 1.1.1:** npm `latest` dist-tag이고, 공식 저장소에 같은 이름의 태그 `v1.1.1`이 있다. `vision.d.ts`·`vision_bundle.mjs`에 `FaceDetector`가 있다. 배포일이 2026-10-14로 하루밖에 안 됐지만 1.1.0(2026-10-06)의 패치 릴리스이고, 아래 검증에서 로딩·생성·감지 호출이 정상이었다. 참고 프로젝트는 1.0.1이다.
- **복사할 wasm:** bundle은 SIMD를 지원하면 `vision_wasm_internal.*`, 아니면 `vision_wasm_nosimd_internal.*`를 고른다(`FilesetResolver` 코드 확인). 현장 Chrome은 SIMD를 지원하지만, 그렇지 않은 환경에서 로딩 자체가 실패하지 않도록 nosimd도 둔다(참고 프로젝트와 같다, 약 13MB 추가). `vision_wasm_module_internal.*`은 `forVisionTasks(path, true)`에서만 쓰므로 뺐다. `.cjs`·`.js`(UMD)·`.map`·`.d.ts`·`README.md`도 런타임에 필요 없어 뺐다.
- **LICENSE:** npm 패키지 1.1.1에는 라이선스 파일이 없다(`package.json`의 `license: "Apache-2.0"`만 있음). 그래서 공식 저장소 `google-ai-edge/mediapipe`의 `v1.1.1` 태그가 가리키는 커밋 `50505c8312c7eacb1bd411cecdc4cc9fd08d53cb`의 `LICENSE`를 받는다. 태그는 바뀔 수 있으므로 URL에는 커밋 해시를 쓴다.
- **모델 URL:** `latest` 대신 버전 경로 `float16/1`을 쓴다. 확인 시점에 `latest`와 `1`은 같은 파일이었고(SHA-256 같음, 서버 `Last-Modified` 2023-04-26), 참고 프로젝트의 모델과도 바이트가 같았다.
- **`lib/mediapipe/** -text`:** 이 PC는 `core.autocrlf=true`이다. `* text=auto`만 있으면 bundle·wasm 로더 JS·LICENSE가 체크아웃할 때 CRLF로 바뀌어 받은 파일과 바이트가 달라진다. 커밋 후 7개 파일의 Git blob SHA-256이 작업 트리 파일과 같음을 확인했다.
- **`.npmrc` `save-exact=true`:** 이후 `npm install <패키지>@<버전>`으로 갱신할 때 `^`가 붙지 않게 한다.

## 파일과 크기

| 파일 | 바이트 | SHA-256 |
|---|---:|---|
| `lib/mediapipe/tasks-vision/vision_bundle.mjs` | 156,139 | `a84921e02321e582484c1f8126d344b5f33b791fa09c640a52e20ee8632068f1` |
| `lib/mediapipe/tasks-vision/wasm/vision_wasm_internal.js` | 334,128 | `6522286aa32dd93eff17c3da002b0649516f87abfec7a80b5bfe5c9625caa5f8` |
| `lib/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm` | 13,519,922 | `0e101a010e262ef8e78f22e3c95b60a9705fd06962753c9acd6356d9fb56b7bd` |
| `lib/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.js` | 333,931 | `942654dbdcebce08ea039af23d18e58bebf23c8607d74023d2df7071c8a7b638` |
| `lib/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm` | 12,627,509 | `c9b1b69bb87baf9e529254d8559dcbcf4c5a9c0eda84f56a12f17d675335ec9c` |
| `lib/mediapipe/tasks-vision/LICENSE` | 12,331 | `8707eef0533987efc5b155d64761eeb6e20793f50b9bd1a68dad1cf4719d0ed8` |
| `lib/mediapipe/models/blaze_face_short_range.tflite` | 229,746 | `b4578f35940bf5a1a655214a1cce5cab13eba73c1297cd78e1a04c2380b0152f` |
| 합계 | 27,213,706 (약 27.2MB) | |

- 가장 큰 파일은 13.5MB로 GitHub 100MB 단일 파일 제한(50MB 경고)보다 작다.
- 복사한 파일 4개(bundle, wasm 로더 JS 2개, simd wasm)는 `node_modules`의 원본과 `cmp`로 같음을 확인했다.
- npm tarball 무결성: `package-lock.json`의 `integrity` `sha512-jwntgT5tzDrKOkqg6xNDNpRcTUnGvmylZE5DFnzPXossiWOIDdZX+C81LI75hlXhsG58YZW+lGzcmjH1qrQE/Q==`.

## 검증

### 스크립트 재실행

- 첫 실행: LICENSE·모델 `downloaded`, 7개 파일 출력.
- `models/stray.bin`·`tasks-vision/stray.txt`를 만들어 두고 다시 실행했다. 모델은 `kept`, LICENSE는 다시 받아 검증했다(`tasks-vision/`를 비우므로). 두 파일은 지워졌고, `lib/` 전체 SHA-256 목록이 첫 실행과 같았다.

### 서버 (`serve.ps1 -Port 8771`, `curl`)

| 경로 | 상태 | Content-Type |
|---|---|---|
| `/lib/mediapipe/tasks-vision/vision_bundle.mjs` | 200 | `text/javascript; charset=utf-8` |
| `/lib/mediapipe/tasks-vision/wasm/vision_wasm_internal.js` | 200 | `text/javascript; charset=utf-8` |
| `/lib/mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm` | 200 | `application/wasm` |
| `/lib/mediapipe/tasks-vision/wasm/vision_wasm_nosimd_internal.wasm` | 200 | `application/wasm` |
| `/lib/mediapipe/models/blaze_face_short_range.tflite` | 200 | `application/octet-stream` |
| `/lib/mediapipe/tasks-vision/LICENSE` | 200 | `application/octet-stream` |

받은 바이트 수가 파일 크기와 같았다. 모델과 simd wasm은 받은 내용의 SHA-256도 같았다.

### 로딩 (저장소 밖 임시 하네스)

- 환경: Chrome 155.0.8059.79, `--headless=new`, `%TEMP%` 임시 프로필, `--use-fake-device-for-media-stream --use-fake-ui-for-media-stream`(가짜 카메라 `fake_device_0` 640×480, 실제 카메라는 열지 않음), `--disable-background-networking --disable-component-update`.
- Node DevTools Protocol 하네스의 동작:
  - `http://localhost:8771/__harness.html` 요청을 가로채 빈 HTML을 돌려준다(같은 출처, 저장소 파일 변경 없음).
  - 그 페이지에서 bundle을 동적 `import`하고, `FilesetResolver.forVisionTasks('/lib/mediapipe/tasks-vision/wasm')`와 `FaceDetector.createFromOptions`(로컬 모델 경로, `runningMode: 'VIDEO'`)를 부른다.
  - 가짜 카메라 `<video>`로 `detectForVideo`를 30프레임 돌리고, 이후 100ms 간격으로 계속 호출한다.
  - 페이지와 자동 연결된 하위 대상의 `Network.requestWillBeSent`·`loadingFailed`와 콘솔을 기록한다.
- 안전장치: 텔레메트리 주소(`*odml.pa.googleapis.com*`)는 `Network.setBlockedURLs`로 막았다. 요청 시도는 기록되지만 실제로 나가지 않는다.
- WebGL 렌더러: `ANGLE (NVIDIA, NVIDIA GeForce RTX 5090 ... Direct3D11 ...)`. headless에서도 실제 GPU를 썼다(SwiftShader 아님).

| 실행 | wasm | 생성 | `detectForVideo` 30프레임 | 오류 |
|---|---|---|---|---|
| GPU delegate | simd(자동 선택) | 성공 (112ms) | 성공 | 없음 |
| CPU delegate | simd(자동 선택) | 성공 (68ms, XNNPACK) | 성공 | 없음 |
| GPU delegate | nosimd(fileset 직접 지정) | 성공 (125ms) | 성공 | 없음 |
| CPU delegate | nosimd(fileset 직접 지정) | 성공 (81ms) | 성공 | 없음 |

- 로컬 요청: `vision_bundle.mjs`, `wasm/vision_wasm_internal.js`(또는 nosimd), `.wasm`, 모델 각 1회. `favicon.ico` 404(하네스 페이지 때문).
- 생성 시간은 wasm·모델이 이미 메모리에 없을 때의 값이고 `Cache-Control: no-store`로 매번 다시 받았다. 프레임당 시간은 `requestAnimationFrame` 대기를 포함해 성능 판단 근거로 쓰지 않는다.
- 가짜 카메라 화면(얼굴 없음)에서도 검출이 나왔다(30프레임 중 11~16건). 오검출로 보인다. 점수·크기 기준과 실제 정확도는 2-2에서 실제 카메라로 확인한다.

### 외부 네트워크 요청 — **0건이 아님**

| 실행 | 관찰 |
|---|---|
| 생성 후 약 2초 뒤 `close()` | `close()` 때 `POST https://odml.pa.googleapis.com/v1/log` 1건 (CDP로 차단됨) |
| 생성 후 75초 동안 감지를 계속 호출 | 모델 로딩 뒤 **60.0초**에 같은 POST 1건. 차단으로 실패한 뒤에는 로거가 멈춰 `close()` 때 다시 보내지 않았다 |
| 같은 조건 + 페이지에 `<meta http-equiv="Content-Security-Policy" content="connect-src 'self'">` | 네트워크 요청 0건. 콘솔에 `Refused to connect because it violates the document's Content Security Policy`, `securitypolicyviolation` 1건. 로딩·생성·감지 호출은 정상 |

- 원인: `tasks-vision` 1.0.0부터 들어간 사용 통계 로거다(0.10.35·0.10.21·0.10.14 번들에는 이 주소가 없고, 1.0.0·1.0.1·1.1.0·1.1.1에는 있다).
  - 태스크를 만들 때 항상 켜지고, 공개 옵션으로 끌 수 없다(`TaskRunnerOptions`에는 `baseOptions`만 있다).
  - API 키는 wasm의 `_mediapipeLoggerGetEncodedApiKey`에서 가져온다.
  - 번들 코드상 모으는 내용은 태스크 종류(`FaceDetector`), 실행 모드, OS 종류, 라이브러리 버전, 처리 횟수와 시간 통계다. 이미지나 감지 좌표를 넣는 코드는 보지 못했다. 실제 전송 내용을 해독해 확인하지는 않았다.
- 현장 PC가 오프라인이면 요청은 실패로 끝나고 기능에는 영향이 없다. 하지만 개발 PC나 인터넷이 연결된 현장 PC에서는 실제로 Google에 전송된다. "외부 서비스 없이 로컬에서 처리" 가안과 맞지 않으므로 막는 방법을 정해야 한다. 이번 범위(2-1)에서는 서버·앱 코드를 바꾸지 않았다.
- 막는 방법 후보:
  - (a) `src/web/index.html`에 CSP meta `connect-src 'self'`를 둔다. 위 실험과 같은 방식이고 가장 작은 변경이다.
  - (b) `serve.ps1` 응답 헤더에 같은 CSP를 넣는다. 모든 페이지에 적용된다.
  - (c) vendor 스크립트에서 bundle의 주소를 바꿔 쓴다. 받은 파일이 원본과 달라지고, 버전을 올릴 때마다 맞춰야 한다.
  - (d) 텔레메트리가 없는 0.10.35로 고정한다.
- 작업 에이전트 의견은 (a)다. 2-2에서 앱이 bundle을 처음 불러올 때 함께 넣는다. 다른 외부 연결(`fetch`·XHR·WebSocket)도 같이 막혀 오프라인 원칙의 안전장치가 된다.

### 정리

검증 후 서버, 하네스 Chrome, `%TEMP%`의 임시 프로필·하네스·npm tarball 비교 폴더를 모두 지웠다. 프레임·이미지는 저장하지 않았다.

### 사고: `chrome.exe --version` 실행

Chrome 버전을 확인하려고 `chrome.exe --version`을 실행했다. Windows에서는 이 명령이 버전을 출력하지 않고, 이미 실행 중인 사용자 Chrome에 붙은 채 2분 동안 끝나지 않았다. 그래서 중지했다. 사용자 Chrome에 새 창이나 탭이 생겼을 수 있다. 이후 버전은 실행 파일의 파일 버전 정보로 확인했다.

## 미검증

- 실제 웹캠·OBS 가상카메라로 로딩·감지를 하지 않았다(가짜 카메라만 사용).
- 현장 PC의 GPU·드라이버에서 GPU delegate가 생성되는지 확인하지 않았다(이 개발 PC는 RTX 5090).
- nosimd 경로는 fileset을 직접 지정해 확인했다. SIMD가 없는 브라우저에서 자동 선택되는지는 확인하지 않았다.
- 텔레메트리 전송 내용은 코드로만 확인했고, 실제 전송 본문을 해독하지 않았다.

## 남은 문제

- **MediaPipe 사용 통계 전송 차단 방법 결정 필요** (위 후보 a~d).
- 가짜 카메라 화면의 오검출. 2-2에서 최소 점수·최소 얼굴 크기·영역 조건과 함께 실제 카메라로 본다.
- 1단계 로그 03의 "사용자 실측 필요" 시나리오(OBS 중지·재시작 등)는 여전히 미실측이다.

## 다음 작업

- 2-2 감지와 인식 상태:
  - 앱이 `/lib`에서 Face Detector를 불러오게 한다(외부 요청 차단 방식 결정을 반영).
  - `camera.isReady()`·`subscribe()`로 카메라가 준비됐을 때만 감지한다.
  - 분석 해상도와 감지 빈도를 낮춘다.
  - 결과를 "인식됨 / 인식 안됨" 신호로만 밖에 전달하고, `D` 개발용 정보에 표시한다.
  - 실제 카메라로 인식 상태 변화를 확인한다.
