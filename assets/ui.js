/* ============================================================
   ui.js · 主题、导航、提示、语音朗读
   ============================================================ */

import { getPrefs, setPref, resolvedTheme, dueWords } from './core.js';

/* ---------------- 主题 ---------------- */

export function applyTheme() {
  document.documentElement.dataset.theme = resolvedTheme();
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = resolvedTheme() === 'dark' ? '#14120f' : '#fbf8f1';
}

export function initChrome(activePage) {
  applyTheme();

  document.querySelectorAll('[data-page]').forEach((link) => {
    if (link.dataset.page === activePage) link.classList.add('active');
  });

  const due = dueWords().length;
  document.querySelectorAll('[data-due-badge]').forEach((el) => {
    if (due > 0) {
      el.textContent = String(due);
      el.hidden = false;
    } else {
      el.hidden = true;
    }
  });

  document.querySelectorAll('[data-theme-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
      setPref('theme', next);
      // 换主题时临时给全局加上过渡，让底色和文字平滑过渡
      document.documentElement.classList.add('is-theme-swap');
      window.setTimeout(() => document.documentElement.classList.remove('is-theme-swap'), 420);
      applyTheme();
      toast(next === 'dark' ? '已切换到夜间模式' : '已切换到日间模式');
    });
  });

  document.querySelectorAll('[data-year]').forEach((el) => {
    el.textContent = String(new Date().getFullYear());
  });

  // 跟随系统主题变化
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getPrefs().theme === 'auto') applyTheme();
  });

  initScrollState();
  initReveal();
}

/* ---------------- 滚动进场 ---------------- */

// 选择器 + 同组内错峰的步长（毫秒）
const REVEAL_MAP = [
  ['.hero-kicker', 0],
  ['.hero h1', 70],
  ['.hero p.lead', 140],
  ['.hero-actions', 200],
  ['.stat', 70],
  ['.section-head', 0],
  ['.lib-item', 55],
  ['.page-head', 0],
  ['.article-head', 0],
  ['.article-body .para', 0],
  ['.due-banner', 60],
  ['.vocab-table tr', 22],
  ['.form-grid > .field', 45],
];

let revealObserver = null;
let revealTimer = 0;

function scanReveal(root = document) {
  if (!revealObserver) return;
  for (const [sel, step] of REVEAL_MAP) {
    root.querySelectorAll(sel).forEach((el, i) => {
      if (el.hasAttribute('data-reveal')) return;
      if (step) el.style.setProperty('--d', `${Math.min(i * step, 320)}ms`);
      el.setAttribute('data-reveal', '');
      revealObserver.observe(el);
    });
  }
}

export function initReveal() {
  if (revealObserver) return;
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  revealObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add('in');
        revealObserver.unobserve(entry.target);
      }
    },
    { rootMargin: '0px 0px -6% 0px', threshold: 0.05 }
  );

  scanReveal(document);

  // 动态渲染的内容（文章段落、生词行、导入后的本机列表）也要接上
  const mo = new MutationObserver(() => {
    if (revealTimer) return;
    revealTimer = window.setTimeout(() => {
      revealTimer = 0;
      scanReveal(document);
    }, 60);
  });
  mo.observe(document.body, { childList: true, subtree: true });
}

function initScrollState() {
  let ticking = false;
  const sync = () => {
    document.body.classList.toggle('scrolled', window.scrollY > 6);
    ticking = false;
  };
  sync();
  window.addEventListener(
    'scroll',
    () => {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(sync);
    },
    { passive: true }
  );
}

/* ---------------- 提示 ---------------- */

let toastTimer = 0;

export function toast(message, ms = 2200) {
  let node = document.querySelector('.toast');
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.appendChild(node);
  }
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), ms);
}

/* ---------------- 语音朗读 ---------------- */

const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1.5"/></svg>';

