# 美术与动效日志

用户回来后要的「改动清单」就跑这里。每轮记录：改了什么、为什么、怎么验证的。

## 2026-11-19 · 第一轮：纸感、排版细节、动效系统

**基调**：把站点的气质从「干净的网页」推向「印在纸上的外刊」——米白纸面、极淡噪点、衬线正文、深绿强调色。所有效果零依赖（内联 SVG、纯 CSS），不加载任何外部图片或字体，离线可用。

### 视觉
- **纸纹**：`body` 上铺一层内联 SVG 噪点（`feTurbulence`，`--grain`），浅色用 `multiply`、深色用 `soft-light`。浓度调到约 1~2%，只在细看时感到纸的颗粒，不影响阅读对比度。（第一版 5% 太脏，已回调。）
- **首屏强调**：标题里「自己的英语」下方加一笔手写感的斜线，长度从左向右生长出来，像编辑用红笔划的重点。纯 CSS `::before` + `transform` 动画，主题色自动跟随深浅色。
- **首屏 kicker**：`— ENGLISH · EXTENSIVE READING` 前面加一条 26px 细线，更像杂志眉。
- **首字下沉**：精读页第一段第一个字母做 drop cap（深绿、3.15em、浮动），外刊排版里最经典的一个细节。
- **空状态**：文章库无结果、生词本为空时，加一枚 7px 菱形花饰，代替孤零零的一行灰字。
- **正文结尾**：正文底部横线上穿一枚菱形小花饰，作为「读完了」的句点。
- **进度**：阅读页顶部的进度条改成 深绿→琥珀 渐变并带一点辉光；右侧新增等宽数字的百分比读数（滚动时实时更新，手机上隐藏）。

### 动效
- **滚动入场**：标题、统计格、文章列表、正文段落、生词表格行在进入视口时轻微上浮淡入，同组错峰 55~70ms；`prefers-reduced-motion` 时整套关闭。
- **悬停**：文章列表项左侧竖线从上展开、标题轻微右移；正文里的生词用「荧光笔扫过」的方式从字底泛出底色；段落朗读键 hover 放大、按下回弹；按钮统一抬升 1px + 柔和投影。
- **换页**：接入 `@view-transition`，支持的浏览器里页面之间是 0.26s 的交叉淡出。
- **查词浮层**：弹簧式弹出，并从被点的那个词的位置「长」出来（动态设置 `transform-origin`）。
- **复习卡**：卡片弹簧入场，答案淡入上浮，三档评分按钮依次入场。
- **切主题**：点太阳/月亮时，全局底色、边框、文字在 340ms 内一起过渡，不闪。
- **顶栏**：滚动后出现一条极淡的分隔阴影。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误（滚动入场、百分比、浮层动画都没破坏分词、进度、生词、复习、导入）。
- 截图：`screens/polish-*.png`（浅色/深色/移动端/浮层/空状态/正文结尾）。

### 已知取舍
- 纸纹浓度是主观值，深色下更克制（0.035 vs 0.055）；如果用户觉得重，改 `--paper` 即可。
- 首字下沉只作用于第一段，避免每段都下沉导致页面花。
- 滚动入场用 IntersectionObserver + MutationObserver 监听动态内容；JS 不可用时这些样式完全不生效，内容正常显示（不会白屏）。

## 2026-11-19 · 第二轮：信息层级与卡片手感

**基调**：第一轮解决「气质」，这一轮解决「一眼看懂到哪了」——文章库不再一屏里说两遍词数，复习卡真的翻过来。

