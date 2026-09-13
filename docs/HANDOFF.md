# 交接提示词（新会话从这里开始）

> 本文件路径：`/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`
> 用途：把这个项目交给一个**没有上下文的新会话**。第一节是**可直接整段复制粘贴**的提示词；
> 后面是本次核心任务、现状摘要、**路径速查（全绝对路径）**、检索纪律与避坑清单。
>
> **本版写于 2026-09-12 深夜（v3.41 收尾）**：上一轮做了 P0 剩余 → 探针重跑 → P1 → P2 的整改，
> 并陪用户走完一轮**真机人工验收**。本轮新写/改写的关键证据文件：
> `docs/reviews/manual-acceptance-2026-09-12.md`（人工验收全记录）、`docs/CHANGELOG.md` 的 **v3.41 §1–§12**。

---

## 一、可直接粘贴的提示词

```
你接手一个**已经实现、已在真机验收过**的项目：DSH Web Companion
（Chrome 侧边栏扩展 + 本地 DSH 进程内桥接插件 + native messaging 拉起器）。

【第 0 步 · 先定检索方式（强制，不许跳过）】
先读 `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md` —— 那是本机**唯一真源**的检索规范。
之后本项目的一切检索都必须按它执行：
  - **文档问题**（规格/方案/笔记/README/研究）→ 先调 `mcp__semble__search`（必须显式 `--content docs`）；
    CLI 等价物：`/Users/mac/.local/bin/semble search "查询" /Users/mac --content docs`。
  - **代码问题**（符号/函数/调用链/调用者/影响面/"X 怎么工作"）→ 先调 `mcp__codegraph__codegraph_explore`，
    本项目用 `projectPath: "/Users/mac/ai_tools/dsh project/网页插件"`；
    查 DSH 引擎自身实现用 `projectPath: "/Users/mac/.codegraph-dsh-engine"`。
    **它的返回是 Read 等价物（逐字源码 + 行号）—— 不要再 Read 重开那些文件。**
  - 只有"全树字面量扫描"才用 Grep / rg；**在 `/Users/mac/.codegraph-dsh-engine` 里绝不要用 rg**
    （那是符号链接农场，rg 默认不跟随 → 恒 0 命中，据此判定"符号不存在"是错的）。

【第 1 步 · 按顺序读这些文档（全绝对路径）】
  1. `/Users/mac/ai_tools/dsh project/网页插件/详细设计文档.md`        —— 设计真源（目标 / ADR / 协议 / 模块 / 安全模型）
  2. `/Users/mac/ai_tools/dsh project/网页插件/docs/11-台账.md`       —— 台账（完成度 vs 设计、差异、未做清单、证据索引）
  3. `/Users/mac/ai_tools/dsh project/网页插件/docs/PROGRESS.md`      —— 跨轮进度与续跑规则（含"待办，按顺序取"）
  4. `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`       —— 本文件（核心任务 + 现状 + 避坑清单 + 验收口味）
  5. `/Users/mac/ai_tools/dsh project/网页插件/docs/reviews/manual-acceptance-2026-09-12.md`
     —— 最近一次真机人工验收的全记录：哪些项 ✅、哪条旧期望被实测**推翻**、哪些项**未验**（含原因与解锁条件）

【第 2 步 · 自己把现状跑一遍（不要只信文档，文档可能过期）】
  cd "/Users/mac/ai_tools/dsh project/网页插件"
  npm run check        # 协议一致性 + 20 条反模式规则 + 23 个单测文件 + 构建 + dist 端口门禁；不需要浏览器
  npm run probe:all    # 8 个真 Chrome / 真模型探针；会自己拉起测试用 DSH（占 3099 端口），结束时只杀自己拉的那个
  两条都应全绿。若失败，先判断是**产品缺陷**还是**探针自身问题**（历史上两者都出现过，见 HANDOFF 第六节）。

【第 3 步 · 报告】
  告诉我：① 你实际跑出来的结果与台账/验收记录是否一致（不一致必须指出）；
  ② 你打算怎么推进下面两个核心任务（先给方案与取舍，不要直接大改）。

【本次的核心任务（第二优先级低于"先把现状跑一遍"）】
  A. **做这个项目的英文版**：面向英语用户的产品文案/UI/README，以及（要不要连文档一起翻，问我）。
  B. **把它做成"可下载、自动检查依赖、安装部署"的程序**：一键安装/卸载、依赖与平台检查、
     扩展与 native host 的落地方式、DSH 插件挂载的稳定性。
  HANDOFF 第二节已经把我（上一轮）能查到的翻译面积与打包阻力列出来了，先从那节读起。

【工作纪律（必须遵守）】
  - 任何结论都要带证据来源：实测（命令 + 输出）、源码（文件:行号）、文档、推理；**没测过的必须标注"未验"**。
  - 改了行为就在 `docs/CHANGELOG.md` 追加一条（含**为什么**，以及被推翻的旧结论）。
  - 收工前 `npm run check` 必须全绿；改了探针/协议就补跑对应的 `npm run probe:*`。
  - **不允许**为了让测试变绿而放宽断言或改验收目标值；要改目标值必须先问我。
  - 探针必须**顺序无关、次数无关**（不得谎报共享状态、不得长期占用固定端口、不得改全局设置）。
  - 新写的单测文件**必须加进 `package.json` 的 `test:unit` 链**，否则 `npm run check` 根本跑不到它（＝门禁假绿）。
  - 遇到"只有真人能做的事"（用户手势弹窗、有头界面判断、改 Chrome 设置），停下来告诉我，别绕过。
  - **跟我沟通一律用绝对路径**（用户明确要求）：提到任何文件都写全路径，
    例如 `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`，
    **不要**只写 `docs/HANDOFF.md` 这种相对路径。

现在开始：先读检索规范 → 再读那五份文档 → 然后跑那两条命令 → 报告。
```

