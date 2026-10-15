# 2026-10-15-03 — 1-2 카메라 권한·오류·첫 프레임·끊김 안내와 자동 회복

브랜치 `stage1-camera-web`, 기준 커밋 `ce69251`. 작업 에이전트(Opus 5.5 high)가 오케스트레이터 지시 범위(1-2)만 진행했다.

## 전제

- 1-1은 사용자가 실제 OBS 9:16 가상카메라로 확인했다: 장치 선택, 해상도, 반전, 9:16 배치 모두 정상.
- 현장은 무인·비접촉 키오스크다. 화면에 버튼을 두지 않고 스스로 회복한다.

## 작업 내용

- 새 파일 `src/web/js/camera-monitor.js`: 상태 구분, 첫 프레임 확인, 끊김 감지(트랙 `ended`·`devicechange`·프레임 정지), 자동 재시도, 상태 구독 인터페이스.
- `src/web/js/camera.js`: `listVideoInputs()`, `findByLabel()`을 공개했다. 장치 선택·스트림 열기·닫기 책임은 그대로다.
- `src/web/js/config.js`: `cameraRecovery`(재시도 3초, 첫 프레임 5초, 프레임 정지 3초, 직원 문의 문구 30초, 가안).
- `src/web/js/main.js`: 감시 모듈을 구독해 관람객 문구와 `D` 개발용 정보를 그린다.
- `src/web/css/app.css`: 상태 문구 줄바꿈(`white-space: pre-line`).
- 문서: `docs/SYSTEM.md` 3절 "카메라 상태와 자동 회복", 폴더 구성. `docs/logs/2026-10-15-02-...`의 사용자 실측 항목을 "사용자 확인: 정상 작동"으로 갱신.

## 결정과 이유

- **모듈 분리:** `camera.js`(장치 선택·스트림 열기)와 `camera-monitor.js`(상태·감시·재시도)를 나눴다. 감시·재시도는 타이머와 이벤트가 얽혀 `camera.js`에 넣으면 "카메라 책임만" 원칙이 흐려진다. 다만 상태 머신 라이브러리나 범용 이벤트 버스는 만들지 않고, 함수 하나(`createCameraMonitor`)와 `isReady`·`getState`·`subscribe`만 둔다.
- **상태:** `starting`, `ready`, `permission-denied`, `not-found`, `unavailable`(사용 중·열 수 없음, 알 수 없는 오류 포함), `unsupported`, `no-frames`(영상 준비 실패), `disconnected`. 관람객에게는 상태별로 다른 문구를 보이지 않는다(기술 용어 회피). 상태 상세는 `D` 화면에만 보인다.
- **첫 프레임·정지 감지에 `requestVideoFrameCallback` 사용:** 새 영상 프레임이 화면에 올라갈 때만 호출되므로 "실제 프레임이 들어오는가"를 직접 잴 수 있다. MediaStream 재생에서는 `currentTime`·`timeupdate`가 프레임과 무관하게 흐르므로 정지 판정에 쓸 수 없다. `MediaStreamTrackProcessor`는 프레임마다 처리 비용이 크고 이번 목적에는 과하다. 페이지가 숨겨지면 콜백이 멈추므로 그동안은 판정하지 않는다. 대상 브라우저가 Chrome이므로 이 API가 없으면 `unsupported`로 둔다.
- **재시도 규칙:** 실패하면 3초 간격으로 다시 시도한다. 정상 이후 끊김(`disconnected`)은 즉시 한 번 다시 시도하고, 실패하면 해당 오류 상태로 간격 재시도한다. `devicechange`는 0.5초 묶은 뒤 즉시 재시도한다. `unsupported`는 재시도하지 않는다.
- **권한 거절:** 사이트 권한이 `denied`(차단)이면 재시도해도 풀리지 않고 매번 실패만 쌓이므로 간격 재시도를 멈추고 Permissions API `camera`의 `change`를 기다린다. 프롬프트를 닫기만 한 경우(`prompt`)나 API가 없으면 간격 재시도한다.
- **겹침 방지:** 연결 시도는 한 번에 하나만 진행한다. 진행 중에 요청이 오면 끝난 뒤 한 번 더 시도하고, 그 사이에 얻은 스트림은 닫는다. 연결이 무효화될 때마다 세대 번호를 올려, 늦게 도착한 트랙 이벤트·프레임 콜백·결과를 무시한다.
- **OBS가 나중에 나타나면 전환:** 기본 카메라로 대신 연결된 상태에서 `devicechange` 후 우선 라벨(`OBS Virtual Camera`) 장치가 보이면 OBS로 다시 연결한다. 현장은 OBS 사용이 확정이고 크롭·보정이 OBS에 있으므로, 대체 카메라로 계속 운영하는 것보다 잠깐 끊기더라도 OBS로 가는 편이 맞다. 대체 연결은 개발·비상용이다.
- **관람객 문구(가안):** 정상이 아니면 "준비 중입니다. 잠시만 기다려 주세요." 30초 이상 이어지거나 스스로 풀리기 어려운 상태(`unsupported`, `permission-denied`)면 "준비 중입니다. 직원에게 문의해 주세요." 끊기면 영상을 지워 검은 화면 위에 문구를 띄운다.
- **이후 단계용 경계:** 촬영 진행 코드(2단계)는 `isReady()`가 참일 때만 시작하고, `subscribe()`로 `ready`가 아니게 되는 순간을 받아 회차를 취소한다.

