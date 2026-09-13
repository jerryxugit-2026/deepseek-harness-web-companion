# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`/tmp/wc-unreviewed.patch`、`bootstrap/install.mjs`、`bootstrap/lib/profile-patch.mjs`、`bootstrap/lib/yaml-scalar.mjs`、`bootstrap/lib/native-host-install.mjs`、`tests/unit/install-behavior.test.mjs`、`tests/unit/profile-patch.test.mjs`
- prompt：`scripts/review-prompts/wizard-6-frozen.md`
- 用时：495.0s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T06:28:52.777Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

这批修复**净正向，且没有重演上一轮那种级别的自伤**：`die()` 同步化确实堵住了"dry-run 提前退出失效、`--yes` 真写盘"的 BLOCKER（`install-behavior` 用例 B 正面咬住），`dist-port` 抬成硬判据、退出码拆成 0/2/3/4/5、`finishBanner` 不再说"跳过了第 11 步"这句假话、`preserved` 被消费且第 8 步文案改到与行为一致、三处 `.bak-before-*` 只留首份、manifest 走 `.tmp`+rename、`yamlScalar` 兜底全部 C0/DEL 与日期加引号、`rehydrate` 与 `looksNumeric` 对齐、`readBlockConfig` 对带引号来源不做类型还原、`argOf(...)||null`、`esbuildRange` 双源回退、`summarize` 的合法状态集从渲染表派生 —— 逐条核对都落到实处；两份提议分别提出的两条 BLOCKER 我都**不予采信**：`removeCompanion` 的 `else` 分支已改用 `span.start`（提议2 的推演自相矛盾），`checkDshCli` 的 warn 分支在 `checks.mjs:58-67` 实打实存在、跨包 id 断言的两处字面量也已跨仓逐字对上（提议2 的两条"测试必红/正则不可信"是事实错误）。

**但它没有做干净，且新引入了一条会丢用户数据的路径**：`findEntrySpan` 的"起点上移"让 `removeCompanion` 的 `entryIndent` 改从破折号行取值，同一 `- insert:` 段内混用两种手写形状时邻居就认不出来，于是落回"整段 splice"——与本批自称消灭的伤害同型，而第 13 节的夹具（我方排在段末、无前导注释、缩进形状统一）恰好绕开。其次，"可下载依赖移出 confirm"只修了守卫位置、没修执行条件：用户拒绝建链接、而 `ws` 已在暂存区时，末尾的 `symlinkSync` 循环照样把它链进去，绕过了"每个依赖都要确认"这条硬约束，并留下只有 `ws` 没有 `@deepseek-ai/*` 的半截依赖树。第三，`exitCode===5` 一律提示"重启 DSH 就好"，把刚被抬成硬判据的"安装残缺"重新归因成"还没重启"，等于用提示文案抵消了本批最重要的一条判定修复。另有一处潜伏假绿未动：`finishBanner([]).ok` 仍可能为 `true`，而新增断言只钉文案、依旧不碰 `.ok`。

