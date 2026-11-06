// 개발 검증 전용: 원본 JS는 실행하지 않고 GLSL 문자열 선언만 읽는다.
// 로컬 렌더러의 패스/획 버퍼에 원본 전체 셰이더를 연결해 이식 조각의 합성 결과를 독립 비교한다.
import {tokens} from '../src/web/config/filter-source.js';
export function referenceShaders(source) {
  const ts=tokens(source), memo={};
  function read(name,depth=0){
    if(depth>8)throw Error('GLSL declaration cycle');
    if(memo[name])return memo[name];
    let i=ts.findIndex((t,i)=>t.v==='const'&&ts[i+1]?.v===name&&ts[i+2]?.v==='=')+3;
    if(i<3)throw Error('GLSL declaration missing '+name);
    let s='';
    for(;ts[i]?.v!==';';i++){
      const v=ts[i].v;if(v==='+')continue;
      if(v.startsWith('`')&&!v.includes('${'))s+=v.slice(1,-1);
      else if(/^[A-Z_]+$/.test(v))s+=read(v,depth+1);
      else throw Error('Nonliteral GLSL expression');
    }
    memo[name]=s;return s;
  }
  const result={};
  for(const k of ['VS_STROKE','FS_STROKE','FS_UNDER','FS_COMPOSE','FS_GRADE','FS_TFM','FS_SST','FS_BLUR','FS_BLOB'])result[k]=read(k);
  // 같은 획 목록을 CPU에서 받는다. 원본 strokeIn이 만드는 aS와 같은 float32 자료형.
  result.VS_STROKE=result.VS_STROKE.replace('layout(location=0) in float aI; vec4 aS;','layout(location=0) in vec4 aS;').replace('aS = strokeIn(aI);','');
  for(const k of Object.keys(result))result[k]=result[k].replace('uniform int uMedium;','const int uMedium = 1;');
  // 원본 paintStrokes의 고정 바인딩. 추가 카메라·감열지 경로는 비교하지 않는다.
  result.FS_STROKE=result.FS_STROKE.replace('uOpacity, ','');
  result.FS_STROKE=result.FS_STROKE.replace('void main(){','const float uOpacity = 1.;\nvoid main(){');
  result.FS_COMPOSE=result.FS_COMPOSE.replace('uFlick, ','').replace('void main(){','const float uFlick = 1.;\nvoid main(){');
  return result;
}
