# 变更记录（CHANGELOG）

> **纪律**：任何大版本重写必须在本文件记录「**删了什么、为什么删、是否已回填**」，防止再次发生 v3.0 那种"重写导致已验证细节丢失"的事故（见 [docs/REVIEW-v3.0.md](./docs/REVIEW-v3.0.md) B1–B11）。
> 同仓库多文档结论冲突 = 阻断项，修复前不得开工。

---

## v3.45 — 2026-09-13（抓取残留粘连 + 引导程序让用户选目录）

**触发**：用户复查上一轮修复，问三件事 —— ①「抓取的标签清晰了吗？还有空行吗？」
②「抓取文件的看门狗生效了吗？」③「引导程序会不会让用户选择目录进行安装？包括本程序和依赖？」
查下来：① 标签**还剩一处粘连**（§1）、空行堆**已修好**；③ **不会**，而且那是文件头写着、从未实现的目标（§3）。
② 的答案与两个待办见 §5。

### 1. 「标签不粘连」还有第二例：文本节点紧邻 inline 元素

上一轮只修了**相邻 inline 元素**（`<span>Owner</span><span>(required)</span>` → 补空格）。
真机复查仍抓出 **`Owner(required) *`** —— `Owner` 是**裸文本节点**、`(required)` 是紧跟的 `<span>`。
浏览器 `innerText` 对这两种形状**都不补空格**，所以这活儿只能我们干。

`extension/src/content/extract.fn.js:206-221` 的 `walkChildren` 现在同时管两种形状：

| | 形状 | 结果 |
|---|---|---|
| ① | 元素紧跟元素 | 补空格（原有） |
| ② | **文本紧跟元素**，且上一字符是**文字/数字**、该元素以**文字/数字/`(`** 开头 | 补空格（**新增**） |

条件收紧是为了不制造新粘连：`(<span>x</span>)` **不会**变成 `( x )`、`foo<span>,</span>` **不会**变成 `foo ,`
（"上一字符是文字/数字"这条不成立）。

### 2. 夹具漏了形状 ② ⇒ 那条断言一直是**装饰性的**（这次是实测证明的）

第一版夹具把三个节点全写成 `<span>` —— 那份 markup 是**从渲染后的文字反推**的
（`browser_read` 只给文字、看不到节点类型）。后果实测如下：

- 线上抓出 `Owner(required) *` 的同时，`probe:sites` **23/23 全绿**；
- 夹具补上形状 ②、新增断言之后再退回修复，红的**正好**是新断言，而**旧的「标签不粘连」依然绿**
  ⇒ 旧断言对这个形状确实没有咬合力（不是推断，是 `probe exit=1` 那次输出）。

新增断言（`tests/quality/probe-sites.mjs`）：**「文本+内联元素不粘连（不许出现 `Owner(required)`，应为 `Owner (required)`）」**
⇒ `probe:sites` 23 → **24 条断言**。

**咬合验证**：把 `walkChildren` 的新规则退回 `isElement && previousWasElement` ⇒ 该断言变红、`probe` 退出码 1；
还原后 hash 与修复版一致、24/24 绿（`probe:all` 8/8，exit 0）。

### 3. 引导程序：**让用户选择安装目录**（此前只能靠命令行参数）

用户问「会不会让用户选择目录进行安装？」—— 查下来**不会**：`--install-dir` / `--dsh-home` 参数有，
但向导只**打印**算出来的路径再问一句"创建这个目录？"，不接受默认就只能 Ctrl-C 重跑带参数；
`wizard.mjs` 里那个自由输入的 `ask()` **全仓无人调用**（只有它自己的单测碰过）。
而 `bootstrap/install.mjs` 文件头**第 6 行**本来就写着目标「让用户选择安装目录」—— 只是从未实现。

现在（`bootstrap/install.mjs:136-145`）：

```
$ node bootstrap/install.mjs
? 本程序安装到哪个目录？ [/Users/mac/.dsh/plugins/dsh-web-companion] /opt/dshwc
? DSH 数据目录（配对钥匙/凭据放这里）？ [/Users/mac/.dsh] ⏎
```

| 情形 | 行为 |
|---|---|
| 命令行给了 `--install-dir` / `--dsh-home` | **不问**（自动化里让参数说话）—— 实测 `--install-dir /tmp/webtest` 不再提问，计划改用新路径 |
| 真终端 | 各问一句；回车用默认值；`~/xxx` 会展开 —— 实测（pty）两个问句都能作答并被采用 |
| 非交互（管道/CI） | `ask()` 立刻返回默认值，**绝不阻塞** |
| `--apply --yes` | 同上（`ask()` 现在也认 `--yes`），并把选中的路径打出来 |

**目录里装什么**（用户同时问的"包括依赖吗"）：本程序 ✅、esbuild ✅（`<安装目录>/extension/node_modules`，唯一真下载的）；
`@deepseek-ai/dsh` 本体 ❌ 走 `npm install -g`（全局 prefix）；插件运行期依赖 ❌ **从已装的 DSH 里符号链接**
—— 插件跑在 DSH 进程**内**，必须绑到 DSH 自己那份 `@deepseek-ai/dsh-tools`（多一份副本=两个模块实例）。缺链接兜底见 §5。

### 4. 顺带修掉三个真缺陷（都是实测撞出来的）

1. **`ask()` 不认 `--yes`** ⇒ `--apply --yes` 会照样弹问句然后**永久等输入**（`--yes` 的语义被破坏，
   且这正是"自动化里最糟的失败形态：不是报错，是僵住"）。现在 `--yes` 直接回落默认值并打出来（`wizard.mjs:88`）。
2. **stdin 被关掉（Ctrl-D / EOF）时崩栈**：`rl.question()` 抛
   `Error [ERR_USE_AFTER_CLOSE]: readline was closed`；而"提问进行中被关"时那个 promise 可能
   **永不 settle**（挂死）。现在统一走 `askLine()`（`wizard.mjs:44`），与 `close` 事件**赛跑**，
   输入没了就按最保守的默认值收场（是与否→否、路径→默认、等待→不等）**并说明原因**。
3. **安装器收尾谎报"硬判据没过"**（`--apply --yes` 实测）：非交互时 `w.pause()` 返回 false ⇒
   第 11 步复检**没跑** ⇒ `health` 是空数组，而 `overallOk([])` 是 `false`（它要求"至少一条硬判据"）
   ⇒ 一律打印"还有硬判据没过（见上面的 ❌ 与 ↳ 修法）"，可上面**一条 ❌ 都没有**。
   现在抽出纯函数 `finishBanner()`（`bootstrap/lib/health.mjs`）把"**没查**"与"**查了没过**"分开，
   并给出 `doctor.mjs` 自查入口。

回归：`tests/unit/wizard-interaction.test.mjs` 32 → **40 条断言**（`--yes`×2 + EOF×6）、
`tests/unit/install-health.test.mjs` 45 → **52 条断言**（横幅 7 条）。
**咬合验证**：把 `askLine` 退回 `rl.question` ⇒ 向导单测**直接崩在 `ERR_USE_AFTER_CLOSE`**；
删掉 `finishBanner()` 的空数组分支 ⇒ 安装器单测**正好 2 条变红**。

### 5. 复查结论与仍没做的事（如实列出）

- **空行堆已修好**（实测）：新版 61 行/最长连续空行 **1**；修复前那份 107 行/最长连续 **7**。
  但空行占比仍 43%（每个内容行之间一个空行）—— 那是 Markdown 段落分隔，不是这个 bug。
- **看门狗生效，但只有时间上限、没有数量上限**：策略是"mtime 超过 24h 才清"，
  24 小时内抓 1000 次就有 1000 个文件。用户原话是"防止文件数量爆炸" ⇒ `maxFiles` 这类**数量上限未做**。
  上线至今**真实清理正例为 0**（最老一份 23.6h，还差 0.4h 到期）；逻辑层证据：单测 21 条 + 用真实文件名在 `/tmp` 副本上跑真函数。
- **`npmInstallTargets()` 无人调用**：插件依赖若在 DSH 里找不到，安装器只**警告**、没有下载兜底 ⇒ 待办。
- 用户自己的文件（`网页捕获/我的笔记-请勿删除.md`）**永不碰**：已用真实文件名实测。

---


## v3.44 — 2026-09-13（抓取：正文是表单的页面不再抓成空）

**触发**：用户真机使用时发现 —— 用「看左边」抓 `github.com/new`（建仓库页）落盘的文件**只有 front-matter、正文 0 行**；
随后抓 `github.com/settings/ssh/new`（加 SSH key 页）**同样为空**。用户指示：改进它，**中英页面都要管**。

### 1. 根因（一行代码，但影响一整类页面）

`extension/src/content/extract.fn.js` 的 `NOISE` 列表里**含 `form`**：

```js
const NOISE = 'script,style,noscript,svg,canvas,nav,footer,header,aside,form,iframe,…'
```

它把**整类 `<form>`** 当噪音删掉。而**正文本身就是表单的页面**（建仓页、设置页、结算页、登录页…）
删完就什么都不剩 ⇒ 抽取结果为空，落盘文件只有 front-matter。
**与页面语言无关**：中文表单页、英文表单页一样中招。

当初把 `form` 写进去的动机是对的（搜索框 / 订阅框该清），但**判据不该是标签名**。

### 2. 修法：`form` 移出 NOISE，改按"大小/形态"清

新增规则 **E. `stripSmallForms()`**（与既有四条启发式并列，同样可单独关闭 `stripSmallForms: false`）：

```js
const SMALL_FORM_MAX = 120
for (const form of [...clone.querySelectorAll('form')]) {
  if (text(form).length <= SMALL_FORM_MAX) form.remove()   // 搜索框 / 订阅框：文字极少
}
```

判据**只看可见文字量**：搜索框的文字通常只有 "Search" 一两个词（`placeholder` **不算** `textContent`），
订阅框是 "Email / Subscribe"；而真正的表单页满屏标签与说明。120 给了足够余量。

### 3. 回归：新增第 6 类夹具 `form.html`（`probe:sites`，16 → **20 条断言**）

夹具照 GitHub 建仓页的形态写，**故意同时放中英两种标签**（用户要求"中英都要管"）：

| 断言 | 结果 |
|---|---|
| 抓取成功 | ✅ |
| 正文完整 7/7：`FORM-MARKER`、`Create a new repository`、`Repository name`、`Add a README file`、**`仓库名称`**、**`可见性`**、**`私有`** | ✅ |
| 大表单正文非空（>400 字符） | ✅ |
| **小搜索框仍被清掉** | ✅ |

**咬合验证**：把 `form` 塞回 `NOISE` ⇒ **2 条变红**，且缺的正是那 5 个中英标签
（`Repository name | Add a README file | 仓库名称 | 可见性 | 私有`）—— 证明这条夹具**中英两面都能咬**。

### 4. 渲染器也修了：表单拉平成文本时**标签会粘连**（用户指出，2026-09-13）

用户看到真机抓取结果后指出：内容是抓到了，但**压成 Markdown 时标签粘在一起** ——
`Repository owner and nameOwner(required)*`、`).Required`、`Description0 / 350 characters2`。

**根因在渲染器**（`toMarkdown` 的兜底分支），不在抓取层：

| 症状 | 根因 |
|---|---|
| `nameOwner(required)*` | **块级容器**（`div`/`section`/`label`/`fieldset`…）全部落到 `default: inner()`，相邻块之间**不加分隔** |
| 修了块级之后**仍然粘** | 真实 markup 是**同一容器内相邻的 inline `<span>`**（标题 + 值 + 必填徽章），块级分隔管不到它们 |
| `).Required` | 一段结尾与下一段开头直接相接 |

**两处修法**：

1. **块级容器自带分隔**：`div, section, article, main, aside, header, footer, nav, form,
   fieldset, legend, label, figure, figcaption, details, summary, dt, dd, address, hgroup, dialog`
   → `\n\n` 包裹。表单里 `<label>`/`<fieldset>`/`<legend>` 承担"一行一个字段"，是关键的分隔来源。
2. **相邻 inline 元素之间补一个空格**：新增 `walkChildren()`，走子节点时若"上一个也是元素"就补空格。
   **代价明知**：一个词被拆在多个 span 里（纯为样式）会多一个空格；取舍依据是真实页面里
   "相邻 inline 且源码无空白"绝大多数是**不同的界面原子**（标签/值/徽章）。

**回归**（`probe:sites` 表单页夹具，20 → **22 条断言**）：
- `标签不粘连（不含 nameOwner 这种拼接，也不含 ).大写字母）`
- `每个字段标签独立成行（Repository name / Description / 仓库名称 都在行首）`

**★ 咬合验证过程本身暴露了两个我自己的问题，都如实记下**：
1. 夹具**第一版没有复现真机形态**（相邻 span），所以"标签不粘连"那条**退回旧行为时仍然绿**
   —— 装饰性断言。照真机 markup 补上 `<div class="field-head"><span>…</span><span>…</span></div>` 之后它才会咬。
2. **只加块级分隔时，它依然是红的** —— 这才发现真正的症状在 inline 兄弟之间，于是有了第 2 处修法。
   两条断言现在**都**能咬（分别退回 ⇒ 各自变红，均实测）。

**未修（故意）**：GitHub 步骤徽章那种**孤立的 1–2 位数字**（`(*).1`、`…characters2`）。
判据上无法与"合法的短数字"（表格里的 `1`、`5 items`）区分，硬删会误伤真实内容 —— 宁留噪音不误删。

### 4.0 紧接着的第三个症状：**空行堆**（同一处修复引入的，已修）

把标签分开之后，用户看到真机文件**从 34 行变成 106 行、其中 71 行是空行**（21 处 4 连换行）。
数据（同一页面 github.com/new）：

| 时间 | 字节 | 行数 | 空行 |
|---|---:|---:|---:|
| 00:37（修复前） | 206 | 12 | 2（正文为空） |
| 00:53（修好"不丢内容"） | 1366 | 34 | 12 |
| 01:11（修好"标签不粘连"后） | 1447 | **106** | **71** ← 新毛病 |

**根因**：`toMarkdown()` 结尾折过一次 `\n{3,}` → `\n\n`，但**紧接着** `clean()` 会把
U+2028/U+2029（行/段分隔符 —— GitHub 这类页面真的会产出）**再变成换行**，
那一步在折叠**之后** ⇒ 空行又被撑开，而且没人再折一次。

**修法**：在 `clean()` **之后**补一次同样的折叠（一行）。

**回归**：`probe:sites` 表单页再加一条断言 —— `正文没有空行堆（不出现 3 个以上连续空行）`，
共 **23 条**。**咬合验证**：把 `clean()` 之后那次折叠去掉 ⇒ 该断言**变红**（夹具能咬，
说明它复现了真机的 U+2028/U+2029 情形）。

### 4.1 顺带


- `scripts/probe-all.mjs` 里 `probe:sites` 的说明由"5 类页面"改为"**6 类**页面"。
- `npm run check` → **exit 0**（35 个测试套件）；`probe:sites` **20/20**。

## v3.43 — 2026-09-12（英文版，进行中）

**触发**：用户下令开工英文版（「你做英文版了吗? 可以做了啊」）。四个已定决定：**同一份代码双语**
（`_locales` + `chrome.i18n`）；抓取目录**新装用英文名、老装保留 `网页捕获`**；**只翻 README 与
上手/安装文档**；上传 GitHub 等另行下令。

### 1. ★ 单源文案 + 生成，而不是手写两份语言包

手写两份 `messages.json` **一定会漂移**（改了一边忘另一边），而漂移的表现是"切到中文时某几个
标签还是英文"，只有用户会看到、测试很难发现。所以照搬协议那边的做法（单源 → codegen → 逐字节校验）：

```
extension/i18n/messages.source.json          ← 唯一真源：{ key: { en, zh_CN } }
        │  node extension/i18n/codegen.mjs
        ├─→ extension/_locales/en/messages.json      （Chrome 读的）
        ├─→ extension/_locales/zh_CN/messages.json   （Chrome 读的）
        └─→ extension/src/lib/messages.generated.js  （运行期兜底 + 单测可用）
```

`codegen.mjs --check` 已接进 `npm run check`（`i18n:check`，紧跟 `protocol:check`）。
新增脚本：`i18n:codegen` / `i18n:check`。

### 2. 运行期取值：`extension/src/lib/i18n.js`

- `t(key, substitutions)`：优先 `chrome.i18n.getMessage`，**拿不到时退回生成的默认语言包** ——
  这条兜底不是可选项：Node 里没有 `chrome.i18n`，没有兜底的话单测只能断言"要么中文要么 key"，
  等于没断言。
- `applyI18n(root)`：把 `data-i18n` / `data-i18n-title` 的文案填进 DOM，并把 `<html lang>` 设对。
  **Chrome 没有声明式本地化**（`data-l10n` 是 Firefox 的），面板 HTML 是静态的，只能由 JS 填。
- 未知 key **原样返回 key**（而不是空串）—— 一眼能看出漏配。

### 3. 已转换的界面（本轮）

| 位置 | 做法 |
|---|---|
| `extension/manifest.json` | `name`/`description`/`action.default_title` → `__MSG_*__`，加 `default_locale: "en"`。**`key` 未动 ⇒ 扩展 ID 不变**，native host 清单与配对文件无需同步 |
| `extension/src/sidepanel/panel.html` | 英文默认文案 + `data-i18n` / `data-i18n-title` 标记；`panel.js` 启动时 `applyI18n()` 覆盖 |
| `extension/src/sidepanel/errors.js` | 判定与取文案**拆成两个函数**：`explainErrorKey()`（与语言无关，返回 `{key, substitutions}`）+ `explainError()`（取文案）。错误码→key 做成数据表 `CODE_TO_KEY`，好让门禁能静态看见它 |
| `extension/build.mjs` | 静态复制加入 `_locales` |

**顺带修掉一个真 bug**：`build.mjs` 的静态复制 `cpSync` **没带 `recursive: true`**，
复制目录 `_locales` 时直接 `ERR_FS_EISDIR` 崩掉（`npm run check` 正是在这一步变红的）。

### 4. ★ 新门禁（`tests/unit/i18n-messages.test.mjs`，37 条断言，已进 `test:unit`）

翻译最容易出的三类错，各有一条断言钉住：

| 门禁 | 抓什么 |
|---|---|
| 两种语言都不为空 | **两侧漂移**（改了中文忘英文） |
| ★ 两种语言必须不同 + zh_CN 必须含汉字 | **假翻译**（把英文抄进 zh_CN 冒充"翻过了"） |
| 引用的 key 都在源表里 + **已抽取文件里 0 处汉字残留** | **漏抽取** |

`panel-errors.test.mjs` 同时**改测"走对了哪个分支"**（`explainErrorKey`）而不是措辞 ——
原来断言中文字符串，一翻译就得跟着改，那种测试锁的是措辞、还会掩盖"分支走错"。

**咬合验证 4 处**（全部实测变红后还原）：
① zh_CN 全抄成英文 ⇒ 红；② `panel.html` 塞回中文可见文案 ⇒ 红；
③ 代码引用源表里不存在的 key ⇒ 红；④ 删掉一条 zh_CN 文案 ⇒ 红。

> 过程小记（两条都值得记）：门禁第一版把**注释里的中文**误报成残留（扫描器按"整行注释"过滤，
> 挡不住多行块注释与行尾注释）；第二版改成"抽字符串字面量"，又被 `errors.js` 里
> **含引号的正则字面量**（`/Either the '<all_urls>' or 'activeTab'/`）带偏 ⇒ 会**假阴性**。
> 最终采用"按我自己定的规则去注释、再扫剩下文本"，并把已知局限写进测试注释里。

### 5. 本轮**未**做（下一轮继续）

1. `extension/src/sidepanel/panel.js`（318 汉字）与 `extension/src/sw/ops/index.js`（179 汉字）
   等 SW 侧用户可见文案 —— 下一轮抽取，抽完把文件加进 `EXTRACTED_FILES` 门禁清单。
2. **面向模型的 `browser_*` 工具 description**（`dsh-plugin/src/host/tools.js`，789 汉字）：
   宿主进程**没有 `chrome.i18n`**，必须另定机制（候选：profile 配置里加 `locale`）。
3. 抓取目录英文名（安装器对新装写 `attachDir`）。
4. `README.md` 与 `docs/13-安装部署.md` 的英文版（中文版保留）。
5. **真 Chrome 双语验证**：需要用户重新加载扩展，分别在 en 与 zh_CN 界面语言下确认
   manifest 名称、面板文案、错误文案。

### 6. 第二轮抽取：`panel.js` + Service Worker 的用户可见文案

| 位置 | 条数 | 说明 |
|---|---|---|
| `extension/src/sidepanel/panel.js` | 24 | 状态灯、授权门、抓取结果、两个开关的提示（含审批口径那几句）、「看左边」状态 |
| `extension/src/sw/capture.js` | 4 | 截图失败的三种情形（"没取到图" / "图是空的" / 带原因） |
| `extension/src/sw/dsh-session.js` | 5 | DSH 未运行（有/无 native host）、未就绪、未配对、取票据失败 |

**Service Worker 里 `chrome.i18n` 是可用的**，所以 SW 的文案也走同一套 `t()`（不必另立机制）。
顺带把 `dsh-session.js` 里**原本就是英文**的那句"未配对"提示也收进文案表 —— 否则中文用户会看到
一句突兀的英文。

源表 **25 → 58 条**；`EXTRACTED_FILES` **4 → 7 个文件**（`panel.js`、`sw/capture.js`、
`sw/dsh-session.js` 已加入门禁清单）。这三个文件里现在**只剩注释是中文**，面向用户的字面量已清空
（门禁实测 0 处残留）。

**★ 又抓到两处"测试锁的是中文措辞"**（改造后立刻变红，说明它们确实在断言措辞而不是行为）：

| 测试 | 原来断言 | 改成 |
|---|---|---|
| `tests/unit/embed-url.test.mjs` | `/票据/`、`/密钥/` 中文字样 | ★"文案来自文案表（**默认语言无汉字**）+ 带错误码 + 带服务端原因"、模板占位符 2 个、渲染后**无残留 `$1/$2`** |
| `tests/unit/screenshot-mode.test.mjs` | `/截图没成功/`、`/正文已照常投递/` | ★"默认语言无汉字"、`/screenshot failed/i`、`/page text was still delivered/i`、仍带真实原因 `/activeTab/` |

两处改动都**没有放松断言**：原来"漏了某一层信息就会红"，现在照样会红（而且额外多了一条
"不许退回硬编码中文"）。`npm run check` → **exit 0**（58 条文案 × 2 语言、267 文件、34 个测试套件）。

### 7. 下一轮要定的机制：**面向模型的文案**

剩下两块中文都在**面向模型**的文本里，两者都**不能**走 `chrome.i18n` 的理由不同：

| 位置 | 汉字数 | 为什么不能照搬 |
|---|---|---|
| `dsh-plugin/src/host/tools.js` | 789 | 宿主进程**没有 `chrome.i18n`**（不是扩展环境） |
| `extension/src/sw/ops/index.js` | 179 | 它**在 SW 里、有 `chrome.i18n`**，但内容是 `browser_*` 的 `notes`，**模型读的**，不是用户读的 |

如果一边按浏览器语言切、另一边按插件配置切，模型会同时看到英文描述 + 中文备注。
所以这一条要**一个统一的机制**（候选：插件配置里的 `locale`，默认 `en`；SW 侧则固定英文，
因为它服务的是模型而不是用户）—— 下一轮定下来再动，**本轮不动**。

### 8. ★★ 英文版过程中的两处真事故（都是我自己造成的，都已修 + 加门禁）

#### 8.1 安装器的"卸载 → 重装"往返把用户的 `approvalForWriteOps: false` 悄悄丢了

**现象**：英文版做到一半去核对现场，发现 `/ag/control` 的 `approvalMode` 是 **`ask`**，
而这台部署在 2026-09-12 被用户**明确设成** `approvalForWriteOps: false`（无审批形态）。
本机会话审批策略是 `never` ⇒ 变回 `ask` 之后，写操作会被**当场拒绝**。

**根因**：`install.mjs` 第 8 步只写它自己管理的键（当时只有 `attachDir`）。
`uninstall --apply` 把整条挂载删掉（连着里面的 `approvalForWriteOps`），
重装时只写 `attachDir` ⇒ 用户的键**没有任何地方记得**。

**修法（不靠猜，靠显式传参）**：

| 改动 | 说明 |
|---|---|
| `buildMountConfig()`（`bootstrap/lib/profile-patch.mjs`） | 把"写哪些 config"变成**可单测的纯函数** |
| `--approval-for-write-ops <true\|false>` | 显式表达那个键；非法值直接拒绝（exit 2） |
| `--set key=value`（可重复） | 任意额外 config 键，值自动转 boolean/number/string |
| **新装 vs 老装** | 新装写 `attachDir: captures`（英文目录名）；**老装完全不写 `attachDir`** ⇒ 沿用插件默认的 `网页捕获`，**历史 `@网页捕获/…` 引用不失效** |
| dry-run 里如实列出来 | 计划区直接显示"已有安装/新装"与 `config = {…}`；只写自己管的键时还会提示"别的键用 `--set` 显式带上，我不会猜" |

**现场已修**：用 `node bootstrap/install.mjs --apply --yes --approval-for-write-ops false` 写回，
`/ag/control` 现在报 **`approvalMode: "off"`**（profile 的 `patchReload: live` 让它**无需重启就生效**）；
用户真实的抓取目录 `/Users/mac/ai_tools/dsh project/网页捕获`（16 个文件）**未受影响**。

**新增断言 12 条**（`tests/unit/profile-patch.test.mjs` §11–§12），含"托管块是整体替换语义"这条
（以前没写下来，容易误以为它会 merge 未知键）。

#### 8.2 发行清单漏了 `extension/_locales` ⇒ 装完的副本构建直接报错

**现象**：修完 8.1 重跑安装，第 6 步（构建扩展）失败：
`Error: ENOENT: no such file or directory, lstat '<install-dir>/extension/_locales'`。
安装器**当场停住并且没有写 DSH 挂载**（这正是第 3 条安全设计的价值），所以现场没被搞坏。

**根因**：英文版新增了 `extension/_locales/`，而 `installPayload()` 是一份**手维护**的清单，
忘了加它。当时的断言只**抽查了几个名字**，所以没咬到。

**修法**：清单补上 `extension/_locales` 与 `extension/i18n`；
并把断言换成**交叉核对** —— 从 `extension/build.mjs` 的源码里读出 `STATIC` 数组与 `ENTRIES` 的键，
逐个要求被清单覆盖（两个文件必须一致，以后再加构建输入忘了同步清单就会红）。

**咬合验证**：把 `extension/_locales` 从清单删掉 ⇒ **2 条断言变红**（`缺：_locales`）；还原后全绿。

### 9. 英文文档

- `README.en.md` —— README 的英文版（含 bootstrapper 快速开始、能力表、安全模型、已知限制）
- `docs/13-installation.md` —— 安装部署指南的英文版（十步说明 / 依赖为什么是链接 / API key / 排错 / 回滚）
- 中文版**保留**，并在两份中文文档顶部加了互链（`README.md` ↔ `README.en.md`、
  `docs/13-安装部署.md` ↔ `docs/13-installation.md`）

> 两份英文文档里的路径**故意写成 `<install-dir>` 这类占位** —— 它们给的是别人的机器看的。
> 是否把 `README.md` 换成英文版（GitHub 首页默认英文）等你定，那是一行的事。

### 10. ★ 面向模型的文案也做完了（`tools.js` + `ops/index.js`）

到这一步，**产品代码里已经没有面向用户、也没有面向模型的中文文案**。

| 位置 | 规模 | 机制 |
|---|---|---|
| `dsh-plugin/src/host/tools.js` | **76 处**文案（约 789 汉字） | 新增 `dsh-plugin/src/host/model-text.js`：**单文件即单源**（两语相邻，物理上无法漂移），75 个 key。语言由**插件配置 `locale`** 决定（`dsh-plugin/src/host/index.js` 加 `locale: config.locale ?? 'en'`），默认 **`en`**、可选 `zh_CN` |
| `extension/src/sw/ops/index.js` | 6 处 | **固定英文**（不切换）。理由：它服务的是**模型**而不是用户；而且 SW 拿不到宿主插件的配置，要切换就得再加跨进程协商。这条不对称已在此写明 |

**为什么 `tools.js` 不能照搬扩展那套**：宿主进程**没有 `chrome.i18n`**。所以自带一份表 + 一个
`resolveModelLocale()`（容错归一化：`en-US`→`en`、`zh-CN`/`zh`→`zh_CN`、未知值→默认 `en`）。

**结构性等价是被证明的，不是声明的**（改造只许换文案）：
用同一个 hub 桩分别构建旧/新工具定义，**递归剥掉所有 `description` 后比较 `parameters` + `output`**：

```
allowWrite=false: tools=5→5, schema（除 description）=== IDENTICAL
allowWrite=true : tools=8→8, schema（除 description）=== IDENTICAL
```

我另外做了一次**独立复核**（不依赖上面的探针）：对 HEAD 版与工作区版做结构指纹对比 ——
`type:35 required:6 additionalProperties:13 oneOf:2 name:8` **完全一致**。
中文逐字保留：从 HEAD 抽出的 **75 个非契约中文字面量 100% 作为子串出现在 zh_CN 表里**（missing=0）。

