# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`tests/m2/autostart-probe.mjs`、`tests/m2/capture-probe.mjs`、`tests/m2/gate-probe.mjs`、`tests/m2/look-left-e2e-probe.mjs`、`tests/m2/look-left-probe.mjs`、`tests/m2/native-headed-probe.mjs`、`tests/m2/perf-probe.mjs`
- prompt：`scripts/review-prompts/code-review.md`
- 用时：297.8s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T12:37:33.599Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

两份提议都没有完成任务：P1 找对了仓库位置并给出唯一一条可核对的产品代码线索（`hub.js` 的 pong 子串匹配，行号记错但内容属实），却以预算耗尽为由拒绝任何结论；P2 完全没找到源码、把「0% 覆盖」当成事实，其唯一的产品级指控（`look-left`/`look_left` 漂移）经我亲验为误读——这两种拼写是 `reason` 与 `trigger` 两个字段的合法枚举（`protocol.generated.js:814` 与 `:886` 并存）。但 P2 对任务所给的 6 个探针脚本做了扎实的内证分析，其中 G6 读 `build-size.json`、CDP 9233 冲突、workspace 共享三条完全成立。综合后最重的问题不在产品接线，而在**门禁本身**：`capture/gate/autostart/native-headed` 四个探针结尾一律 `process.exit(0)` 且从不计算失败集，`chipNeverFallsBackToDom` 用 `[].every()` 恒真，`hardeningChecks` 失败时返回 `null` 而非 `false`——「已验证」的自我评价建立在一组**结构上不可能变红**的脚本之上。产品侧我确证的两处是 `agent-channel.js:96` 把 reason 当 trigger 传（使 capture-request 的第二个消费者与 `attach.js:65` 的 `=== 'look_left'` 判定错位，进而抢会话并写错 front-matter，而 `panel.js:310` 的另一个消费者是对的）与 `hub.js:73` 的心跳子串误吞。**只能修 3 处就修**：① 给 `capture/gate/autostart` 三个探针加 `failed` 计算与非零退出，并把 `every()`/`null` 这类空断言改成显式存在性断言；② `agent-channel.js:96` 统一走与 `panel.js` 相同的 reason→trigger 归一化（并在 `attach.js` 侧对未知 trigger 显式拒绝而非静默降级为 `new`）；③ `hub.js:73` 改为解析后 `frame.type === 'pong'`。**未覆盖声明**：我只读到 `hub.js:73` 一行与上述 `rg` 命中行，`dsh-plugin/lib/client.js`、`src/host/routes/*` 全文、`src/sw/*` 全文、`native-host/*`、`protocol/` 源、`tests/unit/*`（含 `client-attach.test.mjs`）、`build.mjs`、`package.json` 门禁脚本**一律未读**；因此 A 类中「两个 DSH 页面半是否双投递」、B 类中「`__AG_CLIENT__`/`__AG_PANEL__` 钩子是否为测试专用分支」、C 类中「`dev-config` 在生产构建里的 fallback」三个核心疑点仍为【可疑待验】，本轮不做结论。

## 一、【冲突点与采信】

