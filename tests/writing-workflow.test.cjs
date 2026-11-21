'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {runWritingWorkflow}=require('../public/writing-workflow.js');

function fixture(extra={}){
 const events=[],saved=[];
 const options={automatic:true,generate:async()=>({content:'生成原稿',model:'first-model'}),humanize:async source=>{assert.equal(saved[0],source);return {content:'自然改稿',model:'second-model'};},save:async(result,kind)=>{const draft={...result,id:kind};saved.push(draft);return draft;},onState:s=>events.push(s),...extra};
 return {events,saved,options};
}
test('automatic writing saves source before humanizing and completes only after final save',async()=>{
 let release;const held=new Promise(resolve=>{release=resolve;});
 const f=fixture();const save=f.options.save;
 f.options.save=async(result,kind)=>{if(kind==='final')await held;return save(result,kind);};
 const pending=runWritingWorkflow(f.options);
 while(!f.events.some(e=>e.stage==='saving-final'))await new Promise(resolve=>setImmediate(resolve));
 assert.equal(f.events.at(-1).percent,90);assert.equal(f.saved.length,1);
 release();const result=await pending;
 assert.equal(result.stage,'complete');assert.equal(result.percent,100);assert.equal(result.source.content,'生成原稿');assert.equal(result.final.content,'自然改稿');
 assert.deepEqual(f.events.map(e=>[e.stage,e.percent]),[['generating',0],['saving-source',45],['humanizing',50],['saving-final',90],['complete',100]]);
});
test('second-step failure retains saved source and explicit retry calls only humanizing',async()=>{
 const f=fixture({humanize:async()=>{throw new Error('额度不足');}});
 const result=await runWritingWorkflow(f.options);
 assert.equal(result.stage,'error');assert.equal(result.percent,50);assert.equal(result.source.content,'生成原稿');assert.equal(f.saved.length,1);assert.equal(f.events.at(-1).error,'额度不足');
 let generated=0,edited=0;const retry=fixture({source:result.source,generate:async()=>{generated++;throw new Error('must not generate');},humanize:async source=>{edited++;assert.equal(source.id,'source');return {content:'重试后的改稿'};}});
 const resumed=await runWritingWorkflow(retry.options);assert.equal(resumed.stage,'complete');assert.equal(generated,0);assert.equal(edited,1);assert.equal(retry.saved.length,1);
});
test('first-step failure never calls humanizing or saves an incomplete article',async()=>{
 let called=0;const f=fixture({generate:async()=>{throw new Error('上游失败');},humanize:async()=>{called++;}});
 const result=await runWritingWorkflow(f.options);assert.equal(result.stage,'error');assert.equal(result.percent,0);assert.equal(called,0);assert.equal(f.saved.length,0);
});
test('stopping during generation prevents subsequent stages even if transport resolves late',async()=>{
 const controller=new AbortController();let edited=0;
 const f=fixture({signal:controller.signal,generate:async()=>{controller.abort();return {content:'迟到的回复'};},humanize:async()=>{edited++;}});
 const result=await runWritingWorkflow(f.options);assert.equal(result.stage,'cancelled');assert.equal(edited,0);assert.equal(f.saved.length,0);assert.equal(result.percent,0);
});
test('stopping during humanizing preserves source and never reports completion',async()=>{
 const controller=new AbortController();const f=fixture({signal:controller.signal,humanize:async()=>{controller.abort();return {content:'迟到的改稿'};}});
 const result=await runWritingWorkflow(f.options);assert.equal(result.stage,'cancelled');assert.equal(result.percent,50);assert.equal(f.saved.length,1);assert.ok(result.source);assert.equal(f.events.some(s=>s.percent===100),false);
});
test('failed saves and empty model results cannot advance or silently truncate long articles',async()=>{
 for(const options of [
  {save:async()=>null},
  {generate:async()=>({content:'  '})},
  {humanize:async()=>({content:''})},
  {generate:async()=>({content:'文'.repeat(20001)}),humanize:async()=>{assert.fail('must not send a truncated article');}},
  {save:async(result,kind)=>kind==='source'?{...result,id:'source'}:null,humanize:async()=>({content:'完整改稿'})}
 ]){const f=fixture(options);const r=await runWritingWorkflow(f.options);assert.equal(r.stage,'error');assert.ok(r.percent<100);}
});
test('switching off automation makes a single model call and preserves the original output',async()=>{
 const f=fixture({automatic:false,humanize:async()=>assert.fail('disabled stage ran')});const r=await runWritingWorkflow(f.options);assert.equal(r.stage,'complete');assert.equal(f.saved.length,1);assert.equal(r.final.content,'生成原稿');assert.equal(f.events.some(s=>s.stage==='humanizing'),false);
});
