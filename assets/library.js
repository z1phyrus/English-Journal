/* ============================================================
   library.js · 首页文章库
   ============================================================ */

import {
  loadLibrary, getProgress, vocabList, dueWords, allProgress,
  formatDate, escapeHtml, debounce,
} from './core.js';
import { initChrome, qs, toast } from './ui.js';

initChrome('library');

const state = { all: [], q: '', level: '', sort: 'date' };

const listEl = qs('#lib-list');
const countEl = qs('#lib-count');
const searchEl = qs('#search');
const levelEl = qs('#level-filter');
const sortEl = qs('#sort');

function renderStats(lib) {
  const progress = allProgress();
  const started = Object.values(progress).filter((p) => p && p.pct > 0.02).length;
  qs('#st-articles').textContent = String(lib.length);
  qs('#st-read').textContent = String(started);
  qs('#st-vocab').textContent = String(vocabList().length);
  qs('#st-due').textContent = String(dueWords().length);
}

function fillLevels(lib) {
  const levels = [...new Set(lib.map((a) => a.level).filter(Boolean))].sort();
  for (const lv of levels) {
    const opt = document.createElement('option');
    opt.value = lv;
    opt.textContent = lv;
    levelEl.appendChild(opt);
  }
}

function visible() {
  const q = state.q.trim().toLowerCase();
  let rows = state.all.filter((a) => {
    if (state.level && a.level !== state.level) return false;
    if (!q) return true;
    return [a.title, a.subtitle, a.source, a.summary, ...(a.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(q);
  });

  if (state.sort === 'title') {
    rows.sort((a, b) => a.title.localeCompare(b.title, 'en'));
  } else if (state.sort === 'short') {
    rows.sort((a, b) => a.words - b.words);
  } else {
    rows.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  }
  return rows;
}

function render() {
  const rows = visible();
  countEl.textContent = `${state.all.length} 篇${rows.length !== state.all.length ? ` · 命中 ${rows.length}` : ''}`;

  if (!rows.length) {
    listEl.innerHTML = state.all.length
      ? '<div class="empty">没有匹配的文章，换个关键词试试。</div>'
      : '<div class="empty">还没有文章。<a class="btn btn-sm" style="margin-left:.6rem" href="import.html">去导入第一篇</a></div>';
    return;
  }

  listEl.innerHTML = rows.map((a) => {
    const p = getProgress(a.id);
    const pct = Math.min(100, Math.round((p ? p.pct || 0 : 0) * 100));
    const tags = (a.tags || [])
      .map((t) => `<span class="chip">${escapeHtml(t)}</span>`)
      .join('');

    // 右侧只回答一个问题：这篇我读到哪儿了
    let side;
    if (pct >= 98) {
      side = `<span class="lib-state is-done">已读完</span>
        <div class="lib-progress"><i style="width:100%"></i></div>`;
    } else if (pct > 0) {
      side = `<span class="lib-state is-reading">在读 ${pct}%</span>
        <div class="lib-progress"><i style="width:${pct}%"></i></div>`;
    } else {
      side = `<span class="lib-state">未读</span>`;
    }

    return `
      <a class="lib-item" href="reader.html?id=${encodeURIComponent(a.id)}" data-state="${pct >= 98 ? 'done' : pct > 0 ? 'reading' : 'unread'}">
        <div>
          <div class="lib-meta">
            ${a.level ? `<span class="chip chip-accent">${escapeHtml(a.level)}</span>` : ''}
            ${a.source ? `<span>${escapeHtml(a.source)}</span>` : ''}
            ${a.date ? `<span class="sep">·</span><span>${escapeHtml(formatDate(a.date))}</span>` : ''}
            <span class="sep">·</span><span>${a.words} 词 · 约 ${a.minutes} 分钟</span>
            ${a.local ? '<span class="chip">本机</span>' : ''}
          </div>
          <h3 class="lib-title">${escapeHtml(a.title)}</h3>
          ${a.subtitle ? `<div class="lib-sub">${escapeHtml(a.subtitle)}</div>` : ''}
          ${a.summary ? `<p class="lib-summary">${escapeHtml(a.summary)}</p>` : ''}
          ${tags ? `<div class="lib-meta" style="margin-top:.7rem">${tags}</div>` : ''}
        </div>
        <div class="lib-side">${side}</div>
      </a>`;
  }).join('');
}

/* 上次读到——取最近一次、且还没读完的那篇 */
function renderResume(lib) {
  const el = qs('#resume');
  if (!el) return;
  const entries = Object.entries(allProgress())
    .filter(([, p]) => p && p.pct > 0.02 && p.pct < 0.985)
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  for (const [id, p] of entries) {
    const art = lib.find((a) => a.id === id);
    if (!art) continue;
    const pct = Math.round(p.pct * 100);
    el.hidden = false;
    el.href = `reader.html?id=${encodeURIComponent(id)}`;
    qs('#resume-title').textContent = art.title;
    qs('#resume-title').title = art.title;
    qs('#resume-pct').textContent = `${pct}%`;
    qs('#resume-fill').style.width = `${pct}%`;
    return;
  }
  el.hidden = true;
}

async function boot() {
  try {
    state.all = await loadLibrary();
  } catch (err) {
    console.error(err);
    toast('文章库加载失败，请检查 data/articles.json');
    state.all = [];
  }
  fillLevels(state.all);
  renderStats(state.all);
  renderResume(state.all);
  render();
}

const refresh = debounce(() => {
  state.q = searchEl.value;
  render();
}, 120);

searchEl.addEventListener('input', refresh);
levelEl.addEventListener('change', () => {
  state.level = levelEl.value;
  render();
});
sortEl.addEventListener('change', () => {
  state.sort = sortEl.value;
  render();
});

document.addEventListener('keydown', (e) => {
  if (e.key === '/' && document.activeElement !== searchEl) {
    e.preventDefault();
    searchEl.focus();
  }
});

boot();
