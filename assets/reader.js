/* ============================================================
   reader.js · 精读页：划词查词、朗读、进度、生词高亮
   ============================================================ */

import {
  getArticle, paragraphToHtml, escapeHtml, formatDate, isSaved, addWord, removeWord,
  getProgress, saveProgress, getPrefs, setPref, clamp, debounce,
  loadLibrary, vocabList, getExam, saveExam,
} from './core.js';
import { initChrome, Speaker, toast, qs, qsa, ICON_PLAY, scrollBehavior } from './ui.js';
import { fetchDef, fetchZh, cachedDef, cachedZh, lemmas } from './dict.js';

initChrome();

const bodyEl = qs('#body');
const headEl = qs('#head');
const barTitle = qs('#bar-title');
const rail = qs('#rail');
const pctEl = qs('#rail-pct');
const pop = qs('#popover');
const speakAllBtn = qs('#speak-all');
const segEl = qs('#seg-lang');

const speaker = new Speaker();
let article = null;
let nextArticle = null;
let lesson = null;          // 讲义结构（双语 / 注释 / 作业）
let noteIndex = null;       // 词 → 注释 的匹配器
let noteByTerm = new Map(); // term → note
let bilingual = false;
let activeSpan = null;
let activeWord = null;      // 浮层当前针对的词（可能来自词表，没有正文 span）
let activeNote = null;
let slowTimer = null;

/* ---------------- 渲染 ---------------- */

function renderError(message) {
  headEl.innerHTML = `<h1>找不到这篇文章</h1>
    <p class="dek">${escapeHtml(message)}</p>`;
  bodyEl.innerHTML = `<p><a class="btn btn-primary" href="index.html">回到文章库</a></p>`;
  barTitle.textContent = '文章不存在';
}

