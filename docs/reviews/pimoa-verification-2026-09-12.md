# PiMoa 审核结论·独立验真（2026-09-12）

> 对象：`docs/reviews/pimoa-code-adversarial-bridge.md`（`moa_verify`，quorum 2/2，206.7s，裁决 status=unknown 但正文给出了 3 BLOCKER / 6 MAJOR / 8 MINOR）。
> 方法：**不接受 PiMoa 的转述**，逐条回到本仓库代码核对 —— ①file:line 是否真实存在、②代码是否真的那样、③该断言在当前代码路径上是否真的会发生。判定只有四种：**真 / 部分真 / 误读 / 无法判定**。
> 本文只写"我核过的事实"，不重复 PiMoa 的原文措辞。

## 0. 先说材料缺口（决定哪些结论不能采信）

PiMoa 这一轮**只拿到了桥接层**。它自己明确写出以下文件在其材料里是 **0 字节**，因此相关声称它一律拒绝判"成立"——这一点它做得对，我照录：

| 声称 | 材料缺口 | 现状 |
|---|---|---|
| 「看左边」只抓一次（episode 逻辑） | `dsh-plugin/lib/client.js` 0 字节 | 已派子代理补跑（片 2a） |
| 「测试是真断言/无假绿」 | `tests/**` 全部 0 字节 | 已派子代理补跑（片 2b/2c） |
| 右键菜单端到端落盘 | `extension/` 全部 0 字节 | 同上 |
| 写操作第 2 层（扩展侧 `E_READONLY`） | `E_READONLY` 在材料里 0 次出现 | 同上 |
| 第 3 层 cordis waterfall 契约 | `dsh-tools/lib/index.js` 缺失 | **我已单独实测**（见 §3-3） |

## 1. 逐条验真（桥接层）