### 视觉与信息层级
- **文章库右侧只回答一个问题**：未读 / 在读 45% / 已读完。前面一个小圆点（未读空心、在读实心深绿、读完实心灰），下面一条细进度条。原来右侧重复显示「442 词」（meta 行已经有了），已删掉。
- **右侧状态块与文字垂直居中**（原来标签在顶、进度条沉在底，像两个不相干的东西）。
- **复习卡真翻面**：正面只有单词与音标，按下「显示释义」或空格，卡片绕 Y 轴 3D 翻转（0.6s，`preserve-3d` + `perspective: 1500px`），背面是中文、英文释义、例句引文；评分按钮在卡片外，翻面后出现。
- **背面排版**：中文放大到 1.55rem 作主角，释义 0.95rem，例句斜体；去掉原来「答案」区的虚线分隔（现在整面都是答案，不需要一条线）。
- **卡片高度固定**：翻面前后 `#rv-card` 都是 318px（已用 CDP 量过），不会在翻转时跳。

### 动效
- 卡片翻面用旋转而不是淡入，配合 `backface-visibility: hidden`，两面互不穿透。
- 每张新卡落下时有 0.42s 的 `dealIn`（上浮 + 淡入，`animation` 不带 `fill`，所以后面的 `rotateY(180deg)` 不会被锁住）。
- 翻面后按钮组继续沿用第一轮的错峰入场。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误（复习断言仍是 `#rv-answer.hidden === false` + 3 个评分按钮，翻面改动没有破坏它）。
- 截图：`screens/polish-review-front.png`、`polish-review-back.png`、`polish-index-light.png`（在读/已读完两种状态）。

## 2026-11-19 · 第三轮：手感的细节

一路下来最容易被忽略的，是那些「点一下之后」的反馈。

### 改了什么
- **收词不再让正文跳行**：`.w.saved` 原来除了变色还加 `font-weight: 600`，字宽一变整段会重新折行——读着读着页面就动一下。现在只保留颜色（已收词的底纹由 `.known` 提供），排版不再动。
- **收词按钮按下回弹**：点「+ 加入生词本」后按钮先压到 0.955 再弹回（`savePop`，0.5s 弹簧），配 `void btn.offsetWidth` 强制重排，连续收词时动画每次都能重放。
- **生词表格行**：hover 的底色变化加了 0.18s 过渡，不再是一下子跳过去。
- **PDF 解析状态条**：出现时轻微上浮淡入，不让它「啪」一下挤出来。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误。
- 截图：`screens/polish-reader-saved.png`（已收词 ritual / stranger / culprit 在正文里的样子）。

## 2026-11-19 · 第四轮：把「预览」做成一张校样

### 改了什么
- **预览分段变成校样**：预览框现在有自己的结构——顶部一行小字 `预览 · 3 段 · 58 词`（等宽/大写间距，像杂志的栏目标签），标题下面每一段左侧挂一个等宽数字编号。段落切得对不对，一眼就能数。
- **预览框左内边距加宽**（`3.7rem`），给编号留出走字的余地；手机上关闭编号、恢复 1.2rem 内边距，避免正文被挤窄。
- **空状态换成星号花饰**：原来是一枚菱形，现在用 `mask` 画的三连菱形（asterism，⁂）——书籍里用来替代省略号的排字符号。用 `mask` 而不是 `background-image`，所以颜色跟着 `--line-strong` 走，深色下自动变浅。
- **预览出现时**上浮淡入 0.45s，不该「啪」一下出现。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误（导入断言仍是 3 段预览、保存后跳转正常）。
- 截图：`screens/polish-import-preview.png`、`polish-vocab-empty.png`、`polish-reader-dark.png`。

## 2026-11-19 · 第五轮：朗读高亮与「复习结束」

