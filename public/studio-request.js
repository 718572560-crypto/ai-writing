'use strict';
// Replay only requests rejected before execution for an expired token.
function createStudioRequest({fetch:transport=fetch,getStatus,setStatus}) {
  let refreshing;
  async function refresh(signal) {
    if(!refreshing)refreshing=(async()=>{
      const r=await transport('/api/status',{signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw new Error('本地服务未连接，请稍后重试。');
      const state=await r.json();setStatus(state);return state;
    })().finally(()=>{refreshing=null;});
    const state=await refreshing;signal?.throwIfAborted();return state;
  }
  return async function studioRequest(path,options={}) {
    const signal=options.signal||AbortSignal.timeout(20000);
    if(!getStatus().token)await refresh(signal);
    for(let attempt=0;attempt<2;attempt++){
      const state=getStatus();
      const headers=new Headers(options.headers);
      headers.set('X-Studio-Token',state.token);
      if(state.csrf)headers.set('X-CSRF-Token',state.csrf);
      const response=await transport(path,{...options,headers,signal});
      if(attempt===0&&response.status===403){
        const failure=await response.clone().json().catch(()=>({}));
        if(['TOKEN_EXPIRED','CSRF_EXPIRED'].includes(failure.code)){
          await refresh(signal);continue;
        }
      }
      return response;
    }
  };
}
if(typeof module!=='undefined')module.exports={createStudioRequest};
