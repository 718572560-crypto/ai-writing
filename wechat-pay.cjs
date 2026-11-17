'use strict';

const {
  createPrivateKey,createPublicKey,createVerify,createSign,createDecipheriv,
  X509Certificate,randomBytes
}=require('node:crypto');

const api='https://api.mch.weixin.qq.com';
const safeError=(message,status=502)=>Object.assign(new Error(message),{status});
const normalizeSerial=value=>String(value||'').replaceAll(':','').replace(/\s/g,'').toUpperCase().replace(/^0+/,'');
const base64Pem=value=>{
  if(typeof value!=='string'||!value.trim())return '';
  if(value.includes('-----BEGIN '))return value.trim();
  const text=Buffer.from(value.trim(),'base64').toString('utf8');
  return text.includes('-----BEGIN ')?text:'';
};
const signedText=(timestamp,nonce,message)=>`${timestamp}\n${nonce}\n${message}\n`;

function createWechatPay({env=process.env,fetchImpl=fetch,now=()=>Date.now()}={}){
  const key=base64Pem(env.WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64);
  const pem=base64Pem(env.WECHAT_PAY_PLATFORM_CERTIFICATE_BASE64);
  let privateKey=null,certificate=null,platformKey=null,serial='';
  try {
    if(key){privateKey=createPrivateKey(key);if(privateKey.asymmetricKeyType!=='rsa'||privateKey.asymmetricKeyDetails.modulusLength<2048)privateKey=null;}
    if(pem){certificate=new X509Certificate(pem);const withinValidity=Date.now()>=Date.parse(certificate.validFrom)&&Date.now()<=Date.parse(certificate.validTo);platformKey=withinValidity?certificate.publicKey:null;serial=normalizeSerial(certificate.serialNumber);}
    else {const publicPem=base64Pem(env.WECHAT_PAY_PLATFORM_PUBLIC_KEY_BASE64);if(publicPem){platformKey=createPublicKey(publicPem);serial=normalizeSerial(env.WECHAT_PAY_PLATFORM_SERIAL);}}
    if(platformKey&&(platformKey.asymmetricKeyType!=='rsa'||platformKey.asymmetricKeyDetails.modulusLength<2048))platformKey=null;
  } catch { privateKey=null;certificate=null;platformKey=null; }
  const platformSerial=normalizeSerial(env.WECHAT_PAY_PLATFORM_SERIAL);
  const v3key=typeof env.WECHAT_PAY_API_V3_KEY==='string'?Buffer.from(env.WECHAT_PAY_API_V3_KEY,'utf8'):Buffer.alloc(0);
  const appId=env.WECHAT_PAY_APP_ID||env.WECHAT_LOGIN_APP_ID||env.WECHAT_APP_ID||'';
  const publicBase=String(env.PUBLIC_BASE_URL||'').replace(/\/+$/,'');
  let notifyUrl='';
  try { notifyUrl=new URL(env.WECHAT_PAY_NOTIFY_URL||'/api/pay/wechat/notify',publicBase).href; } catch {}
  let validNotify=false;try{const parsedNotify=new URL(notifyUrl);validNotify=parsedNotify.protocol==='https:'&&parsedNotify.origin===publicBase&&parsedNotify.pathname==='/api/pay/wechat/notify'&&!parsedNotify.search&&!parsedNotify.hash;}catch{}
  const configured=!!(appId&&env.WECHAT_PAY_MCHID&&env.WECHAT_PAY_MCH_SERIAL&&privateKey&&platformKey&&platformSerial&&serial===platformSerial&&v3key.length===32&&validNotify);
  const reasons=[];
  if(!appId)reasons.push('微信支付关联 AppID');
  if(!env.WECHAT_PAY_MCHID)reasons.push('微信支付商户号 WECHAT_PAY_MCHID');
  if(!env.WECHAT_PAY_MCH_SERIAL)reasons.push('商户 API 证书序列号 WECHAT_PAY_MCH_SERIAL');
  if(!privateKey)reasons.push('商户 API 私钥 WECHAT_PAY_MERCHANT_PRIVATE_KEY_BASE64');
  if(!platformKey||!platformSerial||serial!==platformSerial)reasons.push('微信支付平台证书/公钥及序列号');
  if(v3key.length!==32)reasons.push('32 字节 APIv3 密钥 WECHAT_PAY_API_V3_KEY');
  if(!validNotify)reasons.push('同域 HTTPS 支付通知地址及 PUBLIC_BASE_URL');

  function authorization(method,path,bodyText){
    const timestamp=String(Math.floor(now()/1000)),nonce=randomBytes(16).toString('hex');
    const signer=createSign('RSA-SHA256');signer.update(method+'\n'+path+'\n'+timestamp+'\n'+nonce+'\n'+bodyText+'\n');signer.end();
    const signature=signer.sign(privateKey,'base64');
    return `WECHATPAY2-SHA256-RSA2048 mchid="${env.WECHAT_PAY_MCHID}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${env.WECHAT_PAY_MCH_SERIAL}",signature="${signature}"`;
  }
  function verifySignedResponse(headers,bodyText){
    const timestamp=headers.get('wechatpay-timestamp'),nonce=headers.get('wechatpay-nonce'),signature=headers.get('wechatpay-signature'),responseSerial=normalizeSerial(headers.get('wechatpay-serial'));
    if(!timestamp||!/^[0-9]{1,12}$/.test(timestamp)||Math.abs(Math.floor(now()/1000)-Number(timestamp))>300||!nonce||!signature||responseSerial!==platformSerial)throw safeError('微信支付应答签名校验失败。');
    const verifier=createVerify('RSA-SHA256');verifier.update(signedText(timestamp,nonce,bodyText));verifier.end();
    if(!verifier.verify(platformKey,signature,'base64'))throw safeError('微信支付应答签名校验失败。');
  }
  async function apiRequest(path,body){
    if(!configured)throw safeError('微信支付商户尚未完成安全配置。',503);
    const bodyText=JSON.stringify(body),response=await fetchImpl(api+path,{method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),headers:{Accept:'application/json','Content-Type':'application/json','Authorization':authorization('POST',path,bodyText)},body:bodyText});
    const responseText=await response.text();verifySignedResponse(response.headers,responseText);
    let data;try{data=JSON.parse(responseText);}catch{throw safeError('微信支付返回了无法识别的应答。');}
    if(!response.ok)throw safeError('微信支付暂时无法受理该订单，请稍后重试。');
    return data;
  }
  async function createNativeOrder({providerRef,name,amountCents}){
    if(!configured)throw safeError('微信支付商户尚未完成安全配置。',503);
    if(!/^[A-F\d]{32}$/.test(providerRef)||!Number.isInteger(amountCents)||amountCents<1||amountCents>100000000)throw safeError('支付订单参数无效。',400);
    const response=await apiRequest('/v3/pay/transactions/native',{appid:appId,mchid:env.WECHAT_PAY_MCHID,description:String(name).slice(0,120),out_trade_no:providerRef,notify_url:notifyUrl,time_expire:new Date(now()+15*60*1000).toISOString().replace(/\.\d{3}Z$/,'+00:00'),amount:{total:amountCents,currency:'CNY'}});
    if(typeof response.code_url!=='string'||!response.code_url.startsWith('weixin://wxpay/'))throw safeError('微信支付未返回有效的付款码，请重试。');
    return {codeUrl:response.code_url};
  }
  function verifyAndDecryptNotification(headers,bodyText){
    if(!configured)throw safeError('微信支付通知校验尚未配置。',503);
    const timestamp=headers['wechatpay-timestamp'],nonce=headers['wechatpay-nonce'],signature=headers['wechatpay-signature'],incomingSerial=normalizeSerial(headers['wechatpay-serial']);
    if(!timestamp||!/^[0-9]{1,12}$/.test(timestamp)||Math.abs(Math.floor(now()/1000)-Number(timestamp))>300||!nonce||!signature||incomingSerial!==platformSerial)throw safeError('微信支付通知签名校验失败。',400);
    const verifier=createVerify('RSA-SHA256');verifier.update(signedText(timestamp,nonce,bodyText));verifier.end();
    if(!verifier.verify(platformKey,signature,'base64'))throw safeError('微信支付通知签名校验失败。',400);
    let event;try{event=JSON.parse(bodyText);}catch{throw safeError('微信支付通知格式无效。',400);}
    const resource=event?.resource;
    if(!resource||resource.algorithm!=='AEAD_AES_256_GCM'||typeof resource.ciphertext!=='string'||typeof resource.nonce!=='string'||Buffer.byteLength(resource.nonce)!==12||typeof event.id!=='string'||event.id.length>128)throw safeError('微信支付通知加密数据无效。',400);
    try{
      const encrypted=Buffer.from(resource.ciphertext,'base64');if(encrypted.length<17)throw new Error();
      const decipher=createDecipheriv('aes-256-gcm',v3key,Buffer.from(resource.nonce,'utf8'));
      if(resource.associated_data)decipher.setAAD(Buffer.from(resource.associated_data,'utf8'));
      decipher.setAuthTag(encrypted.subarray(-16));
      const clear=Buffer.concat([decipher.update(encrypted.subarray(0,-16)),decipher.final()]).toString('utf8');
      const payment=JSON.parse(clear);
      if(event.event_type!=='TRANSACTION.SUCCESS'||payment.trade_state!=='SUCCESS'||payment.appid!==appId||payment.mchid!==env.WECHAT_PAY_MCHID||typeof payment.out_trade_no!=='string'||!payment.amount||!Number.isInteger(payment.amount.total)||payment.amount.currency!=='CNY'||typeof payment.transaction_id!=='string')throw safeError('微信支付通知内容与当前商户不匹配。',400);
      return {notificationId:event.id,transactionId:payment.transaction_id,providerRef:payment.out_trade_no,amountCents:payment.amount.total,currency:payment.amount.currency};
    }catch(error){if(error.status)throw error;throw safeError('微信支付通知解密失败。',400);}
  }
  return {configured,appId,notifyUrl,unconfiguredReason:reasons.join('、'),createNativeOrder,verifyAndDecryptNotification};
}

module.exports={createWechatPay,normalizeSerial};
