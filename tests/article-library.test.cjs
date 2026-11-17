const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createArticleLibrary,normalizeArticle,excerpt,dateKey,curateArticle,shouldRefreshDaily}=require('../article-library.cjs');

test('normalizes public metadata, trims summaries, and rejects unsafe source URLs',()=>{
  const article=normalizeArticle({title:'  标题  ',content:'摘要 '.repeat(100),url:'https://mp.weixin.qq.com/s/example',domain:'科技',views:'12'});
  assert.equal(article.title,'标题');assert.equal(article.category,'科技');assert.equal(article.views,12);assert.ok(article.desc.length<=141);
  assert.equal(normalizeArticle({title:'标题',url:'http://mp.weixin.qq.com/s/example'}).url,'http://mp.weixin.qq.com/s/example');
  assert.equal(normalizeArticle({title:'虎嗅标题',url:'https://www.huxiu.com/article/4903068.html'}).url,'https://www.huxiu.com/article/4903068.html');
  assert.equal(normalizeArticle({title:'标题',url:'http://127.0.0.1/private'}).url,'');
  assert.equal(normalizeArticle({title:'标题',url:'https://evil.example/a'}).url,'');
  assert.ok(excerpt('文章 '.repeat(100),140).length<=141);
});

test('uses cache on upstream failure and imports public articles from any website',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-library-'));
  let fail=false;
  const library=createArticleLibrary({dataDir,schedule:false,fetchImpl:async()=>{if(fail)throw new Error('offline');return {ok:true,json:async()=>({articles:[{title:'公开标题',summary:'公开摘要',url:'https://www.toutiao.com/article/123/',domain:'科技'}],total:1,domains:['科技']})};},readArticle:async url=>({title:'导入标题',content:'导入正文摘要。'.repeat(20),url,source:'今日头条',chars:200})});
  try {
    const first=await library.list({time:'today',sort:'hot',domain:'全部'});assert.equal(first.articles.length,1);
    fail=true;const cached=await library.list({time:'today',sort:'hot',domain:'全部'},{refresh:true});assert.equal(cached.stale,true);assert.equal(cached.articles[0].title,'公开标题');
    await assert.rejects(library.addImport('http://127.0.0.1/post'),/公网/);
    const added=await library.addImport('https://www.toutiao.com/article/123456/');assert.equal(added.article.title,'导入标题');assert.equal(added.article.imported,true);
    const duplicate=await library.addImport('https://www.toutiao.com/article/123456/');assert.equal(duplicate.duplicate,true);
    const general=await library.addImport('https://www.huxiu.com/article/4903068.html');assert.equal(general.article.url,'https://www.huxiu.com/article/4903068.html');
    const restored=createArticleLibrary({dataDir,schedule:false});assert.equal((await restored.listImports()).count,2);
  } finally {fs.rmSync(dataDir,{recursive:true,force:true});}
});

test('uses Shanghai calendar dates for daily refresh decisions',()=>{
  assert.equal(dateKey('2026-11-05T16:30:00.000Z'),'2026-11-06');
  assert.equal(dateKey('2026-11-06T15:59:59.000Z'),'2026-11-06');
});

test('curates source material into category-aware writing angles',()=>{
  const technology=normalizeArticle({title:'【观察】AI工具进入日常工作！',summary:'多个团队开始使用智能助手。',domain:'科技',url:'https://www.toutiao.com/article/123/'});
  const society=normalizeArticle({title:'社区服务的新变化',summary:'多个团队开始使用智能助手。',domain:'社会',url:'https://www.toutiao.com/article/456/'});
  assert.equal(technology.sourceTitle,'【观察】AI工具进入日常工作！');
  assert.equal(technology.inspirationTitle,'观察AI工具进入日常工作');
  assert.match(technology.inspirationDesc,/写作时可以继续追问/);
  assert.notEqual(technology.writingAngle,society.writingAngle);
  assert.match(technology.writingPrompt,/不补造细节/);
  const curated=curateArticle('一条热点','','热点');
  assert.ok(curated.inspirationDesc.includes('一条热点'));
});

test('runs the daily refresh at or after 08:00 Beijing and catches up after restart',()=>{
  assert.equal(shouldRefreshDaily('2026-11-06T23:59:00.000Z',null),false); // 07:59 Beijing
  assert.equal(shouldRefreshDaily('2026-11-07T00:00:00.000Z',null),true); // 08:00 Beijing
  assert.equal(shouldRefreshDaily('2026-11-07T01:00:00.000Z','2026-11-07T00:00:00.000Z'),false);
  assert.equal(shouldRefreshDaily('2026-11-07T00:30:00.000Z','2026-11-06T23:00:00.000Z'),true);
  assert.equal(shouldRefreshDaily('2026-11-07T00:30:00.000Z','2026-11-07T00:10:00.000Z'),false);
});

test('reports daily refresh time and preserves source status with cached results',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-library-daily-'));
  let fail=false;
  const now=()=>Date.parse('2026-11-06T01:00:00.000Z'); // 09:00 Beijing
  const library=createArticleLibrary({dataDir,schedule:false,now,feeds:[],fetchImpl:async()=>{
    if(fail)throw new Error('offline');
    return {ok:true,json:async()=>({articles:[{title:'今日热点',summary:'一条公开摘要',url:'https://www.toutiao.com/article/123/',domain:'热点'}],total:1,domains:['热点']})};
  }});
  try {
    const refreshed=await library.refreshDaily();
    assert.equal(refreshed.dailyRefreshedAt,'2026-11-06T01:00:00.000Z');
    assert.deepEqual(refreshed.sources,[{name:'今日头条等平台聚合源',ok:true,error:''}]);
    fail=true;
    const cached=await library.refreshDaily();
    assert.equal(cached.stale,true);
    assert.equal(cached.articles[0].title,'今日热点');
    assert.equal(cached.dailyRefreshedAt,'2026-11-06T01:00:00.000Z');
    assert.deepEqual(cached.sources,refreshed.sources);
  } finally {fs.rmSync(dataDir,{recursive:true,force:true});}
});

test('coalesces simultaneous requests for the same article query',async()=>{
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-library-flight-'));
  let calls=0, release;
  const gate=new Promise(resolve=>{release=resolve;});
  const library=createArticleLibrary({dataDir,schedule:false,fetchImpl:async()=>{
    calls++;
    await gate;
    return {ok:true,json:async()=>({articles:[{title:'同一条公开内容',url:'https://www.toutiao.com/article/123/'}],total:1})};
  }});
  try {
    const first=library.list({time:'today',sort:'hot',domain:'全部'});
    const second=library.list({time:'today',sort:'hot',domain:'全部'});
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(calls,1);
    release();
    const [a,b]=await Promise.all([first,second]);
    assert.equal(a.articles[0].title,'同一条公开内容');
    assert.equal(b.articles[0].title,'同一条公开内容');
  } finally {fs.rmSync(dataDir,{recursive:true,force:true});}
});