## 검증 (자동 확인, 가짜 카메라)

### 방법

- 서버: `powershell -NoProfile -ExecutionPolicy Bypass -File bin\server\serve.ps1`
- Chrome: `%TEMP%` 임시 프로필, `--headless=new --use-fake-device-for-media-stream=device-count=2`, 원격 디버깅 포트. `--use-fake-ui-for-media-stream`은 **쓰지 않았다**(권한 설정을 덮어써 거절을 재현할 수 없었기 때문). 대신 시나리오마다 새 브라우저 컨텍스트를 만들고 DevTools Protocol `Browser.setPermission`으로 `camera` 권한을 정했다.
- 페이지 스크립트보다 먼저 실행되는 주입 스크립트(`Page.addScriptToEvaluateOnNewDocument`)로 `getUserMedia`·`enumerateDevices`를 감싸 실패·지연·장치 목록을 흉내 냈다. `D` 개발용 정보를 켜고 그 내용 변화(상태·원인·관람객 문구)를 시각과 함께 기록했다. 뷰포트 1080×1920.
- 마지막에 지금까지 만든 모든 트랙 중 살아 있는 트랙 수(`liveTracks`)를 세어 스트림이 새지 않는지 확인했다.
- 안전장치: 실행 전에 앱 없는 페이지에서 `enumerateDevices`로(카메라를 열지 않음) 장치가 모두 `fake_device_*`인지 확인했다. 주입 스크립트도 가짜가 아닌 장치가 보이면 `getUserMedia`를 거부하게 했다. 원격 디버깅 포트를 잡은 프로세스가 임시 프로필의 Chrome인지도 확인했다(아래 "사고" 참고).

### 결과

