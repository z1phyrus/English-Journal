/* ============================================================
   vocab.js · 生词本与间隔复习
   ============================================================ */

import {
  vocabList, dueWords, removeWord, clearVocab, reviewWord, nextIntervalDays,
  relDue, todayStat, escapeHtml, debounce,
} from './core.js';
import { initChrome, Speaker, toast, qs } from './ui.js';

initChrome('vocab');

const areaEl = qs('#vocab-area');
const searchEl = qs('#vocab-search');
const sortEl = qs('#vocab-sort');
const overlay = qs('#review');
const cardEl = qs('#rv-card');
const actionsEl = qs('#rv-actions');
const speaker = new Speaker();

const state = { q: '', sort: 'due' };

/* ---------------- 列表 ---------------- */

function rows() {
  const q = state.q.trim().toLowerCase();
  let list = vocabList();
  if (q) {
    list = list.filter((item) => {
      const hay = [item.word, item.zh, ...(item.defs || []).map((d) => d.def)].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }
  if (state.sort === 'alpha') list.sort((a, b) => a.word.localeCompare(b.word, 'en'));
  else if (state.sort === 'added') list.sort((a, b) => (b.addedAt || 0) - (a.addedAt || 0));
  else list.sort((a, b) => (a.due || 0) - (b.due || 0));
  return list;
}

function render() {
  const all = vocabList();
  const due = dueWords();
  const today = todayStat();

  qs('#due-count').textContent = String(due.length);
  qs('#mini-stats').textContent = `共 ${all.length} 词 · 今日新增 ${today.added || 0} · 今日复习 ${today.reviews || 0}`;
  qs('#start-review').disabled = due.length === 0;

  const list = rows();
  if (!all.length) {
    areaEl.innerHTML = `<div class="empty">
      生词本还是空的。去读一篇文章，点一下不认识的词就能把它收进来。
      <div style="margin-top:1rem"><a class="btn btn-sm btn-primary" href="index.html">去看文章</a></div>
    </div>`;
    return;
  }
  if (!list.length) {
    areaEl.innerHTML = '<div class="empty">没有匹配的生词。</div>';
    return;
  }

  areaEl.innerHTML = `
    <table class="vocab-table">
      <thead>
        <tr>
          <th style="width:20%">单词</th>
          <th>释义</th>
          <th class="col-src" style="width:18%">来源</th>
          <th class="col-due" style="width:12%">下次复习</th>
          <th style="width:2.5rem"></th>
        </tr>
      </thead>
      <tbody>
        ${list.map((item) => {
          const def = item.zh || (item.defs && item.defs[0] ? item.defs[0].def : '');
          const extra = item.zh && item.defs && item.defs[0] ? item.defs[0].def : '';
          const isDue = (item.due || 0) <= Date.now();
          return `<tr data-word="${escapeHtml(item.word)}">
            <td>
              <div class="vocab-word">${escapeHtml(item.word)}</div>
              ${item.phonetic ? `<div class="vocab-phon">${escapeHtml(item.phonetic)}</div>` : ''}
            </td>
            <td>
              <div class="vocab-def">${escapeHtml(def) || '<span style="opacity:.5">—</span>'}</div>
              ${extra ? `<div class="vocab-src">${escapeHtml(extra)}</div>` : ''}
              <div class="vocab-sub">
                <span class="vocab-due ${isDue ? 'now' : ''}">${relDue(item.due)}</span>
                ${item.artTitle ? `<span class="sep">·</span><span class="vocab-sub-src">${escapeHtml(item.artTitle)}</span>` : ''}
              </div>
            </td>
            <td class="col-src"><div class="vocab-src">${escapeHtml(item.artTitle || '—')}</div></td>
            <td class="col-due"><div class="vocab-due ${isDue ? 'now' : ''}">${relDue(item.due)}</div></td>
            <td><button class="row-del" data-del="${escapeHtml(item.word)}" title="删除" aria-label="删除 ${escapeHtml(item.word)}">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
            </button></td>
          </tr>`;
        }).join('')}
      </tbody>
    </table>`;

  areaEl.querySelectorAll('[data-del]').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const word = btn.dataset.del;
      removeWord(word);
      toast(`已删除：${word}`);
      render();
    });
  });

  areaEl.querySelectorAll('tr[data-word]').forEach((tr) => {
    tr.addEventListener('click', () => {
      speaker.speakText(tr.dataset.word);
    });
  });
}

/* ---------------- 复习 ---------------- */

let queue = [];
let idx = 0;
let revealed = false;
let session = { again: 0, hard: 0, good: 0 };

function fmtInterval(days) {
  if (!days) return '';
  const minutes = days * 24 * 60;
  if (minutes < 60) return `${Math.max(1, Math.round(minutes))} 分钟`;
  const hours = days * 24;
  if (hours < 24) return `${Math.round(hours)} 小时`;
  return `${Math.round(days)} 天`;
}

function startReview(words) {
  const list = (words || dueWords()).slice(0, 40);
  if (!list.length) {
    toast('今天没有到期的生词');
    return;
  }
  queue = list;
  idx = 0;
  revealed = false;
  session = { again: 0, hard: 0, good: 0 };
  overlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  renderCard();
}

