// 사진 효과 "유화 · 획 (세부 보존)" GLSL (WebGL2, GLSL ES 3.00).
//
// 출처: 같은 팀 동료가 만든 재료 필터 갤러리 https://nau-filter-gallery.vercel.app/ 프리셋 `oil2f` (2026-10-16 받은 배포 페이지).
//   배포 페이지에서 이식했다(원본 소스 저장소는 받지 못함). 원본이 바뀌면 다시 분석·비교한다 (docs/SYSTEM.md 6절)
//   원본 셰이더 VS, FS_GRADE, FS_SST, FS_BLUR, FS_TFM, VS_STROKE, FS_STROKE, FS_UNDER, FS_COMPOSE에서
//   oil2f가 실제로 지나는 분기(uMedium == 1 유화, 비교 위치 0, 노출 깜빡임 1)만 남겼다. 페이지에 라이선스 표기는 없다.
// 기법: Hertzmann 1998 "Painterly Rendering with Curved Brush Strokes of Multiple Sizes"(층 칠하기·오차 기준 보완 층),
//   구조 텐서(Sobel → 가우스 흐림 → 고유벡터)로 획 방향장. hash12는 Dave Hoskins "Hash without Sine"(MIT)과 같은 식이다.
//
// 원본과 다른 점 (기준 해상도 s = 1, 반전·크롭 없음이면 계산이 같다):
// - FS_GRADE: 소스를 uSrcOffset + vUV * uSrcScale로 읽는다 (9:16 cover 크롭과 좌우 반전. 원본은 vUV 그대로)
// - FS_UNDER: 밑칠 밉 단계 4.5를 uUnderLod로 받는다 (해상도 비례로 + log2(s))
// - FS_STROKE: 붓털 무늬 주기를 uBrisLen·uBrisWid(기준 해상도 값)로 받는다 (원본은 uLen·uWid)
// - FS_COMPOSE: 법선 세기를 uRelief(= 강도 × s)로, 캔버스 결 주기를 px / uPxScale로 계산한다
// - 출력 단계 FS_OUTPUT을 하나 더 둔다 (컬러 그대로 또는 회색조·레벨)
// - 감열지 출력 단계 FS_THERMAL_REDUCE·FS_THERMAL_DITHER·FS_THERMAL_SHOW (6-1, 원본에 없음. 계산은 core/thermal.js와 같다)
// - 흑백 스타일 (7-1, 원본에 없음): VS_STROKE·FS_STROKE가 높이 텍스처의 G에 "붓 결 선" 값을 더 쓴다(합성은 R만 읽어 색은 같다),
//   FS_BW_PREP(붓 높이 조명), FS_THERMAL_REDUCE의 국소 대비, FS_THERMAL_SCREEN(흐름 선·붓 결 선 문턱)

export const VS = `#version 300 es
const vec2 P[3] = vec2[3](vec2(-1.,-1.), vec2(3.,-1.), vec2(-1.,3.));
out vec2 vUV;
void main(){ vec2 p = P[gl_VertexID]; vUV = p*0.5+0.5; gl_Position = vec4(p,0.,1.); }`;

