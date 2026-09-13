# 进度与续跑规则（durable memory）

> 本文件绝对路径：`/Users/mac/ai_tools/dsh project/网页插件/docs/PROGRESS.md`
> **本轮（v3.41 之后）的两件核心任务**（写在新会话最前面）：
> **A. 做本项目的英文版**；**B. 把它做成"可下载 / 自动检查依赖 / 一键安装部署"的程序**。
> 侦察结果与阻力点已写在 `docs/HANDOFF.md` 第二节，**从那里开始**，别从零推导。
>
> **先看这三份**（全绝对路径）：
> `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md`（检索规范，唯一真源 —— 文档走 semble、代码走 codegraph）、
> `/Users/mac/ai_tools/dsh project/网页插件/docs/11-台账.md`（对照设计的完成度、差异、未做清单、证据索引）、
> `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`（交给新会话的提示词 + 避坑清单）。
> 本文件只记"下一步"与续跑规则。

> 这份文件是**跨轮次的记忆**。每轮开工先读这里，取第一个未完成项，做完再更新。
> 目的：不再"每轮重新推导下一步"，也不再因为一轮结束就把任务停在半路。

## 续跑规则（自我约束，写下来比记着可靠）

1. **只有两种情况才结束回合**：① 真正只有用户能做的事挡路（用户手势 / 重启 DSH / 刷新扩展 / 有头人工判断）；② 目标完成。
2. **不阻塞执行的问题不中途问**：把问题写进最终报告，继续干活。可逆、在范围内的改动**直接做**，不用"要不要我…"。
3. 每个完成项必须同时满足：真实 Chrome/真进程探针通过 + 相关单测通过 + `npm run check` 全绿 + `docs/CHANGELOG.md` 记录（含被推翻的结论）。
4. 大块上下文消耗（codegraph 大源码、长探针输出）用子代理或写文件承载，不因此收尾。
5. **跟用户沟通一律用绝对路径**（用户明确要求）：提到任何文件都写全路径，例如 `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md`。

## 当前状态（v3.41，2026-09-12）

- **M0a/M0b/M1/M2**：已完成并实测（嵌入认证、composer 白盒探针、胶囊生命周期、抓取三粒度、UI 噪音启发式、抓取硬化、划词入口、右键菜单、attach 默认新会话、「看左边」全链路 22/22）。
- **M3 代码侧**：已完成并实测 —— ops 层 30/30（真 Chrome，实测）、工具契约 31 断言、debugger 前置 14 断言、控制面 11/11（能力集 5↔8 无重启）、写操作三层闸门 + 审批（`approvalMode` 实测为 `ask`；策略为 `never` 时如实报 `policy-never` 并当场拒绝）、帧预算 16 断言。
- **保留策略**：24h 清扫已实现并现场验证（19 断言 + 25h 文件被清/用户文件保留）；v3.39 补齐原生 host 日志轮转（此前是链路上唯一无上限的日志）。
- **v3.38（2026-09-12）**：①右键菜单 `trigger` 不在枚举里、**从来就是坏的**（改 `manual`）；②审计日志两半都没实现（现已补，allow-list 只记元数据 + 轮转）；③扩展显示名仍是 `Antigravity Web Companion`（改 `DeepSeek 浏览器插件`，ID 不变）。新增单测 menu-trigger / audit-log / audit-fields。
- **v3.39（2026-09-12）**：**推翻 v3.38 的"不抢界面+不预填"，按用户决策恢复设计行为**（按钮/右键抓取 = 新建会话 + 切过去 + 预填）。能这么改是因为修掉了两个把它们放大成随机事件的真缺陷：③**一次抓取只投一个页面半**（原来 `hub.push` 广播，用户常态两个页面半 ⇒ 一次抓取建两个会话；22:23 那个现象的真因）；④**一次「看左边」只抓一次**（旧守卫把"插件自己改写的草稿"当新意图 ⇒ 785ms 后重复抓取、输入框堆两个引用）。另修⑤**发布产物被烤进测试端口**（我造成的：探针改写 dev-config 时并发构建），加 `check:dist` 门禁 + `probe:all` 收尾重建。新增单测 capture-routing（20 断言）、重写 client-attach（26 断言）、rotate（11 断言）。

## 待办（按顺序取）

- [ ] **★ A. 英文版**（新核心任务）：产品文案/UI/`browser_*` 工具描述 + README；设计文档是否要翻**先问用户**。
      面积统计与三条技术路线（`_locales`/`chrome.i18n`、模型面向文案另走一套、抓取目录名属数据契约）见 `docs/HANDOFF.md` 第二节。
