const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '..', 'public', 'app.js'), 'utf8');
const reader = source.slice(source.indexOf('function readReferenceLink('), source.indexOf('function clearTopicText('));

function setup(fetch) {
  const url = 'https://www.toutiao.com/item/1881014324900867/';
  const states = [], topic = {}, count = {}, preview = {};
  const context = vm.createContext({
    fetch, AbortController, AbortSignal, performance, setTimeout, clearTimeout,
    activeLinkUrl:'', activeLinkPromise:null, linkTimer:undefined, linkController:null, linkRequestId:0,
    status:{token:'before-restart',csrf:'old-csrf'}, writer:{topic:url},
    articleUrlFromText:text => text === url ? url : '', persist:()=>{},
    setLinkState:(...state)=>states.push(state), wordCount:text=>text.replace(/\s/g,'').length,
    $:selector=>selector === '#topic' ? topic : selector === '#topic-count' ? count : preview,
  });
  vm.runInContext(reader, context);
  return {context,states,topic};
}

test('an open writing tab recovers after server restart and imports the actual article', async()=>{
  const calls=[];
  const {context,states,topic}=setup(async(path,options)=>{
    calls.push({path,token:options?.headers?.['X-Studio-Token'],csrf:options?.headers?.['X-CSRF-Token']});
    if(path==='/api/status')return Response.json({token:'after-restart',csrf:'new-csrf'});
    if(calls.length===1)return Response.json({error:'请刷新页面后重试。'},{status:403});
    return Response.json({title:'公开文章',source:'原作者',content:'完整文章的真实正文，含第一段与最后一段。',url:'https://www.toutiao.com/w/1881014324900867/'});
  });
  await context.readReferenceLink();
  assert.deepEqual(calls.map(c=>c.path),['/api/extract-link','/api/status','/api/extract-link']);
  assert.equal(calls[2].token,'after-restart');
  assert.equal(calls[2].csrf,'new-csrf');
  assert.match(topic.value,/完整文章的真实正文/);
  assert.equal(context.writer.topic,'完整文章的真实正文，含第一段与最后一段。');
  assert.doesNotMatch(context.writer.topic,/来源：|参考文章：|原文链接：/);
  assert.equal(context.writer.reference.url,'https://www.toutiao.com/w/1881014324900867/');
  assert.equal(context.writer.reference.title,'公开文章');
  assert.equal(states.at(-1)[0],'ok');
});

test('invalid links and authentication failures are not blindly retried; repeated denial stops',async()=>{
  for(const status of [400,401,403]){
    let requests=0,refreshes=0;
    const {context,states}=setup(async path=>{
      if(path==='/api/status'){refreshes++;return Response.json({token:'refreshed'});}
      requests++;return Response.json({error:'无法读取这篇文章'},{status});
    });
    await context.readReferenceLink();
    assert.equal(requests,status===403?2:1);
    assert.equal(refreshes,status===403?1:0);
    assert.equal(states.at(-1)[0],'fail');
    assert.equal(context.writer.topic,'https://www.toutiao.com/item/1881014324900867/');
  }
});