| # | PiMoa 声称 | 级别 | 我的判定 | 我的证据（逐字核对点） |
|---|---|---|---|---|
| 1 | `pushClientPrimary` 把"`send()` 没抛"当成送达；半死 socket 下 `delivered=1` 但事件蒸发 | BLOCKER | **真** | `node_modules/ws/lib/websocket.js` 的 `send()`：只在 `readyState === CONNECTING` 时 `throw`；**其余非 OPEN 状态走 `sendAfterClose(this, data, cb)`，且只在传了 `cb` 时才上报**（并把长度加进 `_bufferedAmount`）。`hub.js` 的 `pushClientPrimary` 调用时**没传 cb** ⇒ 静默丢弃却 `return 1`。另外"TCP 黑洞"（对端消失、无 FIN/RST）时 `readyState` 仍是 OPEN，数据进内核缓冲后丢失 —— 同文件 `callAgent` 的注释已经识别过这一类"尸体收得到 ping、吞掉调用"，但投递路径没用上 |
| 2 | 投递失败降级入队时**丢掉 owner**，两个页面半都能合法 drain | BLOCKER | **真（但当前影响被另一个已知缺陷掩盖）** | `attach.js`：`hub.pushClientPrimary(event, resolveOwner(payload.captureId))` —— `takeCaptureOwner` 是**读后即删**；随后 `if (delivered === 0) store.enqueue(event)` 入队的事件里**不含** owner。`pendingRoute` 用 `state.guard().checkClient(req)`（同源 + cookie），两个页面半都合法。**但**：全仓没有任何调用者会 `GET /ag/pending`（台账 §5-11），所以入队的抓取现在本来就永远投不出去 ⇒ 这条是"修 §5-11 时**必须同时**带回 owner，否则会引入'插进错误会话'"的前置约束 |
| 3 | `approval.js` 的 `if (typeof next !== 'function') return { kind: 'allow' }` 是 fail-open | BLOCKER | **部分真**（真实存在，但不能按它说的方式直接翻） | `approval.js:38` 逐字存在；且**单测把它当契约钉住了**：`tests/unit/write-gate.test.mjs:82`「没有 next 时返回 allow（宁可放行也不挂住调用）」。**但它建议的"改成 deny"会弄坏读工具**：该分支之下非写工具走 `return next()`，`next` 不是函数会 `TypeError`。正确修法：**写工具 deny + 非写工具 allow + 大声记日志**（`WRITE_TOOL_SET` 已在同一函数内可用） |
| 4 | `mode` 是创建期 `const` 快照，却回传面板当"会问你" | MAJOR | **真** | `approval.js`：`const mode = !hasApprovalService ? 'switch-only' : approvalRequired() ? 'ask' : 'off'`；`hasApprovalService` 取自 `ctx.get('approval') !== undefined`，而 DSH 引擎自己的注释承认服务可中途卸载（unmount mid-session 会降级）。`index.js` 每次 `/ag/control` 响应都读这个快照 ⇒ 面板文案与运行时事实脱钩。**与我在 v3.38 独立发现的"审批策略 never 时面板仍说会问"是同一类缺陷**（台账 §5-12） |
| 5 | `writeGate.dispose` 从未调用、未包 `ctx.effect` | MAJOR | **真** | `grep -rn writeGate dsh-plugin/src/host/index.js` 只有三处：创建（:238）、写审计（:299）、回传 mode（:300）。无 `dispose()` ⇒ 插件热重载时旧的 `tools/pre-execute` 监听器留在 cordis 总线上 |
| 6 | `TEMP_FILE = /\.tmp$/u` 会删用户的 `.tmp`，与同文件注释矛盾 | MAJOR | **真** | `retention.js:35` 逐字 `export const TEMP_FILE = /\.tmp$/u`；`retention.js:15` 注释逐字 "Anything a user dropped into that folder is theirs — never touched"。而 `store.js` 自己只写 `<stamp>-<slug>-<id6>.md.tmp` ⇒ 完全可收紧 |
| 7 | schema 里 `CaptureResultEvent.error.code` 是裸 string（不是 `$ref`），审计 `errorCode` 只截断不过滤 | MAJOR | **真** | `protocol/messages.schema.json`：`CaptureResultEvent.error.properties.code = {"type":"string"}`、`AgentToolResult` 同；而 `Error.properties.code` 是 `$ref`（`ErrorCode` 14 项）。`index.js` 把它原样进审计，`audit.js#project()` 只 `slice(0,200)` |
| 8 | `onAgentConnect` 消费整队却只投最后一条，日志却打 N | MAJOR | **真（行为是设计，日志是缺陷）** | 逐字：`const queued = store.drainIntents()` → `hub.pushAgent({ ...queued[queued.length - 1], reason: 'queued' })` → 日志 `replayed ${queued.length} queued intent(s)`。设计 §5.2 确实写"补发最后一条"，所以丢 N-1 条是**刻意**的；**假的是那句日志**，且丢弃没有任何记录 |
| 9 | 审计一旦 IO 异常即永久停写，且系统内外都不可观测 | MAJOR | **真** | `audit.js`：`catch { enabled = false; log(...); return false }` —— 无复活路径；所有调用方忽略 `append()` 的返回值；`routes/ping.js` 里**没有任何 audit 字段**（grep 零命中）。审计存在的场景（"这事是谁干的"）恰好是它静默死掉后无法回答的场景 |
| 10 | `check-dist-config.mjs` 断言的是 source==dist，不是"dist 正确"，对自称覆盖的事故恒真 | MAJOR | **真** | 全文只用 `source` 提取期望值（`const expectedPort = (source.match(/port: *([0-9]+)/) ?? [])[1]`），**无独立基准**。若探针崩在"改写了 `dev-config` 但没还原"之间，source 与 dist 一致地错 ⇒ 门禁必然绿 —— 而这正是 HANDOFF 避坑清单第 2 条描述的那类事故 |
| 11 | `look_left`（下划线）vs `look-left`（连字符）三处枚举不一致 | MINOR | **真** | `AttachRequest.trigger` 枚举 `look_left`；`CaptureRequestEvent.reason` 枚举 `look-left`；`attach.js` 的会话模式判定只认 `payload.trigger === 'look_left'`。**这一类拼写错配在本项目已经造成过一个真缺陷**：右键菜单发 `contextmenu`（不在枚举内）⇒ 每次都被 `validateAs` 400 挡掉（v3.38 修） |
| 12 | `store.js` 与 `retention.js` 的默认值语义相反 | MINOR | **真** | `store.js:88` `config.retentionHours > 0 ? sweep : { disabled: true }`（`undefined` ⇒ **不清理**）；`retention.js:45` `options.retentionHours ?? 24`（`undefined` ⇒ **默认 24h 清理**）。当前靠 `index.js` 的 `?? 24` 兜住，任何直接 `createStore()` 的新调用点会静默关掉保留 |
| 13 | `ASSET_FILE` 允许 `webp`，而协议只允许 png/jpeg | MINOR | **真（无害）** | `retention.js:33` 正则含 `webp`；`Screenshot.mime` 枚举只有 png/jpeg。只多识别本模块命名的文件，不会删错用户文件 |
| 14 | `linkCaptureToIntent` 依赖非 required 的 `captureId`，缺失即静默退回启发式 | MINOR | **真** | schema：`CaptureResultEvent.required = ["type","requestId","ok"]` —— **没有 `captureId`**；`index.js` 用 `typeof frame.captureId === 'string'` 守卫，缺失时无日志 |
| 15 | `pickPrimary` 平局退化到 Set 插入序；从未发 `hello` 的半得 0 分 | MINOR | **真（窄）** | `score` 与 `connectedAt` 皆相同（同 tick 连上）时 `sort` 稳定 ⇒ 退化到插入序；`facts={}` 的半得 0 分，可能被选中而另一个更"在场"的被跳过 |
| 16 | `consistency-check.mjs` 的豁免按**整行**判定 | MINOR | **真 —— 这是门禁自身的假绿** | `consistency-check.mjs:211`：`if (rule.pattern.test(line) && !(rule.allowIf !== undefined && rule.allowIf.test(line)))` —— 模式与否定词**在同一行**即豁免。把旧说法写进含"废弃/已改/历史"的句子里，该行所有规则命中全部被吞 |
| 17 | `WRITE_TOOLS` 只含三个工具；`fullPage` 截图与 `ax` 不在闸门内 | MINOR | **部分真，但我核出一条更硬的（见 §2）** | PiMoa 的说法是"材料里找不到它们的开关实现"——方向对但结论弱。真正的问题是它们**根本没查开关** |

