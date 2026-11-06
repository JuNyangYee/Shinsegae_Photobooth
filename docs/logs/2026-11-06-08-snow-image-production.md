# 14단계 — 통합 장식 이미지 제작

## 범위와 현재 결과

- 내장 `image_gen`으로 기존 통합판 수정 1회, 좌표 가이드 기반 생성 1회, 상대 크기·배치 수정 1회를 수행했다. CLI/API·Python 이미지 편집은 사용하지 않았다.
- UI 코드와 부모 브리프는 수정하지 않았다. 실제 촬영 자료는 사용하지 않았다.
- 3차 결과를 후보로 보존한다. 사진 창 좌표와 완전히 일치하지 않으므로 원본을 전체 화면에 단순 확대하는 방식으로는 완료가 아니다. Opus와 표시 합성을 협의 중이다.
- 상단 문구와 그림 속 글자는 없다. 하단 눈바닥은 상태 안내와 카운트다운의 DOM 각인 표현을 위해 비웠다.

## 입력 역할

원본 참고는 외부 시퀀스 자산에서 읽기만 했으며 런타임 의존으로 쓰지 않는다.

1. `plate-layout-guide.png`: Opus 제공 위치·크기 규격. 그림 속 표기·선은 생성물에 넣지 않는다.
2. 부모 `exec-0f71d645-ae56-4e5e-9145-8dfc8ccd873d.png`: 1차 편집 대상, 배경·재질·포즈 참고.
3. `13_characters_3d_scale_lineup.png`: 공식 원형·복장·기립 키 103:66:60:27.
4. `01_pubilla_3d_turnaround.png`: 푸빌라 얼굴·몸·의상 원형.
5. 3차 편집 입력은 본인 2차 생성물 한 장이다.

각 입력을 `view_image`로 확인한 뒤 사용했다. 도구 참조는 회당 4개/3개/1개였다.

## 생성 결과와 선택 이유

원본은 Codex generated_images의 세션 `01a1b0c8-ed89-75a1-9880-1c3cd0a94326`에 유지한다.

- 1차 `exec-f5b9442c-06e0-4a0d-b8d1-1a981371e6c8.png`: 기존 상단 들보와 과대한 캐릭터 배치가 거의 유지되어 미채택.
- 2차 `exec-841521ec-b5b9-4c48-b067-cac1f1047911.png`: 가이드 중심 재생성. 여전히 상단 띠가 두껍고 푸빌라 손에 붉은 장갑을 추가해 미채택.
- 3차 `exec-931e0f16-6ac4-49bb-ad37-6fe8b40b19ec.png`: 상단 띠·캐릭터 축소, 푸빌라 손 흰 털로 복원. 현재 후보.

## 규격과 최소 확인

- 목표 캔버스 1080×1920(9:16), 카메라 x0~1080/y240~1590(4:5).
- 목표 들보 y222~258, y1572~1608. 얼음벽 y1608~1710, 눈바닥 y1710~1920.
- 실제 3차 파일은 **941×1672**다. 9:16과 약 0.053% 차이가 있다. 정확한 9:16 출력 요청이 도구 결과에 완전히 반영되지 않았다.
- System.Drawing 읽기 전용 픽셀 검사: 중앙열 x470에서 `G-max(R,B)>=140`인 영역 **y233~1322**, 1920 높이 환산 약 **267.6~1518.1**. 원본 편집·리샘플링은 수행하지 않았다.
- 추가 표본 x0/300/470/680/940의 키 영역은 각각 y233~1319/1321/1322/1322/1319다. 중앙 픽셀 RGBA는 (5,250,2,255)로 현재 키 임계값을 충족한다.
- 후보를 `src/web/assets/scene/snow-frame-plate.png`에 원본 바이트 그대로 복사했다(1,595,820바이트). 생성 원본은 유지했다. `git diff --check`에서 오류가 없었다.
- 육안: 푸빌라 양손 들보 위, 후트 앉아 한 팔 위로, 깨또 들보/얼음벽 윗면에 서서 손 흔듦, 포코 눈덩이. 네 캐릭터·복장·눈바닥·문자 없음 확인.
- 공식 상대 키는 프롬프트에 유지했으나 서로 다른 포즈·가림 때문에 결과의 정확한 기립 환산 척도는 미검증이다. 최종 사용자 원형 검수는 별도다.
- 코드 테스트·실제 카메라·브라우저 합성은 담당 범위 밖으로 수행하지 않았다.

