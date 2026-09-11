# 变更记录（CHANGELOG）

> **纪律**：任何大版本重写必须在本文件记录「**删了什么、为什么删、是否已回填**」，防止再次发生 v3.0 那种"重写导致已验证细节丢失"的事故（见 [docs/REVIEW-v3.0.md](./docs/REVIEW-v3.0.md) B1–B11）。
> 同仓库多文档结论冲突 = 阻断项，修复前不得开工。

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
