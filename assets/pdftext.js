// 极简 PDF 文本提取器（浏览器 / Node 通用，无外部依赖）
// 只做「拿到文字」这一件事：解析对象 → 解压内容流 → 解释文本算子 → 用字形坐标重排成行。
// 支持：FlateDecode、Identity-H 双字节字体 + ToUnicode CMap、/W 字宽、简单字体 /Widths。
// 不支持：加密 PDF、扫描件（无文字层）、图片 OCR、多栏自动分栏。

const DELIMS = new Set(['(', ')', '<', '>', '[', ']', '{', '}', '/', '%']);

export async function pdfToText(input, opts = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const src = latin1(bytes);
  const doc = { bytes, src, objs: scanObjects(src) };
  const pages = readPageTree(doc);
  const out = [];
  for (const page of pages) {
    const res = await readResources(doc, page);
    const content = await pageContent(doc, page);
    if (!content) {
      out.push({ width: page.width, height: page.height, lines: [] });
      continue;
    }
    const glyphs = interpret(content, res, page);
    const entry = { width: page.width, height: page.height, lines: buildLines(glyphs) };
    if (opts.debug) entry.glyphs = glyphs;
    out.push(entry);
  }
  return { pages: out };
}

// 把整份文档拍平成行，附带页码
export function flattenLines(doc) {
  const lines = [];
  doc.pages.forEach((page, i) => {
    page.lines.forEach((line) => lines.push({ ...line, page: i + 1 }));
  });
  return lines;
}

/* ---------------------------------------------------------------- 基础工具 */

function latin1(u8) {
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) {
    out += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
  }
  return out;
}

const mul = (m, n) => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

async function inflate(u8) {
  for (const fmt of ['deflate', 'deflate-raw']) {
    try {
      const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream(fmt));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      /* 换下一种封装再试 */
    }
  }
  return null;
}

function asciiHex(u8) {
  const s = latin1(u8).replace(/[^0-9a-fA-F]/g, '');
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i += 1) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

function ascii85(u8) {
  let s = latin1(u8).replace(/\s/g, '');
  if (s.startsWith('<~')) s = s.slice(2);
  const end = s.indexOf('~>');
  if (end >= 0) s = s.slice(0, end);
  const out = [];
  let group = [];
  for (const ch of s) {
    if (ch === 'z' && group.length === 0) {
      out.push(0, 0, 0, 0);
      continue;
    }
    group.push(ch.charCodeAt(0) - 33);
    if (group.length === 5) {
      let v = 0;
      for (const d of group) v = v * 85 + d;
      out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255);
      group = [];
    }
  }
  if (group.length) {
    const pad = 5 - group.length;
    while (group.length < 5) group.push(84);
    let v = 0;
    for (const d of group) v = v * 85 + d;
    const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
    out.push(...b.slice(0, 4 - pad));
  }
  return new Uint8Array(out);
}

/* ---------------------------------------------------------------- 对象扫描 */

function scanObjects(src) {
  const objs = new Map();
  const re = /(\d+)\s+(\d+)\s+obj\b/g;
  let m;
  while ((m = re.exec(src)) !== null) {
    const num = Number(m[1]);
    const bodyStart = m.index + m[0].length;
    const endobj = src.indexOf('endobj', bodyStart);
    const streamAt = src.indexOf('stream', bodyStart);
    const limit = endobj < 0 ? src.length : endobj;
    let dict = src.slice(bodyStart, limit);
    let streamStart = -1;
    if (streamAt >= 0 && streamAt < limit) {
      dict = src.slice(bodyStart, streamAt);
      let s = streamAt + 6;
      if (src[s] === '\r') s += 1;
      if (src[s] === '\n') s += 1;
      streamStart = s;
    }
    const indirectLen = /\/Length\s+(\d+)\s+0\s+R/.exec(dict);
    const directLen = /\/Length\s+(\d+)(?!\s+0\s+R)/.exec(dict);
    objs.set(num, {
      num,
      dict,
      streamStart,
      streamLen: directLen ? Number(directLen[1]) : 0,
      lenRef: indirectLen ? Number(indirectLen[1]) : 0,
    });
  }
  return objs;
}

