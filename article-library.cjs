const fs = require('node:fs');
const path = require('node:path');
const { fetchArticle, normalizeArticleUrl } = require('./link-extractor.cjs');

const API = 'https://qdaiyoushu.com/api/article-library';
const CACHE_TTL = 15 * 60 * 1000;
const MAX_PAGE = 10000;
const CATEGORIES = new Set(['全部','热点','财经','科技','AI','体育','娱乐','历史','军事','国际','社会','三农','美食','旅游','文化','情感','育儿','教育','职场','健康','养老','房产','汽车']);
const TIMES = new Set(['today','2days','3days']);
const TIME_ZONE = process.env.ARTICLE_LIBRARY_TIMEZONE || 'Asia/Shanghai';
const SORTS = new Set(['hot','latest','rewrites']);
const clean = (value, limit = 240) => String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);

function decodeXml(value = '') {
  return String(value).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n))).replace(/&#x([\da-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16))).replace(/\s+/g, ' ').trim();
}

function xmlTag(block, tag) {
  const match = block.match(new RegExp(`<(?:(?:\\w+):)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:(?:\\w+):)?${tag}\\s*>`, 'i'));
  return match ? decodeXml(match[1]) : '';
}

function parseFeed(text, sourceName, sourceUrl) {
  const input = String(text || '');
  let rows = [];
  if (/^\s*\{/.test(input) || /^\s*\[/.test(input)) {
    const data = JSON.parse(input);
    const raw = Array.isArray(data) ? data : (data.items || data.articles || data.data || []);
    if (!Array.isArray(raw)) throw new Error('JSON 订阅源缺少 items / articles 数组');
    rows = raw.map(item => ({ title:item.title || item.name, summary:item.summary || item.description || item.content_text || item.content, url:item.url || item.external_url || item.link, timestamp:item.date_published || item.pubDate || item.published || item.timestamp, source:item.source || sourceName, domain:item.category || item.domain || '热点' }));
  } else {
    const blocks = [...input.matchAll(/<(item|entry)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi)].map(match => match[2]);
    rows = blocks.map(block => {
      const linkTag = block.match(/<link\b([^>]*)\/?\s*>/i);
      const href = linkTag?.[1]?.match(/\bhref=["']([^"']+)["']/i)?.[1];
      return { title:xmlTag(block,'title'), summary:xmlTag(block,'description') || xmlTag(block,'summary') || xmlTag(block,'content'), url:href || xmlTag(block,'link'), timestamp:xmlTag(block,'pubDate') || xmlTag(block,'published') || xmlTag(block,'updated'), source:sourceName, domain:xmlTag(block,'category') || '热点' };
    });
  }
  return rows.map(item => {
    let link = '';
    try { link = normalizeArticleUrl(new URL(String(item.url || ''), sourceUrl).href).href; } catch {}
    if (!link) return null;
    const row = normalizeArticle({ ...item, id:`feed-${link}`, source:item.source || sourceName, url:link });
    return row ? { ...row, source:clean(item.source || sourceName,60) } : null;
  }).filter(Boolean);
}

function configuredFeeds(raw = process.env.ARTICLE_LIBRARY_FEEDS || '') {
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map((feed, index) => ({ name:clean(feed?.name || `公开订阅源 ${index + 1}`,60), url:String(feed?.url || '').trim() }))
      .filter(feed => {
        try { const url = new URL(feed.url); return url.protocol === 'https:' && !url.username && !url.password && !/^(localhost|.*\.local|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(url.hostname); } catch { return false; }
      });
  } catch { return []; }
}

function dateKey(value, timeZone = TIME_ZONE) {
  const date = value instanceof Date ? value : new Date(value);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year:'numeric', month:'2-digit', day:'2-digit' }).formatToParts(date);
    const part = Object.fromEntries(parts.map(item => [item.type, item.value]));
    return `${part.year}-${part.month}-${part.day}`;
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function shanghaiTime(value, timeZone = TIME_ZONE) {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour:'2-digit', minute:'2-digit', hourCycle:'h23' }).format(new Date(value));
}

function shouldRefreshDaily(value, refreshedAt, timeZone = TIME_ZONE) {
  if (shanghaiTime(value, timeZone) < '08:00') return false;
  return !refreshedAt || dateKey(refreshedAt, timeZone) !== dateKey(value, timeZone) || shanghaiTime(refreshedAt, timeZone) < '08:00';
}

