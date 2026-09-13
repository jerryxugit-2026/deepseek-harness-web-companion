# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`dsh-plugin/lib/client.js`、`extension/src/content/extract.fn.js`、`extension/src/lib/frame-budget.js`、`extension/src/lib/result.js`、`extension/src/lib/urls.js`、`extension/src/sidepanel/agent-channel.js`、`extension/src/sidepanel/errors.js`、`extension/src/sidepanel/panel.js`、`extension/src/sidepanel/state.js`、`extension/src/sw/attach-sender.js`、`extension/src/sw/audit.js`、`extension/src/sw/capture.js`、`extension/src/sw/dsh-session.js`、`extension/src/sw/index.js`、`extension/src/sw/menu.js`、`extension/src/sw/native-host.js`、`extension/src/sw/ops/debugger.js`、`extension/src/sw/ops/index.js`
- prompt：`scripts/review-prompts/code-review.md`
- 用时：339.0s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:29:01.618Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
三、【最终裁决】

这套代码的工程素养很高——错误分层、探针钩子、审计白名单、`trusted` 路径标注都做得比同类项目扎实——但它自称"已验证"的部分恰好落在最脆的三处接缝上。**如果只能修三处**：① `panel.js#initWriteOps` 改为只读取状态（新增只读消息或 GET 分支），别再用一次 POST `false` 把用户刚开的写权限静默注销——这是唯一一条既造成功能回归、又直接制造顺序敏感假绿的双重毒源，且改动只有几行；② `agent-channel.js#handleCaptureRequest` 的校验失败分支补发 `capture-result{ok:false}`，让"永远不静默失败"的注释真正成立，否则一次协议漂移就能让「看左边」永久挂起且无任何信号；③ 把 host 半的"哪个页面半"身份一路带到底——`resolveWorkspace` 改读 `pickPrimary().facts.workspace`、pending 入队携带 owner、`onAgentConnect` 重放全部而非最后一条队列项——这三者是同一个错误的三个面：socket 级事实被全局化或丢弃，后果分别是文件落错仓库、`@文件` 进错草稿、意图被吞。紧随其后应处理的是 `dsh-plugin/lib/client.js` 手写协议常量（`protocolVersion: 1` 与 `'/ag/client'` 无任何同步机制，是全链路静默失效的定时炸弹，加一条 `npm run check` 断言即可）与 `extract.fn.js#stripTrailingMeta` 的恒真判据（有可执行反例，每个用户每次抓取都在受影响）。最后必须说清：B 类"假绿"本轮**没有拿到直接证据**——测试与探针代码一行未见，本报告列出的都是从实现结构反推的风险点，其中 `__AG_PROBE_WRITE__` 与真实 `applyAttach` 路径的分叉最值得优先去读测试确认；同理，被点名的"测试密钥烤进发布产物"因 `dev-config.js` 与 `init-key.mjs` 缺失而完全未能评估，请勿把本报告的沉默当作该项通过。

