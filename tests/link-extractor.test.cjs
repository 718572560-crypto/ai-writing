const test = require('node:test');
const assert = require('node:assert/strict');
const { privateAddress, validateArticleUrl, parseArticle, fetchArticle, MAX_TEXT } = require('../link-extractor.cjs');

test('accepts public article sites and blocks private addresses, credentials and non-web destinations', async () => {
  const lookup=async()=>[{address:'1.1.1.1',family:4}];
  for (const ip of ['127.0.0.1','10.2.3.4','172.19.1.1','192.168.1.3','169.254.169.254','::1','fc00::1','::ffff:127.0.0.1','192.0.2.1','198.51.100.1','203.0.113.1']) assert.equal(privateAddress(ip),true,ip);
  for (const ip of ['1.1.1.1','8.8.8.8','114.114.114.114','2409:8c1e:75b0:1120::57','2001:4860:4860::8888']) assert.equal(privateAddress(ip),false,ip);
  for(const url of ['http://mp.weixin.qq.com/s/test','https://example.com/article','https://www.huxiu.com/article/4903068.html','https://36kr.com/p/123','https://sspai.com/post/123','https://news.qq.com/rain/a/123']) assert.equal((await validateArticleUrl(url,lookup)).href,url);
  await assert.rejects(validateArticleUrl('file:///etc/passwd'),/HTTP/);
  await assert.rejects(validateArticleUrl('https://user:password@example.com/'),/HTTP/);
  await assert.rejects(validateArticleUrl('https://mp.weixin.qq.com@127.0.0.1/s/test'),/HTTPS/);
  await assert.rejects(validateArticleUrl('https://mp.weixin.qq.com:8443/s/test'),/HTTPS/);
  await assert.rejects(validateArticleUrl('https://mp.weixin.qq.com/s/test',async()=>[{address:'127.0.0.1',family:4}]),/公网/);
  const wechatLong=await validateArticleUrl('https://mp.weixin.qq.com/s?__biz=sample&mid=1&idx=1&sn=sample',async()=>[{address:'1.1.1.1',family:4}]);assert.equal(wechatLong.pathname,'/s');
  for(const route of ['item/1881014324900867','w/1881014324900867']) {
    const accepted=await validateArticleUrl('https://www.toutiao.com/'+route+'/',async()=>[{address:'1.1.1.1',family:4}]);
    assert.equal(accepted.pathname,'/'+route+'/');
  }
  for(const url of ['http://localhost/','https://127.1/','http://0x7f000001/','https://[::1]/','http://169.254.169.254/','http://printer.local/']) await assert.rejects(validateArticleUrl(url,lookup),/公网/);
  await assert.rejects(validateArticleUrl('https://example.com/post',async()=>[{address:'1.1.1.1',family:4},{address:'10.0.0.1',family:4}]),/公网/);
});

test('extracts full micro-post text from the public detail response for item and w links',async()=>{
  const body='第一段是微头条的原文，不需要登录就能公开阅读。\n\n第二段包含作者自己的观察与结尾，不应被摘要或相关推荐替代。';
  for(const [route,content] of [['item',JSON.stringify({rich_content:{text:body},images:[{caption:'图片元数据不要混入正文'}]})],['w',`<p>${body.split('\n\n')[0]}</p><p>${body.split('\n\n')[1]}</p>`]]) {
    const result=await fetchArticle(`https://www.toutiao.com/${route}/1881014324900867/`,{
      lookup:async()=>[{address:'1.1.1.1',family:4}],
      fetch:async(url,options)=>{
        assert.equal(String(url),'https://www.toutiao.com/api/pc/detail/?group_id=1881014324900867');
        assert.equal(options.redirect,'error');
        return Response.json({message:'success',data:{content,pgc_info_card:{media_info:{name:'公开作者'}}}});
      }
    });
    assert.equal(result.source,'公开作者');
    assert.match(result.content,/第一段是微头条的原文/);
    assert.match(result.content,/第二段包含作者自己的观察与结尾/);
    assert.doesNotMatch(result.content,/图片元数据|rich_content/);
    assert.equal(result.title,body.split('\n')[0]);
  }
});

