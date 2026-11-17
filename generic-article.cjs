'use strict';
const {JSDOM} = require('jsdom');
const {Readability} = require('@mozilla/readability');
const {cleanArticleText, pruneArticleDom} = require('./article-cleaner.cjs');
const MAX_TEXT = 20000;
const CONTENT_SELECTOR = '#js_content, article.tt-article-content, article.syl-article-base, #article-content, .article__content, .article-content-inner, .article-body, .article_detail__content, .rich_media_content, [itemprop="articleBody"], .entry-content, .post-content, .news-content, .TRS_Editor';
const JUNK_SELECTOR = 'script, style, noscript, iframe, svg, canvas, template, nav, footer, aside, form, button, [hidden], [aria-hidden="true"], .comments, #comments, .comment-list, .related-articles, .recommend-list, .advertisement, .ad-container, .share-buttons';
const compact = value => String(value || '').replace(/\s/g, '');

function textOf(node, body=false) {
  if (!node) return '';
  const clone = node.cloneNode(true);
  if(body)clone.querySelectorAll('h1').forEach(n=>n.remove());
  const hadReferences = body && pruneArticleDom(clone);
  clone.querySelectorAll(JUNK_SELECTOR).forEach(n=>n.remove());
  clone.querySelectorAll('[style]').forEach(n=>{if(/display\s*:\s*none|visibility\s*:\s*hidden/i.test(n.getAttribute('style')))n.remove();});
  clone.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));
  clone.querySelectorAll('p,div,section,article,h1,h2,h3,h4,h5,h6,li,blockquote,pre,tr').forEach(n=>{n.prepend('\n');n.append('\n');});
  const text=clone.textContent.replace(/[\t\u00a0\u3000 ]+/g, ' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  return body ? cleanArticleText(text,{hadReferences}) : text;
}

function parseGenericArticle(html, pageUrl) {
  // No runScripts/resources options: source-page JavaScript never runs in the server process.
  const dom = new JSDOM(html, {url:pageUrl});
  try {
    const document = dom.window.document;
    const meta = key => document.querySelector(`meta[property="${key}"],meta[name="${key}"]`)?.content?.trim() || '';
    const structured = [];
    const visit = (value, depth=0) => {
      if (!value || typeof value!=='object' || depth>12 || structured.length>1000) return;
      if (Array.isArray(value)) {for (const row of value) visit(row,depth+1);return;}
      if ([value['@type']].flat().some(type=>/^(?:Article|NewsArticle|BlogPosting|TechArticle|Report|ScholarlyArticle|SocialMediaPosting)$/.test(type))) structured.push(value);
      for (const key of ['@graph','mainEntity','hasPart']) visit(value[key],depth+1);
    };
    for (const node of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {visit(JSON.parse(node.textContent));} catch {}
    }
    const data = structured.find(row=>typeof row.articleBody==='string' && compact(row.articleBody).length>=80) || structured[0];
    const pageTitle = document.title.trim();
    let title = textOf(document.querySelector('h1')) || meta('og:title') || meta('twitter:title') || pageTitle || data?.headline || '';
    if (/^(?:服务提示|安全验证|访问验证|页面不存在|页面未找到|系统错误|access denied|just a moment|attention required|error\b|404\b|403\b)/i.test(title)) throw Object.assign(new Error('文章网站返回了验证或错误页面，未取得正文。请打开原文核实后重试。'), {status:422});
    title = title.replace(/\s*[-_|｜]\s*(?:虎嗅网|果壳(?:\s*科技有意思)?|今日头条|微信公众号|微信公众平台).*$/,'').trim().slice(0,180);
    const authorData = [data?.author].flat().filter(Boolean).map(a=>typeof a==='string'?a:a.name).filter(Boolean).join('、');
    const author = authorData || meta('author') || meta('article:author');
    const source = author || meta('og:site_name') || new URL(pageUrl).hostname;
    const partial = structured.some(row=>row.isAccessibleForFree===false || row.isAccessibleForFree==='False') ||
      [...document.querySelectorAll('[class*="paywall"], [class*="subscribe-wall"], [class*="paid-content"]')].some(n=>/订阅|付费|购买|subscribe|purchase/i.test(n.textContent));
    let content = '';
    // Prefer the visible full article over structured data, which can contain only an SEO summary.
    for (const node of document.querySelectorAll(CONTENT_SELECTOR)) {
      const text = textOf(node,true);
      if (compact(text).length>=80 && text.length>content.length) content=text;
    }
    if (!content) {
      document.querySelectorAll(JUNK_SELECTOR).forEach(n=>n.remove());
      const readable = new Readability(document.cloneNode(true), {charThreshold:100, maxElemsToParse:60000, disableJSONLD:true}).parse();
      if (readable?.content) {
        const fragment = JSDOM.fragment(readable.content);
        content = textOf(fragment,true);
        if (!title) title=readable.title;
      }
    }
    if (compact(content).length<80 && typeof data?.articleBody==='string') content = /<(?:p|div|br)\b/i.test(data.articleBody) ? textOf(JSDOM.fragment(data.articleBody),true) : data.articleBody.trim();
    content=cleanArticleText(content,{title});
    if (!title || compact(content).length<80) throw Object.assign(new Error('未定位到这篇文章的正文，页面可能需要动态加载。'), {status:422});
    const truncated = content.length > MAX_TEXT;
    content = content.slice(0,MAX_TEXT).trim();
    return {title, source:String(source).slice(0,180), url:pageUrl, content, chars:compact(content).length, truncated, ...(partial?{partial:true,notice:'仅提取当前公开可见的内容，付费或登录部分未读取。'}:{})};
  } finally {dom.window.close();}
}
module.exports = {parseGenericArticle, CONTENT_SELECTOR};
