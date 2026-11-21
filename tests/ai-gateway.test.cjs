const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const {spawn} = require('node:child_process');
const {createGateway, normalizeBase} = require('../ai-gateway.cjs');

test('API address normalization and credential destination isolation', async t => {
  assert.equal(normalizeBase('https://relay.example'), 'https://relay.example/v1');
  assert.equal(normalizeBase('https://relay.example/api/v1/chat/completions/'), 'https://relay.example/api/v1');
  assert.equal(normalizeBase('https://relay.example/v1/responses'), 'https://relay.example/v1');
  assert.throws(()=>normalizeBase('http://relay.example/v1'), /HTTPS/);
  assert.throws(()=>normalizeBase('https://key@relay.example/v1'), /密码/);
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-ai-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const ai=createGateway(dir);
  ai.save({baseUrl:'https://relay.example/v1',apiKey:'secret-test',model:'gpt-6.1-sol'});
  assert.equal(JSON.stringify(ai.publicConfig()).includes('secret-test'),false);
  ai.save({baseUrl:'https://relay.example/v1',apiKey:'',model:'relay/gpt-custom'});
  assert.equal(createGateway(dir).publicConfig().model,'relay/gpt-custom');
  assert.throws(()=>ai.save({baseUrl:'https://different.example/v1',apiKey:'',model:'test'}),/重新输入密钥/);
});

