# 变更记录（CHANGELOG）

> **纪律**：任何大版本重写必须在本文件记录「**删了什么、为什么删、是否已回填**」，防止再次发生 v3.0 那种"重写导致已验证细节丢失"的事故（见 [docs/REVIEW-v3.0.md](./docs/REVIEW-v3.0.md) B1–B11）。
> 同仓库多文档结论冲突 = 阻断项，修复前不得开工。

---

## v3.12 — 2026-09-11（当前）

**触发**：client 半落地 + **E2E-0 最小闭环自动跑通**（M0b 收尾）。

### 交付

| 组件 | 说明 |
|---|---|
| `dsh-plugin/lib/client.js`（重写） | 真正的 client 半：持有 `WS /ag/client`（同源，无需 key）；收 `attach` → 注入 `@fileRef` 到草稿 → 渲染可删胶囊 → ack；「看左边」意图嗅探（草稿正则 → `intent` 帧）；20s 心跳；卸载时清定时器与连接。同时保留 M0a 白盒探针入口（`__AG_PROBE__` / `__AG_PROBE_WRITE__`） |
| `guard.checkClient` | F4 判定放宽为"**同源即通过**（key 可选）"——key 不该出现在页面 JS 里；外部页面既无法被本服务提供、也无法伪造 loopback 的 `Origin`/`Host` 组合 |
| `tests/m0b/chip-probe.mjs` | E2E-0 闭环探针：自签 cookie → 无头 Chrome → 驱动 UI 选中会话 → POST attach → 断言胶囊/草稿/ack → ✕ 撤销 → 断言清理 |

### E2E-0 实测（`docs/reviews/probe-chip.{md,json}`）

client 连接 ✅ → composer 激活 ✅ → `/ag/attach` 200 且 `deliveredTo:["client:1"]` ✅ → **胶囊出现**（`status: inserted`、label 含页面标题）✅ → **草稿含 `@网页捕获/…md`** ✅ → ack `inserted` ✅ → **✕ 撤销**：胶囊清零、**草稿还原为 `"\n"`**、ack `dismissed` ✅。

### 修掉的真实缺陷

首轮 `✕` 只删胶囊、未清草稿引用：`shell.state.draft` 写入后常为空串，权威内容在活动编辑器 DOM。新增 `readDraft()` 三级回退（state → lastMirroredDraft → DOM），插入与撤销统一走它。

### 记录的偏差

胶囊目前为 **DOM 注入**（`[data-ag-chip]` 锚定在 composer 上方），尚未走 `conversation.input.dock` 插槽——插槽版需 React 组件与 props 契约，列为 M1/M2 打磨项；可观察契约一致。

---

## v3.11 — 2026-09-11

**触发**：M0b 上下文通道落地——`/ag/attach` 落盘 + `WS /ag/client` 推送 + `/ag/pending` / `/ag/ack`，并用探针逐项取证。

### 交付

| 组件 | 说明 |
|---|---|
| `dsh-plugin/src/host/store.js` | 原子落盘（tmp→rename）：`<workspace>/网页捕获/<yyyy-MM-dd-HHmm>-<slug>-<id6>.md`，YAML front-matter（captureId/title/url/domain/capturedAt/trigger/source/screenshot/truncated）+ 用户选区引用块 + 正文；另含离线 pending 队列（上限 32） |
| `dsh-plugin/src/host/hub.js` | WebSocket hub：`/ag/client`（client 半）与 `/ag/agent`（扩展，M3）分离；20s 心跳 / 30s 判离线；`push()` 广播并返回投递数 |
| `dsh-plugin/src/host/routes/attach.js` | `POST /ag/attach`（先落盘后推送，推送失败入队）、`GET /ag/pending`（`?peek=1` 只看不取）、`POST /ag/ack`（幂等） |
| `guard.checkClient` | 新增 F4 判定：key +（同源 Origin **或** Origin 缺失）→ 覆盖 DSH 页面自身的 client 半 |

### 探针取证（`tests/m0b/attach-probe.mjs` → `docs/reviews/probe-attach.json`）

| 断言 | 结果 |
|---|---|
| WS `/ag/client` 建连（F4） | ✅ `wsOpen: true` |
| `POST /ag/attach` 落盘 | ✅ 200；文件**真实存在**；front-matter 五项齐全、含选区块与正文（21 行），文件快照 sha256 已记录 |
| **推送而非拉取** | ✅ 已连接 client **收到 1 条 `attach` 事件**（含 `fileRef`、`mode: selection+page`、内联图片、summary） |
| `POST /ag/ack` | ✅ 200 |
| **离线队列** | ✅ 无 client 时 `deliveredTo: []`；`/ag/pending?peek=1` → 1；drain → 1；再 peek → 0（取出即消费） |
| 鉴权与校验 | ✅ 无 key 403、错 key 403、仅扩展 Origin 无 key 403、schema 拒绝 400、超限 413 |

### 依赖

根 `package.json` 增加 `ws` devDependency（探针与 hub 都需要；此前只有 `dsh-plugin/node_modules` 里的软链）。

---

