# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`bootstrap/install.mjs`、`bootstrap/uninstall.mjs`、`bootstrap/doctor.mjs`、`docs/13-安装部署.md`
- prompt：`scripts/review-prompts/wizard-1-orchestration.md`
- 用时：255.3s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T05:44:41.796Z

---
## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| dry-run 下是否会真落盘 | 提议A(MiniMax)：逐条排查后结论"一个字节都没写"；提议B(deepseek)：先报 step4 的 `rmSync/symlinkSync` 为 BLOCKER，随后自行撤回 | 双方最终结论一致：**dry-run 不写文件**（亲验） | 真文件中 `if (DRY_RUN) { … process.exit(…) }` 在 `install.mjs:316`，而所有写调用（`328/330`、`354-356`、`447-451`、`462`、`552-554`、`576-579`）行号**全部大于 316**，不可达。B 的"撤回"是对的，其初稿 BLOCKER 不成立 |
| "全新机器上 dry-run 会以 exit 3 提前退出"（B 的 A2，列为 MAJOR，并给了复现命令） | B 主张成立；A 未提 | **不采信 B** | `process.exit(3)` 在 `install.mjs:397`，位于 step 3 的 `if (await w.confirm(...))` 分支内，而 step 3 整体在 `316` 的 dry-run 出口之后 ⇒ dry-run 永不进入。B 给的复现命令只会打印计划并 exit 0/2。这是 B 最严重的一处误判 |
| `--dsh-version` 在 `dsh` 已存在时被静默忽略 | B 列为 D 区头号障碍并给出可跑验证；A 的 C1 反而把 `targetDshVersion` 判为"单一真源、OK" | **采信 B** | 代码只有 `dshPath === null ? 安装 : w.detail('已装…跳过')` 两支（step 3），`targetDshVersion`（`install.mjs:217`）在已装分支只进入打印。A 把"只有一份字面量"误当"无缺陷"，漏了"参数不生效"这一真实行为缺陷 |
| 第 2 步 `rmSync` 先删再拷的严重度 | A：BLOCKER（中途失败会连旧版一起丢）；B：MAJOR（摧毁用户对安装目录的本地改动且唯一不备份的写路径） | **采信 B 的 MAJOR，并吸收 A 的失败窗口论证** | 源码可从发行包重拷、重跑能自愈（`354-356` 每项独立替换），不构成不可恢复损坏；但"唯一一处不备份的破坏性写"确是真缺陷。定 MAJOR |
| 非交互下第 11 步被跳过是否算缺陷 | A：标【可疑待验】，能否定性取决于 `finishBanner` | B：已确认 MAJOR（跳过复检却 exit 0） | **采信 B** | 已亲验 `wizard.mjs:138` 非交互 `pause()` 直接返回 false；`install.mjs:593` → `health=[]` → `632` 无条件 `process.exit(0)`。横幅措辞如何，都改变不了"复检未执行而退出码报成功"这一事实 |
| 第 7 步在第 5 步被拒时会写出不一致的 native host 清单 | B 报 MAJOR（已确认）；A 未发现 | **采信 B** | step 7 的 `extId` 取自第 2 步复制来的 manifest，ID 守卫只在 step 5 的 `if (!DRY_RUN)` 块（`500` 之前那段）内执行 |
| A 的 B1/B8 两条 BLOCKER（profile config 幂等、rm+cp 破坏性） | A 自述推演过程中多次"这一步是安全的""不是 bug"后仍标 BLOCKER | **不采信该级别** | A 正文自证了安全闭环，级别与论证矛盾；降级/并入 MAJOR 或剔除 |
| 两份提议给出的行号 | 双方各写一套，互不相同 | **均不可直接引用** | 亲验：step 1 在 `328-335`（非 A 的 319、非 B 的 238），step 2 拷贝在 `354-356`（非 B 的 265-283）。本裁决下文行号一律以磁盘实际文件为准 |

