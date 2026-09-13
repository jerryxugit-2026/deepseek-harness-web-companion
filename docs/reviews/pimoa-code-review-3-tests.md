# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`tests/protocol/contract.test.mjs`、`tests/quality/audit-captures.mjs`、`tests/quality/probe-sites.mjs`、`tests/unit/agent-selection.test.mjs`、`tests/unit/audit-fields.test.mjs`、`tests/unit/audit-log.test.mjs`、`tests/unit/browser-tools.test.mjs`、`tests/unit/capture-routing.test.mjs`、`tests/unit/client-attach.test.mjs`、`tests/unit/frame-budget.test.mjs`、`tests/unit/menu-trigger.test.mjs`、`tests/unit/op-debugger-optin.test.mjs`、`tests/unit/panel-errors.test.mjs`、`tests/unit/retention.test.mjs`、`tests/unit/rotate.test.mjs`、`tests/unit/tickets.test.mjs`、`tests/unit/write-gate.test.mjs`
- prompt：`scripts/review-prompts/code-review.md`
- 用时：293.5s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:33:55.328Z

---
## 一、【冲突点与采信】

| # | 分歧点 | 提议 1 主张 | 提议 2 主张 | 采信 | 理由（证据） |
|---|---|---|---|---|---|
| 1 | 目标仓库能否取证 | 找不到目标仓库，只能审测试文本 | 同样声称预算耗尽、只审测试文本 | **两者都不采信** | 仓库就在 `/Users/mac/ai_tools/dsh project/网页插件/`（含 `extension/ dsh-plugin/ native-host/ protocol/ tests/`）。两份提议都把"找不到"当成结论前提，因此凡涉及实现的判断都需重验 |
| 2 | `agent-selection.test.mjs §2` 是否假绿 | 【MAJOR 可疑】若 pong 只刷时间戳、不改 Set 顺序，测试对旧 `[0]` 实现也会绿 | 未提此点，另提"并发未测" | **驳回提议 1（部分采纳其方法论）** | 亲验 `hub.js:249-250`：候选按 `lastSeen` 降序 + `suspectAt` 后置；`hub.js:291-305` 是逐 socket 重试。测试里 mute 刚回 pong ⇒ mute 被**首选**、超时后重试 answering 才拿到结果 —— 断言只有在"排序+重试"都在时才绿，是真钉子。唯一成立的弱点：它钉的是现行规则，钉不住最初的裸 `[0]` 版本（那版靠插入序也会碰巧通过） |
| 3 | `client.js` 的 `hello.embedded` 字段是否可能缺失/拼错（导致 attach 投错页面半） | 未提 | 【MAJOR 已确认】声称无任何测试覆盖真实 hello，字段可能叫 `isEmbedded` | **驳回提议 2** | 亲验 `lib/client.js:146` `embedded = window.self !== window.top`（catch ⇒ true）、`:163` `embedded: facts.embedded`；`hub.js:87` 读 `typeof frame.embedded === 'boolean'`。生产者/消费者名称与类型完全对齐，非缺陷 |
| 4 | client-attach 测试用 `window.self/top` 桩是否"可能误判实现" | 【MINOR-MAJOR】若实现查 `window.frameElement` 则该桩会错误标绿 | 未提 | **提议 1 的担忧不成立** | 实现确实用 `self !== top`（`client.js:146`），桩与实现一致 |
| 5 | `client-attach.test.mjs` 是否漏测"socket 入站 attach → deliver"这一真实链路 | 【MAJOR】是：只直接调 `deliver()`，WebSocket 桩从不投递入站帧 | 只提 `dockMounted` 绕过 DOM 分支 | **采信提议 1** | 测试里 `globalThis.WebSocket` 的 `send` 仅入 `sentFrames`，全文无任何把 `{type:'attach'}` 喂给监听器的代码 —— 入站分发是唯一用户路径却无覆盖（此项我未读到 client.js 的 message handler，保留为可疑待验） |
| 6 | `audit-captures.mjs` 的"中文站点 regex 失效"是否 BLOCKER | 未提 | 【BLOCKER】称让质量门禁"永远绿" | **降级为 MINOR** | 该脚本**没有任何 pass/fail 断言**：只 `console.log` 统计，唯一非零退出是"找不到文件 → exit 2"。它是报告工具，不是门禁，因此谈不上"假绿"；regex 只覆盖英文文案确实限制其召回，属能力局限 |
| 7 | `probe-sites.mjs` 的 `record()` 会把 `timedOut/error` 算成通过 | 未提 | 【MAJOR】是 | **驳回提议 2** | 该文件所有 `record` 传入的都是比较表达式（`captured?.ok === true && body !== ''`、`missing.length === 0`、`leaked.length === 0`、`extra.ok`），全为布尔；`·` 分支在此文件不可达 |
| 8 | `browser-tools.test.mjs` 末行逗号表达式是空断言 | 未提 | 【MAJOR】是 | **降级/驳回** | `makeHub.callAgent` 在查桩之前先 `calls.push(request)`，故 `browser_tabs` 那次调用一定进了 `calls`，`every(c => c.allowWrite !== true)` 不是恒真空断言 |
| 9 | `probe-sites.mjs` 的 macOS/Chrome 硬编码 | 【MINOR-MAJOR】与头注释"可以进 CI"矛盾 | 【MAJOR】同 | **采信（MINOR）** | `CHROME='/Applications/...'` + `/usr/bin/env bash` + `--headless=new` 确实只能本机跑；但文件头已声明"前置：dev 实例在跑"，属定位说明不一致，不是功能缺陷 |
| 10 | 两份提议都**未发现**的三处实证问题 | — | — | **本裁决新增** | `hub.js:73` 的 `text.includes('"pong"')` 全帧丢弃；`probe-sites.mjs` 把真实配对 key 写入受版本管理的 `extension/src/lib/dev-config.js` 并重建 dist；`hub.js:63` 两条通道共用 `client:` 前缀 id |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 一句理由 | 行号 / 原文 |
|---|---|---|---|---|
| MAJOR | `dsh-plugin/src/host/hub.js#attach(channel).ws.on('message')` | 亲验 | 心跳快路径用**整帧子串**判定 pong，任何正文里含 `"pong"` 的帧（如 `tool-result` 里的 markdown/AX 名称）会在 `JSON.parse` 与 `settle()` 之前被整条丢弃 ⇒ 相关调用只能以 `E_TIMEOUT` 收场，且日志里连帧都看不到 | `hub.js:73` `if (text.includes('"pong"')) return` |
| MAJOR | `tests/quality/probe-sites.mjs#DEV_CONFIG 重写` | 亲验（测试源码） | 探针把 `.devhome` 配对密钥与端口 3099 写进**受版本管理的源文件**再 `build.mjs` 烤进 `extension/dist`；只在 `process.on('exit')` 里 best-effort 还原 —— 被 SIGKILL / 崩溃即把测试密钥留在源码与产物里（正是"测试密钥进发布产物"这一类） | `writeFileSync(DEV_CONFIG, \`export const DEV_CONFIG = { port: ${DSH_PORT}, key: ${JSON.stringify(key)} }\`)` + `execFileSync(... extension/build.mjs)` |
| MAJOR【可疑待验】 | `tests/unit/client-attach.test.mjs#WebSocket 桩` | 推理（未读 client.js 的 message 分发） | 测试只直调导出的 `deliver()`，WebSocket 桩的 `send` 仅记帧、从不注入入站 `{type:'attach'}`；真实用户路径（socket onmessage → 字段解包 → deliver）无任何覆盖，若 hub 推的字段名与 client 读的不一致，两侧单测仍全绿 | 桩体 `send(data) { sentFrames.push(data) }`；全文无入站投递 |
| MAJOR【可疑待验】 | `extension/src/sw/ops/index.js#opClick/opType/opNavigate` | 推理（未读 ops 源码） | `op-debugger-optin.test.mjs` 只对 `opScreenshot/opAx` 断言"关关时不 attach"；三个写 op 若也走 `chrome.debugger`，默认同样会弹不可消除的调试横幅，与 ADR-12/T8 冲突且无测试 | 测试仅 `import { opAx, opScreenshot }` |
| MAJOR【可疑待验】 | `dsh-plugin/src/host/routes/attach.js#audit.append 返回值` | 推理（未读该路由） | `audit-log.test.mjs` 钉住"写失败返回 false 并自禁用"，但无任何测试证明调用方**接住**这个 false；若路由忽略返回值，审计在磁盘退化路径上静默消失 | `record('返回 false（调用方知道没记上）', ok === false)` |
| MINOR | `dsh-plugin/src/host/hub.js#attach.entry.id` | 亲验 | `attach(channel)` 对 client/agent 两条通道共用写死的 `client:` 前缀，而 `callAgent` 失败日志正是打 `entry.id` ⇒ agent 侧故障日志显示 `client:xxxx`，排查直接指错方向；16 bit 随机也偏窄 | `hub.js:63` `id: \`client:${Math.random().toString(16).slice(2, 6)}\`` |
| MINOR | `dsh-plugin/src/host/hub.js#pickPrimary` 平分裂序 | 亲验 | 分数相同时按 `connectedAt` **降序**（最近连接优先），而文件头注释写的是"再否则按 focused → visible → 最近连接"，语义一致但 `capture-routing.test.mjs` §2 的"默认胜者=secondId"同时被 `embedded` 和"最近连接"两条规则满足 ⇒ 该断言无法区分两者，规则退化时不会红 | `hub.js:165` `(score(b)-score(a)) || ((b.connectedAt ?? 0)-(a.connectedAt ?? 0))` |
| MINOR | `tests/quality/probe-sites.mjs#cleanup` | 亲验 | panel target 从不关闭、`/tmp/dshwc-sites-profile` 与 `dshwc-sites-ext` 不清理；`cleanup()` 既注册在 `exit` 又在末尾显式调用 ⇒ 重复 `server.close()/kill` | `process.on('exit', cleanup)` … 末尾 `cleanup()` |
| MINOR | 跨文件常量 `retentionHours: 24` / 截断 120 / `timeoutMs` | 亲验（测试侧） | `retention.test.mjs`、`browser-tools.test.mjs`、`audit-fields.test.mjs` 各自写死 24 / 120，未从实现 import 常量；同一语义四处并存，改一处漏三处 | `record('截断到 120 字符', long.domain.length === 120)`；`sweepCaptures(dir, { retentionHours: 24, now })` |
| MINOR | `tests/quality/audit-captures.mjs#PATTERNS` | 亲验 | 噪音规则把当时的英文 UI 文案（Knowledge/Overview/Read more/Downloads）烤进 regex，中文站命中恒 0；因该脚本无断言、不参与门禁，仅是召回局限而非假绿 | `readMore: /\bread more\b/giu` |
| MINOR | `tests/quality/probe-sites.mjs#CHROME / WORKSPACE 默认值` | 亲验 | `/Applications/Google Chrome.app/...`、`bash -c`、`.devhome/workspace-m0a` 写死，与文件头"因此可以进 CI"自相矛盾（实际仅 macOS 本机可跑） | `const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'` |
| — 驳回 | `agent-selection.test.mjs §2 假绿` | 亲验 | `hub.js:249-250` 排序 + `:291-305` 跨 socket 重试使该断言只在正确实现下为真 | `.sort((a,b)=>(b.lastSeen??0)-(a.lastSeen??0)).sort(... suspectAt ...)` |
| — 驳回 | `hello.embedded 字段可能缺失/拼错` | 亲验 | 三端字段名与类型一致 | `client.js:163` `embedded: facts.embedded` ↔ `hub.js:87` |
| — 驳回 | `probe-sites record() 把 timedOut 算通过` | 亲验 | 该文件所有 record 实参均为布尔比较式 | `record(..., missing.length === 0)` |
| — 驳回 | `browser-tools 末行是空断言` | 亲验 | `calls.push` 先于桩查找，calls 非空 | `callAgent: async (request) => { calls.push(request); const answer = answers[request.tool]` |

