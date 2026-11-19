# 外刊精读 · en-reader

自用的一个极简的英文外刊精读站。每日导入经济学人考研英语外刊。

---

## 相关功能

**文章库（`index.html`）**
- 列表展示标题、来源、日期、难度、词数和预计阅读时间
- 搜索（标题 / 来源 / 标签 / 摘要）、难度筛选、按日期 / 标题 / 篇幅排序
- 显示每篇文章的阅读进度，点进去会接着上次的地方读

**精读页（`reader.html?id=…`）**
- 点任意单词 → 浮层显示音标、英文释义、例句、中文翻译
- 一键加入生词本，全文所有该词自动高亮（原文已收录的词带下划线）
- 悬停段落左侧出现 ▶，整段逐句朗读，当前句高亮
- 顶栏「朗读全文」按钮或 `K` 键随时开始 / 暂停；开始朗读后再按空格也是暂停 / 继续
- 字号调节、深浅色主题
- 滚动进度自动保存，下次打开自动回到原位；同时累计阅读时长

**生词本（`vocab.html`）**
- 到期数量、今日新增 / 今日复习统计
- 按到期时间排序，显示每个词下次复习时间
- 复习模式：显示单词 → 显示释义 → 分为三档三档（遗忘 / 模糊 / 记得），
  按 SM-2 简化算法安排间隔：忘了 10 分钟后再来，记得 1 天 → 3 天 → 越来越远
- 键盘操作：空格显示释义，`1` / `2` / `3` 评分
- 导出 JSON 备份、清空

**导入（`import.html`）**
- 粘贴正文（段落之间空一行，段内换行自动合并），或拖入 `.txt` / `.md`
- **拖入 PDF 自动解析**：去页眉页脚和讲稿板块、只留英文正文、按 `【Para. N】` 与行距重新分段、
  从封面自动读取标题 / 来源 / 日期 / 难度 / 中文脉络
- **讲义类 PDF 会额外认出发音稿结构**（见下节）：每段中文译文、讲义单独讲过的词条、翻译作业与句子分析
- 自动统计字数与段数，可预览分段
- 保存后立即开始阅读（存在本机浏览器，只有你看得见）
- 「导出全部 JSON」：把本机文章导成 `articles.json`，合并进 `data/` 就变成所有人可见

**讲义模式（精读页自动开启）**
- 顶栏多一个 `原文 / 双语` 分段开关：双语时每段英文下面跟着该段中文译文，选择会记住
- 讲义讲过的词在正文里是**虚线**，点开就是讲义的解释（音标、词性、英文释义、中文、例句、`【考研大纲词汇】` 之类的标签），
  不走网络；需要更详细的释义时卡里还有「查词典」
- 正文下方 `本篇词表`：讲义全部词条与短语的清单，点任意一条同样打开讲解卡
- 文末 `翻译作业`：作业原句 + 参考译文（= 该段译文）+ 句子分析，译文写进 textarea 会存在本机

---

## 依赖

需要 Node.js（18+ 即可，无需安装依赖）。

```bash
cd en-reader
node tools/serve.mjs        # 默认 http://127.0.0.1:5173
```

或者：

```bash
npm start
```

> **不要直接双击 `index.html`。** 浏览器在 `file://` 协议下会拦截 ES module 与 `fetch('data/articles.json')`，
> 页面会空白。必须通过上面的本地服务器（或任意静态服务器）访问。

---

## 导入文章

### 方式一：网页导入（推荐，带预览）

打开 `http://127.0.0.1:5173/import.html`，粘贴正文，填标题 / 来源 / 难度，保存。

也可以**直接把 PDF 拖进页面**（或点「选择文件」）：PDF 会在浏览器里当场解析，不需要上传到任何服务器。
解析器会自动做这些事：

- 去掉页眉页脚、页码、公众号水印、版权行等
- 认出正文正文字号，只留英文段落，剔掉夹在里面的中文引导句
- 识别 `【Para. 1】` 这类分段标记，按行距重新分段
- 跳过词汇注释、译文、长难句分析等讲稿板块
- 从封面读出标题、来源、日期、难度星级、中文脉络，自动填进表单

也支持 `.txt` / `.md`（按空行分段）。解析结果只是「填好表单」，保存前可以随便改。

> PDF 需要**有文字层**。扫描件（整页是图片）读不出字；双栏排版、竖排或特殊字体的 PDF 可能断行不准，
> 这时用「预览分段」检查一下，或直接粘贴正文。

文章存在 `localStorage`，**只有你自己的浏览器看得到**。想公开给所有人看，点「导出全部 JSON」，
把导出的数组内容合并进 `data/articles.json` 的 `articles` 字段，提交到仓库即可。

### 方式二：命令行导入（直接写入文章库，所有人可见）

```bash
node tools/import.mjs article.txt \
  --title "Why We Sleep" \
  --source "The Economist" \
  --date 2026-11-19 \
  --level C1 \
  --tags 科技,社会 \
  --summary "一句话中文摘要"
```

可用参数：`--subtitle` `--author` `--id` `--force`（覆盖同名 id）。

---

## 发布给所有人看

整个 `en-reader/` 目录就是一个静态站点，把根目录指向它即可：

