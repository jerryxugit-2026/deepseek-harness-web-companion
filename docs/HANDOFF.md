# 交接提示词（新会话从这里开始）

> 本文件路径：`/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`
> 用途：把这个项目交给一个**没有上下文的新会话**。第一节是**可直接整段复制粘贴**的提示词；后面是现状摘要、**路径速查（全绝对路径）**、检索纪律与避坑清单。

---

## 一、可直接粘贴的提示词

```
你接手一个**已经实现并测试过**的项目：DSH Web Companion（Chrome 侧边栏插件 + 本地 DSH 桥接插件）。

【第 0 步 · 先定检索方式（强制，不许跳过）】
先读 `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md` —— 那是本机**唯一真源**的检索规范。
之后本项目的一切检索都必须按它执行：
  - **文档问题**（规格/方案/笔记/README/研究）→ 先调 `mcp__semble__search`；
    它的 CLI 等价物是 `/Users/mac/.local/bin/semble search "查询" /Users/mac --content docs`
    （CLI 必须显式给 `--content docs`，且服务若报 "Operation not permitted" 说明它不是从 Warp 终端起的）。
  - **代码问题**（符号/函数/调用链/调用者/影响面/"X 怎么工作"）→ 先调 `mcp__codegraph__codegraph_explore`，
    本项目用 `projectPath: "/Users/mac/ai_tools/dsh project/网页插件"`；
    查 DSH 引擎自身实现用 `projectPath: "/Users/mac/.codegraph-dsh-engine"`。
    **它的返回是 Read 等价物（逐字源码 + 行号）—— 不要再 Read 重开那些文件。**
  - 只有"全树字面量扫描"才用 Grep / rg；**在 `/Users/mac/.codegraph-dsh-engine` 里绝不要用 rg**
    （那是纯符号链接农场，rg 默认不跟随 → 恒 0 命中，据此判定"符号不存在"是错的）。

【第 1 步 · 按顺序读四份文档（全绝对路径）】
  1. `/Users/mac/ai_tools/dsh project/网页插件/详细设计文档.md`   —— 设计真源（v3.37：目标、架构决策 ADR、协议、模块、测试方案、安全模型、里程碑）
  2. `/Users/mac/ai_tools/dsh project/网页插件/docs/11-台账.md`  —— 台账（设计 vs 实际完成度、实现方式的差异、未做清单、未决问题、证据索引）
  3. `/Users/mac/ai_tools/dsh project/网页插件/docs/PROGRESS.md` —— 跨轮进度与续跑规则
  4. `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`  —— 本文件（现状摘要 + 避坑清单 + 验收口味）

【第 2 步 · 自己把现状跑一遍（不要只信文档，文档可能过期）】
  cd "/Users/mac/ai_tools/dsh project/网页插件"
  npm run check            # 静态检查 + 7 个单测 + 构建；不需要浏览器
  npm run probe:all        # 8 个真 Chrome / 真模型测试；会自己拉起测试用 DSH（占 3099 端口）
  两条都应全绿。若有失败，先判断是**产品缺陷**还是**探针自身问题**（历史上两者都出现过；
  已知的那类见台账 §8 与本文件第三节）。

【第 3 步 · 报告】
  告诉我：① 你实际跑出来的结果与台账是否一致（不一致的地方必须指出）；
  ② 你打算先做哪一项（默认建议见台账 §10 与 §5）。

【工作纪律（必须遵守）】
  - 任何结论都要带证据来源：实测（命令 + 输出）、源码（文件:行号）、文档、推理；**没测过的必须标注"未验"**。
  - 改了行为就要在 `/Users/mac/ai_tools/dsh project/网页插件/docs/CHANGELOG.md` 追加一条（含**为什么**，以及被推翻的旧结论）。
  - 提交前必须 `npm run check` 全绿；探针类改动要跑对应的 `npm run probe:*`。
  - **不允许**为了让测试变绿而放宽断言或改验收目标值；要改目标值必须先问我。
  - 探针之间必须**顺序无关**（不得谎报共享状态、不得长期占用固定端口、不得改全局设置）。
  - 遇到"只有真人能做的事"（用户手势弹窗、有头界面判断），停下来告诉我，不要绕过。

现在开始：先读检索规范，再读那四份文档，然后跑那两条命令，最后报告。
```

---

## 二、路径速查（全部绝对路径）

### 项目与文档

