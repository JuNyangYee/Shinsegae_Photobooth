# 18단계 — 넓은 창·상하 캐릭터 이미지

## 범위와 채택

- 담당 변경은 `src/web/assets/scene/snow-frame-plate.png`와 이 로그 두 파일이다. UI·설정·기준 문서는 변경하지 않았다.
- 기존 17단계 이미지의 하단 집중 배치를 위 푸빌라·후트 / 아래 포코·깨또로 바꾸었다. 단일 가는 각재, 압설 눈벽 2단, 황혼·차가운 fill, 원경 DOF, 무필터 3D를 요청했다.
- Opus 디자인 리드의 목표는 1080×1920에서 창 x60~1020, y250~1530(960×1280, 3:4), 기둥36px, 위 들보38px, 벽 y1540~1690, 하단 안내 영역 비움이다.
- 실제 내장 `image_gen` 성공 생성은 3회다. 7개 참고 경로를 넣은 최초 호출은 최대5개 제한으로 생성 전에 실패했다. 이후 성공한 3회 외 추가 생성은 하지 않았다.
- Opus는 교정1의 캐릭터 척도·포즈·재질을 채택 수준으로 평가했다. 부모는 교정1 원본을 **바이트 그대로 납품**하도록 확정했다. PNG 띠분할·변형·재인코딩은 하지 않는다. 기하 맞춤은 Opus의 런타임 표시 코드 범위다.
- 기존 원본은 Git 이전 커밋에 보존되며 생성 도구 원본 3장도 삭제하지 않는다.

## 직접 확인한 참고와 역할

- 공식 `00_References/01_Project_Characters/01_pubilla_3d_turnaround.png`, `02_kkaetto_3d_turnaround.png`, `03_hoot_3d_turnaround.png`, `04_poco_3d_turnaround.png`, `13_characters_3d_scale_lineup.png`를 모두 직접 열어 확인했다. 척도103:66:60:27.
- Opus `artifacts/stage18/layout-guide-960x1280.png`: 구도·치수 전용. 가이드 글씨·박스는 결과에 넣지 않음.
- 사용자 눈벽 참고: `c5a443b6060e1867d974920fd80d23394ee58f6cc55289885a1f5ed738b5d720.png`. 압설 알갱이·2단 블록·조명·DOF 전용.
- 5개 입력 제한 때문에 초기 생성은 가이드·눈벽·푸빌라 턴어라운드·후트 턴어라운드·공식 척도표를 사용했다. 깨또·포코는 공식 척도표를 생성 입력으로 사용했다. 교정1은 초기 렌더·가이드·척도표, 최종 시도는 가이드·눈벽·척도표·푸빌라·후트 순이다.
- 실행 helper 시작 오류로 읽기·측정·복사·Git은 Paseo 터미널을 썼다. 이미지 제작은 실제 내장 image_gen만 썼으며, Python/Pillow/NumPy는 파일 읽기와 측정에만 썼다.

## 원본과 검증

생성 원본은 도구 기본 저장소 `generated_images/01a1bfbb-f8d7-7930-b3cf-f2dbf26ee45a/`에 있다. 앱은 저장소 안 자산만 사용하며 이 외부 경로에 의존하지 않는다.

| 순서 | 원본 파일 | 크기 | 키 bbox 포함 좌표 | 키 크기·비율 |
|---|---|---|---|---|
| 초기 | exec-b092431c-08f5-48ff-b269-2f70bdeaf2a6.png | 941×1672 | x82..857 y311..1233 | 776×923 / 0.840737 |
| **채택 교정1** | exec-1d2649f1-1783-40c0-a859-290523fb7d79.png | 941×1672 | x77..862 y310..1232 | 786×923 / 0.851571 |
| 최종 시도 | exec-ee1f1785-049b-4ca1-99a5-a85a4faf7b62.png | 941×1672 | x62..873 y302..1275 | 812×974 / 0.833676 |

- 키는 RGB를 정수로 읽어 `G - max(R,B) >= 140`인 화소 전체의 min/max로 측정했다. bbox는 양 끝 포함이다.
- 전체 비율 941/1672=0.562799로 9:16(0.5625)의 근사이며 정확한9:16이 아니다. **세 결과 모두 키 허용 비율0.75~0.77에 실패했다.**
- 채택본의 창 내부 x80..859가 전부 키인 연속 범위는 y321..984다. 후보 절단선 y400·y900에서 각각 x77..861이 키이고, 내부780화소 모두 키다. 이 줄에는 캐릭터가 없고 양옆 기둥·배경은 있다. 런타임 띠맞춤의 후보이며 합성 품질 보증은 아니다.
- 채택본 캐릭터 수동 시각 근사(자동 실루엣 분할 아님): 푸빌라 보이는 귀~앞발 y139..286 약147px(전신 가림), 후트 폼폼~부츠 y117..321 약204px(앉음), 깨또 귀~발 y986..1239 약253px, 포코 귀~발 y1113..1238 약125px. 가려진 푸빌라 전신과 앉은 후트의 서 있는 키는 실측할 수 없다.
- 채택본 눈벽 윗선 약y1244, 바닥 윗선 약y1413(수동 시각 근사). 깨또·포코 상대척도와 목표치는 완전 일치하지 않는다.
- 상하 배치·가는 단일 틀·2단 눈벽·무필터3D·글자/게이지 없음은 생성 결과를 직접 보아 확인했다. 카메라·인물 프레임은 생성/저장/사용하지 않았다.

