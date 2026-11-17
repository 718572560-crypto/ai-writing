'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const { Agent, fetch: request } = require('undici');
const MAX_HTML = 6 * 1024 * 1024;
const invalid = message => Object.assign(new Error(message), {status:400});

function privateAddress(value) {
  const ip = String(value || '').toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
  if (ip.includes(':')) {
    const first = Number.parseInt(ip.split(':')[0] || '0', 16);
    return !net.isIP(ip) || first < 0x2000 || first > 0x3fff || /^2001:(?:db8|0|2|10|20):/.test(ip) || ip.startsWith('2002:');
  }
  if (!net.isIP(ip)) return true;
  const [a,b,c] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2)) ||
    (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
    (a === 203 && b === 0 && c === 113);
}

// Shared syntax check for library links and the extractor; DNS is checked again at connection time.
function normalizeArticleUrl(raw) {
  if (typeof raw !== 'string' || raw.trim().length > 4096) throw invalid('请粘贴完整的文章链接（最长 4096 字符）。');
  let url;
  try { url = new URL(raw.trim()); } catch { throw invalid('请粘贴完整的 HTTP 或 HTTPS 文章链接。'); }
  if (!['https:','http:'].includes(url.protocol) || url.username || url.password || url.port) throw invalid('仅支持标准端口的 HTTP / HTTPS 公开文章链接，不支持账号或密码。');
  const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');
  if (!host || host.includes('%') || /(?:^|\.)(?:localhost|local|internal|lan|home|invalid|test|example)$/.test(host) ||
      (net.isIP(host) ? privateAddress(host) : !host.includes('.'))) throw invalid('文章链接未通过公网地址检查。');
  url.hash = '';
  return url;
}

async function publicAddresses(host, lookup = dns.lookup) {
  host = host.replace(/\.$/, '').replace(/^\[|\]$/g, '');
  let addresses, timer;
  try {
    addresses = net.isIP(host) ? [{address:host, family:net.isIP(host)}] : await Promise.race([
      lookup(host, {all:true, verbatim:true}),
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),4000);timer.unref?.();})
    ]);
  } catch { throw Object.assign(new Error('暂时无法解析文章网站地址，请检查链接或稍后重试。'), {status:502}); }
  finally {clearTimeout(timer);}
  if (!addresses.length || addresses.some(row=>privateAddress(row.address))) throw invalid('文章链接未通过公网地址检查。');
  return addresses;
}

async function validateArticleUrl(raw, lookup = dns.lookup) {
  const url = normalizeArticleUrl(raw);
  await publicAddresses(url.hostname, lookup);
  return url;
}

// Resolve inside the transport's lookup callback so validation and connection cannot use different DNS results.
async function publicFetch(raw, options = {}, lookup = dns.lookup) {
  const url = normalizeArticleUrl(String(raw));
  const agent = new Agent({connect:{lookup(host, opts, callback) {
    publicAddresses(host, lookup).then(rows=>{
      const family = Number(opts.family) || 0;
      const addresses = family ? rows.filter(row=>row.family===family) : rows;
      if (!addresses.length) throw new Error('没有可用的公网地址。');
      if (opts.all) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    }).catch(callback);
  }}});
  try {
    const response = await request(url, {...options, redirect:'manual', dispatcher:agent});
    if (Number(response.headers.get('content-length')) > MAX_HTML) {
      await response.body?.cancel();
      throw Object.assign(new Error('文章页面内容过大，无法安全读取。'), {status:413});
    }
    const parts = []; let total = 0;
    for await (const part of response.body || []) {
      total += part.length;
      if (total > MAX_HTML) throw Object.assign(new Error('文章页面内容过大，无法安全读取。'), {status:413});
      parts.push(part);
    }
    const headers = new Headers(response.headers);
    headers.delete('content-encoding'); headers.delete('content-length');
    return new Response([204,205,304].includes(response.status) ? null : Buffer.concat(parts), {status:response.status, headers});
  } finally {await agent.destroy();}
}
module.exports = {MAX_HTML, privateAddress, normalizeArticleUrl, validateArticleUrl, publicAddresses, publicFetch};
