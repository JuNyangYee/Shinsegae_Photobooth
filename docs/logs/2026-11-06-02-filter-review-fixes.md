# 13단계 독립 검수 보완 — 원문 검산과 확인 상태 보존

## 범위와 채택

오케스트레이터가 독립 검수 4건을 모두 채택했다. 시작점은 작업 브랜치의 7d49ebd이며, 검수자는 코드를 바꾸지 않았다. 구현자는 이 작업 폴더에서만 수정·검증했다. master 병합/push, 추가 에이전트, 현장 원본 설정 수정은 하지 않았다. 기존 22항목(숫자 21 + 선택 1), oil2f 범위, 오프라인·Node 없는 현장 실행을 유지한다.

| 채택 지적 | 수정 전 재현 | 원인과 수정 |
|---|---|---|
| P1 서버 원문-후보 일치 보장 누락 | 실제 HTTP PUT에 공식 hash/fingerprint를 유지하고 default=1.5, label=not from source, strokeStep=빈 문자열을 제출해 200. 400 기대 assertion 실패 | 제출 지문 비교와 GLSL substring만 검사했다. 저장소의 제한된 C# 판독기가 서버가 받은 두 원문에서 전체 bundle을 독립 재추출하고, 서버 기준 엔진/UI 지문을 검증한 후 모든 속성을 재귀 대조한다. 서버 생성 객체만 보관한다. 빈/공백 GLSL도 거부한다 |
| P2 preset 의미 경계 누락 | 합성 원문 양쪽 sbr 1→2 또는 newOilValue:7 추가가 거부되지 않아 수정 전 테스트 실패 | preset 전체를 지문에서 제외하면서 tune 키만 검사했다. 지원 최상위 키를 명시하고 sbr=1을 요구한다. 지원 수치 변경은 계속 수용한다 |
| P2 HTML 실행 규칙 검사 누락 | levelApply 시작에 return; 삽입이 거부되지 않아 수정 전 테스트 실패 | HTML hash는 식별에만 사용했다. 설정 controller의 별도 uiFingerprint를 브라우저/서버에서 각각 계산하고 동봉 지원 지문과 대조한다 |
| P2 확인 시 미저장값 손실 | 실제 UI handler와 같은 next 적용 방식에서 저장 0.3/미저장 0.9가 확인 후 0.3이 되어 수정 전 테스트 실패 | check가 restore/saved를 반환했다. 확인은 renderer/settings를 변경하거나 반환하지 않는다. 시험판과 새 후보를 분리하고, 재확인 후에는 새 후보를 다시 시험해야 적용할 수 있다 |

수정 전 실패 기록은 ignored runtime/stage13-review/before-node.txt, before-http.txt에 남겼다. 작업 전 코드 백업은 같은 폴더 before-review.zip(7d49ebd)이고 최초 코드/현장 설정 백업은 runtime/stage13/backup에 유지한다. 로그에는 프레임이나 사진을 남기지 않았다.

구현 커밋: 4809315(서버 원문 검산·preset/UI 경계), 6cce301(미저장값·시험판 보존). 검증 도구·문서·이 로그는 후속 커밋으로 묶는다.

## 현재 검증 경계

