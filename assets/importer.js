/* ============================================================
   importer.js · 粘贴导入文章（存本机 → 可导出发布）
   ============================================================ */

import {
  saveLocalArticle, localArticles, removeLocalArticle, invalidateLibrary,
  escapeHtml, countWords, formatDate, debounce,
} from './core.js';
import { initChrome, toast, qs, scrollBehavior } from './ui.js';

initChrome('import');

const bodyEl = qs('#f-body');
const titleEl = qs('#f-title');
const subtitleEl = qs('#f-subtitle');
const sourceEl = qs('#f-source');
const dateEl = qs('#f-date');
const levelEl = qs('#f-level');
const tagsEl = qs('#f-tags');
const summaryEl = qs('#f-summary');
const previewPane = qs('#preview-pane');
const localList = qs('#local-list');

dateEl.value = new Date().toISOString().slice(0, 10);

/* ---------------- 文本切分 ---------------- */

function splitParagraphs(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function splitTags(raw) {
  return String(raw)
    .split(/[,，;；]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
}

/* ---------------- 字数 ---------------- */

const updateCount = debounce(() => {
  const words = countWords(bodyEl.value);
  qs('#word-count').textContent = `${words} 词 · ${splitParagraphs(bodyEl.value).length} 段`;
}, 200);

bodyEl.addEventListener('input', updateCount);

/* ---------------- 预览 ---------------- */

qs('#preview').addEventListener('click', () => {
  const paragraphs = splitParagraphs(bodyEl.value);
  if (!paragraphs.length) {
    toast('先粘贴一些正文');
    return;
  }
  previewPane.hidden = false;
  previewPane.innerHTML = `
    <div class="preview-kicker">预览 · ${paragraphs.length} 段 · ${countWords(paragraphs.join(' '))} 词</div>
    <h3>${escapeHtml(titleEl.value.trim() || '（未填标题）')}</h3>
    ${paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('')}`;
  previewPane.scrollIntoView({ behavior: scrollBehavior(), block: 'start' });
});

/* ---------------- 保存 ---------------- */

function buildArticle() {
  const paragraphs = splitParagraphs(bodyEl.value);
  if (!paragraphs.length) {
    toast('正文是空的，先粘贴文章');
    return null;
  }

  let title = titleEl.value.trim();
  if (!title) {
    title = paragraphs[0].split(/(?<=[.!?])\s/)[0].slice(0, 90);
  }

  return {
    id: `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    title,
    subtitle: subtitleEl.value.trim(),
    source: sourceEl.value.trim(),
    author: '',
    date: dateEl.value || '',
    level: levelEl.value || '',
    tags: splitTags(tagsEl.value),
    summary: summaryEl.value.trim(),
    paragraphs,
    ...(parsedLesson ? { lesson: parsedLesson } : {}),
    createdAt: new Date().toISOString(),
  };
}

qs('#save').addEventListener('click', () => {
  const article = buildArticle();
  if (!article) return;

  // 同名文章给出提示但仍允许保存（可能是不同期的同题文章）
  const dup = localArticles().find((a) => a.title === article.title);
  saveLocalArticle(article);
  invalidateLibrary();

  renderLocal();
  toast(dup ? '已保存（同名文章已存在）' : '已保存，正在打开…');

  setTimeout(() => {
    location.href = `reader.html?id=${encodeURIComponent(article.id)}`;
  }, 550);
});

qs('#reset').addEventListener('click', () => {
  [bodyEl, titleEl, subtitleEl, summaryEl, tagsEl].forEach((el) => { el.value = ''; });
  previewPane.hidden = true;
  parsedLesson = null;
  updateCount();
  toast('表单已清空');
});

/* ---------------- 文件读取 ---------------- */

const pdfStatus = qs('#pdf-status');
const levelOptions = Array.from(levelEl.options).map((o) => o.value);

function setStatus(html) {
  if (!html) {
    pdfStatus.hidden = true;
    pdfStatus.innerHTML = '';
    return;
  }
  pdfStatus.hidden = false;
  pdfStatus.innerHTML = html;
}

function loadText(file) {
  const reader = new FileReader();
  reader.onload = () => {
    bodyEl.value = String(reader.result || '');
    if (!titleEl.value.trim()) {
      const name = file.name.replace(/\.(txt|md|markdown)$/i, '').replace(/[-_]+/g, ' ').trim();
      if (name) titleEl.value = name;
    }
    updateCount();
    toast(`已读取 ${file.name}`);
  };
  reader.onerror = () => toast('文件读取失败');
  reader.readAsText(file, 'utf-8');
}

const PDF_MAX = 80 * 1024 * 1024;
let parsedLesson = null;

async function loadPdf(file) {
  if (file.size > PDF_MAX) {
    toast('这个 PDF 太大了（超过 80MB）');
    return;
  }
  if (typeof DecompressionStream === 'undefined') {
    setStatus('<b>当前浏览器不支持解析 PDF</b><div class="pdf-warn">需要 Chrome 80+ / Edge / Safari 16.4+。可以先另存为 txt 再拖进来。</div>');
    return;
  }

  const started = Date.now();
  setStatus(`<span class="pdf-spin" aria-hidden="true"></span> 正在解析 ${escapeHtml(file.name)}…`);

  try {
    // 解析器只在真的用到时才加载，平时打开导入页不背这个包
    const [{ pdfToText, flattenLines }, { extractArticle }, { lessonFromLines }] = await Promise.all([
      import('./pdftext.js'),
      import('./pdfextract.js'),
      import('./pdflesson.js'),
    ]);
    const buf = await file.arrayBuffer();
    const doc = await pdfToText(buf);
    const res = extractArticle(doc);

    // 讲义类 PDF 还带段落译文、词汇注释和翻译作业，一起收下来
    let lesson = null;
    try {
      const parsed = lessonFromLines(flattenLines(doc));
      if (parsed?.ok && parsed.paragraphs.length) lesson = parsed;
    } catch (err) {
      console.warn('lesson parse failed', err);
    }
    parsedLesson = lesson;

    if (!res.ok) {
      setStatus(`<b>没解析出正文</b><div class="pdf-warn">${escapeHtml(res.warnings[0] || '换个文件试试')}</div>`);
      toast('这份 PDF 没能自动解析');
      return;
    }

    if (res.title) titleEl.value = res.title;
    if (res.subtitle) subtitleEl.value = res.subtitle;
    if (res.source) sourceEl.value = res.source;
    if (res.date) dateEl.value = res.date;
    if (res.level && levelOptions.includes(res.level)) levelEl.value = res.level;
    if (res.summary) summaryEl.value = res.summary;
    if (res.paragraphs.length) bodyEl.value = res.paragraphs.join('\n\n');
    updateCount();

    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const stat = `${res.stats.pages} 页 · ${res.stats.paragraphs} 段 · ${res.stats.words} 词 · ${secs}s`;
    const lessonMeta = lesson
      ? `<div class="pdf-meta pdf-lesson">讲义结构 · ${lesson.stats.translated} 段译文 · ${lesson.stats.notes} 条词汇注释${
          lesson.stats.hasExercise ? ' · 翻译作业' : ''
        }${lesson.stats.hasAnalysis ? ' · 句子分析' : ''}</div>`
      : '';
    const warns = res.warnings.length
      ? `<div class="pdf-warn">${res.warnings.map((w) => escapeHtml(w)).join('<br>')}</div>`
      : '';
    setStatus(
      `<b>已解析：${escapeHtml(res.title || file.name)}</b>
       <div class="pdf-meta">${stat}${res.source ? ` · ${escapeHtml(res.source)}` : ''}${res.level ? ` · ${escapeHtml(res.level)}` : ''}</div>
       ${lessonMeta}
       ${warns}
       <div class="pdf-tip">${
         lesson
           ? '识别成讲义：保存后精读页会有中英对照开关、虚线标注的词汇讲解和文末翻译作业。'
           : '标题、来源、难度都按 PDF 里的信息填好了；去掉的页眉页脚和词汇注释没有进正文，可以点「预览分段」看一眼再保存。'
       }</div>`,
    );
    toast('PDF 解析完成');
  } catch (err) {
    console.error(err);
    setStatus(`<b>解析失败</b><div class="pdf-warn">${escapeHtml(err?.message || String(err))}</div>`);
    toast('PDF 解析失败');
  }
}

function handleFile(file) {
  if (!file) return;
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    loadPdf(file);
    return;
  }
  setStatus('');
  loadText(file);
}

qs('#f-file').addEventListener('change', (e) => handleFile(e.target.files?.[0]));

const dropTargets = [bodyEl, pdfStatus.parentElement || bodyEl];
dropTargets.forEach((el) => {
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    el.classList.add('drag-over');
  });
  el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    el.classList.remove('drag-over');
    handleFile(e.dataTransfer?.files?.[0]);
  });
});

// 整页拖放：拖到页面任何地方都算，免得用户非要瞄准那个小框
const veil = qs('#drop-veil');
const veilSub = qs('#drop-veil-sub');
const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');

/* dragover 阶段拿不到文件名，但能拿到 MIME；据此换一句更具体的提示 */
function dragHint(e) {
  const items = Array.from(e.dataTransfer?.items || []);
  const types = items.map((it) => it.type || '');
  const isPdf = types.some((t) => t === 'application/pdf');
  const isText = types.some((t) => /^text\//.test(t));
  if (isPdf) return 'PDF 会自动去掉页眉页脚、词汇注释和译文，只留下英文正文';
  if (isText) return 'txt / md 按空行切段，一行一段直接读';
  if (items.some((it) => it.kind === 'file')) return '支持 PDF / txt / md';
  return '松手即可导入';
}

window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  if (veilSub) veilSub.textContent = dragHint(e);
  veil.hidden = false;
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', (e) => {
  if (!hasFiles(e)) return;
  if (e.relatedTarget) return;
  veil.hidden = true;
});
window.addEventListener('drop', (e) => {
  veil.hidden = true;
  if (!hasFiles(e)) return;
  e.preventDefault();
  handleFile(e.dataTransfer?.files?.[0]);
});

/* ---------------- 本机文章列表 ---------------- */

function renderLocal() {
  const list = localArticles();
  if (!list.length) {
    localList.innerHTML = '<div class="empty">还没有本机文章。粘贴一篇试试。</div>';
    return;
  }
  localList.innerHTML = list.map((a) => {
    const words = countWords((a.paragraphs || []).join(' '));
    return `<div class="lib-item" style="align-items:center">
      <div>
        <div class="lib-meta">
          ${a.level ? `<span class="chip chip-accent">${escapeHtml(a.level)}</span>` : ''}
          ${a.source ? `<span>${escapeHtml(a.source)}</span><span>·</span>` : ''}
          <span>${formatDate(a.date)}</span><span>·</span><span>${words} 词</span>
        </div>
        <h3 class="lib-title" style="margin-bottom:.2rem">
          <a href="reader.html?id=${encodeURIComponent(a.id)}">${escapeHtml(a.title)}</a>
        </h3>
        ${a.subtitle ? `<div class="lib-sub">${escapeHtml(a.subtitle)}</div>` : ''}
      </div>
      <div class="lib-side" style="flex-direction:row;align-items:center">
        <a class="btn btn-sm" href="reader.html?id=${encodeURIComponent(a.id)}">阅读</a>
        <button class="btn btn-sm btn-ghost" data-remove="${escapeHtml(a.id)}">删除</button>
      </div>
    </div>`;
  }).join('');

  localList.querySelectorAll('[data-remove]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!window.confirm('删除这篇本机文章？')) return;
      removeLocalArticle(btn.dataset.remove);
      invalidateLibrary();
      renderLocal();
      toast('已删除');
    });
  });
}

/* ---------------- 导出 ---------------- */

qs('#export-local').addEventListener('click', () => {
  const articles = localArticles().map(({ local, ...rest }) => rest);
  if (!articles.length) {
    toast('还没有可导出的文章');
    return;
  }
  const payload = { version: 1, updatedAt: new Date().toISOString(), articles };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'articles.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast('已导出：把内容合并进 data/articles.json 即可公开');
});

renderLocal();
updateCount();
