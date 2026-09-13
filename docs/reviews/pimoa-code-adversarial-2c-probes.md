# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`tests/m0a/composer-probe.mjs`、`tests/m0a/cookie-ext/manifest.json`、`tests/m0a/cookie-ext/probe.js`、`tests/m0a/cookie-matrix.mjs`、`tests/m0a/ext/manifest.json`、`tests/m0a/ext/panel.js`、`tests/m0a/ext/sw.js`、`tests/m0a/keepalive-ext/manifest.json`、`tests/m0a/keepalive-ext/page.js`、`tests/m0a/keepalive-ext/sw.js`、`tests/m0a/keepalive-probe.mjs`、`tests/m0a/permission-probe.mjs`、`tests/m0b/attach-probe.mjs`、`tests/m0b/chip-probe.mjs`、`tests/m1/panel-probe.mjs`、`tests/m2/autostart-probe.mjs`、`tests/m2/capture-probe.mjs`、`tests/m2/gate-probe.mjs`、`tests/m2/look-left-e2e-probe.mjs`、`tests/m2/look-left-probe.mjs`、`tests/m2/native-headed-probe.mjs`、`tests/m2/perf-probe.mjs`、`tests/m3/agent-turn-probe.mjs`、`tests/m3/control-probe.mjs`、`tests/m3/debugger-probe.mjs`、`tests/m3/ops-probe.mjs`
- prompt：`scripts/review-prompts/code-adversarial.md`
- 用时：219.5s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:16:58.535Z

---
一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信方 | 理由 |
|---|---|---|---|
| 被审代码是否在可读范围内 | 两份提议一致：审计根是 PiMoa，`extension/`、`dsh-plugin/`、`native-host/`、`scripts/` 均不存在，唯一实物是上下文中粘贴的探针脚本 | 双方一致 | 与任务上下文一致：给出的只有 `tests/**` 探针，产品代码零行可引 |
| 8 条声称的总体裁决 | ①：逐条区分（#7 前两层判"成立"、#8 判"被证伪"，其余"证据不足"）；②：8 条一律"无法证伪且证据不足" | **①** | #8 是唯一其主体（测试代码）完整在材料内的声称，可直接举出恒真/不计分断言证伪；②把可判的也一并降级，属于过度保守 |
| `control-probe.mjs` 的 `Array.isArray(...)` 那行属于哪类缺陷 | ①：称之为"假绿/测不到东西"，同时又说它只会是 false；②：明确指出它**恒为 false**、会被 `filter(v===false)` 抓到，因此是**恒假**不是假绿 | **②** | ② 的求值链条更精确：`Array.isArray(布尔)` 恒 false，`false && …` 恒 false，该行永远进失败清单，属恒假 bug 而非假绿 |
| `chipNeverFallsBackToDom` 是否恒真 | ①：明确指出 `[].every(...) === true`，空数组时恒真；②：未提及 | **①** | 可核对：`activeChips` 为空时 `.every` 返回 true，这是真正的假绿，② 漏判 |
| 失败判定 `filter(v === false)` 的覆盖面 | ①：系统性指出 `null`/`{timedOut:true}`/字符串/数字都不计失败，是全库最承重的假绿机制；②：只在个别脚本（keepalive、composer）指出 exit 0 问题 | **①**（② 为补充） | ① 抓住了通用机制，② 给出了两处具体落地实例，二者可合并 |
| 残留策略测试的弱点定位 | ①：阈值谓词几乎未被约束（25h vs 200h 离边界太远）；②：命名谓词才是未被约束的那半（用户文件不带插件前缀，保留与实现无关） | **② 为主，① 为辅** | ② 的推理更硬：用户文件不匹配插件命名模式，所以"被保留"在正确实现下与实现逻辑无关，是弱断言；① 关于边界值的批评同时成立，两者并存 |
| `look-left-e2e-probe.mjs` 中"触发草稿是否保留"一行 | ①：未提及；②：指出布尔值被拼进了 `record()` 的 **name** 参数，结果不进 results、永不计失败 | **②** | 可核对：该行把 `${JSON.stringify(...)}` 拼进第一参数，第二参数虽是布尔但 key 每次不同，仍进 results——② 的"纯观察不裁决"结论方向正确（代码注释亦自陈"记录而非断言"） |
| `capture-probe.mjs` 的 dev-config 恢复是否原子 | ①：指出 look-left-e2e 的 `restoreDevConfig` 只写文件、不重建 dist；②：未展开 | **①** | 可核对：`capture-probe.mjs` 的 `restoreDevConfig` 写文件+重建两步都有，而 `look-left-e2e-probe.mjs` 的同名函数只有 `writeFileSync`，确为不对称 |

二、【逐条裁决】

