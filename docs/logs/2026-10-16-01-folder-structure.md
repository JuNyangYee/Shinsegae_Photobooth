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

## 커밋 나눔

1. 이 분류표(로그 초안) — 이동 전
2. `git mv`만(내용 변경 없음 → rename 100%). 이 커밋 하나로는 경로가 맞지 않아 동작하지 않는다
3. 경로 수정
4. core 규칙 테스트
5. 문서·로그 결과
