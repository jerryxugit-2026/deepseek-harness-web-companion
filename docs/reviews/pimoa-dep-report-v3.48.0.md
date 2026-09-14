# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`bootstrap/install.mjs`、`bootstrap/lib/checks.mjs`、`bootstrap/lib/probe.mjs`、`bootstrap/lib/dsh-root.mjs`、`tests/unit/install-behavior.test.mjs`、`tests/unit/preflight-checks.test.mjs`、`README.md`
- prompt：`/tmp/pimoa-3480-prompt.md`
- 用时：333.0s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-14T02:06:09.278Z

---
## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| 被审仓库位置 | A（index=2）称"不在 cwd、无法定位，行号全为估算"；B（index=1）定位到 `/Users/mac/ai_tools/dsh project/网页插件/` 并核对行号 | **B** | 我亲验：`rg -n … '/Users/mac/ai_tools/dsh project/网页插件/bootstrap/install.mjs'` 命中，行号与 prompt 文本一致。A 的"行号 ±10"免责声明不必要 |
| 是否存在 BLOCKER | A：无 BLOCKER；B：B1 = 第 4 步 esbuild symlink 复用算写盘，列 BLOCKER | **A** | 该路径只建符号链接复用**本机已有**的 esbuild，不联网、不安装；且受 `w.confirm()` 把关、dry-run 有打印。违反的只是 README 措辞边界 ⇒ 文案级 MINOR，不是 BLOCKER |
| `depBlockers` 与 `verdict.blockers` 的先后 | A（M-6）：顺序颠倒，应把 depBlockers 提前；B：门禁位置正确 | **B（对前提）+ A（对后果）** | 亲验 `install.mjs:430` 门禁在 `:436` 逃生口**之前**，A 的前提错；但 A 顺带推出的真缺口成立：`depBlockers=0` 而 `install-dir` 不可写 + `--yes` ⇒ 跳过逃生口 ⇒ `:445 mkdirSync` 抛 EACCES ⇒ `die(3)`，退出码语义错。保留为 MAJOR，理由改写 |
| 测试第 5 节 `every(l => l === 'prefix -g')` | A（m-7）：已用 `every`，撤回；B（M4）：`calls` 为空时 `every` 对空数组恒 `true`，空集假绿 | **B** | `[].every(...) === true` 是语言事实；`npm-calls.log` 不存在时 `calls=''`、`filter` 后为空数组 ⇒ 断言恒绿，探测根本没发生也算通过 |
| `--dsh` 指错路径的行为 | A 未提；B（M1）：候选不过滤 `exists`，`dshPath = candidates[0]` 短路，PATH 上真 DSH 被丢弃 | **B** | `probe.mjs findDshCandidates` 中 `--dsh` 分支 `push` 无 `exists` 过滤，而 `install.mjs:271` 只取 `[0]`；注释宣称"候选全部打印"但计划区只打印 `用 ${dshPath}` |
| `npm prefix -g` 弄脏 `$HOME/.npm` 的严重度 | A：MAJOR；B：未列 | **折中 → MINOR** | 已用惰性探测（`:260-269`）限制为"所有来源都没找到"时才触发，且是 npm 自身副作用；测试注释已承认。不构成"下载/安装依赖" |
| `checkPluginDeps` 里 `where` 三元的 null 分支 | A（m-6）：死代码；B 未提 | **A** | `checks.mjs` 中 `if (dshRoot === null) return {…missing…}` 先于 `const where = dshRoot === null ? '你的 DSH 安装目录' : dshRoot`，null 支不可达 |
| 是否过度设计 | A：CLI parser 可换 `node:util.parseArgs`；B：`inPlace` 是安全前提不可删 | **两者均采纳（不冲突）** | 二者指向不同对象，均成立 |

