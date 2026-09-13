# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`/tmp/wc-unreviewed.patch`、`bootstrap/lib/probe.mjs`、`bootstrap/lib/checks.mjs`、`bootstrap/lib/health.mjs`、`tests/unit/preflight-checks.test.mjs`、`tests/unit/install-health.test.mjs`
- prompt：`scripts/review-prompts/wizard-6-frozen.md`
- 用时：682.3s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T06:31:58.529Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

**这批改动是净正向的，没有新增 BLOCKER，上一轮那几条最重的问题都真修掉了**：`die()` 从异步 write 回调回归同步 `process.exit`（dry-run 的"一个字节都不动"重新成立，并由 `install-behavior` 用例 B 正面咬住）；`removeCompanion` 的 `splice(span.start, …)` 经逐行夹具推演确实消灭了"前置注释 + 同段邻居 ⇒ 连段头带前邻居一起删"这条用户数据丢失；`ws` 下载被拒从静默 `return` 改为显式 `die(2)` + 警告；`dist-port` 从 soft 改硬判据，并同批把 `install-health.test.mjs` 的三条旧断言反向改写；`readBlockConfig` 的 `wasQuoted` 闸门正确（`m[2]` 拿的是引号未剥的原文），配合 `rehydrate` 扩宽后，程序自己写出的配置两轮之间不再漂；`STATUS_ICON` 单一真源、`❓` 渲染、`portListening` 三态、`checkPort` 的 `null`、`checkDshCli` 版本读不出、`finishBanner` 只列真查过的判据、`preserved` 的生产—消费—文案三方对齐、native host 清单 `.tmp`+rename、`installDirArg || null`、`dying` 哨兵、暂存区改判 `package.json`、esbuild 版本退回读仓库那份、退出码 4/5 的引入与实际产出——全部接线经逐字核对成立。

**它没有做干净的地方集中在"护栏"而非"行为"**：① 本批最重的那条数据丢失修复（`removeCompanion`）**一条夹具都没补**，`profile-patch.test.mjs` 只多了一行 `record` 去重 ⇒ 改回旧写法不会变红；② `finishBanner([]).ok` 仍可为 `true`，而三条新断言只查文案、一条 `.ok` 都没有，`doctor.mjs` 侧可达；③ `summarize` 那条"未知 status 算阻断"的断言是**假咬合** —— 两种 `known` 写法在当前 `STATUS_ICON` 下产出同一集合，注释里"退回旧写法 ⇒ 这里红"是假话；④ 退出码语义仍两副口径：ws 被拒 `die(2)`、致命依赖缺失仍走 `must({status:1})`（渲染出不存在的 exit 1）、用户主动拒绝该归 4 而非 2；⑤ `findEntrySpan` 起点上移把缩进硬编码成 2 空格、且不跳注释行，4 空格缩进或 `- name:`/`id:` 之间夹注释时上一轮的"卸载残留半条"原样存在。此外 `record` 去重守卫被复制了 33 份、断言改名成"（第N次）"，与本批自己点名的"两处枚举漂移"属同一类病灶。

**只能修 3 处**：① **给 `tests/unit/profile-patch.test.mjs` 补一条"段头上方有提及本插件的注释 + 段内还有邻居"的夹具**，断言只删我们自己那一条、注释与前邻居仍在 —— 这是唯一具备用户数据丢失后果的修复，目前零回归保护；② **`finishBanner` 改 `ok: items.length > 0 && !mountSkipped && autoDeclined === 0`，并补一条 `none.ok === false` 断言** —— 上一轮已点名、本轮仍未修的"护栏本身没护栏"；③ **把第 3 步 fatal 分支的 `must({ status: 1 }, …)` 换成 `die(2)`，并把 ws 被拒的 `die(2)` 改成 `die(4)`** —— 两处机械改动，同时消掉"不存在的 exit 1"与 `--help` 退出码表的两副口径。紧随其后：`findEntrySpan` 的硬编码 `- 2` 改成 `prevIndent < entryIndent` 并跳过注释行；给 `summarize` 那条断言换成真能咬住"从渲染表派生"的形态（临时加键）；`record` 守卫抽到 `tests/unit/_record.mjs`。