function excerpt(text, limit = 190) {
  const value = String(text || '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return value.length > limit ? `${value.slice(0, limit).trimEnd()}…` : value;
}

const ANGLES = {
  '科技': ['技术变化会怎样影响普通人的工作与生活？', '把热点放回具体场景：谁会先受影响，谁能从中受益？'],
  '财经': ['从数字变化追问行业和普通人的真实感受。', '关注趋势如何传导到就业、消费与个人决策。'],
  '社会': ['从个体遭遇延伸到背后的公共议题与现实处境。', '多问一步：事件为何发生，现有规则能否回应？'],
  '教育': ['从学生、家长与老师的不同处境切入，讨论改变是否可行。', '把争议落到具体的学习场景和可执行做法。'],
  '职场': ['从职场人的实际选择出发，梳理变化带来的机会与代价。', '聚焦普通从业者可以采取的下一步行动。'],
  '健康': ['将热点转成可核实、可执行的健康信息，并提醒适用边界。', '从日常习惯与专业建议之间的差距展开。'],
  '情感': ['观察关系中的真实需求和沟通方式，避免简单贴标签。', '从当事人的选择与边界感讨论关系议题。'],
  '文化': ['从一个文化现象追问它为何在当下引发共鸣。', '联系生活经验，讨论传统与当代表达如何相遇。'],
  '热点': ['先核实事实，再观察事件对不同人群意味着什么。', '从具体细节出发，呈现热点背后的真实问题。']
};

function curateArticle(title, desc, category) {
  const sourceTitle = clean(title, 180);
  const sourceDesc = excerpt(desc, 140);
  const prompts = ANGLES[category] || ANGLES['热点'];
  const writingAngle = prompts[(sourceTitle.length + sourceDesc.length) % prompts.length];
  const inspirationTitle = sourceTitle.replace(/[【】\[\]]/g, '').replace(/[！!。]+$/g, '').trim();
  const inspirationDesc = sourceDesc
    ? `这条热点提供了一个观察入口。${sourceDesc} 写作时可以继续追问：${writingAngle}`
    : `围绕「${inspirationTitle}」补充可核实的事实与当事人视角，再讨论：${writingAngle}`;
  return { inspirationTitle, inspirationDesc, writingAngle, writingPrompt: `请围绕「${inspirationTitle}」写一篇面向普通读者的文章。切入角度：${writingAngle} 先核实来源中的事实，区分事实与观点，不补造细节。` };
}

function normalizeArticle(item, rank = 0) {
  const rawCover = String(item.cover_image || item.cover || item.image_url || '');
  let cover = '';
  try {
    const parsed = new URL(rawCover.startsWith('/') ? `https://qdaiyoushu.com${rawCover}` : rawCover);
    if (parsed.protocol === 'https:' && parsed.hostname === 'qdaiyoushu.com' && parsed.pathname.startsWith('/api/article-library/cover')) cover = parsed.href;
  } catch {}
  let url = '';
  try {
    url = normalizeArticleUrl(String(item.url || item.source_url || item.original_url || item.link || '')).href;
  } catch {}
  const title = clean(item.title, 180);
  if (!title) return null;
  const category = CATEGORIES.has(clean(item.domain, 30)) ? clean(item.domain, 30) : '热点';
  const desc = excerpt(item.summary || item.description || item.content || '', 140);
  const curated = curateArticle(title, desc, category);
  return {
    id: clean(item.id || url || title, 120), title,
    desc, ...curated, sourceTitle:title, sourceDesc:desc,
    category,
    source: clean(item.source || '公开文章源', 60), url, cover,
    timestamp: clean(item.timestamp || '', 40), time: clean(item.time || '', 40),
    views: Number.isFinite(Number(item.views)) ? Math.max(0, Number(item.views)) : null,
    likes: Number.isFinite(Number(item.likes)) ? Math.max(0, Number(item.likes)) : null,
    comments: Number.isFinite(Number(item.comments)) ? Math.max(0, Number(item.comments)) : null,
    rewriteCount: Number.isFinite(Number(item.rewrite_count)) ? Math.max(0, Number(item.rewrite_count)) : null,
    imported: !!item.imported, rank
  };
}

function createArticleLibrary({ dataDir = path.join(__dirname, 'data'), fetchImpl = fetch, readArticle = fetchArticle, now = Date.now, cacheTtl = CACHE_TTL, schedule = true, feeds = configuredFeeds() } = {}) {
  const file = path.join(dataDir, 'article-library.json');
  const queries = new Map();
  const inFlight = new Map();
  let feedCache = { at:0, articles:[], statuses:[] };
  let imports = [];
  let dailyRefreshedAt = null;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    imports = Array.isArray(saved.imports) ? saved.imports.map(item => normalizeArticle(item)).filter(Boolean).slice(0, 250) : [];
    dailyRefreshedAt = saved.dailyRefreshedAt || null;
    for (const row of saved.queries || []) if (row && row.key && row.value) queries.set(row.key, row.value);
  } catch {}
  function persist() {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const rows = [...queries.entries()].slice(-60);
      const temp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ version: 1, savedAt: new Date(now()).toISOString(), dailyRefreshedAt, imports, queries: rows }));
      fs.renameSync(temp, file);
    } catch (error) { console.error('文章库缓存保存失败：' + error.message); }
  }
  function queryOf(raw = {}) {
    const page = Math.max(1, Math.min(MAX_PAGE, Math.trunc(Number(raw.page) || 1)));
    const perPage = Math.max(1, Math.min(30, Math.trunc(Number(raw.per_page) || 20)));
    const time = TIMES.has(raw.time) ? raw.time : 'today';
    const sort = SORTS.has(raw.sort) ? raw.sort : 'hot';
    const domain = CATEGORIES.has(clean(raw.domain, 30)) ? clean(raw.domain, 30) : '全部';
    const keyword = clean(raw.keyword, 100);
    return { page, perPage, time, sort, domain, keyword };
  }
  function keyOf(q) { return [q.time,q.domain,q.sort,q.keyword.toLocaleLowerCase(),q.page,q.perPage].join('|'); }
  async function loadFeeds(force = false) {
    if (!force && now() - feedCache.at < cacheTtl) return feedCache;
    const settled = await Promise.all(feeds.map(async feed => {
      try {
        const response = await fetchImpl(feed.url, { headers:{ Accept:'application/rss+xml, application/atom+xml, application/feed+json, application/json, text/xml;q=0.9, */*;q=0.5', 'User-Agent':'YoushuStudio/1.0 (+public feed reader)' }, signal:AbortSignal.timeout(10000), redirect:'error' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const type = response.headers?.get?.('content-type') || '';
        if (/html/i.test(type)) throw new Error('返回网页而非订阅数据');
        const text = await response.text();
        if (text.length > 2_000_000) throw new Error('订阅内容超过 2 MB');
        return { name:feed.name, articles:parseFeed(text,feed.name,feed.url), ok:true };
      } catch (error) { return { name:feed.name, articles:[], ok:false, error:clean(error.message,100) }; }
    }));
    const successful = settled.filter(result => result.ok);
    if (successful.length || !feedCache.at) feedCache = { at:now(), articles:successful.flatMap(result => result.articles), statuses:settled.map(({name,ok,error})=>({name,ok,error:error||''})) };
    return feedCache;
  }
  async function request(q) {
    const key = keyOf(q);
    if (inFlight.has(key)) return inFlight.get(key);
    const pending = (async () => {
    const params = new URLSearchParams({ page:String(q.page), per_page:String(q.perPage), time:q.time, sort:q.sort });
    if (q.domain !== '全部') params.set('domain', q.domain);
    if (q.keyword) params.set('keyword', q.keyword);
    let data = null, platformError = '';
    try {
      const response = await fetchImpl(`${API}?${params}`, { headers: { Accept: 'application/json', 'User-Agent': 'YoushuStudio/1.0 (public article metadata)' }, signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error(`平台聚合源返回 ${response.status}`);
      data = await response.json();
      if (!data || !Array.isArray(data.articles)) throw new Error('平台聚合源数据格式暂不可用');
    } catch (error) { platformError = clean(error.message,100); }
    const feedResult = await loadFeeds(q.time === 'today' && q.page === 1 && q.sort === 'hot');
    const platformArticles = (data?.articles || []).map((item,index) => normalizeArticle(item,(q.page - 1) * q.perPage + index + 1)).filter(item => item && item.url);
    const cutoff = q.time === 'today' ? 24 : q.time === '2days' ? 48 : 72;
    const feedArticles = feedResult.articles.filter(item => {
      const age = item.timestamp ? (now() - Date.parse(item.timestamp)) / 3600000 : 0;
      return (!Number.isFinite(age) || age <= cutoff) && (q.domain === '全部' || item.category === q.domain) && (!q.keyword || `${item.title} ${item.desc} ${item.source}`.toLocaleLowerCase().includes(q.keyword.toLocaleLowerCase()));
    });
    const unique = new Map();
    for (const item of [...platformArticles, ...feedArticles]) unique.set(item.url || item.title, item);
    const merged = [...unique.values()];
    if (!merged.length) throw Object.assign(new Error(platformError || '当前没有可用的公开文章源。'), { status:502 });
    const total = Math.max(0, Number(data?.total) || platformArticles.length) + feedArticles.length;
    const articles = q.page === 1 ? merged.slice(0,q.perPage) : merged.slice((q.page - 1) * q.perPage,q.page * q.perPage);
    const value = {
      articles, total, page:q.page, perPage:q.perPage,
      hasMore: !!data?.has_more || total > q.page * q.perPage, domains: Array.isArray(data?.domains) ? [...new Set([...data.domains.filter(x => CATEGORIES.has(clean(x,30))),...feedArticles.map(item=>item.category)])] : [...CATEGORIES],
      sources: [{name:'今日头条等平台聚合源',ok:!!data,error:platformError},...feedResult.statuses],
      cachedAt: new Date(now()).toISOString(), dailyRefreshedAt: null
    };
    queries.set(keyOf(q), value);
    if (q.time === 'today' && q.page === 1 && q.sort === 'hot' && q.domain === '全部' && !q.keyword && shanghaiTime(now(), TIME_ZONE) >= '08:00') {
      dailyRefreshedAt = value.cachedAt;
      value.dailyRefreshedAt = dailyRefreshedAt;
    }
    persist();
    return value;
    })().finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
    return pending;
  }
  async function list(raw = {}, { refresh = false } = {}) {
    const q = queryOf(raw), key = keyOf(q), cached = queries.get(key);
    if (!refresh && cached && now() - Date.parse(cached.cachedAt) < cacheTtl) return { ...cached, stale: false, dailyRefreshedAt };
    try { return { ...await request(q), stale: false, dailyRefreshedAt }; }
    catch (error) {
      if (cached) return { ...cached, stale: true, dailyRefreshedAt, refreshError: '在线内容暂时无法刷新，当前显示上次缓存。' };
      throw error;
    }
  }
  async function refreshDaily() { feedCache.at=0; return list({ time:'today', sort:'hot', page:1, per_page:20 }, { refresh:true }); }
  async function listImports() { return { articles: imports.slice(), count: imports.length }; }
  async function addImport(url, { ip = '' } = {}) {
    let normalized = String(url || '').trim();
    if (!normalized || normalized.length > 2048) throw Object.assign(new Error('请粘贴有效的文章链接。'), { status:400 });
    normalized = normalizeArticleUrl(normalized).href;
    const previous = imports.find(item => item.url === normalized);
    if (previous) return { article: previous, duplicate:true };
    const article = await readArticle(normalized);
    const category = CATEGORIES.has(clean(article.domain || article.category,30)) ? clean(article.domain || article.category,30) : '热点';
    const row = normalizeArticle({ id:`import-${Buffer.from(normalized).toString('base64url').slice(0,48)}`, title:article.title, content:article.content, source:article.source, url:article.url || normalized, timestamp:new Date(now()).toISOString(), domain:category, imported:true });
    if (!row) throw Object.assign(new Error('未能从链接中识别文章标题。'), { status:422 });
    row.desc = excerpt(article.content, 140);
    row.contentChars = Math.max(0, Number(article.chars) || String(article.content || '').length);
    row.importedAt = new Date(now()).toISOString();
    row.source = clean(article.source || new URL(normalized).hostname,60);
    imports = [row, ...imports.filter(item => item.url !== row.url)].slice(0,250);
    persist();
    return { article:row, duplicate:false };
  }
  if (schedule) {
    const refresh = () => { refreshDaily().catch(error => console.error('每日文章更新失败：' + error.message)); };
    const needsTodayRefresh = () => shouldRefreshDaily(now(), dailyRefreshedAt, TIME_ZONE);
    if (needsTodayRefresh()) setTimeout(refresh, 1500).unref?.();
    // Check periodically instead of relying on the server's local timezone or a single long timer.
    // This also catches up after sleep, deployment restarts, or a missed timer.
    const timer = setInterval(() => { if (needsTodayRefresh()) refresh(); }, 60 * 1000);
    timer.unref?.();
  }
  return { list, listImports, addImport, refreshDaily, queryOf };
}

module.exports = { createArticleLibrary, normalizeArticle, excerpt, dateKey, curateArticle, shouldRefreshDaily, CATEGORIES, TIMES, SORTS };
