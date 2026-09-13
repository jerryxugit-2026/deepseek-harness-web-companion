# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`bootstrap/lib/wizard.mjs`、`bootstrap/lib/checks.mjs`、`bootstrap/lib/probe.mjs`、`bootstrap/lib/health.mjs`、`tests/unit/preflight-checks.test.mjs`、`tests/unit/install-health.test.mjs`、`tests/unit/wizard-interaction.test.mjs`
- prompt：`scripts/review-prompts/wizard-3-interaction.md`
- 用时：341.8s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T05:46:07.809Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

本片代码的自我叙述（"实测过""不许假绿也不许假红"）**部分属实但不可全信**：作者确实修掉了几处真缺陷（`secret()` 的 `pause`→`resume`、`askLine` 的 EOF 竞态、`renderChecks` 的下标假红、`finishBanner` 区分"没查"与"没过"），这些是真本事，应予肯定；但同一批注释也掩盖了两处同级甚至更重的问题——**`secret()` 只认构造时的 `interactive`、不认 `inputClosed`，EOF 后必然永久僵死**（正是它宣称最痛恨的失败形态，而单测的假 TTY 替身在结构上无法复现），以及 **`distOk === null` 被标 `soft` 后，收尾横幅逐字宣称"产物端口一致"，而该项从未被检查**，并被单测 `overallOk(noScript) === true` 钉死为期望值。判定层还有两处成体系的"探测失败＝通过"：`checkDshCli` 在 `dsh -V` 读不出版本时直接报 ✅，`portListening` 把 lsof 缺失/受限一律归为"端口空闲"；再叠加 `pingPlugin` 不查 `res.ok`、不校验 `plugin`，"DSH 在本机 N 端口应答"这条硬判据实际只能证明"某个 HTTP 服务回了一段 JSON"。另需驳回两份提议中的若干臆断：`checkNode('')` 实为 `missing` 非 `ok`、`extension-proxy` 并非恒红（协议暴露的正是 `connectedClients`，缺的是 `agentClients`）、`dirStatus` 不会死循环、`/System` 复现例不成立、码点遍历不破坏多字节——这些若被当真，会把审查引向不存在的缺陷。**若只能修 3 处**：① `secret()` 入口加 `|| inputClosed` 守卫并对 `setRawMode` 包 try（消灭僵死，一行半）；② `dist-port` 改 `soft:false`、`detail` 写明"未检查（缺 scripts/check-dist-config.mjs）"，并同步翻转那条被钉死的单测（让横幅不再说没验过的话）；③ `checkDshCli` 增加"路径在但版本读不出 ⇒ warn"分支，同时把 `portListening` 改成三态（`true/false/null`，`null` 时 `checkPort` 报 warn 而非"空闲"）——两者是同一类"探测失败当通过"，改动都在十行以内。

## 一、【冲突点与采信】

