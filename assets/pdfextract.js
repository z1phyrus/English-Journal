/* ============================================================
   pdfextract.js · 从 PDF 文字层里猜出「标题 + 正文段落」
   ------------------------------------------------------------
   针对的是精读讲义类的 PDF：页眉页脚、页码、【Para. N】标记、
   词汇注释块、段落译文、长难句分析……这一堆都不该进正文。
   猜不准也没关系：结果是可编辑的，用户能在导入页里改。
   ============================================================ */

import { flattenLines } from './pdftext.js';

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
const CJK_ALL = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g;

// 「每一页都有」的那种行：公众号名、版权声明、孤零零的页码
const CHROME_RE = [
  /^\s*公众号\s*[:：]/,
  /^\s*关注微信公众号/,
  /版权所有|侵权必究|禁止传播|未经授权|仅供学习|请勿转载/,
  /加入训练营|打卡圈|资料禁言群/,
  /^\s*第\s*\d{1,3}\s*页\s*$/,
  /^\s*[-—–]?\s*\d{1,3}\s*[-—–]?\s*$/,
  /^\s*\d{1,3}\s*\/\s*\d{1,3}\s*$/,
  /^\s*[A-Z][a-z]+\s+\d{1,2}(?:ST|ND|RD|TH)?\s*[-–—]\s*\d{1,2}(?:ST|ND|RD|TH)?\s+\d{4}\s*[|｜]/,
];

// 段首标记：【Para. 1】 / Para.1 / （Para. 2）
const PARA_RE = /(?:【\s*Para\.?\s*(\d+)\s*】|[（(]\s*Para\.?\s*(\d+)\s*[)）])/i;

// 段落之后那些「不是正文」的小节
const SECTION_STOP = /词汇|单词|生词|短语|译文|翻译|长难句|句子分析|成分分析|练习|答案|解析|学习流程|使用说明|阅读提示|文章脉络|背景知识|拓展阅读|参考译文|写作积累/;
const SECTION_START = /^(?:【[^】]*】|今日|【)?\s*(?:翻译作业|句子分析|长难句|学习流程|文章脉络|背景知识|拓展阅读|参考译文)/;

export const PDFEXTRACT_VERSION = 2;

/* ------------------------------------------------------------ 小工具 */

function round1(n) {
  return Math.round(n * 10) / 10;
}

function median(nums) {
  if (!nums.length) return 0;
  const a = nums.slice().sort((x, y) => x - y);
  const mid = a.length >> 1;
  return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
}

function stats(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const cjk = (text.match(CJK_ALL) || []).length;
  return { latin, cjk, share: latin / Math.max(1, latin + cjk) };
}

function words(text) {
  return (text.match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
}

function normKey(text) {
  return text.trim().replace(/\d+/g, '#').replace(/\s+/g, ' ');
}

/** 行尾连字符：`un-\nhealthy` 拼回 `unhealthy`；`blood-\nbrain` 这种真连字符保留 */
function joinLine(a, b) {
  if (!a) return b;
  if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
  return `${a} ${b}`;
}

function tidy(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?%)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/\s+—\s+/g, ' — ')
    .trim();
}

/** 拆出「英文标题 + 中文标题」 */
function splitBilingual(text) {
  const s = text.replace(/^[（(]\s*Para\.?\s*\d+\s*[)）]\s*/i, '').trim();
  const i = s.search(CJK);
  if (i < 0) return { en: s, zh: '' };
  return { en: s.slice(0, i).trim(), zh: s.slice(i).trim() };
}

/** 只有「独占一行」的标记才算段首：【Para. 1】 / （Para. 2） */
function isParaMarkLine(text) {
  const t = String(text).trim();
  if (!PARA_RE.test(t)) return false;
  if (/^【/.test(t)) return true;
  return t.replace(PARA_RE, '').trim().length <= 3;
}

/* ------------------------------------------------------------ 主流程 */

