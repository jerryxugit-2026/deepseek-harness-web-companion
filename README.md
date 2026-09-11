# DSH Web Companion（DeepSeek Harness 网页侧边栏智能伴侣）

在 Chrome 侧边栏里直接驱动本机 **DeepSeek Harness (DSH)** 完全体 Agent：点开即用原生 DSH 界面，写下「看左边」或点顶栏按钮，把左侧网页快照（正文 Markdown + 视口截图 + best-effort 字幕/元数据）注入本地工作区，打通「网页信息获取 → 本地工程修改与命令执行」闭环。

> **Agent 内核 = DSH**（本机真实运行，带本地文件读写、沙箱终端、子 agent 与权限审批）。桥接层以 **DSH 进程内插件**实现，复用既有 3080 端口，**0 新增常驻进程**。
> ⚠️ 内嵌复用的是 DSH 的**视觉与交互层**；上下文胶囊、意图嗅探、草稿写入等**桥接逻辑仍需自写 client 插件**（详见详设 §0.3）。

---

## 当前状态

| 阶段 | 状态 |
|---|---|
| 可行性验证（真实 Chrome 内嵌 DSH + 认证方案） | ✅ [FINDINGS.md](./FINDINGS.md)（含截图与实测矩阵） |
| 详细设计 **v3.1**（已吸收两份独立审核的修正） | ✅ [详细设计文档.md](./详细设计文档.md) |
| 内部评审 + PiMoa 多模型对抗审核 | ✅ [docs/REVIEW-v3.0.md](./docs/REVIEW-v3.0.md) · [docs/reviews/](./docs/reviews/) |
| 文档 ↔ 代码双图谱 | ✅ [docs/DOC-GRAPH.md](./docs/DOC-GRAPH.md) + `.codegraph/`（CodeGraph 1.6.0） |
| **待你拍板** | ⏳ **H4**：DSH 未运行时是否自动拉起（详设 [§0.2](./详细设计文档.md)；本版按「做」设计） |
| 代码实现 | ⏸ M1 骨架已写但**暂停**；评审通过后从 **M0 最小闭环 spike** 开工 |

---

## 三条已实测的关键事实

1. 扩展页面**不能**直连 DSH `/api`（Origin/Sec-Fetch 围栏 → 403），但 iframe 内 DSH 页面自身的同源请求合法 → 自建 `/ag/*` 路由（自行校验预共享 key + 钉死扩展 ID）。
2. DSH 原生的 `SameSite=Strict` cookie 在扩展 iframe 内 **fetch 能过、WebSocket 握手 401**（界面卡在 `connection lost`）；改签 **`SameSite=None; Secure`** 后完整可用 —— 截图 `spike/out/panel-none-secure.png`。
3. Chrome 137+ 已移除命令行 `--load-extension` → 自动化测试走 CDP `Extensions.loadUnpacked`；本机**没有 pnpm** → 开发期用 profile `cordis.patch.yml` 绝对路径条目安装插件（已实测跑通）。

---

## 文档导航

| 文档 | 内容 |
|---|---|
| **[详细设计文档.md](./详细设计文档.md)** | ★ **唯一权威（v3.1）**：量化验收、硬约束、架构、ADR、协议契约、模块函数级设计、时序与降级矩阵、测试方案、安全模型、里程碑、平台速查、未决问题与最脆弱假设 |
| [DESIGN.md](./DESIGN.md) | 设计摘要（与详设一致；**冲突时以详设为准**并视为阻断项） |
| [PRD_需求定义说明书.md](./PRD_需求定义说明书.md) | 需求定义（v3.0） |
| [FINDINGS.md](./FINDINGS.md) | 可行性实证：约束、变体矩阵、复现方式 |
| [docs/REVIEW-v3.0.md](./docs/REVIEW-v3.0.md) | 内部评审：12 条硬错误 + 11 处信息丢失 + 优化建议 |
| [docs/reviews/](./docs/reviews/) | PiMoa 多模型对抗审核结果（8 阻断 / 10 MAJOR / 3 内部矛盾） |
| [docs/CHANGELOG.md](./docs/CHANGELOG.md) | 变更纪律与历史（防止重写丢信息） |
| [docs/DOC-GRAPH.md](./docs/DOC-GRAPH.md) | 文档 ↔ 代码图谱（自动生成，随进展更新） |
| [docs/01](./docs/01-protocol.md) · [02](./docs/02-extension.md) · [03](./docs/03-bridge-plugin.md) · [04](./docs/04-client-plugin.md) · [05](./docs/05-native-host.md) · [06](./docs/06-test-plan.md) · [07](./docs/07-implementation-plan.md) · [08](./docs/08-security.md) | 模块详版（协议/扩展/host 插件/client 插件/native host/测试/计划/安全） |
| [docs/research/](./docs/research/) | 三份平台调研（DSH 插件规范 / composer 接缝 / Chrome 约束，带 citations） |

---

## 工程纪律（质量门）

```sh
npm run graph:sync     # 代码图谱增量重建（CodeGraph，本地 SQLite + FTS5）
npm run graph:docs     # 文档图谱重生成（docs/DOC-GRAPH.md + doc-graph.json）
npm run graph:check    # 校验图谱是否最新 + 引用是否断裂（必须 0 问题）

# 对抗审核（本地 PiMoa MCP，127.0.0.1:8758；用 ~/ai_tools/PiMoa/bin/pimoa-service.sh status 查看服务）
node scripts/pimoa-review.mjs --tool moa_verify \
  --prompt-file scripts/review-prompts/design-adversarial.md \
  --context 详细设计文档.md docs/REVIEW-v3.0.md \
  --out docs/reviews/pimoa-<milestone>.md
```

**每个里程碑收尾必须**：①刷新两个图谱 ②跑 PiMoa 复评 ③`graph:check` 与复评任一不过，不得进入下一阶段。

---

## 目录结构

```
网页插件/
├── 详细设计文档.md / PRD_需求定义说明书.md / DESIGN.md / FINDINGS.md / README.md
├── docs/            # 模块详版、平台调研、评审报告、对抗审核、图谱、变更记录
├── protocol/        # 单源消息 schema + codegen（M1）
├── extension/       # Chrome MV3（TypeScript + Vite）
├── dsh-plugin/      # DSH 插件（host 桥接 + client composer 注入）
├── native-host/     # native messaging 宿主（M2，H4 决策后）
├── scripts/         # init-key / doc-graph / pimoa-review / review-prompts
├── tests/e2e/       # E2E harness（CDP 驱动真实 Chrome）
├── spike/           # 已跑通的可行性实验（回归基线）
└── .devhome/        # 隔离 DSH_HOME（dev/e2e 用，已 gitignore）
```