> 取证前提（两份提议一致、我复核认可）：`bootstrap/**` 与 `tests/unit/**` 不在本会话审计根内，双方结论均基于 prompt 内嵌源码。故下文以**符号名 + 逐字片段**定位，不伪造行号。

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `checkDirectory` 把 `status:'missing'` 映射成 `'ok'` 的严重度 | 提议1：BLOCKER（配合单测固化）；提议2：MAJOR（"没真写文件验证"） | **降级为 MINOR** | 两方都漏看了 `dirStatus` 在"不存在"分支**已经对最近的已存在祖先做了 `accessSync(W_OK)`**，不可写时返回 `'unwritable'` ⇒ `checkDirectory` 判 `missing`（阻断）。所以"不存在⇒ok"不是无验证的假绿，只剩 root/磁盘满/根级边界这类窄口子 |
| 提议1 的 `/System` 复现例（"权限位 755 ⇒ `accessSync(W_OK)` 对普通用户可能通过"） | 提议1 断言可复现 | **驳回** | 755 且属主为 root，非属主写位为 0，`access(W_OK)` 必失败 ⇒ 返回 `'unwritable'`。该复现例不成立，不能作为证据 |
| `dirStatus` 的 `while (at !== dirname(at))` 是否会在容器里死循环（提议2） | 提议2：隐患/死循环 | **驳回** | `dirname` 单调收敛到 `'/'`，`dirname('/')==='/'` ⇒ 必然终止。但复核中发现**另一个真问题**：路径形如 `/newtop/sub` 时循环在 `'/'` 处直接跳出，`return 'missing'` **未检查根是否可写** ⇒ 该窄路径确有假绿（已并入逐条裁决） |
| `extension-proxy` 是否"恒红死代码"（提议2 A-10：`/ag/ping` 不发 `connectedClients`） | 提议2：MAJOR 恒红；提议1：软判据设计正确 | **采信提议1，驳回提议2** | 提议2 误读了 health.mjs 注释——注释原文是 `只有 connectedClients: () => hub.clientCount`，缺的是 `agentClients`。`connectedClients` **是**暴露的，该判据不恒红 |
| `checkNode({nodeVersion:''}).status === 'ok'`（提议2 A-5） | 提议2：假绿 | **驳回** | `/^v?(\d+)/u.exec('')` 为 `null` ⇒ `?.[1] ?? NaN` ⇒ `Number.isInteger(NaN)===false` ⇒ 实际是 `missing`。提议2 的可执行例子会直接反证它自己 |
| `secret()` 按码点遍历破坏多字节（提议2 B-4） | 提议2：MINOR 缺陷 | **驳回主体** | `for (const ch of chunk.toString('utf8'))` 迭代的是**完整码点**不是字节；只剩"退格 `buf.slice(0,-1)` 切断代理对"这一无关紧要的残余，API key 为 ASCII，不构成缺陷 |
| `dshCliPath` 非空但 `dsh -V` 读不出版本 ⇒ 直接 `status:'ok'` | 仅提议1（A1）提出；提议2 未覆盖 | **采信提议1** | 代码可直证：两个前置 `if` 都不命中 ⇒ 落到末尾 `status:'ok'`。这是本片最纯粹的"探测失败＝通过" |
| `pingPlugin` 不查 `res.ok` / 不校验 `plugin` 字段 | 提议1 强调 `res.ok`；提议2 强调 `plugin` 未被任何判定消费 | **两者都采信、合并** | 二者是同一个洞的两半：任何在该端口回 JSON 的服务都能让 `dsh-up` 变 ✅；`plugin` 已被 probe 取出却无人校验 |
| `distOk === null` 标 `soft` 的定性 | 提议1：BLOCKER（唯一确定性扩展判据被跳过）；提议2：MAJOR（fix 文案误导） | **采信提议1的定性，取 MAJOR** | 决定性证据是提议1指出的横幅原文：`✅ 装好了，硬判据全过（DSH 应答 / 已配对 / 产物端口一致）`——**"产物端口一致"根本没验过**，这是横幅在说谎，比抽象的 soft/hard 之争更硬 |
| `targetDshVersion` 未传 ⇒ `@undefined` 的严重度（提议2 A-2） | 提议2：MAJOR，"可能装到错误版本" | **降级 MINOR** | `npm install -g @deepseek-ai/dsh@undefined` 会以 `No matching version` **响亮失败**，不会静默装错版本；缺入参校验属实但后果是可见报错 |
| `secret()` 在 EOF 之后的行为 | 提议1：`setRawMode` 可能抛（可疑待验） | **采信方向、并强化为"必挂"** | 更硬的证据不是抛：stdin 已 `end`，`stdin.once('end', onEnd)` **永不再触发**、也不会再有 `data` ⇒ 该 Promise **永不 settle**，正是文件注释自己宣称杜绝的"不是报错，是僵住" |
| 单测未断言注入的 `ping` 真被调用（提议2 D-4） | 提议2：MAJOR | **采纳，降 MINOR** | 若注入被忽略会回落真实 `probePing`，通常返回 `reachable:false` 而变红；只有开发机恰好有 DSH 跑在 3080 时才假绿——真实但窄 |
| 一致处（无分歧） | `portListening` 的 `catch ⇒ false`、`pause()` 非交互返回 false 导致第 11 步复检不跑、单测把"缺脚本⇒总判定通过"钉成期望、3080 在测试里写死 | **双方一致，全部采信** | 其中 `pause` 一条有 health.mjs 注释自证；单测一条有逐字断言 `overallOk(noScript) === true` 自证 |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `wizard.mjs#secret` | 亲验（读码推演） | 只看构造时捕获的 `interactive`、不看 `inputClosed`；EOF 后 `'end'` 已发过，重新 `once('end')` 永不触发且无后续 `data` ⇒ **Promise 永不 settle**，安装器在"贴 API key"这一步永久僵死 | `if (!interactive) { … return '' }` … `stdin.once('end', onEnd)` |
| BLOCKER | `health.mjs#finishBanner` + `evaluateHealth` | 亲验 | `distOk===null ⇒ soft:true` ⇒ `overallOk` 不计它 ⇒ 横幅逐字打印"产物端口一致"，而该项从未被检查；缺 `scripts/check-dist-config.mjs` 恰恰意味着产物不全 | `' ✅ 装好了，硬判据全过（DSH 应答 / 已配对 / 产物端口一致）'` 与 `soft: distOk === null` |
| MAJOR | `checks.mjs#checkDshCli` | 亲验 | `dshCliPath` 非空且 `dshVersion` 非字符串（`dsh -V` 失败／PATH 上是同名程序）时，两个前置分支都不命中 ⇒ 末尾 `status:'ok'`，**连"这是不是 DSH"都没验就报 ✅**；单测只覆盖了 `dshCliPath:null` | 末尾 `return { …, status: 'ok', detail: \`${dshCliPath}${typeof dshVersion === 'string' ? …}\` }` |
| MAJOR | `probe.mjs#portListening` → `checks.mjs#checkPort` | 亲验 | `catch { return false }` 把"lsof 不存在／无权限／被沙箱拦"与"确实没人在听"合并 ⇒ `checkPort` 走末行 `status:'ok', detail:'空闲'`，探测失败被渲染成绿 | `catch { return false // lsof 无输出时退出码非零 ⇒ 没人在听 }` |
| MAJOR | `probe.mjs#pingPlugin` → `health.mjs#evaluateHealth('dsh-up')` | 亲验 | 从不检查 `res.ok`，也从不校验 `body.plugin`；任何在该端口回 JSON 的服务（含 404 JSON）都让 `reachable:true` ⇒ 硬判据"DSH 在本机 N 端口应答"变 ✅ | `const res = await fetch(url, …); const body = await res.json(); return { reachable: true, … }` |
| MAJOR | `wizard.mjs#pause` → 第 11 步复检（编排在片 1） | 推理（health.mjs 注释自证） | 非交互时 `pause()` 立刻返回 false，用户硬约束第 5 条的"复检所有依赖/扩展健康"在 `--apply --yes` 下**完全不执行**；本轮只把横幅文案改准确，控制流未修——复检是只读的，不该由 `pause` 把关 | 注释：`非交互时 w.pause() 直接返回 false ⇒ **第 11 步复检根本没跑**` |
| MAJOR | `tests/unit/install-health.test.mjs` 第 7 节 | 亲验 | 把"缺产物脚本 ⇒ 总判定通过"钉成期望值，任何人要修上面那条 BLOCKER 必须先删测试——典型的"为绿灯把期望改成实现当前值" | `record('此时总判定仍只看另外两条硬判据 → 通过', overallOk(noScript) === true)` |
| MAJOR（可疑待验） | `tests/unit/wizard-interaction.test.mjs#fakeOut` / `fakeTty` | 亲验（替身事实）＋待 pty 验证后果 | `fakeOut` 的 `isTTY:false` 使 readline 的 terminal 模式关闭、`fakeTty.setRawMode` 是恒成功空函数；于是"★ stdout 里没有明文 key"与 EOF 相关异常在替身下**结构性不可复现**。真 TTY 上 `rl` 仍挂在同一 stdin 且未 pause，其 terminal 回显是否把 key 打上屏，必须用真 pty 验 | `function fakeOut() { return { isTTY: false, … } }`；`stdin.setRawMode = () => stdin` |
| MINOR | `checks.mjs#checkDirectory` + `probe.mjs#dirStatus` | 亲验 | 主路径有祖先可写性校验（故非 BLOCKER），但 `/newtop/sub` 这类路径循环在 `'/'` 处跳出并 `return 'missing'`，**未检查根可写性** ⇒ 判 ✅；另 `accessSync(W_OK)` 对 root 恒真、不覆盖磁盘满 | `while (at !== dirname(at)) { … } return 'missing'` |
| MINOR | `checks.mjs#checkDshCli` | 亲验 | 无 `targetDshVersion` 入参校验，`String(undefined)` 会生成 `@deepseek-ai/dsh@undefined` 的 fix 文案与 command；后果是 npm 响亮报错而非静默装错 | `command: ['npm', ['install','-g', \`@deepseek-ai/dsh@${String(targetDshVersion)}\`]]` |
| MINOR | `checks.mjs#renderChecks` + `summarize` | 亲验 | 未知 `status` 在渲染端 `?? '  '` 变成两个空格（整行"隐身"），在 `summarize` 里既不算 blocker 也不算 warning ⇒ `ok:true`；新增 check 拼错枚举即静默假绿 | `icon[c.status] ?? '  '`；`checks.filter((c) => c.status === 'missing')` |
| MINOR | `health.mjs#evaluateHealth('dist-port')` | 亲验 | `fix` 不区分"未检查"与"真不一致"，两种都劝用户 `node <installDir>/extension/build.mjs`；缺脚本的场景下该文件多半也不存在 | `fix: distOk === true ? null : \`重跑构建：node ${installDir}/extension/build.mjs\`` |
| MINOR | `wizard.mjs#ask` | 亲验（后果待片 1 验） | `assumeYes` 且 `fallback === undefined` 时返回 `undefined`，若调用方直接 `join()`/`startsWith()` 即 TypeError；单测未覆盖该组合 | `if (assumeYes) { write(…\`${String(fallback ?? '')}\`…); return fallback }` |
| MINOR | `wizard.mjs#autoDeclined` | 亲验（本片内零消费） | 只自增、唯一读取方是单测；"非交互 `--apply` 未给 `--yes` ⇒ 全部按否 ⇒ 一个文件没动"这件事没有任何收尾文案承载，若此前已有 DSH 在跑，横幅仍会绿 | `get autoDeclined() { return autoDeclined }` |
| MINOR | `tests/unit/install-health.test.mjs` | 亲验 | `a === true === false` 实为 `(a===true)===false`，对 `undefined`／字段缺失同样通过——断言的是"不等于 true"，不是"等于 false" | `byId(down, 'dsh-up').ok === true === false` |
| MINOR | `tests/unit/install-health.test.mjs` 第 7 节 | 亲验 | 未断言注入的 `ping`/`spawn` 真被调用；一旦注入点回归，测试会静默落到真实 `probePing` 上，开发机恰有 DSH 跑在 3080 时即假绿 | `const fakePing = async () => ({ reachable: true, paired: true, connectedClients: 2 })` |
| MINOR | `tests/unit/*.test.mjs` 端口常量 | 亲验 | `3080` 在两份单测里逐字写死，未从 `layout.mjs` 导入（对比 `MIN_NODE_MAJOR` 是导入的）⇒ 改默认端口不会让任何测试变红 | `checkPort({ port: 3080, … })`、`FACTS_OK = { port: 3080, … }` |
| MINOR | `tests/unit/preflight-checks.test.mjs` 第 6 节 | 亲验 | `lines.length >= 3` 与 `lines[0].startsWith('✅')` 分别是弱断言与顺序耦合断言（后者依赖调用方传入顺序）；同节的 `some(startsWith)` 已是作者自己修过的正确写法 | `record('渲染出至少每项一行', lines.length >= 3)` |