额外亲验发现（两份提议都没提）：磁盘上的 `bootstrap/install.mjs:207-209` 存在 `mkdirSync / rmSync / symlinkSync(staged(name), linkPath)` 一组调用，**审查材料贴出的源码里没有这一段** ⇒ 被审材料与磁盘文件已漂移；该段是否在 `DRY_RUN` 守卫的 helper 内【可疑待验】（取证预算已耗尽，未能打开该函数体）。

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 行号/片段 |
|---|---|---|---|---|
| MAJOR | install.mjs#step3（DSH 版本分支） | 亲验 | `dsh` 在 PATH 上即跳过，`--dsh-version` 被静默吞掉，"版本旧要能升级"完全缺失 | `217 targetDshVersion = requested ?? installed ?? '0.1.5-rc.2'`；step 3 else 支 `DSH 已装：… —— 跳过安装` |
| MAJOR | install.mjs#step10/11（`w.pause` → `health`） | 亲验（含 `wizard.mjs:138` 非交互返回 false） | 管道/CI 下复检整段不执行，仍 `exit 0`，与用户"装完要检测一切健康"硬约束直接冲突 | `593 const waited = await w.pause(...)`；`632 process.exit(0)` |
| MAJOR | install.mjs#step2（先删再拷） | 亲验 | 全程唯一不备份的破坏性写：对已有安装目录逐项 `rm -rf` 后再拷，用户在安装目录内的改动无提示丢失；拷贝中途失败时旧版已被删 | `354 rmSync(dest, { recursive: true, force: true })` / `356 cpSync(src, dest, …)` |
| MAJOR | install.mjs#step7（native host 的 extId 来源） | 亲验 | 第 5 步被拒时仍用源仓库公钥写清单，而配对文件 `extensionOrigins` 未更新 ⇒ 三方对不上；ID 守卫不在此路径 | step 7 `const extId = manifestSrc?.key ? extensionIdFromKey(manifestSrc.key) : null` |
| MAJOR | install.mjs#must()（覆盖面） | 亲验 | `applyPluginLinks` / `applyNativeHostInstall` / 两处 `writeFileSync` 不经 `must()`，抛异常即裸栈退出码 1，无"停在哪一步/怎么回滚"语义 | `552-554 writeFileSync(layout.profilePatch, next.text)`；`576-579 writeFileSync(layout.credentialsFile, …)` |
| MAJOR | install.mjs#step8 的 confirm 语义 | 亲验 | 除 step 1 外所有 `confirm` 拒绝都只跳过并继续；拒绝写挂载后仍走完 step 9/10/11 并打印收尾横幅，用户会以为装好了 | step 1 是唯一例外：`335 process.exit(1)` |
| MINOR | install.mjs#退出码约定 | 亲验 | `2` 同时表示"参数非法"（`119`）与"用户拒绝继续"（`323`），`1`（用户取消）与未捕获异常默认码相同；`--help` 与文档均无退出码表 | `119 process.exit(2)` / `323 if (!go) { w.close(); process.exit(2) }` / `335 process.exit(1)` |
| MINOR | install.mjs#step4（esbuild 链接分支） | 亲验 | `rmSync(targetDir)` 无条件清掉整个 `extension/node_modules`（含用户自装内容），且是唯一不备份的删除 | `447 rmSync(targetDir, { recursive: true, force: true })` |
| MINOR | install.mjs#help 文案硬编码 | 亲验 | 端口/默认目录在 `--help` 与注释里写死 `3080`、`~/.dsh/plugins/dsh-web-companion`，而运行时走 `DEFAULT_PORT` / `defaultInstallDir()` ⇒ 改常量后帮助会说谎 | `96 parsePort(argOf('port', DEFAULT_PORT)) ?? DEFAULT_PORT` vs help 正文 `--port <端口> DSH 端口（默认 3080）` |
| MINOR | install.mjs#esbuild 版本 | 推理 | `esbuild@^0.25.0` 在引导程序里另写一份浮动范围，与 `extension/package.json` 的声明可能漂移（未读该文件，故为推理） | `454 … 'esbuild@^0.25.0'` |
| MINOR | install.mjs#`created` | 亲验 | 赋值后全文无读者，是未完成的回滚逻辑残骸（`rg` 仅命中 326/331 两处） | `326 let created = false` / `331 created = true` |
| MINOR | install.mjs#所有 `process.exit(n)` | 推理 | 管道下 stdout 异步，`w.close()` 后立即 `exit` 可能截断最后几行（阻断清单、回滚提示）；最小修法改 `process.exitCode` | `316 / 335 / 397 / 482 / 509 / 632` |
| MINOR | install.mjs#dry-run 的对外探测 | 亲验 | dry-run 仍 `pingPlugin` / `portListening` 打本机端口；不写文件故不违反字面承诺，但文档 §0 的"一个字节都不动"需限定为"文件" | 探测段在 `316` 之前，`const ping = listening ? await pingPlugin(port, pairingKey) : …` |
| MINOR | install.mjs#step3 拒绝后继续 | 亲验 | 用户拒装 DSH 后仍跑 step 4/5/6（含 11MB 下载与一次构建），直到 `500-509` 的 import 自证才退出；安全但浪费数分钟 | `509 process.exit(3)`（在 step 7/8 之前，挂载确实被挡住） |
| D 区·MAJOR | install.mjs#（缺失）本机/远端插件版本 | 亲验 | 全文不读任何 `package.json.version`、不读 `extension/manifest.json` 的 `version`（只读 `key`），无 semver 比较、无 `npm view`/远端查询 ⇒ "装没装、该不该升"无判据，只能无脑全跑 | 唯一版本探测是 DSH 的：`217`；step 7 只取 `manifestSrc?.key` |
| D 区·MAJOR | install.mjs#（缺失）三元模式与迁移 | 亲验 | 新装/重装/升级三态仅靠 `mountBefore.found` 一个布尔推断，且只影响 `attachDir` 一个键；`approvalForWriteOps` 的"卸载→重装丢失"已被注释承认却仍要用户手动带参，无自动侦测/恢复 | step 8 `buildMountConfig({ freshInstall: mountBefore.found !== true, … })` |
| D 区·MINOR | install.mjs#升级保留清单 | 亲验 | 升级必须保留的四样里，配对钥匙（`462` 先备份）、profile（`552` 先备份）、credentials 其它键（定点改写）OK；**安装目录源码与 `extension/node_modules` 会被无备份替换**（`354`、`447`） | 同上两行 |
| （驳回） | B#A2「dry-run 在无 dsh 机器上 exit 3」 | 亲验反例 | `397` 在 `316` 之后不可达 | — |
| （驳回） | A#B1/B8 标为 BLOCKER | 亲验 | A 自身论证已证明安全或可自愈，级别不成立 | — |
| 可疑待验 | install.mjs:207-209 的 `rmSync/symlinkSync` | 亲验其存在，未验其可达性 | 磁盘文件含该段而审查材料不含 ⇒ 材料已过期；若该段不在 helper 内或无 `DRY_RUN` 守卫，则是真正的 dry-run 泄漏（唯一候选） | `207 mkdirSync(dirname(linkPath), …) / 208 rmSync(linkPath, …) / 209 symlinkSync(staged(name), linkPath, 'dir')` |
| 可疑待验 | install.mjs#step6.5 自证强度 | 推理 | 若 `dsh-plugin/src/host/index.js` 顶层未静态 import DSH 子包，则"import 成功"不能证明依赖齐全，挂载前的唯一硬守卫会假阳性 | `500-505 spawnSync(process.execPath, ['--input-type=module','-e', 'await import(...)'])` |