| 시나리오 | 재현 방식 | 관찰된 흐름 | 판정 |
|---|---|---|---|
| 정상 | 실제(가짜 장치) | `starting` → 0.1s `ready`, 시도 1회, `video 2160x2160`, 문구 숨김 | 통과 |
| 권한 거절 | **실제**: `setPermission denied` 후 접속 | 즉시 `permission-denied`(`SecurityError`), 즉시 직원 문의 문구, 8초 동안 재시도 없음(시도 1회 유지), `permission: denied` | 통과 |
| └ 이후 허용 | **실제**: `setPermission granted` | 권한 `change` → 즉시 재시도 → `ready` | 통과 |
| 실행 중 권한 회수 | **실제**: `ready` 상태에서 `setPermission denied` | Chrome이 트랙을 종료 → `disconnected`(`track-ended`) → 재시도 → `permission-denied`, 간격 재시도 멈춤. 다시 허용 → `ready` | 통과 |
| 카메라 없음 + 직원 문구 | 흉내: `getUserMedia`가 계속 `NotFoundError` | `not-found`, 3초 간격 재시도(32초 동안 11회), 30.0초에 직원 문의 문구로 전환. 이후 정상화 → 다음 재시도에 `ready`, 문구 사라짐 | 통과 |
| 사용 중 | 흉내: `NotReadableError` 2회 | `unavailable`(`in-use`) → 3초 간격 2회 → `ready` | 통과 |
| 영상 준비 실패 | 흉내: 프레임이 없는 `canvas.captureStream(0)` 스트림 1회 | 5.0초에 `no-frames`(`first-frame-timeout`) → 3초 뒤 재시도 → `ready` | 통과 |
| 트랙 종료 | 흉내: 현재 트랙에 `ended` 이벤트 발생 | `disconnected`(`track-ended`) → 즉시 재시도 → 0.1초 뒤 `ready`, 살아 있는 트랙 1개 | 통과 |
| 프레임 정지 | 흉내: `video.pause()`로 프레임 콜백 중단 | 정지 3초 + 확인 간격 뒤 `disconnected`(`frame-stall`) → 즉시 재시도 → `ready` | 통과 |
| 장치 제거 | 흉내: `enumerateDevices`에서 현재 장치를 숨기고 `devicechange` 발생 | 0.5초 묶은 뒤 `disconnected`(`device-removed`) → 재시도 → `ready` | 통과 |
| OBS 등장 → 전환 | 흉내: 현재 장치 라벨을 `OBS Virtual Camera`로 바꿔 보이고 `devicechange` | `starting`(`switch-to-preferred`) → `ready`, `preferred ... found` | 통과 |
| 시도 겹침 | 흉내: 시도마다 1.5초 지연 + 0.6초 간격 `devicechange` 4회 | 겹치지 않고 순서대로 진행, 최종 `ready`, 만든 스트림 5개 중 살아 있는 트랙 1개 | 통과 |
| 미지원 | 흉내: `getUserMedia` 제거 | 즉시 `unsupported`, 직원 문의 문구, 8초 동안 재시도 없음 | 통과 |

- "실제"는 Chrome이 실제로 만든 권한 상태·트랙 종료이고, "흉내"는 주입 스크립트로 오류·이벤트를 만든 것이다. 흉내 결과는 상태 처리 논리를 확인한 것이며, 실제 장치가 같은 오류·이벤트를 내는지는 사용자 실측이 필요하다.
- OBS 전환 시나리오는 실제로는 같은 가짜 장치를 다시 연 것이다. 아래 Chrome 문제 때문에 다른 가짜 장치로 바꾸는 방식을 쓰지 못했다.
- 미지원 상태의 시도 횟수 1회는 `startCamera`가 즉시 `unsupported`를 돌려준 것이다.

### 검증 중 발견한 Chrome 문제 (앱과 무관)

- headless Chrome에서 가짜 장치 `fake_device_0`를 재생하다가 `fake_device_1`로 바꾸면 렌더러가 간헐적으로 충돌했다(`Inspector.targetCrashed`). 앱 코드 없이 빈 페이지에서 `getUserMedia`만으로도 재현됐다. 같은 조건에서 충돌하지 않은 경우도 있었다. 가짜 캡처 경로 문제로 보고, 실제 장치 전환은 사용자 실측으로 확인한다.

### 사고: 검증 중 실제 OBS 가상카메라가 잠깐 열림

- 첫 시나리오 실행에서 앱이 가짜 장치가 아니라 실제 `OBS Virtual Camera`(1080×1920)를 약 3초 동안 열었다. 확인 즉시 해당 Chrome을 종료했다. 스크린샷·프레임은 저장하지 않았고, 기록된 것은 장치 라벨과 영상 크기뿐이다.
- 원인은 확정하지 못했다. 직후 같은 플래그로 다시 띄운 Chrome에서는 장치 목록이 가짜(`fake_device_0`, `fake_device_1`)만 나왔다. 원격 디버깅 포트(9333)에 다른 Chrome이 떠 있어 하네스가 그쪽에 붙었을 가능성이 있다(확인 시점에는 포트가 비어 있었음).
- 이후 위 안전장치(사전 장치 목록 확인, 주입 스크립트의 가짜 장치 전용 제한, 포트 소유 프로세스 확인)를 두고 다시 실행했다. 앞으로 가짜 카메라 검증에서도 같은 장치를 두는 것을 권장한다.

### 정리

