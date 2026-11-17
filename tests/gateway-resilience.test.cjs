const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {createGateway}=require('../ai-gateway.cjs');

test('only temporary upstream rejection retries once; auth, limits, timeouts and disconnects do not replay generation',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-resilience-'));
  let mode='recover',calls=0;
  const upstream=http.createServer(async(req,res)=>{
    for await(const chunk of req){}calls++;
    if(mode==='disconnect'){req.socket.destroy();return;}
    if(mode==='cancel'){res.writeHead(200,{'Content-Type':'application/json'});res.write('{');return;}
    if(mode==='recover'&&calls>1){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({choices:[{message:{content:'完整内容'},finish_reason:'stop'}]}));}
    res.writeHead(mode==='recover'?503:Number(mode));res.end('do-not-log-secret');
  });
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  t.after(()=>{upstream.closeAllConnections();upstream.close();fs.rmSync(dir,{recursive:true,force:true});});
  const ai=createGateway(dir);ai.save({baseUrl:`http://127.0.0.1:${upstream.address().port}/v1`,apiKey:'only-test',model:'test',protocol:'chat'});
  assert.equal((await ai.generate({topic:'test'})).content,'完整内容');assert.equal(calls,2);
  for(const next of ['401','429','503','504','524','disconnect']){
    mode=next;calls=0;await assert.rejects(ai.generate({topic:'test'}));assert.equal(calls,next==='503'?2:1,next);
  }
  mode='cancel';calls=0;const controller=new AbortController();
  const pending=ai.generate({topic:'test'},controller.signal);
  setTimeout(()=>controller.abort(),40);
  await assert.rejects(pending,e=>e.name==='AbortError');assert.equal(calls,1);
});

test('client cancellation releases generation capacity and aborted requests do not leave a busy backend',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-cancel-'));
  let received;const started=new Promise(resolve=>{received=resolve;});
  const upstream=http.createServer(async(req,res)=>{for await(const c of req){}res.writeHead(200,{'Content-Type':'application/json'});res.write('{');received();});
  await new Promise(r=>upstream.listen(0,'127.0.0.1',r));
  const child=spawn(process.execPath,[path.join(__dirname,'..','server.cjs')],{env:{...process.env,PORT:'0',HOST:'127.0.0.1',AUTH_REQUIRED:'false',AI_CONFIG_PATH:path.join(dir,'ai.json'),ACCOUNT_DB_PATH:path.join(dir,'account.sqlite'),AI_BASE_URL:`http://127.0.0.1:${upstream.address().port}/v1`,AI_API_KEY:'only-test',AI_MODEL:'test',AI_PROTOCOL:'chat'},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));upstream.closeAllConnections();upstream.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=await new Promise((resolve,reject)=>{child.stdout.once('data',d=>resolve('http://127.0.0.1:'+String(d).match(/127\.0\.0\.1:(\d+)/)[1]));child.once('error',reject);});
  const state=await(await fetch(base+'/api/status')).json();
  const denied=await fetch(base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':'stale'},body:'{"topic":"test"}'});
  assert.equal((await denied.json()).code,'TOKEN_EXPIRED');
  const controller=new AbortController();
  const pending=fetch(base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':state.token},body:'{"topic":"test"}',signal:controller.signal});
  const result=pending.catch(e=>e);
  await started;assert.equal((await(await fetch(base+'/api/health')).json()).activeRequests,1);
  controller.abort();assert.equal((await result).name,'AbortError');
  let active=1;const until=Date.now()+3000;
  while(active&&Date.now()<until){await new Promise(r=>setTimeout(r,20));active=(await(await fetch(base+'/api/health')).json()).activeRequests;}
  assert.equal(active,0);
});