### 改了什么
- **朗读中的句子**：改用 `box-decoration-break: clone`，一句话折成三行时，每一行都有自己的圆角底色，而不是只有首尾两个角有弧度——这才是马克笔划过去的样子。底色提到琥珀 20%，配 0.35s 过渡 + 0.5s 首亮动画（从 34% 落到 20%，像笔尖落下）。
- **复习完成卡**：原来只有一行字和一个按钮。现在是一张「收尾卡」——顶部星号花饰、衬线大字「这一轮结束了」、下面三格数字（记得·深绿 / 模糊·琥珀 / 忘了·墨色，等宽数字衬线），再一句提醒。
- **完成态收口**：复习结束后右上角的「空格 显示释义 · 1/2/3 评分」淡到 18%（留位不跳动），因为这时候键盘提示已经没有意义了。
- **星号花饰抽成变量**：`--asterism` + 可复用的 `.asterism` 类，空状态与完成卡共用一份 SVG，颜色仍走 `--line-strong`（深色自动变浅）。
- **尊重「减少动态效果」**：`ui.js` 新增 `motionOK()` / `scrollBehavior()`；导入页预览的 `scrollIntoView` 在系统开启减少动态时改为瞬间跳转，不再平滑滚动。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误（复习完成断言仍是 `#rv-done` 存在、`.review-done p` 有内容）。
- 截图：`screens/polish-reader-speaking.png`、`polish-review-done.png`。

## 2026-11-19 · 第六轮：窄屏不再丢信息，动效可关闭

### 改了什么
- **生词表在手机上是卡片不是表格**：屏幕上放不下四列，原来直接 `display:none` 掉了「来源」和「下次复习」——等于把信息扔了。现在窄屏切换成卡片布局（`grid-template-areas: "word del" "def del"`）：第一行是单词 + 音标，第二行是释义，第三行是「现在 · 来自哪篇文章」；删除按钮固定在右上。桌面端仍是四列表格，两套布局共用同一份 DOM。
- **音标不再被折断**：窄屏下 `white-space: nowrap`，`/ˈstreɪndʒə/` 不会在斜杠处裂成两行。
- **375px 以下的顶栏**：新增 `@media (max-width: 400px)`，品牌字、导航内边距、外框留白一起收一档，给「文章 / 生词本 / 导入 / 主题」留出空间。
- **「减少动态效果」实测**：用 CDP 把 `prefers-reduced-motion` 模拟成 `reduce` 后截图，并用脚本统计关键元素的 `opacity`——`REDUCED hidden elements: 0`，没有任何内容因为入场动画被卡在半透明状态；首屏强调线的 `markIn` 会瞬间到位。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误。
- 截图：`screens/polish-vocab-mobile.png`（390px 卡片式生词表）、`polish-index-reduced.png`（reduce 模式，同时补上了「未读」状态的样张）。

## 2026-11-19 · 第七轮：查词浮层在手机上变成底部抽屉

### 改了什么
- **手机上不再是「跟着词飘的卡片」**：原来无论屏幕多宽，浮层都以被点的词为锚点定位（宽度 = 100vw - 1.2rem 的整条）。在 390px 下它仍会盖住词所在的那一段，用户刚点完词就看不见词了。现在 ≤640px 走底部抽屉：`top: auto !important`、`bottom: 0.5rem`、`left/right: 0.5rem`、`max-height: 68vh`、18px 圆角、顶部一根 36×4 的把手，正文区内部滚动（`.pop-body { flex: 1; min-height: 0; overflow-y: auto }`），fade 从下方升起（`sheetIn`）。桌面端几何完全不变。
- **浮层高度有天花板的通用修法**：把 `.popover` 变成 flex 纵向容器（`.pop-head/.pop-foot { flex: none }`、`.pop-body { flex: 1; min-height: 0 }`），这样长词条只在 `.pop-body` 内部滚动，标题和「加入生词本」按钮永远钉住。
- **朗读时聚焦当前段**：`.article-body:has(.s.speaking) .para:not(:has(.s.speaking)) { opacity: 0.42 }`，配 `.para { transition: opacity .45s }`。朗读一个自然段时，其余段落压暗，视线跟着高亮句走；停读立即恢复。纯 CSS `:has()`，不需要 JS 记账。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误（浮层三条断言仍通过：词、音标、词典释义 218 字符、中译 `礼数中译 · MyMemory`）。
- CDP 量过抽屉几何：`innerHeight 844`、抽屉 `top 507 / bottom 836`（`bottom: 8px` 生效），没有出屏。
- 截图：`screens/polish-popover-mobile.png`（点 ritual，词仍在抽屉上方可见）、`polish-reader-speaking.png`（当前段高亮、其余段落压暗）。

