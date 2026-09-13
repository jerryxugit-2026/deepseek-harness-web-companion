# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`dsh-plugin/src/host/approval.js`、`dsh-plugin/src/host/audit.js`、`dsh-plugin/src/host/cookie.js`、`dsh-plugin/src/host/guard.js`、`dsh-plugin/src/host/hub.js`、`dsh-plugin/src/host/index.js`、`dsh-plugin/src/host/key-store.js`、`dsh-plugin/src/host/paths.js`、`dsh-plugin/src/host/retention.js`、`dsh-plugin/src/host/routes/attach.js`、`dsh-plugin/src/host/routes/control.js`、`dsh-plugin/src/host/routes/enter.js`、`dsh-plugin/src/host/routes/ping.js`、`dsh-plugin/src/host/routes/probe-page.js`、`dsh-plugin/src/host/routes/ticket.js`、`dsh-plugin/src/host/routes/whoami.js`、`dsh-plugin/src/host/routes/ws-echo.js`、`dsh-plugin/src/host/routes/ws-probe.js`、`dsh-plugin/src/host/store.js`、`dsh-plugin/src/host/tickets.js`、`dsh-plugin/src/host/tools.js`、`native-host/host.mjs`、`native-host/install.mjs`、`native-host/launcher.mjs`、`native-host/protocol.generated.mjs`、`native-host/rotate.mjs`、`protocol/codegen.mjs`、`protocol/messages.schema.json`、`protocol/vectors/invalid/ack-bad-status.json`、`protocol/vectors/invalid/attach-bad-trigger.json`、`protocol/vectors/invalid/attach-extra-key.json`、`protocol/vectors/invalid/attach-missing-page.json`、`protocol/vectors/invalid/garbage.json`、`protocol/vectors/invalid/hello-missing-version.json`、`protocol/vectors/invalid/page-missing-capturedat.json`、`protocol/vectors/invalid/screenshot-webp.json`、`protocol/vectors/invalid/unknown-error-code.json`、`protocol/vectors/invalid/ws-bad-op.json`、`protocol/vectors/invalid/ws-response-missing-ok.json`、`protocol/vectors/valid/ack.json`、`protocol/vectors/valid/attach-request.json`、`protocol/vectors/valid/attach-response.json`、`protocol/vectors/valid/client-ack.json`、`protocol/vectors/valid/client-attach.json`、`protocol/vectors/valid/client-intent.json`、`protocol/vectors/valid/error.json`、`protocol/vectors/valid/extension-capture.json`、`protocol/vectors/valid/native-ensure.json`、`protocol/vectors/valid/native-response.json`、`protocol/vectors/valid/native-status.json`、`protocol/vectors/valid/pending.json`、`protocol/vectors/valid/ping.json`、`protocol/vectors/valid/ticket.json`、`protocol/vectors/valid/ws-event.json`、`protocol/vectors/valid/ws-hello.json`、`protocol/vectors/valid/ws-ping.json`、`protocol/vectors/valid/ws-pong.json`、`protocol/vectors/valid/ws-request.json`、`protocol/vectors/valid/ws-response-err.json`、`protocol/vectors/valid/ws-response-ok.json`、`scripts/.dev-extension-key.json`、`scripts/check-dist-config.mjs`、`scripts/consistency-check.mjs`、`scripts/doc-graph.mjs`、`scripts/init-key.mjs`、`scripts/pimoa-review.mjs`、`scripts/probe-all.mjs`
- prompt：`scripts/review-prompts/code-adversarial.md`
- 用时：206.7s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:05:33.606Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
# 三、【最终裁决】

