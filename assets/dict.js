/* ============================================================
   dict.js · 免费词典 / 翻译（带本地缓存与降级）
   - 释义：dictionaryapi.dev（无需 key）
   - 中文：MyMemory（无需 key，注意其每日匿名额度）
   所有请求失败都被吞掉，界面上只降级，不报错。
   ============================================================ */

const CACHE_KEY = 'er.dict.v1';
const TTL = 30 * 86400000;
const inflight = new Map();

function readCache() {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {
    /* 空间不足时静默放弃缓存 */
  }
}

function getEntry(type, word) {
  const cache = readCache();
  const row = cache[type] && cache[type][word];
  if (!row) return null;
  const ttl = row.ttl || TTL;
  if (Date.now() - row.at > ttl) return null;
  return row.data;
}

function putEntry(type, word, data, ttlMs = 0) {
  const cache = readCache();
  cache[type] = cache[type] || {};
  cache[type][word] = ttlMs ? { at: Date.now(), data, ttl: ttlMs } : { at: Date.now(), data };
  const keys = Object.keys(cache[type]);
  if (keys.length > 1200) {
    keys.sort((a, b) => cache[type][a].at - cache[type][b].at);
    for (const k of keys.slice(0, 200)) delete cache[type][k];
  }
  writeCache(cache);
}

export function cachedZh(word) {
  return getEntry('zh', word);
}

export function cachedDef(word) {
  return getEntry('def', word);
}

async function withTimeout(promise, ms = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await promise(ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- 英文释义 ---------------- */

export async function fetchDef(word) {
  const key = String(word).toLowerCase();
  const hit = cachedDef(key);
  if (hit) return hit;
  if (inflight.has(`def:${key}`)) return inflight.get(`def:${key}`);

  const task = (async () => {
    try {
      const res = await withTimeout((signal) =>
        fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(key)}`, { signal })
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const entry = Array.isArray(data) ? data[0] : null;
      if (!entry) throw new Error('empty');

      const defs = [];
      for (const meaning of entry.meanings || []) {
        for (const d of (meaning.definitions || []).slice(0, 2)) {
          defs.push({
            pos: meaning.partOfSpeech || '',
            def: d.definition || '',
            eg: d.example || '',
          });
          if (defs.length >= 4) break;
        }
        if (defs.length >= 4) break;
      }

      const phonetic =
        entry.phonetic ||
        (entry.phonetics || []).map((p) => p.text).find(Boolean) ||
        '';
      const audio =
        (entry.phonetics || []).map((p) => p.audio).find((a) => a && a.trim()) || '';

      const result = { ok: true, phonetic, audio, defs };
      putEntry('def', key, result);
      return result;
    } catch (err) {
      return { ok: false, error: err.message, phonetic: '', audio: '', defs: [] };
    } finally {
      inflight.delete(`def:${key}`);
    }
  })();

  inflight.set(`def:${key}`, task);
  return task;
}

/* ---------------- 中文释义 ---------------- */

function decodeEntities(str) {
  return String(str)
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

async function viaMyMemory(key) {
  const url =
    'https://api.mymemory.translated.net/get?q=' +
    encodeURIComponent(key) +
    '&langpair=en|zh-CN';
  const res = await withTimeout((signal) => fetch(url, { signal }), 4500);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  const text = data?.responseData?.translatedText || '';
  if (/MYMEMORY WARNING/i.test(text) || /NO QUERY SPECIFIED/i.test(text)) throw new Error('quota');
  return text;
}

// 备用：MyMemory 在国内通常可用，国外有时被限流；Google 反之
async function viaGoogle(key) {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' +
    encodeURIComponent(key);
  const res = await withTimeout((signal) => fetch(url, { signal }), 4500);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  return (data?.[0] || []).map((seg) => seg?.[0] || '').join('');
}

export async function fetchZh(word) {
  const key = String(word).toLowerCase();
  const hit = cachedZh(key);
  if (hit) return hit;
  if (inflight.has(`zh:${key}`)) return inflight.get(`zh:${key}`);

  const task = (async () => {
    try {
      let lastErr = null;
      for (const [attempt, label] of [[viaMyMemory, 'MyMemory'], [viaGoogle, 'Google']]) {
        try {
          let text = decodeEntities(await attempt(key)).trim();
          if (!text) throw new Error('empty');
          // 单词查询不该返回一整句话
          if (text.length > 40) text = text.slice(0, 40);
          const result = { ok: true, zh: text, src: label };
          putEntry('zh', key, result);
          return result;
        } catch (err) {
          lastErr = err;
        }
      }
      // 两个来源都失败：短期记住「查不到」，免得同一个词反复等十几秒
      const failed = { ok: false, error: lastErr ? lastErr.message : 'failed', zh: '' };
      putEntry('zh', key, failed, 10 * 60000);
      return failed;
    } finally {
      inflight.delete(`zh:${key}`);
    }
  })();

  inflight.set(`zh:${key}`, task);
  return task;
}

/* ---------------- 词形还原（轻量） ---------------- */

const IRREGULAR = {
  was: 'be', were: 'be', been: 'be', being: 'be', am: 'be', is: 'be', are: 'be',
  went: 'go', gone: 'go', goes: 'go', had: 'have', has: 'have', having: 'have',
  made: 'make', said: 'say', took: 'take', taken: 'take', came: 'come',
  saw: 'see', seen: 'see', knew: 'know', known: 'know', thought: 'think',
  felt: 'feel', left: 'leave', kept: 'keep', began: 'begin', begun: 'begin',
  brought: 'bring', bought: 'buy', built: 'build', found: 'find', got: 'get',
  gave: 'give', given: 'give', told: 'tell', became: 'become', put: 'put',
  ran: 'run', read: 'read', wrote: 'write', written: 'write', spoke: 'speak',
  spent: 'spend', stood: 'stand', won: 'win', lost: 'lose', met: 'meet',
  paid: 'pay', sent: 'send', sold: 'sell', sat: 'sit', lay: 'lie', led: 'lead',
  children: 'child', people: 'person', men: 'man', women: 'woman', feet: 'foot',
  teeth: 'tooth', mice: 'mouse', lives: 'life', leaves: 'leaf', halves: 'half',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', data: 'datum',
};

export function lemmas(word) {
  const w = String(word).toLowerCase();
  const out = [w];
  if (IRREGULAR[w]) out.push(IRREGULAR[w]);
  if (w.length > 4 && w.endsWith('ies')) out.push(w.slice(0, -3) + 'y');
  if (w.length > 4 && w.endsWith('ves')) out.push(w.slice(0, -3) + 'f');
  if (w.length > 3 && w.endsWith('es')) out.push(w.slice(0, -2));
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  if (w.length > 5 && w.endsWith('ing')) {
    out.push(w.slice(0, -3));
    out.push(w.slice(0, -3) + 'e');
  }
  if (w.length > 4 && w.endsWith('ed')) {
    out.push(w.slice(0, -2));
    out.push(w.slice(0, -1));
  }
  if (w.length > 5 && w.endsWith('ly')) out.push(w.slice(0, -2));
  if (w.length > 4 && w.endsWith('er')) {
    out.push(w.slice(0, -2));
    out.push(w.slice(0, -1));
  }
  return [...new Set(out)].filter((x) => x.length > 1);
}