## 2026-11-19 · 第八轮：进度条变成尺子，拖放有了明确的落点

### 改了什么
- **进度条加段落刻度**：`reader.html` 的 `.progress-rail` 里多了一层 `#rail-ticks`，`paintTicks()` 在排版完成、字体就绪（`document.fonts.ready`）、窗口缩放（debounce 180ms）、字号调整后重算。每个刻度是 1×5px 的小竖线，位置 = `段落文档顶 / (scrollHeight - innerHeight)`，**间距小于 1.2% 的后段自动跳过**（文章末尾几段在滚动上都会贴到 100%，不筛会挤成一团色块）。
- **刻度用 `color-mix(in srgb, var(--ink) 30%, transparent)`**：一开始用 `--line-strong`，深色主题下它在暗底上几乎不可见；改成按墨色混合，深浅两个主题都成立。
- **朗读时点亮当前段刻度**：`assets/ui.js` 的 `Speaker._next()` 与 `stop()` 各派发一个 `er:speak` 自定义事件（`{ speaking, node }`），`reader.js` 监听后用 `node.closest('.para').dataset.i` 找到对应刻度，加 `.is-current`（2px 宽、10px 高、琥珀色 + 辉光）。这样「读到哪一段」在顶栏也有一处极小的提示，不用回头数。
- **拖放遮罩重做**：原来是「松手即可导入 PDF / txt」一个深绿色胶囊，信息量低。现在是一张卡片：衬线标题「松手即可导入」+ 一行副文案，**副文案按拖进来的类型变化**（`dragHint()` 读 `dataTransfer.items` 的 MIME：PDF → 「会自动去掉页眉页脚、词汇注释和译文，只留下英文正文」；`text/*` → 「txt / md 按空行切段」；其他文件 → 「支持 PDF / txt / md」），出现时有一次 0.24s 的上浮淡入（`veilIn`）。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误。
- CDP 量过刻度：1280×900 下 5 枚刻度在 `x = 446 / 657 / 905 / 1152 / 1264`，`y = 52`、`5px` 高，正好压在 `y = 55` 的 2px 轨道上；`er:speak` 事件链实测 `[false, true]`（headless 里 `speechSynthesis` 会立刻 `onerror` 再 `stop()`，所以最终归为 false——真实浏览器会保持亮起）。
- 截图：`screens/polish-import-drop.png`（遮罩卡片）、`polish-reader-speaking.png`（顶栏刻度 + 当前段点亮）。

## 2026-11-19 · 第九轮：深色主题巡检 + 「上次读到」

### 改了什么
- **深色主题补 `color-scheme`**：`:root { color-scheme: light }` / `:root[data-theme="dark"] { color-scheme: dark }`。之前深色下原生控件不跟随：导入页的日期选择器图标是黑的（几乎看不见）、下拉弹出层是白底、滚动条是浅色的。这一行 CSS 让浏览器自己把原生控件切到暗色。
- **首页新增「上次读到」条**：`index.html` 在首屏按钮组下面加 `.resume`（`#resume`），`library.js` 的 `renderResume()` 从 `allProgress()` 里挑**最近一次、且 2% < pct < 98.5%** 的文章（读完的不算、刚打开的不算），填标题、百分比和进度条；整条就是 `<a>`，点哪都能继续读。没有符合条件的进度就 `hidden`——这里踩过一次 `[hidden]` 被 `display: grid` 覆盖的坑，所以显式写了 `.resume[hidden] { display: none }`。
- 窄屏（≤640px）改成「眉题 + 百分比」一行、标题一行、进度条一行，隐藏 `继续阅读` 字样（整条可点，不需要再多一个热区），标题允许折行。
- 深色/浅色/移动端各补了截图：`polish-vocab-dark`、`polish-import-dark`、`polish-popover-dark`、`polish-review-dark`、`polish-index-mobile-resume`。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误。
- CDP 断言：无进度时 `#resume.hidden === true`；写入 `pct: 0.47` 与一篇 `pct: 1` 后重载，`href = reader.html?id=why-you-forget-the-words-you-learn`、`title` 正确、`pct = 47%`、`fill = 47%`（读完了那篇被正确排除）。
- 截图：`screens/polish-index-light.png`（桌面「上次读到」）、`polish-index-mobile-resume.png`（窄屏两行式）、`polish-import-dark.png`（日期控件已跟随暗色）。

