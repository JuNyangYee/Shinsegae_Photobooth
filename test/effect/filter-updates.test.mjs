import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFilterUpdates} from '../../src/web/effect/filter-updates.js';
import {extractFilter} from '../../src/web/config/filter-source.js';
import {config} from '../../src/web/config/config.js';
import {normalizeEffectSettings,serializeEffectSettings} from '../../src/web/config/effect-settings.js';
import {sourceFixture} from '../fixtures/filter-source.mjs';
const source=sourceFixture(),builtin=await extractFilter(source.module,source.gallery);
const base=normalizeEffectSettings(config.effect,config.effect).settings;
async function setup(store={revision:0,active:null,previous:null}){
  let current=base,bundle=null,candidate=null,allowed=true,fail='',network=0,waitCheck=null;
  const json=data=>({ok:true,json:async()=>structuredClone(data)});
  const preview={getSettings:()=>current,setSettings:s=>{current=s;},getBundle:()=>bundle,replaceFilter(b,s){if(b?.port.strokeFns==='bad')throw Error('shader failed');bundle=b;current=s;}};
  const fetcher=async(url,options={})=>{
    const d=options.body?JSON.parse(options.body):null;
    if(url==='/config/filter-builtin.json')return json(builtin);
    if(url.endsWith('check')){network++;if(waitCheck)await waitCheck;if(fail==='network')throw Error('offline');if(fail==='compat')return json({...source,gallery:source.gallery.replace('function levelApply(preset) {','function levelApply(preset) { return;')});return json(source);}
    if(url.endsWith('candidate')){candidate=d;return json({id:d.meta.sha256});}
    if(options.method==='GET')return json(store);
    if(fail==='write')throw Error('disk write failed');
    if(url.endsWith('apply')){store.previous=store.active??{bundle:null,settings:d.before};store.active={bundle:candidate,settings:d.settings};}
    else if(url.endsWith('rollback')){[store.active,store.previous]=[store.previous,store.active];}
    else store.active.settings=d.settings;
    store.revision++;
    if(fail==='ack')throw Error('response interrupted after commit');
    return json(store);
  };
  const make=()=>createFilterUpdates({preview,defaults:config.effect,initial:{settings:base,source:'file',issues:[],note:''},canChange:()=>allowed,fetcher});
  return {u:await make(),make,preview,store,setFail:v=>{fail=v;},allow:v=>{allowed=v;},network:()=>network,holdCheck:()=>{let release;waitCheck=new Promise(r=>release=r);return ()=>{waitCheck=null;release();};}};
}
test('확인은 실행판/저장판 무변경, 시험은 메모리만, 닫기 복원',async()=>{
  const x=await setup();assert.equal(x.network(),0);await x.u.check();assert.equal(x.preview.getBundle(),null);assert.equal(x.store.active,null);
  const s=await x.u.trial(base);assert.equal(x.preview.getBundle().meta.commit,'7f58eaa');assert.equal(x.store.active,null);assert.equal(s.strength,base.strength);
  await assert.rejects(x.u.save(s),/후보 시험/);x.u.restore();assert.equal(x.preview.getBundle(),null);assert.deepEqual(x.preview.getSettings(),base);
});
test('apply→restart offline→rollback→restart restores exact engine+user values',async()=>{
  const x=await setup();await x.u.check();let s=await x.u.trial(base);s=x.u.defaults(s);await x.u.apply(s);
  assert.equal(x.store.active.settings.settings.strength,.29);assert.deepEqual(x.store.previous.settings,JSON.parse(serializeEffectSettings(base)));
  x.setFail('network');const reboot=await x.make();assert.equal(reboot.initial.settings.strength,.29);assert.equal(x.network(),1);
  await reboot.rollback();const again=await x.make();assert.deepEqual(again.initial.settings,base);assert.equal(x.preview.getBundle(),null);
});
test('촬영 중 변경 차단, 네트워크·저장 실패는 원판 유지',async()=>{
  const x=await setup();x.allow(false);await assert.rejects(x.u.check(),/촬영/);assert.equal(x.network(),0);
  x.allow(true);x.setFail('network');await assert.rejects(x.u.check(),/offline/);assert.equal(x.preview.getBundle(),null);
  x.setFail('');await x.u.check();await x.u.trial(base);x.setFail('write');await assert.rejects(x.u.apply(base),/disk write/);
  assert.equal(x.store.active,null);assert.equal(x.preview.getBundle(),null);assert.deepEqual(x.preview.getSettings(),base);
});
test('파일은 저장됐지만 응답이 끊긴 경우 재읽어 확정, 화면/디스크 일치',async()=>{
  const x=await setup();await x.u.check();await x.u.trial(base);x.setFail('ack');await x.u.apply(base);
  assert.equal(x.u.getInfo().active.meta.sha256,x.store.active.bundle.meta.sha256);assert.equal(x.u.getInfo().trial,false);
});
test('시작 때 셰이더 컴파일 실패는 저장된 이전 정상판으로 자동 복원',async()=>{
  const bad=structuredClone(builtin);bad.port.strokeFns='bad';
  const entry={bundle:bad,settings:JSON.parse(serializeEffectSettings(base))};
  const x=await setup({revision:5,active:entry,previous:{bundle:null,settings:JSON.parse(serializeEffectSettings(base))}});
  assert.equal(x.store.revision,6);assert.equal(x.store.active.bundle,null);assert.equal(x.preview.getBundle(),null);assert.match(x.u.getInfo().note,/이전 정상판 복원/);
});