| 是什么 | 绝对路径 |
|---|---|
| 项目根（git 仓库根） | `/Users/mac/ai_tools/dsh project/网页插件` |
| 设计真源 | `/Users/mac/ai_tools/dsh project/网页插件/详细设计文档.md` |
| **台账** | `/Users/mac/ai_tools/dsh project/网页插件/docs/11-台账.md` |
| 交接提示词（本文件） | `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md` |
| 跨轮进度与续跑规则 | `/Users/mac/ai_tools/dsh project/网页插件/docs/PROGRESS.md` |
| 版本改动与原因 | `/Users/mac/ai_tools/dsh project/网页插件/docs/CHANGELOG.md` |
| 人工验收清单（只列机器做不了的） | `/Users/mac/ai_tools/dsh project/网页插件/docs/09-manual-checklist.md` |
| 自动化分层（哪些能无人跑） | `/Users/mac/ai_tools/dsh project/网页插件/docs/10-automation.md` |
| 分册文档 01–08（协议/扩展/桥接/客户端/拉起器/测试/计划/安全） | `/Users/mac/ai_tools/dsh project/网页插件/docs/` |
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
| 扩展清单 | `/Users/mac/ai_tools/dsh project/网页插件/extension/manifest.json` |
| 协议单源 schema | `/Users/mac/ai_tools/dsh project/网页插件/protocol/messages.schema.json` |
| 协议代码生成器 | `/Users/mac/ai_tools/dsh project/网页插件/protocol/codegen.mjs` |
| native messaging 拉起器 | `/Users/mac/ai_tools/dsh project/网页插件/native-host/` |
| 单测 | `/Users/mac/ai_tools/dsh project/网页插件/tests/unit/` |
| 各里程碑探针 | `/Users/mac/ai_tools/dsh project/网页插件/tests/{m0a,m0b,m1,m2,m3}/` |
| 质量回归与审计 | `/Users/mac/ai_tools/dsh project/网页插件/tests/quality/` |
| 运维脚本（批量探针/文档图谱/一致性检查/对抗审核） | `/Users/mac/ai_tools/dsh project/网页插件/scripts/` |

### 运行时与本机环境

| 是什么 | 绝对路径 |
|---|---|
| 测试用 DSH 数据目录（探针用） | `/Users/mac/ai_tools/dsh project/网页插件/.devhome` |
| 测试用 DSH 的抓取落盘目录 | `/Users/mac/ai_tools/dsh project/网页插件/.devhome/workspace-m0a/网页捕获` |
| **你真实使用时的抓取落盘目录** | `/Users/mac/ai_tools/dsh project/网页捕获` |
| 配对密钥文件（真实 profile） | `/Users/mac/.dsh/dsh-web-companion.json` |
| 测试用配对密钥 | `/Users/mac/ai_tools/dsh project/网页插件/.devhome/dsh-web-companion.json` |
| 真实 profile 的插件挂载行 | `/Users/mac/.dsh/profiles/web/cordis.patch.yml` |
| 测试 profile 的插件挂载行 | `/Users/mac/ai_tools/dsh project/网页插件/.devhome/profiles/web/cordis.patch.yml` |
| native host 安装位置（Chrome 侧清单） | `/Users/mac/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dsh.web_companion.json` |
| native host 日志 | `/Users/mac/.dsh/logs/dsh-web-companion-host.log` |
| Chrome 测试用 profile（探针） | 临时目录，形如 `/tmp/dshwc-*-profile`（每次新建、用完不保留） |
| codegraph 引擎索引根 | `/Users/mac/.codegraph-dsh-engine` |

> 注意：测试用 DSH 与真实 DSH 是**两个不同的数据目录**（`.devhome` vs `~/.dsh`），端口也不同（3099 vs 3080）。探针只碰前者。

---

## 三、检索纪律（按 `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md` 执行）

| 你要找什么 | 用什么 | 备注 |
|---|---|---|
| 文档、散文、笔记、规格、README、方案 | `mcp__semble__search` | 服务在 `http://127.0.0.1:8757/mcp`，**必须在 Warp 终端启动**；首次查询可能几分钟（在建索引），不是挂了 |
| 代码、符号、调用链、影响面 | `mcp__codegraph__codegraph_explore` | 输出是 **Read 等价物**，别再 Read 重开；本项目 `projectPath` 用绝对路径（见提示词第 0 步） |
| 全树字面量扫描 | Grep / rg | 仅此一种情况 |
| 在 `/Users/mac/.codegraph-dsh-engine` 里 | **只能用 codegraph** | 那是 222 个符号链接的聚合根，rg 默认不跟随 → 恒 0 命中 |

CLI 回落（MCP 不可用时）：

```bash
/Users/mac/.hermes/node/bin/codegraph explore "查询"
/Users/mac/.local/bin/semble search "查询" /Users/mac --content docs
```

---

## 四、现状摘要（给新会话的浓缩版）

**能用的完整链路**：点侧边栏 → 看到本机 DSH 界面（自动登录）→ 抓网页 / 划词 / 在输入框写「看左边」→ 变成工作区 `网页捕获/*.md` 并自动把 `@文件` 贴进输入框 → AI 能反过来读页面、点击、填表、截图。

**技术栈**：Chrome MV3 扩展（纯 JavaScript + esbuild）+ DSH 进程内插件（ESM JavaScript）+ native messaging 拉起器（Node）+ 一份协议 schema 生成三端代码。