**未覆盖**：`bootstrap/lib/*`（除亲验的 `wizard.mjs` 非交互契约：`73/89/138`）、`scripts/init-key.mjs`、`scripts/check-dist-config.mjs`、`extension/build.mjs`、`dsh-plugin/src/host/index.js`、`package.json`/`CHANGELOG`/`extension/manifest.json` 的实际版本值、`install.mjs:195-215` 的函数体、Windows/Linux 分支、任何实际运行（全部静态分析）。

## 三、【最终裁决】

**无 BLOCKER。** 最关键的一条硬约束——"默认 dry-run 一个字节都不动"——经亲验成立：`install.mjs:316` 的提前 `process.exit` 把所有写调用（`328`–`579`）挡在身后，两份提议中那些指向 dry-run 泄漏的 BLOCKER（step 4 的 `rmSync`、"无 dsh 机器 dry-run exit 3"）均被行号反证推翻；唯一残留嫌疑是磁盘文件里审查材料未包含的 `207-209` 符号链接段，须确认它是否在受守卫的 helper 内，同时说明**被审材料与磁盘已漂移**，后续评审应以磁盘为准。真实缺陷集中在三个方向：① 编排的"拒绝/跳过后仍继续"语义（除 step 1 外无一处拒绝会停，step 7 在 step 5 被拒时还会写出 ID 不一致的 native host 清单，`must()` 也未覆盖四处直接写盘）；② 非交互路径把"装完必须复检"这条硬约束整段跳过却返回 0；③ 装/升级合一基本等于零——代码从不读本插件自身任何版本号、无 semver 比较、无远端版本来源，`--dsh-version` 在 `dsh` 已存在时被静默忽略，升级只能"无脑全跑"，且全跑过程中安装目录与 `extension/node_modules` 是唯一两处无备份的破坏性替换。**只能修 3 处就修**：(1) step 3 的已装分支加版本比较与"要不要升级"询问，顺带让 `--dsh-version` 真的生效（约 6 行，直击用户第 7 条）；(2) `w.pause()` 返回 false 时仍跑一次 `probeHealth` 并把硬判据计入退出码（约 4 行，堵住"CI 报成功但从未复检"）；(3) step 2 的 `rmSync` 前对已存在的 `dest` 做一次 `.bak-before-reinstall`，并把 step 8 的 `confirm` 拒绝改为立即退出（约 6 行，消除唯一无备份破坏写 + 消除"拒绝写挂载却打印成功横幅"）。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=ce71e5efc2ca… audit=/Users/mac/.pimoa/spool/20260913T054441-moa_verify-51771-nh3ork-ce71e5efc2ca.md