## 2. 我额外核出的一条真缺陷（PiMoa 只擦到边）

**`browser_screenshot({fullPage:true})` 与 `browser_ax` 会在用户**没开**「浏览器控制」开关时 attach 调试器。**

- `extension/src/sw/ops/index.js:266`：`if (debuggerAvailable() && (wantFullPage || settings.browserControl === true))`
- `extension/src/sw/ops/index.js:290`：`if (!debuggerAvailable()) throw opError('E_NO_PERMISSION', 'accessibility tree needs chrome.debugger')`
- `extension/src/sw/ops/debugger.js:32`：`debuggerAvailable()` = `typeof chrome.debugger?.attach === 'function'` —— **只查 API 存在，不查用户开关**。

后果：模型只要调 `browser_screenshot{fullPage:true}`（或 `browser_ax`），就会 attach 调试器、弹**不可消除**的「正在调试」横幅，即使「浏览器控制」是关的。这与

- **ADR-12 / T8**「install 期必需、**运行期 opt-in**：默认不 attach，需在微壳里显式打开「浏览器控制」+ 站点白名单」，以及
- `tools.js` 里该工具自己的描述「整页需要「浏览器控制」开关」

**直接矛盾**：工具声明了契约，实现没执行。级别 **MAJOR**（隐私/UX 契约 + 会与用户的 DevTools 互踢）。

## 3. 我为验真额外做的三项独立实测

1. **`ws.send()` 语义**（决定 BLOCKER-1 是否成立）：读 `node_modules/ws/lib/websocket.js` 源码确认 —— 只在 CONNECTING 抛；其余非 OPEN 走 `sendAfterClose`，未传回调即静默。判定 BLOCKER-1 **成立**。
2. **跨时钟/端到端交叉验证**：真实环境里用工具桥 `browser_read` 读到的页面正文长度 **5983 字符**，与同一时刻插件审计日志里那次抓取的 `chars: 5983` **逐字相符** —— 两条独立通道（扩展读页面 / 插件记审计）互相印证，说明"抓的确实是那一页、审计记的确实是那一次"。
3. **行为级验证（不是读代码）**：真实环境里连续两次抓取，审计日志 `delivered` 从 `2` 变成 `1`、每次抓取只新建**一个**会话（会话库按毫秒核对）、`trigger=look_left` 只出现**一条**（此前 785ms 内两条）⇒ v3.39 的两处修复在真实部署里确认生效。

## 4. 结论：确认要修的清单（按优先级）