## v3.10 — 2026-09-11

**触发**：M1 第①项落地——协议单源 schema + codegen + 契约测试（ADR-9）。

### 交付

| 产物 | 说明 |
|---|---|
| `protocol/messages.schema.json` | **唯一真源**：HTTP 端点消息、WS 信封、client 事件、扩展内部消息、native messaging 消息全部定义在一个 JSON Schema 里（21 个消息定义 + 错误码/枚举） |
| `protocol/codegen.mjs` | 生成三端自包含产物（扩展 ESM / 插件 ESM / native host MJS），每个产物头部带 schema 的 sha256；`--check` 逐字节比对 |
| `protocol/vectors/` | 21 个正向量 + 11 个反向量（含 `image/webp`、未知错误码、多余字段、非法 op 等真实反例） |
| `tests/protocol/contract.test.mjs` | 5 组断言：产物与 schema 一致 / 三端一致（版本·消息种类·枚举·路由·通道）/ 正向量全过 / 反向量全被拒且码为 `E_PAYLOAD` / 命名定义可直接校验 |
| 接入 | 扩展 `urls.js`、`dsh-session.js` 与插件 `index.js`、`ping.js` **已改用生成物**（路由常量、版本号、入站校验、出站自校验） |

### 自校验立刻抓到的真实漂移

接上出站自校验后，`/ag/ping` 第一次返回 **500**：`pairing payload violates schema: expected string|null, got undefined at $.pairingError`——即"配对正常时 `pairingError` 被省略"这一手写行为不符合封闭 schema。**已修**（显式 `null`），这也验证了守卫的有效性：schema 漂移会在开发期立刻暴露，而不是留到联调。

### 质量门更新

`npm run check` = `protocol:check` → `graph:sync` → `graph:check` → `check:consistency` → `test:protocol`（五道全绿）。

---

## v3.9 — 2026-09-11

**触发**：方案 A 落地后，在**用户真实 DSH 实例**（`~/.dsh`，端口 3080）上复跑 composer 探针——**M0b 两条硬断言全部达成**。

### 方案 A 落地（真实 profile 挂载）

- `~/.dsh/profiles/web/cordis.patch.yml` 追加顶层 `insert` 行（保留既有 semble/codegraph 两行）；备份 `cordis.patch.yml.bak-before-companion`
- `~/.dsh/dsh-web-companion.json`（0600）配对文件；扩展 dev-config 指向 3080
- 预检发现并修掉**首次写入的缩进错误**（会嵌套进上一条 insert，导致 loader 行缺 `name`、启动失败）；`dsh --profile web --dump-config` 复核通过
- 实测：`/ag/ping` → `paired:true`、`pairingSource=/Users/mac/.dsh/dsh-web-companion.json`；`/ag/enter` 与 `/ag/whoami` 无票据/无 Origin → **403**（fail-closed 正常）

### M0b 硬断言结果（真实 GUI）

| 断言 | 结果 | 证据 |
|---|---|---|
| ① 读到的必须是 **DSH 原生 composer**（且是活动编辑器） | ✅ `{anyEditable: true, activeEditable: true, attrs: {ce: "true", role: "textbox"}}` | `docs/reviews/probe-composer.json` |
| ② **写入方向可观察** | ✅ `__AG_PROBE_WRITE__('M0B-DOM-MARKER')` → `domText: "M0B-DOM-MARKER"`、`domHasMarker: true`、`lastMirroredDraft: "M0B-DOM-MARKER"`；随后**自动恢复原草稿**（`restoredNow: ""`，DOM 复原为换行） | 同上 |
| ③ 白盒探针（`__ModuleLoader__` / 服务面 / 图片 API） | ✅ `createDraftImages: true`、`sessions.scope: true`、`uiSession.currentBinding.props = {sessionId, inputActions}` | 同上 |

### 关键实现修正（探针自身）

1. **探针不再创建/切换会话**：早先版本在真实 GUI 里 `sessions.create` 会把 shell 切到"无工作区"的会话，composer 变回惰性态（`contenteditable="false"`）——这解释了此前"断言①始终失败"。现改为只观察 shell 当前会话，写入由 harness 在 UI 就绪后经 `__AG_PROBE_WRITE__` 触发。
2. 写入前记录原草稿、写入后**自动回填**，不在用户界面留残留文本。

### 副作用（如实记录）

探针在用户真实实例里留下了约 8 个空会话（14:52–14:55，标题均为「新会话」，均为无消息的空会话）——可在侧栏逐个删除；后续探针已改为不再创建会话。

---

## v3.8 — 2026-09-11

**触发**：M0a 第五个实验——空闲 WebSocket 保活（Q8 / D10）。

### 实测结论

| 持有者 | 90s 空闲后 | 判定 |
|---|---|---|
| 扩展文档（侧边栏文档形态） | WS 全程 `ws-open`，**无 `ws-close`** | ✅ D10 主方案成立 |
| MV3 Service Worker | 目标仍在但 `sendMessage` 返回 `Could not establish connection. Receiving end does not exist.`；**未捕获 close 事件** | ⚠️ SW 不能作为长期持有者（不宣称 socket 收到过 close） |

