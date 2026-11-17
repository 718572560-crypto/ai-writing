const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
async function freePort() {
  const probe = http.createServer();
  await new Promise((resolve, reject) => probe.listen(0, '127.0.0.1', resolve).once('error', reject));
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  return String(port);
}
async function start(env) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-server-fixture-'));
  const child = spawn(process.execPath, [path.join(__dirname,'..','server.cjs')], {env:{...process.env, HOST:'127.0.0.1', OPENAI_API_KEY:'', AI_PROTOCOL:'auto', AI_CONFIG_PATH:path.join(dir,'ai-config.json'), ACCOUNT_DB_PATH:path.join(dir,'accounts.sqlite'), ...env}, stdio:['ignore','pipe','pipe']});
  child.once('exit',()=>fs.rmSync(dir,{recursive:true,force:true,maxRetries:3,retryDelay:50}));
  let startupError='';child.stderr.on('data',data=>{startupError+=String(data);});
  await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',code=>reject(new Error('server exit '+code+' '+startupError)));});
  return child;
}
test('local service: assets, configuration, request validation, private files', async t => {
  const port = await freePort();
  const child = await start({PORT:port,AI_API_KEY:'',AI_MODEL:''});
  t.after(()=>child.kill());
  const base=`http://127.0.0.1:${port}`;
  const index=await fetch(base); assert.equal(index.status,200); assert.match(await index.text(),/有术 Studio/);
  const status=await (await fetch(base+'/api/status')).json(); assert.equal(status.configured,false); assert.ok(status.token);
  const forbidden=await fetch(base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'}); assert.equal(forbidden.status,403);
  const unconfigured=await fetch(base+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':status.token},body:'{"topic":"test"}'}); assert.equal(unconfigured.status,503);
  const deniedLink=await fetch(base+'/api/extract-link',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':status.token},body:'{"url":"http://127.0.0.1/private"}'}); assert.equal(deniedLink.status,400);
  assert.match((await deniedLink.json()).error,/公网/);
  const noTokenLink=await fetch(base+'/api/extract-link',{method:'POST',headers:{'Content-Type':'application/json'},body:'{"url":"https://mp.weixin.qq.com/s/example"}'}); assert.equal(noTokenLink.status,403);
  assert.equal((await fetch(base+'/.env')).status,404);
  assert.equal((await fetch(base+'/server.cjs')).status,404);
  assert.equal((await fetch(base+'/styles.css')).status,200);
  assert.equal((await fetch(base+'/missing')).status,404);
});
test('account mode authenticates admins, scopes cloud data by user, and protects admin APIs',async t=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-server-accounts-'));
  const child=await start({PORT:'4180',AUTH_REQUIRED:'true',ADMIN_EMAIL:'root@example.test',ADMIN_PASSWORD:'a-long-admin-password',ACCOUNT_DB_PATH:path.join(dir,'account.sqlite'),COOKIE_SECURE:'false',ENABLE_REGISTRATION:'false',AI_API_KEY:''});
  t.after(async()=>{child.kill();await new Promise(resolve=>child.once('exit',resolve));fs.rmSync(dir,{recursive:true,force:true});});
  const base='http://127.0.0.1:4180',status=await(await fetch(base+'/api/status')).json();
  assert.equal(status.authRequired,true);assert.equal(status.authenticated,false);assert.equal(status.paymentEnabled,false);assert.equal((await fetch(base+'/api/admin/dashboard')).status,401);assert.equal((await fetch(base+'/admin')).status,200);assert.equal((await fetch(base+'/api/auth/wechat/start')).status,503);
  async function login(email,password){const r=await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email,password})});assert.equal(r.status,200);const d=await r.json(),jar=Object.fromEntries(r.headers.getSetCookie().map(x=>x.split(';')[0].split('=')));return {csrf:d.csrf,cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; '),user:d.user};}
  const admin=await login('root@example.test','a-long-admin-password');
  assert.equal((await fetch(base+'/api/admin/payment-account',{headers:{'Cookie':admin.cookie}})).status,200);
  assert.equal((await fetch(base+'/api/admin/payment-account',{method:'PUT',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({accountName:'本地测试收款账户',appId:'wx-test',mchid:'1900000001',merchantSerial:'merchant-serial',platformSerial:'platform-serial',publicBaseUrl:'https://pay.example.test',merchantPrivateKeyBase64:'secret-private-key',platformPublicKeyBase64:'secret-platform-key',apiV3Key:'01234567890123456789012345678901'})})).status,200);
  const paymentSettings=await(await fetch(base+'/api/admin/payment-account',{headers:{'Cookie':admin.cookie}})).json();assert.equal(paymentSettings.account.accountName,'本地测试收款账户');assert.equal(paymentSettings.account.secrets.merchantPrivateKeyBase64,true);assert.equal(JSON.stringify(paymentSettings).includes('secret-private-key'),false);
  assert.equal((await fetch(base+'/api/admin/payment-account')).status,401);
  assert.match((await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:'root@example.test',password:'a-long-admin-password'})})).headers.get('set-cookie'),/SameSite=Lax/);
  const storedPlan=await fetch(base+'/api/admin/plans',{method:'POST',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({id:'monthly',name:'月度会员',days:30,credits:300,amountCents:2990})});assert.equal(storedPlan.status,200);assert.equal((await storedPlan.json()).plan.amountCents,2990);
  const storedCredits=await fetch(base+'/api/admin/plans',{method:'POST',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({id:'credits-500',name:'500 次包',kind:'credits',days:0,credits:500,amountCents:4900})});assert.equal(storedCredits.status,200);assert.equal((await storedCredits.json()).plan.kind,'credits');
  const memberCatalog=await(await fetch(base+'/api/membership')).json();assert.equal(memberCatalog.checkoutEnabled,false);assert.equal(memberCatalog.plans.find(p=>p.id==='monthly').name,'月度会员');assert.equal(memberCatalog.plans.find(p=>p.id==='credits-500').credits,500);assert.equal(memberCatalog.plans.find(p=>p.id==='credits-500').kind,'credits');
  assert.equal((await fetch(base+'/api/pay/wechat/orders',{method:'POST',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({planId:'monthly'})})).status,503);
  const created=await fetch(base+'/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({email:'writer@example.test',password:'a-long-user-password'})});assert.equal(created.status,201);const user=(await created.json()).user;
  const created2=await fetch(base+'/api/admin/users',{method:'POST',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({email:'other@example.test',password:'another-long-password'})});assert.equal(created2.status,201);
  const oldWriter=await login('writer@example.test','a-long-user-password'),other=await login('other@example.test','another-long-password');
  const memberOffers=await(await fetch(base+'/api/membership',{headers:{'Cookie':oldWriter.cookie}})).json();assert.equal(memberOffers.account.role,'user');assert.equal(memberOffers.account.credits,0);
  assert.equal((await fetch(base+'/admin',{headers:{'Cookie':oldWriter.cookie},redirect:'manual'})).status,404);
  assert.equal((await fetch(base+'/admin.html',{headers:{'Cookie':oldWriter.cookie},redirect:'manual'})).status,404);
  assert.equal((await fetch(base+'/admin',{headers:{'Cookie':admin.cookie},redirect:'manual'})).status,200);
  const passwordChange=await fetch(base+'/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json','Cookie':oldWriter.cookie,'X-CSRF-Token':oldWriter.csrf},body:JSON.stringify({currentPassword:'a-long-user-password',newPassword:'a-different-long-password'})});assert.equal(passwordChange.status,200);const changed=await passwordChange.json(),jar=Object.fromEntries(passwordChange.headers.getSetCookie().map(x=>x.split(';')[0].split('='))),writer={csrf:changed.csrf,cookie:Object.entries(jar).map(([k,v])=>k+'='+v).join('; ')};assert.equal((await fetch(base+'/api/account/data',{headers:{'Cookie':oldWriter.cookie}})).status,401);
  assert.equal((await login('writer@example.test','a-different-long-password')).user.id,user.id);
  const saved=await fetch(base+'/api/account/data',{method:'PUT',headers:{'Content-Type':'application/json','Cookie':writer.cookie,'X-CSRF-Token':writer.csrf},body:JSON.stringify({data:{drafts:[{title:'private draft'}],favorites:[]}})});assert.equal(saved.status,200);const revision=await saved.json();const staleSave=await fetch(base+'/api/account/data',{method:'PUT',headers:{'Content-Type':'application/json','Cookie':writer.cookie,'X-CSRF-Token':writer.csrf},body:JSON.stringify({data:{drafts:[]},expectedUpdatedAt:null})});assert.equal(staleSave.status,409);assert.ok(revision.updatedAt);
  const privateRead=await fetch(base+'/api/account/data',{headers:{'Cookie':other.cookie}});assert.equal((await privateRead.json()).data,null);
  const noCsrf=await fetch(base+'/api/admin/users/'+user.id+'/membership',{method:'PATCH',headers:{'Content-Type':'application/json','Cookie':admin.cookie},body:JSON.stringify({plan:'member',days:30,credits:300})});assert.equal(noCsrf.status,403);
  const granted=await fetch(base+'/api/admin/users/'+user.id+'/membership',{method:'PATCH',headers:{'Content-Type':'application/json','Cookie':admin.cookie,'X-CSRF-Token':admin.csrf},body:JSON.stringify({plan:'member',days:30,credits:300})});assert.equal(granted.status,200);assert.equal((await granted.json()).user.plan,'member');
  const dashboard=await(await fetch(base+'/api/admin/dashboard',{headers:{'Cookie':admin.cookie}})).json();assert.equal(dashboard.commerce.paymentEnabled,false);assert.equal(dashboard.orders.length,0);
  const suspendedPlan=await fetch(base+'/api/admin/plans/monthly',{method:'DELETE',headers:{'Cookie':admin.cookie,'X-CSRF-Token':admin.csrf}});assert.equal(suspendedPlan.status,200);assert.equal((await(await fetch(base+'/api/membership')).json()).plans.length,1);
  const suspendedCredits=await fetch(base+'/api/admin/plans/credits-500',{method:'DELETE',headers:{'Cookie':admin.cookie,'X-CSRF-Token':admin.csrf}});assert.equal(suspendedCredits.status,200);assert.equal((await(await fetch(base+'/api/membership')).json()).plans.length,0);
});
test('configured model gateway: prompts, success, invalid input, upstream failure', async t => {
  let seen;
  const upstream=http.createServer(async(req,res)=>{let text='';for await(const c of req)text+=c;seen={auth:req.headers.authorization,url:req.url,body:JSON.parse(text)};if(seen.body.messages[1].content.includes('FAIL')){res.writeHead(429);res.end('{}');return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content:'# 测试文章\n\n这是接口验证内容。'}}]}));});
  await new Promise(resolve=>upstream.listen(4176,'127.0.0.1',resolve));
  t.after(()=>upstream.close());
  const child=await start({PORT:'4177',AI_API_KEY:'test-only-key',AI_MODEL:'test-model',AI_BASE_URL:'http://127.0.0.1:4176/v1'});
  t.after(()=>child.kill());
  const base='http://127.0.0.1:4177';
  const status=await (await fetch(base+'/api/status')).json();assert.equal(status.configured,true);assert.equal(status.model,'test-model');assert.equal(JSON.stringify(status).includes('test-only-key'),false);
  const headers={'Content-Type':'application/json','X-Studio-Token':status.token};
  const response=await fetch(base+'/api/generate',{method:'POST',headers,body:JSON.stringify({topic:'周末留白',mode:'article',platform:'微信公众号',style:'自然叙述',length:1200})});
  assert.equal(response.status,200);assert.match((await response.json()).content,/测试文章/);assert.equal(seen.url,'/v1/chat/completions');assert.equal(seen.auth,'Bearer test-only-key');assert.equal(seen.body.model,'test-model');assert.match(seen.body.messages[1].content,/周末留白/);
  const humanized=await fetch(base+'/api/generate',{method:'POST',headers,body:JSON.stringify({topic:'这不仅是一个按钮，更是效率的新入口。让我们深入看看。',mode:'humanize',model:'test-model'})});
  assert.equal(humanized.status,200); assert.match(seen.body.messages[0].content,/中文去 AI 味编辑/); assert.match(seen.body.messages[0].content,/不保证通过任何 AI 检测器/); assert.match(seen.body.messages[1].content,/只输出完整的最终改写稿/); assert.match(seen.body.messages[1].content,/不增加事实/);
  assert.equal((await fetch(base+'/api/generate',{method:'POST',headers,body:'{"topic":""}'})).status,400);
  assert.equal((await fetch(base+'/api/generate',{method:'POST',headers,body:'not-json'})).status,400);
  const failure=await fetch(base+'/api/generate',{method:'POST',headers,body:'{"topic":"FAIL"}'});assert.equal(failure.status,502);assert.match((await failure.json()).error,/429/);
});
test('writing tools, image vision payload and contextual chat use the configured gateway', async t => {
  const seen=[];
  const upstream=http.createServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);seen.push(body);let content='{"summary":"已分析","score":86,"dimensions":[{"name":"结构","score":80,"reason":"背景较多。","suggestion":"提前说出问题。"}],"issues":[{"severity":"medium","type":"结构","quote":"开头","reason":"背景较多","suggestion":"提前说出问题"}],"rewrite":"# 改稿\\n\\n这里是经编辑预览的稿件。","questions":[],"suggestions":[]}';if(req.url==='/v1/chat/completions'&&body.messages.at(-1).content==='请解释建议')content='建议先明确文章要回答的问题。';res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{content}}],usage:{prompt_tokens:30,completion_tokens:20}}));});
  await new Promise(resolve=>upstream.listen(4179,'127.0.0.1',resolve));t.after(()=>upstream.close());
  const child=await start({PORT:'4178',AI_API_KEY:'test-only-key',AI_MODEL:'vision-test',AI_BASE_URL:'http://127.0.0.1:4179/v1'});t.after(()=>child.kill());
  const base='http://127.0.0.1:4178',status=await(await fetch(base+'/api/status')).json(),headers={'Content-Type':'application/json','X-Studio-Token':status.token};
  const scan=await fetch(base+'/api/tool',{method:'POST',headers,body:JSON.stringify({tool:'quality',text:'这是一个绝对保证有效的方法！！！',title:'',deep:false})});assert.equal(scan.status,200);assert.equal((await scan.json()).local.issues.some(x=>x.type==='绝对化/保证性表达'),true);
  const deep=await fetch(base+'/api/tool',{method:'POST',headers,body:JSON.stringify({tool:'quality',text:'开头较长。',title:'小标题',platform:'微信公众号',options:{focus:['结构'],reasoning:'low'},deep:true})});assert.equal(deep.status,200);const report=await deep.json();assert.equal(report.analysis.score,86);assert.equal(report.analysis.rewrite.includes('改稿'),true);assert.equal(report.analysis.dimensions.length,1);assert.match(seen.at(-1).messages[1].content,/只按以下选中维度精修：结构/);assert.equal(seen.at(-1).max_completion_tokens,10000);assert.equal(seen.at(-1).reasoning_effort,'low');
  const bytes=Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0,0,0,0,0]);
  const image=await fetch(base+'/api/image',{method:'POST',headers,body:JSON.stringify({image:'data:image/png;base64,'+bytes.toString('base64')})});assert.equal(image.status,200);assert.match(seen.at(-1).messages[1].content[1].image_url.url,/data:image\/png;base64/);
  const chat=await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({messages:[{role:'user',content:'请解释建议'}],context:'一篇需要检查的稿件',model:'vision-test'})});assert.equal(chat.status,200);assert.match((await chat.json()).content,/明确文章/);assert.match(seen.at(-1).messages[1].content,/一篇需要检查的稿件/);
  const bad=await fetch(base+'/api/chat',{method:'POST',headers,body:JSON.stringify({messages:[{role:'system',content:'x'}]})});assert.equal(bad.status,400);
  assert.equal(JSON.stringify(await(await fetch(base+'/api/status')).json()).includes('test-only-key'),false);
});