**顺带必须改的两个旧测试**（它们原来锁的是中文措辞，改完必红；**都没有放宽**）：

| 测试 | 改法 |
|---|---|
| `tests/unit/browser-tools.test.mjs` | 只把该处 `buildBrowserTools` 的 config 从 `{}` 钉成 `{ locale: 'zh_CN' }`；**断言一字未改**（该文件 33 条断言不变） |
| `tests/unit/op-debugger-optin.test.mjs` | ops 文案已固定英文 ⇒ 3 条断言改成同义英文匹配（`/browser control/i` + `/debug/i` 等），强度不变（13 条断言不变） |

**新门禁 `tests/unit/model-text.test.mjs`（36 条断言，已进 `test:unit`）**：两语都非空 / 两语必须不同 /
zh_CN 必须含汉字 / 双向核对 key（引用的都在表里、表里没有死 key）/ `tools.js` 里 0 处残留中文字面量 /
`resolveModelLocale` 各分支 / `t()` 占位与容错 / **接线断言：`config.locale` 真的决定工具文案**。
它自带**扫描器自检**（先证明"能咬"再去扫 `tools.js`），并显式复现了我在扩展侧踩过的那个坑：
**含引号的正则字面量**（`/Either the '<all_urls>' or 'activeTab'/`）会把"抽字符串字面量"的写法带偏成假阴性。

**咬合验证 3 处**（逐字输出见该轮记录）：① 塞回中文 description ⇒ 红；② 某 key 的 zh_CN 抄成英文 ⇒ 红；
③ 删掉仍被引用的 key ⇒ 红。每处还原后 `tools.js` / `model-text.js` 的 sha256 与改前**逐字相同**。

**一处显式窄豁免（先给理由，不是放宽）**：`'网页捕获'` 是**截图落盘目录名的数据契约默认值**
（`store.js` / attach / 抓取探针都依赖它），**不是文案**，故不建 key、不翻译；扫描残留前只把
**精确表达式** `config.attachDir ?? '网页捕获'` 换成占位符，并**另加一条断言"该表达式必须仍然存在"**，
免得窄豁免顺带盖住"契约被删"。同理 `'URL'` 两语同形、不含汉字，不进表。

**我独立复核的结论**（没有只信子代理的报告）：`npm run check` **exit 0**（271 文件、**35 个测试套件**、
构建 2 entry / 21 modules、`check:dist` OK）；结构指纹与 HEAD 一致；两个被改的旧测试断言条数不变
（33 / 13）且全绿。

### 11. ★ 真 Chrome 双语验证（新增 `probe:i18n`）

新增 `tests/m2/i18n-probe.mjs`（`npm run probe:i18n`），**不需要 DSH**：把 `extension/dist` 拷到无空格
路径、**把副本里的端口改到死端口**（这样面板连不上用户的真实 DSH，不往用户会话里插东西），
用 CDP `Extensions.loadUnpacked` 载入，打开面板页读**真实 DOM**，并与**源表**逐条比对。
**期望值取自 `extension/i18n/messages.source.json`，不写死在探针里** —— 否则改文案就得跟着改探针，
那是在测"探针与文案一致"，不是在测产品。

实测（2026-09-12，真 Chrome 150，界面语言 zh-CN）：

| 断言 | 结果 |
|---|---|
| 面板标签 == 源表 `attachPageLabel.zh_CN`（`Attach 网页`） | ✅ |
| 第二个按钮 / 重试按钮 同法 | ✅ |
| `title` 属性也被本地化 | ✅ |
| `<html lang>` == `zh-CN`（`applyI18n` 设的） | ✅ |
| 文档标题 == 源表 `extName.zh_CN` | ✅ |
| 错误文案（`errors.js` 用的 key）本地化 | ✅ |
| `manifest.default_locale` == `en` | ✅ |
| **`manifest.name` 由 Chrome 解析成本语言**（`DeepSeek 浏览器插件`） | ✅ |
| `manifest.description` 同样解析 | ✅ |

⇒ **`_locales` → `chrome.i18n` → `applyI18n` → DOM → manifest** 这整条真链路在真 Chrome 里是通的。

**★ 诚实边界（必须写下来）**：**macOS 上 Chrome 的界面语言改不动**。三种办法实测都无效：
① `--lang=en` 起来仍报 `zh-CN`；② 启动前预置 profile 的 `Local State`（`intl.app_locale`）——
首启被系统语言覆盖；③ "先跑一次建好 profile → 关掉 → 改 `Local State` → 再起"——**仍然** `zh-CN`。
所以本探针**只断言"Chrome 实际报的那种语言"那一侧的契约**，并把覆盖范围**打印出来**（本次 `zh_CN`）。
它能咬住的真问题：`default_locale` 写错、语言包没进 dist、`data-i18n` key 拼错、`applyI18n()` 没跑、
DOM 与文案表不一致 —— 这些在**任何一种**语言下都会红。**它不能自己覆盖另一种语言。**

**英文那一侧的真实观测**：本会话早先那次探针跑（在我修正期望绑定之前）里，有一轮 Chrome 恰好以
**英文界面**起来，实测到 `manifest.name = "DeepSeek Browser Companion"`、面板按钮 = `Attach page`、
`<html lang> = en`。那是一次**真实观测**（不是推断），只是不能用 `--lang` 稳定复现 ——
要稳定复现就把 Chrome 界面语言切到 English 再跑 `npm run probe:i18n`。

**探针第一版自己也有个真 bug（已修，值得记）**：它原来"只要 `#attach-page` 文本非空就跳出轮询"——
而 `panel.html` 里**本来就写着英文默认文案**（给 JS 没跑起来时兜底），于是第一次轮询就满足，
读到的是**静态 HTML**：DOM 看着是英文、`<html lang>` 还是 `en`，而同一页里 `chrome.i18n.getMessage`
明明是中文 —— 差一步就把"探针读太早"误报成"产品没本地化"。现在改用模块自己设的就绪标记
`globalThis.__AG_PANEL__`（`panel.js` 第 47 行，在 `applyI18n()` 第 20 行**之后**执行）
⇒ 见到它就意味着本地化已经填过了。

### 15. ★ 更接近真实的演练：**从"克隆出来的仓库"装机**

上一节的演练用的是**工作区**（有 `node_modules`）。远端拿到的是**从 GitHub 下载的干净副本**，
所以这轮直接 `git clone` 本仓库到 `/tmp`（= GitHub 上那份），从**克隆**里跑引导程序：

| 检查 | 结果 |
|---|---|
| 克隆里有 `node_modules` / `extension/dist` 吗 | **都没有**（正确：发行包只带源码） |
| 克隆里有语言包吗 | 只有 `extension/_locales/en` ✅ |
| `node bootstrap/install.mjs`（dry-run） | **exit 0** |
| `--apply --yes`（装到 scratch 目录） | **exit 0**，15 项源码复制、3 个依赖链接、构建 + `check:dist` OK、插件可加载自证 ✅ |
| **esbuild 的"下载"分支** | ✅ **首次真跑**：`added 2 packages in 2s`（此前本机一直是链接已有的，没走过这条路） |
| **全新安装的 `attachDir`** | ✅ `attachDir: captures`（英文目录名） |
| 扩展 ID | ✅ 未变 |
| scratch 产物 | `dist/_locales` 只有 `en`；`extension/node_modules/esbuild` 是真下载的目录（不是链接） |

跑完把**真实 Chrome 清单还原成与演练前逐字相同**，`doctor` 四条全绿，scratch 目录已清理。

**至此"远端才会走到"的三条只剩一条没验**：

1. ~~esbuild 下载分支~~ ✅ 本轮已验；
2. ~~全新安装 `attachDir: captures`~~ ✅ 本轮已验；
3. **`npm install -g @deepseek-ai/dsh@<版本>`（全局安装本身）仍未跑过** ——
   本轮只验到"**同一个包用 `--prefix` 装得动**"（522 包 / 59s，且装出来的树里三个依赖都在）。
   全局安装可能需要 sudo（取决于远端 node 怎么装的）；失败时引导程序会**停下并打印要跑的命令**，
   不会硬来。若远端真的卡在权限上，可以把第 3 步改成 `--prefix <安装目录>`（已验证可行），
   代价是要把 `<安装目录>/node_modules/.bin` 加进 PATH —— 否则 native host 的自动拉起会找不到 `dsh`。

### 14. ★★ 为"远端全新机器"演练抓到的一个真 bug：依赖提升布局认不出来

**背景**：用户计划在**远端 mac（10.0.0.1）**上从 GitHub 下载后做安装测试 —— 那是**全新机器**。
动手前先在本机把"只有远端才会走到"的两条路各自演练了一遍（都**不碰**本机全局环境）：

| 演练 | 做法 | 结果 |
|---|---|---|
| DSH 能不能按钉死的版本装上 | `npm install --prefix /tmp/wc-dsh-trial @deepseek-ai/dsh@0.1.5-rc.2` | ✅ 装上 0.1.5-rc.2（522 个包 / 59s） |
| esbuild 的**下载**分支（本机一直是链接本地的） | `npm install --prefix /tmp/wc-ext-trial esbuild@^0.25.0` | ✅ 0.25.12 |
| 依赖链接能不能认出新装的 DSH | 拿 `/tmp/wc-dsh-trial/node_modules/.bin/dsh` 跑 `findDshRoot` + `planPluginLinks` | ❌ **三个包全判成"缺"** |

**根因（真 bug）**：`planPluginLinks()` 原来只认一种布局 —— `<dshRoot>/node_modules/<pkg>`，
也就是"依赖**嵌在** dsh 包自己的 node_modules 里"。本机的**全局**安装恰好是这种，所以一直没暴露。
但 `npm install --prefix X` 会把依赖**提升**到 `X/node_modules/`，
于是 `<dshRoot>/node_modules/...` 根本不存在 ⇒ 三个包全判缺 ⇒ **一个符号链接都不建** ⇒
第 6.5 步自检失败。**远端走的正是这条路径**，也就是说：不演练的话，用户会在远端撞上它。

**修法**：按 Node 的查找顺序**逐层向上**找候选 `node_modules`（`candidateNodeModules()`），
取第一个真正存在的 —— 嵌套布局与提升布局都覆盖。两种布局都实测通过：

```
前缀安装（提升）: dshRoot=/private/tmp/wc-dsh-trial/node_modules/@deepseek-ai/dsh
  @deepseek-ai/dsh-tools=true, @deepseek-ai/dsh-credentials=true, ws=true
本机全局（嵌套）: dshRoot=/Users/mac/.hermes/node/lib/node_modules/@deepseek-ai/dsh
  @deepseek-ai/dsh-tools → .../dsh/node_modules/@deepseek-ai/dsh-tools  available=true
```

**回归**：`tests/unit/dsh-root.test.mjs` 新增一节（共 25 条断言），专门造出**提升布局**并断言
三个包可用、且 `target` 指向前缀的 `node_modules`；同时断言嵌套布局**仍**命中（别修坏另一种）。
**咬合验证**：把实现退回"只看 `dshRoot/node_modules`" ⇒ **2 条断言变红**。

`npm run check` → **exit 0**（35 个测试套件）。

### 13. ★★ 产品定位改定：**只发布 `en`，永远是英文版**（用户 2026-09-13）

用户指示：「用户的 chrome 设置成中文或者英文, 我们的插件都是英文版, 就可以」。

**这条把 §11 的验证难题一并解决了** —— 原来我在跟"macOS 上改不动 Chrome 界面语言"较劲，
其实**根本不需要**：Chrome 挑语言包的规则是"按浏览器界面语言找最匹配的，找不到就退到
`default_locale`"。所以**只要不发布 `zh_CN`**，无论用户的 Chrome 是中文还是英文，插件都必然是英文版。

改动：

| 位置 | 改动 |
|---|---|
| `extension/i18n/codegen.mjs` | 区分「**发布**的语言包」`SHIPPED_LOCALES = ['en']` 与「源表必须有哪几列」`REQUIRED_COLUMNS = ['en','zh_CN']`。**只生成 `_locales/en/`**；`zh_CN` 那一列留在源表里当**中文原稿/参考**，但永不生成、永不被 Chrome 选中 |
| `extension/_locales/zh_CN/` | **删除**（它存在就会被中文浏览器选中） |
| `extension/src/lib/i18n.js` | `<html lang>` 改为跟**实际渲染出来的语言**（`en`）走，而不是浏览器语言 —— 内容是什么语言就写什么语言，否则会误导读屏软件与浏览器翻译 |
| `README.md` / `README.en.md` / `docs/13-安装部署.md` / `docs/13-installation.md` | 各加一句"本插件是英文版，与浏览器界面语言无关" |

**门禁也跟着改了**（`tests/unit/i18n-messages.test.mjs`，37 条断言）：新增两条钉住这个机制 ——
★ `_locales` 下**只有一个语言包且是 `en`**；★ **不存在 `_locales/zh_CN`**。
把 zh_CN 加回去 ⇒ 立刻变红。

**★ 验证方式因此变得干净且更强**（`npm run probe:i18n`，14 条断言）：
本机 Chrome 的界面语言是 **`zh-CN`**（探针把观测值打印出来），
而探针断言"面板标签 / 按钮 / `title` / 文档标题 / 错误文案 / `manifest.name`+`description` **全部是英文**"：

```
★ 与浏览器界面语言无关：中文浏览器下也必须是英文
  ✅ 跑了 2 轮: true
  ✅ ★ 观测到的浏览器语言里有非英文的（实际：zh-CN, zh-CN）—— 这样"无关"才被真正验到
  ✅ ★ 所有轮次都显示英文（2 轮）: true
  ✅ ★ 所有轮次的 manifest 名称都是英文: true

  en（期望）: name="DeepSeek Browser Companion"  按钮="Attach page"
  实测(浏览器 zh-CN): name="DeepSeek Browser Companion"  按钮="Attach page"
```

⇒ **"中文浏览器 + 英文插件"这条被真 Chrome 实测钉住了**，§11 里那个"en 侧只有一次历史观测、
无法稳定复现"的口子就此关闭。

### 12. 英文版收口状态

| 项 | 状态 |
|---|---|
| 面向用户文案（manifest / panel.html / panel.js / errors.js / SW） | ✅ 全部抽取，`extension/src` 面向用户汉字 **0** |
| 面向模型文案（`tools.js` 76 处 + `ops/index.js` 6 处） | ✅ `locale` 配置（默认 en）+ 固定英文 |
| 单源文案 + codegen + 逐字节校验 | ✅ 扩展侧 58 条 × 2 语言；插件侧 75 条 × 2 语言 |
| 门禁接入 `test:unit` | ✅ `i18n-messages`(37) + `model-text`(36) |
| 咬合验证 | ✅ 扩展侧 4 处 + 插件侧 3 处 + 清单覆盖 1 处，全部实测变红后还原 |
| 英文文档 | ✅ `README.en.md` + `docs/13-installation.md`（中文版保留并互链） |
| 真 Chrome 验证 | ✅ zh_CN 侧完整通过（12 条断言）；**en 侧有真实观测但未能稳定复现**（见 §11 的边界） |
| 新装用英文抓取目录名 | ✅ 安装器对**新装**写 `attachDir: captures`；**老装不写**（沿用 `网页捕获`，历史引用不失效） |
| 上传 GitHub | ⏸ 等用户下令 |

---

## v3.42 — 2026-09-12（引导程序 / 去硬编码，已跑通真机）

**触发**：用户指令 —— 「这是典型的硬编码问题。我们要在这个版本，彻底检查，变成通过引导程序传入参数。」
外加两条约束：**发行包必须轻**（「依赖程序都是用引导程序下载, 并不在我们打包的安装程序里, 不然会很重」）；
**只考虑 macOS**（「用户的系统我们暂时不考虑 windows 系统」）。

### 1. 硬编码审计（全仓扫，结论分四类）

| # | 位置 | 性质 | 处置 |
|---|---|---|---|
| ① | `/Users/mac/ai_tools/dsh project/网页插件/native-host/run-host.sh` | **被 git 跟踪的生成物**，内容里焊着作者本机的 node 路径与仓库绝对路径 | 已从索引移除（`git rm --cached`，文件保留在磁盘上供 `install.mjs` 用）+ 写进 `.gitignore` |
| ② | `native-host/install.mjs:21` | Chrome 清单目录写死成 macOS 的 `~/Library/Application Support/...` | 由 `bootstrap/lib/layout.mjs` 的平台分支取代（darwin / linux 候选目录 / win32 注册表） |
| ③ | `/Users/mac/.dsh/profiles/web/cordis.patch.yml:68` | 插件挂载行是**手工**写的、指向下载目录的绝对路径（**用户抱怨的那一处**） | 由 `bootstrap/lib/profile-patch.mjs` 按参数幂等写入（本轮先做好机制，接线在下一轮） |
| ④ | `native-host/host.mjs:52`、`native-host/launcher.mjs:19`、`scripts/init-key.mjs:34` | 默认端口 3080 写死 | 都是"可被参数覆盖的默认值"，保留；但引导程序必须把用户真实端口显式传下去 |

### 2. 新增（本轮只做机制与门禁，尚未接进任何现有流程）

- `bootstrap/lib/layout.mjs`：**路径的唯一真源**。installDir / dshHome / homeDir / port / platform
  全部由参数推导；按**目标平台**选分隔符（能在 mac 上单测 win32 分支）。
- `bootstrap/lib/profile-patch.mjs`：profile 补丁层里我们那一条的幂等 upsert / remove。纯文本进出。
- `bootstrap/lib/credentials.mjs`：`.credentials.yaml` 的**定点**改写（只碰 `refs.<KEY>` 一行）。
- `bootstrap/lib/yaml-scalar.mjs`：YAML 标量渲染/解析（路径含空格必须加引号）。

### 3. ★ 三条新门禁（都已接进 `npm run check` 的 `test:unit` 链）

不接进链就等于没写 —— 这是本项目栽过的地方（"新单测文件必须加进 `test:unit`"）。

| 门禁 | 断言数 | 咬合验证（把毛病放回去，看它红不红） |
|---|---|---|
| `tests/unit/bootstrap-layout.test.mjs` | 60 | ✅ 实测：把 `native-host/install.mjs:21` 那行 macOS 写死路径放回 `bootstrap/lib/layout.mjs` ⇒ **exit 1**（`发现 1 处`）；把 `pluginEntry` 写死成绝对路径 ⇒ 「pluginEntry 跟着 installDir 变」**变红** |
| `tests/unit/profile-patch.test.mjs` | 61 | 夹具照用户**真实文件形状**（semble + codegraph + 本插件三段、含人类注释与空行）。断言：换参数写入后**行级 diff 只有 1 行**、别人的条目逐字节不动、连跑三次幂等、卸载后 round-trip 逐字节相等 |
| `tests/unit/credentials-write.test.mjs` | 36 | 断言改 key 时 `records` 段**逐字节不动**（那里住着签发 cookie 用的 `client-connection/browser-session`）、别的 key 不动、行数不变 |

`npm run check`：**exit 0**（20 条反模式规则 / 244 文件、协议 23 正 13 反、26 个单测文件、构建 136.9KB、`check:dist` OK、`check:repo-root` OK）。

### 4. ★ 推翻一条旧结论：esbuild 不是"未声明的依赖"

审计时先怀疑「`extension/build.mjs` 用了 esbuild 却没在依赖里声明」（根目录 `npm install` 后
`import.meta.resolve('esbuild')` 确实 **ERR_MODULE_NOT_FOUND**）。**查下去发现这是误判**：
本仓其实是**三个独立的 npm 包**，`extension/` 自带 `package.json`（devDeps: esbuild、typescript）
与自己的 `extension/node_modules/`，Node 从 `extension/build.mjs` 向上解析正好命中它。
⇒ 结论改为：**引导程序必须在 `dsh-plugin/` 与 `extension/` 两处各自 `npm install`**
（根目录那份只有测试/脚本用，用户装机不需要）。这条差异已写进
`npmInstallTargets()` 的注释与单测断言里。

### 5. ★ 安装器的一个真实雷：npm registry 的版本陷阱（实测 2026-09-12）

| 包 | npm `dist-tags` |
|---|---|
| `@deepseek-ai/dsh` | `latest: 0.1.5-rc.1`、`next: 0.1.5-rc.2`、`alpha: 0.1.5-alpha.2` |
| `@deepseek-ai/dsh-tools` | **`latest: 0.0.1-rc.1`（stub）**、`next: 0.1.5-rc.2` |

本机安装的是 `@deepseek-ai/dsh 0.1.2-rc.1`，而 `dsh-plugin/package.json` 钉的也是 `0.1.2-rc.1`。
⇒ 引导程序**不得**用 `latest` 装 DSH 或它的子包（会拿到 stub 或未验证的 0.1.5），必须钉版本并把
"用哪个版本"作为显式参数。

### 6. ★★ 推翻第 5 条的处置方式：依赖应该**链接**，不是下载（读现场得出）

上面的"钉版本然后 npm install"**实测行不通**：在插件目录里执行
`npm install @deepseek-ai/dsh-tools@0.1.5-rc.2` **必然失败**：
```
npm error ERESOLVE could not resolve
npm error Conflicting peer dependency: @deepseek-ai/dsh-llm@0.1.5-rc.2
```
因为 `dsh-tools` peer 依赖 `dsh-llm` / `cordis` / `dsh-agent` / `dsh-scope` / `dsh-session` /
`dsh-user-approval` / `dsh-system-prompt` / `dsh-invariants` / `dsh-code-runtime` 共 9 个包，
单独装一个子包满足不了它们。

**改去读"工作正常的现场"**，发现真相：`dsh-plugin/node_modules/` 里**根本没有真实安装**任何包，
而是三个符号链接指向**用户那份 DSH 自带**的子包（2026-09-11 12:37 建的）：
```
@deepseek-ai/dsh-tools       -> <DSH 根>/node_modules/@deepseek-ai/dsh-tools
@deepseek-ai/dsh-credentials -> <DSH 根>/node_modules/@deepseek-ai/dsh-credentials
ws                           -> <DSH 根>/node_modules/ws
```
一条路线解决四个问题：**版本永远一致**（DSH 升级插件自动跟随 —— 这也解释了为什么
用户把 DSH 从 0.1.2-rc.1 升到 0.1.5-rc.2 后插件**什么都没做就正常**）、**不用下载**（符合轻量约束）、
**绕开 peer 地狱**（DSH 的树里 peer 天然齐全）、**升级 DSH 不必重装插件**。

⇒ `bootstrap/lib/dsh-root.mjs` 实现之：`findDshRoot()`（跟着 `dsh` 的两层符号链接向上找
`@deepseek-ai/dsh` 的包根）+ `planPluginLinks()` + `applyPluginLinks()`（先清空再链接，幂等）。
只有 `esbuild`（构建扩展用）**不在** DSH 里，那一个才需要下载；本机已有则直接链接。

### 7. ★★★ 引导程序自己踩出来的真实事故：**扩展 ID 被悄悄换掉**

**现象**：第一次真机 `--apply` 之后核对，发现 Chrome 清单的 `allowed_origins` 变成了
`chrome-extension://coceclkaehnmkjkboghilkkkolmjcial`，而用户 Chrome 里装着的扩展是
`idpgkobbblmpmnonlndopijgfmehfmig` —— **配对文件里的 `extensionOrigins` 也跟着变了**，
意味着用户原本能用的插件当场失效。

**根因**：`scripts/init-key.mjs` 原来只有两条路 ——「`scripts/.dev-extension-key.json` 存在就用它」
与「生成一对新的」。而那是**私钥材料、被 gitignore**，引导程序复制源码时**正确地没有带上它**
⇒ init-key 就在安装目录里**生成了一对新密钥** ⇒ 公钥变 ⇒ ID 变。与"发行包要轻、不带密钥材料"
这条正确的约束**直接冲突**，冲突点却落在 ID 上。

**修法**（`scripts/init-key.mjs`）：没有私钥文件时，**先沿用 `extension/manifest.json` 里已钉的公钥**
（私钥只有打 `.crx` 才用得上，本项目不需要）。三种情形因此都对：
迁移已有部署 → 沿用老 ID；全新 clone → 沿用被提交的那份公钥（项目故意钉的）；两者都没有 → 才生成新的。

**防复发（两道）**：
1. 引导程序新增守卫：读部署前配对文件里的 ID 作为基准，第 5 步之后**断言 ID 未变**，
   变了就**当场停住、不写 DSH 挂载**，并打印配对文件备份的回滚命令；
2. `tests/unit/init-key-preserves-id.test.mjs`（17 断言）在假仓库里真跑一遍 init-key。
   **咬合验证**：把"沿用 manifest 公钥"那段删掉（退回无条件生成）⇒ **6 条断言变红**（exit 1）。

**事故现场已修复**：用仓库里的 init-key 重跑一次把配对文件写回原 ID，清掉装坏的目录，
用修好的引导程序重装。现四处 ID 完全一致（配对文件 / Chrome 清单 / 安装目录 manifest /
用户实际在用的扩展）。

### 8. 真机实跑结果（2026-09-12，macOS，DSH 0.1.5-rc.2）

| 场景 | 结果 |
|---|---|
| `node bootstrap/install.mjs`（默认 dry-run） | exit 0；打印 10 步计划 + 体检表；**与前后快照逐字节比对：零改动** |
| `node bootstrap/install.mjs --apply --yes` | exit 0。链接 3 个包（**零下载**）、复用本机 esbuild、init-key、构建 dist（port=3080）、`check:dist` OK、**插件可加载自证通过**、写 native host 清单、写 profile 挂载、API key 跳过（非交互） |
| 再跑一次（幂等） | exit 0；挂载报「内容已是目标状态（无需改动）」；备份与现文件逐字节相同 |
| `node bootstrap/uninstall.mjs`（dry-run） | exit 0；正确列出"将摘掉挂载/删清单/删目录"，**配对钥匙与 API key 默认保留**；**零改动** |
| **卸载 → 重装 全往返**（第二轮补跑，卸/装的**写路径**都真跑过） | 卸载后实测：挂载条目 0 条、Chrome 清单已删、安装目录已删，而**配对钥匙仍在**、**`.credentials.yaml` md5 未变**、**semble/codegraph 两条别人的条目仍在**（2/2）；随即重装 exit 0，`扩展 ID 未变`。往返前后状态快照**逐字节一致** |

**安全设计（都实到位）**：关键步骤失败即**当场停**且**不碰 DSH 挂载**（避免把"装到一半"
变成"原来的也不能用"）；挂载前先 `import()` 自证安装目录里的插件能解析依赖；
非交互环境**绝不阻塞、绝不自作主张**（`--yes` 才批量同意，否则一律按"否"）；
`--dry-run` 是**默认**。

### 9. 安全清理与新增门禁

- `extension/package.json`：删掉 `typescript` devDependency。依据：**全仓没有任何 `.ts` 源文件**
  （ADR-2 已记载"实际是纯 JS + esbuild"），它从未被使用，却会让每次安装多下 20MB+。
- `scripts/check-dist-config.mjs`：基准配对文件改为尊重 `DSH_HOME`（原来写死 `~/.dsh`，
  自定义 DSH_HOME 的安装会拿错基准）。
- 新增单测 6 个（共 **239 条断言**），全部已接进 `test:unit` 链：
  `bootstrap-layout`(60) / `profile-patch`(61) / `credentials-write`(36) / `dsh-root`(21) /
  `preflight-checks`(44) / `init-key-preserves-id`(17)。
- `npm run check`：**exit 0**（20 条反模式规则 / 255 文件、**29 个单测文件**、构建、`check:dist`、`check:repo-root`）。

### 10. ★ 改正一处**假红**：把 `connectedClients` 当成"扩展已连上"

第一版的健康复检里有一条写的是「扩展已连上桥接」，判据是 `/ag/ping` 的 `connectedClients > 0`。
查 `dsh-plugin/src/host/index.js:327` 发现那是 **`hub.clientCount` —— DSH 页面半（client 半）的连接数，
不是扩展**。于是用户**没开侧边栏**时这条会报红，而扩展其实好好的（假红）。

本项目的验收口味是"不许假绿，也不许假红"，所以本轮把判定抽成 `bootstrap/lib/health.mjs` 并改口径：

| 判据 | 类型 | 依据 |
|---|---|---|
| DSH 在端口应答 | 硬 | `ping.reachable` |
| 插件已加载并配对 | 硬 | `ping.paired` |
| 扩展产物端口 == 配对端口 | 硬 | `check-dist-config` 退出码 |
| 扩展连通 | **软（代理判据）** | `connectedClients > 0` ⇒ "侧边栏开着" |

软判据**不参与总判定**，如实写明它是代理判据、并给出"打开侧边栏再查一次"的下一步
（引导程序里最多重查 3 次）。**要变成真判据需要给 `/ag/ping` 加字段**
（例如 `agentClients: () => hub.agentCount`）—— 那会动协议 schema（`ping` 有正向量、帧是闭集），
**本轮故意不做**，在此记明。

### 11. 新增 `doctor`：随时自查（与第 11 步共用同一段逻辑）

`node bootstrap/doctor.mjs`（或 `npm run doctor`），支持 `--json` 便于贴 issue。
单独做成命令的三个理由：用户**任何时候**都可能要它；它与引导程序第 11 步共用
`health.mjs#probeHealth`，**不会出现"装的时候这么判、自查的时候那么判"**；它不阻塞、不需要 TTY，
所以可自动化。实跑（2026-09-12，本机）：

