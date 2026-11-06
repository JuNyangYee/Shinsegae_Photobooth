# 13단계 — 카메라 oil2f 업데이트와 원본 조절 수치 동기화

- 날짜: 2026-11-06. 구현 브랜치 `stage13-filter-updates`, 기준 `ca42378`(WISHFUL HOLIDAY 채택판). 독립 기술 검수·통합은 오케스트레이터가 담당한다. 이 작업은 merge/push하지 않는다. 구현 커밋은 `eaca286`(원본 정의·렌더링)과 `bf6696d`(운영자/API)이며 마지막 문서/도구 커밋까지 순서대로 적용한다.
- 범위: 카메라에 입히는 oil2f 엔진과 조절 데이터. 디자인, 자동 촬영/인식, 카메라 보정, 흑백/인쇄, 기존 현장 설정은 유지한다. 갤러리 전체 매체 추가는 하지 않는다.

## 조사와 결정

- 지정 viewer의 README/updater/server/update UI, gallery-port, adapter, oil-stroke-fx, preset/level 및 baseline/candidates/history를 읽었다. viewer의 기존 strength/size/refine 유지 + 새 5개 수치 방식만 복제하면 요청에 모자라므로 공식 모듈과 루트 UI를 함께 판독하도록 구현했다. 참고 프로젝트는 수정하지 않았고 런타임에서 접근하지 않는다.
- PowerShell 고정 URL 다운로드 → 브라우저 비실행 리터럴 판독 → 정의/지원 GLSL 묶음 → GPU 시험 → 단일 원자 파일 저장 경로를 부모에게 보고하고 승인된 범위에서 진행했다. 별도 MOODS/캐릭터 mask는 제외한다. 최종 조사에서 mask 없이도 level에 영향을 주는 state.style을 확인해 부모에게 추가 보고했다.
- 공식 최신 HTTP 직접 확인: [모듈](https://nau-filter-gallery.vercel.app/nau-filter/nau-filter.js) `7f58eaa`, 2026-11-05 표기, 135462바이트, SHA-256 `51816e9146ea1d90af0cd89a0faf2078a4b68ea023784b7ac3da70e495bde4ae`. [루트 UI](https://nau-filter-gallery.vercel.app/) SHA-256 `a84c03395506577aef92c023dfe0a06f40be9c79f282a35d5917ce0bad87965e`. [show](https://nau-filter-gallery.vercel.app/show/) 36605바이트, SHA-256 `41b158bd74ae0154de6f660c61b8977d0c4f7ab8fa60a9311b4cd227e6bdad0c`도 확인했다. show는 모듈 소비 화면이고 수치 정의는 루트 UI에 있다. 공식 manifest/서명 없음. 해시는 공식 서명이 아니다.
- 전체 **22개 = 숫자 21개 + 그림체 선택 1개**. 숫자 21은 공통 6 + OIL 14(w 벡터 3성분 별도) + GRADE.keepW 1이다. [SYSTEM 전체 원본 키·종류·범위·step·default·연결 표](../SYSTEM.md#카메라-유화-수동-업데이트-13단계)를 기준으로 한다.
- 일반 6개 값: strength .29, size 1.23, boil .02, fps 15, grade 1, level 50. 세부는 w=[1.01,1.23,.72], len=1.68, jit=.096, bump=5.3, spec=.178, canvas=.023, refineT=.10, eye/edge/spill/slope=1, halo=0, keepW=1. style=flat(options flat/3d). 모든 수치는 원본 preset/PER/state에서 읽는다. JS의 초기 상수나 HTML input value를 실제 preset 값으로 오해하지 않는다.
- CTRL_BASE + CTRL.oil2f의 범위/라벨 덮어쓰기까지 추출했다(boil의 실제 표시명은 획 다시 놓기). strength/size는 갤러리 oil2f UI에서 숨기지만 현장 호환을 위해 노출한다. 별도 MOODS는 재료 뒤 색 톤 처리, normal/light는 캐릭터 번호 마스크 입력이 있어야 하는 분기다. 카메라 oil2f 범위에 포함하지 않았다. style은 포함하며 갤러리의 소스별 자동 선택과 카메라 모듈의 flat 기본을 구분한다.
- level 6행과 CR.tfmE, 붓 3층/보완 층을 함께 받는다. 원본 순서 snapshot → preset.tune → levelApply → memo.tune를 대조했다. 기본 refine의 .22보다 preset OIL.refineT .10이 우선한다. 현장 strength/size 직접 조절은 다음 level/style 변경까지 유지하며, 명시 OIL 세부값은 level 이후에도 우선한다.

## 구현

- `config/filter-source.js`: 제한 리터럴 parser, 선언/속성 범위 판독, 전체 22키 schema, 모듈·UI 배포 일치, 슬롯 밖 fingerprint. 임의 원격 JS는 실행하지 않는다. 신뢰하지 않는 원본 문구는 UI textContent로 표시한다.
- `filter-builtin.json`에 최신 필수 GLSL·정의를 동봉. 기존 기본 제공 엔진은 첫 명시 적용 전까지 그대로 쓴다. `filter-values.js`가 원본값/현장 덮어쓰기를 분리하고 기본값 변화·범위 충돌·level·style을 처리한다.
- `effect/filter-shaders.js`와 oil-renderer에 방향장·획 경로/폭·도움 함수·합성·덩이 지도 7슬롯 및 수치 uniform 연결. 미리보기와 결과는 같은 renderer/bundle/settings/seed/source texture 경로다. 감지 입력과 사진 크롭/회전·색 보정, 출력 단계는 기존 경로다.
- `filter-updates.js`는 로컬 상태 읽기, 명시 check, trial, apply, rollback, save를 직렬화한다. 시험/적용 직전에 실제 결과 크기로 warm render하며 컴파일/렌더 실패는 이전 엔진을 유지한다. 시작 로컬 복원 및 후보 시험 중 새 촬영도 차단한다.
- E 필터 영역에 확인·후보 시험·적용 저장·이전판 복원·가져온 기본값 적용과 데이터 기반 22개 조절 UI를 추가했다. 현재 현장값을 자동으로 원본 기본값으로 바꾸지 않는다. 취소/닫기는 엔진까지 복원하고 저장 중 닫기는 대기한다.
- `bin/server/filter-api.ps1`: 기존 HttpListener에 좁은 고정 경로만 추가. Node 런타임/새 서버 없음. 기존 Origin/Host/CSRF/메서드 방어 재사용, candidate 128KiB·나머지32KiB, 고정 두 URL GET만 허용. 서버도 후보 구조/숫자/슬롯/원본hash/GLSL 출처를 검사한다.
- `config/filter.local.json`의 active·previous 안에 엔진/정의/settings를 모두 넣고 한 번의 flush+File.Replace/Move로 확정한다. revision 경쟁은 거절한다. 이전 effect.local.json은 그대로 남고 필터 파일이 우선한다. 응답만 끊겼을 때는 state 재읽기로 결과를 확정한다. 시작 컴파일 실패는 previous 복원, 둘 다 실패하면 기본판으로 열고 저장을 보류한다.
- 원격 확인은 운영자가 버튼을 눌렀을 때만 한다. 부팅·평상시 촬영·복원에는 인터넷을 쓰지 않으며 사진/프레임/사용자 데이터를 원격 요청에 넣지 않는다. CSP는 변경하지 않았다.

## 검증

- `node --test "test/**/*.test.mjs"`: **643/643 통과**(기존 623 + 신규20). 합성 소스에서 실제 parser를 통과시켜 전체 키 대응, CTRL 덮어쓰기, 수치/범위/간격 변화, 선언 줄바꿈, 혼합 배포, unknown/삭제/중복/잘림/표현식 거절을 확인한다. 수치 테스트는 원본의 구체 expected 값과 level 우선순위를 대조한다.
- 상태 API/네트워크를 흉내 낸 단위 검증: 확인만 무변경, 시험 취소, 현장값 보존/새 기본값 적용, 오프라인 재시작, 저장 실패, 응답만 끊김, 시작 셰이더 실패/이전판 복원, 두 판 실패시 보류. 이는 실제 네트워크 단절·전원 차단 실험과 구분한다.
- `node tools/filter-browser-check.mjs --capture`: 임시 Chrome·실제 PS API에서 공식 원격 확인→시험→기본값→적용→페이지 재시작→이전판 복원→재시작 완료. 합성 입력만 사용한다. 합성 실행과 최종 실제 OBS 실행 모두 통과했다.
- GPU 합성 180×320: 원본·유화 × 컬러·흑백 ×384/576점 8조합에서 같은 source texture 반복 출력 동일, 유화 OFF 획0·인쇄 여부 확인. full-source GLSL을 비실행 리터럴로 별도 추출해 같은 CPU 획 목록/패스에 넣은 기준과 비교: RGBA 평균/최대 차 **0/0**. 원본 갤러리 전체 앱을 실행한 독립 비교는 아니며 이식 GLSL의 일치 검증이다.
- 실제 GPU 컴파일 오류를 주입해 기존 preview 엔진이 유지되고 renderStill이 계속 성공하는 것 확인. 사용한 GPU 객체는 dispose 뒤 liveResources=0. fps를 제외한 21개(숫자20+style선택)의 각각 변경에서 화소 차>0을 확인했다. 받은 fps15의 실제 그리기15장/초, fps7 조절 뒤7장/초도 합성 시계/실제 GPU로 확인했다.
- 실제 HTTP 12검사: header 없음403, 다른 Origin403, URL 주입400, 잘못된 method405, 본문초과413, revision경쟁409, 잘못된 후보400, 곡선 중복400, 원본에 없는 GLSL400, 정상 후보200, UI hash 없는 후보 ID 적용400, 파일 잠금으로 Replace 실패400 및 원래 bytes/revision 유지.
- `node tools/filter-browser-check.mjs --real --capture`: 실제 **OBS Virtual Camera 1080×1920**에서 최신판을 시험 적용했다. 인식기 GPU 정상. 4조합 결과 사진 1080×1350, 같은 셔터 그림 블록 차 photo-color .374 / photo-mono .021 / oil-color .339 / oil-mono .304(0~255, 모두1 미만). 원본 30/30·유화12/12장/초, 유화 획238305, 흑백 인쇄 데이터576×912·컬러는 없음. 카메라 프레임/사진은 저장하지 않았다. 이 실행 뒤 테스트 전 설정을 복원했다.
- 기존 전체 `node tools/browser-check.mjs`: **25/25 통과 집계**, 약579초. 이 중 운영자 스크린샷 항목은 `--screens` 미사용으로 도구가 skip 처리했다(화면 PNG 검수로 주장하지 않음). 임시 프로필·합성 카메라로 기존 디자인/인식/촬영/보정/설정/실패 회귀를 실행했다.

## 백업·정리·미검증

- 작업 시작 전 `runtime/stage13/backup/code.zip`에 기준 HEAD, 현장 원본 4개 설정을 읽어 작업 폴더 backup에 복사했다. runtime과 *.local.json은 기존 ignore 적용을 확인한 뒤 만들었다. 원본 설정 파일은 수정하지 않았다. SHA-256 전후가 4개 모두 일치했다(camera 650918…085f, effect eb5845…58b4, presence 6323e9…4c75, timing 88e62f…721c).
- 자체 서버/Chrome/임시 프로필은 도구 finally에서 종료·삭제, 작업 폴더 설정은 원래 bytes 또는 없음 상태로 복구한다. 원격 원문 임시 파일은 최종 정리에서 삭제하고 재현에 필요한 필수 정의/합성 fixture/도구만 커밋한다. 백업은 ignored runtime에 남긴다.
- **미검증:** 실제 사람/발자국 매트의 자동 시작·이탈 현장 실측, 4K·실제 설치 조명·장시간 부하, 실제 프린터 출력, OS 전원 차단 중 원자 저장. 합성 감지 입력·OBS 가상카메라 검증을 실제 사람 판정으로 보고하지 않는다. 낮은 previewScale은 같은 설정/프레임/구성이지만 결과 해상도와 화소가 같지는 않다.
- 범위 밖 upstream 코드/새 파라미터가 나오면 검토 필요로 멈춘다. 모든 미래 갤러리 변경을 무조건 자동 이식하는 기능은 아니다. 원본 라이선스/사용 권한 TBD는 기존과 같다.
- **복원:** E 필터의 이전판 복원 → 재시작. 저장 두 판이 모두 손상되면 앱 종료, filter.local.json 별도 백업 후 제거, 다시 시작하면 기존 effect.local.json과 기본 엔진. 작업 코드 기준은 ca42378/ignored backup이다.
- **남은 문제/바로 다음 작업:** 오케스트레이터의 독립 기술 검수. 채택·수정 여부를 기록한 뒤 통합한다. 현장 원본 설정에 최신판을 적용하거나 master 병합/push하는 것은 이 작업에서 하지 않는다.
