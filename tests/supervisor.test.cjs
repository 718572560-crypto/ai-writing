const test=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {setTimeout:delay}=require('node:timers/promises');

test('supervisor restores a crashed worker, preserves startup settings and prevents duplicate workers',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-supervisor-'));
  const probe=http.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
  const port=probe.address().port;await new Promise(r=>probe.close(r));
  fs.writeFileSync(path.join(dir,'worker.cjs'),`const http=require('node:http');let hung=false;http.createServer((req,res)=>{if(req.url==='/exit-clean'){res.end('exiting');return setTimeout(()=>process.exit(0),10);}if(req.url==='/crash'){res.end('crashing');return setTimeout(()=>process.exit(1),10);}if(req.url==='/hang'){hung=true;return res.end('hanging');}if(hung)return;res.setHeader('Content-Type','application/json');res.end(JSON.stringify({instance:process.env.STUDIO_INSTANCE_ID,pid:process.pid,marker:process.env.TEST_MARKER}));}).listen(Number(process.env.PORT),'127.0.0.1');`);
  const modulePath=path.join(__dirname,'..','scripts','supervise.cjs');
  const code=`require(${JSON.stringify(modulePath)}).supervise({directory:${JSON.stringify(dir)},entry:'worker.cjs',intervalMs:100,healthTimeoutMs:100,restartDelayMs:50}).catch(e=>{console.error(e);process.exitCode=1;});`;
  const launch=()=>spawn(process.execPath,['-e',code],{env:{...process.env,PORT:String(port),HOST:'127.0.0.1',TEST_MARKER:'preserved'},stdio:['ignore','pipe','pipe']});
  const supervisor=launch();let worker;
  t.after(async()=>{
    supervisor.kill();try{process.kill(worker);}catch{}
    await delay(100);fs.rmSync(dir,{recursive:true,force:true});
  });
  const base=`http://127.0.0.1:${port}`;
  async function waitWorker(previous){
    const deadline=Date.now()+8000;
    while(Date.now()<deadline){
      try{const r=await fetch(base+'/api/health',{signal:AbortSignal.timeout(500)});const h=await r.json();if(h.instance&&h.pid!==previous)return h;}catch{}
      await delay(40);
    }
    throw new Error('Worker failed to recover');
  }
  const first=await waitWorker();worker=first.pid;assert.equal(first.marker,'preserved');
  const duplicate=launch();const exit=await new Promise(r=>duplicate.once('exit',r));assert.equal(exit,0);
  assert.equal((await(await fetch(base+'/api/health')).json()).pid,worker);
  await fetch(base+'/crash');const recovered=await waitWorker(worker);worker=recovered.pid;
  assert.equal(recovered.instance,first.instance);assert.equal(recovered.marker,'preserved');
  await fetch(base+'/exit-clean');const cleanRecovery=await waitWorker(worker);worker=cleanRecovery.pid;
  await fetch(base+'/hang');const restored=await waitWorker(worker);worker=restored.pid;
  assert.equal(restored.instance,first.instance);
  const log=fs.readFileSync(path.join(dir,'data',`service-${port}.log`),'utf8');
  assert.match(log,/health_failed/);assert.match(log,/service_exited/);assert.equal((log.match(/service_started/g)||[]).length,4);
});
