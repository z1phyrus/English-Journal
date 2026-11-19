import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || 'chrome';
}

const CHROME = findChrome();
const PORT = Number(process.env.CDP_PORT || 9333);
const BASE = process.env.BASE_URL || 'http://127.0.0.1:5173';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getJson(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--remote-allow-origins=*',
  `--user-data-dir=${profile}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--disable-extensions',
  '--window-size=1280,1400',
  'about:blank',
], { stdio: 'ignore' });

let ws;
const pending = new Map();
let seq = 0;
const errors = [];

function send(method, params = {}) {
  const id = ++seq;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout ${method}`)); }
    }, 15000);
  });
}

async function ev(expression) {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { ${expression} })()`,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) {
    throw new Error('eval failed: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  }
  return r.result.value;
}

async function waitFor(expression, label, timeout = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      if (await ev(`return !!(${expression});`)) return true;
    } catch { /* page may be navigating */ }
    await sleep(120);
  }
  throw new Error(`timeout waiting: ${label}`);
}

async function goto(url) {
  await send('Page.navigate', { url });
  await waitFor(`document.readyState === 'complete'`, 'load ' + url);
  await sleep(400);
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
}

// 现合成一个最小 PDF（未压缩、Helvetica、真空格字形），用来测解析器的通用路径
function buildSynthPdf() {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const content = [
    { size: 20, text: 'Mental block', y: 760 },
    { size: 12, text: 'As the command centre of the human body, the brain requires the best protection', y: 660 },
    { size: 12, text: 'biology can supply. The hard, bony casing of the skull helps to shield the organ.', y: 645 },
    { size: 12, text: 'In a new study, published in Cell on November 11th, a team led by Andrew Yang', y: 590 },
    { size: 12, text: 'showed that the barrier plays a far more active role in brain health than expected.', y: 575 },
    { size: 12, text: 'The word block also appears in the third paragraph of this short sample article.', y: 520 },
  ].map((l) => `BT /F1 ${l.size} Tf 1 0 0 1 90 ${l.y} Tm (${esc(l.text)}) Tj ET`).join('\n');

  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /FirstChar 32 /LastChar 126 /Widths [${Array.from({ length: 95 }, () => 500).join(' ')}] >>`,
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  offsets.forEach((o) => { out += `${String(o).padStart(10, '0')} 00000 n \n`; });
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