const COMMON = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform vec2 uRes; uniform vec2 uTexel;
float lum(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
`;

// 색 보정: 따뜻한 쪽으로 조금, 밝은 곳 압축, 아주 약한 갈색 섞기
export const FS_GRADE = COMMON + `
uniform sampler2D uSrc; uniform float uAmt; uniform vec2 uSrcOffset, uSrcScale;
void main(){
  vec3 c = texture(uSrc, uSrcOffset + vUV*uSrcScale).rgb;
  vec3 g = c*vec3(1.035,1.0,0.94);
  float l = lum(g); g = mix(vec3(l), g, 1.0);
  float k = 0.08; g = g*(1.+k)/(1.+k*g);
  g = mix(g, vec3(.15,.10,.07), .03);
  o = vec4(mix(c, g, uAmt), 1.);
}`;

// 구조 텐서: Sobel 기울기 → (gx², gy², gx·gy)
export const FS_SST = COMMON + `
uniform sampler2D uTex;
float L(vec2 d){ return lum(texture(uTex, vUV + d*uTexel).rgb); }
void main(){
  float tl=L(vec2(-1,1)), t=L(vec2(0,1)), tr=L(vec2(1,1));
  float l=L(vec2(-1,0)), r=L(vec2(1,0));
  float bl=L(vec2(-1,-1)), b=L(vec2(0,-1)), br=L(vec2(1,-1));
  float gx = (tr + 2.*r + br - tl - 2.*l - bl)*.25;
  float gy = (tl + 2.*t + tr - bl - 2.*b - br)*.25;
  o = vec4(gx*gx, gy*gy, gx*gy, 1.);
}`;

// 한 방향 가우스 흐림 (가로 → 세로 두 번)
export const FS_BLUR = COMMON + `
uniform sampler2D uTex; uniform vec2 uDir; uniform float uSigma;
void main(){
  vec4 s = vec4(0.); float ws = 0.; float R = ceil(2.*uSigma);
  for (int i=-12;i<=12;i++){ float fi=float(i); if (abs(fi)>R) continue;
    float w = exp(-fi*fi/(2.*uSigma*uSigma)); s += w*texture(uTex, vUV + fi*uDir); ws += w; }
  o = s/ws;
}`;

// 흐름장: 텐서의 작은 고유값 방향(형태를 따라가는 방향). 평평한 곳은 60도로 기운다. (cos, sin, 각도, 이방성)
export const FS_TFM = COMMON + `
uniform sampler2D uTex;
void main(){
  vec3 g = texture(uTex, vUV).xyz; float E=g.x, G=g.y, F=g.z;
  float disc = sqrt((E-G)*(E-G) + 4.*F*F);
  float l1 = .5*(E+G+disc), l2 = .5*(E+G-disc);
  vec2 t = vec2(l1 - E, -F);
  t = length(t) > 1e-9 ? normalize(t) : vec2(0.,1.);
  float A = (l1+l2) > 1e-9 ? (l1-l2)/(l1+l2) : 0.;
  float str = (E+G)/(E+G+4e-5);
  float w = clamp(A*str*1.3, 0., 1.);
  vec2 d = vec2(cos(1.0472), sin(1.0472));              // 평평한 곳의 기본 붓 방향 60도
  vec2 t2 = vec2(t.x*t.x - t.y*t.y, 2.*t.x*t.y), d2 = vec2(d.x*d.x - d.y*d.y, 2.*d.x*d.y);
  vec2 m2 = mix(d2, t2, w);
  float ang = .5*atan(m2.y, m2.x);
  o = vec4(cos(ang), sin(ang), ang, A*str);
}`;

const SBR_HEAD = `#version 300 es
precision highp float; precision highp int;
float hash12(vec2 p){ vec3 p3 = fract(vec3(p.xyx)*.1031); p3 += dot(p3, p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.-2.*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),u.x), mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),u.x), u.y); }
float lum(vec3 c){ return dot(c, vec3(.299,.587,.114)); }
`;

// 획 하나 = 인스턴스 하나. 중심에서 흐름장을 따라 앞뒤로 6마디씩 휘는 띠(삼각형 띠 14점).
export const VS_STROKE = SBR_HEAD + `
layout(location=0) in vec4 aS;                 // 중심 x,y (0~1), 난수 2개
uniform sampler2D uGrade, uTFM, uCanvas;
uniform vec2 uRes;
uniform float uLen, uWid, uLod, uDetMin, uJit, uErrT, uCell;
out vec2 vSt; out vec3 vCol; out float vR; out vec2 vSize; // vSize: 획 길이·굵기 px (붓 결 선, 7-1)
const int NSEG = 6;
void main(){
  int sec = gl_VertexID / 2; float side = (gl_VertexID % 2 == 0) ? -1. : 1.;
  vec2 c = aS.xy;
  bool keep = true;
  if (uErrT > 0.) {                                              // 보완 층 (Hertzmann 1998): 칸의 평균 오차가 문턱을 넘을 때만, 최대 오차 지점에 칠한다
    float sum = 0., best = -1.; vec2 bc = c;
    for (int j=-1;j<=1;j++) for (int i=-1;i<=1;i++){
      vec2 q = c + vec2(float(i), float(j))*uCell*.4/uRes;
      float e = length(textureLod(uGrade, q, uLod).rgb - texture(uCanvas, q).rgb);
      sum += e; if (e > best) { best = e; bc = q; }
    }
    if (sum/9. < uErrT) keep = false;
    c = bc;
  }
  vec3 col = textureLod(uGrade, c, uLod).rgb;
  float det = abs(lum(textureLod(uGrade, c, uLod).rgb) - lum(textureLod(uGrade, c, uLod + 2.5).rgb));
  if (uDetMin > 0. && det < uDetMin) keep = false;              // 세밀한 곳에만 가는 붓
  vec2 dir0 = texture(uTFM, c).xy;
  if (!keep) { gl_Position = vec4(2., 2., 2., 1.); return; }
  float t = float(sec)/float(NSEG) - .5;
  float L = uLen*(.75 + .5*aS.z), W = uWid*(.8 + .4*aS.w);
  vec2 p = c*uRes;
  float target = t*L, dist = abs(target), sgn = target < 0. ? -1. : 1.;
  vec2 dcur = dir0*sgn; float trav = 0.; float stepL = L/float(NSEG);
  for (int k=0; k<NSEG; k++){
    if (trav >= dist - 1e-3) break;
    float s = min(stepL, dist - trav);
    vec2 nd = texture(uTFM, p/uRes).xy;
    if (dot(nd, dcur) < 0.) nd = -nd;
    dcur = normalize(mix(dcur, nd, .7));
    p += dcur*s; trav += s;
  }
  vec2 tang = dist < 1e-3 ? dir0 : dcur*sgn;
  vec2 nrm = vec2(-tang.y, tang.x);
  float taper = mix(.55, 1., 1. - pow(abs(t)*2., 2.));
  p += nrm*side*W*.5*taper;
  gl_Position = vec4(p/uRes*2. - 1., 0., 1.);
  vSt = vec2(t + .5, side);
  vCol = clamp(col*(1. + (aS.z - .5)*uJit*2.)*vec3(1. + (aS.w - .5)*uJit, 1., 1. - (aS.w - .5)*uJit), 0., 1.);
  vR = aS.z*37.1 + aS.w*11.3;
  vSize = vec2(L, W);
}`;

// 유화 붓 한 획: 길이 방향 붓털 홈, 끝에서 물감이 갈라진다. 색(0번)과 높이(1번)를 함께 쓴다.
// 높이 텍스처의 G·B는 흑백 스타일(7-1)이 쓴다. 합성(FS_COMPOSE)은 R만 읽으므로 색 그림은 원본과 같다.
// - G "붓 결 선": 획 가로 위치를 선 주기(uLinePx)로 나눈 삼각파(0~1). 획마다 위상이 다르고 길이 방향으로 조금 흔들린다
// - B "획 볼록": 획 가운데 1, 가장자리·양 끝 0인 획 단위 높이. 원본 높이(R)는 붓털 무늬(약 2px)라 인쇄 해상도에서 평균되어 사라지므로,
//   흑백 준비(FS_BW_PREP)는 이 높이로 조명을 더한다
export const FS_STROKE = SBR_HEAD + `
in vec2 vSt; in vec3 vCol; in float vR; in vec2 vSize;
uniform float uBrisLen, uBrisWid, uLinePx;
layout(location=0) out vec4 oC; layout(location=1) out vec4 oH;
void main(){
  float u = vSt.x, av = abs(vSt.y);
  float a; vec3 col = vCol; float h = .5;
  float bris = vnoise(vec2(u*uBrisLen/2.2, vSt.y*uBrisWid*.45 + vR*13.));
  float edge = 1. - smoothstep(.72, 1., av + (bris - .5)*.4);
  a = edge*smoothstep(0., .06, u)*smoothstep(1., .9, u);
  a *= mix(1., step(.38, bris), smoothstep(.7, 1., u));       // 붓 끝에서 물감이 갈라진다
  col *= .92 + .16*bris;
  h = .3 + .6*bris*edge;
  a = clamp(a, 0., 1.);
  float ph = vSt.y*vSize.y*.5/uLinePx + fract(vR*.618) + .35*(vnoise(vec2(u*vSize.x/(uLinePx*3.), vR*7.)) - .5);
  float dome = (1. - av*av)*smoothstep(0., .25, u)*smoothstep(1., .75, u);
  oC = vec4(col, a); oH = vec4(h, abs(2.*fract(ph) - 1.), dome, a);
}`;

// 밑칠: 아주 흐린 색 보정 이미지, 높이 0.5
export const FS_UNDER = SBR_HEAD + `
in vec2 vUV;
uniform sampler2D uGrade; uniform float uUnderLod;
layout(location=0) out vec4 oC; layout(location=1) out vec4 oH;
void main(){
  vec3 b = textureLod(uGrade, vUV, uUnderLod).rgb;
  oC = vec4(b, 1.); oH = vec4(.5, .5, .5, 1.);
}`;

// 합성: 높이로 법선을 만들어 빛(왼쪽 위)·광택, 캔버스 결, 가장자리 어둡게
export const FS_COMPOSE = SBR_HEAD + `
in vec2 vUV; out vec4 o;
uniform sampler2D uPaint, uHgt;
uniform vec2 uRes, uTexel; uniform float uStr, uRelief, uPxScale;
vec2 px(){ return vUV*uRes; }
void main(){
  vec2 uv = vUV;
  vec3 c = texture(uPaint, uv).rgb;
  float h0 = texture(uHgt, uv).r, hx = texture(uHgt, uv + vec2(uTexel.x, 0.)).r, hy = texture(uHgt, uv + vec2(0., uTexel.y)).r;
  vec3 n = normalize(vec3((h0 - hx)*6.*uRelief, (h0 - hy)*6.*uRelief, 1.));
  vec3 Ld = normalize(vec3(-.5, .65, .8));
  float diff = dot(n, Ld), spec = pow(max(dot(reflect(-Ld, n), vec3(0.,0.,1.)), 0.), 22.)*.1*uStr;
  c = c*(.84 + .26*diff) + spec;
  vec2 q = px()/uPxScale/4.6;
  c *= 1. + .02*uStr*sin(q.x*6.2832)*sin(q.y*6.2832);
  vec2 d = vUV - .5; c *= (1. - .12*dot(d,d)*2.);
  o = vec4(clamp(c, 0., 1.), 1.);
}`;

// 출력 단계: 효과 결과 → 화면 또는 결과 사진(화면 밖). 지금은 그대로 통과한다.
// 감열지 출력용 흑백·디더링 패스를 붙일 때 이 셰이더를 바꾸거나 이 앞에 패스를 더한다.
// uFlipY: 결과 사진은 위아래를 뒤집어 그려 readPixels가 위 줄부터 읽히게 한다 (NEAREST 1:1이라 화소 값은 같다)
// 출력 단계의 회색조·레벨 (core/thermal.js levelOf와 같은 식): Rec.601 회색조 → 대비(0.5 중심) → 밝기 → 0~1 → 감마
const LEVELS = `
uniform float uBrightness, uContrast, uGamma;
float levels(vec3 c){
  float g = dot(c, vec3(.299,.587,.114));
  g = clamp((g - .5)*uContrast + .5 + uBrightness, 0., 1.);
  return pow(g, 1./uGamma);
}`;

// 출력 단계: 합성 결과 → 화면 캔버스 또는 결과 사진용 화면 밖 대상. uGray 1이면 회색조·레벨 (출력 모드 'gray')
export const FS_OUTPUT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uImage; uniform float uFlipY, uGray;
${LEVELS}
void main(){
  vec2 uv = vec2(vUV.x, uFlipY > .5 ? 1. - vUV.y : vUV.y);
  vec3 c = texture(uImage, uv).rgb;
  o = vec4(uGray > .5 ? vec3(levels(c)) : c, 1.);
}`;

