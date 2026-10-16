# 2026-10-16-01 — 폴더 구조 정리

브랜치 `task-folder-structure`(기준 `master` `b0dc369`). 작업 에이전트(Opus 5.5). `paseo.json`은 건드리지 않았다.

사진 효과와 인쇄를 붙이기 전에 `src/web/js/`에 평평하게 있던 17개 모듈을 역할과 의존 방향에 따라 하위 폴더로 나누고, 테스트 폴더도 같은 구조로 맞춘다. 참고 사례는 같은 회사 ThrowSnow 저장소의 같은 작업 로그(`003_ThrowSnow/docs/logs/2026-10-15-03-folder-structure.md`, 읽기만 함)다.

- **동작 변경 없음:** `git mv`와 경로 수정만 한다. 코드 로직·함수 이름·공개 API·파일 이름은 그대로다. 예외는 진입점 두 개(`js/main.js` → `main.js`, `css/app.css` → `style.css`)다.
- **하지 않는 것:** `src/web` → `public` 이름 바꾸기, `lib/`·`bin/`·`tools/`·실행 스크립트 구조 변경(경로 참조만 고침), `main.js`의 D 화면 분리 같은 리팩터링, 기능 변경, 새 의존성, push·병합.

## 분류 원칙

각 파일의 머리말 주석과 import를 읽고 **책임**과 **의존 방향**으로 나눴다. ThrowSnow처럼 순수한 모듈이라도 책임이 분명히 다른 폴더에 속하면 그 폴더에 둔다(예: `detector-keeper.js`). 폴더 깊이는 1단계이고, 파일이 1개뿐인 소스 폴더는 만들지 않는다.

| 폴더 | 담는 것 | 기준 |
|---|---|---|
| (`src/web/` 최상위) | `index.html`, `main.js`, `style.css` | 진입점과 페이지 스타일. CSS가 하나뿐이라 `css/`로 두면 1개짜리 폴더다 |
| `config/` | 설정값, 운영자 조절값의 검증·정규화·저장 형식, 조절값 파일 불러오기·저장 | "설정"이라는 한 책임. 다른 폴더를 import하지 않는다 |
| `core/` | DOM·카메라·MediaPipe·네트워크에 의존하지 않는 계산·상태 | **core는 같은 core와 `config`(순수한 파일)만 불러온다.** 지금 import가 이미 그렇다(core는 core만 부른다) |
| `camera/` | 브라우저 카메라 스트림, 카메라 상태 감시, 캔버스 캡처 | `getUserMedia`·`<video>`·캔버스를 다룬다 |
| `vision/` | MediaPipe 감지기 생성·재생성, 감지 루프 | 감지기에 관한 책임 |
| `ui/` | 운영자용 DOM 화면 | DOM 요소·포인터 이벤트를 다룬다 |

이동 후 의존 방향(실제 import 기준): `main.js` → 모든 폴더, `ui` → `config`, `camera`·`vision` → `core`, `config` 안에서 `settings-file` → `presence-settings`, `core` 안에서 `auto-start` → `session`, `session` → `log-limit`. 폴더 사이에 순환이 없고, `core`와 `config`는 바깥 폴더를 부르지 않는다.

쓰지 않은 이름: `utils/`(로그 제한 하나뿐 — 순수 모듈이라 `core`), `net/`·`storage/`(조절값 파일 클라이언트 하나뿐 — 설정 책임이라 `config`), `photo/`(캡처 하나뿐 — `camera`), `css/`(1개짜리).

## 분류표

