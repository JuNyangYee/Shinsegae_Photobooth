// Development only. Official downloads must be in the ignored directory passed here.
// node tools/filter-source-check.mjs runtime/stage13-review
import {readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFile} from 'node:child_process';
import {extractFilter,validateBundle} from '../src/web/config/filter-source.js';
import {declarationCases,brushCases,replaceOilPreset} from '../test/fixtures/filter-boundaries.mjs';
import assert from 'node:assert/strict';
const root=resolve(import.meta.dirname,'..');
const sourceDir=resolve(root,process.argv[2]??'runtime/stage13-review');
if(!sourceDir.startsWith(join(root,'runtime')+'\\'))throw Error('Use ignored runtime source directory');
const module=await readFile(join(sourceDir,'module.txt'),'utf8'),gallery=await readFile(join(sourceDir,'gallery.html'),'utf8');
const baseline=JSON.parse(await readFile(join(root,'src/web/config/filter-builtin.json'),'utf8'));
const good=await extractFilter(module,gallery,baseline),cases=[];
const add=(name,m,h,candidate,status)=>cases.push({name,module:m,gallery:h,candidate,status});
add('official full extraction',module,gallery,good,200);
const mutations={
  default:b=>b.controls[0].default=1.5,label:b=>b.controls[0].label='not from source',
  min:b=>b.controls[0].min=-1,max:b=>b.controls[0].max=2,step:b=>b.controls[0].step=.02,
  help:b=>b.controls[6].help='not from source',option:b=>b.controls[21].options[0].label='other',
  style:b=>b.controls[21].default='3d',preset:b=>b.preset.strength=.5,
  layer:b=>b.preset.layers[0][0]=37,refine:b=>b.preset.refine[0]=4,
  level:b=>b.levels[0][1]=.15,flow:b=>b.flowDefault=.00005,
  emptyShader:b=>b.port.strokeStep='',substringShader:b=>b.port.strokeStep=' ',
  otherShader:b=>b.port.strokeStep='return;',metadata:b=>b.meta.commit='fffffff',
  fingerprint:b=>b.fingerprint='0'.repeat(64),uiFingerprint:b=>b.uiFingerprint='0'.repeat(64),
  extra:b=>b.extra='unrecognized',type:b=>b.controls[0].default='0.29',
};
for(const [name,change]of Object.entries(mutations)){const b=structuredClone(good);change(b);add('forged '+name,module,gallery,b,400);}
// Literal changes are exercised in both independently deployed sources.
const replace=(text,from,to)=>{if(!text.includes(from))throw Error('fixture source changed: '+from);return text.replace(from,to);};
for(const [name,change] of [
  ['preset strength',s=>replace(s,'strength:0.29','strength:0.37')],
  ['preset layers',s=>replace(s,'[36,15,84,3.8,0,1]','[37,15,84,3.8,0,1]')],
  ['level curve',s=>replace(s,'["state.strength", .12, null, .75, .1, .22, .55]','["state.strength", .13, null, .76, .1, .22, .55]')],
  ['refine',s=>replace(s,'[3.5,3,10,0.6,0.22]','[3.6,3,10,0.6,0.22]')],
]) {
  const oilChange=s=>{const at=s.indexOf('oil2f:');return s.slice(0,at)+change(s.slice(at));};
  const m=oilChange(module),h=oilChange(gallery);add('supported '+name,m,h,await extractFilter(m,h,baseline),200);
}
for(const [name,change]of [
  ['sbr semantics',s=>replace(s,'sbr:1','sbr:2')],
  ['unknown preset',s=>replace(s,'label:"\uC720\uD654 v3",','label:"\uC720\uD654 v3", newOilValue: 7,')],
]) {
  // Restrict replacement to oil2f rather than another preset with the same sbr value.
  const oilChange=s=>{const at=s.indexOf('oil2f:');return s.slice(0,at)+change(s.slice(at));};
  const m=oilChange(module),h=oilChange(gallery);
  add('unsupported '+name,m,h,{...good,meta:{...good.meta,sha256:await hash(m),htmlSha256:await hash(h)}},400);
}
for(const [name,from,to]of [
  ['level return','function levelApply(preset) {','function levelApply(preset) { return;'],
  ['tune return','function applyTune(preset, useMemo = true) {','function applyTune(preset, useMemo = true) { return;'],
  ['level interpolation','const lerp = (a, b, t) => a*(1 - t) + b*t;','const lerp = (a,b,t) => a;'],
]) {
  const h=replace(gallery,from,to);add('unsupported HTML '+name,module,h,{...good,meta:{...good.meta,htmlSha256:await hash(h)}},400);
}
for(const [name,from,to] of [
  ['range/default label','strength: ["강도", 0, 1.6, 0.01]','strength: ["두께", 0, 2, 0.02]'],
  ['tune range','["OIL.w.0", "굵은 붓 굵기", 0.4, 2, 0.05','["OIL.w.0", "굵은 붓 굵기", 0.3, 2.5, 0.1'],
]) {const h=replace(gallery,from,to);add('supported '+name,module,h,await extractFilter(module,h,baseline),200);}
const slotChange=s=>replace(s,'float wv = W*.5*taper;','float wv = W*.45*taper;');
const changedModule=slotChange(module),changedHtml=slotChange(gallery);
add('supported shader slot',changedModule,changedHtml,await extractFilter(changedModule,changedHtml,baseline),200);
const decorated=gallery.replace('<html','<!-- unrelated presentation -->\n<html');
add('HTML surrounding presentation',module,decorated,await extractFilter(module,decorated,baseline),200);
const schemaCases=[];
for(const c of declarationCases({module,gallery})) {
  let candidate;
  if(c.accepted)candidate=await extractFilter(c.module,c.gallery,baseline);
  else {await assert.rejects(extractFilter(c.module,c.gallery,baseline));candidate=structuredClone(good);}
  candidate.meta={...candidate.meta,sha256:await hash(c.module),htmlSha256:await hash(c.gallery),bytes:Buffer.byteLength(c.module)};
  add('N1 '+c.name,c.module,c.gallery,candidate,c.accepted?200:400);cases.at(-1).sourceAccepted=c.accepted;
}
for(const [name,change,accepted]of brushCases){
  const candidate=structuredClone(good);change(candidate.preset);
  const m=replaceOilPreset(module,candidate.preset),h=replaceOilPreset(gallery,candidate.preset);
  candidate.meta={...candidate.meta,sha256:await hash(m),htmlSha256:await hash(h),bytes:Buffer.byteLength(m)};
  if(accepted){validateBundle(candidate);assert.deepEqual((await extractFilter(m,h,baseline)).preset,candidate.preset);}
  else {assert.throws(()=>validateBundle(candidate));await assert.rejects(extractFilter(m,h,baseline));}
  add('N2 '+name,m,h,candidate,accepted?200:400);cases.at(-1).sourceAccepted=accepted;
  schemaCases.push({name,candidate,status:accepted?200:400});
}
const path=join(sourceDir,'server-cases.json'),schemaPath=join(sourceDir,'schema-cases.json');
try {
  await writeFile(path,JSON.stringify(cases));
  const result=await new Promise(r=>execFile('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/filter-source-check.ps1'),'-CasesPath',path],{cwd:root,windowsHide:true,maxBuffer:8*1024*1024},(error,stdout,stderr)=>r({code:error?.code??0,stdout,stderr})));
  console.log(result.stdout);if(result.code)throw Error(result.stderr);
  await writeFile(schemaPath,JSON.stringify(schemaCases));
  const schema=await new Promise(r=>execFile('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'tools/filter-source-check.ps1'),'-CasesPath',schemaPath,'-Schema'],{cwd:root,windowsHide:true,maxBuffer:8*1024*1024},(error,stdout,stderr)=>r({code:error?.code??0,stdout,stderr})));
  console.log(schema.stdout);if(schema.code)throw Error(schema.stderr);
} finally { await rm(path,{force:true});await rm(schemaPath,{force:true}); }
async function hash(text){const {createHash}=await import('node:crypto');return createHash('sha256').update(text).digest('hex');}