一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| 是否应报 host 半（`hub.js`/`host/index.js`/`routes/attach.js`）的缺陷 | 提议1：额外读到这三个文件，报出 `onAgentConnect` 只重放最后一条 intent、`clientFacts` 全局 workspace 互覆、`deliveredTo: 'client:1'` 假标识、pending 队列丢 owner；提议2：完全未读 host，声明全部为盲区 | 提议1（有条件采信） | 它给出了可核对的逐字片段（`queued[queued.length - 1]`、`clientFacts.workspace`、`deliveredTo: delivered === 0 ? [] : ['client:'+delivered]`），提议2对同一区域只是声明未覆盖，非反证。但这些文件不在任务上下文内，只能记为"引用外部证据、待复核"，不得升格为上下文内已确认。 |
| `panel.js` `initWriteOps()` 初始化时 POST `{allowBrowserWriteOps:false}` 是否缺陷 | 提议1：BLOCKER，每次开面板静默把写权限关掉、并造成探针顺序敏感假绿；提议2：未提及（只在 MAJOR-188 讨论 method 是否 POST 后判 OK） | 提议1 | 上下文内可逐字核对：`body: JSON.stringify({ allowBrowserWriteOps: false })` 出现在"读取当前状态"的位置；提议2只核对了 HTTP 方法本身，没检查语义副作用，属漏判。 |
| `agent-channel.js` `handleCaptureRequest` 校验失败时静默 return 是否缺陷 | 提议2：MAJOR，与本文件"Never die silently"注释直接矛盾，bridge 永等；提议1：未提 | 提议2 | 代码与同文件注释逐字冲突，证据在上下文内、可直接核对，提议1漏判。 |
| `extract.fn.js` `stripTrailingMeta` 的第二判据 | 提议1：`/^[^。.!?]{0,80}$/u` 把 digitRatio 判据架空，尾部 30% 任何 ≤80 字无句末标点的短句都会被删，MAJOR；提议2：逐例试算后判 OK/撤回 | 提议1 | 提议1给了可执行反例 `node -e "/^[^。.!?]{0,80}$/u.test('这是一段没有句号的结语文字')" → true`；提议2的试算只覆盖含数字的英文句子，未检验"无标点中文短句"这一最常见输入，结论不成立。 |
| `stripChipRows` 的 `CHIP_LABEL_MAX = 12` | 提议2：MAJOR，注释自述 24 会吞 `[Go]`/`doc/2`，而 12 同样吞（这些标签仅 4–5 字符），注释自我打脸；提议1：未提 | 提议2 | 该推理可由注释与常量逐字对照证实：注释举的反例长度远小于 12，阈值从 24 降到 12 并不能保护它们。 |
| `stripPlaceholderAnchors` 的 `isBareAnchor` | 提议1：右侧分支因 `location.href` 带 query 而 startsWith 失配 → 规则漏判（MINOR）；提议2：同页 `href="https://x/p#sec"` 且 location 为 `https://x/p` 时 startsWith 成立 → 误删有效同页锚（MAJOR） | 两者并存，但均降级为 MINOR | 两个结论互不矛盾（分别是漏判与误删两个方向），各自推理都对；但该规则整体还有 `children.length > 1 continue`、`label.length ≤ 2`、剩余文本为空三重收窄，实际触发面很小，提议2的 MAJOR 定级过高。 |
| `dsh-session.js` ticket 失败回退 `enterUrl()`（key 进 URL） | 提议2：MAJOR，违反本文件注释承诺、key 泄漏到 history/Referer/日志；提议1：未提 | 提议2 | 注释"the long-lived key never enters the frame URL"与 `url: enterUrl()` 分支逐字冲突，证据在上下文内。 |
| `INTENT_PATTERN` 是否有缺陷 | 提议1：特意确认无 `g` 标志、非缺陷；提议2：`/m` 让 `^` 匹配任意行首，多行草稿中间行以「看左边」开头也会触发（MAJOR） | 提议2（降为 MINOR/待验） | 两者说的不是同一件事：`g`/`lastIndex` 确实不是问题（提议1对），但 `/m` 的行首语义问题提议1没查。误触发场景真实但需用户恰好多行输入，且"看左边"本身是刻意关键词，定级 MINOR。 |
| `applyAttach` 首次 capture 是否必然走 DOM 而非 slot | 提议2：`useSlot = state.dockMounted === true`，dock mount 是 React 异步提交，首次 attach 可能先到 → 首条 chip 走 DOM（MAJOR，后又部分自撤）；提议1：未提 | 部分采信，降为 MINOR/可疑待验 | 代码结构支持这个竞态（`dockMounted` 仅在 `useEffect` 内置真），但 plugin `apply` 早于任何 attach 到达、实际窗口极窄；且两条 host 的可观测契约（present/removable/acked）都成立，用户影响有限。 |
| `clean()` 的不可见字符白名单是否有缺口 | 提议2：漏 `\u2066-\u2069`（Bidi isolate）与 `\u2028/\u2029`（MAJOR）；提议1：未提 | 提议2（降为 MINOR） | 区间对照可直接核对，确实漏；但本项目下游是 Markdown 文件与模型输入，不是渲染信任边界，注入增益有限。 |
| blockquote 多段落是否保持单一引用块 | 提议2：空行被映射为孤立 `>`，Markdown 会断成多个 quote，与注释"stay one quote block"相反（MAJOR）；提议1：未提 | 提议2（降为 MINOR，标可疑待验） | 推理方向对（`>`/`> ` 的差异确实影响部分渲染器），但"`>` 空行会断块"依渲染器而异（CommonMark 下 `>` 空行仍属同一 blockquote），需实测才能定性。 |
| 提议2的整体方法 | 提议2输出 200 条"MAJOR-n"，其中约 150 条以"撤回/不是 bug/OK"结尾 | 不采纳其体例 | 大量条目自述为非缺陷，仍占据 MAJOR 编号，违反"按严重度排序、只报真实缺陷"的要求；其中少数有效结论已单独采信，其余噪音剔除。 |
| `panel.js` 中 `els.retry` 监听器三行是否语法错误 | 提议1：列为可疑，一句 `node --check` 可定论 | 采信其"可疑"定性，但判为非缺陷 | JS 语句以换行分隔合法：`void a()` / `void b()` / `void c()` 是三条合法表达式语句，`node --check` 会通过；格式差但不是缺陷，且属风格类，不计入清单。 |