---

## 二、本次的两个核心任务（上一轮已做的侦察，别从零开始）

### A. 英文版

**已查清的面积**（2026-09-12 统计，供你直接规划；数字是"中文字符数"，含注释与文案）：

| 位置 | 规模 | 性质 |
|---|---|---|
| `extension/manifest.json` | `name` / `action.default_title` 是中文（`description` **已是英文**） | 用户第一眼看到的 |
| `extension/src/sidepanel/panel.html` | 42 行，~300 中文字符 | 面板标签、按钮、状态区 |
| `extension/src/sidepanel/panel.js` | 339 行，~2200 中文字符 | 状态文案、开关提示（**含审批口径那几句**）、报错翻译 |
| `extension/src/sidepanel/errors.js` | 26 行，~240 中文字符 | 面向用户的错误解释（"你该做什么"） |
| `extension/src/sw/{index,capture,menu,ops/index}.js` | ~1900 行，~6800 中文字符 | SW 侧：`chrome.contextMenus` 标题、抓取/权限错误的用户可见文案 |
| `dsh-plugin/src/host/tools.js` | — | **`browser_*` 工具的 `description` / 参数说明是中文** —— 这些是**面向模型**的，英文版必须一并翻 |
| 抓取落盘目录名 `网页捕获/` | 出现在 `@网页捕获/…` 引用、front-matter、保留策略正则、探针断言里 | ⚠️ **这是数据契约**：改名会让历史引用失效，必须与用户确认（可能要"新装用英文名、老装保留原名"） |
| `README.md`（12K）+ `docs/`（19 个 md + `详细设计文档.md`，1.4M）+ `docs/reviews/` | 全中文 | **开发/设计文档**。产品英文版是否需要翻它们，取决于你的目标用户 —— 先问用户 |

**建议的技术路线（供讨论，不是结论）**：
1. **UI 走 `_locales/` + `chrome.i18n`**：manifest 的 `name`/`description`/`action.default_title` 支持 `__MSG_*__`，
   面板与 SW 用 `chrome.i18n.getMessage()`；`default_locale: "en"`，语言包 `zh_CN` + `en`。
   注意：SW/面板里的文案目前是**散落的字面量**，要先把它们收成一份 key→文案表（这本身是重构，要有断言挡住回归）。
2. **模型面向文案**（`tools.js` 的 description/参数说明）**不走 chrome.i18n**（宿主进程没有该 API），
   要自己选一套：跟随 DSH 的 locale / 读环境变量 / 构建期生成两份产物 —— 先定这个决策再动手。
3. **抓取目录名与 front-matter** 属于**数据格式**：改之前先看 `dsh-plugin/src/host/retention.js`（`CAPTURE_FILE`/`ASSET_FILE` 正则）
   与 `store.js#write`、以及所有探针断言里的 `网页捕获` 字面量。

**必须先问用户的**：① 英文版是"同一份代码双语"还是"两个发布渠道各一份"？
② 抓取目录/`@引用` 要不要改成英文名（会牵动历史文件与所有断言）？
③ README 与设计文档是否也要英文（工作量差异极大）。