| 현재 경로 (`src/web/`) | 새 경로 (`src/web/`) | 이유 |
|---|---|---|
| `index.html` | 그대로 | 진입점. `serve.ps1`의 `/` → `src/web/index.html`이 그대로 |
| `js/main.js` | `main.js` | 진입점. 화면 조립·단축키·D 화면 |
| `css/app.css` | `style.css` | 페이지 스타일 하나 |
| `js/config.js` | `config/config.js` | 바꿀 수 있는 값 한곳. import 없음 |
| `js/presence-settings.js` | `config/presence-settings.js` | 조절값 범위(`presenceLimits`)·저장 형식·검증·정규화. import 없음, 브라우저 API를 직접 쓰지 않음 — **애매:** 순수 함수라 `core`도 가능하고, 영역 이동·크기 계산(`moveRegion`·`resizeRegion`)도 같이 있다. 책임이 "운영자 조절값의 정의"이고 `settings-file`·조절 화면이 함께 쓰므로 `config`에 둔다. 파일을 나누지 않는다(리팩터링) |
| `js/settings-file.js` | `config/settings-file.js` | 조절값 파일 API 클라이언트와 시작할 때 불러오기 순서 — **애매:** 기본 `fetch`가 `globalThis.fetch`라 순수하지 않다. 하나뿐인 네트워크 모듈이라 따로 폴더를 만들지 않고 설정 책임으로 `config`에 둔다. 그래서 `config`는 폴더 전체가 순수하지는 않고, core 규칙 테스트가 core에서 닿는 파일마다 순수한지 본다 |
| `js/session.js` | `core/session.js` | 촬영 상태 기계. 시계·타이머·사진 함수를 주입받음(기본값 `globalThis` 타이머·`performance.now()`는 Node에도 있는 전역) |
| `js/auto-start.js` | `core/auto-start.js` | 인식 상태 → 상태 기계 연결, 레벨 판정 순수 함수. `session`만 import |
| `js/presence.js` | `core/presence.js` | 인식 판정 순수 함수(좌표 변환·인정 조건·안정화) |
| `js/guidance.js` | `core/guidance.js` | 관람객 안내 규칙 순수 함수 |
| `js/log-limit.js` | `core/log-limit.js` | 반복 오류 로그 제한 — **애매:** 공용 도구지만 순수하고(`console`·`Date`·`performance`만), camera·vision·core가 모두 부르므로 가장 아래 층인 `core`에 둔다 |
| `js/camera.js` | `camera/camera.js` | 장치 선택·스트림 열기·닫기 |
| `js/camera-monitor.js` | `camera/camera-monitor.js` | 카메라 상태 감시·자동 회복 |
| `js/capture.js` | `camera/capture.js` | 보이는 9:16 영역 캔버스 캡처·JPEG·Object URL — **애매:** 카메라 장치가 아니라 이미지 처리다. 사진 효과가 붙으면 `photo/` 같은 폴더로 나눌 수 있지만 지금은 1개짜리라 영상 프레임을 다루는 `camera`에 둔다 |
| `js/face-detector.js` | `vision/face-detector.js` | MediaPipe 사전 확인·생성·실패 정리·감지 |
| `js/detector-keeper.js` | `vision/detector-keeper.js` | 감지기 재생성·재시도·감지기 상태 — **애매:** MediaPipe를 직접 모르는 순수 모듈이라 `core`도 가능. 책임이 감지기 생명주기라 `vision`(ThrowSnow의 `render-support` 등과 같은 기준) |
| `js/presence-monitor.js` | `vision/presence-monitor.js` | 감지 루프·인식 상태 구독(축소 캔버스·`document` 기본값) |
| `js/presence-tuning.js` | `ui/presence-tuning.js` | 운영자 인식 범위 조절 화면(R) |
| `js/region-drag.js` | `ui/region-drag.js` | 인식 영역 포인터 끌기. DOM을 주입받지만 하는 일이 포인터 이벤트 처리라 `ui` |

## 테스트 폴더

`tests/` → `test/`. 하위 폴더는 소스와 같은 이름으로, 테스트의 주 대상 모듈 위치를 따른다. 테스트 폴더는 소스 위치를 그대로 비추는 것이 목적이라, 1개짜리라도 소스 폴더와 짝을 맞춘다(`test/camera/`, `test/tools/`).

