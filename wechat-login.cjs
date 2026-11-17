'use strict';

const { createHash, randomBytes } = require('node:crypto');

const sha256=value=>createHash('sha256').update(value).digest('hex');
const timeout=10000;

function createWechatLogin({env=process.env,accounts,fetchImpl=fetch}={}){
  const appId=env.WECHAT_LOGIN_APP_ID||env.WECHAT_APP_ID;
  const appSecret=env.WECHAT_LOGIN_APP_SECRET||env.WECHAT_APP_SECRET;
  const registrationEnabled=env.WECHAT_ALLOW_REGISTRATION!=='false';
  let configured=!!(accounts&&appId&&appSecret&&env.PUBLIC_BASE_URL);
  let publicBase='',callbackUrl='';
  if(configured){
    try{
      const url=new URL(env.PUBLIC_BASE_URL);
      if(url.pathname!=='/'||url.search||url.hash)throw new Error();
      if(url.protocol!=='https:'&&!(env.NODE_ENV!=='production'&&['localhost','127.0.0.1'].includes(url.hostname)))throw new Error();
      publicBase=url.origin;callbackUrl=new URL('/api/auth/wechat/callback',publicBase).href;
    }catch{configured=false;}
  }
  const unconfiguredReason=[!appId?'微信开放平台网站应用 AppID':null,!appSecret?'微信开放平台网站应用 AppSecret':null,!publicBase?'正式 HTTPS 网站域名及已验证的微信授权域名':null].filter(Boolean).join('、');
  async function jsonRequest(url){
    const response=await fetchImpl(url,{signal:AbortSignal.timeout(timeout),headers:{Accept:'application/json'}});
    if(!response.ok)throw Object.assign(new Error('微信授权服务暂时不可用。'),{status:502});
    const value=await response.json();
    if(!value||typeof value!=='object'||Array.isArray(value)||value.errcode||value.openid&&typeof value.openid!=='string')throw Object.assign(new Error('微信授权未能完成，请重试。'),{status:502});
    return value;
  }
  function start({mode='login',user=null,sessionToken=null}={}){
    if(!configured)throw Object.assign(new Error('尚未配置微信开放平台网站应用。'),{status:503});
    const action=mode==='bind'?'bind':'login';
    if(action==='bind'&&(!user?.id||!sessionToken))throw Object.assign(new Error('请先登录后绑定微信。'),{status:401});
    const state=randomBytes(32).toString('hex');accounts.beginWechatAuthorization({stateHash:sha256(state),action,userId:action==='bind'?user.id:null,sessionToken:action==='bind'?sessionToken:null});
    const url=new URL('https://open.weixin.qq.com/connect/qrconnect');
    url.searchParams.set('appid',appId);url.searchParams.set('redirect_uri',callbackUrl);url.searchParams.set('response_type','code');url.searchParams.set('scope','snsapi_login');url.searchParams.set('state',state);
    return {url:url.href,state,callbackUrl};
  }
  async function complete({code,state,cookieState,sessionToken}){
    if(!configured)throw Object.assign(new Error('尚未配置微信开放平台网站应用。'),{status:503});
    if(typeof state!=='string'||!/^[a-f\d]{64}$/i.test(state)||typeof cookieState!=='string'||!timingSafeHashMatch(state,cookieState))throw Object.assign(new Error('微信授权校验已过期，请重新扫码。'),{status:400});
    if(typeof code!=='string'||!code||code.length>512)throw Object.assign(new Error('微信未返回授权凭证，请重试。'),{status:400});
    const authorization=accounts.consumeWechatAuthorization(sha256(state));
    if(!authorization)throw Object.assign(new Error('微信授权已过期或已使用，请重新扫码。'),{status:400});
    if(authorization.action==='bind'){
      if(!sessionToken||authorization.sessionHash!==sha256(sessionToken))throw Object.assign(new Error('绑定请求已失效，请登录后重新发起。'),{status:401});
      const active=accounts.session(sessionToken);if(active?.id!==authorization.userId)throw Object.assign(new Error('登录状态已变化，请重新绑定。'),{status:401});
    }
    const token=await jsonRequest('https://api.weixin.qq.com/sns/oauth2/access_token?'+new URLSearchParams({appid:appId,secret:appSecret,code,grant_type:'authorization_code'}));
    if(typeof token.access_token!=='string'||typeof token.openid!=='string'||token.openid.length>128)throw Object.assign(new Error('微信未返回有效授权信息。'),{status:502});
    const profile=await jsonRequest('https://api.weixin.qq.com/sns/userinfo?'+new URLSearchParams({access_token:token.access_token,openid:token.openid,lang:'zh_CN'}));
    const identity={openId:token.openid,unionId:typeof(profile.unionid||token.unionid)==='string'?(profile.unionid||token.unionid).slice(0,128):null,nickname:typeof profile.nickname==='string'?profile.nickname:''};
    const user=authorization.action==='bind'?accounts.bindWechatIdentity({userId:authorization.userId,sessionToken, ...identity}):accounts.completeWechatLogin({...identity,allowRegistration:registrationEnabled});
    return {user,action:authorization.action};
  }
  return {configured,callbackUrl,publicBase,unconfiguredReason,start,complete};
}
function timingSafeHashMatch(a,b){const x=Buffer.from(sha256(a),'hex'),y=Buffer.from(sha256(b),'hex');const {timingSafeEqual}=require('node:crypto');return x.length===y.length&&timingSafeEqual(x,y);}

module.exports={createWechatLogin};
