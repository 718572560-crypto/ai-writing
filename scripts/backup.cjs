'use strict';
const fs=require('node:fs');
const path=require('node:path');
const {DatabaseSync}=require('node:sqlite');
const dbFile=process.env.ACCOUNT_DB_PATH||path.join(__dirname,'..','data','youshu.sqlite');
if(!fs.existsSync(dbFile)){console.error('账号数据库不存在。');process.exit(1);}
const directory=path.join(path.dirname(dbFile),'backups');fs.mkdirSync(directory,{recursive:true});
const stamp=new Date().toISOString().replace(/[:.]/g,'-');const destination=path.join(directory,`youshu-${stamp}.sqlite`);
const db=new DatabaseSync(dbFile);try{db.exec(`VACUUM INTO '${destination.replace(/'/g,"''")}'`);}finally{db.close();}
const backups=fs.readdirSync(directory).filter(name=>/^youshu-.*\.sqlite$/.test(name)).map(name=>({name,file:path.join(directory,name),mtime:fs.statSync(path.join(directory,name)).mtimeMs})).sort((a,b)=>b.mtime-a.mtime);
for(const old of backups.slice(14))fs.unlinkSync(old.file);
console.log(destination);