### B. 可下载 / 自动检查依赖 / 一键安装部署

**现在的手工流程**（`README.md` 的"快速开始"，逐条对应一个自动化缺口）：

```bash
npm install                     # 依赖（devDeps: ws, codegraph；runtime deps 为空）
node scripts/init-key.mjs       # 生成配对 key（幂等）→ ~/.dsh/dsh-web-companion.json
node native-host/install.mjs    # 写 Chrome native messaging host 清单 + run-host.sh
npm run build:ext               # esbuild → extension/dist
dsh web                         # 起 DSH
# 然后：chrome://extensions → 加载已解压的扩展程序 → 选 extension/dist
# 再然后：手工往 ~/.dsh/profiles/web/cordis.patch.yml 插一行绝对路径的插件挂载
```

**已查清的阻力点（每一条都是真问题，不是猜想）**：

| 阻力 | 事实（源码/实测） | 影响 |
|---|---|---|
| **插件挂载是用户 profile 里的绝对路径** | `/Users/mac/.dsh/profiles/web/cordis.patch.yml` 里 `name: '<绝对路径>/dsh-plugin/src/host/index.js'` | 安装器必须把插件放到**稳定安装目录**（如 `~/.dsh/plugins/dsh-web-companion/`）并改这一行；升级时要防止路径漂移 |
| **扩展 ID 由 `manifest.json` 的 `key` 决定** | `native-host/install.mjs#extensionIdFromKey` 从 `key` 推导 ID，写进 host 清单的 `allowed_origins`；配对文件里也要登记同一个 `chrome-extension://<id>` | 换 key ⇒ ID 变 ⇒ native host 清单、配对文件、文档、探针都要同步（**上一轮有过私钥外发事故，用户明确决定"不轮换 key"**，所以英文版是否复用同一 key 要问用户） |
| **Chrome 不允许静默装扩展** | Chrome 137+ 忽略 `--load-extension`（探针改走 CDP `Extensions.loadUnpacked`）；`loadUnpacked` 要求**路径不含空格**（探针因此先把 dist 拷到 `/tmp`） | 真正的"一键"要么走 **Chrome Web Store**，要么走**企业策略强制安装**，要么用**启动器**（自己起 Chrome 并带扩展）。三条路的取舍必须先跟用户定 |
| **native host 清单要落到 Chrome 的目录** | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dsh.web_companion.json`（`native-host/install.mjs` 写） | macOS 上还好；跨平台（Linux `~/.config/google-chrome/NativeMessagingHosts`、Windows 注册表）需要分支 |
| **`dsh` CLI 与 Node 版本是硬依赖** | 插件跑在 DSH 进程内；native host 用 `process.execPath`（`run-host.sh` 里写死当前 node 路径） | 安装器要检查：`dsh` 在 PATH、Node ≥ 某版本、端口 3080 空闲、`~/.dsh` 可写 |
| **端口/密钥一致性有门禁** | `npm run check:dist` 断言 `extension/dist` 与**真实配对文件**同端口（`scripts/check-dist-config.mjs`） | 发布产物必须按用户的真实端口构建；安装器要在装完后再跑一次这个门禁 |
| **没有打包/发布脚本** | `package.json` 无 `pack`/`zip`/`release`；`extension/build.mjs` 只构建 dist | 要做：产出一个**带版本的 zip/crx**（或 npm 包），并写好版本号策略（当前 `0.1.0`，CHANGELOG 版本是 v3.41，两者**不是同一个号**） |

**建议的第一步（供讨论）**：先写一个**幂等的 `install.mjs`**（检查依赖 → 生成/复用 key → 构建 → 装 native host → 把插件拷到稳定目录并**幂等**改 profile YAML（可回滚、带备份）→ 打印"接下来在 Chrome 里点三下"），
再写 `uninstall.mjs`（把上面每步反向，含从 YAML 里移除挂载行）。**"扩展怎么落地"单独决策**，不要和安装器混在一起。

---

## 三、路径速查（全部绝对路径）

### 项目与文档

| 是什么 | 绝对路径 |
|---|---|
| 项目根（git 仓库根） | `/Users/mac/ai_tools/dsh project/网页插件` |
| 设计真源 | `/Users/mac/ai_tools/dsh project/网页插件/详细设计文档.md` |
| **台账** | `/Users/mac/ai_tools/dsh project/网页插件/docs/11-台账.md` |
| 交接提示词（本文件） | `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md` |
| 跨轮进度与续跑规则 | `/Users/mac/ai_tools/dsh project/网页插件/docs/PROGRESS.md` |
| 版本改动与原因（**含被推翻的旧结论**） | `/Users/mac/ai_tools/dsh project/网页插件/docs/CHANGELOG.md` |
| **最近一次真机人工验收记录** | `/Users/mac/ai_tools/dsh project/网页插件/docs/reviews/manual-acceptance-2026-09-12.md` |
| 人工验收清单（只列机器做不了的） | `/Users/mac/ai_tools/dsh project/网页插件/docs/09-manual-checklist.md` |
| 实机验收测试方案（T1–T13） | `/Users/mac/ai_tools/dsh project/网页插件/docs/12-实机验收-测试方案.md` |
| 自动化分层（哪些能无人跑） | `/Users/mac/ai_tools/dsh project/网页插件/docs/10-automation.md` |
| 探针与审核报告 | `/Users/mac/ai_tools/dsh project/网页插件/docs/reviews/` |
| **检索工具规范（唯一真源）** | `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md` |
| 工作区全局 agent 指令 | `/Users/mac/ai_tools/AGENTS.md`、`/Users/mac/.dsh/AGENTS.md` |

### 代码与产物

| 是什么 | 绝对路径 |
|---|---|
| 桥接插件（宿主端） | `/Users/mac/ai_tools/dsh project/网页插件/dsh-plugin/src/host/` |
| 桥接插件（DSH 页面内那半） | `/Users/mac/ai_tools/dsh project/网页插件/dsh-plugin/lib/client.js` |
| 扩展源码 | `/Users/mac/ai_tools/dsh project/网页插件/extension/src/` |
| 扩展构建产物（Chrome 加载的就是这个目录） | `/Users/mac/ai_tools/dsh project/网页插件/extension/dist` |
| 扩展清单（含固定 ID 的 `key`） | `/Users/mac/ai_tools/dsh project/网页插件/extension/manifest.json` |
| 协议单源 schema / 代码生成器 | `/Users/mac/ai_tools/dsh project/网页插件/protocol/messages.schema.json`、`/Users/mac/ai_tools/dsh project/网页插件/protocol/codegen.mjs` |
| native messaging 拉起器与安装脚本 | `/Users/mac/ai_tools/dsh project/网页插件/native-host/`（`install.mjs` / `host.mjs` / `run-host.sh`） |
| 单测（23 个文件） | `/Users/mac/ai_tools/dsh project/网页插件/tests/unit/` |
| 各里程碑探针 | `/Users/mac/ai_tools/dsh project/网页插件/tests/{m0a,m0b,m1,m2,m3}/` |
| 质量回归与审计 | `/Users/mac/ai_tools/dsh project/网页插件/tests/quality/` |
| 运维脚本（批量探针/文档图谱/一致性检查/材料守卫/对抗审核驱动） | `/Users/mac/ai_tools/dsh project/网页插件/scripts/` |

### 运行时与本机环境

| 是什么 | 绝对路径 |
|---|---|
| 测试用 DSH 数据目录（探针用） | `/Users/mac/ai_tools/dsh project/网页插件/.devhome` |
| 测试用 DSH 的抓取落盘目录 | `/Users/mac/ai_tools/dsh project/网页插件/.devhome/workspace-m0a/网页捕获` |
| **用户真实使用的抓取落盘目录** | `/Users/mac/ai_tools/dsh project/网页捕获` |
| 配对密钥文件（真实 profile） | `/Users/mac/.dsh/dsh-web-companion.json` |
| 测试用配对密钥 | `/Users/mac/ai_tools/dsh project/网页插件/.devhome/dsh-web-companion.json` |
| **真实 profile 的插件挂载行**（含本轮的 `approvalForWriteOps: false`） | `/Users/mac/.dsh/profiles/web/cordis.patch.yml` |
| 上面那个文件的备份（改之前） | `/Users/mac/.dsh/profiles/web/cordis.patch.yml.bak-before-approval-off` |
| 测试 profile 的插件挂载行 | `/Users/mac/ai_tools/dsh project/网页插件/.devhome/profiles/web/cordis.patch.yml` |
| native host 清单（Chrome 侧） | `/Users/mac/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dsh.web_companion.json` |
| native host 日志 | `/Users/mac/.dsh/logs/dsh-web-companion-host.log` |
| **审计日志（宿主侧，JSONL）** | `/Users/mac/.dsh/logs/web-companion-audit.jsonl` |
| 扩展侧审计（ring buffer 200） | `chrome.storage.local['ag-audit']`，读法 `chrome.runtime.sendMessage({kind:'audit'})` |
| codegraph 引擎索引根 | `/Users/mac/.codegraph-dsh-engine` |

> 测试用 DSH 与真实 DSH 是**两个数据目录**（`.devhome` vs `~/.dsh`），端口也不同（**3099 vs 3080**）。探针只碰前者。

---

## 四、检索纪律（按 `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md` 执行）

| 你要找什么 | 用什么 | 备注 |
|---|---|---|
| 文档、散文、笔记、规格、README、方案 | `mcp__semble__search` | 服务在 `http://127.0.0.1:8757/mcp`，**必须在 Warp 终端启动**；首次查询可能几分钟（在建索引），不是挂了 |
| 代码、符号、调用链、影响面 | `mcp__codegraph__codegraph_explore` | 输出是 **Read 等价物**，别再 Read 重开；本项目用绝对 `projectPath` |
| 全树字面量扫描 | Grep / rg | 仅此一种情况 |
| 在 `/Users/mac/.codegraph-dsh-engine` 里 | **只能用 codegraph** | 符号链接农场，rg 默认不跟随 → 恒 0 命中 |

