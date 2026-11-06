import { filterValues, setFilterValue } from '../config/filter-values.js';

// 조절 종류·범위·이름·기본값은 받은 정의로 구성한다. 원본 HTML은 DOM에 넣지 않는다.
export function createFilterTuning({panel,updates,getSettings,setSettings,acceptSaved,canChange,onDone=()=>{}}) {
  const host=panel.querySelector('[data-filter-updates]');
  if(!host)return {render(){}};
  const doc=host.ownerDocument;
  const status=doc.createElement('p');status.className='op-readout';status.setAttribute('role','status');
  const actions=doc.createElement('div');actions.className='op-actions';
  const details=doc.createElement('p');details.className='op-readout';
  const controls=doc.createElement('div');
  host.append(status,actions,details,controls);
  let error='',waiting=false,key=null,inputs=[];
  const labels={check:'업데이트 확인',trial:'후보 시험',apply:'필터 적용·저장',rollback:'이전판 복원',defaults:'가져온 기본값 적용'};
  const buttons=new Map();
  for(const [action,label]of Object.entries(labels)){
    const b=doc.createElement('button');b.type='button';b.textContent=label;b.dataset.filterAction=action;actions.append(b);buttons.set(action,b);
    b.addEventListener('click',async()=>{
      if(waiting)return;
      waiting=true;error='';render();
      try {
        if(!canChange())throw Error('촬영이 끝난 뒤 필터를 바꾸세요');
        const next=await updates[action](getSettings());
        if(action==='apply'||action==='rollback')acceptSaved(next);
        else if(next)setSettings(next);
      }catch(e){error=e.message;if(action==='apply')setSettings(updates.restore());}
      finally{waiting=false;render();onDone();}
    });
  }
  function render(){
    const info=updates.getInfo(), b=info.definition;
    const active=info.active?.meta.commit??'기본 제공판', candidate=info.candidate?.meta.commit;
    status.textContent=`현재 ${active}${candidate?` · 후보 ${candidate}`:''} · ${waiting?'처리 중…':error||info.note}`;
    details.textContent=info.changes.join(' · ');
    for(const [action,button]of buttons)button.disabled=info.unavailable||waiting||info.busy||!canChange()||(action==='trial'&&!info.candidate)||(action==='apply'&&!info.canApply)||(action==='rollback'&&!info.previous)||(action==='defaults'&&!b);
    // 기존 수치 UI는 이전 기본판에서만 쓴다. 새 판은 같은 값도 받은 정의로 만든다.
    for(const k of ['strength','size','boil','fps','grade','refineThreshold']){
      const input=panel.querySelector(`input[data-key="${k}"]`);if(input)input.closest('label').hidden=!!b;
    }
    if(key!==b){
      key=b;controls.replaceChildren();inputs=[];
      for(const c of b?.controls??[]){
        const row=doc.createElement('label');row.className='op-row';
        const label=doc.createElement('span');label.className='op-label';label.textContent=c.label;
        const help=doc.createElement('small');help.textContent=`받은 기본값 ${c.default}`;label.append(help);
        const input=doc.createElement(c.kind==='select'?'select':'input');if(c.kind==='select'){for(const o of c.options){const opt=doc.createElement('option');opt.value=o.value;opt.textContent=o.label;input.append(opt);}}else input.type='range';input.min=String(c.min);input.max=String(c.max);input.step=String(c.step);input.dataset.filterId=c.id;
        const output=doc.createElement('output');output.className='op-value';
        row.append(label,input,output);controls.append(row);inputs.push({c,input,output});
        input.addEventListener('input',()=>{if(!canChange()||waiting)return;setSettings(setFilterValue(b,getSettings(),c.id,c.kind==='select'?input.value:+input.value));render();});
      }
    }
    if(b){const settings=getSettings(),values=filterValues(b,settings);for(const {c,input,output}of inputs){input.value=String(values[c.id]);output.textContent=c.kind==='select'?c.options.find(o=>o.value===values[c.id])?.label:String(+values[c.id].toFixed(6));input.disabled=waiting||settings.oil===false||!canChange();}}
  }
  render();return {render,isBusy:()=>waiting||updates.getInfo().busy};
}
