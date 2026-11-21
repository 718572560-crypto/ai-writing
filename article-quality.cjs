'use strict';
const fs = require('node:fs');
const path = require('node:path');

const articleSkill = fs.readFileSync(path.join(__dirname,'skills','article-editor-zh','SKILL.md'),'utf8')
  .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/,'').trim();
const articleRewriteRules = '这是文章流程的终稿。保留原稿的切入点、给读者的具体判断或行动、短引及归属、数字写法、限定和链接；不能把来源观点抹成无归因断言，也不能添加新链接、数字、例子或经历。标题文字保持原样，保留标题中已有的人物处境和生活细节。结尾已有的具体互动问题须保留问题指向，不把它当客服腔删掉；没有互动时不追加。只去掉真的空转和重复，不为追求流畅而稀释信息。';

function normalized(text) {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
}

function referenceDetails(reference) {
  if (!reference || typeof reference !== 'object') return null;
  if (typeof reference.url !== 'string' || reference.url.length > 3000) return null;
  let url;
  try { url = new URL(reference.url); } catch { return null; }
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password) return null;
  const field = (value,limit) => typeof value === 'string' ? value.trim().slice(0,limit) : '';
  return {title:field(reference.title,200),source:field(reference.source,100),url:url.href};
}

function articleError(message,status=422) {
  throw Object.assign(new Error(message),{status});
}

function checkGeneratedArticle(content, reference, sourceText) {
  const supplement = content.trim().match(/^【需要补充素材】[ \t]*(?=\r?\n|$)([\s\S]*)/u);
  if (supplement) {
    const questions = supplement[1].trim().slice(0,360).replace(/\s+/gu,' ');
    articleError('这篇文章还需要素材：'+(questions || '请补充你掌握的事实、过程或可核对的来源。'));
  }
  checkRepeatedParagraphs(content);
  if (!reference) return;
  const draft = normalized(content), material = normalized(sourceText);
  // Match substantial verbatim passages after removing formatting, while allowing brief quotes.
  const size = 48;
  let copied = 0;
  for (let i=0; i+size<=draft.length;) {
    if (material.includes(draft.slice(i,i+size))) { copied+=size; i+=size; }
    else i+=8;
  }
  if (copied>=size*2 && copied/draft.length>=0.3)
    articleError('草稿大段沿用了参考原文，未保存。请补充你自己的观察、对比或分析角度后重试。');
  const [links] = evidenceMarkers(content);
  if (!links.has(reference.url))
    articleError('草稿漏掉了已读取文章的来源链接，未保存。请重试生成或改用你自己的材料。');
}

function checkRepeatedParagraphs(content) {
  const seen = new Set();
  for (const paragraph of content.split(/\n\s*\n/u).map(normalized)) {
    if (paragraph.length<36) continue;
    if (seen.has(paragraph)) articleError('草稿出现大段重复，未保存。请缩小主题范围或补充更具体的材料后重试。');
    seen.add(paragraph);
  }
}

function evidenceMarkers(text) {
  const normalizedText = text.normalize('NFKC');
  const urlPattern = /https?:\/\/[^\s<>\p{Script=Han}\[\]{}"'`“”‘’，。；、]+/gu;
  const urls = [...normalizedText.matchAll(urlPattern)].map(([url])=>url.replace(/[).,;!?]+$/u,''));
  const withoutUrls = normalizedText.replace(urlPattern,'').replace(/^\s*(?:[-*+]\s*)?\d+[.)、](?=\s)/gmu,'');
  const numbers = [...withoutUrls.matchAll(/\d+(?:[.,]\d+)*(?:\s*[%‰])?/gu)].map(([number])=>number.replace(/[\s,]/gu,''));
  return [new Set(urls),new Set(numbers)];
}

function checkArticleRewrite(source, rewrite) {
  const before=evidenceMarkers(source),after=evidenceMarkers(rewrite);
  if (before.some((markers,i)=>markers.size!==after[i].size || [...markers].some(marker=>!after[i].has(marker))))
    articleError('改稿改变了原稿中的数字或来源链接，改稿未保存。原稿仍在，可检查原稿或仅重试去 AI 味。');
}

module.exports = {articleSkill,articleRewriteRules,referenceDetails,checkGeneratedArticle,checkArticleRewrite};
