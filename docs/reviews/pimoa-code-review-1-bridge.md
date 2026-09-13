# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`dsh-plugin/src/host/approval.js`、`dsh-plugin/src/host/audit.js`、`dsh-plugin/src/host/cookie.js`、`dsh-plugin/src/host/guard.js`、`dsh-plugin/src/host/hub.js`、`dsh-plugin/src/host/index.js`、`dsh-plugin/src/host/key-store.js`、`dsh-plugin/src/host/paths.js`、`dsh-plugin/src/host/retention.js`、`dsh-plugin/src/host/routes/attach.js`、`dsh-plugin/src/host/routes/control.js`、`dsh-plugin/src/host/routes/enter.js`、`dsh-plugin/src/host/routes/ping.js`、`dsh-plugin/src/host/routes/probe-page.js`、`dsh-plugin/src/host/routes/ticket.js`、`dsh-plugin/src/host/routes/whoami.js`、`dsh-plugin/src/host/routes/ws-echo.js`、`dsh-plugin/src/host/routes/ws-probe.js`、`dsh-plugin/src/host/store.js`、`dsh-plugin/src/host/tickets.js`、`dsh-plugin/src/host/tools.js`、`native-host/host.mjs`、`native-host/install.mjs`、`native-host/launcher.mjs`、`native-host/protocol.generated.mjs`、`native-host/rotate.mjs`、`protocol/codegen.mjs`、`protocol/messages.schema.json`、`protocol/vectors/invalid/ack-bad-status.json`、`protocol/vectors/invalid/attach-bad-trigger.json`、`protocol/vectors/invalid/attach-extra-key.json`、`protocol/vectors/invalid/attach-missing-page.json`、`protocol/vectors/invalid/garbage.json`、`protocol/vectors/invalid/hello-missing-version.json`、`protocol/vectors/invalid/page-missing-capturedat.json`、`protocol/vectors/invalid/screenshot-webp.json`、`protocol/vectors/invalid/unknown-error-code.json`、`protocol/vectors/invalid/ws-bad-op.json`、`protocol/vectors/invalid/ws-response-missing-ok.json`、`protocol/vectors/valid/ack.json`、`protocol/vectors/valid/attach-request.json`、`protocol/vectors/valid/attach-response.json`、`protocol/vectors/valid/client-ack.json`、`protocol/vectors/valid/client-attach.json`、`protocol/vectors/valid/client-intent.json`、`protocol/vectors/valid/error.json`、`protocol/vectors/valid/extension-capture.json`、`protocol/vectors/valid/native-ensure.json`、`protocol/vectors/valid/native-response.json`、`protocol/vectors/valid/native-status.json`、`protocol/vectors/valid/pending.json`、`protocol/vectors/valid/ping.json`、`protocol/vectors/valid/ticket.json`、`protocol/vectors/valid/ws-event.json`、`protocol/vectors/valid/ws-hello.json`、`protocol/vectors/valid/ws-ping.json`、`protocol/vectors/valid/ws-pong.json`、`protocol/vectors/valid/ws-request.json`、`protocol/vectors/valid/ws-response-err.json`、`protocol/vectors/valid/ws-response-ok.json`、`scripts/check-dist-config.mjs`、`scripts/consistency-check.mjs`、`scripts/doc-graph.mjs`、`scripts/init-key.mjs`、`scripts/pimoa-review.mjs`、`scripts/probe-all.mjs`
- prompt：`scripts/review-prompts/code-review.md`
- 用时：360.1s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:23:22.362Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

