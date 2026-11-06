// 원문을 실행하지 않고 검수 변형을 만든다. 예상 허용/거부는 판독기와 독립된 표다.
import {tokens} from '../../src/web/config/filter-source.js';

function declaration(text,name) {
  const ts=tokens(text),at=ts.findIndex((t,i)=>t.v==='const'&&ts[i+1]?.v===name&&ts[i+2]?.v==='=');
  if(at<0)throw Error('fixture declaration '+name);
  let depth=0;
  for(let i=at+3;i<ts.length;i++) {
    if(['{','['].includes(ts[i].v))depth++;
    else if(['}',']'].includes(ts[i].v)&&--depth===0)return {start:ts[at+3].start,end:ts[i].end,previous:ts[i-1].v};
  }
  throw Error('fixture end');
}
export function appendProperty(text,name,value) {
  const p=declaration(text,name);
  return text.slice(0,p.end-1)+(p.previous===','||p.previous==='{'?'':',')+value+text.slice(p.end-1);
}
function alterDeclaration(text,name,change) {
  const p=declaration(text,name);return text.slice(0,p.start)+change(text.slice(p.start,p.end))+text.slice(p.end);
}
export function replaceOilPreset(text,preset) {
  const p=declaration(text,'PRESETS'),chunk=text.slice(p.start,p.end),ts=tokens(chunk);
  const at=ts.findIndex((t,i)=>t.v==='oil2f'&&ts[i+1]?.v===':');if(at<0)throw Error('fixture oil2f');
  let depth=0;
  for(let i=at+2;i<ts.length;i++){
    if(['{','['].includes(ts[i].v))depth++;else if(['}',']'].includes(ts[i].v)&&--depth===0)return text.slice(0,p.start+ts[at+2].start)+JSON.stringify(preset)+text.slice(p.start+ts[i].end);
  }
  throw Error('fixture preset end');
}
export function declarationCases(src) {
  const cases=[];
  const add=(name,change,accepted=false)=>cases.push({name,module:src.module,gallery:change(src.gallery),accepted});
  for(const key of ['oil2f','"oil2f"',"'oil2f'",String.raw`"\u006fil2f"`])add('duplicate CTRL '+key,h=>appendProperty(h,'CTRL',key+':{strength:["OVERRIDE",0,9,0.1]}'));
  for(const [name,value]of [
    ['PRESETS','"oil2f":{}'],['LEVELS',"'oil2f':{rows:[]}"],['TUNE_ROWS','"oil":[]'],
    ['CTRL_BASE',"'strength':[\"OVERRIDE\",0,9,.1]"],['PER_DEF','"grade":.5'],
    ['PER_DEF','strength:.5'],['SLIDER_DEF',"'strength':.5"],
  ])add('duplicate '+name+' '+value,h=>appendProperty(h,name,value));
  for(const name of ['CTRL_BASE','PER_DEF','SLIDER_DEF'])add('unknown '+name,h=>appendProperty(h,name,'newOilValue:7'));
  add('unknown oil2f control',h=>alterDeclaration(h,'CTRL',s=>s.replace(/oil2f:\s*\{/,'oil2f:{ newOilValue:7,')));
  add('unknown oil2f level',h=>alterDeclaration(h,'LEVELS',s=>s.replace(/oil2f:\s*\{/,'oil2f:{ newOilValue:7,')));
  add('duplicate nested level rows',h=>alterDeclaration(h,'LEVELS',s=>s.replace(/oil2f:\s*\{/,'oil2f:{ "rows": [],')));
  add('dynamic computed key',h=>appendProperty(h,'CTRL','["oil2f"]:{strength:["OVERRIDE",0,9,.1]}'));
  add('dynamic getter',h=>appendProperty(h,'CTRL','get oil2f(){return {};}'));
  add('unknown spread',h=>appendProperty(h,'CTRL','...unexpectedControls'));
  add('trailing expression',h=>{const p=declaration(h,'CTRL');return h.slice(0,p.end)+' || {}'+h.slice(p.end);});
  add('duplicate const declaration',h=>h.replace('const CTRL =','const CTRL = {}; const CTRL ='));
  add('duplicate PER item',h=>alterDeclaration(h,'PER',s=>s.replace('[','["strength",')));
  add('unknown PER item',h=>alterDeclaration(h,'PER',s=>s.replace('[','["newOilValue",')));
  // 값·키의 다른 정적 표기와 정상 다른 매체는 허용한다.
  add('quoted static keys',h=>['PRESETS','CTRL','LEVELS'].reduce((s,n)=>alterDeclaration(s,n,v=>v.replace(/\boil2f\s*:/,"'oil2f':")),h),true);
  add('unrelated static media',h=>appendProperty(h,'CTRL','otherMedium:{strength:["Other",0,2,.1]}'),true);
  return cases;
}

// 양수 geometry와 0을 허용하는 보조값, 배타적 상한을 각각 시험한다.
export const brushCases=[
  ['layer radius zero',p=>p.layers[0][0]=0,false],
  ['layer spacing zero',p=>p.layers[0][1]=0,false],
  ['layer length zero',p=>p.layers[0][2]=0,false],
  ['refine width zero',p=>p.refine[0]=0,false],
  ['refine spacing zero',p=>p.refine[1]=0,false],
  ['refine length zero',p=>p.refine[2]=0,false],
  ['refine opacity zero',p=>p.refine[3]=0,false],
  ['layer tail zero',p=>p.layers[0][5]=0,true],
  ['refine threshold zero',p=>p.refine[4]=0,true],
  ['small positive geometry',p=>{p.layers[0][1]=.00001;p.refine[0]=.00001;},true],
  ['layer below upper bound',p=>p.layers[0][0]=199.999,true],
  ['refine below upper bound',p=>p.refine[0]=199.999,true],
  ['layer upper bound',p=>p.layers[0][0]=200,false],
  ['layer tail upper bound',p=>p.layers[0][5]=200,false],
  ['refine upper bound',p=>p.refine[0]=200,false],
  ['refine threshold upper bound',p=>p.refine[4]=200,false],
  ['layer negative',p=>p.layers[0][4]=-.01,false],
  ['refine negative',p=>p.refine[4]=-.01,false],
  ['layer null',p=>p.layers[0][0]=null,false],
  ['refine null',p=>p.refine[4]=null,false],
  ['layer string',p=>p.layers[0][0]='36',false],
  ['refine boolean',p=>p.refine[0]=true,false],
  ['missing layer',p=>p.layers.pop(),false],
  ['extra layer',p=>p.layers.push([...p.layers[0]]),false],
  ['short layer',p=>p.layers[0].pop(),false],
  ['long layer',p=>p.layers[0].push(1),false],
  ['short refine',p=>p.refine.pop(),false],
  ['long refine',p=>p.refine.push(1),false],
  ['null layers',p=>p.layers=null,false],
  ['null refine',p=>p.refine=null,false],
];