test('relay config API, discovery, Responses and Chat generation, errors and persistence', async t => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-integration-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const requests=[];
  const sourceParagraph='冬季值班时，图书角的借阅记录依然放在前台，开放安排临时调整由工作人员手写说明。读者通常先在书架上选书，再到入口的服务台登记归还日期。';
  const sourceText=sourceParagraph+'\n\n初次到访者常从东门进入，容易错过写着还书流程的小纸条。原来的说明贴在前台桌面内侧，只有已经走到工作人员旁边时才看得到。午间前台交班时有一段空档。';
  const reference={title:'图书角走访',source:'街区通讯',url:'https://example.test/notes'};
  const upstream=http.createServer(async(req,res)=>{
    let text='';for await(const chunk of req) text+=chunk;
    const body=text?JSON.parse(text):null;requests.push({url:req.url,auth:req.headers.authorization,body});
    res.setHeader('Content-Type','application/json');
    if(req.url==='/v1/models') return res.end(JSON.stringify({data:[{id:'gpt-6.1-sol'},{id:'relay/custom'},{id:'relay/custom'}]}));
    if(body.model==='bad-key'){res.writeHead(401);return res.end(JSON.stringify({error:{message:'secret-integration'}}));}
    if(body.model==='proxy-timeout'){res.writeHead(524);return res.end('upstream timeout');}
    if(body.model==='proxy-unavailable'){res.writeHead(503);return res.end('private upstream diagnostic');}
    if(body.model==='empty')return res.end('{}');
    if(body.model==='truncated') return res.end(JSON.stringify({status:'incomplete',output:[{type:'message',content:[{type:'output_text',text:'不完整内容'}]}]}));
    if(req.url==='/v1/responses')return res.end(JSON.stringify({status:'completed',output:[{type:'reasoning',summary:[]},{type:'message',content:[{type:'output_text',text:'# 协议测试文章\n\n连接成功'}]}],usage:{input_tokens:15,output_tokens:20}}));
    const fixtures={
      'thin-material':'【需要补充素材】\n请提供活动记录和主办方的原始公告。',
      'copied-draft':'# 新标题\n\n'+sourceText,
      'duplicate-draft':'# 新标题\n\n'+sourceParagraph+'\n\n**'+sourceParagraph+'**',
      'no-reference':'# 第一次到图书角，先看哪个方向\n\n把还书提示移到读者抵达的位置。',
      'new-draft':'# 第一次到图书角，先看哪个方向\n\n把还书提示移到读者抵达的位置。\n\n[来源：街区通讯]('+reference.url+')',
      'altered-rewrite':JSON.stringify({summary:'改写',rewrite:'周六借出的 30 本书。',changes:[]}),
      'faithful-rewrite':JSON.stringify({summary:'改写',rewrite:'周六借出了 30 本书（[登记表]('+reference.url+')）。',changes:[]})
    };
    return res.end(JSON.stringify({choices:[{message:{content:[{type:'text',text:fixtures[body.model]||'# Chat 测试文章\n\n连接成功'}]},finish_reason:'stop'}]}));
  });
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
  const relay='http://127.0.0.1:'+upstream.address().port+'/v1';
  const accountDir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-integration-accounts-'));
  const child=spawn(process.execPath,[path.join(__dirname,'..','server.cjs')],{env:{...process.env,HOST:'127.0.0.1',PORT:'0',AI_CONFIG_PATH:path.join(dir,'ai-config.json'),ACCOUNT_DB_PATH:path.join(accountDir,'accounts.sqlite'),AI_API_KEY:'',OPENAI_API_KEY:''},stdio:['ignore','pipe','pipe']});
  child.once('exit',()=>fs.rmSync(accountDir,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
  t.after(()=>child.kill());
  // Use the listener's actual port so this test never collides with a running site.
  let port;
  await new Promise((resolve,reject)=>{child.stdout.once('data',data=>{const m=String(data).match(/127\.0\.0\.1:(\d+)/);port=Number(m?.[1]);resolve();});child.once('error',reject);child.once('exit',code=>reject(new Error('server exit '+code)));});
  const base='http://127.0.0.1:'+port;
  const status=await(await fetch(base+'/api/status')).json();
  const headers={'Content-Type':'application/json','X-Studio-Token':status.token};
  const post=(route,data,extra={})=>fetch(base+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(data)});
  const config={baseUrl:relay+'/responses',apiKey:'secret-integration',model:'gpt-6.1-sol',protocol:'responses',reasoning:'low'};
  assert.equal((await post('/api/ai/config',config,{Origin:'https://evil.example'})).status,403);
  const save=await post('/api/ai/config',config);assert.equal(save.status,200);assert.equal((await save.json()).hasKey,true);
  const safe=await(await fetch(base+'/api/ai/config',{headers})).json();assert.equal(JSON.stringify(safe).includes('secret-integration'),false);assert.equal(safe.baseUrl,relay);
  const same={...config,baseUrl:relay,apiKey:''};
  const listed=await post('/api/ai/models',same);assert.deepEqual((await listed.json()).models,['gpt-6.1-sol','relay/custom']);
  const probe=await post('/api/ai/test',same);assert.equal(probe.status,200);assert.match((await probe.json()).content,/连接成功/);
  assert.equal((await(await fetch(base+'/api/status')).json()).verified.model,'gpt-6.1-sol');
  const generated=await post('/api/generate',{topic:'周末留白',model:'relay/custom',mode:'outline'});assert.equal(generated.status,200);assert.equal((await generated.json()).model,'relay/custom');
  let last=requests.at(-1);assert.equal(last.url,'/v1/responses');assert.equal(last.auth,'Bearer secret-integration');assert.equal(last.body.store,false);assert.equal(last.body.reasoning.effort,'low');assert.match(last.body.input,/周末留白/);assert.equal(last.body.max_output_tokens,16000);
  assert.doesNotMatch(last.body.instructions,/中文原创文章编辑/);
  const bad=await post('/api/ai/test',{...same,model:'bad-key'});assert.equal(bad.status,502);const message=await bad.text();assert.match(message,/401/);assert.equal(message.includes('secret-integration'),false);
  assert.equal((await post('/api/ai/test',{...same,model:'empty'})).status,502);
  assert.equal((await post('/api/ai/test',{...same,model:'truncated'})).status,502);
  const slowTool=await post('/api/tool',{tool:'quality',model:'proxy-timeout',text:'短文',options:{focus:['结构']},deep:true});assert.equal(slowTool.status,502);assert.match((await slowTool.json()).error,/524.*等待期限/);
  const unavailableTool=await post('/api/tool',{tool:'humanize',model:'proxy-unavailable',text:'短文',options:{intensity:'均衡'},deep:true});assert.equal(unavailableTool.status,502);const unavailableMessage=await unavailableTool.text();assert.match(unavailableMessage,/503.*当前不可用|服务商已为此密钥开放/);assert.equal(unavailableMessage.includes('private upstream diagnostic'),false);
  await post('/api/ai/config',{...same,protocol:'chat',tokenField:'max_tokens',reasoning:'auto'});
  const chat=await post('/api/generate',{topic:'真实主题',model:'relay/custom',length:5000});assert.equal(chat.status,200);assert.match((await chat.json()).content,/Chat/);
  last=requests.at(-1);assert.equal(last.url,'/v1/chat/completions');assert.equal(last.body.max_tokens,16000);assert.equal(last.body.reasoning_effort,undefined);
  assert.match(last.body.messages[1].content,/目标长度：约 3000 字/); // Old clients are capped at the largest remaining option.
  assert.match(last.body.messages[1].content,/让情绪有来处/);
  assert.match(last.body.messages[1].content,/长短句和段落可有变化/);
  assert.match(last.body.messages[1].content,/不强行升华/);
  assert.match(last.body.messages[1].content,/不强制 Markdown 一级标题/);
  assert.match(last.body.messages[0].content,/不是展示结构多完美/);
  assert.match(last.body.messages[0].content,/中文原创文章编辑/);
  assert.match(last.body.messages[0].content,/初稿就检查模板节奏/);
  assert.match(last.body.messages[0].content,/标题的人情味/);
  assert.match(last.body.messages[0].content,/三个有不同切口的标题/);
  assert.match(last.body.messages[0].content,/结尾的自然互动/);
  assert.match(last.body.messages[0].content,/最多一个问题/);
  for(const length of [1000,2000,3000,4000]) {
    assert.equal((await post('/api/generate',{topic:'字数范围测试',mode:'outline',length})).status,200);
    assert.match(requests.at(-1).body.messages[1].content,new RegExp('目标长度：约 '+Math.min(length,3000)+' 字'));
  }
  const draft=(model,extra={})=>post('/api/generate',{topic:sourceText,mode:'article',model,...extra});
  const enough=await draft('new-draft',{reference});assert.equal(enough.status,200);assert.match((await enough.json()).content,/街区通讯/);
  assert.match(requests.at(-1).body.messages[1].content,/街区通讯.*example\.test\/notes/);
  const thin=await draft('thin-material');assert.equal(thin.status,422);assert.match((await thin.json()).error,/原始公告/);
  const copied=await draft('copied-draft',{reference});assert.equal(copied.status,422);assert.match((await copied.json()).error,/大段沿用了参考原文/);
  const missing=await draft('no-reference',{reference});assert.equal(missing.status,422);assert.match((await missing.json()).error,/漏掉了.*来源链接/);
  const duplicate=await draft('duplicate-draft');assert.equal(duplicate.status,422);assert.match((await duplicate.json()).error,/大段重复/);
 const rewrite=(model,options)=>post('/api/tool',{tool:'humanize',text:'周六记录借出 30 本书。\n\n你家附近的图书角有类似经历吗？欢迎说说。见 '+reference.url,deep:true,model,options});
  const changed=await rewrite('altered-rewrite',{articleWorkflow:true});assert.equal(changed.status,422);assert.match((await changed.json()).error,/原稿仍在/);
  const faithful=await rewrite('faithful-rewrite',{articleWorkflow:true});assert.equal(faithful.status,200);assert.match((await faithful.json()).analysis.rewrite,/30 本/);
  assert.match(requests.at(-1).body.messages[0].content,/保留原稿的切入点/);
  assert.match(requests.at(-1).body.messages[0].content,/保留标题中已有的人物处境/);
  assert.match(requests.at(-1).body.messages[0].content,/保留问题指向/);
  assert.equal((await rewrite('altered-rewrite',{})).status,200); // Standalone editing still uses its original contract.
  const restored=createGateway(dir).publicConfig();assert.equal(restored.protocol,'chat');assert.equal(restored.configured,true);
  assert.equal((await fetch(base+'/ai-config.json')).status,404);
});