- **GitHub Pages**：推到仓库 → Settings → Pages → 选择分支根目录
- **Netlify / Vercel / Cloudflare Pages**：新建项目，构建命令留空，发布目录填 `en-reader`（或把它作为仓库根）

`data/articles.json` 里的文章对所有访客可见；生词本、阅读进度、导入的本机文章都存在**访客自己的浏览器**里，
不需要账号，也不会上传任何数据。

---

## 数据结构

`data/articles.json`：

```json
{
  "version": 1,
  "articles": [
    {
      "id": "why-you-forget-the-words-you-learn",
      "title": "Why You Forget the Words You Learn",
      "subtitle": "Memory is not a bucket.",
      "source": "The Economist",
      "date": "2026-11-12",
      "level": "B2",
      "tags": ["心理", "学习方法"],
      "summary": "一句话中文摘要",
      "paragraphs": ["第一段…", "第二段…"]
    }
  ]
}
```

段落是纯文本数组，标点符号和引号原样保留即可；句子切分与单词切分在浏览器里完成。

讲义文章（从讲义 PDF 导入的）会多一个 `lesson` 字段，普通文章没有它，精读页就按单语渲染：

```json
{
  "id": "local-xxx",
  "title": "Mental block",
  "paragraphs": ["第一段英文…"],
  "lesson": {
    "lead": { "en": "The blood-brain barrier may…", "zh": "血脑屏障可能…" },
    "paragraphs": [{ "n": 1, "en": "第一段英文…", "zh": "第一段中文译文…" }],
    "notes": [{
      "term": "protection", "pos": "n", "phonetic": "/prəˈtekʃn/",
      "def": "the act of keeping someone safe", "zh": "保护",
      "tag": "考研大纲词汇", "example": "The law provides protection.", "exampleZh": "法律提供保护。"
    }],
    "exercise": {
      "title": "今日翻译作业", "para": 2,
      "en": "Researchers found that…",
      "analysis": "句子主干：…"
    }
  }
}
```

`lesson` 可以手写，也可以只写其中几个字段：缺段落译文就只有英文，缺 `exercise` 就不显示作业区。

---

## 用到的免费服务

| 用途 | 接口 | 说明 |
| --- | --- | --- |
| 英文释义 / 音标 / 发音音频 | `api.dictionaryapi.dev`
| 中文翻译（主） | `api.mymemory.translated.net`
| 中文翻译（备） | `translate.googleapis.com`
| 朗读 | 浏览器 `speechSynthesis`

中译取不到时只是不显示中文，不影响查词、加生词和阅读；失败的词会记住 10 分钟，
免得同一个词反复空等。若释义也一直转圈，说明网络访问不到 `dictionaryapi.dev`，
换成能访问外网的网络，或把 `assets/dict.js` 里的地址替换成自己的代理。

---

## 目录结构

```
en-reader/
├─ index.html            文章库
├─ reader.html           精读页
├─ vocab.html            生词本 + 复习
├─ import.html           导入
├─ data/articles.json    公开文章数据
├─ assets/
│  ├─ style.css          全部样式
│  ├─ core.js            存储 / 偏好 / SRS / 文本处理
│  ├─ dict.js            词典与翻译（带缓存、降级）
│  ├─ ui.js              主题、导航、提示、朗读器
│  ├─ library.js         首页逻辑
│  ├─ reader.js          精读页逻辑
│  ├─ vocab.js           生词本逻辑
│  ├─ importer.js        导入页逻辑
│  ├─ pdftext.js         PDF 文字层提取（零依赖，自己解 FlateDecode / CMap）
│  ├─ pdfextract.js      从 PDF 行里认出正文段落与元信息
│  └─ pdflesson.js       讲义 PDF：分段译文、词汇注释、翻译作业
├─ tools/
│  ├─ serve.mjs          零依赖静态服务器
│  ├─ import.mjs         命令行导入
│  └─ selftest.mjs       浏览器端自检（需另开一个终端跑服务器）
├─ docs/
│  ├─ whats-new.md       美术与动效的改动对照（之前 / 现在）
│  └─ polish-log.md      逐轮记录：改了什么、为什么、怎么验的
└─ README.md
```

自检（PDF / 讲义解析 + 用无头 Chrome 把四个页面跑一遍，共 25 项）：

```bash
node tools/serve.mjs      # 终端 A
node tools/selftest.mjs   # 终端 B；自动寻找 Chrome/Edge，也可用 CHROME_PATH 指定
```

---

## 关于版权

仓库里的两篇示例文章是**为演示原创撰写**的，可以随意修改或删除。
导入真实外刊时，请只保存给自己学习使用；若要公开部署，建议只放你自己写的摘要 + 原文链接，
或使用公版文本（Project Gutenberg、Wikipedia、政府公开报告等）。

---

## 未来更新计划

- 文章内的「句子翻译」逐句对照
- 生词本按文章 / 标签分组，导出 Anki
- 阅读统计页：每日词数、复习热力图
- 词形还原已做了轻量版（`assets/dict.js` 的 `lemmas()`），可以接更完整的词表
- 多用户：加一个后端（SQLite + 简单登录）即可同步生词
