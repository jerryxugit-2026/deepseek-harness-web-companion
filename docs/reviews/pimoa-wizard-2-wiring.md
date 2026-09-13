# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`bootstrap/lib/layout.mjs`、`bootstrap/lib/dsh-root.mjs`、`bootstrap/lib/extension-id.mjs`、`bootstrap/lib/native-host-install.mjs`、`bootstrap/lib/profile-patch.mjs`、`bootstrap/lib/credentials.mjs`、`bootstrap/lib/yaml-scalar.mjs`、`tests/unit/bootstrap-layout.test.mjs`、`tests/unit/profile-patch.test.mjs`、`tests/unit/credentials-write.test.mjs`、`tests/unit/dsh-root.test.mjs`、`tests/unit/init-key-preserves-id.test.mjs`
- prompt：`scripts/review-prompts/wizard-2-wiring.md`
- 用时：409.8s
- 结果：（receipt 缺失：只有正文，没有可核对的结构化字段）
- 生成时间：2026-09-13T05:47:15.303Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

本片的路径参数化目标**基本达成**（`layout.mjs` 确为单一真源，`resolveLayout` 纯函数、按目标平台选分隔符、拒相对路径；`credentials.mjs`/`profile-patch.mjs` 纯文本进出，`records:` 保全与行级最小改动名副其实），但**接线层仍有两类真实伤害**：其一，`profile-patch.mjs` 的条目边界建立在「顶层 `- `」上，而实际条目是 `- insert:` 列表里的缩进项——只要用户按 HANDOFF 的指引把我们这一行手工加进**已有的** `- insert:` 段（夹具本身就演示了同段多条目的合法形态），`upsertCompanion` 会覆写邻居的 `name:`、`removeCompanion` 会整段删掉邻居，现有夹具恰好让这个 bug 表现为「正确」，属**测试形状掩盖缺陷**的典型，定为 BLOCKER；其二，`native-host-install.mjs` 在 `layout` 之外**又自算了一遍**清单路径（硬编码 `/`、丢 `env`），且把「未知平台/win32」统一折叠成 `manifestPath: null` 后静默跳过、照常返回成功，既造成 dry-run 与落盘分叉，也直接违反「不许假装成功」。叠加上「备份固定名、重跑即覆盖首次原件」与「5 个测试无一触达 `install.mjs`」，当前的绿灯不足以支撑「多轮实测过」的自我评价。

