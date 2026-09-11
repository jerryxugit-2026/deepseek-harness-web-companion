# DeepSeek Harness Web Companion (DSH 浏览器智能侧伴侣)
# 产品需求定义与系统架构说明书 (PRD & Tech Spec)

**文档版本**：v3.0.0  
**更新时间**：2026-09-11  
**文档归属**：`/Users/mac/ai_tools/dsh project/网页插件/`  
**关联文档**：[详细设计规范说明书(v3.0)](./详细设计文档.md) · [实测证据与可行性报告](./FINDINGS.md)  
**状态**：极简方案定稿 / 工程实现基准

---

## 一、 项目背景与核心动因

### 1.1 现状洞察：Chrome 原生 Gemini 侧边栏的启发
Google Chrome 浏览器内置的 Gemini 侧边栏功能（位于浏览器侧面）。用户浏览任意网页时，点击即可呼出右侧并排的工作面板，支持跨页面分析、文档答疑或文件交互。这种**“网页浏览与 AI 伴侣并排工作（Side-by-Side）”**的形式，将信息输入与思考的上下文切换成本降到了最低。

### 1.2 核心痛点：云端大模型沙箱 vs 本地高能 Agent 的鸿沟
虽然 Chrome 原生 Gemini 侧边栏非常方便，但在**真实软件研发、深度工程实现与本地生产力**场景下，存在三大致命断层：
1. **无法触碰本地环境**：云端 Gemini 处于云端沙箱隔离，无法读取开发者本地工程仓库、无法查看本地运行日志。
2. **缺乏行动执行力（No Actionability）**：它只能“给建议”，无法直接修改本地代码、无法运行本地单测、无法执行终端编译与 Git 操作。
3. **工具与模型生态受限**：无法联动本地已经配置好的 Model Context Protocol (MCP) 本地工具集、本地数据库和本地终端沙箱。

### 1.3 本项目的核心使命：DSH 单内核驱动的本地超级侧伴侣
打造一个能在 Chrome 侧边栏直接驱动 **DeepSeek Harness (DSH)** 完全体 Agent 的轻量浏览器伴侣：
> **在保持 Chrome 原生侧边栏“即点即开、并排显示”极致体验的同时，直接内嵌本地 DeepSeek Harness（Node.js/Cordis 原生生态，监听 3080），用户在输入框写下“看左边”或点击按钮瞬间完成左侧网页全量快照注入，按需调用底层配置的任意顶级 LLM（DeepSeek / Claude / Gemini），打通从“网页信息获取”到“本地工程修改与命令执行”的完整闭环。**

---

## 二、 竞品与参考对象对比分析

| 维度 | Chrome 原生 Gemini 侧边栏 | 本项目方案 (DSH Web Companion) |
| :--- | :--- | :--- |
| **展现形态** | Chrome Side Panel 原生面板 | **Chrome Side Panel 微壳容器 + 内嵌 DSH 原生 GUI** |
| **智能内核** | Google 云端服务器沙箱 | **DeepSeek Harness (本地 3080) · 支持自由配置切换不同大模型** |
| **本地文件与终端** | ❌ 严禁访问本地磁盘/终端 | ✅ **支持本地 Workspace 读写、终端 Bash 与代码修改 (Diff)** |
| **网页上下文 Attach** | 纯云端文本提取 | ✅ **“看左边”即刻全量快照：结构化 Markdown + 视口截图 + 视频字幕** |
| **反向浏览器控制** | ❌ 不支持 | ✅ **Agent 模型可调用 `browser_*` 工具读/写/点击当前页** |
| **界面开发成本** | 闭源官方实现 | ✅ **100% 复用 DSH 成熟 Web GUI（Thinking/Tool/审批全部免费获得）** |
| **系统开销与体积** | 依赖云端 | ✅ **扩展体积 < 1MB；本地 0 新增常驻进程（完全复用既有 DSH 3080）** |
| **数据隐私与安全** | 全部网页传至公网云端 | ✅ **数据严守 `127.0.0.1` 本地回环；预共享密钥 + 钉死 Extension ID** |

---

## 三、 产品定义与定位

* **产品名称**：`DSH Web Companion`（中文简称：`DSH 网页伴侣`）
* **定位**：面向工程与科研开发者的本地 Agent 浏览器端延伸入口与上下文捕获器。
* **一句话价值主张**：*“输入‘看左边’，瞬间将任意网页抓入本地 DSH 工程，自动阅读视频字幕与文档并直接修改本地代码。”*

---

## 四、 核心功能需求规范 (Functional Requirements)

### 4.1 展现与交互模块 (UI / Surface)
* **FR-1.1 原生侧边栏容器（Chrome Side Panel）**：
  * 利用 Chrome Manifest V3 的 `chrome.sidePanel` API 构建原生侧边栏，不挤占网页内部 DOM，与网页平铺并排。
  * 支持浏览器右上角 Action 图标一键开关，支持全局快捷键唤起（macOS: `Cmd + Shift + G`）。
* **FR-1.2 极简顶栏与 DSH 界面内嵌**：
  * 顶栏常驻品牌标识 `[⚡ DeepSeek Harness]`、健康指示灯与 **`[👀 看左边]`** 一键快照按钮。
  * 侧边栏主体直接挂载 DSH 原生 Web GUI（利用 `/ag/enter` 签发 `SameSite=None; Secure` 会话 Cookie 解决跨域认证）。
  * 零开发成本获得 Thinking 思维链折叠展收、Tool Calls 状态卡片、会话历史、工作区选择与权限审批。

