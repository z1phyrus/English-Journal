/**
 * pdflesson.js — 从「外刊精读讲义」类 PDF 里抽出结构化的一课：
 *
 *   lead:       { en, zh }             正文前的题记（英文引用 + 中文释义）
 *   paragraphs: [{ n, en, zh, notes }]  英文正文 + 该段中文译文 + 该段的词条注释
 *   notes:      [{ term, pos, phonetic, def, zh, tag, example, exampleZh, para }]
 *   exercise:   { title, en, para, analysis, writing }  翻译作业 + 句子分析 + 写作积累
 *
 * 依赖 pdftext.js 给出的「行（含字号与坐标）」，不依赖任何第三方库。
 * 判定规则只看版式：正文字号 / 注释块字号 / 中文占比 / 段首标记 / 小节标题 / 缩进。
 */
import { flattenLines } from './pdftext.js';

const CJK_RE = /[\u3400-\u9FFF\uF900-\uFAFF]/g;
const PARA_MARK = /^【\s*Para\.?\s*(\d+)\s*】$/i;
const PARA_INLINE = /^[（(]\s*Para\.?\s*(\d+)\s*[)）]\s*(.+)$/i;
const NOTE_START =
  /^([A-Za-z][A-Za-z'’\-]*(?:\s+[A-Za-z'’\-]+){0,3})\s+(?:(n|v|a|adj|adv|vt|vi|prep|conj|num|pron|art)\.|(phrase|phr))\s*/i;
const PHONETIC = /^\/\s*([^\/]{1,48}?)\s*\//;
const TRAILER = /[（(]\s*下一页提供句子分析\s*[)）]/;
const COVER_NOISE = /难度评级|文章脉络|［|【\d{1,2}\.\d{1,2}|★|↓|↑/;

const SECTION_TITLES = ['今日翻译作业', '今日句子分析', '句子成分分析', '写作积累', '长难句', '学习流程', '文章脉络'];
const CHROME = /公众号|版权所有|禁止传播|第\s*\d+\s*页|考研那些事儿/;

/* 杂志刊头（November 14TH-20TH 2026｜Science & technology）和公众号引导语，
   两者都可能混进正文或译文，单独拦掉 */
const MASTHEAD = /^(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:ST|ND|RD|TH)?\s*[-–—]\s*\d{1,2}(?:ST|ND|RD|TH)?,?\s+\d{4}\b/i;
const PROMO = /群公告|资料禁言群|打卡圈子|查看全文翻译|学习心得|扫码|加微信|关注公众号|公众号后台|回复【/;