// 감열지 1: 합성 결과(W×H) → 회색조·레벨 → 인쇄 해상도로 면적 평균. 출력은 (Pw/4)×Ph RGBA8에 가로 4점씩 묶는다
// (텍셀 i의 r·g·b·a = 점 4i..4i+3). 화소로 읽을 때 4분의 1만 옮기고, 읽은 바이트가 그대로 점 순서다.
// 점 하나가 덮는 원본 구간 [x·s, (x+1)·s)와 겹친 넓이로 가중 평균한다(s = 원본/인쇄, 576이면 1.875). 위아래는 GL 방향(아래 원점)
// 흑백 스타일(7-1)이 톤 점이 아니면 합성 결과 대신 FS_BW_PREP의 밝기(uPrep, 밉)를 읽고 국소 대비를 더한다:
// v + uLocal·(v − 밉 uLocalLod의 v). 흐린 쪽은 밉(상자 평균 + 삼선형)이라 GPU에서만 계산한다(회색을 읽어 CPU가 점을 다시 확인한다)
export const FS_THERMAL_REDUCE = `#version 300 es
precision highp float; precision highp int;
out vec4 o;
uniform sampler2D uImage, uPrep; uniform vec2 uScale; uniform float uUsePrep, uLocal, uLocalLod;
${LEVELS}
float levels1(float v){
  v = clamp((v - .5)*uContrast + .5 + uBrightness, 0., 1.);
  return pow(v, 1./uGamma);
}
float srcGray(int sx, int sy, ivec2 n){
  if (uUsePrep < .5) return levels(texelFetch(uImage, ivec2(sx, sy), 0).rgb);
  float v = texelFetch(uPrep, ivec2(sx, sy), 0).r;
  float m = textureLod(uPrep, (vec2(sx, sy) + .5)/vec2(n), uLocalLod).r;
  return levels1(v + uLocal*(v - m));
}
float dotGray(int x, int y){
  vec2 a = vec2(float(x), float(y))*uScale, b = a + uScale;
  ivec2 n = textureSize(uImage, 0);
  int x0 = int(floor(a.x)), x1 = min(int(ceil(b.x)), n.x);
  int y0 = int(floor(a.y)), y1 = min(int(ceil(b.y)), n.y);
  float sum = 0., wsum = 0.;
  for (int j = 0; j < 12; j++){
    int sy = y0 + j; if (sy >= y1) break;
    float wy = min(b.y, float(sy + 1)) - max(a.y, float(sy));
    for (int i = 0; i < 12; i++){
      int sx = x0 + i; if (sx >= x1) break;
      float w = wy*(min(b.x, float(sx + 1)) - max(a.x, float(sx)));
      sum += w*srcGray(sx, sy, n);
      wsum += w;
    }
  }
  return sum/wsum;
}
void main(){
  ivec2 f = ivec2(gl_FragCoord.xy);
  int x = f.x*4;
  o = vec4(dotGray(x, f.y), dotGray(x + 1, f.y), dotGray(x + 2, f.y), dotGray(x + 3, f.y));
}`;