这套代码的骨架设计（单播投递、owner 端到端追踪、allow-list 审计、写工具不注册即不存在）是清醒的，但**多处"承诺"停在注释层而未在代码里闭合**：审批闸把响应式 getter 固化成启动快照、同源判定把"没有 Origin"当成凭证、capture owner 在投递结果未知前就被丢弃、审计 allow-list 留了三个永远没人填的列、收尾门禁失败时不改退出码——这些恰恰都是模块注释最用力强调的那几点，属于典型的"修了被点名的那句话，没修那句话所在的契约面"。两份提议各有独到发现且基本互补：提议A 的 `approval.js` 冻结与 `guard.js` 放行是本轮最强的两条（少数方证据更硬，已优先采纳），提议B 的 owner 链路、`WRITE_TOOLS` 手工同步与 `req.destroy` 后写响应成立但严重度自评偏高；我另行确认了两条双方都漏的硬证据——`deliveredTo` 把计数当 socket id 返回（与协议向量直接冲突）、hub 给 agent socket 也打 `client:` 前缀且仅 4 位熵。**若只能修三处**：一修 `guard.js#sameOriginOk`（照抄同仓 `whoami.js` 已写对的判定，堵住无 key 即可 drain 待投递队列这条唯一确凿可达的鉴权绕过）；二修 `approval.js#createWriteGate`（把 `mode` 改为每次判定时求值，顺带让 `/ag/control` 上报真实状态，一处改动同时修掉"开关不生效"和"上报撒谎"）；三修 capture owner 全链（`linkCaptureToIntent` 丢 owner 时落审计、`takeCaptureOwner` 改为投递成功后再删、`store.enqueue` 连 owner 一起排队、`deliveredTo` 回填真实 socket id），因为它同时关掉"招牌功能静默错投"和"错投后无从追查"两个口子。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `approval.js` 的 `mode` 是否在构造期冻结 | 提议A（deepseek）列为 BLOCKER；提议B（MiniMax）通篇未提，反而断言 `writeGate` "这一层对" | **采信 A** | 代码逐字为 `const mode = !hasApprovalService ? 'switch-only' : approvalRequired() ? 'ask' : 'off'`，`approvalRequired` 是注入的 getter 却只求值一次；`hasApprovalService` 亦为一次性快照。少数方有可核对的行，采纳 |
| `guard.js#sameOriginOk` 无 Origin 即放行 | A 列 MAJOR 并给出 curl 复现；B 未提 | **采信 A，并上调为 BLOCKER** | `if (origin === undefined) return true` 完全不看 Host/key，而 `/ag/pending` 的 `drain()` 是**消费性**的 GET，跨站 `<img>`/导航无 Origin 即可清空队列——副作用不受 CORS 约束 |
| 「看左边」attach 错投页面半 | B 列为 BLOCKER-1（owner 静默丢失）；A 列为 MAJOR-M4（owner read-and-forget + 断连回退） | **两者合并，定 BLOCKER** | 二者是同一缺陷的两个切面且互补：`linkCaptureToIntent` 静默 return + `takeCaptureOwner` 投递前即删除 + `store.enqueue(event)` 不携带 owner，三处叠加使回退到评分选择且不可补救 |
| `audit.js` 失败即永久禁用 | A 定 BLOCKER | **采信事实，降为 MAJOR** | "disables the log once" 是模块自述的**设计**；真正的缺陷是把 `rotateIfNeeded()` 放进同一 `try`，令一次轮转失败连带杀死可用的 append 路径——是健壮性问题而非契约崩塌 |
| `hub.js` suspect 排序 | A 定 BLOCKER | **采信事实，降为 MAJOR** | `suspectAt` 只设不过期、仅 `settle` 清除，确会让好 socket 长期排后；但它**自愈**（轮到它应答即清），代价是每次多耗一半预算，不是功能性中断 |
| `applyTools()` 的 dispose | B 的 B3 论证冗长且中途自我推翻，但落点成立；A 未提 | **采信 B 的落点，定 MAJOR** | `applyTools` 恒传 `keepDisposers`，故 `registerBrowserTools` 里的 `ctx.effect(...)` 分支**永不执行**，插件卸载/热重载时工具 disposer 无人调用 |
| `trigger:'look_left'` vs `reason:'look-left'` | B 定 BLOCKER；A 转而指出 `mode` 枚举漂移（M1） | **采信 B 的定位，降为 MAJOR + 扩展侧待验** | host 侧证据确凿（`payload.trigger === 'look_left'` 对 `reason:'look-left'`），但"扩展是否正确翻译"无代码可证，不能写成已确认 |
| `WRITE_TOOLS` 与注册名手工同步 | B 定 BLOCKER 并进入 top-3；A 未提 | **采信事实，降为 MAJOR** | 确是"第三道闸自身靠人手对齐"的结构缺陷，但当前名单一致、无现网影响，属可演化风险 |
| `req.destroy()` 后仍 `send(4xx)` | B 的 B6；A 未提 | **采信 B，定 MAJOR** | `control.js` 逐字为先 `resolve` 再 `req.destroy()`，随后 `send(res,400,...)` 写死 socket |
| B 提议中大量 "经分析 OK / 已自洽" 条目（M2、M3、M14、M15、m1–m20 多数） | B 自列为缺陷编号 | **不采信，剔除** | 提议正文自己完成了证伪，保留只会稀释信噪比；篇幅不构成证据 |
| 覆盖面声明 | A 明确列出未读文件与预算耗尽；B 亦声明 dump 之外未覆盖 | **一致，予以保留** | 两方对 `extension/**`、`tests/**`、`lib/client.js`、`@deepseek-ai/dsh-tools` 未覆盖的判断一致 |