function closeReview() {
  overlay.classList.remove('open');
  document.body.style.overflow = '';
  speaker.stop();
  render();
}

function renderCard() {
  const item = queue[idx];
  if (!item) {
    renderDone();
    return;
  }

  qs('#rv-progress').textContent = `${idx + 1} / ${queue.length}`;
  overlay.classList.remove('is-done');

  const defsHtml = (item.defs || [])
    .slice(0, 2)
    .map((d) => `<div class="def-item">${d.pos ? `<span class="pos">${escapeHtml(d.pos)}</span>` : ''}${escapeHtml(d.def)}</div>`)
    .join('');

  cardEl.innerHTML = `
    <div class="rv-flip" id="rv-flip">
      <div class="rv-face rv-front">
        <div class="word">${escapeHtml(item.word)}</div>
        ${item.phonetic ? `<div class="phon">${escapeHtml(item.phonetic)}</div>` : ''}
      </div>
      <div class="rv-face rv-back">
        <div id="rv-answer" class="answer" hidden>
          ${item.zh ? `<div class="zh">${escapeHtml(item.zh)}</div>` : ''}
          ${defsHtml || (item.zh ? '' : '<div style="opacity:.6">（没有保存释义）</div>')}
          ${item.ctx ? `<div class="ctx">“${escapeHtml(item.ctx)}”</div>` : ''}
        </div>
      </div>
    </div>
    <div style="margin-top:1.6rem" id="rv-reveal-wrap">
      <button class="btn" id="rv-reveal">显示释义 <span style="opacity:.45;font-size:.78em">空格</span></button>
    </div>`;

  actionsEl.innerHTML = '';
  revealed = false;
  qs('#rv-reveal').addEventListener('click', reveal);
}

function reveal() {
  if (revealed || !queue[idx]) return;
  revealed = true;
  qs('#rv-answer').hidden = false;
  const flip = qs('#rv-flip');
  if (flip) flip.classList.add('flipped');
  const wrap = qs('#rv-reveal-wrap');
  if (wrap) wrap.style.display = 'none';

  const item = queue[idx];
  const options = [
    { grade: 'again', label: '忘了', cls: 'rate-again' },
    { grade: 'hard', label: '模糊', cls: 'rate-hard' },
    { grade: 'good', label: '记得', cls: 'rate-good' },
  ];

  actionsEl.innerHTML = options.map((o) => {
    const days = o.grade === 'again' ? '10 分钟' : fmtInterval(nextIntervalDays(item.word, o.grade));
    return `<button class="btn ${o.cls}" data-grade="${o.grade}">
      ${o.label}<span style="opacity:.65;font-size:.78em">${days}</span>
    </button>`;
  }).join('');

  actionsEl.querySelectorAll('[data-grade]').forEach((btn) => {
    btn.addEventListener('click', () => rate(btn.dataset.grade));
  });
}

function rate(grade) {
  const item = queue[idx];
  if (!item) return;
  reviewWord(item.word, grade);
  session[grade] = (session[grade] || 0) + 1;
  idx += 1;
  renderCard();
}

function renderDone() {
  qs('#rv-progress').textContent = `${queue.length} / ${queue.length}`;
  overlay.classList.add('is-done');
  cardEl.innerHTML = `
    <div class="review-done">
      <span class="asterism done-mark" aria-hidden="true"></span>
      <div class="big">这一轮结束了</div>
      <p class="done-summary">
        <span class="ds"><i>${session.good}</i><em>记得</em></span>
        <span class="ds"><i>${session.hard}</i><em>模糊</em></span>
        <span class="ds"><i>${session.again}</i><em>忘了</em></span>
      </p>
      <p class="done-tip">忘了的词 10 分钟后会再次到期，随时回来复习。</p>
    </div>`;
  actionsEl.innerHTML = '<button class="btn btn-primary" id="rv-done">完成</button>';
  qs('#rv-done').addEventListener('click', closeReview);
}

qs('#start-review').addEventListener('click', () => startReview());
qs('#rv-close').addEventListener('click', closeReview);

document.addEventListener('keydown', (e) => {
  if (!overlay.classList.contains('open')) return;
  if (e.key === 'Escape') {
    closeReview();
    return;
  }
  if (!revealed && (e.key === ' ' || e.key === 'Enter')) {
    e.preventDefault();
    reveal();
    return;
  }
  if (revealed && ['1', '2', '3'].includes(e.key)) {
    e.preventDefault();
    rate({ 1: 'again', 2: 'hard', 3: 'good' }[e.key]);
  }
});

/* ---------------- 工具按钮 ---------------- */

const refresh = debounce(() => {
  state.q = searchEl.value;
  render();
}, 120);
searchEl.addEventListener('input', refresh);
sortEl.addEventListener('change', () => {
  state.sort = sortEl.value;
  render();
});

qs('#export-vocab').addEventListener('click', () => {
  const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), words: vocabList() }, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `生词本备份-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出备份文件');
});

qs('#clear-vocab').addEventListener('click', () => {
  const count = vocabList().length;
  if (!count) return;
  if (!window.confirm(`确定清空全部 ${count} 个生词吗？此操作不可撤销，建议先导出备份。`)) return;
  clearVocab();
  toast('生词本已清空');
  render();
});

render();
