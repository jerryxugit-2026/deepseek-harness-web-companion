# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`/tmp/wc-changes-tests.patch`、`tests/unit/install-behavior.test.mjs`、`tests/unit/credentials-write.test.mjs`、`tests/unit/preflight-checks.test.mjs`、`tests/unit/install-health.test.mjs`、`package.json`
- prompt：`scripts/review-prompts/wizard-5-tests.md`
- 用时：232.5s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T06:06:38.631Z

---
## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `DEFAULT_PORT` 是否真从 `layout.mjs` 导出（两方均标为可能 BLOCKER／未核实） | 提议A：导出名若不对则整链炸，BLOCKER 候选；提议B：还可能是 env 派生 ⇒ 同义反复，最该修的三处之一 | **两方均驳回** | 亲验：`bootstrap/lib/layout.mjs:33` 逐字为 `export const DEFAULT_PORT = 3080`，是字面常量、非 env 派生。去硬编码改动**正确且会咬**（改常量 ⇒ 断言随动但仍与 `checks.mjs` 的 fix 文本对照，不构成同义反复） |
| `--install-dir` / `--dsh-home` 是否被 `install.mjs` 识别（A 标 BLOCKER 待验，B 标可疑待验） | 双方均"无法核实、可能三用例全废" | **两方均驳回** | 亲验：`install.mjs:26`、`:71-72` 帮助文本，`:95-96` `argOf('install-dir', null)` / `argOf('dsh-home', null)`。参数名正确，注入生效 |
| "删掉 `DRY_RUN` 提前退出 ⇒ B 立刻红"是否成立 | 提议A：只单向成立、咬合弱；提议B：无法确认、列为第一要修 | **成立（采信"咬合有效"）** | 亲验：`install.mjs:353-356` 的 dry-run 分支之后紧接 `:360` 阻断确认、`:368-375` 第 1 步 `mkdirSync(layout.installDir)`；删掉 353-356 且带 `--yes`（`ASSUME_YES` ⇒ confirm 恒真）⇒ 目录真被创建 ⇒ B 的 `existsSync(installDir)===false` 变红。提议A 说的"mkdir 被 try/catch 吞掉仍绿"是构造出的假想改法，无触发路径 |
| 用例 C 是否可能"提前退出而假绿" | 提议A：C 可能根本没走 confirm，四条仍绿（MAJOR）；提议B：未表态 | **方向错，但暴露了真问题** | 亲验：非交互 `--apply` 的真实路径是 `:368` confirm →否→ `:373` 打印「用户拒绝创建目录」→ `exit 1`，C 的三条正断言确实咬住。但若预检**有阻断项**，程序会在 `:362-363` 先 `exit 2` 且不打印那三个词 ⇒ C 第三条**变红（假红）**，不是假绿。采信"环境依赖"这一真缺陷，驳回"假绿" |
| `credentials-write.test.mjs` §7 自查源码断言的失效方式 | 提议A：`.dsh/` 与 `.credentials.yaml` 分散出现也会命中 ⇒ 对动态拼接**假红**；提议B：动态 `join(homedir(),'.dsh','credentials.yaml')` **不含**该连续子串 ⇒ **漏检**（假绿方向） | **提议B** | `String.includes()` 匹配的是**拼接后的连续子串** `'.dsh/.credentials.yaml'`，分散出现不会命中。提议A 的 JS 语义判断错误 |
| `code = error?.status ?? 1` 的严重度 | 提议B：MAJOR（spawn 失败/超时伪装成"非 0 退出"）；提议A：未提 | **采信 B 的事实，降级为 MINOR** | 事实成立；但同组还有输出内容断言（`拒绝创建目录/什么都没装/就此停下`），install.mjs 缺失时 stderr 为模块找不到 ⇒ 该条会红，组级仍能兜住 |
| 新测试拖慢/挂死 `test:unit`（提议A #12）| A：MAJOR，可能整链挂 180s | **驳回为实缺陷** | dry-run 在 `:356` 立退、C 在 `:375` 立退，三次 spawn 均为秒级；"挂死"无触发路径，属推测 |
| `doc-graph` 计数与 area 归属（提议B A5）| B：手改计数、把审查 prompt 列进 `extension` area 是语义污染 | **保留为可疑待验 MINOR** | 未核 `scripts/doc-graph.mjs` 统计口径；修法一致且极小：重跑 `npm run graph:docs` 比对 |
| `wizard-4-changes.md` 标题"依赖兜底"与本批 diff 不符（提议A #15）| A：MINOR 文档夸大 | **驳回** | 该文件是给**上一批源码改动**用的审查 prompt，标题描述的是被审对象而非本批 diff，不是缺陷 |