async function main() {
  // 先确认本地服务器在跑
  try {
    const res = await fetch(`${BASE}/data/articles.json`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`连不上 ${BASE}（${err.message}）—— 先在另一个终端运行 node tools/serve.mjs`);
  }

  // PDF 解析：用现合成的最小 PDF 跑一遍，不依赖浏览器，也不需要样本文件
  try {
    const { pdfToText } = await import('../assets/pdftext.js');
    const { extractArticle } = await import('../assets/pdfextract.js');
    const doc = await pdfToText(buildSynthPdf());
    const res = extractArticle(doc);
    const p = res.paragraphs;
    const ok = doc.pages.length === 1 && p.length === 3
      && res.title === 'Mental block'
      && p[0].startsWith('As the command centre of the human body')
      && p[1].includes('In a new study')
      && !/[\u4e00-\u9fff]/.test(p.join(' '));
    check('pdf: 合成 PDF 解析出 3 段纯英文', ok,
      `pages=${doc.pages.length} paras=${p.length} title=${res.title} first=${(p[0] || '').slice(0, 30)}`);
  } catch (err) {
    check('pdf: 合成 PDF 解析出 3 段纯英文', false, err.message);
  }

  // 讲义解析：直接喂「行」数组，不依赖浏览器与样本文件
  try {
    const { lessonFromLines } = await import('../assets/pdflesson.js');
    const L = (text, size, x = 90, y = 0, page = 1) => ({ text, size, x, y, page, width: 0, height: 0 });
    const lines = [
      L('【Para. 1】', 14.1, 118, 100),
      L('The brain requires protection. A barrier keeps', 14.1, 90, 120),
      L('toxins out of the tissue.', 14.1, 90, 140),
      L('• protection n. /prəˈtekʃn/ the act of keeping safe , 保护 【大纲词汇】', 15, 90, 180),
      L('• toxin n. /ˈtɒksɪn/ a poison , 毒素', 15, 90, 200),
      L('大脑需要保护。一道屏障把毒素挡在外面。', 15, 120, 240),
      L('【Para. 2】', 14.1, 118, 300),
      L('Researchers found that the barrier is active.', 14.1, 90, 320),
      L('研究者发现这道屏障是主动的。', 15, 120, 360),
      L('今日翻译作业', 15, 90, 400),
      L('(Para.2) Researchers found that the barrier is active.', 14.1, 90, 430),
      L('(下一页提供句子分析）', 14.1, 90, 450),
      L('今日句子分析', 15, 90, 500),
      L('句子主干：Researchers found that…', 15, 90, 530),
    ];
    const les = lessonFromLines(lines);
    const p = les.paragraphs || [];
    const ok = les.ok && p.length === 2
      && p[0].zh.includes('大脑需要保护')
      && p[1].zh.includes('研究者发现')
      && les.notes.length === 2
      && les.notes.find((n) => n.term === 'protection')?.zh === '保护'
      && les.exercise?.para === 2
      && /Researchers found/.test(les.exercise?.en || '')
      && /句子主干/.test(les.exercise?.analysis || '');
    check('lesson: 讲义行解析出译文/注释/作业', ok,
      `paras=${p.length} zh=${p.filter((x) => x.zh).length} notes=${les.notes.length} ex=${les.exercise?.en?.slice(0, 24)}`);
  } catch (err) {
    check('lesson: 讲义行解析出译文/注释/作业', false, err.message);
  }

  // wait for devtools
  let ver;
  for (let i = 0; i < 40; i += 1) {
    try { ver = await getJson(`http://127.0.0.1:${PORT}/json/version`); break; } catch { await sleep(250); }
  }
  if (!ver) throw new Error('chrome devtools not reachable');

  const target = await getJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT');
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      errors.push(d.exception?.description || d.text);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
      errors.push(msg.params.entry.text);
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  // ---- 1. library ----
  await goto(`${BASE}/index.html`);
  await waitFor(`document.querySelectorAll('.lib-item').length >= 2`, 'library items');
  const libCount = await ev(`return document.querySelectorAll('.lib-item').length;`);
  check('library renders 2 articles', libCount === 2, `count=${libCount}`);
  const stats = await ev(`return document.querySelector('#st-articles').textContent;`);
  check('stat strip filled', stats.trim() === '2', `#st-articles=${stats}`);

  // search filter
  await ev(`
    const s = document.querySelector('#search');
    s.value = 'sky'; s.dispatchEvent(new Event('input', { bubbles: true }));
  `);
  await sleep(400);
  const filtered = await ev(`return document.querySelectorAll('.lib-item').length;`);
  check('search filters list', filtered === 1, `hits=${filtered}`);
  await ev(`
    const s = document.querySelector('#search');
    s.value = ''; s.dispatchEvent(new Event('input', { bubbles: true }));
  `);

  // ---- 2. reader ----
  await goto(`${BASE}/reader.html?id=why-you-forget-the-words-you-learn`);
  await waitFor(`document.querySelectorAll('.w').length > 300`, 'reader words');
  const counts = await ev(`return {
    paras: document.querySelectorAll('.para').length,
    words: document.querySelectorAll('.w').length,
    sents: document.querySelectorAll('.s').length
  };`);
  check('reader tokenised', counts.paras === 6 && counts.words === 442 && counts.sents === 30, JSON.stringify(counts));

  // click a word -> popover
  await ev(`
    const w = [...document.querySelectorAll('.w')].find(el => el.dataset.w === 'ritual');
    w.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: 400, clientY: 400 }));
  `);
  await waitFor(`document.querySelector('#popover').classList.contains('open')`, 'popover open');
  await waitFor(`document.querySelector('#pop-word').textContent.trim().length > 0`, 'pop word');
  await waitFor(
    `document.querySelector('#pop-defs').textContent.trim().length > 40 || document.querySelector('#pop-zh .zh')`,
    'dictionary response', 15000,
  );
  // 中译与释义独立渲染，可能稍后到达
  let zhOk = false;
  for (let i = 0; i < 40 && !zhOk; i += 1) {
    zhOk = await ev(`return !!document.querySelector('#pop-zh .zh');`);
    if (!zhOk) await sleep(300);
  }
  const pop = await ev(`return {
    word: document.querySelector('#pop-word').textContent.trim(),
    phonetic: document.querySelector('#pop-phonetic').textContent.trim(),
    defs: document.querySelector('#pop-defs').textContent.trim().length,
    zh: (document.querySelector('#pop-zh .zh') || {}).textContent ? document.querySelector('#pop-zh .zh').textContent.trim() : ''
  };`);
  check('popover shows word', pop.word.toLowerCase() === 'ritual', JSON.stringify(pop).slice(0, 160));
  check('popover has dictionary definition', pop.defs > 40, `defs chars=${pop.defs}`);
  if (pop.zh.length) check('popover has Chinese gloss', true, `zh=${pop.zh.slice(0, 40)}`);
  else console.log('SKIP  popover has Chinese gloss — 本机网络访问不到两个翻译接口，界面已降级');
  await sleep(300);

  // save word
  await ev(`document.querySelector('#pop-save').click();`);
  await waitFor(`JSON.stringify(JSON.parse(localStorage.getItem('er.vocab.v1') || '[]')).includes('ritual')`, 'word saved', 15000);
  await sleep(400);
  const saved = await ev(`
    const v = JSON.parse(localStorage.getItem('er.vocab.v1') || '[]');
    return { keys: Object.keys(v), len: Array.isArray(v) ? v.length : -1,
             hit: JSON.stringify(v).includes('ritual'),
             savedSpans: document.querySelectorAll('.w.saved').length };
  `);
  check('word saved to vocabulary', saved.hit === true, JSON.stringify(saved).slice(0, 200));
  check('saved word highlighted in text', saved.savedSpans > 0, `spans=${saved.savedSpans}`);

  // progress after scroll
  await ev(`
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo(0, max * 0.45);
    return Math.round(window.scrollY);
  `);
  await sleep(1400);
  const prog = await ev(`
    const p = JSON.parse(localStorage.getItem('er.progress.v1') || '{}');
    return p['why-you-forget-the-words-you-learn'] || null;
  `);
  check('reading progress saved', !!prog, JSON.stringify(prog).slice(0, 120));

  // reopen at saved position
  await goto(`${BASE}/reader.html?id=why-you-forget-the-words-you-learn`);
  await waitFor(`document.querySelectorAll('.w').length > 300`, 'reader reopen');
  await sleep(1000);
  const restored = await ev(`
    const max = document.documentElement.scrollHeight - window.innerHeight;
    return { y: Math.round(window.scrollY), ratio: +(window.scrollY / (max || 1)).toFixed(2) };
  `);
  check('reopens at saved position', restored.ratio > 0.3 && restored.ratio < 0.65, JSON.stringify(restored));

  // ---- 3. vocab ----
  await goto(`${BASE}/vocab.html`);
  await waitFor(`document.querySelectorAll('#vocab-area tbody tr').length >= 1`, 'vocab rows');
  const vrows = await ev(`return {
    rows: document.querySelectorAll('#vocab-area tbody tr').length,
    due: document.querySelector('#due-count').textContent.trim(),
    stats: document.querySelector('#mini-stats').textContent.trim()
  };`);
  check('vocab table lists saved word', vrows.rows === 1, JSON.stringify(vrows).slice(0, 160));

  // review flow
  await ev(`document.querySelector('#start-review').click(); return true;`);
  await waitFor(`document.querySelector('#review').classList.contains('open')`, 'review open');
  await waitFor(`!!document.querySelector('#rv-reveal')`, 'reveal button');
  await ev(`document.querySelector('#rv-reveal').click(); return true;`);
  await sleep(350);
  const revealed = await ev(`return {
    answerHidden: document.querySelector('#rv-answer') ? document.querySelector('#rv-answer').hidden : null,
    rateBtns: document.querySelectorAll('#rv-actions button').length
  };`);
  check('review reveals answer + 3 grades', revealed.answerHidden === false && revealed.rateBtns >= 3, JSON.stringify(revealed));
  await ev(`document.querySelector('.rate-good').click(); return true;`);
  await sleep(500);
  const afterReview = await ev(`
    const v = JSON.parse(localStorage.getItem('er.vocab.v1') || '{}');
    const rec = v.ritual || Object.values(v)[0] || null;
    return { done: !!document.querySelector('#rv-done'),
             summary: (document.querySelector('.review-done p') || {}).textContent || '',
             interval: rec ? rec.interval : null, due: rec ? rec.due > Date.now() : null };
  `);
  check('review finishes with summary', afterReview.done === true, JSON.stringify(afterReview).slice(0, 200));
  check('graded word rescheduled into future', afterReview.interval >= 1 && afterReview.due === true,
    JSON.stringify(afterReview).slice(0, 200));

  // ---- 4. import ----
  await goto(`${BASE}/import.html`);
  await ev(`
    document.querySelector('#f-title').value = 'Test Article From Paste';
    document.querySelector('#f-level').value = 'B1';
    const body = document.querySelector('#f-body');
    body.value = 'First paragraph here about machines.\\n\\nSecond paragraph, with a continuation\\nline inside it.\\n\\nThird paragraph ends the piece.';
    body.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(500);
  await ev(`document.querySelector('#preview').click(); return true;`);
  await sleep(300);
  const imp = await ev(`return {
    words: document.querySelector('#word-count').textContent.trim(),
    previewHidden: document.querySelector('#preview-pane').hidden,
    previewParas: document.querySelectorAll('#preview-pane p').length
  };`);
  check('import previews paragraphs', imp.previewParas === 3 && imp.previewHidden === false, JSON.stringify(imp));

  await ev(`document.querySelector('#save').click(); return true;`);
  await sleep(1800);
  const imported = await ev(`return { href: location.href, paras: document.querySelectorAll('.para').length, h1: (document.querySelector('h1')||{}).textContent };`);
  check('import saves and opens reader', /reader\.html\?id=local-/.test(imported.href) && imported.paras === 3,
    JSON.stringify(imported).slice(0, 200));

  // ---- 4.5 讲义文章：双语 / 注释 / 作业 ----
  const lessonSeed = {
    id: 'local-lesson-selftest',
    title: 'Lesson Selftest',
    subtitle: '',
    source: 'Selftest',
    author: '',
    date: '2026-11-19',
    level: 'B2',
    tags: [],
    summary: '',
    paragraphs: [
      'The brain requires protection. A barrier keeps toxins out of the tissue.',
      'Researchers found that the barrier is active.',
    ],
    lesson: {
      lead: { en: 'A short epigraph.', zh: '一句题记。' },
      paragraphs: [
        { n: 1, en: 'The brain requires protection. A barrier keeps toxins out of the tissue.', zh: '大脑需要保护。一道屏障把毒素挡在组织外面。' },
        { n: 2, en: 'Researchers found that the barrier is active.', zh: '研究者发现这道屏障是主动的。' },
      ],
      notes: [
        { term: 'protection', pos: 'n', phonetic: '/prəˈtekʃn/', def: 'the act of keeping someone or something safe', zh: '保护', tag: '大纲词汇', example: 'The law provides protection.', exampleZh: '法律提供保护。', para: 1 },
        { term: 'toxin', pos: 'n', phonetic: '/ˈtɒksɪn/', def: 'a poisonous substance', zh: '毒素', tag: '', example: '', exampleZh: '', para: 1 },
      ],
      exercise: {
        title: '今日翻译作业',
        en: 'Researchers found that the barrier is active.',
        para: 2,
        analysis: '句子主干：Researchers found that…\nthat 引导宾语从句。',
        writing: '',
      },
      stats: { paragraphs: 2, translated: 2, notes: 2, words: 13, exerciseWords: 7, hasExercise: true, hasAnalysis: true },
    },
    createdAt: new Date().toISOString(),
  };

  await goto(`${BASE}/index.html`);
  await ev(`
    localStorage.setItem('er.local.v1', JSON.stringify(${JSON.stringify([lessonSeed])}));
    localStorage.setItem('er.prefs.v1', JSON.stringify({ theme: 'light', fontScale: 1, rate: 0.95, autoZh: true, bilingual: true }));
    return true;
  `);
  await goto(`${BASE}/reader.html?id=${lessonSeed.id}`);
  await sleep(600);

  const les = await ev(`return {
    seg: !document.querySelector('#seg-lang').hidden,
    zh: document.querySelectorAll('#body .para-zh').length,
    zhShown: [...document.querySelectorAll('#body .para-zh')].filter((e) => e.offsetParent !== null).length,
    marks: document.querySelectorAll('#body .w.has-note').length,
    lead: !!document.querySelector('.article-lead'),
    exam: document.querySelector('#exam').hidden === false,
    examEn: (document.querySelector('#exam-en') || {}).textContent || '',
    gloss: document.querySelector('#glossary').hidden === false,
    glossRows: document.querySelectorAll('#glossary-list .gloss').length
  };`);
  check('lesson reader: 双语开关与译文', les.seg && les.zh === 2 && les.zhShown === 2 && les.lead,
    JSON.stringify(les).slice(0, 200));
  check('lesson reader: 注释标记 / 作业 / 词表', les.marks > 0 && les.exam && les.gloss && les.glossRows === 2,
    `marks=${les.marks} exam=${les.exam} rows=${les.glossRows}`);

  await ev(`document.querySelector('#seg-lang button[data-lang="en"]').click(); return true;`);
  await sleep(250);
  const enOnly = await ev(`return [...document.querySelectorAll('#body .para-zh')].filter((e) => e.offsetParent !== null).length;`);
  check('lesson reader: 切到原文隐藏译文', enOnly === 0, `visible=${enOnly}`);

  const noteCard = await ev(`
    document.querySelector('#body .w.has-note').click();
    const pop = document.querySelector('#popover');
    return {
      isNote: pop.classList.contains('is-note'),
      word: document.querySelector('#pop-word').textContent,
      zh: document.querySelector('#pop-zh').textContent,
      tag: (document.querySelector('.pop-note .note-tag') || {}).textContent || ''
    };`);
  check('lesson reader: 点注释词开讲解卡', noteCard.isNote && /保护|toxin/i.test(noteCard.zh + noteCard.word),
    JSON.stringify(noteCard).slice(0, 160));

  // 作业译文写进去，刷新后还在
  await ev(`
    const box = document.querySelector('#exam-input');
    box.value = '研究者发现这道屏障是主动的。';
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;`);
  await sleep(700);
  await goto(`${BASE}/reader.html?id=${lessonSeed.id}`);
  await sleep(500);
  const kept = await ev(`return (document.querySelector('#exam-input') || {}).value || '';`);
  check('lesson reader: 作业译文存在本机', kept.includes('研究者发现'), JSON.stringify(kept));

  // ---- 5. theme ----
  await goto(`${BASE}/index.html`);
  const t0 = await ev(`return document.documentElement.dataset.theme || 'none';`);
  await ev(`document.querySelector('[data-theme-toggle]').click(); return true;`);
  await sleep(300);
  const t1 = await ev(`return document.documentElement.dataset.theme || 'none';`);
  check('theme toggle switches', t0 !== t1, `${t0} -> ${t1}`);

  console.log('\n--- runtime errors ---');
  if (!errors.length) console.log('(none)');
    else [...new Set(errors)].slice(0, 12).forEach((e) => console.log('  ! ' + String(e).split('\n')[0].slice(0, 220)));

  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} checks passed, ${errors.length} runtime errors`);
  process.exitCode = failed || errors.length ? 1 : 0;
}

try {
  await main();
} catch (e) {
  console.error('E2E ABORTED:', e.message);
  process.exitCode = 2;
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(300);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
}