**若只能修 3 处**：(1) `profile-patch.mjs` 的条目定位改为按 `idAt` 的缩进块增删——只有该 `insert:` 段清空时才连段头一起摘，并补一条「同段含邻居条目」的夹具测试；(2) 删掉 `planNativeHostInstall` 内的清单路径二次拼装，令 `plan.manifestPath === layout.chromeManifestPath`，同时把「非数组」拆成 `registry===true`（win32，明确抛「不支持」）与其余未知平台（直接抛错），并补一条 darwin/linux(带 `XDG_CONFIG_HOME`)/win32 三平台的一致性断言——这一条同时咬住路径漂移、env 丢失、`browser: undefined` 与「假装成功」；(3) 把 `install.mjs` 的三处备份改为带时间戳且**首份原件只写一次**（`if (!existsSync(orig.bak)) copy(...)` 或 `.bak-<ISO>`），并在托管块整体替换时对「块内已有、本次未传」的键**保留并告警**而非静默删除。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| `cordis.patch.yml` 中我们的条目与别人共处同一 `- insert:` 段时的行为 | 提议A（pos2）判为 **BLOCKER**：`findEntrySpan` 的 span 是整个 `- insert:` 段，`removeCompanion` 会连邻居条目一起删；提议B（pos1）在 A-6/A-7 判为「N/A / 非常规、不是 bug」 | **采信 A，并加强** | 代码可直接证明：`TOP_ITEM = /^-(?:\s|$)/u` 只匹配行首 `- `，而条目是 `    - id:`（缩进 4），故 `span=[- insert:, 下一个顶层 -)`。除删除外，`replaceName(block,…)` 取的是 `block.findIndex(/^\s*name:/)`＝**段内第一个 name**，若我们不是第一条，`upsertCompanion` 会把别人的 `name: '@deepseek-ai/dsh-mcp-client'` 改写成我们的插件路径。B 只看到「第一个 name」却未推到这个后果 |
| 备份是否存在 | B 断言「**完全没有备份**（A-9, MAJOR）」；A 称「无法确认，可疑待验（D3）」 | **采信 A 的谨慎，并以实证定案** | 亲验 `bootstrap/install.mjs:462/552/576`：`copyFileSync(layout.profilePatch, \`${layout.profilePatch}.bak-before-companion\`)` 等三处确有备份 ⇒ B 的「完全没有」为**事实错误**；但备份名**固定不带时间戳**，重跑即用已改过的文件覆盖首次备份 ⇒ 原始状态丢失，这才是真缺陷 |
| `yamlScalar('+1')` 是否会不加引号导致类型漂移 | A（D7）称会写成 `key: +1` 被解析成整数 | **驳回 A** | `plain` 的第三个条件是 `!/^[+-]?\d+(\.\d+)?$/u.test(s)`，`'+1'` 命中该正则 ⇒ `plain=false` ⇒ 加引号。真正的缺口是它**没挡住** `1e5` / `0x10` / `.5`（字符集允许、十进制正则不命中） |
| `planNativeHostInstall` 丢 `env` 导致 `layout.chromeManifestPath` 与 `plan.manifestPath` 在 Linux 上指向两处 | 仅 A（A2）发现；B 未提 | **采信 A** | 源码逐字可证：`chromeNativeMessagingCandidates({ platform: layout.platform, homeDir: layout.homeDir })` —— 未传 `env`，而 `resolveLayout` 传了 |
| `runnerScript` 用双引号插值是否构成注入面 | 仅 B（B-6）发现；A 未提 | **采信 B（降级 MINOR）** | `exec "${nodePath}" "${hostEntry}"`：`sh` 双引号内 `$`、反引号仍展开；`hostEntry` 源自用户选的 `installDir`。触发需用户目录名含 `$(...)`，概率低但修复成本一行 |
| win32/未知平台被 `Array.isArray()` 混为一谈 | B（A-1）聚焦「未知平台被当成 Windows、静默假装成功」；A（A3）聚焦「`target.browser` 为 `undefined` 导致 `describeNativeHostPlan` 打印 `目标浏览器 undefined`」 | **两者合并采信** | 同一根因（非数组即当注册表）；B 的后果判断更重（违反「不许假装成功」），A 的证据更细（`if (plan.browser !== null)` 对 `undefined` 为真） |
| `applyPluginLinks` 先 `rm -rf node_modules` 再链接的危险度 | A（A6）判 MAJOR「留下空 node_modules 却像已装」；B（A-16）判 N/A | **采信 A 的机理，降为 MINOR** | 机理成立（`rm` 先于 `available` 判断）；但 `install.mjs:421` 注释与 `classifyMissingPluginDeps` 显示编排层对「必须同源的两个 `@deepseek-ai/*`」会当场停下，闸门存在 |
| `findDshRoot` 8 层上限 | B（A-2）MINOR 且自认本机够用；A 未提 | **采信 B（MINOR）** | 魔法数 8 无边界测试，`dsh-root.test.mjs` 只造了 4 层夹具 |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `profile-patch.mjs#upsertCompanion/replaceName` | 亲验（源码逐字） | 我们的条目若与别的插件共处同一 `- insert:` 段（DSH 格式允许，夹具第一段就是 semble+codegraph 同段），`block` 是整段，`replaceName` 改的是**段内第一个** `name:` ⇒ 静默把别人的 `name:` 覆盖成我们的插件路径 | `const at = block.findIndex((line) => /^\s*name:\s*/u.test(line))` |
| BLOCKER | `profile-patch.mjs#removeCompanion/findEntrySpan` | 亲验 | 同一根因：`splice(start, span.end - start)` 删的是整个 `- insert:` 段 ⇒ 卸载连带删掉同段的 mcp-semble / mcp-codegraph 等用户配置 | `const start = [...starts].reverse().find((s) => s <= idAt)`，`TOP_ITEM = /^-(?:\s|$)/u` |
| MAJOR | `install.mjs:552,576#备份策略` | 亲验（实读该文件） | 备份名固定 `.bak-before-companion` / `.bak-before-apikey`，`copyFileSync` 每次覆盖 ⇒ 第二次运行后**首次的原始状态永久丢失**，回滚提示 `cp … .bak-before-install …` 会回滚到一个已被改过的版本 | `if (existsSync(layout.profilePatch)) copyFileSync(layout.profilePatch, \`${layout.profilePatch}.bak-before-companion\`)` |
| MAJOR | `native-host-install.mjs#planNativeHostInstall`（路径二次拼装） | 亲验 | 同一清单路径在 `layout.chromeManifestPath`（`P.join`，按平台分隔符）与本处（硬编码 `/`）各拼一遍，违反「路径唯一真源」；dry-run 展示的与实际写入的可分叉 | ``manifestPath: chromeDir === null ? null : `${chromeDir}/${HOST_NAME}.json`,`` |
| MAJOR | `native-host-install.mjs#planNativeHostInstall`（丢 `env`） | 亲验 | 未透传 `env` ⇒ Linux 上 `XDG_CONFIG_HOME` 被忽略，`plan.manifestPath` 与 `layout.chromeManifestPath` 指向不同文件（macOS 不受影响） | `chromeNativeMessagingCandidates({ platform: layout.platform, homeDir: layout.homeDir })` |
| MAJOR | `layout.mjs#chromeNativeMessagingCandidates` ＋ `applyNativeHostInstall`（非数组＝注册表） | 亲验 | win32 与「未知平台」两条分支都落进 `Array.isArray(...)===false`，`manifestPath` 为 `null`，`applyNativeHostInstall` 直接跳过写清单并**正常返回** ⇒ 直接违反「Windows 可以不做，但不许假装成功」 | `return { registry: false, unsupported: platform, keyPath: () => null }` ＋ `if (plan.manifestPath !== null) { … }` |
| MAJOR | `install.mjs:257 vs :522#planNativeHostInstall` | 亲验 | 同一函数两处调用形状不一致，`:522` 传 `{ ...layout, homeDir }` 用当场重解析的 `homeDir` 覆盖 layout 的值 ⇒ 「计划」与「落地」可分叉，且无任何测试覆盖 | `const plan = planNativeHostInstall({ ...layout, homeDir }, { extensionId: extId, … })`（install.mjs:522） |
| MAJOR | `tests/unit/*`#整体覆盖面 | 亲验 | 5 个测试文件全部只测 lib 纯函数，无一执行 `bootstrap/install.mjs` ⇒「默认 dry-run 一字节不动」「每步先确认」「备份」「clean-up 顺序」全部**零回归保护** | 测试 import 清单只含 `../../bootstrap/lib/*.mjs` 与 `scripts/init-key.mjs` |
| MAJOR | `profile-patch.mjs#upsertCompanion`（托管块整体替换） | 亲验 | 托管块命中时整段 `renderBlock` 替换 ⇒ 上一轮用 `--set` 写入的键在本轮不传即被静默删除；测试第 12 节把该行为**固化为期望值**，与文档记录的 `approvalForWriteOps` 事故同型 | `all.splice(managed.begin, managed.end - managed.begin + 1, ...rendered)` |
| MINOR | `native-host-install.mjs#applyNativeHostInstall` | 亲验 | 用 `lastIndexOf('/')` 切父目录：win32 路径返回 `-1`，`slice(0,-1)` 得到「去掉末字符的整条路径」，会创建名为 `run-host.s` 的目录；应改 `dirname()` | `mkdirSync(plan.runnerPath.slice(0, plan.runnerPath.lastIndexOf('/')), { recursive: true })` |
| MINOR | `native-host-install.mjs#describeNativeHostPlan` | 亲验 | win32 下 `target.browser` 是 `undefined` 而非 `null`，`plan.browser !== null` 成立 ⇒ 打印 `目标浏览器   undefined`；`layout.mjs` 用 `? null :` 归一，两处规则不一致 | `browser: Array.isArray(candidates) ? target.browser : null,` ／ `if (plan.browser !== null) lines.push(...)` |
| MINOR | `native-host-install.mjs#runnerScript` | 亲验 | `sh` 双引号内 `$`/反引号仍展开，`hostEntry` 源自用户选定的 `installDir`；改用单引号并 `replaceAll("'", "'\\''")` 即可 | ``exec "${nodePath}" "${hostEntry}"`` |
| MINOR | `dsh-root.mjs#applyPluginLinks` | 亲验 | `rm(nodeModules)` 无条件先执行，`available` 全 false 时留下空 `node_modules` 且返回 `[]`；编排层有闸门（install.mjs:421 `classifyMissingPluginDeps`）故未升级 | `rm(nodeModules)` 位于 `for (const item of plan) { if (!item.available) continue …}` 之前 |
| MINOR | `yaml-scalar.mjs#yamlScalar`（控制字符） | 亲验 | 含 `\n` 的值被写成跨行单引号标量，在 `refs:` 的 2 空格缩进下续行落到列 0，极可能让整个 `.credentials.yaml` 解析失败；含 `\r` 时 `parseScalar` 会 `trim` 掉 ⇒ 幂等判定永远不成立、每次重写 | `if (plain) return s; return \`'${s.replaceAll("'", "''")}'\`` ＋ `parseScalar` 的 `String(raw ?? '').trim()` |
| MINOR | `yaml-scalar.mjs#yamlScalar`（数字外观） | 亲验 | 十进制守卫 `/^[+-]?\d+(\.\d+)?$/` 挡不住 `1e5` / `0x10` / `.5`，而字符集允许它们 ⇒ 下游 YAML 解析器可能读成数字（注：`+1` 已被正确引号化，提议中的该条不成立） | `const plain = /^[A-Za-z0-9_./+-]+$/u.test(s) && … && !/^[+-]?\d+(\.\d+)?$/u.test(s)` |
| MINOR | `tests/unit/credentials-write.test.mjs`#第 7 节 | 亲验 | 两条无效断言：`!import.meta.url.includes('.dsh/.credentials.yaml')` 恒真；`FIXTURE.includes('FAKE') && !FIXTURE.includes('sk-') === false` 因 `!` 优先级实为「含 sk-」，与其宣称的「值都是假值」语义相反 | `record('夹具里的值都是假值', FIXTURE.includes('FAKE') && !FIXTURE.includes('sk-') === false)` |
| MINOR | `tests/unit/bootstrap-layout.test.mjs`#第 8 节源码门禁 | 亲验 | 门禁只扫 `/Users/`、`/home/`、`C:\Users` 三种**绝对路径字面量**，抓不到本片真正的漂移（同一路径两处拼、硬编码 `/` 分隔符），却给出「已参数化」的安全感 | `for (const pattern of [/\/Users\//u, /\/home\//u, /[A-Za-z]:\\\\Users/u])` |
| MINOR | `tests/unit/bootstrap-layout.test.mjs`#build.mjs 反查 | 亲验 | `[^\]]*` 要求 `const STATIC = [...]` 写在一行，build.mjs 一旦折行即假红；断言目的正当但夹具脆 | `/const STATIC = (\[[^\]]*\])/u.exec(buildSrc)?.[1] ?? '[]'` |
| MINOR | `dsh-root.mjs#findDshRoot` | 亲验 | 向上 8 层是魔法数，`dsh-root.test.mjs` 只造 4 层夹具，无 8/9 层边界用例 | `for (let i = 0; i < 8; i += 1)` |
| MINOR | `extension-id.mjs#extensionIdFromKey` | 亲验 | 算法与 Chrome 规则一致（sha256(DER) 前 16 字节，nibble→`a..p`），但 `Buffer.from(x,'base64')` 静默丢弃非法字符、无长度 sanity，且全链路**没有**把算出的 ID 与 Chrome 实际加载的 ID 做校验闸门 | `createHash('sha256').update(Buffer.from(keyBase64,'base64')).digest('hex').slice(0, 32)` |
| MINOR | `profile-patch.mjs#MANAGED_CONFIG_KEYS` | 亲验 | 常量只列两键，`buildMountConfig.extra` 可写任意键 ⇒ dry-run 的「哪些键由我负责」会漏报 `--set` 键 | `export const MANAGED_CONFIG_KEYS = ['attachDir', 'approvalForWriteOps']` |
| MINOR | `native-host-install.mjs#applyNativeHostInstall`（非原子） | 亲验 | runner 已 `chmod 755` 写好后若清单写入抛错，异常穿透、`written` 丢失 ⇒ 留下「拉起器在、Chrome 找不到」的半截状态；`writeFileSync` 到 `.tmp` 再 `renameSync` 即可 | `writeFileSync(plan.runnerPath, plan.runnerBody); chmodSync(...); … writeFileSync(plan.manifestPath, ...)` |

