# DSH Web Companion

**English** (this section) · [中文](#中文) · [Install (EN)](./docs/13-installation.md) · [安装部署 (中文)](./docs/13-安装部署.md)

A Chrome extension that puts **your own AI agent next to the page you are looking at** — in the browser
side panel. It can *read* the page for you (as clean Markdown) and, when you allow it, *operate* the
browser: fill forms, click, translate, gather data across tabs.

> The extension UI ships **English only** — whatever your Chrome language is. (Chrome falls back to
> `default_locale` when it cannot match your language, so shipping only `en` locks the UI to English.)

---

## Why this project exists

I am Jerry. I noticed that **a browser side panel + an AI agent** solves a whole class of everyday
"using the web" problems — the ones that used to mean copying and pasting back and forth:

- **Filling in forms** — applications, sign-ups, tax/registration forms: the agent reads the form,
  understands each field, and fills it in.
- **Translating a page** — in context, keeping the layout and the terminology consistent.
- **Summarising a long page** — a 50-page policy, a long thread, a docs page: just the parts that matter,
  with follow-up questions.
- **Gathering data across tabs** — compare one product on three shops, collect addresses from five pages,
  write it all into one table.

I first used a ChatGPT browser extension and it was genuinely great. But **many people in China cannot use
ChatGPT**, while **DeepSeek 4.1 Flash is already very good and is available in China**. **DeepSeek Harness**
— the local agent runtime I use — had **no such extension**. So I built this one.

The agent runs **on your own machine**; the side panel is just the window into it. Your pages never have to
be shipped to a third-party browser service.

---

## Architecture

```text
┌──────────────────────────────── Chrome ─────────────────────────────────┐
│  any web page                      side panel                          │
│  ┌──────────────┐                 ┌─────────────────────────────────┐  │
│  │ the page you │                 │ DSH Web Companion panel         │  │
│  │ look at      │                 │ attach page / selection / shot  │  │
│  └──────┬───────┘                 │ browser control / write-approval│  │
│         │ content script          └───────┬─────────────────────────┘  │
│         │ extracts page/selection         │ embeds → the DSH web UI    │
│         ▼                                 ▼  (the "page half")         │
│  ┌──────────────────────┐          ┌──────────────────────────┐        │
│  │ extension service    │          │ DSH web UI (in an iframe)│        │
│  │ worker: capture page │          │ composer + conversation  │        │
│  │ / selection / shot,  │          └────────┬─────────────────┘        │
│  │ run browser ops      │                   │                          │
│  └────────┬─────────────┘                   │                          │
└───────────┼─────────────────────────────────┼──────────────────────────┘
            │ WS /ag/agent                    │ WS /ag/client
            │ (extension half)                │ (DSH-page half)
            ▼                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │ DSH (DeepSeek Harness) — running locally on your Mac       │
   │  ┌──────────────────────────────────────────────────────┐  │
   │  │ dsh-web-companion-bridge (a DSH/cordis plugin)        │  │
   │  │  · /ag/* HTTP routes   · hub (two WebSockets)         │  │
   │  │  · tools the model may call (browser_*)               │  │
   │  │  · approval gate for write operations                 │  │
   │  │  · capture store + audit log + retention              │  │
   │  └──────────────────────────────────────────────────────┘  │
   │        captures become Markdown files in your workspace,    │
   │        referenced in the chat as @file                      │
   └────────────────────────────────────────────────────────────┘
            ▲ native messaging (Chrome can start DSH if it is not running)
      ┌─────┴──────┐
      │ native host │
      └─────────────┘
```

Three local pieces:

1. **The Chrome extension** — the only part that touches web pages (text, selections, screenshots, clicks).
2. **A plugin inside DSH** (`dsh-web-companion-bridge`) — runs *inside* your local DSH process: it exposes
   the model's tools, decides what is allowed, stores captures, keeps the audit log.
3. **A native messaging host** — a tiny launcher so the extension can start DSH when it is not running.

### Why not the simple design?

The obvious design is: *put DSH in the sidebar, type "look left", grab the page text.* I deliberately did
**not** ship only that, because it collapses as soon as you want more than reading:

- **Reading is not enough.** Filling a form and translating a page are *actions*. A text-only design has
  nowhere to put "click this / type that / wait for the page" — and no place to ask you first.
- **One page dump is not always what you want.** Sometimes the **selection**, sometimes a **screenshot**
  (chart, canvas, PDF viewer), sometimes the **accessibility tree**. So capture is three buttons, not one
  hidden behaviour.
- **Something has to hold the privileged access.** A page inside an iframe cannot read other tabs or
  cross-origin pages, and cannot use Chrome's debugging capabilities. Only the extension can — so the
  extension is the "hands" and DSH is the "brain".
- **Each half sees only half.** The extension cannot read the DSH composer; the DSH page cannot read other
  sites. That is why the **"look left" intent is sniffed by the DSH page half** (it can see your input box)
  while the **capture is done by the extension half** — they talk through the local plugin.
- **Write operations need a gate and a paper trail.** Anything that *changes* a page goes through an approval
  gate, and every capture/attach/ack is appended to an audit log. "The AI silently clicked a button" is not
  acceptable.

The extra structure (attach page / attach selection / screenshot / browser control / write-op approval)
exists so the agent can **act** while you keep **control**.

---

## Features

**1. Give the page to the agent**
- **Attach page** — the whole page flattened to clean Markdown, saved in your workspace, referenced as `@网页捕获/….md`.
- **Attach selection** — only what you highlighted.
- **Attach screenshot** — charts, canvases, PDF viewers, anything that is not text.
- **Right-click → send to agent** — same capture without leaving the page.
- **"看左边" / "look left"** — type it in the DSH composer and the page in the other tab is captured (both languages work).

**2. Let the agent use the browser (read-only tools)**
- `browser_read` (page or one element as text) · `browser_tabs` (which tabs are open) ·
  `browser_wait` (wait for something to appear) · `browser_screenshot` · `browser_ax` (accessibility tree).

**3. Let the agent *do* things (write operations, behind a gate)**
- Click, type, select, scroll, navigate — what actually fills a form or drives a wizard.
- **Every write operation passes an approval gate.** With the gate on you are asked first; if the session is
  configured never to ask, write operations are **refused** rather than silently allowed.
- Nothing is claimed that did not happen: each operation reports a real result and failures come back as
  errors the model can react to.

**4. Keep you in control**
- The panel shows what the agent is doing, and every capture/attach/ack goes to a local audit log.
- **Retention**: captures older than 24 h are swept automatically, so the folder cannot grow forever.
- `bootstrap/uninstall.mjs` removes only what the installer added; `bootstrap/doctor.mjs` re-checks any time.

**5. Make it installable by normal people**
- A terminal wizard (`bootstrap/install.mjs`): **dry-run by default**, asks before every write, verifies the
  result, and can repair or upgrade an existing installation.

---

## Security

Everything runs on your machine, and nothing happens without your consent.

- **No third-party browser service** — your extension captures the page and hands it to your local DSH process.
- **Nothing but localhost** — the plugin listens only on your local DSH port and does not talk to the outside network.
- **Two-channel pairing with a key** — both WebSockets (`/ag/agent`, `/ag/client`) require the pairing key and
  an exact `Origin` match (the extension's own ID). A random page cannot talk to the bridge; a random process
  cannot impersonate the extension.
- **The extension ID is pinned** by a public key committed in `manifest.key`, and the native-host manifest
  allow-lists exactly that ID.
- **Write operations fail closed** — no approval mechanism, or an "ask" policy that cannot be satisfied, means
  the write is **refused**, and the message says the *policy* said no.
- **Every write is asked for and recorded** — the installer asks before each change; the plugin gates each
  browser write; the audit log keeps the record.
- **No secrets in the repository** — no keys, no pairing file, no built extension, no absolute paths from the
  author's machine; `npm run check` has a gate that scans for exactly that.

---

## Installing

Full walkthrough: [`docs/13-installation.md`](./docs/13-installation.md).

```bash
git clone https://github.com/jerryxugit-2026/deepseek-harness-web-companion.git
cd deepseek-harness-web-companion

node bootstrap/install.mjs          # dry-run: prints what it *would* change
node bootstrap/install.mjs --apply  # really install; every step asks you first
```

Then, once:

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → pick the `extension/dist` folder the
   installer just built.
2. Click the extension icon to open the side panel — that is your agent's window.
3. Restart DSH (`dsh web`) so it loads the freshly mounted plugin, then run:

```bash
node bootstrap/doctor.mjs           # checks DSH, pairing, the built extension, connectivity
```

**What the wizard does**: asks (interactively) where to install and where your DSH data lives; checks Node,
`dsh`, Chrome and the port; installs DSH if missing; links the plugin's runtime dependencies from your DSH
(or downloads the one package that is safe to download); builds the extension **on your machine** with your
port and pairing key baked in; writes the Chrome native-messaging manifest; adds one mount line to your DSH
profile (backed up first); then verifies everything.

**Requirements**: macOS, Node ≥ 22, Chrome/Chromium. (Windows is not supported — the wizard says so and stops
instead of pretending.)

---

<a id="中文"></a>
# DSH Web Companion（中文）

**English**（见上） · **中文**（本节） · [Install (EN)](./docs/13-installation.md) · [安装部署 (中文)](./docs/13-安装部署.md)

一个 Chrome 扩展：把**你自己的 AI agent 放到你正在看的网页旁边** —— 就在浏览器侧边栏里。它能替你**读**页面
（压成干净的 Markdown），在你允许时也能替你**操作**浏览器：填表、点击、翻译、跨标签页收集资料。

> 扩展界面**只发英文**，无论你的 Chrome 设成中文还是英文。（Chrome 匹配不到语言时会退到 `default_locale`，
> 所以只发 `en` 等于把界面锁死为英文。）

---

## 为什么做这个

我是 Jerry。我发现**浏览器侧边栏 + AI agent** 能解决一大类"上网办事"的问题 —— 那些以前只能靠来回复制粘贴的事：

- **填表** —— 申请、注册、报税/登记类表单：agent 读懂表单、理解每个字段，替你填。
- **翻译网页** —— 结合上下文翻，保持版式与术语前后一致。
- **长页面总结** —— 几十页的条款、很长的帖子、一篇文档：只给要紧的部分，还能就着它追问。
- **跨标签页收集资料** —— 在三家店比一个商品、从五个页面里收地址，再整理成一张表。

我最早用的是 Chrome + ChatGPT 的插件，**确实非常好用**。但我发现**很多人在国内无法使用 ChatGPT**，而
**DeepSeek 4.1 Flash 已经非常好用、国内可以直接用**。可是 **DeepSeek Harness 没有这样的扩展程序**。
于是我自己做了这个。

结果是：agent 跑在**你自己的机器上**，侧边栏只是它的窗口。你的网页不需要交给任何第三方的浏览器服务。

---

## 架构

```text
┌──────────────────────────────── Chrome ─────────────────────────────────┐
│  任意网页                          侧边栏                               │
│  ┌──────────────┐                 ┌─────────────────────────────────┐  │
│  │ 你正在看的    │                 │ DSH Web Companion 面板           │  │
│  │ 那个页面      │                 │ 附页面 / 附选区 / 截图           │  │
│  └──────┬───────┘                 │ 浏览器控制 / 写操作审批          │  │
│         │ 内容脚本                 └───────┬─────────────────────────┘  │
│         │ 抽取页面/选区                    │ 内嵌 → DSH 界面             │
│         ▼                                  ▼ （"页面半"）               │
│  ┌──────────────────────┐          ┌──────────────────────────┐        │
│  │ 扩展 service worker  │          │ DSH 界面（在 iframe 里） │        │
│  │ 抓整页 / 选区 / 截图 │          │ 输入框 + 会话            │        │
│  │ 执行浏览器操作       │          └────────┬─────────────────┘        │
│  └────────┬─────────────┘                   │                          │
└───────────┼─────────────────────────────────┼──────────────────────────┘
            │ WS /ag/agent                    │ WS /ag/client
            │ （扩展半）                      │ （DSH 页面半）
            ▼                                 ▼
   ┌────────────────────────────────────────────────────────────┐
   │ DSH（DeepSeek Harness）—— 跑在你本机 Mac 上                 │
   │  ┌──────────────────────────────────────────────────────┐  │
   │  │ dsh-web-companion-bridge（一个 DSH/cordis 插件）      │  │
   │  │  · /ag/* HTTP 路由   · hub（两条 WebSocket）          │  │
   │  │  · 模型能调用的工具（browser_*）                      │  │
   │  │  · 写操作审批闸门                                     │  │
   │  │  · 抓取存档 + 审计日志 + 保留策略                     │  │
   │  └──────────────────────────────────────────────────────┘  │
   │        抓到的内容写成 Markdown 文件放进你的工作目录，        │
   │        并在对话里以 @文件 引用                              │
   └────────────────────────────────────────────────────────────┘
            ▲ native messaging（DSH 没跑时，Chrome 能把它拉起来）
      ┌─────┴──────┐
      │ native host │
      └─────────────┘
```

三块，全在本地：

1. **Chrome 扩展** —— 唯一能碰网页的部分（文字、选区、截图、点击）。
2. **DSH 里的插件**（`dsh-web-companion-bridge`）—— 跑在**本机 DSH 进程内部**：提供模型能调用的工具、
   判定什么允许做、保存抓取内容、维护审计日志。
3. **native messaging host** —— 一个很小的拉起器：DSH 没在跑时，点扩展就能把它拉起来。

### 为什么不用"最简单的那种"做法

最容易想到的做法是：**把 DSH 放进侧边栏，打一句「看左边」，把页面文字抓过来就行**。我**故意没有只做这个**，
因为只要你想要的不止"读"，它就会塌：

- **光读不够。** 填表和翻译都是**动作**。只抓文字的设计没有地方安放"点这里/输入那个/等页面加载"，
  也没有地方在动手前问你一句。
- **整页一把抓不总是你要的。** 有时要**选区**，有时要**截图**（图表、canvas、PDF 阅读器），有时只要
  **无障碍树**。所以抓取是三个独立入口，而不是一个藏在背后的行为。
- **特权访问得有个东西来拿。** iframe 里的页面读不到别的标签页、读不到跨域页面、也用不了 Chrome 的调试能力 ——
  只有扩展能。所以扩展当"手"，DSH 当"脑"。
- **两半各只能看到一半。** 扩展读不到 DSH 输入框；DSH 页面读不到别的网站。这就是为什么「看左边」的**嗅探**放在
  **DSH 页面半**（它看得见你的输入框），而真正的**抓取**由**扩展半**做 —— 两者通过本机插件通信。
- **写操作需要闸门与留痕。** 任何会**改动**页面的动作都走审批闸门，每次抓取/投递/回执都写审计日志。
  "AI 悄悄点了个按钮"是不可接受的。

一句话：多出来的这些结构（附页面／附选区／截图／浏览器控制／写操作审批），是为了让 agent 能**动手**，
同时让你始终**握着方向盘**。

---

## 功能

**1. 把页面交给 agent**
- **附上页面** —— 整页压平成干净的 Markdown，存进你的工作目录，以 `@网页捕获/….md` 引用。
- **附上选区** —— 只给你划中的那段。
- **附上截图** —— 图表、canvas、PDF 阅读器，任何不是文字的东西。
- **右键 → 交给 agent** —— 不离开页面就能抓。
- **「看左边」/「look left」** —— 在 DSH 输入框打这句，**另一个**标签页的页面被自动抓过来（中英都认）。

**2. 让 agent 用浏览器（只读工具）**
- `browser_read`（页面或某个元素读成文字）· `browser_tabs`（有哪些标签页）·
  `browser_wait`（等东西出现）· `browser_screenshot`（截图）· `browser_ax`（无障碍树）。

**3. 让 agent 动手（写操作，走闸门）**
- 点击、输入、选择、滚动、跳转 —— 真正能填完一张表、走完一个向导的那些操作。
- **每个写操作都过审批闸门。** 闸门开着时先问你；若会话被配置成"从不询问"，写操作会被**明确拒绝**，
  而不是偷偷放行。
- 不谎报：每个操作都返回真实结果，失败以错误形式回到模型那里。

**4. 让你握着方向盘**
- 面板如实显示 agent 在做什么，每次抓取/投递/回执都进本机审计日志。
- **保留策略**：超过 24 小时的抓取自动清理，目录不会无限膨胀。
- `bootstrap/uninstall.mjs` 只摘掉安装器加的东西；`bootstrap/doctor.mjs` 随时重新体检。

**5. 让普通人也能装**
- 终端向导（`bootstrap/install.mjs`）：**默认 dry-run**、每一步写盘前都问你、装完自证，能修复/升级已有安装。

---

## 安全性

全部跑在你本机，且没有你的同意就什么都不做。

- **不经过任何第三方的浏览器服务** —— 页面由你自己的扩展抓取，交给你本机的 DSH 进程。
- **只走 localhost** —— 插件只监听本机 DSH 端口，不与外部网络通信。
- **两条通道都要配对钥匙** —— `/ag/agent` 与 `/ag/client` 都要求配对钥匙 + `Origin` 精确匹配（扩展自己的 ID）。
  随便一个网页跟插件说不上话，随便一个进程也冒充不了扩展。
- **扩展 ID 是钉死的** —— 由提交在 `manifest.key` 里的公钥推导，native host 清单只允许这一个 ID。
- **写操作 fail-closed** —— 没有审批机制、或"询问"策略问不了，写操作**当场被拒**，并说明是**策略**拒绝的。
- **每次写操作都要问、且留痕** —— 安装器每改一处先问；插件对每次浏览器写操作把关；审计日志留记录。
- **仓库里没有任何机密** —— 没有密钥、配对文件、构建产物、作者机器的绝对路径；`npm run check` 有门禁专扫这些。

---

## 安装

完整步骤见 [`docs/13-安装部署.md`](./docs/13-安装部署.md)。

```bash
git clone https://github.com/jerryxugit-2026/deepseek-harness-web-companion.git
cd deepseek-harness-web-companion

node bootstrap/install.mjs          # dry-run：只打印"打算"改哪些文件
node bootstrap/install.mjs --apply  # 真装：每一步都先问你
```

然后一次性的事：

1. `chrome://extensions` → 开**开发者模式** → **加载已解压的扩展程序** → 选安装器刚构建的 `extension/dist`。
2. 点扩展图标打开侧边栏 —— 那就是 agent 的窗口。
3. 重启 DSH（`dsh web`）让它加载刚挂上的插件，然后跑：

```bash
node bootstrap/doctor.mjs           # 体检：DSH / 配对 / 构建产物 / 连通性
```

**向导做了什么**：问你装到哪、DSH 数据目录在哪；检查 Node、`dsh`、Chrome、端口；DSH 缺了就装；
把插件依赖从你已装的 DSH 链接过来（只有一个普通包允许下载）；在**你的机器上**现场构建扩展并把端口与钥匙
烤进去；写 Chrome native messaging 清单；往 DSH profile 加一行挂载（改前备份）；最后自证一遍。

**前置条件**：macOS、Node ≥ 22、Chrome/Chromium。（不支持 Windows —— 向导会明确说并**当场停下**，不假装成功。）