**2026-09-12 实测补充（两件事，能省你半小时）**：

- **改完文档不用手工重建索引**：semble 会在改完后的**第一次查询**里自动增量重建（实测 22:19:00 发出 → 22:22:43 返回，≈223s：181s 遍历 + 建索引），之后查询 <1s。别把"这次特别慢"当成服务挂了。
  （另外 `/Users/mac/.dsh/logs/semble-http.log` **可能是陈旧文件** —— 服务若在前台终端里起，stdout 在那个终端而不是这个日志。）
- **泛中文词排不上名次是能力边界，不是索引陈旧**：专名词（`approvalForWriteOps`、`manual-acceptance-2026-09-12`、`install.mjs`）一查即中；
  但 `交接提示词`、`英文版` 这类词在 `/Users/mac`（14,992 文件）上可能排不进 top-50（嵌入模型是**代码模型** `potion-code-16M-v2`，对中文散文弱）。
  **做法：查询里带上文件名/目录限定词**（`HANDOFF.md`、`网页插件`）—— 实测能把目标文档顶到 #1。

CLI 回落（MCP 不可用时）：

```bash
/Users/mac/.hermes/node/bin/codegraph explore "查询"
/Users/mac/.local/bin/semble search "查询" /Users/mac --content docs
```

---

## 五、现状摘要（v3.41，2026-09-12）