test('falls back to article HTML when the public post response is unavailable or only metadata',async()=>{
  for(const payload of [{message:'error'},{message:'success',data:{content:JSON.stringify({images:[{}]})}}]) {
    let requests=0;
    const result=await fetchArticle('https://www.toutiao.com/item/1881014324900867/',{
      lookup:async()=>[{address:'1.1.1.1',family:4}],
      fetch:async url=>{
        requests++;
        if(String(url).includes('/api/pc/detail/'))return Response.json(payload);
        return new Response('<title>网页原文标题</title><article>'+('网页返回了完整的文章正文，应当继续使用网页方式提取而不是把错误或图片元数据当作正文。'.repeat(3))+'</article>',{headers:{'Content-Type':'text/html'}});
      }
    });
    assert.equal(requests,2);
    assert.equal(result.title,'网页原文标题');
    assert.match(result.content,/完整的文章正文/);
  }
});

test('selects Toutiao article body without its surrounding metadata, loading prompts, recommendations or comments',()=>{
  const body='美国有庞大的军费，有遍布全球的基地，还有数量可观的先进战机和航空母舰。这里是要读取的文章第一段。';
  const tail='最有价值的军事威慑，不是靠战争证明谁更强，而是看清战争的代价。这里是需要保留的文章末段。';
  const html=`<html><head><title>原文标题 - 今日头条</title></head><body><div class="article-content"><h1>原文标题</h1><div class="article-meta"><span>2026-10-30</span><span class="name"><a href="/c/user/token/author">八道宴之</a></span></div><span>视频加载中...</span><article class="syl-article-base tt-article-content"><p>${body}</p><p>${tail}</p></article></div><aside>相关推荐</aside><div class="comments"><p>读者评论不应混入原文</p></div></body></html>`;
  const a=parseArticle(html,'https://www.toutiao.com/article/7702399938851832339/');
  assert.equal(a.title,'原文标题');assert.equal(a.source,'八道宴之');assert.equal(a.content,body+'\n'+tail);
  assert.doesNotMatch(a.content,/原文标题|2026|加载中|相关推荐|读者评论/);
});

test('does not claim that an error or a page shell is article content',()=>{
  const html='<html><head><title>服务提示</title></head><body><main><p>这是一段网页状态文字，不是真实文章正文。'.repeat(5)+'</p></main></body></html>';
  assert.throws(()=>parseArticle(html,'https://www.toutiao.com/article/123/'),/未定位到/);
});

test('extracts readable WeChat article title, author and paragraphs while dropping scripts/navigation', () => {
  const html=`<!doctype html><html><head><meta property="og:title" content="午后散步，重新认识熟悉的街道"><meta name="author" content="城市观察"><title>关注我们</title></head><body><header>公众号关注我们</header><h1>午后散步，重新认识熟悉的街道</h1><div id="js_content"><p>上周六的午后，我从熟悉的地铁站提前一站下车，沿着河边走回家。</p><p>走进一条从未经过的小巷，才发现街角开着一家小小的花店。店主正把刚送来的枝叶整理进陶瓶里。</p><p>城市没有改变，只是我今天走得慢了一点，也多看见了一些日常的风景。</p><script>不要提取攻击性或导航脚本文本</script><p style="display:none">隐藏追踪文字</p><nav>相关推荐：不应进入正文</nav></div><footer>关注点赞</footer></body></html>`;
  const article=parseArticle(html,'https://mp.weixin.qq.com/s/example');
  assert.equal(article.title,'午后散步，重新认识熟悉的街道');
  assert.equal(article.source,'城市观察');
  assert.match(article.content,/从熟悉的地铁站提前一站下车/);
  assert.match(article.content,/街角开着一家小小的花店/);
  assert.doesNotMatch(article.content,/相关推荐|隐藏追踪|攻击性|关注点赞/);
  assert.equal(article.truncated,false);
});

test('decodes Chinese article HTML and reports a bounded article length', () => {
  const body=Array.from({length:600},(_,i)=>`<p>第${i+1}段：认真观察生活里的细节，给创作者带来新的写作灵感和值得分享的真实经历。</p>`).join('');
  const html=`<html><head><meta property="og:title" content="文章标题 &amp; 阅读体验"></head><body><article>${body}</article></body></html>`;
  const article=parseArticle(html,'https://www.toutiao.com/article/123/');
  assert.equal(article.title,'文章标题 & 阅读体验');
  assert.ok(article.content.includes('第1段'));
  assert.equal(article.truncated,true);
  assert.ok(article.content.length<=MAX_TEXT);
});