```
✅ DSH 在本机 3080 端口应答 —— 是
✅ 插件已加载并配对（/ag/ping → paired） —— 是
✅ 扩展产物端口 == 真实配对端口 —— 一致
⚠️  扩展连通（代理判据：侧边栏里的 DSH 页面半） —— 现在没有页面半连着 —— 打开侧边栏后应当 >0
      ↳ 点浏览器工具栏里的本扩展图标打开侧边栏，然后回这里再查一次。（注意：本程序看不到"扩展装没装"，只能看它有没有连上来。）
✅ 硬判据全过。      （退出码 0）
```

### 12. 面向用户的安装文档

- 新增 `docs/13-安装部署.md`：一分钟版 / 装完得到什么 / 前置条件 / 十步各动哪些文件 /
  **依赖为什么是链接不是下载** / API key 怎么弄 / Chrome 扩展怎么装 / `doctor` 怎么用 /
  卸载 / 排错表 / 安全与回滚。
  ⚠️ 该文档里的路径**故意写成 `<安装目录>` 这类占位**（它是给别人的机器看的）——
  硬编码绝对路径正是本次要消灭的东西；与仓库内交接文档写 `/Users/mac/…` 的口径不同，已在该文档开头写明。
- `README.md` 的「快速开始」改为**引导程序三条命令**，原来的手工七步收进 `<details>` 作为开发期路径；
  新增 `docs/13` 到「相关文档」。
- `package.json` 新增脚本：`bootstrap` / `bootstrap:apply` / `doctor` / `uninstall`。
- 新增单测 `tests/unit/install-health.test.mjs`（**45 条断言**：判定、渲染、软判据不参与总判定、
  以及 `probeHealth` 的 I/O 编排），已接进 `test:unit`。

`npm run check`：**exit 0**（20 条反模式规则 / **259 文件**、**30 个单测文件**、构建、`check:dist`、
`check:repo-root`）；`npm run graph:check` OK（52 文档 / 209 代码文件，无断链）。

### 12.1 本轮**仍未做/未验**的（诚实清单）

1. **交互式重查循环没在真 TTY 里被人跑过**（★ 本条的**归因已被本轮推翻**，见 §13）：
   上一轮我把"用 `script` 造 pty 时卡在 API key 提示"归因于"pty 把输入丢了"。
   本轮先做假设验证再动手，**真因是我自己代码的 bug**（`secret()` 结尾 `pause()` 没人 resume）。
   该 bug 已修，交互层现有 **32 条**假 TTY 断言覆盖（含 `secret → pause → confirm` 的真实顺序）。
   仍建议由**一个人在真终端里**走一遍 —— 理由从"可能挂"变成"覆盖真终端的 raw mode / Ctrl-C / 粘贴行为"。
2. **`dsh web` 尚未重启**：现在这个进程仍按**旧**挂载（指向仓库）在跑；重启后才会从
   `<安装目录>` 加载，那才是"去硬编码"真正生效的时刻。
3. 只支持 macOS（用户明确"暂时不考虑 windows"）；Linux 分支已写但**未实测**。

### 13. ★★★ 又抓到一个"会让用户挂死"的真缺陷：粘贴 API key 之后，下一步永久挂起

**这是本轮最有价值的产出，而且它推翻了上一轮的一个归因。**

**上一轮的归因（错的）**：用 `script` 造 pty 跑引导程序时卡在 API key 提示，我判断是"pty 把输入丢了"。

**本轮先做假设验证，再动手**：写了个最小复现（`PassThrough` + `isTTY=true` 当假 stdin）：

```
1) secret → sk-SECRETVALUE         ← 能读到，且不回显（假设"readline 会吃掉输入"被证伪）
   （secret 之后 stdin.isPaused() = true ）
2) pause  → TIMEOUT：pause 挂住了   ← 真因在这里
```

**根因**：`bootstrap/lib/wizard.mjs` 的 `secret()` 结尾调了 `stdin.pause()`，而**没有任何地方会再 resume**。
readline 的 `Interface` 是在构造时就挂在同一个 stdin 上的，后续 `confirm()` / `pause()` 全靠它收数据
⇒ **用户一旦粘贴过 API key，紧接着第 10 步那句"装好了按回车继续"就永久挂住**
（不报错、不退出、没有超时 —— 对用户来说就是"卡死了"）。

**修法**：`secret()` 收尾改为 `stdin.resume()`（保留 `setRawMode(false)`），并写清为什么不能 pause。

**回归**：新增 `tests/unit/wizard-interaction.test.mjs`（**32 条断言**，用假 TTY 驱动，不需要真终端）：
confirm 默认 No / `--yes` 语义 / 非交互**绝不阻塞** / secret 不回显且退格可用 /
★ `secret → pause → confirm` 的真实顺序 / close 幂等。
**咬合验证**：把 `resume` 改回 `pause` ⇒ **3 条断言变红**。

**这个测试还端出了两条设计约束**（都是踩出来的）：
1. **任何等待超时都必须变成一条变红的断言，而不是让测试进程崩掉/挂住** ——
   第一版超时就 `reject` 出去，直接把整个测试进程打崩；现在超时返回哨兵，断言自然为假。
   本项目吃过"假绿"的亏（2026-09-12 §1 的截图假绿），也不该吃"假挂"的亏。
2. **`--yes` 不等于"什么都别问"**：是非题（要不要装）不问；但"粘贴 key"是**要内容**的提问，
   仍会正常提问、回车表示跳过。第一版断言"`--yes` 下 secret 立刻返回"是错的。

**顺带确认没伤到用户数据**：整轮验证期间
`~/.dsh/.credentials.yaml` 的 md5 始终是 `2d811f8f0c6e6aea5136ca89a3ae3d50`，
且没有产生 `.bak-before-apikey`（说明 API key 那一步**从未被真的写过**）。

**★ 修完之后在真 TTY 里跑通了整条交互路径**（这次输入**在提示出现之后**才喂进去，
不再有"输入早到被丢弃"的干扰）：

```
▶ 第 9 步 · 写入 DeepSeek API key        ? 粘贴 API key（留空跳过）: → 已跳过
▶ 第 10 步 · 在 Chrome 里加载扩展        … 装完了吗？（装好了按回车继续）→ 继续   ← 修之前这里永久挂住
▶ 第 11 步 · 复检                        ✅ DSH 应答 / ✅ 已配对 / ✅ 产物端口一致 / ⚠️ 扩展连通（软判据）
                                         ? 打开侧边栏后再查一次？→ 重查（共 3 次）
════════════════════════════════════════
 ✅ 装好了，硬判据全过（DSH 应答 / 已配对 / 产物端口一致）
 💡 那条 ⚠️ 是软判据：打开侧边栏后它会变 ✅
```

退出码 0；跑完复核：挂载仍指向安装目录、扩展 ID 未变、`doctor` exit 0、
`.credentials.yaml` md5 未变。**§12.1 第 1 条那道"只有真人能验"的口子，至此由真 TTY 补上了。**

### 14. ★★ 端到端证明：**真实的 DSH 进程能从安装目录加载插件**（去硬编码的最终验收）

第 6.5 步只证明了"安装目录里的插件能被 `import()`、依赖解析得开"。但用户重启 `dsh web` 时
真正发生的是另一件事：**DSH 按 profile 里的挂载行去加载它、跑 `apply()`、注册 `/ag/*` 路由**。
两者之间还隔着 DSH 的插件加载契约 / `inject` 声明 / 路由注册，所以单独证一次：

造一个**临时 DSH_HOME**（`/tmp/wc-loadtest-home`，用随机假 key，不碰用户真 key），
只放 profile 骨架 + **一行指向安装目录的挂载**：

```yaml
- insert:
    - id: dsh-web-companion-bridge
      name: '/Users/mac/.dsh/plugins/dsh-web-companion/dsh-plugin/src/host/index.js'
```

然后 `DSH_HOME=/tmp/wc-loadtest-home dsh web --no-open --port 3097`：

```
✅ 真 DSH 进程从**安装目录**加载了插件，并在 3097 上应答：
     plugin: dsh-web-companion-bridge
     paired: true
     protocolVersion: 1
     capabilities: 5 个
收尾：端口 3097 上还剩 0 个监听；临时 home 已删
```

全程不碰用户的 3080 与真实 `~/.dsh`。**这就是用户重启之后 3080 上会发生的事** ——
挂载行不再指向"下载下来的那份目录"，而是稳定的安装目录。

> 过程小记（值得记一笔的坑）：临时脚本里有一行 `echo "... port=$PORT）..."`
> —— 中文全角右括号紧跟变量名，bash 会把多字节字符也算进变量名 ⇒ `set -u` 报
> `PORT）: unbound variable`。**变量后面紧跟中文时一律写 `${VAR}`**。
> 这是本仓中文注释/中文输出很多的情况下很容易再踩的一次。

---

## v3.41 — 2026-09-12

**触发**：v3.40 收尾时列出的「P1 剩余项」按顺序做完（截图假绿 → 积压补投 → `perf` 判定 → `CHIP_LABEL_MAX` 注释），再进 P2。用户指令：**不停下来汇报，按 P0 剩余 → 重跑探针 → P1 → P2 持续做完**，且**不许过度设计**。

### 1. P1：`mode:'screenshot'` 抓不到图却回 `ok:true`（假绿）

| 项 | 问题 | 修法 | 回归 |
|---|---|---|---|
| 截图模式假绿 | `captureVisibleTab` 失败（没有 `<all_urls>` 权限、标签页不在前台、体积超限）时，`buildCapture` 把 `{dropped:true, dropReason}` 写进 body 照常投递，而 `sw/index.js` 只看 `sendCapture` 的结果就回 `ok:true`：面板显示「已附加」、审计记 `ok:true`，而**用户唯一要的那个产物（图）根本不存在**（`base64` 是空串，图片文件压根没写） | 新增纯函数 `capture.js#shotProblem(body)`（只在 `mode==='screenshot'` 时判定，因为那正是"要的就是图"的模式），SW 入口据此把**结果**判失败并把原因说清（「截图没成功，正文已照常投递：…」）；两份 `dropped` 对象补上机器可读的 `code`（`E_TOO_LARGE` / 传播真实错误码） | `tests/unit/screenshot-mode.test.mjs`（22 断言，**跑到 SW 入口的 `route()`** 而不是只测那个纯函数；退回旧行为 ⇒ **10 条变红**） |

补两个"修过头"防线（同测试内）：`mode:'page'` 的截图失败**不许**影响正文抓取的结论；真拿到图时**必须** `ok:true` 且 body 里带非空 base64。

> 说明：`includeScreenshot` 参数目前**只有 SW 内部**会传（`mode==='screenshot'` 派生），全仓无第二个调用者，所以判据取 `mode` 已覆盖所有真实路径。

### 2. P1：积压抓取补投（队列此前是**只写**的）

**缺陷**（台账 §5 第 11 项，v3.38 查出）：`attachRoute` 在无页面半连接时 `store.enqueue()` 并如实回 `deliveredTo: []`；而 client 半**每次连上都会发** `{type:'request-pending'}`（设计 §4.2），**host 侧没有这个帧的 handler**，唯一能 `drain()` 的 `GET /ag/pending` **全仓无调用者**。于是"没开 DSH 页面时抓的东西"落盘、入队、然后永远躺在内存队列里（上限 32，超了静默丢最旧）。用户看到的现象就是"抓了，但什么都没发生"。

**修法**：

- `onClientFrame` 收下 `request-pending` → `deliverPending(entry)`；
- 投递复用与实时 attach **同一个原语** `hub.pushClientPrimary(item, owner)`：owner 记着的（「看左边」那条链）必须回到当初发起它的页面半，否则 `sessionMode:'current'` 会插进**另一个页面半**的会话；没有 owner 时投给**提问的那个半**；
- **投不出去就放回队列**（`store.enqueue(item)`）—— 只 drain 不管的死法是本次要修的 bug，不能顺手再引入一次；
- 审计新增 `kind:'pending-replay'`（`queued`/`delivered`/`requeued` 三个计数已加进 `AUDIT_FIELDS`）。

| 验证 | 内容 |
|---|---|
| 真机路径 | `tests/m0b/attach-probe.mjs` **第 7 节（新）**：离线 attach（`deliveredTo: []`）→ peek 里找得到 → 页面半连上并 `request-pending` → **真的收到那条 attach**、`fileRef` 可引用、再要一次不会重复推、队列里已经没有了。退回旧行为 ⇒ **5 条变红**（观测里能看到 `pendingAfterReplay: ["M0B-PROBE-PENDING"]`，队列里那条就是"永远投不出去"的实证） |
| 探针够不到的那一支 | `tests/unit/pending-delivery.test.mjs`（16 断言，真 hub + 真队列）：投不出去时**抓取仍在队列里**、owner 优先于默认胜者、无 owner 时投给提问方、空队列不写噪音审计。去掉"放回队列" ⇒ **3 条变红** |

### 3. 顺带修掉的真缺陷：413 之后的下一个请求必踩 `ECONNRESET`

写第 7 节时探针**当场崩了**（`TypeError: fetch failed … ECONNRESET`，位置正好是 413 之后的那次 `GET /ag/pending`）。实测复现并定位：

```
1 oversize POST OK 413          ← 请求体 9MB，超 attachMaxBytes
2 immediate peek FAIL ECONNRESET ← 同一个连接池里的下一条请求
3 再来一次 OK                    ← 新连接，正常
```

`readBody` 在超限时是**故意不读完**请求体的（这正是 413 的意义），socket 上还有未读数据 ⇒ Node 必须销毁它；但响应头写的是 `connection: keep-alive` **外加** `keep-alive: timeout=5` —— **在撒谎**。客户端于是把这条死连接放回池子，下一条请求直接撞上 reset。

**修法**：`attachRoute` 的 413 分支显式回 `connection: close`（400/E_PAYLOAD 那种"读完才失败"的路径不关，它本来就能复用）。**回归**：`attach-probe` 新增断言「oversize 的 413 如实声明 `connection: close`」；退回旧行为 ⇒ 该断言变红，且 `1→2→3` 那段实测复现 reset。

### 4. P1：`perf` 判定改造（G1 不再是"能悄悄变红的墙"）

`tests/m2/perf-probe.mjs` 原先三个指标一起进退出码，而 **G1（热启动 p50）本就是浮动基线**（实测 2090–2956ms，用户已接受 2.1–2.7s、文档目标 ≤2.8s）。它的抖动会周期性把整条探针判红，制造"狼来了"，而红的那次并不代表回归。

- `G1_HOT_TARGET = 2800`：**记为基线、不参与退出码**，超线时打印 `G1 p50 … 超 … —— 基线指标，不影响退出码`；
- G2 / G6 仍是**硬门禁**（体积、开关生效），并且 G6 判定与文案统一引用常量 `G6_LIMIT`（此前是"判 1KB 却印 1024KB"式的自相矛盾）；`build-size.json` 缺 `totalBytes`/`totalKb` 时直接抛，不再被当成 0 混过去。
- **咬合验证**（实测）：G2/G6 仍能把退出码打成 1 —— 例如把 `G6_LIMIT` 临时改成 1 时 `PERF_EXIT(应=1): 1`（随后还原），G1 超线只影响打印。

### 5. P2：协议收紧 + 单一真源 + 口径统一

| 项 | 问题（逐字） | 修法 | 回归 |
|---|---|---|---|
| `error.code` 不是闭集 | `CaptureResultEvent` / `AgentToolResult` 的 `error.code` 是 `{"type":"string"}` ⇒ 任何字符串都过关 | 改成 `$ref: #/$defs/ErrorCode`（与 `ErrorEnvelope` 一致） | `protocol/vectors/invalid/capture-result-unknown-error-code.json` |
| **枚举漏掉 5 个真实在用的码** | 代码里用了 `E_NO_SELECTION` / `E_READONLY` / `E_TARGET_BUSY` / `E_PERMISSION` / `E_PLUGIN`，枚举里都没有；光收紧 schema 会让这些帧**整帧被判非法并被宿主丢弃**（`capture-result` 被丢 ⇒ 意图与抓取失联、attach 落错页面半） | 枚举补齐（19 个）+ `docs/01 §2.6` 表补全（含每个码的 HTTP 状态与修法）；`E_WS` 是面板本地状态串，**不进协议**，在门禁里显式登记为 local-only | 新增 `tests/unit/protocol-error-codes.test.mjs`（11 断言）：扫 44 个源文件里的 `'E_…'` 字面量逐个核对闭集、三端枚举一致、文档不许漏码、集合外的码必须被拒 |
| `captureId` 该必填 | 成功的 `capture-result` 缺 `captureId` ⇒ 宿主拿不到 `requestId→captureId` 关联，owner 链断掉；但失败帧**本来就没有** id，无条件 `required` 会把合法失败帧一起判非法 | 校验器补 `if/then/else` 支持，schema 写 `if ok:true → then required: [captureId]` | `protocol/vectors/invalid/capture-result-success-without-captureid.json` + 正向失败帧向量 |
| **顺手抓到的潜伏 bug** | 校验器里 `required` 只在 `properties`/`additionalProperties` 同时存在时才被检查 ⇒ **只有 `required` 的子模式等于什么都没查**（新写的 if/then 规则就是这样"看着生效、其实放行"的） | 判定条件补上 `schema.required !== undefined` | 就是上面那条反向量：修之前它**意外通过**，修之后被拒 |
| 扩展侧可能发出集合外的码 | 捕获失败时 `error.code` 直接透传被抛错误的 `code`，抛出的东西可能是 DOM/chrome 的错误对象 | 面板侧新增 `wireCode()`：不在闭集里一律降级 `E_INTERNAL`（宁可码粗一点，也不能让整帧被丢） | 由 `protocol-error-codes` 门禁 + 三处发送点共用同一个归一化函数 |
| 路由靠字符串替换拼 | `/ag/wsecho`、`/ag/wsprobe` 由 `ROUTE.whoami.replace('/whoami','/wsecho')` 得到：哪天把 `whoami` 改个名，两条升级处理器会**注册到同一个路径**（后者静默盖掉前者），而不是报错 | 把两条路由进 `codegen.mjs` 的 ROUTE 表（代码生成物的一部分），注册点直接用 `ROUTE.wsEcho` / `ROUTE.wsProbe` | `tests/protocol/contract.test.mjs`（三端路由一致）+ `node protocol/codegen.mjs --check` |
| `stamp` 两处实现 | `store.js#stamp` 与 `tools.js#stampOf` 各写一份 `yyyy-MM-dd-HHmm`：文件名约定改一处就会只改一半 | `tools.js` 改为复用 `store.js#stamp`（保留旧导出名，避免调用方跟着改） | `tests/unit/browser-tools.test.mjs`（31 断言，含截图落盘） |
| "常量漂移"查证 | ①`3080` 在产品代码里只出现在 `extension/src/lib/dev-config.js`（真实配对文件的镜像），其余是测试/文档夹具；真正真源是 `~/.dsh/dsh-web-companion.json`，已由 `check-dist-config` 门禁盯着 ②`keepLines` 1200（插件审计）vs 800（native host 日志）是**两个不同文件**的轮转，且 `docs/12` 已按 1200 记档 | **不改**。如实记进本表：这条是从评审清单里带过来的假设，核对后不成立；为了"显得在做工"而硬统一两处跨包常量反而是耦合 | — |
| `paired` 同词两义 | `/ag/ping`：`key && extensionOrigins>0`；`/ag/wsprobe`：只看 `key`。而面板、`probe-all`、4 个探针、`docs/09`、`docs/12` 都拿 `paired===true` 当"这套安装可用"的判据 —— 有 key 没登记扩展 origin 的安装，一个端点说配对、另一个说没配对，谁读到哪个算哪个 | 判据收进 `key-store.js#isPaired`（唯一实现），两端点都引用；诊断函数抽成纯函数 `wsProbeDiagnostic()` 以便测试 | 新增 `tests/unit/pairing-semantics.test.mjs`（20 断言，**跨端点**断言两边 verdict 相同 + `keyConfigured` 仍如实） |
| `/ag/ping` 会把诊断路由打成 500 | 状态对象没有 `liveTickets`/`connectedClients` 探针时，payload 里留下 `liveTickets: undefined` 这样的键，而校验器把"键在、值为 undefined"判为类型错误 ⇒ 一条本该解释安装状态的诊断路由回 `E_INTERNAL` | 改为"没有就不写这个键"（`...(fn ? {k: fn()} : {})`） | 同上（测试用最小 state 驱动真实 `pingRoute`，修之前 12 条红） |
| `pimoa-review` 的裁决永远是 `unknown` | 真实 PiMoa 回答是「Markdown + 围栏 JSON receipt」，而驱动用 `JSON.parse(block.text)` 取 `structured` ⇒ 必然抛 ⇒ **每一份** review 都写着 `裁决（status）：unknown`；同时 `quorum` / `proposerMarks` / 聚合模型 / 耗时全被丢掉。核对真实 receipt（`~/.pimoa/spool`）：**根本没有 `status` 字段** | 新增 `scripts/pimoa-result.mjs`（纯函数：`receiptOf`/`bodyOf`/`describeReceipt`/`summaryLine`）：读围栏 JSON、正文剥离、如实摊开 quorum 与逐模型标记，并明说"receipt 里没有 status，这里不编一个" | 新增 `tests/unit/pimoa-result.test.mjs`（22 断言）+ `tests/unit/pimoa-driver.test.mjs`（16 断言：本地假 MCP 端到端跑完驱动，断言报告里**没有** unknown、quorum 被点出、会话 id 有带上） |
| `pimoa-review` 撞 300s 墙 | 用 `fetch` 调 MCP ⇒ undici 默认 300s body 超时；实测成功耗时 189–309s **正贴这道墙**，更慢的审核会在厂商已经出结果后报 `TypeError: fetch failed` | 改用 `node:http`（无该默认值），`--timeout-ms` 成为唯一的钟；超时也给出可读原因 | 上面的 driver 集成测试 |
| 审批策略 `never` 甩锅（台账 §5-12） | `approval.js#modeOf` 只问"审批服务在不在"，不看策略 ⇒ 面板承诺"每次都会先问你"，而 `dsh-user-approval` 在 `policy:'never'` 下 `decide()` 在问任何人之前就 `return 'rejected'`，模型收到 `the user rejected tool "browser_click"` —— **没有人被问过** | 新增 `policyOf(agent)`（按**本次调用**所属会话读 `effectivePolicy`，拿不到会话退到配置默认）；`mode` 多一个真实取值 `policy-never`；写调用在 `never` 下**当场拒绝**且理由是策略（不是"用户拒绝"）；面板文案按策略分支；顺带把 control 审计里塞进 `errorCode` 的 mode 挪到 `status` | `tests/unit/write-gate.test.mjs` 扩到 33 断言，含"另一个被改回 ask 的会话仍要能问"（这是第一版修法的真 bug：它按无会话的 mode 判定，会把那个会话的写操作**静默放行**）与"理由不许甩锅给用户" |

### 6. 门禁自身的接线（新增测试必须真的进 `npm run check`）

`test:unit` 是一条**显式列举**的 `&&` 链：新写的单测文件如果不加进去，`npm run check` 根本不会跑到它 —— 那就是门禁层面的假绿。本轮 6 个新文件（`screenshot-mode`、`pending-delivery`、`protocol-error-codes`、`pairing-semantics`、`pimoa-result`、`pimoa-driver`）已全部接入（17 → **23** 个文件）。

### 7. 本轮验证（如实，全部在**收紧之后**的判定下取得）

```
npm run check        → exit 0
   反模式规则 20 条 / 235 文件；单测 23 个文件全绿；codegen --check 一致（schema 608a16de9b9d…）
   协议契约：正向量 23 / 反向量 13 / 三端产物 3 一致
   build:ext：136.7 KB（G6 判据 ≤1024KB 通过）；dist-config: OK（port=3080，且与真实配对文件一致）

npm run probe:all    → exit 0，8/8
   m3-debugger ✅43s  look-left ✅5s  capture ✅48s  sites ✅54s
   m3-ops ✅53s  m3-control ✅23s  look-left-e2e ✅28s  agent-turn（真模型回合）✅69s

npm run probe:attach → exit 0（12 断言 / 18 观测；新增第 7 节积压补投 + 413 的 connection: close）
npm run probe:chip   → exit 0（3 断言 / 12 观测）
```

> 上面这份汇总取自**全部改动落地之后**的最后一次运行（含 §8 的探针判定统一：6 个探针从
> `filter(v === false)` 迁到 `createResults`；迁移后的断言/观测数见 §8 的表）。

**"能不能咬"逐条实测**（不是为了好看，每条都真的把修复退回去看过它变红）：

| 退回什么 | 变红的断言 |
|---|---|
| `sw/index.js` 不再判 `shotProblem` | `screenshot-mode` 10 条 |
| `pending.js` 投不出去时不放回队列（"取走即丢"） | `pending-delivery` 3 条 |
| `index.js` 去掉 `request-pending` handler | `probe:attach` 第 7 节 5 条（观测里能看到队列里那条 `M0B-PROBE-PENDING` 仍在） |
| 413 去掉 `Connection: close` | 新断言变红，且 `1 oversize POST OK 413 → 2 immediate peek FAIL ECONNRESET` 当场复现 |
| 校验器的 if/then 规则（`required` 单独存在时不被检查） | 新的反向量**意外通过** → 修完才被拒 |
| 审批策略 `never`（第一版修法用无会话的 `mode` 判定） | `write-gate` 第 7 节抓到：被改回 `ask` 的那个会话的写操作会被**静默放行** |

> 唯一一处"查证后不改"的：3080 常量与 `keepLines` 1200/800 —— 见 §5 表格最后两行，如实记录为**不成立的假设**，而不是为了显得在做工而硬改。

### 8. P0-C 收尾：剩下 6 个探针的判定也统一了（"只有布尔 true 算过"）

v3.40 把 8 个探针接到了 `tests/lib/probe-result.mjs`，但**还有 6 个在 `probe:all` 里跑的探针**留着自己那份
`filter(([, v]) => v === false)` 判定 —— 凡记成 `null`/对象/字符串的断言**静默算过**。本轮补齐：

| 探针 | 迁移前的判定 | 现在 |
|---|---|---|
| `probe:m3-debugger` | `v === false` | `createResults`（断言 14 / 观测 0） |
| `probe:look-left` | `v === false` | `createResults`（断言 11 / 观测 0） |
| `probe:sites` | `v === false` | `createResults`（断言 16 / 观测 0） |
| `probe:m3-ops` | `v === false` | `createResults`（断言 30 / 观测 0） |
| `probe:m3-control` | `v === false` | `createResults`（断言 11 / 观测 0） |
| `probe:look-left-e2e` | `v === false` | `createResults`（断言 22 / 观测 0） |

顺手清掉的三处"结构性假绿 / 死代码"：

1. **两套判定并存**：`agent-turn-probe` 与 `attach-probe` 已经用了 `createResults`，却还各留着一段旧的
   `filter(... === false)` 失败集**并抢着设退出码**。两套并存时说话的是松的那套。已删，判定只由 `finish()` 出。
2. **只有标题、没有断言的小节**：`ops-probe` 里 `console.log('\n6. 写操作门禁的运行时开关…')` 之后**什么都没有** ——
   读报告的人会以为这一段测过了。已删除并写明真正的覆盖在 `probe:m3-control`（扩展侧复核 `E_READONLY` 在第 2 节）。
3. **恒真合取**：`control-probe` 那条"面板探针同步拿到新能力集"写成
   `Array.isArray(x.constructor === String ? JSON.parse(x) : []) && …` —— 两个分支分别是"真数组"与 `[]`，
   第一个合取项**恒为真**，同一次 `evaluate` 还被求值三遍。已改成取一次值 + 两条干净断言
   （新增「面板能力集与插件侧一致」）。

**★ 顺带抓到的真问题：探针本身有 order-dependence。** 复查时我连跑了三次 `probe:look-left`，第 2、3 次各红 3 条。
原因不是产品：v3.40 给宿主加的意图去重规则是"同一 `sessionId+draft`、来自**另一个**页面半、5 秒内折叠成一次"，
而探针每次开新 socket（新 client id）却用**固定的** `sessionId+draft` ⇒ 5 秒内再跑一次，它的意图被判成
"另一个页面半的重复投递"吃掉了。草稿改为带时间戳后**连跑 3 次全绿**（这也说明该探针此前"跑一次绿"的结果里
有一半是运气）。

**咬合验证**：把一条断言强改 `false` ⇒ `❌ m2/look-left 失败 1/11 项：错误 key 的 /ag/agent 被拒（403）`，exit 1；
改成非布尔对象 ⇒ 进观测桶、**不计通过**（旧判定下它会静默算过）。

**计数如实（文档里旧的数字一并纠正）**：`ops` 文档原写"31/31"，实测**迁移前后都是 30**（老数字本身就偏了）；
`control` 由 10 → **11**（本轮新增一条）；`look-left-e2e` 由文档的 16 → **22**。

### 9. ★ 我上一版埋的回归：面板"读"写开关从来没成功过（这次是真浏览器抓出来的）

**背景**：v3.40 §A3 为了不再"打开面板就把写开关关掉"，把面板的初始化从
`POST {allowBrowserWriteOps:false}` 改成 `GET /ag/control`。当时的回归栏写的是
*"旧契约由 test:unit 断言 + 真实环境验证（下次重启后…）"* —— **实际上没有在浏览器里验过**。

