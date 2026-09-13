# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`tests/protocol/contract.test.mjs`、`tests/quality/audit-captures.mjs`、`tests/quality/probe-sites.mjs`、`tests/unit/agent-selection.test.mjs`、`tests/unit/audit-fields.test.mjs`、`tests/unit/audit-log.test.mjs`、`tests/unit/browser-tools.test.mjs`、`tests/unit/capture-routing.test.mjs`、`tests/unit/client-attach.test.mjs`、`tests/unit/frame-budget.test.mjs`、`tests/unit/menu-trigger.test.mjs`、`tests/unit/panel-errors.test.mjs`、`tests/unit/retention.test.mjs`、`tests/unit/rotate.test.mjs`、`tests/unit/tickets.test.mjs`、`tests/unit/write-gate.test.mjs`
- prompt：`scripts/review-prompts/code-adversarial.md`
- 用时：342.7s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:19:01.744Z

---
## 一、【冲突点与采信】

| # | 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|---|
| 1 | 被审代码是否可取证 | 提议A：本仓库无 `extension/`、`dsh-plugin/`，判「代码不存在」；提议B：在审计根外、读不到 | **均不采信** | 我亲验到被审对象在跨仓只读根内：`/Users/mac/ai_tools/dsh project/网页插件/{extension,dsh-plugin,native-host,protocol,scripts,tests}` 全部存在且可读。两方结论均建立在错误的取证前提上，凡以「目录不存在/读不到」为由给出的「证据不足」一律重判 |
| 2 | 声称3（右键菜单 trigger） | A：**被证伪**，`validateAs` 是「自证 X 验 X」，任何字符串都绿；B：**成立（部分）**，喂的是实现真实发出的值、校验器来自 schema | **采信 B** | A 的推理是错的：`validateAs('AttachRequest', {trigger: value})` 把 value 对照 **schema 的 enum** 校验，不是对照自身。若实现回退成 `'contextmenu'`，该断言必红。另亲验 `extension/src/sw/menu.js:34` `return capture({ mode, trigger: 'manual' })` 与 `protocol/messages.schema.json:308-311` `"look_left","button","shortcut","manual"` —— 值确在枚举内 |
| 3 | 声称2（看左边 episode）假绿性质 | A：「删掉关键词→不触发」与「再写一次→触发」两条恒真、无法区分实现；B：sniff 是纯函数、真实草稿事件接线被桩空 | **采信 B** | A 事实有误：第二条断言期望 `=== true`，一个「永不重新武装」的实现会让它红，两条并非同值。B 指出的缺口（`document.addEventListener: () => {}`、`globalThis.setInterval = () => 0`）才是真缺口 |
| 4 | retention「不递归进子目录」是否假绿 | A：恒真（`list().includes('sub')` 只证目录条目在）；B：未列为假绿 | **部分采信 A** | 单看该断言确实弱，但同节 `swept.removed.length === 3` 会在递归删除嵌套文件时变成 4 而变红 —— 组合后仍有真保护。降级为 MINOR，不算假绿 |
| 5 | audit-log「有界」断言 | A：未深究；B：`size <= 400 + 300` 靠算术巧合，「完全不轮转的实现也可能满足」 | **部分采信 B** | 余量是否覆盖单条最大长度确实未被断言（这点成立）；但「不轮转也能绿」不成立——41 条含 ISO 时间戳的 JSONL 必远超 700B。另亲验 `dsh-plugin/src/host/audit.js:73` 默认 `maxBytes = 512*1024, keepLines = 1200`，与测试传入的 400/5 是两套数量级，测试未覆盖默认档 |
| 6 | 声称1 的真实链路是否零断言 | A：泛泛判「代码不存在」；B：`capture-routing` 用自造 `attachEvent()`，真实 `/ag/attach` 链路零断言 | **采信 B，但需修正** | 亲验 `dsh-plugin/src/host/routes/attach.js:85` 注释 `This used to be hub.push(event) — a broadcast` 与 `:92` `const delivered = hub.pushClientPrimary(event, resolveOwner(payload.captureId))` —— 接线**确实存在**，B 的「可能从未被调用」被排除；但「一次抓取只建一个会话」在任何测试里仍无断言，缺口成立 |
| 7 | 声称5（dist 端口门禁） | A：`scripts/` 不存在→证据不足；B：门禁无样本，但 probe 会改写 `dev-config.js` 且吞掉构建失败 | **采信 B 的发现，驳回 A 的前提** | `scripts/` 目录亲验存在（未读内容，故门禁行为仍未证实）；B 从给定源码中挖出的 `catch { /* ignore */ }` + `cpSync(EXT_DIST, EXT_COPY)` 降级路径是本轮最有价值的独立发现 |
| 8 | `record()` 三态陷阱 | 只有 B 提出 | **采信 B** | 全部测试共用 `filter(([, v]) => v === false)` 而渲染有 `'·'` 分支 —— 非布尔值静默计为通过，是系统性假绿温床 |