| 현재 경로 | 새 경로 | 비고 |
|---|---|---|
| `tests/session.test.mjs`, `auto-start`, `presence`, `guidance`, `log-limit` | `test/core/` | `auto-start`는 실제 `session`·`capture`도 함께 쓴다 — 주 대상 기준 |
| `tests/capture.test.mjs` | `test/camera/` | |
| `tests/face-detector.test.mjs`, `detector-keeper`, `presence-monitor` | `test/vision/` | `presence-monitor`는 `auto-start`·`session`도 함께 쓴다 |
| `tests/presence-settings.test.mjs`, `settings-file` | `test/config/` | |
| `tests/presence-tuning.test.mjs`, `region-drag` | `test/ui/` | |
| `tests/browser-check-lib.test.mjs` | `test/tools/` | `tools/browser-check-lib.mjs` 대상 |
| `tests/helpers.mjs` | `test/helpers.mjs` | 여러 폴더 테스트가 함께 쓴다. `test/helpers/`로 두면 1개짜리 폴더 |
| `tests/fixtures/fake-vision-bundle.mjs` | `test/fixtures/fake-vision-bundle.mjs` | 원래 있던 폴더. 파일 이름으로 라이브러리 코드를 알아보므로 이름 유지 |

## 커밋

| # | 커밋 | 내용 |
|---|---|---|
| 1 | `290be6e` | 이 분류표(로그 초안) — 이동 전 |
| 2 | `f692512` | `git mv`만. 34개 모두 `R100`(내용 변경 없음). 이 커밋 하나로는 경로가 맞지 않아 동작하지 않는다 |
| 3 | `0ce8d1e` | 경로 수정 |
| 4 | `3ebe83e` | core 규칙 테스트 |
| 5 | (이 커밋) | 문서·로그 결과 |

## 경로 수정 (`0ce8d1e`)

- **ES module import:** 상대 경로는 옛 위치에서 대상 파일을 풀어 새 위치 기준으로 다시 계산했다(저장소 밖 임시 스크립트, `git show -M`의 이동표 사용). 예: `camera/capture.js`의 `./presence.js` → `../core/presence.js`, `main.js`의 `./config.js` → `./config/config.js`. 같은 폴더로 함께 옮긴 import(`./session.js`, `./camera.js` 등)는 그대로다. 앱 코드에 절대 경로 import와 동적 `import()` 경로는 없었다(`face-detector.js`의 동적 import는 `config`의 `/lib/…` 번들 경로라 그대로).
- **`index.html`:** `css/app.css` → `style.css`, `js/main.js` → `main.js`.
- **도구:** `tools/browser-check.mjs` 생성 실패 시나리오의 페이지 안 `import('/js/face-detector.js')` → `/vision/face-detector.js`. `tools/browser-check-lib.mjs` 머리말의 테스트 경로.
- **테스트:** import `../src/web/js/…` → `../../src/web/<폴더>/…`, `./helpers.mjs` → `../helpers.mjs`, `../tools/…` → `../../tools/…`. `face-detector.test.mjs`의 저장소 파일 읽기 `new URL('../lib/…')`·`'../tools/vendor-mediapipe.mjs'` → `'../../…'`, 가짜 번들 `./fixtures/…` → `../fixtures/…`.
- **`package.json`:** `test` 스크립트 `"tests/**/*.test.mjs"` → `"test/**/*.test.mjs"`.
- **주석:** 소스 머리말의 `Node 테스트: tests/<이름>.test.mjs` → `test/<폴더>/<이름>.test.mjs`(11곳), `config.js`의 `tests/face-detector.test.mjs`, 가짜 번들·`presence.test.mjs` 머리말.
- **확인만 하고 고치지 않은 것:**
  - `bin/server/serve.ps1`: `/` → `src/web/index.html`, 나머지 → `src/web/` 매핑이라 하위 폴더도 그대로 제공된다. 진입점 위치가 같아 변경 없음. 루트 `config/`(조절값 파일)는 URL로 제공하지 않으므로 `src/web/config/`와 겹치지 않는다(`/config/config.js` → `src/web/config/config.js`).
  - CSP: `'self'`라 같은 출처의 새 경로가 모두 허용된다(아래 브라우저 확인에서 CSP 위반 0).
  - `bin/*.ps1`·`*.bat`·`tools/vendor-mediapipe.mjs`: `src/web/js`·`tests/`를 참조하지 않는다.
  - `.gitignore`의 `/config/*.local.json`은 루트에 고정된 패턴이라 `src/web/config/`에 영향 없음.

