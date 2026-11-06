// 받은 기본값과 현장 덮어쓰기의 분리. DOM·네트워크 없음.
const top = id => id.startsWith('state.') ? id.slice(6) : id === 'OIL.refineT' ? 'refineThreshold' : null;
export function filterValues(bundle, settings) {
  const v = Object.fromEntries(bundle.controls.map(c=>[c.id,c.default]));
  for(const c of bundle.controls) {
    const k=top(c.id);
    if(k && !['level','style'].includes(k)) v[c.id]=k==='refineThreshold' ? settings.refine?.[4] ?? c.default : settings[k] ?? c.default;
  }
  v['state.style']=settings.gallery?.style ?? bundle.controls.find(c=>c.id==='state.style').default;
  v['CR.tfmE']=bundle.flowDefault;
  v['state.level']=settings.gallery?.level ?? bundle.controls.find(c=>c.id==='state.level').default;
  // 갤러리 applyTune 순서: preset → level → 명시 세부값. 상태 strength/size는 UI level 변경 때 계산한다.
  for(const r of bundle.levels) if(r[0].startsWith('OIL.')||r[0]==='CR.tfmE') {
    const [lo,mid,hi]=v['state.style']==='3d'&&r.length===7?r.slice(4):r.slice(1,4), m=mid ?? v[r[0]], s=v['state.level']/100;
    v[r[0]]=s<=.5 ? lo*(1-s*2)+m*s*2 : m*(2-s*2)+hi*(s*2-1);
  }
  Object.assign(v,settings.gallery?.values ?? {});
  return v;
}
export function setFilterValue(bundle,settings,id,value) {
  const def=bundle.controls.find(c=>c.id===id);
  if(!def||(def.kind==='number'&&!Number.isFinite(value))) throw Error('알 수 없는 필터 값');
  const n=def.kind==='select'?(def.options.some(o=>o.value===value)?value:def.default):Math.min(def.max,Math.max(def.min,value));
  const next={...settings,gallery:{style:settings.gallery?.style??bundle.controls.find(c=>c.id==='state.style').default,level:settings.gallery?.level??bundle.controls.find(c=>c.id==='state.level').default,values:{...settings.gallery?.values}}};
  const k=top(id);
  if(id==='state.level'||id==='state.style') {
    if(id==='state.style')next.gallery.style=n;else next.gallery.level=n;
    for(const r of bundle.levels) if(['state.strength','state.size'].includes(r[0])) {
      const [lo,mid,hi]=next.gallery.style==='3d'&&r.length===7?r.slice(4):r.slice(1,4), m=mid??bundle.controls.find(c=>c.id===r[0]).default, s=next.gallery.level/100;
      next[r[0].slice(6)]=s<=.5 ? lo*(1-s*2)+m*s*2 : m*(2-s*2)+hi*(s*2-1);
    }
  } else if(k==='refineThreshold') next.refine=[...(settings.refine??bundle.preset.refine).slice(0,4),n];
  else if(k) next[k]=n;
  else next.gallery.values[id]=n;
  return next;
}
export function importedDefaults(bundle,settings) {
  const next={...settings,layers:bundle.preset.layers,refine:bundle.preset.refine,gallery:{style:bundle.controls.find(c=>c.id==='state.style').default,level:50,values:{}}};
  for(const c of bundle.controls) {
    const k=top(c.id);
    if(k==='refineThreshold') next.refine=[...next.refine.slice(0,4),c.default];
    else if(k==='level') next.gallery.level=c.default;
    else if(k==='style') next.gallery.style=c.default;
    else if(k) next[k]=c.default;
  }
  return setFilterValue(bundle,next,'state.level',next.gallery.level);
}
export function migrateFilterValues(bundle,settings,previousBundle=null) {
  const next={...settings,layers:bundle.preset.layers,refine:settings.refine ? [...bundle.preset.refine.slice(0,4),settings.refine[4]] : null,gallery:{level:settings.gallery?.level??(previousBundle??bundle).controls.find(c=>c.id==='state.level').default,style:settings.gallery?.style??(previousBundle??bundle).controls.find(c=>c.id==='state.style').default,values:{...settings.gallery?.values}}};
  if(previousBundle){
    const old=filterValues(previousBundle,settings),fresh=filterValues(bundle,next);
    for(const c of previousBundle.controls)if(!top(c.id)&&bundle.controls.some(n=>n.id===c.id)&&old[c.id]!==fresh[c.id])next.gallery.values[c.id]=old[c.id];
  }
  const issues=[];
  const v=filterValues(bundle,next);
  for(const c of bundle.controls) if((c.kind==='number'&&(!Number.isFinite(v[c.id])||v[c.id]<c.min||v[c.id]>c.max))||(c.kind==='select'&&!c.options.some(o=>o.value===v[c.id]))) issues.push(`${c.label}: 현재 ${v[c.id]} / 범위 ${c.min}~${c.max}`);
  // 현장 값은 자동으로 자르거나 삭제하지 않는다. 충돌이면 적용 자체를 막아 먼저 운영자가 해결하게 한다.
  for(const k of Object.keys(next.gallery.values)) if(!bundle.controls.some(c=>c.id===k))issues.push(`${k}: 삭제된 현장 값`);
  if(issues.length)throw Error(`검토 필요: ${issues.join(', ')}`);
  return next;
}

export function filterLimits(bundle, legacy) {
  if(!bundle)return legacy;
  const limits={...legacy};
  for(const c of bundle.controls){const k=top(c.id);if(k && k!=='level')limits[k]={min:c.min,max:c.max,step:c.step};}
  return limits;
}
