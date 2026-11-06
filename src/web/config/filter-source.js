// 원격 JS를 실행하지 않는 제한 판독기. 전체 정적 선언과 알려진 참조만 읽는다.
export function tokens(text) {
  const out = [];
  const re = /\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|[A-Za-z_$][\w$]*|./gy;
  let m;
  while ((m = re.exec(text))) {
    const v = m[0];
    if (/^\s|^\/\//.test(v) || v.startsWith('/*')) continue;
    out.push({ v, start: m.index, end: re.lastIndex });
  }
  return out;
}

function stringValue(t) {
  let out='';
  const escapes={'"':'"',"'":"'",'\\':'\\',b:'\b',f:'\f',n:'\n',r:'\r',t:'\t'};
  for(let i=1;i<t.length-1;i++) {
    let c=t[i];if(c!=='\\'){if(c<' ')throw Error('검토 필요: 문자열 줄바꿈');out+=c;continue;}
    c=t[++i];if(c==='u'&&/^[0-9a-fA-F]{4}$/.test(t.slice(i+1,i+5))){out+=String.fromCharCode(parseInt(t.slice(i+1,i+5),16));i+=4;}
    else if(Object.hasOwn(escapes,c))out+=escapes[c];else throw Error('검토 필요: 지원하지 않는 문자열 escape');
  }
  return out;
}
const keyValue=t=>t.startsWith('"')||t.startsWith("'")?stringValue(t):/^[A-Za-z_$][\w$]*$/.test(t)?t:(()=>{throw Error('검토 필요: 동적/미지원 속성 키');})();

// 객체 전체를 끝까지 읽는다. 알려진 정적 참조만 펼치며 명시 키·spread 사이 중복도 거부한다.
function readAt(text,offset,resolve=()=>{throw Error('검토 필요: 정적 참조 밖의 값');}) {
  const ts=tokens(text.slice(offset));let i=0;
  const take=()=>{if(!ts[i])throw Error('잘린 원본');return ts[i++].v;};
  const reference=()=>{let name=take();while(ts[i]?.v==='.'&&/^[A-Za-z_$]/.test(ts[i+1]?.v??'')){i++;name+='.'+take();}return resolve(name);};
  const read=(depth=0)=>{
    if(depth>12||i>20000)throw Error('리터럴 한도');
    const t=take();
    if(t==='['||t==='{') {
      const obj=t==='{',end=obj?'}':']',result=obj?{}:[];
      const put=(k,v)=>{if(['__proto__','constructor','prototype'].includes(k)||Object.hasOwn(result,k))throw Error('검토 필요: 중복/금지 속성 '+k);result[k]=v;};
      while(ts[i]?.v!==end) {
        if(ts[i]?.v==='.'&&ts[i+1]?.v==='.'&&ts[i+2]?.v==='.') {
          i+=3;const value=reference();
          if(obj){if(!value||Array.isArray(value)||typeof value!=='object')throw Error('검토 필요: 객체 spread');for(const [k,v]of Object.entries(value))put(k,v);}
          else {if(!Array.isArray(value))throw Error('검토 필요: 배열 spread');result.push(...value);}
        } else if(obj) {const k=keyValue(take());if(take()!==':')throw Error('검토 필요: 객체 값이 아님');put(k,read(depth+1));}
        else result.push(read(depth+1));
        if(ts[i]?.v===end)break;if(take()!==',')throw Error('검토 필요: 표현식은 허용하지 않음');
      }
      take();return result;
    }
    if(t.startsWith('"')||t.startsWith("'"))return stringValue(t);
    if(t==='null')return null;if(t==='true'||t==='false')return t==='true';
    if(/^-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(t)&&Number.isFinite(+t))return +t;
    if(/^[A-Za-z_$][\w$]*$/.test(t)){i--;return reference();}
    throw Error('검토 필요: 허용하지 않는 리터럴');
  };
  const value=read();return {value,start:offset+ts[0].start,end:offset+ts[i-1].end,next:ts[i]?.v};
}
export function literalAt(text,marker) {
  const at=text.indexOf(marker);if(at<0||text.indexOf(marker,at+marker.length)>=0)throw Error('검토 필요: '+marker);
  return readAt(text,at+marker.length);
}
function sourceReader(text) {
  const ts=tokens(text),cache=new Map(),pending=new Set();
  const references=['SLIDER_DEF','NO_MATERIAL','CRAYON_ROWS','CRAYON_NORMAL','CRAYON_FLOW'];
  const resolve=name=>{
    const [base,...path]=name.split('.');if(!references.includes(base)||path.some(k=>!['set','rows'].includes(k)))throw Error('검토 필요: 미지원 정적 참조 '+name);
    let value=declaration(base).value;for(const key of path){if(!value||!Object.hasOwn(value,key))throw Error('검토 필요: 없는 정적 참조');value=value[key];}return value;
  };
  const declaration=name=>{
    if(cache.has(name))return cache.get(name);if(pending.has(name))throw Error('검토 필요: 순환 참조');
    const matches=ts.filter((t,i)=>t.v==='const'&&ts[i+1]?.v===name&&ts[i+2]?.v==='=');
    if(matches.length!==1)throw Error('검토 필요: 선언 누락/중복 '+name);
    pending.add(name);const at=matches[0].start,index=ts.findIndex(t=>t.start===at);
    const p=readAt(text,ts[index+3].start,resolve);if(p.next!==';')throw Error('검토 필요: 선언 뒤 표현식 '+name);
    pending.delete(name);cache.set(name,p);return p;
  };
  const property=(name,...keys)=>{
    let p=declaration(name);
    for(const key of keys){
      if(!p.value||Array.isArray(p.value)||!Object.hasOwn(p.value,key))throw Error('검토 필요: 속성 없음 '+key);
      const sub=tokens(text.slice(p.start,p.end));let depth=0,found=null;
      for(let i=0;i<sub.length;i++){
        const t=sub[i].v;
        if(depth===1&&sub[i+1]?.v===':'&&keyValue(t)===key){found=readAt(text,p.start+sub[i+2].start,resolve);break;}
        if(t==='{'||t==='[')depth++;else if(t==='}'||t===']')depth--;
      }
      // 대상 속성 자체가 spread에만 있으면 위치를 임의로 추정해 마스킹하지 않는다.
      if(!found)throw Error('검토 필요: 대상 속성은 명시 선언해야 합니다');p=found;
    }
    return p;
  };
  return {declaration,property};
}

export const SOURCE_URLS = Object.freeze({ module: 'https://nau-filter-gallery.vercel.app/nau-filter/nau-filter.js', gallery: 'https://nau-filter-gallery.vercel.app/' });
export const OIL_KEYS = Object.freeze(['OIL.w.0','OIL.w.1','OIL.w.2','OIL.len','OIL.jit','OIL.bump','OIL.spec','OIL.canvas','OIL.refineT','OIL.eye','OIL.edge','OIL.spill','OIL.slope','OIL.halo','GRADE.keepW']);
export const TOP_KEYS = Object.freeze(['strength','size','boil','fps','grade','level']);
export const PORT_KEYS = Object.freeze(['tfmBody','strokeStep','strokeWidth','strokeFns','finishBody','blobFragment','blb']);
export async function digest(text) {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(v => v.toString(16).padStart(2,'0')).join('');
}

function shader(text, name) {
  const t = tokens(text), at = t.findIndex((x,i) => x.v === 'const' && t[i+1]?.v === name && t[i+2]?.v === '=');
  if (at < 0) throw Error(`셰이더 없음: ${name}`);
  let i = at + 3;
  while (t[i] && !t[i].v.startsWith('`') && t[i].v !== ';') i++;
  if (!t[i]?.v.startsWith('`') || t[i].v.includes('${')) throw Error('셰이더 구조 변경');
  return { value: t[i].v.slice(1,-1), start:t[i].start+1, end:t[i].end-1 };
}
function slot(src, a, b) {
  const start = src.indexOf(a), end = src.indexOf(b, start + a.length);
  if (start < 0 || end < 0) throw Error(`이식 위치 변경: ${a}`);
  return src.slice(start+a.length,end);
}
const clean = text => tokens(text).map(t => t.v.startsWith('`') ? '`'+t.v.slice(1,-1).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g,'').replace(/\s+/g,'')+'`' : t.v).join(' ');

