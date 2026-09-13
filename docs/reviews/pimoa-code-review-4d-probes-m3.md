# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`tests/m3/agent-turn-probe.mjs`、`tests/m3/control-probe.mjs`、`tests/m3/debugger-probe.mjs`、`tests/m3/ops-probe.mjs`
- prompt：`scripts/review-prompts/code-review.md`
- 用时：188.3s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T12:40:42.238Z

---
## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| 被审对象是否在当前仓库 | 两方一致：不在。cwd 为 `/Users/mac/ai_tools/PiMoa`（`"name": "pi-moa"`），无 `extension/`、`dsh-plugin/`、`native-host/`、`tests/m3/`、`.devhome/` | 一致采信 | 这是本次唯一的【已确认】环境事实，双方独立取证一致 |
| 缺席后是否还应输出代码级发现 | 提议A：可对贴出的四段文本做纯静态审查并给出结论；提议B：一律不给，任何结论都是凭空构造 | **采信 A 的方向，但收紧范围** | 四个探针文件的**逐字全文已在任务上下文中给出**，对「断言是否恒真/恒假、清理是否可靠、端口是否写死」这类**自洽性**问题，无需外部实现即可判定；B 的拒答只对「帧有没有 handler」「白盒钩子是否等价真实路径」这类跨模块问题成立 |
| `control-probe.mjs` 那条 `Array.isArray(...)` 断言的性质 | 提议A：三元恒走前支 → `Array.isArray(String)` → **恒为 false**，是「假红/假绿双面陷阱」 | **两方都不对，按我的重解** | 三元在 `Array.isArray(...)` **内部**：真支 `JSON.parse(...)` 返回数组 → true，假支 `[]` → 也 true。故该合取项 **恒为真（空断言）**，而非恒假。A 的解析方向错了，但它指出的「这行有硬伤」成立 |
| 该断言所在文件 | 提议A 标为 `agent-turn-probe.mjs:224-227` | **不采信** | 该行逐字出现在 `control-probe.mjs`（`record('面板探针同步拿到新能力集', …)`），`agent-turn-probe.mjs` 中无此片段；A 的文件与行号均不可核 |
| `ops-probe.mjs` 「导航后标题更新」是否假绿 | 提议A：对实现常量写死 → 恒真 | **部分不采信（降级）** | `String(navigated.value?.title ?? '')` 在 navigate 失败/无 title 时为 `''` → false，并非恒真；真实弱点是只校验工具回包字段、未回查页面，属弱断言而非空断言 |
| `debugger-probe.mjs` 生命周期断言 | 提议A：断言写法正确，仅前置不稳定 | 采信 | 该条 `during === before+1 && after === before` 是真实增量断言，注释也明说绝对值不可用，不构成假绿 |
| 探针间互相污染 / dev-config 覆写 | A 明确列出并给证据；B 未展开（仅把端口列为「原本要查」） | 采信 A | `agent-turn-probe.mjs` 与 `control-probe.mjs` 逐字包含同一段 `writeFileSync(DEV_CONFIG, …)` + `process.on('exit', cleanup)`，可直接核对 |