export function extractArticle(doc, opts = {}) {
  const now = opts.now instanceof Date ? opts.now : new Date();
  const pages = Array.isArray(doc?.pages) ? doc.pages : [];
  const warnings = [];

  const fail = (reason, extra) => ({
    ok: false, reason, warnings: extra ? [extra] : [], paragraphs: [], body: '',
  });

  if (!pages.length) return fail('empty', '这份 PDF 没有读到页面');
  const all = flattenLines(doc).filter((l) => l.text && l.text.trim());
  if (!all.length) {
    return fail('no-text', '这份 PDF 没有文字层（可能是扫描件），暂时只能手动粘贴原文');
  }

  const pageCount = pages.length;

  /* 1. 去掉每页重复的页眉页脚 ------------------------------------ */
  const freq = new Map();
  for (const l of all) {
    const k = normKey(l.text);
    freq.set(k, (freq.get(k) || 0) + 1);
  }
  const isChrome = (l) => {
    const t = l.text.trim();
    if (CHROME_RE.some((re) => re.test(t))) return true;
    return pageCount >= 3 && (freq.get(normKey(t)) || 0) / pageCount >= 0.45;
  };
  const content = all.filter((l) => !isChrome(l));

  /* 2. 猜正文字号：长且几乎全英文的行，谁的字母数多谁说了算 ------ */
  const votes = new Map();
  for (const l of content) {
    const s = stats(l.text);
    if (s.latin < 40 || s.share < 0.9) continue;
    const k = round1(l.size);
    votes.set(k, (votes.get(k) || 0) + s.latin);
  }
  let bodySize = 0;
  let best = -1;
  for (const [size, v] of votes) {
    if (v > best) { best = v; bodySize = size; }
  }
  if (!bodySize) {
    const hist = new Map();
    for (const l of content) hist.set(round1(l.size), (hist.get(round1(l.size)) || 0) + l.text.length);
    for (const [size, v] of hist) if (v > best) { best = v; bodySize = size; }
  }

  /* 3. 正文行：字号接近正文 + 以英文为主 -------------------------- */
  const isBody = (l) => {
    if (Math.abs(l.size - bodySize) > Math.max(0.55, bodySize * 0.05)) return false;
    const t = l.text.trim();
    // 行尾挂着中文＝「英文句子 + 中文释义」被排版切开的那种行，不是正文
    if (CJK.test(t.slice(-1))) return false;
    const s = stats(t);
    // 阈值放宽到 3 个字母：换行处只剩 `where.` 这样一两个词时也不能丢
    return s.latin >= 3 && s.share >= 0.85;
  };
  // 小节标记（【译文】【长难句】、今日翻译作业…）也要进流程，否则跳过区不生效
  const isSectionLine = (l) => {
    const t = l.text.trim();
    return /^【[^】]{1,40}】/.test(t) || SECTION_START.test(t);
  };
  const bodyLines = content
    .filter((l) => isParaMarkLine(l.text) || isSectionLine(l) || isBody(l))
    .sort((a, b) => a.page - b.page || a.y - b.y);

  /* 4. 行距中位数，用来判断「空行 = 换段」 ------------------------ */
  const gaps = [];
  for (let i = 1; i < bodyLines.length; i += 1) {
    const a = bodyLines[i - 1];
    const b = bodyLines[i];
    if (a.page !== b.page) continue;
    const d = b.y - a.y;
    if (d > 0.5) gaps.push(d);
  }
  const pitch = median(gaps) || bodySize * 1.5;

  /* 5. 拼段落 ---------------------------------------------------- */
  const paragraphs = [];
  let cur = null;
  let skipping = false;

  const flush = () => {
    if (!cur) return;
    const text = tidy(cur.text);
    if (words(text) >= 3) paragraphs.push(text);
    cur = null;
  };

  for (const line of bodyLines) {
    const t = line.text.trim();

    // 段落标记：一定开新段，并且结束「跳过」状态
    // 注意「(Para.2)In a new study…」是作业区里的引用，不算标记
    const mark = PARA_RE.exec(t);
    const isParaMark = Boolean(mark) && (/^【/.test(t) || t.replace(PARA_RE, '').trim().length <= 3);
    if (isParaMark) {
      skipping = false;
      flush();
      continue;
    }

    // 小节标记：这之后的英文多半是译文/分析/作业，不是正文
    const isBracket = /^【[^】]{1,40}】/.test(t) || /^【/.test(t);
    if (isBracket) {
      flush();
      if (SECTION_STOP.test(t)) skipping = true;
      continue;
    }
    if (SECTION_START.test(t)) {
      flush();
      skipping = true;
      continue;
    }
    if (skipping) continue;

    const gap = cur && cur.page === line.page ? line.y - cur.lastY : pitch;
    if (!cur || gap > pitch * 1.45) {
      flush();
      cur = { page: line.page, lastY: line.y, text: '' };
    }
    cur.text = joinLine(cur.text, t);
    cur.page = line.page;
    cur.lastY = line.y;
  }
  flush();

  /* 6. 去重 + 去掉太短的行 --------------------------------------- */
  const kept = [];
  const seen = new Set();
  for (const p of paragraphs) {
    if (words(p) < 4) continue;
    const key = p.slice(0, 90).toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    kept.push(p);
  }
  // 作业区/分析区偶尔会漏出一句正文的碎片：被更长段落完整包含的，删掉
  const deduped = kept.filter((p, i) => !kept.some((q, j) => j !== i && q.length > p.length && q.includes(p)));

  const body = deduped.join('\n\n');
  const wordCount = words(body);
  if (!deduped.length) {
    return fail('no-body', '有文字层，但没能从版式里认出正文（可能是双栏或纯图片排版）');
  }
  if (wordCount < 60) warnings.push('解析出的正文偏短，建议对照原文检查一下');

  /* 7. 标题、来源、日期、难度、摘要 ------------------------------ */
  const head = content.filter((l) => l.page <= 2);
  const meta = readMeta(head, content, bodySize, now);

  if (meta.level === '') warnings.push('没识别出难度评级，按 B2 处理');

  return {
    ok: true,
    version: PDFEXTRACT_VERSION,
    title: meta.title || splitBilingual(deduped[0]).en.slice(0, 80) || 'Untitled',
    subtitle: meta.subtitle,
    source: meta.source,
    date: meta.date,
    level: meta.level || 'B2',
    summary: meta.summary,
    tags: meta.tags,
    paragraphs: deduped,
    body,
    warnings,
    stats: {
      pages: pageCount,
      lines: all.length,
      usedLines: bodyLines.length,
      paragraphs: deduped.length,
      words: wordCount,
    },
  };
}

