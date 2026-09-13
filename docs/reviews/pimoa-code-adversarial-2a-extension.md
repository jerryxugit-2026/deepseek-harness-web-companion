# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`dsh-plugin/lib/client.js`、`extension/src/content/extract.fn.js`、`extension/src/lib/dev-config.js`、`extension/src/lib/frame-budget.js`、`extension/src/lib/result.js`、`extension/src/lib/urls.js`、`extension/src/sidepanel/agent-channel.js`、`extension/src/sidepanel/errors.js`、`extension/src/sidepanel/panel.js`、`extension/src/sidepanel/state.js`、`extension/src/sw/attach-sender.js`、`extension/src/sw/audit.js`、`extension/src/sw/capture.js`、`extension/src/sw/dsh-session.js`、`extension/src/sw/index.js`、`extension/src/sw/menu.js`、`extension/src/sw/native-host.js`、`extension/src/sw/ops/debugger.js`、`extension/src/sw/ops/index.js`
- prompt：`scripts/review-prompts/code-adversarial.md`
- 用时：237.9s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:17:16.838Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
# 三、【最终裁决】

8 条声称中，**②（一次「看左边」一次抓取）、④（审计"按大小轮转"与"结构性不泄漏"）、⑦（写操作三层闸门）被直接证伪**——证据全部落在本次粘贴的源码内，不依赖任何缺席文件：`sniffOnce` 的 session 归零检查排在类型早退之前且武装态不跨页面半共享；审计轮转按条数而非大小、`hostOf` 用 `URL.host` 把端口写进日志、白名单只管键名不管值；`onMessage` 显式弃用 `_sender` 使任意同扩展上下文可自带 `allowWrite:true` 绕过面板，而所谓"扩展侧复核"只是复读 host 布尔值、扩展侧零审批实现。**①③⑤⑥⑧ 一律判「无法证伪但证据不足」**——`dsh-plugin/src/host/`、`tests/**`、`protocol.generated.js`、`scripts/check-dist-config.mjs`/`init-key.mjs`、dist 产物在本轮材料中**零行可见**，这些声称目前仅由注释自我背书，不得记为成立。

另有四处**注释与实现直接矛盾**的死代码/死注释：`urls.js` 声称打包构建从 `chrome.storage.local` 读 key 而实现无一处 `chrome.storage`；`dsh-session.js` 的 `TICKET_KEY()` 声称是测试注入点却硬返回常量；`client.js` 的 `api().inputActions` 读的全局符号从未被赋值；`ops/index.js` 的 `maybeDetach` 是被调用的空函数。

**最可能让用户再次踩坑的 3 个点（概率 × 影响）**：
1. **面板每次打开都把写操作静默关成 false**（`panel.js#initWriteOps` 无条件 POST `allowBrowserWriteOps: false`）——触发概率≈100%，表现为「browser_click 突然消失」且开关回显自洽、不报错，用户必然误判为 DSH 故障。
2. **双页面半 + sessionId 抖动导致「看左边」重复触发、重复建会话、workspace 降级落错目录**（`sniffOnce` 归零顺序 + `openFreshSession` 的 `items[0]` 兜底）——项目自称"两半同时在线是常态"，而 client 半零防御、降级不告警，产物会静默落进错误工作区。
3. **未知 mode 静默降级为整页抓取 + 任意同扩展上下文可自带 `allowWrite:true`**（`route('capture')` 无枚举白名单 / `onMessage` 无 sender 校验）——前者造成"成功外观 + 错误产物"（以为抓选区，实得 120KB 整页），后者使全部写闸门在扩展内部失效。

# 一、【冲突点与采信】