**如果只能修 3 处**：① `removeCompanion`/`findEntrySpan` 的缩进基准统一（`entryIndent` 取 `min(span.start 行缩进, span.idAt 行缩进)`），并补一条"混合形状 + 段头上方带本插件注释 + 段内有邻居"的夹具断言——这是唯一具备用户数据丢失后果的一条；② 把第 3 步末尾的链接动作与 `applyPluginLinks` 的确认结果绑定（拒绝时只下载不链、并明确 warn），恢复"每个依赖都经用户确认"的对称守卫；③ 收尾提示按"没过的硬判据是哪几条"分流，只有在待重启类判据不过时才打"重启 DSH 即可"，否则指向 ❌ 行的真因（顺手把 `finishBanner([]).ok` 改成 `false` 并补上 `none.ok === false` 的断言）。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `removeCompanion` 的 `else` 分支是否仍会连段头带邻居删 | 提议2：**BLOCKER**（本批未消除）；提议1：未提（认为 `span.start` 修正有效） | **采信提议1（驳回提议2）** | 改动后逐字是 `all.splice(span.start, span.end - span.start)`，`span.start` 是条目起点、与被注释上提的 `start` 已解耦；提议2 自己在最终裁决里连说三次"这条也安全"，其 BLOCKER 结论未能自洽，无可核对的触发序列 |
| `preflight-checks.test.mjs` 新增的 `checkDshCli` "读不出版本 ⇒ warn" 断言会不会立刻红 | 提议2：**MAJOR**，"本批没改 `checkDshCli` 实现，断言必红"；提议1：未提 | **驳回提议2（事实错误）** | 亲验 `bootstrap/lib/checks.mjs:58-67` 已存在该分支：`detail: \`${dshCliPath} 在，但 \\\`dsh -V\\\` 读不出版本 —— 可能不是真的 DSH\``、`fix: \`先手动确认：${dshCliPath} -V；…\`` ⇒ `status==='warn'`、`detail.includes('读不出版本')`、`fix.includes('-V')` 三条全命中 |
| 跨包 id 一致性断言的正则 `/export const name = '([^']+)'/` 是否站得住 | 提议2：**MAJOR·形状不可信**；提议1：未提 | **驳回提议2（亲验反证）** | `dsh-plugin/src/host/index.js:39` 逐字 `export const name = 'dsh-web-companion-bridge'`，`routes/ping.js:17` 逐字 `plugin: 'dsh-web-companion-bridge'`，两条断言都能咬 |
| 拒绝"建立这些链接？"之后的行为 | 提议1：**BLOCKER**，末尾 symlink 循环仍无条件执行、用户拒绝被无视；提议2：**BLOCKER**，拒链接+拒下载 ⇒ 第 6.5 步以 `ERR_MODULE_NOT_FOUND` 假绿式失败 | **采信提议1的事实、降为 MAJOR；提议2 的描述部分失实** | 事实一：`linkDownloadablePluginDeps` 末尾 `rmSync(linkPath…); symlinkSync(staged(name), linkPath,'dir')` 确在 confirm 之外，且 `needing` 为空时连"要不要下载"都不问 ⇒ 拒链接仍被链入 `ws`；事实二：拒下载现在已是 `w.warn(...) + w.close() + die(2)`，**不再静默**，提议2 说"仍以模块找不到失败"只对"拒链接"这一半成立，且 6.5 步 `die(3)` 带明确指引，不是假绿。综合定 MAJOR（守卫不对称 + 违反"每个依赖都要确认"） |
| `findEntrySpan` 起点上移后 `removeCompanion` 的邻居判据是否闭合 | 提议1：**MAJOR**，混合形状下 `entryIndent` 取自破折号行 ⇒ 邻居认不出 ⇒ 走整段删；提议2：反复推演后自判"目前安全" | **采信提议1** | `entryIndent = 取 all[span.start] 的缩进`，手写分行形状下 span.start 已上移、缩进比 `id:` 少 2；邻居若是 `    - id: x` 单行形状缩进不同 ⇒ `siblings=[]` ⇒ 落入 `all.splice(segmentStart, segment.end - segmentStart)` 整段删。这是本批**新增的上移逻辑**带出的回归，有可构造的最小夹具 |
| `finishBanner([]).ok` 是否仍是假绿 | 提议1：**MAJOR**（文案改对了、判定没改、测试仍不断言 `.ok`）；提议2：只评"死码+死文案"MINOR | **采信提议1（保留 MAJOR·潜伏）** | diff 里空数组分支的 `ok: !mountSkipped && autoDeclined === 0` 逐字未动，新增断言只钉文案；install.mjs 侧当前不可达，故属"护栏本身没护栏" |
| `die()` 同步化是否引入新问题 | 提议2：**MAJOR**，stderr 不 flush ⇒ 管道下看不到崩溃栈；提议1：未提 | **采纳事实、降为 MINOR** | 代价在注释里已明写且为知情取舍；"正确性优先于完整性"的方向正确，补救（`process.exitCode` + 自然退出）与上一轮的异步坑同源，不宜再动 |
| `step(9)` 在 `mountSkipped` 时仍写 API key | 提议2：MAJOR；提议1：未提 | **降为 MINOR** | 写 key 另有一次 `confirm()`，用户知情同意；属口径不贯通而非误写（与上一轮 4b 裁决一致） |
| install-behavior A/B 退出码断言放宽为 `0 || 2` | 提议2：MAJOR"形同虚设" | **驳回为缺陷、记为 MINOR** | 主判据已改成 `r.out.includes('将要写入') && r.out.includes('dry-run 结束')`，退出码只作辅助，本就是上一轮点名的"环境依赖假红"的正确修法 |