export class Speaker {
  constructor() {
    this.queue = [];
    this.index = 0;
    this.active = null;     // 当前高亮的元素
    this.playing = false;
    this.button = null;     // 当前播放按钮
    this.rate = getPrefs().rate || 0.95;
    this.voice = null;
    this.onFinish = null;   // 全部读完时的回调（用户手动停止不触发）
    if (this.supported) {
      this._pickVoice();
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this._pickVoice());
    }
  }

  get supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window;
  }

  _pickVoice() {
    const voices = window.speechSynthesis.getVoices() || [];
    if (!voices.length) return;
    const en = voices.filter((v) => /^en(-|_)?/i.test(v.lang));
    if (!en.length) return;
    const score = (v) =>
      (/natural|neural|premium|enhanced/i.test(v.name) ? 4 : 0) +
      (/google/i.test(v.name) ? 3 : 0) +
      (/samantha|serena|daniel|karen|moira|alex/i.test(v.name) ? 2 : 0) +
      (v.lang === 'en-US' ? 1 : 0) +
      (v.localService ? 1 : 0);
    this.voice = en.sort((a, b) => score(b) - score(a))[0];
  }

  setRate(rate) {
    this.rate = rate;
  }

  /** 朗读一组句子节点，逐句高亮 */
  speakNodes(nodes, button) {
    if (!this.supported) {
      toast('当前浏览器不支持语音朗读，可试试 Chrome 或 Edge');
      return;
    }
    this.stop();
    const list = Array.from(nodes).filter(Boolean);
    if (!list.length) return;

    this.queue = list.map((node) => ({ text: node.textContent, node }));
    this.index = 0;
    this.playing = true;
    this.button = button || null;
    if (this.button) this.button.innerHTML = ICON_STOP;
    this._next();
  }

  speakText(text, button) {
    if (!this.supported) {
      toast('当前浏览器不支持语音朗读，可试试 Chrome 或 Edge');
      return;
    }
    this.stop();
    this.queue = [{ text, node: null }];
    this.index = 0;
    this.playing = true;
    this.button = button || null;
    if (this.button) this.button.innerHTML = ICON_STOP;
    this._next();
  }

  _next() {
    if (!this.playing) return;
    const item = this.queue[this.index];
    if (!item) {
      this._finish();
      return;
    }
    if (this.active) this.active.classList.remove('speaking');
    this.active = item.node;
    if (this.active) this.active.classList.add('speaking');
    /* 告诉页面「现在读到哪个节点」，进度刻度之类的装饰可以据此点亮 */
    window.dispatchEvent(new CustomEvent('er:speak', { detail: { speaking: true, node: item.node } }));

    const utter = new SpeechSynthesisUtterance(item.text);
    utter.lang = this.voice?.lang || 'en-US';
    if (this.voice) utter.voice = this.voice;
    utter.rate = this.rate;
    utter.pitch = 1;
    utter.onend = () => {
      if (!this.playing) return;
      this.index += 1;
      this._next();
    };
    utter.onerror = (e) => {
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      this.stop();
    };
    window.speechSynthesis.speak(utter);
  }

  stop() {
    this.playing = false;
    this.queue = [];
    if (this.active) {
      this.active.classList.remove('speaking');
      this.active = null;
    }
    window.dispatchEvent(new CustomEvent('er:speak', { detail: { speaking: false, node: null } }));
    if (this.button) {
      this.button.innerHTML = ICON_PLAY;
      this.button = null;
    }
    if (this.supported) window.speechSynthesis.cancel();
  }

  /** 队列自然读完 */
  _finish() {
    this.stop();
    const cb = this.onFinish;
    this.onFinish = null;
    if (typeof cb === 'function') cb();
  }
}

export { ICON_PLAY, ICON_STOP };

/* ---------------- 小工具 ---------------- */

export function qs(sel, root = document) {
  return root.querySelector(sel);
}

/** 尊重系统的「减少动态效果」设置 */
export function motionOK() {
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function scrollBehavior() {
  return motionOK() ? 'smooth' : 'auto';
}

export function qsa(sel, root = document) {
  return Array.from(root.querySelectorAll(sel));
}

export function on(target, type, handler, opts) {
  if (target) target.addEventListener(type, handler, opts);
}