**本轮第一步就撞上了**：给 `panel-probe` 加上"先把开关置 on 再开面板，看面板读到什么"之后，
第一次真浏览器运行就是 `dshHttp: {"200 /":1,"403 /ag/control":1}` + `consoleErrors: [403 Forbidden]`。

**服务端逐字证据**（临时日志，已移除）：

```
[dbg-control-403] {"url":"/ag/control?key=…","origin":null,"site":"none","mode":"cors","keyPresent":true}
```

也就是说：**Chrome 对扩展文档发出的"简单"跨域 GET 不带 `Origin`**（扩展页面有宿主权限、CORS 豁免，
所以连预检都没有；实测直接给 route 发 OPTIONS 预检是 400，也证明预检根本没发生）。
而 F2 只认"精确 `Origin`" ⇒ **403** ⇒ 面板 `enabled` 恒为 `false`：开关看着永远是关的。
**开关本身一直能用**，因为 POST 是非简单方法、会带 `Origin` —— 这就是它"看起来正常"的原因，
也是这处回归能活下来的原因：真正坏的是**读**，而不是写。

**修法**（与 F4 已有的做法对称）：`guard.originOk` —— `Origin` **存在**必须精确等于配对里的扩展 origin；
**缺失**时要求 `Sec-Fetch-Site: none` **且** `Sec-Fetch-Mode: cors`。两个头都由浏览器置入、页面无法伪造
（网站的 fetch 是 `cross-site`，导航是 `navigate`），且 key 仍然必需 —— 凭据强度不变，只是承认了它到达的形态。
设计 `详细设计文档 §5.4` 的 F2 行同步改写（v3.1 的 F4 就是这么修的，这次是 F2 的同类补丁）。

**回归与咬合（都真跑了，不是"应该会红"）**：

| 验什么 | 退回旧行为（只认 Origin） | 修好后 |
|---|---|---|
| `tests/unit/guard-client.test.mjs` 第 6 节（26 断言，新增 7 条：网站 `cross-site` / 导航 `navigate` / 两个头都缺 / 伪造 Origin 都不许过） | 2 条红 | 全绿 |
| `probe:panel` 新增第 4 节「面板读到的状态 == 插件真实状态」（真 Chrome；前置用 F2 POST 把开关置 on） | `dshHttp: {"200 /":1,"403 /ag/control":1}`、断言红 | `{"200 /":1,"200 /ag/control":1}`、`consoleErrors: []`、断言绿 |

**教训（同一类错误第二次）**：v3.40 §A3 的回归栏写着"真实环境验证"，但那件事**没有做**；
本文档的原则一直是"未跑过的，不许当证据"。从此凡改动**浏览器侧请求形态**的，回归栏必须点名
**跑过哪个真 Chrome 探针**，否则只能写"未验证"。

**顺带修掉的两处探针自身问题**（都是这次才发现的）：

- `panel-probe` 默认端口是 **3080（用户真实实例）**，而它加载的面板 iframe 又走 `dist` 里烤的
  `DEV_CONFIG` ⇒ 旧行为下"探针的过滤器看 3099、面板实际打 3080"（实测 `dshHttp: {}`，自相矛盾）。
  现在默认 **3099（开发实例）**，并且像其它探针一样**重写 dev-config → 重建 dist → 结束时还原并重建**
  —— 整条探针（含面板）指向同一个实例；要验真实实例必须显式 `--port 3080`。
- 想验真实实例时也不会再"顺手把用户的实例当测试床"。

**仍未做（明确清单，不藏）**：
1. **要你做**：重启一次 `dsh web`（宿主端插件有改动），并跑一遍人工验收 6 项（`docs/09-manual-checklist.md`）；写操作那一步请先看 `/ag/control` 的 `approvalMode`（`ask` 才会弹提示）。
2. 面板上仍**没有截图按钮**（能力有、入口没有，台账 §5 第 10 项）；`intentCaptureMode` 默认整页。
3. G5 的 SPA 成功率样本、域名黑名单、快捷键、把 `probe:all` 接进 CI —— 都还在台账 §5 里挂着。
4. `probe:attach` / `probe:chip` / `probe:panel` / 各 M0a·M1 探针不在 `probe:all` 的 8 条里，需要单独跑（本轮已单独跑过；但"一条命令全跑完"目前不包含它们）。

---

### 10. ★ 真机上抓到的两个"工具层"缺陷（只在真机用工具才会遇到）

**怎么抓到的**：你在真机打开侧边栏、打开「浏览器控制」之后，我调了一次 `browser_ax`，得到

```
tool "browser_ax" returned invalid output: "value" must match exactly one oneOf branch (matched 0)
```

也就是**模型拿不到无障碍树**，只拿到一句 schema 报错。顺着查，同一层还有第二个：

| 缺陷 | 现状（逐字） | 为什么两边门禁都没抓到 | 修法 |
|---|---|---|---|
| `browser_ax` 的 output schema 把 `nodeId` 声明成 **number** | CDP 里 `Accessibility.AXNode.nodeId` 是**字符串**（`DOM.Node.nodeId` 才是数字）⇒ 真实的无障碍树**整条**过不了 output schema，引擎直接判 `invalid output` | ①`probe:m3-ops` 看的是 **op 层**返回值（`opAx` 原样透传，探针只断言"节点数 > 5"）；②`browser-tools.test.mjs` 的 `browser_ax` 夹具是**手搓的**，`nodeId` 恰好写成数字 `11`，把缺陷盖住了 | schema 改为 `str(...)`；夹具改成真实形态（字符串），并注明两个 CDP 域的区别 |
| `browser_screenshot` 的 `execute` 用了 `randomBytes` 但**没有 import** | 每次通过工具层截图都是 `ReferenceError: randomBytes is not defined`（v3.40 我把后缀随机数从 `Math.random` 改成 `randomBytes(3)`，只加了用法没加 import） | ①op 层探针不碰工具层；②单测第 2 节的 schema 校验**恰好跳过了 screenshot**（它要落盘），而直接调 `persistScreenshot` 的那几条又显式传了 `id6`，绕过了那一句 | 补 `import { randomBytes } from 'node:crypto'`；单测把 screenshot 的 `execute` 也纳入（给临时工作区） |

**结构性修法（比修这两条更重要）**：把"**真值驱动工具层**"接成门禁 —— `probe:m3-ops` 新增一节，
用**真实 CDP 值**去调每个工具的 `execute()`，再把工具真正返回的东西撞它自己声明的 output schema（8 个工具逐条）。
注意必须是 `execute()` 而不是 op 值：`browser_screenshot` 的工具层会**变换**返回值（op 给 base64/tabId/notes，
工具落盘后换成 filePath/fileRef），拿 op 值去比会误报。

**咬合（都真跑过）**：

- `nodeId` 退回 `num` ⇒ 新断言红，且报错**逐字复现**真机那句 `"value" must match exactly one oneOf branch (matched 0)`；
- 去掉 `randomBytes` 的 import ⇒ 单测当场 `ReferenceError`；补回后单测 33 断言、`probe:m3-ops` **39 断言**全绿。

**教训**：这两个缺陷都不是"没测"，而是**测错了层**——op 层绿、工具层全靠手搓夹具。凡是"模型看得到的东西"，
就必须有至少一条断言走**模型走的那条路**（`tool.execute` → output schema）。

### 11. 真机人工验收（用户本人操作）—— 又抓到一个同族缺陷，并推翻一条旧期望

记录全文：`docs/reviews/manual-acceptance-2026-09-12.md`。本轮在真机上**通过**的项：
B4（调试横幅，见下）、B6（取消「浏览器控制」后 `browser_ax` → `E_NO_PERMISSION`）、C8（写「看左边」→ 抓取/落盘/推送，
审计逐字 `trigger:look_left`、`sessionMode:current`、`delivered:1`）、C10（面板关着写的意图，面板一开就补投，
`kind:"intent-replay"`）、E14（保留策略现场：25h 的**抓取形态**文件被删、用户命名文件保留）。

**推翻的旧期望（横幅）**：`docs/09` B4 与 `docs/12` T8 原写"勾选「浏览器控制」→ 目标页出现**不可消除**的调试横幅"。
实测：开关只是**许可**，attach 发生在**每次操作内部**（`ops/debugger.js#withDebugger`：attach → 执行 → `finally` 里 detach），
所以横幅只在一次调用进行中短暂出现（用户亲眼看到那行「浏览器正在调试」闪过，连发两次整页截图均可复现）。两处文档已按实测改写。

**推翻的旧期望（DevTools）**：B7 原写"打开 DevTools ⇒ attach 失败并报 `Another debugger is already attached…`"。
实测（真机 Chrome 150，DevTools 打开着，连测两次）：**attach 照样成功**，`browser_ax` 都返回了树（`total: 999`）。
也就是说新版 Chrome 允许多个调试器并存；`E_TARGET_BUSY` 的真实触发是**另一个扩展**占着该目标。
`docs/09` B7 已作废并写明实测、`docs/12` T8 同步，面板提示从"（例如 DevTools 打开着）"收窄为"（通常是另一个扩展在调试该页）"，单测同步。

**★ 第 4 个真缺陷：页面的回执帧被静默丢弃**（与 `request-pending`、`agent-hello` 同族：**有生产者、没有消费者**）

| | |
|---|---|
| 现象 | 想在验收里回答"引用到底插进输入框没有"，去审计找页面的回执 → `grep '"kind":"ack"'` 得到 **0 条**（一整天真实抓取一条都没有） |
| 链路核实 | client 半从 v3.38 起就在发 `{type:'ack', captureId, status}`（`lib/client.js` 两处）；协议里有 `ClientAckEvent`；宿主 `recordAck` **确实**写审计（`kind:"ack"` + `status`，字段表注释写的正是 "ack: inserted \| dismissed \| failed"）—— 但 `onClientFrame` 只认 `hello`/`request-pending`/`intent`，**没有 `ack` 分支** |
| 影响 | "页面拿到抓取后干了什么"（插入成功/失败/被 ✕ 撤销）事后无法回答 —— 而这正是审计存在的意义 |
| 修法 | `onClientFrame` 收下 `ack`（先 `validateAs('ClientAckEvent')`，通过再 `state.recordAck(frame)`）；`probe:look-left` 新增两条断言（11 → **13**）：走真实 WS 发 ack → **读审计文件**确认 `kind:"ack"` + `status:"inserted"` 落盘 |
| 咬合与两处踩坑 | ①去掉 handler ⇒ 红 ✓；②第一版断言**不咬**：captureId 写死、审计文件是追加的，上一轮条目替本轮作答（去掉 handler 仍绿）⇒ 改成每次运行唯一 id（与前面 look-left 草稿那次同一个教训）；③探针第一版给 ack 帧多带 `protocolVersion`，而 `ClientAckEvent` 是**闭集且不含该字段** ⇒ 帧被校验拒绝（反过来证明校验在拦） |

**另外两处真机事实**（顺手记下，免得以后误判）：

- 「写操作」是**运行期**开关，`dsh web` 每次重启回到"关"（面板如实显示、能力集 5）——安全默认，不是 bug；
- 本会话审批策略是 `never`，所以 B5（审批弹窗的批准/拒绝）在本会话跑不了：写操作被插件**当场拒绝并说明是策略**
  （修之前的版本会把这件事说成"用户拒绝了"，而没有人被问过）。要跑那两个分支需换一个策略为 `ask` 的会话。

### 12. 用户决定：这台部署改成"写操作不走审批缝"（并修掉一个优先级错误）

**用户的决定**（人工验收过程中）：本体会话的审批策略是 `never`（弹窗根本弹不出来），于是写操作只会被拒绝、没法用。
他把部署改成**无审批**形态：`~/.dsh/profiles/web/cordis.patch.yml` 的插件条目加

```yaml
      config:
        approvalForWriteOps: false      # 写操作只由面板「写操作」开关把关
```

（备份：`cordis.patch.yml.bak-before-approval-off`；回滚 = 删掉这两行 + 重启 `dsh web`。）

**为满足这个配置，先修掉一个优先级错误**：v3.41 §5 里那条 `policy === 'never' → deny` 排在
`!approvalRequired()` **之前**，于是"操作者明确关掉了审批"反而被会话策略挡下 —— 操作者说不用问，
插件却替他拒绝。现在顺序是：

```
写工具 + 开关关着           → deny（开关是最后一道闸）
approvalForWriteOps=false   → 放行（mode 报 off，面板文案「审批已在配置里关闭」）
会话策略 never              → deny（如实说明是策略，不甩锅给用户）
无审批服务                   → 放行（mode 报 switch-only）
其余                        → ask
```

**回归**：`tests/unit/write-gate.test.mjs` 第 8 节（新增 4 条，共 **37 断言**）——
"`approvalForWriteOps=false` + 会话策略 `never` ⇒ 写操作**放行**、mode=`off`"、
以及"开关仍然关着时无论审批怎么配都 deny"（否则"无审批部署"会退化成"无闸门"）。

**由此留下的未验项（如实记录）**：审批弹窗的**交互**（真的弹出来 + 批准/拒绝两个分支）在本机仍未验证 ——
只有换回 `ask`（把那段 config 删掉重启）才能验。unit 层覆盖的是判定逻辑，不是弹窗本身。

### 13. 生成物不再"每次 check 都脏"：去掉时间戳 + 让生成物自身不参与扫描

**现象**：每跑一次 `npm run check`，工作区就多两个无意义 diff —— `docs/DOC-GRAPH.md`（头部 `生成时间：<ISO>`）与 `docs/reviews/build-size.json`（`generatedAt`）。

**两个成因，都修了**：

| 成因 | 修法 |
|---|---|
| 生成物里写了时间戳 | `scripts/doc-graph.mjs` 不再输出 `生成时间` 行（连带删掉"比较前把时间戳归一化"的兜底，见 `docs/CHANGELOG.md` 里更早那条修复）；`extension/build.mjs` 的体积报告不再写 `generatedAt`。新鲜度看 `git log -1 -- docs/DOC-GRAPH.md` 即可 |
| **生成物自己参与了扫描**（更根本） | `docs/DOC-GRAPH.md` 本身是一份 `.md`，而图谱会把每份文档的 `lines`/`sections` 写进去 ⇒ **输出反哺输入** ⇒ 任何一次生成之后，磁盘上的文件都与"再次生成的结果"不一致。已把它排除（`GENERATED_DOC`），图谱因此变成**其它文档的纯函数**：生成一次即收敛，`--check` 是逐字节真比对 |

**副作用（是修正，不是退化）**：`待实现引用` 从 **317 → 140** —— 因为 `DOC-GRAPH.md` 自己那张"待实现引用"表又把自己的条目数了一遍（自我重复计数）。140 才是真实的"设计文档点名、仓库里没有这个文件"的数量。

**验收（实测）**：连续两次 `npm run check` 后，`docs/DOC-GRAPH.md`、`docs/doc-graph.json`、`docs/reviews/build-size.json` 三个生成物的 **md5 完全相同**；`git status` 剩下的只有本次有意的源码/生成物改动，不再有时间戳噪声。

### 14. 探针不再把抓取写进仓库（根因 + 门禁），顺带修掉两处端口撞车

**现象**：`git status` 里冒出 `/Users/mac/ai_tools/dsh project/网页插件/网页捕获/`，里面一个 `trigger: button` 的抓取文件，
front-matter 指向 `http://127.0.0.1:3994/docs.html` —— 那是 `probe:sites` 的文档站夹具。附带症状：doc-graph 的"文档数"会莫名 +1（那份 .md 被当成文档统计）。

**根因（实测链路）**：`/Users/mac/ai_tools/dsh project/网页插件/scripts/probe-all.mjs` 用 `cwd: <仓库根>` 拉起测试 DSH
⇒ 面板 iframe 里那个 DSH 会话的**工作目录就是仓库根** ⇒ 它向插件 announce 的 `workspace` 就是仓库根
⇒ **凡是不显式钉 `target.workspace` 的抓取**（点面板按钮那条路）就写进仓库。
（直接 `POST /ag/attach` 的探针不受影响 —— `tests/m0b/attach-probe.mjs` 一直有钉 `target.workspace`。）

**修法（两条腿）**：

| # | 改什么 | 验证 |
|---|---|---|
| ① | `scripts/probe-all.mjs` 的 spawn `cwd` 改成测试工作区 `/Users/mac/ai_tools/dsh project/网页插件/.devhome/workspace-m0a` | 跑完整套 `probe:all`（**8/8**）后，`probe:sites` 的产物落在 `/Users/mac/ai_tools/dsh project/网页插件/.devhome/workspace-m0a/网页捕获/`，仓库根干净 |
| ② | 新增门禁 `/Users/mac/ai_tools/dsh project/网页插件/scripts/check-repo-root.mjs`，接进 `npm run check`：仓库根一旦出现 `网页捕获/` 或 `yyyy-MM-dd-HHmm-*.md` 就 **exit 1** 并打印修法 | 咬合实测：手工造一个 `网页捕获/x.md` + 一个根级抓取命名文件 ⇒ 门禁列出两处违规并 exit 1；清掉后 exit 0 |

门禁故意收得很窄（**只看仓库根这一层**、只认抓取目录名与抓取文件命名形态），仓库里正当的 md 不会长那样 ⇒ 零误报。

**顺带修掉两处探针端口撞车**（同类"探针之间互相污染"）：

- `tests/m0a/permission-probe.mjs` 与 `tests/m2/capture-probe.mjs` 默认夹具端口**都是 3999** → 前者改 **3997**；
- `tests/m2/gate-probe.mjs` 与 `tests/m2/look-left-e2e-probe.mjs` 默认 CDP 端口**都是 9233** → 前者改 **9235**。

**另一个实测到的环境坑（已记进 HANDOFF 避坑第 10 条）**：某探针 **0 秒**失败往往不是代码问题，而是上一次残留进程占着端口
（`probe:agent-turn` 就这么失败过一次，`EADDRINUSE 3992`；`lsof -nP -iTCP:3992 -sTCP:LISTEN` 确认后端口一空即通过）。

## v3.40 — 2026-09-12

**触发**：把 v3.39 里"审核 + 验真"产出的缺陷清单按 P0 → P1 → P2 修下去。用户同时拍板两件事：**接受 G1 实测 2.1–2.7 秒**（目标由 1.5s 下调为 2.8s）、以及**按上述顺序持续整改**。

### 0. G1 目标按用户决定下调（★目标值变更，留痕）

用户 2026-09-12 决定：**接受实测 2.1–2.7 秒**，G1 目标由 **≤1.5s 改为 ≤2.8s（p50）**。三处文档**同时**改齐，避免同仓库两套结论：
`详细设计文档.md §1.2`、`docs/11-台账.md §2`、`docs/PROGRESS.md`（并把"预热 iframe 实测"作废）。
原 1.5s **未达标**的事实保留在案；瓶颈经实测定位在 iframe 内 DSH 应用首屏（握手 2ms / 我方外壳 ~750ms / DSH 应用 ~1.34–2.6s），**不在本插件**。

### 1. P0：安全与正确性（最小改动，各配能咬的回归）

| 项 | 问题 | 修法 | 回归 |
|---|---|---|---|
| **A1** | `guard.js#sameOriginOk`：**Origin 缺失即放行**，而导航/`<img>` 这类请求也不发 Origin ⇒ 任意网页可 `GET /ag/pending`（消费式 `drain()`）清空待投递队列 | 严格照设计 §5.4 F4 那句话：Origin 存在必须等于本服务 authority；**缺失**时要求 `Sec-Fetch-Site: same-origin` **且**带 `dsh-auth-` cookie | `tests/unit/guard-client.test.mjs`（19 断言；旧代码下 4 条变红） |
| **A2** | `dsh-session.js#ensureReady`：取票据失败时**静默回退**把长期配对密钥拼进 iframe URL（与同文件注释、设计 T9 都矛盾） | 重试一次；仍失败则 **fail-closed**：不返回 URL，给可诊断错误（复用已有 `E_UNPAIRED`，不新增协议码） | `tests/unit/embed-url.test.mjs`（12 断言，钉"任何返回字段都不含密钥"） |
| **A3** | `panel.js#initWriteOps`：初始化用 `POST {allowBrowserWriteOps:false}` 去"读"状态 ⇒ **每次开面板把写开关静默关掉**（审计日志有实证） | 新增 **`GET /ag/control`**（只读）；面板初始化改 GET，只有用户拨动开关才 POST | 旧契约由 `test:unit` 的 write-gate/control 相关断言 + 真实环境验证（下次重启后 `delivered`/`control` 记录应只在用户操作时出现） |
| **A4** | `agent-channel.js`：`capture-request` 校验失败只 `log` 后 `return`，不回 `capture-result` ⇒ 违背设计 §5.2「必须无条件回包」 | 失败也回 `capture-result(ok:false, E_PAYLOAD)` | 由 probe:look-left 系列覆盖（下轮重跑） |
| **B1** | `hub.pushClientPrimary` 把"`send()` 没抛"当送达（`ws` 只在 CONNECTING 抛，其余非 OPEN 走 `sendAfterClose` 静默丢弃）；`deliveredTo` 回的是**计数伪装成 id**（`client:1`） | 发送前查 `readyState === OPEN`；首选半收不下就**回落其他页面半**；**返回真实 client id（或 null）**，`deliveredTo` 用它 | `tests/unit/capture-routing.test.mjs`（20 断言，新增"返回的 id 必须是已连接的 client id"） |
| **B2a** | `sniffOnce` 的重新武装排在类型早退之前 ⇒ session id 抖成 `undefined` 时又可能重复抓取 | 类型检查前置 | 同上（client-attach 的 episode 断言） |
| **B2b** | 意图 episode 是**页面级闭包**，而常态有两个页面半嗅**同一份共享草稿** ⇒ 同一句「看左边」可能被抓两次 | **宿主侧按 `sessionId+draft` 5 秒窗去重** | 待下轮探针/实机验证（页面级去重无法覆盖跨半，只有宿主能收敛） |
| **B3** | 投递失败降级入队时**丢 owner** ⇒ 将来补投会把 `sessionMode:'current'` 插进错误页面半的会话 | owner 先取出，入队时带 `ownerClientId` | 由 capture-routing 的 owner 路径覆盖 |

### 2. P0-C：让探针能红（针对"假绿"，单一真源）

新增 `tests/lib/probe-result.mjs`：**断言 / 观测分离，且只有布尔 `true` 算通过**；非布尔值进"观测"桶、永不计通过（旧规则 `filter(v === false)` 会把记成 `null` 的对象静默算过）。

- 已接线：`tests/m2/capture-probe.mjs`、`tests/m0b/chip-probe.mjs` —— 两者此前**既不算失败集、又无条件 `process.exit(0)`**（结构上不可能变红），现在以 `finish()` 收尾并如实设退出码。
- 同时修掉 `capture-probe` 的恒真断言：`[].every(...)`（胶囊一个都没生成时反而变绿）改为**两条非空集断言**（`dockMounted === true` + 观察到的胶囊必须来自插槽），并把它从"硬断言"降级为观测的那条也标注清楚。
- **新增门禁**（`consistency-check.mjs`，规则 19 → **20**）：`decorative-assertion` 禁止 `record(…, true)` 这类**装饰性断言** —— 实测 `tests/m3/debugger-probe.mjs` 里就有一条（还被我此前当成"14 条断言"之一引用过），已删除。实测该门禁会咬。
- 另修我自己造的静默失败：`scripts/probe-all.mjs` 收尾重建 `dist` 失败时**只 `console.error` 而不影响退出码** ⇒ 现计入退出码。

### 3. P0-C 续 + 第一次"能红的"探针重跑（★本轮最重要的证据）

**探针全部接到新判定**：`attach` / `gate` / `agent-turn` / `autostart` 改用 `createResults`（`capture`/`chip` 此前已接）；`native-headed` 本来**零断言**，改为显式 `recorder.finish()` 如实打印「断言 0 条」（不假装它测过什么）；`perf` 的判定改造留在 P1。**16 个单测文件**的失败谓词同步收紧为 `v !== true`（原来只认字面 `false` ⇒ 记成 `null`/对象的断言静默通过）。

**然后重跑 `probe:all` + `probe:chip`，结果（如实，含暴红）**：

```
❌ 2/8 个探针失败：probe:look-left、probe:capture
✅ chip-probe：全部通过（断言 3 条，观测 12 条）
```

两条失败**都是真信息**，而且都指向"以前被静默掩盖"的东西：

1. **`capture-probe` 红了 2 条 v3.38 的过期断言**（`noHijack_shellNotSwitched` / `noHijack_draftNotPrefilled`）。v3.39 按用户决定恢复设计行为（切到新会话 + 预填）后，这两条断言就过期了 —— 但该探针当时**没有失败集且无条件 `exit(0)`**，所以它一直"绿"。这正是"结构上不可能变红"掩盖缺陷的活样本；已改为断言新契约（`switched=true` / `inserted=true`）。
2. **`probe:look-left` 红了 2 条** —— 因为我在 P0 引入的**宿主侧意图去重太钝**：它把"同一个页面半先后两次意图"也吞掉了。已收窄为**只在"另一个页面半发来同一 `sessionId+draft`"时折叠**（那才是重复投递的真因）。修完两片单独重跑：`probe:look-left` ✅、`probe:capture` ✅。

> 教训（值得留档）：**收紧判定之后第一次重跑就会暴红**，而它抓到的两处都不是"新引入的 bug"，而是**被旧的假绿掩盖的旧问题**。这就是把"能红"排在所有 P1/P2 之前的原因。

### 4. P1（本轮完成的子集）

| 项 | 问题 | 修法 | 回归 |
|---|---|---|---|
| `hub.js` 心跳 | 用**原始文本子串** `includes('"pong"')` 判 pong ⇒ 任何 payload 含该字面量的帧在 `JSON.parse`/`settle()` 之前被丢，调用只能以 `E_TIMEOUT` 收场 | 先 parse，再判 `frame.type === 'pong'` | 由既有 loopback WS 单测（agent-selection / capture-routing）覆盖 |
| `agent-hello` 死帧 | 协议有定义、扩展在发、**host 无 handler**（与 `request-pending` 同类） | `onAgentFrame` 收下并记录扩展版本/panel（诊断"陈旧构建"正需要它） | 同上 |
| `onAgentConnect` 日志谎报 | `drainIntents()` 消费整队却只投最后一条，日志却打 `replayed N`，被丢的 N-1 条无任何痕迹 | 日志改 `replayed 1/N` + 丢弃数；并写入审计 `kind:"intent-replay"` | 由 probe:look-left（补发路径）覆盖 |
| `retention.js#TEMP_FILE` | `/\.tmp$/u` 无前缀约束 ⇒ **用户在捕获目录里的 `notes.tmp` 老于 24h 就被删**，与本文件注释"绝不碰用户文件"直接矛盾 | 收紧为 `^\d{4}-\d{2}-\d{2}-\d{4}-.*\.md\.tmp$`（`store.js` 真正写的形态） | `retention.test.mjs` 新增第 5 节（21 断言；旧正则下"用户 .tmp 被保留"变红） |
| `approval.js` 三处 | ①`next` 缺失时**无差别 allow**（写操作静默变无限制）②`mode` 是创建期 `const` 快照，却回传面板当"会问你"③`dispose` 从未被调用（热重载泄漏监听器） | ①写工具 **fail-closed**、读工具照旧放行；②`get mode()` 每次重算；③用 `ctx.effect` 注册 | `write-gate.test.mjs` 扩到 23 断言（含"写工具缺 next 必须 deny"与"mode 随审批服务卸载而变"） |
| `check-dist-config` 独立基准 | 只断言 `source == dist` ⇒ 探针崩在"改写了 dev-config 未还原"时两边**一致地错**，门禁必然绿（正是它自称要防的事故） | 增加独立基准：源码端口必须等于**真实配对文件** `~/.dsh/dsh-web-companion.json` 的端口；无该文件时**明说基准缺失**而不是假装检查过 | 实测：把 dev-config 改成 3099 并一致重建 dist，门禁 **exit 1** 且给出修法 |
| `audit.js` 静默死亡 | 一次 IO 异常即 `enabled = false` **永久**停写、无复活路径，且系统内外都不可观测（调用方全忽略返回值、`/ag/ping` 不暴露） | 不再拉闸：每次 append 都真的重试、计数、首次失败大声记一次；新增 `status()` 并经 **`/ag/whoami`** 暴露（诊断路由，不牵动协议 schema） | `audit-log.test.mjs` 扩到 26 断言，含"★第二次是真的重试（failed=2）而不是短路" |
| `applyAttach` 无幂等 | 同一 `captureId` 被重复投递（重连/重试/发送方出 bug）会**重复插同一段 `@文件`** | 进函数先查 `state.chips.has(captureId)`，重复即忽略并返回 false | `client-attach.test.mjs` 新增第 6 节（29 断言；去掉守卫后 3 条变红） |
| `persistScreenshot` id6 | `Math.random().toString(16).slice(2,8)` 可能**不足 6 位**（如 0.5 → `"0.8"`）⇒ 同一分钟的截图可能被 rename 静默覆盖 | 改用 `randomBytes(3).toString('hex')`（恒 6 位） | 由 E2E-13 工具契约断言（截图落盘资产）间接覆盖 |
| `capture-probe` 复合观测 | `emptySelection` / `retention` 等把对象交给 `record()` ⇒ 旧过滤器只认字面 `false`，里面任何一项为 false **都不会变红** | 拆成逐条布尔断言（5 条新增），原对象降级为 `observe()` 保留可读性 | 探针自证（下次重跑可见断言数上升） |