- [ ] **★ B. 可下载 + 自动检查依赖 + 一键安装部署**（新核心任务）：先做幂等的 `install.mjs` / `uninstall.mjs`；
      "扩展怎么落地"（Web Store / 企业策略 / 启动器）**单独决策**。七条阻力点（插件挂载绝对路径、扩展 ID 由 `key` 决定、
      Chrome 不允许静默装扩展、native host 清单路径、`dsh`/Node 依赖、端口门禁、没有打包脚本）见 `docs/HANDOFF.md` 第二节。


- [x] **M4-1 胶囊走 `conversation.input.dock` 插槽**（v3.33）：契约已取证并实现；DOM 条带保留为兜底；`probe:capture` 断言 `host === "slot"`，`probe:chip` 覆盖插入/✕/ack。
- [x] **M4-2 多站点抓取质量回归**（v3.31）：`npm run probe:sites` 五类页面 16/16；夹具本地 HTML 不依赖外网。首轮抓出两个真缺陷（引用 Markdown 非法、`Load more` 漏清）。
- [x] **M4-3 自动化/CI 说明**（v3.33）：`docs/10-automation.md` 四层分层 + `npm run probe:all` 一条命令跑完 7 个 Chrome 探针（实测 7/7）。
- [x] **M4-4 文档收口**（v3.34）：G1/G2/G6 全部改为实测（`npm run probe:perf`），两条未达标如实记录并写明下一步；README 已知限制随实现更新。
- [x] **G1 决策已闭环（2026-09-12）**：用户决定**接受实测 2.1–2.7 秒**，目标由 1.5s 下调为 **2.8s（p50）**。三处文档已同步（`详细设计文档.md §1.2` / `docs/11-台账.md §2` / 本文件）。原 1.5s 目标**未达标**的事实保留在案；瓶颈是 iframe 内 DSH 应用首屏（握手 2ms / 我方外壳 ~750ms / DSH 应用 ~1.34–2.6s），**不在本插件**。不再做 iframe 预热。
- [x] **G2 截图**（v3.36）：整页截图加 12000px 高度上限 → p95 1512ms（原 1865ms）且不再硬失败，改为带 `clipped` 说明的成功；视口截图语义修正后 ~97ms。
- [x] **M3-剩余**（v3.37）：真模型回合已自动化 —— `npm run probe:agent-turn` 断言"模型真的调用 browser_read + 回复里出现夹具标记"，并已加入 `probe:all`。**过程中修掉两个真缺陷**：hub 的 `close` 处理器丢失（僵尸 socket 吞调用）、`callAgent` 盲取第一个 socket。剩：写操作审批弹窗的实际批准/拒绝交互（仍属有头人工项）。
- [~] **M4-5（人工验收）**：进行中，记录见 `docs/reviews/manual-acceptance-2026-09-12.md`（B4/B6/C8/C10/E14 ✅；B7 旧期望被实测推翻；B5 需换 `ask` 会话；C9/D/A/E13 待办）。

## 已固化的验证资产（截至 v3.38）

- `npm run check`：协议一致性（codegen 产物逐字节校验 + 23 正向量/13 反向量）+ **20 条反模式规则**（235 文件）+ **23 个单测文件** + 构建 + 体积门禁（136.7KB）+ `check:dist`（产物端口必须等于真实配对文件的端口）
- `npm run probe:all`：**8 个 Chrome/真模型探针，顺序无关**（v3.38 改动后复跑一次 8/8）
- `npm run probe:chip`：胶囊插入/✕/ack（不在 `probe:all` 里，改胶囊行为时要单独跑）
- `npm run probe:perf`：G1/G2/G6 基线（含两处未达标与原因）
- `npm run audit:captures`：真实抓取文件的质量审计

- [x] **探针稳定性复现**：连续两次 `probe:all` **8/8 + 8/8**（修完竞态/TDZ 断言之后）。

## 待办（v3.38 之后，按顺序取）

- [x] **积压抓取投递路径缺失**（v3.41 修）：`request-pending` 现在按 owner 绑定投递（`hub.pushClientPrimary`），**投不出去就放回队列**（只 drain 不管的死法不再有）；审计记 `kind:"pending-replay"`。回归：`probe:attach` 第 7 节（5 断言能咬）+ `tests/unit/pending-delivery.test.mjs`（16 断言）。
- [x] **审批策略 `never` 下写操作被自动拒绝**（v3.41 修）：`mode` 读会话真实策略并新增 `policy-never`；写调用在 `never` 下当场拒绝、理由说明是策略（不是「用户拒绝」）；面板文案按策略分支。回归 33 断言。
- [x] ~~**G1 预热实测**~~ **已作废**（2026-09-12）：用户已决定接受 2.1–2.7 秒并下调目标，预热不再需要。