// 감열지 2 (문턱값 디더, GPU): 8비트 회색 g와 8비트 문턱 t(core/thermal.js thresholdMap)를 정수로 비교해 g >= t면 흰 점.
// 문턱 지도는 위 줄부터 올리므로 점 좌표도 위 원점(y = Ph-1-행)으로 읽는다. CPU ditherThreshold와 비트 단위로 같다.
// 출력은 회색과 같은 묶음((Pw/4)×Ph, 4점씩, 0/1, GL 방향). 결과 사진은 이것을 읽고, 화면은 FS_THERMAL_SHOW로 확대한다
// uFull 1이면 문턱이 타일이 아니라 인쇄 해상도 전체(FS_THERMAL_SCREEN 결과, 같은 묶음)다 (흐름 선·붓 결 선, 7-1)
export const FS_THERMAL_DITHER = `#version 300 es
precision highp float; precision highp int;
out vec4 o;
uniform sampler2D uGray, uThr; uniform float uFull;
float packed(sampler2D s, int x, int yGL){
  return dot(texelFetch(s, ivec2(x >> 2, yGL), 0), vec4(equal(ivec4(x & 3), ivec4(0, 1, 2, 3))));
}
float white(int x, int yGL){
  int h = textureSize(uGray, 0).y;
  ivec2 n = textureSize(uThr, 0);
  float g = floor(packed(uGray, x, yGL)*255. + .5);
  float t = uFull > .5 ? floor(packed(uThr, x, yGL)*255. + .5)
    : floor(texelFetch(uThr, ivec2(x % n.x, (h - 1 - yGL) % n.y), 0).r*255. + .5);
  return g >= t ? 1. : 0.;
}
void main(){
  ivec2 f = ivec2(gl_FragCoord.xy);
  o = vec4(white(f.x*4, f.y), white(f.x*4 + 1, f.y), white(f.x*4 + 2, f.y), white(f.x*4 + 3, f.y));
}`;