test('humanizer defaults to fast reasoning, uses a compact response schema, and bounds short-draft output',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-humanizer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let seen;const output={summary:'删去重复套话并保持原意。',rewrite:'规律运动有助于增强体质，也可能改善心情。',changes:[{before:'值得一提的是',after:'',reason:'删除无实义套话'}]};
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
 const ai=createGateway(dir);ai.save({baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKey:'only-mock',model:'humanize-test',protocol:'chat'});
 const result=await ai.runTool({tool:'humanize',text:'在日常生活中，很多人都会发现规律运动非常重要。值得一提的是，运动可以增强体质。',options:{intensity:'均衡',reasoning:'low'}});
 assert.equal(result.analysis.rewrite,output.rewrite);assert.equal(result.analysis.changes.length,1);assert.equal(seen.reasoning_effort,'low');assert.equal(seen.max_completion_tokens,8000);
 const prompt=seen.messages[1].content;assert.match(prompt,/changes 仅列最多 6 项重要/);assert.match(prompt,/完整编辑稿/);assert.doesNotMatch(prompt,/"questions"|"titles"|"topics"|"dimensions"/);
 const system=seen.messages[0].content;assert.match(system,/中文编辑检查点/);assert.match(system,/层叠的“的”/);assert.match(system,/读者上下文/);assert.match(system,/对照示例/);assert.match(system,/同一次回答内部完成/);
 assert.doesNotMatch(system,/allowed-tools:|AskUserQuestion/); // Upstream tool permissions stay outside runtime prompts.
 assert.match(system,/标题中已有的生活细节/);
 assert.match(system,/不额外添加互动/);
 await ai.generate({mode:'humanize',topic:'原稿中的信息。'});
 assert.match(seen.messages[0].content,/中文编辑检查点/);
 assert.match(seen.messages[0].content,/可以原样保留/);
 assert.equal(seen.max_completion_tokens,18000);
});