| 命令 | 需要什么 | 覆盖 |
|---|---|---|
| `npm run check` | 无 | 协议一致性、19 条反模式规则、7 个单测文件、构建、体积门禁 |
| `npm run probe:all` | 本机 Chrome + DSH | 8 个探针（debugger 能力、意图桥接跳、抓取、多站点质量、反向操作、写操作开关、意图全链路、真模型回合） |
| `npm run probe:perf` | 同上 | G1/G2/G6 性能基线 |
| `npm run audit:captures` | 无（读已有文件） | 用真实抓取文件统计噪音与结构完整性 |

**当前状态（编写时）**：41 次提交，最新 `d55f01f`；`npm run check` 全绿；`probe:all` 曾连续两轮 8/8。

**待办**：G1 性能决策（2.09s vs 目标 1.5s）、有头人工验收 6 项、SPA 成功率未测、快捷键/域名黑名单/视频字幕/截图入口未做、对实现的对抗复评未做、CI 未接入 —— 完整清单在台账 §5 与 §10。

---

## 五、避坑清单（这个项目真踩过的，别再踩）

### 环境与运行

1. **探针要一个测试用 DSH**：`DSH_HOME="/Users/mac/ai_tools/dsh project/网页插件/.devhome" dsh web --no-open --port 3099 &`。`npm run probe:all` 会自己拉、结束后只杀自己拉的那个 —— **不要**动你真实在跑的那个（默认 3080）。
2. **探针会临时改写** `/Users/mac/ai_tools/dsh project/网页插件/extension/src/lib/dev-config.js`（把端口/密钥指向测试实例），结束时自己还原。探针中断时检查这个文件有没有被留在测试端口上。
3. **Chrome 137+ 忽略 `--load-extension`**：探针走 CDP 的 `Extensions.loadUnpacked`，且**路径不能含空格** —— 所以都先把 `/Users/mac/ai_tools/dsh project/网页插件/extension/dist` 拷到 `/tmp/<无空格>` 再加载。
4. **无头 Chrome 与有头不同**：调试横幅、权限弹窗在无头里不出现；性能数字也是无头测的，别当成有头体感。

### DSH 插件契约（最容易写错的三条）

5. **`ctx.slots.register(options, component)`**：组件是**第二个位置参数**，返回 **React 元素**（`react` 是平台种子模块，自带 React 会崩 hooks）；把组件写在 options 里会被静默丢弃。
6. **注册插槽必须包在 `ctx.slots.inject(name, ...)` 里**：直接注册尚未声明的插槽会抛 `slot "…" is not declared`；`inject` 会等声明，并在声明坍塌后**重跑回调**（回调必须可重入）。
7. **工具注册**：`defineTool` 从 `@deepseek-ai/dsh-tools` 导入（版本须与运行时一致）；`inject` 必须含 `'tools'`；output schema **每个 object 都要显式写 `additionalProperties`**，`required` 写在属性里；工具失败返回 `{code, message}`（不是抛异常）。
8. **校验器返回值只有 `{ok}`**，成功时**没有 `value` 字段**（误读会让整条链路静默失效 —— 本项目真发生过）。
9. **`debugger` 权限不能声明为"可选"**（Chrome 会拒绝并省略它）；必须放必需权限，用运行期开关控制是否 attach。

### 测试写法（本项目反复栽的地方）

10. **跨进程 iframe 是独立 CDP target**：`Runtime.executionContextCreated` 只在**它自己的会话**上投递；在父页面会话里查 DSH 页面的字段会读到 `undefined`（把"已连接"读成 false）。要用 `contextId` 显式指定。
11. **面板上下文与 DSH 页面上下文不是一回事**：`__AG_PANEL__` 在面板里，`__AG_CLIENT__` 在 DSH 页面里 —— 各查各的。
12. **异步出现的东西不要读一次快照**（胶囊、连接状态）—— 那是测竞态。要么有界轮询，要么把断言收窄成"永不出现某坏情况"。
13. **探针不得污染共享状态**：曾有探针谎报 `workspace`，导致后续探针的文件落到假目录（内容断言还全绿，只有计数断言红）。断言要以**回复里的落盘路径**为准。
14. **单测要跑真值**：出现过两次"单测假绿" —— 一次桩返回 `undefined` 恰好落进错误分支，一次把校验器的"违规数组"当成 `{ok}` 读。断言要同时要求"是成功值"和"零违规"。

### 平台细节

15. **macOS 文件时间戳是纳秒精度**：用毫秒级时间做"恰好相等"的边界断言会出现 1µs 级假失败，断言用 ±1s 边距。
16. **Chrome 的 `captureVisibleTab` 限流 2 次/秒**且只能抓当前活动标签页；抓后台标签页或整页要走调试器。

---

## 六、这个项目的"验收口味"

- **不接受**"看起来能跑"：每个结论要么有命令输出，要么有 `文件:行号`。
- **不接受**为了绿灯放宽断言：宁可标注"未达标/未验"。
- **未达标必须写清楚"下一步"**，而且**不许偷偷改目标值**（G1 就是不达标照实记录，等用户决策）。
- **发现自家工具的 bug 要一起修**（历史上修过审计工具的路径解析、探针的跨上下文读取等）。
- **修完要有回归**：行为改动 → 在单测或探针里加一条能挡住下次的断言。