D10 结论不变并补上实测依据；兜底方案（SW + `chrome.alarms` + 重连）保留。局限已记录：观察窗仅 90s、未模拟侧边栏隐藏/关闭、未做"有心跳流量时是否保活"的对照。

---

## v3.7 — 2026-09-11

**触发**：M0a 第三、四个实验（cookie 矩阵 Q1/Q2 + 客户端 composer 契约已于 v3.6 记录）。

### Q1 现象闭环（逐格取证）

四形态 × 三属性矩阵（`docs/reviews/probe-cookie-matrix.json`）：`SameSite=Strict` 在**扩展页与 iframe 内的 WebSocket 握手都失败**、fetch 都成功；`None; Secure` 与 CHIPS **四格全绿**。机制（为什么 WS 与 fetch 不同）仍未证实，留 `chrome://net-export` 的 `COOKIE_*` 事件做后续定位。

### 发现并修复一处设计缺陷：同源请求不带 `Origin`

【实测】iframe 内同源 `fetch('/ag/whoami')` 到达服务端时 `Origin` 为 **null**（Fetch 规范：同源请求省略 Origin）。而 §5.4 从 v3.1 起把 F4 定义为"Origin 必须等于 authority"——照此实现会把 DSH 页面自己的合法请求误判。**已修正**：Origin 存在时必须匹配；缺失时以 `Sec-Fetch-Site: same-origin` + 有效会话 cookie 判定。`/ag/whoami` 分类器同步修正。

### Q2 未闭环（诚实记录，不粉饰）

`profile.block_third_party_cookies=true` 下矩阵结果与未屏蔽**完全一致**，但**跨站对照证明该偏好未生效**（`http://localhost` 顶层页 iframe `127.0.0.1` 时 `None; Secure` 仍被投递）。因此"3P 屏蔽不影响本设计"**尚未证实**，需改用真正的 3P 屏蔽开关重跑。§7.4 的 3P 兜底保持"不预置自动切换"。

---

## v3.6 — 2026-09-11

**触发**：M0a 第二个实验（composer / client 插件契约探针，`tests/m0a/composer-probe.mjs`）——把 client 插件从"按文档推断"变成"在真实 GUI 里跑起来并逐项取证"。

### 实测确认（逐字证据见 `docs/reviews/probe-composer.{md,json}`）

| 项 | 结论 |
|---|---|
| **客户端打包机制（A6）** | ✅ 成立：`exports["./client"]` + `dsh.client.platform="web"` + CJS 闭包工厂 → 写入 boot 图、经 `/plugins/??dsh-web-companion-bridge/client.js&rev=…` 返回 200/5764B，插件 `apply` 在真实 GUI 中成功执行 |
| **`inject` 是硬要求** | ❌→✅：不声明时 `apply` 早于服务就绪，`ctx.get('conversation'/'sessions')` 全 undefined；声明 `inject: ['sessions','conversation']` 后全部就位 |
| **`createDraftImages`（Q3，PiMoa 假设 C）** | ✅ 运行时存在并可用：`createDraftImages([File])` → `array(1)`，返回浏览器端 id；`createDraftAttachments` 在本版本**不存在** |
| **`setDraft` 签名** | ⚠️ 安装版 `0.1.2-rc.1` **arity=1**（无 `editRange`）→ v3.4 依据的"`setDraft(text, editRange?)`"来自更新源码；撤销契约改为**按 arity 能力探测**双路径 |
| **写入方向可观察** | ✅（非 DOM 形式）：`setDraft(marker)` 后 `shell.state.draft === marker`、`shell.lastMirroredDraft === marker` |
| **标准 props 可达** | ✅ `uiSession.currentBinding.props = { sessionId, inputActions }` → 插件可直接调用 `inputActions.setDraft`，无需 React |
| **可见服务面** | `conversation` / `sessions` / `uiConversation` / `uiSession` / `slots` / `connection` / `modules`，keys 清单已存档 |

### 未闭合项（明确记录，不粉饰）

**E2E-0 断言①（活动编辑器）**在隔离 dev home 中无法达成：composer 元素存在但为惰性占位（`contenteditable="false"`、`aria-label="选择工作区"`），因为该环境没有"已绑定工作区且被 shell 选为当前"的会话。四种驱动方式均已尝试并留证（真实 UI 点击 / `sessions.create`+`open` / `uiWorkspace.connectWorkspace` / `uiSession.createMaterializedBinding` 抛 `missing hook 'session'`）。
→ 两条解锁路径写在 `docs/reviews/probe-composer.md` §2：**A** 把插件挂进真实 profile（需一次工作区外写入，需用户批准）；**B** 接受非 DOM 回读，把断言①降级为 M1 前置人工步骤。**待用户选择**。

### 其他修订

§6.3 新增"运行时可达性（实测）"与"图片准入（Q3 结论）"两行；打包形态一栏由【源码】升级为【源码】+【实测】；插入/撤销契约按 arity 探测重写。

---

## v3.5 — 2026-09-11

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