// 갤러리의 설정 적용·level·memo 우선순위 및 이벤트 연결을 검사한다.
// CSS/소스 목록 등 주변 HTML과 이미 별도 판독하는 데이터 선언은 제외한다.
function uiSkeleton(html,reader) {
  const start=html.indexOf('const PER ='), end=html.indexOf('</script>',start);
  if(start<0||end<0)throw Error('검토 필요: 갤러리 설정 실행 영역 없음');
  let region=html.slice(start,end);
  const cuts=['PER_DEF','CTRL_BASE','CTRL','TUNE_ROWS','GRADE_ROW','LEVELS'].map(n=>reader.declaration(n)).filter(p=>p.start>=start&&p.end<=end).sort((a,b)=>b.start-a.start);
  for(const p of cuts)region=region.slice(0,p.start-start)+'DATA'+region.slice(p.end-start);
  return clean(region);
}
function validatePreset(p) {
  const allowed=['label','sbr','layers','refine','strength','size','boil','fps','grade','level','tune'];
  if(!p||Object.keys(p).some(k=>!allowed.includes(k))||p.sbr!==1||typeof p.label!=='string'||p.label.length>100)throw Error('검토 필요: 지원하지 않는 preset 의미');
  if(!p.tune||Object.keys(p.tune).length!==OIL_KEYS.length||OIL_KEYS.some(k=>!Number.isFinite(p.tune[k])))throw Error('검토 필요: preset tune 변경');
  for(const k of TOP_KEYS)if(k in p&&!Number.isFinite(p[k]))throw Error('검토 필요: preset 수치 오류');
}

