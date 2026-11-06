// 개발 전용. 임시 Chrome 프로필·자기 서버만 사용하며 실제 프레임은 저장하지 않는다.
import {spawn,spawnSync,execFile} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import assert from 'node:assert/strict';
import {config} from '../src/web/config/config.js';
import {normalizeEffectSettings,serializeEffectSettings} from '../src/web/config/effect-settings.js';
import {referenceShaders} from './filter-reference.mjs';
import {backupFile,restoreFile,createCdpSession} from './browser-check-lib.mjs';
const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const runtime=join(root,'runtime','stage13');mkdirSync(runtime,{recursive:true});
const profile=mkdtempSync(join(runtime,'chrome-'));
const backups=['filter','effect','camera','presence','timing'].map(n=>backupFile(join(root,'config',n+'.local.json')));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let server,chrome,cdp;
const log=(label,value)=>console.log(label,JSON.stringify(value));
async function until(fn,message,ms=20000){const end=Date.now()+ms;let last;while(Date.now()<end){try{last=await fn();if(last)return last;}catch(e){last=e.message;}await sleep(150);}throw Error(message+': '+last);}
try {
  const port=await new Promise(r=>{const s=createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const origin=`http://localhost:${port}`;
  server=spawn('powershell',['-NoProfile','-ExecutionPolicy','Bypass','-File',join(root,'bin/server/serve.ps1'),'-Port',String(port)],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',()=>{});server.stderr.on('data',d=>console.error(String(d)));
  await until(async()=> (await fetch(origin)).ok,'server');
  const chromePath=['C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
  chrome=spawn(chromePath,['--headless=new',`--user-data-dir=${profile}`,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--window-size=1080,1920','--autoplay-policy=no-user-gesture-required',...(process.argv.includes('--real')?[]:['--use-fake-device-for-media-stream']),'about:blank'],{windowsHide:true,stdio:'ignore'});
  const page=await until(async()=>{const p=readFileSync(join(profile,'DevToolsActivePort'),'utf8').split('\n')[0];return (await(await fetch(`http://127.0.0.1:${p}/json/list`)).json()).find(t=>t.type==='page');},'chrome');
  const ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});cdp=createCdpSession(ws,{timeoutMs:60000});
  const evalJS=async expression=>{const r=await cdp.send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description??r.exceptionDetails.text);return r.result.value;};
  const errors=[];cdp.on(e=>{if(e.method==='Runtime.exceptionThrown')errors.push(e.params.exceptionDetails.exception?.description??e.params.exceptionDetails.text);});
  await cdp.send('Runtime.enable');await cdp.send('Page.enable');await cdp.send('Browser.setPermission',{permission:{name:'camera'},setting:'granted',origin});
  await cdp.send('Page.navigate',{url:origin});
  await until(()=>evalJS(`!!document.querySelector('[data-filter-action="check"]')`),'filter UI');
  await sleep(1500);
  const key=async code=>{await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',code,key:code==='Escape'?'Escape':code.slice(3).toLowerCase()});await cdp.send('Input.dispatchKeyEvent',{type:'keyUp',code});};
  await key('KeyP');await key('KeyE');
  await evalJS(`document.querySelector('button[data-section="effect"]').click()`);
  const action=async name=>{await evalJS(`document.querySelector('[data-filter-action="${name}"]').click()`);await until(()=>evalJS(`!document.querySelector('[data-filter-action="check"]').disabled`),'action '+name,60000);return evalJS(`document.querySelector('[data-filter-updates] [role="status"]').textContent`);};
  const getState=()=>fetch(origin+'/local-api/filter-state').then(r=>r.json());
  const before=await getState();
  const legacyStrength='input[data-key="strength"]';
  const originalStrength=await evalJS(`document.querySelector('${legacyStrength}').value`);
  await evalJS(`{const input=document.querySelector('${legacyStrength}');input.value='.9';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  for(let i=0;i<2;i++){log('check',await action('check'));assert.equal(await evalJS(`document.querySelector('${legacyStrength}').value`),'0.9');assert.deepEqual(await getState(),before);}
  await cdp.send('Network.enable');await cdp.send('Network.setBlockedURLs',{urls:['*local-api/filter-check']});
  log('offline check',await action('check'));assert.equal(await evalJS(`document.querySelector('${legacyStrength}').value`),'0.9');
  await cdp.send('Network.setBlockedURLs',{urls:[]});await action('check');
  log('trial',await action('trial'));
  assert.equal(await evalJS(`document.querySelectorAll('[data-filter-id]').length`),22);
  assert.deepEqual(await getState(),before);
  await evalJS(`{const input=document.querySelector('[data-filter-id="state.strength"]');input.value='.8';input.dispatchEvent(new Event('input',{bubbles:true}));}`);
  await action('check');assert.equal(await evalJS(`document.querySelector('[data-filter-id="state.strength"]').value`),'0.8');
  assert.equal(await evalJS(`document.querySelector('[data-filter-action="apply"]').disabled`),true);
  await action('trial');assert.equal(await evalJS(`document.querySelector('[data-filter-id="state.strength"]').value`),'0.8');
  await cdp.send('Network.setBlockedURLs',{urls:['*local-api/filter-check']});await action('check');await action('defaults');
  assert.equal(await evalJS(`document.querySelector('[data-filter-id="state.strength"]').value`),'0.29');
  await cdp.send('Network.setBlockedURLs',{urls:[]});
  await key('Escape');await key('KeyE');await evalJS(`document.querySelector('button[data-section="effect"]').click()`);
  assert.equal(await evalJS(`document.querySelector('${legacyStrength}').value`),originalStrength);
  await action('check');await action('trial');
  log('unsaved settings','success/repeat/offline/trial recheck/retrial/close passed');
  log('defaults',await action('defaults'));
  log('apply',await action('apply'));
  const applied=await getState();assert.ok(applied.active.bundle);assert.equal(applied.active.settings.settings.strength,.29);assert.equal(applied.active.bundle.controls.length,22);
  log('active',{revision:applied.revision,meta:applied.active.bundle.meta});
  const raw=await (await fetch(origin+'/local-api/filter-check',{method:'POST',headers:{'Content-Type':'application/json','X-Photobooth':'1'},body:'{}'})).json();
  const reference=referenceShaders(raw.module);
  // 실제 GPU: 합성 입력, 4 조합·두 용지 폭. 프레임/화소는 브라우저 메모리만.
  log('GPU',await evalJS(`(async()=>{
    const {createOilRenderer}=await import('/effect/oil-renderer.js');
    const {config}=await import('/config/config.js');
    const {importedDefaults,setFilterValue}=await import('/config/filter-values.js');
    const {normalizeEffectSettings}=await import('/config/effect-settings.js');
    const bundle=await(await fetch('/config/filter-builtin.json')).json();
    const source=new OffscreenCanvas(180,320),ctx=source.getContext('2d');
    const g=ctx.createLinearGradient(0,0,180,320);g.addColorStop(0,'#ecb8aa');g.addColorStop(.4,'#205044');g.addColorStop(1,'#dddfff');ctx.fillStyle=g;ctx.fillRect(0,0,180,320);
    ctx.fillStyle='#fff';ctx.fillRect(40,40,90,150);ctx.fillStyle='#16111c';ctx.beginPath();ctx.arc(70,70,9,0,Math.PI*2);ctx.fill();
    const base=importedDefaults(bundle,normalizeEffectSettings(config.effect,config.effect).settings);
    const renderer=createOilRenderer({canvas:new OffscreenCanvas(180,320),bundle});
    const results=[];
    for(const oil of [false,true])for(const mono of [false,true])for(const paperDots of [384,576]){
      const settings={...base,oil,outputMode:mono?'gray-oil':'off',paperDots};
      const a=renderer.render(source,{settings,width:180,height:320,referenceShortSide:180,seed:17,output:'pixels'});
      const b=renderer.render(null,{settings,width:180,height:320,referenceShortSide:180,seed:17,output:'pixels'});
      if(a.pixels.some((v,i)=>v!==b.pixels[i]))throw Error('same frame differs');
      if((oil && !a.strokes)||(!oil && a.strokes))throw Error('stroke bypass');
      if(mono!==!!a.mask)throw Error('print mode');
      results.push({oil,mono,paperDots,strokes:a.strokes,print:a.mask?.length??0});
    }
    const reference={...base,outputMode:'off'};
    const original=renderer.render(source,{settings:reference,width:180,height:320,referenceShortSide:180,seed:17,output:'pixels'}).pixels;
    const {filterShaders}=await import('/effect/filter-shaders.js');
    const sourceShaders=${JSON.stringify(reference)}, localShaders=filterShaders(bundle);
    const refCanvas=new OffscreenCanvas(180,320),refGl=refCanvas.getContext('webgl2');
    const shaderSource=refGl.shaderSource.bind(refGl);
    refGl.shaderSource=(shader,src)=>{const key=Object.keys(sourceShaders).find(k=>localShaders[k]===src);shaderSource(shader,key?sourceShaders[key]:src);};
    const refRenderer=createOilRenderer({canvas:refCanvas,bundle});
    const sourcePixels=refRenderer.render(source,{settings:reference,width:180,height:320,referenceShortSide:180,seed:17,output:'pixels'}).pixels;
    let sourceDiff=0,sourceMax=0;for(let i=0;i<original.length;i++){const d=Math.abs(original[i]-sourcePixels[i]);sourceDiff+=d;sourceMax=Math.max(sourceMax,d);}
    refRenderer.dispose();
    if(sourceDiff/original.length>0.5)throw Error('source GLSL mismatch '+sourceDiff/original.length);
    const changed=[];
    for(const c of bundle.controls.filter(c=>c.id!=='state.fps')){
      const value=c.kind==='select'?'3d':c.default===c.min?c.max:c.min;
      const s=setFilterValue(bundle,reference,c.id,value);
      const a=renderer.render(source,{settings:s,width:180,height:320,referenceShortSide:180,seed:17,output:'pixels'}).pixels;
      let diff=0;for(let i=0;i<a.length;i++)diff+=Math.abs(a[i]-original[i]);if(!diff)throw Error('parameter has no GPU effect '+c.id);changed.push({id:c.id,diff:diff/a.length});
    }
    const {createEffectPreview}=await import('/effect/effect-preview.js');
    source.videoWidth=180;source.videoHeight=320;
    const trialPreview=createEffectPreview({canvas:document.createElement('canvas'),video:source,camera:{isReady:()=>false},stageAspect:9/16,settings:reference});
    trialPreview.replaceFilter(bundle,reference,false);
    const broken=structuredClone(bundle);broken.port.strokeFns+=' this is invalid GLSL;';
    let rejected=false;try{trialPreview.replaceFilter(broken,reference,false);}catch{rejected=true;}
    if(!rejected||trialPreview.getBundle()!==bundle||!trialPreview.renderStill().pixels)throw Error('shader failure lost current engine');
    trialPreview.stop();
    let clock=0,frame;
    const cadence=createEffectPreview({canvas:document.createElement('canvas'),video:source,camera:{isReady:()=>true},stageAspect:9/16,settings:{...reference,previewScale:.25},now:()=>clock,raf:fn=>{frame=fn;return 1;},cancelRaf:()=>{},idle:()=>1,cancelIdle:()=>{}});
    cadence.start();cadence.replaceFilter(bundle,{...reference,previewScale:.25},true);
    for(clock=0;clock<=1000;clock+=10)frame();
    const receivedFps=cadence.getState().drawingsPerSecond;
    cadence.setSettings({fps:7});for(;clock<=2100;clock+=10)frame();
    const adjustedFps=cadence.getState().drawingsPerSecond;cadence.stop();
    if(Math.abs(receivedFps-reference.fps)>1||Math.abs(adjustedFps-7)>1)throw Error('fps cadence mismatch');
    renderer.dispose();if(Object.values(renderer.liveResources()).some(n=>n))throw Error('GPU resource leak');
    return {results,changed,cadence:{receivedFps,adjustedFps},compileFailureRetained:true,sourceComparison:{mean:sourceDiff/original.length,max:sourceMax}};
  })()`));
  await cdp.send('Page.reload');await until(()=>evalJS(`document.querySelector('[data-filter-updates] [role="status"]')?.textContent.includes('${applied.active.bundle.meta.commit}')`),'restart');
  await sleep(1800);await key('KeyP');await key('KeyE');await evalJS(`document.querySelector('button[data-section="effect"]').click()`);
  log('rollback',await action('rollback'));const rolled=await getState();assert.deepEqual(rolled.active,applied.previous);
  await cdp.send('Page.reload');await until(()=>evalJS(`!!document.querySelector('[data-filter-action="check"]')`),'rollback restart');
  // 실제 HTTP API: method, header, origin, size, URL 주입, revision 경쟁.
  const req=async(path,method,body,headers={})=>fetch(origin+path,{method,headers,body:JSON.stringify(body)}).then(r=>r.status);
  const headers={'Content-Type':'application/json','X-Photobooth':'1'};
  assert.equal(await req('/local-api/filter-check','POST',{}),403);
  assert.equal(await req('/local-api/filter-check','POST',{}, {...headers,Origin:'https://example.com'}),403);
  assert.equal(await req('/local-api/filter-check','POST',{url:'https://example.com'},headers),400);
  assert.equal(await req('/local-api/filter-check','PUT',{},headers),405);
  assert.equal(await req('/local-api/filter-apply','POST',{x:'x'.repeat(40000)},headers),413);
  assert.equal(await req('/local-api/filter-rollback','POST',{revision:-1},headers),409);
  assert.equal(await req('/local-api/filter-candidate','PUT',{schema:1},headers),400);
  const corrupt=structuredClone(applied.active.bundle);corrupt.levels[1]=corrupt.levels[0];
  assert.equal(await req('/local-api/filter-candidate','PUT',corrupt,headers),400);
  corrupt.levels=applied.active.bundle.levels;corrupt.port.strokeFns='void not_from_upstream(){}';
  assert.equal(await req('/local-api/filter-candidate','PUT',corrupt,headers),400);
  const forged=structuredClone(applied.active.bundle);forged.controls[0].default=1.5;forged.controls[0].label='not from source';forged.port.strokeStep='';
  const forgedStatus=await req('/local-api/filter-candidate','PUT',forged,headers);log('review P1 forged candidate',forgedStatus);assert.equal(forgedStatus,400);
  for(const [name,change] of Object.entries({default:b=>b.controls[0].default=1.5,label:b=>b.controls[0].label='not from source',empty:b=>b.port.strokeStep='',levels:b=>b.levels[0][1]=.15,preset:b=>b.preset.layers[0][0]=37,uiFingerprint:b=>b.uiFingerprint='0'.repeat(64)})){
    const b=structuredClone(applied.active.bundle);change(b);assert.equal(await req('/local-api/filter-candidate','PUT',b,headers),400,name);
  }
  assert.equal(await req('/local-api/filter-candidate','PUT',applied.active.bundle,headers),200);
  const stable=await getState();
  assert.equal(await req('/local-api/filter-apply','POST',{revision:stable.revision,id:applied.active.bundle.meta.sha256,settings:stable.active.settings,before:stable.active.settings},headers),400);
  const statePath=join(root,'config/filter.local.json'),stableBytes=readFileSync(statePath);
  const lock=spawn('powershell',['-NoProfile','-Command',"$s=[IO.File]::Open('config/filter.local.json',[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read);Write-Output 'locked';try {Start-Sleep -Seconds 15} finally {$s.Dispose()}"],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
  try {
    await new Promise((resolve,reject)=>{lock.stdout.once('data',resolve);lock.once('error',reject);lock.once('exit',code=>{if(code)reject(Error('lock process failed'));});});
    const changed=structuredClone(stable.active.settings);changed.settings.strength=.42;
    assert.equal(await req('/local-api/filter-state','PUT',{revision:stable.revision,settings:changed},headers),400);
    assert.deepEqual(readFileSync(statePath),stableBytes);assert.deepEqual(await getState(),stable);
  } finally {spawnSync('taskkill',['/PID',String(lock.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});}
  log('API security / atomic failure','19 passed');assert.deepEqual(errors,[]);
  if(process.argv.includes('--capture')) {
    await cdp.send('Page.navigate',{url:'about:blank'});
    const captureState={revision:applied.revision,active:{bundle:applied.active.bundle,settings:JSON.parse(serializeEffectSettings(normalizeEffectSettings(config.effect,config.effect).settings))},previous:applied.previous};
    writeFileSync(join(root,'config/filter.local.json'),JSON.stringify(captureState));
    const capture=await new Promise(resolve=>execFile(process.execPath,['tools/browser-check.mjs','--camera',process.argv.includes('--real')?'real':'fake','--only','시험 조합 4가지'],{cwd:root,windowsHide:true,maxBuffer:8*1024*1024},(error,stdout,stderr)=>resolve({code:error?.code??0,stdout,stderr})));
    writeFileSync(join(runtime,'latest-capture-'+(process.argv.includes('--real')?'real':'fake')+'.txt'),capture.stdout+capture.stderr);
    log('latest capture',{code:capture.code,tail:capture.stdout.slice(-6500)});assert.equal(capture.code,0);
  }
  log('PASS','check / trial / defaults / apply / reload / rollback / reload / GPU / API');
} finally {
  cdp?.close();
  for(const p of [chrome,server])if(p?.pid)spawnSync('taskkill',['/PID',String(p.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
  for(const b of backups){const result=restoreFile(b);if(!result.ok)console.error(result);}
  // Only this invocation's resolved temporary profile is deleted.
  if(resolve(profile).startsWith(resolve(runtime)+'\\'))rmSync(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
}
