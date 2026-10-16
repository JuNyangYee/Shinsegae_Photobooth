// 사진 효과 "유화 · 획 (세부 보존)" GLSL (WebGL2, GLSL ES 3.00).
//
// 출처: 재료 필터 갤러리 https://nau-filter-gallery.vercel.app/ 프리셋 `oil2f` (2026-10-16 받은 페이지).
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
// - 출력 단계 FS_OUTPUT을 하나 더 둔다 (지금은 그대로 통과. 감열지용 흑백·디더링 자리)

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
out vec2 vSt; out vec3 vCol; out float vR;
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
}`;

// 유화 붓 한 획: 길이 방향 붓털 홈, 끝에서 물감이 갈라진다. 색(0번)과 높이(1번)를 함께 쓴다.
export const FS_STROKE = SBR_HEAD + `
in vec2 vSt; in vec3 vCol; in float vR;
uniform float uBrisLen, uBrisWid;
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
  oC = vec4(col, a); oH = vec4(vec3(h), a);
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

// 출력 단계: 효과 결과 → 화면(또는 이후 캡처). 지금은 그대로 통과한다.
// 감열지 출력용 흑백·디더링 패스를 붙일 때 이 셰이더를 바꾸거나 이 앞에 패스를 더한다.
export const FS_OUTPUT = `#version 300 es
precision highp float;
in vec2 vUV; out vec4 o;
uniform sampler2D uImage;
void main(){ o = vec4(texture(uImage, vUV).rgb, 1.); }`;
