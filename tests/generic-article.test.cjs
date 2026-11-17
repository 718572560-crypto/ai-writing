const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {parseArticle,fetchArticle,MAX_HTML}=require('../link-extractor.cjs');
const {publicFetch,validateArticleUrl}=require('../article-url.cjs');
const lookup=async()=>[{address:'1.1.1.1',family:4}];
const first='下班后他没有立刻回家，而是在公交站旁边停了一会儿，想起今天会议上没来得及说完的话。';
const last='第二天早上，他把那份修改过的计划发给同事。事情没有突然变好，但两个人终于开始讨论具体该怎么办。';

test('Huxiu article DOM wins over shorter structured summary and excludes surrounding recommendations',()=>{
  const html=`<title>真实标题-虎嗅网</title><script type="application/ld+json">${JSON.stringify({'@type':'NewsArticle',author:{name:'原作者'},articleBody:'摘要而非全文。'.repeat(15)})}</script><nav>导航链接</nav><h1>真实标题</h1><div class="article__content"><p>${first}</p><p>${last}</p><div class="comments">这条评论不能进入正文</div><div hidden>隐藏文字</div><p style="display:none">隐藏追踪内容</p></div><aside>推荐文章</aside>`;
  const a=parseArticle(html,'https://www.huxiu.com/article/4903068.html');
  assert.equal(a.title,'真实标题');assert.equal(a.source,'原作者');
  assert.match(a.content,new RegExp(first));assert.ok(a.content.endsWith(last));
  assert.doesNotMatch(a.content,/摘要而非全文|导航链接|推荐文章|这条评论|隐藏/);
});

test('generic readability handles unfamiliar blog markup without mixing in menus or sidebars',()=>{
  const html=`<title>一次普通的工作沟通</title><header><nav>${'首页 分类 商城 联系我们 '.repeat(20)}</nav></header><main><div id="story-xyz"><h1>一次普通的工作沟通</h1><p>${first.repeat(5)}</p><p>${last.repeat(5)}</p></div></main><aside>${'这是相关推荐 '.repeat(100)}</aside><footer>版权与联系方式</footer>`;
  const a=parseArticle(html,'https://example.com/blog/story');
  assert.match(a.content,/下班后/);assert.match(a.content,/讨论具体该怎么办/);assert.doesNotMatch(a.content,/相关推荐|联系我们|版权与联系方式/);
  assert.equal(a.source,'example.com');
});

test('reads articleBody in JSON-LD graphs without confusing description with the full article',()=>{
  const data={'@graph':[{'@type':'WebPage',description:'只有摘要不能当正文'},{'@type':['Article','BlogPosting'],headline:'结构化文章',articleBody:first+'\n\n'+last,author:[{name:'一位作者'}]}]};
  const a=parseArticle(`<script type="application/ld+json">${JSON.stringify(data)}</script>`,'https://example.com/post');
  assert.equal(a.title,'结构化文章');assert.equal(a.source,'一位作者');assert.ok(a.content.endsWith(last));
  assert.throws(()=>parseArticle('<title>只有简介</title><meta name="description" content="'+first+last+'">','https://example.com/'),/未定位到/);
});

test('does not execute scripts or accept verification/error pages as articles',()=>{
  assert.throws(()=>parseArticle(`<title>安全验证</title><article>${first+last}</article>`,'https://example.com/'),/验证或错误/);
  const a=parseArticle(`<title>公开原文</title><article><p>${first}</p><p>${last}</p><script>globalThis.__readerExecuted=true;</script></article>`,'https://example.com/post');
  assert.equal(globalThis.__readerExecuted,undefined);assert.doesNotMatch(a.content,/__readerExecuted/);
});

test('marks publicly available paid-article text as partial',()=>{
  const a=parseArticle(`<title>文章预览</title><script type="application/ld+json">{"@type":"Article","isAccessibleForFree":false}</script><div class="post-content"><p>${first}</p><p>${last}</p></div><div class="paywall">订阅后阅读全文</div>`,'https://example.com/post');
  assert.equal(a.partial,true);assert.match(a.notice,/公开可见/);assert.doesNotMatch(a.content,/订阅后/);
});

test('follows public cross-site short links but rechecks every redirect destination',async()=>{
  const requests=[];
  const a=await fetchArticle('http://example.com/short',{lookup,fetch:async url=>{
    requests.push(String(url));
    if(requests.length===1)return new Response(null,{status:302,headers:{Location:'https://www.huxiu.com/article/4903068.html'}});
    return new Response(`<title>跳转后的原文</title><div class="article__content">${first+last}</div>`,{headers:{'content-type':'text/html'}});
  }});
  assert.equal(requests.length,2);assert.equal(a.url,'https://www.huxiu.com/article/4903068.html');
  await assert.rejects(fetchArticle('https://example.com/short',{lookup,fetch:async()=>new Response(null,{status:302,headers:{Location:'http://[::ffff:127.0.0.1]/private'}})}),/公网/);
});

test('pins DNS checks to the actual connection and rejects rebinding before connecting',async()=>{
  let calls=0;
  const changing=async()=>[{address:++calls===1?'1.1.1.1':'127.0.0.1',family:4}];
  await validateArticleUrl('https://rebinding.example.com/post',changing);
  await assert.rejects(publicFetch('https://rebinding.example.com/post',{signal:AbortSignal.timeout(3000)},changing),error=>/公网/.test(error.cause?.message||error.message));
  assert.equal(calls,2);
});

test('detects legacy Chinese charset from HTML meta when HTTP omits it and bounds large responses',async()=>{
  const bytes=Buffer.concat([Buffer.from('<meta charset="gb2312"><title>'),Buffer.from('d6d0cec4','hex'),Buffer.from('</title><article>'),Buffer.from('d6d0cec4'.repeat(100),'hex'),Buffer.from('</article>')]);
  const a=await fetchArticle('https://example.com/post',{lookup,fetch:async()=>new Response(bytes,{headers:{'content-type':'text/html'}})});
  assert.equal(a.title,'中文');assert.match(a.content,/中文中文/);
  await assert.rejects(fetchArticle('https://example.com/post',{lookup,fetch:async()=>new Response('',{headers:{'content-type':'text/html','content-length':String(MAX_HTML+1)}})}),/过大/);
});

test('writer detects arbitrary article links, shared text and balanced URL parentheses',()=>{
  const source=fs.readFileSync(path.join(__dirname,'..','public','app.js'),'utf8');
  const context=vm.createContext({URL});
  vm.runInContext(source.slice(source.indexOf('function articleUrlFromText('),source.indexOf('function scheduleLinkRead(')),context);
  for(const url of ['https://www.huxiu.com/article/4903068.html','http://example.com/post','https://en.wikipedia.org/wiki/Article_(publishing)','https://mp.weixin.qq.com/s?__biz=abc&mid=1']) assert.equal(context.articleUrlFromText(url),url);
  assert.equal(context.articleUrlFromText('推荐阅读：https://www.huxiu.com/article/4903068.html。'),'https://www.huxiu.com/article/4903068.html');
  assert.equal(context.articleUrlFromText('[原文](https://example.com/story)'),'https://example.com/story');
  assert.equal(context.articleUrlFromText('参考文章：正文\n\n原文链接：https://example.com/story'),'');
  assert.equal(context.articleUrlFromText('https://example.com/a https://example.com/b'),'');
  assert.equal(context.articleUrlFromText('https://user:pass@example.com/post'),'');
});
