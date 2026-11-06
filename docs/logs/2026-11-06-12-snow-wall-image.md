# 15단계 — 압설 눈블록 벽 이미지 수정

## 범위와 결과

- 작업 트리가 깨끗함을 확인하고 `master 63d4687`에서 `stage15-snow-assets`를 만들었다.
- 내장 `image_gen`으로 기존 통합 장식판의 투명 푸른 얼음블록을 **불투명 압설 눈블록 2단**으로 수정했다. 둥근 모서리, 엇갈린 줄눈, 고운 눈 알갱이, 라벤더빛 흰 면과 부드러운 보라 줄눈 그늘을 반영했다.
- Opus와 생성 전에 분담을 합의했다. 전체 장면 유화와 발자국처럼 파인 동적 글씨는 **런타임 구현**이다. 그림에 유화·붓 필터·문자·발자국을 굽지 않았다.
- 생성은 1회이며 CLI/API/Python 그림 편집·후처리는 하지 않았다. 최종 파일은 생성 원본 바이트 그대로 `src/web/assets/scene/snow-frame-plate.png`에 복사했다.
- UI·필터 코드, 현장 설정, 이전 로그는 수정하지 않았다. 실제 촬영 자료는 없고 제공된 캐릭터 그림만 사용했다.

## 참고와 입력 역할

- 편집 대상: `master 63d4687`의 `src/web/assets/scene/snow-frame-plate.png` (14단계 `exec-931e0f16`, 941×1672).
- 형태·재질 참고: 시퀀스 자산의 `03_ThrowSnow/versions/v09/01_Keyframes/TS_IDLE_t003_r01.png`에서 캐릭터 앞 눈벽만 사용했다. 원본의 배치·캐릭터·바닥을 가져오지 않도록 지시했다.
- 같은 v09의 `TS_L4_THROW_t002_r01.png`도 직접 열어 벽 형태를 확인했으나 생성 입력에는 넣지 않았다.
- 두 참조와 편집 대상을 `view_image`로 직접 확인했다. 외부 시퀀스 프로젝트는 읽기 전용이며 저장소·런타임에 참조 원본을 복사하지 않았다.
- 생성 원본: Codex generated_images 세션 `01a1b0c8-ed89-75a1-9880-1c3cd0a94326`의 `exec-e5ee45b3-5a19-4a5d-8258-86fbfe6d6bee.png`. 원본은 유지한다.

## 최소 확인과 합의

- 실제 출력 **941×1672**, 이전판과 동일하다. 화면 9:16·카메라 4:5 및 기존 띠 맞춤은 Opus 구현에서 유지한다.
- System.Drawing 읽기 전용 측정, 키 조건 `G-max(R,B)>=140`:
  - 표본 x0/300/470/680/940의 시작은 모두 y233.
  - 끝은 새 판 y1318/1320/1322/1321/1319, 이전판 y1319/1321/1322/1322/1319. 변화는 0~-1px.
  - 중앙 x470,y800 RGBA=(5,250,4,255), 중앙 키 영역 y233~1322 유지.
- 육안으로 두 단 압설 블록·엇갈림·둥근 모서리·불투명 재질, 캐릭터 네 명의 포즈·크기·들보 위치·글자 없는 눈바닥을 확인했다.
- 벽 띠는 원본 기준 대략 y1357~1455/1456이다. 바닥과 눈이 부드럽게 이어져 정확한 하단 한 줄은 기계적으로 정의하지 않았다. Opus도 하단 약1455(화면 약1718)를 확인했고 바닥 글자 영역과 충돌 없다고 판단했다.
- **벽 밖 화소 완전 보존은 미달**이다. 벽 영역 y1355~1450 밖을 8px 간격으로 비교한 23,246표본 중 21,630표본에 바이트 차이가 있었다. 생성 도구가 미세 재생성했으므로 원본과 픽셀 동일하다고 보고하지 않는다.
- Opus가 위 수치와 결과를 확인해 **채택 가능**, 기존 띠 맞춤 값 유지, 벽 밖 미세 재생성은 육안 동일 조건으로 허용한다고 회신했다. 추가 생성하지 않는다.
- 실제 런타임 합성·유화·눈 글씨 검증은 Opus 담당이며 이 작업에서 코드 테스트·실제 카메라·브라우저 검증을 하지 않았다.

## 실제 전체 프롬프트

입력 순서: 1 편집 대상 통합판, 2 v09 IDLE 눈벽 참고. `transparent_background=false`.

```text
Use case: precise-object-edit.
Input1 is the EDIT TARGET, a 941x1672 photobooth plate. Input2 is a MATERIAL/SHAPE REFERENCE ONLY: use only its two rows of packed-snow blocks in front of the characters (approximately y1310-1530 in that reference). Do not transfer its characters, composition, background, or ground.
Edit ONLY the translucent blue ice-block strip directly underneath the LOWER wooden beam in Input1, approximately x0-940, y1355-1450. Keep the strip's top and bottom boundaries within 3 pixels of their current positions. Keep output exactly the same 941x1672 dimensions and framing.
Replace the ice with TWO ROWS of opaque compacted SNOW blocks like an igloo wall. Stagger the seams by half a block. Each row is half the strip height; each block about 2-2.5 times as wide as tall. Rounded pillowy corners, gently irregular packed-snow faces with fine snow grains and a few subtle sparkling particles. Lavender-tinted WHITE opaque snow, soft purple shadows in recessed snowy joints, faint warm golden light from the fairy lights along the top. This is sculpted and stacked snow, NOT white-colored glass: remove ALL transparency, clear ice facets, blue glass reflections and interior cracks.
PRESERVE EVERYTHING OUTSIDE THIS NARROW WALL STRIP unchanged: top sky/village, both wooden beams and lights, four characters' exact identity/outfits/pose/size/location, fox feet and squirrel on beam, flat chroma green window with original edges y233-1322, empty snow ground beneath wall. Do not crop, resize, move beams, change the green area, add green spill/shadow, add objects, letters, text, logos, footprints or watermarks.
Preserve the existing clean 3D render style. NO oil painting, NO brushstroke filter, NO painterly stylization: those effects will be applied later at runtime. Only change the ice wall into the two-row packed-snow wall.
```

## 남은 문제와 바로 다음 작업

- 자산과 이 로그 두 파일만 커밋해 부모·Opus에 전달한다. master 병합·push는 하지 않는다.
- Opus가 자산 커밋을 cherry-pick하고 기존 띠 맞춤으로 실제 표시·전체 씬 유화·눈 파임 글씨를 확인한다. 이미지에 유화가 중복 적용되지 않게 유지한다.
- 캐릭터 원형의 최종 사용자 검수와 실제 현장 화면·감열지 확인은 이 자산 작업에서 미검증이다.