## 三、【最终裁决】

两份提议的共同前提——"找不到被审仓库"——是错的：代码就在 `/Users/mac/ai_tools/dsh project/网页插件/`，因此它们对实现的判断基本都是悬空推测，其中两条最响的"已确认"（`agent-selection §2` 假绿、`hello.embedded` 字段不对齐）经亲验**被证伪**：`hub.js:249-250` 的双重排序加 `:291-305` 的跨 socket 重试让那条回归钉子真的钉得住；`client.js:146/163` 与 `hub.js:87` 的 `embedded` 字段名、类型三端一致。提议 2 的大量 BLOCKER（audit-captures 中文失效、probe record 吞错、逗号表达式空断言）在代码面前都站不住，属于"按篇幅堆结论"；提议 1 唯一有价值的独立发现是 client-attach 测试未走入站 socket 分发这条真实路径。真正值得修的三处，两份提议都没看到，全部来自本轮亲验：**① `hub.js:73` 用 `text.includes('"pong"')` 判心跳，会把正文含该子串的 `tool-result` 整帧丢进黑洞（表现为无法复现的 E_TIMEOUT）；② `probe-sites.mjs` 把真实配对密钥与端口 3099 写进受版本管理的 `dev-config.js` 并立刻重建 dist，仅靠 `exit` 钩子还原，是"测试密钥进发布产物"的现成路径；③ 补一条把 `hub.pushClientPrimary` 产出的真实 attach 帧经 socket 喂进 `lib/client.js` 的端到端接线测试**——当前 host 侧与 client 侧各测一半、中间字段契约无人验证，正是这套"绿灯"最大的结构性空洞。覆盖声明：本轮只亲验了 `dsh-plugin/src/host/hub.js`（第 1-100、152-226、238-323 行）与 `lib/client.js` 中 `embedded` 相关 6 行；`extension/src/**`、`native-host/**`、`protocol/`、`src/host/tools.js|retention.js|approval.js|routes/*`、`ops/index.js` 未读，涉及它们的条目已如实标注【可疑待验】。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=029c07795db7… audit=/Users/mac/.pimoa/spool/20260912T063355-moa_verify-51771-1pevgo-029c07795db7.md
