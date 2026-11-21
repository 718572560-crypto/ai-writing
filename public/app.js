'use strict';
const $ = (q, root = document) => root.querySelector(q);
const $$ = (q, root = document) => [...root.querySelectorAll(q)];
const esc = (s = '') => String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const iconPaths = {
  grid:'<rect x="3" y="3" width="7" height="7" rx="1.4"/><rect x="14" y="3" width="7" height="7" rx="1.4"/><rect x="3" y="14" width="7" height="7" rx="1.4"/><rect x="14" y="14" width="7" height="7" rx="1.4"/>',
  pen:'<path d="m15 4 5 5M4 20l5-1L21 7a2.1 2.1 0 0 0-4-4L5 15zM14 20h7"/>',
  book:'<path d="M12 5v15M3 4c4-1 6 0 9 2 3-2 5-3 9-2v15c-4-1-6 0-9 2-3-2-5-3-9-2z"/>',
  clock:'<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  bookmark:'<path d="M6 4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17l-6-4-6 4z"/>',
  settings:'<path d="m9 3-1 3-3 1-2 4 2 2v4l4 2 3-1 3 1 4-2v-4l2-2-2-4-3-1-1-3z"/><circle cx="12" cy="11" r="3"/>',
  search:'<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  help:'<circle cx="12" cy="12" r="9"/><path d="M9.5 8a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4M12 16h.01"/>',
  menu:'<path d="M4 6h16M4 12h16M4 18h16"/>',
  plus:'<path d="M12 5v14M5 12h14"/>',
  arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',
  spark:'<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5zM20 2v4M18 4h4"/>',
  layers:'<path d="m12 3 9 5-9 5-9-5zM3 12l9 5 9-5M3 16l9 5 9-5"/>',
  title:'<path d="M4 5h16M12 5v15M8 20h8M4 5v3M20 5v3"/>',
  feather:'<path d="M20 3C8 1 3 10 7 16c6 4 15-1 13-13ZM3 21 16 8M8 16l7-1"/>',
  calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18M8 14h2M14 14h2M8 17h2"/>',
  file:'<path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5M8 12h8M8 16h6"/>',
  copy:'<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/>',
  download:'<path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/>',
  trash:'<path d="M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7"/>',
  close:'<path d="m6 6 12 12M6 18 18 6"/>',
  check:'<path d="m5 12 4 4L19 6"/>',
  refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/>',
  upload:'<path d="M12 16V3m-5 5 5-5 5 5M4 16v5h16v-5"/>',
  leaf:'<path d="M20 3C7 2 3 8 5 15c7 6 16 1 15-12ZM3 21 15 9"/>'
};
function icon(name) { return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${iconPaths[name] || iconPaths.file}</svg>`; }
function hydrateIcons(root = document) { $$('[data-icon]', root).forEach(e => e.innerHTML = icon(e.dataset.icon)); }
let storageKey = 'youshu-studio-v1';
const writingLengths = [1000,2000,3000];
const freshWriter = () => ({ id:null, mode:'article', topic:'', reference:null, platform:'微信公众号', style:'自然叙述', length:'1000', content:'', title:'', origin:'本地编辑', model:'', autoHumanize:true });
let db = { drafts:[], favorites:[], writer:freshWriter() };
let storageOK = true;
try { const saved = JSON.parse(localStorage.getItem(storageKey) || 'null'); if (saved && Array.isArray(saved.drafts) && Array.isArray(saved.favorites)) db = { drafts:saved.drafts, favorites:saved.favorites, writer:{...freshWriter(), ...saved.writer} }; }
catch { storageOK = false; }
let writer = db.writer;
let route = '';
let homeCategory = '生活方式';
let category = '全部';
let filter = '';
let libraryTime = 'today', librarySort = 'hot', libraryArticles = [], libraryImports = [], libraryDomains = ['全部'], libraryUpdatedAt = '', libraryDailyUpdatedAt = '', librarySources = [], libraryStale = false, libraryLoading = false, libraryError = '', librarySearchTimer, libraryPageNumber=1, libraryHasMore=false;
let generating = false;
let workflowProgress=null,workflowController=null,workflowClock;
let linkTimer;
let linkRequestId = 0;
let linkController;
let activeLinkUrl='', activeLinkPromise=null, linkUndo='';
let linkState = { kind:'', message:'' };
let status = { configured:false, model:'本地构思助手', token:'', presets:[],csrf:'' };
const studioRequest=createStudioRequest({getStatus:()=>status,setStatus:value=>{status=value;}});
let availableModels = [];
let aiFormBusy = false;
function modelOptions() { return [...new Set([...(status.presets || []).map(m=>m.id), ...availableModels, ...(status.configured ? [status.model] : [])])]; }
function serviceState() { $('#service-state').innerHTML=`<i></i>${status.configured ? status.verified ? 'AI 最近调用成功' : 'AI 已配置 · 待测试' : '本地创作空间'}`;const adminNav=$('[data-admin-nav]');if(adminNav)adminNav.hidden=!(status.authenticated&&status.user?.role==='admin');const name=$('.profile strong'),detail=$('.profile small'),avatar=$('.avatar'),top=$('.top-avatar');if(status.authenticated&&status.user){if(name)name.textContent=status.user.displayName||status.user.email;if(detail)detail.textContent=status.user.role==='admin'?'管理员账号 · 不限调用额度':(status.user.plan==='member'?'会员':status.user.packageCredits>0?'次数包':'免费账号')+(Number.isFinite(status.user.credits)?' · 剩余 '+status.user.credits+' 次':'');const mark=status.user.role==='admin'?'管':status.user.plan==='member'?'会':status.user.packageCredits>0?'次':'创';if(avatar)avatar.textContent=mark;if(top)top.textContent=mark;} }
let toastTimer, autosaveTimer, cloudSyncTimer, cloudQueue=Promise.resolve(), cloudReady=false, cloudRevision=null;
const labels = { home:'创作首页', write:'AI 写作', library:'灵感文章库', history:'创作记录', favorites:'我的收藏', membership:'会员与次数' };
const modes = { article:'文章创作', outline:'大纲构思', titles:'标题灵感', polish:'文章润色', humanize:'去 AI 味' };
let articles = [
  {id:'slow',category:'生活方式',title:'把生活调慢一点，找回自己的节奏',desc:'从一杯认真冲泡的咖啡开始，重新发现日常里微小而确定的美好。',minutes:3,palette:0,body:'周末醒来，先别急着打开手机。给自己烧一壶水，打开窗，听一听楼下的声音。\n\n慢下来不是把事情都推后，而是主动为重要的事留出空间。走一段路时放下耳机，吃一顿饭时不再处理消息，睡前用几行字记录今天。\n\n可以从一个小练习开始：每天给自己二十分钟，不追求产出，只专注做一件喜欢的事。读书、照顾植物，或者发一会儿呆。\n\n节奏不必和别人一样。当我们知道自己的时间流向哪里，生活就多了一点可以握住的东西。'},
  {id:'city',category:'生活方式',title:'在熟悉的城市，重新做一次旅人',desc:'换一条回家的路，让日常的街道成为新的风景。',minutes:3,palette:1,body:'离开惯常的地铁出口，多走两个路口。那家门前放着木椅的小店，可能一直都在那里，只是我们从未停下来。\n\n不妨为自己安排半天的城市漫游。不列必去清单，只确定一个出发点。沿河走，穿过菜市场，在老街找一碗热汤。\n\n旅行的感受有时与距离无关。它来自重新观察的能力：光线怎样穿过树叶，店主如何招呼老客，一块旧招牌留下什么故事。\n\n把发现记下来，配上一张照片。我们不必离开生活，才看见生活。'},
  {id:'desk',category:'个人成长',title:'给自己一张安静的书桌',desc:'清理的不只是桌面，也是注意力。给思考留一点空白。',minutes:4,palette:2,body:'桌面上堆着的物品，常常也是尚未完成的决定。一本没看完的书、一张过期的便签、一根用不上的线，各自占据一点注意力。\n\n先把所有物品移开，只放回今天真正需要的东西。为文具留一个固定位置，把零散的想法收进同一本笔记。\n\n安静的书桌不意味着什么都没有。它可以有一株植物、一盏灯和一件喜欢的小物。重要的是，每样东西都让你更愿意坐下来。\n\n在整洁与温度之间，找到适合自己的程度。然后开始写下第一句话。'},
  {id:'ai',category:'科技观察',title:'工具越来越聪明，表达更需要自己',desc:'当 AI 成为日常助手，创作者应把注意力放在哪里？',minutes:5,palette:3,body:'当写一段文字变得容易，选择写什么反而成为更重要的问题。工具可以帮助整理材料、探索结构，但不能替代我们判断哪些经历值得被讲述。\n\n使用 AI 时，可以先写下自己的观点和观察，再让工具协助梳理。把它给出的判断当作待验证的线索，对数据、引用和事实逐一核实。\n\n最后一遍编辑，留给自己的声音。删除那些你不会说的话，补上具体的场景与真实的感受。\n\n效率提供的是更多余裕。如何使用这份余裕，仍是创作者自己的选择。'},
  {id:'reading',category:'文化阅读',title:'读完一本书之后，留下什么',desc:'阅读不必成为打卡。在一段文字中，与自己的经验相遇。',minutes:4,palette:4,body:'有时读完一本书，我们记不住完整的情节，却记住某个雨夜、一次沉默，或一句轻轻说出的话。它们之所以留下，是因为碰到了我们的经验。\n\n读书笔记不妨从三个问题开始：哪一段让我停下来？我为什么在意？这与现在的生活有什么关系？\n\n不必摘抄很多。用自己的话写几句，比复制一整页更能帮助理解。隔一段时间再看，那些笔记也是我们变化的记录。\n\n阅读的收获未必立刻显现。它有时只是在下次面对一个问题时，让我们多了一种看法。'},
  {id:'work',category:'个人成长',title:'不把忙碌，当作努力的唯一证明',desc:'重新安排优先级，把有限的精力交给真正重要的事情。',minutes:4,palette:5,body:'一天结束时，待办清单划掉了很多项，却想不起完成了什么重要的事。这种感受可能提醒我们：任务数量和工作的价值并不总是同步。\n\n每天开始前，选出一件今天最想推进的事。把它拆成可以在一小时内完成的一步，为这一小时关掉非必要通知。\n\n也给收尾留出时间。记录进度、整理文件、写下明天的第一步，可以减少重新开始的成本。\n\n休息不必等到所有事都完成。精力有边界，承认边界，才能更长久地投入。'}
];
const topics = {
  '生活方式':['周末留白计划：把时间还给自己','一人食，也可以好好吃一顿饭','在城市的角落，寻找一点松弛感'],
  '个人成长':['告别无效忙碌，从一件重要的事开始','建立自己的阅读笔记系统','不着急成为别人期待的样子'],
  '科技观察':['AI 时代，普通人的表达还有什么价值？','数字工具如何改变我们的注意力','从功能堆叠到真正好用的产品'],
  '文化阅读':['重读一本旧书，发现不一样的自己','一间独立书店里的城市温度','为什么我们还需要写信？']
};
function cloudSave(){if(!status.authRequired||!status.authenticated||!status.csrf||!cloudReady)return;clearTimeout(cloudSyncTimer);cloudSyncTimer=setTimeout(()=>{const data={...db,conversations:typeof cwStore==='undefined'?undefined:cwStore};cloudQueue=cloudQueue.then(async()=>{const response=await fetch('/api/account/data',{method:'PUT',headers:{'Content-Type':'application/json','X-CSRF-Token':status.csrf},body:JSON.stringify({data,expectedUpdatedAt:cloudRevision}),signal:AbortSignal.timeout(15000)}),result=await response.json();if(!response.ok){if(response.status===409)cloudReady=false;throw new Error(result.error||'云端保存失败。');}cloudRevision=result.updatedAt;}).catch(error=>toast(error.message||'云端保存失败，请检查网络后重试。'));},500);}
function persist() { db.writer = writer; try { localStorage.setItem(storageKey, JSON.stringify(db));cloudSave();return true; } catch { if (storageOK) toast('浏览器存储不可用或已满，请及时导出作品。'); storageOK = false; return false; } }
function toast(text) { $('#toast').textContent = text; $('#toast').classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('show'), 3300); }
function setLinkState(kind, message, retry = false) {
  linkState = { kind, message };
  const el = $('#reference-note');
  if (el) { el.className='reference-note '+kind; el.innerHTML = `${esc(message)}${retry ? ' <button class="text-btn" data-action="read-link">重新读取</button>' : ''}`; }
}
function articleUrlFromText(text) {
  if(String(text||'').startsWith('参考文章：')&&String(text).includes('\n\n原文链接：'))return '';
  const matches = String(text || '').match(/https?:\/\/[^\s\u3000"'<>，。！？、】]+/gi) || [];
  if (matches.length !== 1) return '';
  let urlText = matches[0].replace(/[.,;!?]+$/,'');
  for(const [open,close] of [['(',')'],['[',']'],['{','}'],['（','）']]){
    while(urlText.endsWith(close)&&urlText.split(close).length>urlText.split(open).length)urlText=urlText.slice(0,-1);
  }
  const extra = String(text).replace(matches[0], '').replace(/[\s\u3000，。！？、；：,.!?()（）【】]+/g,'');
  if (extra.length > 240) return '';
  try {
    const url = new URL(urlText);
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||url.href.length>4096)return '';
    url.hash='';return url.href;
  } catch { return ''; }
}
function scheduleLinkRead(immediate=false) {
  clearTimeout(linkTimer);
  const url=articleUrlFromText(writer.topic);
  if(writer.reference && writer.topic.trim()!==url && !immediate)return;
  if(url && url===activeLinkUrl && activeLinkPromise)return;
  if(linkController)linkController.abort();
  linkRequestId++;activeLinkUrl='';activeLinkPromise=null;
  if(!url){setLinkState('','');return;}
  setLinkState('loading','已识别文章链接，正在自动读取正文…');
  if(immediate)readReferenceLink(url);
  else linkTimer=setTimeout(()=>readReferenceLink(url),180);
}
function readReferenceLink(url=articleUrlFromText(writer.topic)||writer.reference?.url||writer.topic.match(/\n\n原文链接：(https?:\/\/\S+)\s*$/)?.[1]||'') {
  if(!url){setLinkState('fail','请粘贴一条完整的 HTTP / HTTPS 文章链接。',true);return Promise.resolve();}
  if(url===activeLinkUrl&&activeLinkPromise)return activeLinkPromise;
  clearTimeout(linkTimer);if(linkController)linkController.abort();
  const controller=new AbortController(),requestId=++linkRequestId;
  linkController=controller;activeLinkUrl=url;
  const started=performance.now(),inputTopic=writer.topic;
  setLinkState('loading','正在自动读取文章正文…');
  const slowTimer=setTimeout(()=>{if(requestId===linkRequestId)setLinkState('loading','文章页面响应较慢，正在用浏览器读取正文…');},3500);
  activeLinkPromise=(async()=>{
    try{
      if(!status.token){const res=await fetch('/api/status',{signal:controller.signal});if(!res.ok)throw new Error('本地服务连接失败，请刷新后重试。');status=await res.json();}
      if(requestId!==linkRequestId)return;
      let response,data;
      for(let attempt=0;attempt<2;attempt++){
        response=await fetch('/api/extract-link',{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':status.token,...(status.csrf?{'X-CSRF-Token':status.csrf}:{})},body:JSON.stringify({url}),signal:AbortSignal.any([controller.signal,AbortSignal.timeout(30000)])});
        data=await response.json();
        if(response.status!==403||attempt!==0)break;
        // Restarting the local server invalidates tokens held by already-open tabs.
        const refreshed=await fetch('/api/status',{signal:controller.signal});
        if(!refreshed.ok)throw new Error('本地服务连接失败，请重试。');
        status=await refreshed.json();
        if(requestId!==linkRequestId)return;
      }
      if(requestId!==linkRequestId)return;
      if(!response.ok)throw new Error(data.error||'文章读取失败。');
      if(writer.topic!==inputTopic)return;
      const content=data.content.slice(0,20000).trim();
      writer.topic=content;
      writer.reference={title:data.title,source:data.source,url:data.url};persist();
      const input=$('#topic');if(input){input.value=content;input.scrollTop=0;$('#topic-count').textContent=content.length+' / 20000';}
      const preview=$('[data-action="preview-reference"]');if(preview)preview.hidden=false;
      const elapsed=((performance.now()-started)/1000).toFixed(1);
      setLinkState('ok','已提取「'+data.title+'」'+(data.source?' · '+data.source:'')+' · '+wordCount(content).toLocaleString()+' 字 · '+(data.cached?'缓存命中':elapsed+' 秒')+(data.truncated||content.length<data.content.length?'（长文已截取）':'')+(data.partial?'。'+(data.notice||'仅提取公开可见部分。'):'。正文可直接编辑。'));
    }catch(error){if(requestId!==linkRequestId||controller.signal.aborted)return;const disconnected=error instanceof TypeError||/failed to fetch|networkerror|load failed/i.test(error.message||'');setLinkState('fail',disconnected?'本地服务连接中断。请在项目目录双击“启动网站.cmd”，保持启动窗口打开后刷新页面。':error.name==='TimeoutError'?'文章响应超时，请重试或粘贴正文。':error.message||'读取失败，请重新读取。',true);}
    finally{clearTimeout(slowTimer);if(requestId===linkRequestId){activeLinkUrl='';activeLinkPromise=null;linkController=null;}}
  })();
  return activeLinkPromise;
}
function clearTopicText(){
  linkUndo={topic:writer.topic,reference:writer.reference};cancelLinkRead();writer.topic='';writer.reference=null;persist();
  const input=$('#topic');if(input){input.value='';input.scrollTop=0;$('#topic-count').textContent='0 / 20000';input.focus();}
  const preview=$('[data-action="preview-reference"]');if(preview)preview.hidden=true;
  setLinkState('','输入已清空，可以直接粘贴下一条文章链接。');
  const note=$('#reference-note');if(note&&linkUndo.topic){const button=document.createElement('button');button.className='text-btn';button.dataset.action='undo-clear-topic';button.textContent='撤销清空';note.append(' ',button);}
}
function undoClearTopic(){if(!linkUndo?.topic)return;cancelLinkRead();writer.topic=linkUndo.topic;writer.reference=linkUndo.reference||null;linkUndo='';persist();const input=$('#topic');if(input){input.value=writer.topic;$('#topic-count').textContent=writer.topic.length+' / 20000';input.focus();}const preview=$('[data-action="preview-reference"]');if(preview)preview.hidden=!writer.reference&&!writer.topic.startsWith('参考文章：');setLinkState('','已恢复清空前的文本。');}
function uid() { return typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2); }
function wordCount(text) { return String(text || '').replace(/\s/g, '').length; }
function fmtDate(t) { return new Date(t).toLocaleDateString('zh-CN', {month:'2-digit', day:'2-digit'}); }
function updateCount() { $('#history-count').textContent = db.drafts.length; }
function go(page) { if (location.hash === '#' + page) render(); else location.hash = page; }
function cancelLinkRead() { clearTimeout(linkTimer); linkRequestId++; if (linkController) linkController.abort(); linkController = null; activeLinkUrl='';activeLinkPromise=null;linkState = {kind:'',message:''}; }
function newWork(mode = 'article', topic = '') { clearTimeout(autosaveTimer); cancelLinkRead(); if (writer.content.trim() && !saveDraft(false)) return toast('当前作品保存失败，请先导出备份。'); const model=writer.model,autoHumanize=writer.autoHumanize!==false; writer = {...freshWriter(), mode, topic, model,autoHumanize}; if(!generating)workflowProgress=null; persist(); go('write'); return true; }
function humanizeCurrent() {
  if (generating) return toast('请等待当前请求完成。');
  if (!writer.content.trim()) return toast('稿纸还是空白的，请先输入原文。');
  if (writer.content.length > 20000) return toast('当前稿纸超过 20,000 字，请分段粘贴到去 AI 味模式。');
  newWork('humanize', writer.content);
}
function saveDraft(notify = true) {
  clearTimeout(autosaveTimer);
  if (!writer.content.trim() && !writer.id) { if (notify) toast('先写一点内容，再保存作品。'); return false; }
  const existing = db.drafts.find(d => d.id === writer.id);
  if (!writer.id) writer.id = uid();
  if (!writer.title.trim()) writer.title = writer.content.split('\n').find(t => t.trim())?.replace(/^#+\s*/, '').slice(0, 70) || '未命名作品';
  const row = { ...writer, updatedAt:Date.now(), createdAt:existing?.createdAt || Date.now() };
  db.drafts = [row, ...db.drafts.filter(d => d.id !== writer.id)];
  const success = persist(); updateCount();
  if ($('#save-status')) $('#save-status').textContent = success ? '已保存在此浏览器' : '保存失败，请导出';
  if (notify && success) toast('作品已保存到创作记录');
  return success;
}
function heroArt() {
  return `<svg viewBox="0 0 410 310" fill="none" aria-hidden="true"><defs><pattern id="art-grid" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" stroke="#c4d0b0" stroke-width=".5"/></pattern><filter id="paper-shadow"><feDropShadow dx="0" dy="12" stdDeviation="10" flood-color="#344f32" flood-opacity=".12"/></filter></defs><circle cx="225" cy="155" r="118" stroke="#bdcba7" stroke-dasharray="3 6"/><circle cx="225" cy="155" r="94" fill="url(#art-grid)" opacity=".8"/><ellipse cx="219" cy="274" rx="124" ry="14" fill="#d8e1c8"/><g transform="rotate(12 215 159)"><rect x="140" y="63" width="158" height="210" rx="7" fill="#d6dfc4" stroke="#b4c39c"/></g><g transform="rotate(-8 207 164)" filter="url(#paper-shadow)"><rect x="115" y="49" width="164" height="218" rx="7" fill="#fcfdf5" stroke="#c6d2b4"/><path d="M140 81h56M140 96h106" stroke="#8ea67b" stroke-width="3" stroke-linecap="round"/><path d="M140 119h110M140 135h110M140 151h77M140 192h110M140 208h110M140 224h68" stroke="#dce4cf" stroke-width="2" stroke-linecap="round"/><path d="M140 171c15-9 22 8 38-1 12-6 20 3 32-3" stroke="#6d8c5c" stroke-width="2.5" stroke-linecap="round"/></g><g transform="rotate(33 286 168)"><rect x="278" y="91" width="13" height="125" rx="4" fill="#30594a"/><path d="M278 108h13M278 113h13" stroke="#a5bb8d"/><path d="m278 214 6.5 21 6.5-21" fill="#ccbb92"/><path d="m282.3 228 2.2 7 2.2-7" fill="#30594a"/><rect x="281" y="91" width="3" height="120" rx="1" fill="#ffffff15"/></g><path d="M93 228c-5-36-13-57-28-79M87 201c-22-2-31-17-27-27 15 0 25 8 27 27ZM91 219c9-19 7-35-3-41-9 11-9 25 3 41Z" stroke="#8fa679" stroke-width="1.5" fill="#b7c99c"/><path d="M318 107c6-19 12-28 24-37M328 89c-4-11-1-22 8-25 5 8 2 17-8 25ZM326 94c14-4 22-2 25 5-8 6-18 4-25-5Z" stroke="#8fa679" stroke-width="1.4" fill="#b7c99c"/><path d="m94 88 3-11 3 11 11 3-11 3-3 11-3-11-11-3z" fill="#adc18b"/><path d="m327 210 2-8 2 8 8 2-8 2-2 8-2-8-8-2z" fill="#b0c393"/><circle cx="319" cy="51" r="3" fill="#bdcba5"/><circle cx="71" cy="119" r="2" fill="#bdcba5"/><circle cx="349" cy="174" r="2" fill="#bdcba5"/><g transform="rotate(8 306 247)"><rect x="278" y="226" width="56" height="30" rx="5" fill="#d9e5bb" stroke="#a8bf87"/><path d="m291 241 6 6 12-13" stroke="#6e8e56" stroke-width="2"/></g></svg>`;
}
function coverArt(p) {
  const colors = [['#e6eddf','#a2b690','#6c8c6a'],['#efe9dc','#c8b78f','#938869'],['#e6eae3','#b0bba5','#7a8e75'],['#e4e9eb','#b1c0c4','#758f94'],['#eee5dd','#ccb5a0','#9a7f6b'],['#e8eadf','#b9c09d','#8b986c']][p % 6];
  const motifs = [
    '<path d="M140 130V65m0 25c-30 2-40-18-34-30 23-1 34 13 34 30Zm0-7c26-4 38-23 29-36-23 2-29 19-29 36Z" fill="C2" stroke="C3" stroke-width="1"/><path d="M118 102h44l-5 32h-34z" fill="C3"/><circle cx="227" cy="43" r="20" fill="C2" opacity=".3"/>',
    '<path d="M40 132V62h42v70M91 132V44h38v88M139 132V70h49v62M200 132V52h49v80" fill="C2"/><path d="M102 59h9m-9 15h9m-9 15h9m100-20h11m-11 17h11m-67 1h14m-14 15h14M55 80h12" stroke="C1" stroke-width="4"/><circle cx="230" cy="27" r="13" fill="C2" opacity=".5"/>',
    '<path d="M56 116h183" stroke="C3" stroke-width="3"/><path d="M84 116V60h70v56" fill="C1" stroke="C3"/><path d="M89 69h59m-56 9h46m-46 9h50" stroke="C2" stroke-width="3"/><path d="M200 116V40l-33 17m19-21 19 13-25 14-11-12z" fill="C2" stroke="C3"/><path d="M173 116h54" stroke="C3" stroke-width="3"/>',
    '<rect x="94" y="40" width="112" height="75" rx="10" fill="C2"/><rect x="101" y="47" width="98" height="61" rx="6" fill="C1"/><path d="m139 72 11-11 11 11-11 11zM150 83v13M125 96h50" stroke="C3" stroke-width="2"/><circle cx="78" cy="64" r="6" fill="C2"/><circle cx="227" cy="91" r="11" fill="C2" opacity=".6"/>',
    '<path d="M150 65c-25-13-47-13-68-8v63c21-5 43-5 68 8 25-13 47-13 68-8V57c-21-5-43-5-68 8Z" fill="C1" stroke="C3"/><path d="M150 65v63m-51-52 34 5m-34 7 34 5m34-12 34-5m-34 17 34-5" stroke="C2" stroke-width="2"/><path d="m209 45 9-17 9 17-9 17z" fill="C2"/>',
    '<circle cx="150" cy="79" r="42" fill="C1" stroke="C2" stroke-width="2"/><path d="M150 47v34l23 12" stroke="C3" stroke-width="3" stroke-linecap="round"/><path d="M70 125c15-20 40-20 55 0M174 125c15-20 40-20 55 0" fill="C2"/>'
  ];
  return `<svg viewBox="0 0 300 150" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><rect width="300" height="150" fill="${colors[0]}"/><circle cx="150" cy="105" r="100" fill="#fff" opacity=".16"/><ellipse cx="150" cy="134" rx="102" ry="8" fill="${colors[1]}" opacity=".3"/>${motifs[p % 6].replaceAll('C1', colors[0]).replaceAll('C2', colors[1]).replaceAll('C3', colors[2])}</svg>`;
}
function empty(title, description, button = '开始创作', action = 'new') { return `<div class="empty-state">${icon('file')}<h2>${esc(title)}</h2><p>${esc(description)}</p>${button ? `<button class="btn primary" data-action="${action}">${icon('plus')}${esc(button)}</button>` : ''}</div>`; }
function pageHead(kicker, title, desc, actions = '') { return `<div class="page-head"><div><span class="eyebrow">${kicker}</span><h1>${title}</h1><p>${desc}</p></div>${actions ? `<div class="head-actions">${actions}</div>` : ''}</div>`; }
function homePage() {
  const date = new Intl.DateTimeFormat('zh-CN', { month:'long', day:'numeric', weekday:'long' }).format(new Date());
  return `<div class="welcome"><div><span class="eyebrow">YOUR CREATIVE SPACE</span><h1>今天，也写点好内容。</h1><p>把值得记录的想法，变成值得阅读的文字。</p></div><div class="welcome-date">${icon('calendar')}${date}</div></div>
  <section class="hero"><div class="hero-copy"><span class="hero-tag"><i></i> 灵感有迹，创作有术</span><h2>让灵感落笔，<br>让<em>好内容</em>发生。</h2><p>从一个念头到一篇好文章，<br>让有术成为你创作路上的得力搭档。</p><div class="hero-buttons"><button class="btn primary" data-action="new">${icon('pen')}开始创作 ${icon('arrow')}</button><button class="btn subtle" data-action="guide">了解创作流程 ↗</button></div></div><div class="hero-art">${heroArt()}</div><span class="hero-footnote">MADE FOR YOUR IDEAS.</span></section>
  <section><div class="section-title"><h2>从这里开始 <small>CREATE SOMETHING GOOD</small></h2><span class="eyebrow" style="font-size:8px">为每一种表达，找到起点</span></div><div class="tools-grid">${[
    ['article','pen','文章创作','把想法，写成一篇好文章'],['outline','layers','大纲构思','先搭骨架，再填好内容'],['titles','title','标题灵感','为好内容，找到好开头'],['polish','feather','文章润色','细细打磨，让表达更自然'],['humanize','spark','去 AI 味','删掉套话，保留你的声音']
  ].map(([m,i,t,d]) => `<button class="tool-card" data-action="mode" data-mode="${m}"><span class="tool-icon">${icon(i)}</span><span class="tool-arrow">↗</span><strong>${t}</strong><p>${d}</p></button>`).join('')}</div></section>
  <div class="home-lower"><section><div class="section-title"><h2>找一点灵感 <small>INSPIRATION</small></h2><button class="text-btn" data-action="shuffle">换一组 ↻</button></div><div class="inspiration-box"><div class="inspiration-tabs">${Object.keys(topics).map(c => `<button class="tab ${c === homeCategory ? 'active' : ''}" data-action="home-category" data-category="${c}">${c}</button>`).join('')}</div><div class="topic-list" id="home-topics">${topicRows()}</div></div></section><section><div class="section-title"><h2>最近的创作 <small>RECENT</small></h2><a class="text-btn" href="#history">查看全部 ↗</a></div><div class="recent-box">${db.drafts.length ? db.drafts.slice(0,3).map(d => `<button class="recent-row" style="background:none;width:100%;text-align:left" data-action="open-draft" data-id="${esc(d.id)}"><span class="document-icon">${icon('file')}</span><span><strong class="truncate">${esc(d.title)}</strong><small>${fmtDate(d.updatedAt)} · ${wordCount(d.content)} 字</small></span>${icon('arrow')}</button>`).join('') : `<div class="empty-mini">${icon('file')}<strong>好作品，从第一句话开始</strong><p>你的创作会安静地保存在这里</p><button class="text-btn" data-action="new">写下第一篇 ↗</button></div>`}</div></section></div>
  <div class="workflow-line"><strong>像做手艺一样写文章</strong><span><span class="step-dot">01</span>挑选好料</span><span class="dash"></span><span><span class="step-dot">02</span>立起骨架</span><span class="dash"></span><span><span class="step-dot">03</span>细细打磨</span><span class="dash"></span><span><span class="step-dot">04</span>精心出品</span></div>`;
}
function topicRows() { return topics[homeCategory].map((t, i) => `<button class="topic-row" data-action="topic" data-topic="${esc(t)}"><span class="topic-number">0${i+1}</span><span class="topic-text">${esc(t)}</span><span class="topic-tag">灵感</span>${icon('arrow')}</button>`).join(''); }
function currentWritingWorkflow(){
  if(workflowProgress)return workflowProgress;
  const source=db.drafts.find(d=>d.id===writer.id&&['pending','failed','cancelled'].includes(d.automation?.state));
  if(source)return {stage:source.automation.state==='cancelled'?'cancelled':'error',percent:50,automatic:true,source,error:source.automation.error||'上次流程在原稿保存后中断，可单独继续去 AI 味。',startedAt:null};
  return null;
}
function writingWorkflowPanel(){
  const p=currentWritingWorkflow();if(!p)return '<div id="writing-workflow-slot"></div>';
  const running=generating,step=p.stage,failed=['error','cancelled'].includes(step);
  const labels={generating:p.snapshot?.mode==='humanize'?'正在去 AI 味':'正在生成文章','saving-source':'正在保存原稿',humanizing:'正在去 AI 味','saving-final':'正在保存改稿',complete:'流程已完成',error:'流程未完成',cancelled:'流程已停止'};
  const steps=p.automatic?['生成文章','去 AI 味','保存改稿']:[p.snapshot?.mode==='humanize'?'去 AI 味':'生成内容','保存作品'];
  const active=p.automatic?(p.percent>=90?2:p.percent>=50?1:0):(p.percent>=90?1:0);
  const elapsed=p.startedAt?Math.floor(((p.finishedAt||Date.now())-p.startedAt)/1000):0;
  const canRetry=failed&&p.automatic&&p.source&&p.source.content.length<=20000&&p.failedStage!=='saving-final';
  return `<section id="writing-workflow-slot" class="writing-workflow ${route!=='write'?'workflow-global':''}" aria-label="自动写作流程"><div class="workflow-header"><div class="workflow-heading"><strong class="workflow-title" role="status" aria-live="polite">${labels[step]||'写作流程'}</strong><span class="workflow-caption">${p.automatic?'生成文章 → 去 AI 味 → 保存改稿':'单步创作'}${p.startedAt?` · 已用时 <span data-workflow-elapsed>${elapsed}</span> 秒`:''}</span></div><span class="workflow-percentage">${p.percent}%</span></div><div class="workflow-track" role="progressbar" aria-label="阶段完成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.percent}" aria-valuetext="${esc(labels[step])}，阶段进度 ${p.percent}%"><i class="workflow-fill" style="transform:scaleX(${p.percent/100})"></i></div><ol class="workflow-steps" style="grid-template-columns:repeat(${steps.length},minmax(0,1fr))">${steps.map((label,i)=>`<li class="workflow-step ${step==='complete'||i<active?'done':i===active?'active':''}" ${step!=='complete'&&i===active?'aria-current="step"':''}><b>${step==='complete'||i<active?icon('check'):i+1}</b><span>${label}</span></li>`).join('')}</ol><p class="workflow-caption workflow-notice">按完成阶段显示百分比，模型运行时保持当前值，不代表剩余时间。${running?'保持页面打开，可随时停止。':''}</p>${failed?`<p class="workflow-error" role="alert">${esc(p.error)}${p.source?' 生成原稿已保留在创作记录中。':''}</p>`:''}<div class="workflow-actions">${running?'<button class="btn small" data-action="stop-workflow">停止流程</button>':''}${canRetry?'<button class="btn small primary" data-action="retry-humanize">仅重试去 AI 味</button>':''}${p.source&&p.automatic?`<button class="btn small" data-action="view-workflow-source" data-id="${esc(p.source.id)}">查看生成原稿</button>`:''}${!running?'<button class="btn small" data-action="dismiss-workflow">收起流程</button>':''}</div></section>`;
}
function updateWritingWorkflowPanel(){const slot=$('#writing-workflow-slot');if(slot)slot.outerHTML=writingWorkflowPanel();}
function writerPage() {
  const length = String(Math.min(3000,Math.max(1000,Math.round((Number(writer.length)||1000)/1000)*1000)));
  if (writer.length !== length) { writer.length = length; persist(); }
  if(wtView==='chat') return chatWorkspace();
  const local = !status.configured;
  const placeholders = { article:'写下你想聊的主题、目标读者和核心观点。\n\n例如：为忙碌的上班族写一篇关于「周末留白」的文章，语气温暖，给出可执行的小建议。', outline:'你想围绕什么主题搭建文章大纲？\n写下主题、读者和想解决的问题。', titles:'输入文章主题或核心观点，探索不同的标题切入角度。', polish:'粘贴需要润色的原文。\n真实 AI 服务连接后，可优化结构与表达。', humanize:'粘贴需要去除机械表达的中文原文。\n会保留事实、限定、作者态度和文章结构，只修改确实不自然的地方。' };
  return `${workspaceTabs()}${pageHead(writer.mode === 'humanize' ? 'THE EDITING DESK' : 'THE WRITING DESK', writer.mode === 'humanize' ? '让文字，回到你的声音。' : '给灵感，一张书桌。', writer.mode === 'humanize' ? '减少套话与机械表达，保留事实、原意和文体。' : '不必等到想法完美，先写下第一句话。', `<span class="badge"><i></i>${esc(status.configured ? status.model : '本地构思模式')}</span><button class="btn small" data-action="new">${icon('plus')}新建</button>`)}
  <div class="mode-switch" aria-label="创作类型">${Object.entries(modes).map(([key,name]) => `<button class="${writer.mode === key ? 'active' : ''}" data-action="writer-mode" data-mode="${key}" aria-pressed="${writer.mode === key}">${name}</button>`).join('')}</div>
  ${writingToolbar()}${writingWorkflowPanel()}<div class="writer-grid"><section class="panel"><div class="panel-head"><h2>${icon(writer.mode === 'humanize' ? 'spark' : 'pen')}${writer.mode === 'humanize' ? '去 AI 味编辑' : '创作需求'}</h2><span class="eyebrow" style="font-size:8px">${writer.mode === 'humanize' ? 'KEEP YOUR VOICE' : 'START WITH AN IDEA'}</span></div><div class="panel-body"><div class="field"><div class="field-label topic-label"><label for="topic">${writer.mode === 'polish' || writer.mode === 'humanize' ? '待编辑原文' : '主题 / 原文'}<span class="topic-input-actions"><small id="topic-count">${writer.topic.length} / 20000</small><button class="text-btn clear-topic-btn" data-action="clear-topic" title="清空主题 / 原文，保留稿纸正文">${icon('trash')}清空文本</button></span></div><textarea id="topic" class="topic-input" aria-label="主题 / 原文" maxlength="20000" placeholder="${esc(placeholders[writer.mode])}">${esc(writer.topic)}</textarea><span class="reference-help">粘贴公开文章链接后自动提取正文。<button class="btn small reference-button" data-action="read-link">${icon('file')}读取链接</button></span><span id="reference-note" class="reference-note ${esc(linkState.kind)}" role="status" aria-live="polite">${esc(linkState.message)}</span><button class="text-btn reference-preview" data-action="preview-reference" ${writer.reference || writer.topic.startsWith('参考文章：') ? '' : 'hidden'}>展开全文 ↗</button></div>
  ${writer.mode === 'humanize' ? '<div class="notice">去掉空泛铺垫、重复和机械句式，保留原意与文体。沿用原文结构和篇幅，只输出修改稿。<button class="text-btn" data-action="humanizer-guide">查看编辑原则 ↗</button></div>' : `<label class="field"><span class="field-label">发布平台</span><div class="chips">${['微信公众号','今日头条','小红书','通用文章'].map(p => `<button class="chip ${writer.platform === p ? 'active' : ''}" data-action="platform" data-value="${p}" aria-pressed="${writer.platform === p}">${p}</button>`).join('')}</div></label><div class="field-row"><label class="field"><span class="field-label">表达风格</span><select id="style">${['自然叙述','温暖治愈','专业理性','轻松幽默','简洁有力'].map(s => `<option ${writer.style === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label><label class="field"><span class="field-label">目标字数</span><select id="length">${writingLengths.map(n => `<option value="${n}" ${String(writer.length) === String(n) ? 'selected' : ''}>约 ${n} 字</option>`).join('')}</select></label></div>`}
  <div class="field model-field"><label for="writer-model" class="field-label">AI 模型<button class="text-btn" data-action="connection">配置服务 ↗</button></label><input id="writer-model" list="writer-models" value="${esc(writer.model || (status.configured ? status.model : status.presets?.[0]?.id || 'gpt-6.1-sol'))}" placeholder="选择或填写服务商模型 ID" ${generating ? 'disabled' : ''}><datalist id="writer-models">${modelOptions().map(id=>`<option value="${esc(id)}"></option>`).join('')}</datalist><small>可填写中转模型别名；是否可用以服务商权限为准。</small></div>
  ${writer.mode==='article'?`<label class="workflow-toggle"><input id="auto-humanize" type="checkbox" ${writer.autoHumanize!==false?'checked':''} ${generating?'disabled':''}><span><strong>生成后自动去 AI 味</strong><small class="workflow-caption">${local?'连接 AI 后执行两步流程。当前仅生成本地框架。':'先保存生成原稿，再自动精修并另存改稿。共调用模型两次，分别占用额度。'}</small></span></label>`:''}
  <button class="btn primary generate-btn" data-action="generate" ${generating ? 'disabled' : ''}>${icon(generating ? 'refresh' : 'spark')}<span>${generating ? ({humanizing:'正在去 AI 味…','saving-source':'正在保存原稿…','saving-final':'正在保存改稿…'}[workflowProgress?.stage] || (writer.mode==='humanize'?'正在去 AI 味…':'正在生成文章…')) : writer.mode === 'humanize' ? local ? '配置 AI 后开始编辑' : '开始去 AI 味编辑' : local ? (writer.mode === 'titles' ? '探索标题角度' : writer.mode === 'polish' ? '整理原文与编辑清单' : '生成写作框架') : writer.mode==='article'&&writer.autoHumanize!==false?'生成并自动去 AI 味':'开始生成'}</span></button><p class="mode-note">${local ? '当前使用本地规则生成框架和写作提示，不调用 AI 模型。<button data-action="connection">连接 AI 服务</button> 后可生成完整正文与润色内容。' : writer.mode === 'humanize' ? '原文会发送到所选模型。完成后请对照检查事实和限定，原稿会保留在输入框及创作记录中。' : '主题与设置将发送到你配置的 AI 服务商。生成内容请核实后使用。'}</p></div></section>
  <section class="panel editor-panel"><div class="panel-head"><h2>${icon('file')}你的稿纸</h2><div class="editor-tools"><button class="btn small" data-action="humanize-current" ${generating ? 'disabled' : ''}>${icon('spark')}去 AI 味</button><button class="icon-btn" data-action="copy" aria-label="复制正文" title="复制正文">${icon('copy')}</button><button class="icon-btn" data-action="export-work" aria-label="导出 Markdown" title="导出 Markdown">${icon('download')}</button></div></div><div id="editor-area">${editorArea()}</div><div class="editor-footer"><span id="save-status">${writer.id ? '已保存在此浏览器' : '内容仅保存在此浏览器'}</span><div class="editor-footer-actions">${writer.sourceDraftId?`<button class="btn small" data-action="view-workflow-source" data-id="${esc(writer.sourceDraftId)}">查看生成原稿</button>`:writer.mode === 'humanize' && writer.content.trim() ? '<button class="btn small" data-action="view-humanize-source">查看原稿</button>' : ''}<button class="btn small" data-action="save">${icon('check')}保存作品</button></div></div></section></div><p class="status-local">温馨提示：关闭无痕窗口或清除浏览器数据会移除本地作品，建议定期导出备份。</p>`;
}
function editorArea() {
  if (writer.mode === 'humanize' && !writer.content) return `<div class="editor-empty"><div class="big-spark">✧</div><h3>改写后的文字，会留在这里。</h3><p>粘贴原文或读取文章链接，再开始去 AI 味编辑。<br>完成后可对照原稿检查、修改和保存。</p></div>`;
  return writer.content ? `<input class="input-title" id="work-title" ${generating&&workflowProgress?.automatic&&writer.automation?.state==='pending'?'readonly':''} maxlength="100" aria-label="作品标题" placeholder="为作品起个名字" value="${esc(writer.title)}"><textarea id="output" ${generating&&workflowProgress?.automatic&&writer.automation?.state==='pending'?'readonly':''} class="output-editor" aria-label="文章正文" placeholder="在这里开始写作…">${esc(writer.content)}</textarea><div class="editor-footer"><span id="output-count">${wordCount(writer.content)} 字</span><span>${esc(writer.origin)}</span></div>` : `<div class="editor-empty"><div class="big-spark">✧</div><h3>让一个好想法，从这里生长。</h3><p>在左侧写下主题，开始构思。<br>也可以直接打开一张空白稿纸。</p><button class="btn small" data-action="blank">${icon('pen')}自由书写</button></div>`;
}
function card(a) {
  const saved = db.favorites.includes(a.id), art=`<div class="article-cover-art">${coverArt(a.rank||0)}</div>`, cover=a.cover?`${art}<img src="${esc(a.cover)}" alt="" loading="lazy">`:art;
  const stats=[a.views!=null?`阅读 ${Number(a.views).toLocaleString()}`:'',a.likes!=null?`赞 ${Number(a.likes).toLocaleString()}`:'',a.rewriteCount!=null?`构思 ${Number(a.rewriteCount).toLocaleString()}`:''].filter(Boolean).join(' · ');
  const title=a.inspirationTitle||a.title, desc=a.inspirationDesc||a.desc, angle=a.writingAngle||'先核实事实，再从自己的经验出发补充观察。';
  return `<article class="article-card"><a class="article-cover" href="${esc(a.url||'#')}" target="_blank" rel="noopener noreferrer" aria-label="查看来源：${esc(a.sourceTitle||a.title)}">${cover}<span>${esc(a.category||'热点')}</span></a><div class="article-body"><h2><a href="${esc(a.url||'#')}" target="_blank" rel="noopener noreferrer">${esc(title)}</a></h2><p>${esc(desc||'围绕热点核实事实，补充自己的观察与经验。')}</p><p class="article-angle"><strong>写作切入点</strong> ${esc(angle)}</p><div class="article-meta"><span>${esc(a.source||'公开文章')} · ${esc(a.time||'近期')} · <a href="${esc(a.url||'#')}" target="_blank" rel="noopener noreferrer">查看来源 ↗</a></span><button class="icon-btn ${saved ? 'is-saved' : ''}" data-action="favorite" data-id="${esc(a.id)}" aria-label="${saved ? '取消收藏' : '收藏'}：${esc(title)}" aria-pressed="${saved}">${icon('bookmark')}</button></div><div class="article-use"><span>${esc(stats||'编辑整理的灵感选题')}</span><button data-action="use-article" data-id="${esc(a.id)}">以此构思 <span class="arrow">↗</span></button></div></div></article>`;
}
function filteredArticles() { return libraryArticles.filter(a => (route !== 'favorites' || db.favorites.includes(a.id)) && (category === '全部' || a.category === category) && (a.title + a.desc + a.source).toLocaleLowerCase().includes(filter.toLocaleLowerCase())); }
function libraryPage() {
  const favorite = route === 'favorites';
  const domains=['全部',...libraryDomains.filter(x=>x!=='全部')];
  const updated = libraryUpdatedAt ? new Date(libraryUpdatedAt).toLocaleString('zh-CN',{hour12:false}) : '';
  const dailyUpdated = libraryDailyUpdatedAt ? new Date(libraryDailyUpdatedAt).toLocaleString('zh-CN',{hour12:false}) : '尚无成功记录';
  const sourceStatus = librarySources.length ? librarySources.map(source=>`<span class="library-source-status ${source.ok?'ok':'failed'}" title="${esc(source.error||'本次读取成功')}"><i></i>${esc(source.name)}：${source.ok?'可用':'暂不可用'}</span>`).join('') : '<span class="library-source-status pending"><i></i>来源状态将在同步后显示</span>';
  return `${pageHead(favorite ? 'YOUR COLLECTION' : 'DAILY ARTICLE RADAR', favorite ? '把喜欢的，留在身边。' : '每天发现值得写的内容。', favorite ? '收藏的文章与创作线索。' : '根据公开平台热点整理成新的选题角度，原文链接用于核实事实。', `<button class="btn small" data-action="import-article">${icon('plus')}导入文章链接</button><button class="btn primary small" data-action="new">${icon('plus')}开始创作</button>`)}<div class="library-toolbar"><div class="library-time">${[['today','今天'],['2days','近两天'],['3days','近三天']].map(([v,label])=>`<button class="chip ${libraryTime===v?'active':''}" data-action="library-time" data-value="${v}">${label}</button>`).join('')}</div><label>排序 <select id="library-sort"><option value="hot" ${librarySort==='hot'?'selected':''}>热度优先</option><option value="latest" ${librarySort==='latest'?'selected':''}>最新发布</option><option value="rewrites" ${librarySort==='rewrites'?'selected':''}>构思最多</option></select></label><span class="library-updated">${libraryLoading?'正在同步公开文章…':libraryStale?`在线更新失败 · 显示缓存${updated?`（列表缓存于 ${esc(updated)}）`:''}`:updated?`列表缓存于 ${esc(updated)}`:'等待同步列表'}</span></div><div class="library-source-panel"><div><strong>每日热点更新</strong><span>计划时间：每天北京时间 08:00</span><span>最近成功刷新：${esc(dailyUpdated)}</span>${updated?`<span>当前列表缓存：${esc(updated)}</span>`:''}</div><div class="library-source-statuses">${sourceStatus}</div></div><div class="filter-bar"><div class="chips">${domains.map(c => `<button class="chip ${category === c ? 'active' : ''}" data-action="category" data-category="${esc(c)}" aria-pressed="${category === c}">${esc(c)}</button>`).join('')}</div><label class="search-field"><span>${icon('search')}</span><input id="library-search" aria-label="搜索选题" placeholder="搜索选题或关键词…" value="${esc(filter)}"></label></div><div class="library-source-note">热点整理为新的选题摘要与写作角度，不复制文章全文；每条保留来源链接供核实。头条聚合内容取决于公开源可用性；微信公众号文章仅在公开订阅源配置并可访问时出现。<button data-action="refresh-library">立即更新 ↻</button></div><div class="library-grid" id="article-list">${libraryResults()}</div>${libraryHasMore?`<div class="library-more"><button class="btn" data-action="library-more" ${libraryLoading?'disabled':''}>${libraryLoading?'正在加载…':'加载更多文章'}</button></div>`:''}`;
}
function libraryResults() { if(libraryLoading&&!libraryArticles.length)return `<div class="empty-state"><h2>正在同步每日文章</h2><p>连接公开文章源并整理可用的创作线索…</p></div>`;if(libraryError&&!libraryArticles.length)return `<div class="empty-state"><h2>文章源暂时无法连接</h2><p>${esc(libraryError)}</p><button class="btn primary" data-action="refresh-library">重试</button></div>`;const list = filteredArticles(); return list.length ? list.map(card).join('') : empty(route === 'favorites' && !db.favorites.length ? '还没有收藏的文章' : '没有找到相关内容', route === 'favorites' && !db.favorites.length ? '去灵感文章库，收藏一点喜欢的文字。' : '试试放宽时间范围或更换关键词。', route === 'favorites' && !db.favorites.length ? '看看文章库' : '', 'to-library'); }
async function loadLibrary(refresh=false,append=false){if(libraryLoading)return;libraryLoading=true;libraryError='';if(route==='library'||route==='favorites')render();try{const params=new URLSearchParams({time:libraryTime,sort:librarySort,domain:category,per_page:'30',page:String(append?libraryPageNumber+1:1)});if(filter)params.set('keyword',filter);if(refresh)params.set('refresh','1');const [response,importsResponse]=await Promise.all([fetch('/api/library/articles?'+params,{cache:'no-store'}),append?Promise.resolve(null):fetch('/api/library/imports',{cache:'no-store'})]);const data=await response.json(),imports=importsResponse?await importsResponse.json():{articles:libraryImports};if(!response.ok)throw new Error(data.error||'文章源暂不可用');libraryImports=imports.articles||[];const incoming=(data.articles||[]).filter(a=>!libraryImports.some(i=>i.url===a.url));libraryArticles=append?[...libraryArticles,...incoming]:[...libraryImports,...incoming];libraryPageNumber=data.page||1;libraryHasMore=!!data.hasMore;articles=libraryArticles;libraryDomains=data.domains||['全部'];libraryUpdatedAt=data.cachedAt||'';libraryDailyUpdatedAt=data.dailyRefreshedAt||'';librarySources=data.sources||[];libraryStale=!!data.stale;libraryError='';if(route==='library'||route==='favorites')render();}catch(error){libraryError=error.message||'请稍后重试';}finally{libraryLoading=false;if(route==='library'||route==='favorites')render();}}
function historyPage() {
  const count = db.drafts.reduce((n,d) => n + wordCount(d.content), 0);
  return `${pageHead('EVERY WORD COUNTS', '每一次表达，都有迹可循。', '那些认真写下的文字，会在这里等你。', `<button class="btn small" data-action="backup">${icon('download')}备份</button><button class="btn primary small" data-action="new">${icon('plus')}新建作品</button>`)}<div class="stats-strip"><div class="stat-card"><span>已保存作品</span><strong>${db.drafts.length}<small style="font:10px var(--sans)"> 篇</small></strong></div><div class="stat-card"><span>累计创作</span><strong>${count.toLocaleString()}<small style="font:10px var(--sans)"> 字</small></strong></div><div class="stat-card"><span>珍藏灵感</span><strong>${db.favorites.length}<small style="font:10px var(--sans)"> 篇</small></strong></div></div><div class="filter-bar"><span class="eyebrow">YOUR MANUSCRIPTS</span><label class="search-field"><span>${icon('search')}</span><input id="history-search" aria-label="搜索创作记录" placeholder="搜索作品标题或正文…" value="${esc(filter)}"></label></div><div id="record-list" class="records">${historyResults()}</div>`;
}
function historyResults() {
  const list = db.drafts.filter(d => (d.title + d.content).includes(filter));
  return list.length ? list.map(d => `<article class="record"><span class="document-icon">${icon('file')}</span><div class="record-main" role="button" tabindex="0" data-action="open-draft" data-id="${esc(d.id)}"><h2 class="truncate">${esc(d.title)}</h2><p>${fmtDate(d.updatedAt)} 更新 · ${esc(d.platform)} · ${wordCount(d.content)} 字 · ${esc(d.origin || '本地编辑')}</p></div><div class="record-actions"><button class="icon-btn" aria-label="编辑：${esc(d.title)}" data-action="open-draft" data-id="${esc(d.id)}">${icon('pen')}</button><button class="icon-btn" aria-label="导出：${esc(d.title)}" data-action="export-draft" data-id="${esc(d.id)}">${icon('download')}</button><button class="icon-btn" aria-label="删除：${esc(d.title)}" data-action="delete-draft" data-id="${esc(d.id)}">${icon('trash')}</button></div></article>`).join('') : empty(db.drafts.length ? '没有找到相关作品' : '给第一篇作品，留个位置。', db.drafts.length ? '试试其他关键词。' : '开始写作并保存，让每一个想法都有归处。', db.drafts.length ? '' : '开始创作');
}
function render() {
  const next = location.hash.replace('#','').split('?')[0] || 'home';
  route = labels[next] ? next : 'home';
  $('#page-title').textContent = labels[route];
  document.title = `${labels[route]} · 有术 Studio`;
  $$('[data-nav]').forEach(a => { a.classList.toggle('active', a.dataset.nav === route); if (a.dataset.nav === route) a.setAttribute('aria-current','page'); else a.removeAttribute('aria-current'); });
  $('#sidebar').classList.remove('open');
  $('[data-action="menu"]').setAttribute('aria-expanded','false');
  $('#main').innerHTML = ((route!=='write'||wtView==='chat')&&generating?writingWorkflowPanel():'') + (route === 'home' ? homePage() : route === 'write' ? writerPage() : route === 'history' ? historyPage() : route === 'membership' ? membershipPageShell() : libraryPage());
  $$('.article-cover img', $('#main')).forEach(img => img.addEventListener('error', () => img.remove(), { once:true }));
  document.body.classList.toggle('chat-workspace-open',route==='write'&&wtView==='chat');
  updateCount();
  if((route==='library'||route==='favorites')&&!libraryArticles.length&&!libraryLoading)loadLibrary();
  if(route==='membership')loadMembershipPage();
}
function showModal(title, html) { $('#modal').className=''; $('#modal-content').innerHTML = `<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="icon-btn" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${html}</div>`; if (!$('#modal').open) $('#modal').showModal(); }
function closeModal() { $('#modal').close(); }
function guide() { showModal('像做手艺一样写文章', `<div class="guide-steps">${[['挑选好料','从一个你在意的主题开始。在文章库收藏灵感，也可以带着自己的经历坐下来。'],['立起骨架','用大纲构思明确文章想回答的问题，先确定结构，再展开论述。'],['细细打磨','在稿纸上直接修改文字。连接 AI 后可以生成正文或润色原文；所有事实和引用仍需自己核实。'],['精心出品','作品编辑后自动保存到本地。复制正文或导出 Markdown，发布前再认真读一遍。']].map(([t,d],i) => `<div class="guide-step"><span>0${i+1}</span><div><strong>${t}</strong><p>${d}</p></div></div>`).join('')}</div><div class="modal-actions"><button class="btn primary" data-action="start-from-modal">写下第一句话 ${icon('arrow')}</button></div>`); }
async function connection() {
  if (generating) return toast('请等待当前生成完成后再修改 AI 服务。');
  try {
    if (!status.token) status = await (await fetch('/api/status')).json();
    const response = await studioRequest('/api/ai/config', {headers:{'X-Studio-Token':status.token}});
    const c = await response.json();
    if (!response.ok) throw new Error(c.error);
    status={...status,...c};
    showModal('连接 OpenAI / 中转服务', `<div class="ai-connection"><p>填写官方或中转服务提供的地址与密钥，保存后立即生效。</p>
      <label class="field"><span class="field-label">API 基础地址</span><input id="ai-base" type="url" value="${esc(c.baseUrl)}" placeholder="https://你的中转域名/v1" autocomplete="off"><small>可填基础地址或完整接口地址。密钥将发送到这个服务商。</small></label>
      <label class="field"><span class="field-label">API Key ${c.hasKey ? '· 已保存' : ''}</span><input id="ai-key" type="password" placeholder="${c.hasKey ? '同一地址留空保留原密钥' : '粘贴官方或中转 API Key'}" autocomplete="new-password" spellcheck="false"><small>仅保存在本机服务端配置文件；不写入作品备份或浏览器存储。</small></label>
      <label class="field"><span class="field-label">默认模型<button class="text-btn" data-action="ai-models" aria-label="拉取服务商模型列表">拉取服务商模型列表</button></span><input id="ai-model" aria-label="默认模型 ID" list="ai-model-options" value="${esc(c.model)}" placeholder="服务商提供的模型 ID"><datalist id="ai-model-options">${modelOptions().map(id=>`<option value="${esc(id)}"></option>`).join('')}</datalist></label>
      <div class="ai-presets">${c.presets.map(m=>`<button class="chip" data-action="ai-preset" data-model="${esc(m.id)}">${esc(m.name)}</button>`).join('')}</div><small>预设仅供选择，当前服务商不一定提供。支持自定义模型 ID。</small>
      <label class="field"><span class="field-label">接口协议</span><select id="ai-protocol">${[['auto','自动 · 官方用 Responses，中转用 Chat'],['responses','Responses · /responses'],['chat','Chat Completions · /chat/completions']].map(([v,n])=>`<option value="${v}" ${c.protocol===v?'selected':''}>${n}</option>`).join('')}</select></label>
      <details><summary>兼容设置</summary><div class="field-row"><label class="field"><span class="field-label">Chat 输出上限字段</span><select id="ai-token-field">${['max_completion_tokens','max_tokens'].map(v=>`<option ${c.tokenField===v?'selected':''}>${v}</option>`).join('')}</select></label><label class="field"><span class="field-label">推理强度</span><select id="ai-reasoning">${[['auto','默认 · 不额外传参'],['none','none'],['low','low'],['medium','medium'],['high','high']].map(([v,n])=>`<option value="${v}" ${c.reasoning===v?'selected':''}>${n}</option>`).join('')}</select></label></div><p>旧版中转可改用 max_tokens；模型不支持推理参数时保持默认。</p></details>
      <p class="ai-result" id="ai-result" role="status" aria-live="polite">${c.verified ? '最近一次测试 / 生成成功：'+esc(c.verified.model) : c.configured ? '已保存配置，尚未验证实际调用。' : '等待填写地址和密钥。'}</p>
      <div class="modal-actions"><button class="btn" data-action="ai-test">测试当前填写配置</button><button class="btn primary" data-action="ai-save">保存配置</button></div><p class="ai-footnote">测试会发送一条简短提示词，可能产生少量模型费用。测试成功后仍需保存；保存后可再次测试确认。</p></div>`);
  } catch(e) { toast(e.message || '配置读取失败，请刷新页面。'); }
}
function readAIForm() {
  return {baseUrl:$('#ai-base').value.trim(),apiKey:$('#ai-key').value.trim(),model:$('#ai-model').value.trim(),protocol:$('#ai-protocol').value,tokenField:$('#ai-token-field').value,reasoning:$('#ai-reasoning').value};
}
async function aiAction(action) {
  if (aiFormBusy) return;
  const form = readAIForm();
  const panel = $('.ai-connection');
  const result = $('#ai-result');
  const endpoint = {'ai-save':'config','ai-test':'test','ai-models':'models'}[action];
  aiFormBusy = true;
  panel.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
  result.className='ai-result';
  result.textContent=action==='ai-test'?'正在请求真实模型，请稍候…':action==='ai-models'?'正在读取服务商模型列表…':'正在保存…';
  try {
    const response = await studioRequest('/api/ai/'+endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':status.token},body:JSON.stringify(form),signal:AbortSignal.timeout(190000)});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '操作失败');
    if (action === 'ai-models') {
      availableModels = data.models;
      $('#ai-model-options').innerHTML=modelOptions().map(id=>`<option value="${esc(id)}"></option>`).join('');
      result.textContent=`已读取 ${data.models.length} 个模型，可在默认模型输入框中选择或输入。`;
    } else if (action === 'ai-test') {
      result.textContent=`实际调用成功 · ${data.model} · ${data.protocol}：${data.content.slice(0,180)}`;
      status=await (await fetch('/api/status')).json(); serviceState();
    } else {
      status={...status,...data}; writer.model=data.model; persist(); serviceState();
      $('#ai-key').value=''; $('#ai-key').placeholder='同一地址留空保留原密钥';
      result.textContent='配置已保存并立即生效。点击测试确认模型可用。';
      if(route==='write') render();
    }
    result.classList.add('ok');
  } catch(e) { result.classList.add('fail');result.textContent=e.name==='TimeoutError'?'请求超时，请检查地址后重试。':e.message; }
  finally { aiFormBusy=false; if(panel.isConnected) panel.querySelectorAll('input,select,button').forEach(el=>el.disabled=false); }
}
function settings() { showModal('你的工作室', `<div class="settings-row"><strong>AI 创作服务</strong><p>${status.configured ? '已配置：' + esc(status.model) : '本地构思模式 · 未连接模型服务'}</p><button class="btn small" data-action="connection">配置 / 测试模型 ↗</button></div><div class="settings-row"><strong>会员与订单</strong><p>查看会员套餐与订单。微信商户未配置时不会收款；管理员可在 <a href="/admin">后台创建套餐并设定售价 ↗</a>。</p><button class="btn small" data-action="membership">打开会员中心</button></div><div class="settings-row"><strong>作品数据</strong><p>${status.authRequired?'作品、收藏、当前稿纸和对话会话会同步至当前账号云端。':'作品与收藏存储在当前浏览器，不会自动同步到其他设备。'}备份会同时包含作品、当前稿纸、收藏和对话会话。</p><button class="btn small" data-action="backup">${icon('download')}导出全部备份</button><button class="btn small" data-action="import">${icon('upload')}导入备份</button><input class="import-file" id="import-file" type="file" accept="application/json,.json"></div>${status.authRequired?'<div class="settings-row"><strong>账号</strong><p>'+esc(status.user?.displayName||status.user?.email||'')+' · '+(status.user?.role==='admin'?'管理员':status.user?.plan==='member'?'会员':'免费账号')+'</p><p>微信账号：'+(status.user?.wechatLinked?'已绑定':'未绑定')+'</p>'+(status.wechatLoginEnabled&&!status.user?.wechatLinked?'<button class="btn small" data-action="bind-wechat">绑定微信账号 ↗</button>':'')+'<form id="password-change"><label>当前密码<input type="password" name="currentPassword" autocomplete="current-password" required></label><label>新密码（至少 12 位）<input type="password" name="newPassword" minlength="12" maxlength="128" autocomplete="new-password" required></label><button class="btn small">更改密码</button><span id="password-message" role="status"></span></form><button class="btn small" data-action="logout">退出登录</button></div>':''}<div class="settings-row"><strong>关于有术 Studio</strong><p>依据公开前端功能分析独立设计与实现的新网站。本站未接入原站实时平台规则。版本 1.0。</p></div>`); }
function paymentStatusLabel(value){return ({pending:'待支付',paid:'支付成功',refunded:'已退款',cancelled:'已取消'})[value]||value;}
let membershipLoadVersion=0;
function membershipPageShell(){return `${pageHead('MEMBERSHIP & CREDITS','把合适的额度，留给每一次好创作。','选择会员方案或单独购买次数；价格和权益由管理员在后台设置。')}<div class="membership-loading" role="status">正在读取会员方案…</div>`;}
function membershipPlanCard(plan,data){
  const permanent=plan.days===0,activeMember=data.account?.plan==='member',admin=data.account?.role==='admin';
  const benefit=plan.kind==='credits'?`${plan.credits.toLocaleString()} 次 AI 调用，长期保留`:`${permanent?'长期有效':`${plan.days} 天会员`} · ${plan.credits.toLocaleString()} 次会员调用额度`;
  const action=!status.authenticated?`<a class="btn primary small" href="/account.html">登录后购买</a>`:admin?'<span class="membership-admin-note">管理员账号无需购买</span>':data.checkoutEnabled?`<button class="btn primary small" data-action="buy-membership" data-plan="${esc(plan.id)}" data-plan-name="${esc(plan.name)}">${plan.kind==='credits'?'购买次数':'开通会员'}</button>`:`<button class="btn small" disabled>微信支付暂不可用</button>`;
  return `<article class="membership-plan ${plan.kind==='membership'?'is-member-plan':'is-credit-plan'} ${plan.featured?'is-featured':''}"><div class="membership-plan-top"><span class="membership-plan-kind">${plan.kind==='credits'?'次数包':'会员方案'}</span>${plan.featured?'<span class="membership-recommend">推荐</span>':''}</div><h3>${esc(plan.name)}</h3><p class="membership-benefit">${benefit}</p><div class="membership-price"><small>¥</small>${(plan.amountCents/100).toFixed(2)}</div><div class="membership-plan-footer"><span>${plan.kind==='credits'?'长期有效':'购买后自动到账'}</span>${action}</div></article>`;
}
function membershipOrderRows(orders){return orders.length?`<div class="membership-orders">${orders.map(order=>`<article class="membership-order"><div><strong>${esc(order.name||order.plan)}</strong><span class="membership-order-kind">${order.kind==='credits'?'次数包':'会员'}</span><small>${new Date(order.createdAt).toLocaleString()} · ${order.credits?.toLocaleString()||0} 次${order.kind==='membership'?(order.days===0?' · 永久会员':` · ${order.days} 天`):''}</small></div><div class="membership-order-total"><strong>¥${(order.amountCents/100).toFixed(2)}</strong><span>${paymentStatusLabel(order.status)}</span></div></article>`).join('')}</div>`:'<div class="membership-empty-orders">还没有订单。购买记录会显示在这里。</div>';}
async function loadMembershipPage(){
  const version=++membershipLoadVersion;
  try{
    const response=await fetch('/api/membership',{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'会员服务暂不可用。');
    let orders=[];if(status.authenticated){const result=await fetch('/api/account/orders',{cache:'no-store'});if(result.ok)orders=(await result.json()).orders||[];}
    if(version!==membershipLoadVersion||route!=='membership')return;
    const account=data.account,memberPlans=data.plans.filter(plan=>plan.kind==='membership'),creditPlans=data.plans.filter(plan=>plan.kind==='credits'),current=account?.plan==='member',expires=account?.expiresAt;
    const accountTitle=!account?'尚未登录':account.role==='admin'?'管理员账号':current?'会员有效中':account.packageCredits>0?'可用次数包':'免费账号';
    const accountDetail=!account?'登录后可购买并查看个人订单。':account.role==='admin'?'管理员不受会员额度限制。':current?`有效期：${expires?new Date(expires).toLocaleDateString()+' 到期':'永久有效'} · 会员次数 ${account.memberCredits??0} 次`:`会员未开通 · 剩余次数 ${account.packageCredits??0} 次`;
    const loginLink=!status.authenticated?'<a class="btn small" href="/account.html">登录 / 注册</a>':'';
    const unavailable=!data.checkoutEnabled&&data.plans.length?`<div class="membership-payment-note" role="status"><strong>在线支付尚未启用</strong><span>${esc(data.paymentUnavailableReason||'服务器尚未配置微信支付商户信息。')} 套餐价格仅供本地页面预览，当前不会收款。</span></div>`:'';
    const adminHint=status.authenticated&&status.user?.role==='admin'?'<a class="btn small" href="/admin">管理商品与售价 ↗</a>':'';
    const noPlans='<div class="membership-empty">管理员还没有发布方案。'+(status.authenticated&&status.user?.role==='admin'?' <a href="/admin">去后台创建会员或次数套餐 ↗</a>':'')+'</div>';
    $('#main').innerHTML=`<div class="membership-page-title"><div><span class="eyebrow">会员与次数</span><h1>选择适合你的创作方案</h1></div><button class="btn small" data-action="membership-collapse">收起</button></div><section class="membership-account"><div class="membership-account-mark">${current?'会':account?.packageCredits>0?'次':'有'}</div><div class="membership-account-copy"><span class="eyebrow">当前权益</span><h2>${accountTitle}</h2><p>${accountDetail}</p></div><div class="membership-balance"><span>当前剩余</span><strong>${account?.role==='admin'?'∞':(account?.credits??'0')}</strong><small>次</small></div>${loginLink}</section>${unavailable}<section class="membership-section screenshot-section"><div class="membership-section-heading"><div><h2>购买会员</h2></div></div><div class="membership-grid screenshot-membership-grid">${memberPlans.length?memberPlans.map(plan=>membershipPlanCard(plan,data)).join(''):noPlans}</div></section><section class="membership-section screenshot-section"><div class="membership-section-heading"><div><h2>次数包</h2><p>用完为止。当前余额 ${account?.packageCredits??0} 次</p></div></div><div class="credit-plan-grid screenshot-credit-grid">${creditPlans.length?creditPlans.map(plan=>membershipPlanCard(plan,data)).join(''):noPlans}</div></section><section class="redeem-bar"><div class="redeem-icon">▣</div><div><span>兑换权益</span><strong>已有兑换码？</strong></div><form id="redeem-form"><input name="code" placeholder="输入兑换码" autocomplete="off" maxlength="64"><button class="btn primary small">立即兑换</button></form></section><p class="membership-help-note">支付成功后会员或次数会自动到账，如果超过几分钟未刷新，请回到个人中心刷新或联系客服核对订单。</p><section class="membership-section membership-faq"><div class="membership-section-heading"><div><h2>常见问题</h2></div></div><details><summary>会员和次数包有什么区别？</summary><p>会员按期限提供会员权益和调用次数；次数包购买后长期保留，用完为止，会员额度用完后也可继续使用。</p></details><details><summary>支付后没有到账怎么办？</summary><p>先刷新个人中心并查看订单状态；如果订单已支付但权益未到账，请联系客服核对订单号。</p></details><details><summary>可以退款吗？</summary><p>虚拟商品是否支持退款请以购买前页面说明和客服处理结果为准。</p></details></section>`;
  }catch(error){if(version===membershipLoadVersion&&route==='membership')$('#main').innerHTML=`${pageHead('MEMBERSHIP & CREDITS','会员服务暂不可用','请稍后刷新页面重试。')}<p class="notice" role="status">${esc(error.message)}</p>`;}
}
document.addEventListener('submit',async e=>{if(e.target.id!=='redeem-form')return;e.preventDefault();if(!status.authenticated){location.href='/account.html';return;}const f=e.target,button=f.querySelector('button');button.disabled=true;try{const response=await fetch('/api/account/redeem',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':status.csrf},body:JSON.stringify({code:f.elements.code.value})}),data=await response.json();if(!response.ok)throw new Error(data.error||'兑换失败。');const session=await fetch('/api/auth/session',{cache:'no-store'});if(session.ok){const signed=await session.json();status.user=signed.user;status.csrf=signed.csrf;}toast(data.result.kind==='credits'?`兑换成功，已增加 ${data.result.credits} 次。`:`兑换成功，已增加会员权益与 ${data.result.credits} 次额度。`);await loadMembershipPage();}catch(error){toast(error.message);}finally{button.disabled=false;}});
function membershipPanel(){if($('#modal')?.open)closeModal();if(route==='membership')loadMembershipPage();else location.hash='#membership';}
let activePaymentPoll=null;
async function pollMembershipOrder(id){if(activePaymentPoll)clearTimeout(activePaymentPoll);const poll=async()=>{if(!$('#modal')?.open)return;try{const response=await fetch('/api/account/orders/'+encodeURIComponent(id),{cache:'no-store'}),data=await response.json();if(!response.ok)throw new Error(data.error||'订单查询失败。');if(data.order.status==='paid'){activePaymentPoll=null;const session=await fetch('/api/auth/session',{cache:'no-store'});if(session.ok){const signed=await session.json();status.user=signed.user;status.csrf=signed.csrf;status.authenticated=true;serviceState();}closeModal();if(route==='membership')loadMembershipPage();toast('支付成功，权益已到账。');return;}if(data.order.status!=='pending'){activePaymentPoll=null;$('#pay-state').textContent='订单'+paymentStatusLabel(data.order.status)+'。';return;}const el=$('#pay-state');if(el)el.textContent='等待扫码付款；付款后权益自动到账。订单 15 分钟内有效。';activePaymentPoll=setTimeout(poll,2500);}catch(error){const el=$('#pay-state');if(el)el.textContent=error.message;activePaymentPoll=setTimeout(poll,5000);}};activePaymentPoll=setTimeout(poll,2000);}
async function buyMembership(planId,button){button.disabled=true;try{const response=await fetch('/api/pay/wechat/orders',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':status.csrf},body:JSON.stringify({planId}),signal:AbortSignal.timeout(25000)}),data=await response.json();if(!response.ok)throw new Error(data.error||'创建支付订单失败。');showModal('微信扫码支付',`<div style="display:grid;justify-items:center;text-align:center;gap:8px"><img src="${esc(data.qrUrl)}" alt="微信支付二维码" width="260" height="260" style="image-rendering:pixelated;background:white"><strong>请使用微信扫描二维码付款</strong><span>¥${(data.order.amountCents/100).toFixed(2)} · ${esc(data.order.name)}</span><p id="pay-state" role="status">正在等待扫码付款…</p></div><div class="modal-actions"><button class="btn" data-action="close-modal">稍后处理</button><button class="btn" data-action="membership">返回会员中心</button></div>`);pollMembershipOrder(data.order.id);}catch(error){toast(error.message||'创建支付订单失败。');}finally{button.disabled=false;}}
function localCompose() {
  const clean = writer.topic.trim();
  const title = clean.split(/[\n。！？]/)[0].slice(0,42);
  const head = `# ${title}\n\n> 本地规则构思稿，未调用 AI。请根据真实经历、核实资料补充正文。\n> 平台：${writer.platform} ｜ 风格：${writer.style} ｜ 目标：约 ${writer.length} 字\n\n`;
  const brief = `## 原始创作需求\n${clean}\n\n`;
  if (writer.mode === 'titles') return head + `## 十个可调整的标题角度\n\n1. 关于「${title}」，我想聊聊这几个细节\n2. 从一个日常场景，重新理解「${title}」\n3. 「${title}」：有哪些值得先问的问题？\n4. 写给正在关注「${title}」的你\n5. 从观察到行动：我的「${title}」笔记\n6. 关于「${title}」，那些容易忽略的小事\n7. 从不同角度看看「${title}」\n8. 「${title}」之后，我们可以做些什么？\n9. 一次关于「${title}」的认真思考\n10. 把「${title}」放回真实生活里\n\n## 选题提示\n这些标题来自固定句式，请按实际文章内容筛选与修改，避免虚构经历或夸大承诺。\n\n` + brief;
  if (writer.mode === 'polish') return `# 原文整理与编辑清单\n\n> 本地模式只整理原文和检查清单，不执行 AI 润色。\n\n## 原文\n${clean.replace(/\n{3,}/g,'\n\n')}\n\n## 建议逐项检查\n- 开头是否尽快说明了具体问题？\n- 每一段是否围绕一个核心观点？\n- 是否可以用真实场景替换抽象评价？\n- 引用、数字和因果关系是否经过核实？\n- 是否删掉了重复表达与不必要的形容词？\n- 朗读一遍，调整不自然的长句。\n\n## 修改记录\n在此记录你的修改与保留的理由。`;
  if (writer.mode === 'humanize') return `# 中文去 AI 味编辑清单\n\n> 本地模式不改写原文，只提供编辑检查清单。\n\n## 原文\n${clean.replace(/\n{3,}/g,'\n\n')}\n\n## 检查重点\n- 删除没有信息的开场铺垫、意义拔高和宣传式收尾。\n- 合并同义反复，但保留每一条独立事实和条件。\n- 检查“可能、据称、超过、正在、计划”等限定是否被误改。\n- 保留作者的语气、立场和必要的排比、转折与正式表达。\n- 不添加数据、经历、来源或看似具体的细节。\n- 通读改写稿，确认没有新增、遗漏或强化原文主张。`;
  const sections = `## 一、从一个具体场景开始\n[写一个与「${title}」有关的真实场景。人物、时间、细节越具体，读者越容易进入。]\n\n## 二、明确这篇文章要回答的问题\n[你的读者是谁？他们正在面临什么疑问？用一句话写出核心观点。]\n\n## 三、展开三个相互支撑的角度\n### 1. 现象：你观察到了什么\n[补充事实、经历或有出处的资料。]\n\n### 2. 原因：为什么值得关注\n[区分事实、解释和个人判断，避免未经证实的归因。]\n\n### 3. 行动：读者可以做些什么\n[提供与读者情境有关、可以尝试的具体建议。]\n\n## 四、回到开头，留下一个余味\n[回应开头的场景，用一句克制、清晰的话收束。]\n\n`;
  return head + brief + sections + (writer.mode === 'article' ? `## 写作与发布检查\n- 补足原创正文，删除所有方括号提示。\n- 按「${writer.style}」调整语气，以内容实际需要决定篇幅。\n- 核实事实、引用与来源。\n- 检查「${writer.platform}」的最新内容要求。\n` : `## 下一步\n先为每一节写下一句核心观点，再补充真实的素材与例子。`);
}
async function generate() {
  if (generating) return;
  if (writer.mode === 'humanize' && !status.configured) { toast('去 AI 味需要连接模型，请先配置 AI 服务。'); return connection(); }
  if (articleUrlFromText(writer.topic)) { await readReferenceLink(); if (articleUrlFromText(writer.topic)) return; }
  if (!writer.topic.trim()) { toast(['polish','humanize'].includes(writer.mode) ? '先粘贴需要编辑的原文。' : '先写下一个主题，灵感才有方向。'); $('#topic')?.focus(); return; }
  if (writer.content.trim()) { showModal('保留当前作品', '<p>继续生成会打开一张新稿纸。当前内容会先保存到创作记录，你可以随时回来编辑。</p><div class="modal-actions"><button class="btn" data-action="close-modal">继续编辑</button><button class="btn primary" data-action="generate-confirm">保存并生成</button></div>'); return; }
  await doGenerate();
}
async function doGenerate(resumeSource=null) {
  if(generating)return;
  clearTimeout(autosaveTimer);
  const snapshot=structuredClone(resumeSource||writer),configured=status.configured;
  const {topic,mode,platform,style,length,model,reference}=snapshot;
  const automatic=configured&&snapshot.mode==='article'&&snapshot.autoHumanize!==false;
  if(resumeSource&&!configured){toast('请先连接 AI 服务，再继续去 AI 味。');return connection();}
  let anchor=resumeSource&&writer.id!==resumeSource.id?null:writer,expected=structuredClone(writer);
  const matches=()=>writer===anchor&&['id','topic','mode','content','title','platform','style','length','model','autoHumanize'].every(key=>writer[key]===expected[key]);
  const startedAt=Date.now();workflowController=new AbortController();generating=true;
  workflowProgress={stage:resumeSource?'humanizing':'generating',percent:resumeSource?50:0,automatic,source:resumeSource,snapshot,startedAt};
  render();
  workflowClock=setInterval(()=>{const elapsed=$('[data-workflow-elapsed]');if(elapsed)elapsed.textContent=Math.floor((Date.now()-startedAt)/1000);},1000);
  const request=async(path,payload,signal)=>{
    const response=await studioRequest(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:AbortSignal.any([signal,AbortSignal.timeout(190000)])});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'当前步骤失败，请重试。');
    if(result.model){status.verified={model:result.model,at:new Date().toISOString()};serviceState();}return result;
  };
  try{
    const outcome=await runWritingWorkflow({automatic,source:resumeSource,signal:workflowController.signal,
      generate:signal=>configured?request('/api/generate',{topic,mode,platform,style,length,model,reference},signal):Promise.resolve({content:localCompose()}),
      humanize:async(source,signal)=>{
        const result=await request('/api/tool',{tool:'humanize',deep:true,text:source.content,title:source.title,platform:snapshot.platform,style:snapshot.style,model:snapshot.model||source.model||status.model,options:{intensity:'均衡',reasoning:'low',articleWorkflow:true}},signal);
        return {content:result.analysis?.rewrite,model:result.model,changes:result.analysis?.changes||[]};
      },
      save:async(result,kind,source)=>{
        const row={...snapshot,id:uid(),content:result.content,title:result.content.split('\n').find(s=>s.trim())?.replace(/^#+\s*/,'').slice(0,100)||'新作品',model:result.model||snapshot.model,origin:configured?(kind==='final'?'自动去 AI 味 · ':snapshot.mode==='humanize'?'去 AI 味 · ':'AI · ')+(result.model||status.model):'本地规则构思',createdAt:Date.now(),updatedAt:Date.now()};
        // Source and final drafts have separate IDs; a failed second request never replaces the source.
        delete row.automation;delete row.sourceDraftId;
        if(automatic&&kind==='source')row.automation={state:'pending'};
        if(kind==='final'){row.sourceDraftId=source.id;row.humanizeChanges=result.changes||[];}
        db.drafts.unshift(row);
        if(matches()){writer={...row};anchor=writer;expected=structuredClone(writer);}
        if(!persist())throw new Error(kind==='final'?'改稿已生成，但浏览器保存失败。请立即导出正文。':'原稿已生成，但浏览器保存失败。请立即导出正文。');
        if(kind==='final'){
          const original=db.drafts.find(d=>d.id===source.id);if(original)original.automation={state:'complete',finalId:row.id};
          // Final is already durable even if updating this optional source marker fails.
          persist();
        }
        updateCount();if(route==='write')render();
        return row;
      },
      onState:state=>{workflowProgress={...state,startedAt,snapshot,...(['complete','error','cancelled'].includes(state.stage)?{finishedAt:Date.now()}:{})};updateWritingWorkflowPanel();const label=$('[data-action="generate"] span');if(label&&state.stage==='humanizing')label.textContent='正在去 AI 味…';}
    });
    if(['error','cancelled'].includes(outcome.stage)&&outcome.source){
      const original=db.drafts.find(d=>d.id===outcome.source.id);
      if(original){original.automation={state:outcome.stage==='cancelled'?'cancelled':'failed',error:workflowProgress.error};if(writer.id===original.id)writer.automation={...original.automation};persist();}
    }
    toast(outcome.stage==='complete'?(automatic?'文章生成和去 AI 味已完成，原稿与改稿均已保存。':configured?'内容已生成并保存，请核实事实后使用。':'写作框架已保存。'):workflowProgress.error);
  }finally{clearInterval(workflowClock);workflowController=null;generating=false;render();}
}
function download(name, text, type = 'text/markdown;charset=utf-8') { const url = URL.createObjectURL(new Blob([text], {type})); const a = document.createElement('a'); a.href=url; a.download=name.replace(/[<>:"/\\|?*]/g,'_'); a.click(); setTimeout(() => URL.revokeObjectURL(url),1000); }
function exportWork(d = writer) { if (!d.content.trim()) return toast('稿纸还是空白的，写一点再导出吧。'); download((d.title || '有术作品') + '.md', d.content); toast('已导出 Markdown 文件'); }
function backup() { persist(); download('有术工作室备份-' + new Date().toISOString().slice(0,10) + '.json', JSON.stringify({ version:1, exportedAt:new Date().toISOString(), ...db, conversations:cwStore },null,2), 'application/json'); toast('作品和收藏已打包导出'); }
async function importBackup(file) {
  if (!file) return;
  if (file.size > 8_000_000) return toast('备份文件过大，请选择 8 MB 以内的文件。');
  try {
    const data = JSON.parse(await file.text());
    if (data.version !== 1 || !Array.isArray(data.drafts) || !Array.isArray(data.favorites) || data.drafts.length > 2000) throw new Error();
    if (data.drafts.some(d => !d || typeof d.id !== 'string' || typeof d.content !== 'string' || typeof d.title !== 'string' || d.content.length > 300000 || !Number.isFinite(d.updatedAt))) throw new Error();
    const allowed = ['mode','topic','platform','style','length','content','title','origin','model'];
    const cleaned = data.drafts.map(d => ({...freshWriter(), ...Object.fromEntries(allowed.filter(k=>typeof d[k] === 'string').map(k=>[k,d[k]])), id:d.id, createdAt:Number(d.createdAt)||d.updatedAt, updatedAt:d.updatedAt}));
    const currentIds = new Set(db.drafts.map(d => d.id));
    db.drafts.push(...cleaned.filter(d => !currentIds.has(d.id)));
    db.drafts.sort((a,b)=>b.updatedAt-a.updatedAt);
    db.favorites = [...new Set([...db.favorites,...data.favorites.filter(id => articles.some(a=>a.id===id))])];
    if (data.writer && typeof data.writer.content === 'string' && data.writer.content.trim() && !db.drafts.some(d => d.id === data.writer.id)) {
      const w = {...freshWriter(), ...Object.fromEntries(allowed.filter(k=>typeof data.writer[k] === 'string').map(k=>[k,data.writer[k]])), id:uid(), createdAt:Date.now(), updatedAt:Date.now()};
      w.title ||= '导入的未完成稿纸'; db.drafts.unshift(w);
    }
    if(data.conversations)cwRestore(data.conversations);
    persist(); closeModal(); render(); toast('已合并导入，现有作品已保留。');
  } catch { toast('这不是有效的有术工作室备份文件。'); }
}
function searchModal() { showModal('找一找，你的文字', '<input class="search-modal-input" id="global-search" aria-label="搜索作品与灵感" placeholder="搜索作品、文章或关键词…" autofocus><div class="search-results" id="search-results"><p>输入关键词，同时查找你的作品与灵感文章。</p></div>'); $('#global-search').focus(); }
function searchResults(query) {
  if (!query.trim()) { $('#search-results').innerHTML='<p>输入关键词，同时查找你的作品与灵感文章。</p>'; return; }
  const rows = [...db.drafts.filter(d => (d.title+d.content).includes(query)).map(d=>({title:d.title, sub:'我的作品 · '+fmtDate(d.updatedAt),action:'open-draft',id:d.id})), ...articles.filter(a=>(a.title+(a.desc||'')).includes(query)).map(a=>({title:a.title,sub:'灵感文章 · '+a.category,action:'read',id:a.id}))];
  $('#search-results').innerHTML = rows.length ? rows.slice(0,30).map(r=>`<button class="search-result" data-action="${r.action}" data-id="${esc(r.id)}"><strong>${esc(r.title)}</strong><small>${esc(r.sub)}</small></button>`).join('') : '<p>没有找到相关文字，试试别的关键词。</p>';
}
document.addEventListener('click', async e => {
  if (e.target.closest('.skip')) { e.preventDefault(); $('#main').focus(); return; }
  if (innerWidth <= 760 && !e.target.closest('.sidebar') && !e.target.closest('[data-action="menu"]')) { $('#sidebar').classList.remove('open'); $('[data-action="menu"]').setAttribute('aria-expanded','false'); }
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;
  if(action==='logout'){try{await fetch('/api/auth/logout',{method:'POST',headers:status.csrf?{'X-CSRF-Token':status.csrf}:{}});}finally{location.replace('/account.html');}return;}
  if(action==='membership')return membershipPanel();
  if(action==='buy-membership')return buyMembership(el.dataset.plan,el);
  if(action==='membership-collapse'){location.hash='#home';return;}
  if(action==='bind-wechat'){location.href='/api/auth/wechat/start?mode=bind';return;}
  if(action==='close-modal'&&activePaymentPoll){clearTimeout(activePaymentPoll);activePaymentPoll=null;}
  if (action === 'menu') { $('#sidebar').classList.toggle('open'); el.setAttribute('aria-expanded',$('#sidebar').classList.contains('open')); return; }
  if (action === 'new') return newWork();
  if (action === 'mode') return newWork(el.dataset.mode);
  if (action === 'topic') return newWork('article',el.dataset.topic);
  if (action === 'home-category') { homeCategory=el.dataset.category; render(); return; }
  if (action === 'shuffle') { const cats=Object.keys(topics); homeCategory=cats[(cats.indexOf(homeCategory)+1)%cats.length]; render(); return; }
  if (action === 'guide') return guide();
  if (action === 'connection') return connection();
  if (action === 'settings') return settings();
  if (action === 'humanize-current') return wtOpen('humanize');
  if (action === 'view-humanize-source') return showModal('改写前的原稿', `<div class="article-full">${esc(writer.topic)}</div>`);
  if (action === 'humanizer-guide') return showModal('中文去 AI 味编辑原则', '<p>参考 Humanizer-zh 的中文编辑方法，减少空话、重复、机械节奏和宣传式表达。常见词和标点只是检查线索，有实际作用时会保留。</p><p>保留事实、数据、限定、归因、作者态度及文章结构，不虚构经历或补造例子；只输出修改稿。它改善表达，不判断作者身份，也不保证通过 AI 检测。</p><p>可粘贴原文，也可点击稿纸上的“去 AI 味”把当前作品转入编辑，原稿会先保存。</p>');
  if (['ai-save','ai-test','ai-models'].includes(action)) return aiAction(action);
  if (action === 'ai-preset') { $('#ai-model').value=el.dataset.model; return; }
  if (action === 'close-modal') return closeModal();
  if (action === 'start-from-modal') { closeModal(); return newWork(); }
  if (action === 'writer-mode') { writer.mode=el.dataset.mode; persist(); render(); return; }
  if (action === 'platform') { writer.platform=el.dataset.value; persist(); $$('.chips [data-action="platform"]').forEach(b=>{b.classList.toggle('active',b===el);b.setAttribute('aria-pressed',b===el);}); return; }
  if (action === 'generate') return generate();
  if (action === 'stop-workflow') { workflowController?.abort();return; }
  if (action === 'retry-humanize') { const source=currentWritingWorkflow()?.source;if(!source)return toast('原稿记录不存在，请从创作记录重新打开。');if(generating)return;return doGenerate({...source,autoHumanize:true}); }
  if (action === 'view-workflow-source') { const source=db.drafts.find(d=>d.id===el.dataset.id);if(!source)return toast('生成原稿已被移除。');return showModal('生成原稿 · 保留版本',`<div class="article-full">${esc(source.content)}</div><div class="modal-actions"><button class="btn" data-action="export-draft" data-id="${esc(source.id)}">导出原稿</button><button class="btn" data-action="close-modal">返回</button></div>`); }
  if (action === 'dismiss-workflow') { workflowProgress=null;const d=db.drafts.find(d=>d.id===writer.id);if(d?.automation&&d.automation.state!=='complete'){d.automation.state='dismissed';writer.automation={...d.automation};persist();}return render(); }
  if (action === 'read-link') return readReferenceLink();
  if (action === 'clear-topic') return clearTopicText();
  if (action === 'undo-clear-topic') return undoClearTopic();
  if (action === 'preview-reference') { showModal(writer.reference?.title||'已读取的文章正文',`<div class="article-full">${esc(writer.topic)}</div><div class="modal-actions"><button class="btn" data-action="close-modal">返回编辑</button></div>`); return; }
  if (action === 'generate-confirm') { if (!saveDraft(false)) return toast('当前作品保存失败，请先导出备份。'); writer={...writer,id:null,content:'',title:''}; persist(); closeModal(); return doGenerate(); }
  if (action === 'blank') { writer.content='\n'; writer.origin='自由书写'; persist(); $('#editor-area').innerHTML=editorArea(); $('#output').focus(); return; }
  if (action === 'save') return saveDraft();
  if (action === 'copy') { if (!writer.content.trim()) return toast('先写一点内容，再复制吧。'); try { await navigator.clipboard.writeText(writer.content); toast('正文已复制'); } catch { $('#output')?.select(); toast('请按 Ctrl+C 复制选中的正文。'); } return; }
  if (action === 'export-work') return exportWork();
  if (action === 'open-draft') { cancelLinkRead(); if (writer.content.trim() || writer.id) saveDraft(false); const d=db.drafts.find(d=>d.id===el.dataset.id); if (!d) return; writer={...d}; persist(); if ($('#modal').open) closeModal(); return go('write'); }
  if (action === 'export-draft') { const d=db.drafts.find(d=>d.id===el.dataset.id); if (d) exportWork(d); return; }
  if (action === 'delete-draft') { const d=db.drafts.find(d=>d.id===el.dataset.id); if (!d) return; showModal('移除这篇作品？', `<p>「${esc(d.title)}」将从本地创作记录中移除。你可以先导出备份。</p><div class="modal-actions"><button class="btn" data-action="export-draft" data-id="${esc(d.id)}">先导出</button><button class="btn" data-action="close-modal">取消</button><button class="btn danger" data-action="confirm-delete" data-id="${esc(d.id)}">移除作品</button></div>`); return; }
  if (action === 'confirm-delete') { db.drafts=db.drafts.filter(d=>d.id!==el.dataset.id); if (writer.id===el.dataset.id) writer=freshWriter(); persist(); closeModal(); render(); return toast('作品已移除'); }
  if (action === 'category') { category=el.dataset.category; loadLibrary(); return; }
  if(action==='library-time'){libraryTime=el.dataset.value;loadLibrary();return;}
  if(action==='library-more'){loadLibrary(false,true);return;}
  if(action==='refresh-library'){libraryPageNumber=1;loadLibrary(true);return;}
  if(action==='import-article'){showModal('导入公开文章',`<form id="article-import-form"><label class="field"><span class="field-label">文章链接</span><input name="url" type="url" required maxlength="2048" placeholder="粘贴虎嗅、公众号、头条或其他文章链接"><small>仅提取标题和短摘要，并保留原文链接；不会复制整篇正文。</small></label><p id="article-import-status" role="status"></p><div class="modal-actions"><button type="button" class="btn" data-action="close-modal">取消</button><button class="btn primary" type="submit">识别并加入文章库</button></div></form>`);return;}
  if (action === 'to-library') { if ($('#modal').open) closeModal(); return go('library'); }
  if (action === 'favorite') { const id=el.dataset.id; const saved=db.favorites.includes(id); db.favorites=saved?db.favorites.filter(a=>a!==id):[...db.favorites,id]; persist(); if (route==='library'||route==='favorites') $('#article-list').innerHTML=libraryResults(); toast(saved?'已取消收藏':'已收进你的灵感收藏'); return; }
  if (action === 'read') { const a=libraryArticles.find(a=>a.id===el.dataset.id); if(a?.url)window.open(a.url,'_blank','noopener,noreferrer'); return; }
  if (action === 'use-article') {
    if (generating) return toast('请等待当前创作完成后再导入文章。');
    const article = libraryArticles.find(a=>a.id===el.dataset.id);
    const url = articleUrlFromText(article?.url);
    if (!url) return toast('这篇文章缺少有效的原文链接，请查看来源并手动粘贴正文。');
    if (newWork('article', url)) {
      if (wtView !== 'write') cwSwitchView('write');
      scheduleLinkRead(true);
    }
    return;
  }
  if (action === 'backup') return backup();
  if (action === 'import') return $('#import-file').click();
  if (action === 'search') return searchModal();
});
document.addEventListener('submit',async e=>{if(e.target.id!=='password-change')return;e.preventDefault();const form=e.target,message=$('#password-message'),button=form.querySelector('button');button.disabled=true;message.textContent='正在更新…';try{const response=await fetch('/api/auth/password',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':status.csrf},body:JSON.stringify({currentPassword:form.elements.currentPassword.value,newPassword:form.elements.newPassword.value})});const result=await response.json();if(!response.ok)throw new Error(result.error||'密码更新失败。');status.csrf=result.csrf;form.reset();message.textContent='密码已更新，其他登录会话已退出。';}catch(error){message.textContent=error.message;}finally{button.disabled=false;}});
document.addEventListener('input', e => {
  const el=e.target;
  if (el.id==='auto-humanize') { writer.autoHumanize=el.checked;persist();const label=$('[data-action="generate"] span');if(label&&!generating&&status.configured)label.textContent=el.checked?'生成并自动去 AI 味':'开始生成';return; }
  if (el.id==='library-search') { filter=el.value; libraryPageNumber=1; clearTimeout(librarySearchTimer); librarySearchTimer=setTimeout(()=>loadLibrary(),350); return; }
  if (el.id==='history-search') { filter=el.value; $('#record-list').innerHTML=historyResults(); return; }
  if (el.id==='global-search') return searchResults(el.value);
  if (el.id==='topic') { writer.topic=el.value; if(!el.value.trim()||e.inputType==='insertFromPaste'||articleUrlFromText(el.value)===el.value.trim())writer.reference=null; $('#topic-count').textContent=el.value.length+' / 20000'; persist(); scheduleLinkRead(e.inputType==='insertFromPaste'); }
  if (el.id==='style') { writer.style=el.value; persist(); }
  if (el.id==='writer-model') { writer.model=el.value.trim(); persist(); }
  if (el.id==='length') { writer.length=el.value; persist(); }
  if (el.id==='output' || el.id==='work-title') {
    if (el.id==='output') { writer.content=el.value; $('#output-count').textContent=wordCount(el.value)+' 字'; }
    else writer.title=el.value;
    persist(); clearTimeout(autosaveTimer); $('#save-status').textContent='保存中…';
    autosaveTimer=setTimeout(()=>saveDraft(false),600);
  }
});
document.addEventListener('paste',e=>{if(e.target.id==='topic')queueMicrotask(()=>{const input=$('#topic');if(input){writer.topic=input.value;persist();scheduleLinkRead(true);}});});
document.addEventListener('change', e => { if(e.target.id==='import-file') importBackup(e.target.files[0]); if(e.target.id==='library-sort'){librarySort=e.target.value;libraryPageNumber=1;loadLibrary();} });
document.addEventListener('submit',async e=>{if(e.target.id!=='article-import-form')return;e.preventDefault();const form=e.target,button=form.querySelector('[type="submit"]'),message=$('#article-import-status');button.disabled=true;message.textContent='正在读取公开文章信息…';try{const response=await fetch('/api/library/imports',{method:'POST',headers:{'Content-Type':'application/json',...(status.csrf?{'X-CSRF-Token':status.csrf}:{})},body:JSON.stringify({url:form.elements.url.value.trim()}),signal:AbortSignal.timeout(30000)}),data=await response.json();if(!response.ok)throw new Error(data.error||'识别失败');libraryArticles=[data.article,...libraryArticles.filter(a=>a.id!==data.article.id)];articles=libraryArticles;libraryError='';closeModal();filter='';category='全部';if(route!=='library')location.hash='library';else render();toast(data.duplicate?'这篇文章已在文章库中':'文章识别成功，已加入文章库');}catch(error){message.textContent=error.message||'识别失败，请检查链接后重试。';}finally{button.disabled=false;}});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='k') {e.preventDefault();searchModal();}
  if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='s' && route==='write') {e.preventDefault();saveDraft();}
  if (e.key==='Escape') { $('#sidebar').classList.remove('open'); $('[data-action="menu"]').setAttribute('aria-expanded','false'); }
  if ((e.key==='Enter'||e.key===' ') && e.target.matches('[role="button"][data-action]')) { e.preventDefault(); e.target.click(); }
});
window.addEventListener('hashchange', () => { if(writer.content.trim() || writer.id) saveDraft(false); filter=''; category='全部'; render(); window.scrollTo({top:0,behavior:'instant'}); });
window.addEventListener('pagehide', () => { if (writer.content.trim() || writer.id) saveDraft(false); else persist(); });
$('#modal').addEventListener('click', e => { if(e.target===$('#modal')) {const r=$('#modal').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)closeModal();} });
hydrateIcons();
fetch('/api/status').then(r=>{if(!r.ok)throw new Error();return r.json();}).then(async data=>{status=data;if(status.authRequired&&!status.authenticated){location.replace('/account.html');return;}if(status.authRequired&&status.user?.id){cloudReady=false;storageKey='youshu-studio-v1:'+status.user.id;const local=JSON.parse(localStorage.getItem(storageKey)||'null');db=local&&Array.isArray(local.drafts)&&Array.isArray(local.favorites)?{drafts:local.drafts,favorites:local.favorites,writer:{...freshWriter(),...local.writer}}:{drafts:[],favorites:[],writer:freshWriter()};writer=db.writer;if(typeof cwUseAccount==='function')cwUseAccount(status.user.id);const remote=await fetch('/api/account/data');if(!remote.ok)throw new Error('云端作品同步失败。');const saved=await remote.json();cloudRevision=saved.updatedAt??null;cloudReady=true;if(saved.data&&Array.isArray(saved.data.drafts)&&Array.isArray(saved.data.favorites)){db={drafts:saved.data.drafts,favorites:saved.data.favorites,writer:{...freshWriter(),...saved.data.writer}};writer=db.writer;if(typeof cwUseAccount==='function')cwUseAccount(status.user.id,saved.data.conversations);localStorage.setItem(storageKey,JSON.stringify(db));}else{persist();cloudSave();}}serviceState();render();if(new URLSearchParams(location.search).get('wechat')==='bound')toast('微信账号已安全绑定。');if(new URLSearchParams(location.search).get('wechat')==='login')toast('已通过微信授权登录。');if(route==='write'&&articleUrlFromText(writer.topic))scheduleLinkRead();}).catch(()=>{$('#service-state').innerHTML='<i></i>云端服务暂不可用';render();});