**未覆盖（必列）**：`bootstrap/install.mjs`、`wizard.mjs`、`profile-patch.mjs`（`parseScalar`/`siblings`/`segment`/`upsertConfigKeys`/`renderBlock` 全文）、`yaml-scalar.mjs`、`native-host-install.mjs`、`layout.mjs`、`credentials.mjs`、`extension-id.mjs`、`dsh-root.mjs`、`uninstall.mjs`、`doctor.mjs`、`dsh-plugin/src/host/index.js` 与 `routes/ping.js`、`package.json`、`scripts/doc-graph.mjs` 的**磁盘全文均未读**；仅 `probe.mjs` / `checks.mjs` / `health.mjs` / `preflight-checks.test.mjs` / `install-health.test.mjs` 有完整源码。凡涉及未读文件的结论（`must` 的确切退出码、`parseScalar` 的转义语义、`siblings`/`segment` 的精确定义、`secret()` 的 EOF 实现、`withPairing` 对 `/ag/ping` 的影响、`uninstall.mjs` 是否清 `.plugin-deps`、`doctor.mjs` 是否复用 `finishBanner`）**一律以 diff 文本为据并已标【可疑待验】**。`docs/reviews/*.md` 新增 4 份、`doc-graph` 计数与 `areas` 归属、`m4-site-quality.json` 的真伪**未核**。**本轮未执行任何命令、未跑任何测试、未做真终端（pty）验证**，全部结论为静态核对。