### 5. 本轮验证

`npm run check` 全绿（exit 0）：**20 条反模式规则 / 222 文件、17 个单测文件**、`dist-config: OK（port=3080，且与真实配对文件一致）`。
`probe:all` 8 个探针 6 ✅ / 2 ❌（**都是我该修的**：v3.38 过期断言 + 我引入的过钝去重；均已修，单跑复验 ✅）；`probe:chip` ✅。

> **另一处"我自己的假绿"**：新加的独立基准一开始把 `homedir is not defined` 这类**检查自身的 bug** 也吞成"本机没有配对文件、跳过基准"——门禁静默退化。已改成显式区分「文件不存在」与「检查坏了（直接抛）」。

**未做（下一步，P1 剩余）**：`mode:'screenshot'` 零像素仍 `ok:true`、积压抓取补投路径、`perf` 判定、`CHIP_LABEL_MAX` 注释纠正；然后 P2（协议 `error.code` 收紧、ROUTE 表单一来源、常量漂移、`whoami`/`ping` 口径、`pimoa-review` 驱动）。

### 6. 第三轮：抽取质量 + 门禁自身收紧 + 全套复核

**抽取质量（`extension/src/content/extract.fn.js`）**：

| 项 | 问题 | 修法 |
|---|---|---|
| `stripTrailingMeta` | `digitRatio > 0.15 \|\| /^[^。.!?]{0,80}$/u.test(value)` —— 右边那支几乎恒真，**数字判据被完全架空**，而注释却声称"只在以数字为主时才删"（注释与代码相反） | 删掉从未起作用的数字判据；阈值 80 → **40**（80 字符能装下一整句英文说明，那不是标签） |
| `clean()` | 零宽集合缺 **U+2066–U+2069**（Bidi isolate）；**U+2028/U+2029** 被当零宽**删除**，而它们是换行 ⇒ 会把两段粘成一段 | 补进 isolate；行/段分隔符改为替换成 `\n` |
| `stripPlaceholderAnchors#isBareAnchor` | 用字符串 `startsWith` 比 `location.href`：带 query 时**漏判**占位锚点；`location.href` 恰为目标时又**误删**有效同页锚 | 改成比较"去掉 fragment/query 后的文档地址"，两端一致才算本页 |

**门禁自身（两处"假绿"）**：

- `consistency-check.mjs` 的 `allowIf` 豁免：**试过**改成"只看命中处前后 40 字符"的距离窗口 —— 结果**误伤设计文档里正当的引用**（那类句子本就更长），说明距离启发式不可靠，**已回退**。改为**不改变判定、但把豁免逐条打印**（本次 18 处）：弱点可见，而不是静默。这条"试过错法再回退"的过程也一并留痕。
- `material-guard.mjs`：内容嗅探原先只匹配**裸关键词**，于是**守卫自己的源码与它的单测**（含正则字面量与伪造夹具）也被自己拦住 ⇒ 那两个文件进不了任何审查材料。改为要求"关键词后面真的跟着 ≥120 字符 base64"（PEM 头 + 正文，或私钥字段带长值），并把测试夹具改成真实长度。19 断言，含"★守卫自己的源码不被自己拦住"。

**探针恢复**：`look-left-e2e-probe.mjs` 恢复 `dev-config` 时**同时重建 dist**（此前只还原源文件 ⇒ `extension/dist/` 留着测试端口 + 测试密钥构建的产物，而 dist 正是用户 Chrome 加载的目录）。核对：所有会改写 `dev-config` 的 6 个探针现在都重建 dist。

**★全套复核（收紧判定之后）**：

```
npm run check                                            → exit 0（20 条规则 / 223 文件 / 17 单测文件 / dist-config OK）
npm run probe:all                                        → exit 0，8/8 全绿
npm run probe:chip                                       → exit 0
```

这意味着：**这一轮的全绿是在"探针真的会红"的判定下取得的**（此前同一批绿是结构上不可能红的）。
**未做（下一步）**：P1 其余项（审计可观测与复活、`check-dist-config` 独立基准、`extract.fn.js` 抽取质量、`applyAttach` 幂等与截图零像素仍 ok、`persistScreenshot` id6、探针端口/路径集中、把 `capture-probe` 的复合"观测"升级为真断言、`perf` 判定）→ 然后 P2。

---

## v3.39 — 2026-09-12

**触发**：用户实测后指出两件事 —— ①「按设计点击插件应该开一个新会话，但现在是在当前会话里 attach」；②我在 v3.38 里"顺带查出"的两个重复缺陷要一起修。

### 0. ★推翻 v3.38 的一个决定（留痕，不粉饰）

v3.38 我把「按钮/右键抓取」改成 **不抢界面 + 不预填**（用户当时在选项里选了这一条）。**本版按用户决策恢复设计行为**：

| | v3.38（被推翻） | v3.39（当前） |
|---|---|---|
| `sessionMode: 'new'`（面板按钮 / 右键菜单） | 新建会话，**不切走、不预填**，胶囊给「引用」/「去该会话」 | **新建会话 + `sessions.open()` 切过去 + 把 `@文件` 写进那个会话的草稿**（= `attachSessionMode` 的设计含义） |
| `sessionMode: 'current'`（「看左边」） | 引用进当前草稿 | 不变 |

**为什么推翻**：用户最初的报告（"点「新会话」输入框自带 attach 文档"）**不是"切换"本身的错**，而是它被两个重复缺陷放大成了随机事件 —— 一次抓取被投给两个页面半（各建一个会话）、一次「看左边」触发两次抓取。把重复修掉之后，"按了按钮就切到新会话"是确定且符合预期的行为。v3.38 加的 `offered` /「引用」/「去该会话」机制因此整块删除，不留悬空代码。

### 1. 修：一次抓取只投给一个页面半（真缺陷，用户实测暴露）

**现场**：`/ag/ping` 报 `connectedClients: 2`（主 GUI 标签页 + 侧边栏 iframe 里那份 DSH GUI）。`/ag/attach` 用的是 `hub.push()` —— **广播**，两份页面各自 `applyAttach()`：

```
审计 05:45:05.821  trigger=button  sessionMode=new  delivered=2
会话 05:45:05.846 / .849   ← 一次抓取，两个会话（相隔 3ms）
审计 05:46:18.597  trigger=manual  sessionMode=new  delivered=2
会话 05:46:18.619 / .622   ← 同上
```

这也**解释了用户最初报的 22:23 现象**（而我第一次把因果讲错了：那两个会话相隔 5ms，我说成"一个是你点的、一个是插件建的"，实际**两个都是插件建的** —— 一次抓取 × 两个页面半）。附带证据：那份 22:23 文件的 front-matter 逐字写着 `trigger: button`，而全仓只有面板两个按钮会发 `button`（右键菜单当时是坏的，意图路径写的是 `look_left`）。

**修法**：

- `hub.pushClientPrimary(event, preferredId)` —— 只投**一个**页面半；`push()` 的广播语义保留（心跳/状态类事件仍要广播）。
- 选择顺序：**①谁要的给谁**（「看左边」意图的发起页面）→ ②被嵌入的那份（侧边栏，抓取就是从那儿发起的）→ ③focused → visible → 最近连接。
- 配套接线（"接线"最容易错的地方，**端到端打通**）：client 半的 `hello` 新增 `embedded / visible / focused` 页面事实（并在 focus/blur/visibilitychange 时重发）；host 记住 `intent → requestId → (扩展的 capture-result 带 captureId) → captureId → clientId`，attach 落地时按 id 送回发起它的那个页面。断开的收件人自动回落到规则选出的页面，**不因 preferred 失效而丢抓取**。

### 2. 修：一次「看左边」只抓一次（真缺陷）

**现场**：`05:45:52.999` 与 `05:45:53.784` 两次 `look_left` 抓取，相隔 **785ms**（正好是嗅探器 800ms 的轮询周期），用户输入框里因此堆了**两个** `@网页捕获/…md`（内容完全相同，上下文成本翻倍）。

**根因**：意图嗅探的旧守卫是"草稿与上次发送的不同"。而第一次抓取完成后插件**会改写草稿**（追加 `@文件`）—— 草稿变了、且仍以「看左边」开头 ⇒ 785ms 后又触发一次。同一个坑在用户**打字过程中**也会踩到。

**修法**：改成 **episode 武装/解除** —— 命中关键词时触发一次并解除武装，直到关键词从草稿里消失（用户清掉）或换了会话才重新武装。

### 3. 修：发布产物里被烤进了测试端口（真事故，用户侧整段时间连不上）

**现场**：用户报"面板连不上"。查下来 `extension/dist/src/sw/index.js` 与 `panel.js` 里是 `port: 3099`（测试实例端口），而源码 `dev-config.js` 是 3080。**根因是我自己的操作**：探针为指向测试实例会临时改写 `dev-config.js`，而与此同时后台在跑 `npm run check`（含 `build:ext`）—— 构建把**测试端口**烤进了 `dist/`，而 `dist/` 正是用户 Chrome 加载的目录。表现是 `/ag/agent` 连不上、`E_EXT_OFFLINE`，而看源码完全看不出问题。

**修法（两道防线）**：

- `scripts/check-dist-config.mjs`（`npm run check:dist`，已并入 `check`）：**产物里烤的端口/密钥必须等于源码 `dev-config.js`**，不一致直接红并打印典型原因。已实测：正常 `exit 0`，把源码端口改成 3081 后 `exit 1`。
- `probe:all` 收尾自动重建 `dist` 并自证，跑完探针不需要记得额外做什么。

**顺带暴露的测试隔离问题（未修，记录）**：探针固定用 3099，而一份"指向测试端口 + 测试密钥"的扩展会真的连上测试实例并**替它应答工具调用** —— 实测 `probe:agent-turn` 因此读到用户的真实页面（apexnc）而不是夹具页，红了两次。这不是产品缺陷，但说明**探针实例没有和外来扩展隔离**（随机端口/独立密钥可解）。

### 4. 测试

| 文件 | 断言 | 钉住什么 |
|---|---|---|
| `tests/unit/capture-routing.test.mjs`（新） | 20 | 真 hub + 真 loopback WS：`push()` 广播、`pushClientPrimary()` **只投一个**、指定收件人覆盖默认规则、无页面时返回 0、只有主标签页时不丢、收件人已断开时回落、事实更新后规则跟着变 |
| `tests/unit/client-attach.test.mjs`（重写） | 26 | 设计契约（`new` → 建会话 + 切过去 + 写进**那个**会话的草稿；`current` → 写当前草稿）+ **意图 episode 只触发一次** + 页面事实上报 |
| `tests/unit/rotate.test.mjs`（新） | 11 | 原生 host 日志轮转（此前它是这条链路上**唯一无上限**的日志文件） |

`npm run check` 全绿（exit 0）：19 条反模式规则 / 202 文件、**13 个单测文件**、`dist-config: OK（port=3080）`、体积 130.8KB。

> 诚实记录：这轮我自己写测试时先写错了两处（一条期望值抄错、一条 WebSocket 桩从不触发 `open` 导致 hello 断言形同虚设），另有两条因为快照时机太早而假红 —— 都已修正，见 §5 的"未做/待验"。

### 5. 未做 / 待验（如实）

- **真 Chrome 探针本轮未跑**（用户要求"先不测试，先做 review"）；`probe:all` 与 `probe:chip` 需下一轮补跑。
- 测试隔离（随机端口）未做，见 §3。
- 台账 §5 的第 11、12 项（积压抓取投不出去、审批 `never` 下写操作被自动拒绝）仍未修。

### 6. ★安全事件：扩展签名私钥被当审核材料外发给模型厂商

**发生了什么**：我派 PiMoa 做对抗性 review 时，分片命令里带了 `scripts/`，于是
`scripts/.dev-extension-key.json` 被 `scripts/pimoa-review.mjs` **逐字读入**当材料发出；`moa_verify`
会把材料送给模型厂商 —— 报告里逐字记着 `models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3`。**已外传。**

**泄漏物**（逐字核对，非推测）：

| 片 | 混入的敏感文件 | 泄漏物 | 落点 |
|---|---|---|---|
| 片1（桥接） | `scripts/.dev-extension-key.json` | **扩展签名私钥**：`publicKeyDer`(392) + `privateKeyPem`(1704，RSA-2048，可解析)；`publicKeyDer` 与 `extension/manifest.json` 的 `"key"` **逐字相同**，推导出的扩展 ID 正是 `idpgkobbblmpmnonlndopijgfmehfmig` | 已外发给模型厂商 |
| 片2a（扩展） | `extension/src/lib/dev-config.js` | **真实桥接配对密钥**（32 字节，`/ag/*` 的唯一门禁；实测该文件里的 key 与 `~/.dsh/dsh-web-companion.json` 逐字相同） | 已外发；**并被模型逐字回显进本机 spool** `/Users/mac/.pimoa/spool/20260912T061716-…md`（`docs/reviews/*` 产物里**不含**密钥，已 grep 逐字确认 0 命中） |

> ⚠️ **更正**：本文件早先版本写的是"配对密钥不在那份材料里"—— 那是**只看了桥接片**得出的错结论。片 2a 的 context 是
> `find extension/src dsh-plugin/lib …`，`dev-config.js` 正在其中，所以**配对密钥确实泄了**。原判断已作废。

**爆炸半径（决定"要不要紧张"的关键事实）**：`/ag/*` 只监听回环（`127.0.0.1:3080`，实测 `lsof`）。拿到密钥的人必须**已经能在这台机器上执行代码或访问回环**才能用它 —— 远程攻击者用不上；网页也读不到（CORS + key/Origin 双校验）。且两个凭据各管一半：扩展签名密钥能造"同 ID 的扩展"，但过不了 `/ag/*` 的 key 校验；配对密钥能调 `/ag/*`，但拿不到它的人是远程的。

**已做的卫生处置**：`/Users/mac/.pimoa/spool` → `700`，目录内含明文密钥的文件 → `600`（此前是 `644`，同机其他用户可读）。**没有删除**该 spool（保留证据），只是收紧权限。

**根因**：设计 §9/T2 早把"密钥文件误外发"列为本机高频事故模式，但**只防了 git**，没防"喂给外部模型"这条等价出口；
驱动脚本对 context 没有任何过滤。

**处置（已做）**：`scripts/material-guard.mjs` + `pimoa-review.mjs` **上网之前**调用 ——
路径黑名单（`.dev-extension-key.json`/`dsh-web-companion.json`/`dev-config.js`/`.credentials.yaml`/`.devhome/`/`*.pem`/`*.key`/`id_rsa`）
**加**内容嗅探（PEM 私钥头、`privateKeyPem` 字段名；路径改名也拦得住）；命中即 `exit 2` 并列名，
**故意不留强制放行开关**。实测 `--context scripts/.dev-extension-key.json` → `exit 2` 且无任何产物；
`tests/unit/material-guard.test.mjs`（16 断言）覆盖真实路径 / 伪装路径 / 干净文件不误报。

**用户决定（2026-09-12）：不轮换这对扩展密钥。** 理由：泄漏物不含配对密钥（真正的门禁没泄），而轮换会改扩展 ID，
牵动 native host 的 `allowed_origins` 与重新配对 —— 相对收益不值这个代价，且这不是当前的核心问题。
**记录在此，以免后人以为是遗漏。**

### 7. 审核与验真（PiMoa，本轮只做了审核与验真，未改代码）

- 对抗性 review **桥接片成功**：`docs/reviews/pimoa-code-adversarial-bridge.md`（quorum 2/2，206.7s，3 BLOCKER / 6 MAJOR / 8 MINOR）。
- **逐条独立验真**：`docs/reviews/pimoa-verification-2026-09-12.md` —— 17 条中 **15 条真 / 2 条部分真 / 0 条误读**。
  两条经源码确认的硬结论：①`node_modules/ws/lib/websocket.js` 的 `send()` **只在 CONNECTING 时抛**，其余非 OPEN 走
  `sendAfterClose(ws,data,cb)`，没传回调即静默丢弃 ⇒ `pushClientPrimary` 会把半死 socket 记成 `delivered=1`；
  ②`consistency-check.mjs:211` 的豁免按**整行**判定 ⇒ 门禁自身可被话术绕过；③`check-dist-config.mjs` 只断言 `source==dist`、
  无独立基准 ⇒ 对"探针崩在改写 dev-config 未还原"这类事故恒真。
- **我额外核出一条 MAJOR**（PiMoa 只擦到边）：`extension/src/sw/ops/index.js:266`/`:290` 只用 `debuggerAvailable()`
  （= `typeof chrome.debugger?.attach === 'function'`）判断、**不查「浏览器控制」开关** ⇒ 模型调
  `browser_screenshot{fullPage:true}` 或 `browser_ax` 会在用户没开开关时 attach 调试器并弹不可消除的「正在调试」横幅 ——
  与 ADR-12/T8「运行期 opt-in、默认不 attach」**以及该工具自己描述里写的"整页需要「浏览器控制」开关"直接矛盾**。
- **缺口（未完成）**：常规 code review 两片**零产出**；对抗性 review 的**扩展/测试片**因材料预算（424541 > 360000 字符）整片失败
  ⇒ 「看左边只抓一次」「测试有无假绿」两条**仍未被外部审过**。已派子代理改小分量重跑。
- 待修清单（P0 三条 / P1 五条 / P2 六条）见验真文档 §4。

---

## v3.38 — 2026-09-12（已被 v3.39 部分推翻，见上）

**触发**：用户报了一个现象 —— **在 DSH GUI 里点「新会话」，输入框自带一份网页 attach 文档**（`@网页捕获/…md`），他说自己没开侧边栏、也没点扩展。查下去牵出四个真问题，本版全修，并补上"以后能定案"的审计。

### 0. 用户报的现象：根因在 client 半，不在扩展

会话库里的证据（`~/.dsh/sessions/--Users-mac-ai_tools-dsh~0020project--/`）：2026-09-11T02:23:36.**922**Z 与 **.927**Z **相隔 5ms 创建了两个会话** —— 5ms 不可能是两次人手点击，而全仓唯一程序化建会话的地方就是 client 半的 `openFreshSession()`。其中 `session-4dc031af` 的首条用户消息逐字以注入的 `@网页捕获/2026-09-11-2223-plant-the-peak-…md` 开头，并跑完了一轮 18 步对话。

链路（逐字）：

1. `dsh-plugin/src/host/routes/attach.js:65` — `sessionMode = trigger === 'look_left' ? 'current' : (config.attachSessionMode ?? 'new')`
2. `dsh-plugin/src/host/index.js` — `attachSessionMode` 默认 `'new'`
3. `dsh-plugin/lib/client.js` — `applyAttach()` 对 `'new'` 调 `openFreshSession()`
4. **旧 `openFreshSession()` 里有 `sessions.open(sessionId)`**（抢走界面）+ **`applyAttach()` 无条件 `shell.setDraft(fileRef)`**（预填输入框）

⇒ 任何**非「看左边」**触发的抓取（面板按钮 / 右键菜单）都会**新建会话 + 把界面切过去 + 预填 `@文件`**。用户点「新会话」时看到的那份附件，就是插件在他点完 5ms 后创建并切过去的那个会话。

**修法**（两半契约从此分开，`tests/unit/client-attach.test.mjs` 钉住）：

| `sessionMode` | 谁触发 | 新建会话 | 抢界面 | 预填草稿 | 状态 |
|---|---|---|---|---|---|
| `current` | 输入框写「看左边」 | 否 | 否 | **是**（用户就是在这个会话里打的那句话） | `inserted` |
| `new` | 面板按钮 / 右键菜单 | 是 | **否**（旧行为：是） | **否**（旧行为：是） | **`offered`** |

`offered` 的兑现方式：胶囊上多一个 **「引用」** 按钮（点了才切到该会话并插入 `@文件`）；若目标会话不是当前会话，当前会话的胶囊区会显示一条 **「去该会话」** 条目 —— 不加这条，"不抢界面"会静默退化成"抓取丢了"（插槽是 session 作用域的）。ack 也随之改变：**offered 不立即 ack**，用户点「引用」→ `inserted`，点 ✕ → `dismissed`，所以审计里"没人理的抓取"如实显示为没人理，而不是假的 `inserted`。

### 1. 右键菜单抓取从来就是坏的（`trigger` 不在枚举里）

`extension/src/sw/menu.js` 一直发 `trigger: 'contextmenu'`，而 `AttachRequest.trigger` 的枚举是 `look_left | button | shortcut | manual` —— 这个值**不在枚举里**，于是每次右键抓取都在 host 的 `validateAs('AttachRequest')` 被 **400/E_PAYLOAD** 挡掉，一个文件都不会落盘。菜单看起来接好了，实际是哑的。

修：改用枚举内的 **`manual`**（用户手势触发、既不是面板按钮也不是快捷键）。新增 `tests/unit/menu-trigger.test.mjs`（7 断言）把**扩展发出的值直接喂给同一个生成校验器**；已实测把旧值放回去该测试立刻变红并打印 `not in enum [...] at $.trigger`。

> 台账 §3 曾把"右键菜单"记为已有 —— 错的，探针从未测过这条路。

### 2. 审计日志（设计 §9 承诺过，此前零实现）

设计与台账都写了"桥接插件记录 `ts, origin, route, status, bytes, duration, captureId`（无 key/正文）"、"扩展记录 capture/tool"。实测：**两半都没有**。这正是上面那个 5ms 事件查不到底的原因（插件队列只在内存，进程一重启就没了；当时那个实例已经没了）。

新增：

| 位置 | 产物 | 关键字段 |
|---|---|---|
| 插件 | `<DSH_HOME>/logs/web-companion-audit.jsonl`（轮转，512KB / 保留 1200 行） | `trigger`、`sessionMode`、`delivered`、`captureId`、`status`、`chars` |
| 扩展 | `chrome.storage.local['ag-audit']` 环形缓冲（200 条），`chrome.runtime.sendMessage({kind:'audit'})` 读 | `trigger`、`mode`、`domain`（**仅主机名**）、`code`、`ms` |

隐私是**结构性**的，不靠约定：两半都走 **allow-list**，不在名单上的键永远进不了文件/存储（`url`、正文、选区、密钥即使被传进来也没用），并有单测把 `LEAK-*` 值钉死。扩展侧 `domain` 只到主机名 —— 整条 URL 会把搜索词、文档 id、query 里的 token 一起带进去。写不进去时**自我禁用并报告，绝不弄坏抓取**。

单测：`tests/unit/audit-log.test.mjs`（23 断言）+ `tests/unit/audit-fields.test.mjs`（11 断言）。

### 3. 改名：设计早就宣布废弃，manifest 一直没改

`extension/manifest.json` 里逐字还是 `"name": "Antigravity Web Companion"` + `"default_title": "Antigravity Companion"`，`panel.html` 的标题同样是旧的，而设计 §6.1 早已写「旧名全部废弃、扩展名统一 `DSH Web Companion`」。改为用户指定的 **`DeepSeek 浏览器插件`**（manifest name / action.default_title / panel 标题）。

**扩展 ID 不变**：ID 由 `manifest.key`（钉死的公钥）决定，实测改名后探针仍报 `extension id=idpgkobbblmpmnonlndopijgfmehfmig`，所以 native host 的 `allowed_origins`、配对密钥、`chrome.storage` 全不受影响。顺带把 `host/paths.js` 里遗留的 `antigravity-bridge.log` 改成 `dsh-web-companion-bridge.log`。

### 4. 新增单测：直接跑那个手写 bundle

`tests/unit/client-attach.test.mjs`（25 断言）用假 `ctx` 直接加载 `dsh-plugin/lib/client.js`（桩掉 `window.__ModuleLoader__` / `WebSocket` / `document` / `location` / 定时器），断言：

- `sessionMode: 'new'` → 建了会话，但 **`sessions.open()` 0 次、`setDraft()` 0 次**，状态 `offered`，不 ack；
- `sessionMode: 'current'` → 照旧写进当前草稿并 ack `inserted`；
- 「引用」→ 切到该会话 + 插入 + ack；✕ → 不动草稿 + ack `dismissed`。

> 为什么必须补这层：`client.js` 是**手写产物** —— `dsh-plugin/package.json` 的 `build:client` 指向一个**并不存在的 `build.mjs`**（`src/client/` 目录也没有）。此前只有真 Chrome 探针能碰它，而探针跑的是**白盒 hook**，这正是真实链路缺陷能躲过全绿的原因。

### 5. 已知但本版未修（如实列出）

| # | 问题 | 证据 |
|---|---|---|
| a | **积压抓取永远投不出去**：`attach.js:84` 在无客户端时 `store.enqueue()`（响应如实写 `deliveredTo: []`），但 client 半发的 `request-pending` **在 host 侧没有 handler**（`grep request-pending dsh-plugin/src` 零命中），而唯一能 `drain()` 的 `GET /ag/pending` **全仓无调用者** | 设计 §5.1/§5.2 与此不符 |
| b | **审批策略 `never` 会让写操作"自动拒绝 + 甩锅给用户"**：插件 `approval.js` 的 `mode` 只看 `ctx.get('approval')` **存不存在**、不看策略；真实部署 3080 现在仍回 `approvalMode: "ask"`；而 DSH 侧 `dsh-user-approval/lib/invariant.js` 的 `decide()` 在 `never` 下直接 `return "rejected"`，`serviceAsk` 把它变成 `the user rejected tool "browser_click"` | `approval.js:31-51`、`dsh-tools/lib/index.js:3315-3348` |
| c | G1 仍未达标，且**不是常量**：台账记 2.09s，2026-09-12 实测 p50 **2743ms**（瓶颈仍是 iframe 内 DSH 应用启动） | `docs/reviews/perf-g1-g2.json` |
| d | 三份文档的提交数与设计图谱数字过期（台账 40 / HANDOFF 41 / PROGRESS 32+`v3.30`，实际 **43**；设计 §13.1 写 20 文件 246 节点，实际 89 文件 / 4206 边） | 已在本版一并订正 |

---

## v3.37 — 2026-09-11

**触发**：补完 E2E-7 的最后一格 —— 让**真实模型**调用 `browser_*`。结果顺带挖出两个真缺陷。

### 交付：真模型回合探针（`npm run probe:agent-turn`）

在活着的 DSH + 已连上的扩展里，**投递一条真实用户消息**（用 `inputActions.setDraft+submit`，不模拟输入框事件），然后断言三层都真的动了：

| 断言 | 结果 |
|---|---|
| 扩展侧收到 `tool-call`（模型真的调用了） | ✅ |
| 工具读到夹具页（回复里出现夹具标记） | ✅ |

路上把"发送用户消息"的真实调用形状**实证**出来（错误信息本身就是文档）：`conversation.send` 需要**会话作用域**（`ctx.sessions.scope(id).conversation`）；插槽的公开动作面暴露的是 **`submit`**，不是 `send`。

### 修掉的两个真缺陷

1. **`hub` 的 `ws.on('close')` 处理器被整块删掉了**（"清理调试日志"那一步的副作用，只剩 `error` 分支）。心跳的 `terminate()` 与对端干净关闭**都只触发 `close`** → 死亡 socket 永不从集合移除、集合还会无限增长。这些僵尸收得到**广播**的 ping，却吞掉**只发给某一个**的工具调用，模型看到的是 "The extension timed out" —— 一个把人往"超时/性能"方向带偏的错误。
2. **`callAgent` 盲取 `[...sockets.agent][0]`**：即使没有僵尸，一个"回心跳但不回调用"的 socket 也会被选中。改为按 `lastSeen` 排序 + **首次超时即标记可疑并换下一个候选**（总预算不变），把半开连接从"失败"降级为"稍慢的成功"。

### 新增单测（`tests/unit/agent-selection.test.mjs`，6 断言）

真 hub + 真 loopback WS 对：唯一 agent 正常应答；**陈旧 socket 存在时调用仍须成功**；只剩哑 socket 时给明确 `E_TIMEOUT`（不许假装成功）；连接后计数为 1、断开后归零；零连接 → `E_EXT_OFFLINE`。

> 这个单测的价值就是它当场否掉了我的第一个修法：只按 `lastSeen` 选仍会选中"回心跳不回调用"的 socket。

### 探针隔离（同批跑才暴露出来的）

`probe:all` 第一次把 8 个探针串起来跑，两个挂了 —— 根因不是产品，是**探针互相污染**：

- `probe:look-left` 曾向插件谎报 `workspace: '/tmp/probe-workspace'`；插件把**最近一次 client hello 的 workspace** 记成落盘目标，于是后面的 `probe:capture` / `probe:look-left-e2e` 的文件落到了那个假目录（内容断言仍然通过，只有"新增文件数"挂了）。修法：探针不再谎报 workspace，插件退到配置默认值。
- 顺带把断言改成以**回复里的 `filePath`** 为准（落盘事实），不再假定某个工作区目录；`panel.js` 的 `intent` 探针记录也带上 `filePath`。
- 我自己在 v3.33 插入断言时还制造了两处 `ReferenceError`（引用了尚未定义/名字取自 record 标题的变量），同批跑才暴露 —— 已修。