| 级别 | 文件#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | 声称#3 `AttachRequest.trigger` 含 `'manual'` — **无法证伪但证据不足** | 亲验（反证） | 全部探针 payload 只用 `'button'`/`'look_left'`，`'manual'` 从未被任何一次 attach 发送；右键路径零覆盖 | `tests/m0b/attach-probe.mjs` `capturePayload`：`trigger: 'button'`；`tests/m2/look-left-e2e-probe.mjs`：`/^trigger: look_left$/mu` |
| BLOCKER | 全部探针#`const failed = Object.entries(results).filter(([, v]) => v === false)` — 声称#8 **被证伪** | 亲验 | 只有字面 `false` 计失败；`null`、`{timedOut:true}`、`'timeout'`、数字、对象全部静默通过，"✅ 全部通过"的分母不是断言数 | `tests/m2/look-left-probe.mjs` 末尾、`tests/m3/ops-probe.mjs` 末尾同款一行 |
| BLOCKER | `tests/m2/capture-probe.mjs#chipNeverFallsBackToDom` — 假绿 | 亲验 | `activeChips.every(...)`，空数组时 `[].every` 恒 `true`；胶囊从未生成（最坏情况）时这条守卫反而变绿 | `record('chipNeverFallsBackToDom', activeChips.every((entry) => entry.host !== 'dom'))` |
| MAJOR | 声称#7 第三层「审批」闸门 — **无法证伪但证据不足** | 亲验（反证） | 前两层有真断言（`E_READONLY`、工具集 5↔8），第三层审批在 ops/control 两份探针里零断言；`ops-probe.mjs` 第 6 节只有标题 `console.log`、下方无任何 `record` | `console.log('\n6. 写操作门禁的运行时开关（/ag/control，F2 形态…）')` 后直接进第 7 节 |
| MAJOR | 声称#1 一次抓取只投一个页面半 — **无法证伪但证据不足** | 亲验（反证） | 所有 frameEval 用 `targetInfos.find(...)` 取**首个** iframe，全程只有一个 client 半；"两半同时在线"这个被自称为常态的场景从未被构造，也无 delivery/session 基数断言 | `tests/m2/capture-probe.mjs#frameEval`：`const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(ORIGIN))` |
| MAJOR | 声称#2 一次「看左边」只触发一次抓取 — **无法证伪但证据不足** | 亲验（反证） | 断言全为单侧"至少一次"：`sniffed > 0`、`frames.length > before`、`deliveries.length >= 1`、`intent = JSON.parse(seen)[0]`；重复触发（正是该声称否认的失败模式）仍全绿 | `tests/m2/look-left-e2e-probe.mjs`：`record('客户端嗅探到意图（否则与面板无关）', sniffed > 0)` |
| MAJOR | 声称#4 审计日志元数据/有界/轮转 — **无法证伪但证据不足** | 亲验（反证） | 材料中无审计写入点、无读审计文件的探针、无大小/轮转/脱敏断言，一条都没有 | 全部 `tests/**` 中无任何 `audit` 相关 `record` |
| MAJOR | 声称#5 `scripts/check-dist-config.mjs` 门禁 — **无法证伪但证据不足**，且周边代码主动制造漂移 | 亲验 | 门禁脚本本体不在材料内、无任何探针调用它；而 5 份探针改写 `dev-config.js` 并重建 dist，其中一份的恢复路径不重建 | `tests/m2/look-left-e2e-probe.mjs`：`const restoreDevConfig = () => { try { writeFileSync(DEV_CONFIG, DEV_BACKUP) } catch { /* best effort */ } }`（无 build.mjs），对比 `capture-probe.mjs#restoreDevConfig` 含 `execFileSync(... build.mjs ...)` |
| MAJOR | `tests/m3/control-probe.mjs#面板探针同步拿到新能力集` — 恒假断言（非假绿，但零信息） | 亲验 | `Array.isArray(x.constructor === String ? … : [])` 外层包的是三元结果，整个 `&&` 左操作数求值链使该 record 无法为真；且同一表达式调用 `evaluate` 三次，非确定性 | `record('面板探针同步拿到新能力集', Array.isArray((await evaluate(...)).constructor === String ? JSON.parse(...) : []) && ...)` |
| MAJOR | 声称#6 残留策略"只删本插件命名 + 严格老于阈值" — **无法证伪但证据不足** | 亲验 | 命名谓词：用户文件不带插件命名模式，正确实现下本就不会扫到，"被保留"与实现无关；阈值谓词：25h/200h 两点离边界都远，"删所有 >1h"也通过；缺"他人前缀 + 超阈值文件不被删"这一关键反例 | `tests/m2/capture-probe.mjs`：`for (const [path, ageHours] of [[stalePath, 25], [userKeepPath, 200]])`；`record('retention', { stale25hRemoved: !existsSync(stalePath), userFileKept: existsSync(userKeepPath) })` |
| MINOR | `tests/m0b/attach-probe.mjs#pushedEvents` / `pushedEventSummary` — 假绿 | 亲验 | 前者记录数字（永不为 `false`），后者无推送时记 `null`；脚本末尾只筛 `v === false || v === 'error:'`，"推送而非轮询"这条核心契约无法变红 | `record('pushedEvents', received.length)`；`record('pushedEventSummary', received[0] === undefined ? null : {...})` |
| MINOR | `tests/m0a/composer-probe.mjs` — 探针整体可在被测物完全没起来时 exit 0 | 亲验 | `probe` 轮询失败后落回 `{ probe: null, note: 'client plugin never published __AG_PROBE__' }`，仍写报告并 `process.exit(0)`；无任何非零退出路径 | `shell: probe ?? { probe: null, note: 'client plugin never published __AG_PROBE__' }` + 末尾 `process.exit(0)` |
| MINOR | `tests/m0a/composer-probe.mjs#consoleLines` — 恒空收集器 | 亲验 | 声明后无任何 `push`，报告里永远 `[]`；注释自陈"collect console/log events through a listener registered on the socket"但未实现 | `const consoleLines = []` … `const listenerSocket = browserWs; void listenerSocket` |
| MINOR | `tests/m0a/keepalive-probe.mjs` — 扩展未加载时写出"正常"报告并 exit 0 | 亲验 | 无 `samples`/console 为空时的失败判定，最后固定 `process.exit(0)` | 末尾 `console.log(JSON.stringify({ swConsole: swLines, pageConsole: pageLines, ... }))` → `cleanup(); process.exit(0)` |
| MINOR | `tests/m2/look-left-e2e-probe.mjs#触发草稿是否保留（观察）` — 明示的非裁决项 | 亲验 | 该项把动态字符串拼进 record 名，且注释自陈"recorded, not asserted"，对回归无约束力 | `record(\`触发草稿是否保留（观察）: ${JSON.stringify(String(draftAfter).slice(0, 60))}\`, ...)` |
| MINOR | `tests/m2/capture-probe.mjs#hardeningChecks` / `selectionFileChecks` — 条件缺失时静默跳过 | 亲验 | `if (pagePath === undefined) return null`；路径取不到时整组安全断言（`javascriptUrlDropped`/`zeroWidthStripped`）记为 `null`，不计失败 | `const pagePath = typeof pagePathFromReply === 'string' && existsSync(pagePathFromReply) ? pagePathFromReply : undefined; if (pagePath === undefined) return null` |

