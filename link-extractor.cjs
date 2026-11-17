const dns = require('node:dns').promises;
const fs = require('node:fs');
const {MAX_HTML, privateAddress, normalizeArticleUrl, validateArticleUrl, publicFetch} = require('./article-url.cjs');
const {parseGenericArticle, CONTENT_SELECTOR} = require('./generic-article.cjs');
const {cleanArticleText} = require('./article-cleaner.cjs');

const MAX_TEXT = 20000;
const BLOCKED_TAGS = new Set(['script', 'style', 'noscript', 'svg', 'iframe', 'canvas', 'template', 'nav', 'footer', 'button', 'form', 'aside']);
const VOID_TAGS = new Set(['area','base','br','col','embed','hr','img','input','link','meta','param','source','track','wbr']);

function decodeEntities(s) {
  return s.replace(/&(#(?:x[\da-f]{1,8}|\d{1,8})|amp|lt|gt|quot|apos|nbsp|ensp|emsp|middot);/gi, (all, entity) => {
    if (entity[0] === '#') { const hex = entity[1]?.toLowerCase() === 'x'; const code = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10); return Number.isFinite(code) && code <= 0x10ffff ? String.fromCodePoint(code) : ''; }
    return ({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'",nbsp:' ',ensp:' ',emsp:'  ',middot:'·'})[entity.toLowerCase()] || all;
  });
}

function parseAttributes(text) {
  const result = {};
  for (const m of text.matchAll(/([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) result[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return result;
}

function parseHtml(html) {
  const root = { tag:'root', attrs:{}, children:[], parent:null };
  const stack = [root];
  const tokens = html.match(/<!--[\s\S]*?-->|<![^>]*>|<\/?[a-zA-Z][^>]*>|[^<]+|</g) || [];
  for (const token of tokens) {
    if (token.startsWith('<!--') || /^<!/.test(token)) continue;
    if (token[0] !== '<' || token === '<') {
      if (stack.at(-1).tag !== 'script' && stack.at(-1).tag !== 'style' && stack.at(-1).tag !== 'noscript') stack.at(-1).children.push(decodeEntities(token));
      continue;
    }
    const closing = /^<\s*\//.test(token);
    const tagMatch = token.match(/^<\s*\/?\s*([\w:-]+)/);
    if (!tagMatch) continue;
    const tag = tagMatch[1].toLowerCase();
    if (closing) {
      for (let i = stack.length - 1; i > 0; i--) if (stack[i].tag === tag) { stack.length = i; break; }
      continue;
    }
    const node = { tag, attrs:parseAttributes(token.slice(tagMatch[0].length, token.length - 1)), children:[], parent:stack.at(-1) };
    stack.at(-1).children.push(node);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(token) && stack.length < 120) stack.push(node);
  }
  return root;
}

function descendants(node, out = []) {
  for (const child of node.children || []) if (typeof child !== 'string') { out.push(child); descendants(child, out); }
  return out;
}

function visible(node) {
  const a = node.attrs || {};
  return !BLOCKED_TAGS.has(node.tag) && !('hidden' in a) && a['aria-hidden'] !== 'true' && !/display\s*:\s*none/i.test(a.style || '');
}

function nodeText(node, chunks = [], body=false) {
  if (typeof node === 'string') { chunks.push(node); return chunks; }
  if (!visible(node) || body && (node.tag==='h1' || node.tag==='figcaption' || /(?:^|\s)(?:comments?|comment-list|related-articles|recommend-list|image-caption|img-caption|photo-caption|share-buttons|qrcode)(?:\s|$)/i.test(node.attrs.class||''))) return chunks;
  const block = /^(?:p|div|article|section|h[1-6]|li|blockquote|pre|tr|table|ul|ol)$/.test(node.tag);
  if (block && chunks.length && !chunks.at(-1).endsWith('\n')) chunks.push('\n');
  for (const child of node.children || []) nodeText(child, chunks, body);
  if (node.tag === 'br') chunks.push('\n');
  if (block && chunks.length && !chunks.at(-1).endsWith('\n')) chunks.push('\n');
  return chunks;
}

function cleanText(node, body=false) {
  return nodeText(node,[],body).join('').replace(/[\t\u00a0\u3000 ]+/g, ' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
}

function parseArticle(html, pageUrl) {
  if (Buffer.byteLength(html) > MAX_HTML) throw Object.assign(new Error('文章页面内容过大，无法安全读取。'), { status:413 });
  const hostname = new URL(pageUrl).hostname;
  if (hostname !== 'mp.weixin.qq.com' && !/(^|\.)toutiao\.com$/.test(hostname)) return parseGenericArticle(html, pageUrl);
  html = html.replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,'').replace(/<img\b[^>]*>/gi,'');
  const root = parseHtml(html);
  const all = descendants(root);
  const metas = all.filter(n => n.tag === 'meta');
  const meta = (key, value) => {
    const row = metas.find(n => (n.attrs[key] || '').toLowerCase() === value.toLowerCase());
    return row?.attrs.content || '';
  };
  const titleNode = all.find(n => n.tag === 'h1' && cleanText(n));
  const titleTag = all.find(n=>n.tag==='title');
  const rawTitle = (titleNode ? cleanText(titleNode) : '') || meta('property','og:title') || meta('name','twitter:title') || (titleTag ? cleanText(titleTag) : '');
  const title = rawTitle.replace(/\s*[-_|｜]\s*(?:今日头条|头条号|微信公众号|微信公众平台).*$/,'').trim().slice(0,180);
  const byline = all.find(n=>/(?:^|\s)article-meta(?:\s|$)/.test(n.attrs.class||''));
  const authorNode = byline && descendants(byline).find(n=>n.tag==='a' && /\/c\/user\//.test(n.attrs.href||''));
  const author = meta('name','author') || meta('property','og:article:author') || meta('name','twitter:creator') || (authorNode ? cleanText(authorNode) : '');
  const source = author || (/weixin\.qq\.com/.test(pageUrl) ? '微信公众号文章' : '今日头条文章');
  const selectors = [
    { score:150, test:n=>n.attrs.id==='js_content' },
    { score:145, test:n=>n.tag==='article' && /(?:tt-article-content|syl-article-base)/.test(n.attrs.class||'') },
    { score:135, test:n=>n.attrs.id==='article-content' },
    { score:110, test:n=>/(?:rich_media_content|article-content|article__content|article-content-inner|article-body|article_detail__content)/i.test(n.attrs.class||'') },
    { score:125, test:n=>n.tag==='article' }
  ];
  const candidates = [];
  for (const n of all) {
    let rank = 0;
    for (const selector of selectors) if (selector.test(n)) rank = Math.max(rank, selector.score);
    if (!rank) continue;
    const text = cleanText(n,true);
    if (text.length >= 40) candidates.push({rank, text});
  }
  candidates.sort((a,b)=>b.rank-a.rank || b.text.length-a.text.length);
  let content = cleanArticleText(candidates[0]?.text || '',{title});
  if (!title || content.replace(/\s/g,'').length < 40) throw Object.assign(new Error('未定位到这篇文章的正文。请重新读取，或直接复制文章正文到输入框。'), { status:422 });
  const truncated = content.length > MAX_TEXT;
  content = content.slice(0, MAX_TEXT).trim();
  return { title, source, url:pageUrl, content, chars:content.replace(/\s/g,'').length, truncated };
}

function getCharset(contentType, html) {
  const charset = String(contentType || '').match(/charset\s*=\s*["']?([^;\s"']+)/i)?.[1] || html.slice(0,8192).match(/<meta\b[^>]*charset\s*=\s*["']?([\w-]+)/i)?.[1] || 'utf-8';
  const normalized = charset.toLowerCase().replace(/[^\w-]/g,'');
  if (['gb2312','gbk','xgbk','gb18030'].includes(normalized)) return 'gb18030';
  return ['utf-8','utf8','big5','shift_jis','euc-jp','iso-8859-1','windows-1252'].includes(normalized) ? normalized : 'utf-8';
}

async function fetchToutiaoPost(url, options) {
  const id = url.pathname.match(/^\/(?:item|w)\/(\d+)\/?$/)?.[1];
  if (!id) return null;
  // This public detail endpoint includes the post body; HTML can be only a page shell.
  const target = await validateArticleUrl(`https://www.toutiao.com/item/${id}/`, options.lookup || dns.lookup);
  const response = await (options.fetch || ((url, init)=>publicFetch(url, init, options.lookup)))(`${target.origin}/api/pc/detail/?group_id=${id}`, {
    redirect:'error', headers:{Accept:'application/json',Referer:target.href,'User-Agent':'YoushuStudio/1.0'},
    signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
  });
  if (!response.ok || !response.body) throw new Error('头条公开正文接口暂不可用。');
  if (Number(response.headers.get('content-length')) > MAX_HTML) throw Object.assign(new Error('文章页面内容过大，无法安全读取。'), {status:413});
  const parts=[]; let total=0;
  for await (const part of response.body) {
    total+=part.length;
    if(total>MAX_HTML) throw Object.assign(new Error('文章页面内容过大，无法安全读取。'), {status:413});
    parts.push(part);
  }
  const payload=JSON.parse(Buffer.concat(parts).toString('utf8'));
  if(payload.message!=='success' || typeof payload.data?.content!=='string') throw new Error('头条未返回公开正文。');
  const data=payload.data;
  let body=data.content, plain=false;
  if(/^\s*\{/.test(body)) {
    const post=JSON.parse(body);
    if(typeof post.rich_content?.text!=='string') throw new Error('头条正文格式暂不可识别。');
    body=post.rich_content.text; plain=true;
  }
  const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const text=plain ? body.trim() : cleanText(parseHtml(body));
  const title=(typeof data.title==='string' && data.title.trim()) || text.split(/\n/).find(line=>line.trim())?.slice(0,180);
  if(!title || text.replace(/\s/g,'').length<40) throw new Error('头条未返回完整可读的正文。');
  const author=data.pgc_info_card?.media_info?.name;
  return parseArticle(`<title>${escape(title)}</title>${typeof author==='string'?`<meta name="author" content="${escape(author)}">`:''}<article>${plain?escape(body).replace(/\n/g,'<br>'):body}</article>`,url.href);
}

async function fetchDirectArticle(rawUrl, options = {}) {
  const lookup = options.lookup || dns.lookup;
  const request = options.fetch || ((url, init)=>publicFetch(url, init, lookup));
  let url = await validateArticleUrl(rawUrl, lookup);
  if (/(^|\.)toutiao\.com$/.test(url.hostname) && /^\/(?:item|w)\/\d+\/?$/.test(url.pathname)) {
    try { return await fetchToutiaoPost(url, options); }
    catch (error) { options.signal?.throwIfAborted(); if (error.status===400 || error.status===413) throw error; }
  }
  for (let redirect = 0; redirect <= 5; redirect++) {
    options.signal?.throwIfAborted();
    const response = await request(url, { redirect:'manual', headers:{ 'Accept':'text/html,application/xhtml+xml;q=0.9,*/*;q=0.2', 'Accept-Language':'zh-CN,zh;q=0.9,en;q=0.5', 'User-Agent':'Mozilla/5.0 (compatible; YoushuStudio/1.0; +https://qdaiyoushu.com/)', 'Referer':url.origin + '/' }, signal:options.signal ? AbortSignal.any([options.signal,AbortSignal.timeout(7000)]) : AbortSignal.timeout(7000) });
    if ([301,302,303,307,308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirect === 5) throw Object.assign(new Error('文章链接跳转过多或目标不可用，请打开文章复制正文。'), { status:422 });
      const next = new URL(location, url);
      await response.body?.cancel();
      url = await validateArticleUrl(next.href, lookup);
      continue;
    }
    if (!response.ok) throw Object.assign(new Error(response.status === 403 || response.status === 401 ? '平台限制了自动读取。请打开文章复制正文，再粘贴到写作框。' : `文章页面暂时无法读取（HTTP ${response.status}）。请稍后重试或直接粘贴正文。`), { status:422 });
    if (!/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(response.headers.get('content-type') || '')) throw Object.assign(new Error('链接没有返回可读取的网页正文，请确认这是文章页面。'), { status:422 });
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_HTML) throw Object.assign(new Error('文章页面内容过大，无法安全读取。'), { status:413 });
    if (!response.body) throw Object.assign(new Error('文章页面没有可读取的内容。'), { status:422 });
    const parts=[];let total=0;
    for await (const part of response.body) { total+=part.length;if(total>MAX_HTML) throw Object.assign(new Error('文章页面内容过大，无法安全读取。'),{status:413});parts.push(part); }
    const buffer=Buffer.concat(parts);
    const html=new TextDecoder(getCharset(response.headers.get('content-type'), buffer.subarray(0,8192).toString('latin1'))).decode(buffer);
    return parseArticle(html, url.href);
  }
  throw Object.assign(new Error('文章链接无法读取，请打开文章复制正文。'), { status:422 });
}

let browserJobs = 0;
let sharedBrowser, browserStarting, browserIdle;
async function acquireBrowser(chromium,browserPath) {
  clearTimeout(browserIdle);
  if(sharedBrowser?.isConnected())return sharedBrowser;
  if(!browserStarting)browserStarting=chromium.launch({headless:true,executablePath:browserPath,timeout:8000}).then(browser=>{sharedBrowser=browser;browser.on('disconnected',()=>{if(sharedBrowser===browser)sharedBrowser=null;});return browser;}).finally(()=>{browserStarting=null;});
  return browserStarting;
}
function releaseBrowser() {
  if(browserJobs)return;
  clearTimeout(browserIdle);
  browserIdle=setTimeout(()=>{if(!browserJobs&&sharedBrowser){const browser=sharedBrowser;sharedBrowser=null;browser.close().catch(()=>{});}},60000);
  browserIdle.unref();
}
async function closeArticleBrowser(){clearTimeout(browserIdle);if(browserStarting)await browserStarting.catch(()=>{});const browser=sharedBrowser;sharedBrowser=null;if(browser)await browser.close().catch(()=>{});}
async function fetchRenderedArticle(rawUrl, lookup = dns.lookup, options = {}) {
  if (browserJobs >= 2) throw Object.assign(new Error('文章读取任务较多，请稍后再试。'), {status:429});
  let chromium;
  try { ({ chromium } = require('playwright-core')); }
  catch { throw Object.assign(new Error('该文章需要浏览器渲染。请先在服务器执行 npm install，或直接粘贴文章正文。'),{status:422}); }
  const browserPath = process.env.BROWSER_EXECUTABLE || [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    '/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].find(file=>fs.existsSync(file));
  if (!browserPath) throw Object.assign(new Error('该文章需要浏览器渲染，请在服务器设置 BROWSER_EXECUTABLE 指向 Chrome、Edge 或 Chromium，或直接粘贴正文。'),{status:422});
  browserJobs++;
  let context;
  let abort;
  try {
    const timing=options.onTiming||(()=>{});
    await validateArticleUrl(rawUrl, lookup);
    timing('validated');
    options.signal?.throwIfAborted();
    const browser = await acquireBrowser(chromium,browserPath);
    timing('browser-ready');
    options.signal?.throwIfAborted();
    context=await browser.newContext({locale:'zh-CN',serviceWorkers:'block'});
    abort=()=>context.close().catch(()=>{});
    options.signal?.addEventListener('abort',abort,{once:true});
    options.signal?.throwIfAborted();
    const page=await context.newPage();
    let requests=0;
    await context.routeWebSocket('**/*',socket=>socket.close());
    await page.route('**/*',async route=>{
      const request=route.request();
      if (++requests>100 || !['GET','HEAD'].includes(request.method()) || ['image','media','font','stylesheet'].includes(request.resourceType())) return route.abort();
      try {
        const target=normalizeArticleUrl(request.url());
        if (request.isNavigationRequest()) {
          if (request.frame() !== page.mainFrame()) return route.abort();
          await validateArticleUrl(target.href,lookup);
        }
        const response=await (options.fetch||publicFetch)(target.href,{method:request.method(),headers:await request.allHeaders(),signal:options.signal?AbortSignal.any([options.signal,AbortSignal.timeout(6500)]):AbortSignal.timeout(6500)},lookup);
        const headers=Object.fromEntries(response.headers);
        const cookies=response.headers.getSetCookie();
        if(cookies.length)headers['set-cookie']=cookies.join('\n');
        return await route.fulfill({status:response.status,headers,body:Buffer.from(await response.arrayBuffer())});
      } catch { return route.abort(); }
    });
    await page.goto(rawUrl,{waitUntil:'commit',timeout:12000});
    timing('navigation-committed');
    await page.waitForFunction(genericSelector=>{
      const selector=/(^|\.)toutiao\.com$/.test(location.hostname)?'article.tt-article-content, article.syl-article-base, article, #article-content':location.hostname==='mp.weixin.qq.com'?'#js_content':genericSelector+', article, main, #content, .content';
      const body=[...document.querySelectorAll(selector)].some(node=>(node.textContent||'').replace(/\s/g,'').length>=40);
      const title=document.querySelector('h1')?.textContent?.trim()||document.querySelector('meta[property="og:title"]')?.content||document.title;
      return title&&(body || document.querySelectorAll('p').length>=2 && (document.body?.innerText||'').length>160 || [...document.querySelectorAll('script[type="application/ld+json"]')].some(n=>n.textContent.includes('articleBody')));
    },CONTENT_SELECTOR,{timeout:12000,polling:100});
    timing('body-ready');
    const deadline=Date.now()+10000;
    while(true){
      options.signal?.throwIfAborted();
      try{
        const finalUrl=await validateArticleUrl(page.url(),lookup);
        return parseArticle(await page.content(),finalUrl.href);
      }catch(error){
        if(error.status!==422||Date.now()>=deadline||/验证或错误页面/.test(error.message))throw error;
        await abortable(new Promise(resolve=>setTimeout(resolve,300)),options.signal);
      }
    }
  } catch(error) {
    if (error.status) throw error;
    throw Object.assign(new Error('文章读取超时或页面结构未被正确识别，请重新读取，或复制正文到输入框。',{cause:error}),{status:422});
  } finally {options.signal?.removeEventListener('abort',abort);if(context)await context.close().catch(()=>{});browserJobs--;releaseBrowser();}
}

function abortable(promise,signal){
  if(!signal)return promise;
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{const abort=()=>reject(signal.reason);signal.addEventListener('abort',abort,{once:true});promise.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));});
}
async function readArticleFast(url,options){
  const controller=new AbortController();
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),controller.signal,AbortSignal.timeout(25000)]);
  let timer,startRender;
  const hedgeMs=options.hedgeMs??(/(^|\.)(?:toutiao\.com|weixin\.qq\.com)$/.test(new URL(url).hostname)?450:1200);
  const renderReady=new Promise(resolve=>{startRender=resolve;timer=setTimeout(resolve,hedgeMs);});
  // Start the browser shortly after HTTP, or immediately on an HTTP extraction failure.
  const direct=fetchDirectArticle(url,{...options,signal}).catch(error=>{startRender();throw error;});
  const rendered=renderReady.then(()=>{signal.throwIfAborted();return (options.render||fetchRenderedArticle)(url,options.lookup||dns.lookup,{signal});});
  try{return await abortable(Promise.any([direct,rendered]),signal);}
  catch(error){if(options.signal?.aborted)throw options.signal.reason;const errors=error.errors||[error];const specific=errors.find(e=>[400,413].includes(e.status))||errors.find(e=>e.status===422&&/平台限制|验证或错误|HTTP \d/.test(e.message));if(specific)throw specific;throw Object.assign(new Error('未能取得这篇文章的正文，网页直读和浏览器读取均未成功。请打开原文确认可访问后重试，或直接粘贴正文。'),{status:422});}
  finally{clearTimeout(timer);controller.abort();startRender();}
}
const articleCache=new Map(), articlePending=new Map();
function articleKey(url){const key=new URL(url);key.hash='';if(/(^|\.)toutiao\.com$/.test(key.hostname)&&/^\/((?:article|item|w)\/\d+|[ai]\d+)\/?$/.test(key.pathname))key.search='';return key.href;}
function createArticleReader({lookup=dns.lookup,load=readArticleFast,ttl=300000,maxEntries=32}={}){
  const cache=load===readArticleFast?articleCache:new Map(),pending=load===readArticleFast?articlePending:new Map();
  return async function read(rawUrl,{signal}={}){
    signal?.throwIfAborted();
    const url=await abortable(validateArticleUrl(rawUrl,lookup),signal),key=articleKey(url);
    const saved=cache.get(key);
    if(saved&&Date.now()-saved.at<ttl){cache.delete(key);cache.set(key,saved);return {...saved.value,cached:true};}
    if(saved)cache.delete(key);
    let job=pending.get(key);
    if(!job){
      if(pending.size>=6)throw Object.assign(new Error('文章读取任务较多，请稍后重试。'),{status:429});
      const controller=new AbortController();job={controller,users:0};
      job.promise=Promise.resolve().then(()=>load(url.href,{lookup,signal:controller.signal})).then(value=>{if(!controller.signal.aborted){cache.set(key,{at:Date.now(),value});while(cache.size>maxEntries)cache.delete(cache.keys().next().value);}return {...value,cached:false};}).finally(()=>{if(pending.get(key)===job)pending.delete(key);});
      pending.set(key,job);
    }
    job.users++;
    try{return await abortable(job.promise,signal);}
    finally{job.users--;if(!job.users&&pending.get(key)===job){pending.delete(key);job.controller.abort();}}
  };
}
const defaultReader=createArticleReader();
async function fetchArticle(rawUrl,options={}){
  if(options.fetch&&!options.render)return fetchDirectArticle(rawUrl,options);
  if(options.render||options.lookup)return readArticleFast((await validateArticleUrl(rawUrl,options.lookup||dns.lookup)).href,options);
  return defaultReader(rawUrl,options);
}
module.exports = { MAX_HTML, MAX_TEXT, privateAddress, normalizeArticleUrl, validateArticleUrl, parseHtml, cleanText, parseArticle, fetchArticle, fetchRenderedArticle, createArticleReader, closeArticleBrowser };