// 흑백 스타일 준비 (7-1, 톤 점이 아닐 때): 합성 결과의 밝기에 획 볼록(높이 B)의 조명을 곱한다(그리는 해상도, 밉을 만든다).
// 빛은 합성과 같은 왼쪽 위. 기울기는 uStep 텍셀 떨어진 차이로 잰다(획 크기 무늬). 평평하면 1이라 톤은 거의 그대로다
export const FS_BW_PREP = SBR_HEAD + `
in vec2 vUV; out vec4 o;
uniform sampler2D uImage, uHgt; uniform vec2 uTexel; uniform float uRelief, uStep;
void main(){
  float v = lum(texture(uImage, vUV).rgb);
  vec2 d = uTexel*uStep;
  float hx = texture(uHgt, vUV + vec2(d.x, 0.)).b - texture(uHgt, vUV - vec2(d.x, 0.)).b;
  float hy = texture(uHgt, vUV + vec2(0., d.y)).b - texture(uHgt, vUV - vec2(0., d.y)).b;
  vec3 n = normalize(vec3(-hx*uRelief, -hy*uRelief, 1.));
  vec3 L = normalize(vec3(-.5, .65, .8));
  v *= (.84 + .26*dot(n, L))/(.84 + .26*L.z);
  o = vec4(vec3(clamp(v, 0., 1.)), 1.);
}`;