## core 규칙 테스트 (`3ebe83e`)

`test/core-deps.test.mjs`(새 의존성 없음, `node:test`, 6개). 여러 폴더를 함께 보는 구조 검사라 `test/` 바로 아래에 둔다.

- 소스에서 주석을 버리고 문자열·템플릿 글자·정규식을 토큰으로 묶은 뒤(템플릿 `${…}` 안은 코드로 읽음), 정적 import·`export … from`·부수 효과 import·동적 `import()`를 뽑아 `core/` 파일마다 **전이적으로** 따라간다.
- **위반:** `core/`·`config/` 밖의 파일, `/lib/`·패키지 이름, 문자열이 아닌 동적 `import()`, 닿은 모든 파일의 브라우저 전역(`document`·`window`·`self`·`navigator`·`location`·`localStorage`·`fetch`·`WebSocket`·캔버스·이미지·미디어 생성자·`requestAnimationFrame` 등). 속성 접근(`obj.document`)과 객체 키는 제외, `globalThis.fetch`처럼 전역 객체의 속성은 포함.
- **허용:** 타이머·`performance`·`Date`·`console`·`URL`·`globalThis` — Node에도 있고, `session.js`·`log-limit.js`가 주입 가능한 기본값으로 쓴다.
- **`config`가 순수할 때만:** 폴더가 아니라 닿은 파일마다 검사하므로 `config/config.js`는 통과하고 `config/settings-file.js`(기본 `globalThis.fetch`)는 실패한다. 이 경우를 실제 파일로 확인하는 테스트를 넣었다.
- 지금 코드는 규칙을 어기지 않는다(core는 core만 부른다). 고친 코드 없음.
- **결함 주입 확인(되돌림):** 실제 core 파일 5곳을 잠시 바꿈 — `presence.js`에 `../config/config.js` import(허용 예상), `guidance.js`에 `document.title`, `log-limit.js`에 `import '../camera/camera.js'`, `session.js`에 `import('../vision/face-detector.js')`, `auto-start.js`에 `../config/settings-file.js` import → 위반 4건이 모두 보고되고(전이 경로 `auto-start → session → log-limit → camera` 포함), `config.js` import는 위반이 아님. `git checkout`으로 다섯 파일을 복원한 뒤 다시 통과.

## 검증

### Node 테스트 (이동 전후 비교)

- 이동 전(`b0dc369`): `npm test` **206개 통과**, 묶음 46.
- 이동·경로 수정 뒤(`0ce8d1e`): **206개 통과**, 묶음 46. 테스트 파일마다 `node --test --test-reporter=tap`으로 돌려 "파일 이름 :: 테스트·묶음 이름"(252줄)을 정렬해 비교 — **이동 전과 같음**(하위 폴더 테스트를 glob이 모두 찾음).
- core 규칙 테스트 추가 뒤(`3ebe83e`): **212개 통과**(206 + 6), 3회 연속. 이름 목록 차이는 `core-deps`의 8줄(테스트 6 + 묶음 2)뿐.

### 브라우저 확인 도구 (가짜 카메라)

- `npm run check:browser`: 이동 전(임시 worktree `b0dc369`) **7/7**, 이동 후 **7/7**, 종료 코드 0. 시나리오별 세부 값(결과 사진 1215×2160, 생성 실패 60초 타이머 1→1, 권한 허용 뒤 회복 259ms, 외부 요청·CSP·예외 0)이 같다. 생성 실패 시나리오가 새 경로 `/vision/face-detector.js`를 불러 통과했다.

### 실제 OBS 가상카메라 (임시 프로필 headless Chrome)

저장소 밖 임시 스크립트(CDP)로 이동 전(임시 worktree)과 이동 후를 같은 절차로 돌렸다: 페이지 로드 → `D` → `S` 한 사이클 → `R` 열기 → `R` 닫기 → `R` 열기 → `Esc` 닫기 → `D` 끄기. 이미지는 저장하지 않았다(앱 메모리 안에서만 캡처).

