# DSH Web Companion

**English** (this section) · [中文](#中文) · [Install guide](./docs/13-installation.md) · [安装部署](./docs/13-安装部署.md)

An AI agent that sits **next to the web page you are looking at**, in the Chrome side panel.
It reads the page for you, and — when you turn that on — it also *works* the page: fills forms,
translates, clicks, collects things from several tabs into one place.

It runs on **your own computer** (through DeepSeek Harness). Nothing is sent to a third-party
browser service.

---

## Background: why I built this

I am **Jerry**. I found that **a browser side panel plus an AI agent** solves a big class of everyday
"doing things on the web" problems — the ones that used to mean copying and pasting back and forth:

- **Filling in forms** — applications, sign-ups, tax and registration forms.
- **Translating a page** — keeping the layout and the terminology consistent, not just word by word.
- **Summarising a long page** — a 50-page policy, a long thread, a documentation page.
- **Collecting from several tabs** — compare one product on three shops, gather addresses from five pages.

At first I used a **Chrome + ChatGPT extension**, and it was genuinely great. But I noticed that
**many people in China cannot use ChatGPT**, while **DeepSeek 4.1 Flash is already very good and is
available in China**. Yet **DeepSeek Harness had no such extension**. So I built this one.

That is the whole reason: the experience I liked, made usable by the people around me, running locally.

---

## What you can do with it

You open the side panel, and you have an agent that can see the page you are on.

- **Ask about the page you are reading.** "What does this contract actually commit me to?" "Summarise this
  in five points." No copying, no pasting — the page is already in front of it.
- **Fill a form.** Give it a form page and tell it what you want to say; it reads each field, understands
  what goes where, and fills it in. It asks you before it changes anything.
- **Translate.** The whole page, or just the part you highlighted — with consistent terminology.
- **Summarise something long.** Long policy pages, forum threads, docs: get the parts that matter, then ask
  follow-up questions about them.
- **Collect from several tabs.** "Compare this product on those three shops." "Get the address from each of
  these five pages." It gathers them into one answer or one table.
- **Hand it what you are looking at, three ways.** The **page**, the **text you selected**, or a
  **screenshot** (for charts, canvases, PDF viewers — things that are not text). There is also a
  right-click menu, and if you type 「看左边」 (or "look left") in the chat it grabs the page in the
  other tab by itself.
- **Let it actually click and type.** Turn on the *write operations* switch and it can fill, click, select,
  scroll and navigate — the things that finish a form or walk through a wizard. Every single one of those
  actions is confirmed by you first, unless you deliberately turn asking off (in which case they are
  refused instead of quietly allowed).

Everything it captures is saved in your workspace as a normal Markdown file, and referenced in the chat as
`@网页捕获/….md` — so you can read, edit, keep or delete it like any other file.

---

## How it works

```text
┌──────────────────────────── Chrome ────────────────────────────┐
│  the page you are on                side panel                 │
│  ┌──────────────┐                  ┌─────────────────────────┐ │
│  │  web page    │                  │ Companion panel         │ │
│  │              │                  │ page / selection / shot │ │
│  └──────┬───────┘                  │ control / write switch  │ │
│         │ reads the page           └───────┬─────────────────┘ │
│         ▼                                  │ shows the DSH UI   │
│  ┌──────────────────────┐         ┌────────▼─────────────────┐ │
│  │ extension background │         │ DSH chat UI (in a frame) │ │
│  └────────┬─────────────┘         └────────┬─────────────────┘ │
└───────────┼────────────────────────────────┼───────────────────┘
            │  local connection              │  local connection
            ▼                                ▼
   ┌──────────────────────────────────────────────────────────┐
   │  DeepSeek Harness — running on your computer             │
   │    └ the Companion plugin (inside DSH)                   │
   │       · talks to the browser                             │
   │       · gives the AI its browser abilities               │
   │       · asks you before any change is made               │
   │       · saves the captures and keeps a local log         │
   └──────────────────────────────────────────────────────────┘
            ▲  lets Chrome start DSH when it is not running
      ┌─────┴──────┐
      │ small      │
      │ launcher   │
      └────────────┘
```

Three small pieces, all on your machine:

1. **The Chrome extension** — the only part that can touch web pages. It is built on your computer when
   you install, with your own settings baked in.
2. **A plugin inside DeepSeek Harness** — it lives in the same process as your local DSH, gives the AI its
   browser abilities, gates the changes, and keeps the log.
3. **A small launcher** — so that clicking the extension can start DeepSeek Harness for you if it is not
   running yet.

### Why it is built this way

The easiest possible version would be: *put DSH in the side panel, type "look left", grab the page text.*
I did not stop there, because that version only *reads*:

- **Reading is not enough.** Filling a form and translating a page are things you *do*. A read-only version
  has nowhere to put "click here", "type this", "wait for the page" — and nowhere to ask you first.
- **One big dump is not always what you want.** Sometimes it is the text you selected, sometimes a picture of
  a chart, sometimes a page made of controls rather than text. So there are three separate ways to hand it
  over, instead of one hidden behaviour.
- **Only the extension can reach the page.** A page shown inside a frame cannot read other tabs or other
  sites. So the extension is the hands, and DeepSeek Harness is the brain.
- **Changes need permission and a record.** Anything that modifies a page goes through a confirmation, and
  every capture is written to a local log. "The AI quietly clicked something" is not acceptable.

---

## Is it safe?

The short version: **it all runs on your computer, and nothing happens without your consent.**

- **No third-party browser service.** Your extension reads the page and hands it to *your* local DSH
  process. There is no company in the middle.
- **Nothing is exposed to the network.** The plugin listens only on your own machine, and does not talk to
  the internet.
- **Only your browser can talk to it.** The connection requires a secret pairing key that is generated on
  your machine, and it checks that the caller really is your extension. A random web page cannot reach it.
- **Your extension's identity is pinned**, so another extension cannot impersonate it.
- **Write operations fail closed.** If asking is not possible — or the session is set to never ask — the
  action is **refused**, and it tells you it was the *setting*, not a person, that said no.
- **Every change is asked for, and recorded**, in a local log you can read.
- **No secrets in this repository**: no keys, no pairing file, no built extension. The build checks this.

---

## Getting it, and installing it

### Which files do I download?

**Nothing in particular — take the whole repository.** Either way works:

**Option A — download a ZIP (no git needed)**
1. Open <https://github.com/jerryxugit-2026/deepseek-harness-web-companion>
2. Click the green **Code** button → **Download ZIP**
3. Unzip it anywhere you like (for example your home folder). You get one folder.

**Option B — clone it**
```bash
git clone https://github.com/jerryxugit-2026/deepseek-harness-web-companion.git
```

**What you are downloading (and what you are not)**: only the project's own source. There is **no**
`node_modules`, **no** pre-built extension, and **no** keys inside. Everything else — DeepSeek Harness
itself, the plugin's dependencies, and the built Chrome extension — is **fetched or built on your machine
by the installer**, with your own settings. That is why the download is small.

### Then run the installer

You need **macOS**, **Node 22 or newer**, and **Chrome**. Open a terminal in the folder you just unzipped
and run:

```bash
node bootstrap/install.mjs          # dry run: it only prints what it *would* change
node bootstrap/install.mjs --apply  # the real thing: it asks you before every step
```

Then, once:

1. In Chrome, open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and choose
   the `extension/dist` folder the installer just built for you.
2. Click the extension icon to open the side panel — that is your agent's window.
3. Restart DeepSeek Harness (`dsh web`) so it picks up the plugin, then check everything:

```bash
node bootstrap/doctor.mjs           # verifies DSH, pairing, the built extension, connectivity
```

The installer asks you where to install and where your DSH data lives. It checks Node, DSH, Chrome and the
port; installs DSH if it is missing; builds the extension on your machine; adds one line to your DSH
settings (after backing it up); and then verifies the result. To remove it again:
`node bootstrap/uninstall.mjs`.

*(Windows is not supported. The installer says so and stops, rather than pretending.)*

---

## For engineers

Design docs, the changelog and the ledger live in [`docs/`](./docs). The model-facing tools are
`browser_read`, `browser_tabs`, `browser_wait`, `browser_screenshot`, `browser_ax`, plus gated write
operations; the two local channels are `/ag/agent` (extension) and `/ag/client` (DSH page).
`npm run check` runs the whole gate suite; `npm run probe:all` runs the real-Chrome probes.

---

<a id="中文"></a>
# DSH Web Companion（中文）

**English**（见上） · **中文**（本节） · [安装说明](./docs/13-installation.md) · [安装部署](./docs/13-安装部署.md)

一个 AI agent，就坐在**你正在看的网页旁边** —— 在 Chrome 侧边栏里。它替你读页面，在你同意时也替你**操作**页面：
填表、翻译、点击、把好几个标签页里的东西收拢到一处。

它跑在**你自己的电脑上**（通过 DeepSeek Harness），网页不需要交给任何第三方的浏览器服务。

---

## 开发背景：为什么做这个

我是 **Jerry**。我发现**浏览器侧边栏 + AI agent** 能解决一大类"上网办事"的问题 —— 那些以前只能来回复制粘贴的事：

- **填表** —— 申请、注册、报税与登记类表单。
- **翻译网页** —— 保持版式与术语一致，而不是逐词硬翻。
- **长页面总结** —— 几十页的条款、很长的帖子、一篇文档。
- **跨标签页收集** —— 在三家店比一个商品、从五个页面里收地址。

我最开始用的是 **Chrome + ChatGPT 的插件**，**确实非常好用**。但我发现**很多人在国内无法使用 ChatGPT**，
而 **DeepSeek 4.1 Flash 已经非常好用、国内可以直接用**。可是 **DeepSeek Harness 没有这样的扩展程序**。
于是我自己做了这个。

理由就这么简单：把我喜欢的那种体验，做成身边的人能用、而且跑在本地的东西。

---

## 你能让它做什么

点开侧边栏，你就有了一个看得见当前页面的 agent。

- **就着当前页面问它。** "这份合同到底让我承担了什么？""用五句话总结这一页。" 不用复制粘贴，页面已经在它眼前。
- **替你填表。** 给它一个表单页，告诉它你想写什么；它读懂每个字段要什么，然后填好。**动手之前会先问你。**
- **翻译。** 整页翻，或只翻你划中的那段 —— 术语前后一致。
- **总结长内容。** 长条款、长帖、文档：只给要紧的部分，然后可以就着它追问。
- **跨标签页收集。** "把这个商品在那三家店比一下。""从这五个页面里把地址取出来。" 它会汇总成一段答案或一张表。
- **把你在看的东西交给它，三种方式。** **整页**、**你划中的文字**、或**截图**（图表、canvas、PDF 阅读器这类不是文字的东西）。
  也有右键菜单；在对话里打「看左边」（或 "look left"），它会自己把另一个标签页抓过来。
- **让它真的动手。** 打开**写操作**开关，它就能填、点、选、滚、跳 —— 那些能真正填完一张表、走完一个向导的动作。
  这些动作**每一个都先经过你确认**；除非你特意关掉询问（那样它们会被**当场拒绝**，而不是偷偷放行）。

它抓到的内容会作为普通 Markdown 文件存在你的工作目录里，并在对话中以 `@网页捕获/….md` 引用 ——
你可以像对待任何文件一样读它、改它、留着或删掉。

---

## 它是怎么工作的

```text
┌──────────────────────────── Chrome ────────────────────────────┐
│  你正在看的网页                      侧边栏                     │
│  ┌──────────────┐                  ┌─────────────────────────┐ │
│  │   网页        │                  │ Companion 面板          │ │
│  │              │                  │ 页面 / 选区 / 截图      │ │
│  └──────┬───────┘                  │ 浏览器控制 / 写操作开关 │ │
│         │ 读取页面                  └───────┬─────────────────┘ │
│         ▼                                  │ 显示 DSH 界面      │
│  ┌──────────────────────┐         ┌────────▼─────────────────┐ │
│  │ 扩展的后台            │         │ DSH 对话界面（在框里）   │ │
│  └────────┬─────────────┘         └────────┬─────────────────┘ │
└───────────┼────────────────────────────────┼───────────────────┘
            │  本机连接                       │  本机连接
            ▼                                ▼
   ┌──────────────────────────────────────────────────────────┐
   │  DeepSeek Harness —— 跑在你的电脑上                       │
   │    └ Companion 插件（在 DSH 进程内）                      │
   │       · 与浏览器通信                                      │
   │       · 给 AI 浏览器能力                                  │
   │       · 任何改动之前先问你                                │
   │       · 保存抓取内容并留一份本机日志                       │
   └──────────────────────────────────────────────────────────┘
            ▲  让 Chrome 在 DSH 没跑时把它拉起来
      ┌─────┴──────┐
      │ 小启动器    │
      └────────────┘
```

三块小东西，全在你机器上：

1. **Chrome 扩展** —— 唯一能碰网页的部分。安装时**在你的电脑上现场构建**，把你的设置烤进去。
2. **DeepSeek Harness 里的插件** —— 和你的本机 DSH 同一个进程：给 AI 浏览器能力、给改动把关、留日志。
3. **一个小启动器** —— DSH 没在跑时，点扩展就能把它拉起来。

### 为什么做成这个结构

最省事的版本是：*把 DSH 放进侧边栏，打一句「看左边」，把页面文字抓过来*。我没有停在那里，因为那个版本只会**读**：

- **光读不够。** 填表和翻译都是你要**做**的事。只读的版本没有地方安放"点这里""输入这个""等页面加载"，
  也没有地方先问你一句。
- **整页一把抓不总是你要的。** 有时要的是你划中的文字，有时要一张图表的截图，有时页面是由控件而不是文字拼成的。
  所以是三种各自独立的交付方式，而不是一个藏在背后的行为。
- **只有扩展能碰到页面。** 框里显示的页面读不到别的标签页、读不到别的网站。所以扩展当"手"，DeepSeek Harness 当"脑"。
- **改动需要许可与留痕。** 任何会修改页面的动作都走一次确认，每次抓取都写进本机日志。
  "AI 悄悄点了什么"是不可接受的。

---

## 它安全吗

一句话：**全部跑在你的电脑上，没有你的同意就什么都不做。**

- **不经过第三方浏览器服务。** 扩展读到页面后交给你**本机**的 DSH 进程，中间没有厂商。
- **不对外暴露网络。** 插件只监听你自己的机器，不与互联网通信。
- **只有你的浏览器能跟它说话。** 连接需要一把在你机器上生成的配对钥匙，并校验对方确实是你那个扩展。
  随便一个网页连不上它。
- **扩展身份是钉死的**，别的扩展冒充不了。
- **写操作 fail-closed。** 问不成、或会话被设成"从不询问"时，动作会**被拒绝**，并告诉你是**设置**拒绝的。
- **每次改动都先问、且留痕** —— 本机日志可查。
- **仓库里没有任何机密**：没有钥匙、没有配对文件、没有构建产物。构建门禁会扫这些。

---

## 怎么下载、怎么安装

### 我该下载哪几个文件？

**不用挑，把整个仓库拿走就行。** 两种方式都可以：

**方式 A —— 下载 ZIP（不需要 git）**
1. 打开 <https://github.com/jerryxugit-2026/deepseek-harness-web-companion>
2. 点绿色的 **Code** 按钮 → **Download ZIP**
3. 解压到任何地方（比如你的主目录），得到一个文件夹。

**方式 B —— clone**
```bash
git clone https://github.com/jerryxugit-2026/deepseek-harness-web-companion.git
```

**你下载到的（以及没有下载到的）**：只有项目自己的源码。里面**没有** `node_modules`、**没有**预先构建好的扩展、
**没有**任何钥匙。其余的一切 —— DeepSeek Harness 本体、插件的依赖、以及构建出来的 Chrome 扩展 ——
都由**安装器在你的机器上**获取或构建，用的是你自己的设置。所以下载包很小。

### 然后运行安装器

需要 **macOS**、**Node 22 或更高**、**Chrome**。在你刚解压出来的目录里打开终端：

```bash
node bootstrap/install.mjs          # dry run：只打印"打算"改哪些文件
node bootstrap/install.mjs --apply  # 真装：每一步都会先问你
```

然后一次性的事：

1. Chrome 里打开 `chrome://extensions`，开启**开发者模式**，点**加载已解压的扩展程序**，
   选安装器刚为你构建出来的 `extension/dist` 文件夹。
2. 点扩展图标打开侧边栏 —— 那就是 agent 的窗口。
3. 重启 DeepSeek Harness（`dsh web`）让它加载插件，然后自检：

```bash
node bootstrap/doctor.mjs           # 检查 DSH、配对、构建产物、连通性
```

安装器会问你装到哪、DSH 数据目录在哪；检查 Node、DSH、Chrome 与端口；DSH 缺了就替你装；
在你的机器上现场构建扩展；往你的 DSH 设置里加一行（改前先备份）；最后自证一遍。
想卸掉：`node bootstrap/uninstall.mjs`。

*（不支持 Windows。安装器会明确说明并**当场停下**，而不是假装成功。）*

---

## 给工程师

设计文档、变更记录与台账在 [`docs/`](./docs)。面向模型的工具是 `browser_read`、`browser_tabs`、
`browser_wait`、`browser_screenshot`、`browser_ax`，以及受闸门保护的写操作；两条本机通道是
`/ag/agent`（扩展侧）与 `/ag/client`（DSH 页面侧）。`npm run check` 跑全部门禁，`npm run probe:all` 跑真 Chrome 探针。