test('저장판과 이전판이 모두 컴파일 실패하면 기본판으로 열고 추가 저장을 보류',async()=>{
  const bad=structuredClone(builtin);bad.port.strokeFns='bad';const entry={bundle:bad,settings:JSON.parse(serializeEffectSettings(base))};
  const x=await setup({revision:5,active:entry,previous:structuredClone(entry)});
  assert.equal(x.preview.getBundle(),null);assert.equal(x.u.getInfo().unavailable,true);assert.equal(x.u.getInfo().definition,null);
  await assert.rejects(x.u.check(),/복구/);assert.equal(x.store.revision,5);
});

test('검수 P4: 확인 handler가 미저장 수치를 덮어쓰지 않는다',async()=>{
 const x=await setup();let current={...base,strength:.9};const handler=async()=>{const next=await x.u.check(current);if(next)current=next;};
 await handler();assert.equal(current.strength,.9);await handler();assert.equal(current.strength,.9);
 x.setFail('network');await assert.rejects(handler(),/offline/);assert.equal(current.strength,.9);
});

test('확인 성공·실패·반복이 시험 엔진과 미저장값을 유지하고 재시험 전 적용을 막는다',async()=>{
 const x=await setup();await x.u.check();const trial=await x.u.trial({...base,strength:.9});x.preview.setSettings(trial);const engine=x.preview.getBundle();
 for(const failure of ['', 'network','compat','']){
   x.setFail(failure);if(failure)await assert.rejects(x.u.check(trial));else assert.equal(await x.u.check(trial),undefined);
   assert.equal(x.preview.getBundle(),engine);assert.equal(x.preview.getSettings().strength,.9);assert.equal(x.u.getInfo().definition,engine);assert.equal(x.u.getInfo().canApply,false);
   assert.equal(x.u.defaults(trial).strength,.29);
   await assert.rejects(x.u.apply(trial),/시험/);
 }
 const retried=await x.u.trial(trial);assert.equal(retried.strength,.9);assert.equal(x.u.getInfo().canApply,true);await x.u.apply(retried);assert.equal((await x.make()).initial.settings.strength,.9);
});
test('확인 중 저장·복원·기본값·중복 작업 경쟁을 거부하고 완료 후 취소 가능',async()=>{
 const x=await setup();await x.u.check();await x.u.trial({...base,strength:.9});const release=x.holdCheck(),pending=x.u.check();
 assert.equal(x.u.getInfo().busy,true);await assert.rejects(x.u.save(base),/시험|작업/);await assert.rejects(x.u.check(),/작업/);await assert.rejects(x.u.rollback(),/작업/);assert.throws(()=>x.u.restore(),/작업/);assert.throws(()=>x.u.defaults(base),/작업/);
 assert.equal(x.preview.getSettings().strength,.9);release();await pending;x.u.restore();assert.deepEqual(x.preview.getSettings(),base);assert.equal(x.u.getInfo().trial,false);
});
test('시험하지 않은 상태의 호환 실패도 현재 미저장값을 유지',async()=>{
 const x=await setup();const current={...base,strength:.9};x.preview.setSettings(current);x.setFail('compat');await assert.rejects(x.u.check(current),/검토 필요/);assert.equal(x.preview.getSettings(),current);
});