| 항목 | 이동 전 | 이동 후 |
|---|---|---|
| 미리보기 | `OBS Virtual Camera` 1080×1920, 재생 중, 반전 | 같음 |
| D 화면 | `status ready`, `preferred found`, `detector running, health ok`, `delegate GPU`, `guidance none`, `settings defaults (no file)` | 같음 |
| `S` 한 사이클 | countdown → result → cooldown → idle, `round 1 by key, completed 1`, 사진 자원 0 (`taken 1, released 1`), 캡처 1080×1920 | 같음 |
| `R` | 패널·영역 보임, 슬라이더 5개, 값 `0.050, 0.600, 0.70, 500ms, 1000ms`, `저장된 값과 같습니다`. `R`·`Esc` 모두 닫힘 | 같음 |
| 같은 출처 응답 | 25개 (`/`, CSS, `main.js` 포함 모듈 17, `lib/` 4, 404 2) | 25개, 새 경로 모두 200 |
| 400 이상 | `/local-api/presence-settings` 404, `/favicon.ico` 404 | 같음 |
| 콘솔 오류·경고 | 위 404의 "Failed to load resource" 2줄, MediaPipe `OpenGL error checking is disabled` 경고 1줄 | 같음 |
| 페이지 예외 | 0 | 0 |

- **404 두 건은 원래 동작이다.** `/local-api/presence-settings` 404는 조절값 파일이 없을 때 서버가 주는 정해진 응답이다(SYSTEM 1절 "조절값 파일 API", 앱은 기본값을 씀). `/favicon.ico`는 파일이 없어 이전부터 404다. 이동으로 생긴 404·콘솔 오류는 0이다. 지시의 "콘솔 오류 0, 404 0"과는 이 두 건만큼 다르다.
- OBS 화면에 얼굴이 잡혀 있어 확인 중 자동 회차가 함께 돈 실행도 있었다(확인 스크립트 첫 시도). 비교에 쓴 마지막 실행에서는 두 쪽 모두 `S`로 시작한 수동 회차(`by key`)를 확인했다.

### 실행 스크립트 (임시 설정)

- `%TEMP%`의 임시 `settings.ini`: `server_port=8897`, 임시 프로필, `kiosk=false`, 60,60 / 360×640 창, `obs_autostart=false`, `obs_stop_on_shutdown=false`. `cmd /c ""…\Launch.bat" -SettingsPath "…" < NUL"`를 숨김 창으로 실행.
- `Launch.bat` 종료 코드 0, 로그 `Server ready … 200`, `Chrome started (… kiosk=False)`, 임시 프로필 Chrome 12개. 서버 요청 기록에 `/style.css`, `/main.js`, `config/`·`core/`·`camera/`·`vision/`·`ui/`의 16개 모듈, `lib/` 4개가 모두 200, 404는 위 두 건뿐 — 실행 스크립트로 띄운 창이 새 구조의 페이지를 끝까지 불러왔다.
- `Shutdown.bat` 종료 코드 0, `Kiosk Chrome stopped: 9 process(es), forced 0`, 서버 종료. 사용자 OBS(PID 60536)는 처음과 끝이 같았다.
- **첫 시도는 확인 방식 문제로 실패했다:** `Start-Process -Wait`로 불러 자식 프로세스(서버·Chrome)까지 기다리느라 명령이 끝나지 않았고, 그사이 Chrome이 페이지를 요청하지 않고 사라졌다(서버 요청 기록 0줄). `Shutdown.bat`으로 서버를 정리하고 `-Wait` 없이 다시 실행해 위 결과를 얻었다. Chrome이 사라진 원인은 확인하지 못했다. 경로와 무관한 단계(페이지 요청 전)라 이번 작업의 영향은 아니라고 판단하지만 **미확인**으로 남긴다.

### 정리

