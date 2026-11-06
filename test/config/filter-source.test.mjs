import {test} from 'node:test';
import assert from 'node:assert/strict';
import {extractFilter} from '../../src/web/config/filter-source.js';
import {sourceFixture} from '../fixtures/filter-source.mjs';
const src=sourceFixture(),base=await extractFilter(src.module,src.gallery);
test('합성 원본에서 22개 정의와 모든 preset/layers/refine/level을 추출',async()=>{
  const b=await extractFilter(src.module,src.gallery,base);
  assert.equal(b.controls.length,22);assert.equal(b.controls.find(c=>c.id==='OIL.jit').default,.096);
  assert.equal(b.levels[0][6],.55);
});
test('원본 수치·범위·간격 변경은 새 정의로 반영하고 과거 하드코딩을 쓰지 않는다',async()=>{
  const module=src.module.replace('"strength":0.29','"strength":0.37');
  const html=src.gallery.replace('"strength":0.29','"strength":0.37').replace('["강도",0,1.6,0.01]','["강도",0,2,0.02]');
  const b=await extractFilter(module,html,base), c=b.controls.find(c=>c.id==='state.strength');
  assert.deepEqual([c.default,c.max,c.step],[.37,2,.02]);
});
test('모듈과 UI의 preset, 기본값, 셰이더 배포 불일치 거절',async()=>{
  for(const mutate of [s=>s.replace('"strength":0.29','"strength":0.4'),s=>s.replace('canvas:.02','canvas:.03'),s=>s.replace('float R = k == 0 ? 20.','float R = k == 0 ? 21.')])await assert.rejects(extractFilter(src.module,mutate(src.gallery),base),/불일치/);
});
test('지원 위치 밖 코드·알 수 없는 조절 항목·잘린 원본은 적용하지 않는다',async()=>{
  await assert.rejects(extractFilter(src.module.replace('createFilter() {}','createFilter() { alert(1); }'),src.gallery,base),/검토 필요/);
  await assert.rejects(extractFilter(src.module,src.gallery.replace('"OIL.len","획 길이"','"OIL.new","획 길이"'),base),/추가·삭제/);
  await assert.rejects(extractFilter(src.module.slice(0,-5),src.gallery,base));
  await assert.rejects(extractFilter(src.module,src.gallery.slice(0,-10),base));
});

test('oil2f CTRL 덮어쓰기와 여러 줄 preset 키를 판독한다',async()=>{
  const html=src.gallery.replace('oil2f:  ','oil2f:\n  ').replace('boil:["획 다시 놓기"]','boil:["획 다시 놓기",0,0.8,0.02]');
  const b=await extractFilter(src.module,html,base),c=b.controls.find(c=>c.id==='state.boil');
  assert.deepEqual([c.label,c.min,c.max,c.step],['획 다시 놓기',0,.8,.02]);
});