**修完重跑 `probe:all`：8/8 全绿**（debugger 43s / look-left 5s / capture 10s / sites 54s / m3-ops 53s / m3-control 23s / look-left-e2e 27s / agent-turn 69s）。

### 探针稳定性（诚实记录，未粉饰）

随后两次重跑各出现 1 个失败，全部落在 `probe:look-left-e2e`，**根因都是我自己的断言写法**，与产品无关：

1. "`__AG_LAST_ATTACH__` 等于探针记录的那一次"—— 多次 attach 时"最后一次"未必是"第一次记录的"，这是**竞态断言**。改成断言真正的要求：**落盘那份文件的引用进了输入框**（`applied.fileRef` 相等 **或** 草稿里出现该文件名）。
2. 改完后我又把该断言插在 `draftAfter` **定义之前** → TDZ `ReferenceError`。移到位后单跑通过。
3. `capture-probe` 的 `chipHostedBySlot` 同理：胶囊是异步出现的，读一次快照就是测竞态。硬断言收窄为**"永不回退到 DOM 宿主"**（出现就必须来自插槽），数量/宿主改为观察值；"出现与撤销"由 `probe:chip` 覆盖。

**当前状态**：修完后**连续两次 `probe:all` 全绿（8/8 + 8/8）** —— 批量跑稳定，探针顺序无关。

### 方法论备注

`__AG_PANEL__`（面板上下文）与 `__AG_CLIENT__`（DSH iframe 上下文）**不在同一个执行上下文**里：跨进程 iframe 是独立 CDP target，`Runtime.executionContextCreated` 也只在**它自己的会话**上投递。探针第一版在错误的上下文里查字段，把"通道已连接"读成了 false —— 已在注释里写死这两个坑。

---

## v3.36 — 2026-09-11

**触发**：G2 整页截图的失败模式 —— 超长页面会产出巨大 PNG，最终被帧预算丢弃，工具以 `E_STORAGE` **硬失败**。

### 变更

`Page.captureScreenshot` 改为**带高度上限的裁剪**：先 `Page.getLayoutMetrics` 取内容高度，超过 **12000 CSS px** 就按上限裁剪，并在返回值里如实带 `clipped: true` / `clippedAtPx` / `contentHeight`；工具 schema 同步这三项。

**为什么是"带说明的成功"而不是硬失败**：截断的图 + 真实高度让调用者能自己决定"要不要分段截"，而 `E_STORAGE` 只告诉他"失败了"。同一个上限还顺带把耗时拉回目标内。

### 实测（`npm run probe:perf`，页高 15288px）

| 项 | 修前 | 修后 |
|---|---|---|
| 整页截图 p50 / p95 | 1780ms / 1865ms | **1494ms / 1512ms**（目标 1500ms） |
| 超长页面行为 | `E_STORAGE`（工具失败） | `ok:true` + `clipped:true` + `clippedAtPx:12000` + `contentHeight:15288` |
| 视口截图 | 94ms（曾因 fullPage 标志被忽略而误走整页） | 97ms / 214KB，语义正确 |

`probe:m3-ops` 增加契约断言：超限时必须带 `clipped` 且有像素（在 `probe:all` 里回归）。

---

## v3.35 — 2026-09-11

**触发**：G1 未达标 —— 先判断"能不能优化"，而不是先动手改。

### G1 三段分解（新增测量）

| 阶段 | 耗时 | 说明 |
|---|---|---|
| `/ag/enter` 握手（303 + `Set-Cookie`） | **2ms**（p50） | 授权链路不是瓶颈 —— 这条先排除掉 |
| 本插件外壳（面板文档 + iframe 建立） | **~750ms** | 633ms 面板文档启动（无头下偏慢）+ 116ms iframe 建立 |
| iframe 内 DSH 应用启动 | **~1.34s** | 应用根节点 638ms → DOM complete 1511ms → **composer 2077ms** |

**结论（诚实）**：G1 目标 1500ms 在当前形态下达不到，主因是 **DSH web 应用在新建 iframe 内的首屏启动**（bundle 加载 ~0.75s + 渲染到 composer ~0.55s），不是本插件的授权链路或抓取逻辑。所以这件事的下一步是**决策**而非纯实现：要么把 G1 拆成两档（外壳 ≤0.8s、等待应用 ≤2.5s），要么由 DSH 侧优化首屏、或接受"预热 iframe"这一额外成本。**目标值我没有偷偷改。**

### 顺带记录

视口截图那一次的 p95 冲到 605ms（p50 94ms）：原因是同一轮测量里前一次调用刚创建过新的 fixture 标签页，首次截图的合成器尚未预热。样本量小（5 次）时这类抖动会进入 p95 —— 报告里保留原始序列，不粉饰。

---

## v3.34 — 2026-09-11

**触发**：M4-4 —— 设计文档 §1.2 的 G1/G2/G6 一直挂着 `【目标·未测】`。这次把它们变成数字（`npm run probe:perf`），**不达标也照实记录**。

### 实测结果

| 指标 | 目标 | 实测 | 判定 |
|---|---|---|---|
| G1 侧边栏热启动（DSH 在跑 → composer 可输入） | p50 ≤ 1500ms | **p50 2074ms** | ❌ 未达标 |
| G1 分解 | — | 面板文档 585ms → iframe target 691ms → **composer 2074ms** | 约 1.38s 在 **iframe 内 DSH 应用启动**，本插件侧 ~0.7s |
| G2 正文·轻量页 | p50 ≤ 300ms | **66ms**（p95 94ms） | ✅ |
| G2 正文·标准页（~120KB） | p95 ≤ 800ms | **92ms**（p95 533ms） | ✅ |
| G2 视口截图 | p95 ≤ 1500ms | **94ms**（p95 118ms，214KB PNG） | ✅ |
| G2 整页截图（debugger） | 同上（设计按视口定义） | **p50 1764ms / p95 1861ms** | ⚠️ 超目标 |
| G6 打包体积 | ≤ 1024KB | **127KB** | ✅ |

诚实边界写进报告：无头 Chrome、本机回环、同机；**基线而非承诺**。G6 另外两条（0 常驻进程、流量限 `127.0.0.1`）成立；且我们**没有**引入 Readability/turndown/DOMPurify（自写抽取器 ~20KB）。

### 测量顺手抓出的真缺陷

**`browser_screenshot` 忽略调用者的 `fullPage` 标志**：开了「浏览器控制」后，即使请求视口截图也走 `Page.captureScreenshot{captureBeyondViewport:true}` → 返回整页大图、1.8s。改为按 `fullPage` 决定内容、按运行期开关决定**手段**（debugger 只是绕开 2 次/秒限流、支持后台标签页）。修后视口截图 **94ms**。一个"调用者设了但我们忽略"的标志，比没有这个标志更糟。

### 下一步（写进设计文档的"下一步"栏，不留在脑子里）

- G1：预加载 iframe（面板首次打开即预热）或与 DSH 侧核对首屏路径 —— **目标值不动**。
- G2 截图：把"含截图"拆成视口/整页两档指标，或对整页截图加高度上限。

---

## v3.33 — 2026-09-11

**触发**：M4-1 —— 胶囊从"往页面里塞 DOM"改成"用 DSH 自己的插槽"，以及 M4-3 的自动化分层。

### M4-1 胶囊走 `conversation.input.dock` 插槽

`ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name, id: 'dsh-companion-chips', order: 30 }, CaptureDock))`。

契约是**读 shell 源码 + 官方 slot ledger 取证**的（不是试错出来的），其中三条最容易踩：

1. **组件是第二个位置参数**（`register(options, component)`），写在 options 里的 `component` 会被静默丢弃；组件返回 **React 元素**，`react` 是平台种子模块 —— 自带 React 会造出第二份 React，hooks 直接崩。
2. **必须用 `inject` 包一层**：直接注册尚未声明的插槽会抛 `slot "…" is not declared (a parent entry's children table must declare it)`；`inject` 会等声明出现，并在声明坍塌后**重跑回调**（所以回调必须可重入）。
3. list 槽必须给 `id`；排序 `priority` → `order`（都默认 0）；**同 `(id, priority)` 重复注册会抛错**。

**DOM 条带保留为兜底**（`inject` 只保证等声明，不保证声明一定来）：`__AG_CLIENT__.chips()` 每项报告 `host: 'slot' | 'dom'`。

**实测**：`probe:capture` → `chips[0].host === "slot"`；`probe:chip`（M0b 胶囊生命周期）→ 插入 `host: slot`、草稿含引用、`ack: inserted`、✕ 后胶囊消失 + 草稿清理 + `ack: dismissed`。

### M4-3 自动化分层（`docs/10-automation.md` + `npm run probe:all`）

- **第 0 层**（纯静态、无 Chrome/无 DSH）：`npm run check` 一条命令 = 协议一致性 + 19 条反模式规则 + 6 个单测文件 + 构建 + 体积门禁。
- **第 1 层**（要 DSH，不要浏览器）：`npm run audit:captures`、`/ag/ping` 自检。
- **第 2 层**（要 Chrome，不要人）：`npm run probe:all` —— **自己拉 dev 实例**，按顺序跑 7 个探针，汇总表 + 非零退出码；只杀自己拉起的实例，绝不碰用户正在用的那个。
- **第 3 层**（必须由人）：用户手势（授权弹窗三分支）、有头 UI 判断（调试横幅、审批弹窗）、品味判断（内容够不够好）。

**实测 `npm run probe:all`：7/7 全绿**（debugger 43s / look-left 5s / capture 10s / sites 54s / m3-ops 53s / m3-control 23s / look-left-e2e 27s）。

---

## v3.32 — 2026-09-11

**触发**：修掉"没选中却点「Attach 选区」静默抓整页"—— 我先前只是**问了**要不要改，按纪律这类可逆小修应当直接做。

### 变更

| 位置 | 变更 |
|---|---|
| `extension/src/sw/capture.js` | 选区模式无选区 → 抛 `E_NO_SELECTION`，**不再回退整页**（旧行为让用户以为抓的是选区，实际塞进整页） |
| `extension/src/sidepanel/errors.js` | **新增**：把错误码翻译成"你该做什么"的纯函数（从 panel.js 抽出），覆盖 E_NO_SELECTION / E_NO_WORKSPACE / E_DSH_DOWN / E_READONLY / E_EXT_OFFLINE / E_TARGET_BUSY / E_TIMEOUT 与三种权限消息 |
| `tests/unit/panel-errors.test.mjs` | **新增** 11 断言：每个已知码都给出可操作提示；未知码原样透出；缺 message / undefined 不崩 |

### 实测

- `npm run test:panel-errors` 11/11；
- `npm run probe:capture` 新增 `emptySelection` 断言：`{refusedWithCode: true, noFileWritten: true, swMessageStatesFact: true}`（明确失败 + **不产生文件**）；
- 选区正常路径不受影响（`hasSelectionBlock` / `markdownIsSelectionOnly` 仍为 true）。

### 分层教训（写进断言名）

探针第一版断言"SW 返回的消息里应出现『选区』"→ 失败。原因不是缺提示，而是那句话**属于面板层**：SW/ops 只说事实，面板负责翻译。修正后两层各查各的，把口径写进断言名（`swMessageStatesFact`），避免以后再互相错怪。

---

## v3.31 — 2026-09-11

**触发**：M4-2 多站点抓取质量回归 —— 只有把"五类页面"固定下来，噪音启发式改一处才不会在另一类页面上悄悄误删。

### 交付

`tests/quality/probe-sites.mjs`（`npm run probe:sites`，真 Chrome）：五类页面（文档站 / 新闻 / 政务站 / SPA 控制台 / 论坛），夹具是 `tests/quality/sites/*.html` 本地固定 HTML，**不依赖外网** → 可进 CI、不因站点改版随机失败。每类同时断言"该清的清了"与"该留的留着"（所以既能抓漏删、也能抓误删）。

### 首轮抓出的两个真缺陷（都是"看代码看不出来、跑夹具才暴露"）

1. **引用生成的 Markdown 形状非法**：`<blockquote><p>…</p></blockquote>` 被渲染成孤立的 `>` + 空行 + 正文 —— **内容没丢，但语义丢了**（渲染器会当成空引用 + 普通段落）。改为真正的引用语法：逐行加 `>`、空行也带 `>`、去掉首尾多余引用行，多段引用仍是同一个引用块。
2. **`Load more` 不在操作标签名单里**：`ACTION_LABELS` 有 `read more`/`show more`/`more`，独缺 SPA 里最常见的 `load more`。已补。

同时把这轮的方法论固定进探针：**内容断言与形状断言分开**（`keep` 查内容、`extra` 查 Markdown 形状），避免把"形状不对"误报成"内容丢失"。

### 实测

`npm run probe:sites` → **16/16 全绿**（5 类页面 × 抓取成功/正文完整/噪音清除 + 1 条引用形状）。

---

## v3.30 — 2026-09-11

**触发**：README 里那句"多站点抓取质量仍有风险"不该是拍脑袋的 —— 需要一个用**真实产物**说话的工具。

### 交付

| 文件 | 内容 |
|---|---|
| `tests/quality/audit-captures.mjs`（`npm run audit:captures`） | 审计真实抓取文件：分类 chip / 标签页 / Read more / trailing stats / 占位锚点 / 密集短链接列表 + 结构完整性（H1、段落数、短链接占比），输出表格或 `--json` |
| 抓取文件记录构建版本 | `AttachRequest.extVersion` → front-matter `sourceVersion`（扩展版本）。**没有这个字段，审计无法区分"旧构建的产物"和"当前构建的回归"** —— 这正是首次审计时暴露的缺口 |

### 首次审计结果（用户的真实文件）

| 文件 | 构建 | 噪音 | 明细 |
|---|---|---|---|
| 三份 NotebookLM/ClawHub（16:19/16:32/16:34） | 旧（v3.20 之前） | 各 20 | `readMore:1, tabStrip:1, trailingStats:18` |
| apexnc（22:23） | 旧（v3.29 之前） | 2 | `placeholderAnchor:2`（就是今天修掉的那两条 `- [A](…#)`） |

结论：两处噪音**都已在 v3.20 / v3.29 修掉**，而这份审计成为它们的长期回归信号。同时它诚实标注：没有 `sourceVersion` 的文件是旧构建产物，噪音高**不代表**当前回归。

### 工具自身的一个 bug

第一版路径解析把绝对路径当 base 又拼了一次 `dir`，三个候选全不存在 → 静默输出"没找到文件"（看起来像"目录里没东西"）。已修，并且它现在对"目录存在但没匹配文件"和"目录不存在"给不同信息。

---

## v3.29 — 2026-09-11

**触发**：M4 起步 —— 补齐项目级交付物，并处理真站抓取质量问题。

### 交付

| 文件 | 内容 |
|---|---|
| `README.md` | 项目入口：能做什么（每条挂实测证据）、快速开始、安全模型（三道闸门 + 保留策略）、测试命令、目录结构、**已知限制** |
| `docs/09-manual-checklist.md` | 人工验收清单（**只列自动化做不了的**）：授权弹窗允许/拒绝/撤销三分支、调试横幅与审批、连续「看左边」、抓取质量判断、自动拉起与保留策略现场验证；每项带"失败时怎么办" |

### 抓取质量：两处真问题（都由探针抓出来）

1. **占位锚点未清理**（新增启发式 D）：真站抓取里出现 `- [A](https://…/#)` 这类"1–2 字 + 纯页内锚点"的列表项（apexnc.org 实测 2 条）。规则刻意很窄：只删「整项文本 = 1–2 字」且「href 是 `#`/同页锚点」的项；短标签但真跳转的链接、以及带正文的条目都不动。
2. **chip 行阈值过宽（24 → 12 字符）**：新探针暴露出连坐删除 —— 一份真实链接列表里 `[Go]`、`doc/2` 这类短标签/中等标签条目被当成 chip 一起删掉。收紧到 12 字符后，链接列表保留、而分类 chip（`Knowledge`/`Automation`）与标签页（`SKILL.md`/`Files`/`Versions`）仍被清掉（后者的 `Stats & details` 由规则 B 的显式名单覆盖），原有四条噪音断言全绿不变。

### 实测

`npm run probe:capture`：`placeholderAnchors: {bareAnchorJunkGone: true, realShortLabelKept: true, proseWithShortAnchorKept: true, longDocLinksKept: true}`，且 `fileChecks` 原有噪音项全部保持。

---

## v3.28 — 2026-09-11

**触发**：M3 收尾第二项 —— 设计里承诺的"写操作开启后受审批"，落到真 seam 上。

### 契约（读源码得来，非猜测）

`dsh-tools` 的执行前闸门是 cordis **waterfall**：

```js
ctx.waterfall(carrier, 'tools/pre-execute', exec, () => Promise.resolve({ kind: 'allow' }))
```

监听器签名 `(exec, next)`，**不调用 `next()` 就等于否决**；返回 `{ kind:'ask', reason }` 会把决定权交给 `ctx.get('approval')`（`approval.request({agent, toolName, callId, reason, signal})` → `allowed-once` 放行，`rejected`/`cancelled`/其它 deny）。没有审批服务的部署会把 `ask` **降级为 deny** —— 这正是必须如实报告 mode 的原因。

### 实测

| 检查 | 结果 |
|---|---|
| `npm run test:write-gate`（20 断言） | ✅ 非浏览器工具原样放行；写工具在开关关闭时 deny 且理由点名开关；有审批服务时三个写工具都走 `ask`；无审批服务时 `switch-only` 且开关打开即放行；`approvalForWriteOps=false` → `off`；缺 `next` 时不静默否决 |
| 真进程 `/ag/control` | ✅ 返回 `approvalMode: "ask"`（**本机部署确实带审批服务**）+ 8 个工具 |

### 结论（对用户可见的行为）

打开「写操作」后，模型每次 `browser_click` / `browser_type` / `browser_navigate` 都会先在 DSH 界面里向你请求批准 —— 三层闸门：不注册（关时）→ 扩展复核 → 逐次审批。

### 单测自身的又一次"假绿"

第一版桩把 `writeEnabled` 写成常量 `() => true`，于是"关闭 → deny"三处断言永远测不到（也永远不失败）。改成可变开关后才真正覆盖。

---

## v3.27 — 2026-09-11

**触发**：M3 收尾 —— 让「写操作」成为**用户的一次点击**，而不是"改 YAML + 重启 DSH"。

### 为什么这算 M3 的一部分

`allowBrowserWriteOps` 决定写类工具**是否存在**（默认 false 时不注册，模型看不见 —— 比"注册后拒绝"强）。但如果只能靠改 `cordis.patch.yml` 才能打开，安全默认就等于永久只读，功能形同没做。

### 交付

| 位置 | 变更 |
|---|---|
| 协议 | `ROUTE.control = /ag/control`（路由表源头在 `protocol/codegen.mjs`）+ `ControlRequest` / `ControlResponse` 两个消息定义 |
| 插件 | `routes/control.js`；`index.js` 把工具注册变成**可重注册**（`applyTools()` 先 dispose 旧的再按当前开关注册），`state.applyControl()` 翻转并返回新能力集；无 key 或非法 body 分别 403 / 400 |
| 扩展 | `extension/src/lib/urls.js` 增 `controlUrl()` / `pairingKey()`；面板新增「写操作」开关（红色、默认关、说明它让 Agent 能点/输入/导航） |

### 实测（`npm run probe:m3-control`，真 Chrome + 真 dev 实例，10/10）

- 面板「写操作」开关可见；点击后面板探针确认 `writeOps=true`；
- **插件即时**把工具集从 5 个扩到 8 个（含 `browser_click` / `browser_type` / `browser_navigate`），**全程无重启**；再点回去又回到 5 个 —— 写工具是**从注册表消失**，不是被拒绝；
- 无 key → 403；`{"allowBrowserWriteOps":"yes"}` → 400（schema 校验拦下）；两次非法请求都没改变状态。

### 方法论备注

第一版我把控制面断言"顺手塞进" `ops-probe`，还留了一段 `note: 'placeholder'` 的占位代码 —— 删掉了。控制面需要真实 DSH 实例，而 `ops-probe` 刻意不依赖 DSH；混在一起会让一个探针的通过掩盖另一个探针没跑。拆成两个探针，各自的前提写在自己的文件头。

---

## v3.26 — 2026-09-11

**触发**：继续 M3（用户：「你继续做吧」）—— 把 `browser_*` 反向控制从设计变成已验证的两层实现。

### 交付

| 层 | 内容 |
|---|---|
| 协议 | 新增 `AgentToolCall` / `AgentToolResult`（`/ag/agent` 上的请求/响应） |
| 桥接插件 | `hub.callAgent()`：**关联在 hub**（它拥有 socket），掉线即把在途调用全部以 `E_EXT_OFFLINE` 失败；`tools.js` 用 `ctx.tools.register(defineTool(...))` 注册 8 个 `browser_*`；写类**不注册**（`allowBrowserWriteOps=false` 时模型看不见）；`/ag/ping.capabilities` 反映已注册工具 |
| 扩展 ops | `sw/ops/index.js`（read/tabs/wait/screenshot/ax/click/type/navigate）+ `sw/ops/debugger.js`（AX 树、盒模型定位、可信点击/输入/按键、整页截图）；两条路径**如实标注** `trusted` |
| 扩展 UI | 面板新增「浏览器控制」开关（ADR-12 的运行期 opt-in；关闭即 `detachAll` 释放调试器） |
| 帧预算 | 新增 `lib/frame-budget.js`：截图 base64 在预算内**保留**、超限才带原因丢弃 |
| 测试 | `tests/m3/ops-probe.mjs`（真 Chrome，31 断言）、`tests/m3/debugger-probe.mjs`(14)、`tests/unit/browser-tools.test.mjs`(31)、`tests/unit/frame-budget.test.mjs`(16) |

### 实测

| 检查 | 结果 |
|---|---|
| `npm run probe:m3-ops` | ✅ 31/31：只读 5 项可用；未授权写操作 `E_READONLY`；**非可信点击真的改变页面**（clicks+1）且 `trusted:false`；开开关后**可信点击真的触发 onclick**、可信输入 append/replace 双语义、返回坐标；`ax` 有 role/name 节点；`screenshot` >1KB 整页 PNG；`navigate/wait/tabs` 形状正确；`wait` 超时 `E_TIMEOUT` |
| `npm run test:browser-tools` | ✅ 31/31：**声明 schema 接受实现返回值**（同一份 `validateJsonSchemaValue`）；写工具按开关注册；失败是 `{code,message}`；截图落 `网页捕获/assets/` 且旧截图被同一保留策略清掉 |
| `/ag/ping.capabilities`（真进程） | ✅ 默认 `[browser_read, browser_tabs, browser_wait, browser_screenshot, browser_ax]`；临时把 `allowBrowserWriteOps: true` 写进 dev 配置重启后变 8 个（含 3 个写类），验证后已还原 |
| `npm run test:unit` | ✅ tickets + retention(19) + frame-budget(16) + browser-tools(31) |

### 过程中修掉的三个真缺陷（都是"两层各自看着都对"的接缝问题）

1. **截图像素被无条件丢弃**：`agent-channel` 第一版删掉所有 `base64`，于是 `browser_screenshot` **结构性不可能成功**（插件只会看到 `E_STORAGE: extension returned no pixels`）。改为帧预算内保留、超限带原因拒绝。
2. **保留策略不认截图命名**：`sweepCaptures` 只认抓取名，`网页捕获/assets/*.png` 会无限膨胀 —— 正是保留策略要防的那件事，只是换了个子目录。新增 `ASSET_FILE` 规则。
3. **可信输入的追加语义不可靠**：`Input.insertText` 落在**插入点**，点击落点可能把光标放在文本中间（实测）。改为先用脚本定位光标/选中、再走可信插入，append 与 replace 成为确定语义。

### 单测自身的两处"假绿"（一并修掉，否则上面的成绩都不算数）

1. `validateJsonSchemaValue` 返回的是**违规数组**（空数组=通过），第一版按 `.ok` 读 → 永远 false，被"或上 `includes('"code"')`"的宽松写法掩盖；
2. 桩函数只认 `{reply}` 包装，喂原始帧时返回 `undefined` → 走**错误分支** → 恰好被 `oneOf` 的错误变体接受，于是"schema 接受实现返回值"全部是空断言。修法是让断言同时要求 `value.code === undefined`（必须是成功值）。

### 平台/契约要点（已写入 docs/03 §6）

DSH 的 output schema **强制**每个 object 显式声明 `additionalProperties`；`required` 写在属性里；`defineTool` 从 `@deepseek-ai/dsh-tools` 导入（0.1.2-rc.1，须与运行时同版本）。

---

## v3.25 — 2026-09-11

**触发**：用户实测提出 —— 抓取会在工作区 `网页捕获/` 里持续生成 `.md`，**没有任何东西会删它们**。

### 策略（已实现并现场验证）

**每次落盘后清扫同一目录**，删除**严格老于 `retentionHours`（默认 24h）**的文件；只挑**本插件命名**的文件（`yyyy-MM-dd-HHmm-<slug>-<id6>.md` 与崩溃残留的 `.tmp`），**用户自己放进该目录的文件永不删除**（计入 `kept`）。

三个取舍写清楚，免得后来者"顺手改成定时器"：

1. **落盘时清扫，不用定时器**：插件保持零后台工作，代价只在实际产生文件的那一刻付；一个不抓取的会话不付任何成本。
2. **按名字白名单**：抓取目录是用户可见的普通目录，不能用"目录里所有旧文件"作为删除依据。
3. **按 mtime 判龄**：复制/恢复/改名后 mtime 仍是真的；报告里同时带 `ageHours` 便于日志追溯。

### 交付

| 位置 | 变更 |
|---|---|
| `dsh-plugin/src/host/retention.js` | 新增 `sweepCaptures(dir, {retentionHours, now, log})`；导出 `CAPTURE_FILE` / `TEMP_FILE` 规则 |
| `dsh-plugin/src/host/store.js` | `write()` 成功后调用清扫（放在写之后，保证不与写入竞争，且刚写的文件 mtime=now 永不入选）；返回值新增 `pruned`/`prunedFiles`（**只供内部与日志**，不进 `/ag/attach` 响应体，避免破坏扩展侧 schema 校验） |
| `dsh-plugin/src/host/index.js` | 新配置 `retentionHours`（默认 24，`0`/负数关闭） |
| `tests/unit/retention.test.mjs` | 新增 19 条断言：删旧的/留新的/留用户文件/不递归子目录/`.tmp` 清理/`0` 关闭/目录不存在不抛错/未来时间戳不误删/±1s 边界 |
| `tests/m2/capture-probe.mjs` | 现场断言：埋入 25h 前的抓取文件与一个用户文件 → 真捕获一次 → `{stale25hRemoved: true, userFileKept: true}` |
| `package.json` | `test:unit` 现在跑 tickets + retention（两个文件） |

### 顺带记录的平台事实

macOS/APFS 的 mtime 是**纳秒精度**，用毫秒精度的 `Date` 调 `utimesSync` 会存成 `….999ms` —— 于是"恰好 24h"实际比 cutoff 早约 **1µs**，第一版单测因此出现"假失败"。断言改为 ±1s 边距，比较符语义（`>=` 保留 / `<` 删除）写进断言名。

---

## v3.24 — 2026-09-11

**触发**：你在 chrome://extensions 里看到 Chrome 的告警 —— `Permission 'debugger' cannot be listed as optional. This permission will be omitted.`

这不是配置笔误，是**平台规则**，直接推翻了 M3 计划里"`debugger` 作为可选权限、运行时申请"的那一步。

### 实测（同一扩展、两种声明，逐字对比）

| 声明方式 | SW 内 `typeof chrome.debugger` | `permissions.contains` | attach 全链路 |
|---|---|---|---|
| `optional_permissions: ["debugger"]` | **`undefined`**（能力整个消失） | 无从发起 | 不可用 |
| `permissions: [..., "debugger"]` | `object` | `true` | ✅ AX 树 15 节点（含 button/heading）、`Input.dispatchMouseEvent` **真的触发** `onclick`、`Input.insertText` 进输入框（须先点焦点）、`Page.captureScreenshot` 14KB PNG |

### 决策（ADR-12）

**`debugger` 放进必需 `permissions`；"opt-in" 从"权限层"下沉到"运行期"**：默认不 attach，微壳里显式打开「浏览器控制」+ 站点白名单才 attach，写操作仍受 DSH 侧审批。代价必须明说：安装/重载会出现不可消除的权限提示，attach 期间有「正在调试」横幅——竞品同样如此（ChatGPT / Claude 扩展都把 `debugger` 放必需权限）。被否决的替代：放弃 debugger 改用 `scripting` 合成事件 —— 拿不到**可信输入**与 AX 树，M3 退化为 DOM 模拟，不满足 E2E-7。

### 交付

| 位置 | 变更 |
|---|---|
| `extension/manifest.json` | `debugger` 移入 `permissions`；删除 `optional_permissions`（Chrome 的告警来源） |
| `tests/m3/debugger-probe.mjs` | 新增 M3 能力前置探针（14 断言，`npm run probe:m3-debugger`）→ `docs/reviews/m3-debugger-probe.json` |
| 文档 | 设计文档 §4 ADR-12、§9 权限表与降级矩阵 T8、§11.1 速查表、M3 里程碑；`docs/02-extension.md`、`docs/07-implementation-plan.md`、`docs/08-security.md` |
| 门禁 | 一致性规则第 19 条 `optional-debugger-permission`（禁止把 debugger 写回 optional） |

