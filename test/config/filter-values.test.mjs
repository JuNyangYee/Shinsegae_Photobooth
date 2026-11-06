import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {config} from '../../src/web/config/config.js';
import {filterValues,setFilterValue,importedDefaults,migrateFilterValues,filterLimits} from '../../src/web/config/filter-values.js';
import {normalizeEffectSettings,serializeEffectSettings,parseStoredEffectSettings,effectLimits} from '../../src/web/config/effect-settings.js';
import {validateBundle,bundleChanges,literalAt} from '../../src/web/config/filter-source.js';
const bundle=JSON.parse(readFileSync(new URL('../../src/web/config/filter-builtin.json',import.meta.url)));
const base=normalizeEffectSettings(config.effect,config.effect).settings;
test('원본 대응: 21개 숫자 + 그림체 선택, 벡터 w의 세 성분을 각각 센다',()=>{
  validateBundle(bundle);
  assert.equal(bundle.controls.filter(c=>c.kind==='number').length,21);
  assert.equal(bundle.controls.filter(c=>c.kind==='select').length,1);
  const s=importedDefaults(bundle,base), v=filterValues(bundle,s);
  assert.deepEqual(bundle.controls.map(c=>v[c.id]),bundle.controls.map(c=>c.default));
  assert.deepEqual(s.layers,[[36,15,84,3.8,0,1],[18,8,44,2.6,.02,1],[8,4,20,1.4,.06,1]]);
  assert.equal(s.refine[4],.10);
});
test('현장 18개 값 보존, 신규값 원본 기본값, 예전 파일의 새 키 없음 유지',()=>{
  const s=migrateFilterValues(bundle,base);
  for(const k of ['strength','size','boil','fps','grade','oil','outputMode','brightness','contrast','gamma','paperDots'])assert.equal(s[k],base[k]);
  assert.equal(s.refine[4],base.refine[4]);assert.equal(filterValues(bundle,s)['OIL.len'],1.68);
  const old=serializeEffectSettings(base);assert.ok(!old.includes('gallery'));
  assert.deepEqual(parseStoredEffectSettings(old,config.effect).settings,base);
});
test('level 원본 우선순위: preset→곡선→세부 명시값, 왕복 오차 없음',()=>{
  let s=importedDefaults(bundle,base);
  s=setFilterValue(bundle,s,'OIL.jit',.2);
  s=setFilterValue(bundle,s,'state.level',100);
  assert.equal(s.strength,.75);assert.equal(s.size,1.7);assert.equal(filterValues(bundle,s)['OIL.canvas'],.05);assert.equal(filterValues(bundle,s)['OIL.jit'],.2);
  s=setFilterValue(bundle,s,'state.level',50);assert.equal(s.strength,.29);assert.equal(s.size,1.23);assert.equal(filterValues(bundle,s)['OIL.jit'],.2);
  s=setFilterValue(bundle,s,'state.style','3d');assert.equal(s.strength,.22);assert.equal(filterValues(bundle,s)['CR.tfmE'],.001);
  s=setFilterValue(bundle,s,'state.level',100);assert.equal(s.strength,.55);assert.equal(filterValues(bundle,s)['OIL.canvas'],.04);
  const loaded=parseStoredEffectSettings(serializeEffectSettings(s),config.effect).settings;
  assert.deepEqual(filterValues(bundle,loaded),filterValues(bundle,s));
});
test('범위 축소는 현장 값을 조용히 자르지 않고 적용 보류, 확장값은 저장·재읽기 보존',()=>{
  const b=structuredClone(bundle);b.controls.find(c=>c.id==='state.strength').max=.2;
  assert.throws(()=>migrateFilterValues(b,base),/검토 필요/);
  b.controls.find(c=>c.id==='state.strength').max=2;
  const s=setFilterValue(b,base,'state.strength',1.9);
  const loaded=parseStoredEffectSettings(serializeEffectSettings(s),config.effect,filterLimits(b,effectLimits));
  assert.equal(loaded.settings.strength,1.9);
});
test('원본 기본값 변경은 신규/비명시 수치로 반영, 명시값은 보존',()=>{
  const b=structuredClone(bundle);b.controls.find(c=>c.id==='OIL.len').default=1.8;
  assert.equal(filterValues(b,base)['OIL.len'],1.8);
  const s=setFilterValue(bundle,base,'OIL.len',1.2);assert.equal(filterValues(b,s)['OIL.len'],1.2);
  assert.ok(bundleChanges(bundle,b).some(c=>c.includes('1.68 → 1.8')));
});
test('손상·새 키·삭제 키·중복·비정상 층 거절',()=>{
  for(const mutate of [b=>b.controls.push({...b.controls[0],id:'OIL.unknown'}),b=>b.controls.pop(),b=>b.controls[1]=b.controls[0],b=>b.controls[0].default=NaN,b=>b.preset.layers[0][1]=0,b=>b.port.strokeStep='${alert(1)}']){
    const b=structuredClone(bundle);mutate(b);assert.throws(()=>validateBundle(b));
  }
});
test('리터럴 파서는 주석/배열/음수/지수는 읽지만 JS 표현식은 실행하지 않는다',()=>{
  assert.deepEqual(literalAt('const X = {a:[.1,-2,4e-5],b:null,// }\n c:"}"};','const X = ').value,{a:[.1,-2,.00004],b:null,c:'}'});
  for(const text of ['{a:alert(1)}','{get a(){return 1}}','{a:1+2}','{__proto__:1}','{a:1,a:2}','{a:[1,2'])assert.throws(()=>literalAt('X='+text,'X='));
});

test('업데이트는 이전에 유효했던 세부값을 보존하고 받은 기본값 버튼만 새 수치를 쓴다',()=>{
  const old=importedDefaults(bundle,base), b=structuredClone(bundle);
  b.controls.find(c=>c.id==='OIL.len').default=1.8;
  b.controls.find(c=>c.id==='OIL.canvas').default=.04;
  b.preset.tune['OIL.len']=1.8;b.preset.tune['OIL.canvas']=.04;
  const next=migrateFilterValues(b,old,bundle);
  assert.equal(filterValues(b,next)['OIL.len'],1.68);assert.equal(filterValues(b,next)['OIL.canvas'],.023);
  assert.equal(filterValues(b,importedDefaults(b,next))['OIL.len'],1.8);
  assert.equal(filterValues(b,importedDefaults(b,next))['OIL.canvas'],.04);
});
test('원본 level/style 기본값 변경도 최초 도입과 기본값 적용에서 반영',()=>{
  const b=structuredClone(bundle);b.controls.find(c=>c.id==='state.level').default=100;b.controls.find(c=>c.id==='state.style').default='3d';
  const initial=migrateFilterValues(b,base);assert.equal(initial.gallery.level,100);assert.equal(initial.gallery.style,'3d');assert.equal(initial.strength,base.strength);
  const s=importedDefaults(b,initial);assert.equal(s.strength,.55);assert.equal(s.size,1.7);assert.equal(filterValues(b,s)['OIL.canvas'],.04);
});