**能用的完整链路**：点侧边栏 → 看到本机 DSH 界面（自动登录）→ 抓网页 / 划词 / 在输入框写「看左边」→
变成工作区 `网页捕获/*.md` 并把 `@文件` 贴进输入框（**有 ack 回执为证**）→ 模型能反过来读页面、点击、填表、截图。

**技术栈**：Chrome MV3 扩展（纯 JS + esbuild）+ DSH 进程内插件（ESM）+ native messaging 拉起器（Node）+ 一份协议 schema 生成三端代码。

| 命令 | 需要什么 | 覆盖 |
|---|---|---|
| `npm run check` | 无 | 协议一致性（codegen 逐字节 + 23 正向量/13 反向量）、**20 条**反模式规则（235+ 文件）、**23 个**单测文件、构建、体积门禁、`check:dist`（产物端口 == 真实配对文件端口） |
| `npm run probe:all` | 本机 Chrome + DSH | **8 个**探针：debugger 能力、意图桥接跳、抓取、多站点质量、浏览器 op 层、写操作控制面、意图全链路、真模型回合 |
| `npm run probe:attach` / `probe:chip` / `probe:panel` | 本机 Chrome + DSH | 不在 `probe:all` 里，**要单独跑**（attach 含积压补投与 413 连接语义；chip 胶囊；panel 含"面板读到的开关状态 == 插件真实态"） |
| `npm run probe:perf` | 同上 | G1/G2/G6 基线（**G1 是浮动基线、不参与退出码**；G2/G6 是硬门禁） |
| `npm run audit:captures` | 无（读已有文件） | 用真实抓取文件统计噪音与结构完整性 |

