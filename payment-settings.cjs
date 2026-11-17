'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');

const SECRET_FIELDS = [
  'merchantPrivateKeyBase64', 'platformCertificateBase64',
  'platformPublicKeyBase64', 'apiV3Key', 'wechatLoginAppSecret'
];
const bad = message => Object.assign(new Error(message), { status: 400 });
const clean = (value, max = 200) => {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.trim().length > max) throw bad('配置字段类型或长度无效。');
  return value.trim();
};

function createPaymentSettings(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const keyPath = path.join(directory, 'payment-settings.key');
  const dataPath = path.join(directory, 'payment-settings.enc');
  let key;
  try {
    key = fs.readFileSync(keyPath);
    if (key.length !== 32) throw new Error('支付配置密钥文件格式无效。');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    key = randomBytes(32);
    fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' });
    try { fs.chmodSync(keyPath, 0o600); } catch {}
  }

  function read() {
    try {
      const saved = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(saved.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(saved.tag, 'base64'));
      return JSON.parse(Buffer.concat([
        decipher.update(Buffer.from(saved.data, 'base64')),
        decipher.final()
      ]).toString('utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw new Error('收款账户配置无法解密；请恢复 payment-settings.key 与配置文件备份。');
    }
  }

  function write(config) {
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(config)), cipher.final()]);
    const payload = JSON.stringify({ iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') });
    const tempPath = `${dataPath}.${process.pid}.tmp`;
    fs.writeFileSync(tempPath, payload, { mode: 0o600 });
    try { fs.chmodSync(tempPath, 0o600); } catch {}
    fs.renameSync(tempPath, dataPath);
    try { fs.chmodSync(dataPath, 0o600); } catch {}
  }

  function save(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw Object.assign(new Error('收款账户配置格式无效。'), { status: 400 });
    const previous = read() || {};
    for (const field of Object.keys(input)) if (input[field] !== undefined && field !== 'wechatAllowRegistration' && typeof input[field] !== 'string') throw bad('配置字段必须为文本。');
    if (input.wechatAllowRegistration !== undefined && typeof input.wechatAllowRegistration !== 'boolean') throw bad('微信注册开关必须为布尔值。');
    const next = {
      accountName: clean(input.accountName || previous.accountName, 80),
      appId: clean(input.appId || previous.appId, 128),
      mchid: clean(input.mchid || previous.mchid, 64),
      merchantSerial: clean(input.merchantSerial || previous.merchantSerial, 128),
      platformSerial: clean(input.platformSerial || previous.platformSerial, 128),
      notifyUrl: clean(input.notifyUrl || previous.notifyUrl, 500),
      publicBaseUrl: clean(input.publicBaseUrl || previous.publicBaseUrl, 500),
      wechatLoginAppId: clean(input.wechatLoginAppId || previous.wechatLoginAppId, 128),
      merchantPrivateKeyBase64: clean(input.merchantPrivateKeyBase64 || previous.merchantPrivateKeyBase64, 20000),
      platformCertificateBase64: clean(input.platformCertificateBase64 || previous.platformCertificateBase64, 20000),
      platformPublicKeyBase64: clean(input.platformPublicKeyBase64 || previous.platformPublicKeyBase64, 20000),
      apiV3Key: clean(input.apiV3Key || previous.apiV3Key, 128)
    };
    next.wechatLoginAppSecret=clean(input.wechatLoginAppSecret||previous.wechatLoginAppSecret,512);
    next.wechatAllowRegistration=input.wechatAllowRegistration ?? previous.wechatAllowRegistration ?? true;
    // A supplied verification key replaces the other verification method.
    if (input.platformPublicKeyBase64?.trim() && !input.platformCertificateBase64?.trim()) next.platformCertificateBase64='';
    if (input.platformCertificateBase64?.trim() && !input.platformPublicKeyBase64?.trim()) next.platformPublicKeyBase64='';
    if (input.platformCertificateBase64?.trim() && input.platformPublicKeyBase64?.trim()) throw bad('平台证书与平台公钥请选择一种。');
    if (previous.mchid && next.mchid!==previous.mchid && !(input.merchantPrivateKeyBase64?.trim() && input.apiV3Key?.trim() && input.merchantSerial?.trim())) throw bad('切换商户号时请同时填写新商户的私钥、证书序列号与 APIv3 密钥。');
    if (previous.wechatLoginAppId && next.wechatLoginAppId!==previous.wechatLoginAppId && !input.wechatLoginAppSecret?.trim()) throw bad('切换微信登录 AppID 时请同时填写对应的 AppSecret。');
    if (!next.accountName&&!next.wechatLoginAppId) throw Object.assign(new Error('请填写收款账户名称或微信登录 AppID。'), { status: 400 });
    if (next.publicBaseUrl) {
      let url;try { url=new URL(next.publicBaseUrl); } catch { throw bad('正式网站地址格式无效。'); }
      if (url.protocol!=='https:' || url.username || url.password || url.pathname!=='/' || url.search || url.hash) throw bad('正式网站地址须为 HTTPS 域名，不能包含路径、账号、查询参数或片段。');
      next.publicBaseUrl=url.origin;
    }
    if (next.notifyUrl) {
      let url;try { url=new URL(next.notifyUrl); } catch { throw bad('支付通知地址格式无效。'); }
      if (url.origin!==next.publicBaseUrl || url.pathname!=='/api/pay/wechat/notify' || url.search || url.hash || url.username || url.password) throw bad('通知地址须为正式网站域名下的 /api/pay/wechat/notify。');
    }
    write(next);
    return next;
  }

  function status() {
    const config = read();
    if (!config) return { exists: false, accountName: '', appId: '', wechatLoginAppId:'', wechatAllowRegistration:true, wechatLoginConfigured:false, mchid: '', merchantSerial: '', platformSerial: '', notifyUrl: '', publicBaseUrl: '', secretsConfigured: false };
    return {
      exists: true, accountName: config.accountName, appId: config.appId,
      wechatLoginAppId:config.wechatLoginAppId||'',wechatLoginConfigured:!!(config.wechatLoginAppId&&config.wechatLoginAppSecret),
      wechatAllowRegistration:config.wechatAllowRegistration!==false,
      mchid: config.mchid, merchantSerial: config.merchantSerial,
      platformSerial: config.platformSerial, notifyUrl: config.notifyUrl,
      publicBaseUrl: config.publicBaseUrl,
      secretsConfigured: !!(config.merchantPrivateKeyBase64 && config.apiV3Key && (config.platformCertificateBase64 || config.platformPublicKeyBase64)),
      secrets: Object.fromEntries(SECRET_FIELDS.map(field => [field, !!config[field]]))
    };
  }
  return { read, save, status };
}

module.exports = { createPaymentSettings };