一致且我复核通过的关键判断：`die()` 同步化确实修掉了上一轮的 BLOCKER；`dist-port` 改硬判据、退出码 5 与收尾提示、`.bak-before-*` 首份只写一次、native-host 清单 `.tmp`+rename、`yamlScalar` C0 兜底与日期加引号、`rehydrate` 与 `looksNumeric` 对齐、`readBlockConfig` 带引号不做类型还原、`argOf(...)||null`、`esbuildRange` 双源回退、`preserved` 被消费且文案改到与行为一致、`summarize` 从 `STATUS_ICON` 派生 —— 均按声称修到位。

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| MAJOR | `bootstrap/lib/profile-patch.mjs#removeCompanion` / `#findEntrySpan` | 亲验（改动后全文） | 本批新增的"起点上移"让 `entryIndent` 取自破折号行，而邻居判据要求**同缩进** ⇒ 同段内混用 `- id:` 单行形状与 `- name:`/`id:` 分行形状时邻居认不出，`siblings=[]` ⇒ 走整段 `splice`，把段头与邻居一并删掉（用户数据丢失，与本批要消灭的伤害同型） | `const entryIndent = (/^\s*/u.exec(all[span.start])?.[0] ?? '').length` 配 `return indent === entryIndent && /^\s*-\s/u.test(line) && !idLinePattern(id).test(line)`；最小修：`entryIndent` 取 `min(span.start 行缩进, span.idAt 行缩进)`，或邻居判据改成"落在 `[segment.start+1, segment.end)` 且缩进 ≤ idAt 缩进的 `- ` 行" |
| MAJOR | `bootstrap/install.mjs#step(3)` / `#linkDownloadablePluginDeps` | 亲验 | 把 `gaps.downloadable` 提到 confirm 之外修对了"拒建链接就整段跳过"，但函数末尾的 `symlinkSync` 循环**无条件**执行：用户对"建立这些链接？"答 n、而 `ws` 已在暂存区（`needing` 为空，连下载确认都不问）时，仍会有一条链接被写进 `dsh-plugin/node_modules` —— 用户的显式拒绝被绕过，且此时 `@deepseek-ai/*` 未链，留下半截依赖树 | `if (await w.confirm('建立这些链接？')) { … }` 之后 `if (gaps.downloadable.length > 0) await linkDownloadablePluginDeps(gaps.downloadable)`；函数内 `rmSync(linkPath, …); symlinkSync(staged(name), linkPath, 'dir')`。最小修：把"链接"这一步的执行条件与 `applyPluginLinks` 的确认结果绑定，或在被拒时只下载到暂存区并 `w.warn('重跑并同意建链接后才会接上')` |
| MAJOR | `bootstrap/install.mjs`（收尾 exit 5 提示） | 亲验 | `exitCode===5` 涵盖**任何**硬判据不过（含 `dist-port` 不一致、缺 `check-dist-config.mjs`＝安装残缺、插件加载不了），却一律提示"重启 DSH 就好"——本批刚把 `dist-port` 从 soft 抬成硬判据以暴露安装残缺，这句提示又把它重新藏回去，用户会重启后再次红灯且拿不到真因 | `if (exitCode === 5 && health.length > 0) { w.info(' 💡 步骤都跑完了。若这是**首次安装**，DSH 还没重启 ⇒ …') }`；最小修：仅当不过的硬判据只有 `plugin-ping`/`paired` 之类"待 DSH 重启"项时才打印，否则改成"上面的 ❌ 就是原因" |
| MAJOR（潜伏） | `bootstrap/lib/health.mjs#finishBanner`（空数组分支）＋ `tests/unit/install-health.test.mjs` 第 4 节 | 亲验 | 本批只把文案改成"没拿到任何健康判据"，`ok: !mountSkipped && autoDeclined === 0` 逐字未动 ⇒ 空判据 + 无拒绝仍可 `ok:true` ⇒ `exitCode 0`；新增断言依旧只钉文案、**没有一条断言 `.ok`**，一旦复检被重新 gate 回去，回归网抓不到 | `return { ok: !mountSkipped && autoDeclined === 0, text: \`…没拿到任何健康判据（probeHealth 返回空）…\` }`；最小修：`ok: false` + `record('★ 没拿到判据 ⇒ 不许判成功', none.ok === false)` |
| MINOR | `bootstrap/lib/yaml-scalar.mjs#yamlScalar` ↔ `#parseScalar` | 亲验 | 写出端新增 `\xNN` 兜底转义，读回端 `replace(/\\(.)/gu, …)` 只认 `n r t " \\`，其余一律退化成裸字符 ⇒ `\u0007` 写成 `"\x07"`、读回变成 4 个可见字符、再写出加单引号，**值在两轮之间自己漂**，正是本批要消灭的形态 | 写：`return \`\\x${ch.codePointAt(0).toString(16).padStart(2, '0')}\``；读：`(_, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch)`；最小修：双引号分支加 `x` 的两位十六进制处理 |
| MINOR | `bootstrap/install.mjs#uncaughtException` / `#unhandledRejection` 哨兵 | 亲验 | 哨兵写成 `if (dying) return`：处理器自身第二次抛（stderr EPIPE 时 `console.error` 失败）会被**吞掉**，进程不再 `die(3)` 而是带着坏状态继续跑——比它要修的死循环更难察觉 | `let dying = false` … `if (dying) return`；最小修：`if (dying) process.exit(3)` |
| MINOR | `bootstrap/install.mjs`（两个 `process.on` 的注册时机） | 亲验 | 两个兜底 handler 注册在两处 `await w.ask('本程序安装到哪个目录？' …)` **之后**，所以"问你装到哪"这一段抛异常仍是裸栈 + 退出码 1，与本批"说清停在哪一步"的目标不符 | `const installDir = installDirArg === null ? resolve(expandUserPath(await w.ask(…))) : …` 出现在 `process.on('uncaughtException', …)` 之前；最小修：把两个 `process.on` 上移到 `const w = createWizard(...)` 紧后 |
| MINOR | `bootstrap/install.mjs#linkDownloadablePluginDeps`（暂存区复用判据） | 亲验 | 改成看 `package.json` 比只看目录强，但 npm 中断的常见残留恰恰是"`package.json` 已落、正文未落" ⇒ 声称堵住的"半截目录"只堵了一半 | `const installed = (name) => existsSync(join(staged(name), 'package.json'))`；最小修：再校验 `main`/`exports` 指向的文件存在 |
| MINOR | `bootstrap/install.mjs#step(3)` fatal 分支 | 亲验 | 隔壁拒下载分支已改成显式 `die(2)`，这里仍用伪造的 `{ status: 1 }` 借道 `must()`（打印不存在的 `exit 1` 且退 3），两条同类路径的退出码与文案不一致 | `must({ status: 1 }, \`插件依赖检查（缺 ${gaps.fatal.join('、')}）\`)`；最小修：`w.warn(...) + w.close() + die(2)` |
| MINOR | `bootstrap/install.mjs#step(9)` | 亲验 | `mountSkipped === true`（＝等于没装）后仍继续问并写 API key，"拒挂载＝没装"的口径没贯通到凭据文件 | `mountSkipped = true` 之后无短路，`step(9, …)` 照常执行 |
| MINOR | `bootstrap/lib/native-host-install.mjs#applyNativeHostInstall` | 亲验 | 只给 manifest 上了 `.tmp`+rename，runner 仍是直写 + chmod ⇒ 写 runner 途中失败照样留半截（换了个半截形态）；且 rename 与 runner 无整体回滚 | `writeFileSync(plan.runnerPath, plan.runnerBody); chmodSync(plan.runnerPath, 0o755)` 与 `renameSync(manifestTmp, plan.manifestPath)`；最小修：runner 同样走 `.tmp`+rename |
| MINOR | `bootstrap/install.mjs#die`（stderr） | 推理 | 同步退出修对了主问题，但崩溃兜底的 `console.error(error)` 走 stderr，管道下可能被截 —— 属知情取舍，记录以免被当成已解决 | `console.error(error); die(3)` |
| MINOR | `bootstrap/install.mjs#step(8)`（两条提示重叠） | 亲验 | 「本程序只写它自己管理的键」与新加的「保留了原有 config 键：…」在同一屏同时出现，前者已被后者的行为覆盖，用户看到两条口径不同的说明 | `w.info('   💡 本程序只写它自己管理的键（attachDir / approvalForWriteOps）。')` 与 `w.info(\`   💡 保留了原有 config 键：${next.preserved.join('、')}…\`)` |
| MINOR（测试缺口） | `tests/unit/profile-patch.test.mjs` 第 13 节 | 亲验 | 共享段夹具是"我方排在段末、上方无前导注释、邻居与我方同为四空格单行形状"——本批新增的两处高危路径（注释上提 + 混合缩进形状）**一条都没造**，回归网抓不到上面那条 MAJOR | `const shared = ['- insert:', '    - id: mcp-semble', …, \`    - id: ${PLUGIN_ID}\`, …]`；最小修：加一个"我方用 `- name:`/`id:` 分行形状 + 邻居用单行形状 + 段头上方带 `# --- DSH Web Companion` 注释"的夹具 |
| MINOR（测试缺口） | `tests/unit/install-behavior.test.mjs` | 亲验 | 三个用例都停在"拒绝创建目录"就退出，**没有任何用例走到第 3 步**，本批改动最危险的那处（拒建链接仍链 ws）零覆盖 | 用例 C 只断言 `existsSync(r.installDir) === false` 等；最小修：加一个 `--apply` + 脚本化应答的用例，或把 `linkDownloadablePluginDeps` 的判定部分抽成纯函数单测 |
| MINOR（可疑待验） | `bootstrap/lib/checks.mjs#renderChecks` | 推理（`renderChecks` 全文未读） | 本批把 `const icon = { … }` 换成无 `❓` 键的 `STATUS_ICON`；若原实现的兜底是 `?? '  '` 而非 `?? '❓'`，新增断言 `mixedLines.some(l => l.startsWith('❓'))` 会直接红。验证：`rg -n "icon\[" bootstrap/lib/checks.mjs` | `const icon = STATUS_ICON` |

⚠️ [正文 11692 字符超回包预算 10000，已按行截取前 9770 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260913T062852-moa_verify-51771-eyamae-f1b2a57add47.md（sha256=3ee42ff676fb…，70649 字节，保留至 2026-09-27），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=f1b2a57add47… audit=/Users/mac/.pimoa/spool/20260913T062852-moa_verify-51771-eyamae-f1b2a57add47.md