- 서버: Windows PowerShell 5.1 + 기본 .NET Add-Type으로 **로컬** bin/server/filter-source.cs만 컴파일한다. 원문은 제한 리터럴/토큰 판독 대상이며 원격 JS·표현식·호출을 실행하지 않는다. 컴파일/파싱/검산 실패 시 400, 실행판 불변. 별도 Node 서버나 설치는 없다.
- 독립 재추출 대상: metadata(버전/날짜/두 hash/bytes/고정 출처), 엔진 fingerprint, uiFingerprint, controls 22개의 id/kind/label/help/min/max/step/options/default, preset 전체, layers/refine, level 6행, flowDefault, GLSL 7슬롯. 키 추가/삭제·자료형·배열 위치·값·문자열을 모두 대조한다. 검산 결과 캐시는 같은 다운로드에만 유효하고 새 확인 때 비운다.
- preset 지원 키는 label/sbr/layers/refine/strength/size/boil/fps/grade/level/tune, sbr 값은 1이다. tune은 지원 15키 전부가 필요하다. 숫자 변경은 기존 schema 한도 안에서 수용한다.
- HTML 지문은 const PER부터 해당 script 끝까지다. applyValues/applyTune/levelApply, 보간/경로 설정, memo 우선순위, 이벤트 연결, 공유값 로딩·초기화·embed 재적용을 포함한다. 별도로 파싱하는 데이터 선언 6개(PER_DEF/CTRL_BASE/CTRL/TUNE_ROWS/GRADE_ROW/LEVELS)는 마스킹한다. 주변 CSS/마크업의 변경이나 지원 수치 변경으로 전체 HTML hash가 달라져도 허용한다. 해당 controller의 지원 밖 실행 규칙 변경은 보류한다.
- 새 uiFingerprint는 기존 schema 1의 선택 필드로 저장판 오프라인 호환을 유지한다. **새 후보**에서는 서버가 두 지문을 모두 재계산·검증한다. 해시는 공식 서명이 아니다.
- 확인 정상/실패/연속 호출은 현재 미저장값을 유지한다. 시험 중 재확인은 시험 엔진·정의·수치를 유지하고 적용 버튼을 잠근다. 확인 실패 뒤 가져온 기본값도 현재 시험판 기준이다. 취소/닫기는 저장판 복원, 적용/이전판 복원은 명시 저장이다. 처리 중 중복 작업·저장·취소·기본값·복원을 거절하고 닫기는 완료 후 처리한다. 예전 효과 파일 저장 중에도 업데이트를 막는다.
- 엔진/정의/수치/previous를 한 파일로 flush 후 원자 교체하는 경로는 유지했다. 후보 무결성 검산으로 기존 저장·복원 원자성을 약화하지 않았다.

## 실제 원격판과 항목

2026-11-06 공식 두 고정 URL을 직접 HTTP로 다시 받아 확인했다. 최신 응답은 7f58eaa(원본 표기 2026-11-05), JS 135462바이트다. 모듈 SHA-256은 51816e9146ea1d90af0cd89a0faf2078a4b68ea023784b7ac3da70e495bde4ae, UI SHA-256은 a84c03395506577aef92c023dfe0a06f40be9c79f282a35d5917ce0bad87965e다. 새 설정 controller 지문은 4df48c3e79c63c97cdc79bcc02ee022ad377e8bf20391da58af825242056881b다.

수치 자체는 이전 구현과 동일하다. 전체 원본 식별자·종류·범위·값·연결은 SYSTEM 6절 대응표에 있다. 숫자 21개는 state 공통 6개 + OIL 14개(w 세 성분을 각각 집계) + GRADE.keepW 1개이고, state.style 선택을 더해 22개다. MOODS/캐릭터 mask 제외와 level→세부 사용자값 우선순위도 그대로다.

## 수행한 검증

| 검증 | 결과/조건 |
|---|---|
| Node 전체 | node --test test/**/*.test.mjs, 650/650 통과(기존 643 + 보완 7). 원문 경계, 후속 HTML 초기화 우회, 미저장값/시험판 보존, 재시험, 통신/호환 실패, 동시 작업 거부, 재시작/롤백·오프라인·응답 유실 모의를 포함 |
| 실제 PowerShell 함수 | node tools/filter-source-check.mjs runtime/stage13-review, 35/35. 실제 Invoke-FilterApi와 모의 요청 MemoryStream 사용. 공식 원문 전체 추출 동등성, 후보 21종 변조, preset 의미 2종, HTML 실행 규칙 3종 거부. strength/layers/refine/level 곡선/라벨·범위·step/세부 범위/지원 GLSL 변경 및 주변 표시 변경은 200으로 수용 |
| 실제 HTTP/브라우저 | node tools/filter-browser-check.mjs, 자기 서버·임시 프로필. 확인/시험/기본값/적용/재시작/롤백/재시작 통과. P1 재현은 200→400. header/Origin/메서드/크기/URL/revision/후보 변조/파일 잠금 실패 총 19검사 통과 |
| 미저장값 실제 UI | 저장 전 0.9: 확인·반복·통신 실패 후 보존. 시험 중 0.8: 재확인 후 보존, 재시험 전 적용 비활성, 재시험 후 보존. 시험 중 확인 실패 뒤 기본값은 시험판의 0.29. 닫으면 저장값 복원 |
| 실제 GPU·합성 입력 | 4조합×384/576점, 같은 프레임 반복 결과 동일. 숫자/선택 21항목 각각 화소 변화, fps는 15→7 cadence. 원문 전체 GLSL과 앱 이식 GLSL의 같은 합성 입력 비교 mean/max 차이 0. 컴파일 실패 시 기존 renderer 유지, dispose 후 자원 0 |
| 실제 카메라 | node tools/filter-browser-check.mjs --real --capture. OBS Virtual Camera 1080×1920, 감지기 GPU ok. 4조합 결과 1080×1350, 셔터 직전 동일 영역 블록 차이 0.374/0.021/0.339/0.304(0~255 스케일, 모두 1 미만). 원본 30fps/유화 12fps, 유화 끔 획 0, 흑백 결과 print 576×912·컬러 none. 페이지/촬영 2/2 통과 |