## 二、【逐条裁决】

BLOCKER | `dsh-plugin/src/host/approval.js#createWriteGate` | 亲验 | `mode` 与 `hasApprovalService` 均在构造期求值一次，`approvalForWriteOps` 运行期失效，且 `/ag/control` 上报的 `approvalMode` 是启动快照——安全开关与其自述的"reports its mode instead of assuming"双双落空 | `const mode = !hasApprovalService ? 'switch-only' : approvalRequired() ? 'ask' : 'off'`
BLOCKER | `dsh-plugin/src/host/guard.js#sameOriginOk / checkClient` | 亲验 | Origin 缺失即无条件放行且不校验 Host/key，而 `/ag/pending` 的 `drain()` 具消费性副作用，跨站导航/`<img>` 即可清空待投递队列 | `if (origin === undefined) return true`
BLOCKER | `dsh-plugin/src/host/index.js#takeCaptureOwner` + `routes/attach.js#attachRoute` | 亲验 | owner 在投递结果已知前即被删除、`store.enqueue(event)` 不携带 owner、`pickPrimary` 静默回退到评分赢家——「看左边」的 `sessionMode:'current'` 可落到另一个 React 应用且不可补救、无审计 | `const delivered = hub.pushClientPrimary(event, resolveOwner(payload.captureId))` / `if (delivered === 0) store.enqueue(event)`
MAJOR | `dsh-plugin/src/host/routes/attach.js#attachRoute` | 亲验 | `deliveredTo` 把**计数**当 socket id 返回，与协议向量里的 id 形状直接冲突，消费方按 id 解析必错 | 实现 `[\`client:${String(delivered)}\`]` vs `protocol/vectors/valid/attach-response.json` 的 `"deliveredTo": ["client:8f2c"]`
MAJOR | `dsh-plugin/src/host/routes/attach.js` ↔ `host/index.js#relayIntent` | 亲验(host)/待验(扩展) | `sessionMode` 判定绑死 `'look_left'`（下划线），而下发的 `reason` 是 `'look-left'`（连字符），两枚举无交叉约束、无 fixture，扩展一旦漏做翻译即静默退化为新会话 | `payload.trigger === 'look_left' ? 'current' : ...` / `reason: 'look-left'`
MAJOR | `dsh-plugin/src/host/approval.js#WRITE_TOOLS` ↔ `host/tools.js` | 亲验 | 第三道闸的写工具名单是手写冻结常量、未从 `buildBrowserTools` 派生，新增写工具漏改即"注册了但不过审批" | `Object.freeze(['browser_click','browser_type','browser_navigate'])`
MAJOR | `dsh-plugin/src/host/hub.js#callAgent` | 亲验 | `suspectAt` 只在超时路径设置、仅 `settle` 清除且无时效，健康 socket 被长期排到末位，每次调用先白耗一半预算 | `.sort((a,b)=>(a.suspectAt===undefined?0:1)-(b.suspectAt===undefined?0:1))`
MAJOR | `dsh-plugin/src/host/routes/control.js#readBody`（`routes/attach.js#readBody` 同形） | 亲验 | 超限时先 `resolve` 再 `req.destroy()`，随后路由仍 `send(res,400,...)`，客户端拿到的是 ECONNRESET 而非状态码；且 4xx 拒绝完全不进审计 | `resolve({ error: ... }); req.destroy()`
MAJOR | `dsh-plugin/src/host/index.js#applyTools` ↔ `host/tools.js#registerBrowserTools` | 亲验 | 恒传 `keepDisposers` 使 `ctx.effect(...)` 分支永不执行，插件卸载/热重载时工具 disposer 无人调用 | `if (Array.isArray(keepDisposers)) keepDisposers.push(...disposers) else ctx.effect(...)`
MAJOR | `dsh-plugin/src/host/audit.js#createAuditLog` | 亲验 | `rotateIfNeeded()` 与 append 共用一个 `try`，一次轮转/stat 失败即把仍可用的写入路径永久关闭；`auditPath()` 固定单文件，多实例下 read-modify-write 丢行 | `appendFileSync(...); rotateIfNeeded()` 在同一 `try` 内，`catch` 里 `enabled = false`
MAJOR | `dsh-plugin/src/host/index.js` 的全部 `audit.append` 调用点 | 亲验 | allow-list 里的 `route` / `durationMs` / `origin` 没有任何生产者；attach 行不带 `requestId`，与 capture-result 行无法按意图关联，审计链断成两截 | `audit.append({ kind:'attach', captureId, trigger, sessionMode, mode, delivered, chars, truncated, hasSelection })`
MAJOR | `dsh-plugin/src/host/retention.js#TEMP_FILE` | 亲验 | 与 `CAPTURE_FILE`/`ASSET_FILE` 不同，它不要求时间戳前缀，用户自己放在捕获目录里的任何 `.tmp` 超过 24h 即被删，违反模块自述的"anything a user dropped into that folder is theirs" | `export const TEMP_FILE = /\.tmp$/u`
MAJOR | `scripts/probe-all.mjs` | 亲验 | dist 收尾重建失败只 `console.error` 不影响退出码，而这段收尾正是为防 2026-09-12 那次"测试端口烤进 dist"事故而存在——它失败时 CI 仍是绿的 | `process.exit(failed.length === 0 ? 0 : 1)`（只统计探针，不含收尾 catch）
MAJOR | `protocol/messages.schema.json#AgentHello` ↔ `host/index.js#onAgentFrame` | host 侧亲验 / 扩展侧待验 | 协议定义了 `agent-hello` 且扩展侧有发送方，但 host 的 agent 分支只处理 `tool-result`、`onAgentFrame` 只处理 `capture-result`——典型"发了但无 handler 的帧" | `onAgentFrame: (frame) => { if (frame?.type !== 'capture-result') return; ... }`
MAJOR | `dsh-plugin/src/host/tools.js` 的 `output.schema` | 待验 | 注释声称"runtime validates every returned value"，但 `AgentToolResult.value` 在协议层是裸 `{type:'object'}`，host 不做形状校验，真正的校验只存在于测试里由测试自己再实现一遍——假绿结构（需 `@deepseek-ai/dsh-tools` 源码方能定案） | `"value": { "type": "object" }`
MINOR | `dsh-plugin/src/host/hub.js#attach` | 亲验 | agent 通道的 entry 也被打上 `client:` 前缀 id，日志与 `failed on ${entry.id}` 误导；且仅 4 位十六进制熵，两个页面半 id 碰撞会让 `pickPrimary(preferredId)` 选错 | `id: \`client:${Math.random().toString(16).slice(2, 6)}\`` （位于 `attach(channel)` 内，对两个 channel 共用）
MINOR | `dsh-plugin/src/host/index.js#state.applyControl` | 亲验 | 把 `'ask'/'switch-only'/'off'` 写进审计的 `errorCode` 字段，与 `ErrorCode` 枚举语义冲突，按该字段做审计查询会误判 | `audit.append({ kind:'control', tool:'allowBrowserWriteOps', ok:..., errorCode: writeGate.mode })`
MINOR | `dsh-plugin/src/host/hub.js` 的 `ws.on('error')` | 亲验/时序待验 | 只从集合删除，不清 `entry.inflight`、不 reject，与 `close` 分支不对称；通常由随后的 `close` 兜底，窗口期内 `inflightCount` 失准 | `ws.on('error', () => { sockets[channel].delete(entry) })`
MINOR | `dsh-plugin/src/host/tools.js#persistScreenshot` | 亲验 | `Math.random().toString(16).slice(2,8)` 可能不足 6 位（如 0.5 → `"0.8"`），同一分钟内两张截图可被 `rename` 静默覆盖 | `id6: Math.random().toString(16).slice(2, 8)`
MINOR | 超时常量族（`hub.js` / `tools.js` / `index.js` / `tickets.js`） | 亲验 | `browser_screenshot` 传 20000 表达"截图慢"，但多 socket 时首候选只拿 `floor(remaining/2)`＝10000，意图被静默折半；`ticketTtl` 30000、`auditMaxBytes` 512KB 各写两份，`keepLines` 更是 1200 与 800 两个值却自称"in line with them" | `const budget = isLast ? remaining : Math.max(200, Math.floor(remaining / 2))`
MINOR | 端口 3080（`launcher.mjs` / `host.mjs` / `init-key.mjs` / vectors） | 亲验 | 四处各写一份默认值；且 `check-dist-config.mjs` 的 key 提取正则一旦失配就静默跳过 key 校验（只在 `expectedKey` 非空时才断言） | `if (typeof expectedKey === 'string' && expectedKey !== '' && !body.includes(expectedKey))`
MINOR | `scripts/consistency-check.mjs` | 亲验 | `NEGATED` 豁免词表（含"改为/修正/历史"等高频词）易被正常叙述无意命中而整行豁免；`stale-protocol-version` 正则只覆盖带引号 JSON 写法，`protocolVersion: 2` 这类无引号写法完全看不见 | `pattern: /"protocolVersion"\s*:\s*(?!1\b)\d+/u`
MINOR | `dsh-plugin/src/host/routes/ws-probe.js` vs `routes/ping.js` | 亲验 | `paired` 一处只看 key、一处是 key && origins，两个诊断口径不一致会让排查失焦 | `paired: state.pairing().key !== undefined` vs `paired: pairing.key !== undefined && pairing.extensionOrigins.length > 0`
MINOR | `dsh-plugin/src/host/index.js` 的 wsecho / wsprobe 注册 | 亲验 | 两条 WS 路由靠对 `ROUTE.whoami` 做字符串替换拼出，未进入协议单源 ROUTE 表，改路由前缀时必漏 | `path: ROUTE.whoami.replace('/whoami', '/wsprobe')`
MINOR | `dsh-plugin/src/host/routes/whoami.js` | 亲验 | `form === FORMS.sameOrigin` 即无条件 `authorized`，同源上下文无需 key 即可读到会话 cookie 名与请求元数据（诊断端点被当常驻端点注册） | `const authorized = form === FORMS.sameOrigin ? true : ...`
MINOR | `native-host/launcher.mjs#ensureDsh` | 亲验/低概率 | 启动失败路径仍可能把已死 pid 写入 state（`child.pid` 在 spawn 后立即有值），后续 `stop-dsh` 得到 ESRCH；`URL_LINE` 未锚定行尾 | `const record = { pid: child.pid ?? null, ... }`
MINOR | `dsh-plugin/src/host/store.js#stamp` 与 `host/tools.js#stampOf` | 亲验 | 同一时间戳语义两份实现，漂移风险 | 两处均为 `${year}-${pad(month+1)}-${pad(date)}-${pad(h)}${pad(m)}`


⚠️ [正文 10023 字符超回包预算 10000，已按行截取前 9693 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260912T062322-moa_verify-51771-h4vy6t-e50899e55c23.md（sha256=b59a3b3a4aad…，149082 字节，保留至 2026-09-26），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=e50899e55c23… audit=/Users/mac/.pimoa/spool/20260912T062322-moa_verify-51771-h4vy6t-e50899e55c23.md