test('fetches only a valid public article URL and rechecks redirects', async () => {
  const html='<html><head><meta name="author" content="作者"><title>测试头条文章</title></head><body><article><h1>测试头条文章</h1><p>第一段正文足够长，包含真实文章的主要叙述内容以及一个具体细节。</p><p>第二段正文继续展开，能够正常显示在创作主题输入框内供作者查看和编辑。</p></article></body></html>';
  let requested;
  const result=await fetchArticle('https://www.toutiao.com/article/123/',{lookup:async()=>[{address:'1.1.1.1',family:4}],fetch:async(url,options)=>{requested={url:String(url),options};return new Response(html,{status:200,headers:{'Content-Type':'text/html; charset=utf-8'}});}});
  assert.equal(result.source,'作者');
  assert.match(result.content,/第一段正文/);
  assert.equal(requested.options.redirect,'manual');
  assert.match(requested.options.headers['User-Agent'],/YoushuStudio/);
  await assert.rejects(fetchArticle('https://www.toutiao.com/article/123/',{lookup:async()=>[{address:'1.1.1.1',family:4}],fetch:async()=>new Response(null,{status:302,headers:{Location:'http://127.0.0.1/private'}})}),/公网/);
});

test('browser fallback starts before slow HTTP finishes and cancels the losing request',async()=>{
 const lookup=async()=>[{address:'1.1.1.1',family:4}];let directAborted=false;
 const result=await fetchArticle('https://www.toutiao.com/article/123/',{lookup,hedgeMs:1,
 fetch:async(url,{signal})=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>{directAborted=true;reject(signal.reason);},{once:true});}),
 render:async()=>({title:'浏览器已读取',content:'完整正文'.repeat(20),source:'作者',url:'https://www.toutiao.com/article/123/',chars:80,truncated:false})});
 assert.equal(result.title,'浏览器已读取');assert.equal(directAborted,true);
});

test('HTTP success avoids launching browser and parse failure starts browser immediately',async()=>{
 const lookup=async()=>[{address:'1.1.1.1',family:4}];let rendered=0;
 const html='<title>真实文章标题</title><article>'+('文章的正文已经在 HTTP 返回中完整出现，不需要再打开浏览器。'.repeat(4))+'</article>';
 const first=await fetchArticle('https://www.toutiao.com/article/123/',{lookup,hedgeMs:10000,fetch:async()=>new Response(html,{headers:{'content-type':'text/html'}}),render:async()=>{rendered++;throw new Error('unneeded');}});
 assert.match(first.content,/完整出现/);assert.equal(rendered,0);
 const second=await fetchArticle('https://www.toutiao.com/article/124/',{lookup,hedgeMs:10000,fetch:async()=>new Response('<title>页面壳</title>',{headers:{'content-type':'text/html'}}),render:async()=>{rendered++;return {title:'渲染后的文章',content:'正文'};}});
 assert.equal(second.title,'渲染后的文章');assert.equal(rendered,1);
});

test('article reader merges duplicate work, ignores Toutiao tracking parameters, and caches only success',async()=>{
 const {createArticleReader}=require('../link-extractor.cjs');let calls=0,finish;
 const reader=createArticleReader({lookup:async()=>[{address:'1.1.1.1',family:4}],load:async(url)=>{calls++;await new Promise(resolve=>finish=resolve);return {title:'同一篇文章',content:'完整正文',url};}});
 const a=reader('https://www.toutiao.com/article/123/?log_from=a'),b=reader('https://www.toutiao.com/article/123/?log_from=b');
 await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,1);finish();
 assert.equal((await a).cached,false);assert.equal((await b).cached,false);
 const cached=await reader('https://www.toutiao.com/article/123/');assert.equal(cached.cached,true);assert.equal(calls,1);
});

test('canceling one reader preserves other users; canceling the last user aborts extraction',async()=>{
 const {createArticleReader}=require('../link-extractor.cjs');let loadSignal,finish,calls=0;
 const reader=createArticleReader({lookup:async()=>[{address:'1.1.1.1',family:4}],load:async(url,{signal})=>{calls++;loadSignal=signal;await new Promise((resolve,reject)=>{finish=resolve;signal.addEventListener('abort',()=>reject(signal.reason),{once:true});});return {title:'文章',content:'正文'};}});
 const one=new AbortController(),two=new AbortController();
 const a=reader('https://www.toutiao.com/article/123/',{signal:one.signal}),b=reader('https://www.toutiao.com/article/123/',{signal:two.signal});
 await new Promise(resolve=>setImmediate(resolve));one.abort();await assert.rejects(a);assert.equal(loadSignal.aborted,false);finish();await b;
 const last=new AbortController();const c=reader('https://www.toutiao.com/article/456/',{signal:last.signal});await new Promise(resolve=>setImmediate(resolve));last.abort();await assert.rejects(c);assert.equal(loadSignal.aborted,true);assert.equal(calls,2);
});