// 흑백 스타일 문턱 (7-1, 흐름 선·붓 결 선): 인쇄 점마다 8비트 문턱 t(1..255)를 만든다. 출력 묶음은 회색과 같다((Pw/4)×Ph, 4점씩, GL 방향).
// - 붓 결 선(uStyle 1): 높이 텍스처 G(FS_STROKE의 획 가로 삼각파)를 점 가운데에서 읽는다
// - 흐름 선(uStyle 0): 흐름장(tfm)을 따라 앞뒤로 uSteps점씩 값 잡음(주기 uLine점)을 평균한다(LIC). 평균은 0.5 둘레에 몰리므로
//   표준편차 uLicSigma로 정규 분포 누적함수를 근사해 0~1에 고르게 편다
// 두 경우 모두 선 값 u에 블루 노이즈 문턱 b를 (1−uMix):uMix로 섞고, 두 균일 분포 합의 누적함수로 다시 고르게 편다(톤 보존).
// 그래서 회색 g의 흰 점 비율 ≈ g/255이고, 선은 어두울수록 굵어진다. 회색 비교는 FS_THERMAL_DITHER(uFull 1)가 한다
export const FS_THERMAL_SCREEN = SBR_HEAD + `
out vec4 o;
uniform sampler2D uHgt, uTFM, uBlue; uniform vec2 uPrint; uniform float uStyle, uLine, uMix, uLicSigma, uSteps;
float uniformSum(float w, float a){ // a·U1 + (1−a)·U2의 누적함수 (a ≥ 0.5)
  float c = 1. - a;
  if (c <= 0.) return w;
  if (w < c) return w*w/(2.*a*c);
  if (w < a) return (w - c*.5)/a;
  return 1. - (1. - w)*(1. - w)/(2.*a*c);
}
float normCdf(float z){ return 1./(1. + exp(-1.5976*z - .07056*z*z*z)); } // 정규 분포 누적함수 근사
float blueAt(vec2 q){ // 블루 노이즈 문턱 지도(0~1)를 쌍선형으로 읽는다 (타일). 낮은 주파수가 없어 결이 고른 간격으로 남는다
  ivec2 n = textureSize(uBlue, 0);
  vec2 f = q - .5, i = floor(f), t = f - i;
  ivec2 a = (ivec2(i) % n + n) % n, b = (a + 1) % n;
  float v00 = texelFetch(uBlue, a, 0).r, v10 = texelFetch(uBlue, ivec2(b.x, a.y), 0).r;
  float v01 = texelFetch(uBlue, ivec2(a.x, b.y), 0).r, v11 = texelFetch(uBlue, b, 0).r;
  return mix(mix(v00, v10, t.x), mix(v01, v11, t.x), t.y);
}
float flowLine(vec2 p){ // p: 인쇄 점 좌표 (GL 방향)
  vec2 d0 = texture(uTFM, p/uPrint).xy;
  float sc = 2./uLine; // 블루 노이즈 주기(약 2텍셀)를 선 간격에 맞춘다
  float sum = blueAt(p*sc), n = 1.;
  for (int s = -1; s <= 1; s += 2) {
    vec2 q = p, d = d0*float(s);
    for (int k = 0; k < 16; k++) {
      if (float(k) >= uSteps) break;
      vec2 v = texture(uTFM, q/uPrint).xy;
      if (dot(v, d) < 0.) v = -v;
      d = v; q += d;
      sum += blueAt(q*sc); n += 1.;
    }
  }
  return normCdf((sum/n - .5)/uLicSigma);
}
float threshold(int x, int yGL){
  vec2 p = vec2(float(x), float(yGL)) + .5;
  float u = uStyle > .5 ? texelFetch(uHgt, ivec2(p/uPrint*vec2(textureSize(uHgt, 0))), 0).g : flowLine(p);
  ivec2 bn = textureSize(uBlue, 0);
  int yTop = int(uPrint.y) - 1 - yGL;
  float b = (texelFetch(uBlue, ivec2(x % bn.x, yTop % bn.y), 0).r*255. - .5)/255.;
  float t = uniformSum(clamp(u, 0., 1.)*(1. - uMix) + b*uMix, max(uMix, 1. - uMix));
  return clamp(1. + floor(t*255.), 1., 255.)/255.;
}
void main(){
  ivec2 f = ivec2(gl_FragCoord.xy);
  o = vec4(threshold(f.x*4, f.y), threshold(f.x*4 + 1, f.y), threshold(f.x*4 + 2, f.y), threshold(f.x*4 + 3, f.y));
}`;

