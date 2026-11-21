'use strict';

// Percentages describe completed workflow stages, never elapsed model time.
async function runWritingWorkflow({generate,humanize,save,source=null,automatic=false,signal,onState=()=>{}}) {
  let stage='generating',percent=0,final=null;
  function update(next,value,extra={}) {
    stage=next;percent=value;onState({stage,percent,automatic,source,final,...extra});
  }
  function check(){signal?.throwIfAborted();}
  function validate(result){if(typeof result?.content!=='string'||!result.content.trim())throw new Error('模型没有返回完整正文，请重试当前步骤。');return result;}
  try {
    check();
    if(!source){
      update('generating',0);
      const result=validate(await generate(signal));check();
      update('saving-source',automatic?45:90);
      source=await save(result,'source');
      if(!source)throw new Error('原稿保存失败，请导出正文后再继续。');
    }
    check();
    if(automatic){
      update('humanizing',50);
      if(source.content.length>20000)throw new Error('文章已保存，但超过去 AI 味工具的 20,000 字上限，请分段处理。');
      const result=validate(await humanize(source,signal));check();
      update('saving-final',90);
      final=await save(result,'final',source);
      if(!final)throw new Error('改稿保存失败，请立即导出正文。');
    }else final=source;
    update('complete',100);
    return {stage,percent,source,final};
  }catch(error){
    const failedStage=stage;
    update(signal?.aborted?'cancelled':'error',percent,{failedStage,error:signal?.aborted?'流程已停止。':error.name==='TimeoutError'?'当前步骤超时，请重试。':error.message||'当前步骤失败，请重试。'});
    return {stage,percent,source,final,error,failedStage};
  }
}

if(typeof module!=='undefined')module.exports={runWritingWorkflow};
