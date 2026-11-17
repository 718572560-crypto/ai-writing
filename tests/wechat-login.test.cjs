'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createHash}=require('node:crypto');
const {createAccountStore}=require('../account-store.cjs');
const {createWechatLogin}=require('../wechat-login.cjs');

test('official WeChat website OAuth builds one-time, per-session state and keeps new-user policy explicit',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-oauth-')),accounts=createAccountStore(path.join(dir,'db.sqlite'));
 t.after(()=>{accounts.close();fs.rmSync(dir,{recursive:true,force:true});});
 const requests=[];let activeOpenId='mock-openid';
 const fetchImpl=async url=>{const parsed=new URL(url);requests.push(parsed);if(parsed.pathname==='/sns/oauth2/access_token')return new Response(JSON.stringify({access_token:'mock-access',openid:activeOpenId,unionid:'union-'+activeOpenId}),{status:200});if(parsed.pathname==='/sns/userinfo')return new Response(JSON.stringify({openid:activeOpenId,unionid:'union-'+activeOpenId,nickname:'测试微信用户'}),{status:200});throw new Error('Unexpected mocked upstream URL');};
 const env={NODE_ENV:'production',WECHAT_LOGIN_APP_ID:'wx-mock-app',WECHAT_LOGIN_APP_SECRET:'mock-secret',PUBLIC_BASE_URL:'https://studio.example.com',WECHAT_ALLOW_REGISTRATION:'true'};
 const login=createWechatLogin({env,accounts,fetchImpl});assert.equal(login.configured,true);assert.equal(login.callbackUrl,'https://studio.example.com/api/auth/wechat/callback');
 const start=login.start();const authorizationUrl=new URL(start.url);assert.equal(authorizationUrl.origin,'https://open.weixin.qq.com');assert.equal(authorizationUrl.pathname,'/connect/qrconnect');assert.equal(authorizationUrl.searchParams.get('appid'),'wx-mock-app');assert.equal(authorizationUrl.searchParams.get('scope'),'snsapi_login');assert.equal(authorizationUrl.searchParams.get('state'),start.state);
 await assert.rejects(login.complete({code:'mock-code',state:start.state,cookieState:'incorrect-state'}),/授权校验已过期/);
 assert.equal(accounts.consumeWechatAuthorization(createHash('sha256').update(start.state).digest('hex')).action,'login');
 const validStart=login.start();const complete=await login.complete({code:'mock-code',state:validStart.state,cookieState:validStart.state});assert.equal(complete.action,'login');assert.equal(complete.user.displayName,'测试微信用户');assert.equal(complete.user.wechatLinked,true);assert.equal(requests[0].searchParams.get('appid'),'wx-mock-app');assert.equal(requests[0].searchParams.get('secret'),'mock-secret');
 await assert.rejects(login.complete({code:'mock-code',state:validStart.state,cookieState:validStart.state}),/已过期或已使用/);
 const closed=createWechatLogin({env:{...env,WECHAT_ALLOW_REGISTRATION:'false'},accounts,fetchImpl});activeOpenId='closed-openid';const again=closed.start();await assert.rejects(closed.complete({code:'mock-code',state:again.state,cookieState:again.state}),/未开放新账号注册/);
 const bindUser=await accounts.createUser('bind@example.test','a-long-test-password'),session=await accounts.login('bind@example.test','a-long-test-password');activeOpenId='bound-openid';const bindStart=login.start({mode:'bind',user:session.user,sessionToken:session.token});await login.complete({code:'mock-code',state:bindStart.state,cookieState:bindStart.state,sessionToken:session.token});assert.equal(accounts.session(session.token).wechatLinked,true);
 assert.throws(()=>login.start({mode:'bind'}),/请先登录后绑定/);
});