| 优先级 | 项 | 修法要点 |
|---|---|---|
| P0 | `pushClientPrimary` 的送达判定（§1-1） | 判别 `readyState === WebSocket.OPEN`；不 OPEN 即换下一个候选；把"未确认送达"如实计入返回值/日志。更稳的长期解：以 client 的 `ack` 作为送达证据 |
| P0 | `browser_screenshot{fullPage}` / `browser_ax` 绕过运行期 opt-in（§2） | 两处都加 `settings.browserControl === true` 前置；关着时返回可读错误"整页截图需要先打开「浏览器控制」"（与工具描述一致） |
| P0 | 降级入队丢 owner（§1-2） | 修 §5-11（补投路径）时**必须**同时把 owner 带进队列 |
| P1 | `writeGate` 三处（§1-3/4/5） | 写工具 fail-closed + `mode` 每次响应重算 + 用 `ctx.effect` 包裹并调用 `dispose` |
| P1 | `TEMP_FILE` 越界删用户文件（§1-6） | 正则收紧为 `<stamp>-<slug>-<id6>.md.tmp` |
| P1 | 审计静默死掉不可观测（§1-9） | 不永久 latch（下次尝试复活/冷却重试）；`/ag/ping` 暴露 `auditEnabled` 与丢弃计数 |
| P1 | `check-dist-config` 恒真盲区（§1-10） | 加独立基准：真实配对文件的 port（存在时），或断言 dist 端口不是测试端口 |
| P1 | `onAgentConnect` 日志谎报（§1-8） | 日志改 `replayed 1/N`，丢弃数进审计 |
| P2 | schema `error.code` 收紧（§1-7） | `$ref: ErrorCode`（协议改动：schema → codegen → 向量 → 三端同步测试） |
| P2 | consistency 门禁整行豁免（§1-16） | 豁免改为"否定词与命中在同一条**句子**内且距离受限"，而不是整行 |
| P2 | 其余 MINOR（§1-11/12/13/14/15/17） | 拼写统一、默认值收敛、`captureId` 提为 required、平局加确定性 tie-break |

## 5. 未完成的部分（如实）

- 常规 code review（`code-review.md`）**两片零产出**，原因待子代理回报；已派其改 4 片小分量重跑。
- 对抗性 review 的**扩展/测试片**因材料预算（424541 > 360000 字符）整片失败，已派其改 3 片重跑 ⇒ 「看左边只抓一次」「测试有无假绿」这两条**目前仍未被外部审过**。
- 我自己的验真只覆盖"桥接层 + 我额外发现的那条"；扩展侧与测试侧的验真要等补跑结果。

---

# 第二批验真：全量 code review（片 1/2/3/4a）与对抗性补跑（2a/2b/2c）

材料：`pimoa-code-review-{1-bridge,2-extension,3-tests,4a-probes-m0m1}.md` + `pimoa-code-adversarial-{2a-extension,2b-tests,2c-probes}.md`。
**片 4（`tests/m2/**` + `tests/m3/**`，11 个探针）两跑两败**（驱动侧 undici `UND_ERR_BODY_TIMEOUT`，不是预算超限）⇒ **m2/m3 至今没有任何 PiMoa 裁决**。

## 6.1 我核过的（判定 + 证据）