| # | 分歧点 | 各方主张 | 采信方 | 理由 |
|---|---|---|---|---|
| 1 | 声称②「一次『看左边』只触发一次抓取」的裁决 | 提议1：**被证伪**（sessionId 抖动重置武装态、双页面半各持独立 `intentArmed`、重连遗留监听）；提议2：**部分证伪**，同样给出 sessionId 闪烁与双 half 反例 | **提议1（判被证伪）**，但采纳提议2 补充的「删掉再打即重新武装」反例 | 两者证据一致且可在粘贴源码内自洽核对：`sniffOnce` 中 `if (sessionId !== intentSession) { intentSession = sessionId; intentArmed = true }` 位于 `typeof sessionId !== 'string'` 早退之前，`undefined→'s1'` 抖动必然重新武装；这是纯 client 半反例，不依赖 host，足以判「被证伪」而非「证据不足」 |
| 2 | `state.inputActions` 与 `globalThis.__AG_PANEL_INPUT_ACTIONS__` 名称错位 | 提议2：**确凿假绿/真 bug**，`api().inputActions` 恒为 `[]`；提议1：完全未提及 | **提议2** | 少数方给出更强的可核对证据：`CaptureDock` 内写的是 `state.inputActions = props?.inputActions`，而 `api()` 读的是 `Object.keys(globalThis.__AG_PANEL_INPUT_ACTIONS__ ?? {})`，两个符号在全文件中**无任何赋值桥接**（rg 该文件仅此两处出现）。这是不因多数取舍的典型案例 |
| 3 | `hostOf()` 是否泄露端口 | 提议2：`parsed.host` 含 `:port`，违反「HOST ONLY / 只记元数据」注释；提议1：判定「不泄密钥成立」，未察觉端口问题 | **提议2** | `return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined` 逐字可核，`URL.host` 定义含端口，注释写「Host name only」应为 `hostname`——文档/实现自相矛盾 |
| 4 | 审计「按大小轮转」 | 提议1：**被证伪**，实现是按条数 `AUDIT_LIMIT = 200`；提议2：认为 200×~1.3KB「确实有界」 | **提议1**（关于「按大小」措辞）＋**提议2**（关于「有界」成立） | 两者不真冲突：`while (list.length > AUDIT_LIMIT) list.shift()` 是条数轮转，故「按大小轮转」被证伪；但总量确有上界，故「有界」成立。拆成两条裁决 |
| 5 | 「扩展侧复核」是否构成独立闸门 | 提议1：**被证伪**，只是复读 host 的布尔值；提议2：**部分证伪**，并追加「同扩展任意页可发 `{kind:'op', allowWrite:true}`，`route()` 无 sender 校验」 | **两者合并**：判被证伪，采纳提议2 的 sender 反例 | `chrome.runtime.onMessage.addListener((message, _sender, sendResponse)` 逐字把 `_sender` 下划线弃用，全文件无任何 `sender.id` 校验——这是比「复读布尔值」更硬的绕过证据 |
| 6 | `panel.js` `initWriteOps()` 无条件 POST `allowBrowserWriteOps: false` | 提议1：列为**第 1 名踩坑**（每次打开面板静默关闭写开关）；提议2：引用了同段代码但未识别该副作用 | **提议1** | `body: JSON.stringify({ allowBrowserWriteOps: false })` 逐字为写语义而非读语义，且函数注释自称是在「读当前值」；副作用可直接从代码推出 |
| 7 | `openFreshSession` 的 workspace 降级 | 提议2：**真 bug**，`return items[0]?.workspaceId ?? items[0]?.id` 会把文件落到错误工作区；提议1：未提及 | **提议2** | 代码逐字可核，且该降级路径**不向用户报告**（仅写入 `__AG_LAST_NEW_SESSION__`），属静默错配 |
| 8 | `switched` 字段的真实性 | 提议2：`await sessions.open()` 不抛 ≠ UI 真切换，属假绿；提议1：未提及 | **提议2** | `try { await sessions.open(sessionId); switched = true }` 逐字，无任何事后校验（未回读 `currentSessionId() === sessionId`） |
| 9 | mode 无枚举校验导致静默降级 | 提议1：列为第 2 名踩坑；提议2：未提及 | **提议1** | `const mode = message.mode === 'auto' ? 'page' : (message.mode ?? 'page')` 无白名单，`buildCapture` 内只对 `'selection'` 特判，其余一律整页 |
| 10 | 取证基线 | 两者一致：`dsh-plugin/src/host/`、`tests/**`、`scripts/*.mjs`、`protocol.generated.js`、dist 产物**均不在材料中** | **一致，予以确认** | 故声称 ①(host 部分)、③(schema)、⑤、⑥、⑦(第一/三层)、⑧ 一律不得判「成立」 |
| 11 | `withDebugger` 的 detach 假绿 | 提议1：`attached.delete(tabId)` 在 `.catch(()=>{})` 之前，内部状态先清理→`attachedTabs()` 恒空；提议2：未提及 | **提议1** | 逐字可核，是本轮最干净的一条结构性假绿 |
| 12 | 提议1 假绿清单第 4 条（`sniff` 探针污染）的自我修正 | 提议1 自己写「修正裁决：此条在纯删除场景下不必然绿」 | **采信其修正后的弱化版本**，降级为 MINOR | 自我修正后证据链诚实；不应按原始强断言计入 |

**各方一致的关键判断**：8 条声称中，仅 ②④⑦ 可在粘贴材料内被直接证伪；①③⑤⑥⑧ 因 host 半、schema、测试、门禁脚本、dist 产物全部缺席，一律为「证据不足」，**任何一方都未把证据不足写成成立**。

