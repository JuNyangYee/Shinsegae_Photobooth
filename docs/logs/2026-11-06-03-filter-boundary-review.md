# 13단계 재검수 보완 — 전체 선언 판독과 붓 schema 일치

## 범위·채택

af574e6 재검수에서 이전 1/2/4 해결, 3 부분 해결 판정을 받았다. 오케스트레이터가 잔존 N1과 신규 N2(P2)를 모두 채택했다. 이번 범위는 판독·검증 경계이며 UI/디자인/렌더 계산/카메라/현장 설정은 바꾸지 않는다. 작업 브랜치에서만 구현하고 병합·push·추가 에이전트는 하지 않았다.

| 항목 | 수정 전 직접 재현 | 원인 |
|---|---|---|
| N1 중복 oil2f 선언 | 공식 HTML CTRL 마지막에 oil2f:{strength:["OVERRIDE",0,9,0.1]}를 추가했다. JS는 첫 정의의 강도/max=1.6을 추출하며 승인했고, 실제 C# 독립 추출·Invoke-FilterApi도 200이었다. 거부 기대 검증 실패 | propertyAt이 첫 키에서 즉시 반환하고 uiSkeleton은 뒤 속성까지 포함한 CTRL 전체를 마스킹했다. JS 객체의 마지막 키 우선 의미를 놓쳤다 |
| N2 붓 배열 경계 | 공식 두 원문의 oil2f spacing 15→0 및 refine width 3.5→0. 원문 hash/bytes와 후보 preset을 맞춘 요청에서 JS는 붓 층 오류로 거절했지만 PS API는 각각 200이었다. 거부 기대 검증 실패 | PS가 0~200만 검사해 JS의 앞쪽 geometry 양수·200 미만 규칙과 달랐다. 적용 직전 재검사도 없었다 |

위 재현은 원격 코드를 실행하지 않았으며 파일 적용은 하지 않았다. ignored runtime/stage13-review2/before.txt에 실제 PS 실패를 남겼다. 시작 코드 백업은 같은 폴더 before-review.zip(af574e6), 기존 코드·현장 설정 백업은 앞 로그의 위치 그대로다.

## 변경

### N1: 검증한 선언만 마스킹

- JS/C# 모두 선언 전체를 끝까지 제한 판독한다. 첫 속성을 찾은 뒤 나머지를 버리지 않는다. 전체 객체가 검증된 후 대상 속성의 위치를 선택한다. UI 마스킹도 이 판독기가 검증한 선언의 start/end만 사용한다.
- PRESETS, PER, SLIDER_DEF, PER_DEF, CTRL_BASE, CTRL, TUNE_ROWS, GRADE_ROW, LEVELS와 참조 선언을 검사한다. 중첩 객체까지 중복 키를 거부한다. 식별자 oil2f, 큰/작은따옴표, 지원 Unicode escape로 적은 동일 키를 같은 이름으로 판독한다. 선언 자체 중복·명시/spread 간 중복도 거부한다.
- 공식의 정적 참조 SLIDER_DEF, NO_MATERIAL, CRAYON_ROWS, CRAYON_NORMAL, CRAYON_FLOW와 set/rows 경로만 제한 해석한다. 참조 대상도 끝까지 검사하며 순환 참조를 거부한다. 객체/배열 spread가 기대 종류와 다르거나 getter·계산 키·호출·미지원 참조·선언 뒤 표현식이면 검토 필요다. 일반 JS 실행기는 아니다.
- oil2f preset/control/level, PER/PER_DEF/SLIDER_DEF/CTRL_BASE의 관련 키 목록과 행 길이를 명시한다. 다른 매체의 정상 정적 키와 공식의 기존 참조 구조는 수용한다. 조절 항목 22개(숫자 21 + 선택 1)를 유지한다.
- 전체 원문 hash를 고정하지 않았다. 기존 모듈/HTML 동작 지문은 그대로이고 지원 수치·범위·라벨·층·보완 층·level·GLSL 변경은 계속 수용한다. 주변 표시 변경과 같은 키의 지원 따옴표 표기도 정상 수용했다.

### N2: 승인·활성화에 같은 schema

- C#의 Bundle 검증을 서버의 단일 schema 검사로 사용한다. Extract는 결과를 반환하기 전에 검사하고, PS Test-FilterBundle도 같은 함수를 호출한다. 별도의 느슨한 PS 붓 검사는 제거했다.
- 후보 제출뿐 아니라 적용 직전, 현재값 저장의 active bundle, 복원 대상 previous bundle을 다시 검사한다. 거부하면 기존 파일을 쓰지 않는다.
- 브라우저 validateBundle도 같은 규칙을 사용한다. 저장 문서 GET은 손상판의 previous 복구를 위해 그대로 전달하며, 브라우저는 각 저장 엔트리를 실행 전에 검증한다. 새 승인 bundle의 저장→읽기 round trip을 PS 및 HTTP에서 확인했다.

| 정의 | 길이 | 수치 규칙 | null |
|---|---|---|---|
| layers | 3층, 층마다 6개 | 앞 3개: 0 초과·200 미만, 나머지: 0 이상·200 미만 | 불가 |
| refine | 5개 | 앞 4개: 0 초과·200 미만, 마지막: 0 이상·200 미만 | 불가 |
| level | 기존 6행, 행 길이 4/7 | 0~100의 유한 숫자 | 중간 기준점(행 index 2)만 기존대로 허용 |