- [x] **v3.41（2026-09-12）P0 剩余 → 探针 → P1 → P2 全部做完**：
  - P1：`mode:'screenshot'` 抓不到图却回 `ok:true`（假绿）已修（`shotProblem()`，22 断言能咬）；`perf` 判定改造（G1 变基线不参与退出码，G2/G6 仍是硬门禁）；`CHIP_LABEL_MAX` 注释纠正。
  - P2：协议 `error.code` 收紧为 `$ref: ErrorCode` 并**补齐 5 个真实在用的码**（否则收紧即丢帧）、`captureId` 在 `ok:true` 时必填（校验器补 `if/then`，顺带修掉"只有 `required` 的子模式不检查"这个潜伏 bug）、`ROUTE` 表补 `wsEcho`/`wsProbe`（不再字符串替换拼路由）、`stamp` 去重、`paired` 口径统一（`key-store.js#isPaired`）、`/ag/ping` 少探针时不再 500、`pimoa-review` 驱动（receipt 解析 + `node:http` 绕开 undici 的 300s 墙）。
  - 顺带抓到的真缺陷：**413 之后的下一个请求必踩 `ECONNRESET`**（响应谎报 `keep-alive`，现改为 `connection: close`）。
  - 新门禁单测 6 个已接入 `test:unit`（不接入＝ `check` 根本跑不到）。
  - 验证：`npm run check` exit 0、`probe:all` 8/8 exit 0、`probe:attach` / `probe:chip` exit 0。
  - **真机抓出两个工具层缺陷（v3.41，用工具时暴露）**：`browser_ax` 的 output schema 把 CDP 的
    `AXNode.nodeId`（字符串）声明成 number ⇒ 模型只会收到 `invalid output`；`browser_screenshot` 的
    `execute` 用了 `randomBytes` 却没 import ⇒ 每次截图 ReferenceError。两者都因为"探针只打 op 层、
    单测用手搓夹具"而漏网。新增门禁：`probe:m3-ops` 用**真实 CDP 值**驱动 8 个工具的 `execute()`
    并撞各自声明的 output schema（39 断言）；单测补上 screenshot 的 execute（33 断言）。
  - **修掉我上一版埋的回归（v3.41，真浏览器抓出）**：v3.40 把面板"读写开关"从 POST 改成 GET，
    而 Chrome 对扩展文档的**简单 GET 不带 `Origin`** ⇒ F2 一律 403 ⇒ 面板永远显示开关是关的（写本身一直能用）。
    `guard.originOk` 对称化 F4：Origin 缺失时要求 `Sec-Fetch-Site: none` + `Sec-Fetch-Mode: cors`（都是浏览器置入、页面伪造不了）。
    回归：`guard-client` 26 断言（退回 ⇒ 2 红）+ `probe:panel` 真 Chrome 断言"面板显示态 == 插件真实态"（退回 ⇒ 403 + 红）。
  - **P0-C 收尾（v3.41）**：`probe:all` 里最后 6 个探针（debugger / look-left / sites / ops / control / look-left-e2e）
    也迁到 `tests/lib/probe-result.mjs`（只有布尔 `true` 算过）；删掉 ops-probe 的空小节、重写 control-probe 的恒真合取、
    删掉 agent-turn / attach 里并存的第二套旧判定；并修掉 look-left 探针的 **order-dependence**（固定草稿会撞上宿主的意图去重，
    5 秒内连跑第二、三次各红 3 条 —— 现在草稿带时间戳，连跑 3 次全绿）。

## 用户侧待办（v3.41 更新）

- **重启一次 `dsh web`**：宿主端插件这轮改动最多（补投路径、审批策略、路由表、协议收紧、413 连接语义），不重启不生效。
- 刷新扩展后可选跑：`npm run probe:m3-control`、`npm run probe:capture`、`npm run audit:captures`。
- 人工验收 6 项里"写操作审批"一步：先看 `/ag/control` 的 `approvalMode` 是 `ask` 还是 `policy-never`（后者不会弹窗，会当场拒绝并说明是策略）。

## 用户侧待办（不阻塞我）

- 重启 `dsh web` + 刷新扩展 → 生效：保留策略、写操作开关、审批、ops 层。
- 之后可跑：`npm run probe:m3-control`、`npm run probe:capture`、`npm run audit:captures`。