**最近一轮（v3.41）修了什么**（细节见 CHANGELOG v3.41 §1–§12，这里只列"新会话最容易再踩"的）：

- **P1**：`mode:'screenshot'` 抓不到图却回 `ok:true`（假绿）；**积压抓取补投**（`request-pending` 之前无 handler，队列是**只写**的）；
  `perf` 判定改造（G1 → 基线）。
- **P2**：协议 `error.code` 收紧为 `$ref: ErrorCode` 并**补齐 5 个真实在用的码**（不补就丢帧）；
  `captureId` 在 `ok:true` 时必填（校验器补 `if/then`，顺手修掉"只有 `required` 的子模式不检查"）；
  `ROUTE` 表补 `wsEcho`/`wsProbe`（不再字符串替换拼路由）；`stamp` 去重；`paired` 口径统一；
  `/ag/ping` 少探针时不再 500；`pimoa-review` 驱动（receipt 解析 + 换 `node:http` 绕开 undici 的 300s 墙）。
- **我上一版埋的回归**：v3.40 把面板"读写开关"从 POST 改成 GET，而 **Chrome 对扩展文档的简单 GET 不带 `Origin`** ⇒
  F2 一律 403 ⇒ 面板永远显示开关是关的。修法：`guard.originOk` 对称化 F4（Origin 缺失时要求 `Sec-Fetch-Site: none` + `Sec-Fetch-Mode: cors`）。
- **真机抓到的两个工具层缺陷**：`browser_ax` 的 output schema 把 CDP 的 `AXNode.nodeId`（**字符串**）声明成 number ⇒
  模型只收到 `invalid output`；`browser_screenshot` 的 `execute` 用了 `randomBytes` **却没 import** ⇒ 每次截图 ReferenceError。
  两者都因为"op 层探针 + 手搓夹具"而漏网 ⇒ 新增门禁：`probe:m3-ops` 用**真实 CDP 值**驱动**8 个工具**的 `execute()` 并撞各自声明的 schema（39 断言）。
- **页面的回执帧（`ClientAckEvent`）之前被静默丢弃**（有生产者无消费者，同 `request-pending`/`agent-hello`）⇒
  审计里曾有 **0 条** ack；现在每次抓取都会留一条 `{"kind":"ack",…,"status":"inserted"}`。
- **审批语义**：本机部署已按用户要求改成 `approvalForWriteOps: false`（写操作只由面板开关把关，`approvalMode: "off"`）。

**真机人工验收结果**（详见 `docs/reviews/manual-acceptance-2026-09-12.md`）：
✅ B4 横幅（**不是常驻**，只在调用进行中出现）、B6 取消开关→`E_NO_PERMISSION`、C8/C9 写「看左边」可重复、C10 意图补投、
D 抓取质量（用户判"够了"）、E14 保留策略双向、写操作演示（无审批放行 + 页面真变）、ack 留痕；
❌ **B7 旧期望被推翻**（DevTools 打开着**不**阻塞我们的 attach —— 新版 Chrome 允许并存，文档已改）；
⛔ **未验**：A 授权弹窗三分支（用户决定不跑）、E13 native host 自拉起（日志只有 2026-09-11 那次实测）、
**审批弹窗的交互本身**（本会话策略是 `never`，弹窗弹不出来；unit 层 37 断言只覆盖判定逻辑）。

**git 状态**：HEAD 约 `0538a8e` + 一百多个脏文件（本轮改动都还没提交，**新会话不要擅自 `git checkout`**）。

**仍然挂着的（台账 §5 有完整清单）**：面板没有截图按钮；G5 的 SPA 成功率样本；域名黑名单；快捷键；`probe:all` 未进 CI；
以及本次两个新核心任务（英文版、安装部署）。

---

## 六、避坑清单（这个项目真踩过的，别再踩）

### A. 测试与断言（本项目栽得最多的地方）

1. **"测错了层"是本项目第一号缺陷来源**：op 层绿 ≠ 工具层绿。`browser_ax`/`browser_screenshot` 两个真机缺陷都是
   "探针只调 op、单测只喂手搓夹具"漏掉的。**凡是模型看得到的东西，必须有一条断言走模型走的那条路**
   （`tool.execute()` → output schema；`probe:m3-ops` 已用真实 CDP 值覆盖 8 个工具）。
2. **手搓夹具会盖住真缺陷**：`nodeId` 夹具写成数字 `11`，于是"schema 声明成 number"两年都没被发现。
   夹具要**照真实形态**写（CDP 的 `Accessibility.AXNode.nodeId` 是**字符串**；`DOM.Node.nodeId` 才是数字）。
