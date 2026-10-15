# 신세계 크리스마스 - 포토부스

스크린 앞 스윗스팟(발자국 매트)에 서면 자동으로 3·2·1 카운트다운 후 사진을 찍어 보여주는 **비접촉 웹 포토부스**다.

```text
스크린 앞에 서요 → 3·2·1 자동 촬영 → 특별한 사진으로 변해요 → 사진을 받아요
```

## 현재 상태

- 1단계(개발용 정적 서버, 9:16 좌우 반전 카메라 미리보기, 카메라 상태·자동 회복) 완료. 2단계(얼굴 감지) 진행 중이며, MediaPipe 라이브러리를 `lib/`에 두었다. 화면에는 아직 감지를 연결하지 않았다.
- 현재 개발 범위는 **카메라 촬영부터 결과 화면 표시까지**다. 사진 효과는 TBD, 인쇄는 이후 범위다.
- PC 한 대에서 로컬 웹 서버(`localhost`)를 띄우고, 같은 PC의 브라우저를 전체화면으로 사용한다.

## 개발용 실행

저장소 루트에서 Windows PowerShell 5.1로 서버를 띄운다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File bin\server\serve.ps1
```

- Chrome에서 `http://localhost:8765/`를 연다. 포트를 바꾸려면 `-Port 8800`처럼 붙인다.
- `127.0.0.1`이 아닌 `localhost`로 접속한다(`127.0.0.1`은 400). 루프백(같은 PC)이 아닌 주소로 들어온 요청은 403으로 거절한다.
- `OBS Virtual Camera`가 있으면 그 장치를, 없으면 기본 카메라를 사용한다.
- `D` 키: 개발용 정보(카메라 상태·오류 원인·재시도 횟수, 카메라 라벨, 실제 영상 크기, 9:16 영역 크기) 표시 토글
- 카메라가 끊기거나 열리지 않으면 화면에 "준비 중입니다" 문구를 띄우고 자동으로 다시 연결한다.
- 종료: 서버 창에서 Ctrl+C

## 라이브러리 갱신 방법 (개발 PC 전용, 현장 불필요)

MediaPipe 런타임·모델은 `lib/mediapipe/`에 커밋되어 있다. 현장 PC는 clone만 하면 되고 Node·npm·인터넷이 필요 없다. 버전을 바꿀 때만 개발 PC(Node 18 이상)에서 실행한다.

```powershell
npm install
npm run vendor:mediapipe
```

버전 변경, 해시 갱신, 검증 절차는 [docs/SYSTEM.md](docs/SYSTEM.md) 5절 "MediaPipe 로컬 라이브러리"를 따른다.

## 문서

| 문서 | 내용 |
|---|---|
| [AGENTS.md](AGENTS.md) | AI 작업 지침 |
| [docs/PROJECT.md](docs/PROJECT.md) | 체험 기획, 범위, 확정·가안·TBD, 단계별 계획 |
| [docs/SYSTEM.md](docs/SYSTEM.md) | 기술 구조, 촬영 상태, 감지 연결, 기술 제약 |
| [docs/logs/](docs/logs/) | 작업 로그 |
