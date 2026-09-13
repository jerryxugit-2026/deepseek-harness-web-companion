# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`/tmp/wc-changes.patch`、`bootstrap/lib/probe.mjs`、`bootstrap/lib/checks.mjs`、`bootstrap/lib/health.mjs`
- prompt：`scripts/review-prompts/wizard-4-changes.md`
- 用时：491.8s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T06:06:26.959Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

这批改动的**判定层**（`probe.mjs` 验身份 / 三态、`checks.mjs` 未知态阻断与 ❓ 渲染、`checkDshCli` 版本读不出转 warn、`finishBanner` 分开"没查"与"没过"）与**数据安全层**（`findEntrySpan` 只圈一条、`removeCompanion` 邻居感知且要求同缩进、备份首份只写一次、`upsertCompanion` 保留旧键、`native-host` 用 `join()` 且非 mac 抛错）确实修对了各自声称的问题，其中 `pingPlugin` 的身份判据我已跨仓亲验与 `routes/ping.js` 的 `ok`/`plugin` 字段逐字对上，两份提议"只能采信 diff 自述"的那一格现在可以坐实。但**编排层的 `die()` 重写引入了一个比它修掉的任何问题都严重的新缺陷**：`process.exit` 被塞进异步 write 回调后 `must()` 不再终止程序，"失败就停"退化成"失败就吼一嗓子然后接着写盘"，最坏形态是 npm 下载失败后仍同步 `rmSync` + `symlinkSync` 造出一批坏链接，而"缺 `@deepseek-ai/*` 当场停下"这条本轮的招牌修复只靠 nextTick 早于微任务的实现细节侥幸成立——两份提议都没看到这一层，都给了"无 BLOCKER"，我不随多数。其次，`ws` 下载被拒时的静默 `return`、以及 `downloadable` 被挂在"要不要建链接"这个**别的**问句之下，使"依赖兜底"在最常见的交互路径上退回改动前的行为；`dist-port` 仍是 `soft`，缺 `check-dist-config.mjs`（＝安装目录不完整）照样 `✅ + exit 0`，PiMoa 片 3 那条 BLOCKER 只修了文案没修判定。**若只能修 3 处**：(1) `die()` 改成"先 flush 再退且**不返回**"——最小写法是 `must()`/各硬失败点在 `die(code)` 之后立即 `throw`（或让 `die` 内 `process.exitCode = code` 后 `throw`，由已有的 `uncaughtException` 兜底打印步号），恢复"决定失败即刻停止"的语义；(2) `linkDownloadablePluginDeps` 的拒绝分支由 `return` 改为与相邻 fatal 分支一致地硬失败，并把 `gaps.downloadable` 的处理提到"建立这些链接？"这个 confirm 之外单独问；(3) `dist-port` 在 `distOk === null` 时改 `soft: false`、`detail` 写明"未检查（缺 scripts/check-dist-config.mjs）"，并同步补上 `finishBanner([]).ok === false` 这条缺失的断言。