3. **有生产者、没有消费者的帧**：已发现三例（`request-pending`、`agent-hello`、`ack`）。
   加新帧时**两端都要接线**，否则功能"看起来做了"其实数据被丢。
4. **探针必须"顺序无关 + 次数无关"**：两个真踩过的坑 —— ①look-left 用了**固定草稿**，5 秒内连跑第二次会撞上宿主的意图去重（红 3 条）；
   ②ack 断言用**固定 captureId**，而审计文件是**追加**的，上一轮的条目替本轮作答（去掉 handler 仍绿）。
   凡是"读追加日志/复用固定名字"的断言都要唯一化。
5. **判定谓词只认布尔 `true`**：老写法 `filter(v => v === false)` 会把记成 `null`/对象的断言静默算过。
   统一用 `tests/lib/probe-result.mjs`（断言/观测分离），并且**新单测文件必须加进 `test:unit` 链**，否则 `check` 跑不到。
6. **文档里的"期望"也是待验证的假设**：B4「不可消除横幅」、B7「DevTools 打开会 attach 失败」两条期望都被真机**推翻**。
   人工验收发现文档与实现不符时，**改文档并留痕**，不要反过来怀疑产品。

### B. 环境与运行

7. **探针要一个测试用 DSH**：`DSH_HOME="/Users/mac/ai_tools/dsh project/网页插件/.devhome" dsh web --no-open --port 3099 &`。
   `npm run probe:all` 会自己拉、结束只杀自己拉的那个 —— **不要**动用户真实的那个（3080）。
8. **探针会临时改写** `extension/src/lib/dev-config.js`（端口/密钥指向测试实例），结束时自己还原**并重建 dist**。
   中断时检查该文件是否被留在测试端口（`node scripts/check-dist-config.mjs` 会当场抓出来）。
9. **探针会把抓取写进仓库根**（2026-09-12 实测，**同日已修 + 加了门禁**）：`scripts/probe-all.mjs` 曾用 `cwd: <项目根>` 拉起测试 DSH ⇒
   面板 iframe 里那个 DSH 会话的工作目录就是仓库根，它向插件 announce 的 `workspace` 也就是仓库根 ⇒
   凡是不显式钉 `target.workspace` 的抓取（实测 `probe:sites` 的 `target: button` 那次）就落到
   `/Users/mac/ai_tools/dsh project/网页插件/网页捕获/`（仓库里！被 git 看见，还被 doc-graph 当成一份"文档"统计）。
   **已修**：① `scripts/probe-all.mjs` 的 spawn `cwd` 改成测试工作区 `/Users/mac/ai_tools/dsh project/网页插件/.devhome/workspace-m0a`
   （实测：`probe:sites` 的产物现在落在 `/Users/mac/ai_tools/dsh project/网页插件/.devhome/workspace-m0a/网页捕获/`，已被 `.gitignore` 覆盖）；
   ② 新增门禁 `/Users/mac/ai_tools/dsh project/网页插件/scripts/check-repo-root.mjs`（已接进 `npm run check`）：
   仓库根一旦出现 `网页捕获/` 或 `yyyy-MM-dd-HHmm-*.md` 就 **exit 1** 并打印修法（实测：造一个假污染立刻变红）。
   ③ 写探针时仍要**显式钉** `target: { workspace: … }`（直接 POST `/ag/attach` 的那种，参考 `/Users/mac/ai_tools/dsh project/网页插件/tests/m0b/attach-probe.mjs`）。
10. **探针端口撞车**（2026-09-12 顺手修的）：`tests/m0a/permission-probe.mjs` 与 `tests/m2/capture-probe.mjs` 默认夹具端口都是 **3999**、
   `tests/m2/gate-probe.mjs` 与 `tests/m2/look-left-e2e-probe.mjs` 默认 CDP 端口都是 **9233** ⇒ 并发或"上一次残留没退"时直接 `EADDRINUSE`。
   已改为各自独立（3997 / 9235）。**残留进程**另一种表现：某探针 **0 秒**失败 —— 先用
   `lsof -nP -iTCP:<端口> -sTCP:LISTEN` 看谁占着（实测 `probe:agent-turn` 就这么失败过一次，端口一空即通过）。10. **扩展侧改动必须重建 dist**：Chrome 加载的是 `extension/dist`（不是 `src`）；只改 src 不生效。
    改完跑 `npm run check`（含 build + `check:dist`）。