// 원본 전체 실행 코드를 지문화한다. 허용한 수치와 GLSL 조각 밖의 변경은 자동 이식하지 않는다.
export async function extractFilter(module, html, baseline = null) {
  if (typeof module !== 'string' || typeof html !== 'string' || module.length > 500000 || html.length > 800000 || !html.trimEnd().endsWith('</html>')) throw Error('잘못되거나 잘린 원본');
  const meta = /갤러리 ([0-9a-f]{7,40}) (\d{4}-\d{2}-\d{2})/.exec(module.slice(0,600));
  if (!meta || !module.trimEnd().endsWith('}')) throw Error('원본 버전 또는 끝 구조 없음');
  const ms=sourceReader(module),hs=sourceReader(html);
  const preset = ms.property('PRESETS','oil2f');
  validatePreset(preset.value);
  const rootPreset = hs.property('PRESETS','oil2f');
  const levels = ms.property('LEVELS','oil2f','rows');
  const rootLevels = hs.property('LEVELS','oil2f','rows');
  const oil = ms.declaration('OIL');
  const per = ms.declaration('SLIDER_DEF');
  if(JSON.stringify(per.value)!==JSON.stringify(hs.declaration('SLIDER_DEF').value))throw Error('검토 필요: 공통 기본값 배포 불일치');
  // PER_DEF의 spread는 실행하지 않고, 알려진 참조 하나만 명시적으로 펼친다.
  const flowDefault=ms.declaration('CR').value.tfmE;
  if(flowDefault!==hs.declaration('CR').value.tfmE)throw Error('검토 필요: 방향장 기본값 배포 불일치');
  const knownState=[...TOP_KEYS,'flat','mood','moodK','normal'];
  const keys=(value,allowed)=>{if(!value||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw Error('검토 필요: 알 수 없는 관련 속성');};
  for(const source of [ms,hs]) {
    keys(source.declaration('PER_DEF').value,knownState);keys(source.declaration('SLIDER_DEF').value,['strength','size','boil']);
    keys(source.property('LEVELS','oil2f').value,['rows','normal']);
    const perKeys=source.declaration('PER').value;
    if(!Array.isArray(perKeys)||new Set(perKeys).size!==perKeys.length||perKeys.some(k=>!knownState.includes(k)))throw Error('검토 필요: PER 항목 변경');
  }
  const pd = ms.declaration('PER_DEF').value;
  const rootPd=hs.declaration('PER_DEF').value;
  if(JSON.stringify(pd)!==JSON.stringify(rootPd) || JSON.stringify(oil.value)!==JSON.stringify(hs.declaration('OIL').value))throw Error('검토 필요: 기본값 배포 불일치');
  if (JSON.stringify(preset.value) !== JSON.stringify(rootPreset.value) || JSON.stringify(levels.value) !== JSON.stringify(rootLevels.value)) throw Error('검토 필요: 모듈과 갤러리의 preset/level 배포 불일치');
  const rows = hs.property('TUNE_ROWS','oil').value;
  const gradeRow = hs.declaration('GRADE_ROW').value;
  if(!Array.isArray(gradeRow)||gradeRow.length!==6)throw Error('검토 필요: 색 보정 조절 정의 변경');
  const tune = [...rows, gradeRow];
  if(rows.some(r=>!Array.isArray(r)||r.length<6||r.length>7 || (r[6]!=null && r[6]!=='oil2f')))throw Error('검토 필요: 유화 조절 표시 조건 변경');
  if (tune.some(r => !OIL_KEYS.includes(r[0])) || OIL_KEYS.some(k => !tune.some(r => r[0] === k)) || tune.length !== OIL_KEYS.length) throw Error('검토 필요: 조절 항목 추가·삭제·중복');
  if (Object.keys(preset.value.tune).some(k=>!OIL_KEYS.includes(k))) throw Error('검토 필요: 알 수 없는 preset 항목');
  if (JSON.stringify(Object.keys(oil.value).sort()) !== JSON.stringify(['w','len','jit','bump','spec','canvas','refineT','eye','edge','spill','slope','halo'].sort())) throw Error('검토 필요: OIL 구조 변경');
  const ctrlBase=hs.declaration('CTRL_BASE').value;
  keys(ctrlBase,[...TOP_KEYS,'flat','moodK']);
  const ctrl=hs.property('CTRL','oil2f').value;
  if(Object.keys(ctrl).some(k=>!TOP_KEYS.includes(k)&&k!=='note'))throw Error('검토 필요: 공통 조절 항목 변경');
  const controls = TOP_KEYS.map(k => {
    const raw=ctrlBase[k], override=ctrl[k];
    if(!Array.isArray(raw)||raw.length!==4||(override!==undefined&&override!==null&&(!Array.isArray(override)||override.length>4)))throw Error('공통 조절 정의 오류');
    // oil2f에서 숨긴 strength/size도 기존 현장 조절 호환을 위해 기반 범위를 받는다.
    const [label,min,max,step]=raw.map((v,i)=>override?.[i]??v);
    return {id:'state.'+k,kind:'number',label,min,max,step,default:preset.value[k]??pd[k]??per.value[k]};
  });
  for (const [id,label,min,max,step,help] of tune) controls.push({ id,kind:'number',label,min,max,step,help,default:preset.value.tune[id] });
  const styleHtml=/<label>([^<]+)<\/label><select id="style">([\s\S]*?)<\/select>/.exec(html);
  const styleDefault=/style:\s*"([^"]+)"/.exec(module)?.[1];
  // 갤러리는 소스 종류에 따라 style을 고른다. 카메라 기본은 공개 모듈의 state.style이다.
  const rootStyle=/style:\s*"([^"]+)"/.exec(html.slice(html.indexOf('const state ='),html.indexOf('};',html.indexOf('const state ='))))?.[1];
  const stylePolicy='state.style = spec?.style || (SOURCES.find(s => s[1] === path)?.[0].startsWith("3D") ? "3d" : "flat");';
  if(rootStyle?rootStyle!==styleDefault:!clean(html).includes(clean(stylePolicy)))throw Error('검토 필요: 그림체 선택 정책 변경');
  if(!styleHtml || !styleDefault)throw Error('그림체 정의 없음');
  const options=[...styleHtml[2].matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map(m=>({value:m[1],label:m[2]}));
  if(options.map(o=>o.value).join(',')!=='flat,3d'||!options.some(o=>o.value===styleDefault))throw Error('검토 필요: 그림체 선택 변경');
  controls.push({id:'state.style',kind:'select',label:styleHtml[1],options,default:styleDefault});
  for (const c of controls.filter(c=>c.kind==='number')) if (![c.min,c.max,c.step,c.default].every(Number.isFinite) || c.min >= c.max || c.step <= 0 || c.default < c.min || c.default > c.max) throw Error(`잘못된 정의: ${c.id}`);
  const vs = shader(module,'VS_STROKE'), tfm = shader(module,'FS_TFM'), compose = shader(module,'FS_COMPOSE'), blob = shader(module,'FS_BLOB');
  for(const [name,part]of [['VS_STROKE',vs],['FS_TFM',tfm],['FS_COMPOSE',compose],['FS_BLOB',blob]])if(clean(part.value)!==clean(shader(html,name).value))throw Error('검토 필요: 셰이더 배포 불일치');
  const path = slot(vs.value,'dcur = normalize(mix(dcur, nd, .7));','p += dcur*s; trav += s;');
  const silEnd = path.indexOf('\n', path.indexOf('uNOSil > 0.'));
  if (silEnd < 0) throw Error('획 경로 구조 변경');
  const fnStart = vs.value.indexOf('bool spillTo('), fnEnd = vs.value.indexOf('\n}',fnStart);
  if (fnStart<0 || fnEnd<0) throw Error('획 도움 함수 없음');
  const port = {
    tfmBody:slot(tfm.value,'d2 = vec2(d.x*d.x - d.y*d.y, 2.*d.x*d.y);','vec2 m2 = mix(d2, t2, w);'),
    strokeStep:path.slice(silEnd+1),
    strokeWidth:slot(vs.value,'float taper = mix(.55, 1., 1. - pow(abs(t)*2., 2.));','gl_Position = vec4(p/uRes*2. - 1., 0., 1.);'),
    strokeFns:vs.value.slice(fnStart,fnEnd+2),
    finishBody:slot(compose.value,'if (uMedium == 1) {','float h0 = texture(uHgt, uv).r'),
    blobFragment:blob.value,
    blb:/float blb\(vec2 q\)\{[^\n]*?\}/.exec(compose.value)?.[0],
  };
  if (!port.blb) throw Error('덩이 지도 함수 없음');
  let skeleton = module;
  const cuts = [preset,levels,oil,per].sort((a,b)=>b.start-a.start);
  for(const c of cuts) skeleton = skeleton.slice(0,c.start)+'DATA'+skeleton.slice(c.end);
  // 기본값 변경도 동기화 대상이다.
  skeleton = skeleton.replace(/const PER_DEF = \{[^\n]*?\};/, 'const PER_DEF = DATA;');
  skeleton=skeleton.replace(/tfmE:\s*[\d.e+-]+/g,'tfmE:DATA').replace(/style:\s*"[^"]+"/g,'style:DATA');
  for (const s of Object.values(port)) skeleton = skeleton.replace(s,'SLOT');
  for (const k of PORT_KEYS) port[k] = port[k].replace(/\s*&&\s*uMedium == 1\b/g,'').replace(/\buMedium == 1\s*&&\s*/g,'');
  const fingerprint = await digest(clean(skeleton));
  if (baseline && fingerprint !== baseline.fingerprint) throw Error('검토 필요: 지원 이식 위치 밖의 엔진 코드가 바뀌었습니다');
  const uiFingerprint=await digest(uiSkeleton(html,hs));
  if(baseline && uiFingerprint!==baseline.uiFingerprint)throw Error('검토 필요: 갤러리 설정 적용 규칙이 바뀌었습니다');
  const bundle = { schema:1, meta:{ commit:meta[1],date:meta[2],sha256:await digest(module),htmlSha256:await digest(html),bytes:new TextEncoder().encode(module).length,source:SOURCE_URLS.module }, fingerprint,uiFingerprint,controls,preset:preset.value,levels:levels.value,flowDefault,port };
  validateBundle(bundle);
  return bundle;
}

