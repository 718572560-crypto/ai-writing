'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {createAccountStore}=require('../account-store.cjs');

test('accounts, sessions, membership limits, private data and admin audit are isolated',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-account-'));
 const store=createAccountStore(path.join(dir,'db.sqlite'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 assert.equal(await store.bootstrapAdmin('owner@example.test','a-long-admin-password'),true);
 const admin=await store.login('OWNER@example.test','a-long-admin-password');assert.equal(admin.user.role,'admin');assert.equal(store.verifyCsrf(store.session(admin.token),admin.csrf),true);
 await store.bootstrapAdmin('owner@example.test','rotated-admin-password');assert.equal((await store.login('owner@example.test','a-long-admin-password')).user.role,'admin');await assert.rejects(store.login('owner@example.test','rotated-admin-password'),/邮箱或密码/);
 const a=await store.createUser('writer-a@example.test','a-long-user-password');const b=await store.createUser('writer-b@example.test','another-long-password');
 assert.equal(store.access(admin.user.id,0,0).plan,'admin');assert.equal(store.dashboard().users,2);assert.equal(store.dashboard().members,0);
 const oldSession=await store.login('writer-b@example.test','another-long-password');await store.changePassword(b.id,'another-long-password','different-long-password');assert.equal(store.session(oldSession.token),null);await assert.rejects(store.login('writer-b@example.test','another-long-password'),/邮箱或密码/);assert.equal((await store.login('writer-b@example.test','different-long-password')).user.id,b.id);
 const revision=store.saveAccountData(a.id,{drafts:[{title:'only A'}]},null).updatedAt;assert.equal(store.getAccountData(b.id).data,null);assert.equal(store.getAccountData(a.id).data.drafts[0].title,'only A');store.saveAccountData(a.id,{drafts:[{title:'latest'}]},revision);assert.throws(()=>store.saveAccountData(a.id,{drafts:[{title:'stale'}]},revision),/另一处更新/);assert.equal(store.getAccountData(a.id).data.drafts[0].title,'latest');
 for(let i=0;i<2;i++)store.recordUsage(a.id,'humanize','test-model');assert.deepEqual(store.access(a.id,2,300),{allowed:false,reason:'本月免费调用次数已用完。',used:2,limit:2,plan:'free'});
 store.grant(admin.user.id,a.id,{days:30,credits:3});assert.equal(store.access(a.id,10,300).allowed,true);const failed=store.reserveUsage(a.id,'humanize','test-model',10,300);assert.equal(store.access(a.id,10,300).credits,2);store.refundUsage(failed.id);assert.equal(store.access(a.id,10,300).credits,3);const done=store.reserveUsage(a.id,'chat','test-model',10,300);store.finalizeUsage(done.id,'test-model');assert.equal(store.access(a.id,10,300).credits,2);
 const aSession=await store.login('writer-a@example.test','a-long-user-password');store.setStatus(admin.user.id,a.id,'suspended');assert.equal(store.access(a.id).allowed,false);assert.equal(store.session(aSession.token),null);assert.equal((await store.login('writer-b@example.test','different-long-password')).user.status,'active');
 assert.ok(store.auditRows().some(row=>row.action==='membership.grant'));
});

test('password length and unknown sessions are rejected',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-account-password-'));
 const store=createAccountStore(path.join(dir,'db.sqlite'));t.after(()=>{store.close();fs.rmSync(dir,{recursive:true,force:true});});
 await assert.rejects(store.createUser('bad@example.test','short'),/12 至 128/);
 assert.equal(store.session('x'.repeat(48)),null);
});
