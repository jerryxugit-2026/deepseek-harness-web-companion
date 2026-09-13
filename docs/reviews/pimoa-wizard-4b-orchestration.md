# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`/tmp/wc-changes.patch`、`bootstrap/install.mjs`、`bootstrap/lib/native-host-install.mjs`
- prompt：`scripts/review-prompts/wizard-4-changes.md`
- 用时：377.0s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T06:04:33.033Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

这批改动**总体是净正向的，且几处最关键的接线经亲验确实接对了**：`pingPlugin` 的身份校验与插件真实 `/ag/ping` 载荷逐字吻合（`ok` + `plugin === 'dsh-web-companion-bridge' === PLUGIN_ID`），不会造成两份提议担心的全面假红；`wizard.mjs` 确实暴露了 `autoDeclined` / `interactive`，收尾横幅的三条「不算成功」判据不是死文案；`applyPluginLinks()` 无条件 `rm -rf node_modules` 属实，故「下载必须后做」的顺序约束成立；`findEntrySpan` 已确为条目级、`upsertCompanion` / `removeCompanion` 与它的 `{start,end,idAt}` 对得上；备份「首份只写一次」、native host 的 `join()` 与 `manifestPath === null` 抛错、`summarize`/`renderChecks` 的未知态、`dirStatus` 的根可写性、`portListening` 三态、`finishBanner` 区分「没查/没过」——都按声称修到位了。**但它没有做干净**：第一，`removeCompanion` 在「段头上方有提及本插件的注释 + 段内还有邻居」这条路径上，仍会把段头连同排在前面的邻居条目一起 `splice` 掉，与本批自称已消灭的那条 BLOCKER 是同一种伤害，而新增的第 13 节测试恰好没造这个形状；第二，`ws` 下载被交互式拒绝时静默 `return`，既不警告也不计入 `autoDeclined`，把「可下载兜底」悄悄降级成「可静默失败 + 收尾仍报绿」，方向与本批目标相反；第三，`--help` 新印的退出码表里 `4` 从不产生、`die()` 只覆盖 8 处退出中的 2 处——本批自己立的两条对外契约都只兑现了一半。此外新引入一处窄口子：`rehydrate` 会把上一轮写下的带引号「像数字」字符串在保留时转成数字，属于「升级不丢配置」这条修复自带的类型漂移。

