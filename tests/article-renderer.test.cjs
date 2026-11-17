const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {fetchRenderedArticle,closeArticleBrowser}=require('../link-extractor.cjs');
const browserPath=process.env.BROWSER_EXECUTABLE || ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','C:/Program Files/Google/Chrome/Application/chrome.exe','/usr/bin/chromium','/usr/bin/chromium-browser','/usr/bin/google-chrome'].find(p=>fs.existsSync(p));

test('renders an unfamiliar article using its external CDN and public JSON API, without reading a loading shell',{skip:!browserPath,timeout:22000},async t=>{
  const previous=process.env.BROWSER_EXECUTABLE;process.env.BROWSER_EXECUTABLE=browserPath;
  t.after(async()=>{await closeArticleBrowser();if(previous===undefined)delete process.env.BROWSER_EXECUTABLE;else process.env.BROWSER_EXECUTABLE=previous;});
  const requests=[];
  const first='这是一篇动态加载的真实文章，开头讲述了人们在一次社区会议中遇到的问题，以及现场提出的不同解决方案。';
  const last='文章的最后一段保留了讨论的结果，也说明仍然需要关注后续进展，不能把加载中的页面或导航当作正文。';
  const result=await fetchRenderedArticle('https://dynamic.example.com/post',async()=>[{address:'1.1.1.1',family:4}],{
    fetch:async url=>{
      requests.push(url);
      if(url==='https://dynamic.example.com/post')return new Response(`<meta charset="utf-8"><title>动态文章标题</title><main>${'文章还在加载，请稍等片刻。'.repeat(4)}</main><script src="https://cdn.example.com/app.js"></script>`,{headers:{'content-type':'text/html; charset=utf-8'}});
      if(url==='https://cdn.example.com/app.js')return new Response(`setTimeout(async()=>{const r=await fetch('https://api.example.com/article');const a=await r.json();document.querySelector('main').innerHTML='<h1>动态文章标题</h1><div class="post-content"><p>'+a.first+'</p><p>'+a.last+'</p></div>';},400);`,{headers:{'content-type':'application/javascript; charset=utf-8'}});
      if(url==='https://api.example.com/article')return Response.json({first,last},{headers:{'access-control-allow-origin':'*'}});
      throw new Error('Unexpected request '+url);
    }
  });
  assert.equal(result.title,'动态文章标题');assert.ok(result.content.startsWith(first));assert.ok(result.content.endsWith(last));
  assert.doesNotMatch(result.content,/还在加载/);
  assert.ok(requests.includes('https://cdn.example.com/app.js'));assert.ok(requests.includes('https://api.example.com/article'));
});