**未覆盖**：`bootstrap/install.mjs`、`wizard.mjs`、`profile-patch.mjs`、`yaml-scalar.mjs`、`native-host-install.mjs`、`dsh-root.mjs` 的**磁盘全文均未通读**（取证预算在第三次调用即耗尽），上述涉及这些文件的结论除 `dsh-root.mjs`/`layout.mjs:23` 外均以 diff 文本为据；`argOf`、`installPayload`、dry-run 出口的确切退出码、`uninstall.mjs` 是否清理 `.plugin-deps`、`doctor.mjs` 是否复用 `finishBanner`、`w.interactive` 是否被导出、三份单测的实际红/绿，全部未验；未执行任何测试或命令，无真终端（pty）验证。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `die()` 改写的后果 | 提议1：管道下 stdout 被 destroy 时可能丢退出码（可疑待验，MINOR）；提议2：空串 `write` 在包装过的 stdout 上可能不回调 ⇒ 死锁（可疑待验，MAJOR） | **两者都不采信，改判为更严重的确定性缺陷** | 两方都只盯着"能不能退出"，都漏了**`die()` 会 return**：流的 write 回调**永远异步**，`must()` 里原本同步终止的 `process.exit(3)` 变成了"打个招呼再回来"，调用点后面的同步代码（含 `rmSync`/`symlinkSync`）照跑。这是本批改动**新引入**的最重问题，见二 BLOCKER-1 |
| `linkDownloadablePluginDeps` 里用户答 n ⇒ 静默 `return` | 提议1：MAJOR（回到"等第 6.5 步才炸"，正是本次要消灭的形态）；提议2：未提，且断言该函数"已自洽" | **采信提议1** | diff 逐字可证 `if (!(await w.confirm(...))) return`，与紧邻的 `fatal` 分支（`must({status:1},…)` 硬失败）语义不对称 |
| `finishBanner([])` 的 `ok` 可能为 true、且单测没断言 `ok` | 提议1：MAJOR；提议2：未提 | **采信提议1（降为 MAJOR-潜伏）** | 单测逐字只有 `none.text.includes('硬判据没过') === false`，确无 `none.ok === false`；但第 11 步现在无条件跑 ⇒ install.mjs 侧暂时不可达，属"护栏本身没护栏" |
| `upsertCompanion` 的 `preserved` 无人消费 | 提议1：MINOR；提议2：未提 | **采信提议1并加强** | 不只是没打印：第 8 步那句"它不会自己去猜、请显式带上"的提示**已被这次改动作废**，代码与文案反向 |
| `parseScalar` 会把字面 `\\n` 误还原成真换行 | 提议2：可疑待验 MINOR；提议1：未提 | **驳回提议2** | 单趟 `/\\(.)/gu` 逐字模拟：`\`,`\`,`n` → 首次匹配吃掉 `\\` 产出 `\`，剩 `n` 原样 ⇒ 结果正是 `\n`（反斜杠+n），转义/反转义闭合。提议2 的推演有误 |
| 第 3 步"没装 DSH 就停"缺 `w.close()` | 提议2：MAJOR | **驳回（事实错误）** | diff 该 hunk 逐字含 `w.close()`：`w.warn('就此停下…')` → `w.close()` → `die(3)` |
| `uncaughtException` 处理器可能递归 | 提议2：MAJOR | **降为 MINOR·可疑待验** | 无可核对的触发路径（要 `w.warn` 自身抛），且 `die()` 已设定终止意图；但确实无递归哨兵 |
| `--install-dir=`（空值）会被当成"显式给了" | 提议2：MAJOR | **降为 MINOR·可疑待验** | `argOf` 未读，空串行为无证据；一行防御成本低，保留为待验 |
| ❓/emoji 列宽抖动、`checkDirectory` 双绿 | 提议2：MINOR ×2 | **驳回** | 前者是显示宽度的既有性质、非本批引入；后者 `missing⇒ok` 是"不存在就创建"的既定语义，与 `summarize` 自洽 |
| `pingPlugin` 验身份是否真能对上服务端 | 双方都只能"采信 diff 自述" | **亲验坐实** | `dsh-plugin/src/host/routes/ping.js` 逐字 `ok: true` / `plugin: 'dsh-web-companion-bridge'`，`bootstrap/lib/layout.mjs:23` `PLUGIN_ID = 'dsh-web-companion-bridge'` ⇒ 三个判据全命中，改动有效（但字面量两处各写一份，见 MINOR-6） |
| 总体是否存在 BLOCKER | 提议1、提议2 一致：无 BLOCKER | **不采信多数** | 见 BLOCKER-1，证据可从 diff 直接推出 |

一致且我认可的关键判断（两方无分歧、我复核通过）：`portListening` 三态与 `checkPort` 的 `!== true && !== false` 消费端对齐；`checkDshCli` 新分支插入位置正确；`summarize` 未知态阻断 + `renderChecks` ❓ 同批改到；`classifyMissingPluginDeps` 判据单一真源且单测钉死 `DOWNLOADABLE_PLUGIN_DEPS.join() === 'ws'`；下载点确在 `applyPluginLinks()` 之后且 dry-run 不可达；`findEntrySpan`/`removeCompanion` 的同缩进邻居判据与夹具形状匹配。

---

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `bootstrap/install.mjs#die` / `#must` / `#linkDownloadablePluginDeps` | 亲验（diff 逐字）+ 推理（流回调必异步） | `die()` 把 `process.exit` 塞进 write 回调后**同步返回**，`must()` 因此不再终止程序：npm 下载失败后**紧接着的同步 `for` 循环照样 `rmSync(linkPath)` 再 `symlinkSync` 出一批指向不存在暂存包的坏链接；"缺 `@deepseek-ai/*` 当场停下"那条也只靠 nextTick 早于微任务侥幸成立 | `try { process.stdout.write('', () => process.exit(code)) } catch { process.exit(code) }` 与 `must(...)` 末尾 `w.close(); die(3)`；下游 `must(run('npm',…), \`下载 ${needing.join('、')}\`)` 之后紧跟 `for (const name of names) { … rmSync(linkPath, …); symlinkSync(staged(name), linkPath, 'dir') }` |
| MAJOR | `bootstrap/install.mjs#linkDownloadablePluginDeps` | 亲验 | 用户对"现在下载到暂存区？"答 n ⇒ 静默 `return`，既不停也不标记，`ws` 仍缺 ⇒ 退回"写完一堆文件才在第 6.5 步以模块找不到失败"，正是本次声称消灭的形态 | `if (!(await w.confirm(\`DSH 里没有 ${needing.join('、')} —— 现在下载到暂存区？\`))) return` |
| MAJOR | `bootstrap/install.mjs`（第 3 步 `gaps.downloadable` 的消费位置） | 亲验 | `fatal` 在 `confirm` **之前**硬失败，而 `downloadable` 被塞进 `if (await w.confirm('建立这些链接？'))` 之内 ⇒ 用户拒绝建链接时缺 `ws` 这件事被整段跳过，两条路守卫位置不对称 | `if (await w.confirm('建立这些链接？')) { … if (gaps.downloadable.length > 0) await linkDownloadablePluginDeps(gaps.downloadable) }` |
| MAJOR | `bootstrap/lib/health.mjs#evaluateHealth('dist-port')` | 亲验（完整源码） | 本批只改了 `fix`/横幅文案，`soft: distOk === null` **原样保留** ⇒ 安装目录缺 `scripts/check-dist-config.mjs`（等于第 2 步复制不完整）时，横幅仍打"✅ 装好了，硬判据全过（两条）"并 `die(0)`；PiMoa 片 3 那条 BLOCKER 只修了一半 | `soft: distOk === null,` 与 `passed = items.filter((i) => !i.soft && i.ok)` |
| MAJOR | `bootstrap/lib/health.mjs#finishBanner`（空数组分支）＋ `tests/unit/install-health.test.mjs` 第 4 节 | 亲验 | 空数组时 `ok: !mountSkipped && autoDeclined === 0` 可为 **true**（"没复检也算成功"），而新增单测只断言文案、**没有一条断言 `.ok`** ⇒ 一旦有人把复检重新 gate 回去，回归网抓不到 | `return { ok: !mountSkipped && autoDeclined === 0, text: \`…本轮**没做复检**…\` }`；`record('★ 没复检时不许说"硬判据没过"…', none.text.includes('硬判据没过') === false)` |
| MAJOR（可疑待验） | `bootstrap/install.mjs`（第 11 步重试循环）↔ `bootstrap/lib/wizard.mjs` | 推理（wizard 返回对象未读全） | 新代码用 `if (w.interactive)` 门控"打开侧边栏再查一次"，但 diff 里 wizard 的返回对象**没有任何 hunk 暴露 `interactive`**；若未导出则该值恒 `undefined` ⇒ 真终端下重试循环永远不执行（软判据再也不会变 ✅）。验证：`rg -n "interactive" bootstrap/lib/wizard.mjs` | `if (w.interactive) { const proxyItem = () => health.find((i) => i.id === 'extension-proxy') … }` |
| MAJOR | `bootstrap/install.mjs`（第 8 步提示文案）↔ `bootstrap/lib/profile-patch.mjs#upsertCompanion` | 亲验 | 改动让 upsert **自动保留**旧 config 键并返回 `preserved`，但调用方既不打印 `preserved`，旁边那句"它不会自己去猜、请用 `--set` 显式带上"**仍在原地** ⇒ 代码与用户看到的说明相反，且 `preserved` 全仓无消费者（下次重构会连语义一起删） | `w.info('      若你之前设过别的键（例如 approvalForWriteOps: false），…它不会自己去猜。')` 与 `@returns {{ …, preserved: string[] }} \`preserved\` = …调用方应如实告诉用户` |
| MINOR | `bootstrap/lib/profile-patch.mjs#rehydrate` ↔ `bootstrap/lib/yaml-scalar.mjs#yamlScalar` | 亲验 | 同一批改动里 `yamlScalar` 的"像数字"判据放宽到 `1e5`/`0x10`/`.5`，`rehydrate` 却只认十进制整数/小数 ⇒ 旧块里的 `x: 1e5` 被读回成字符串、再写出成 `x: '1e5'`，配置在两轮之间自己漂 | `if (/^[+-]?\d+$/u.test(t)) return Number(t)` vs `const looksNumeric = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u.test(s) \|\| …` |
| MINOR | `bootstrap/lib/profile-patch.mjs#readBlockConfig` | 亲验 | `parseScalar` 丢掉"原来加没加引号"的信息，经 `rehydrate` 后 `k: '5'`（有意的字符串）会被保留成 `k: 5`（数字）——"保留旧键"顺手改了它的类型 | `out[m[1]] = rehydrate(parseScalar(m[2]))` |
| MINOR | `bootstrap/lib/yaml-scalar.mjs#yamlScalar` | 亲验 | 控制字符分支只转义 `\\ " \n \r \t`，其余 C0/DEL（`\u0000-\u0008`、`\u000b`、`\u007f`…）被**原样**塞进双引号串 ⇒ 仍是非法 YAML，判据（正则包含它们）与处置（只转 3 个）不匹配；最小修法：兜底 `\xNN` | `if (/[\u0000-\u001f\u007f]/u.test(s)) { const escaped = s.replaceAll('\\\\','\\\\\\\\')…` |
| MINOR | `bootstrap/lib/profile-patch.mjs#findEntrySpan` / `#removeCompanion` | 亲验 | 新的 span 以 `id:` 那行为起点、以"同缩进 `- `"为邻居判据：用户按 HANDOFF 手写成 `- name: …` 在前、`id:` 在后时，条目的破折号行既被当成"邻居"（段头摘不掉）又留在文件里（卸载后残留半条） | `const idAt = all.findIndex((line) => idLinePattern(id).test(line)); … return { start: idAt, end, idAt }` |
| MINOR | `bootstrap/install.mjs`（第 3 步 fatal 分支） | 亲验 | 用伪造的 `{ status: 1 }` 借道 `must()` 表达"这不是命令失败"，今天只因 `must` 只读 `.status` 才成立；直接 `die(3)`（或让 `must` 接受 `null`）更稳 | `must({ status: 1 }, \`插件依赖检查（缺 ${gaps.fatal.join('、')}）\`)` |
| MINOR-6 | `dsh-plugin/src/host/routes/ping.js` ↔ `bootstrap/lib/layout.mjs:23` | 亲验（两处逐字比对） | 身份判据依赖的 `dsh-web-companion-bridge` 在插件侧是**写死的字面量**、在引导侧是 `PLUGIN_ID` 常量，两份各改一处就会让所有安装都报"本插件没应答"；插件侧应引用同一常量 | `plugin: 'dsh-web-companion-bridge',` 与 `export const PLUGIN_ID = 'dsh-web-companion-bridge'` |
| MINOR | `bootstrap/install.mjs`（退出码） | 亲验 | `--help` 声明 `3 中途失败`，而收尾 `die(banner.ok ? 0 : 3)` 把"安装步骤全成功、只是 DSH 还没起/扩展还没装"也判成 3 ⇒ 自动化无法区分"装坏了"与"装好了但还没跑起来"；另 `process.exit(1)/(2)` 数处未换成 `die()`，flush 理由不自洽 | `die(banner.ok ? 0 : 3)`；`if (!go) { w.close(); process.exit(2) }` |
| MINOR（可疑待验） | `bootstrap/install.mjs#argOf('install-dir', null)` | 推理（`argOf` 未读） | 若 `--install-dir=`（空值）返回 `''` 而非 `null`，`installDirArg === null` 不命中 ⇒ 不问也不报错，`resolve('')` 落到 cwd。验证：`node bootstrap/install.mjs --install-dir=` 看计划里的路径 | `const installDirArg = argOf('install-dir', null)` |
| MINOR（可疑待验） | `bootstrap/install.mjs#process.on('uncaughtException'…)` | 推理 | 处理器内 `w.warn`/`console.error` 若自身抛出会再次进入同一处理器，无哨兵；一行 `if (dying) return` 即可 | `process.on('uncaughtException', (error) => { w.warn(…); console.error(error); die(3) })` |
| MINOR | `tests/unit/install-health.test.mjs`（`unchecked` 那组） | 亲验 | `unchecked.text.includes('产物端口') === false` 只证明"没进硬判据括号"，不证明它被如实标注为"未检查"；真正的语义（未检查 ≠ 软失败）没有断言咬住 | `record('★ 没查过的判据不许出现在"硬判据全过（…）"括号里', unchecked.text.includes('产物端口') === false)` |
| MINOR | `extension/src/content/extract.fn.js#walkChildren` | 亲验（diff） | 形状②的修法本身正确（`previousText` 只在 `nodeType === 3` 时赋值，注释节点不会污染），但这段逻辑**至今只有真站点探针覆盖、没有单测**——同一处已经因"夹具从渲染文字反推"漏过一次，回归风险仍在 | `if (isElement && (previousWasElement \|\| (endsWithWord(previousText) && startsLikeWord(child)))) out.push(' ')` |

---

## 三、【最终裁决】


⚠️ [正文 9794 字符超回包预算 10000，已按行截取前 9840 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260913T060626-moa_verify-51771-etvw8r-e879eb2da861.md（sha256=86bf21430bc6…，62299 字节，保留至 2026-09-27），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=e879eb2da861… audit=/Users/mac/.pimoa/spool/20260913T060626-moa_verify-51771-etvw8r-e879eb2da861.md