**如果只能修 3 处**：① `removeCompanion` 的 `else` 分支改为 `all.splice(Math.max(start, span.start), span.end - Math.max(start, span.start))`（即有邻居时**绝不**把注释/段头纳入删除范围），并补一条「注释＋邻居」的夹具断言——这是唯一具备用户数据丢失后果的一条；② `linkDownloadablePluginDeps` 的拒答改为 `must({ status: 1 }, \`下载 ${needing.join('、')} 被拒绝\`)`（或至少 `w.warn` + 置一个跟 `mountSkipped` 同级的标志喂给 `finishBanner`），堵住这条新造的假绿；③ 把六处裸 `process.exit(1|2|3)` 统一换成 `die()`，并让「用户拒绝关键步骤」真的产出 `4`——两处都是机械改动、零风险，能同时消掉输出截断与 `--help` 说谎。（紧随其后：`rehydrate` 对带引号来源不做类型还原；`summarize` 的 `known` 改为 `new Set(Object.keys(icon))`；给 `secret()` 的 EOF 守卫补一条回归。）

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `wizard.mjs` 是否真的暴露 `autoDeclined` / `interactive` | 提议2：未核，若没暴露则 `declined` 文案是死的 ⇒ 条件 BLOCKER；提议1：默认存在 | **采信提议1（并已亲验坐实）** | `bootstrap/lib/wizard.mjs:60-61`：`interactive,` 与 `get autoDeclined() { return autoDeclined },` 都在返回对象里 ⇒ `w.autoDeclined` / `w.interactive` 接线成立，该条件 BLOCKER **不成立** |
| `pingPlugin` 新增身份校验会不会变成全面**假红**（插件若不返回 `ok`/`plugin`） | 提议1：列为最重要的「可疑待验」，并放进 top-3；提议2：认为已修对 | **采信提议2（已亲验坐实）** | `dsh-plugin/src/host/routes/ping.js`：`payload = { ok: true, …, plugin: 'dsh-web-companion-bridge', … }`，而 `layout.mjs:23 export const PLUGIN_ID = 'dsh-web-companion-bridge'` ⇒ 三项判据逐字对得上，不会假红。提议1 把它排进 top-3 是误判 |
| `portListening` 的 `error?.status === 1` | 提议1：MAJOR，魔法数无实测支撑，可能双向误判；提议2：已修对 | **折中：MINOR（可疑待验）** | 方向正确（ENOENT/EACCES 无 `status` ⇒ 落 `null`），且 lsof「无匹配」惯例就是 exit 1；但把「其它 exit 1 类错误」也归成「确实没人听」仍是猜测。提议1 的 stdout 判空写法是有价值的硬化，不到 MAJOR |
| 用户拒绝下载 `ws` 时 `linkDownloadablePluginDeps` 静默 `return` | 提议2：MAJOR；提议1：认为语义可接受（MINOR） | **采信提议2** | 交互式答 `n` **不会**让 `autoDeclined` 自增（`wizard.mjs:73/75` 只在非交互/EOF 分支自增）⇒ `finishBanner` 收不到任何信号，仍可能打「装好了」，而 `dsh-plugin/node_modules/ws` 根本不存在 —— 这是这批改动自己新造的一条假绿路径 |
| 第 9 步在 `mountSkipped` 时仍写 API key | 提议2：MAJOR；提议1：未提 | **采纳事实，降为 MINOR** | 写 key 本身另有一次 `confirm()`，用户是知情同意；只是「拒挂载＝等于没装」的口径没覆盖到它，属提示不全而非误写 |
| `applyNativeHostInstall` 非原子写 | 提议2：MAJOR；提议1：未提 | **采纳，降为 MINOR** | 属**存量**问题（本批未触碰写序），触发需进程中途被杀/磁盘满；修法一行 rename，值得做但不是本批引入 |
| 提议1 自述的 2.1 / 2.3 / 2.4 / 2.9 | 提议1 自己在正文中逐条推翻或降级 | **全部驳回** | `status:null` 形状一致、`checkDshCli` 新分支命中 `null` 正确、`autoDeclined` 语义在「非交互全 false」前提下确实等价于「什么都没装」 |
| 两份提议**都没发现**的三处 | — | **本裁决新增**（见二） | `removeCompanion` 注释+邻居共存时仍会连段头带邻居删；`rehydrate` 把带引号的「像数字」字符串强转成数字；`finishBanner([])` 分支在 install 路径已成死代码且文案已过期 |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| MAJOR | `profile-patch.mjs#removeCompanion` | 亲验（diff 逐字） | 有邻居时走 `else` 分支，而 `start` 可能已被前导注释拉到**段头之上** ⇒ `splice(start, span.end - start)` 连 `- insert:` 段头和排在我们前面的邻居条目一起删——正是本批声称已修掉的那类数据丢失，只是触发条件变窄（段头上方有提及本插件的注释） | `let at = (segment?.start ?? span.start) - 1` … `if (sawComment && mentions) start = at + 1` … `} else { all.splice(start, span.end - start) }`；第 13 节测试**没有**「注释＋邻居」用例 |
| MAJOR | `install.mjs#linkDownloadablePluginDeps` | 亲验 | 用户对「现在下载到暂存区？」答 `n` 时函数静默 `return`：`ws` 既没下也没链，交互式拒绝不计入 `autoDeclined`，收尾横幅仍可能报「装好了」 | `if (!(await w.confirm(\`DSH 里没有 ${needing.join('、')} —— 现在下载到暂存区？\`))) return`；对比同段 `@deepseek-ai/*` 走的是 `must({ status: 1 }, …)` |
| MINOR | `install.mjs#die()` 覆盖面 | 亲验 | 「先 flush 再退」只落到 `must()` 与收尾两处，其余六处仍是裸 `process.exit`，管道下计划/回滚提示照样会被截断 | 仍为裸退出的点：dry-run 出口 `process.exit(verdict.blockers.length > 0 ? 2 : 0)`、阻断项 `if (!go) { w.close(); process.exit(2) }`、第 1 步 `process.exit(1)`、找不到 dsh `process.exit(3)`、扩展 ID 守卫 `process.exit(3)`、第 6.5 步 `process.exit(3)` |
| MINOR | `install.mjs#--help` 退出码表 | 亲验 | 新印的约定宣称 `4 关键步骤被你拒绝`，但全文**没有任何**产生 4 的路径（拒建目录是 1、拒绝继续是 2、拒挂载最终是 3）⇒ 自动化按 4 判「用户拒绝」永不命中 | `0 成功   2 参数/前置条件不满足…   3 中途失败   4 关键步骤被你拒绝   130 Ctrl-C` vs `process.exit(1)` / `process.exit(2)` / `die(banner.ok ? 0 : 3)` |
| MINOR | `profile-patch.mjs#rehydrate` | 亲验 | `parseScalar` 已剥掉引号、`rehydrate` 再按外观转类型 ⇒ 上一轮写下的 `key: '1.0'` / `'007'` 这类**带引号的字符串**在保留时被转成数字 `1` / `7` 重新渲染，正是这条改动想防的「两轮之间自己漂移」 | `out[m[1]] = rehydrate(parseScalar(m[2]))` + `if (/^[+-]?\d+$/u.test(t)) return Number(t)` |
| MINOR | `health.mjs#finishBanner`（空数组分支） | 亲验 | 第 11 步复检已不再被 `pause()` gate，`evaluateHealth` 必返回非空数组 ⇒ 该分支在 install 路径成死码，且其文案「非交互环境跳过了第 11 步」现在是**错的**，只有单测在喂它 | `text: \`…本轮**没做复检**（非交互环境跳过了第 11 步）…\`` 与 install 侧无条件的 `let health = await probeOnce()` |
| MINOR | `probe.mjs#portListening` | 亲验＋推理 | 三态方向正确，但用 `error?.status === 1` 区分「确实没人听」是未实测的经验值；改判 stdout 是否为空可去掉魔法数 | `if (error?.status === 1) return false` / `return null`；验证：`lsof -nP -iTCP:9 -sTCP:LISTEN; echo $?` |
| MINOR | `checks.mjs#summarize` | 亲验 | 新写死的 `known` 与 `renderChecks` 的 `icon` 是**两份**枚举，任一方新增键就会「判定与渲染不一致」——正是这条改动要消灭的问题 | `const known = new Set(['ok', 'warn', 'missing'])`；最小修法 `new Set(Object.keys(icon))` |
| MINOR | `install.mjs#linkDownloadablePluginDeps`（暂存区复用判据） | 亲验 | `existsSync(staged(name))` 只看目录在不在：上一次 `npm install` 中途崩掉留下的半截包会被当成「已有，不重复下载」 | `const needing = names.filter((name) => !existsSync(staged(name)))` |
| MINOR | `install.mjs#esbuild 版本单一真源` | 亲验 | 单一真源只做了一半：读的是**安装目录里那份**（第 2 步被拒就读不到），且 `'^0.25.0'` 仍在同一表达式里硬编码两次 | `… .devDependencies?.esbuild ?? '^0.25.0'` `} catch { return '^0.25.0' }` |
| MINOR | `install.mjs`（未消费的 import） | 亲验 | `overallOk` / `pendingHard` 改用 `finishBanner` 后已无调用点，只剩 import —— 与本批点名的 `npmInstallTargets()` 同类死接线 | `import { finishBanner, overallOk, pendingHard, probeHealth, renderHealth } from './lib/health.mjs'` |
| MINOR | `install.mjs#step(9)` | 亲验 | `mountSkipped === true`（＝等于没装）时仍继续写 API key，横幅也不提「key 已经写下去了」，口径没贯通 | `mountSkipped = true` 之后无任何短路，`step(9, …)` 照常执行 |
| MINOR | `native-host-install.mjs#applyNativeHostInstall` | 亲验 | 先写 runner + chmod、再写 manifest，中途异常留下「拉起器在、Chrome 找不到清单」的半截态（存量问题，本批未触及） | `writeFileSync(plan.runnerPath, plan.runnerBody); chmodSync(...)` … `writeFileSync(plan.manifestPath, …)` |
| MINOR | `yaml-scalar.mjs#yamlScalar` | 亲验 | 「像数字」放宽到 `1e5`/`0x10`/`.5` 是对的，但 `2024-01-15` 这类字符集全在白名单、`looksNumeric` 不命中 ⇒ 仍以裸标量写出，下游会读成日期 | `const plain = /^[A-Za-z0-9_./+-]+$/u.test(s) && … && !looksNumeric` |
| MINOR（测试缺口/假绿） | `tests/unit/wizard-interaction.test.mjs` 第 8 节 | 亲验 | 本批把 `secret()` 的 EOF 僵死列为 BLOCKER 修复，但新增的三组 EOF 用例只覆盖 `confirm` / `ask` / `pause`，**`secret()` 零回归保护** | 第 8 节四条断言分别是 `confirm → false`、`ask → 默认值`、已关后 `confirm/ask`、`pause → false` |
| MINOR（测试缺口/假绿） | `tests/unit/preflight-checks.test.mjs` | 亲验（diff 无该文件） | `summarize` 的「未知 status 当阻断」与 `renderChecks` 的 `❓` 都没有任何新断言，退回旧写法不会变红 | 本批 diff 只改了 `checks.mjs`，未新增对应用例 |
| 驳回 | 提议1「`pingPlugin` 可能造成全面假红」列入 top-3 | 亲验反证 | `ping.js` 的 payload 逐字满足 `ok`+`plugin`，`res.ok` 亦为 200 | `plugin: 'dsh-web-companion-bridge'` ↔ `PLUGIN_ID` |
| 可疑待验 | `install.mjs`＋`index.js:416` 的 ping 路由包了 `withPairing` | 推理 | 若 `withPairing` 在无 key 时返回非 200，则**尚未配对**的机器上 `dsh-up` 会由「能连上」变成 ❌；配对后不受影响，需实跑确认 | `handler: withPairing(pingRoute({ state, protocolVersion: PROTOCOL_VERSION }))`；验证：`curl -i http://127.0.0.1:3080/ag/ping` |

