# 신세계 크리스마스 - 포토부스

세로 스크린 앞 발자국 매트(스윗스팟)에 서면 자동으로 3·2·1 카운트다운 뒤 사진을 찍어 보여 주는 **비접촉 웹 포토부스**다. PC 한 대에서 로컬 웹 서버(`localhost`)를 띄우고 같은 PC의 Chrome을 전체화면으로 쓴다. 관람객은 화면을 만지지 않는다.

```text
스크린 앞에 서요 → 3·2·1 자동 촬영 → 회색조 유화 사진으로 변해요 → 사진을 받아요
```

**현재 상태:** 카메라 → 회색조 유화 미리보기 → 자동 촬영·결과 표시까지 구현, 인쇄 연동은 예정.

## 실행

**현장 PC** (Windows, Chrome, OBS Studio. Node·인터넷 필요 없음)

| 파일 | 하는 일 |
|---|---|
| `Launch.bat` | OBS(가상카메라, 꺼져 있을 때만) → 로컬 서버(창 없이) → Chrome 키오스크 순서로 띄운다. 다시 실행하면 이 프로젝트의 서버·키오스크를 닫고 새로 띄운다 |
| `Shutdown.bat` | 키오스크 Chrome(전용 프로필)과 로컬 서버만 종료한다. OBS는 `obs_stop_on_shutdown=true`일 때만 |
| `Setup-Startup.bat` | 로그인할 때 `Launch.bat`이 실행되도록 시작 프로그램 바로가기를 만든다(`-Remove`로 제거) |

첫 설치 절차(OBS 설정, 카메라 권한 허용, 인식 범위 조절)와 실패 시 로그 위치는 [docs/SYSTEM.md](docs/SYSTEM.md) 1절 "현장 실행 스크립트"를 따른다.

**개발 PC** (저장소 루트, Windows PowerShell 5.1)

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\server\serve.ps1   # -Port 8800 처럼 포트 변경
```

Chrome에서 `http://localhost:8765/`를 연다(`127.0.0.1`은 400). 종료는 서버 창에서 Ctrl+C.

## 운영자 단축키 (관람객용 아님)

| 키 | 동작 |
|---|---|
| `D` | 개발용 정보와 감지 박스 겹쳐 그리기 켜기·끄기 |
| `R` | 인식 범위·반응 속도 조절 화면 (`Esc`로도 닫음, 마우스 사용). 열려 있는 동안 자동 촬영을 막는다 |
| `E` | 사진 효과·출력·카메라 좌우 반전 조절 화면 (`Esc`로도 닫음). `R`과 같은 저장·닫기 규칙, 동시에 열리지 않음 |
| `S` | 수동 촬영 (대기 중이고 카메라가 준비됐을 때만). 사람이 없어도 끝까지 찍는다 |
| `X` | 강제 초기화: 어느 상태든 바로 대기로. 촬영 중지 수단이 아니다(멈추려면 `P`) |
| `P` | 자동 촬영 일시정지·다시 켜기. 저장되지 않아 재시작하면 다시 켜진다 |

`Ctrl`·`Alt` 등과 함께 누르면 무시한다. 조절 화면은 **저장**을 눌러야 파일에 남고, 저장하지 않고 닫으면 저장된 값으로 돌아간다. 자세한 규칙은 [docs/SYSTEM.md](docs/SYSTEM.md) 4절 "운영자 단축키".

## 설정 파일

- `settings.ini` — 현장 실행 설정(포트, Chrome·OBS 경로, 키오스크 등). 첫 실행 때 `settings.example.ini`에서 만들어지고 Git에서 제외된다. 키 표는 [docs/SYSTEM.md](docs/SYSTEM.md) 1절 "현장 실행 스크립트".
- `config/presence.local.json`, `config/effect.local.json` — `R`·`E`에서 저장한 운영자 조절값(Git 제외). **현장 PC를 옮길 때 두 파일을 복사한다.** 없으면 기본값으로 시작한다. 형식은 [docs/SYSTEM.md](docs/SYSTEM.md) 1절 "조절값 파일 API", 5·6절.
  - 저장한 파일이 있으면 그 값이 기본값보다 우선한다. 기본값이 바뀌어도(예: 2026-10-27 반응 속도 0.5·1초 → 0.25초) 그 PC에는 반영되지 않으므로, `R` "반응 속도"를 0.25초로 옮기고 **다시 저장**한다("기본값으로"는 영역·얼굴 크기·신뢰도까지 기본값으로 바꾼다).

## 테스트 (개발 PC 전용)

```powershell
npm test                                            # Node 테스트 (Node 22 이상, 설치 필요 없음)
npm run check:browser                               # 임시 프로필 headless Chrome으로 실제 앱 확인 (가짜 카메라)
npm run check:browser -- --camera real              # 실제 카메라 (OBS 가상카메라 우선)
npm run check:browser -- --soak --camera real       # 장시간 실측, 기본 10분 (--soak 60 처럼 분 지정)
```

`check:browser`는 몇 초 동안 `config/*.local.json`에 시험 값을 썼다가 되돌리므로 **현장 키오스크가 도는 PC에서는 실행하지 않는다.** MediaPipe 라이브러리는 `lib/mediapipe/`에 커밋되어 있고, 버전을 바꿀 때만 `npm install` → `npm run vendor:mediapipe`를 쓴다([docs/SYSTEM.md](docs/SYSTEM.md) 5절 "MediaPipe 로컬 라이브러리").

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI 작업 지침 |
| [docs/PROJECT.md](docs/PROJECT.md) | 체험 기획, 범위, 확정·가안·TBD, 단계 계획 |
| [docs/SYSTEM.md](docs/SYSTEM.md) | 시스템 구조, 폴더 규칙, 상태·규칙, 설정값, 기술 제약, 확인 도구 |
| [docs/logs/](docs/logs/) | 작업 로그 (결정 경위, 측정, 검증 기록) |