- 검증 후 서버, Chrome, 하네스 프로세스와 `%TEMP%` 임시 프로필·스크립트를 모두 정리했다.

## 사용자 실측 필요

실제 OBS·웹캠은 열지 않았다. 아래는 현장 PC 또는 개발 PC에서 확인할 시나리오와 기대 동작이다. `D` 키로 상태·원인을 보면서 확인한다.

| 시나리오 | 기대 동작 |
|---|---|
| 실행 중 OBS에서 "가상 카메라 중지" → 다시 "시작" | 중지 직후 영상이 멈추거나 끊긴다. 약 3초 안에 `disconnected`(`frame-stall` 또는 `track-ended`)가 되고 화면은 검정 + "준비 중입니다" 문구. 재시작하면 다음 재시도(최대 약 3~5초)에 `ready`로 돌아온다. **주의:** OBS는 가상 카메라가 꺼져 있을 때 장치를 그대로 두고 안내 화면(정지 이미지 등)을 계속 보낼 수 있다. 그러면 프레임이 계속 들어와 `ready`로 남을 수 있다. 실제로 어떻게 보이는지 기록이 필요하다. |
| OBS 프로그램 종료 → 다시 실행 + 가상 카메라 시작 | 위와 같다. 종료 중 `not-found`·`unavailable`·`no-frames` 중 무엇이 되는지 기록한다. |
| Chrome 사이트 설정에서 `localhost` 카메라 "차단" → "허용" | 차단 즉시 `permission-denied` + 직원 문의 문구, 간격 재시도 없음. 허용하면 새로고침 없이 바로 `ready`. |
| 웹캠 USB 분리 → 다시 연결 (OBS 사용 중) | OBS가 웹캠을 잃으면 OBS 출력이 멈추거나 검게 바뀔 수 있다. 출력이 멈추면 `frame-stall`, 검은 화면을 계속 보내면 `ready`로 남는다(앱은 화면 내용을 보지 않음). 다시 연결 후 OBS가 복구하면 정상. |
| 웹캠 직접 연결(OBS 없이) 중 USB 분리 → 연결 | `disconnected`(`track-ended` 또는 `device-removed`) → `not-found`로 3초 간격 재시도 → 연결하면 `devicechange`로 바로 `ready`. |
| OBS 없이 기본 카메라로 연결된 상태에서 OBS 가상 카메라 장치가 새로 생김 | `devicechange` 후 `switch-to-preferred` → OBS로 전환(`preferred ... found`). OBS 가상 카메라 장치가 설치 시점부터 늘 존재하면 이 경우는 생기지 않는다. |
| 다른 프로그램이 카메라 점유(직접 연결 웹캠) | `unavailable`(`in-use`) → 해제되면 다음 재시도에 `ready`. |
| 30초 넘게 카메라를 쓸 수 없음 | 문구가 "직원에게 문의해 주세요"로 바뀐다. 회복되면 문구가 사라진다. |

## 남은 문제

- OBS 가상 카메라를 껐을 때 OBS가 안내 화면을 계속 보내면 끊김을 감지할 수 없다. 실측 결과에 따라 화면 내용 기반 검사(예: 단색·정지 이미지 판정)가 필요한지 결정해야 한다. 이번 범위에서는 넣지 않았다.
- 권한 프롬프트를 닫기만 한 경우(`prompt`)에는 3초마다 다시 시도하므로 프롬프트가 반복해서 뜰 수 있다. 현장은 전용 프로필에 권한을 미리 허용해 두므로 영향이 작다고 판단했다.
- 재시도 간격·제한 시간·문구 전환 시간과 관람객 문구는 가안이다.

## 다음 작업

- 1단계 단위 검수: GPT-6.1-Sol xhigh로 `master..stage1-camera-web` 변경분 검수. 검수 결과의 채택·보류는 다음 로그에 남긴다.
- 사용자 실측: 위 "사용자 실측 필요" 시나리오, 특히 OBS 가상 카메라 중지·재시작 때 실제로 보이는 화면.
- 검수 통과 후 오케스트레이터가 `master`에 병합하고 2단계(개발용 입력 촬영 한 사이클)로 넘어간다. 2단계는 `camera.isReady()`·`subscribe()`로 카메라 준비 여부를 받는다.