## 二、【逐条裁决】

| 级别 | 文件#符号 | 证据强度 | 理由 | 行号/原文 |
|---|---|---|---|---|
| BLOCKER | `tests/quality/probe-sites.mjs#restore/build` | 亲验（测试文本） | 探针改写生产源码后，构建失败被吞、继续拷贝陈旧 `dist`，且 `restore()` 只挂 `process.on('exit')`，kill -9 后源码永久留在探针端口 —— 正是声称5 要防的事 | `try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }` 紧接 `cpSync(EXT_DIST, EXT_COPY, { recursive: true })` |
| BLOCKER | 声称7 第三层 `extension` 侧 allowWrite 复核 | 推理 | 全套测试对「扩展侧收到 `allowWrite!==true` 时拒绝」断言数为 0；现有断言只证插件**打了标**，一个完全忽略该字段的扩展照样全绿 | `record('只读帧不带 allowWrite', (await offlineTools.find(...).execute({}, {}), offlineHub.calls.every((c) => c.allowWrite !== true)))` |
| MAJOR | 声称1 `hub.pushClientPrimary` / `attach.js` | 亲验 + 推理 | 接线真实存在（`attach.js:92`），但「一次抓取只建一个会话」的**会话计数**在 `capture-routing`（自造事件）与 `probe-sites`（0 条会话断言）里均无断言 —— 事故面未被钉 | `attach.js:92` `const delivered = hub.pushClientPrimary(event, resolveOwner(payload.captureId))` |
| MAJOR | 声称2 `client.sniff` episode | 亲验（测试文本） | 6 条断言全部直接调纯函数；`document.addEventListener`/`querySelector`/`setInterval` 全被桩空，「草稿变更 → sniff」这根真实的线断掉时 6 条全绿 | `globalThis.setInterval = () => 0`；`document = { querySelector: () => null, addEventListener: () => {} }` |
| MAJOR | `tests/protocol/contract.test.mjs#codegen --check` | 亲验（测试文本） | 「逐字节匹配」全部外包给子进程退出码，没有任何负面测试（篡改产物后断言非 0）—— 守卫本身无守卫 | `check('codegen --check 通过（产物逐字节匹配 schema）', codegen.status === 0, ...)` |
| MAJOR | `dsh-plugin/src/host/audit.js#createAuditLog` 有界性 | 亲验（源码+测试） | 测试只跑 `maxBytes:400/keepLines:5` 的极端档，默认档 `512*1024/1200` 从未被验证；且余量 `+300` 是否覆盖单条最大长度无断言；并发 append 0 断言 | `audit.js:73` `createAuditLog({ file, maxBytes = 512 * 1024, keepLines = 1200, ... })` vs 测试 `size <= 400 + 300` |
| MAJOR | 全部测试 `#record()` | 亲验（测试文本） | `filter(([, v]) => v === false)` + `'·'` 三态渲染：`undefined`/`null`/字符串一律不计失败，任何漏写 `=== true` 的断言静默变绿 | `console.log(\`  ${value === true ? '✅' : value === false ? '❌' : '·'}\`)` 与 `filter(([, v]) => v === false)` |
| MINOR | 声称3 `extension/src/sw/menu.js#handleMenuClick` | 亲验（源码+schema） | trigger 值确在枚举内、且测试用同一生成校验器喂真实值（**A 的「自证」指控不成立**）；但首条 `value !== 'contextmenu'` 是否定式弱断言，第 4 节只数请求条数不校验 body | `menu.js:34` `return capture({ mode, trigger: 'manual' })`；schema:308-311 含 `"manual"` |
| MINOR | 声称3 端到端「能落盘」 | 推理 | 校验器认可 ≠ 路由接收 + 落盘；`/ag/attach` 返回 200/400 与文件真实写出在菜单路径上无断言 | `menu-trigger.test.mjs` 止于 `validated.ok === true` |
| MINOR | `tests/unit/retention.test.mjs#不递归` | 亲验（测试文本） | `list().includes('sub')` 单独看恒真，但同节 `swept.removed.length === 3` 能挡住递归删除 —— 弱而非假绿；并发落盘（写入中的 `.md`）窗口 0 断言 | `record('不递归进子目录', list().includes('sub'))` + `record('报告里 removed 数量 = 3', swept.removed.length === 3)` |
| MINOR | `tests/unit/browser-tools.test.mjs#output schema` | 亲验（测试文本） | 哨兵 `value?.code === undefined` 对 `undefined`/`{}` 也绿（真正兜底是紧邻的 schema 校验）；未断言三个工具的 schema 彼此不同 | `record(\`${name} 返回成功值（不是错误分支）\`, value?.code === undefined)` |
| MINOR | `tests/protocol/contract.test.mjs#first/rest` | 亲验（测试文本） | `void rest` 与 `Object.entries(...).slice(1)` 是两套裁剪，基准模块一致性靠 V8 键序巧合而非显式契约 | `const [first, ...rest] = Object.values(modules)` … `void rest` |
| MINOR | `tests/quality/audit-captures.mjs` 被当作回归保护 | 亲验（测试文本） | 它是报告器不是断言器（自述「只报数字不下结论」），但被 `probe-sites.mjs` 注释称作「用真文件说话」的质量保障 | `probe-sites.mjs` 注释：「真实站点的抓取质量由 `npm run audit:captures` 用真文件说话」 |

