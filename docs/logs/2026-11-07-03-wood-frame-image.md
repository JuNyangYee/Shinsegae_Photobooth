# 16단계 — 좌우 여백과 연결된 나무틀 이미지

## 범위와 작업

- 깨끗한 작업 트리를 확인하고 `master f386920`에서 `stage16-wood-assets`를 만들었다.
- Opus의 정확한 3:4 창 좌표와 배치 가이드를 받은 뒤 내장 `image_gen` 편집 1회를 실행했다.
- 기존 압설 눈벽·캐릭터·배경 판을 바탕으로 좌우 기둥과 연결된 네 모서리, 기둥 바깥 DOF 눈마을 여백을 추가했다.
- 유화·파인 글씨는 런타임 처리다. 이미지에 글자·발자국·유화 필터를 굽지 않았다.
- CLI/API/Python 이미지 편집, UI·코드·현장 설정 변경은 하지 않았다. 실제 촬영 자료를 사용하지 않았다.

## 입력과 전체 프롬프트

입력을 직접 `view_image`로 확인했다.

1. 편집 대상: master의 `src/web/assets/scene/snow-frame-plate.png`, 15단계 압설벽 판(941×1672).
2. 구도 가이드: Opus의 `artifacts/stage16/wood-frame-guide.png`. 위치·크기만 참고하며 글자·상자·가이드선을 출력하지 않는다.
3. 공식 `13_characters_3d_scale_lineup.png`는 정체성·척도 확인용으로 열었으나 생성 입력에 추가하지 않았다.

내장 도구 `transparent_background=false`, 참조 2개.

```text
Use case: compositing.
Edit the existing Christmas photobooth plate (Input1) to the exact new spatial layout (Input2). Input1 supplies character identity, exact poses, relative sizes, materials, snowy village, opaque packed-snow wall, lighting. Input2 is ONLY a geometry guide: never render any labels, boxes, outlines or text from it.
Output one opaque portrait PNG, exactly 9:16, preferably 1080x1920. Do not squeeze or distort any character or the scenery.
NEW FRAME: ONE connected four-sided rustic wooden frame with joined log corners. On a 1080x1920 canvas: top beam x117-963 y342-378; bottom beam x117-963 y1422-1458; left post x117-153 y342-1458; right post x927-963 y342-1458. All wood approximately36px thick with the same warm wood grain as Input1. Snow caps on horizontal surfaces, warm fairy lights along horizontal beams and just a few on posts. No gap at any of the four corners.
CAMERA: exact 3:4 opening centered at x135-945,y360-1440, 810x1080. Beams/posts overlap its edge by18px. The entire interior is perfectly flat pure #00FF00, no texture/gradient/reflections/shadows. Only overlapping character portions remain opaque.
SIDE MARGINS: outside frame x0-117 and x963-1080 are REAL CONTINUOUS blurred snowy village/fir trees/sky matching the top scene, extending down to y1458. NO GREEN outside the wooden frame. Top background y0-342 remains blue-violet twilight village with warm golden bokeh and peach horizon, shallow DOF.
CHARACTERS: preserve Input1 identity/outfits/poses and same size relative to full canvas, MOVE only to the new frame. Bear upper-left x150-410, head aroundy150, leaning from behind top beam with both white rounded mitten paws on it. Raccoon upper-right x760-960 sitting on top beam, legs dangling, one hand pointing upward. Fox lower-left x60-280 in FRONT of left post, waving, feet at y1458 standing atop snow wall. Squirrel lower-right x800-930,y1320-1424 sitting on bottom beam holding tiny snowball. Do not enlarge mascots, keep official relative scale and faces. Leave central face zone x300-780 y460-1360 clear green.
BELOW: full-width opaque packed-snow block wall y1458-1560, two staggered rows with rounded pillowy edges and lavender-white snow grains exactly like Input1 (NOT glass or translucent ice). Frame posts rest on this wall. Beneath wall y1560-1920 broad EMPTY smooth snow floor with gentle violet shadows, no text or footprints.
No oil painting or brushstroke treatment; runtime applies that later. No letters, numbers, logos, UI, guides, falling snow, extra characters. Preserve current clean 3D artwork, fur, scarves and warm/cool lighting. The major change is enclosing the camera with joined side posts and visible background side margins, moving existing objects to the guide positions.
```

