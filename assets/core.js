/* ============================================================
   core.js · 存储、偏好、生词 SRS、文章工具
   ============================================================ */

export const DAY = 86400000;
export const MIN = 60000;

const KEY = {
  prefs: 'er.prefs.v1',
  vocab: 'er.vocab.v1',
  progress: 'er.progress.v1',
  local: 'er.local.v1',
  dict: 'er.dict.v1',
  stats: 'er.stats.v1',
  exam: 'er.exam.v1',
};

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (err) {
    console.warn('[store] 读取失败', key, err);
    return fallback;
  }
}

function writeJSON(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch (err) {
    console.warn('[store] 写入失败，可能是存储空间已满', key, err);
    return false;
  }
}

/* ---------------- 偏好 ---------------- */

const DEFAULT_PREFS = { theme: 'auto', fontScale: 1, rate: 0.95, autoZh: true };

export function getPrefs() {
  return { ...DEFAULT_PREFS, ...readJSON(KEY.prefs, {}) };
}

export function setPref(key, value) {
  const prefs = getPrefs();
  prefs[key] = value;
  writeJSON(KEY.prefs, prefs);
  return prefs;
}

export function resolvedTheme() {
  const { theme } = getPrefs();
  if (theme === 'light' || theme === 'dark') return theme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/* ---------------- 生词本 ---------------- */

export function getVocab() {
  return readJSON(KEY.vocab, {});
}

export function saveVocab(map) {
  writeJSON(KEY.vocab, map);
}

export function vocabList() {
  return Object.values(getVocab()).sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
}

export function bindWord(word) {
  return String(word || '').trim().toLowerCase();
}

export function isSaved(word) {
  return Boolean(getVocab()[bindWord(word)]);
}

export function addWord(entry) {
  const w = bindWord(entry.word);
  if (!w) return null;
  const map = getVocab();
  const exist = map[w];
  const now = Date.now();
  if (exist) {
    // 已存在则只补充缺失信息，不重置复习进度
    map[w] = {
      ...exist,
      phonetic: exist.phonetic || entry.phonetic || '',
      zh: exist.zh || entry.zh || '',
      defs: exist.defs && exist.defs.length ? exist.defs : entry.defs || [],
      ctx: exist.ctx || entry.ctx || '',
    };
    saveVocab(map);
    return map[w];
  }
  map[w] = {
    w,
    word: entry.word || w,
    phonetic: entry.phonetic || '',
    zh: entry.zh || '',
    defs: entry.defs || [],
    ctx: entry.ctx || '',
    art: entry.art || '',
    artTitle: entry.artTitle || '',
    addedAt: now,
    ease: 2.5,
    interval: 0,
    reps: 0,
    lapses: 0,
    due: now,           // 新词立刻到期，当天即可复习
    lastAt: 0,
    reviews: 0,
  };
  saveVocab(map);
  bumpStat('added');
  return map[w];
}

export function removeWord(word) {
  const map = getVocab();
  delete map[bindWord(word)];
  saveVocab(map);
}

export function clearVocab() {
  saveVocab({});
}

export function dueWords(now = Date.now()) {
  return vocabList()
    .filter((item) => (item.due || 0) <= now)
    .sort((a, b) => (a.due || 0) - (b.due || 0));
}

export function reviewWord(word, grade, now = Date.now()) {
  const map = getVocab();
  const key = bindWord(word);
  const item = map[key];
  if (!item) return null;

  let { ease = 2.5, interval = 0, reps = 0, lapses = 0 } = item;

  if (grade === 'again') {
    lapses += 1;
    reps = 0;
    ease = Math.max(1.3, ease - 0.2);
    interval = 10 / (24 * 60);        // 10 分钟后重现
  } else if (grade === 'hard') {
    reps += 1;
    ease = Math.max(1.3, ease - 0.15);
    interval = Math.max(1, interval <= 0 ? 1 : interval * 1.2);
  } else {
    reps += 1;
    ease = Math.min(3, ease + 0.05);
    if (interval <= 0) interval = 1;
    else if (interval < 3) interval = 3;
    else interval *= ease;
  }

  interval = Math.min(interval, 180);

  const updated = {
    ...item,
    ease,
    interval,
    reps,
    lapses,
    due: now + interval * DAY,
    lastAt: now,
    reviews: (item.reviews || 0) + 1,
  };
  map[key] = updated;
  saveVocab(map);
  bumpStat('reviews');
  return updated;
}

export function nextIntervalDays(word, grade) {
  const item = getVocab()[bindWord(word)];
  if (!item) return 0;
  let { ease = 2.5, interval = 0 } = item;
  if (grade === 'again') return 10 / 1440;
  if (grade === 'hard') return Math.max(1, interval <= 0 ? 1 : interval * 1.2);
  if (interval <= 0) return 1;
  if (interval < 3) return 3;
  return Math.min(180, interval * ease);
}

/* ---------------- 阅读进度 ---------------- */

export function getProgress(articleId) {
  return readJSON(KEY.progress, {})[articleId] || null;
}

export function saveProgress(articleId, pct, seconds) {
  const all = readJSON(KEY.progress, {});
  const prev = all[articleId] || { sec: 0 };
  all[articleId] = {
    pct: Math.max(prev.pct || 0, Math.min(1, pct)),
    at: Date.now(),
    sec: (prev.sec || 0) + (seconds || 0),
  };
  writeJSON(KEY.progress, all);
}

export function allProgress() {
  return readJSON(KEY.progress, {});
}

/* ---------------- 学习统计 ---------------- */

function todayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function getStats() {
  return readJSON(KEY.stats, {});
}

/* ---------- 翻译作业（自己写的译文按文章存本地） ---------- */

export function getExam(articleId) {
  const all = readJSON(KEY.exam, {});
  return typeof all[articleId] === 'string' ? all[articleId] : '';
}

export function saveExam(articleId, text) {
  if (!articleId) return;
  const all = readJSON(KEY.exam, {});
  if (text) all[articleId] = text;
  else delete all[articleId];
  writeJSON(KEY.exam, all);
}

export function bumpStat(kind, n = 1) {
  const stats = getStats();
  const key = todayKey();
  const bucket = stats[key] || { added: 0, reviews: 0 };
  bucket[kind] = (bucket[kind] || 0) + n;
  stats[key] = bucket;
  // 只保留最近 400 天
  const keys = Object.keys(stats).sort();
  while (keys.length > 400) delete stats[keys.shift()];
  writeJSON(KEY.stats, stats);
}

export function todayStat() {
  return getStats()[todayKey()] || { added: 0, reviews: 0 };
}

/* ---------------- 本机导入的文章 ---------------- */

export function localArticles() {
  return readJSON(KEY.local, []);
}

export function saveLocalArticle(article) {
  const list = localArticles();
  const idx = list.findIndex((a) => a.id === article.id);
  if (idx >= 0) list[idx] = article;
  else list.unshift(article);
  writeJSON(KEY.local, list);
  return article;
}

export function removeLocalArticle(id) {
  writeJSON(KEY.local, localArticles().filter((a) => a.id !== id));
}

/* ---------------- 文章库 ---------------- */

let libraryCache = null;

export async function loadLibrary() {
  if (libraryCache) return libraryCache;
  let remote = [];
  try {
    const res = await fetch('data/articles.json', { cache: 'no-cache' });
    if (res.ok) {
      const data = await res.json();
      remote = Array.isArray(data.articles) ? data.articles : [];
    }
  } catch (err) {
    console.warn('[library] 无法加载 data/articles.json，以本机文章为准', err);
  }
  const local = localArticles().map((a) => ({ ...a, local: true }));
  libraryCache = [...local, ...remote].map(normalizeArticle);
  return libraryCache;
}

export function invalidateLibrary() {
  libraryCache = null;
}

export function normalizeArticle(raw) {
  const paragraphs = (raw.paragraphs || [])
    .map((p) => String(p).trim())
    .filter(Boolean);
  const plain = paragraphs.join(' ');
  return {
    id: raw.id,
    title: raw.title || '未命名文章',
    subtitle: raw.subtitle || '',
    source: raw.source || '',
    author: raw.author || '',
    date: raw.date || '',
    level: raw.level || '',
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    summary: raw.summary || '',
    paragraphs,
    local: Boolean(raw.local),
    // 讲义结构（段落译文 / 词汇注释 / 翻译作业）原样带上，渲染层自己判断要不要用
    ...(raw.lesson && Array.isArray(raw.lesson.paragraphs) ? { lesson: raw.lesson } : {}),
    words: countWords(plain),
    minutes: Math.max(1, Math.round(countWords(plain) / 200)),
  };
}

export async function getArticle(id) {
  const lib = await loadLibrary();
  return lib.find((a) => a.id === id) || null;
}

export function countWords(text) {
  const m = String(text).match(/[A-Za-z][A-Za-z'’-]*/g);
  return m ? m.length : 0;
}

/* ---------------- 文本处理 ---------------- */

const SENTENCE_RE = /[^.!?…]+(?:[.!?…]+["'”’)\]]*|$)/g;

export function splitSentences(text) {
  const out = [];
  const matches = String(text).match(SENTENCE_RE) || [];
  for (const m of matches) {
    const s = m.trim();
    if (s) out.push(s);
  }
  return out;
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const WORD_RE = /[A-Za-z][A-Za-z'’\-]*/g;

/**
 * 把一段英文切成「句子 span + 单词 span」，便于整句朗读与划词查询。
 * 返回 HTML 字符串（已转义）。
 */
export function paragraphToHtml(text, noteFor) {
  return splitSentences(text)
    .map((sentence) => {
      let html = '';
      let last = 0;
      WORD_RE.lastIndex = 0;
      let m;
      while ((m = WORD_RE.exec(sentence))) {
        html += escapeHtml(sentence.slice(last, m.index));
        const raw = m[0];
        const core = raw.replace(/['’]s$/, '');
        const key = core.toLowerCase();
        const term = noteFor ? noteFor(key) : '';
        const attrs = term ? ` data-note="${escapeHtml(term)}"` : '';
        html += `<span class="w${term ? ' has-note' : ''}" data-w="${escapeHtml(key)}"${attrs}>${escapeHtml(raw)}</span>`;
        last = m.index + raw.length;
      }
      html += escapeHtml(sentence.slice(last));
      return `<span class="s">${html}</span>`;
    })
    .join(' ');
}

export function formatDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`;
}

export function relDue(ts, now = Date.now()) {
  if (!ts) return '—';
  const diff = ts - now;
  if (diff <= 0) return '现在';
  const mins = Math.round(diff / MIN);
  if (mins < 60) return `${mins} 分钟后`;
  const hours = Math.round(diff / 3600000);
  if (hours < 24) return `${hours} 小时后`;
  const days = Math.round(diff / DAY);
  return `${days} 天后`;
}

export function uid(prefix = 'a') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function debounce(fn, wait = 200) {
  let timer = 0;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

export { todayKey };