八条声称中，**只有一条可判成立**：声称 3 的 schema 层（`AttachRequest.trigger` 枚举含 `manual`，`attachRoute` 走 `validateAs` 校验，逐字可核）——但其端到端（扩展侧 contextMenus 映射）无材料，不得外推。声称 1、4、6、7 **部分被证伪**：单投递的主路径确实改对了，但半死 socket 下"send 不抛即送达"与降级入队丢 owner 两条旁路会复现同一用户可见症状；审计的 allow-list 保护 key 不保护 value，`error.code` 未用 `$ref` 收紧即是可泄任意 200 字符的缺口，且"有界"的失败模式是**永久静默停写且不可观测**；残留策略的 `TEMP_FILE = /\.tmp$/` 与同文件"绝不碰用户文件"的注释直接矛盾；三层闸门中第一层结构性成立、第二层在材料中查无实据、第三层含一条 fail-open 分支 + 一个从未被调用的 dispose + 一个会对用户撒谎的冻结 mode。声称 5 的门禁逻辑正确但对其自称覆盖的事故类型恒真盲视。声称 2、8 **未被证实**——其唯一载体（`dsh-plugin/lib/client.js`、`tests/**`）在材料中零字节，此处任何更积极的裁决都违反证据准则；且在 host 侧还发现与声称同链路的真缺陷（队列消费 N 条只投 1 条、日志谎报 N）。

最可能让用户再次踩坑的三点，按概率×影响排序：**①** `pushClientPrimary` 的"send 没抛即送达" + `/ag/pending` 降级丢 owner——用户仍会看到"抓取落进别的会话/凭空消失"，与当初被修的现象难以区分，因此同一个 bug 报告会再来一次；**②** 审批闸门对未验证宿主契约的单向依赖且 fail-open，叠加冻结 mode 经 `ControlResponse.approvalMode` 回传面板——最可能的失效不是崩溃而是"面板说会问你、实际不问"，属安全 UI 撒谎，无任何外部观测点能揭穿；**③** `TEMP_FILE` 越界删用户 `.tmp`（注释保证与实现相反，删除只进 log 不进审计）配合审计一旦 IO 异常即永久静默停写——下一次"这个会话是谁拉起来的？"仍将无法回答，而这正是 `audit.js` 开篇写下的、促使它诞生的那个问题。

# 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| 声称 4「审计不泄敏感数据」的裁决 | A：allow-list 结构性成立，未找到泄密反例，判"形式成立"；B：`errorCode` 取自 `CaptureResultEvent.error.code`，schema 是裸 `"code": {"type":"string"}` 而非 `$ref: ErrorCode`，`project()` 只 `slice(0,200)` 不做字符过滤，扩展可塞任意 ≤200 字符（含 URL/token） | **B** | B 给出可逐字核对的 schema 片段（`CaptureResultEvent.error.properties.code` = `{"type":"string"}`，对比 `Error.properties.code` = `{"$ref":"#/$defs/ErrorCode"}`）+ `index.js` 中 `errorCode: frame.error?.code` 的传递链。这是可核对反例，A 只是"没找到"。allow-list 保护 key 不保护 value，是真实缺口 |
| 声称 6 的主要缺陷点 | A：并发 capture 时 A 的 sweep 会删掉 B 未 rename 的 `.tmp`；B：`TEMP_FILE = /\.tmp$/u` 无前缀约束，会删用户自己的 `.tmp`，与注释"Anything a user dropped into that folder is theirs"直接矛盾 | **两者都成立，B 更硬** | B 是注释与实现的逐字矛盾（`retention.js` 正则 vs 同文件注释），单进程即可复现，不需要并发假设；A 的并发窗口在 Node 单进程 + `store.write` 串行 await 下确实存在（两个 HTTP 请求的 async 交错是真的），但需要恰好撞上 `.tmp` 存活窗口且该 `.tmp` mtime 老于 24h——而刚写的 `.tmp` mtime 是 now，**A 的并发反例实际不成立**（cutoff 判定会 keep 它）。故 A 的并发结论应剔除，保留 B |
| 声称 1 的裁决基调 | A："部分证伪"（push() 仍导出 + attach 无幂等 + 选错页面半）；B："无法证伪但证据不足"，并额外给出两条更硬旁路：半死 socket 下 `send()` 不抛 ⇒ `delivered=1` 而事件蒸发；`delivered=0` 时 `store.enqueue(event)` **丢掉 owner**，两个页面半都能合法 `drain()` | **B 的证据 + A 的裁决措辞** | B 的两条旁路都能在给定代码里逐字定位（`pushClientPrimary` 的 try/catch 只捕获抛出；`attach.js` 的 `if (delivered === 0) store.enqueue(event)` 确实不带 `resolveOwner` 结果），比 A 的"push() 还活着"（未被调用 ≠ 缺陷）更实质。裁决上主路径确实修对了，故判"部分证伪" |
| 声称 7 第 3 层的具体证伪点 | A：`hub.callAgent` 是 API 旁路，任何持 hub 引用者可绕过；B：`writeGate.dispose` 从未被调用/未包 `ctx.effect`（监听器泄漏）、`mode` 创建期冻结导致面板可能对用户撒谎、`next` 缺失时 `return {kind:'allow'}` 是 fail-open | **B 为主，A 的旁路作为补充** | B 的三点都能在给定代码里逐字核对：`index.js` 中 `const writeGate = createWriteGate({...})` 之后仅读 `writeGate.mode`，全文无 `writeGate.dispose()`；`approval.js` 的 `mode` 是 `const` 快照；fail-open 分支逐字可见。A 的 hub 旁路属于"理论可达但当前无调用点"，级别应降 |
| 声称 2 的额外发现 | A：仅判"材料缺失，未证实"；B：同判未证实，但**额外发现 host 侧真缺陷**——`onAgentConnect` 里 `drainIntents()` 消费整队却只投 `queued[queued.length-1]`，日志却打 `replayed ${queued.length} queued intent(s)` | **B** | B 的发现在 `index.js` 里逐字可核，是日志与行为不符 + 静默丢件的真缺陷，与"是否触发两次"正交但同属该链路。A 漏掉了 |
| 声称 5 的裁决 | A："形式成立但无测试覆盖，证据不足"；B："门禁本身成立，但它宣称覆盖的事故类型未被覆盖"——断言的是 source==dist，source 被污染时两者一致地错，门禁必然绿 | **B** | B 指出了门禁的恒真盲区，这是逻辑层可判定的（`check-dist-config.mjs` 全文只比对 source 与 dist，无"正确端口"的独立基准），不需要额外材料。A 的"没有测试"是弱结论 |
| `ASSET_FILE` 允许 webp vs schema 只允许 png/jpeg | A：指出并判"无害形式不一致"；B：未提 | **A** | A 的观察正确且无害（只会多识别一类本模块命名的文件，不会删错用户文件），保留为 MINOR |
| 是否可基于"材料外文件缺失"给成立裁决 | 两方一致：声称 2、3（端到端）、7 第 2 层、8 均不得判"成立" | **一致** | 符合任务给定的证据准则 |