### 探针自身修正（三处断言失真）

1. `getTargets()` 的 `attached` **包含 CDP 自身连接**（实测 `before=1`）→ 占用判断只能看增量；2. `Input.insertText` 打到**当前焦点**元素，不先点焦点则静默无效（这是 M3 `type` 的接线要点，不是探针瑕疵）；3. `permissions.getAll()` 用布尔断言取 `permissions.includes('debugger')`，避免字符串化形状的坑。

### 顺带记录的 M3 接线要点

`chrome.debugger.sendCommand()` 返回的是 **CDP result 本体**：`Runtime.evaluate` 的取值在 `.result.value`（不是 `.value`）。这与 v3.23 的 `validateAs` 是同一类"契约形状"坑，已在同一份探针里固化为断言。

---

## v3.23 — 2026-09-11

**触发**：把「看左边」的**最后一跳**接通 —— 之前止步于桥接插件收到 intent。

### 交付（代码）

| 位置 | 变更 |
|---|---|
| 协议 | 新增 `AgentHello`、`CaptureRequestEvent`（桥接插件→扩展）、`CaptureResultEvent`（扩展→桥接插件）；`oneOf` 收录，三份生成物同步 |
| 桥接插件 | 注册 `WS /ag/agent`（F3 形态鉴权，见 §5.4）；`hub` 支持 agent 推送/计数/连接回调；`relayIntent()` 把 client 的 `intent` 组成 `capture-request`，agent 不在线时进**独立 intent 队列**，连接后补发（`reason: queued`）；`capture-result` 只记日志 |
| 抓取落点 | `trigger === 'look_left'` → `sessionMode: 'current'`；按钮路径保持默认 `new` |
| 扩展 | 新 `sidepanel/agent-channel.js`：面板文档持有 WS、`agent-hello`、20s 心跳、指数退避重连、`capture-request` → 复用面板既有 `runCapture`、异常兜底回执 |
| 抓取目标 | `activeTab()` 拒绝把**自身界面**（`chrome-extension://<自己>`、DSH 自身 origin）当目标，按 `lastAccessed` 回退到最近使用的普通网页；无候选 → `E_TARGET` |
| 面板 | 无手势路径不再"先问权限再抓"（`permissions.request` 无手势必抛）——直接抓，让浏览器给答案，失败再映射成可执行的提示 |
| 探针 | `__AG_PROBE_WRITE__` 支持 `{keep:true}`；面板新增 `__AG_PANEL__` 白盒探针（`agentConnected/frames/intents`） |

### 实测

| 断言 | 结果 |
|---|---|
| `probe:look-left`（桥接跳，11 条） | ✅ 全绿：入队/补发、在线直推、失败回执后存活、错误 key 403、抓取推送未被队列吞掉 |
| `probe:look-left-e2e`（全链路，16 条） | ✅ 全绿：无 `<all_urls>` 授权下面板建链 → 嗅探 → 转发 → 抓取落盘（`trigger: look_left`）→ 回推 → 胶囊 + 引用写入 → `sessionMode=current`/`switched=false` |
| `probe:capture` 回归（按钮路径） | ✅ `sessionMode: "new"`、`shellSwitched: true`；选区/整页/硬化断言全绿（硬化断言此前因读错文件恒为 `null`，已修正） |

### 过程中定位并修掉的真缺陷

1. **`validateAs()` 契约误用（致命且静默）**：生成的校验器成功时只返回 `{ ok: true }`，没有 `value`。`agent-channel.js` 写成 `validated.value.requestId` → `TypeError` → 面板抛错、桥接插件永远等不到回执 → 整条意图链路"看起来没反应"。修法：改用传入的 frame 本体；新增一致性规则 `validateas-value-misuse`（第 18 条）防复发；异常路径无条件回 `capture-result(ok:false)`。
2. **自身界面被当作抓取目标**：面板作为标签页被激活时，意图路径 100% `E_NO_PERMISSION`，且提示误导用户去授权。修法见上表"抓取目标"。
3. **探针自身两处失真**：①E2E 未等 client 半通道就绪就写草稿（嗅探器还没启动 → 假阴性）；②`__AG_PROBE_WRITE__` 900ms 后恢复草稿，与 800ms 嗅探轮询**赛跑**（靠运气通过）→ 新增 `{keep:true}`；③`capture-probe` 的硬化断言引用了不存在的变量，恒为 `null`（"绿的但什么都没验证"）。

### 顺带澄清

- 「看左边」在**哪个会话**落地：用户是在当前会话里打的这句话，所以附件回到**当前会话**（`current`），不新开；按钮路径保持"默认新开会话"（v3.21 用户提议）。

---

## v3.22 — 2026-09-11

**触发**：竞品调研后的第一批优化 —— 抓取硬化 + 划词入口。

### 交付

| 组件 | 说明 |
|---|---|
| `extract.fn.js` 硬化 | ①**URL scheme 白名单**：链接仅保留 `http/https/mailto/tel` 与相对路径（拒绝 `javascript:`/`vbscript:`/`file:`/`blob:`），图片额外允许 `data:image/*`（拒绝其它 `data:`）②**隐形字符清理**：零宽/双向控制/`\uFEFF` 全部剔除、`\u00A0` 归一为空格（提示注入载体） |
| 划词入口 | 面板新增 **「Attach 选区」** 按钮（`mode: selection`）；`capture.js` 已有的选区分支复用同一编排 |
| 右键菜单 | 新 `contextMenus` 权限 + `src/sw/menu.js`：**Ask DSH about this page** / **Ask DSH about selection**；点击即用户手势 → 顺带 `sidePanel.open()`，因此不依赖工具栏图标 |

### 实测（`tests/m2/capture-probe.mjs` + 直接校验产物）

| 断言 | 结果 |
|---|---|
| 选区模式 | ✅ 选中段落 → `mode: selection` 抓取 → 文件含 `**用户选区**` 块、**正文仅为选区**（不含 `小节标题`/`要点一`）、`chars: 282` |
| `javascript:` 链接剔除 | ✅ 整页抓取文件内 `javascript:alert` 出现 **0** 次 |
| 隐形字符清理 | ✅ 零宽字符已从 `KNOW\u200bLEDGE` 剔除 |
| `data:image/*` 保留 | ✅ 内联 PNG 仍在（相对链接同时已绝对化） |
| 新会话默认 | ✅ 仍为 `newSessionCreated/targetIsFreshSession/shellSwitched` 三项 true |
| 体积 | 45.5 KB（仍在 G6 内） |

顺带修正探针自身一处误判：硬化断言原先读"最新文件"，而在选区用例之后最新的是选区文件 → 改为明确读取**整页抓取**那份。

---

## v3.21 — 2026-09-11

**触发**：用户提出"attach 应默认新开会话"（同意并实现）。

### 交付

| 组件 | 说明 |
|---|---|
| 协议 | `ClientAttachEvent` 增加 `sessionMode`（`new` / `current`）；codegen 三端同步 |
| 插件 | 配置 `attachSessionMode`（**默认 `new`**），随 attach 事件下发 |
| client 半 | `openFreshSession()`：把**页面上报的 cwd** 匹配到工作区注册表拿 **workspaceId**（不是路径）→ `sessions.create({workspaceId})` → `sessions.open(id)` 尝试跳转；插入与胶囊都落在**新会话**；胶囊带 `data-session-mode` |
| 探针 | `tests/m2/capture-probe.mjs` 增加会话断言，并**自带端口隔离**（临时把构建指向探测端口 + 收尾恢复），避免再往真实工作区写测试文件 |

### 实测（`docs/reviews/probe-capture.json`）

| 断言 | 结果 |
|---|---|
| 新建了会话 | ✅ `newSessionCreated: true` |
| **插入目标是新会话** | ✅ `targetIsFreshSession: true`（不在抓取前的会话集合中） |
| **shell 自动跳到新会话** | ✅ `shellSwitched: true` |
| 胶囊 / ack | ✅ `status: "inserted"` + ack `inserted` |
| 抽取质量未回退 | ✅ 噪音四项全 false、正文与 front-matter 保留 |

### 过程中修掉的两个真实缺陷

1. `sessions.create` 需要 **workspaceId（UUID）**，传路径会 `workspace/not-found`（已改为"路径→注册表匹配 id"，并以首个工作区兜底，避免出现"无工作区会话 → composer 惰性"）。**已实测修复**。
2. 探针此前会把夹具文件写进**用户真实工作区**（因 dev-config 指回 3080）——已改为自带端口隔离 + 收尾恢复，并清理了误写入的文件。

---

## v3.20 — 2026-09-11

**触发**：用户同意"UI 噪音启发式"；实测来自真实站点（ClawHub）的抓取噪声。

### 交付（`extract.fn.js`，三条规则各自可关）

| 规则 | 判定 | 干掉什么 |
|---|---|---|
| A `stripChipRows` | 同一父节点下 ≥3 个"短且无标点"的叶子（≥children-1） | 分类胶囊、面包屑、`SKILL.md / Files / Versions` tab 条 |
| B `stripActionLabels` | 纯文本精确匹配动作词白名单（read more / share / download / stats & details / view all …） | "Read more"、tab 文案 |
| C `stripTrailingMeta` | 文档后 30% 内、含 downloads / last updated / version / license 且数字占比高或极短 | `DownloadsAll time30d7d 162`、`Last updated 4mo ago…` 统计块 |

元数据新增 `cleaner`（启用的规则数）便于观测。

### 回归（`tests/m2/capture-probe.mjs` 夹具已升级）

夹具页加入 chip 行 / tab 行 / "Read more" / 末尾统计块后重跑：

| 断言 | 结果 |
|---|---|
| UI 噪音被剔除 | ✅ `hasCategoryChips: false`、`hasTabStrip: false`、`hasReadMore: false`、`hasTrailingStats: false` |
| 正文完好 | ✅ 标记、标题、`## 小节标题`、`- 要点一`、```js 代码块、绝对化链接、front-matter 全部保留 |
| 端到端 | ✅ 落盘 + 胶囊（`inserted`）+ ack |

---

## v3.19 — 2026-09-11

**触发**：用户在真实 Chrome 中完成 H4① 自动拉起实测 —— **M2 阶段收尾**。

### 实测结论（`docs/reviews/probe-autostart-manual-verification.md`）

| 环节 | 证据 |
|---|---|
| host 被唤起并拉起 DSH | `dsh-web-companion-host.log`：`20:32:36 host started` → `20:32:40 ensure-dsh → started=true port=3080`（**4 秒**）→ `stdin closed — exiting`（短连接） |
| 进程与 URL 记录 | `~/.dsh/web-companion-dsh.json`：pid 8125 / port 3080 / token 43 字符 |
| **监听者确为该进程** | `lsof :3080` → `node 8125`（与状态文件完全一致） |
| 面板连上通道 | `/ag/ping`：`paired: true`、`liveTickets: 0`、**`connectedClients: 2`** |
| 端到端可用 | 用户随即成功抓取 `网页捕获/2026-09-11-1632-notebooklm-clawhub-l-ba83.md` |

### M2 阶段完成清单（全部有实测）

- ✅ 正文抽取 → Markdown（噪音剔除 / 链接绝对化 / 代码块 / 表格 / 截断）
- ✅ `/ag/attach` 原子落盘 + `WS /ag/client` 推送 + 离线队列 + ack
- ✅ composer 注入 `@fileRef` + 可删胶囊 + ✕ 撤销（草稿清理）
- ✅ 一次性授权引导（`optional_host_permissions` + 手势内 `permissions.request`）
- ✅ **native messaging 自动拉起**（真实环境实测，4 秒）
- ✅ 一次性票据握手（长期密钥不进 iframe URL）

### 自动化缺口（诚实记录）

`tests/m2/autostart-probe.mjs` 在本 agent 沙箱内启动的 Chrome 上仍报 `Specified native messaging host not found`（判断为环境限制）；本环的回归依赖真实环境人工验证。若需 CI 可跑，须在非沙箱环境执行。

---

## v3.18 — 2026-09-11

**触发**：M2 自动拉起（H4①）——native messaging host 落地。

### 交付

| 组件 | 说明 |
|---|---|
| `native-host/launcher.mjs` | 端口探测 → `spawn dsh web --no-open --port <p>`（detached, stdout 管道）→ 解析 `dsh web: <url>` 行拿 token → 写 `$DSH_HOME/web-companion-dsh.json`(0600)；`status`/`stop-dsh` 依据该文件 |
| `native-host/host.mjs` | stdio 帧循环（4 字节小端长度 + JSON，host→Chrome 上限 1MB）；命令 `ensure-dsh` / `status` / `stop-dsh` / `get-info`；stdout 只走帧，日志写文件 |
| `native-host/install.mjs` | 写 Chrome 的 `NativeMessagingHosts/com.dsh.web_companion.json`（含 `allowed_origins` 用**从扩展公钥推导**的钉死 ID）+ 生成 `run-host.sh`；支持 `--print` / `--uninstall` |
| 扩展 `src/sw/native-host.js` | `connectNative` 封装：**短连接**（一次命令一次连接即断，避免常驻端口把 SW 钉住）；错误映射 `E_NATIVE_MISSING` / `E_TIMEOUT` |
| 扩展 `dsh-session.js` | `/ag/ping` 失败 → 请 native host 拉起 → 轮询重探（≤10s）；未安装 host 时给出可执行提示；state 带 `autoStarted` |
| `manifest.json` | 补 **`nativeMessaging`** 权限（此前缺失 → `connectNative is not a function`） |

### 已实测

| 项 | 结果 |
|---|---|
| 帧协议（`get-info` / `status`） | ✅ 经 `run-host.sh` 直接驱动，响应正确 |
| **真实拉起** | ✅ `ensure-dsh` 在 **3.3s** 内拉起 DSH，返回 `started:true`、pid、**token 长度 43**、URL host 正确；随后 `status` → `running:true`；`stop-dsh` → `stopped:true`，端口释放 |
| 安装 | ✅ 清单已写入 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`，`allowed_origins` = 钉死扩展 ID；`run-host.sh` 可执行且响应正常 |
| 修掉的真实 bug | `dsh web` 是 `--profile web` 的别名，**不能再传 `--profile`**（原来报 `unknown option '--profile'`）|

### 未闭环（诚实记录）

**Chrome→host 的实际启动**尚未验证：我的测试 Chrome 由本 agent（沙箱内）启动，`connectNative` 返回 `Specified native messaging host not found.`，而同一清单在用户级目录中结构、权限、`allowed_origins` 均与同目录下可用的其它 host 一致，且脚本可被直接 exec 成功。判断为**测试环境限制**（Chrome 子进程受外层沙箱影响），**需要在用户真实 Chrome 中验证**（这才是决定性实验）。

---

## v3.17 — 2026-09-11

**触发**：用户实测首次抓取失败 —— `Cannot access contents of url "https://bailian.console.aliyun.com/…". Extension manifest must request permission to access this host`。
这正是 M0a 权限实验预警的那条限制（`activeTab` 只在"用户点扩展那一刻"对当前标签页生效）。本轮把它按设计 §9 方案③ 落地为**一次性授权引导**。

### 交付

| 组件 | 说明 |
|---|---|
| `manifest.json` | 增加 `optional_host_permissions: ["*://*/*"]`（`permissions.request` 的前提；此前**缺失**，所以授权根本无从发起）与 `optional_permissions: ["debugger"]` |
| 面板授权门（`panel.html` / `panel.css` / `panel.js`） | 点「Attach 网页」时先查 `chrome.permissions.contains`；未授权则显示内联说明卡（"内容只在本机处理"）+ [授权并抓取] [取消]。**授权调用发生在点击处理函数内**（点击即 Chrome 要求的手势）→ 之后意图路径无需手势 |
| 错误归类与可读化 | `capture.js` 把 `Cannot access contents of url` / `must request permission` / `<all_urls> or activeTab` 统一归类为 **`E_NO_PERMISSION`**；面板 `explain()` 把权限类错误翻成可操作提示（"点授权并抓取"或"在目标网页点一次扩展图标"），并区分 `E_NO_WORKSPACE`、`E_DSH_DOWN` |

### 实测（`tests/m2/gate-probe.mjs` → `docs/reviews/probe-gate.json`）

在**未授权的真实站点**（`https://example.com`）上：`permissions.contains('*://*/*') = false` → 点击 Attach（真实 CDP 点击）→ **授权门可见**，文案与按钮正确（`授权并抓取`）。截图 `docs/reviews/probe-gate.png`。

**未覆盖**：授权弹窗本身的允许/拒绝分支——无头 Chrome 无法渲染原生弹窗（M0a 已实测该限制），需有头人工验证（列入人工清单）。

---

## v3.16 — 2026-09-11

**触发**：M2 抓取侧落地，并用构建产物端到端取证 —— 「Attach 网页」按钮真正可用。

### 交付

| 组件 | 说明 |
|---|---|
| `extension/src/content/extract.fn.js` | **自包含**注入函数（`scripting.executeScript` 序列化要求）：主内容根识别（article/main/#content…）→ 噪音剔除（nav/footer/aside/script/表单/广告…）→ 单遍节点遍历转 Markdown（标题层级、嵌套列表、代码块带语言、表格、引用、链接**绝对化**、图片 alt）→ 选区 + 元数据（description/og:title/headings/chars）→ 120k 字符截断 |
| `extension/src/sw/capture.js` | 抓取编排：定位活动标签 → MAIN world 抽取 → 可选视口截图（受 `captureVisibleTab` 权限约束，失败标记 `dropped`+原因而不阻断正文）→ 组装 schema 合规的 `/ag/attach` 请求体 |
| `extension/src/sw/attach-sender.js` | 投递：key + 扩展 Origin（F2）；超时 8s；**仅对可重试错误**退避重试（300/900ms），4xx 直接上抛 |
| SW / 面板 | 新增 `capture` 消息路由与 UI 反馈（按钮进入"抓取中…"，成功显示 `已附加：@…`，失败显示可读原因） |
| **工作区解析（真实修复）** | 三级：请求体 `target.workspace` → **DSH 页面上报的工作区**（client 半 `hello` 携带当前会话 `cwd`，并在会话切换后重新上报）→ 插件配置 `defaultWorkspace`；解析失败返回 `E_NO_WORKSPACE` 并附带三级候选的诊断文本 |
| `scripts/init-key.mjs` | **幂等化**：已有配对文件即复用其 key（仅 `--rotate` 更换），避免"换端口重新生成 key"静默作废运行中的实例与已加载扩展 |

### 实测（`tests/m2/capture-probe.mjs` → `docs/reviews/probe-capture.json`）

在隔离实例上用构造夹具页（含导航/页脚噪音、标题、列表、代码块、相对链接）驱动**构建产物**：

| 断言 | 结果 |
|---|---|
| 面板触发抓取 | ✅ `ok: true`，`@网页捕获/2026-09-11-1608-m2-抓取夹具页-i-0fd6.md` |
| 落盘内容 | ✅ 正文含标记、标题、`## 小节标题`、`- 要点一`、```js 代码块；**导航/页脚噪音已被剔除**；相对链接已绝对化；front-matter 齐全 |
| 面板 iframe 内的 DSH 页面 | ✅ 收到推送并渲染胶囊：`{status: "inserted", mode: "page", label: "📄 网页: M2 抓取夹具页"}` + ack `inserted` |

### 体积

43.0 KB（gzip 0.4 KB），G6 判据仍通过；引入 Readability 类依赖后再复测。

---

## v3.15 — 2026-09-11

**触发**：**E2E-1 在真实扩展 + 真实实例上跑通**（用户已在自己的 Chrome 里加载扩展，ID `idpgkob…` 与配对文件一致）。

### 实测（`tests/m1/panel-probe.mjs` → `docs/reviews/probe-panel.{md,json,png}`）

| 断言 | 结果 |
|---|---|
| 面板文档 + SW 握手 | ✅ `panelStatus: "up"`、`"DSH 已连接"` |
| **frame URL 用票据而非密钥** | ✅ `http://127.0.0.1:3080/ag/enter?ticket=2l4MW8…`；`frameSrcLeaksKey: false` |
| **iframe 内是真正的 DSH GUI** | ✅ `title: "DeepSeek Harness"`、265 节点、**composer 存在**、`unauthorized: false`、正文含工作区 `dsh project` 与输入框占位文案 |
| 网络与错误面 | ✅ DSH 源仅 `200 /`；**无控制台错误** |
| 授权边界 | ✅ 真扩展 Origin 申请票据 200；伪造 Origin 403 |

截图 `docs/reviews/probe-panel.png`：500px 宽面板形态 —— 顶栏「DSH 已连接 + Attach 网页」+ 其下完整 DSH GUI（工作区、模式、模型、输入框齐备）。

### 顺带修正

`panel.js` 在连接成功后未清空 message，DOM 里残留 `正在连接本地 DSH…`（元素已隐藏，但不该留）。已修为连接成功即清空，并记录 `handshake`（`ticket` / `key-fallback`）便于观测。

---

## v3.14.1 — 2026-09-11

**触发**：把诊断字段补齐到协议（`/ag/ping` 暴露 `liveTickets` 与 `connectedClients`），使其成为**可验证的观测面**：
下次重启真实实例后，`connectedClients ≥ 1` 即证明浏览器里的界面已连上我们的上下文通道（client 半加载成功）。

- `protocol/messages.schema.json`：`PingResponse` 增加 `liveTickets` / `connectedClients`（均为 number）
- 插件 `/ag/ping` 输出 `connectedClients`（来自 hub 的 client 连接数）
- 协议契约测试重跑通过（21 正 / 11 反 / 3 产物）

## v3.14 — 2026-09-11

**触发**：M1③ 扩展构建链与体积报告（G6「扩展 ≤1MB」的可证伪依据）。

### 交付

| 组件 | 说明 |
|---|---|
| `extension/package.json` + `tsconfig.json` | esbuild + TypeScript 工具链；`tsconfig` 采用 `allowJs` 分阶段迁移策略（本轮先立构建链，源码仍为 JS，后续逐文件转 TS） |
| `extension/build.mjs` | esbuild 打包 MV3 入口（sw / panel / content）+ 复制静态壳（manifest、html、css）；产出 `dist/`；打印逐文件体积、总计、gzip 估算；写 `docs/reviews/build-size.json` |
| 根 `package.json` | 新增 `build:ext` / `size:ext` |

### 实测（`docs/reviews/build-size.json`）

```
  25.7 KB  src/sw/index.js
   3.3 KB  src/sidepanel/panel.js
   1.7 KB  src/sidepanel/panel.css
   1.1 KB  manifest.json
   0.9 KB  src/sidepanel/panel.html
  32.6 KB  总计（未压缩）   ·   0.4 KB（gzip 估算）
G6 判据：总计 ≤ 1024 KB → ✅ 通过
```

**⚠️ 诚实标注**：32.6 KB 是**尚未引入正文提取依赖**时的数字。M2 会加入 Readability/清洗与 WebVTT 解析（估算 +250–350 KB），届时必须重跑本报告；G6 的判据以那时为准，本轮的交付是**报告机制**而非最终数字。

---

## v3.13 — 2026-09-11

**触发**：M1② 一次性进入票据落地（设计 §5.4 key 生命周期）。

### 交付

| 组件 | 说明 |
|---|---|
| `dsh-plugin/src/host/tickets.js` | 纯函数票据库：`createTicketStore({ttlMs, now, random, limit})`，签发 / 单次消费 / TTL 过期 / 容量上限淘汰；时钟与随机源注入 → 可用假时钟单测 |
| `POST /ag/ticket` | 形态 F2（key + 扩展 Origin）→ 返回 `{ok, ticket, expiresAt}`（30s TTL，协议 schema 已有 `TicketResponse`） |
| `GET /ag/enter?ticket=` | 优先用**一次性票据**进入并消费；`?key=` 保留为探针与降级路径 |
| `/ag/ping` | 新增 `liveTickets` 诊断字段 |
| 扩展 `dsh-session.js` | `requestTicket()` + `ensureReady()` **优先票据**（`state.handshake: 'ticket'`），失败自动回退 key（`handshake: 'key-fallback'`）——**长期密钥不再进入 iframe URL** |

### 验证

| 检查 | 结果 |
|---|---|
| 单测 `tests/unit/tickets.test.mjs` | ✅ 14 项全过（单次消费、未知/空输入、假时钟过期、容量淘汰、默认 TTL 30s、随机串唯一） |
| `POST /ag/ticket`（key + 扩展 Origin） | ✅ 200 + `{ticket, expiresAt}` |
| `GET /ag/enter?ticket=…` | ✅ **303** + `Set-Cookie`（`SameSite=None; Secure`） |
| 同一票据复用 | ✅ **403**（一次性语义） |
| 无 key 申请票据 | ✅ 403 |

### 质量门

`npm run check` / `check:strict` 均加入 `test:unit`，两档共六道门全绿。

---

## v3.12 — 2026-09-11

**触发**：client 半落地 + **E2E-0 最小闭环自动跑通**（M0b 收尾）。

### 交付

| 组件 | 说明 |
|---|---|
| `dsh-plugin/lib/client.js`（重写） | 真正的 client 半：持有 `WS /ag/client`（同源，无需 key）；收 `attach` → 注入 `@fileRef` 到草稿 → 渲染可删胶囊 → ack；「看左边」意图嗅探（草稿正则 → `intent` 帧）；20s 心跳；卸载时清定时器与连接。同时保留 M0a 白盒探针入口（`__AG_PROBE__` / `__AG_PROBE_WRITE__`） |
| `guard.checkClient` | F4 判定放宽为"**同源即通过**（key 可选）"——key 不该出现在页面 JS 里；外部页面既无法被本服务提供、也无法伪造 loopback 的 `Origin`/`Host` 组合 |
| `tests/m0b/chip-probe.mjs` | E2E-0 闭环探针：自签 cookie → 无头 Chrome → 驱动 UI 选中会话 → POST attach → 断言胶囊/草稿/ack → ✕ 撤销 → 断言清理 |

### E2E-0 实测（`docs/reviews/probe-chip.{md,json}`）

client 连接 ✅ → composer 激活 ✅ → `/ag/attach` 200 且 `deliveredTo:["client:1"]` ✅ → **胶囊出现**（`status: inserted`、label 含页面标题）✅ → **草稿含 `@网页捕获/…md`** ✅ → ack `inserted` ✅ → **✕ 撤销**：胶囊清零、**草稿还原为 `"\n"`**、ack `dismissed` ✅。

### 修掉的真实缺陷

首轮 `✕` 只删胶囊、未清草稿引用：`shell.state.draft` 写入后常为空串，权威内容在活动编辑器 DOM。新增 `readDraft()` 三级回退（state → lastMirroredDraft → DOM），插入与撤销统一走它。

### 记录的偏差

胶囊目前为 **DOM 注入**（`[data-ag-chip]` 锚定在 composer 上方），尚未走 `conversation.input.dock` 插槽——插槽版需 React 组件与 props 契约，列为 M1/M2 打磨项；可观察契约一致。

---

## v3.11 — 2026-09-11

**触发**：M0b 上下文通道落地——`/ag/attach` 落盘 + `WS /ag/client` 推送 + `/ag/pending` / `/ag/ack`，并用探针逐项取证。

### 交付

| 组件 | 说明 |
|---|---|
| `dsh-plugin/src/host/store.js` | 原子落盘（tmp→rename）：`<workspace>/网页捕获/<yyyy-MM-dd-HHmm>-<slug>-<id6>.md`，YAML front-matter（captureId/title/url/domain/capturedAt/trigger/source/screenshot/truncated）+ 用户选区引用块 + 正文；另含离线 pending 队列（上限 32） |
| `dsh-plugin/src/host/hub.js` | WebSocket hub：`/ag/client`（client 半）与 `/ag/agent`（扩展，M3）分离；20s 心跳 / 30s 判离线；`push()` 广播并返回投递数 |
| `dsh-plugin/src/host/routes/attach.js` | `POST /ag/attach`（先落盘后推送，推送失败入队）、`GET /ag/pending`（`?peek=1` 只看不取）、`POST /ag/ack`（幂等） |
| `guard.checkClient` | 新增 F4 判定：key +（同源 Origin **或** Origin 缺失）→ 覆盖 DSH 页面自身的 client 半 |

### 探针取证（`tests/m0b/attach-probe.mjs` → `docs/reviews/probe-attach.json`）

| 断言 | 结果 |
|---|---|
| WS `/ag/client` 建连（F4） | ✅ `wsOpen: true` |
| `POST /ag/attach` 落盘 | ✅ 200；文件**真实存在**；front-matter 五项齐全、含选区块与正文（21 行），文件快照 sha256 已记录 |
| **推送而非拉取** | ✅ 已连接 client **收到 1 条 `attach` 事件**（含 `fileRef`、`mode: selection+page`、内联图片、summary） |
| `POST /ag/ack` | ✅ 200 |
| **离线队列** | ✅ 无 client 时 `deliveredTo: []`；`/ag/pending?peek=1` → 1；drain → 1；再 peek → 0（取出即消费） |
| 鉴权与校验 | ✅ 无 key 403、错 key 403、仅扩展 Origin 无 key 403、schema 拒绝 400、超限 413 |

### 依赖

根 `package.json` 增加 `ws` devDependency（探针与 hub 都需要；此前只有 `dsh-plugin/node_modules` 里的软链）。