---

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| **BLOCKER** | 会话环境#审计根 | 亲验 | 被审对象（extension / dsh-plugin / native-host）在可读范围内 0 命中，所有跨模块接线与假绿结论无法达到【已确认】级别 | `package.json`：`"name": "pi-moa" … "M0 skeleton: pi SDK + local CLIProxy streaming smoke"`；仓库无 `tests/m3/` |
| **BLOCKER** | `agent-turn-probe.mjs` / `control-probe.mjs`#build 调用 | 亲验（贴出文本） | 扩展构建失败被静默吞掉，探针会拿**上一次的 `extension/dist`** 继续跑并报绿——典型 B 类假绿，改坏扩展也可能全绿 | `try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }` |
| **BLOCKER** | `debugger-probe.mjs`#record('无需用户手势即可 attach…') | 亲验 | 断言值写死为字面量 `true`，不执行任何探测，永远绿——纯装饰性断言 | `record('无需用户手势即可 attach（不依赖 permissions.request）', true)` |
| **MAJOR** | `control-probe.mjs`#record('面板探针同步拿到新能力集') | 亲验 | 首个合取项 `Array.isArray(三元)` 两支都返回数组 → 恒真（空断言）；同一表达式被 `evaluate` 三次（三次 CDP 往返，状态可能漂移）；`evaluate` 超时返回对象时 `JSON.parse` 会抛未捕获异常直接终止探针 | `Array.isArray((await evaluate('JSON.stringify(globalThis.__AG_PANEL__?.capabilities ?? [])')).constructor === String ? JSON.parse(…) : []) && (JSON.parse(…)).includes('browser_type')` |
| **MAJOR** | `agent-turn-probe.mjs` + `control-probe.mjs`#DEV_CONFIG 覆写/还原 | 亲验 | 两个探针写同一个受版本管理的源文件 `extension/src/lib/dev-config.js`，备份只存内存，仅靠 `process.on('exit')` 还原——SIGINT/SIGTERM/崩溃不触发，且 catch 吞错；并发或先后跑会互相覆盖，最坏把**配对 key 与测试端口留在源码里进而烤进发布产物**（C 类：测试常量污染产物） | `writeFileSync(DEV_CONFIG, \`export const DEV_CONFIG = { port: ${DSH_PORT}, key: ${JSON.stringify(key)} }…\`)` + `const restore = () => { try { … } catch { /* best effort */ } }` |
| **MAJOR** | `agent-turn-probe.mjs`#record('扩展侧 agent 通道已连接') ×2 | 亲验 | 同一语义被记录两次：第 1 节在面板刚打开时立刻判定（退避重连尚未完成，大概率 false），第 1b 节才带重试；结果是即便链路正常，报告也会恒带一个失败项 → 失败计数与退出码不可信（假红） | `record('扩展侧 agent 通道已连接', String(panelState).includes('"agentConnected":true'))` 与其后 `record('扩展侧 agent 通道已连接（工具调用的前提）', agentConnected)` |
| **MAJOR** | `agent-turn-probe.mjs`#delivery / `results` 判定 | 亲验 | `inDsh` 的错误分支返回 `{error:…}`/`{timedOut:true}` 对象，而 `record('用户消息已进入会话', …)` 与后续处理对其直接 `JSON.parse`，超时即抛异常终止；同时 `failed` 只统计 `=== false`，非布尔记录一律不计失败 | `Array.isArray(typeof delivery === 'string' ? JSON.parse(delivery) : delivery) && (…).some((a) => a.ok === true)`；`Object.entries(results).filter(([, value]) => value === false)` |
| **MAJOR** | 四探针#端口/路径常量 | 亲验 | CDP 9241/9243/9244/9247、fixture 3992/3995/3996、DSH 3099、`/Applications/Google Chrome.app/…`、`/tmp/dshwc-*` 各写一份，无占用检测与互斥；同机并行必抢端口/profile，且 Chrome 路径写死使非 macOS/非默认安装直接失败 | `const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`；`const CDP_PORT = Number(argOf('cdp-port', '9247'))` 等四处不同默认值 |
| **MAJOR** | `ops-probe.mjs`#第 6 节 | 亲验 | 标题为「写操作门禁的运行时开关（/ag/control，F2 形态）」，其下**没有任何 record**，只打印一行 header——读报告的人会以为该项已验 | `console.log('\n6. 写操作门禁的运行时开关（/ag/control，F2 形态：key + 扩展 Origin）')` 后直接跟第 7 节 |
| **MINOR** | `ops-probe.mjs`#record('关闭开关返回释放情况') | 亲验 | 仅断言回包字符串里出现 `browserControl` 这个**键名**，既不校验值也不回查 debugger 是否真已 detach；把「有字段」当成「已释放」 | `record('关闭开关返回释放情况', typeof disable === 'string' && disable.includes('browserControl'))` |
| **MINOR** | `ops-probe.mjs`#record('导航后标题更新') | 亲验 | 只校验工具回包里的 `title` 字段，未用 fixture 会话回查真实 `document.title`；不是恒真（失败时为 `''`），但无法区分「真的导航了」与「回包字段拼对了」 | `record('导航后标题更新', String(navigated.value?.title ?? '').includes('第二页'))` |
| **MINOR** | `control-probe.mjs`#enabled 表达式 | 亲验 | `const target = box.checked === true ? box : box` 两支相同，是废三元；说明作者原意（区分已勾选/未勾选）没落地，勾选态下 change 事件可能不触发状态变化 | `const target = box.checked === true ? box : box` |
| **MINOR** | `control-probe.mjs`#record('初始为只读（5 个工具）') | 亲验 | 把工具数量 `5`/`8` 这一业务常量写死在断言里，与插件注册表无单一真源，工具增减即全线变红（C 类漂移） | `before.length === 5 && !before.includes('browser_click')` / `afterOn.length === 8` |
| **【可疑待验】** | 全部 A 类接线问题 | 不可验 | `/ag/client` vs `/ag/agent` 帧的生产者/消费者、`tool-call` 帧字段、`__AG_PANEL__.frames`/`lastOp`/`writeOps` 是白盒钩子还是真实路径、`__AG_CLIENT__.trySend()` 与用户在输入框发送是否等价、两个 DSH 页面半是否只落一次 attach——均需 `extension/src/sw/`、`dsh-plugin/src/host/`、`lib/client.js`，本会话读不到 | 见提议双方一致的缺席清单 |

---

## 三、【最终裁决】

本次审查的**主结论是取证前提不成立**：任务描述的三交付物（`extension/`、`dsh-plugin/`、`native-host/`）与 `tests/m3/` 均不在可读审计根内（cwd 为 `pi-moa`，M0 骨架项目），因此**任何跨模块接线结论（A 类）都只能是【可疑待验】**，两份提议在这一点上的共识可靠，应予采纳；提议B 就此止步是诚实的，但过度保守——四个探针的**逐字全文已随任务给出**，其自洽性缺陷无需外部实现即可判定，故采纳提议A 的静态审查路线。但提议A 的两处关键断言必须纠正：那条 `Array.isArray(…)` 断言在 **`control-probe.mjs`** 而非 `agent-turn-probe.mjs`，且它是**恒真的空断言**而非提议A 所称的「恒为 false」；`ops-probe.mjs` 的标题断言也**不是**恒真，只是弱断言。剔除这两处误判后，仍有三条可直接坐实的严重缺陷：**构建失败被静默吞掉导致探针可能在陈旧 `extension/dist` 上报绿**、**`record(..., true)` 的字面量假断言**、**两个探针覆写受版本管理的 `dev-config.js` 且还原不可靠（会把测试端口与配对 key 留进源码/产物）**。若只能修三处，即修这三处；其余（重复记录导致的假红、第 6 节空章节、端口与工具数量硬编码）列为次轮。注意：本裁决**未覆盖**扩展 SW 消息路由、host 端 `/ag/*` 路由与 schema 校验、`lib/client.js` 客户端半、native-host、`npm run check` 的 19 条反模式规则与 `tests/unit/*.mjs`——这些文件一行都未读到；探针也**未实际运行**，全部代码级结论均为静态推理，行号以逐字片段替代（文件不在仓库，无法给出可核对的仓库行号）。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=27192c99e300… audit=/Users/mac/.pimoa/spool/20260912T124042-moa_verify-51771-nuqec6-27192c99e300.md