**各方一致的关键判断（我亲验确认）**：目标 1、2、3 已达成 —— `install.mjs` 三处 `run()` 全是 `process.execPath` 跑本包脚本，唯一 `execFileSync` 是只读的 `npm prefix -g`（`:267`），`:344` 的 `npm install` 只作为**字符串**进 `command` 字段；依赖门禁 `:430-433 die(2)` 位于 `step(1)`（`:444`）之前且**不接受**"仍要继续"，三种模式全被拦。

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 行号/片段 |
|---|---|---|---|---|
| BLOCKER | — | 亲验 | 无 BLOCKER：无任何下载/安装路径，门禁位于首次写盘之前 | `install.mjs:430` `if (depBlockers.length > 0) { … die(2) }` vs `:444 step(1,…)` |
| MAJOR | `bootstrap/lib/probe.mjs#findDshCandidates` | 亲验 | `--dsh` 候选不校验 `exists` 且被无条件置首，`dshPath=candidates[0]` 短路，PATH 上可用的 DSH 被丢弃且**候选列表从未打印**（与注释"候选全部打印"不符） | `install.mjs:271 const dshPath = dshCandidates.length > 0 ? dshCandidates[0].path : null`；判据：`node bootstrap/install.mjs --dsh /tmp/nope`（PATH 上有真 dsh）⇒ 只报"你点名的路径不存在" |
| MAJOR | `tests/unit/install-behavior.test.mjs#第5节` | 亲验（语言语义）+推理 | ①假 npm 只挡"经 PATH 的 npm 名"，改成 `spawnSync(process.execPath,[npm-cli.js,'install'])` 或 `fetch` tarball，5 条断言仍全绿；②`calls` 为空时 `every` 恒 true，探测没发生也算通过 | `every((l) => l.trim() === 'prefix -g')`；判据：删掉 `:260-269` 整段惰性探测 ⇒ 该断言仍绿 |
| MAJOR | `bootstrap/install.mjs#verdict 逃生口` | 亲验 | `depBlockers=0` 但 `install-dir/dsh-home` 不可写 + `--yes` ⇒ `:436` 条件因 `!ASSUME_YES` 为假而跳过 ⇒ `:445 mkdirSync` 抛 EACCES ⇒ `uncaughtException` `die(3)`，而应为"前置条件不满足"的 2 | `:436 if (verdict.blockers.length > 0 && !ASSUME_YES)`；判据：`--apply --yes --install-dir /System/x` ⇒ 观察 exit 3 |
| MINOR | `bootstrap/install.mjs#step4 esbuild 复用` | 亲验 | 复用本机 esbuild 时 `rmSync+mkdirSync+symlinkSync` 是真写盘（非下载），README「不下载、不安装任何东西」未点明此例外 | `:521-526`（`symlinkSync(esbuildReady, join(esbuildTarget,'esbuild'),'dir')`） |
| MINOR | `bootstrap/install.mjs#esbuild command` | 亲验 | 报告里的 `--prefix` 指向**尚不存在**的安装目录，而 `esbuildRange` 实际取自包内 package.json；`fix` 与 `command` 内容重复 | `:344 command: \`npm install --prefix "${join(layout.installDir,'extension')}" esbuild@${esbuildRange}\`` |
| MINOR | `bootstrap/install.mjs#probeDsh` | 亲验 | `npm prefix -g` 会创建 `$HOME/.npm`（引导程序弄脏用户 HOME）；已惰性化，但测试没把它钉住 | `:267`；建议测试第 4 节加 `existsSync(join(home,'.npm')) === false`（或显式豁免并注明） |
| MINOR | `bootstrap/lib/checks.mjs#checkPluginDeps` | 亲验 | 死代码：`dshRoot === null` 已在上方 return，`const where = dshRoot === null ? … : dshRoot` 的 null 支不可达 | `const where = dshRoot === null ? '你的 DSH 安装目录' : dshRoot` |
| MINOR | `bootstrap/lib/checks.mjs#summarize/STATUS_ICON` | 推理 | `known` 从 `STATUS_ICON` 派生 ⇒ 将来只加图标不加判定分支的状态会"合法但无人判定"，护栏失效；应显式枚举 `{ok,warn,missing}` | `const known = new Set(Object.keys(STATUS_ICON))` |
| MINOR | `bootstrap/lib/checks.mjs#checkDshCli` | 推理 | 源码 checkout（本轮改动的起因）与"同名别的程序"被混成同一条 warn，`fix` 未含 README 那句"源码树不能直接跑，需先装依赖" | `detail: \`${dshCliPath} 在，但 \\\`dsh -V\\\` 读不出版本 —— 可能不是真的 DSH\`` |
| MINOR | `tests/unit/preflight-checks.test.mjs#第3节` | 亲验 | `checkPort({listening:null})` 的 warn 分支（片 3 的核心修复）**零断言**，退回 `return false` 不会变红 | 第 3 节只有 reuse/stolen/free 三例；补 `checkPort({listening:null}).status==='warn'` |
| MINOR | `tests/unit/preflight-checks.test.mjs#ping.js 一致性` | 亲验 | `idIn(pingSrc,…) === null ||` 使断言在 ping.js 无字面量时退化为恒真——弱断言（非假绿，但咬合力为零） | `record('ping 路由若自带字面量…', idIn(pingSrc,…) === null \|\| … === bootstrapId)` |
| MINOR | `tests/unit/install-behavior.test.mjs#第1/2节` | 亲验 | `r.code === 0 \|\| r.code === 2` 削弱"dry-run 必 exit 0"；"进程真的跑起来了"重复 5 处；"隔离 HOME 里没有留下任何东西"实际只查 `.dsh`，名不副实 | `record('退出码 0 或 2 …')` |
| MINOR | `bootstrap/lib/probe.mjs#which` | 亲验 | `\`command -v ${cmd}\`` 把参数拼进 shell 串；当前唯一调用是常量 `'dsh'`，无注入面，但应改 `['-c','command -v "$1"','sh',cmd]` | `execFileSync('/bin/sh', ['-c', \`command -v ${cmd}\`, …])` |
| MINOR | `bootstrap/lib/checks.mjs#checkDirectory` | 亲验 | `ok ? 'ok' : missing ? 'ok' : 'missing'` 等价于 `status==='unwritable' ? 'missing' : 'ok'`——伪分类 | 同行 |
| MINOR | `bootstrap/install.mjs#flag/argOf` | 推理 | 自写 CLI parser 不支持 `--install-dir=foo`、布尔大小写敏感；`node:util.parseArgs` 是 stdlib | `:96-100` 一带 |
| 已核实为误报 | `install.mjs#依赖门禁顺序颠倒`（A-M6 原主张） | 亲验 | `:430` 在 `:436` 之前，depBlockers 确实先拦；原主张前提不成立（真问题另见上表 MAJOR 条） | `:430` vs `:436` |
| 已核实为误报 | 第 4 步 symlink / 第 2 步 cpSync / native host / 配对与凭据写入 = "装依赖" | 亲验 | 这些是部署动作或复用本机已有物，不涉下载/安装第三方包 | `:461-471`、`:599-613` |
| 已核实为误报 | `requestedDshVersion` 死字段 | 亲验 | `:113` 读、`:272` 参与 `targetDshVersion`，并以参数注入 `checkDshCli`，无第二真源 | `:272 const targetDshVersion = requestedDshVersion ?? installedDshVersion ?? '0.1.5-rc.2'` |
| 已核实为误报 | `portListening` 三态 / `pingPlugin` 身份校验 / `checkPluginDeps` 无 DSH 不报绿 / 未知 status 当阻断 / `preserved` 被消费 / `spawnFailed` 区分 | 亲验 | 六处片 3/A/B 的修复均已落地且自洽，非缺陷 | `probe.mjs` 的 `if (error?.status === 1) return false; return null`；`isOurs = res.ok && body?.ok && body?.plugin === PLUGIN_ID` |
| 未核实 | `native-host-install.mjs` / `extension/build.mjs` / `layout.mjs` / `wizard.mjs` / `health.mjs` / `profile-patch.mjs` / `credentials.mjs` / `doctor.mjs` / `uninstall.mjs` | — | 取证预算耗尽，未读实现；"不下载/不联网"约束在这些被调用文件内**未验证**，尤以第 6 步 `build.mjs`（`:576`）与第 7 步 `applyNativeHostInstall`（`:612`）为关键缺口 | `:576 run(process.execPath, [join(layout.installDir,'extension','build.mjs')])` |

