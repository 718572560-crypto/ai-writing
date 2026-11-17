'use strict';

const REFERENCE_HEADING = /^(?:#{1,6}\s*)?(?:参考(?:文献|资料|来源|链接)|资料来源|引用(?:资料|文献)|references|bibliography|endnotes|footnotes)\s*[:：]?$/i;
const BODY_HEADING = /^(?:#{1,6}\s*)?(?:结语|结论|总结|后记|正文|讨论|写在最后|conclusion|discussion)\s*[:：]?$/i;
const NUMBERED_REFERENCE = /^\s*(?:\[\d{1,3}\]|【\d{1,3}】|\d{1,3}[.、)])\s*\S/;
const REFERENCE_DETAIL = /(?:[（(](?:19|20)\d{2}[a-z]?[)）]|Retrieved\b|https?:\/\/|出版社|统计年鉴|统计公报|\bdoi\b|\bISBN\b|\bet al\b)/i;
const BIBLIOGRAPHIC_ROW = /(?:[.．。]\s*[（(](?:19|20)\d{2}[a-z]?[)）]|Retrieved\b|\bdoi\s*[:：]|\bISBN\s*[:：\d])/i;
const RETRIEVAL = /^(?:Retrieved\b|Accessed\b|Available\s+(?:at|from)\b|https?:\/\/\S+\s*$)/i;
const METADATA = /^(?:来源|转载来源|文章来源|作者|撰文|文案|编辑|责编|责任编辑|校对|审核|发布时间|更新于|阅读量|浏览量|原标题|原文标题|题图(?:来自)?|封面图?|供图|摄影|图片来源|图源|图片版权|制图|配图|插画|视频来源)\s*[:：]/;
const REPRINT = /^(?:本文(?:来自|转载自|首发于|经.{0,20}授权转载|由.{0,40}授权)|未经授权.{0,15}转载|版权归.{0,60}所有|如需(?:转载|二次转载)|转载(?:请|须|需)|Copyright\s*(?:©|\(c\)))/i;
const PROMOTION = /^(?:点(?:个|一下)?\s*[“"「『]?(?:小)?(?:爱心|赞|在看)|(?:欢迎|记得|别忘了|请|求)?\s*(?:点赞|点个赞|点在看|一键三连)|关注(?:我们|本公众号|公众号|作者|AI有术)|(?:长按|扫描|识别).{0,40}(?:二维码|关注)|(?:工具链接|工具服务号|商务合作|投稿邮箱|公众号\s*ID|微信号)\s*[:：]|[⬇️👇]{2,})/;
const PHOTO_CREDIT = /^(?:图片|图源|摄影|图注|图片来源|photo(?:graph)?\s*(?:credit|by)|image\s*(?:credit|source))\s*[:：]|[丨|｜]\s*(?:图虫创意|视觉中国|摄图网|IC\s*photo|Getty\s*Images?|Unsplash|Pexels|Pixabay|VCG)(?:\s*[（(][^\n]*[)）])?\s*$/i;
const EXTRA_SELECTOR = 'figcaption, .image-caption, .img-caption, .photo-caption, .pic-caption, .picture-caption, .article__reprinted-explain, .article__reprinted-explain-app, .article-copyright, .copyright-notice, .author-bio, .author-card, .related-articles, .related-posts, .recommend-list, .comment-list, .comments, #comments, .share-buttons, .follow-card, .qrcode, .qr-code, [role="doc-bibliography"], [role="doc-endnotes"], .reference-list, #references, .references, .bibliography, .footnotes, [role="doc-noteref"], a.footnote-ref, a[href^="#fn"], sup.reference';

function isNoise(line) {
  return line.length<=500 && (METADATA.test(line) || REPRINT.test(line) || PHOTO_CREDIT.test(line) || line.length<=180 && PROMOTION.test(line));
}

function pruneArticleDom(root) {
  let hadReferences = false;
  for (const node of root.querySelectorAll(EXTRA_SELECTOR)) {
    if (/reference|bibliography|endnote|footnote/.test(`${node.className} ${node.id} ${node.getAttribute('role')}`)) hadReferences=true;
    node.remove();
  }
  // A figure's caption has no useful text without its image. Tables and narrative blocks remain.
  for (const node of root.querySelectorAll('figure')) if (node.querySelector('img, video') && !node.querySelector('table')) node.remove();
  return hadReferences;
}

function cleanArticleText(input, {hadReferences=false} = {}) {
  const lines = String(input || '').replace(/\r\n?/g,'\n').split('\n');
  const removed = new Set();
  const nonemptyAfter = index => lines.slice(index+1).map(s=>s.trim()).filter(Boolean);
  for (let i=0;i<lines.length;i++) {
    const line=lines[i].trim();
    if (!REFERENCE_HEADING.test(line)) continue;
    const following=nonemptyAfter(i);
    if (!following.some(s=>NUMBERED_REFERENCE.test(s) || REFERENCE_DETAIL.test(s))) continue;
    hadReferences=true;removed.add(i);
    for(let j=i+1;j<lines.length;j++) {
      // Some articles continue with a conclusion after their bibliography.
      if(BODY_HEADING.test(lines[j].trim())){i=j;break;}
      removed.add(j);
    }
  }
  // Plain numbered bibliographies may have no heading. Require multiple bibliographic
  // entries and a tail consisting entirely of references, credits or boilerplate.
  for(let i=0;i<lines.length;i++) {
    if(removed.has(i)||!NUMBERED_REFERENCE.test(lines[i].trim())||!BIBLIOGRAPHIC_ROW.test(lines[i])||lines.slice(0,i).join('').replace(/\s/g,'').length<80)continue;
    const tail=lines.slice(i).map(s=>s.trim()).filter(Boolean);
    const entries=tail.filter(s=>NUMBERED_REFERENCE.test(s)&&BIBLIOGRAPHIC_ROW.test(s));
    if(entries.length>=2 && tail.every(s=>NUMBERED_REFERENCE.test(s)||RETRIEVAL.test(s)||isNoise(s))) {
      hadReferences=true;for(let j=i;j<lines.length;j++)removed.add(j);break;
    }
  }
  const kept=lines.filter((line,i)=>!removed.has(i)&&!isNoise(line.trim()));
  let text=kept.join('\n').replace(/[\t\u00a0\u3000 ]+/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();
  // Only strip inline citation numbers when a bibliography was actually identified;
  // numbered steps, dates, statistics, quotations and links in the narrative stay intact.
  if(hadReferences)text=text.replace(/(?<=[\p{L}\p{N}%％，。；：！？,.!?）)])(?:\[\d{1,3}(?:\s*[-–,，、]\s*\d{1,3})*\])+/gu,'');
  return text;
}
module.exports = {cleanArticleText, pruneArticleDom};
