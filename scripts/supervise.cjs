'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {randomUUID}=require('node:crypto');
const {setTimeout:delay}=require('node:timers/promises');

async function supervise({directory=path.join(__dirname,'..'),entry='server.cjs',env=process.env,intervalMs=10000,healthTimeoutMs=3000,restartDelayMs=1500}={}){
  env={...env};
  const envPath=path.join(directory,'.env');
  if(fs.existsSync(envPath))for(const line of fs.readFileSync(envPath,'utf8').split(/\r?\n/)){
    const match=line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if(match&&env[match[1]]===undefined)env[match[1]]=match[2].replace(/^(['"])(.*)\1$/,'$2');
  }
  const port=Number(env.PORT||4175),host=env.HOST||'127.0.0.1';
  const dataDir=path.join(directory,'data');fs.mkdirSync(dataDir,{recursive:true});
  const lock=path.join(dataDir,`service-${port}.lock`),instance=randomUUID();
  // Exclusively own the supervisor slot; never terminate a process found only by port or stale PID.
  let descriptor;
  for(let attempt=0;attempt<2;attempt++){
    try{descriptor=fs.openSync(lock,'wx');break;}catch(e){
      if(e.code!=='EEXIST')throw e;
      let previous;try{previous=JSON.parse(fs.readFileSync(lock,'utf8'));}catch{throw new Error('服务锁正在初始化，请稍后重试。');}
      try{process.kill(previous.pid,0);console.log(`网站守护已运行：http://${host}:${port}`);return;}catch(error){if(error.code!=='ESRCH')throw error;}
      fs.unlinkSync(lock);
    }
  }
  if(descriptor===undefined)throw new Error('无法取得服务锁。');
  fs.writeFileSync(descriptor,JSON.stringify({pid:process.pid,instance}));fs.closeSync(descriptor);
  const release=()=>{try{if(JSON.parse(fs.readFileSync(lock,'utf8')).instance===instance)fs.unlinkSync(lock);}catch{}};
  process.once('exit',release);
  let stopping=false,child,restarts=[],stopWorker=()=>{};
  const stop=()=>{stopping=true;stopWorker();};
  process.once('SIGINT',stop);process.once('SIGTERM',stop);
  const url=`http://${host.includes(':')?'['+host+']':host}:${port}/api/health`;
  const logFile=path.join(dataDir,`service-${port}.log`);
  const log=event=>{const line=JSON.stringify({at:new Date().toISOString(),...event})+'\n';fs.appendFileSync(logFile,line);process.stdout.write(line);};
  try{
    // A pre-existing site belongs to its existing owner; avoid a restart loop on occupied ports.
    try{const r=await fetch(url,{signal:AbortSignal.timeout(1500)});if(r.ok){console.log(`网站已运行：http://${host}:${port}`);return;}}catch{}
    while(!stopping){
      if(fs.existsSync(logFile)&&fs.statSync(logFile).size>5*1024*1024)fs.renameSync(logFile,logFile+'.previous');
      const output=fs.createWriteStream(logFile,{flags:'a'});
      child=spawn(process.execPath,[entry],{cwd:directory,env:{...env,PORT:String(port),HOST:host,STUDIO_INSTANCE_ID:instance},windowsHide:true,stdio:['ignore','pipe','pipe']});
      const worker=child;
      let killTimer;
      stopWorker=()=>{
        if(killTimer)return;
        worker.kill();
        killTimer=setTimeout(()=>{if(worker.exitCode===null&&worker.signalCode===null)worker.kill('SIGKILL');},5000);
        killTimer.unref();
      };
      child.stdout.pipe(output,{end:false});child.stderr.pipe(output,{end:false});
      log({event:'service_started',pid:child.pid,port});
      let failures=0,checking=false;
      const timer=setInterval(async()=>{
        if(checking||stopping)return;checking=true;
        try{
          const response=await fetch(url,{signal:AbortSignal.timeout(healthTimeoutMs)}),health=await response.json();
          if(!response.ok||health.instance!==instance)throw new Error('health mismatch');
          failures=0;
        }catch{if(++failures>=4&&child===worker&&worker.exitCode===null&&!killTimer){log({event:'health_failed',pid:worker.pid});stopWorker();}}
        finally{checking=false;}
      },intervalMs);
      const exit=await new Promise(resolve=>{child.once('error',error=>resolve({code:1,error:error.code}));child.once('exit',(code,signal)=>resolve({code,signal}));});
      clearInterval(timer);clearTimeout(killTimer);await new Promise(resolve=>output.end(resolve));
      log({event:'service_exited',...exit});
      if(stopping)break;
      restarts=restarts.filter(at=>Date.now()-at<60000);restarts.push(Date.now());
      if(restarts.length>=5){log({event:'restart_limit_reached'});process.exitCode=1;break;}
      await delay(restartDelayMs);
    }
  }finally{release();process.removeListener('exit',release);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);}
}
if(require.main===module)supervise().catch(error=>{console.error('启动失败：'+error.message);process.exitCode=1;});
module.exports={supervise};