## 실제 성공 호출 프롬프트

### 초기 생성

```text
Use case: compositing. Create one production photobooth scene plate, portrait EXACT 9:16 canvas (1080x1920 reference coordinates; scale all coordinates proportionally if resolution differs). Inputs: image 1 is the EXACT layout geometry guide ONLY; REMOVE all its labels, outlines and annotations. Image 2 is snow-block material / lighting / DOF reference ONLY, not composition. Image 3 is official Puuvilla turnaround. Image 4 is official Hoot turnaround. Image 5 is official identity and relative standing scale lineup, left to right white bear Puuvilla, fox Kkaetto, raccoon Hoot, tiny squirrel Poco, standing scale 103:66:60:27. Use lineup for exact Kkaetto and Poco anatomy/clothing too. No reference text should appear.

Rebuild a crisp unfiltered cinematic 3D render, absolutely no oil paint/painterly texture. An exceptionally large empty chroma-green rectangular photo opening occupies x60..1020 y250..1530 (960x1280, exact 3:4). This geometry is essential. Pure uniform #00FF00 only inside opening, zero shadows/gradients/snowflakes. Straight horizontal and vertical inner edges. Camera front-on, no perspective skew. One slender wooden frame: posts x24..60 and x1020..1056, top beam y212..250 (38 high), bottom rail y1530..1546 only 16 high. Single layer slender squared timbers, no double posts. Background visible in 24px strips outside posts. Thin dusting of snow on top beam.

FOUR characters distributed ABOVE and BELOW, never all below:
Puuvilla top LEFT: visible bounding area x100..440 y42..270. STANDING BEHIND top beam, only head, red/cream scarf and front paw visible above it, rest of body hidden behind beam. Normal official head proportions (full standing height would be 470). Head center x270, chin/scarf near y212, one paw resting on beam extends at most to y270. Gentle 3/4 face looking down inward.
Hoot raccoon top RIGHT: bbox x800..1000 y38..270. SITTING ON top beam with bottom at y214, seated height about 180 (standing scale274); yellow pompom hat, black sweater orange suspenders green plaid trousers. Boots dangle only to y270, tail toward right behind post, joyful smile.
Kkaetto fox bottom RIGHT: bbox x790..995 y1245..1552, standing feet y1550 on wall top, height301. Green chunky ball scarf, pink striped sleeves blue vest brown culottes, black gloves, normal official small head, smiling toward opening with one gently waving hand. Tail outside toward right.
Poco tiny squirrel bottom LEFT: bbox x100..235 y1425..1552, height123, standing on wall looking upward inward, cream belly red/cream scarf bushy rusty tail, hands together.
Never enlarge heads. Preserve actual official proportions, colors, clothing.

Keep central opening x200..880 y270..1230 COMPLETELY pure green: no characters, props or flakes. Character overlaps in corners are opaque with clean fur edges and NO green spill.

Wall y1540..1690: exactly TWO courses of opaque compressed snow blocks with rounded corners, visible compacted snow granules and seams like image2, top lightly covers bottom rail. Snow ground y1690..1920; x150..930 y1700..1880 must be calm evenly textured empty snow for later UI (NO actual UI, footprints or props). Distant snow village, roofs, pine trees and warm amber windows strongly defocused natural photographic bokeh, cool blue twilight sky and warm pink-orange sunset. Focus plane is frame, characters and wall upper course; natural depth falloff into foreground. Warm sunset key light plus cool sky fill. Full scene edge-to-edge on exact 9:16. No text, numbers, gauges, logos, watermark, people, additional characters, painted effects. Only green window is chroma key; remainder fully rendered opaque.
```

### 교정1 — 채택

