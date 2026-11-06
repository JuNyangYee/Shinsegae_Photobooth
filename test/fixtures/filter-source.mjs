// 다운로드 원본을 보관하지 않는 합성 구조 fixture. GLSL 데이터는 필수 동봉 묶음에서 가져온다.
import {readFileSync} from 'node:fs';
export const builtin=JSON.parse(readFileSync(new URL('../../src/web/config/filter-builtin.json',import.meta.url)));
export function sourceFixture(){
  const b=builtin,p=b.port;
  const data=`const PRESETS = { oil2f:  ${JSON.stringify(b.preset)} };
const OIL = { w:[1,1,1],len:1,jit:.05,bump:6,spec:.1,canvas:.02,refineT:null,eye:0,edge:0,spill:0,slope:0,halo:0 };
const SLIDER_DEF = {strength:1,size:1,boil:.1};
const PER_DEF = {...SLIDER_DEF,fps:12,grade:1,flat:.8,mood:"none",moodK:1,level:50,normal:0};
const CR = {tfmE:4e-5};
const state = {style:"flat"};
const LEVELS = {oil2f: { rows:${JSON.stringify(b.levels)} }};`;
  const shaders=`const VS_STROKE = \`
${p.blb}
${p.strokeFns}
void main(){
dcur = normalize(mix(dcur, nd, .7));
if (uNOSil > 0.) break;
${p.strokeStep}
p += dcur*s; trav += s;
float taper = mix(.55, 1., 1. - pow(abs(t)*2., 2.));
${p.strokeWidth}
gl_Position = vec4(p/uRes*2. - 1., 0., 1.);
}\`;
const FS_TFM = \`d2 = vec2(d.x*d.x - d.y*d.y, 2.*d.x*d.y);${p.tfmBody}vec2 m2 = mix(d2, t2, w);\`;
const FS_COMPOSE = \`${p.blb}
if (uMedium == 1) {${p.finishBody}float h0 = texture(uHgt, uv).r; }\`;
const FS_BLOB = \`${p.blobFragment}\`;`;
  const rows=b.controls.filter(c=>c.id.startsWith('OIL.')).map(c=>[c.id,c.label,c.min,c.max,c.step,c.help]);
  const keep=b.controls.find(c=>c.id==='GRADE.keepW');
  const ctrlBase=Object.fromEntries(b.controls.filter(c=>c.id.startsWith('state.')&&c.kind==='number').map(c=>[c.id.slice(6),[c.label,c.min,c.max,c.step]]));
  const ctrl='const CTRL_BASE = '+JSON.stringify(ctrlBase)+'; const CTRL = { oil2f:    {strength:null,size:null,level:[],boil:["획 다시 놓기"]} }; function applyCtrl(){}';
  const html=b.controls.filter(c=>c.id.startsWith('state.')&&c.kind==='number').map(c=>`<div class="row"><label>${c.label}</label><input type="range" id="${c.id.slice(6)}" min="${c.min}" max="${c.max}" step="${c.step}"></div>`).join('\n');
  return { module:`// 갤러리 7f58eaa 2026-11-05\n${data}\n${shaders}\nexport function createFilter() {}`, gallery:`<html>${html}<label>소스 그림체</label><select id="style"><option value="flat">평면 그림책</option><option value="3d">3D</option></select><script>\n${data}\n${shaders}\n${ctrl}\nconst TUNE_ROWS = {\n  oil: ${JSON.stringify(rows)}};\nconst GRADE_ROW = ${JSON.stringify([keep.id,keep.label,keep.min,keep.max,keep.step,keep.help])};</script></html>` };
}