function dictOf(doc, num) {
  const o = doc.objs.get(num);
  return o ? o.dict : '';
}

function refOf(dict, key) {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+0\\s+R`).exec(dict);
  return m ? Number(m[1]) : 0;
}

function numOf(dict, key, fallback) {
  const m = new RegExp(`/${key}\\s+(-?[\\d.]+)`).exec(dict);
  return m ? Number(m[1]) : fallback;
}

async function streamOf(doc, num) {
  const o = doc.objs.get(num);
  if (!o || o.streamStart < 0) return null;
  let len = o.streamLen;
  if (!len && o.lenRef) {
    const n = /^\s*(\d+)/.exec(dictOf(doc, o.lenRef));
    if (n) len = Number(n[1]);
  }
  if (!len) {
    const e = doc.src.indexOf('endstream', o.streamStart);
    len = e < 0 ? doc.src.length - o.streamStart : e - o.streamStart;
  }
  const u8 = doc.bytes.subarray(o.streamStart, o.streamStart + len);
  let data = u8;
  const filters = [...o.dict.matchAll(/\/Filter\s*\/(\w+)/g)].map((x) => x[1]);
  for (const f of filters) {
    if (f === 'FlateDecode') data = await inflate(data);
    else if (f === 'ASCIIHexDecode') data = asciiHex(data);
    else if (f === 'ASCII85Decode') data = ascii85(data);
    else return null;
    if (!data) return null;
  }
  return data;
}

/* ---------------------------------------------------------------- 页面树 */

function readPageTree(doc) {
  const pages = [];
  const catalog = [...doc.objs.values()].find((o) => /\/Type\s*\/Catalog/.test(o.dict));
  const seen = new Set();

  const walk = (num, inherited) => {
    if (!num || seen.has(num) || pages.length > 4000) return;
    seen.add(num);
    const dict = dictOf(doc, num);
    if (!dict) return;
    const box = /\/MediaBox\s*\[([^\]]*)\]/.exec(dict);
    const media = inherited.media || (box ? box[1].trim().split(/\s+/).map(Number) : [0, 0, 612, 792]);
    const resourcesRef = refOf(dict, 'Resources');
    const resInline = /\/Resources\s*(<<)/.test(dict);
    const resources = resInline || resourcesRef ? (resourcesRef ? { ref: resourcesRef } : { inline: dict }) : inherited.resources;
    if (/\/Type\s*\/Pages/.test(dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(dict);
      if (kids) {
        for (const k of kids[1].matchAll(/(\d+)\s+0\s+R/g)) walk(Number(k[1]), { media, resources });
      }
      return;
    }
    if (/\/Type\s*\/Page\b/.test(dict)) {
      pages.push({
        num,
        width: media[2] - media[0] || 612,
        height: media[3] - media[1] || 792,
        dict,
        resources,
      });
    }
  };

  if (catalog) walk(refOf(catalog.dict, 'Pages'), {});
  if (!pages.length) {
    // 没有可用目录树时，按对象号兜底
    for (const o of [...doc.objs.values()].sort((a, b) => a.num - b.num)) {
      if (/\/Type\s*\/Page\b/.test(o.dict) && !/\/Type\s*\/Pages/.test(o.dict)) {
        const box = /\/MediaBox\s*\[([^\]]*)\]/.exec(o.dict);
        const media = box ? box[1].trim().split(/\s+/).map(Number) : [0, 0, 612, 792];
        const ref = refOf(o.dict, 'Resources');
        pages.push({
          num: o.num,
          width: media[2] - media[0] || 612,
          height: media[3] - media[1] || 792,
          dict: o.dict,
          resources: ref ? { ref } : { inline: o.dict },
        });
      }
    }
  }
  return pages;
}

async function readResources(doc, page) {
  let dict = '';
  const r = page.resources || {};
  if (r.ref) dict = dictOf(doc, r.ref);
  else if (r.inline) dict = r.inline;
  else {
    // 往上找 /Parent 里的 /Resources
    let parent = refOf(page.dict, 'Parent');
    for (let i = 0; i < 12 && parent; i += 1) {
      const pd = dictOf(doc, parent);
      const ref = refOf(pd, 'Resources');
      if (ref) {
        dict = dictOf(doc, ref);
        break;
      }
      if (/\/Resources\s*<</.test(pd)) {
        dict = pd;
        break;
      }
      parent = refOf(pd, 'Parent');
    }
  }
  const fonts = new Map();
  const fontDict = /\/Font\s*<<([\s\S]*?)>>/.exec(dict);
  if (fontDict) {
    for (const m of fontDict[1].matchAll(/\/([^\s/<>\[\]]+)\s+(\d+)\s+0\s+R/g)) {
      fonts.set(m[1], await readFont(doc, Number(m[2])));
    }
  }
  return { fonts };
}

async function pageContent(doc, page) {
  let refs = [];
  const single = /\/Contents\s+(\d+)\s+0\s+R/.exec(page.dict);
  const multi = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict);
  if (multi) refs = [...multi[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]));
  else if (single) refs = [Number(single[1])];
  const parts = [];
  for (const ref of refs) {
    const data = await streamOf(doc, ref);
    if (data) parts.push(latin1(data));
  }
  return parts.join('\n');
}

/* ---------------------------------------------------------------- 字体 */

async function readFont(doc, num) {
  const dict = dictOf(doc, num);
  const font = {
    twoByte: /\/Subtype\s*\/Type0/.test(dict),
    cmap: new Map(),
    widths: new Map(),
    dw: 1000,
  };
  const tuRef = refOf(dict, 'ToUnicode');
  if (tuRef) {
    const data = await streamOf(doc, tuRef);
    if (data) font.cmap = parseCMap(latin1(data));
  }
  if (font.twoByte) {
    const desc = /\/DescendantFonts\s*\[\s*(\d+)\s+0\s+R/.exec(dict);
    if (desc) {
      const cd = dictOf(doc, Number(desc[1]));
      font.dw = numOf(cd, 'DW', 1000);
      const w = /\/W\s*\[([\s\S]*)\]/.exec(cd);
      if (w) parseWidths(w[1], font.widths);
    }
  } else {
    const fc = /\/FirstChar\s+(\d+)/.exec(dict);
    const w = /\/Widths\s*\[([\s\S]*?)\]/.exec(dict);
    if (fc && w) {
      const start = Number(fc[1]);
      w[1].trim().split(/\s+/).forEach((v, i) => font.widths.set(start + i, Number(v) || 0));
    }
  }
  return font;
}

function parseWidths(text, map) {
  const tokens = [];
  const re = /\[|\]|-?[\d.]+/g;
  let m;
  while ((m = re.exec(text)) !== null) tokens.push(m[0]);

  let i = 0;
  while (i < tokens.length) {
    const first = Number(tokens[i]);
    if (tokens[i + 1] === '[') {
      i += 2;
      let code = first;
      while (i < tokens.length && tokens[i] !== ']') {
        map.set(code, Number(tokens[i]));
        code += 1;
        i += 1;
      }
      i += 1;
    } else if (tokens[i + 1] !== undefined) {
      const last = Number(tokens[i + 1]);
      const w = Number(tokens[i + 2]);
      for (let c = first; c <= last && c - first < 4096; c += 1) map.set(c, w);
      i += 3;
    } else {
      i += 1;
    }
  }
}

function parseCMap(text) {
  const map = new Map();
  const decode = (hex) => {
    let s = '';
    for (let i = 0; i + 3 < hex.length + 1; i += 4) {
      const v = parseInt(hex.substr(i, 4), 16);
      if (!Number.isNaN(v)) s += String.fromCharCode(v);
    }
    return s;
  };
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(m[1], 16), decode(m[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<[0-9a-fA-F]+>|\[[^\]]*\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (m[3].startsWith('[')) {
        const items = [...m[3].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => x[1]);
        items.forEach((hex, i) => map.set(lo + i, decode(hex)));
      } else {
        const base = m[3].slice(1, -1);
        const start = parseInt(base, 16);
        for (let c = lo; c <= hi && c - lo < 65536; c += 1) {
          const v = start + (c - lo);
          const hex = v.toString(16).padStart(4, '0');
          map.set(c, String.fromCharCode(parseInt(hex.slice(-4), 16)));
        }
      }
    }
  }
  return map;
}

/* ---------------------------------------------------------------- 内容流 */

function tokenize(text) {
  const tokens = [];
  let i = 0;
  const n = text.length;
  const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t' || c === '\f' || c === '\0';

  while (i < n) {
    const c = text[i];
    if (isWs(c)) {
      i += 1;
      continue;
    }
    if (c === '%') {
      while (i < n && text[i] !== '\n' && text[i] !== '\r') i += 1;
      continue;
    }
    if (c === '(') {
      // 字面量字符串，处理转义与括号嵌套
      let depth = 1;
      let s = '';
      i += 1;
      while (i < n && depth > 0) {
        const ch = text[i];
        if (ch === '\\') {
          const nx = text[i + 1];
          const map = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' };
          if (nx in map) {
            s += map[nx];
            i += 2;
          } else if (nx >= '0' && nx <= '7') {
            let oct = '';
            let j = i + 1;
            while (j < i + 4 && text[j] >= '0' && text[j] <= '7') {
              oct += text[j];
              j += 1;
            }
            s += String.fromCharCode(parseInt(oct, 8));
            i = j;
          } else {
            i += 2;
          }
          continue;
        }
        if (ch === '(') depth += 1;
        if (ch === ')') {
          depth -= 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
        s += ch;
        i += 1;
      }
      tokens.push({ t: 'str', v: s });
      continue;
    }
    if (c === '<' && text[i + 1] === '<') {
      // 内联字典，跳过
      let depth = 0;
      while (i < n) {
        if (text[i] === '<' && text[i + 1] === '<') {
          depth += 1;
          i += 2;
          continue;
        }
        if (text[i] === '>' && text[i + 1] === '>') {
          depth -= 1;
          i += 2;
          if (depth <= 0) break;
          continue;
        }
        i += 1;
      }
      tokens.push({ t: 'dict' });
      continue;
    }
    if (c === '<') {
      const end = text.indexOf('>', i);
      const hex = end < 0 ? '' : text.slice(i + 1, end).replace(/[^0-9a-fA-F]/g, '');
      i = end < 0 ? n : end + 1;
      tokens.push({ t: 'str', v: hexToBytes(hex) });
      continue;
    }
    if (c === '/' ) {
      let j = i + 1;
      while (j < n && !isWs(text[j]) && !DELIMS.has(text[j])) j += 1;
      tokens.push({ t: 'name', v: text.slice(i + 1, j) });
      i = j;
      continue;
    }
    if (c === '[' || c === ']' || c === '{' || c === '}') {
      tokens.push({ t: c === '[' ? 'arr' : c === ']' ? 'arrend' : 'dict' });
      i += 1;
      continue;
    }
    let j = i;
    while (j < n && !isWs(text[j]) && !DELIMS.has(text[j])) j += 1;
    const word = text.slice(i, j);
    i = j === i ? i + 1 : j;
    if (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(word)) tokens.push({ t: 'num', v: Number(word) });
    else tokens.push({ t: 'op', v: word });
  }
  return tokens;
}

function hexToBytes(hex) {
  let s = '';
  for (let i = 0; i + 1 < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  return s;
}

function interpret(text, res, page) {
  const tokens = tokenize(text);
  const glyphs = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  let tm = [1, 0, 0, 1, 0, 0];
  let lm = [1, 0, 0, 1, 0, 0];
  let fontSize = 12;
  let leading = 0;
  let charSpacing = 0;
  let wordSpacing = 0;
  let font = null;
  const stack = [];
  const operands = [];
  let lastGlyph = null;

  const emit = (str) => {
    if (!font || !str) return;
    const two = font.twoByte;
    const codes = [];
    if (two) {
      for (let i = 0; i + 1 < str.length; i += 2) codes.push((str.charCodeAt(i) << 8) | str.charCodeAt(i + 1));
    } else {
      for (let i = 0; i < str.length; i += 1) codes.push(str.charCodeAt(i));
    }
    for (const code of codes) {
      const mapped = font.cmap.get(code);
      const ch = mapped !== undefined ? mapped : code >= 32 && code < 127 ? String.fromCharCode(code) : '';
      const w = font.widths.get(code) ?? font.dw;
      const m = mul(tm, ctm);
      const size = Math.hypot(m[0], m[1]) * fontSize;
      const gx = m[4];
      const gy = page.height - m[5];
      // 同一个文本行里，前后两个字形的水平差就是前一个字的真实前进量：
      // 比查 /W 表准得多，直接决定「词与词之间到底有没有空格」。
      if (lastGlyph && Math.abs(gy - lastGlyph.ry) < Math.max(2, size * 0.4) && gx > lastGlyph.x) {
        lastGlyph.advReal = gx - lastGlyph.x;
      }
      const glyph = { ch, x: gx, ry: gy, y: gy, size: size || 1, adv: (w / 1000) * fontSize * Math.hypot(tm[0], tm[1]) };
      glyphs.push(glyph);
      lastGlyph = glyph;
      const tx = (w / 1000) * fontSize + charSpacing + (code === 32 ? wordSpacing : 0);
      tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + tx * tm[0], tm[5] + tx * tm[1]];
    }
  };

  const nextLine = (tx, ty) => {
    lm = mul([1, 0, 0, 1, tx, ty], lm);
    tm = lm;
  };

  for (const tok of tokens) {
    if (tok.t === 'op') {
      const op = tok.v;
      switch (op) {
        case 'q':
          stack.push({ ctm: ctm.slice(), font, fontSize, leading, charSpacing, wordSpacing });
          break;
        case 'Q': {
          const s = stack.pop();
          if (s) ({ ctm, font, fontSize, leading, charSpacing, wordSpacing } = s);
          break;
        }
        case 'cm':
          if (operands.length >= 6) ctm = mul(operands.slice(-6).map(Number), ctm);
          break;
        case 'BT':
          tm = [1, 0, 0, 1, 0, 0];
          lm = [1, 0, 0, 1, 0, 0];
          break;
        case 'ET':
          break;
        case 'Tf':
          if (operands.length >= 2) {
            fontSize = Number(operands[operands.length - 1]) || fontSize;
            font = res.fonts.get(String(operands[operands.length - 2])) || font;
          }
          break;
        case 'TL':
          leading = Number(operands[operands.length - 1]) || 0;
          break;
        case 'Tc':
          charSpacing = Number(operands[operands.length - 1]) || 0;
          break;
        case 'Tw':
          wordSpacing = Number(operands[operands.length - 1]) || 0;
          break;
        case 'Tm':
          if (operands.length >= 6) {
            tm = operands.slice(-6).map(Number);
            lm = tm.slice();
          }
          break;
        case 'Td':
          if (operands.length >= 2) nextLine(Number(operands[operands.length - 2]), Number(operands[operands.length - 1]));
          break;
        case 'TD':
          if (operands.length >= 2) {
            const ty = Number(operands[operands.length - 1]);
            leading = -ty;
            nextLine(Number(operands[operands.length - 2]), ty);
          }
          break;
        case 'T*':
          nextLine(0, -leading);
          break;
        case 'Tj':
          if (operands.length) emit(String(operands[operands.length - 1]));
          break;
        case "'":
          nextLine(0, -leading);
          if (operands.length) emit(String(operands[operands.length - 1]));
          break;
        case '"':
          if (operands.length >= 3) {
            wordSpacing = Number(operands[operands.length - 3]) || 0;
            charSpacing = Number(operands[operands.length - 2]) || 0;
            nextLine(0, -leading);
            emit(String(operands[operands.length - 1]));
          }
          break;
        case 'TJ': {
          const arr = operands[operands.length - 1];
          if (Array.isArray(arr)) {
            for (const part of arr) {
              if (typeof part === 'number') {
                const tx = (-part / 1000) * fontSize;
                tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + tx * tm[0], tm[5] + tx * tm[1]];
              } else {
                emit(String(part));
              }
            }
          }
          break;
        }
        case 'BI':
          // 内联图片：跳过到 EI
          break;
        default:
          break;
      }
      operands.length = 0;
    } else if (tok.t === 'num') {
      operands.push(tok.v);
    } else if (tok.t === 'str') {
      operands.push(tok.v);
    } else if (tok.t === 'name') {
      operands.push(tok.v);
    } else if (tok.t === 'arr') {
      operands.push('__arr__');
    } else if (tok.t === 'arrend') {
      // 把 '__arr__' 之后的值收成数组
      const idx = operands.lastIndexOf('__arr__');
      if (idx >= 0) {
        const arr = operands.slice(idx + 1);
        operands.length = idx;
        operands.push(arr);
      }
    }
  }
  return glyphs;
}

/* ---------------------------------------------------------------- 行重建 */

// 标点前后不该凭空多出空格：`Alzheimer ’s`、`“ If` 都是这类毛病
const NO_SPACE_BEFORE = /[’,.;:!?%)\]”»]/;
const NO_SPACE_AFTER = /[“‘(«\[]/;

function buildLines(glyphs) {
  const items = glyphs.slice();
  items.sort((a, b) => a.y - b.y || a.x - b.x);

  const lines = [];
  let cur = null;
  for (const g of items) {
    if (!cur || Math.abs(g.y - cur.y) > Math.max(2.5, cur.size * 0.55)) {
      cur = { y: g.y, size: g.size, glyphs: [g] };
      lines.push(cur);
    } else {
      cur.glyphs.push(g);
      cur.size = Math.max(cur.size, g.size);
    }
  }

  const out = [];
  for (const line of lines) {
    line.glyphs.sort((a, b) => a.x - b.x);

    // 空格有两种来源：真的有一个空格字形（Word 导出的 PDF 很常见），
    // 或者字形之间留了空档（排版软件常这么干）。两种都要认。
    const entries = [];
    let pendingSpace = false;
    for (const g of line.glyphs) {
      if (!g.ch) continue;
      if (g.ch.trim() === '') {
        if (entries.length) pendingSpace = true;
        continue;
      }
      entries.push({ g, spaceBefore: pendingSpace });
      pendingSpace = false;
    }

    let text = '';
    for (let i = 0; i < entries.length; i += 1) {
      const { g, spaceBefore } = entries[i];
      const prev = i > 0 ? entries[i - 1].g : null;
      const next = i + 1 < entries.length ? entries[i + 1].g : null;
      if (prev) {
        const cjk = isCjk(g.ch) || isCjk(prev.ch);
        const keptTight =
          NO_SPACE_BEFORE.test(g.ch) ||
          NO_SPACE_AFTER.test(prev.ch) ||
          // 直引号夹在字母中间时是撇号，不是引号
          (g.ch === "'" && /[A-Za-z]/.test(prev.ch) && next && /[A-Za-z]/.test(next.ch));
        let need = false;
        if (spaceBefore) {
          need = !cjk && !keptTight;
        } else {
          // 用「上一字应有的宽度」和实际位移比较：多出来的那截就是词间空格
          const gap = g.x - (prev.x + prev.adv);
          // 标点旁的位移估算偏差大，门槛抬高一点，免得 `Alzheimer ’ s` 这种
          const thr = /[’'.,;:!?)\]”]/.test(prev.ch)
            ? Math.max(1.4, g.size * 0.2)
            : Math.max(1.1, g.size * 0.14);
          need = !cjk && !keptTight && gap > thr;
        }
        if (need) text += ' ';
      }
      text += g.ch;
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const boxes = entries.map((e) => e.g);
    out.push({
      text,
      x: Math.min(...boxes.map((g) => g.x)),
      y: line.y,
      size: Math.round(line.size * 10) / 10,
    });
  }
  return out;
}

function isCjk(ch) {
  const c = ch.codePointAt(0);
  return (
    (c >= 0x2e80 && c <= 0x9fff) ||
    (c >= 0xff00 && c <= 0xffef) ||
    (c >= 0x3000 && c <= 0x303f)
  );
}