**未覆盖（明确列出）**：片 1 `install.mjs` 的编排（`pause()`/`confirm()` 返回值如何被消费、每个 `installable` 项是否真的逐项 `confirm`、`--apply` 下是否真的不写盘、`autoDeclined` 是否被打印）；片 2 的路径/接线（`installDir`/`dshHome` 来源、`checkChrome.installed` 与 `checkMount.exists/entryPath` 的探测实现、`manifestDir` 可写性）；`/ag/ping` 真实协议与 `hub.clientCount` 语义（只能引注释，未见 `dsh-plugin/src/host/index.js`）；`scripts/check-dist-config.mjs` 本身；真 TTY 行为（raw mode、Ctrl-C、粘贴、readline 回显）；未执行任何测试或命令，全部结论由源码逐字推演得出。

## 三、【最终裁决】

本片代码的自我叙述（"实测过""不许假绿也不许假红"）**部分属实但不可全信**：作者确实修掉了几处真缺陷（`secret()` 的 `pause`→`resume`、`askLine` 的 EOF 竞态、`renderChecks` 的下标假红、`finishBanner` 区分"没查"与"没过"），这些是真本事，应予肯定；但同一批注释也掩盖了两处同级甚至更重的问题——**`secret()` 只认构造时的 `interactive`、不认 `inputClosed`，EOF 后必然永久僵死**（正是它宣称最痛恨的失败形态，而单测的假 TTY 替身在结构上无法复现），以及 **`distOk === null` 被标 `soft` 后，收尾横幅逐字宣称"产物端口一致"，而该项从未被检查**，并被单测 `overallOk(noScript) === true` 钉死为期望值。判定层还有两处成体系的"探测失败＝通过"：`checkDshCli` 在 `dsh -V` 读不出版本时直接报 ✅，`portListening` 把 lsof 缺失/受限一律归为"端口空闲"；再叠加 `pingPlugin` 不查 `res.ok`、不校验 `plugin`，"DSH 在本机 N 端口应答"这条硬判据实际只能证明"某个 HTTP 服务回了一段 JSON"。另需驳回两份提议中的若干臆断：`checkNode('')` 实为 `missing` 非 `ok`、`extension-proxy` 并非恒红（协议暴露的正是 `connectedClients`，缺的是 `agentClients`）、`dirStatus` 不会死循环、`/System` 复现例不成立、码点遍历不破坏多字节——这些若被当真，会把审查引向不存在的缺陷。**若只能修 3 处**：① `secret()` 入口加 `|| inputClosed` 守卫并对 `setRawMode` 包 try（消灭僵死，一行半）；② `dist-port` 改 `soft:false`、`detail` 写明"未检查（缺 scripts/check-dist-config.mjs）"，并同步翻转那条被钉死的单测（让横幅不再说没验过的话）；③ `checkDshCli` 增加"路径在但版本读不出 ⇒ warn"分支，同时把 `portListening` 改成三态（`true/false/null`，`null` 时 `checkPort` 报 warn 而非"空闲"）——两者是同一类"探测失败当通过"，改动都在十行以内。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=fb38a503b10b… audit=/Users/mac/.pimoa/spool/20260913T054607-moa_verify-51771-3c9z0i-fb38a503b10b.md