문자열·bool·NaN·Infinity는 붓 수치가 아니다. 0을 허용하는 보조값과 양수 geometry를 구분했고 정확히 200은 거부한다. 슬롯 개수도 양쪽에서 정확히 7개로 검사한다. 이 표는 Node와 PS가 공유하는 **테스트 입력/예상 결과**의 기준이며 제품 구현 함수를 복제해 기대값을 만들지 않았다.

구현 커밋은 8ad510d(N1 전체 선언 판독), 1a591d4(N2 schema·활성화 경계)다. 회귀 도구·문서·이 로그는 후속 커밋으로 묶는다.

## 검증

공식 고정 두 URL을 2026-11-06 다시 HTTP로 받았다. 7f58eaa(2026-11-05), JS 135462바이트. 모듈 SHA-256 51816e9146ea1d90af0cd89a0faf2078a4b68ea023784b7ac3da70e495bde4ae, HTML SHA-256 a84c03395506577aef92c023dfe0a06f40be9c79f282a35d5917ce0bad87965e로 직전과 동일하다. 공식 서명은 없다.

| 직접 수행 | 결과 |
|---|---|
| 수정 전 | N1 중복 CTRL, N2 spacing=0/refine width=0의 실제 PS API가 모두 기대 400 대신 200. N1 JS도 승인, N2 JS는 거절 |
| Node 전체 | 707/707 통과. 기존 650 + 선언 경계 26 + 붓 경계 30 + 비유한값 1. 기존 4건의 검수 회귀·미저장값·오프라인·복구 모의 포함 |
| 실제 PS 원문/API | node tools/filter-source-check.mjs runtime/stage13-review2. 91/91 통과(기존 35 + N1 26 + N2 30). 공식 원문 및 지원 수치/range/label/layers/refine/level/GLSL 변화 수용. N1/N2 원문 56종은 C# Extract 직접 결과도 JS와 대조 |
| 실제 PS schema/파일 | 붓 30종마다 apply/state-save/rollback 3전이(총 90), 성공 후 Read-FilterState와 재검증, 실패 후 파일 바이트 불변. NaN/±Infinity 3종도 거부. 요청은 MemoryStream 모의지만 PS 함수와 임시 파일 저장은 실제 |
| 실제 HTTP | node tools/filter-api-check.mjs. 15개 상태 assertion 통과: header/Origin/method/URL/size, geometry·default·빈 GLSL 변조 거부, 정상 후보 적용·저장·복원. 자기 PS listener를 3번 띄워 적용→프로세스 재시작→저장→복원→프로세스 재시작 후 상태가 같은지 확인. 받은 bundle을 JS validateBundle로 읽기 검증 |
| 최종 컴파일 확인 | C# 식별자 토큰 범위/PS 중복 코드 정리 뒤 공식 원문과 N1/N2 대표 3거부 재실행, 4/4 통과 |

새 HTTP 도구는 카메라·Chrome을 열지 않는다. 이 작업 폴더 filter.local.json만 백업/시험/복원한다. PS 전이 시험은 후보 검사를 우회해 잘못된 서버 메모리 후보/active/previous를 주입하여 **적용 경계의 방어를 별도로** 확인했다. 그 외 실제 HTTP 후보는 고정 공식 출처를 사용하며 upstream을 가로채지 않았다.

검수자의 재검수 수행(관련 Node 27/27, PS 모의 15, 상태복원 모의)은 이번 구현자 결과와 합산하지 않는다. 이번에는 실제 브라우저·GPU·카메라를 재실행하지 않았다. 해당 경로는 변경하지 않았고 직전 02 로그의 실측을 새 실측으로 세지 않는다.

## 문서·보존·정리

README 개발 검증 명령, PROJECT 단계 상태, SYSTEM의 전체 선언/지원 참조/붓 schema/저장 읽기 경계를 갱신했다. 기존 원본 22항목 대응표와 받은값/현장값 분리·MOODS/캐릭터 mask 제외·복원 절차는 유지한다.

현장 원본 설정은 읽기만 했다. 작업 후 hash가 02 로그와 같다: camera 650918f8…085f, effect eb5845e9…58b4, presence 6323e962…4c75, timing 88e62fbf…721c. master ca4237837741f48079b6b4fdf5a5884905b92ebf는 변경하지 않았다. 임시 서버는 자기 PID만 종료했고 설정은 원래 부재 상태로 복원했다. schema 임시 디렉터리·원문·후보 JSON은 정리하며 숫자 결과 로그와 코드 백업만 ignored runtime에 유지한다. 사진·프레임·스크린샷은 만들지 않았다.

## 남은 한계·바로 다음 작업

- 같은 검수자의 다음 독립 재검수 대기. 구현자는 작은 커밋과 clean 상태를 보고한 뒤 멈추며 오케스트레이터가 통합 여부를 결정한다.
- 파서는 전체 JavaScript 문법을 지원하지 않는다. 허용된 정적 선언/참조 밖 구조는 의미가 같아도 명확히 보류한다. 새 참조/새 oil2f 조절 항목/실행 규칙 변경은 별도 검토가 필요하다.
- 원격 배포가 실제로 깨지는 상황은 유발하지 않았다. 변형 원문은 개발용 합성 mutation, 실제 HTTP는 정상 공식 응답이었다. 실제 전원 차단·장치 네트워크 단절·4K/장시간·현장 사람/매트·프린터는 미검증이며 기존 한계 그대로다.
- 기존 잘못된 파일을 GET으로 읽는 것 자체는 승인으로 보지 않는다. 브라우저의 엔트리 검증/이전 정상판 복구를 유지한다. 두 판 모두 손상된 경우 앱 종료→filter.local.json 백업 후 제거→기존 효과 설정/기본 엔진으로 재시작하는 복원 절차는 SYSTEM과 같다.
