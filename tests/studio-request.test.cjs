const test=require('node:test');
const assert=require('node:assert/strict');
const {createStudioRequest}=require('../public/studio-request.js');

test('writing/chat requests recover stale tokens without replaying permission failures or ambiguous network errors',async()=>{
  for(const failure of [{status:403,code:'TOKEN_EXPIRED'},{status:403,code:'CSRF_EXPIRED'},{status:403,code:'FORBIDDEN'},{status:401},{status:502}]){
    let state={token:'old',csrf:'old-csrf'},posts=0,refreshes=0;
    const request=createStudioRequest({getStatus:()=>state,setStatus:s=>{state=s;},fetch:async(path,options)=>{
      if(path==='/api/status'){refreshes++;return Response.json({token:'new',csrf:'new-csrf'});}
      posts++;
      if(posts===1)return Response.json({code:failure.code},{status:failure.status});
      assert.equal(options.headers.get('X-Studio-Token'),'new');
      assert.equal(options.headers.get('X-CSRF-Token'),'new-csrf');return Response.json({content:'完整正文'});
    }});
    const response=await request('/api/generate',{method:'POST',body:'{}'});
    const recovered=['TOKEN_EXPIRED','CSRF_EXPIRED'].includes(failure.code);
    assert.equal(posts,recovered?2:1);assert.equal(refreshes,recovered?1:0);assert.equal(response.status,recovered?200:failure.status);
  }
  let calls=0;
  const request=createStudioRequest({getStatus:()=>({token:'valid'}),setStatus:()=>{},fetch:async()=>{calls++;throw new TypeError('network failed');}});
  await assert.rejects(request('/api/chat',{method:'POST'}),/network failed/);assert.equal(calls,1);
});

test('concurrent expired pages share a token refresh and a second denial stops recovery',async()=>{
  let state={token:'old'},refreshes=0,posts=0;
  const request=createStudioRequest({getStatus:()=>state,setStatus:s=>{state=s;},fetch:async path=>{
    if(path==='/api/status'){refreshes++;await new Promise(r=>setTimeout(r,20));return Response.json({token:'new'});}
    posts++;return Response.json({code:'TOKEN_EXPIRED'},{status:403});
  }});
  const results=await Promise.all([request('/api/chat'),request('/api/tool')]);
  assert.equal(refreshes,1);assert.equal(posts,4);assert.ok(results.every(r=>r.status===403));
});