| # | 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|---|
| 1 | 被审源码是否可达 | P1：在 `/Users/mac/ai_tools/dsh project/网页插件`（含 extension/、dsh-plugin/、native-host/），可读；P2：不在可读范围，覆盖率 0% | **P1** | 我亲验：`ls /Users/mac/ai_tools` 存在 `dsh project/`，且对 `dsh-plugin/src/host/hub.js`、`extension/src/**` 的 `rg` 成功返回带行号命中。P2 的「不可达」结论是它自己检索路径找错，不是事实 |
| 2 | `hub.js` 的 pong 判定 | P1：`text.includes('"pong"')` 是子串匹配，会误吞含该字面量的合法帧；P2 未提 | **P1（修正行号）** | 亲验 `hub.js:73: if (text.includes('"pong"')) return`；P1 写的 `:82` 是错的行号，内容属实。严重度采信 P1 的保守区间而非它情绪化的上限 |
| 3 | `look-left` vs `look_left` 是否拼写漂移缺陷 | P2：这是最高可能性的 BLOCKER 级漂移，「修 3 处」第一条；P1 未提 | **两方都不成立，按我亲验改判** | 亲验：两种拼写是**两个不同字段的两套枚举**——`capture-request.reason='look-left'`（`host/index.js:181`）与 attach 的 `trigger='look_left'`（`routes/attach.js:65`），`protocol.generated.js` 里两者并存（`:814` 连字符、`:886` 下划线）。P2 的「一端漏转就全断」是误读。但**存在一处更窄的真缺陷**：`agent-channel.js:96` 把 `reason`（连字符域）直接当 `trigger` 传给 `runCapture`，见裁决表第 2 行 |
| 4 | perf-probe 的 G6 体积断言 | P2：读外部 `build-size.json`、字段缺失即 0KB→✅，是假绿通道；P1 未提 | **P2** | 证据就在任务给的源码里：`const totalKb = size.totalBytes === undefined ? size.totalKb ?? null : ...`，随后 `totalKb !== null && totalKb <= 1024 ? '✅'`，无任何 sanity check |
| 5 | 探针间端口/工作区污染 | P2：`gate` 与 `look-left-e2e` 同占 CDP 9233、`capture` 与 `look-left-e2e` 同占 `.devhome/workspace-m0a` 与 3099；P1 未提 | **P2**（其文中「9333」为笔误，实为 9233） | 常量逐字可核：`gate-probe` `argOf('cdp-port','9233')`、`look-left-e2e-probe` `argOf('cdp-port','9233')` |
| 6 | `record('触发草稿是否保留（观察）', …)` 是否被计入失败 | P2：`failed` 只筛 `=== false`，所以观察项不会致败 | **不采信 P2** | 该 record 的值就是布尔 `String(draftAfter).includes('看左边')`，为 `false` 时**恰好**落进 `filter(([, v]) => v === false)`，即注释声明的「观察项」实际是硬失败项——与 P2 结论相反，且这本身是一条缺陷 |
| 7 | 是否给出「只修 3 处」 | P1：拒绝给出；P2：给出 | **P2 的做法** | 输出规范强制要求该结论；在已亲验证据足以支撑时拒答不可取。但 P2 的三条内容需按上表第 3 条改写 |
| 8 | 两方一致的关键判断 | P1、P2 都承认对 `dsh-plugin/lib/client.js`、`src/sw/*`、`native-host/*`、`tests/unit/*` 零覆盖 | **一致，予以保留** | 我同样未读到这些文件，见文末覆盖声明 |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `tests/m2/capture-probe.mjs`#尾部 / `gate-probe.mjs`#尾部 / `autostart-probe.mjs`#finally | 亲验（任务所给源码） | 这三个探针**从不计算失败集、结尾无条件 `process.exit(0)`**——所有 `record()` 只写 JSON，`npm run probe:capture/gate/autostart` 在门禁里恒为绿灯，等于 M2 抓取/闸门/自启三条主链路无自动化守卫 | `cleanup()` 紧跟 `process.exit(0)`；对比 `look-left-probe.mjs` 的 `process.exitCode = failed.length === 0 ? 0 : 1` |
| BLOCKER | `tests/m2/capture-probe.mjs`#chipNeverFallsBackToDom | 亲验 | `activeChips.every(...)` 对**空数组恒真**，而上方轮询在超时后 `activeChips` 就是 `[]`——「胶囊永不回落 DOM」这条唯一硬断言在胶囊根本没出现时也绿；同理 `hardeningChecks` 在路径缺失时 `return null`（`null !== false`）亦不致败 | `record('chipNeverFallsBackToDom', activeChips.every((entry) => entry.host !== 'dom'))` |
| MAJOR | `extension/src/sidepanel/agent-channel.js:96`#capture-request 消费者 | 亲验行号 + 推理后果 | `runCapture(request.mode, request.reason ?? 'look-left')` 把 **reason 域的连字符值**当 trigger 传下去，而落盘侧判的是 `payload.trigger === 'look_left'`（`routes/attach.js:65`）→ 该路径会退化成 `sessionMode='new'`（抢会话），且 front-matter 写出 `trigger: look-left`，与 `look-left-e2e-probe` 的 `/^trigger: look_left$/` 断言相反；`panel.js:310` 的另一条消费者却写死 `runCapture(mode ?? 'page', 'look_left')`——**同一帧有两个消费者、归一化只做了一半** | `agent-channel.js:96 const result = await runCapture(request.mode, request.reason ?? 'look-left')` vs `panel.js:310 const result = await runCapture(mode ?? 'page', 'look_left')` |
| MAJOR | `dsh-plugin/src/host/hub.js:73`#心跳过滤 | 亲验行号 | 用**原始文本子串**而非解析后 `frame.type === 'pong'` 判心跳：任何 payload 含字面量 `"pong"` 的合法帧（抓取正文/工具参数均为用户可控）在 `JSON.parse` 前就被 `return` 静默丢弃，连日志都不留，状态机可卡死 | `if (text.includes('"pong"')) return` |
| MAJOR | `tests/m2/perf-probe.mjs`#G6 | 亲验 | 体积指标不自量而读外部 `build-size.json`，字段缺失/为 0 时判定 `0 KB → ✅`；无 `throw if missing` | `results.g6BundleKb = totalKb` … `totalKb !== null && totalKb <= 1024 ? '✅' : '❌'` |
| MAJOR | `tests/m2/perf-probe.mjs`#measureCapture | 亲验 | 每轮开头的 `Target.activateTarget({ targetId: targetInfos.find((t) => t.sessionId === undefined)?.targetId ?? '' })` 用「没有 sessionId」当选择器，命中的是任意目标（甚至 `''`）并 `.catch(() => {})` 吞掉——G2 耗时可能量的是**非夹具标签**，数字不可信却被写进验收报告 | 同行 `?.targetId ?? ''` + `.catch(() => {})` |
| MAJOR | `tests/m2/*`#dev-config 改写 | 亲验 + 推理 | 三个探针把**探针端口 + 真实配对密钥**写进 `extension/src/lib/dev-config.js` 后 `build.mjs` 打进 `extension/dist`，恢复只挂在 `finally` / `process.on('exit')`——SIGINT 或崩溃不触发，`dist` 即残留测试端口与密钥；这正是「测试常量烤进发布产物」 | `writeFileSync(DEV_CONFIG, \`export const DEV_CONFIG = { port: ${DSH_PORT}, key: '${devKey}' }\`)` |
| MAJOR | `tests/m2/gate-probe.mjs` ↔ `look-left-e2e-probe.mjs`#CDP_PORT | 亲验 | 两者默认 CDP 同为 `9233`，且 `gate-probe` 开头 `if (await portBusy(CDP_PORT)) throw` → 串行/并行批跑必有一个直接抛死；`capture-probe` 与 `look-left-e2e` 又共用 `3099` + `.devhome/workspace-m0a`，后者的 `before = new Set(readdirSync(captureDir))` 与前者的 `retention.stale25hRemoved` 会互相污染 | `argOf('cdp-port', '9233')` 各一处 |
| MAJOR | `tests/m2/autostart-probe.mjs`#nativeHostReply | 亲验 | 探针先自己 `chrome.runtime.connectNative('com.dsh.web_companion')` 证明 Chrome→host 接线，随后只看 `status-dot` 的 `dataset.state === 'up'`；**没有任何断言把「面板显示 up」与「DSH 真在该端口监听」绑定**（`dshListeningAfter`/`pingAfter` 只被 record 不被判），因此「service worker 会自启」这一核心命题未被证明 | `if (status?.state === 'up') break` 之后仅 `record('dshListeningAfter', …)` |
| MINOR | `tests/m2/look-left-e2e-probe.mjs`#观察项 | 亲验 | 注释明说「记录，不断言」，但 `record(label, String(draftAfter).includes('看左边'))` 的 `false` 会被 `failed` 筛出并使 `process.exitCode = 1` —— 声明的契约与实际判定相反（假红，且会诱使后人把期望改成实现值） | `const failed = Object.entries(results).filter(([, v]) => v === false)` |
| MINOR | `tests/m2/perf-probe.mjs`#percentiles / G1 | 亲验 | `at(0.95)` 在 n≤7 时等于 max；且 G1 只跑 `run < 3` 而报告头部宣称「每项 RUNS=7 次」，`p50/p95` 是 3 个样本的记述统计，仍被拿去对齐 `p50 ≤ 1500ms` 目标 | `for (let run = 0; run < 3; run += 1)` 与 `runs: RUNS` 同时写进报告 |
| MINOR | `tests/m2/perf-probe.mjs`#measureShot | 亲验 | `else if (parsed.code === null) results[...Error] = parsed` —— 内层返回对象里根本没有 `code` 字段，`undefined === null` 为假，截图失败永远不会被记录，只表现为样本数变少 | `else if (parsed.code === null) results[\`shot${String(fullPage)}Error\`] = parsed` |
| MINOR | `tests/m2/gate-probe.mjs`#TARGET_URL | 亲验 | 默认打 `https://example.com`（真公网）。离线/沙箱下页面加载失败，`#gate` 仍可能因「拿不到 tab URL」路径显示，断言测的不再是「无 host 权限时的内联闸门」 | `argOf('url', 'https://example.com')` |
| MINOR | `tests/m2/native-headed-probe.mjs` | 亲验 | 全程零断言、零报告、`process.exit(0)`，仅 `console.log('有头 Chrome connectNative:', …)`；它无法区分「功能坏」与「测试夹具跑不动」，而文件头声称的目的正是区分这两者 | 文件末 `console.log('有头 Chrome connectNative:', result.result.result.value)` |
| MINOR | `tests/m2/capture-probe.mjs`#未使用变量 | 亲验 | `const attachDir = …; void attachDir` 之后又立即使用 `attachDir`，说明此处经历过「读最新文件→改读回复 filePath」的返工，两套路径仍并存（`latest` 兜底可能指向别的探针写的文件） | `void attachDir` 紧邻 `const files = readdirSync(attachDir)` |