**这些声称的证据我没能在材料里找到**（项目自称已实测、材料里只有注释/调用点）：
- `dsh-plugin/src/host/` 全部（`hub.pushClientPrimary`、`attach.js`、路由、保留策略、审批闸门、审计写入）——零行。
- `dsh-plugin/lib/client.js`（声称#2 的 episode 武装/解除逻辑本体）——零行。
- `scripts/check-dist-config.mjs`（声称#5 的门禁）——零行，且无任何探针调用。
- `extension/src/content/extract.fn.js`、`extension/src/sw/`（右键菜单注册、`trigger` 枚举、ops 实现）——零行，只有对其输出的断言。
- 审计日志的写入器与任何轮转/脱敏测试——零行。
- `AttachRequest` schema（声称#3 的全部实质）——零行。
- 「两个页面半同时在线」这一被自称为常态的场景——任何探针都未构造。
- `docs/reviews/*.json` 运行产物——探针只写不读，材料中一份也没有。

三、【最终裁决】

八条声称中，只有第 8 条「测试是真断言，不是假绿」的主体完整存在于材料内，且**被证伪**：全部探针的成败判定是 `filter(([, v]) => v === false)`，`null`、`{timedOut:true}`、字符串、数字一律不计失败，而 `chipNeverFallsBackToDom` 在空数组上恒真、`pushedEventSummary` 无推送时记 `null`、`composer-probe` 与 `keepalive-probe` 在被测物完全没起来时照样 exit 0——"✅ 全部通过"衡量的是"没有任何一项字面等于 false"，不是"每项都被验证过"。第 7 条的前两层（不注册 / 扩展侧 `E_READONLY` 复核）有可核对的真断言，可判**成立**；第三层「审批」与第 1、2、3、4、5、6 条一律判**无法证伪但证据不足**——其判定所需的被审代码（`dsh-plugin/src/host/`、`dsh-plugin/lib/client.js`、`scripts/check-dist-config.mjs`、`extension/src/sw/`）在本次可读范围内一行都不存在，且即便只看探针，这些声称所否认的失败模式（重复触发、双页面半、`manual` trigger、阈值边界、他人前缀文件）恰恰全部落在断言的盲区内。**没有一条被证据不足的声称被写成"成立"。**

最可能让用户再次踩坑的三点，按概率×影响：
1. **右键菜单抓取静默不落盘**——`'manual'` 是唯一一个从未被任何一次 attach 发送过的 trigger，而 schema 拒绝路径已被 `'telepathy'` 证明存在；若枚举漏了它，用户侧表现为"点了没反应"，而 CI 全绿。
2. **"全部通过"掩盖一切未测项**——失败分母的定义缺陷是全库最承重的假绿机制，它同时掩盖了上面第 1 点、残留策略阈值、重复触发、双页面半这四类风险。
3. **残留策略误删用户文件**——现有两点式测试（25h/200h、一个不带插件前缀的用户文件）无法区分"按命名前缀删"与"按 mtime 一刀切删"；缺的关键反例是"他人命名前缀 + 超阈值的 .md 必须保留"，一旦有人"优化"这段逻辑，丢失的是用户不可恢复的原文，而测试照绿。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=a2184a7e9e42… audit=/Users/mac/.pimoa/spool/20260912T061658-moa_verify-51771-begu62-a2184a7e9e42.md
