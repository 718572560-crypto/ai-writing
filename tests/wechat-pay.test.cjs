'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {generateKeyPairSync,createSign,createVerify,createCipheriv,createHash}=require('node:crypto');
const {createWechatPay}=require('../wechat-pay.cjs');
const {createAccountStore}=require('../account-store.cjs');
const {qrSvg,makeQrMatrix}=require('../qr-code.cjs');

const now=()=>Date.UTC(2026,10,4,12,0,0);
const signed=(timestamp,nonce,body)=>`${timestamp}\n${nonce}\n${body}\n`;
const asBase64Pem=pem=>Buffer.from(pem).toString('base64');
function keys(){return {merchant:generateKeyPairSync('rsa',{modulusLength:2048}),platform:generateKeyPairSync('rsa',{modulusLength:2048})};}
function testEnvironment(pair){return {PUBLIC_BASE_URL:'https://studio.example.com',WECHAT_APP_ID:'wx-test-app-id',WECHAT_PAY_MCHID:'1900000001',WECHAT_PAY_MCH_SERIAL:'ABCD1234',WECHAT_PAY_API_V3_KEY:'01234567890123456789012345678901',WECHAT_PAY_PLATFORM_SERIAL:'PLATFORM-CERT-2026',WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64:asBase64Pem(pair.merchant.privateKey.export({type:'pkcs8',format:'pem'})),WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64:asBase64Pem(pair.platform.publicKey.export({type:'spki',format:'pem'}))};}
function platformHeaders(pair,body,at=now(),nonce='platform-test-nonce'){const timestamp=String(Math.floor(at/1000)),signature=createSign('RSA-SHA256').update(signed(timestamp,nonce,body)).end().sign(pair.platform.privateKey,'base64');return {'wechatpay-timestamp':timestamp,'wechatpay-nonce':nonce,'wechatpay-signature':signature,'wechatpay-serial':'PLATFORM-CERT-2026'};}
function encryptResource(clear,key){const nonce='wechatnonce1',aad='merchant payment',cipher=createCipheriv('aes-256-gcm',Buffer.from(key),Buffer.from(nonce));cipher.setAAD(Buffer.from(aad));const encrypted=Buffer.concat([cipher.update(JSON.stringify(clear)),cipher.final(),cipher.getAuthTag()]);return {algorithm:'AEAD_AES_256_GCM',nonce,associated_data:aad,ciphertext:encrypted.toString('base64')};}