- 확인 도구·임시 스크립트가 띄운 Chrome·서버 0, 임시 프로필(`photobooth-*`, `launch-profile`) 0, 임시 `settings.ini` 삭제.
- 저장소 `logs/`(원래 없던 폴더) 삭제, 루트 `config/` 없음(원래 없음), 비교용 임시 worktree 제거.

### 미검증

- 키오스크 화면(`kiosk=true`), 현장 PC, 사용자 실기 확인. 경로만 바뀌어 화면·동작 영향은 없다고 판단하고, 개발 PC의 이동 전후 비교로 갈음한다.

## 하지 않은 것

- `src/web` → `public`, `lib/`·`bin/`·`tools/`·실행 스크립트 구조 변경.
- `main.js`의 D 화면·결과 화면 분리, `presence-settings.js`의 영역 계산 분리 같은 리팩터링.
- `favicon.ico` 추가(404 없애기) — 범위 밖.
- `AGENTS.md` 수정. 아래 "질문"에 제안만 둔다.
- 과거 로그 수정(당시 경로 그대로).

## 기준 문서 반영

- `docs/SYSTEM.md`: 목차 2절, 1절 폴더 트리(`src/web/` 하위 폴더, `test/` 하위 폴더, 루트 `config/`와 `src/web/config/` 구분), 2절에 "폴더 규칙"(폴더 뜻·불러와도 되는 것·core 검사·`settings-file.js` 예외·테스트 폴더 규칙) 추가, 본문의 `js/…`·`css/app.css`·`tests/…` 경로 언급 전부. 제목 줄 변화는 새 `### 폴더 규칙` 하나뿐(전후 비교).
- `README.md`: 테스트 절의 `tests/` → `test/`(core 규칙 검사 포함), 문서 안내 표에 폴더 구성·규칙 위치.
- `docs/PROJECT.md`: 경로 언급 없음 — 변경 없음.

## 남은 문제

- **(애매, 오케스트레이터 판단)** `config/presence-settings.js`(순수, `core`도 가능)와 `vision/detector-keeper.js`(순수, `core`도 가능), `camera/capture.js`(사진 효과가 붙으면 `photo/` 후보). 사진 효과 작업 때 `capture.js`와 효과 모듈을 함께 새 폴더로 옮길지 다시 본다.
- **(참고)** `config/`는 폴더 전체가 순수하지 않다(`settings-file.js`). 규칙 테스트가 파일 단위로 잡아 주지만, `core`에서 `config`를 처음 부르게 되면 그 파일이 순수한지 확인해야 한다.
- **(참고)** `test/camera/`·`test/tools/`는 1개짜리 폴더다. 테스트 폴더는 소스 위치를 비춘다는 기준으로 두었다.
- **(참고)** 실행 스크립트 확인 첫 시도에서 Chrome이 페이지를 요청하기 전에 사라진 원인은 미확인(위 "실행 스크립트").

## 다음 작업

- 오케스트레이터 확인 → 검수 → `master` 병합. 이후 작업 지시의 파일 경로는 새 구조 기준(SYSTEM 1절 트리, 2절 "폴더 규칙").
- 그다음은 로그 14의 "다음 작업" 그대로다: 사용자 현장 실측, 사진 효과(TBD: 형식·처리 시간 목표), 인쇄 연동.

## 질문

1. `AGENTS.md`에 폴더 규칙 링크를 한 줄 넣을지(ThrowSnow는 오케스트레이터가 넣음). 안: "새 파일은 `docs/SYSTEM.md` 2절 '폴더 규칙'의 폴더(`config`·`core`·`camera`·`vision`·`ui`)에 둔다. `core/`는 DOM·카메라·MediaPipe·네트워크를 부르지 않는다(`test/core-deps.test.mjs`)." 작업 에이전트는 고치지 않았다.
2. 애매 분류 세 건(`presence-settings`, `detector-keeper`, `capture`)을 이대로 둘지.
3. `test/helpers.mjs`를 `test/` 바로 아래에 둔 것(1개짜리 `test/helpers/`를 피함)과 1개짜리 테스트 폴더(`test/camera/`, `test/tools/`)를 허용한 것이 괜찮은지.
