# 变更记录（CHANGELOG）

> **纪律**：任何大版本重写必须在本文件记录「**删了什么、为什么删、是否已回填**」，防止再次发生 v3.0 那种"重写导致已验证细节丢失"的事故（见 [docs/REVIEW-v3.0.md](./docs/REVIEW-v3.0.md) B1–B11）。
> 同仓库多文档结论冲突 = 阻断项，修复前不得开工。

---

## v3.5 — 2026-09-11（当前）

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