---

## v3.10 — 2026-09-11

**触发**：M1 第①项落地——协议单源 schema + codegen + 契约测试（ADR-9）。

### 交付

| 产物 | 说明 |
|---|---|
| `protocol/messages.schema.json` | **唯一真源**：HTTP 端点消息、WS 信封、client 事件、扩展内部消息、native messaging 消息全部定义在一个 JSON Schema 里（21 个消息定义 + 错误码/枚举） |
| `protocol/codegen.mjs` | 生成三端自包含产物（扩展 ESM / 插件 ESM / native host MJS），每个产物头部带 schema 的 sha256；`--check` 逐字节比对 |
| `protocol/vectors/` | 21 个正向量 + 11 个反向量（含 `image/webp`、未知错误码、多余字段、非法 op 等真实反例） |
| `tests/protocol/contract.test.mjs` | 5 组断言：产物与 schema 一致 / 三端一致（版本·消息种类·枚举·路由·通道）/ 正向量全过 / 反向量全被拒且码为 `E_PAYLOAD` / 命名定义可直接校验 |
| 接入 | 扩展 `urls.js`、`dsh-session.js` 与插件 `index.js`、`ping.js` **已改用生成物**（路由常量、版本号、入站校验、出站自校验） |

### 自校验立刻抓到的真实漂移

接上出站自校验后，`/ag/ping` 第一次返回 **500**：`pairing payload violates schema: expected string|null, got undefined at $.pairingError`——即"配对正常时 `pairingError` 被省略"这一手写行为不符合封闭 schema。**已修**（显式 `null`），这也验证了守卫的有效性：schema 漂移会在开发期立刻暴露，而不是留到联调。

### 质量门更新

`npm run check` = `protocol:check` → `graph:sync` → `graph:check` → `check:consistency` → `test:protocol`（五道全绿）。

---

## v3.9 — 2026-09-11

**触发**：方案 A 落地后，在**用户真实 DSH 实例**（`~/.dsh`，端口 3080）上复跑 composer 探针——**M0b 两条硬断言全部达成**。

### 方案 A 落地（真实 profile 挂载）

- `~/.dsh/profiles/web/cordis.patch.yml` 追加顶层 `insert` 行（保留既有 semble/codegraph 两行）；备份 `cordis.patch.yml.bak-before-companion`
- `~/.dsh/dsh-web-companion.json`（0600）配对文件；扩展 dev-config 指向 3080
- 预检发现并修掉**首次写入的缩进错误**（会嵌套进上一条 insert，导致 loader 行缺 `name`、启动失败）；`dsh --profile web --dump-config` 复核通过
- 实测：`/ag/ping` → `paired:true`、`pairingSource=/Users/mac/.dsh/dsh-web-companion.json`；`/ag/enter` 与 `/ag/whoami` 无票据/无 Origin → **403**（fail-closed 正常）

### M0b 硬断言结果（真实 GUI）

| 断言 | 结果 | 证据 |
|---|---|---|
| ① 读到的必须是 **DSH 原生 composer**（且是活动编辑器） | ✅ `{anyEditable: true, activeEditable: true, attrs: {ce: "true", role: "textbox"}}` | `docs/reviews/probe-composer.json` |
| ② **写入方向可观察** | ✅ `__AG_PROBE_WRITE__('M0B-DOM-MARKER')` → `domText: "M0B-DOM-MARKER"`、`domHasMarker: true`、`lastMirroredDraft: "M0B-DOM-MARKER"`；随后**自动恢复原草稿**（`restoredNow: ""`，DOM 复原为换行） | 同上 |
| ③ 白盒探针（`__ModuleLoader__` / 服务面 / 图片 API） | ✅ `createDraftImages: true`、`sessions.scope: true`、`uiSession.currentBinding.props = {sessionId, inputActions}` | 同上 |

### 关键实现修正（探针自身）

1. **探针不再创建/切换会话**：早先版本在真实 GUI 里 `sessions.create` 会把 shell 切到"无工作区"的会话，composer 变回惰性态（`contenteditable="false"`）——这解释了此前"断言①始终失败"。现改为只观察 shell 当前会话，写入由 harness 在 UI 就绪后经 `__AG_PROBE_WRITE__` 触发。
2. 写入前记录原草稿、写入后**自动回填**，不在用户界面留残留文本。

### 副作用（如实记录）

探针在用户真实实例里留下了约 8 个空会话（14:52–14:55，标题均为「新会话」，均为无消息的空会话）——可在侧栏逐个删除；后续探针已改为不再创建会话。

---

## v3.8 — 2026-09-11

**触发**：M0a 第五个实验——空闲 WebSocket 保活（Q8 / D10）。

### 实测结论

| 持有者 | 90s 空闲后 | 判定 |
|---|---|---|
| 扩展文档（侧边栏文档形态） | WS 全程 `ws-open`，**无 `ws-close`** | ✅ D10 主方案成立 |
| MV3 Service Worker | 目标仍在但 `sendMessage` 返回 `Could not establish connection. Receiving end does not exist.`；**未捕获 close 事件** | ⚠️ SW 不能作为长期持有者（不宣称 socket 收到过 close） |

D10 结论不变并补上实测依据；兜底方案（SW + `chrome.alarms` + 重连）保留。局限已记录：观察窗仅 90s、未模拟侧边栏隐藏/关闭、未做"有心跳流量时是否保活"的对照。

---

## v3.7 — 2026-09-11

**触发**：M0a 第三、四个实验（cookie 矩阵 Q1/Q2 + 客户端 composer 契约已于 v3.6 记录）。

### Q1 现象闭环（逐格取证）

四形态 × 三属性矩阵（`docs/reviews/probe-cookie-matrix.json`）：`SameSite=Strict` 在**扩展页与 iframe 内的 WebSocket 握手都失败**、fetch 都成功；`None; Secure` 与 CHIPS **四格全绿**。机制（为什么 WS 与 fetch 不同）仍未证实，留 `chrome://net-export` 的 `COOKIE_*` 事件做后续定位。

### 发现并修复一处设计缺陷：同源请求不带 `Origin`

【实测】iframe 内同源 `fetch('/ag/whoami')` 到达服务端时 `Origin` 为 **null**（Fetch 规范：同源请求省略 Origin）。而 §5.4 从 v3.1 起把 F4 定义为"Origin 必须等于 authority"——照此实现会把 DSH 页面自己的合法请求误判。**已修正**：Origin 存在时必须匹配；缺失时以 `Sec-Fetch-Site: same-origin` + 有效会话 cookie 判定。`/ag/whoami` 分类器同步修正。

### Q2 未闭环（诚实记录，不粉饰）

`profile.block_third_party_cookies=true` 下矩阵结果与未屏蔽**完全一致**，但**跨站对照证明该偏好未生效**（`http://localhost` 顶层页 iframe `127.0.0.1` 时 `None; Secure` 仍被投递）。因此"3P 屏蔽不影响本设计"**尚未证实**，需改用真正的 3P 屏蔽开关重跑。§7.4 的 3P 兜底保持"不预置自动切换"。

---

## v3.6 — 2026-09-11

**触发**：M0a 第二个实验（composer / client 插件契约探针，`tests/m0a/composer-probe.mjs`）——把 client 插件从"按文档推断"变成"在真实 GUI 里跑起来并逐项取证"。

### 实测确认（逐字证据见 `docs/reviews/probe-composer.{md,json}`）

| 项 | 结论 |
|---|---|
| **客户端打包机制（A6）** | ✅ 成立：`exports["./client"]` + `dsh.client.platform="web"` + CJS 闭包工厂 → 写入 boot 图、经 `/plugins/??dsh-web-companion-bridge/client.js&rev=…` 返回 200/5764B，插件 `apply` 在真实 GUI 中成功执行 |
| **`inject` 是硬要求** | ❌→✅：不声明时 `apply` 早于服务就绪，`ctx.get('conversation'/'sessions')` 全 undefined；声明 `inject: ['sessions','conversation']` 后全部就位 |
| **`createDraftImages`（Q3，PiMoa 假设 C）** | ✅ 运行时存在并可用：`createDraftImages([File])` → `array(1)`，返回浏览器端 id；`createDraftAttachments` 在本版本**不存在** |
| **`setDraft` 签名** | ⚠️ 安装版 `0.1.2-rc.1` **arity=1**（无 `editRange`）→ v3.4 依据的"`setDraft(text, editRange?)`"来自更新源码；撤销契约改为**按 arity 能力探测**双路径 |
| **写入方向可观察** | ✅（非 DOM 形式）：`setDraft(marker)` 后 `shell.state.draft === marker`、`shell.lastMirroredDraft === marker` |
| **标准 props 可达** | ✅ `uiSession.currentBinding.props = { sessionId, inputActions }` → 插件可直接调用 `inputActions.setDraft`，无需 React |
| **可见服务面** | `conversation` / `sessions` / `uiConversation` / `uiSession` / `slots` / `connection` / `modules`，keys 清单已存档 |

### 未闭合项（明确记录，不粉饰）

**E2E-0 断言①（活动编辑器）**在隔离 dev home 中无法达成：composer 元素存在但为惰性占位（`contenteditable="false"`、`aria-label="选择工作区"`），因为该环境没有"已绑定工作区且被 shell 选为当前"的会话。四种驱动方式均已尝试并留证（真实 UI 点击 / `sessions.create`+`open` / `uiWorkspace.connectWorkspace` / `uiSession.createMaterializedBinding` 抛 `missing hook 'session'`）。
→ 两条解锁路径写在 `docs/reviews/probe-composer.md` §2：**A** 把插件挂进真实 profile（需一次工作区外写入，需用户批准）；**B** 接受非 DOM 回读，把断言①降级为 M1 前置人工步骤。**待用户选择**。

### 其他修订

§6.3 新增"运行时可达性（实测）"与"图片准入（Q3 结论）"两行；打包形态一栏由【源码】升级为【源码】+【实测】；插入/撤销契约按 arity 探测重写。

---

## v3.5 — 2026-09-11

**触发**：M0a 权限实验首次实跑（`tests/m0a/permission-probe.mjs` → `docs/reviews/probe-permission.{md,json}`），把设计的**核心假设 A′** 从"推理"升级为"取证"。

### 实测结论（逐字）

| 测得项 | 结果 |
|---|---|
| 无手势 `permissions.request` | ❌ **抛异常** `Error: This function must be called during a user gesture`（不是静默失败） |
| 真实点击面板按钮 / CDP 手势调用 | ⏸ 无头 Chrome 无法渲染原生弹窗 → 请求挂起（**弹窗 UX 需一次有头人工验证，列为 M1 前置**） |
| 无授权 + 无手势截图 | ❌ `Error: Either the '<all_urls>' or 'activeTab' permission is required.` |
| 无授权 + 无手势注入 | ✅ 成功——因为该测试目标 `127.0.0.1` 在探针扩展的 host 权限内 |

### 对设计的修正

1. §9 权限表：把"`executeScript` 与 `captureVisibleTab` **同时**失权"修正为**按源区分**——对无 host 权限的任意站点二者皆被拒（产品主场景），对已持权限的源（`http://127.0.0.1/*` = DSH 自身）注入仍可用。设计结论不变，理由精确化。
2. 明确 `permissions.request` 的失败形态是**抛异常**，微壳必须捕获并转为"请点按钮完成一次授权"的 UI，而不是静默失败。
3. 假设 A′ 状态更新为"**部分证实**"：无手势自授权已证伪（取证），"授权后无手势抓取可用"待有头验证。
4. 新增 M1 前置人工步骤：有头 Chrome 中验证授权弹窗的允许/拒绝/撤销三分支。

### 新增探针资产

`tests/m0a/ext/`（MV3 探针扩展：手势授权按钮 + 无手势对照）· `tests/m0a/permission-probe.mjs`（CDP 驱动：端口预检、失败即清理、逐案结构化输出）· `docs/reviews/probe-permission.{md,json}`

---

## v3.4 — 2026-09-11

**触发**：PiMoa 第四次对抗审核（`docs/reviews/pimoa-adversarial-v3.3.md`）：**阻断 2 → 1**（8 → 6 → 2 → 1）。本轮首次出现**亲验结论**（审核方实际执行了工具，读到了 DSH 源码检出），并据此推翻与纠正了设计的前提。

### 修正的 1 条阻断（权限模型，真缺陷）

`chrome.permissions.request` **必须由扩展侧用户手势触发**，而「看左边」意图路径（client 插件 F4 → 桥接插件 → SW）全程无手势 → **授权卡根本弹不出来**，`activeTab` 也不激活，`executeScript` 与 `captureVisibleTab` 同时失权。v3.4 在 §0.1 与 §9 **写死方案③**：首启经微壳按钮（该点击即手势）完成一次 `optional_host_permissions: *://*/*` 授权；未授权时意图路径降级为"按钮高亮 + 点击授权并抓取"（方案②）；明确否决方案①（声明式全站 host 权限）。M0a 增加三项权限实验（含**无手势调用 `permissions.request` 的 `lastError` 原文**作为证据）。

### 亲验带来的纠错（PiMoa 第四次审核）

| 项 | 纠正 |
|---|---|
| §6.3 契约引用 | **符号已亲验成立**：源码检出 `packages/client/ui-conversation/src/client/input/contract.ts` 的 `setDraft/addImages/submit` 位于 `:35/:37/:46`（此前两轮"未命中"实为 glob 写法与权限截断所致）→ 假设 B 从"未证实"上调为**符号成立、路径已修正**，**不提前触发 M0c** |
| **`setDraft` 签名** | 真实签名为 **`setDraft(text, editRange?)`**（`:104`，`EditRange` `:147`，`draft-changed` `:253`）→ **"`setDraft` 是唯一整段写入入口"被证伪**；v3.3 据此写的三分支撤销契约与 Q4 均基于伪约束，已改为**基于区间的插入/撤销契约**，Q4 改写为"`EditRange` 语义 + `draft-changed` 时机"并上提 M0a |

### 关闭的四项契约面缺口

1. **附件取回通道**：WS `attach` 事件**内联 `image.base64`**（受 8MB/图 上限约束），client 插件直接 `new File(...)` 走 `createDraftImages`——消除"`attachmentId` → `File`"的映射缺口；仅在放宽上限时才启用兜底端点 `GET /ag/attachment`（F4）。
2. **漂移 shim 补全**：新增覆盖 `setDraft`（含 `editRange` 是否存在）、`draft-changed` 事件名，探测失败即降级（无 `editRange` → 撤销退回"整段回退 + 用户编辑检测"）。
3. **两条 WS 的重连状态机拆分**：`/ag/agent`（侧边栏文档持有，断连立即 `E_EXT_OFFLINE`）与 `/ag/client`（页面持有，attach 入队、意图缓存 60s 后补发）**独立重连**。
4. **§7.4 新增两行**：DSH 未登录/会话失效导致 F4 恒 403 的降级（重建 iframe + 停止重连风暴）；**UI 撤销与 ack 解耦**（先本地撤销、后异步 ack，ack 失败不回滚 UI）。

### 最脆弱假设更新

① **A′**：`optional_host_permissions` + 无手势意图抓取能否共存（当前判断**大概率互斥**，唯一阻断项，已按方案③写死并待 M0a 验证）；② **B**：composer 草稿可读性（符号已亲验，剩命名/签名漂移风险）；③ **C**：截图能否真正成为 composer 附件（`createDraftImages` 尚未亲验命中，但取回通道已闭合）。

---

## v3.3 — 2026-09-11

**触发**：PiMoa 对 v3.2 的第三次对抗审核（`docs/reviews/pimoa-adversarial-v3.2.md`）：**阻断 6 → 2**（8 → 6 → 2），并指出残留仍是同一病根——"修了 §5.4 的矩阵却没回改 §5.1 的端点表"。

### 修正的 2 条阻断

| # | 修正 |
|---|---|
| A | **端点表不再重述鉴权规则**：§5.4 引入形态编号 **F1 导航 / F2 扩展 fetch / F3 扩展 WS / F4 client 同源**，§5.1 全部端点改为引用编号；新增一致性规则 `bare-auth-restatement`，禁止 §5.4 之外出现裸"key + Origin" |
| B | **capture 权限模型重写（真缺陷）**：「看左边」主路径由 iframe 内 client 插件发起（F4 → 桥接插件 → SW），**全程无扩展侧用户手势**，此时 `activeTab` 不生效 → `executeScript` 与 `captureVisibleTab` 会**同时失权**，M2 主路径直接不可用。改为：`*://*/*` 作为 `optional_host_permissions` 在首次使用时引导授予（配说明卡 + 状态图标），未授权时降级为"需手势"（提示点图标/⌘⇧E），并要求任何抓取失败给出可诊断原因；M0a 增加权限对照实验 |

### 采纳的 MAJOR / MINOR（第三次审核）

- §6.3 external 内省改为**两段式**（M0a 运行时探针导出 `probe-seed.json` → 构建期读取），修掉"构建期没有 window"的措辞矛盾。
- 配对权威明确（**权威 = `$DSH_HOME` 文件**，扩展侧为缓存）+ **漂移检测与修复态**（`/ag/ping` 判 `paired=false` → `E_UNPAIRED` 修复入口）；§7.2 时序补配对分支。
- **胶囊撤销契约**（v3.2 只写插入未写撤销）：记录 `{preDraft, insertedSpan, draftRev}`，✕ 时按"草稿未变→整段回退 / 已编辑→只删区间 / rev 失效→不动草稿仅标记 detached"三分支处理，禁止无条件覆盖。
- WS 归属从"必须"改为**主方案 + 待 Q8 实测 + 兜底方案**，并补重连状态机。
- M3 退出条件去掉"可靠点击"，改为**普通 HTML 页 100% / 主流 SPA ≥80% 且失败可诊断**。
- M0a 增加**闭环判据**（逐字片段 + 版本/commit + 探针原始输出落盘 `docs/reviews/probe-*.json`），新增 Q8 与权限实验。
- §10 新增**应急预案 M0c**：若 M0b 断言①失败，自动追加自研前端骨架预算并重写 §0.3/§1.1 收益表述（写成 CHANGELOG 显式触发条目，禁止"修措辞式回退"）。
- 明确保留上一轮结论：`chrome.debugger` 的 `requiredVersion:"1.3"` **不必上调**（防止被误判带偏）。
- 被驳回的提议：`/ag/enter` 之后 client 首次握手的 cookie 竞态（时序上 cookie 先写入，不成立）。

---

## v3.2 — 2026-09-11

**触发**：PiMoa 对 v3.1 的第二次对抗审核（`docs/reviews/pimoa-adversarial-v3.1.md`）：**8 阻断 → 6 阻断**，并指出复发模式——"修的是被点出的那句话，而不是那句话所在的契约面"。

### 修正的 6 条阻断（PiMoa v3.1 审核）

| # | 修正 |
|---|---|
| 1 | **鉴权矩阵补第四形态**：`/ag/client`（DSH 页面内 client 插件，**同源** Origin = `http://127.0.0.1:<port>`）必须有独立校验列（key + DSH 会话 cookie），否则按三形态矩阵 `request-pending`/`hello`/`ack` 恒 403 |
| 2 | **key 生命周期明确**：配对 key（长期，安装期生成一次）与**进入票据 ticket**（30s TTL + 单次消费）职责分离；新增 `POST /ag/ticket` 端点；说明自动拉起流程用**已存在的配对 key**，不依赖"拉起时生成新 key" |
| 3 | **WS 归属表述统一**：iframe 文档自建 DSH 原生 `/api/remote.mux`（不属 `/ag/*`）；微壳另行持有 `/ag/agent` 与 `/ag/client` 推送目标 |
| 4 | **截图体积上限统一到同一测量轴**（编码前原始字节）：抓取层 8MB/图 × ≤4 张 · 协议层 12MB（base64 后）· DSH 附件层 20MiB/20 张/64MP/8192px · native messaging 1MB 且**截图与正文一律不走 native messaging**；降级链明确 |
| 5 | **H4 单态化**：标题与 ADR-4 引用全部去掉"待拍板"；H4 记为**已决（启用自动拉起）**，并写明改选 ② 时必须成组修改的三处 |
| 6 | **M0 退出条件可判定**：E2E-0 改为三条硬断言——①必须是 **DSH 原生 composer**（禁止插件自 mount 的 DOM 充数）②**写入方向可观察**（`setDraft(marker)` 后能读回 marker）③白盒探针输出（`__ModuleLoader__` 可达性 + external 解析 + 图片 API 存在性） |

### 采纳的 MAJOR（9 条）

- `guard` 测试补第四形态与 ticket 用例（≥9），避免把 BLOCKER-1 固化成"全覆盖"。
- 图片附件在 §7.1 加显式降级分支（能力探测失败 → `@…png` 文件引用 + 胶囊标注）。
- §6.3 external 清单改为**构建期运行时内省**（禁止手抄），并标注 master 第 9 个包名未证实。
- §6.4 cookie 四级回退链在 §7.4 补对应降级行。
- §9 T7 的防御列落地为 §6.2 顶栏**敏感域确认横幅** + §7.4 新增行（默认不抓取）。
- `cookies` 权限从默认集移入 `optional_permissions`（与"权限最小化"自洽）。
- §7.4 的独立窗口兜底改为**最后手段**（明示破坏并排体验 + 提供回到侧边栏按钮）；3P 自动切换**不再预置**，待 Q2 结果。
- §6.2/§9 T12 的 WS 归属补实测项（新增 Q8：空闲 WS 是否保活侧边栏文档）。
- 排期：M0 拆为 **M0a 环境与能力证伪（≤1 天，可与 M1 并行）+ M0b 最小闭环 spike（≤2 天）**；M1 调为 2.5 天。

### 采纳的 MINOR 与结构性建议

- 【源码】引用补**安装产物绝对路径 + 版本**（`@deepseek-ai/dsh@0.1.2-rc.1`），并记录 PiMoa 亲验在源码检出未命中同路径的事实 → 假设 B 状态由"已知"下调为"未证实"，Q3 提至 M0a。
- 假设 B 的崩塌判据补入"契约路径在所指版本中不存在"。
- 命名与承诺清理：PRD 的"零开发成本"→"接近零 **UI** 开发成本"、"自动提取全部字幕"→"尽力提取（best-effort，附覆盖矩阵）"；`docs/01`–`08` 全量改名；`DESIGN.md` 去除"0 额外内存"字样；`FINDINGS.md` 加"旧命名已废弃"批注。
- §12.2 增加**生产可用率预估**列（`<track>` 路径生产占比低）。
- §8.3 修正"360px 拖到最窄"的表述矛盾（360 即最小值）。
- §11.1 区分"命令行开关已移除"与"CDP `loadUnpacked` 可用"两条路径（原文易被读成矛盾）。
- 新增 **Q8**（空闲 WS 保活实测）。

### 新增的自动化质量门（落实 PiMoa 的结构性建议）

把"评审条目 → 正文"的对齐**脚本化**：新增 `scripts/consistency-check.mjs`（15 条规则黑名单：废弃命名/旧值/webp/三形态/脚本注入/过度承诺等），`npm run check` = `graph:sync` + `graph:check` + `check:consistency`，任一不过即非零退出。当前全绿（15 规则 / 51 文件）。同时修复 `doc-graph --check` 因生成时间戳导致永远为假的问题（比较时归一化时间戳）。

---

## v3.1 — 2026-09-11（当前）

**触发**：用户要求对 v3.0 做错误检查 + 优化；随后逐项修改并交由 PiMoa 多模型对抗审核。

### 修正的硬错误（12 条，来自内部评审 REVIEW-v3.0）

| # | 修正 |
|---|---|
| A1 | 移除 iframe 的 `sandbox` 属性（全部实测均在无 sandbox 下取得；该组合下 sandbox 安全收益为零却作废实证基线） |
| A2 | iframe `src` 改为**运行时**构造 `enterUrl(key)`，不再硬编码无 key 的 `/ag/enter` |
| A3 | 截图格式由 `image/webp` 改为 `image/png`\|`jpeg`（平台枚举无 webp）；明确 `base64` 不含 `data:` 前缀；补体积上限与降级链 |
| A4 | 「看左边」意图嗅探点从扩展端迁到 **DSH client 插件**（用户输入框在跨域 iframe 内，扩展物理上读不到）—— 新增 ADR-11 |
| A5 | 补「导航 / fetch / WS」三形态鉴权矩阵（导航不带 `Origin`）；`/ag/enter` 增加一次性 key + 短 TTL 建议 |
| A6 | client 插件形态改为 DSH 真实加载机制（CJS 闭包工厂 bundle + `exports["./client"]` + 8 个基线 external + `/plugins/??` URL） |
| A7 | 安装路径补两条：开发期 `cordis.patch.yml` 绝对路径条目（本机无 pnpm，已实测可行）/ 生产期 bundle + pnpm |
| A8 | 协议统一为 `protocolVersion: 1`（文档版本另计）+ 统一 WS 信封 + 补齐端点与错误码表 + 单源 schema（ADR-9） |
| A9 | 修正时序图：扩展页不能直调 content script（须经 SW + `chrome.scripting`）；Prompt 提交发生在 iframe 内 DSH composer |
| A10 | 视频字幕降级为 **best-effort + 覆盖矩阵**；DRM 除"不传 mp4"外补"截图多为黑帧" |
| A11 | G1/G2 拆冷/热启动与 p50/p95，标注测量方法；性能数字统一标 `【目标·未测】` |
| A12 | **恢复「自动拉起 DSH」**（native messaging，非 Go）为设计默认，并标为待拍板 H4；同步消除 v3.0 与 DESIGN.md 的两套结论 |

### 回填的丢失信息（11 条）

B1 证据等级标注（全篇恢复）· B2 测试方案（L0–L4 完整 + 10 个 E2E + harness 事实 + 覆盖率 + 隔离）· B3 安全矩阵（恢复 12 条威胁 + 最小权限 + 审计）· B4 平台约束速查（恢复 Chrome 15 条 + DSH 要点）· B5 目录结构（补 `protocol/`、`native-host/`、`tests/e2e/`、`.devhome`、配对文件、`init-key.mjs`）· B6 失败降级矩阵（新增 §7.4，10 种场景）· B7 未决问题清单（新增 §12.4，Q1–Q7）· B8 版本语义（文档 v3.1 / 协议 1）· B9 命名统一（去掉 antigravity 旧名）· B10 DSH 平台事实（Schemastery/inject/路由/cookie/composer API/图片限制）· B11 文档间矛盾（DESIGN.md 重写为与 v3.1 一致的摘要）

### 采纳 PiMoa 对抗审核的额外发现

- BLOCKER：送审版本与"已修复"声明不一致（流程问题）→ 本版实际落盘。
- MAJOR：§8 测试只有负例断言（导航 Origin 误杀也能全绿）→ 改为**正例 + 负例双断言**。
- MINOR：ADR-3「0 额外内存消耗」口径错误 → 删除该表述，G6 只承诺"0 新增常驻进程 + 体积 ≤1MB"。
- MINOR：`captureVisibleTab` 限流 2 次/秒、仅活动标签页 → 补入 §11.1（M3 循环截图会踩）。
- MINOR：侧边栏不能承载远程 URL 属 **FACT(negative)**，应写明"iframe 是被迫的唯一形态"。
- MINOR：C9「扩展路径不能含空格」由硬约束降级为"自动化工具限制"（调研原文标 OBSERVED/UNVERIFIED，且本项目路径本身含空格）。
- C1：`<1MB` 与 Readability+turndown+DOMPurify（≈250KB）需实测 → G6 必须附体积报告。
- 排期：M3 由 2 天上调至 **3 天**（可靠点击/输入需要 `chrome.debugger` 路径，含 infobar 与 `requiredVersion:"1.3"`）。
- 新增 **M0 最小闭环 spike**（ADR-10），把两个最脆弱假设的证伪窗口前移到写 M2 之前。
- 新增 **ADR-9 协议单源**（M2 启动前必须就位）。

### 新增产物

`docs/REVIEW-v3.0.md`（内部评审）· `docs/reviews/pimoa-adversarial-v3.0.md`（PiMoa 审核）· `docs/DOC-GRAPH.md` + `docs/doc-graph.json`（文档图谱）· `scripts/doc-graph.mjs` · `scripts/pimoa-review.mjs` · `scripts/review-prompts/` · `.gitignore` · 根 `package.json`（codegraph devDependency + graph 脚本）· `docs/CHANGELOG.md`（本文件）

---

## v3.0 — 2026-09-11（已废弃）

由外部工具重写为「TypeScript + Node.js 极简单内核版」。**优点**：收敛到 DSH 单内核、明确 TS 技术栈、"看左边"交互替代后台轮询、Safari 明确不做。
**问题**：12 条硬错误（4 条会直接导致 M2 功能不可实现）+ 11 处信息丢失（详见 v3.1 的修正表），且与 DESIGN.md 出现同仓库两套结论。
**处置**：v3.1 逐条修正并在本文件留痕；v3.0 文本不再作为实现依据。

---

## v1.0 — 2026-09-11（首版，已废弃）

DSH 方的首版详细设计（含 8 份模块文档、10 个 E2E 用例、12 条威胁模型、三份平台调研）。v3.0 重写时其细节大量丢失，v3.1 已回填主要部分；仍未回填的细项保留在 `docs/01`–`docs/08` 中，作为模块详版继续有效。