二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `extension/src/sidepanel/panel.js#initWriteOps` | 亲验（上下文内） | "读状态"的 fetch 实际是写状态：每次面板打开都把写权限强制置 false，用户刚开的写工具被静默注销；并使任何"先置 true 再开面板"的探针顺序敏感地变绿/变红 | `body: JSON.stringify({ allowBrowserWriteOps: false })`（初始化分支，非 change 分支） |
| BLOCKER | `extension/src/sidepanel/agent-channel.js#handleCaptureRequest` | 亲验（上下文内） | 校验失败时只 `log` 后 `return`，不回 `capture-result`，bridge 与 DSH 页面半永久等待；同文件 catch 分支的注释明确承诺"必须回答 bridge" | `if (!validated.ok) { log(...); return }` 对比下方 `// Never die silently: a handler bug must still answer the bridge` |
| BLOCKER（待复核） | `dsh-plugin/src/host/index.js#onAgentConnect` | 推理（引用上下文外源码，需复核） | `drainIntents()` 已清空队列却只 `pushAgent(queued[queued.length-1])`，N-1 条意图被吞，日志仍报 `replayed N`；面板关闭期间多次「看左边」只会回来一次 | `hub.pushAgent({ ...queued[queued.length - 1], reason: 'queued' })` |
| MAJOR（待复核） | `dsh-plugin/src/host/index.js#clientFacts` / `resolveWorkspace` | 推理（引用上下文外源码，需复核） | hub 已按 socket 存 `entry.facts`，index 又维护全局单值；两个页面半各 3s 重播 hello，谁后到谁覆盖，落盘 workspace 与 `pickPrimary` 选中的半可以不一致 | `resolveWorkspace: () => clientFacts.workspace ?? resolved.defaultWorkspace` |
| MAJOR（待复核） | `dsh-plugin/src/host/hub.js` pending 队列 | 推理（引用上下文外源码，需复核） | `pickPrimary` 投递失败时 `store.enqueue(event)` 不携带 owner，`GET /ag/pending` 可被任意页面半 drain，与 `intentOwners` 精心维护的 origin 追踪自相矛盾 —— `@文件` 可进错草稿 | `delivered === 0` 分支的 `store.enqueue(event)` |
| MAJOR | `extension/src/content/extract.fn.js#stripTrailingMeta` | 亲验（上下文内，含可执行反例） | `||` 右侧 `/^[^。.!?]{0,80}$/u` 几乎恒真，把 `digitRatio > 0.15` 完全架空：文档尾部 30% 内任何 ≤80 字、无句末标点的短段都会被删，与注释"only drop when mostly numbers/labels, not prose"相反 | `if (digitRatio > 0.15 \|\| /^[^。.!?]{0,80}$/u.test(value)) el.remove()` |
| MAJOR | `extension/src/content/extract.fn.js#stripChipRows` | 亲验（注释与常量自证） | 注释举的真实反例 `[Go]`、`doc/2` 只有 4–5 字符，阈值从 24 降到 12 对它们毫无保护；3 个及以上短标签链接构成的合法列表仍被整行删除 | `const CHIP_LABEL_MAX = 12` 对照注释 `it also swallowed ... the fixture's [Go] / doc/2 items` |
| MAJOR | `extension/src/sw/dsh-session.js#ensureReady` | 亲验（上下文内） | ticket 失败（插件旧版/路由缺失）时静默回退到把长期 key 拼进 iframe URL，泄漏进浏览器历史、Referer 与访问日志，直接违反本文件注释承诺 | `return { ok: true, url: enterUrl(), state: { ..., handshake: 'key-fallback' } }` 对照注释 `the long-lived key never enters the frame URL` |
| MAJOR | `dsh-plugin/lib/client.js` 协议常量（`protocolVersion` / `CHANNEL` / `extVersion`） | 亲验（上下文内） | client 半是手写无构建产物，`protocolVersion: 1`、`'/ag/client'` 与生成物 `protocol.generated.js` 之间无任何同步机制；协议升版后 host 的 `validateAs` 会直接拒帧，「看左边」整链静默失效 | `protocolVersion: 1`（hello 与 intent 各一处）、`const CHANNEL = '/ag/client'`、`extVersion: 'client'` |
| MAJOR | `extension/src/sw/capture.js#buildCapture` + `frame-budget.js#withinFrameBudget` | 亲验（上下文内） | 截图彻底失败时写入 `base64: ''` + `dropped: true`，`sendCapture` 仍返回 `ok: true`；frame-budget 只处理"存在但过大"，空串不触发任何分支，于是 `mode:'screenshot'` 能"成功"却零像素 | `body.media = { screenshot: { ..., base64: '', dropped: true, dropReason } }` 与 `if (typeof copy.base64 === 'string')` 下只有过大分支 |
| MAJOR（待复核） | `dsh-plugin/src/host/routes/attach.js` `deliveredTo` | 推理（引用上下文外源码，需复核） | `pushClientPrimary` 只返回 0/1，`deliveredTo` 因此永远是 `[]` 或 `['client:1']`，`client:1` 不是任何真实 client id（hub 生成形如 `client:a3f1`）；任何据此判断"投给了谁"的诊断/探针拿到的是伪造事实 | `deliveredTo: delivered === 0 ? [] : [\`client:${String(delivered)}\`]` |
| MAJOR | `dsh-plugin/lib/client.js#__AG_PROBE_WRITE__`（假绿风险） | 亲验（上下文内）+ 待验（测试代码未给） | 该 hook 自行 `setDraft` 并断言 DOM，完全绕开 `applyAttach` 的 `readDraft` 三级回退、chips 记账、`ack` 与 `notifyChips`；若 M0b 断言基于它，只证明 `setDraft` 可用，不证明真实 attach 链路。真实路径钩子 `deliver` 已存在，更应被用 | `globalThis.__AG_PROBE_WRITE__ = async (marker, options = {}) => { ... shell.setDraft(marker) ... }` 对照 `deliver: (item) => applyAttach(item)` |
| MAJOR | `extension/src/sw/ops/debugger.js#detachAll` 与 `withDebugger({reuse:true})` | 推理（上下文内代码结构） | op 执行中用户关闭「浏览器控制」→ `detachAll` 清空 `attached` 并真实 detach，正在进行的 `sendCommand` 变成僵尸调用，后续命令以晦涩的 "not attached" 失败而非映射为 `E_READONLY` | `detachAll()` 的 `attached.clear()` 与 `send()` 的 `{ reuse: true }` 无互斥 |
| MINOR（待复核） | `dsh-plugin/src/host/hub.js` `ws.on('error')` | 推理（引用上下文外源码，需复核） | error 分支只 `sockets[channel].delete(entry)`，不像 close 分支那样 reject 全部 inflight；若 close 未随后触发，in-flight 调用要等到超时，违反文件头"disconnect fails every in-flight call immediately"的承诺 | `ws.on('error', () => { sockets[channel].delete(entry) })` |
| MINOR | `dsh-plugin/lib/client.js#INTENT_PATTERN` | 亲验（上下文内） | `/m` 使 `^` 匹配任意行首：多行草稿中任何一行以「看左边」开头即触发抓取，用户只想问第一行的问题时会被误抓；`g` 标志问题不存在（提议1对） | `const INTENT_PATTERN = /^\s*(看左边\|look left)/imu` |
| MINOR | `extension/src/content/extract.fn.js#clean` | 亲验（区间对照） | 漏掉 `\u2066-\u2069`（Bidi isolate）与 `\u2028/\u2029`（行/段分隔符）；注释自称"不可见字符是注入向量，一律剥离"但白名单不完整 | `.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/gu, '')` |
| MINOR | `extension/src/content/extract.fn.js#stripPlaceholderAnchors` | 亲验（上下文内） | `isBareAnchor` 右侧分支双向都错：`location.href` 带 query 时 startsWith 失配（漏判）；location 恰为链接目标时又会删掉有效同页锚（误删）。三重收窄条件使触发面很小 | `href.split('#')[0].startsWith(location.href.split('#')[0])` |
| MINOR | `extension/src/content/extract.fn.js#toMarkdown` blockquote | 推理（需渲染实测） | 空行被映射为孤立 `>`（而非 `> `），部分渲染器会把多段引用断成多个块，与注释"stay one quote block"相反；CommonMark 下未必断块，故须实测定性 | `.map((line) => (line.trim() === '' ? '>' : \`> ${line}\`))` |
| MINOR | `dsh-plugin/lib/client.js#applyAttach` 的 `useSlot` | 推理（React 提交时序） | `useSlot` 取 `state.dockMounted`（只在 `useEffect` 内置真）而非注册成功标志 `state.chipHost === 'slot'`；dock mount 前到达的 attach 走 DOM 回退，首条与后续 chip 宿主不一致 | `const useSlot = state.dockMounted === true` |
| MINOR | `dsh-plugin/lib/client.js#dismissCapture` | 亲验（上下文内） | 用户手动编辑过 `@文件` 引用后，`current.includes(entry.inserted)` 仍可能真并用 `replace` 切掉子串，把引用从中间撕开；另 `applyAttach` 对同一 `captureId` 重投不做幂等 | `shell.setDraft(current.replace(entry.inserted, '')...)` |

⚠️ [正文 12416 字符超回包预算 10000，已按行截取前 9953 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260912T062901-moa_verify-51771-dbnxor-6494364e8ed0.md（sha256=cb4d3fcc9c7e…，152643 字节，保留至 2026-09-26），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=6494364e8ed0… audit=/Users/mac/.pimoa/spool/20260912T062901-moa_verify-51771-dbnxor-6494364e8ed0.md