11. **宿主侧改动必须重启 `dsh web`**；**扩展侧改动必须在 `chrome://extensions` 刷新扩展**；**刷新扩展会关掉侧边栏**
    （通道由侧边栏文档持有 ⇒ 之后 `browser_*` 工具会报 `E_EXT_OFFLINE`，这不是 bug，重新打开侧边栏即可）。
12. **运行期开关会归零**：`allowBrowserWriteOps` 是运行期状态，`dsh web` 每次重启回到"关"（安全默认）。
13. **无头 Chrome 与有头不同**：调试横幅、权限弹窗在无头里不出现。

### C. DSH 插件 / 协议契约

14. **`ctx.slots.register(options, component)`**：组件是**第二个位置参数**，返回 React 元素（`react` 是平台种子模块）；
    注册插槽要包在 `ctx.slots.inject(...)` 里（未声明的插槽会抛）。
15. **工具注册**：`defineTool` 从 `@deepseek-ai/dsh-tools` 导入；`inject` 必须含 `'tools'`；
    output schema **每个 object 都要显式 `additionalProperties`**；`required` 写在属性里；失败返回 `{code,message}`。
    **裸 `required`（没有 `properties`）在旧校验器里等于什么都不检查** —— 已在 v3.41 修好，但自己写的 JSON-Schema 也要照此留意。
16. **协议是闭集**：`ClientAckEvent` 之类**没有** `protocolVersion` 字段，多带一个就会被整帧拒掉；
    `error.code` 现在是 `$ref: ErrorCode`，**新码必须先加进 schema 枚举 + `docs/01 §2.6`**，否则帧被丢。
17. **`debugger` 权限不能声明为"可选"**（Chrome 会拒绝）；必须放必需权限，用运行期开关控制是否 attach。
18. **F2 的真实形态**：扩展**文档**发的简单 GET **不带 `Origin`**，只带 `Sec-Fetch-Site: none` + `Sec-Fetch-Mode: cors`；
    非简单方法（POST）才带精确 Origin。改鉴权时这两条都要考虑（v3.41 的回归就是这么来的）。
19. **`/ag/attach` 的 200 响应是扁平对象**（`{ok, captureId, fileRef, filePath, deliveredTo}`），不是 `{ok,value}` 信封；
    413 必须带 `connection: close`（否则客户端复用死 socket，下一个请求必踩 `ECONNRESET`）。

### D. 平台细节

20. **macOS 文件时间戳是纳秒精度**：毫秒级"恰好相等"的边界断言会 1µs 假失败，用 ±1s 边距。
21. **`chrome.tabs.captureVisibleTab` 限流 2 次/秒**且只能抓当前活动标签页；抓后台标签页或整页要走调试器。
22. **DevTools 打开着不阻塞本扩展 attach**（实测 Chrome 150，连测两次均成功）。`E_TARGET_BUSY` 的真实触发是**另一个扩展**占着该目标。

---

## 七、这个项目的"验收口味"

- **不接受**"看起来能跑"：每个结论要么有命令输出，要么有 `文件:行号`。
- **不接受**为了绿灯放宽断言：宁可标注"未达标/未验"。
- **未达标必须写清楚"下一步"**，**不许偷偷改目标值**（G1 就是不达标照实记录、等用户决策后才下调）。
- **发现自家工具的 bug 要一起修**（历史上修过审计工具路径解析、探针跨上下文读取、`probe:all` 吞构建失败等）。
- **修完要有回归**：行为改动 → 在单测或探针里加一条**能咬**的断言，并且**把修复退回去验证它确实变红**（本项目
  多次出现"以为能咬其实不咬"：装饰性断言、恒真合取、追加日志里的陈旧条目、`filter(v === false)`）。
- **改了浏览器侧请求形态的改动，回归栏必须点名跑过哪个真 Chrome 探针**，否则只能写"未验证"（v3.40 §A3 就是反例）。
- **审计日志是事后唯一能回答"到底发生了什么"的东西**：加了新事件就顺手接上审计（allow-list 里加字段），
  别让它成为下一个 `ack`（有生产者、无消费者、0 条记录）。
- **与用户沟通一律用绝对路径**（用户在本项目里明确要求过）：任何文件/目录都写全路径，不写 `docs/xxx` 这类相对路径。
  本文件第三节就是为此准备的速查表。