## 二、【逐条裁决】

MAJOR | `tests/unit/install-behavior.test.mjs#用例A/B` — `record('退出码 0', r.code === 0)` | 亲验 | dry-run 出口是 `process.exit(verdict.blockers.length > 0 ? 2 : 0)`，只要预检出现任一阻断项（如运行时 Node < 22、临时目录父级不可写）A/B 立刻假红，换机器行为不同 | `bootstrap/install.mjs:356` `process.exit(verdict.blockers.length > 0 ? 2 : 0)`；最小修：改断言为 `r.code === 0 || r.code === 2`，或在 A 里额外断言 `r.out.includes('dry-run 结束')` 作为"确实走完计划"的主判据

MAJOR | `tests/unit/install-behavior.test.mjs#用例C` — `record('★ 说清为什么没装（拒绝创建目录 / 什么都没装 / 就此停下）', …)` | 亲验 | 有阻断项时程序在"仍有阻断项，仍要继续吗？"处非交互按否并 `exit 2`，三个关键词一个都不打印 ⇒ 该条在部分机器上假红；无阻断时才走到 `用户拒绝创建目录` | `bootstrap/install.mjs:362-363` `if (verdict.blockers.length > 0 && !ASSUME_YES) { const go = await w.confirm('仍有阻断项…'); if (!go) { w.close(); process.exit(2) } }`；最小修：把 `仍有阻断项` 或 `不推荐` 加进 or 链

MINOR | `tests/unit/install-behavior.test.mjs#runInstaller` — `code = error?.status ?? 1` | 亲验 | spawn 失败（ENOENT）、`timeout: 180000` 超时、maxBuffer 溢出都会让 `status` 为 undefined 而被伪造成非 0，使 C 的 `r.code !== 0` 在"根本没跑起来"时也绿 | 原文 `catch (error) { code = error?.status ?? 1 }`；最小修：`const spawnFailed = typeof error?.status !== 'number'`，并在每个用例加一条 `record('进程真的跑起来了', spawnFailed === false)`

MINOR | `tests/unit/credentials-write.test.mjs#§7` — `SELF_SOURCE.includes('.dsh/' + '.credentials.yaml') === false` | 亲验 | 只查本测试**自身源码的连续字面量**：改成 `readFileSync(join(homedir(), '.dsh', 'credentials.yaml'))` 一样通过，"绝不碰真实凭据文件"这个承诺没被真正钉住 | 原文 `// needle 拆成两段写，否则这一行自己就命中自己`；最小修：追加一条 `SELF_SOURCE.includes('homedir()') === false && SELF_SOURCE.includes('os.homedir') === false`

MINOR | `tests/unit/credentials-write.test.mjs#§7` — `FIXTURE.match(/sk-[A-Za-z0-9-]+/gu)` | 亲验 | 正则只捞 `sk-` 前缀，夹具里的 `CLIPROXY_API_KEY: cp-FAKE3333…` 永远不进检查集；把它换成不带 FAKE 的真 key 不会变红 | 夹具行 `CLIPROXY_API_KEY: cp-FAKE3333333333333333333333`；最小修：正则放宽为 `/\b(?:sk|cp)-[A-Za-z0-9-]+/gu`

MINOR | `tests/unit/install-behavior.test.mjs#用例B` | 亲验 | B 缺 A 里那条 `r.out.includes('dry-run 结束')`，只靠"目录不存在"作单向证据；`--yes` 组合下"是否仍然走 dry-run 出口"没有正面证据 | 对比 A 的 `record('打印了"将要写入"的计划与"dry-run 结束"', …)`；最小修：B 复用同一条断言