---

# 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `dsh-plugin/lib/client.js#sniffOnce` | 亲验(源码) | 声称②**被证伪**：session 归零检查在类型早退之前，`undefined` 抖动即重新武装，同一段「看左边」草稿会被反复 fire | `if (sessionId !== intentSession) { intentSession = sessionId; intentArmed = true }` 紧接才 `if (typeof sessionId !== 'string') return false` |
| BLOCKER | `dsh-plugin/lib/client.js#watchIntent` / 双页面半 | 亲验 | 声称②**被证伪（第二路）**：`intentArmed`/`intentSession` 是页面级闭包变量，主 tab 与 sidepanel iframe 各持一份，无任何跨半协调或 primary 守卫 | `let intentArmed = true` / `let intentSession`（模块闭包内），`hello` 帧只带 `embedded/visible/focused`，无 `primary` 回执 |
| BLOCKER | `extension/src/sw/index.js#onMessage` | 亲验 | 声称⑦「扩展侧复核」**被证伪**：`_sender` 被显式弃用，任何同扩展上下文可发 `{kind:'op', tool:'click', allowWrite:true}` 直达 `runOp`，绕过面板开关 | `chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {` |
| BLOCKER | `extension/src/sidepanel/panel.js#initWriteOps` | 亲验 | 每次打开面板无条件 POST `allowBrowserWriteOps: false`，静默把用户上次开启的写开关关掉，且回显自洽不报错 | `body: JSON.stringify({ allowBrowserWriteOps: false }),`（函数注释却称此为读取当前值） |
| MAJOR | `extension/src/sw/audit.js#hostOf` | 亲验 | 声称④**部分被证伪**：注释写 "Host name only"，实现用 `URL.host`（含 `:port`），内网非标端口被持久化进 `chrome.storage.local` | `return parsed.protocol === 'http:' \|\| parsed.protocol === 'https:' ? parsed.host : undefined` |
| MAJOR | `extension/src/sw/audit.js#AUDIT_LIMIT` | 亲验 | 声称④「按大小轮转」**被证伪**（实现按条数）；「有界」**成立**（200 条 × ≤12 字段 × 120 字符 ≈ 264KB 上界） | `const AUDIT_LIMIT = 200` + `while (list.length > AUDIT_LIMIT) list.shift()` |
| MAJOR | `extension/src/sw/audit.js#projectAudit` | 推理 | 声称④「结构性不泄漏」被夸大：白名单只约束**键名**不约束**值**；`tool` 字段取自 WS 帧且 `validateAs` 实现不在材料中，可承载 ≤120 字符任意内容 | `if (type === 'string') out[key] = value.slice(0, 120)`；注释自称 "a future caller cannot leak by adding a field" |
| MAJOR | `dsh-plugin/lib/client.js#applyAttach` | 亲验 | 声称①在 client 半**无任何防御**：`if (frame.type === 'attach') void applyAttach(frame)` 无 captureId 幂等、无 primary 守卫，host 若漏过滤则双半各建一个会话、各发一次 ack | `state.chips.set(item.captureId, {...})` 前无 `state.chips.has()` 检查 |
| MAJOR | `dsh-plugin/lib/client.js#openFreshSession` | 亲验 | workspace 匹配失败时静默降级到 `items[0]`，文件落进**错误工作区**，且只写进 `__AG_LAST_NEW_SESSION__`，不出现在 ack/chip/UI | `return items[0]?.workspaceId ?? items[0]?.id` |
| MAJOR | `extension/src/sw/index.js#route('capture')` | 亲验 | mode 无枚举白名单：任何未知/拼错 mode 静默降级为整页抓取并返回 `ok:true`，UI 显示「已附加」——成功外观 + 错误产物 | `const mode = message.mode === 'auto' ? 'page' : (message.mode ?? 'page')` |
| MAJOR | `dsh-plugin/lib/client.js#api` | 亲验 | **假绿/死代码**：`api().inputActions` 恒为 `[]`——dock 写入的是 `state.inputActions`，`api()` 读的是 `globalThis.__AG_PANEL_INPUT_ACTIONS__`，全文件无桥接赋值 | 写：`state.inputActions = props?.inputActions`；读：`Object.keys(globalThis.__AG_PANEL_INPUT_ACTIONS__ ?? {})` |
| MAJOR | `extension/src/sw/ops/debugger.js#withDebugger` | 亲验 | **结构性假绿**：`attached.delete(tabId)` 在 detach 失败吞异常**之前**执行，任何「已释放调试器」断言查 `attachedTabs()` 恒绿 | `attached.delete(tabId); await chrome.debugger.detach(target).catch(() => {})` |
| MAJOR | `extension/src/lib/urls.js#pairingKey` | 亲验 | **注释被实现证伪**：文件头称打包构建从 `chrome.storage.local` 读 key，实现里零个 `chrome.storage` 调用，key 恒取模块常量 | `export const pairingKey = () => DEV_CONFIG.key`；`export const agentSocketUrl = (key = DEV_CONFIG.key) =>` |
| MAJOR | `extension/src/sw/dsh-session.js#TICKET_KEY` | 亲验 | **死间接层**：注释称 "Indirection so tests can inject a key"，函数体 `return DEV_KEY` 无任何注入点，测试无法覆写 | `function TICKET_KEY() { return DEV_KEY }` |
| MAJOR | `dsh-plugin/lib/client.js#openFreshSession` (switched) | 亲验 | **假绿**：`sessions.open` 不抛即记 `switched = true`，无事后回读 `currentSessionId()` 校验，UI 未切换也报 true | `try { await sessions.open(sessionId); switched = true } catch (error) {` |
| MAJOR | `dsh-plugin/lib/client.js#trySend` | 亲验 | **假绿**：空实现/被禁用的 `submit()` 只要不抛就记 `ok: true`，「消息已发送」断言在完全没发时仍绿 | `const returned = await fn(); attempted.push({ label, ok: true, ... })` |
| MAJOR | 声称① `hub.pushClientPrimary` | — | **无法证伪但证据不足**：`dsh-plugin/src/host/` 零行在材料中 | 仅有 client.js 注释 "delivered to **exactly one** page half (hub.pushClientPrimary)" |
| MAJOR | 声称⑥ 残留策略 | — | **无法证伪但证据不足**：清理逻辑、命名前缀校验、`<` vs `<=` 阈值比较全部不可见；attach body 亦不携带保留参数 | 材料中零行相关实现 |
| MAJOR | 声称⑦ 第一层「不注册」/ 第三层「审批」 | 推理 | **无法证伪但证据不足**，且**扩展侧确认零审批实现**：`opClick`/`opType` 直接执行，无任何批准交互；`approvalMode` 仅用于生成中文提示文案 | `const gate = payload.approvalMode === 'ask' ? '每次点击/输入都会先向你请求批准' : ...`（纯文案） |
| MINOR | `extension/src/sw/menu.js#handleMenuClick` | 亲验 | 声称③**无法证伪但证据不足**（schema 不可见）；附带缺陷：`.catch(() => {})` 吞掉整条右键链路的错误，失败对用户完全静默 | `}).catch(() => {})` 于 `chrome.contextMenus?.onClicked.addListener` 内 |
| MINOR | 声称⑤ `check-dist-config.mjs` | — | **无法证伪但证据不足**：门禁脚本与 dist 产物均不在材料中；且即便端口一致，明文 key 仍必然被烤进产物（见 urls.js 条） | `export const DEV_CONFIG = { port: 3080, key: 'sU6h_...' }` |
| MINOR | 声称⑧ 测试真伪 | — | **无法证伪但证据不足**（`tests/**` 零行），但被测代码内已定位 6 处结构性假绿（本表已逐条列出） | 注释引用的 `tests/m3/debugger-probe.mjs` 等文件均不可见 |
| MINOR | `extension/src/sw/ops/index.js#maybeDetach` | 亲验 | 空函数被调用，围绕它的任何测试不可能失败 | `function maybeDetach(_tabId) { /* attach lifetime is handled by withDebugger({reuse:true}) */ }` |
| MINOR | `extension/src/sw/index.js#route('capture')` (audit) | 亲验 | `await recordAudit(...)` 返回值被丢弃，`recordAudit` 内 `catch { return false }`，存储写失败时审计静默归零 | `export async function recordAudit(entry) { try { ... } catch { return false } }` |
| MINOR | `dsh-plugin/lib/client.js#__AG_CLIENT__.sniff` | 推理 | 探针直接调用 `sniffOnce` 会消耗真实武装态，同页面多用例间互相污染（提议1 已自我修正为非必然假绿，故降级） | `sniff: (draft) => sniffOnce(currentSessionId(), draft)` |

⚠️ [正文 10007 字符超回包预算 10000，已按行截取前 9790 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260912T061716-moa_verify-51771-yywpbe-67f4ac3ea97c.md（sha256=a1273e440a0c…，89698 字节，保留至 2026-09-26），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=67f4ac3ea97c… audit=/Users/mac/.pimoa/spool/20260912T061716-moa_verify-51771-yywpbe-67f4ac3ea97c.md