// 감열지 3 (화면 표시): 마스크 묶음((Pw/4)×Ph, 4점씩, GL 방향. GPU 디더 결과 또는 CPU 디더 마스크를 올린 것)
// → 화면 캔버스(uRes = 결과 크기, 예: 1080×1920)에 종이색·잉크색. 정수배 최근접 + 경계 1화소만 넓이 비율로 섞는다
// (core/thermal.js sharpAxis·upscaleSharp와 같은 정수식이라 결과 사진의 화면용 이미지와 화소가 같다). 화면 표시 전용
export const FS_THERMAL_SHOW = `#version 300 es
precision highp float; precision highp int;
out vec4 o;
uniform sampler2D uMask; uniform vec3 uPaper, uInk; uniform vec2 uRes; // 색은 0~255
int dotAt(int x, int y){
  vec4 v = texelFetch(uMask, ivec2(x >> 2, y), 0);
  return dot(v, vec4(equal(ivec4(x & 3), ivec4(0, 1, 2, 3)))) > .5 ? 1 : 0;
}
ivec2 axis(int o, int D, int P){ // (점 경계 b, 오른쪽 점의 비율 0..256)
  int T = (2*o + 1)*P;
  int b = (T + D)/(2*D);
  int num = max(0, T - 2*D*b + P);
  return ivec2(b, min(256, (256*num + P)/(2*P)));
}
void main(){
  ivec2 f = ivec2(gl_FragCoord.xy);
  ivec2 n = textureSize(uMask, 0);
  int pw = n.x*4, ph = n.y;
  ivec2 ax = axis(f.x, int(uRes.x), pw), ay = axis(f.y, int(uRes.y), ph);
  int x0 = clamp(ax.x - 1, 0, pw - 1), x1 = clamp(ax.x, 0, pw - 1);
  int y0 = clamp(ay.x - 1, 0, ph - 1), y1 = clamp(ay.x, 0, ph - 1);
  int lo = dotAt(x0, y0)*(256 - ax.y) + dotAt(x1, y0)*ax.y;
  int hi = dotAt(x0, y1)*(256 - ax.y) + dotAt(x1, y1)*ax.y;
  int v = lo*(256 - ay.y) + hi*ay.y;
  ivec3 c = (ivec3(uInk)*(65536 - v) + ivec3(uPaper)*v + 32768) >> 16;
  o = vec4(vec3(c)/255., 1.);
}`;