MINOR | `tests/unit/install-behavior.test.mjs#用例C` | 亲验 | C 未断言 `existsSync(r.dshHome) === false`，与 A/B 不一致，DSH 数据目录侧无回归保护 | A/B 均有 `record('DSH 数据目录没被创建', existsSync(r.dshHome) === false)`；最小修：C 补同一行

MINOR | `tests/unit/install-behavior.test.mjs#用例C` — `r.out.includes('装好了') === false` | 亲验 | 否定式文案断言：成功横幅文案一改（`bootstrap/lib/health.mjs:165` ` ✅ 装好了，硬判据全过（…）`）此断言即**静默失效**而非变红 | `bootstrap/lib/health.mjs:165` `? \` ✅ 装好了，硬判据全过（${passed}）\``；最小修：从 health.mjs 导出该 marker 常量或断言退出码+`finishBanner().ok`

MINOR | `tests/unit/install-behavior.test.mjs#runInstaller` — `env: { ...process.env, HOME: home, DSH_HOME: dshHome }` | 推理 | 继承宿主 `PATH` 等；A/B 的"没动真格"只覆盖两个临时目录，其他落点不可见（但 `os.homedir()` 在 POSIX 认 `$HOME`，主路径隔离是有效的） | 原文该行；最小修：断言"计划输出里出现的绝对路径都以 `BASE` 或系统只读前缀开头"

MINOR【可疑待验】 | `docs/doc-graph.json#areas.extension` | 推理 | 一份 `codeRefs: 1` 的审查 prompt 同时被列进 `extension` 与 `scripts` 两个 area，且 `indexedFiles` 只 +1，疑似手工编辑而非生成 | diff 中 `"extension": [ …, "scripts/review-prompts/wizard-4-changes.md", … ]`；验证：`npm run graph:docs && git diff --stat docs/doc-graph.json`

无缺陷（记录） | `package.json#test:unit` | 亲验 | 仅在链尾追加 `&& node tests/unit/install-behavior.test.mjs`，其余脚本逐字未动，接线正确 | diff 中该行为唯一变更

无缺陷（记录） | `tests/unit/install-health.test.mjs` / `preflight-checks.test.mjs#DEFAULT_PORT` | 亲验 | 导入名与常量匹配，且 `stolen.fix.includes(String(DEFAULT_PORT))` 仍在跨模块比对 `checks.mjs` 生成的文案，改端口会真变红 | `bootstrap/lib/layout.mjs:33` `export const DEFAULT_PORT = 3080`

## 三、【最终裁决】

这批改动**方向正确、接线无误、没有 BLOCKER**：两个提议共同担心的三处"可能致命"（`DEFAULT_PORT` 导出名、`--install-dir/--dsh-home` 参数名、"删 DRY_RUN 提前退出 ⇒ B 会红"这条咬合承诺）经亲验**全部成立**（`layout.mjs:33`、`install.mjs:26/71-72/95-96`、`install.mjs:353-356` 紧接 `:368` 的 `mkdirSync`），不必改。真正的缺陷集中在**环境依赖导致的假红**而非假绿：dry-run 出口 `exit(blockers>0 ? 2 : 0)` 使 A/B 的 `code === 0` 与 C 的"说清原因"或链在有阻断项的机器上会红（`install.mjs:356`、`:362-363`）；其余为断言强度不足（`error?.status ?? 1` 伪造非 0；自查源码只防连续字面量、动态 `homedir()` 拼接漏检；`sk-` 正则漏掉 `cp-` key；B 缺"dry-run 结束"、C 缺 `dshHome`）。凡是提议里以"我读不到源码所以可能全废"为由抬到 BLOCKER 的条目，一律降级或撤销。**只能修 3 处的话：① 用例 C 的原因断言补入 `仍有阻断项`（否则换机即红，最伤这批测试的可信度）；② A/B 的退出码断言放宽为 `0 || 2` 并把 `dry-run 结束` 作为主判据（同因，且顺带补上 B 缺的正面证据）；③ credentials §7 第一条补 `homedir()` 关键词检查（当前对真正危险的动态拼接完全漏检，是这批"修无效断言"里唯一仍未真正咬住的一条）。**

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=d2beb3f1dec6… audit=/Users/mac/.pimoa/spool/20260913T060638-moa_verify-51771-pauer7-d2beb3f1dec6.md