**明确未覆盖**：`bootstrap/install.mjs` 全文（仅按符号抓取了 6 处调用/备份行）、`bootstrap/uninstall.mjs`、`bootstrap/doctor.mjs`、片 3 的交互与 `w.confirm` 实现；`scripts/init-key.mjs` 的公钥优先级实现体；`extension/manifest.json` 的权限与 native host 清单的对应关系；DSH 对 `cordis.patch.yml` 的真实 schema；Chrome ID 算法未联网复核（仅按已知规则比对）；本轮**未实际执行**任何测试，上述均为静态取证。

**被驳回的提议条目**（避免下游误信）：`yamlScalar('+1')` 类型漂移（不成立，已被数字守卫拦下）；「代码里完全没有备份」（不成立，install.mjs 有三处 `copyFileSync`，问题在固定名覆盖）；`applyPluginLinks` 会把 `target=null` 传进 `symlink`（不成立，`if (!item.available) continue` 在前）；`upsertRef` 空 `refs:` 块插入位置错误（不成立，`insertAt = range.start` 恰好正确）。

## 三、【最终裁决】


⚠️ [正文 9754 字符超回包预算 10000，已按行截取前 9800 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260913T054715-moa_verify-51771-4bm696-51bf6cf3c351.md（sha256=41f58610a0a7…，92348 字节，保留至 2026-09-27），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=51bf6cf3c351… audit=/Users/mac/.pimoa/spool/20260913T054715-moa_verify-51771-4bm696-51bf6cf3c351.md
