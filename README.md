# DSH Web Companion (DeepSeek Harness 网页侧边栏智能伴侣)

本项目旨在为 Chrome 浏览器打造一个专属于本地 **DeepSeek Harness (DSH)** 的超轻量智能侧伴侣插件。

它在保持 Chrome 原生 Gemini 侧边栏“即点即开、并排显示”极致体验的同时，直接内嵌本地运行的完全体 Agent——DeepSeek Harness（端口 3080），具备完整的本地文件读写、沙箱终端执行与多模型（DeepSeek / Claude / Gemini）驱动能力。用户在输入框写下“看左边”或点击顶栏按钮，瞬间即可完成左侧当前网页的全量快照（正文 Markdown + 视口多模态截图 + 视频字幕/元数据），打通从“网页信息获取”到“本地工程修改与命令执行”的完整生产力闭环。

> **核心技术架构**：
> - **扩展端**：**TypeScript** (Chrome MV3 原生，体积 < 1MB，启动 < 50ms，内存 < 20MB)。
> - **桥接端**：**Node.js 进程内插件** (`dsh-antigravity-bridge`)，直接运行在 DSH 进程内，复用既有 3080 端口，**0 额外进程，0 额外端口，0 额外内存消耗**。
> - **单内核保障**：单选 DSH 极大降低复杂度，100% 免费复用成熟的 Thinking 思维链折叠、Tool 卡片、审批弹窗与工作区选择，且可通过 DSH 自由配置任意 LLM 模型。
> - **Go 守护拉起器**：标记为后续增强项，**当前阶段不做**，聚焦扩展与插件核心链路。
> - **平台边界**：纯粹深耕 **Chromium 生态（Chrome / Edge / Brave / Arc）**，**Safari 明确坚决不做**。

---

## 当前状态

| 阶段 | 状态 |
|---|---|
| 可行性验证（真实 Chrome 内嵌 DSH + 认证方案） | ✅ 已完成，证据见 [FINDINGS.md](./FINDINGS.md)（含截图与报告） |
| 详细设计文档（TypeScript + Node.js 极简单内核 v3.0） | ✅ 已完成，见 [详细设计文档.md](./详细设计文档.md) 与 [DESIGN.md](./DESIGN.md) |
| 代码实现（M1 骨架 → M4 打磨） | ⏳ 下一步（见 [DESIGN §9](./DESIGN.md)） |

**三条已验证的关键事实**（决定整体架构）：
1. 扩展页面**不能**直接调 DSH 的 `/api`（Origin/Sec-Fetch 围栏 403），但 iframe 内 DSH 页面自身的同源请求完全合法。
2. DSH 原生下发的 `SameSite=Strict` cookie 在扩展 iframe 中会让 **WebSocket 事件流握手 401**（界面卡死在 `connection lost`）；改成 **`SameSite=None; Secure`** 后完整可用 —— 截图为证：`spike/out/panel-none-secure.png`。
3. 交互上采用 **“看左边” 自然语言意图拦截 + 顶栏【👀 看左边】按钮** 触发单次全量快照，彻底免去后台无休止的 DOM 监听与轮询，零后台电量开销，零无效 Token 浪费。

---

## 文档导航

| 文档 | 内容 |
|---|---|
| **[详细设计文档.md](./详细设计文档.md)** | ★ **完整单文件设计文档 (v3.0)**：终局决策论证、量化验收、六大硬约束、极简架构、ADR、协议契约、模块设计、时序、测试方案、安全、交付计划、平台约束、技术深水区剖析 |
| [DESIGN.md](./DESIGN.md) | 主设计摘要（架构/决策/PRD 对齐差异/风险/里程碑），与详细设计完全同步 |
| [PRD_需求定义说明书.md](./PRD_需求定义说明书.md) | 用户侧需求定义 (v3.0) |
| [FINDINGS.md](./FINDINGS.md) | 可行性实证：约束、变体矩阵、复现方式 |
| [docs/01-protocol.md](./docs/01-protocol.md) | 全部消息/RPC 契约、单源 schema、错误码表 |
| [docs/02-extension.md](./docs/02-extension.md) | Chrome 扩展：文件/函数级设计、权限理由、单测矩阵 |
| [docs/03-bridge-plugin.md](./docs/03-bridge-plugin.md) | DSH host 插件：路由、cookie 签发、WS hub、`browser_*` 工具 |
| [docs/04-client-plugin.md](./docs/04-client-plugin.md) | DSH client 插件：attach 进 composer、上下文胶囊 |
| [docs/05-native-host.md](./docs/05-native-host.md) | native messaging 自动拉起（后续增强设计，当前不做） |
| [docs/06-test-plan.md](./docs/06-test-plan.md) | 分层测试方案（L0-L4）、E2E 用例设计 |
| [docs/07-implementation-plan.md](./docs/07-implementation-plan.md) | 实现计划：M1-M4 任务分解、依赖、每任务完成判据 |
| [docs/08-security.md](./docs/08-security.md) | 安全与威胁模型：12 类威胁、权限最小化、审计 |
| [docs/research/](./docs/research/) | 平台调研笔记（DSH 插件规范 / 客户端 composer 接缝 / Chrome 扩展约束） |