| # | PiMoa 声称 | 判定 | 我的证据 |
|---|---|---|---|
| 1 | `guard.js#sameOriginOk`：Origin 缺失即放行，`/ag/pending` 可被跨站清空 | **真（安全）** | `guard.js:64` 逐字 `if (origin === undefined) return true`；`:90` `checkClient: (req) => sameOriginOk(req) \|\| (keyOk(req) && originOk(req))`。导航 / `<img>` 这类请求**不发 Origin** ⇒ 不带 key 即通过；`pendingRoute` 用 `checkClient`，而它的 `drain()` 是消费式 `splice`。**修法**：缺 Origin 时要求 `Sec-Fetch-Site: same-origin` + 有效会话 cookie；drain 改 POST |
| 2 | `hub.js:73` 用整帧子串判 pong，正文含 `"pong"` 的帧被整条丢弃 | **真（窄）** | 逐字 `if (text.includes('"pong"')) return` —— 发生在 `JSON.parse` 与 `settle()` **之前**。修法：先 parse 再判 `frame.type === 'pong'` |
| 3 | 协议定义 `agent-hello`、扩展在发，host 无 handler | **真（接线）** | `messages.schema.json:841` 有定义、`agent-channel.js:155` 在发、`onAgentFrame` 逐字 `if (frame?.type !== 'capture-result') return` ⇒ 与已知的 `request-pending` 是**同类第二个死帧** |
| 4 | `deliveredTo` 把计数当 socket id | **真（协议撒谎）** | `attach.js` 逐字 `deliveredTo: delivered === 0 ? [] : [\`client:${String(delivered)}\`]`，向量里是 `"client:8f2c"` 这种 id 形状；我改成 `pushClientPrimary` 后它**恒为 `['client:1']`**，而 `client:1` 不是任何真实 id |
| 5 | `probe-all.mjs` 的 dist 收尾失败不影响退出码 | **真（我自己写的）** | 我加的收尾块只有 `console.error`，没有 `process.exitCode` ⇒ 它失败时 `probe:all` 仍绿 —— 正是"假绿"，而我刚犯 |
| 6 | `dsh-session.js#ensureReady` 在 ticket 失败时把长期 key 拼进 iframe URL | **真（安全/卫生）** | 逐字 `url: enterUrl(), state: { …, handshake: 'key-fallback', ticketError: … }`，与同文件注释"the long-lived key never enters the frame URL"矛盾（设计 T9 要求 key 不进网页可达位置） |
| 7 | `agent-channel.js#handleCaptureRequest` 校验失败只 log、不回 `capture-result` | **真（接线）** | 逐字 `if (!validated.ok) { log(…); return }` —— 设计 §5.2 明写「`capture-result` 必须无条件回包」，否则该意图两侧都无终态 |
| 8 | `panel.js#initWriteOps` 每次开面板把写开关静默置 false | **真（用户可撞上）** | 代码逐字 `body: JSON.stringify({ allowBrowserWriteOps: false })`，注释却自称在读当前值；审计里 panel 驱动的那条 `{"kind":"control","ok":false}` 出现在 06:06:15Z（= 用户重开面板时刻） |
| 9 | `extract.fn.js#stripTrailingMeta` 的 `\|\|` 架空 `digitRatio` | **部分真（杀伤被 META_BLOCK 收窄）** | `:108` 逐字 `if (digitRatio > 0.15 \|\| /^[^。.!?]{0,80}$/u.test(value)) el.remove()`；但 `:105` 先要求 `META_BLOCK = /(downloads?\b\|last updated\|current version\|license\b\|updated \d+\w+ ago)/iu` 命中 ⇒ 只有**含这些英文关键词**的尾部短块会被删（如 clawhub 页的 `License MIT-0`）。PiMoa 那句"任何 ≤80 字短段都会被删"**不成立** |
| 10 | 三个写 op（click/type/navigate）可能绕过开关 attach 调试器 | **误读（驳回）** | `ops/index.js:176/181/204` 逐字都带 `settings.browserControl === true &&` 前置 ⇒ 未绕过。PiMoa 自己标了"可疑待验"，核完是**虚警** |
| 11 | 片1 称 `E_READONLY` 在"全内联代码"里 0 次出现 | **误读（材料缺口）** | `ops/index.js` 里该分支真实存在；片1 材料**没有** `extension/`，而片2c 独立判"前两层成立" ⇒ 跨片冲突按"检查存在"收敛 |
| 12 | m0a/m0b 探针"是现象记录器不是测试"（无 assert、恒 exit 0） | **真** | 与此前亲验一致：`capture-probe` 末尾无条件 `process.exit(0)`；`filter(([, v]) => v === false)` 只认字面 `false`（`null`/对象静默通过）；`chipNeverFallsBackToDom` 用 `[].every(...)` 空数组恒真 |

## 6.2 第二轮暴露的方法论问题（不是产品缺陷，但影响结论可信度）

1. **PiMoa 的 verifier 看不到本仓库**：片4a 的会话 cwd 是 `/Users/mac/ai_tools/PiMoa`，它明确写"粘贴的文件在该仓库内不存在、所有『如何验证』命令在此环境无法执行"；片3 的裁决却称"找不到被审仓库"这个前提是错的。⇒ **同一服务在不同会话给出相反的文件系统可见性**；所有"如何验证"的建议都必须在本地自己重核（本文档做的就是这件事）。
2. **回包预算 10000 字符**：片1/片2/片4a 的产物各被按行截断（截掉的多是"未覆盖声明"），子代理从 spool 补回 ⇒ 读产物必须同时读 spool 尾部，否则会漏掉"哪些范围没覆盖"。
3. **`status` 恒 `unknown`**：驱动 `structured?.status` 解析从未命中，真正裁决只在正文 ⇒ 驱动的 verdict 解析是坏的（待修）。
4. **材料守卫的副作用**：`scripts/material-guard.mjs` 与 `tests/unit/material-guard.test.mjs` 因为**自身源码含正则字面量/测试夹具**而被自己的内容嗅探拦住 ⇒ 这两个文件进不了任何审查材料。需修：内容嗅探要求"真实密钥块"（PEM 头 + ≥200 字符 base64），而不是裸关键词。
5. **取证快照**：驱动启动时一次性读材料；02:14–02:16 我并发新增了守卫/测试并改了 `ops/index.js` ⇒ 片2/片3 审的是 02:16 时刻的内容，**我的 opt-in 修复与守卫本身从未被审到**。
