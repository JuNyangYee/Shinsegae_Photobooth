// 검증한 GLSL 조각만 기존 유화 경계에 연결. 원격 JavaScript를 실행하지 않는다.
import * as S from './oil-shaders.js';
import { validateBundle } from '../config/filter-source.js';

export function filterShaders(bundle) {
  if (!bundle) return S;
  validateBundle(bundle);
  const p=bundle.port;
  const once=(s,a,b)=>{if(!s.includes(a))throw Error('로컬 셰이더 연결 위치 변경');return s.replace(a,b);};
  let grade=once(S.FS_GRADE,'uniform float uAmt;','uniform float uAmt, uKeepW;');
  grade=once(grade,'o = vec4(mix(c, g, uAmt), 1.);',`vec3 r = mix(c, g, uAmt);
  if (uKeepW > 0.) {
    float mx = max(c.r, max(c.g, c.b)), sat = (mx - min(c.r, min(c.g, c.b)))/(mx + 1e-3);
    r = mix(r, c, uKeepW*smoothstep(.62, .85, lum(c))*(1. - smoothstep(.08, .22, sat)));
  }
  o = vec4(r, 1.);`);
  let tfm=once(S.FS_TFM,'uniform sampler2D uTex;','uniform sampler2D uTex, uGr; uniform float uSlopeK, uStrE;');
  tfm=once(tfm,'E+G+4e-5','E+G+uStrE');
  tfm=once(tfm,'vec2 m2 = mix(d2, t2, w);',p.tfmBody+'\nvec2 m2 = mix(d2, t2, w);');
  let stroke=once(S.VS_STROKE,'void main(){',`uniform sampler2D uBlob; uniform float uEyeK, uSpillK;
${p.blb}
${p.strokeFns}
void main(){`);
  stroke=once(stroke,'p += dcur*s; trav += s;',p.strokeStep+'\np += dcur*s; trav += s;');
  stroke=once(stroke,'p += nrm*side*W*.5*taper;',p.strokeWidth);
  let compose=once(S.FS_COMPOSE,'void main(){',`uniform sampler2D uGrade, uBlob;
uniform float uEyeK, uEyeR, uEdgeK, uHaloK, uBumpK, uSpecK, uCanvasK;
${p.blb}
void main(){`);
  compose=once(compose,'float h0 = texture(uHgt, uv).r',p.finishBody+'\nfloat h0 = texture(uHgt, uv).r');
  compose=compose.replaceAll('*6.*uRelief','*uBumpK*uRelief').replace(')*.1*uStr',')*uSpecK*uStr').replace('.02*uStr','uCanvasK*uStr');
  const head=S.FS_SST.slice(0,S.FS_SST.indexOf('uniform sampler2D uTex;'));
  return {...S,FS_GRADE:grade,FS_TFM:tfm,VS_STROKE:stroke,FS_COMPOSE:compose,FS_BLOB:head+p.blobFragment};
}