## 三、【最终裁决】

两份提议都没有完成任务：P1 找对了仓库位置并给出唯一一条可核对的产品代码线索（`hub.js` 的 pong 子串匹配，行号记错但内容属实），却以预算耗尽为由拒绝任何结论；P2 完全没找到源码、把「0% 覆盖」当成事实，其唯一的产品级指控（`look-left`/`look_left` 漂移）经我亲验为误读——这两种拼写是 `reason` 与 `trigger` 两个字段的合法枚举（`protocol.generated.js:814` 与 `:886` 并存）。但 P2 对任务所给的 6 个探针脚本做了扎实的内证分析，其中 G6 读 `build-size.json`、CDP 9233 冲突、workspace 共享三条完全成立。综合后最重的问题不在产品接线，而在**门禁本身**：`capture/gate/autostart/native-headed` 四个探针结尾一律 `process.exit(0)` 且从不计算失败集，`chipNeverFallsBackToDom` 用 `[].every()` 恒真，`hardeningChecks` 失败时返回 `null` 而非 `false`——「已验证」的自我评价建立在一组**结构上不可能变红**的脚本之上。产品侧我确证的两处是 `agent-channel.js:96` 把 reason 当 trigger 传（使 capture-request 的第二个消费者与 `attach.js:65` 的 `=== 'look_left'` 判定错位，进而抢会话并写错 front-matter，而 `panel.js:310` 的另一个消费者是对的）与 `hub.js:73` 的心跳子串误吞。**只能修 3 处就修**：① 给 `capture/gate/autostart` 三个探针加 `failed` 计算与非零退出，并把 `every()`/`null` 这类空断言改成显式存在性断言；② `agent-channel.js:96` 统一走与 `panel.js` 相同的 reason→trigger 归一化（并在 `attach.js` 侧对未知 trigger 显式拒绝而非静默降级为 `new`）；③ `hub.js:73` 改为解析后 `frame.type === 'pong'`。**未覆盖声明**：我只读到 `hub.js:73` 一行与上述 `rg` 命中行，`dsh-plugin/lib/client.js`、`src/host/routes/*` 全文、`src/sw/*` 全文、`native-host/*`、`protocol/` 源、`tests/unit/*`（含 `client-attach.test.mjs`）、`build.mjs`、`package.json` 门禁脚本**一律未读**；因此 A 类中「两个 DSH 页面半是否双投递」、B 类中「`__AG_CLIENT__`/`__AG_PANEL__` 钩子是否为测试专用分支」、C 类中「`dev-config` 在生产构建里的 fallback」三个核心疑点仍为【可疑待验】，本轮不做结论。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=70a1bc969d68… audit=/Users/mac/.pimoa/spool/20260912T123733-moa_verify-51771-5snbkf-70a1bc969d68.md