### 4.2 上下文捕获引擎 (Context Capture Engine / Attach)
* **FR-2.0 [“看左边”意图即刻全量快照] (Intent-Driven Full Snapshot)**：
  * **彻底消除用户的认知与操作成本**：用户不需要纠结“该截图还是该读文本”，只要在输入框写下包含 **“看左边”** 的任何指令（例如：*“看左边，总结核心要点”*、*“看左边视频，讲了什么技术架构”*），或点击顶栏 **`[👀 看左边]`** 按钮，系统在 100-300ms 内**瞬间对左侧当前激活页完成多维全量快照**：
    1. 结构化降噪正文 Markdown（自动过滤导航、页脚、广告与无关脚本）；
    2. 当前视口的高清多模态快照（PNG Base64 截图）；
    3. 视频字幕轨（Transcript）与播放进度元数据；
    4. 用户当前划词高亮文本（若有，自动提升为置顶引用）。
  * **完全省去后台实时追踪**：不写“看左边”就是普通的纯本地任务，写了“看左边”就瞬间把左侧拉入战局，既保证读到最新页面，又彻底杜绝无效 Token 挥霍与电池消耗。
* **FR-2.1 [网页视频多维度读取] (Video & Media Reading)**：
  * **字幕提取（Transcript）**：针对包含视频的网页（如 YouTube、Bilibili、网课平台），自动提取全部字幕与台词文本，带时间戳喂给 Agent。
  * **播放元数据**：提取当前视频标题、播放时长、当前暂停秒数、视频描述。
  * **画面截取**：通过视口快照直接将视频当前画面的代码、PPT、架构图带入多模态模型。
  * *(注：不传输未解码的原始庞大 raw mp4 二进制流，DRM 加密视频遵循浏览器硬件保护)*。
* **FR-2.2 结构化上下文注水机制**：
  * 将抓取内容以 `.md` 文件落盘至工作区 `网页捕获/` 目录，通过 Client 插件在 DSH 输入框上方弹出可删除的上下文胶囊 `[📄 网页: React 19 Docs ✕]`，输入框插入结构化 `@文件` 引用。

### 4.3 浏览器反向控制与本地工具闭环 (Browser Control & Local Action)
* **FR-3.1 本地工程完全体执行**：
  * 运行中的 Agent 拥有对本地指定工作区的读写权限，可直接编辑代码、创建文件、运行本地 Bash 终端命令。
* **FR-3.2 Agent 反向操作浏览器 (`browser_*` 工具)**：
  * Agent 模型在执行复杂任务时，可主动调用浏览器工具：
    * `browser_read_page`：读取当前或指定标签页内容。
    * `browser_screenshot`：对页面进行截屏验证。
    * `browser_click` / `browser_type`：模拟点击与表单输入（写操作默认受权限管控）。
* **FR-3.3 守护拉起器规划 (Go Launcher)**：
  * 现阶段聚焦核心功能（基于本机稳定运行的 3080 端口 DSH 实例），Go 守护拉起器列为后续工程增强项，当前不做。

### 4.4 平台兼容性与硬性边界 (Platform Constraints)
* **支持平台**：严格聚焦于 Chromium 系现代浏览器（**Google Chrome**、**Microsoft Edge**、**Brave**、**Arc**）。
* **Safari 平台明确不做（硬阻断）**：Safari 官方底层无 `sidePanel` 扩展 API，且苹果系统对本地 `127.0.0.1` 跨域有严格的 ATS 拦截，在网页内强插 iframe 的伪侧边栏方案极度脆弱且违背产品标准，项目明确放弃 Safari。

---

## 五、 系统总体技术架构

系统由 **Chrome MV3 扩展 (TypeScript)** 与 **DSH 进程内插件 (Node.js)** 构成：

```
/Users/mac/ai_tools/dsh project/网页插件/
├── extension/                     # Chrome MV3 扩展（TypeScript 编写，体积 <1MB）
│   ├── manifest.json              # 扩展清单（固定 Extension ID，声明 sidePanel）
│   └── src/
│       ├── sidepanel/             # 侧边栏微壳（panel.html、iframe 挂载、顶栏按钮）
│       ├── content/               # 网页提取脚本（正文清洗、视频字幕、视口截屏）
│       └── background/            # 后台 Service Worker（调度与通信中转）
│
├── dsh-plugin/                    # DSH 进程内插件（Node.js 编写，复用 3080 端口，0 额外进程）
│   ├── src/host/                  # Host 插件（/ag/ping, /ag/enter, /ag/attach, WS 工具桥）
│   └── src/client/                # Client 插件（网页端注入，输入框胶囊与草稿管理）
│
└── scripts/                       # 快速链接与辅助脚本
```

---

## 六、 实施与演进路线图

* **阶段 1：骨架与 DSH 认证贯通 (M1)**
  * 扩展侧边栏实现微壳容器与 iframe 挂载。
  * DSH 插件就绪，验证 `/ag/enter` 在 iframe 内顺利通过 `SameSite=None; Secure` 认证，DSH GUI 完整展示且 WebSocket 畅通。
* **阶段 2：“看左边”全量快照与工作区注水 (M2)**
  * 完成 Content Script 自包含提取（正文降噪 Markdown、视频字幕、视口截图）。
  * 打通输入框“看左边”关键词意图拦截与顶栏【👀 看左边】按钮。
  * 打通 DSH 工作区 Markdown 落盘与输入框上下文胶囊。
* **阶段 3：浏览器双向控制与工具桥 (M3)**
  * 注册并跑通 `browser_*` 系列模型工具。
* **阶段 4：体验打磨与交付 (M4)**
  * 快捷键与窄栏样式极致优化。
  * 一键插件链接脚本。

---

**文档批准**：  
本文档为项目最终版需求与技术框架规范，与 `详细设计规范说明书(v3.0)` 保持完全一致，作为后续开发与技术评审的标准依据。
