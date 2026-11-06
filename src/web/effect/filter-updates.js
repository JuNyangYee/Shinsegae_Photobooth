import { extractFilter, validateBundle, bundleChanges } from '../config/filter-source.js';
import { migrateFilterValues, importedDefaults, filterLimits } from '../config/filter-values.js';
import { parseStoredEffectSettings, serializeEffectSettings, effectLimits } from '../config/effect-settings.js';

// 상태 변경은 한 번에 하나. 촬영 회차가 진행 중이면 시험·적용·복원을 거절한다.
export async function createFilterUpdates({ preview, defaults, initial, canChange, fetcher = fetch }) {
  let state={revision:0,active:null,previous:null}, candidate=null, trial=false, busy=false;
  let saved=initial.settings, note='', changes=[], unavailable=false;
  const builtin=validateBundle(await (await fetcher('/config/filter-builtin.json',{signal:AbortSignal.timeout(3000)})).json());
  const api=async(name,method='GET',data)=>{
    const res=await fetcher('/local-api/filter-'+name,{method,headers:method==='GET'?{}:{'Content-Type':'application/json','X-Photobooth':'1'},...(data===undefined?{}:{body:JSON.stringify(data)}),signal:AbortSignal.timeout(name==='check'?50000:10000)});
    if(!res.ok)throw Error(`필터 ${name}: ${res.status} ${(await res.text()).slice(0,160)}`);
    return res.json();
  };
  const decode=entry=>{
    if(entry.bundle)validateBundle(entry.bundle);
    const parsed=parseStoredEffectSettings(JSON.stringify(entry.settings),defaults,filterLimits(entry.bundle,effectLimits));
    if(parsed.source!=='stored'||(entry.bundle&&parsed.issues.length))throw Error('저장된 필터 설정 손상');
    const settings=entry.settings.settings.gallery?{...parsed.settings,gallery:entry.settings.settings.gallery}:parsed.settings;
    return entry.bundle?migrateFilterValues(entry.bundle,settings):settings;
  };
  const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.keys(v).sort().map(k=>[k,v[k]])):v);
  const sameEntry=(a,b)=>a&&b&&(a.bundle?.meta.sha256??null)===(b.bundle?.meta.sha256??null) && (a.bundle?.meta.htmlSha256??null)===(b.bundle?.meta.htmlSha256??null)
    && canonical(decode(a))===canonical(decode(b));
  // 파일 교체 뒤 응답만 끊긴 경우 재읽기로 확정한다. 성공한 디스크와 옛 화면이 갈라지지 않게 한다.
  const mutate=async(name,method,data,expected)=>{
    try{return await api(name,method,data);}
    catch(error){
      try{const found=await api('state');if(found.revision===data.revision+1&&sameEntry(found.active,expected))return found;}
      catch{ throw Error(`${error.message} · 저장 결과 확인 불가. 서버에 연결한 뒤 다시 시작해 확인하세요`); }
      throw error;
    }
  };
  try {
    state=await api('state');
    if(state.active) {
      const settings=decode(state.active);
      preview.replaceFilter(state.active.bundle,settings,false);
      saved=settings;
      initial={...initial,settings,source:'file',note:'',issues:[]};
    }
  } catch(error) {
    unavailable=true;
    note=`저장판을 열지 못했습니다: ${error.message}`;
    if(state.previous) {
      try {
        const settings=decode(state.previous);
        preview.replaceFilter(state.previous.bundle,settings,false);
        state=await mutate('rollback','POST',{revision:state.revision},state.previous);
        unavailable=false;
        saved=settings; initial={...initial,settings,source:'file',note:'이전 정상판 복원',issues:[]};
        note+=' · 이전 정상판 복원';
      } catch(recovery) { note+=` · 복원 실패: ${recovery.message}`; }
    }
    if(unavailable){if(preview.getBundle())preview.replaceFilter(null,initial.settings,false);note+=' · 기본 제공판 사용 중. 저장 파일을 복구한 뒤 다시 시작하세요';}
  }
  const guard=()=>{if(unavailable)throw Error('저장판 복구가 필요합니다');if(!canChange())throw Error('촬영이 끝난 뒤 필터를 바꾸세요');};
  const exclusive=async fn=>{
    if(busy)throw Error('필터 작업 중입니다'); guard(); busy=true;
    try{return await fn();} finally{busy=false;}
  };
  const restore=()=>{
    if(trial){preview.replaceFilter(state.active?.bundle??null,saved,false);trial=false;}
    return saved;
  };
  return {
    initial,
    getInfo:()=>({busy,trial,note,changes,candidate,unavailable,active:unavailable?null:state.active?.bundle??null,previous:state.previous,definition:unavailable?null:trial?candidate:state.active?.bundle??null}),
    restore,
    check:()=>exclusive(async()=>{
      restore(); candidate=null; changes=[];
      try {
        const raw=await api('check','POST',{});
        candidate=await extractFilter(raw.module,raw.gallery,builtin);
        await api('candidate','PUT',candidate);
        changes=state.active?.bundle?bundleChanges(state.active.bundle,candidate):['유화 엔진 개선과 조절값 22개를 가져옵니다'];
        note=state.active?.bundle?.meta.sha256===candidate.meta.sha256&&state.active?.bundle?.meta.htmlSha256===candidate.meta.htmlSha256?'현재와 같은 판입니다':'후보를 받았습니다. 시험한 뒤 적용하세요';
        return saved;
      } catch(e){candidate=null;note=`확인 실패 · ${e.message} · 현재판 유지`;throw e;}
    }),
    trial:settings=>exclusive(async()=>{
      if(!candidate)throw Error('먼저 업데이트를 확인하세요');
      const next=migrateFilterValues(candidate,settings,state.active?.bundle??null);
      preview.replaceFilter(candidate,next,true); trial=true; note='후보 시험 중 · 적용하지 않고 닫으면 저장판으로 돌아갑니다';
      return next;
    }),
    defaults:settings=>{guard();const b=trial?candidate:state.active?.bundle;if(!b)throw Error('먼저 후보를 시험하세요');return importedDefaults(b,settings);},
    apply:settings=>exclusive(async()=>{
      if(!trial||!candidate)throw Error('먼저 후보를 시험하세요');
      // 저장 직전에 현재 설정으로 한 번 더 GPU 시험. 저장 실패는 디스크와 화면 모두 원판으로.
      preview.replaceFilter(candidate,settings,true);
      try {
        const entry={bundle:candidate,settings:JSON.parse(serializeEffectSettings(settings))};
        state=await mutate('apply','POST',{revision:state.revision,id:candidate.meta.sha256+':'+candidate.meta.htmlSha256,settings:entry.settings,before:JSON.parse(serializeEffectSettings(saved))},entry);
        saved=settings;trial=false;note='필터와 현재 수치를 적용·저장했습니다';return saved;
      } catch(e){restore();note='적용 실패 · 저장판으로 복원';throw e;}
    }),
    rollback:()=>exclusive(async()=>{
      if(!state.previous)throw Error('이전판이 없습니다');
      const before=preview.getSettings(), old=preview.getBundle(), next=decode(state.previous);
      preview.replaceFilter(state.previous.bundle,next,true);
      try {state=await mutate('rollback','POST',{revision:state.revision},state.previous);saved=next;trial=false;note='이전판과 당시 수치를 복원했습니다';return saved;}
      catch(e){preview.replaceFilter(old,before,false);throw e;}
    }),
    save:async settings=>{
      if(trial)throw Error('후보 시험 중입니다. 필터 적용을 누르거나 취소하세요');
      if(busy)throw Error('업데이트 작업 중입니다');
      guard();
      if(!state.active)return false;
      busy=true;
      try {const entry={bundle:state.active.bundle,settings:JSON.parse(serializeEffectSettings(settings))};state=await mutate('state','PUT',{revision:state.revision,settings:entry.settings},entry);saved=settings;return true;}
      finally {busy=false;}
    },
    remember:settings=>{saved=settings;},
  };
}