## 三、【最终裁决】

本轮"依赖层改为只报告、不代装"的**主目标已经达成，无 BLOCKER**：`install.mjs` 内不存在任何下载或安装第三方包的执行路径（三处 `run()` 全是 `node` 跑本包脚本，唯一的 `execFileSync` 是只读的 `npm prefix -g`，`npm install` 仅以字符串形式进入报告），依赖门禁 `:430` 确实位于第一次写盘（`:444/:445`）之前、`die(2)` 同步退出、且在 `--yes` / 非交互 / 交互三种模式下都无逃生口；片 3/A/B 修掉的六处假绿（端口三态、ping 身份校验、无 DSH 不报绿、点名路径不存在不说"在"、未知 status 当阻断、`preserved` 死接线）均已落地并自洽。剩余问题集中在三处 MAJOR：**`--dsh` 指错时候选短路且从不打印候选列表**（与注释宣称的行为不符，用户机器上真有的 DSH 被静默丢弃）、**测试第 5 节的两处咬合漏洞**（假 npm 只挡 PATH 名，以及空集 `every` 恒真 —— 这意味着"没自己下载"这条硬约束目前只有弱回归保护）、**目录不可写 + `--yes` 走到 `mkdirSync` 抛异常退 3 而非 2**（退出码语义错，自动化会误判为"中途失败"）。修复优先级：测试咬合（M4）> `--dsh` 短路（M1）> 退出码分流，其余 MINOR 顺手清理。另须补审 `native-host-install.mjs` 与 `extension/build.mjs` —— 本轮未读其实现，"全链路不联网"这一结论目前仅覆盖 `install.mjs` 及其三个已读的 lib，尚不能声称全仓成立。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=0080ff25165a… audit=/Users/mac/.pimoa/spool/20260914T020609-moa_verify-51771-0qmke5-0080ff25165a.md