function renderHead(a) {
  document.title = `${a.title} · 外刊精读`;
  barTitle.textContent = a.title;

  const chips = [
    a.level ? `<span class="chip chip-accent">${escapeHtml(a.level)}</span>` : '',
    a.source ? `<span>${escapeHtml(a.source)}</span>` : '',
    a.date ? `<span class="sep">·</span><span>${escapeHtml(formatDate(a.date))}</span>` : '',
    `<span class="sep">·</span><span>${a.words} 词 · 约 ${a.minutes} 分钟</span>`,
    a.local ? '<span class="chip">本机文章</span>' : '',
  ].filter(Boolean).join('');

  headEl.innerHTML = `
    <div class="lib-meta">${chips}</div>
    <h1>${escapeHtml(a.title)}</h1>
    ${a.subtitle ? `<p class="dek">${escapeHtml(a.subtitle)}</p>` : ''}
    ${a.summary ? `<div class="zh-summary">${escapeHtml(a.summary)}</div>` : ''}
    ${(a.tags || []).length ? `<div class="lib-meta" style="margin-top:1rem">${a.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}`;
}

/* ---------- 讲义注释：词形匹配 ---------- */

const INFLECT = ['', 's', 'es', 'ed', 'd', 'ing', 'ly', 'er', 'est'];

function buildNoteIndex(notes) {
  const map = new Map();
  for (const n of notes) {
    const term = n.term.toLowerCase();
    if (/\s/.test(term)) continue; // 短语不做行内标注，只在词表里出现
    for (const suf of INFLECT) map.set(term + suf, n.term);
    // tagged / tagging 这类双写
    const last = term.slice(-1);
    if (/[bdgklmnprt]/.test(last)) {
      map.set(term + last + 'ed', n.term);
      map.set(term + last + 'ing', n.term);
    }
  }
  return (word) => map.get(word) || '';
}

function renderBody(a) {
  const paras = lesson ? lesson.paragraphs : a.paragraphs.map((en) => ({ en, zh: '' }));
  const lead = lesson?.lead;
  const leadHtml = lead
    ? `<div class="article-lead">
         <p class="lead-en" lang="en">${escapeHtml(lead.en)}</p>
         ${lead.zh ? `<p class="lead-zh">${escapeHtml(lead.zh)}</p>` : ''}
       </div>`
    : '';

  bodyEl.innerHTML = leadHtml + paras.map((p, i) => `
    <p class="para" data-i="${i}">
      <button class="para-play" data-play="${i}" title="朗读这一段" aria-label="朗读这一段的第 ${i + 1} 段">${ICON_PLAY}</button>
      ${paragraphToHtml(p.en || p, noteIndex)}
      ${p.zh ? `<span class="para-zh">${escapeHtml(p.zh)}</span>` : ''}
    </p>`).join('');

  applyBilingual();
}

function applyBilingual() {
  bodyEl.classList.toggle('is-bilingual', Boolean(bilingual && lesson));
}

function initLangToggle() {
  if (!segEl) return;
  if (!lesson) {
    segEl.hidden = true;
    return;
  }
  segEl.hidden = false;
  const sync = () => {
    segEl.querySelectorAll('button[data-lang]').forEach((b) => {
      const on = (b.dataset.lang === 'zh') === bilingual;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  };
  sync();
  segEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-lang]');
    if (!btn) return;
    bilingual = btn.dataset.lang === 'zh';
    setPref('bilingual', bilingual);
    applyBilingual();
    sync();
  });
}

function formatAnalysis(text) {
  const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
  const out = [];
  const startNew = /^(\d+\.|主语|谓语|宾语|表语|定语|状语|同位语|句子主干|结构|其中|也就是说|下面|句子成分)/;
  const endsCJK = /[\u3400-\u9FFF]$/;
  const startsCJK = /^[\u3400-\u9FFF]/;
  for (const line of lines) {
    if (!out.length || startNew.test(line)) {
      out.push(line);
      continue;
    }
    const prev = out[out.length - 1];
    const join = endsCJK.test(prev) && startsCJK.test(line) ? '' : ' ';
    out[out.length - 1] = prev + join + line;
  }
  return out;
}

function renderExam() {
  const box = qs('#exam');
  if (!box) return;
  const ex = lesson?.exercise;
  if (!ex) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  qs('#exam-meta').textContent = ex.para ? `原文第 ${ex.para} 段` : '';
  qs('#exam-en').textContent = ex.en;

  const input = qs('#exam-input');
  const saved = qs('#exam-saved');
  input.value = getExam(article.id);

  const flush = debounce(() => {
    saveExam(article.id, input.value);
    saved.textContent = input.value ? '已存在本机' : '';
    setTimeout(() => { saved.textContent = ''; }, 1600);
  }, 500);
  input.addEventListener('input', flush);

  // 参考译文 = 该段的中文译文
  const para = ex.para ? lesson.paragraphs.find((p) => p.n === ex.para) : null;
  const refBox = qs('#exam-ref');
  const revealBtn = qs('#exam-reveal');
  if (para?.zh) {
    refBox.innerHTML = `<p class="ref-label">参考译文</p><p class="ref-zh">${escapeHtml(para.zh)}</p>`;
  } else {
    revealBtn.hidden = true;
  }
  revealBtn.addEventListener('click', () => {
    const open = refBox.hidden;
    refBox.hidden = !open;
    revealBtn.textContent = open ? '收起参考译文' : '看参考译文';
    if (open) refBox.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  });

  const anaBtn = qs('#exam-analysis');
  const anaBox = qs('#exam-analysis-body');
  if (ex.analysis) {
    anaBtn.hidden = false;
    anaBox.innerHTML = formatAnalysis(ex.analysis).map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }
  anaBtn.addEventListener('click', () => {
    const open = anaBox.hidden;
    anaBox.hidden = !open;
    anaBtn.textContent = open ? '收起句子分析' : '看句子分析';
    if (open) anaBox.scrollIntoView({ behavior: scrollBehavior(), block: 'nearest' });
  });

  qs('#exam-clear').addEventListener('click', () => {
    input.value = '';
    saveExam(article.id, '');
    saved.textContent = '已清空';
    setTimeout(() => { saved.textContent = ''; }, 1600);
  });
}

function renderGlossary() {
  const box = qs('#glossary');
  const list = qs('#glossary-list');
  if (!box || !list) return;
  const notes = lesson?.notes || [];
  if (!notes.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const phraseCount = notes.filter((n) => /\s/.test(n.term)).length;
  qs('#glossary-meta').textContent = phraseCount
    ? `${notes.length} 条 · 含 ${phraseCount} 个短语`
    : `${notes.length} 条`;

  list.innerHTML = notes.map((n) => `
    <li>
      <button class="gloss" type="button" data-term="${escapeHtml(n.term)}">
        <span class="gloss-term" lang="en">${escapeHtml(n.term)}</span>
        ${n.pos ? `<span class="gloss-pos">${escapeHtml(n.pos)}.</span>` : ''}
        <span class="gloss-zh">${escapeHtml(n.zh || n.def.slice(0, 40))}</span>
      </button>
    </li>`).join('');

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.gloss');
    if (!btn) return;
    e.stopPropagation();
    const note = noteByTerm.get(btn.dataset.term);
    if (!note) return;
    // 词表按钮也当作锚点用：给它补一个 data-w，浮层里的「查词典」才能走词典流
    btn.dataset.w = note.term.toLowerCase();
    openNote(note, btn);
  });
}


/* ---------------- 生词高亮 ---------------- */

function markSaved(word) {
  const target = String(word).toLowerCase();
  bodyEl.querySelectorAll('.w').forEach((el) => {
    if (el.dataset.w === target) {
      el.classList.add('known');
      el.classList.add('saved');
    }
  });
}

function unmarkSaved(word) {
  const target = String(word).toLowerCase();
  bodyEl.querySelectorAll('.w').forEach((el) => {
    if (el.dataset.w === target) {
      el.classList.remove('known');
      el.classList.remove('saved');
    }
  });
}

function refreshHighlights() {
  bodyEl.querySelectorAll('.w').forEach((el) => {
    if (isSaved(el.dataset.w)) {
      el.classList.add('known');
      el.classList.add('saved');
    }
  });
}

/* ---------------- 查词浮层 ---------------- */

function loadingRow(text) {
  return `<div class="pop-status is-loading"><span class="spinner"></span>${escapeHtml(text)}</div>`;
}

function positionPopover(span) {
  if (!span) return;
  const rect = span.getBoundingClientRect();
  const width = pop.offsetWidth || 350;
  const height = pop.offsetHeight || 240;
  const margin = 10;

  let left = clamp(rect.left + rect.width / 2 - width / 2, margin, window.innerWidth - width - margin);
  let top = rect.bottom + 8;
  if (top + height > window.innerHeight - margin) {
    top = Math.max(margin, rect.top - height - 8);
  }
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;

  // 让浮层从被点的那个词「长」出来
  const ox = clamp(rect.left + rect.width / 2 - left, 16, width - 16);
  const oy = top > rect.bottom ? 0 : height;
  pop.style.transformOrigin = `${Math.round(ox)}px ${Math.round(oy)}px`;
}

function updateSaveButton() {
  const btn = qs('#pop-save');
  if (!activeWord) return;
  const saved = isSaved(activeWord);
  btn.textContent = saved ? '✓ 已在生词本 · 点击移除' : '+ 加入生词本';
  btn.classList.toggle('btn-primary', !saved);
  btn.classList.toggle('btn-ghost', saved);
}

function renderDef(result) {
  const phonEl = qs('#pop-phonetic');
  const audioBtn = qs('#pop-audio');
  const defsEl = qs('#pop-defs');

  if (result.phonetic && !phonEl.textContent) phonEl.textContent = result.phonetic;
  if (result.audio) {
    audioBtn.hidden = false;
    audioBtn.dataset.url = result.audio;
  } else {
    audioBtn.hidden = true;
    delete audioBtn.dataset.url;
  }

  if (!result.ok) {
    defsEl.innerHTML = '<div class="pop-status">没有查到英文释义，可能是人名、专有名词或变形词。</div>';
  } else if (!result.defs.length) {
    defsEl.innerHTML = '<div class="pop-status">这条词条没有释义内容。</div>';
  } else {
    defsEl.innerHTML = result.defs.map((d) => `
      <div class="def-item">
        ${d.pos ? `<span class="pos">${escapeHtml(d.pos)}</span>` : ''}${escapeHtml(d.def)}
        ${d.eg ? `<span class="def-eg">${escapeHtml(d.eg)}</span>` : ''}
      </div>`).join('');
  }
  positionPopover(activeSpan);
}

function renderZh(result) {
  const zhEl = qs('#pop-zh');
  if (!result.ok || !result.zh) {
    zhEl.innerHTML = '<div class="zh-empty">中文暂不可用 · 网络受限，可直接加入生词本</div>';
    positionPopover(activeSpan);
    return;
  }
  zhEl.innerHTML = `<div class="zh">${escapeHtml(result.zh)}<span class="tag">中译 · ${escapeHtml(result.src || '在线')}</span></div>`;
  positionPopover(activeSpan);
}

async function lookupDef(word) {
  const first = await fetchDef(word);
  if (first.ok && first.defs.length) return first;
  for (const form of lemmas(word).slice(1, 4)) {
    const next = await fetchDef(form);
    if (next.ok && next.defs.length) return { ...next, lemma: form };
  }
  return first;
}

async function openPopover(span) {
  const word = span.dataset.w;
  document.querySelectorAll('.w.active').forEach((el) => el.classList.remove('active'));
  span.classList.add('active');
  activeSpan = span;
  activeWord = word;
  activeNote = null;

  pop.classList.remove('is-note');
  const noteBox = qs('#pop-note');
  if (noteBox) { noteBox.hidden = true; noteBox.innerHTML = ''; }

  qs('#pop-word').textContent = word;
  qs('#pop-phonetic').textContent = '';
  qs('#pop-zh').innerHTML = '';
  qs('#pop-defs').innerHTML = loadingRow('取释义中…');
  qs('#pop-audio').hidden = true;
  updateSaveButton();

  pop.classList.add('open');
  positionPopover(span);

  // 网络受限时接口可能很慢：先给一句解释，别让用户对着转圈发呆
  clearTimeout(slowTimer);
  slowTimer = setTimeout(() => {
    if (activeSpan === span && qs('#pop-defs').querySelector('.is-loading')) {
      qs('#pop-defs').innerHTML = loadingRow('还在查… 网络受限时可能较慢，可以先点下面加入生词本');
    }
  }, 3000);

  const defHit = cachedDef(word);
  const zhHit = cachedZh(word);
  if (defHit) renderDef(defHit);
  if (zhHit) renderZh(zhHit);

  // 释义与中译各自独立渲染：中译接口慢，不该拖住释义显示
  const defTask = lookupDef(word).then((def) => {
    if (activeSpan !== span) return;
    clearTimeout(slowTimer);
    renderDef(def);
  });
  const zhTask = fetchZh(word).then((zh) => {
    if (activeSpan === span) renderZh(zh);
  });
  await Promise.allSettled([defTask, zhTask]);
}

function closePopover() {
  if (activeSpan) activeSpan.classList.remove('active');
  pop.classList.remove('open');
  pop.classList.remove('is-note');
  const noteBox = qs('#pop-note');
  if (noteBox) { noteBox.hidden = true; noteBox.innerHTML = ''; }
  activeSpan = null;
  activeWord = null;
  activeNote = null;
}

/* ---------- 讲义注释卡：不查网络，直接给讲义的讲解 ---------- */

const POS_LABEL = {
  n: 'noun', v: 'verb', a: 'adjective', adj: 'adjective', adv: 'adverb',
  vt: 'verb', vi: 'verb', prep: 'prep.', conj: 'conj.', pron: 'pron.',
  num: 'num.', art: 'art.', phrase: 'phrase', phr: 'phrase',
};

function posLabel(pos) {
  const key = String(pos || '').toLowerCase();
  return POS_LABEL[key] || key;
}

function openNote(note, anchor) {
  if (!note) return;
  clearTimeout(slowTimer);

  document.querySelectorAll('.w.active').forEach((el) => el.classList.remove('active'));
  if (anchor?.classList.contains('w')) anchor.classList.add('active');
  activeSpan = anchor;
  activeWord = note.term.toLowerCase();
  activeNote = note;

  qs('#pop-word').textContent = note.term;
  qs('#pop-phonetic').textContent = note.phonetic || '';
  qs('#pop-zh').innerHTML = note.zh
    ? `<div class="zh">${escapeHtml(note.zh)}<span class="tag">讲义注释</span></div>`
    : '';
  qs('#pop-defs').innerHTML = `
    <div class="def-item">
      ${note.pos ? `<span class="pos">${escapeHtml(posLabel(note.pos))}</span>` : ''}${escapeHtml(note.def)}
      ${note.example ? '<span class="def-eg">' + escapeHtml(note.example) + '</span>' : ''}
    </div>`;
  qs('#pop-audio').hidden = false;
  delete qs('#pop-audio').dataset.url;

  const noteBox = qs('#pop-note');
  noteBox.hidden = false;
  noteBox.innerHTML = `
    <div class="note-foot">
      ${note.tag ? `<span class="note-tag">${escapeHtml(note.tag)}</span>` : '<span></span>'}
      <button class="btn btn-sm btn-ghost" id="note-dict" type="button">查词典</button>
    </div>`;

  noteBox.querySelector('#note-dict')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (anchor?.dataset?.w) openPopover(anchor);
  });

  updateSaveButton();
  pop.classList.add('is-note');
  pop.classList.add('open');
  positionPopover(anchor);
}

/* ---------------- 加入 / 移除生词 ---------------- */

async function toggleSave() {
  const word = activeWord;
  if (!word) return;

  if (isSaved(word)) {
    removeWord(word);
    unmarkSaved(word);
    toast(`已从生词本移除：${word}`);
    updateSaveButton();
    return;
  }

  const ctx = activeSpan?.closest('.s')?.textContent?.trim() || '';
  const btn = qs('#pop-save');
  btn.disabled = true;
  btn.textContent = '正在保存…';

  if (activeNote) {
    // 讲义已经给了音标、词性、释义和例句，不用再查一遍网络
    addWord({
      word,
      phonetic: activeNote.phonetic || '',
      zh: activeNote.zh || '',
      defs: [{ pos: activeNote.pos || '', def: activeNote.def, eg: activeNote.example || '' }],
      ctx,
      art: article?.id || '',
      artTitle: article?.title || '',
    });
    btn.disabled = false;
    markSaved(word);
    updateSaveButton();
    flashSaved(btn);
    toast(`已加入生词本：${word}`);
    return;
  }

  const [def, zh] = await Promise.all([lookupDef(word), fetchZh(word)]);
  addWord({
    word,
    phonetic: def.phonetic || qs('#pop-phonetic').textContent,
    zh: zh.ok ? zh.zh : '',
    defs: def.defs,
    ctx,
    art: article?.id || '',
    artTitle: article?.title || '',
  });

  btn.disabled = false;
  markSaved(word);
  updateSaveButton();
  flashSaved(btn);
  toast(`已加入生词本：${word}`);
}

function flashSaved(btn) {
  btn.classList.remove('just-saved');
  // 触发一次重排，保证连续收词时动画能重放
  void btn.offsetWidth;
  btn.classList.add('just-saved');
  setTimeout(() => btn.classList.remove('just-saved'), 560);
}

/* ---------------- 朗读 ---------------- */

function stopIfPlaying(btn) {
  if (speaker.playing) {
    speaker.stop();
    return true;
  }
  return false;
}

bodyEl.addEventListener('click', (e) => {
  const playBtn = e.target.closest('.para-play');
  if (playBtn) {
    if (speaker.button === playBtn) {
      speaker.stop();
      return;
    }
    const para = playBtn.closest('.para');
    speaker.speakNodes(para.querySelectorAll('.s'), playBtn);
    return;
  }

  const word = e.target.closest('.w');
  if (word) {
    e.stopPropagation();
    const term = word.dataset.note;
    const note = term ? noteByTerm.get(term) : null;
    if (note) openNote(note, word);
    else openPopover(word);
    return;
  }
});

document.addEventListener('click', (e) => {
  if (pop.contains(e.target)) return;
  if (e.target.closest('.w') || e.target.closest('.gloss') || e.target.closest('#exam')) return;
  closePopover();
});

qs('#pop-close').addEventListener('click', closePopover);

qs('#pop-audio').addEventListener('click', (e) => {
  const url = e.currentTarget.dataset.url;
  if (url) {
    const audio = new Audio(url);
    audio.play().catch(() => toast('音频加载失败，可点正文里的单词听朗读'));
    return;
  }
  if (activeWord) speaker.speakText(activeWord);
});

qs('#pop-save').addEventListener('click', toggleSave);

let startedReading = false;

function toggleSpeakAll() {
  if (speaker.playing) {
    speaker.stop();
    speakAllBtn.style.color = '';
    return;
  }
  if (!speaker.supported) {
    toast('当前浏览器不支持语音朗读，可试试 Chrome 或 Edge');
    return;
  }
  startedReading = true;
  speaker.onFinish = () => { speakAllBtn.style.color = ''; };
  speaker.speakNodes(bodyEl.querySelectorAll('.s'), null);
  speakAllBtn.style.color = 'var(--accent)';
}

speakAllBtn.addEventListener('click', toggleSpeakAll);

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closePopover();
    speaker.stop();
    speakAllBtn.style.color = '';
    return;
  }
  if (!speaker.supported) return;
  // 空格只在已开始朗读后接管（否则留给页面滚动），K 键任何时候都是播放 / 暂停
  if ((e.key === ' ' && startedReading && e.target === document.body) || e.key === 'k') {
    e.preventDefault();
    toggleSpeakAll();
  }
});

window.addEventListener('resize', () => {
  if (activeSpan) positionPopover(activeSpan);
});

/* ---------------- 字号 ---------------- */

const BASE_SIZE = 19;
let scale = getPrefs().fontScale || 1;

function applyScale() {
  bodyEl.style.fontSize = `${(BASE_SIZE * scale).toFixed(1)}px`;
  if (article) bodyEl.style.lineHeight = 'var(--read-leading)';
  // 行宽跟着字号一起长，保持每行 60～70 个字符的舒服区间
  document.documentElement.style.setProperty('--col', `${(41 * scale).toFixed(2)}rem`);
}

function nudgeScale(delta) {
  scale = clamp(Number((scale + delta).toFixed(2)), 0.85, 1.6);
  setPref('fontScale', scale);
  applyScale();
  toast(`正文字号 ${Math.round(scale * 100)}%`);
}

qs('#font-smaller').addEventListener('click', () => {
  nudgeScale(-0.05);
  repaintTicks();
});
qs('#font-larger').addEventListener('click', () => {
  nudgeScale(0.05);
  repaintTicks();
});

/* ---------------- 进度 ---------------- */

function currentPct() {
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) return 1;
  return clamp(window.scrollY / max, 0, 1);
}

function paintRail() {
  const pct = currentPct();
  rail.style.width = `${(pct * 100).toFixed(1)}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct * 100)}%`;
}

/* 进度条上的段落刻度：像尺子一样标出每一段的位置 */
const ticksEl = qs('#rail-ticks');

function paintTicks() {
  if (!ticksEl) return;
  const max = document.documentElement.scrollHeight - window.innerHeight;
  if (max <= 0) {
    ticksEl.innerHTML = '';
    return;
  }
  const paras = qsa('.article-body > .para');
  /* 文章末尾几段在滚动上会都贴到 100%，挤成一团；间距太近的刻度直接跳过 */
  const marks = [];
  paras.forEach((p, i) => {
    const y = p.getBoundingClientRect().top + window.scrollY;
    const pct = clamp(y / max, 0, 1) * 100;
    if (marks.length && pct - marks[marks.length - 1].pct < 1.2) return;
    marks.push({ pct, i });
  });
  ticksEl.innerHTML = marks
    .map(({ pct, i }) => `<span class="rail-tick" data-i="${i}" style="left:${pct.toFixed(3)}%"></span>`)
    .join('');
}

const repaintTicks = debounce(paintTicks, 180);
window.addEventListener('resize', repaintTicks);

/* 朗读到哪一段，就在刻度上点亮哪一格 */
window.addEventListener('er:speak', (e) => {
  if (!ticksEl) return;
  ticksEl.querySelectorAll('.rail-tick').forEach((t) => t.classList.remove('is-current'));
  if (!e.detail?.speaking || !e.detail.node) return;
  const para = e.detail.node.closest?.('.para');
  if (!para) return;
  const tick = ticksEl.querySelector(`.rail-tick[data-i="${para.dataset.i}"]`);
  tick?.classList.add('is-current');
});

const persistProgress = debounce(() => {
  if (!article) return;
  saveProgress(article.id, currentPct(), 0);
}, 500);

/* 读完这一篇之后，给它一个句号：这一篇收了多少词、下一站在哪 */
const doneEl = qs('#article-done');
const footReview = document.querySelector('.article-foot a[href="vocab.html"]');
let doneShown = false;

function updateDone(pct) {
  if (!doneEl || !article) return;
  const finished = pct >= 0.97;
  if (finished === doneShown) return;
  doneShown = finished;
  if (!finished) {
    doneEl.hidden = true;
    if (footReview) footReview.hidden = false;
    return;
  }
  const mine = vocabList().filter((v) => v.art === article.id);
  const due = mine.filter((v) => (v.due || 0) <= Date.now()).length;
  const line = mine.length
    ? `这一篇你收了 ${mine.length} 个词${due ? `，其中 ${due} 个现在就能复习` : '，都在生词本里等你'}。`
    : '这一篇没有收生词——下次遇到卡住的词，点一下就能带走。';
  qs('#done-line').textContent = line;
  qs('#done-review').textContent = mine.length ? '去复习这一篇的词' : '打开生词本';
  const next = qs('#done-next');
  if (nextArticle) {
    next.hidden = false;
    next.href = `reader.html?id=${encodeURIComponent(nextArticle.id)}`;
  } else {
    next.hidden = true;
  }
  doneEl.hidden = false;
  // 收尾卡里已经有「去复习」和「下一篇」，页脚里那个重复的入口就先藏起来
  if (footReview) footReview.hidden = true;
}

let rafPending = false;
window.addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    const pct = currentPct();
    paintRail();
    updateDone(pct);
    persistProgress();
  });
}, { passive: true });

let lastTick = Date.now();
function flushReadingTime() {
  const now = Date.now();
  const delta = (now - lastTick) / 1000;
  lastTick = now;
  if (!article) return;
  if (document.visibilityState !== 'visible') return;
  if (delta < 1 || delta > 120) return;
  saveProgress(article.id, currentPct(), delta);
}
setInterval(flushReadingTime, 15000);
window.addEventListener('pagehide', flushReadingTime);
document.addEventListener('visibilitychange', () => { lastTick = Date.now(); });

/* ---------------- 启动 ---------------- */

async function boot() {
  applyScale();
  const params = new URLSearchParams(location.search);
  const id = params.get('id');

  if (!id) {
    renderError('地址里没有文章 id。');
    return;
  }

  try {
    article = await getArticle(id);
  } catch (err) {
    console.error(err);
    article = null;
  }

  if (!article) {
    renderError(`文章 ${id} 不存在，可能已被删除。`);
    return;
  }

  /* 讲义文章：有段落译文 / 注释 / 作业就用它渲染，普通文章走原来的单语路径 */
  lesson = article.lesson?.paragraphs?.length ? article.lesson : null;
  noteByTerm = new Map((lesson?.notes || []).map((n) => [n.term, n]));
  noteIndex = lesson ? buildNoteIndex(lesson.notes) : null;
  bilingual = lesson ? getPrefs().bilingual !== false : false;

  renderHead(article);
  renderBody(article);
  refreshHighlights();
  initLangToggle();
  renderExam();
  renderGlossary();
  paintRail();
  paintTicks();
  /* 字体加载完成后行高会变，刻度跟着重排一次 */
  if (document.fonts?.ready) document.fonts.ready.then(repaintTicks);

  /* 下一篇 = 文章库里更新的一篇（找不到就退回文章库） */
  try {
    const lib = await loadLibrary();
    const idx = lib.findIndex((a) => a.id === article.id);
    nextArticle = idx >= 0 ? lib[idx + 1] || null : null;
  } catch { nextArticle = null; }
  updateDone(currentPct());

  const saved = getProgress(article.id);
  if (saved && saved.pct > 0.02 && saved.pct < 0.965) {
    requestAnimationFrame(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      if (max > 0) window.scrollTo(0, Math.round(max * saved.pct));
      paintRail();
      toast(`已回到上次读到的地方 · ${Math.round(saved.pct * 100)}%`);
    });
  }
}

boot();
