const test=require('node:test');
const assert=require('node:assert/strict');
const {cleanArticleText}=require('../article-cleaner.cjs');
const {parseArticle}=require('../link-extractor.cjs');
const first='这座城市的行政区划经历过多次调整，居民仍然保留着自己的生活习惯，也在寻找新的发展机会。';
const middle='2023年，区域经济增长13.9%，但部分居民收入低于全市平均水平27.4%。文中的数字不能在清洗中丢失。';
const last='有人这样形容自己的经历：“生在泰安、长在莱芜、老在济南。”未来如何发展，依旧需要时间来回答。';

test('Guokr-style references, photo credits, reprint notices and like requests are excluded across generic and platform readers',()=>{
  const body=`<p>来源：城市漫游计划（ID：test）</p><p>${first}[1]</p><p>莱芜齐长城锦阳关丨图虫创意</p><h2>城市的变化</h2><p>${middle.replace('13.9%','13.9%[16]').replace('27.4%','27.4%[18]')}</p><p>${last}</p><p>参考文献</p>${Array.from({length:19},(_,i)=>`<p>[${i+1}] 某统计局. (2024). 统计年鉴. Retrieved 16 July 2024 from https://example.com/report/${i+1}.</p>`).join('')}<p>撰文：作者</p><p>本文经授权转载自某公众号，如需二次转载请联系原作者。欢迎转发到朋友圈。</p><p>点个“小爱心”吧</p>`;
  for(const url of ['https://www.guokr.com/article/470655/','https://mp.weixin.qq.com/s/example','https://www.toutiao.com/article/123/']){
    const a=parseArticle(`<title>城市的变化</title><article id="js_content" class="article__content">${body}</article>`,url);
    assert.ok(a.content.startsWith(first));assert.ok(a.content.endsWith(last));
    assert.ok(a.content.includes(middle));assert.match(a.content,/城市的变化/);
    assert.doesNotMatch(a.content,/来源：|ID：|图虫创意|参考文献|Retrieved|example.com|撰文：|授权转载|爱心|\[\d+\]/);
  }
});

test('numbered steps, years, facts, quotations, links and substantive warnings in the body are retained',()=>{
  const text=`${first}\n\n[1] 建设阶段（2019），先核实公开数据再决定预算。\n\n[2] 调整阶段（2024），需观察各区的实际变化。\n\n据统计局报道，经济增长13.9%，数据链接：https://example.com/report。\n\n投资有风险，本材料不构成投资建议。\n\n${last}`;
  assert.equal(cleanArticleText(text),text);
});

test('bibliographies without a heading require multiple high-confidence citation entries at the end',()=>{
  const body=first+'\n\n'+middle+'\n\n'+last;
  const references='\n\n[1] 央广网. (2019). 公开区划资料.\nRetrieved 16 July 2024 from\nhttps://example.com/1.\n\n[2] 某统计局. (2024). 统计公报.\nhttps://example.com/2.';
  assert.equal(cleanArticleText(body+references),body);
  const list='[1] 第一项建设目标（2019），属于正文。\n\n[2] 第二项建设目标（2024），属于正文。';
  assert.equal(cleanArticleText(body+'\n\n'+list),body+'\n\n'+list);
});

test('a conclusion after the reference section is preserved and cleaning is idempotent',()=>{
  const input=first+'\n\n参考文献\n\n[1] 作者. (2024). 公开报告.\n\n结语\n\n'+last;
  const result=cleanArticleText(input);
  assert.equal(result,first+'\n\n结语\n\n'+last);assert.equal(cleanArticleText(result),result);
  assert.equal(cleanArticleText(first+'\n\n参考文献里的日期也可能写错，需要逐一核对。'),first+'\n\n参考文献里的日期也可能写错，需要逐一核对。');
});

test('DOM references and captions are removed, while narrative section headings remain',()=>{
  const a=parseArticle(`<title>原文标题</title><div class="post-content"><h1>原文标题</h1><p>${first}[1]</p><h2>发展中的选择</h2><figure><img src="test.jpg"><figcaption>图片说明不需要</figcaption></figure><p>${middle}</p><p>${last}</p><div role="doc-bibliography"><p>[1] 作者. (2024). 报告.</p></div></div>`,'https://example.com/post');
  assert.ok(a.content.startsWith(first));assert.ok(a.content.endsWith(last));assert.match(a.content,/发展中的选择/);
  assert.doesNotMatch(a.content,/原文标题|图片说明|\[1\]|作者|2024/);
});

test('plain JSON-LD article text receives the same cleanup',()=>{
  const content=first+'\n\n'+middle+'\n\n'+last+'\n\n参考文献\n\n[1] 作者. (2024). 参考报告.\n\n点个“小爱心”吧';
  const a=parseArticle('<script type="application/ld+json">'+JSON.stringify({'@type':'Article',headline:'正文标题',articleBody:content})+'</script>','https://example.com/post');
  assert.equal(a.content,first+'\n\n'+middle+'\n\n'+last);
});
