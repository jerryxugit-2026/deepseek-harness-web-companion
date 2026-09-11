# M0a 探针报告 · composer / client 插件契约（probe-composer）

- **探针**：`tests/m0a/composer-probe.mjs` + 被探对象 `dsh-plugin/lib/client.js`（客户端半，CJS 闭包工厂 bundle）
- **环境**：无头 Chrome 150.0.7871.125 · 隔离 DSH（`DSH_HOME=.devhome`，端口 3099，包经 profile `cordis.patch.yml` 绝对路径条目加载）
- **原始数据**：`docs/reviews/probe-composer.json` · 截图 `docs/reviews/probe-composer.png`
- **被验证的设计条目**：§6.3 client 插件（A6 打包机制）· §12.4 Q3/Q4 · §12.5 假设 B/C · E2E-0 断言①②③

## 1. 结论

| 结论 | 证据强度 |
|---|---|
| **A6 的打包机制成立**：`exports["./client"]` + `dsh.client.platform="web"` + CJS 闭包工厂（`window.__ModuleLoader__.load({id,factory})`）→ 宿主把它写进 boot 图并以 `/plugins/??<pkg>/client.js&rev=…` 提供，插件在真实 GUI 里**成功 apply** | 【实测】bundle HTTP 200 / 5764B；`window.__AG_PROBE__` 被发布 |
| **`inject` 是硬要求**：不声明 `inject` 时 `apply` 在服务就绪前运行，`ctx.get('conversation'/'sessions'/…)` 全为 `undefined`；声明 `inject: ['sessions','conversation']` 后全部就位 | 【实测】两次对照 |
| **`createDraftImages` 运行时存在**（`createDraftAttachments` **不存在**）——PiMoa 列为未证实的假设 C **成立** | 【实测】`conversation.createDraftImages([File])` → `array(1)`，返回浏览器端 id（如 `0bef823e-4d89-4b99-b…`） |
| **`setDraft` 实为单参**：装的 0.1.2-rc.1 里 arity=1（无 `editRange` 形参）→ v3.4 依据的"`setDraft(text, editRange?)`"来自更新的源码检出，**必须做能力探测**而不是硬编码 | 【实测】`setDraft.length === 1` |
| **写入方向成立且可观察（非 DOM）**：`setDraft(marker)` 后 `shell.state.draft === marker`、`shell.lastMirroredDraft === marker` | 【实测】marker 逐字回读 |
| **标准 props 可达**：`uiSession.currentBinding.props` = `{ sessionId, inputActions }` → 第三方插件能拿到 `inputActions`（含 `setDraft`），无需 React | 【实测】 |
| 可见服务：`conversation`、`sessions`、`uiConversation`、`uiSession`、`slots`、`connection`、`modules` | 【实测】keys 清单见原始 JSON |

## 2. 仍未闭合：E2E-0 断言①（DSH 原生 composer 的**活动**编辑器）

**现象（逐字）**：DOM 中确实存在一个 composer 元素，但处于**惰性占位态**：

```
<div role="textbox" contenteditable="false" aria-label="选择工作区" class="uV2eYG_input">
```

`aria-label="选择工作区"` 说明 shell 认为**该会话尚未绑定工作区**，因此渲染的是"工作区选择器"的惰性替身（DSH 文档：无会话态复用同一个 div 并置为 inert）。

**已排除的手段**（都试过且留证）：
1. harness 真实点击「选择工作区」→「m0a-workspace」→「新会话」→ 侧栏会话行（`SPAN.*_title` 文本「新会话」）：点击全部命中，但 composer 仍 `contenteditable="false"`；
2. 插件内 `sessions.create({workspaceId})` / `sessions.open(id)`：会话创建成功，但 shell 当前会话不跟随；
3. 插件内 `uiWorkspace.connectWorkspace(workspaceId)`（用 shell 自己的 API，workspace 解析走 `uiWorkspace.workspaces.list.getSnapshot().items`）：会话创建成功（`session-b351…`），UI 仍未切过去；
4. 插件内 `uiSession.createMaterializedBinding(sessionId)`：抛 `Error: uiSession.provide: missing hook 'session'` → 需要 shell 内部的 session descriptor 机制，非插件可达路径。

**根因判断**：隔离 dev home 里没有一个"**已绑定工作区并被 shell 选为当前**"的会话；绑定动作由 shell 自己的导航/hook 机制完成，第三方插件无法代劳。

**两条解锁路径（择一）**：

| 方案 | 做法 | 代价 |
|---|---|---|
| **A（推荐）** | 把 `dsh-web-companion-bridge` 也挂进**真实 profile**（`~/.dsh/profiles/web/cordis.patch.yml` 追加一行绝对路径条目），在用户真实 GUI（已有绑定工作区的会话）里跑同一条断言 | 需要一次**工作区外写入**（等你批准）；随时可删掉那一行还原 |
| **B** | 保持隔离：接受"非 DOM 回读"作为断言②的达成形式；把断言①（活动编辑器）降级为 **M1 前置人工步骤**（你在自己浏览器里点一次「选择工作区」即可） | 0 代价；但 M0b 少一条机器可验证的断言 |

**其余未覆盖**：`draft-changed` 事件时机（Q4 的另一半）、`EditRange` 在当前版本的存在性（本版 arity=1，倾向不存在）、图片附件进入 composer 后的可视渲染。