## 2026-11-19 · 第十轮：行宽跟着字号走，暗色下卡片站得住

### 改了什么
- **行宽随字号缩放（排印上最实质的一次修正）**：`reader.js` 的 `applyScale()` 里加一句 `document.documentElement.style.setProperty('--col', `${(41 * scale).toFixed(2)}rem`)`。原来 `.article` 的宽度固定 `41rem`（656px），字号调到 150% 时每行只剩三十来个字符——眼睛要在窄柱子里来回跳；调到 85% 时又变成八十多字符一行。现在宽度与字号线性同步：150% → 984px、100% → 656px、85% → 558px，任何档位都稳定在 65~70 个字符。手机上 `@media (max-width:640px)` 的 `width: calc(100% - 1.9rem)` 仍然优先，行为不变。
- **`@view-transition` 尊重「减少动态效果」**：`@media (prefers-reduced-motion: reduce) { @view-transition { navigation: none } }`。之前只靠全局的 `animation-duration: 0.01ms` 兜着，浏览器仍会走一遍过渡机制；关掉之后换页是直接切。
- **深色下的复习卡抬起来**：`:root[data-theme="dark"] .review-card { background: #221e1a; border-color: ink 12%; box-shadow: 0 40px 80px -40px #000, 0 2px 0 #fff 4% inset }`。深色里卡片和背景本来只差一档，屏幕亮度低时几乎看不出边界；现在有一条可见的边 + 内侧顶部高光 + 更深的投影。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误。
- CDP 量过：`fontScale 1.5` 时 `.article-body` 28.5px、正文栏 984px；`0.85` 时 16.1px / 558px（改之前两者都是 656px）。
- 截图：`screens/scale-150.png`、`scale-085.png`（两个极端字号的排版）、`polish-review-done-dark.png`（暗色完成卡）。

## 2026-11-19 · 第十一轮：读完给一个句号

### 改了什么
- **精读页读完不再是无路可走**：滚到 97% 之后，正文下面出现一张收尾卡（`#article-done`）——星号花饰、「读完了」小标题、一句实话「这一篇你收了 N 个词，其中 M 个现在就能复习」，加两个出口「去复习这一篇的词」和「下一篇 →」。`updateDone(pct)` 在滚动 rAF 里与进度条同步判断，跨过阈值才动 DOM（用 `doneShown` 记住状态，避免每帧写 innerHTML）。
- **下一篇的顺序**：`boot()` 里 `await loadLibrary()` 取文章库，按列表顺序（默认按日期倒序）取当前文章的下一条；是最后一篇就隐藏「下一篇」。
- **页脚去重**：收尾卡出现后，页脚里那个「去复习生词」按钮自动隐藏（`footReview.hidden = true`），回来时再显示——否则两个几乎一样的按钮上下贴着。
- **触屏文案**：页脚提示原来写「悬停段落左侧可整段朗读」，手机上没法悬停。改成两段 span，`@media (hover: none)` 时换成「点段落左侧 ▶ 整段朗读」。

### 验证
- `node tools/selftest.mjs` → 19/19 通过，0 运行时错误。
- CDP 断言：页面顶部时 `#article-done.hidden === true`、`0%`；滚到底后 `hidden === false`、文案为「这一篇你收了 2 个词，其中 1 个现在就能复习。」、`#done-next` 指向 `reader.html?id=a-city-that-drinks-the-sky`。
- 截图：`screens/polish-reader-done.png`（桌面）、`polish-reader-done-mobile.png`（窄屏）。
