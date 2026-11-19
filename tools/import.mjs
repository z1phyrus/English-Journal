#!/usr/bin/env node
/**
 * import.mjs · 命令行导入文章到 data/articles.json（所有人可见）
 *
 * 用法：
 *   node tools/import.mjs article.txt --title "Why We Sleep" --source "The Economist" \
 *        --date 2026-11-19 --level C1 --tags 科技,社会 --summary "一句话中文摘要"
 *
 * 可选：--subtitle "导语"  --id my-slug  --force（允许覆盖同 id）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DATA = path.join(ROOT, 'data', 'articles.json');

const argv = process.argv.slice(2);
if (!argv.length || argv[0].startsWith('--')) {
  console.error('用法: node tools/import.mjs <文章.txt> [--title ...] [--source ...] [--date YYYY-MM-DD] [--level B2] [--tags a,b] [--summary ...] [--subtitle ...] [--id slug] [--force]');
  process.exit(1);
}

const file = argv[0];
const flags = {};
for (let i = 1; i < argv.length; i += 1) {
  const arg = argv[i];
  if (!arg.startsWith('--')) continue;
  const key = arg.slice(2);
  const next = argv[i + 1];
  if (!next || next.startsWith('--')) {
    flags[key] = true;
  } else {
    flags[key] = next;
    i += 1;
  }
}

const raw = fs.readFileSync(file, 'utf8');

function splitParagraphs(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/\n\s*/g, ' ').replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean);
}

function slugify(title) {
  const slug = String(title)
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return slug || `article-${Date.now().toString(36)}`;
}

const paragraphs = splitParagraphs(raw);
if (!paragraphs.length) {
  console.error('文件里没有正文。');
  process.exit(1);
}

const title = flags.title || paragraphs[0].split(/(?<=[.!?])\s/)[0].slice(0, 90);
const id = flags.id || slugify(title);

const db = JSON.parse(fs.readFileSync(DATA, 'utf8'));
const articles = Array.isArray(db.articles) ? db.articles : [];

const existing = articles.findIndex((a) => a.id === id);
if (existing >= 0 && !flags.force) {
  console.error(`已存在同 id 的文章：${id}（加 --force 覆盖）`);
  process.exit(1);
}

const article = {
  id,
  title,
  subtitle: typeof flags.subtitle === 'string' ? flags.subtitle : '',
  source: typeof flags.source === 'string' ? flags.source : '',
  author: typeof flags.author === 'string' ? flags.author : '',
  date: typeof flags.date === 'string' ? flags.date : new Date().toISOString().slice(0, 10),
  level: typeof flags.level === 'string' ? flags.level : '',
  tags: typeof flags.tags === 'string'
    ? flags.tags.split(/[,，;；]/).map((t) => t.trim()).filter(Boolean).slice(0, 6)
    : [],
  summary: typeof flags.summary === 'string' ? flags.summary : '',
  paragraphs,
  createdAt: new Date().toISOString(),
};

if (existing >= 0) articles.splice(existing, 1);
articles.unshift(article);

const out = {
  version: db.version || 1,
  updatedAt: new Date().toISOString(),
  articles,
};

fs.writeFileSync(DATA, `${JSON.stringify(out, null, 2)}\n`, 'utf8');

const words = (paragraphs.join(' ').match(/[A-Za-z][A-Za-z'’-]*/g) || []).length;
console.log(`已写入 data/articles.json`);
console.log(`  id      ${id}`);
console.log(`  标题    ${title}`);
console.log(`  篇幅    ${paragraphs.length} 段 / ${words} 词`);
console.log(`  总计    ${articles.length} 篇文章`);