### 这些声称的证据我没能在材料里找到
1. 「一次真实抓取只建一个会话」—— 全套测试的会话计数断言为 0（`attach.js:92` 只证投递条数，不证会话数）。
2. 「扩展侧还会再拦一次」（声称7 第三层）—— 零断言。
3. `scripts/check-dist-config.mjs` 的**行为**（目录存在，但门禁比对什么、失败时怎样，未取证）。
4. 「`probe-sites.mjs` 可以进 CI」—— 硬编码 `/Applications/Google Chrome.app/...` 且依赖外部 `dsh web` 实例，无 CI 配置佐证。
5. 「契约是读 `dsh-tools/lib/index.js` 得来」—— 该文件未核证。
6. 审计日志与 `rotate` 在**并发 append** 下的有界性 —— 零断言。
7. 抓取落盘的原子性（`TEMP_FILE` 暗示 write-then-rename）—— 零断言。
8. 「右键菜单抓取**能落盘**」的端到端证据 —— 只到校验器认可为止。

### 假绿断言清单（真坏掉也绿）
- `browser-tools.test.mjs`「只读帧不带 allowWrite」：逗号运算符 + `every(c => c.allowWrite !== true)`，一个**从不发送该字段**的实现照样绿。
- `menu-trigger.test.mjs`「发出的 trigger ≠ 'contextmenu'」：否定式，`undefined`/`''`/`'banana'` 全过（兜底靠下一条）。
- `menu-trigger.test.mjs` 第 4 节「无 tab/windowId 时仍发出抓取」：只数条数，畸形 body 也绿。
- `client-attach.test.mjs` 第 3 节全部 6 条：只驱动纯函数，事件接线被桩空时全绿。
- `capture-routing.test.mjs` 全 6 节：事件由测试自造，真实 `/ag/attach` 路径不经过该断言。
- `browser-tools.test.mjs`「返回成功值（不是错误分支）」：`undefined` 返回值也绿。
- 全部文件的 `record()`：非布尔值静默计为通过。
- `contract.test.mjs`「codegen --check 通过」：外包退出码，codegen 被改成永远返回 0 则整节保护消失。

## 三、【最终裁决】

被审项目**真实存在且可取证**（`/Users/mac/ai_tools/dsh project/网页插件`），两份提议因取证失败而给出的「代码不存在 / 全部证据不足」应予推翻。按亲验结果：**声称3 的核心（`trigger: 'manual'` 在 `AttachRequest` 枚举内）成立**，其测试也是真断言而非自证；**声称1 的接线成立**（`attach.js:92` 确已从 `hub.push` 改为 `pushClientPrimary`），但「只建一个会话」这层语义**未被证实**——全套测试对会话计数零断言；**声称4 的隐私半边成立**（`AUDIT_FIELDS` allow-list 真实存在，且测试做的是字节级 LEAK 扫描），**有界半边未被证实**（只测极端参数档，默认 512KB/1200 行档与并发写零覆盖）；**声称6 就「只删命名范围内的老文件」成立**，并发写窗口未覆盖；**声称2、5、7（第三层）、8 判定为「无法证伪但证据不足」乃至局部被证伪**——声称7 的第三层是零断言的空头安全承诺，声称8 被本报告列出的 8 处假绿直接证伪，声称5 反而被 `probe-sites.mjs` 自身「改写生产源码 + 吞掉构建失败 + 复用陈旧 dist」的行为**反向加重风险**。

**最可能让用户再次踩坑的 3 点（概率×影响）**：① `probe-sites.mjs` 改写 `extension/src/lib/dev-config.js` 且构建失败静默降级为旧 `dist` —— 任一次 Ctrl-C/SIGKILL/构建报错即命中，且会在错误产物上打出「✅ 全部通过」；② 声称1/2 的回归钉子钉在自造事件与纯函数上，而两起真实事故的根因都在事件接线处 —— 同类缺陷重现时全套单测仍全绿，用户再次看到「一抓两会话 / 输入框堆两个引用」；③ 写操作第三层闸门（扩展侧 `allowWrite` 复核）零断言，打开写开关后若该层失效或从未实现，没有任何测试会红，而 `notes: ['浏览器控制未开启']` 这类话术会让人误以为它在拦。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=475f44b1d291… audit=/Users/mac/.pimoa/spool/20260912T061901-moa_verify-51771-8641u2-475f44b1d291.md
