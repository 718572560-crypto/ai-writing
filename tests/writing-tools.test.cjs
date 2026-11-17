const test=require('node:test');
const assert=require('node:assert/strict');
const {scan,parseJson,promptFor}=require('../writing-tools.cjs');
test('local writing scan reports measurable editorial issues with original positions',()=>{
 const text='这是一个绝对保证有效的方法！！！\n\n这是一个很长的句子'.padEnd(130,'，')+'建议逐段拆开。';
 const r=scan(text,'');
 assert.ok(r.metrics.chars>100);assert.ok(r.metrics.paragraphs>=2);assert.ok(r.issues.some(x=>x.type==='标题'));assert.ok(r.issues.some(x=>x.type==='绝对化/保证性表达'));assert.ok(r.issues.some(x=>x.type==='标点'));assert.ok(r.issues.some(x=>x.type==='可读性'&&Number.isInteger(x.start)));
});
test('scanner safely handles empty drafts and masks contact information as a finding',()=>{
 assert.equal(scan('').score,0);
 const r=scan('请联系 13800138000，具体数字为 123456。','标题');
 assert.ok(r.issues.some(x=>x.type==='联系方式'));
 assert.ok(!r.summary.includes('13800138000'));
});
test('AI analysis JSON parser accepts fenced JSON but rejects malformed output',()=>{
 const r=parseJson('```json\n{"summary":"ok","score":140,"issues":[{"severity":"bad","quote":"x"}],"rewrite":"稿件"}\n```');
 assert.equal(r.score,100);assert.equal(r.issues[0].severity,'medium');assert.equal(r.rewrite,'稿件');
 assert.throws(()=>parseJson('not json'),/格式无效/);
 assert.match(promptFor('platform','正文','标题','微信公众号'),/不保证任何平台审核通过/);
});
test('platform checklist varies by platform and sensitive quotations are masked',()=>{
 const a=scan('可以联系 13800138000 咨询。研究表明这可以治愈多种疾病。','标题','今日头条');
 const b=scan('普通的生活记录。','标题','小红书');
 assert.ok(a.checklist.some(x=>x.includes('医疗')));assert.ok(b.checklist.some(x=>x.includes('商业合作')));
 assert.ok(a.issues.some(x=>x.type==='健康医疗'));assert.ok(a.issues.some(x=>x.type==='来源核实'));assert.ok(!a.issues.find(x=>x.type==='联系方式').quote.includes('13800138000'));
 assert.throws(()=>parseJson('null'),/格式无效/);assert.throws(()=>parseJson('[]'),/格式无效/);assert.throws(()=>parseJson('{}'),/格式无效/);
});
test('tool workflows retain distinct inputs, article plans, diagnosis dimensions and edit explanations',()=>{
 const {toolPrompt}=require('../writing-tools.cjs');
 const base={text:'社区书店原稿',title:'周末记录',platform:'微信公众号',style:'自然叙述'};
 assert.match(toolPrompt({...base,tool:'topic',options:{audience:'附近居民',goal:'周末去处'}}),/topics 必须包含 4 个方案/);
 assert.match(toolPrompt({...base,tool:'quality',options:{focus:['论证']}}),/dimensions/);
 assert.match(toolPrompt({...base,tool:'followup',options:{action:'integrate',answers:[{question:'去了哪家店',answer:'街角书店'}]}}),/街角书店/);
 assert.match(toolPrompt({...base,tool:'toutiao',options:{notice:'题文不符'}}),/用户实际收到/);
 const integration=toolPrompt({...base,tool:'followup',options:{action:'integrate',answers:[{question:'何时',answer:'周六'}]}});assert.match(integration,/必须在此输出完整新稿/);assert.doesNotMatch(integration,/不要立即改稿|rewrite 为空/);
 const quality=toolPrompt({...base,tool:'quality',options:{focus:['结构','论证'],reasoning:'low'}});assert.match(quality,/只按以下选中维度精修：结构、论证/);assert.match(quality,/保留原稿事实、数字、限定、观点与段落结构/);assert.match(quality,/"score":80/);assert.doesNotMatch(quality,/"issues"|"reasoning"/);
 const result=parseJson(JSON.stringify({summary:'分析完成',topics:[{title:'选题',angle:'角度',audience:'读者',outline:['一','二'],materials:'采访'}],dimensions:[{name:'论证',score:78,reason:'缺证据',suggestion:'补来源'}],changes:[{before:'夸大',after:'具体',reason:'保留事实'}]}));
 assert.equal(result.topics[0].outline.length,2);assert.equal(result.dimensions[0].score,78);assert.equal(result.changes[0].after,'具体');
});
test('quality refinement requires selected dimension feedback and a complete rewrite',()=>{
 const {validateToolResult}=require('../writing-tools.cjs');
 const data={tool:'quality',options:{focus:['结构','论证']}};
 const complete={summary:'调整结构并补足论据。',rewrite:'完整新稿',dimensions:[{name:'结构层次',score:80,reason:'开头两段都在铺背景。',suggestion:'将核心问题前置。'},{name:'论证质量',score:70,reason:'关键结论缺少来源。',suggestion:'补充可核对出处。'}]};
 assert.equal(validateToolResult(data,complete).dimensions.length,2);
 assert.throws(()=>validateToolResult(data,{...complete,dimensions:[complete.dimensions[0]]}),/所选维度/);
});
test('structured questions retain their text and missing required tool results fail explicitly',()=>{
 const {validateToolResult}=require('../writing-tools.cjs');
 const a=parseJson(JSON.stringify({summary:'需要补充材料',questions:[{question:'书店叫什么？',reason:'使场景具体'},'当时有多少读者？']}));
 assert.equal(a.questions.length,2);assert.match(a.questions[0],/书店叫什么.*使场景具体/);
 assert.equal(validateToolResult({tool:'followup'},a).questions.length,2);
 assert.throws(()=>validateToolResult({tool:'followup'},{questions:[],rewrite:''}),/没有返回可回答/);
 assert.throws(()=>validateToolResult({tool:'quality'},{rewrite:''}),/完整改稿/);
 assert.throws(()=>validateToolResult({tool:'diagnosis'},{dimensions:[]}),/分项结构/);
});