test('humanizer retries once when the model response is not valid JSON',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-humanizer-format-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const requests=[];const output={summary:'删去重复套话并保持原意。',rewrite:'规律运动有助于增强体质。',changes:[]};
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;requests.push(JSON.parse(raw));res.setHeader('Content-Type','application/json');const content=requests.length===1?'结果如下：这不是 JSON':JSON.stringify(output);res.end(JSON.stringify({choices:[{message:{content},finish_reason:'stop'}]}));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
 const ai=createGateway(dir);ai.save({baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKey:'only-mock',model:'humanize-test',protocol:'chat'});
 const result=await ai.runTool({tool:'humanize',text:'值得一提的是，规律运动可以增强体质。',options:{intensity:'均衡',reasoning:'low'}});
 assert.equal(requests.length,2);assert.equal(result.analysis.rewrite,output.rewrite);assert.match(requests[1].messages.at(-1).content,/未能解析为有效 JSON/);assert.equal(requests[1].reasoning_effort,'low');
});
test('Responses tools and vision retain typed image blocks and chat roles', async t => {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-tools-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let seen;
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'completed',output_text:JSON.stringify({summary:'完整的分析',issues:[],rewrite:'识别文字'}),usage:{input_tokens:10,output_tokens:5}}));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
 const ai=createGateway(dir);ai.save({baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKey:'only-mock',model:'vision-test',protocol:'responses'});
 const image='data:image/png;base64,iVBORw0KGgoAAAAA';
 const r=await ai.runTool({tool:'image',image});assert.equal(r.analysis.rewrite,'识别文字');assert.equal(seen.input[0].content[1].type,'input_image');assert.equal(seen.input[0].content[1].image_url,image);assert.equal(seen.store,false);
 await ai.chat({messages:[{role:'user',content:'问题'},{role:'assistant',content:'回答'},{role:'user',content:'追问'}],context:'原稿'});assert.deepEqual(seen.input.slice(-3).map(m=>m.role),['user','assistant','user']);assert.equal(seen.input.at(-1).content,'追问');
});

test('quality refinement sends only selected dimensions and a shorter completion cap for short drafts',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'studio-quality-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 let seen;const output={summary:'优先收紧开头并补充论证。',dimensions:[{name:'结构层次',score:78,reason:'开头铺垫重复。',suggestion:'提前提出核心问题。'},{name:'论证',score:70,reason:'结论缺少来源。',suggestion:'补上可核验出处。'}],rewrite:'完整的精修稿。'};
 const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen=JSON.parse(raw);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:'stop'}]}));});
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
 const ai=createGateway(dir);ai.save({baseUrl:'http://127.0.0.1:'+upstream.address().port+'/v1',apiKey:'only-mock',model:'quality-test',protocol:'chat'});
 const result=await ai.runTool({tool:'quality',text:'短篇原稿，开头重复铺垫，正文结论需要来源。',options:{focus:['结构','论证'],reasoning:'low',goal:'优先改善论证'}});
 assert.equal(result.analysis.dimensions.length,2);assert.equal(result.analysis.rewrite,output.rewrite);assert.equal(seen.max_completion_tokens,10000);assert.equal(seen.reasoning_effort,'low');
 const prompt=seen.messages[1].content;assert.match(prompt,/只按以下选中维度精修：结构、论证/);assert.match(prompt,/保留原稿事实、数字、限定、观点与段落结构/);assert.doesNotMatch(prompt,/"issues":/);
});