**各方一致的关键判断**：声称 3 的 schema 层（`trigger` 枚举含 `manual`）成立；声称 8 因测试文件零字节，判"未证实"；`dsh-plugin/lib/client.js`、`extension/`、`tests/`、`dsh-tools/lib/index.js` 全部缺席，相关声称一律不得判成立。

---

# 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `dsh-plugin/src/host/hub.js#pushClientPrimary` | 亲验 | 把"`send()` 没抛异常"等同于送达；半死 socket（无 RST 的 TCP 黑洞）下 `delivered=1`，attach 既不重发也不入队，永久蒸发 —— 而同文件 `callAgent` 注释已认识到"尸体能答 ping 却吃调用"，未把该认识应用到投递 | `try { target.ws.send(JSON.stringify(event)); return 1 } catch { sockets.client.delete(target); return 0 }` |
| BLOCKER | `dsh-plugin/src/host/routes/attach.js#attachRoute` | 亲验 | 投递失败降级入队时**丢弃 owner**；`pendingRoute` 用 `checkClient`（same-origin 即可），两个页面半都能合法 `drain()`（消费式 splice），`sessionMode:'current'` 会插进错误会话 —— 与被修复的原缺陷症状同源 | `const delivered = hub.pushClientPrimary(event, resolveOwner(payload.captureId))` / `if (delivered === 0) store.enqueue(event)` |
| BLOCKER | `dsh-plugin/src/host/approval.js#createWriteGate` | 亲验 | `next` 不是函数时 `return { kind: 'allow' }` —— 闸门形状不对/宿主 API 漂移时**静默放行**，与"三层闸门 fail-closed"的全部意义相反 | `if (typeof next !== 'function') return { kind: 'allow' }` |
| MAJOR | `dsh-plugin/src/host/approval.js#createWriteGate` + `index.js` | 亲验 | `mode` 是创建期 `const` 快照（`hasApprovalService` 与 `approvalRequired()` 各求值一次），却经 `ControlResponse.approvalMode` 回传面板；若运行时事实变化，面板会告诉用户"每次写操作都会问你"而实际不问 | `const mode = !hasApprovalService ? 'switch-only' : approvalRequired() ? 'ask' : 'off'` |
| MAJOR | `dsh-plugin/src/host/index.js#apply`（writeGate） | 亲验 | `writeGate.dispose` **全文从未被调用、未包 `ctx.effect`**；插件热重载时旧实例的 `tools/pre-execute` 监听器泄漏在 cordis 总线上 | `const writeGate = createWriteGate({...})`，此后仅出现 `writeGate.mode` |
| MAJOR | `dsh-plugin/src/host/retention.js#TEMP_FILE` | 亲验 | `/\.tmp$/u` 无任何前缀约束，会删用户放在捕获目录的任意 `.tmp`（老于 24h）——与同文件注释"Anything a user dropped into that folder is theirs — never touched"直接矛盾；`store.js` 只写 `<stamp>-<slug>-<id6>.md.tmp`，完全可以收紧 | `export const TEMP_FILE = /\.tmp$/u` |
| MAJOR | `protocol/messages.schema.json#CaptureResultEvent.error.code` / `AgentToolResult.error.code` | 亲验 | 裸 `{"type":"string"}` 而非 `$ref: "#/$defs/ErrorCode"`（对比 `Error.properties.code` 就是 `$ref`）；`index.js` 把它原样写进审计 `errorCode`，`project()` 只 `slice(0,200)` 不过滤——"不泄 URL/正文/密钥"退化为靠扩展自律 | `"error": { ... "properties": { "code": { "type": "string" } ...` vs `"Error": { ... "code": { "$ref": "#/$defs/ErrorCode" }` |
| MAJOR | `dsh-plugin/src/host/index.js#onAgentConnect` | 亲验 | `drainIntents()` 消费**整队**，却只投 `queued[queued.length - 1]`；日志打 `replayed ${queued.length} queued intent(s)`——日志与行为不符，被丢的意图无任何记录 | `const queued = store.drainIntents()` / `hub.pushAgent({ ...queued[queued.length - 1], reason: 'queued' })` / 日志 `replayed ${String(queued.length)}` |
| MAJOR | `dsh-plugin/src/host/audit.js#createAuditLog` | 亲验 | 任一 IO 异常（含 `rotateIfNeeded` 内的 stat/read/write）即 `enabled = false` **永久**关闭，无复活路径；`append()` 返回 false 而所有调用方忽略返回值，`/ag/ping` 也不暴露 `audit.enabled` —— "审计已死"在系统内外均不可观测，而这正是审计存在的场景 | `catch (error) { enabled = false; log(...); return false }`；`pingRoute` payload 无 audit 字段 |
| MAJOR | `scripts/check-dist-config.mjs`（整体） | 推理 | 断言的是 `source.port === dist.port`，不是"dist 是正确端口"；当探针崩在"改写了 dev-config 但未还原"之间，source 与 dist 一致地错，门禁**必然绿**——恰是它自称要防的那类事故 | `const expectedPort = (source.match(/port: *([0-9]+)/) ?? [])[1]`，全文无独立基准 |
| MINOR | `protocol/messages.schema.json`（trigger/reason 枚举） | 亲验 | `AttachRequest.trigger` 用 `look_left`（下划线），`CaptureRequestEvent.reason` 用 `look-left`（连字符），`ClientIntentEvent.trigger` 又是 `["keyword","gesture"]`；`attach.js` 的会话模式判定**只认 `look_left``——中间层若透传连字符形态，行为静默翻转（此路 fail-closed，风险在扩展侧映射） | `const sessionMode = payload.trigger === 'look_left' ? 'current' : ...` |
| MINOR | `dsh-plugin/src/host/store.js#write` vs `retention.js#sweepCaptures` | 亲验 | 默认值语义相反：`retention.js` 是 `options.retentionHours ?? 24`（默认清理），`store.js` 是 `config.retentionHours > 0 ? ... : {disabled:true}`（`undefined` ⇒ 不清理）；当前靠 `index.js` 的 `?? 24` 兜住，任何直接 `createStore({...})` 的新调用点会静默关掉保留 | `const swept = config.retentionHours > 0 ? await sweepCaptures(...) : { removed: [], kept: 0, disabled: true }` |
| MINOR | `dsh-plugin/src/host/retention.js#ASSET_FILE` | 亲验 | 正则允许 `webp`，而 `Screenshot.mime` 枚举只有 `image/png|image/jpeg`——两层不一致（无害：只多识别本模块命名的文件） | `/^browser-\d{4}-\d{2}-\d{2}-\d{4}-.*\.(?:png\|jpe?g\|webp)$/u` |
| MINOR | `dsh-plugin/src/host/index.js#linkCaptureToIntent` | 亲验 | `CaptureResultEvent.captureId` 在 schema 里非 required；扩展漏填时 owner 静默丢失、退回 `pickPrimary` 启发式，无任何日志 | schema `"required": ["type","requestId","ok"]`；`if (validated.ok === true && typeof frame.captureId === 'string')` |
| MINOR | `dsh-plugin/src/host/hub.js#pickPrimary` | 亲验 | `score` 与 `connectedAt` 皆相同时（同 tick 连上的两半）退化为 Set 插入序；且从未发过 `hello` 的半 `facts={}` 得 0 分，可能选中最旧的那个 | `candidates.sort((a,b) => (score(b)-score(a)) \|\| ((b.connectedAt ?? 0)-(a.connectedAt ?? 0)))[0]` |
| MINOR | `scripts/consistency-check.mjs#allowIf: NEGATED` | 亲验 | 豁免按**整行**判定：一行内只要出现"废弃/已改/历史/改为…"，该行上所有规则命中都被吞；把旧说法写进这类句子即永久豁免 | `if (rule.pattern.test(line) && !(rule.allowIf !== undefined && rule.allowIf.test(line)))` |
| MINOR | `dsh-plugin/src/host/approval.js#WRITE_TOOLS` | 亲验 | 仅含三个写工具；`browser_screenshot` 的 `fullPage`（描述自称"需要「浏览器控制」开关"）与 `browser_ax`（同样自称需要开关）不在闸门覆盖内，材料中也找不到它们的开关实现 | `Object.freeze(['browser_click','browser_type','browser_navigate'])`；tools.js `'是否整页（默认视口；整页需要「浏览器控制」开关）'` |