```text
Edit image1, a photobooth plate. Image2 is exact intended geometry guide, not artwork; remove all its annotations. Image3 is official character scale and design. Preserve image1's snow material, sunset colors, lovely unfiltered 3D rendering, character identities and distributed two-above/two-below arrangement. Correct ONLY layout and character scale. Current image1 green window is too short/wide (776x923), characters too large. Target portrait canvas 1080x1920 EXACT 9:16 with pure-green opening x60..1020 y250..1530 =960x1280 EXACT3:4. Make the opening MUCH TALLER and wider until it occupies 88.9% canvas width and 66.7% canvas height; top edge 13.02% canvas height, bottom79.69%. This is the most important requirement. On image1's native 941x1672 coordinates that means x52..889,y218..1332. Slender single wooden posts 31px wide in native size, top beam native y185..218, bottom rail native y1332..1346. Extend green opening upward ~93px and downward ~99px and to both sides ~30px. No perspective.

Substantially SHRINK all four characters to exact native941x1672 approximate boxes: bear visible head/scarf/paw x87..383,y37..235 (body behind top beam, no full torso); seated raccoon x697..871,y33..235 (hat top33, butt on beam185, boots max235, smaller than bear); fox standing x688..867,y1084..1352, height262px; squirrel x87..205,y1241..1352,height107px. Official full standing scale103:66:60:27, no oversized heads. Bear head looking inward/down, raccoon laughing, fox lightly waving, squirrel looking upward. Entire central green region x174..767,y235..1071 must be unobstructed. Keep all green uniformly #00FF00. No shadows or gradients on green.

Snow wall native y1341..1472, exactly TWO rows compressed granular opaque snow blocks. Plain snow ground native y1472..1672, empty UI area x131..810 y1480..1637 without marks or props. Final target at ANY output resolution must preserve these percentages and especially green3:4 ratio. Do NOT merely repeat old geometry. No text, numbers, layout guides or watermarks. No painting filter. Keep natural photographic DOF, warm sunset/cool fill.
```

### 최종 시도 — 미채택

```text
Transform IMAGE 1 layout sketch into a finished cinematic 3D photobooth frame. IMAGE 1 is the EDIT TARGET: preserve its exact canvas aspect ratio, exact huge green rectangle size and location, exact slender brown frame positions, exact two snow wall courses and ground divisions. Do not redesign or move these edges. Remove EVERY label, number, bounding box outline and guide stroke. The full green rectangle behind these labels must become perfectly solid uniform #00FF00. It is an exact 3:4 opening, occupying 88.9% of canvas width, 66.7% of canvas height, starting at 5.56% from left and13.02% from top. The opening must stay this tall, NOT a square. Keep the tall9:16 canvas. Single thin natural wood frame, only3.3% canvas width for each post, thin top beam2% canvas height. Make the wood photoreal3D with light snow on its top.

IMAGE2 is ONLY material/lighting reference: granular opaque compressed snow blocks, TWO courses, snowy foreground, warm orange sunset and cool blue fill, snow village/pine/roof background with strong natural photographic defocus. Do not copy its layout. IMAGE3 is official character identity AND scale sheet, ignore its text. Image4 bear turnaround, image5 raccoon turnaround.

Put exactly four small characters in sketch's indicated corner areas, preserving ample empty green center: Top LEFT white bear BEHIND top beam, only normal-size head, striped red/cream scarf and front paw resting on beam. Head3/4 looking inward/down, body hidden. Top RIGHT small raccoon sitting ON beam, yellow pompom hat black sweater orange suspenders green plaid trousers; laughing, boots dangling only slightly to14% canvas height. Bottom RIGHT fox standing on wall, waving gently inward, green ball scarf blue vest pink striped sleeves brown culottes; entire standing height15.7% canvas height. Bottom LEFT tiny squirrel standing on wall looking upward, red/cream scarf bushy tail, entire height6.4% canvas height. Official relative standing heights bear103 fox66 raccoon60 squirrel27; bear hypothetical standing height24.5% canvas height, raccoon seated from hat to butt8.4% canvas height. Never giant heads. Their feet are at80.8% canvas height, except bear hidden behind beam and raccoon sitting up top. Top bear visible bbox x9.3..40.7%,y2.2..14.1%; raccoon bbox x74..92.6%,y2..14.1%. Fox x73..92%, squirrel x9.3..21.8%. Opaque characters may overlap green corners only. No green spill on fur.

Center x18.5..81.5% y14.1..64.1% must remain empty green. Snow wall spans80.2..88% canvas height, ground starts88%. Bottom snow center empty evenly textured for later UI. No text/logo/number/gauge/UI/footprints/extra props. UNFILTERED pristine3D, no oil paint. Focus on characters, wood and wall top, soft background bokeh. Above all KEEP EDIT TARGET geometry exactly, removing only guide ink and replacing flat materials with 3D scene.
```

## 남은 문제와 바로 다음 작업

- 원본 키 비율과 창 좌표는 요구 불일치다. 이미지 생성기가 상세 좌표·가이드 기하 보존 요청을 따르지 않았다. 조건을 충족했다고 보고하지 않는다.
- **런타임 합성·실제 카메라·최종 화면 필터·인쇄는 이 담당에서 미검증**이다.
- 다음 작업은 Opus가 채택본과 키 bbox·안전 절단선 후보로 런타임 띠맞춤을 구현하고, 얼굴 중앙 비움·상하 캐릭터 잘림·얇은 기둥·하단 안내 위치를 간단 확인하는 것이다. 부모가 검수와 통합을 맡는다. master 병합·push는 이 담당에서 하지 않는다.