# 审查报告：`/tmp/wc-unreviewed.patch`（冻结版引导程序「未被审过的那一段改动」）

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `die()` 改为同步 `process.exit(code)` 是否正确 | 提议1：方向对但"代价没兜底"，建议改回 `process.exitCode + throw`（列 MAJOR-2）；提议2：修对了，自洽 | **采信提议2** | diff 逐字：旧版 `process.stdout.write('', () => process.exit(code))` 正是上一轮的 BLOCKER（调用点后续同步代码继续跑 ⇒ dry-run 提前退出失效）。提议1 建议的 `throw` 方案会把**每一个**退出点都变成"经 uncaughtException 兜底"，而该兜底会 `w.warn('在「X」崩了')` + `console.error` —— 把正常的 dry-run 出口/用户拒绝出口渲染成崩溃，是更坏的形态。管道下丢尾行是明知代价，注释已写清，**不是缺陷** |
| `gaps.downloadable` 移到 `confirm('建立这些链接？')` 之外是否引入新问题 | 提议1：列为 **BLOCKER-1**（"用户拒绝建链接时 `applyPluginLinks` 没跑、`node_modules` 没清空，却仍调用下载+建链，未经确认就动安装目录"）；提议2：列为 **MINOR**（拒链接后下载 ws 是白下的浪费，语义可辩） | **采信提议2，驳回提议1 的 BLOCKER 定级** | 提议1 有两处事实错误：① `linkDownloadablePluginDeps` **自己带一次 `w.confirm('…现在下载到暂存区？')`**（diff 逐字可见），不存在"未经确认就动"；② "`rm -rf node_modules` 没跑所以写链接是未定义行为"是推理，diff 里该函数只有 `must(run('npm',…))` 可见，`rmSync/symlinkSync` 循环**不在本 diff 内**，提议1 自己也标了【可疑待验】却据此定 BLOCKER。真实缺陷只是"拒链接后下载物无处可用" |
| `removeCompanion` 的 `splice(span.start, …)` 是否真修好了"注释+邻居"数据丢失 | 提议1：只在表格里说"修对了"但未推演；提议2：给出逐行夹具推演（`# DSH Web Companion` + `- insert:` + 前邻居 + 我方 + 后邻居），证明旧版 `splice(start,…)` 会删掉前邻居、新版不会 | **采信提议2** | 提议2 的推演可核对且与上一轮审核的 MAJOR 描述（"排在我们前面的邻居"）严格吻合；这也正是上一轮建议的 `Math.max(start, span.start)` 的等价实现 |
| `findEntrySpan` 里 `Math.max(0, entryIndent.length - 2)` 的硬编码 2 | 提议1：**已确认硬编码**，4 空格缩进的 YAML 下上移失效 ⇒ 残留半条（MINOR）；提议2：只推演了 2 空格与嵌套场景，未点出 4 空格缩进 | **采信提议1** | diff 逐字含 `- 2`，是真实硬编码；DSH profile 用 4 空格缩进时 `prevIndent(=0/4) !== entryIndent-2` ⇒ `start` 不上移。这是少数派提议给出的更强证据 |
| `readBlockConfig` 的 `wasQuoted` 修法是否真生效 | 提议1：标【可疑待验】（未读 `parseScalar`，担心引号已被剥）；提议2：逐步推演 `raw = m[2]` 取的是**冒号后的原始文本**（含引号），`wasQuoted` 命中，修法成立 | **采信提议2** | 正则 `/^\s*([A-Za-z0-9_.-]+):\s*(.*?)\s*$/u` 的第 2 组就是引号**尚未剥离**的原文，`/^['"]/` 判定成立；`parseScalar(raw)` 在其后才剥。提议2 的推演正确 |
| `rehydrate` 与 `yamlScalar` 数字判据对齐程度 | 提议1：`0o/0b`、下划线、`.inf/.nan` 全不对齐 ⇒ 两轮漂移（MINOR）；提议2：因 `wasQuoted` 把引号来源挡在前面，实际不漂，只有**手工写裸值**才漂（MINOR） | **采信提议2，采纳提议1 的枚举清单** | 正确链路是：`yamlScalar` 给 `0b101` 加引号 ⇒ 下轮读到 `'0b101'` ⇒ `wasQuoted=true` ⇒ **不进 `rehydrate`** ⇒ 不漂。提议1 漏了 `wasQuoted` 这道闸。残留风险仅限用户手写裸 `0b101` |
| `preflight-checks.test.mjs` 里"未知 status 算阻断"那条断言是否真咬住本批改动 | 提议1：**假咬合** —— `new Set(['ok','warn','missing'])` 与 `new Set(Object.keys(STATUS_ICON))` 在当前 `STATUS_ICON` 下行为完全相同，注释声称"退回旧写法 ⇒ 这里红"是**假的**；提议2：未提 | **采信提议1** | 逐字可证：两种写法产出同一集合，该断言钉的是"未知态算阻断"（旧行为已有），**没有**钉"合法集必须从渲染表派生"。这是提议1 独有的、可核对的强证据 |
| `finishBanner([]).ok` 仍可为 true | 提议1：MAJOR-6（潜伏，doctor 复用会中招，且新测试一条 `.ok` 断言都没有）；提议2：m-7/m-17（MINOR，install 路径已不可达） | **折中：MAJOR-潜伏** | 事实两方一致（`ok: !mountSkipped && autoDeclined === 0`，测试只断言 text）。`health.mjs` 注释自述 `doctor.mjs` 复用同一层，所以"不可达"只在 install 侧成立；一行修 + 一条断言即可，定 MAJOR 更诚实 |
| `m4-site-quality.json` 那条 `false → true` | 提议1：**列进 top-3**，"最可能手工改绿" ；提议2：m-19 MINOR【可疑待验】 | **采信提议2 的定级，采纳提议1 的关注点** | 本 diff 确实不含 `extract.fn.js` 任何改动，制品与代码不同源，值得复核；但① 该文件**不在**本次审查对象（引导程序）范围内，② `at` 时间戳同批更新（`05:34 → 06:13`）说明**探针确实重跑过**，与"手工改绿"矛盾。定 MINOR·待验，不进 top-3 |
| `--help` 里退出码 `3` 是否已成死码 | 提议2：M-3 主张"全文不再产生 3"；提议1：未提 | **驳回提议2** | diff 逐字仍有 4 处 `die(3)`：扩展 ID 守卫、第 6.5 步导入自检、"装完找不到 dsh"、`uncaughtException` 兜底。`3` 活得很好 |
| 退出码 4 是否真被产出（上一轮的 MINOR） | 两方一致：已产出（"仍有阻断项"拒绝、拒建目录、收尾 `mountSkipped/autoDeclined`） | **一致，我复核通过** | diff 逐字三处 `die(4)` |
| `profile-patch.test.mjs` 没为本批最重修复补夹具 | 提议2：**M-1，列进 top-3**；提议1：未提（只在"未覆盖"里说 profile-patch 全文未读） | **采信提议2** | diff 里 `tests/unit/profile-patch.test.mjs` **只加了 `record` 去重一行**，零新增用例。这是本批最重修复的回归缺口 |
| ws 下载被拒该退 2 还是 4 | 提议1：未提；提议2：m-4，主张应为 4（与拒建目录一致） | **采信提议2** | `--help` 明写 `4 关键步骤被你拒绝`，用户主动答 n 正属此类；`2` 的口径是"参数/前置条件不满足" |