실제 HTTP는 실제 서버와 공식 다운로드를 사용했다. PS stream 검증은 네트워크 요청 흉내이며 HTTP 검증과 구분한다. 네트워크 실패는 브라우저 CDP 요청 차단 및 Node 예외 주입이다. 파일 잠금은 실제 Windows File.Replace 실패, 응답만 끊긴 경우와 시작 시 복구는 Node 모의다. 실GPU/OBS 결과는 구현자가 직접 수행했으며 독립 검수자의 수행으로 쓰지 않는다. 이전 전체 브라우저 25검사의 이력은 앞 로그에 있고 이번에 전체 25검사를 다시 실행한 것으로 세지 않았다.

## 원본 보존·정리

현장 원본 파일 전후 SHA-256 동일:

- camera: 650918f87be9b378c8ae53f686df3e0be97bec97955a26b85c939ace41da085f
- effect: eb5845e93ff497378a9366f95ae575bdf7489c6994ab5f7355a6e58a84b758b4
- presence: 6323e962500adb52111bc10b13163459c40a423163ba13e58ccc18e169404c75
- timing: 88e62fbf4b23ce38eac86a6f0d829e8f1d67f431598f99f588082574a656721c

master는 ca4237837741f48079b6b4fdf5a5884905b92ebf 그대로다. 테스트 서버·브라우저는 자기 PID만 종료하고 임시 프로필을 제거했다. 작업 폴더의 시험 설정은 기존 부재 상태로 복원했다. 다운로드 원문·임시 후보·검증 스크립트는 정리하고 수치만 있는 테스트 결과와 코드/설정 백업은 ignored runtime에 둔다. 실제 프레임 파일/스크린샷은 만들지 않았다.

## 남은 한계와 바로 다음 작업

- 독립 재검수는 아직 안 했다. 같은 검수자가 이 커밋의 서버 원문 대조·HTML 경계·상태 보존을 재검수하고 오케스트레이터가 통합 여부를 결정한다. 구현자는 보고 후 멈춘다.
- 실제 전원 차단, 하드웨어 네트워크 단절/전송 중 잘림, 원격 배포 중간 상태의 실서비스 재현, 사람/매트 현장 판정, 실카메라 4K·장시간 구동, 프린터 출력은 이번 미검증이다. 잘림/혼합 배포/오프라인/저장 응답 유실은 명시된 정적·모의 검사 범위다.
- 설정 controller의 기능 변경은 의도가 같아도 보수적으로 검토 필요가 될 수 있다. 지원 수치와 지원 GLSL 슬롯 변경 수용은 양쪽 파서로 확인했다. 공식 manifest/서명이 없으므로 hash는 공식 인증을 의미하지 않는다.
- 운영 복원은 E 필터의 이전판 복원. 저장판/이전판 모두 손상되면 앱 종료→filter.local.json 백업 후 제거→재시작하여 기존 effect.local.json과 기본 엔진으로 복귀한다. 현장 원본 설정을 덮어쓰지 않는다.
