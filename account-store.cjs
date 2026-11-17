'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, scrypt, timingSafeEqual } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const { promisify } = require('node:util');
const scryptAsync = promisify(scrypt);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const emailKey = value => String(value || '').trim().toLowerCase();

function createAccountStore(file = path.join(__dirname, 'data', 'youshu.sqlite')) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','suspended')),
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      csrf_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
    CREATE TABLE IF NOT EXISTS wechat_identities (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      open_id TEXT NOT NULL UNIQUE, union_id TEXT UNIQUE, nickname TEXT NOT NULL DEFAULT '',
      linked_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS wechat_oauth_states (
      state_hash TEXT PRIMARY KEY, action TEXT NOT NULL CHECK(action IN ('login','bind')),
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE, session_hash TEXT,
      expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS wechat_oauth_expiry_idx ON wechat_oauth_states(expires_at);
    CREATE TABLE IF NOT EXISTS memberships (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL DEFAULT 'free', expires_at INTEGER, credits INTEGER NOT NULL DEFAULT 0, purchased_credits INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usage_events (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      action TEXT NOT NULL, credits INTEGER NOT NULL DEFAULT 1, credit_charge INTEGER NOT NULL DEFAULT 0, model TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_month_idx ON usage_events(user_id, created_at);
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      plan TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','paid','refunded','cancelled')),
      provider TEXT NOT NULL DEFAULT 'unconfigured', provider_ref TEXT,
      plan_name TEXT NOT NULL DEFAULT '', entitlement_days INTEGER NOT NULL DEFAULT 30,
      entitlement_credits INTEGER NOT NULL DEFAULT 300, package_kind TEXT NOT NULL DEFAULT 'membership', code_url TEXT,
      transaction_id TEXT, paid_at INTEGER, currency TEXT NOT NULL DEFAULT 'CNY',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_ref_idx ON orders(provider,provider_ref) WHERE provider_ref IS NOT NULL;
    CREATE TABLE IF NOT EXISTS payment_notifications (
      id TEXT PRIMARY KEY, transaction_id TEXT NOT NULL UNIQUE,
      order_id TEXT NOT NULL REFERENCES orders(id), received_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS membership_plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, entitlement_days INTEGER NOT NULL,
      entitlement_credits INTEGER NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      package_kind TEXT NOT NULL DEFAULT 'membership' CHECK(package_kind IN ('membership','credits')),
      featured INTEGER NOT NULL DEFAULT 0 CHECK(featured IN (0,1)), sort_order INTEGER NOT NULL DEFAULT 0,
      currency TEXT NOT NULL DEFAULT 'CNY', enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS redeem_codes (
      code_hash TEXT PRIMARY KEY, code_hint TEXT NOT NULL, package_kind TEXT NOT NULL CHECK(package_kind IN ('membership','credits')),
      entitlement_days INTEGER NOT NULL, entitlement_credits INTEGER NOT NULL,
      max_redemptions INTEGER NOT NULL DEFAULT 1, redemption_count INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS code_redemptions (
      code_hash TEXT NOT NULL REFERENCES redeem_codes(code_hash), user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      redeemed_at INTEGER NOT NULL, PRIMARY KEY(code_hash,user_id)
    );
    CREATE TABLE IF NOT EXISTS audit_log (
      id TEXT PRIMARY KEY, actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      target_id TEXT REFERENCES users(id) ON DELETE SET NULL, action TEXT NOT NULL,
      details TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_data (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      payload TEXT NOT NULL DEFAULT '{}', updated_at INTEGER NOT NULL
    );`);
  // Keep preview databases created by earlier versions forward-compatible.
  for (const sql of [
    "ALTER TABLE orders ADD COLUMN plan_name TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN entitlement_days INTEGER NOT NULL DEFAULT 30",
    "ALTER TABLE orders ADD COLUMN entitlement_credits INTEGER NOT NULL DEFAULT 300",
    "ALTER TABLE orders ADD COLUMN package_kind TEXT NOT NULL DEFAULT 'membership'",
    "ALTER TABLE orders ADD COLUMN code_url TEXT",
    "ALTER TABLE orders ADD COLUMN transaction_id TEXT",
    "ALTER TABLE orders ADD COLUMN paid_at INTEGER",
    "ALTER TABLE orders ADD COLUMN currency TEXT NOT NULL DEFAULT 'CNY'"
  ]) { try { db.exec(sql); } catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; } }
  for (const sql of [
    "ALTER TABLE memberships ADD COLUMN purchased_credits INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE membership_plans ADD COLUMN package_kind TEXT NOT NULL DEFAULT 'membership'",
    "ALTER TABLE membership_plans ADD COLUMN featured INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE membership_plans ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE usage_events ADD COLUMN credit_charge INTEGER NOT NULL DEFAULT 0"
  ]) { try { db.exec(sql); } catch (error) { if (!String(error.message).includes('duplicate column name')) throw error; } }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS orders_provider_ref_idx ON orders(provider,provider_ref) WHERE provider_ref IS NOT NULL;");

  const q = (sql, values=[]) => db.prepare(sql).all(...values);
  const one = (sql, values=[]) => db.prepare(sql).get(...values);
  const run = (sql, values=[]) => db.prepare(sql).run(...values);
  function transaction(work){db.exec('BEGIN IMMEDIATE');try{const value=work();db.exec('COMMIT');return value;}catch(error){db.exec('ROLLBACK');throw error;}}
  function publicUser(row) {
    if (!row) return null;
    const membership=one('SELECT plan,expires_at,credits,purchased_credits FROM memberships WHERE user_id=?',[row.id]);
    const until=membership?.expires_at;
    const active=membership?.plan==='member' && (!until || until>Date.now());
    const identity=one('SELECT nickname FROM wechat_identities WHERE user_id=?',[row.id]);
    return {id:row.id,email:identity?'微信用户':row.email,displayName:identity?.nickname|| (identity?'微信用户':''),role:row.role,status:row.status,createdAt:row.created_at,plan:row.role==='admin'?'admin':active?'member':'free',membershipExpiresAt:row.role==='admin'?null:active?until:null,credits:row.role==='admin'?null:(active?(membership?.credits||0):0)+(membership?.purchased_credits||0),memberCredits:row.role==='admin'?null:active?membership?.credits||0:0,packageCredits:row.role==='admin'?null:membership?.purchased_credits||0,wechatLinked:!!identity};
  }
  async function passwordHash(password, minimum=12) {
    if(typeof password!=='string'||password.length<minimum||password.length>128)throw Object.assign(new Error(`密码需为 ${minimum} 至 128 个字符。`),{status:400});
    const salt=randomBytes(16), derived=await scryptAsync(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});
    return salt.toString('hex')+':'+Buffer.from(derived).toString('hex');
  }
  async function verifyPassword(password, encoded) {
    const [saltHex,hashHex]=String(encoded||'').split(':');
    if(!/^[a-f\d]{32}$/i.test(saltHex||'')||!/^[a-f\d]{128}$/i.test(hashHex||''))return false;
    const actual=Buffer.from(await scryptAsync(String(password||''),Buffer.from(saltHex,'hex'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024}));
    const expected=Buffer.from(hashHex,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);
  }
  function audit(actor,target,action,details={}) { run('INSERT INTO audit_log(id,actor_id,target_id,action,details,created_at) VALUES(?,?,?,?,?,?)',[randomBytes(16).toString('hex'),actor||null,target||null,action,JSON.stringify(details),Date.now()]); }
  async function bootstrapAdmin(email,password) {
    if(!email&&!password)return false;
    if(!email||!password)throw new Error('ADMIN_EMAIL 与 ADMIN_PASSWORD 必须同时配置。');
    const key=emailKey(email);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key)&&!/^[a-z][a-z0-9_-]{2,31}$/.test(key))throw new Error('管理员账号需为邮箱或 3 至 32 位字母、数字、下划线。');
    const existing=one('SELECT id FROM users WHERE email=?',[key]);
    if(existing){run("UPDATE users SET role='admin',status='active',updated_at=? WHERE id=?",[Date.now(),existing.id]);return false;}
    const id=randomBytes(16).toString('hex'),now=Date.now(),hash=await passwordHash(password,8);
    transaction(()=>{run('INSERT INTO users(id,email,password_hash,role,created_at,updated_at) VALUES(?,?,?,\'admin\',?,?)',[id,key,hash,now,now]);run('INSERT INTO memberships(user_id,plan,expires_at,credits,updated_at) VALUES(?,\'member\',NULL,0,?)',[id,now]);audit(null,id,'admin.bootstrap');});return true;
  }
  function createSession(userId,csrf,days=14) {
    const token=randomBytes(32).toString('base64url'),now=Date.now(),expires=now+days*86400000;
    run('DELETE FROM sessions WHERE expires_at<=?',[now]);
    run('INSERT INTO sessions(token_hash,user_id,csrf_hash,expires_at,created_at) VALUES(?,?,?,?,?)',[sha256(token),userId,sha256(csrf),expires,now]);
    return {token,expiresAt:expires};
  }
  function session(token) {
    if(typeof token!=='string'||token.length<32)return null;
    const row=one('SELECT users.id,users.email,users.role,users.status,users.created_at,sessions.csrf_hash,sessions.expires_at FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token_hash=?',[sha256(token)]);
    if(!row||row.status!=='active'||row.expires_at<=Date.now()){if(row)run('DELETE FROM sessions WHERE token_hash=?',[sha256(token)]);return null;}
    return {...publicUser(row),csrfHash:row.csrf_hash};
  }
  function verifyCsrf(user,token){if(!user||typeof token!=='string')return false;const actual=Buffer.from(sha256(token),'hex'),expected=Buffer.from(user.csrfHash,'hex');return actual.length===expected.length&&timingSafeEqual(actual,expected);}
  function removeSession(token){if(token)run('DELETE FROM sessions WHERE token_hash=?',[sha256(token)]);}
  function beginWechatAuthorization({stateHash,action='login',userId=null,sessionToken=null,ttlMs=600000}){
    if(!/^[a-f\d]{64}$/i.test(stateHash)||!['login','bind'].includes(action))throw Object.assign(new Error('微信授权状态无效。'),{status:400});
    if(action==='bind'&&(!userId||!sessionToken))throw Object.assign(new Error('请先登录后再绑定微信。'),{status:401});
    const now=Date.now();return transaction(()=>{run('DELETE FROM wechat_oauth_states WHERE expires_at<=?',[now]);run('INSERT INTO wechat_oauth_states(state_hash,action,user_id,session_hash,expires_at,created_at) VALUES(?,?,?,?,?,?)',[stateHash,action==='bind'?'bind':'login',userId,sessionToken?sha256(sessionToken):null,now+ttlMs,now]);});
  }
  function consumeWechatAuthorization(stateHash){return transaction(()=>{const row=one('SELECT action,user_id,session_hash,expires_at FROM wechat_oauth_states WHERE state_hash=?',[stateHash]);run('DELETE FROM wechat_oauth_states WHERE state_hash=?',[stateHash]);return !row||row.expires_at<=Date.now()?null:{action:row.action,userId:row.user_id,sessionHash:row.session_hash};});}
  function completeWechatLogin({openId,unionId=null,nickname='',allowRegistration=false}){
    if(typeof openId!=='string'||openId.length<1||openId.length>128)throw Object.assign(new Error('微信未返回有效的用户标识。'),{status:400});
    const safeNickname=String(nickname||'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,80).trim();
    return transaction(()=>{
      let identity=one('SELECT user_id FROM wechat_identities WHERE open_id=?',[openId]);
      if(!identity&&unionId)identity=one('SELECT user_id FROM wechat_identities WHERE union_id=?',[unionId]);
      if(identity){run('UPDATE wechat_identities SET nickname=?,union_id=COALESCE(union_id,?) WHERE user_id=?',[safeNickname,unionId,identity.user_id]);const user=one('SELECT * FROM users WHERE id=?',[identity.user_id]);if(!user||user.status!=='active')throw Object.assign(new Error('账号当前不可用，请联系管理员。'),{status:403});return publicUser(user);}
      if(!allowRegistration)throw Object.assign(new Error('目前未开放新账号注册，请联系管理员。'),{status:403});
      const id=randomBytes(16).toString('hex'),now=Date.now(),email='wechat-'+sha256(openId).slice(0,40)+'@wechat.local.invalid',encoded=randomBytes(16).toString('hex')+':'+randomBytes(64).toString('hex');
      run('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)',[id,email,encoded,now,now]);run('INSERT INTO memberships(user_id,updated_at) VALUES(?,?)',[id,now]);run('INSERT INTO wechat_identities(user_id,open_id,union_id,nickname,linked_at) VALUES(?,?,?,?,?)',[id,openId,unionId,safeNickname,now]);audit(null,id,'wechat.login');return publicUser(one('SELECT * FROM users WHERE id=?',[id]));
    });
  }
  function bindWechatIdentity({userId,sessionToken,openId,unionId=null,nickname=''}){
    const safeNickname=String(nickname||'').replace(/[\u0000-\u001f\u007f]/g,'').slice(0,80).trim();
    return transaction(()=>{
      const sessionRow=one('SELECT user_id FROM sessions WHERE token_hash=? AND expires_at>?',[sha256(sessionToken),Date.now()]);if(!sessionRow||sessionRow.user_id!==userId)throw Object.assign(new Error('登录状态已变化，请重新登录后绑定微信。'),{status:401});
      const byOpen=one('SELECT user_id FROM wechat_identities WHERE open_id=?',[openId]),byUnion=unionId?one('SELECT user_id FROM wechat_identities WHERE union_id=?',[unionId]):null,existing=byOpen||byUnion;if(existing&&existing.user_id!==userId)throw Object.assign(new Error('此微信账号已绑定到另一账号。'),{status:409});
      const user=one('SELECT id,status FROM users WHERE id=?',[userId]);if(!user||user.status!=='active')throw Object.assign(new Error('账号当前不可用。'),{status:403});
      const already=one('SELECT open_id FROM wechat_identities WHERE user_id=?',[userId]);if(already&&already.open_id!==openId)throw Object.assign(new Error('当前账号已经绑定了另一个微信账号。'),{status:409});
      run('INSERT INTO wechat_identities(user_id,open_id,union_id,nickname,linked_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET open_id=excluded.open_id,union_id=excluded.union_id,nickname=excluded.nickname',[userId,openId,unionId,safeNickname,Date.now()]);audit(userId,userId,'wechat.bind');return publicUser(one('SELECT * FROM users WHERE id=?',[userId]));
    });
  }
  function usage(userId,now=Date.now()) {
    const month=new Date(now);month.setUTCDate(1);month.setUTCHours(0,0,0,0);
    return Number(one('SELECT COUNT(*) AS count FROM usage_events WHERE user_id=? AND created_at>=?',[userId,month.getTime()])?.count||0);
  }
  function access(userId,freeMonthly=10,memberMonthly=300) {
    const who=one('SELECT id,status,role FROM users WHERE id=?',[userId]);if(!who||who.status!=='active')return {allowed:false,reason:'账号不可用。'};
    if(who.role==='admin')return {allowed:true,used:usage(userId),limit:null,plan:'admin',credits:null};
    const member=one('SELECT plan,expires_at,credits,purchased_credits FROM memberships WHERE user_id=?',[userId]);
    const paid=member?.plan==='member'&&(!member.expires_at||member.expires_at>Date.now()),used=usage(userId),credits=member?.credits||0,packageCredits=member?.purchased_credits||0;
    if(paid&&used<memberMonthly&&credits>0)return {allowed:true,used,limit:memberMonthly,plan:'member',credits:credits+packageCredits,memberCredits:credits,packageCredits};
    if(packageCredits>0)return {allowed:true,used,limit:null,plan:'credits',credits:credits+packageCredits,memberCredits:credits,packageCredits};
    if(paid)return {allowed:false,reason:used>=memberMonthly?'本月会员调用次数已用完。':'会员额度已用完。',used,limit:memberMonthly,plan:'member',credits,memberCredits:credits,packageCredits:0};
    if(used>=freeMonthly)return {allowed:false,reason:'本月免费调用次数已用完。',used,limit:freeMonthly,plan:'free'};
    return {allowed:true,used,limit:freeMonthly,plan:'free'};
  }
  function recordUsage(userId,action,model='',freeMonthly=10,memberMonthly=300) {
    const m=one('SELECT plan,expires_at,credits,purchased_credits FROM memberships WHERE user_id=?',[userId]),paid=m?.plan==='member'&&(!m.expires_at||m.expires_at>Date.now()),used=usage(userId);
    const source=paid&&used<memberMonthly&&m.credits>0?1:(m?.purchased_credits>0?2:0);
    if(source===1)run('UPDATE memberships SET credits=MAX(0,credits-1),updated_at=? WHERE user_id=?',[Date.now(),userId]);
    if(source===2)run('UPDATE memberships SET purchased_credits=MAX(0,purchased_credits-1),updated_at=? WHERE user_id=?',[Date.now(),userId]);
    run('INSERT INTO usage_events(id,user_id,action,credits,credit_charge,model,created_at) VALUES(?,?,?,1,?,?,?)',[randomBytes(16).toString('hex'),userId,String(action).slice(0,40),source,String(model).slice(0,150),Date.now()]);
  }
  function reserveUsage(userId,action,model='',freeMonthly=10,memberMonthly=300) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const allowance=access(userId,freeMonthly,memberMonthly);
      if(!allowance.allowed){db.exec('ROLLBACK');return allowance;}
      const id=randomBytes(16).toString('hex'),now=Date.now();
      const account=one('SELECT role FROM users WHERE id=?',[userId]),membership=one('SELECT plan,expires_at,credits,purchased_credits FROM memberships WHERE user_id=?',[userId]);
      const paid=membership?.plan==='member'&&(!membership.expires_at||membership.expires_at>now),source=account?.role==='admin'?0:(paid&&allowance.used<memberMonthly&&membership.credits>0?1:(membership?.purchased_credits>0?2:0));
      if(source===1)run('UPDATE memberships SET credits=credits-1,updated_at=? WHERE user_id=? AND credits>0',[now,userId]);
      if(source===2)run('UPDATE memberships SET purchased_credits=purchased_credits-1,updated_at=? WHERE user_id=? AND purchased_credits>0',[now,userId]);
      run('INSERT INTO usage_events(id,user_id,action,credits,credit_charge,model,created_at) VALUES(?,?,?,1,?,?,?)',[id,userId,String(action).slice(0,40),source,String(model).slice(0,150),now]);
      db.exec('COMMIT');return {allowed:true,id,used:allowance.used+1,limit:allowance.limit,plan:allowance.plan};
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  function finalizeUsage(id,model=''){run('UPDATE usage_events SET model=? WHERE id=?',[String(model).slice(0,150),id]);}
  function refundUsage(id){const event=one('SELECT user_id,credit_charge FROM usage_events WHERE id=?',[id]);if(!event)return;if(event.credit_charge===1)run('UPDATE memberships SET credits=credits+1,updated_at=? WHERE user_id=?',[Date.now(),event.user_id]);if(event.credit_charge===2)run('UPDATE memberships SET purchased_credits=purchased_credits+1,updated_at=? WHERE user_id=?',[Date.now(),event.user_id]);run('DELETE FROM usage_events WHERE id=?',[id]);}
  function getAccountData(userId){const row=one('SELECT payload,updated_at FROM account_data WHERE user_id=?',[userId]);return row?{data:JSON.parse(row.payload),updatedAt:row.updated_at}:{data:null,updatedAt:null};}
  function saveAccountData(userId,data,expectedUpdatedAt=null){if(!data||typeof data!=='object'||Array.isArray(data))throw Object.assign(new Error('作品数据格式不正确。'),{status:400});const payload=JSON.stringify(data);if(Buffer.byteLength(payload)>3*1024*1024)throw Object.assign(new Error('作品数据超过 3 MB，请先导出备份。'),{status:413});return transaction(()=>{const current=one('SELECT updated_at FROM account_data WHERE user_id=?',[userId]),currentVersion=current?.updated_at??null;if(currentVersion!==expectedUpdatedAt)throw Object.assign(new Error('云端作品已在另一处更新，当前内容尚未覆盖。请刷新页面后检查最新稿件。'),{status:409});const updatedAt=Math.max(Date.now(),(currentVersion||0)+1);run('INSERT INTO account_data(user_id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,updated_at=excluded.updated_at',[userId,payload,updatedAt]);return {updatedAt};});}
  function users(search='',limit=100){const term='%'+String(search).trim().slice(0,120)+'%';return q('SELECT users.*,memberships.plan,memberships.expires_at,memberships.credits,(SELECT COUNT(*) FROM usage_events WHERE usage_events.user_id=users.id AND usage_events.created_at>=?) AS month_usage FROM users LEFT JOIN memberships ON memberships.user_id=users.id WHERE users.email LIKE ? OR EXISTS(SELECT 1 FROM wechat_identities WHERE wechat_identities.user_id=users.id AND wechat_identities.nickname LIKE ?) ORDER BY users.created_at DESC LIMIT ?',[(()=>{const d=new Date();d.setUTCDate(1);d.setUTCHours(0,0,0,0);return d.getTime()})(),term,term,Math.max(1,Math.min(200,limit))]).map(row=>({...publicUser(row),monthUsage:row.month_usage}));}
  function grant(actor,target,{days=30,credits=300,plan='member'}={}){
    if(!Number.isInteger(days)||days<1||days>3650||!Number.isInteger(credits)||credits<1||credits>100000||!['member','free'].includes(plan))throw Object.assign(new Error('会员期限或额度参数无效。'),{status:400});
    return transaction(()=>{const current=one('SELECT plan,expires_at,credits FROM memberships WHERE user_id=?',[target]);if(!one('SELECT id FROM users WHERE id=?',[target]))throw Object.assign(new Error('用户不存在。'),{status:404});const now=Date.now(),base=current?.plan==='member'&&current.expires_at>now?current.expires_at:now,expires=plan==='member'?base+days*86400000:null;run('INSERT INTO memberships(user_id,plan,expires_at,credits,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(user_id) DO UPDATE SET plan=excluded.plan,expires_at=excluded.expires_at,credits=memberships.credits+excluded.credits,updated_at=excluded.updated_at',[target,plan,expires,credits,now]);audit(actor,target,'membership.grant',{days,credits,plan});return publicUser(one('SELECT * FROM users WHERE id=?',[target]));});
  }
  function setStatus(actor,target,status){if(!['active','suspended'].includes(status))throw Object.assign(new Error('用户状态无效。'),{status:400});return transaction(()=>{if(!one('SELECT id FROM users WHERE id=?',[target]))throw Object.assign(new Error('用户不存在。'),{status:404});run('UPDATE users SET status=?,updated_at=? WHERE id=?',[status,Date.now(),target]);if(status==='suspended')run('DELETE FROM sessions WHERE user_id=?',[target]);audit(actor,target,'user.status',{status});return publicUser(one('SELECT * FROM users WHERE id=?',[target]));});}
  function createOrder(userId,{plan,name,days,credits,amountCents,currency='CNY',kind='membership'}){
    if(!/^[a-z\d][a-z\d_-]{1,39}$/i.test(plan)||typeof name!=='string'||name.length>80||!['membership','credits'].includes(kind)||!Number.isInteger(days)||days<(kind==='membership'?0:0)||days>(kind==='membership'?3650:0)||!Number.isInteger(credits)||credits<1||credits>100000||!Number.isInteger(amountCents)||amountCents<1||amountCents>100000000||currency!=='CNY')throw Object.assign(new Error('购买套餐配置无效。'),{status:400});
    return transaction(()=>{const user=one('SELECT id,status FROM users WHERE id=?',[userId]);if(!user||user.status!=='active')throw Object.assign(new Error('账号当前不可用。'),{status:403});const now=Date.now();run("UPDATE orders SET status='cancelled',code_url=NULL,updated_at=? WHERE user_id=? AND provider='wechatpay' AND status='pending' AND created_at<=?",[now,userId,now-900000]);const pending=Number(one("SELECT COUNT(*) AS n FROM orders WHERE user_id=? AND provider='wechatpay' AND status='pending' AND created_at>?",[userId,now-900000])?.n||0);if(pending>=5)throw Object.assign(new Error('待支付订单过多，请先完成或等待旧订单过期。'),{status:429});const id=randomBytes(16).toString('hex'),providerRef=randomBytes(16).toString('hex').toUpperCase();run('INSERT INTO orders(id,user_id,plan,amount_cents,status,provider,provider_ref,plan_name,entitlement_days,entitlement_credits,package_kind,currency,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)',[id,userId,plan,amountCents,'pending','wechatpay',providerRef,name,days,credits,kind,currency,now,now]);return {id,providerRef};});
  }
  function setMembershipPlan(actor,{id,name,days,credits,amountCents,kind='membership',featured=false,sortOrder=0}){
    if(typeof id!=='string'||!/^[a-z\d][a-z\d_-]{1,39}$/i.test(id)||typeof name!=='string'||!name.trim()||name.trim().length>80||!['membership','credits'].includes(kind)||!Number.isInteger(days)||days<(kind==='membership'?0:0)||days>(kind==='membership'?3650:0)||!Number.isInteger(credits)||credits<1||credits>100000||!Number.isInteger(amountCents)||amountCents<1||amountCents>100000000)throw Object.assign(new Error('套餐标识、类型、期限、额度或售价无效。'),{status:400});
    if(typeof featured!=='boolean'||!Number.isInteger(sortOrder)||sortOrder<0||sortOrder>100000)throw Object.assign(new Error('套餐展示设置无效。'),{status:400});
    return transaction(()=>{const now=Date.now(),normalized=name.trim();run(`INSERT INTO membership_plans(id,name,entitlement_days,entitlement_credits,amount_cents,package_kind,featured,sort_order,currency,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,'CNY',1,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,entitlement_days=excluded.entitlement_days,entitlement_credits=excluded.entitlement_credits,amount_cents=excluded.amount_cents,package_kind=excluded.package_kind,featured=excluded.featured,sort_order=excluded.sort_order,currency=excluded.currency,enabled=1,updated_at=excluded.updated_at`,[id,normalized,days,credits,amountCents,kind,featured?1:0,sortOrder,now]);audit(actor,null,'membership.plan.update',{id,name:normalized,days,credits,amountCents,kind,featured:!!featured,sortOrder,currency:'CNY'});return membershipPlan(id);});
  }
  function membershipPlan(id){const p=one('SELECT id,name,entitlement_days,entitlement_credits,amount_cents,package_kind,featured,sort_order,currency,enabled,updated_at FROM membership_plans WHERE id=?',[id]);return p?{id:p.id,name:p.name,days:p.entitlement_days,credits:p.entitlement_credits,amountCents:p.amount_cents,kind:p.package_kind,featured:!!p.featured,sortOrder:p.sort_order,currency:p.currency,enabled:!!p.enabled,updatedAt:p.updated_at}:null;}
  function membershipPlans(){return q('SELECT id,name,entitlement_days,entitlement_credits,amount_cents,package_kind,featured,sort_order,currency,enabled,updated_at FROM membership_plans ORDER BY package_kind ASC,sort_order ASC,amount_cents ASC,id ASC').map(p=>({id:p.id,name:p.name,days:p.entitlement_days,credits:p.entitlement_credits,amountCents:p.amount_cents,kind:p.package_kind,featured:!!p.featured,sortOrder:p.sort_order,currency:p.currency,enabled:!!p.enabled,updatedAt:p.updated_at}));}
  function deleteMembershipPlan(actor,id){return transaction(()=>{if(!/^[a-z\d][a-z\d_-]{1,39}$/i.test(id)||!membershipPlan(id))throw Object.assign(new Error('会员套餐不存在。'),{status:404});run('UPDATE membership_plans SET enabled=0,updated_at=? WHERE id=?',[Date.now(),id]);audit(actor,null,'membership.plan.disable',{id});return membershipPlan(id);});}
  function normalizeCode(value){return String(value||'').trim().toUpperCase().replace(/[\s-]/g,'');}
  function createRedeemCode(actor,{code,kind='credits',days=0,credits,maxRedemptions=1}){
    const normalized=normalizeCode(code);if(!/^[A-Z0-9]{6,64}$/.test(normalized)||!['membership','credits'].includes(kind)||!Number.isInteger(days)||days<0||days>(kind==='membership'?3650:0)||!Number.isInteger(credits)||credits<1||credits>100000||!Number.isInteger(maxRedemptions)||maxRedemptions<1||maxRedemptions>100000)throw Object.assign(new Error('兑换码参数无效。'),{status:400});
    const hash=sha256(normalized),now=Date.now();return transaction(()=>{if(one('SELECT code_hash FROM redeem_codes WHERE code_hash=?',[hash]))throw Object.assign(new Error('兑换码已存在。'),{status:409});run('INSERT INTO redeem_codes(code_hash,code_hint,package_kind,entitlement_days,entitlement_credits,max_redemptions,created_by,created_at) VALUES(?,?,?,?,?,?,?,?)',[hash,normalized.slice(-4),kind,days,credits,maxRedemptions,actor,now]);audit(actor,null,'membership.redeem.create',{hint:normalized.slice(-4),kind,days,credits,maxRedemptions});return {hint:normalized.slice(-4),kind,days,credits,maxRedemptions};});
  }
  function redeemCode(userId,code){const normalized=normalizeCode(code);if(!/^[A-Z0-9]{6,64}$/.test(normalized))throw Object.assign(new Error('请输入有效兑换码。'),{status:400});const hash=sha256(normalized);return transaction(()=>{const item=one('SELECT * FROM redeem_codes WHERE code_hash=? AND enabled=1',[hash]);if(!item||item.redemption_count>=item.max_redemptions)throw Object.assign(new Error('兑换码不存在、已失效或已达使用次数。'),{status:400});if(one('SELECT code_hash FROM code_redemptions WHERE code_hash=? AND user_id=?',[hash,userId]))throw Object.assign(new Error('该兑换码已由当前账号使用。'),{status:409});const current=one('SELECT plan,expires_at,credits FROM memberships WHERE user_id=?',[userId]),now=Date.now();if(item.package_kind==='membership'){const active=current?.plan==='member'&&(!current.expires_at||current.expires_at>now),base=active?current.expires_at:now,expires=item.entitlement_days===0?null:base+item.entitlement_days*86400000;run("UPDATE memberships SET plan='member',expires_at=?,credits=credits+?,updated_at=? WHERE user_id=?",[expires,item.entitlement_credits,now,userId]);}else run('UPDATE memberships SET purchased_credits=purchased_credits+?,updated_at=? WHERE user_id=?',[item.entitlement_credits,now,userId]);run('UPDATE redeem_codes SET redemption_count=redemption_count+1 WHERE code_hash=?',[hash]);run('INSERT INTO code_redemptions(code_hash,user_id,redeemed_at) VALUES(?,?,?)',[hash,userId,now]);audit(null,userId,'membership.redeem',{hint:item.code_hint,kind:item.package_kind,credits:item.entitlement_credits,days:item.entitlement_days});return {kind:item.package_kind,days:item.entitlement_days,credits:item.entitlement_credits};});}
  function redeemCodes(limit=100){return q('SELECT code_hint,package_kind,entitlement_days,entitlement_credits,max_redemptions,redemption_count,enabled,created_at FROM redeem_codes ORDER BY created_at DESC LIMIT ?',[Math.min(200,Math.max(1,limit))]).map(x=>({hint:x.code_hint,kind:x.package_kind,days:x.entitlement_days,credits:x.entitlement_credits,maxRedemptions:x.max_redemptions,redemptions:x.redemption_count,enabled:!!x.enabled,createdAt:x.created_at}));}
  function setOrderCodeUrl(id,codeUrl){const order=one("SELECT id,status,created_at FROM orders WHERE id=? AND provider='wechatpay'",[id]);if(!order||order.status!=='pending'||order.created_at<Date.now()-900000)throw Object.assign(new Error('订单已过期，请重新下单。'),{status:409});run('UPDATE orders SET code_url=?,updated_at=? WHERE id=? AND status=\'pending\'',[String(codeUrl||'').slice(0,2000),Date.now(),id]);}
  function cancelOrder(id){run("UPDATE orders SET status='cancelled',code_url=NULL,updated_at=? WHERE id=? AND status='pending'",[Date.now(),id]);}
  function orderForUser(userId,id){const o=one("SELECT id,plan,plan_name,package_kind,amount_cents,currency,status,created_at,updated_at,paid_at FROM orders WHERE id=? AND user_id=? AND provider='wechatpay'",[id,userId]);return o?{id:o.id,plan:o.plan,name:o.plan_name,kind:o.package_kind,amountCents:o.amount_cents,currency:o.currency,status:o.status,createdAt:o.created_at,updatedAt:o.updated_at,paidAt:o.paid_at}:null;}
  function pendingOrderQr(userId,id){return one("SELECT code_url FROM orders WHERE id=? AND user_id=? AND provider='wechatpay' AND status='pending' AND code_url IS NOT NULL AND created_at>?",[id,userId,Date.now()-900000])?.code_url||null;}
  function accountOrders(userId,limit=20){return q("SELECT id,plan,plan_name,package_kind,entitlement_days,entitlement_credits,amount_cents,currency,status,created_at,updated_at,paid_at FROM orders WHERE user_id=? AND provider='wechatpay' ORDER BY created_at DESC LIMIT ?",[userId,Math.max(1,Math.min(50,limit))]).map(o=>({id:o.id,plan:o.plan,name:o.plan_name,kind:o.package_kind,days:o.entitlement_days,credits:o.entitlement_credits,amountCents:o.amount_cents,currency:o.currency,status:o.status,createdAt:o.created_at,updatedAt:o.updated_at,paidAt:o.paid_at}));}
  function fulfillWechatOrder({notificationId,transactionId,providerRef,amountCents,currency='CNY'}){
    if(typeof notificationId!=='string'||!/^[a-z\d_-]{1,128}$/i.test(notificationId)||typeof transactionId!=='string'||transactionId.length<1||transactionId.length>128)throw Object.assign(new Error('微信支付通知缺少有效交易标识。'),{status:400});
    return transaction(()=>{const seen=one('SELECT transaction_id,order_id FROM payment_notifications WHERE id=?',[notificationId]);const order=one("SELECT * FROM orders WHERE provider='wechatpay' AND provider_ref=?",[providerRef]);if(!order)throw Object.assign(new Error('微信支付通知对应的订单不存在。'),{status:404});if(order.amount_cents!==amountCents||order.currency!==currency)throw Object.assign(new Error('微信支付通知金额与订单不一致。'),{status:400});if(seen&&(seen.transaction_id!==transactionId||seen.order_id!==order.id))throw Object.assign(new Error('微信支付通知编号已关联其他交易。'),{status:409});if(order.status==='paid'){if(order.transaction_id!==transactionId)throw Object.assign(new Error('订单已关联不同的微信交易。'),{status:409});if(!seen)run('INSERT INTO payment_notifications(id,transaction_id,order_id,received_at) VALUES(?,?,?,?)',[notificationId,transactionId,order.id,Date.now()]);return {fulfilled:false,duplicate:true,orderId:order.id};}if(!['pending','cancelled'].includes(order.status))throw Object.assign(new Error('微信支付订单状态不允许入账。'),{status:409});if(seen)throw Object.assign(new Error('微信支付通知已被其他交易使用。'),{status:409});const now=Date.now(),current=one('SELECT plan,expires_at,credits FROM memberships WHERE user_id=?',[order.user_id]);let expires=current?.expires_at??null;if(order.package_kind==='membership'){const active=current?.plan==='member'&&(!current.expires_at||current.expires_at>now),base=active?current.expires_at:now;expires=order.entitlement_days===0?null:(active&&!current.expires_at?null:base+order.entitlement_days*86400000);run("UPDATE memberships SET plan='member',expires_at=?,credits=credits+?,updated_at=? WHERE user_id=?",[expires,order.entitlement_credits,now,order.user_id]);}else run('UPDATE memberships SET purchased_credits=purchased_credits+?,updated_at=? WHERE user_id=?',[order.entitlement_credits,now,order.user_id]);run("UPDATE orders SET status='paid',transaction_id=?,paid_at=?,code_url=NULL,updated_at=? WHERE id=?",[transactionId,now,now,order.id]);run('INSERT INTO payment_notifications(id,transaction_id,order_id,received_at) VALUES(?,?,?,?)',[notificationId,transactionId,order.id,now]);audit(null,order.user_id,'membership.payment',{orderId:order.id,plan:order.plan,kind:order.package_kind,amountCents:order.amount_cents,currency:order.currency});return {fulfilled:true,duplicate:false,orderId:order.id,userId:order.user_id,expiresAt:expires,credits:order.entitlement_credits,kind:order.package_kind};});
  }
  function dashboard(){return {users:Number(one('SELECT COUNT(*) AS n FROM users WHERE role=\'user\'')?.n||0),members:Number(one("SELECT COUNT(*) AS n FROM memberships JOIN users ON users.id=memberships.user_id WHERE users.role='user' AND memberships.plan='member' AND (memberships.expires_at IS NULL OR memberships.expires_at>?)",[Date.now()])?.n||0),callsToday:Number(one('SELECT COUNT(*) AS n FROM usage_events WHERE created_at>=?',[Date.now()-86400000])?.n||0),pendingOrders:Number(one("SELECT COUNT(*) AS n FROM orders WHERE status='pending'")?.n||0),orders:q('SELECT orders.id,orders.user_id,users.email,COALESCE(wechat_identities.nickname,\'\') AS nickname,orders.plan,orders.plan_name,orders.package_kind,orders.entitlement_days,orders.entitlement_credits,orders.amount_cents,orders.currency,orders.status,orders.provider,orders.provider_ref,orders.transaction_id,orders.created_at,orders.paid_at FROM orders JOIN users ON users.id=orders.user_id LEFT JOIN wechat_identities ON wechat_identities.user_id=users.id ORDER BY orders.created_at DESC LIMIT 100')};}
  function auditRows(limit=100){return q('SELECT audit_log.id,audit_log.actor_id,actor.email AS actor_email,audit_log.target_id,target.email AS target_email,audit_log.action,audit_log.details,audit_log.created_at FROM audit_log LEFT JOIN users actor ON actor.id=audit_log.actor_id LEFT JOIN users target ON target.id=audit_log.target_id ORDER BY audit_log.created_at DESC LIMIT ?',[Math.min(200,limit)]);}
  async function login(email,password){const row=one('SELECT * FROM users WHERE email=?',[emailKey(email)]);if(!row||row.status!=='active'||!await verifyPassword(password,row.password_hash))throw Object.assign(new Error('邮箱或密码不正确。'),{status:401});const csrf=randomBytes(32).toString('base64url'),s=createSession(row.id,csrf);return {user:publicUser(row),csrf,...s};}
  async function changePassword(userId,currentPassword,nextPassword){const row=one('SELECT password_hash FROM users WHERE id=? AND status=\'active\'',[userId]);if(!row||!await verifyPassword(currentPassword,row.password_hash))throw Object.assign(new Error('当前密码不正确。'),{status:401});const hash=await passwordHash(nextPassword);transaction(()=>{run('UPDATE users SET password_hash=?,updated_at=? WHERE id=?',[hash,Date.now(),userId]);run('DELETE FROM sessions WHERE user_id=?',[userId]);audit(userId,userId,'user.password.change');});return true;}
  async function createUser(email,password,actor=null){const key=emailKey(email);if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(key))throw Object.assign(new Error('请输入有效邮箱。'),{status:400});const id=randomBytes(16).toString('hex'),now=Date.now(),hash=await passwordHash(password);try{return transaction(()=>{run('INSERT INTO users(id,email,password_hash,created_at,updated_at) VALUES(?,?,?,?,?)',[id,key,hash,now,now]);run('INSERT INTO memberships(user_id,updated_at) VALUES(?,?)',[id,now]);audit(actor,id,'user.create');return publicUser(one('SELECT * FROM users WHERE id=?',[id]));});}catch(error){if(String(error.message).includes('UNIQUE'))throw Object.assign(new Error('该邮箱已注册。'),{status:409});throw error;}}
  return {db,bootstrapAdmin,login,changePassword,createUser,createSession,session,verifyCsrf,removeSession,beginWechatAuthorization,consumeWechatAuthorization,completeWechatLogin,bindWechatIdentity,access,recordUsage,reserveUsage,finalizeUsage,refundUsage,getAccountData,saveAccountData,users,grant,setStatus,setMembershipPlan,membershipPlan,membershipPlans,deleteMembershipPlan,createRedeemCode,redeemCode,redeemCodes,createOrder,setOrderCodeUrl,cancelOrder,orderForUser,pendingOrderQr,accountOrders,fulfillWechatOrder,dashboard,auditRows,audit,publicUser,close:()=>db.close()};
}
module.exports={createAccountStore};
