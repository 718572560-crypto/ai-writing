'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {DatabaseSync}=require('node:sqlite');

test('online database backup produces a restorable SQLite snapshot',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'youshu-backup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const source=path.join(dir,'live.sqlite'),db=new DatabaseSync(source);db.exec('CREATE TABLE content(value TEXT); INSERT INTO content VALUES (\'saved row\')');db.close();
 const run=spawnSync(process.execPath,[path.join(__dirname,'..','scripts','backup.cjs')],{env:{...process.env,ACCOUNT_DB_PATH:source},encoding:'utf8'});assert.equal(run.status,0,run.stderr);
 const snapshot=run.stdout.trim();assert.equal(fs.existsSync(snapshot),true);const restored=new DatabaseSync(snapshot);assert.equal(restored.prepare('SELECT value FROM content').get().value,'saved row');restored.close();
});