## 요청 규격

1080×1920 기준:

- 카메라 x135~945/y360~1440 = 810×1080, 정확 3:4.
- 위 들보 x117~963/y342~378, 아래 들보 x117~963/y1422~1458.
- 좌 기둥 x117~153, 우 기둥 x927~963, 둘 다 y342~1458.
- 압설 눈벽 y1458~1560, 빈 눈바닥 y1560~1920.
- 캐릭터 포즈·상대 크기 유지, 새 틀 위치로 이동. 중앙 얼굴 구역 x300~780/y460~1360 비움.

## 생성 결과와 경계 확인

- 원본 보존: generated_images 세션 `01a1b0c8-ed89-75a1-9880-1c3cd0a94326`의 `exec-9ddc025d-24ce-404b-abaa-f226560d3aed.png`.
- 실제 출력 **941×1672**, 정확 9:16과 약0.05% 차이. 생성 원본은 변형하지 않았다.
- System.Drawing 읽기 전용 픽셀 측정, 키 조건 `G-max(R,B)>=140`:
  - x250/470/600 열에서 y376~1289/1290/1289.
  - y500/800/1000 행에서 x108/109/108~831.
  - 대표 키 사각형(끝 제외) 약 x108~832/y376~1291. 1080×1920 환산 약 x124~955/y432~1482.
- 네 나무 변 중심선은 육안으로 원본 x≈88/852, y≈358/1313. 1080×1920 환산 x≈101/978, y≈411/1508. 눈·전구·나뭇결 때문에 기계적인 정확 중심선으로 보고하지 않는다.
- 요청한 창과 실제 생성 경계가 다르다. 원본 단순 전체 확대만으로 정확 3:4 좌표를 충족하지 않는다. Opus에게 실측과 원본을 전달해 균일 배율·평행이동·띠 이동으로 표시 합성이 가능한지 검토를 요청했다.
- 육안: 연결된 상하좌우 틀과 네 모서리, 기둥 바깥 마을, 불투명 압설블록 2단, 네 캐릭터 포즈, 빈 눈바닥·글자 없음 확인.
- 생성 편집으로 전체 화소가 재생성된다. 얼굴·옷·포즈는 유지되지만 정체성·크기의 픽셀 동일성은 보장하지 않는다. 곰의 화면 비중은 이전보다 다소 커 보이며 정확한 기립 환산 척도는 미검증이다.
- 실제 카메라·브라우저·런타임 유화 합성 및 출력은 이 이미지 작업에서 검증하지 않았다. 코드 테스트도 실행하지 않았다.

## 남은 문제와 바로 다음 작업

- Opus가 동일한 실측(그린 x108~831/y376~1290, 끝 포함)을 확인하고 생성판을 채택했다. 추가 생성하지 않는다.
- Opus의 표시 합성 계획: 균일 배율 1080/915≈1.180과 가운데 맞춤으로 개구부 높이를 y360~1440에 맞춘다. 좌우에 남는 약22px 그린은 기둥 나무를 거울처럼 이어 채워 정확한 3:4(x135~945)를 만든다. 원본을 찌그러뜨리지 않는다. 이 방식의 실제 구현·검증은 Opus 담당이며 본 자산 작업의 검증 결과가 아니다.
- 생성 원본 바이트 그대로 슬롯 PNG에 복사하고 본 로그와 두 파일만 커밋해 부모·Opus에 전달한다. master 병합·push는 하지 않는다.