## 「这些声称的证据我没能在材料里找到」

| 声称 | 自称出处 | 缺失物 |
|---|---|---|
| 2. 「看左边」episode 武装/解除去重 | 题面点名 `dsh-plugin/lib/client.js` | 该文件 **0 字节**；host 半 `relayIntent` 无任何幂等键 |
| 3. 右键菜单端到端落盘 | `trigger:'manual'` | `extension/` 侧 contextMenus → POST `/ag/attach` 的映射代码缺失（schema 层成立） |
| 7 第 2 层. 扩展侧 `E_READONLY` 复核 | `tools.js` 注释 | `E_READONLY` 在全部内联代码中 **0 次出现**；`ErrorCode` 枚举也不含它 |
| 7 第 3 层. cordis waterfall `{kind:'allow'}` 契约 | `approval.js` 注释"verified in dsh-tools/lib/index.js" | 该文件缺失；`next()` 是否返回 Promise、同步返回是否被宿主接受，均无从核对 |
| 8. 「测试是真断言」 | `tests/unit/browser-tools.test.mjs`、`tests/unit/agent-selection.test.mjs`、`tests/protocol/contract.test.mjs`、`tests/m3/debugger-probe.mjs` | **全部 0 字节**，只见文件名被注释转述 |
| cookie 格式"已对活服务器实测 2026-09-11" | `cookie.js` 注释 + FINDINGS.md §2-3 | 无握手样本、无 FINDINGS.md |
| "2026-09-12 measured: sessions created 3ms apart" | `attach.js` / `hub.js` 注释 | 无日志样本 |
| A12「debugger 不能放 optional_permissions」 | `consistency-check.mjs` 的 reason | 转述的 `tests/m3/debugger-probe.mjs` 缺失 |

⚠️ [正文 10942 字符超回包预算 10000，已按行截取前 9982 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260912T060533-moa_verify-51771-scwrij-853062a85c25.md（sha256=e03749a3f308…，77601 字节，保留至 2026-09-26），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=853062a85c25… audit=/Users/mac/.pimoa/spool/20260912T060533-moa_verify-51771-scwrij-853062a85c25.md