**未覆盖**：`upsertConfigKeys` / `renderBlock` / `blockRange` 的缩进处理（只读了 `findEntrySpan` / `readBlockConfig` / `removeCompanion` 段）、`checks.mjs` 的 `icon` 表与 `checkPort` 前置分支全文、`credentials.mjs`、`extension-id.mjs`、`uninstall.mjs` / `doctor.mjs` 是否同步了 `finishBanner` / `preserved` 新接口、`extract.fn.js` 与 `probe-sites` 那条抓取改动（`m4-site-quality.json` 里新断言仍是 `false`，说明该 JSON 是修复**前**的快照，需重跑确认）、以及任何实际执行（全部静态取证）。

## 三、【最终裁决】

这批改动**总体是净正向的，且几处最关键的接线经亲验确实接对了**：`pingPlugin` 的身份校验与插件真实 `/ag/ping` 载荷逐字吻合（`ok` + `plugin === 'dsh-web-companion-bridge' === PLUGIN_ID`），不会造成两份提议担心的全面假红；`wizard.mjs` 确实暴露了 `autoDeclined` / `interactive`，收尾横幅的三条「不算成功」判据不是死文案；`applyPluginLinks()` 无条件 `rm -rf node_modules` 属实，故「下载必须后做」的顺序约束成立；`findEntrySpan` 已确为条目级、`upsertCompanion` / `removeCompanion` 与它的 `{start,end,idAt}` 对得上；备份「首份只写一次」、native host 的 `join()` 与 `manifestPath === null` 抛错、`summarize`/`renderChecks` 的未知态、`dirStatus` 的根可写性、`portListening` 三态、`finishBanner` 区分「没查/没过」——都按声称修到位了。**但它没有做干净**：第一，`removeCompanion` 在「段头上方有提及本插件的注释 + 段内还有邻居」这条路径上，仍会把段头连同排在前面的邻居条目一起 `splice` 掉，与本批自称已消灭的那条 BLOCKER 是同一种伤害，而新增的第 13 节测试恰好没造这个形状；第二，`ws` 下载被交互式拒绝时静默 `return`，既不警告也不计入 `autoDeclined`，把「可下载兜底」悄悄降级成「可静默失败 + 收尾仍报绿」，方向与本批目标相反；第三，`--help` 新印的退出码表里 `4` 从不产生、`die()` 只覆盖 8 处退出中的 2 处——本批自己立的两条对外契约都只兑现了一半。此外新引入一处窄口子：`rehydrate` 会把上一轮写下的带引号「像数字」字符串在保留时转成数字，属于「升级不丢配置」这条修复自带的类型漂移。

**如果只能修 3 处**：① `removeCompanion` 的 `else` 分支改为 `all.splice(Math.max(start, span.start), span.end - Math.max(start, span.start))`（即有邻居时**绝不**把注释/段头纳入删除范围），并补一条「注释＋邻居」的夹具断言——这是唯一具备用户数据丢失后果的一条；② `linkDownloadablePluginDeps` 的拒答改为 `must({ status: 1 }, \`下载 ${needing.join('、')} 被拒绝\`)`（或至少 `w.warn` + 置一个跟 `mountSkipped` 同级的标志喂给 `finishBanner`），堵住这条新造的假绿；③ 把六处裸 `process.exit(1|2|3)` 统一换成 `die()`，并让「用户拒绝关键步骤」真的产出 `4`——两处都是机械改动、零风险，能同时消掉输出截断与 `--help` 说谎。（紧随其后：`rehydrate` 对带引号来源不做类型还原；`summarize` 的 `known` 改为 `new Set(Object.keys(icon))`；给 `secret()` 的 EOF 守卫补一条回归。）

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=10fd60f7f317… audit=/Users/mac/.pimoa/spool/20260913T060433-moa_verify-51771-g0mnuh-10fd60f7f317.md