export function validateBundle(b) {
  if (!b || b.schema!==1 || b.meta?.source!==SOURCE_URLS.module || !/^[a-f0-9]{64}$/.test(b.meta?.sha256) || !/^[a-f0-9]{64}$/.test(b.fingerprint) || !/^[a-f0-9]{64}$/.test(b.meta?.htmlSha256)) throw Error('잘못된 필터 묶음');
  validatePreset(b.preset);
  if(b.uiFingerprint!==undefined&&!/^[a-f0-9]{64}$/.test(b.uiFingerprint))throw Error('잘못된 UI 지문');
  const ids=[...TOP_KEYS.map(k=>'state.'+k),...OIL_KEYS,'state.style'];
  if (!Array.isArray(b.controls) || b.controls.length!==ids.length || new Set(b.controls.map(c=>c.id)).size!==ids.length) throw Error('조절 항목 수 불일치');
  if(b.controls.some(c=>c.id!=='state.style'&&c.kind!=='number'))throw Error('조절 종류 오류');
  for(const c of b.controls.filter(c=>c.kind!=='select')) if(!ids.includes(c.id)||c.kind!=='number'||typeof c.label!=='string'||c.label.length>100||![c.min,c.max,c.step,c.default].every(Number.isFinite)||c.min>=c.max||c.step<=0||c.min< -100||c.max>100||c.default<c.min||c.default>c.max) throw Error('조절 정의 오류');
  const style=b.controls.find(c=>c.id==='state.style');
  if(style?.kind!=='select'||style.options?.map(o=>o.value).join(',')!=='flat,3d'||!['flat','3d'].includes(style.default)||!Number.isFinite(b.flowDefault)||b.flowDefault<=0||b.flowDefault>1||typeof style.label!=='string'||style.label.length>100||style.options.some(o=>typeof o.label!=='string'||o.label.length>100))throw Error('그림체 정의 오류');
  for(const k of PORT_KEYS) if(typeof b.port?.[k]!=='string'||!b.port[k].trim()||b.port[k].length>30000||/`|\$\{|#extension|#include/.test(b.port[k])) throw Error('셰이더 조각 오류');
  if (!Array.isArray(b.preset?.layers)||b.preset.layers.length!==3||!b.preset.layers.every(l=>Array.isArray(l)&&l.length===6&&l.every(n=>Number.isFinite(n)&&n>=0&&n<200)&&l.slice(0,3).every(n=>n>0&&n<200))||!Array.isArray(b.preset.refine)||b.preset.refine.length!==5||!b.preset.refine.every(n=>Number.isFinite(n)&&n>=0&&n<200)||!b.preset.refine.slice(0,4).every(n=>n>0)) throw Error('붓 층 오류');
  if (!Array.isArray(b.levels)||b.levels.length!==6||new Set(b.levels.map(r=>r?.[0])).size!==6||!b.levels.every(r=>Array.isArray(r)&&['state.strength','state.size','OIL.canvas','OIL.jit','CR.nosilw','CR.tfmE'].includes(r[0])&&[4,7].includes(r.length)&&r.slice(1).every((n,i)=>n===null?i===1:Number.isFinite(n)&&n>=0&&n<=100))) throw Error('세기 곡선 오류');
  return b;
}

export function bundleChanges(a,b) {
  const changes=[];
  for(const c of b.controls){const p=a.controls.find(x=>x.id===c.id); if(!p)changes.push(`${c.label}: 새 항목 (기본 ${c.default})`); else for(const k of ['min','max','step','default'])if(c[k]!==p[k])changes.push(`${c.label} ${k}: ${p[k]} → ${c[k]}`);}
  for(const c of a.controls)if(!b.controls.some(x=>x.id===c.id))changes.push(`${c.label}: 삭제`);
  for(const k of ['preset','levels','port','flowDefault'])if(JSON.stringify(a[k])!==JSON.stringify(b[k]))changes.push(({preset:'붓 층·기본 수치',levels:'세기 곡선',port:'유화 엔진',flowDefault:'방향장 기준 수치'})[k]+' 변경');
  return changes;
}
