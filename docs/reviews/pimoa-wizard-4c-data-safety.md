# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`/tmp/wc-changes.patch`、`bootstrap/lib/profile-patch.mjs`、`bootstrap/lib/wizard.mjs`、`bootstrap/lib/yaml-scalar.mjs`、`bootstrap/lib/dsh-root.mjs`、`tests/unit/profile-patch.test.mjs`、`tests/unit/dsh-root.test.mjs`、`tests/unit/install-health.test.mjs`
- prompt：`scripts/review-prompts/wizard-4-changes.md`
- 用时：475.3s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T06:06:10.922Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

这批改动的方向正确，9 条声称里 7 条在代码层面确实落地（`classifyMissingPluginDeps` 的两路分流与"下载必须在 `applyPluginLinks` 之后"的顺序、`portListening` 三态、`summarize`/`renderChecks` 的未知态、`finishBanner` 区分"没查"与"没过"、`askLine` 与 `secret()` 的 EOF 守卫、`findEntrySpan` 的条目级范围、`upsertCompanion` 的配置保留与 `preserved`、三处备份只写首份、`join()` 与 `manifestPath===null` 抛错），提议2 对"两条 BLOCKER 已修"的整体判断在**多数形状上**成立；但两份提议都漏掉了本次最重的一处：`removeCompanion` 在"我方与邻居同段 + 段头上方有我方说明注释"这一真实形状下，连续区间 splice 会把段头与邻居一并删除——**它修掉的是段级 splice，却在注释摘除路径上重新造出了同一种用户数据损坏**，而新加的 §13 测试恰好用了一个没有前导注释的段，属于典型的"夹具形状掩盖缺陷"。其次是两处语义自相矛盾：第 3 步宣称"什么都没装成"时安装目录早已被 mkdir + 覆盖复制；收尾把"复检未过"与"安装中途失败"合并成 exit 3，而新装完成后 DSH 尚未重启时硬判据必然不过，等于把旧的假绿换成了稳定的假红。再次是覆盖面——本批最容易悄悄退回的那些分支（`pingPlugin` 身份校验、`portListening`/`checkPort` 三态、`secret()` EOF、下载顺序）一条回归都没有，而同批提交的 `m4-site-quality.json` 里新断言就明明白白是 `false`，与 CHANGELOG 的"24/24 绿"直接打架，说明"实测过"的自我叙述在这一轮仍不能全信。**只能修 3 处就修**：(1) `removeCompanion` 的 `else` 分支改用 `span.start`（注释摘除只在整段删除时生效），并把 §13 的共享段夹具补上前导 "DSH Web Companion" 注释；(2) 把 `findDshRoot`/`planPluginLinks`/`classifyMissingPluginDeps` 这组只读探测前移到打印计划之前判 `fatal`，让"当场停下、这一轮什么都没装成"名副其实，顺带把该处 `must({status:1})` 换成显式 `die(2)`；(3) 给 `pingPlugin` 的身份判据补一条不走 mock 的最小回归（假 HTTP 服务分别返回 404-JSON、`{ok:true,plugin:'别的'}`、真实形状），并把末尾的退出码拆开——安装步骤全成功但复检未过应与"中途失败"用不同的码，否则每次正常安装都会给自动化一个红灯。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `removeCompanion` 的"有邻居"分支是否安全 | 提议2 逐步推演后判 **✅ 已确认正确**（"删掉说明注释 + 我们这一条，邻居仍在"）；提议1 未提 | **两者都不采信 —— 实为 BLOCKER** | `splice(start, span.end - start)` 删的是**连续区间**：当 `dropLeadingComment` 把 `start` 上提到段头**之上**的注释行、而我们的条目又在邻居**之后**时，这一刀会把段头 + 全部邻居一起带走（详见 §二 第 1 行）。提议2 的推演错在"以为 splice 能跳过中间的邻居" |
| `die()` 的 flush 是否兑现 | 提议1：destroyed 流上 cb 可能永不触发（挂死）；提议2：**"`write('')` 是 no-op，Node 20/22 实测 cb 不调用"** | **均降为【可疑待验】**，并点名提议2违规 | 两方都没有跑过任何命令，提议2把推测写成"实测"，违反"不许把可疑写成已确认"。可确认的只有一件事：崩溃兜底里的 `console.error(error)` 走 **stderr**，而 `die()` 只 flush stdout |
| `uncaughtException` 兜底里 `w` / `currentStepTitle` 是否 TDZ | 提议2：TDZ ⇒ 崩在 `createWizard` 前会甩原生栈 | **驳回提议2** | diff 顺序是 `const w = createWizard(...)` → `let currentStepTitle = '（还没开始）'` → `process.on(...)`，注册时两个绑定都已初始化，不存在 TDZ。真问题是注册时机：两处 `await w.ask()` 发生在注册**之前**（见 §二） |
| `PLUGIN_ID` 是否真被 `layout.mjs` 导出 | 提议2 列为"接线前提·可疑待验，可能让硬判据永远 ❌" | **前半驳回、后半采纳** | 本次材料内就有反证：`tests/unit/profile-patch.test.mjs` 逐字写着 `import { PLUGIN_ID } from '../../bootstrap/lib/layout.mjs'` ⇒ 导出存在。真正未验的是 `/ag/ping` 响应是否含 `ok:true` 且 `plugin` 恰等于该常量 |
| `linkDownloadablePluginDeps` 里的 `rmSync/symlinkSync` 是否泄漏进 dry-run | 提议1：不泄漏，并指出注释里"第 276 行"已漂到 322；提议2：**可疑待验，"patch 没给 step 3 上下文"** | **采信提议1** | 提议1 给出了可核对的行号（`if (DRY_RUN)` 出口在 step 1 之前），且该函数只在 step 3 的 confirm 分支内被调用；注释行号漂移单独记 MINOR |
| "当场停下（这一轮什么都没装成）"是否属实 | 提议1：MAJOR，第 1/2 步已写盘；提议2 未提 | **采信提议1** | step 1 的 `mkdirSync` 与 step 2 的复制都排在 step 3 之前，文案与事实冲突 |
| `must({ status: 1 })` 伪造子进程退出码 | 提议1：MAJOR；提议2 未提 | **采信提议1，定 MINOR** | 后果是文案失真 + 退出码用 3 而非本次新定义的 2，不造成数据损坏 |
| `docs/reviews/m4-site-quality.json` 里新断言为 `false` | 提议1：标【可疑待验】；提议2 未提 | **采信提议1，并升格为已确认的"制品/声称冲突"** | diff 逐字可见 `"表单页：文本+内联元素不粘连…": false`，而同批 CHANGELOG 写"24/24 绿、咬合验证通过"——二者不可能同时为真 |
| `yamlScalar` 控制字符修复是否完备 | 双方都判 ✅ | **均不完全采信** | 守卫命中 `[\u0000-\u001f\u007f]`，但只转义了 `\n \r \t \" \\`，其余控制字符原样落进双引号标量 |
| 本批新分支的回归覆盖 | 提议1：指出 `preflight-checks.test.mjs` 未在 diff 内、`secret()` EOF 无测试；提议2：只说"测试咬合验证明确" | **采信提议1并扩展** | diff 的文件清单里确实没有 `preflight-checks.test.mjs`、没有 probe 的测试；`install-health.test.mjs` 用 `fakePing` 整体绕过了新的身份校验 |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| **BLOCKER** | `bootstrap/lib/profile-patch.mjs#removeCompanion` | 亲验（提供的源码全文） | 当我方条目**与邻居同段**且段头**上方有提到 "DSH Web Companion" 的注释**时，`start` 被上提到注释行，而 `span.end` 在邻居之后 ⇒ 连续区间 splice 把段头与全部邻居一起删掉（我方在首位时则留下无父的孤儿条目 ⇒ YAML 结构破坏）——正是本次声称修掉的那条 BLOCKER，只是换了触发形状；§13 测试用的共享段**没有前导注释**，恰好躲开 | `let at = (segment?.start ?? span.start) - 1` … `if (sawComment && mentions) start = at + 1` … `} else { all.splice(start, span.end - start) }`。最小修：`else` 分支改用 `span.start`（注释摘除只留给整段分支） |
| **MAJOR** | `bootstrap/install.mjs#step3`（缺 DSH / `gaps.fatal` 两处停机） | 亲验（diff 步骤顺序） | 文案 `就此停下（这一轮什么都没装成）` 与 `不改动你的 DSH 挂载` 在此处为假：step 1 的 `mkdirSync(layout.installDir)` 与 step 2 的源码替换已经执行（升级场景下用户安装目录已被换成新版、依赖却是坏的）。只读探测（`findDshRoot`/`planPluginLinks`/`classifyMissingPluginDeps`）完全可以前移到打印计划之前再判 | `+      w.warn('就此停下（这一轮什么都没装成）。装好 DSH 后重跑本程序即可。')` |
| **MAJOR** | `bootstrap/install.mjs#收尾` + `lib/health.mjs#finishBanner` | 亲验（控制流）+ 推理（后果） | 复检不再被 `pause()` gate 住之后，末行是 `die(banner.ok ? 0 : 3)`，而硬判据要求"**本插件**在端口应答"——全新安装刚写完挂载、DSH 尚未重启时必然不应答 ⇒ **一次正确的安装稳定退出 3**（且 3 的定义是"中途失败"，与"步骤跑完但没复检过"不是一回事）。这是把旧的假绿换成了新的假红 | `die(banner.ok ? 0 : 3)`；`ok: hardOk && !mountSkipped && autoDeclined === 0` |
| **MAJOR** | `bootstrap/lib/probe.mjs#pingPlugin` | 亲验（代码）+ 【可疑待验】（协议） | 新身份判据 `res.ok && body.ok === true && body.plugin === PLUGIN_ID` 三项**全未被任何测试覆盖**（`install-health.test.mjs` 注入 `fakePing` 直接绕过它）；只要 `/ag/ping` 不返回 `ok` 字段、或 `plugin` 值与 `PLUGIN_ID` 不同字面量，`reachable` 永远 false ⇒ 预检会说"端口被别人占用"、收尾永远红。验证：`rg -n "'/ag/ping'" -A20 dsh-plugin/src/host/index.js` 或 `curl -s 127.0.0.1:3080/ag/ping` | `const isOurs = res.ok === true && body?.ok === true && body?.plugin === PLUGIN_ID` |
| **MAJOR** | `tests/unit/*`（本批新分支的覆盖面） | 亲验（diff 文件清单） | 声称修好、却**零回归保护**的分支：`portListening` 三态、`checkPort` 的 `listening===null`、`checkDshCli` 版本读不出、`summarize` 未知 status、`renderChecks` 的 `❓`、`dirStatus` 的根不可写、`secret()` 的 `inputClosed/readableEnded` 守卫、以及"下载必须在 `applyPluginLinks` 之后"的顺序约束——diff 里没有 `preflight-checks.test.mjs`，`wizard-interaction.test.mjs` §8 只测了 `confirm/ask/pause` | diff 仅含 `dsh-root/install-health/profile-patch/wizard-interaction` 四个测试文件 |
| **MAJOR** | `docs/reviews/m4-site-quality.json` vs `docs/CHANGELOG.md#v3.45` | 亲验 | 同一批提交里，制品记录新断言 **false**，而 CHANGELOG 声称"23 → 24 条断言、24/24 绿、咬合验证 hash 一致"。要么制品是修复前的陈旧快照（那就该重跑后再提交），要么 `extract.fn.js` 的形状②修复实际没生效。验证：`npm run probe:sites` 后 diff 该 json | `+    "表单页：文本+内联元素不粘连（不许出现 Owner(required)，应为 Owner (required)）": false,` |
| MINOR | `bootstrap/install.mjs#must` 调用点 | 亲验 | 用伪造的 `{ status: 1 }` 借道 `must()` 表达"前置条件不满足"，用户会看到不存在的 `失败（exit 1）`，且按本次新写进 `--help` 的约定应退 **2** 而非 3 | `must({ status: 1 }, \`插件依赖检查（缺 ${gaps.fatal.join('、')}）\`)` |
| MINOR | `bootstrap/lib/health.mjs#finishBanner`（空数组分支）+ `install-health.test.mjs` | 亲验 | 复检已不再被跳过 ⇒ 该分支在 `install.mjs` 里实际不可达，文案"非交互环境跳过了第 11 步"已过期；测试把这段陈述固化成期望值，后续读者会据此误判控制流 | `text: \`…本轮**没做复检**（非交互环境跳过了第 11 步）…\`` |
| MINOR | `bootstrap/install.mjs#esbuildRange` | 亲验 | 注释宣称"单一真源"，但 `?? '^0.25.0'` 与 `catch { return '^0.25.0' }` 又写死了两份，且读的是**安装目录**那份（step 2 被拒或该 payload 项缺失时静默退回硬编码、无任何提示） | `catch { return '^0.25.0' }   // 读不到就退回已知可用的范围` |
| MINOR | `bootstrap/lib/yaml-scalar.mjs#yamlScalar` | 亲验 | 守卫命中整段控制字符，却只转义 `\n \r \t \" \\`，其余（如 `\u0007`、`\u007f`）原样写进双引号标量 ⇒ 仍可能让 `.credentials.yaml` 解析失败。最小修：统一 `.replace(/[\u0000-\u001f\u007f]/gu, c => '\\x' + hex2(c))` | `if (/[\u0000-\u001f\u007f]/u.test(s)) { … .replaceAll('\t', '\\t') ; return \`"${escaped}"\` }` |
| MINOR | `bootstrap/install.mjs#die` | 推理（两方均未实证） | "先 flush 再退"的可靠性依赖 `write('', cb)` 的回调语义；更确定的缺口是崩溃兜底把栈打到 **stderr** 而 `die()` 只处理 stdout。最小修：`process.exitCode = code` + `w.close()` 让 Node 自然退出 | `try { process.stdout.write('', () => process.exit(code)) } catch { process.exit(code) }` |
| MINOR | `bootstrap/install.mjs#uncaughtException/unhandledRejection` 注册时机 | 亲验 | 两个 handler 注册在两处 `await w.ask()` **之后**，所以"问你装到哪个目录"这一段若抛异常仍是裸栈；另外 step 7 的 `applyNativeHostInstall(plan)` 新增的 `throw`（非 mac）没有 try/catch，把一条**设计好的用户可见错误**降级成崩溃通道 + 完整栈 | `let currentStepTitle = '（还没开始）'` 紧邻的 `process.on('uncaughtException', …)` 在 `await w.ask(...)` 之后 |
| MINOR | `bootstrap/lib/wizard.mjs#autoDeclined` → `finishBanner` | 亲验 | 计数只在 `confirm()` 自增，且 **EOF 路径也自增**，但横幅文案写死"在非交互环境下按「否」处理…要真装请加 --yes"——用户在真终端按 Ctrl-D 时这句建议是错的（判定方向仍安全） | `if (raw === null) { autoDeclined += 1; write('  （输入已关闭 ⇒ 按默认 No 处理）'); return false }` |
| MINOR | `bootstrap/install.mjs#linkDownloadablePluginDeps` 注释 | 亲验 | 注释里的"dry-run 在第 276 行就退出了"已漂到 322；这类易腐行号正是上一轮审核点名的病灶，改成"见上方 `if (DRY_RUN)`"即可 | `* 本函数只在 apply 路径上可达（dry-run 在第 276 行就退出了）` |
| MINOR | `bootstrap/install.mjs#linkDownloadablePluginDeps` | 亲验 | 用户对"现在下载到暂存区？"答 n 时直接 `return`，既不 warn 也不置标志，要到第 6.5 步导入自检才以模块找不到失败——与本次修复的初衷（别让失败发生在写了一堆文件之后）同型 | `if (!(await w.confirm(\`DSH 里没有 … 现在下载到暂存区？\`))) return` |
| MINOR | `tests/unit/install-health.test.mjs#record` / `dsh-root.test.mjs` 节号 | 亲验 | `results[name] = value` 以断言**名**为键，而 `'总判定失败'` 在该文件出现 3 次 ⇒ 后写覆盖先写，**一条早先的红可以被同名的绿掩盖**，"45 → 52 断言"的计数也因此不实；另有两处重复节号（`install-health` 出现两个 `4.`、`dsh-root` 出现两个 `5.`） | `record('总判定失败', overallOk(down) === false)` / `record('总判定失败', overallOk(badDist) === false)` |
| MINOR【可疑待验】 | `bootstrap/uninstall.mjs` vs 新增 `<安装目录>/.plugin-deps` | 推理（未读 uninstall.mjs） | 新暂存区不在 `installPayload()` 清单内；若卸载按清单反向删除，下载物会残留。验证：`rg -n "plugin-deps\|installPayload" bootstrap/uninstall.mjs` | `const stage = join(layout.installDir, '.plugin-deps')` |

**未覆盖**：`bootstrap/lib/checks.mjs` 的 `checkChrome`/`checkDirectory`/`checkNode`/`checkMount` 实现体、`layout.mjs`/`credentials.mjs`/`extension-id.mjs` 全文、`install.mjs` 第 1/2/5/6/7 步的完整函数体（只见 diff 节选）、`uninstall.mjs`/`doctor.mjs`、`scripts/init-key.mjs`、`dsh-plugin` 的 `/ag/ping` 实现、`extract.fn.js` 修复的真实效果；**本轮未执行任何测试或安装流程**，全部结论来自 diff 与所给源码的静态核对。

## 三、【最终裁决】


⚠️ [正文 9247 字符超回包预算 10000，已按行截取前 9293 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260913T060610-moa_verify-51771-5w4pup-23635cf0134c.md（sha256=597c1acfae47…，71855 字节，保留至 2026-09-27），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=23635cf0134c… audit=/Users/mac/.pimoa/spool/20260913T060610-moa_verify-51771-5w4pup-23635cf0134c.md
