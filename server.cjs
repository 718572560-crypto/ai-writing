const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash } = require('node:crypto');
const { fetchArticle } = require('./link-extractor.cjs');
const { createArticleLibrary } = require('./article-library.cjs');
const {scan,specs} = require('./writing-tools.cjs');
const {createAccountStore} = require('./account-store.cjs');
const {createPaymentSettings} = require('./payment-settings.cjs');
const root = path.join(__dirname, 'public');
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)\s*=\s*(.*)$/);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const ai = require('./ai-gateway.cjs').createGateway(__dirname);
const accounts = createAccountStore(process.env.ACCOUNT_DB_PATH || path.join(__dirname,'data','youshu.sqlite'));
const paymentSettings=createPaymentSettings(path.dirname(process.env.ACCOUNT_DB_PATH || path.join(__dirname,'data','youshu.sqlite')));
const articleLibrary=createArticleLibrary({dataDir:path.join(__dirname,'data','article-library')});
const {createWechatLogin}=require('./wechat-login.cjs');
const {createWechatPay}=require('./wechat-pay.cjs');
const {qrSvg}=require('./qr-code.cjs');
function getWechatPay(){const saved=paymentSettings.read()||{};return createWechatPay({env:{...process.env,PUBLIC_BASE_URL:saved.publicBaseUrl||process.env.PUBLIC_BASE_URL,WECHAT_PAY_APP_ID:saved.appId||process.env.WECHAT_PAY_APP_ID,WECHAT_PAY_MCHID:saved.mchid||process.env.WECHAT_PAY_MCHID,WECHAT_PAY_MCH_SERIAL:saved.merchantSerial||process.env.WECHAT_PAY_MCH_SERIAL,WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64:saved.merchantPrivateKeyBase64||process.env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64,WECHAT_PAY_PLATFORM_SERIAL:saved.platformSerial||process.env.WECHAT_PAY_PLATFORM_SERIAL,WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64:saved.platformCertificateBase64||process.env.WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64,WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64:saved.platformPublicKeyBase64||process.env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64,WECHAT_PAY_API_V3_KEY:saved.apiV3Key||process.env.WECHAT_PAY_API_V3_KEY,WECHAT_PAY_NOTIFY_URL:saved.notifyUrl||process.env.WECHAT_PAY_NOTIFY_URL}});}
function getWechatLogin(){const saved=paymentSettings.read()||{};return createWechatLogin({env:{...process.env,WECHAT_LOGIN_APP_ID:saved.wechatLoginAppId||process.env.WECHAT_LOGIN_APP_ID,WECHAT_LOGIN_APP_SECRET:saved.wechatLoginAppSecret||process.env.WECHAT_LOGIN_APP_SECRET,WECHAT_ALLOW_REGISTRATION:saved.wechatAllowRegistration===undefined?process.env.WECHAT_ALLOW_REGISTRATION:String(saved.wechatAllowRegistration),PUBLIC_BASE_URL:saved.publicBaseUrl||process.env.PUBLIC_BASE_URL},accounts});}
let wechatPay=getWechatPay();
let wechatLogin=getWechatLogin();
function wechatSettingsStatus(){return {account:paymentSettings.status(),payment:{configured:wechatPay.configured,unconfiguredReason:wechatPay.unconfiguredReason,notifyUrl:wechatPay.notifyUrl,verification:'local-only'},login:{configured:wechatLogin.configured,unconfiguredReason:wechatLogin.unconfiguredReason,callbackUrl:wechatLogin.callbackUrl,verification:'local-only'}};}
const authRequired = process.env.AUTH_REQUIRED === 'true';
if(authRequired&&(!process.env.ADMIN_EMAIL||!process.env.ADMIN_PASSWORD))throw new Error('账号模式要求同时配置 ADMIN_EMAIL 和 ADMIN_PASSWORD。');
const loginAttempts = new Map();
const accountReady=accounts.bootstrapAdmin(process.env.ADMIN_EMAIL,process.env.ADMIN_PASSWORD).catch(error=>{console.error('管理员账户初始化失败：'+error.message);process.exitCode=1;throw error;});
const tokens = new Set();
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };
function json(res, code, data) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
function cookies(req){return Object.fromEntries(String(req.headers.cookie||'').split(';').map(x=>x.trim().split(/=(.*)/s).slice(0,2)).filter(x=>x.length===2).map(([k,v])=>[k,decodeURIComponent(v)]));}
function setAuthCookies(res,token,csrf,expiresAt){const secure=process.env.COOKIE_SECURE==='true'?'; Secure':'';const age=Math.max(0,Math.floor((expiresAt-Date.now())/1000));res.setHeader('Set-Cookie',[`studio_session=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${secure}`,`studio_csrf=${encodeURIComponent(csrf)}; Path=/; SameSite=Lax; Max-Age=${age}${secure}`]);}
function clearAuthCookies(res){const secure=process.env.COOKIE_SECURE==='true'?'; Secure':'';res.setHeader('Set-Cookie',[`studio_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`,`studio_csrf=; Path=/; SameSite=Lax; Max-Age=0${secure}`]);}
function setWechatStateCookie(res,state){const secure=process.env.COOKIE_SECURE==='true'?'; Secure':'';res.setHeader('Set-Cookie',`wechat_oauth_${state}=${encodeURIComponent(state)}; Path=/api/auth/wechat/callback; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);}
function clearWechatStateCookie(res,state){if(!/^[a-f\d]{64}$/i.test(state||''))return;const secure=process.env.COOKIE_SECURE==='true'?'; Secure':'';res.appendHeader('Set-Cookie',`wechat_oauth_${state}=; Path=/api/auth/wechat/callback; HttpOnly; SameSite=Lax; Max-Age=0${secure}`);}
function originAllowed(req){const origin=req.headers.origin;if(!origin)return true;try{return new URL(origin).host===(req.headers.host||'');}catch{return false;}}
function currentUser(req){return accounts.session(cookies(req).studio_session);}
function clientIp(req){const peer=req.socket.remoteAddress||'unknown';if(['127.0.0.1','::1','::ffff:127.0.0.1'].includes(peer))return peer;const forwarded=String(req.headers['x-forwarded-for']||'').split(',').map(value=>value.trim()).filter(value=>value.length<64);return forwarded.at(-1)||peer;}
function touchLoginLimit(ip){const now=Date.now();for(const [key,entry]of loginAttempts)if(now-entry.at>900000)loginAttempts.delete(key);if(!loginAttempts.has(ip)&&loginAttempts.size>=10000)return false;const attempt=loginAttempts.get(ip)||{count:0,at:now};if(now-attempt.at>900000){attempt.count=0;attempt.at=now;}if(attempt.count>=10)return false;attempt.count++;loginAttempts.set(ip,attempt);return true;}
function authError(res,req,{admin=false,csrf=false}={}){if(!originAllowed(req)){json(res,403,{error:'请求来源不匹配。'});return true;}const user=currentUser(req);if(!user){json(res,401,{error:'请先登录后继续。'});return true;}if(admin&&user.role!=='admin'){json(res,403,{error:'需要管理员权限。'});return true;}if(csrf&&!accounts.verifyCsrf(user,req.headers['x-csrf-token'])){json(res,403,{code:'CSRF_EXPIRED',error:'安全校验已过期，请重试。'});return true;}return false;}
async function body(req,limit=80000) {
  const chunks=[]; let size=0;
  for await (const chunk of req) { size+=chunk.length; if(size>limit) throw Object.assign(new Error('请求内容过长。'),{status:413}); chunks.push(chunk); }
  try { const value=JSON.parse(Buffer.concat(chunks).toString('utf8')); if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error(); return value; } catch { throw Object.assign(new Error('请求格式不正确。'), { status: 400 }); }
}
async function rawBody(req,limit=300000) { const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>limit)throw Object.assign(new Error('请求内容过长。'),{status:413});chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8'); }
function membershipPlanConfig(){
  let value=[];try{value=JSON.parse(process.env.MEMBERSHIP_PLANS_JSON||'[]');}catch{value=[];}
  if(!Array.isArray(value))return [];
  return value.filter(plan=>{const kind=plan?.kind||'membership';return plan&&/^[a-z\d][a-z\d_-]{1,39}$/i.test(String(plan.id||''))&&typeof plan.name==='string'&&plan.name.length<=80&&['membership','credits'].includes(kind)&&Number.isInteger(plan.days)&&plan.days>=(kind==='membership'?0:0)&&plan.days<=(kind==='membership'?3650:0)&&Number.isInteger(plan.credits)&&plan.credits>=1&&plan.credits<=100000&&Number.isInteger(plan.amountCents)&&plan.amountCents>0&&plan.amountCents<=100000000;}).map(plan=>({id:String(plan.id),name:plan.name,kind:plan.kind||'membership',days:plan.days,credits:plan.credits,amountCents:plan.amountCents,currency:'CNY'}));
}
for(const plan of membershipPlanConfig())if(!accounts.membershipPlan(plan.id))accounts.setMembershipPlan(null,plan);
function membershipPlans(){return accounts.membershipPlans().filter(plan=>plan.enabled);}
let busy = 0;
const server = http.createServer(async (req, res) => {
  const requestId=randomUUID(),started=Date.now();
  res.setHeader('X-Request-Id',requestId);
  res.once('finish',()=>{if(res.statusCode>=500)console.error(JSON.stringify({event:'request_failed',requestId,method:req.method,path:req.url.split('?')[0],status:res.statusCode,elapsedMs:Date.now()-started}));});
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https://qdaiyoushu.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    await accountReady;
    const url = new URL(req.url, 'http://localhost');
    if(url.pathname==='/api/health'&&req.method==='GET')return json(res,200,{service:'youshu-studio',status:'ok',instance:process.env.STUDIO_INSTANCE_ID||'',pid:process.pid,uptimeSeconds:Math.floor(process.uptime()),activeRequests:busy});
    if(url.pathname==='/api/auth/register'&&req.method==='POST'){
      if(process.env.ENABLE_REGISTRATION!=='true')return json(res,404,{error:'目前未开放自助注册，请联系管理员。'});
      if(!originAllowed(req))return json(res,403,{error:'请求来源不匹配。'});
      const ip=clientIp(req);if(!touchLoginLimit(ip))return json(res,429,{error:'尝试次数过多，请 15 分钟后再试。'});
      const data=await body(req,10000);const user=await accounts.createUser(data.email,data.password);const result=await accounts.login(data.email,data.password);setAuthCookies(res,result.token,result.csrf,result.expiresAt);return json(res,201,{user,csrf:result.csrf});
    }
    if(url.pathname==='/api/auth/login'&&req.method==='POST'){
      if(!originAllowed(req))return json(res,403,{error:'请求来源不匹配。'});
      const ip=clientIp(req);if(!touchLoginLimit(ip))return json(res,429,{error:'尝试次数过多，请 15 分钟后再试。'});
      const data=await body(req,10000);const result=await accounts.login(data.email,data.password);loginAttempts.delete(ip);setAuthCookies(res,result.token,result.csrf,result.expiresAt);return json(res,200,{user:result.user,csrf:result.csrf});
    }
    if(url.pathname==='/api/auth/wechat/start'&&req.method==='GET'){
      const mode=url.searchParams.get('mode')==='bind'?'bind':'login';let user=null,sessionToken=null;
      if(!touchLoginLimit(clientIp(req)))return json(res,429,{error:'尝试次数过多，请 15 分钟后再试。'});
      if(mode==='bind'){if(authError(res,req))return;sessionToken=cookies(req).studio_session;user=currentUser(req);}
      const started=wechatLogin.start({mode,user,sessionToken});setWechatStateCookie(res,started.state);res.writeHead(302,{Location:started.url,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
    }
    if(url.pathname==='/api/auth/wechat/callback'&&req.method==='GET'){
      const state=url.searchParams.get('state')||'',cookieName=/^[a-f\d]{64}$/i.test(state)?`wechat_oauth_${state}`:'',stateCookie=cookieName?cookies(req)[cookieName]||'':'',sessionToken=cookies(req).studio_session||'';
      try{
        const result=await wechatLogin.complete({code:url.searchParams.get('code'),state,cookieState:stateCookie,sessionToken});
        if(result.action==='login'){const csrf=randomBytes(32).toString('base64url'),session=accounts.createSession(result.user.id,csrf);setAuthCookies(res,session.token,csrf,session.expiresAt);}
        clearWechatStateCookie(res,state);res.writeHead(302,{Location:result.action==='bind'?'/?wechat=bound#write':'/?wechat=login#write','Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
      }catch(error){clearWechatStateCookie(res,state);res.writeHead(302,{Location:`/account.html?wechat=${error.status===401?'expired':'failed'}`,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();}
    }
    if(url.pathname==='/api/auth/session'&&req.method==='GET'){
      const user=currentUser(req);if(!user)return json(res,200,{authenticated:false,required:authRequired});
      const csrf=cookies(req).studio_csrf||'';if(!accounts.verifyCsrf(user,csrf))return json(res,401,{authenticated:false,required:authRequired});
      return json(res,200,{authenticated:true,required:authRequired,user:{id:user.id,email:user.email,displayName:user.displayName,role:user.role,plan:user.plan,membershipExpiresAt:user.membershipExpiresAt,credits:user.credits,memberCredits:user.memberCredits,packageCredits:user.packageCredits,wechatLinked:user.wechatLinked},csrf});
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
      const user=currentUser(req);if(user&&!accounts.verifyCsrf(user,req.headers['x-csrf-token']))return json(res,403,{error:'安全校验失败。'});accounts.removeSession(cookies(req).studio_session);clearAuthCookies(res);return json(res,200,{ok:true});
    }
    if(url.pathname==='/api/auth/password'&&req.method==='POST'){
      if(authError(res,req,{csrf:true}))return;const user=currentUser(req),data=await body(req,10000);await accounts.changePassword(user.id,data.currentPassword,data.newPassword);const csrf=randomUUID()+randomUUID(),session=accounts.createSession(user.id,csrf);setAuthCookies(res,session.token,csrf,session.expiresAt);return json(res,200,{ok:true,csrf});
    }
    if(url.pathname==='/api/account/data'&&['GET','PUT'].includes(req.method)){
      if(authError(res,req,{csrf:req.method==='PUT'}))return;
      if(req.method==='GET')return json(res,200,accounts.getAccountData(currentUser(req).id));
      const data=await body(req,3200000);return json(res,200,accounts.saveAccountData(currentUser(req).id,data.data,data.expectedUpdatedAt??null));
    }
    if(url.pathname==='/api/admin/dashboard'&&req.method==='GET'){
      if(authError(res,req,{admin:true}))return;const plans=membershipPlans();wechatPay=getWechatPay();return json(res,200,{...accounts.dashboard(),audit:accounts.auditRows(50),redeemCodes:accounts.redeemCodes(),commerce:{wechatLoginEnabled:wechatLogin.configured,loginConfigurationMissing:wechatLogin.unconfiguredReason||'',paymentEnabled:wechatPay.configured,configurationMissing:wechatPay.unconfiguredReason,pricedPlans:plans.length,plans:plans.map(({id,name,kind,days,credits,amountCents,featured,sortOrder})=>({id,name,kind,days,credits,amountCents,featured,sortOrder})),paymentAccount:paymentSettings.status()}});
    }
    if(url.pathname==='/api/admin/payment-account'&&req.method==='GET'){
      if(authError(res,req,{admin:true}))return;return json(res,200,wechatSettingsStatus());
    }
    if(url.pathname==='/api/admin/payment-account'&&req.method==='PUT'){
      if(authError(res,req,{admin:true,csrf:true}))return;const data=await body(req,80000);
      const previous=paymentSettings.read()||{},paymentFields=['publicBaseUrl','appId','mchid','merchantSerial','platformSerial','merchantPrivateKeyBase64','platformCertificateBase64','platformPublicKeyBase64','apiV3Key','notifyUrl'];
      if(paymentFields.some(field=>data[field] && data[field]!==previous[field]) && accounts.db.prepare("SELECT COUNT(*) AS n FROM orders WHERE provider='wechatpay' AND status='pending'").get().n>0) return json(res,409,{error:'存在待支付订单，暂不能更换收款配置；请先核对并完成订单处理。'});
      paymentSettings.save(data);wechatPay=getWechatPay();wechatLogin=getWechatLogin();accounts.audit(currentUser(req).id,null,'wechat.settings.update',{fields:Object.keys(data).filter(field=>!field.toLowerCase().includes('secret')&&!field.toLowerCase().includes('key')&&!field.toLowerCase().includes('certificate'))});return json(res,200,wechatSettingsStatus());
    }
    if(url.pathname==='/api/admin/users'&&req.method==='GET'){
      if(authError(res,req,{admin:true}))return;return json(res,200,{users:accounts.users(url.searchParams.get('q')||'')});
    }
    const membershipMatch=url.pathname.match(/^\/api\/admin\/users\/([a-f\d]{32})\/(membership|status)$/i);
    if(membershipMatch&&req.method==='PATCH'){
      if(authError(res,req,{admin:true,csrf:true}))return;const data=await body(req,10000),actor=currentUser(req);
      const user=membershipMatch[2]==='membership'?accounts.grant(actor.id,membershipMatch[1],data):accounts.setStatus(actor.id,membershipMatch[1],data.status);return json(res,200,{user});
    }
    if(url.pathname==='/api/admin/users'&&req.method==='POST'){
      if(authError(res,req,{admin:true,csrf:true}))return;const data=await body(req,10000),actor=currentUser(req);return json(res,201,{user:await accounts.createUser(data.email,data.password,actor.id)});
    }
    if(url.pathname==='/api/admin/plans'&&req.method==='GET'){
      if(authError(res,req,{admin:true}))return;return json(res,200,{plans:accounts.membershipPlans()});
    }
    if(url.pathname==='/api/admin/plans'&&req.method==='POST'){
      if(authError(res,req,{admin:true,csrf:true}))return;const data=await body(req,10000),actor=currentUser(req);return json(res,200,{plan:accounts.setMembershipPlan(actor.id,{id:data.id,name:data.name,kind:data.kind||'membership',days:data.days,credits:data.credits,amountCents:data.amountCents,featured:data.featured===true,sortOrder:Number.isInteger(data.sortOrder)?data.sortOrder:0})});
    }
    if(url.pathname==='/api/admin/redeem-codes'&&req.method==='POST'){
      if(authError(res,req,{admin:true,csrf:true}))return;const data=await body(req,10000);return json(res,201,{code:accounts.createRedeemCode(currentUser(req).id,data)});
    }
    const adminPlanMatch=url.pathname.match(/^\/api\/admin\/plans\/([a-z\d][a-z\d_-]{1,39})$/i);
    if(adminPlanMatch&&req.method==='DELETE'){
      if(authError(res,req,{admin:true,csrf:true}))return;return json(res,200,{plan:accounts.deleteMembershipPlan(currentUser(req).id,adminPlanMatch[1])});
    }
    if(url.pathname==='/api/membership'&&req.method==='GET'){
      const plans=membershipPlans(),user=currentUser(req);wechatPay=getWechatPay();return json(res,200,{plans:plans.map(({id,name,kind,days,credits,amountCents,currency,featured,sortOrder})=>({id,name,kind,days,credits,amountCents,currency,featured,sortOrder})),account:user?{id:user.id,role:user.role,plan:user.plan,expiresAt:user.membershipExpiresAt,credits:user.credits,memberCredits:user.memberCredits,packageCredits:user.packageCredits}:null,wechatLoginEnabled:wechatLogin.configured,paymentEnabled:wechatPay.configured,checkoutEnabled:wechatPay.configured&&plans.length>0,paymentUnavailableReason:wechatPay.configured?'':'微信支付尚未完成商户配置，当前不能收款。'});
    }
    if(url.pathname==='/api/account/redeem'&&req.method==='POST'){
      if(authError(res,req,{csrf:true}))return;const data=await body(req,10000);return json(res,200,{result:accounts.redeemCode(currentUser(req).id,data.code)});
    }
    if(url.pathname==='/api/account/orders'&&req.method==='GET'){
      if(authError(res,req))return;return json(res,200,{orders:accounts.accountOrders(currentUser(req).id)});
    }
    const accountOrderMatch=url.pathname.match(/^\/api\/account\/orders\/([a-f\d]{32})(?:\/(qr\.svg))?$/i);
    if(accountOrderMatch&&req.method==='GET'){
      if(authError(res,req))return;const user=currentUser(req),id=accountOrderMatch[1];
      if(accountOrderMatch[2]){const codeUrl=accounts.pendingOrderQr(user.id,id);if(!codeUrl)return json(res,404,{error:'付款码已失效，请重新下单。'});const svg=qrSvg(codeUrl);res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});return res.end(svg);}
      const order=accounts.orderForUser(user.id,id);if(!order)return json(res,404,{error:'订单不存在。'});return json(res,200,{order,qrUrl:order.status==='pending'?`/api/account/orders/${id}/qr.svg`:null});
    }
    if(url.pathname==='/api/pay/wechat/orders'&&req.method==='POST'){
      if(authError(res,req,{csrf:true}))return;if(!wechatPay.configured)return json(res,503,{error:'微信支付尚未配置完成，当前不能收款。'});
      const data=await body(req,10000),plan=membershipPlans().find(value=>value.id===data.planId);if(!plan)return json(res,400,{error:'套餐不存在或未配置有效售价。'});
      const order=accounts.createOrder(currentUser(req).id,{...plan,plan:plan.id});
      try{const native=await wechatPay.createNativeOrder({providerRef:order.providerRef,name:plan.name,amountCents:plan.amountCents});accounts.setOrderCodeUrl(order.id,native.codeUrl);return json(res,201,{order:accounts.orderForUser(currentUser(req).id,order.id),qrUrl:`/api/account/orders/${order.id}/qr.svg`});}
      catch(error){accounts.cancelOrder(order.id);throw error;}
    }
    if(url.pathname==='/api/pay/wechat/notify'&&req.method==='POST'){
      try{const raw=await rawBody(req,300000),payment=wechatPay.verifyAndDecryptNotification(req.headers,raw);accounts.fulfillWechatOrder(payment);return json(res,200,{code:'SUCCESS',message:'成功'});}
      catch(error){return json(res,error.status&&error.status<500?error.status:500,{code:'FAIL',message:error.status&&error.status<500?'通知未通过校验。':'通知处理失败，请稍后重试。'});}
    }
    if (url.pathname === '/api/status' && req.method === 'GET') {
      const token = randomUUID(); tokens.add(token); if (tokens.size > 256) tokens.delete(tokens.values().next().value);
      const config = ai.publicConfig(),user=currentUser(req);
      const csrf=cookies(req).studio_csrf||'';
      return json(res, 200, { ...config, model: config.configured ? config.model : '本地构思助手', token,authRequired,authenticated:!!user,csrf:user&&accounts.verifyCsrf(user,csrf)?csrf:'',wechatLoginEnabled:wechatLogin.configured,wechatLoginConfigurationMissing:wechatLogin.unconfiguredReason||'',paymentEnabled:wechatPay.configured,user:user?{id:user.id,email:user.email,displayName:user.displayName,role:user.role,plan:user.plan,credits:user.credits,memberCredits:user.memberCredits,packageCredits:user.packageCredits,membershipExpiresAt:user.membershipExpiresAt,wechatLinked:user.wechatLinked}:null });
    }
    if (['/api/ai/config','/api/ai/test','/api/ai/models'].includes(url.pathname)) {
      const origin = req.headers.origin;
      if (!['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
          !/^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(req.headers.host || '') ||
          (origin && origin !== 'http://' + req.headers.host)) return json(res,403,{error:'AI 配置仅允许从本机工作室页面操作。'});
      if(!tokens.has(req.headers['x-studio-token']))return json(res,403,{code:'TOKEN_EXPIRED',error:'页面连接已更新，请重试。'});
      if (url.pathname === '/api/ai/config' && req.method === 'GET') return json(res,200,ai.publicConfig());
      if (req.method !== 'POST') return json(res,405,{error:'请求方法不支持。'});
      const data = await body(req);
      if (url.pathname === '/api/ai/config') return json(res,200,ai.save(data));
      if (busy >= 3) return json(res,429,{error:'当前请求较多，请稍后再试。'});
      busy++;
      try { return json(res,200,await (url.pathname === '/api/ai/test' ? ai.test(data) : ai.list(data))); }
      finally { busy--; }
    }
    if (url.pathname === '/api/extract-link' && req.method === 'POST') {
      if (!tokens.has(req.headers['x-studio-token'])) return json(res, 403, { code:'TOKEN_EXPIRED', error: '页面连接已更新，请重试。' });
      if(authRequired&&authError(res,req,{csrf:true}))return;
      const data = await body(req);
      const controller=new AbortController();
      res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      const result = await fetchArticle(data.url,{signal:controller.signal});
      if(!res.destroyed)return json(res, 200, result);
    }
    if(url.pathname==='/api/library/articles'&&req.method==='GET'){
      const result=await articleLibrary.list({page:url.searchParams.get('page'),per_page:url.searchParams.get('per_page'),time:url.searchParams.get('time'),sort:url.searchParams.get('sort'),domain:url.searchParams.get('domain'),keyword:url.searchParams.get('keyword')},{refresh:url.searchParams.get('refresh')==='1'});
      return json(res,200,result);
    }
    if(url.pathname==='/api/library/imports'&&req.method==='GET')return json(res,200,await articleLibrary.listImports());
    if(url.pathname==='/api/library/imports'&&req.method==='POST'){
      if(!originAllowed(req))return json(res,403,{error:'请求来源不匹配。'});
      if(authRequired&&authError(res,req,{csrf:true}))return;
      if(!touchLoginLimit('article-import:'+clientIp(req)))return json(res,429,{error:'导入请求过于频繁，请稍后再试。'});
      const data=await body(req,5000);
      return json(res,201,await articleLibrary.addImport(data.url,{ip:clientIp(req)}));
    }
    if (['/api/tool','/api/image','/api/chat'].includes(url.pathname) && req.method === 'POST') {
      if (!tokens.has(req.headers['x-studio-token'])) return json(res,403,{code:'TOKEN_EXPIRED',error:'页面连接已更新，请重试。'});
      const accountUser=authRequired?currentUser(req):null;
      if(authRequired&&authError(res,req,{csrf:true}))return;
      const data=await body(req,url.pathname==='/api/image'?4400000:180000);
      const invalid=message=>Object.assign(new Error(message),{status:400});
      let local;
      if(url.pathname==='/api/chat') {
        if(!Array.isArray(data.messages)||!data.messages.length||data.messages.length>20||data.messages.some(m=>!m||!['user','assistant'].includes(m.role)||typeof m.content!=='string'||!m.content.trim())||data.messages.at(-1).role!=='user') throw invalid('对话需以用户消息结尾，最多 20 条。');
        if(data.messages.reduce((n,m)=>n+m.content.length,0)>30000||typeof (data.context||'')!=='string'||(data.context||'').length>20000) throw invalid('对话或稿件过长，请开启新对话或缩短材料。');
      } else if(url.pathname==='/api/image') {
        const match=typeof data.image==='string'&&data.image.match(/^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
        if(!match) throw invalid('仅支持 PNG、JPEG、WebP 图片。');
        const bytes=Buffer.from(match[2],'base64');
        const valid=match[1]==='png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):match[1]==='jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
        if(!valid||bytes.length>3000000||bytes.length<12) throw invalid('图片格式不正确或超过 3 MB。');
        data.tool='image';
      } else {
        if(!Object.hasOwn(specs,data.tool)) throw invalid('工具不存在。');
        if(typeof data.text!=='string'||!data.text.trim()||data.text.length>20000||typeof (data.title||'')!=='string'||(data.title||'').length>100) throw invalid('请输入 1 至 20,000 字，标题限 100 字。');
        if(typeof (data.platform||'')!=='string'||(data.platform||'').length>40||typeof (data.style||'')!=='string'||(data.style||'').length>40) throw invalid('平台和风格限 40 字。');
        if(data.options!==undefined && (!data.options || typeof data.options!=='object' || Array.isArray(data.options) || JSON.stringify(data.options).length>14000)) throw invalid('工具参数过长或格式不正确。');
        local=scan(data.text,data.title,data.platform);
        if(data.deep!==true) return json(res,200,{tool:data.tool,local,ruleVersion:'2026-10-31',notice:'通用编辑规则，非官方实时平台规范；分数不是审核分或 AI 检测率。'});
      }
      if(busy>=3) return json(res,429,{error:'当前请求较多，请稍后再试。'});
      const reservation=accountUser?accounts.reserveUsage(accountUser.id,url.pathname==='/api/chat'?'chat':data.tool,ai.publicConfig().model,Number(process.env.FREE_MONTHLY_CALLS||10),Number(process.env.MEMBER_MONTHLY_CALLS||300)):null;
      if(reservation&&!reservation.allowed)return json(res,402,{error:reservation.reason,usage:{used:reservation.used,limit:reservation.limit,plan:reservation.plan}});
      busy++;
      const controller=new AbortController();
      res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      try { const result=url.pathname==='/api/chat'?await ai.chat({...data,_signal:controller.signal}):await ai.runTool(data,controller.signal);if(reservation)accounts.finalizeUsage(reservation.id,result.model);if(!res.destroyed)return json(res,200,{...result,local,tool:data.tool}); }
      catch(error){if(reservation)accounts.refundUsage(reservation.id);throw error;}
      finally {busy--;}
    }
    if (url.pathname === '/api/generate' && req.method === 'POST') {
      if (!tokens.has(req.headers['x-studio-token'])) return json(res, 403, { code:'TOKEN_EXPIRED', error: '页面连接已更新，请重试。' });
      const accountUser=authRequired?currentUser(req):null;
      if(authRequired&&authError(res,req,{csrf:true}))return;
      if (!ai.publicConfig().configured) return json(res, 503, { error: '尚未配置 AI 服务。请打开“连接 AI 服务”填写配置。' });
      const data = await body(req);
      const topic = String(data.topic || '').trim();
      if (!topic || topic.length > 20000) return json(res, 400, { error: '请填写 1 至 20,000 字的创作主题。' });
      if (busy >= 3) return json(res, 429, { error: '当前请求较多，请稍后再试。' });
      const reservation=accountUser?accounts.reserveUsage(accountUser.id,'generate',ai.publicConfig().model,Number(process.env.FREE_MONTHLY_CALLS||10),Number(process.env.MEMBER_MONTHLY_CALLS||300)):null;
      if(reservation&&!reservation.allowed)return json(res,402,{error:reservation.reason,usage:{used:reservation.used,limit:reservation.limit,plan:reservation.plan}});
      busy++;
      const controller=new AbortController();
      res.once('close',()=>{if(!res.writableEnded)controller.abort();});
      try {
        const result=await ai.generate({...data, topic},controller.signal);if(reservation)accounts.finalizeUsage(reservation.id,result.model);if(!res.destroyed)return json(res, 200, result);
      }
      catch(error){if(reservation)accounts.refundUsage(reservation.id);throw error;}
      finally { busy--; }
    }
    if (url.pathname.startsWith('/api/')) return json(res, 404, { error: '接口不存在。' });
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let requested = decodeURIComponent(url.pathname);
    if(requested==='/admin'||requested==='/admin/')requested='/admin.html';
    if(requested==='/admin.html'&&currentUser(req)?.role==='user'){
      res.writeHead(404,{'Cache-Control':'no-store'});return res.end('Not found');
    }
    if(requested==='/account'||requested==='/account/')requested='/account.html';
    if (requested === '/') requested = '/index.html';
    const file = path.resolve(root, '.' + requested);
    if (!file.startsWith(root + path.sep)) { res.writeHead(403); return res.end(); }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  } catch (error) { if(!res.headersSent&&!res.destroyed)json(res, error.status || 500, { error: error.status ? error.message : '服务暂时不可用。',requestId });if(!error.status)console.error(JSON.stringify({event:'internal_error',requestId,code:error.code||error.name||'internal'})); }
});
server.requestTimeout=30000;
server.headersTimeout=15000;
server.keepAliveTimeout=5000;
server.on('close',()=>accounts.close());
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{server.close();});
server.listen(port, host, () => console.log(`有术 Studio: http://${host}:${server.address().port} · ${ai.publicConfig().configured ? 'AI 已配置（可在页面测试）' : '本地构思模式'}`));