/* 刊头有时被排版拼在句子末尾，从行尾切掉 */
function stripMasthead(text) {
  return text.replace(
    /\s*(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+\d{1,2}(?:ST|ND|RD|TH)?\s*[-–—]\s*\d{1,2}(?:ST|ND|RD|TH)?,?\s+\d{4}\s*[｜|].*$/i,
    '',
  );
}

const cjkCount = (s) => (s.match(CJK_RE) || []).length;
const latinWords = (s) => (s.match(/[A-Za-z][A-Za-z'’\-]*/g) || []).length;
const hasCJK = (s) => /[\u3400-\u9FFF\uF900-\uFAFF]/.test(s);

/** 去掉行首的圆点、项目符号、私用区字形与空白 */
function normalize(s) {
  return s
    .replace(/^[\s\uE000-\uF8FF\uFFFD\uF000-\uF0FF•·◦▪∙※]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 统一空白：英文间保留一个空格，中文之间的空格去掉 */
function tidy(s) {
  return (s || '')
    .replace(/\s+/g, ' ')
    /* 排版把撇号拆成了两半：Alzheimer' s → Alzheimer's */
    .replace(/([A-Za-z])['’]\s+(s|t|re|ve|ll|d|m)\b/gi, '$1’$2')
    .replace(/([A-Za-z])\s+['’]\s*([A-Za-z])/g, '$1’$2')
    .replace(/\s+([,.;:!?%)\]])/g, '$1')
    .replace(/([(\[])\s+/g, '$1')
    .replace(/([\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF])\s+(?=[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF])/g, '$1')
    .trim();
}

/** 清理 IPA 里由排版插入的空格 */
function cleanPhonetic(raw) {
  return raw
    .replace(/\s*([ˈˌ])\s*/g, '$1')
    .replace(/\s*ː\s*/g, 'ː')
    .replace(/\s+/g, ' ')
    .trim();
}

const isBody = (size) => size >= 13.2 && size <= 14.5;
const isSmall = (size) => size >= 14.6 && size <= 15.6;

/**
 * 拆一个词条。text 形如：
 *   block n. /blɒk/a solid piece of material; …障碍物【考研大纲词汇】
 *   barrier n. /ˈbæriə(r)/ Something that… difficult.障碍；屏障【考研大纲词汇】
 *   Language differences can create barriers to communication.语言差异…障碍。
 */
export function parseNote(text) {
  const t = normalize(text);
  const head = t.match(NOTE_START);
  if (!head) return null;

  const term = head[1].trim();
  const posRaw = (head[2] || head[3] || '').toLowerCase();
  const pos = posRaw === 'adj' ? 'a' : posRaw === 'adv' ? 'ad' : posRaw;
  let rest = t.slice(head[0].length);

  let phonetic = '';
  const ph = rest.match(PHONETIC);
  if (ph) {
    const clean = cleanPhonetic(ph[1]);
    phonetic = '/' + (/\s/.test(term) ? clean : clean.replace(/\s+/g, '')) + '/';
    rest = rest.slice(ph[0].length);
  }

  const zhStart = rest.search(/[\u3400-\u9FFF]/);
  let def = rest;
  let zh = '';
  let tag = '';
  let tail = '';

  if (zhStart >= 0) {
    def = rest.slice(0, zhStart);
    tail = rest.slice(zhStart);
  }

  const tagAt = tail.search(/【\s*[^】]{1,20}\s*】/);
  if (tagAt >= 0) {
    const m = tail.slice(tagAt).match(/^【\s*([^】]{1,20})\s*】/);
    tag = m[1].trim();
    zh = tail.slice(0, tagAt);
    tail = tail.slice(tagAt + m[0].length);
  } else {
    const cut = tail.search(/[。；！？]\s*(?=[A-Za-z“"‘'])/);
    if (cut >= 0) {
      zh = tail.slice(0, cut + 1);
      tail = tail.slice(cut + 1);
    } else {
      zh = tail;
      tail = '';
    }
  }

  let example = '';
  let exampleZh = '';
  const ex = tail.trim();
  if (ex) {
    const exZh = ex.search(/[\u3400-\u9FFF]/);
    if (exZh > 0) {
      example = ex.slice(0, exZh).trim();
      exampleZh = ex.slice(exZh).trim();
    } else if (exZh === 0) {
      exampleZh = ex;
    } else {
      example = ex;
    }
  }

  const note = {
    term,
    pos,
    phonetic,
    def: tidy(def).replace(/^[;；,，]\s*/, '').replace(/[;；]\s*$/, ''),
    zh: tidy(zh).replace(/^[;；,，、]\s*/, ''),
    tag: tidy(tag),
    example: tidy(example),
    exampleZh: tidy(exampleZh),
  };
  return note.term && note.def ? note : null;
}

/** 一段里 15pt 的那些行 → { notes, zh } */
function readParaSmall(rows) {
  const notes = [];
  let zh = '';
  let open = null;

  const flush = () => {
    if (!open) return;
    if (open.kind === 'zh') {
      zh += open.text;
    } else {
      const note = parseNote(open.text);
      if (note) notes.push(note);
    }
    open = null;
  };

  for (const r of rows) {
    const text = normalize(r.text);
    if (!text) continue;

    if (NOTE_START.test(text) && latinWords(text) >= 2) {
      flush();
      open = { kind: 'note', text };
      continue;
    }

    if (open && open.kind === 'note') {
      const zhStart = r.x >= 115 && cjkCount(text) >= 6 && latinWords(text) <= 2;
      if (zhStart) {
        flush();
        open = { kind: 'zh', text };
      } else {
        open.text += ' ' + text;
      }
      continue;
    }

    if (open && open.kind === 'zh') {
      if (cjkCount(text) >= 4 && latinWords(text) <= 4) open.text += text;
      else {
        flush();
        open = { kind: 'zh', text };
      }
      continue;
    }

    if (cjkCount(text) >= 6 && latinWords(text) <= 4) open = { kind: 'zh', text };
    else open = { kind: 'note', text };
  }
  flush();
  return { notes, zh: tidy(zh) };
}

/**
 * @param {Array} lines 来自 flattenLines(doc)
 */
export function lessonFromLines(lines) {
  const warnings = [];
  const paragraphs = [];
  const leadRows = [];
  const pendingLead = [];
  const exercise = { title: '今日翻译作业', en: '', para: null, analysis: '', writing: '' };
  let hasExercise = false;
  let current = null;
  let section = 'body';
  let lastPage = -1;

  for (const l of lines) {
    if (l.size < 11.5) continue;
    if (l.page !== lastPage) {
      leadRows.length = 0; // 题记只取「段首标记所在页」上的那几行
      lastPage = l.page;
    }

    const text = normalize(l.text);
    if (!text) continue;
    if (CHROME.test(text)) continue;
    if (PROMO.test(text)) continue;
    /* 刊头可能单独成行，也可能被拼进正文行尾，两处都要清 */
    if (MASTHEAD.test(text)) continue;

    const title = SECTION_TITLES.find((t) => text.startsWith(t) && text.length <= 18);
    if (title) {
      leadRows.length = 0;
      if (title === '今日翻译作业') {
        section = 'exercise';
        hasExercise = true;
        exercise.title = title;
      } else if (title === '今日句子分析' || title === '句子成分分析') {
        section = 'analysis';
      } else if (title === '写作积累') {
        section = 'writing';
      } else {
        section = 'body';
      }
      continue;
    }

    if (isBody(l.size)) {
      const mark = text.match(PARA_MARK);
      if (mark && section === 'body') {
        if (!paragraphs.length && leadRows.length) pendingLead.push(...leadRows);
        current = { n: Number(mark[1]), en: '', small: [] };
        paragraphs.push(current);
        leadRows.length = 0;
        continue;
      }
      if (section === 'exercise') {
        const inline = text.match(PARA_INLINE);
        if (inline && !exercise.en) {
          exercise.para = Number(inline[1]);
          exercise.en = inline[2];
        } else {
          exercise.en += ' ' + text;
        }
        continue;
      }
      if (section === 'analysis' || section === 'writing') continue;

      if (current) {
        current.en += ' ' + stripMasthead(text);
      } else if (!COVER_NOISE.test(text)) {
        leadRows.push({ text });
      }
      continue;
    }

    if (isSmall(l.size)) {
      if (section === 'exercise') {
        exercise.en += ' ' + text;
        continue;
      }
      if (section === 'analysis') {
        exercise.analysis += (exercise.analysis ? '\n' : '') + text;
        continue;
      }
      if (section === 'writing') {
        exercise.writing += (exercise.writing ? '\n' : '') + text;
        continue;
      }
      if (current) current.small.push({ text, x: l.x, y: l.y, page: l.page });
    }
  }

  // 题记：正文前紧挨着的「英文引用 + 中文释义」
  let lead = null;
  if (pendingLead.length) {
    const enParts = [];
    const zhParts = [];
    for (const r of pendingLead) {
      const t = normalize(r.text);
      const cut = t.search(/[\u3400-\u9FFF]/);
      if (cut > 0) {
        enParts.push(t.slice(0, cut));
        zhParts.push(t.slice(cut));
      } else if (hasCJK(t)) {
        zhParts.push(t);
      } else {
        enParts.push(t);
      }
    }
    const en = tidy(enParts.join(' ')).replace(/[”"]\s*$/, '');
    const zh = tidy(zhParts.join(''));
    if (en && zh) lead = { en, zh };
  }

  const allNotes = [];
  for (const p of paragraphs) {
    p.en = tidy(p.en);
    const { notes, zh } = readParaSmall(p.small);
    p.zh = zh;
    p.notes = notes;
    for (const n of notes) {
      n.para = p.n;
      allNotes.push(n);
    }
    delete p.small;
  }

  const kept = paragraphs.filter((p) => p.en && latinWords(p.en) >= 4);
  const dropped = paragraphs.length - kept.length;
  if (dropped > 0) warnings.push(`丢弃了 ${dropped} 个没有英文正文的段落`);
  if (!kept.length) {
    return {
      ok: false,
      reason: '没找到「【Para. N】」段落标记，可能不是这类精读讲义 PDF',
      warnings,
      lead: null,
      paragraphs: [],
      notes: [],
      exercise: null,
      stats: { paragraphs: 0, translated: 0, notes: 0, words: 0, hasExercise: false, hasAnalysis: false },
    };
  }

  const seen = new Set();
  const notes = allNotes.filter((n) => {
    const key = n.term.toLowerCase() + '|' + n.pos;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const translated = kept.filter((p) => p.zh).length;
  if (translated < kept.length) warnings.push(`${kept.length - translated} 段没有找到中文译文`);

  exercise.en = tidy(exercise.en.replace(TRAILER, ''));
  exercise.analysis = exercise.analysis.trim();
  exercise.writing = exercise.writing.trim();

  const ex = hasExercise && exercise.en && latinWords(exercise.en) >= 4 ? exercise : null;

  return {
    ok: true,
    lead,
    paragraphs: kept,
    notes,
    exercise: ex,
    warnings,
    stats: {
      paragraphs: kept.length,
      translated,
      notes: notes.length,
      words: kept.reduce((s, p) => s + latinWords(p.en), 0),
      exerciseWords: ex ? latinWords(ex.en) : 0,
      hasExercise: Boolean(ex),
      hasAnalysis: Boolean(ex && ex.analysis),
    },
  };
}

export async function parseLesson(input, opts = {}) {
  const doc = await (await import('./pdftext.js')).pdfToText(input, opts);
  return lessonFromLines(flattenLines(doc));
}