## 실제 프롬프트

### 1차 — 기존 통합판 편집

```text
Use case: compositing. Edit the provided scene plate to obey the provided layout guide EXACTLY. Produce one opaque PNG, exact 9:16 portrait preferably 1080x1920.
Input 1 is the authoritative POSITION AND SIZE GUIDE. Replace its schematic blocks with finished 3D artwork. Never render its labels, colored outlines, or text.
Input 2 is the EDIT TARGET: retain its lovely snowy twilight village, depth of field, materials, lights, character poses and ice wall/snow-floor look, BUT its top beam is far too low and its characters too big.
Input 3 is official character identity and relative standing scale 103:66:60:27. Input 4 locks white bear identity.
CRITICAL EDIT: move TOP beam up to exactly 12.5% image height, move BOTTOM beam to exactly 82.8125% image height. The huge flat pure #00FF00 rectangle BETWEEN them must be 70.3125% image height. No green above upper beam or below lower beam. Do not retain the target's 20% top header! Header must be ONLY 12.5% height.
Coordinates on 1080x1920: top rustic thin wooden beam y222-258, bottom beam y1572-1608, both edge-to-edge with thin snow caps and warm tiny fairy lights. No side posts. Flat pure #00FF00 window x0-1080 y240-1590, beams overlap its edges by18px. No texture, gradient, shadows, scenery inside green.
Resize characters to the GUIDE boxes, SMALL edge decorations:
White bear upper left x50-330, y40-290: waist up BEHIND beam, both rounded mitten paws on beam, head gently tilted toward center. No waving or visible legs. Red/cream striped scarf. Its implied full standing height412px, head width140px. White bear must look like official reference, not generic round teddy.
Raccoon upper right x790-1010, y30-310: sitting on beam with dangling red socks/black shoes, one arm pointing upward, other resting on beam. Mustard pompom cap, black sweater, orange suspenders, green plaid pants and striped tail. Implied standing height240px.
Fox lower left x40-260, y1348-1612: TOTAL full body height264px ONLY. Feet on ICE WALL TOP, in front of lower wooden beam. One hand waves. Sage bobble scarf, pink striped sleeves, blue vest, brown culottes,yellow socks,black shoes,white tail tip.
Tiny squirrel x900-1040,y1466-1576: total height108px ONLY, sitting on lower beam holding snowball, pink plaid scarf, fluffy tail. Much smaller than fox.
The center x300-780 y330-1500 must be completely pure green; upper center x330-750 y20-220 only soft background, reserved empty. Upper background: softly blurred violet-blue twilight snowy village, faint peach horizon, warm golden window bokeh, matching edit target. Characters/wood/ice crisp; village blurred.
Ice block wall y1608-1710, with wooden beam resting atop. Below y1710 through1920 smooth lavender-lit snow ground completely empty for later DOM lettering. No letters, numbers, symbols, logos, footprints, snowfall, or watermark anywhere. Preserve target artistic quality while radically correcting geometry to guide. Exact 9:16 canvas.
```

### 2차 — 가이드 기반 생성