/* ------------------------------------------------------------ 元信息 */

function readMeta(head, content, bodySize, now) {
  const out = { title: '', subtitle: '', source: '', date: '', level: '', summary: '', tags: [] };
  const page1 = head.filter((l) => l.page === 1).map((l) => l.text.trim());

  // 【11.19 | The Economist】Mental block心理障碍
  for (const t of page1) {
    const m = /^【\s*([^】|｜]{2,40}?)\s*[|｜]\s*([^】]{2,40}?)\s*】\s*(.+)$/.exec(t);
    if (!m) continue;
    const [, when, source, rest] = m;
    out.source = source.trim();
    const year = findYear(content) || now.getFullYear();
    const md = /(\d{1,2})\s*[.\-/月]\s*(\d{1,2})/.exec(when);
    if (md) {
      const mm = String(Number(md[1])).padStart(2, '0');
      const dd = String(Number(md[2])).padStart(2, '0');
      out.date = `${year}-${mm}-${dd}`;
    }
    const { en, zh } = splitBilingual(rest);
    out.title = en;
    if (!en) out.title = '';
    if (zh) out.subtitle = '';
    if (zh) out.summary = zh;
    break;
  }

  // 没有【…|…】标题时，退回「第一页最大的英文行」
  if (!out.title) {
    const big = head
      .filter((l) => l.size >= bodySize + 0.8 && /[A-Za-z]/.test(l.text))
      .sort((a, b) => b.size - a.size || a.page - b.page)[0];
    if (big) {
      const { en, zh } = splitBilingual(big.text);
      out.title = en;
      if (zh) out.summary = zh;
    }
  }

  // 难度评级: ★★★★☆
  for (const l of content) {
    const m = /难度[^\n]{0,8}?[:：]\s*([★☆]+)/.exec(l.text);
    if (!m) continue;
    const stars = (m[1].match(/★/g) || []).length;
    out.level = ['', 'A2', 'B1', 'B2', 'C1', 'C2'][Math.min(5, stars)] || 'B2';
    break;
  }

  // 今日文章脉络：血脑屏障阻血液毒素病原体护脑（Para. 1）…
  const outline = [];
  for (const l of head) {
    const t = l.text.trim();
    const m = /^(.{4,60}?)\s*[（(]\s*Para\.?\s*\d+\s*[)）]/.exec(t);
    if (!m) continue;
    const line = m[1].trim();
    if (!CJK.test(line)) continue;
    if (outline.includes(line)) continue;
    outline.push(line);
  }
  if (outline.length) {
    const lead = outline.slice(0, 6).join('；');
    out.summary = out.summary ? `${out.summary}｜${lead}` : lead;
  }

  out.summary = out.summary.slice(0, 300);
  return out;
}

function findYear(content) {
  for (const l of content) {
    const m = /\b(19|20)\d{2}\b/.exec(l.text);
    if (!m) continue;
    const year = Number(m[0]);
    if (year >= 1990 && year <= 2100) return year;
  }
  return 0;
}