test('WechatPay native QR order uses the signed v3 API and verifies the merchant response',async()=>{
  const pair=keys(),env=testEnvironment(pair),timestamp=Math.floor(now()/1000);let request;
  const fetchImpl=async(url,options)=>{request={url,options};const authorization=options.headers.Authorization,signature=authorization.match(/signature="([^"]+)"/)?.[1];assert.ok(signature);const body=options.body,canonical=`POST\n/v3/pay/transactions/native\n${timestamp}\n${authorization.match(/nonce_str="([^"]+)"/)[1]}\n${body}\n`;assert.equal(createVerify('RSA-SHA256').update(canonical).end().verify(pair.merchant.publicKey,signature,'base64'),true);const responseBody=JSON.stringify({code_url:'weixin://wxpay/bizpayurl?pr=TEST'});return new Response(responseBody,{status:200,headers:{'Content-Type':'application/json',...platformHeaders(pair,responseBody,now())}});};
  const pay=createWechatPay({env,fetchImpl,now});assert.equal(pay.configured,true);const result=await pay.createNativeOrder({providerRef:'A'.repeat(32),name:'有术月度会员',amountCents:2990});assert.equal(result.codeUrl,'weixin://wxpay/bizpayurl?pr=TEST');assert.equal(request.url,'https://api.mch.weixin.qq.com/v3/pay/transactions/native');assert.equal(JSON.parse(request.options.body).amount.total,2990);assert.equal(JSON.parse(request.options.body).appid,env.WECHAT_APP_ID);
});

test('WechatPay callback validates its RSA signature, decrypts APIv3 data, and rejects tampering',()=>{
  const pair=keys(),env=testEnvironment(pair),pay=createWechatPay({env,now});assert.equal(pay.configured,true);
  const data={event_type:'TRANSACTION.SUCCESS',resource:encryptResource({appid:env.WECHAT_APP_ID,mchid:env.WECHAT_PAY_MCHID,out_trade_no:'A'.repeat(32),transaction_id:'42000000000000000001',trade_state:'SUCCESS',amount:{total:2990,currency:'CNY'}},env.WECHAT_PAY_API_V3_KEY),id:'evt_123456789'};
  const raw=JSON.stringify(data),headers=platformHeaders(pair,raw);assert.deepEqual(pay.verifyAndDecryptNotification(headers,raw),{notificationId:data.id,transactionId:'42000000000000000001',providerRef:'A'.repeat(32),amountCents:2990,currency:'CNY'});
  assert.throws(()=>pay.verifyAndDecryptNotification({...headers,'wechatpay-signature':'invalid'},raw),/签名校验失败/);
  const unsupported={...data,event_type:'REFUND.SUCCESS'},unsupportedRaw=JSON.stringify(unsupported);assert.throws(()=>pay.verifyAndDecryptNotification(platformHeaders(pair,unsupportedRaw),unsupportedRaw),/不匹配/);
  assert.equal(createWechatPay({env:{...env,PUBLIC_BASE_URL:'http://localhost'},now}).configured,false);
});

test('verified payment events fulfill member orders once; bad totals do not grant credits',async t=>{
  const dir=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'youshu-wechat-order-'));
  const store=createAccountStore(require('node:path').join(dir,'db.sqlite'));t.after(()=>{store.close();require('node:fs').rmSync(dir,{recursive:true,force:true});});
  await store.createUser('writer@example.test','a-long-user-password');const user=await store.login('writer@example.test','a-long-user-password');
  store.setMembershipPlan(user.user.id,{id:'monthly',name:'月度会员',days:30,credits:300,amountCents:2990});
  const plan=store.membershipPlan('monthly'),order=store.createOrder(user.user.id,{plan:plan.id,name:plan.name,days:plan.days,credits:plan.credits,amountCents:plan.amountCents});
  store.setOrderCodeUrl(order.id,'weixin://wxpay/bizpayurl?pr=EXAMPLE');assert.match(store.pendingOrderQr(user.user.id,order.id),/^weixin:\/\/wxpay\//);
  const payment={notificationId:'evt_unique_123',transactionId:'42000000000000000012',providerRef:order.providerRef,amountCents:2990,currency:'CNY'};
  assert.throws(()=>store.fulfillWechatOrder({...payment,amountCents:299}),/金额与订单不一致/);assert.equal(store.access(user.user.id).plan,'free');
  assert.equal(store.fulfillWechatOrder(payment).fulfilled,true);assert.equal(store.access(user.user.id).plan,'member');assert.equal(store.access(user.user.id).credits,300);assert.equal(store.pendingOrderQr(user.user.id,order.id),null);
  assert.equal(store.fulfillWechatOrder(payment).duplicate,true);assert.equal(store.access(user.user.id).credits,300);assert.equal(store.orderForUser(user.user.id,order.id).status,'paid');
  assert.ok(store.auditRows().some(row=>row.action==='membership.payment'));
});

test('credit packs remain separate from membership, can be used after the member quota, and permanent plans never expire',async t=>{
  const dir=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'youshu-credit-pack-'));
  const store=createAccountStore(require('node:path').join(dir,'db.sqlite'));t.after(()=>{store.close();require('node:fs').rmSync(dir,{recursive:true,force:true});});
  const user=await store.createUser('credits@example.test','a-long-user-password');
  store.setMembershipPlan(null,{id:'writer-pack',name:'测试次数包',kind:'credits',days:0,credits:305,amountCents:3900});
  let plan=store.membershipPlan('writer-pack');assert.equal(plan.kind,'credits');
  let order=store.createOrder(user.id,{plan:plan.id,name:plan.name,kind:plan.kind,days:plan.days,credits:plan.credits,amountCents:plan.amountCents});
  assert.equal(store.fulfillWechatOrder({notificationId:'pack_payment_123',transactionId:'42000000000000000022',providerRef:order.providerRef,amountCents:3900,currency:'CNY'}).kind,'credits');
  assert.equal(store.publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id)).packageCredits,305);
  store.grant(null,user.id,{days:30,credits:2});
  for(let i=0;i<300;i++)store.recordUsage(user.id,'article','test-model');
  let access=store.access(user.id,10,300);assert.equal(access.allowed,true);assert.equal(access.plan,'credits');assert.equal(access.packageCredits,7);
  const charged=store.reserveUsage(user.id,'humanize','test-model',10,300);assert.equal(charged.allowed,true);assert.equal(store.access(user.id,10,300).packageCredits,6);
  store.refundUsage(charged.id);assert.equal(store.access(user.id,10,300).packageCredits,7);
  const oldExpiry=store.publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id)).membershipExpiresAt;
  store.setMembershipPlan(null,{id:'forever',name:'永久会员',kind:'membership',days:0,credits:500,amountCents:49900});
  plan=store.membershipPlan('forever');order=store.createOrder(user.id,{plan:plan.id,name:plan.name,kind:plan.kind,days:plan.days,credits:plan.credits,amountCents:plan.amountCents});
  const permanent=store.fulfillWechatOrder({notificationId:'member_payment_123',transactionId:'42000000000000000023',providerRef:order.providerRef,amountCents:49900,currency:'CNY'});
  assert.equal(permanent.expiresAt,null);assert.equal(store.publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id)).membershipExpiresAt,null);
  assert.equal(store.publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(user.id)).plan,'member');assert.equal(oldExpiry> Date.now(),true);
});

test('WeChat login identities, one-time OAuth state and optional admin binding stay account-scoped',async t=>{
  const dir=require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'youshu-wechat-login-'));
  const store=createAccountStore(require('node:path').join(dir,'db.sqlite'));t.after(()=>{store.close();require('node:fs').rmSync(dir,{recursive:true,force:true});});
  const first=store.completeWechatLogin({openId:'open-id-1',unionId:'union-id-1',nickname:'测试作者',allowRegistration:true});assert.equal(first.displayName,'测试作者');assert.equal(first.wechatLinked,true);assert.equal(store.completeWechatLogin({openId:'open-id-1',unionId:'union-id-1',nickname:'作者更新',allowRegistration:true}).id,first.id);
  assert.throws(()=>store.completeWechatLogin({openId:'open-id-new'}),/未开放新账号注册/);
  const authorization={stateHash:createHash('sha256').update('a'.repeat(64)).digest('hex'),action:'login'};store.beginWechatAuthorization(authorization);assert.equal(store.consumeWechatAuthorization(authorization.stateHash).action,'login');assert.equal(store.consumeWechatAuthorization(authorization.stateHash),null);
  const second=await store.createUser('second@example.test','another-long-password'),session=await store.login('second@example.test','another-long-password');store.bindWechatIdentity({userId:second.id,sessionToken:session.token,openId:'open-id-2',nickname:'第二位'});assert.equal(store.publicUser(store.db.prepare('SELECT * FROM users WHERE id=?').get(second.id)).displayName,'第二位');
  assert.throws(()=>store.bindWechatIdentity({userId:second.id,sessionToken:session.token,openId:'open-id-1',unionId:'union-id-1'}),/已绑定到另一账号/);
  assert.equal(store.users('第二位').length,1);
});

test('payment QR generator covers native WeChat code lengths and emits local SVG only',()=>{
  for(const length of [1,10,30,60,100,150,220,270]){const matrix=makeQrMatrix('x'.repeat(length));assert.ok(matrix.length>=21&&matrix.length<=57);assert.ok(matrix.every(row=>row.every(cell=>typeof cell==='boolean')));}
  const svg=qrSvg('weixin://wxpay/bizpayurl?pr=ABCD');assert.match(svg,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);assert.doesNotMatch(svg,/weixin:|ABCD/);
  assert.throws(()=>makeQrMatrix('x'.repeat(400)),/超出二维码容量/);
});