```text
Create a finished 3D Christmas photo-booth scene plate by rendering Image1's EXACT layout. Portrait 9:16 opaque PNG, 1080x1920. Image1 is strict spatial blueprint, Image2 official character identities/scale, Image3 bear design. NO text from references.
The design is dominated by ONE huge flat pure green rectangle from y258 to1572 spanning FULL width. That is 68.44% of total image height! Header is ONLY top 12.5% of canvas. Do NOT make a large header. Use exact guide proportions.
Top horizontal wood beam center y240, thickness36px, x0 to1080. Bottom beam center y1590, thickness36px. Both lightly snowy with tiny warm fairy lights. No vertical posts.
Above top beam: blurred snowy alpine village at blue violet dusk with faint peach horizon and warm golden lights, shallow depth of field. Header center x330-750 empty blurred background.
Place tiny detailed 3D characters as diagrammed:
Bear x50-330 y40-290: waist up behind top beam, paws resting atop beam, head tilted center. Official white bear face, red/cream knit scarf, mitten hands. Implied standing height412 but only upper half visible.
Raccoon x790-1010 y30-310: seated ON upper beam with dangling legs, one arm points upward. Mustard pompom beanie, black knit sweater, orange suspenders, green plaid pants, red socks, black shoes, striped tail. Implied standing240px. Smaller head than bear.
Fox x40-260 y1348-1612: 264px total height, standing on ice wall in front of bottom beam, hand waving. Official sage bobble scarf, blue vest, pink/white striped sleeves,brown culottes,yellow socks,black shoes,white-tip tail.
Squirrel x900-1040 y1466-1576: VERY TINY only108px tall, seated on lower beam holding snowball, fluffy tail/pink plaid scarf.
Maintain official standing height ratio bear103:fox66:raccoon60:squirrel27 and their original head/body proportions.
Below bottom beam: pale blue clear ice block wall y1608-1710. Below wall smooth lavender-white snow ground y1710-1920, empty no marks. Wood sits atop ice wall, fox feet rest on ice wall top.
All space between beams flat pure #00FF00 EXCEPT overlapping characters. No green elsewhere, no shadows/gradient/reflections in green. Central x300-780 y330-1500 completely unobstructed green.
Warm golden rim light/cool violet fill, crisp fur/knit/wood/snow, softly blurred background. NO letters numbers labels outlines titles logos or watermarks. Exact blueprint geometry is more important than large character presentation. Render the blueprint, do not reinterpret it.
```

### 3차 — 2차 판 크기와 배치 수정

```text
Edit this image's layout substantially. Output exact 9:16 portrait. Shrink the ENTIRE TOP illustrated strip (village, bear, raccoon, wood beam together) to TWO THIRDS its present height, anchored to the top edge. Preserve natural character proportions by shrinking characters uniformly in both dimensions; keep bear left and raccoon right. Top wooden beam must now sit at exactly ONE EIGHTH (12.5%) of canvas height, not at 18%. Extend the pure flat green upward to fill the newly freed area. White bear paws are WHITE FUR rounded mitt-shaped paws, NOT red gloves, remove red gloves. Bottom beam center must sit at 82.8125% of image height. Shrink fox and squirrel uniformly to 70% of their present sizes, keep feet anchored at bottom beam/ice wall top, fox left and squirrel right. Maintain original outfits, face identity, bear resting both paws, raccoon seated pointing up, fox waving, squirrel holding snowball. Preserve the bottom ice wall and empty snow floor aesthetic. No text. Most of image must be empty pure #00FF00 green. This is a layout correction, NOT a near-identical recreation. Top band must become dramatically thinner.
```

## 남은 문제와 바로 다음 작업

> 후속 처리: Opus가 원본 이미지를 유지한 채 상·하 띠 평행이동 합성을 적용하고 합성 화면을 확인했다. 간단 검수 후 `master`에 통합됐으며, 현재 기준과 남은 한계는 [09 통합 기록](2026-11-06-09-snow-frame-integration.md)에 있다. 아래는 이미지 담당 인계 시점의 상태다.

- 고정 카메라 창과 생성판 그린 경계 불일치가 남는다. 부모가 현재 생성판을 유지하고 Opus가 상·하 장식을 고정 카메라 창에 맞춰 표시 합성하는 방향을 승인·전달했다. 사진 비율 4:5는 유지한다.
- 후보 파일과 본 로그만 커밋하여 부모와 Opus에 전달한다. 표시 합성 검증 전 최종 채택으로 보고하지 않는다. master 병합·push는 하지 않는다.
