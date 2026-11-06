// 개발 전용 HTTP 회귀. 자기 PS 서버·작업 폴더 설정만 사용하고 종료 시 복원한다.
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {createServer} from 'node:net';
import {readFileSync,existsSync,unlinkSync,rmdirSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {backupFile,restoreFile} from './browser-check-lib.mjs';
import {extractFilter,validateBundle} from '../src/web/config/filter-source.js';
import {config} from '../src/web/config/config.js';
import {normalizeEffectSettings,serializeEffectSettings} from '../src/web/config/effect-settings.js';
const root=resolve(import.meta.dirname,'..'),path=join(root,'config/filter.local.json');
const hadDir=existsSync(join(root,'config')),backup=backupFile(path);
const builtin=JSON.parse(readFileSync(join(root,'src/web/config/filter-builtin.json'),'utf8'));
const settings=JSON.parse(serializeEffectSettings(normalizeEffectSettings(config.effect,config.effect).settings));
const headers={'Content-Type':'application/json','X-Photobooth':'1'};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
let server,origin,count=0;
async function request(name,method='GET',body,extra=headers) {
  return fetch(origin+'/local-api/filter-'+name,{method,headers:extra,...(body===undefined?{}:{body:JSON.stringify(body)})});
}
async function start() {
  const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  origin='http://localhost:'+port;
  server=spawn('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File','bin/server/serve.ps1','-Port',String(port)],{cwd:root,windowsHide:true,stdio:'ignore'});
  const end=Date.now()+15000;
  while(Date.now()<end){try{if((await request('state')).ok)return;}catch{}await pause(100);}
  throw Error('test server failed');
}
function stop(){if(server?.pid)spawnSync('taskkill',['/PID',String(server.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});server=null;}
async function status(name,method,body,expected,extra=headers){const r=await request(name,method,body,extra);assert.equal(r.status,expected,await r.text());count++;}
try {
  if(existsSync(path))unlinkSync(path);
  await start();
  await status('check','POST',{},403,{'Content-Type':'application/json'});
  await status('check','POST',{},403,{...headers,Origin:'https://example.com'});
  await status('check','PUT',{},405);
  await status('check','POST',{url:'https://example.com'},400);
  await status('candidate','PUT',{data:'x'.repeat(140000)},413);
  const raw=await (await request('check','POST',{})).json();
  const candidate=await extractFilter(raw.module,raw.gallery,builtin);
  for(const change of [b=>b.preset.layers[0][1]=0,b=>b.preset.refine[0]=0,b=>b.preset.layers[0][0]=200,b=>b.preset.refine[4]=null,b=>b.controls[0].default=1.5,b=>b.port.strokeStep='']) {
    const invalid=structuredClone(candidate);change(invalid);await status('candidate','PUT',invalid,400);
  }
  const id=candidate.meta.sha256+':'+candidate.meta.htmlSha256;
  await status('candidate','PUT',candidate,200);
  await status('apply','POST',{revision:0,id,settings,before:settings},200);
  const applied=await (await request('state')).json();validateBundle(applied.active.bundle);assert.deepEqual(applied.active.bundle,candidate);
  stop();await start();
  const reboot=await (await request('state')).json();assert.deepEqual(reboot,applied);validateBundle(reboot.active.bundle);
  await status('state','PUT',{revision:reboot.revision,settings},200);
  await status('rollback','POST',{revision:reboot.revision+1},200);
  const rolled=await (await request('state')).json();assert.equal(rolled.active.bundle,null);
  stop();await start();assert.deepEqual(await (await request('state')).json(),rolled);
  console.log(JSON.stringify({httpAssertions:count,checkApplySaveRestartRollbackRestart:true,source:candidate.meta}));
} finally {
  stop();const result=restoreFile(backup);assert.equal(result.ok,true,JSON.stringify(result));
  if(!hadDir&&existsSync(join(root,'config')))rmdirSync(join(root,'config'));
}