一致且我复核通过的关键判断：`pingPlugin` 三项合取身份判据方向正确（配合新增跨包一致性测试）；`portListening` 三态与 `checkPort` 的 `!== true && !== false` 消费端对齐；`checkDshCli` 新 warn 分支插入位置正确且有新断言咬住；`STATUS_ICON` 抽单一真源 + `❓` 渲染正确；`dist-port` 改硬判据方向正确且测试同批改到；`native-host` 清单 `.tmp` + rename 原子性正确；`installDirArg || null` 正确；`dying` 哨兵正确；暂存区判据改看 `package.json` 正确；esbuild 版本退回读仓库那份正确；`preserved` 消费 + 文案改正接线正确；收尾 `exitCode` 三分支穷尽性正确（`finishBanner([])` 时 `banner.ok` 必为 true 或落 4，不会落 5）。

---

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| MAJOR | `tests/unit/profile-patch.test.mjs`（整文件） | 亲验（diff 文件清单） | 本批最重的数据丢失修复（`removeCompanion` 的 `span.start`）**零回归保护**：该文件本批只加了 `record` 去重一行，没有任何"段头上方有提及本插件的注释 + 段内还有邻居"形状的用例 ⇒ 把 `splice(span.start,…)` 改回 `splice(start,…)` 不会变红 | 该文件 diff 全部内容仅 `+  if (Object.hasOwn(results, name)) throw new Error(…)` |
| MAJOR | `bootstrap/lib/health.mjs#finishBanner`（空数组分支）＋ `tests/unit/install-health.test.mjs` §4 | 亲验（完整源码） | `ok: !mountSkipped && autoDeclined === 0` ⇒ "一条健康判据都没拿到"照样 `ok:true`；三条新断言只查 `text`，**没有一条断言 `.ok`**。`health.mjs` 头部注释自述 `doctor.mjs` 复用同一层，那侧可达 | `return { ok: !mountSkipped && autoDeclined === 0, text: \`…没拿到任何健康判据…\` }`；最小修 `ok: items.length > 0 && !mountSkipped && …` + `record('★ 空数组 ⇒ 不算成功', none.ok === false)` |
| MAJOR | `tests/unit/preflight-checks.test.mjs`（未知 status 那组） | 亲验（逐字等价推演） | 假咬合：断言注释写"退回旧写法 ⇒ 这里红"，但 `new Set(['ok','warn','missing'])` 与 `new Set(Object.keys(STATUS_ICON))` 在当前 `STATUS_ICON` 下**产出同一集合** ⇒ 退回旧写法仍绿。本批"单一真源"这个动作本身没有任何护栏 | `record('★ 未知 status 必须算阻断（退回旧写法 ⇒ 这里红）', sum.ok === false && sum.blockers.length === 2)`；最小修：给 `STATUS_ICON` 临时加一个键后断言 `summarize` 对该状态的判定随之改变 |
| MAJOR | `bootstrap/install.mjs`（第 3 步 fatal 分支的退出码） | 亲验（diff）＋推理（`must` 全文未读） | 本批把 ws 下载被拒改成显式 `die(2)` 并在注释里骂了 `must({status:1})` 的假 exit 1，但**隔壁 fatal 分支仍在用 `must({ status: 1 }, …)`** ⇒ 两条同类"前置条件不满足"的路走出不同退出码，且用户仍会看到不存在的"失败（exit 1）" | 新代码 `w.close(); die(2)`；未改的 `must({ status: 1 }, \`插件依赖检查（缺 ${gaps.fatal.join('、')}）\`)`；最小修：该处改 `die(2)` |
| MINOR | `bootstrap/lib/profile-patch.mjs#findEntrySpan` | 亲验（diff 逐字） | 起点上移的判据把 YAML 缩进**硬编码成 2 空格**（`entryIndent.length - 2`）：profile 用 4 空格缩进时判据不命中 ⇒ `start` 不上移 ⇒ 上一轮那条"卸载后残留半条"在 4 空格缩进下原样存在 | `(/^\s*/u.exec(prev)?.[0] ?? '').length === Math.max(0, entryIndent.length - 2)`；最小修：改成"prev 是破折号行 且 prevIndent < entryIndent" |
| MINOR | `bootstrap/lib/profile-patch.mjs#findEntrySpan` | 亲验 | `- name:` 与 `id:` 之间夹一行注释（`  - name: x` / `    # note` / `    id: y`）时 `prev` 是注释行 ⇒ `/^\s*-\s/` 不命中 ⇒ 起点不上移，段头残留。与上条同源 | 同上 `const prev = all[idAt - 1] ?? ''`；最小修：向上跳过空行与 `#` 行再判 |
| MINOR | `bootstrap/lib/profile-patch.mjs#rehydrate` ↔ `yaml-scalar.mjs#looksNumeric` | 亲验 | 两侧"像数字"仍不等价：`yamlScalar` 认 `0o/0b`＋下划线＋`.inf/.nan`，`rehydrate` 只认十进制与 `0x`。因 `wasQuoted` 挡在前面，程序自己写出的值不漂；**仅用户手写裸 `k: 0b101` 时**会被读成字符串再写成 `'0b101'` | `if (/^[+-]?0[xX][0-9a-fA-F]+$/u.test(t)) return Number(t)` vs `/^0[xXoObB][0-9a-fA-F_]+$/u`；最小修：两侧共用同一份正则常量 |
| MINOR | `bootstrap/lib/yaml-scalar.mjs#yamlScalar` | 亲验 | 兜底转义只覆盖 C0/DEL（守卫也只匹配这段），`\u0085`(NEL)/`\u2028`/`\u2029` 在 YAML 里同属 line break、写进双引号标量非法，仍会原样落盘。存量缺口，本批未声称修 | `if (/[\u0000-\u001f\u007f]/u.test(s))`；最小修：守卫与 `.replace` 字符类同步加 `\u0085\u2028\u2029` |
| MINOR | `bootstrap/install.mjs`（ws 下载被拒的退出码） | 亲验 | 用户**主动**答 n 属 `--help` 定义的"4 关键步骤被你拒绝"（与拒建目录 `die(4)` 同类），本批却给 `die(2)` ⇒ 自动化按 4 判"用户拒绝"漏这一条 | `w.close()` / `die(2)`，与 `w.warn('用户拒绝创建目录…'); w.close(); die(4)` 对比 |

⚠️ [正文 15388 字符超回包预算 10000，已按行截取前 9742 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260913T063158-moa_verify-51771-b3mx9r-ab3758da3ec9.md（sha256=81091e8ffd17…，189621 字节，保留至 2026-09-27），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=ab3758da3ec9… audit=/Users/mac/.pimoa/spool/20260913T063158-moa_verify-51771-b3mx9r-ab3758da3ec9.md
