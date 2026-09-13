# PiMoa 对抗性审查 — 驱动索引与转述（非 PiMoa 原始裁决）

> ⚠️ **本文件由驱动 agent 编写，是索引/转述，不是 PiMoa 的原始产物。**
> PiMoa 的原始裁决在以下 4 份文件里（`moa_verify` 直接落盘，未修改）：
>
> - `docs/reviews/pimoa-code-adversarial-bridge.md`（片1）
> - `docs/reviews/pimoa-code-adversarial-2a-extension.md`（片2a）
> - `docs/reviews/pimoa-code-adversarial-2b-tests.md`（片2b）
> - `docs/reviews/pimoa-code-adversarial-2c-probes.md`（片2c）
>
> 另有 `docs/reviews/pimoa-code-adversarial-extension.md`：**失败片留痕**，内容只有 fail-closed 错误，不是裁决。
> 本文件中的一切判断均转述自 PiMoa，未加入驱动 agent 的独立分析。

---

## 1. 材料卫生（⚠️ 有外泄，如实留痕）

`moa_verify` 会把 prompt + context 原文送给模型厂商（本轮 `models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3`，`aggregator=cliproxy/claude-opus-5`）。

| 片 | 文件数 | 字符数 | 混入的敏感文件 | 后果 |
|---|---|---|---|---|
| 片1 bridge | 67 | 222,245 | **`scripts/.dev-extension-key.json`** | **扩展签名私钥（`privateKeyPem` 1,704 字符 + `publicKeyDer` 392 字符）已外传** |
| 片2a extension | 19 | 132,550 | **`extension/src/lib/dev-config.js`** | **桥接共享密钥（`key:` 明文）已外传**；且模型把**完整密钥逐字回显**进 PiMoa spool `20260912T061716-moa_verify-51771-yywpbe-…md`（2 处） |
| 片2b tests | 16 | 75,464 | —（仅 `tests/unit/material-guard.test.mjs` 的**伪造** PEM 常量与路径字符串） | 无真实密钥 |
| 片2c probes | 26 | 211,652 | —（仅 `dev-config.js` 路径常量） | 无真实密钥 |

已核实：

- 5 份 `docs/reviews/pimoa-code-adversarial-*.md` 中**没有**任何真实私钥正文；2a 产物第 69 行出现的是**被截断的密钥前 5 字符 + `...`**（不可用）。
- 真实私钥正文**未**出现在任何 PiMoa spool（逐字节比对 `privateKeyPem` 前 200 个 base64 字符，全部 false）。
- 真实**桥接共享密钥**在 spool `20260912T061716-…` 中出现 **2 次**（模型回显）。
- 另一份 spool `20260912T060918-moa_verify-51771-w9rokm-…md` 含 PEM 头，但**不是**本项目的真实私钥（应为模型举例/伪造常量）。

**建议（由驱动 agent 提出，非 PiMoa 裁决）**：轮换扩展签名密钥与 dev-config 桥接密钥；后续分片 context 一律用 `grep -v` 排除 `dev-config.js`、`*key*.json`、`*private*`、`*credential*`。

---

## 2. 运行记录

| 片 | 命令（工作目录 `…/网页插件`） | 退出码 | 耗时 | 产物 | 大小 | 截断 |
|---|---|---|---|---|---|---|
| 片1 | `node scripts/pimoa-review.mjs --tool moa_verify --prompt-file scripts/review-prompts/code-adversarial.md --context $CTX --out docs/reviews/pimoa-code-adversarial-bridge.md` | 0 | 206.7s | bridge.md | 13,190 字符 | **是**（正文 10,942 → 截 9,982） |
| 片2（合一） | 同上，context = `extension/src tests dsh-plugin/lib` | 0 | **1s** | extension.md | 2,779 字节 | **fail-closed，非文档** |
| 片2a | 同上，context = `extension/src dsh-plugin/lib`（`*.js|*.mjs`） | 0 | 237.9s | 2a-extension.md | 11,082 字符 | **是**（正文 10,007 → 截 9,790） |
| 片2b | 同上，context = `tests/unit tests/protocol tests/quality`（`*.mjs`） | 0 | 342.7s | 2b-tests.md | 8,491 字符 | 无 |
| 片2c | 同上，context = `tests/m0a tests/m0b tests/m1 tests/m2 tests/m3` | 0 | 219.5s | 2c-probes.md | 8,927 字符 | 无 |

四片 `quorum=2/2`，`status=unknown`（驱动脚本的 status 解析字段未命中，属驱动侧报告口径问题，非 PiMoa 失败）。

片2（合一）的失败原文（逐字）：

```
[moa failed] stage=config reason=材料预算超限(fail-loud,v4 §4)：prompt+context+recon 合并 424541 字符 > 预算 360000(mode=verify)。请减料、分段调用、或改用 files 传路径由服务端按上限读入;本工具不做静默截断/压缩(那是静默降质)。临时放宽:env PIMOA_MATERIAL_BUDGET_CHARS(见方案 §4.2 的 600k 显式档)。
mode=verify preset=moa_verify quorum=0/0 models= aggregator=(未解析)
```

---

## 3. 八条声称的跨片裁决矩阵（全部转述 PiMoa）

PiMoa 的裁决标签只有三档。下表"裁决"列一律是 **PiMoa 的说法**。

| # | 声称 | 片1 bridge | 片2a extension | 片2b tests | 片2c probes |
|---|---|---|---|---|---|
| 1 | 一次抓取只创建一个会话、只投给一个页面半 | **部分被证伪** | 无法证伪但证据不足 | 接线成立/「只建一个会话」未被证实 | 无法证伪但证据不足 |
| 2 | 一次「看左边」只触发一次抓取 | 未被证实 | **被证伪** | 事件接线断掉时 6 条断言全绿 | 无法证伪但证据不足 |
| 3 | 右键菜单 `trigger:'manual'` 可落盘 | schema 层成立（端到端无材料） | 无法证伪但证据不足 | **成立** | 无法证伪但证据不足 |
| 4 | 审计只记元数据/不泄密/有界（按大小轮转） | **部分被证伪** | **被证伪**（轮转按条数） | 隐私半边成立、有界半边未被证实 | 无法证伪但证据不足 |
| 5 | 产物端口与 `dev-config.js` 一致（门禁） | 门禁逻辑正确但**恒真盲视** | 无法证伪但证据不足 | 门禁被周边代码**反向加重风险** | 无法证伪但证据不足 |
| 6 | 残留策略只删本插件命名的、严格老于阈值 | **部分被证伪** | 无法证伪但证据不足 | 成立（并发窗口未覆盖） | 无法证伪但证据不足 |
| 7 | 写操作三层闸门 | 第1层成立/第2层查无实据/第3层 fail-open | **被证伪（第2层）** | 第三层**零断言** | 前两层**成立**、第三层证据不足 |
| 8 | 测试是真断言，不是假绿 | 未被证实 | 无法证伪但证据不足（代码内 6 处结构性假绿） | **被证伪**（8 处假绿） | **被证伪** |

**跨片冲突（PiMoa vs PiMoa，驱动 agent 不裁决）**：声称 7 第 2 层——片2a 判"被证伪"（`_sender` 弃用，任意同扩展上下文可自带 `allowWrite:true`），片2c 判"成立"（`E_READONLY` 有真断言）。两片材料不同，各自只看到一半。

---

## 4. 各片原始裁决（逐字）

### 片1 bridge
> 八条声称中，**只有一条可判成立**：声称 3 的 schema 层（`AttachRequest.trigger` 枚举含 `manual`，`attachRoute` 走 `validateAs` 校验，逐字可核）——但其端到端（扩展侧 contextMenus 映射）无材料，不得外推。声称 1、4、6、7 **部分被证伪**……声称 5 的门禁逻辑正确但对其自称覆盖的事故类型恒真盲视。声称 2、8 **未被证实**……且在 host 侧还发现与声称同链路的真缺陷（队列消费 N 条只投 1 条、日志谎报 N）。

（完整三段见 `pimoa-code-adversarial-bridge.md` 第 15、17、19-56 行；被截断的尾行 `registerChipDock` 不在该产物内。）

### 片2a extension
> 8 条声称中，**②（一次「看左边」一次抓取）、④（审计"按大小轮转"与"结构性不泄漏"）、⑦（写操作三层闸门）被直接证伪**……**①③⑤⑥⑧ 一律判「无法证伪但证据不足」**。

### 片2b tests
> **声称3 的核心……成立**，其测试也是真断言而非自证；**声称1 的接线成立**（`attach.js:92`）但「只建一个会话」**未被证实**；**声称4 的隐私半边成立**、**有界半边未被证实**；**声称6 就「只删命名范围内的老文件」成立**；**声称2、5、7（第三层）、8 判定为「无法证伪但证据不足」乃至局部被证伪**——声称7 的第三层是零断言的空头安全承诺，声称8 被本报告列出的 8 处假绿直接证伪，声称5 反而被 `probe-sites.mjs` 自身行为**反向加重风险**。

### 片2c probes
> 只有第 8 条……**被证伪**……第 7 条的前两层（不注册 / 扩展侧 `E_READONLY` 复核）有可核对的真断言，可判**成立**；第三层「审批」与第 1、2、3、4、5、6 条一律判**无法证伪但证据不足**……**没有一条被证据不足的声称被写成"成立"。**

---

## 5. 假绿断言清单（PiMoa 逐条指出；合并去重）

| 出处 | PiMoa 说它为什么真坏掉也绿 |
|---|---|
| 全部探针 `filter(([, v]) => v === false)`（`2c`） | 只有字面 `false` 计失败；`null`/`{timedOut:true}`/字符串/数字/对象全部静默通过 |
| `tests/m2/capture-probe.mjs#chipNeverFallsBackToDom`（`2c`） | `activeChips.every(...)` 在**空数组**上恒 `true`——胶囊从未生成时守卫生效 |
| `tests/unit` 全部测试的 `record()` 三态渲染（`2b`） | `undefined`/`null`/字符串一律不计失败，漏写 `=== true` 的断言静默变绿 |
| `browser-tools.test.mjs`「只读帧不带 allowWrite」（`2b`） | 逗号运算符 + `every(c => c.allowWrite !== true)`，**从不发送该字段**的实现照样绿 |
| `menu-trigger.test.mjs`「trigger ≠ 'contextmenu'」（`2b`） | 否定式，`undefined`/`''`/`'banana'` 全过 |
| `menu-trigger.test.mjs` 第4节（`2b`） | 只数请求条数，畸形 body 也绿 |
| `client-attach.test.mjs` 第3节 6 条（`2b`） | 只驱动纯函数，事件接线被桩空时全绿 |
| `capture-routing.test.mjs` 全6节（`2b`） | 事件由测试自造，真实 `/ag/attach` 路径不经过该断言 |
| `contract.test.mjs`「codegen --check 通过」（`2b`） | 外包子进程退出码，无负面测试；codegen 永远返回 0 则整节保护消失 |
| `scripts/check-dist-config.mjs` 整体（`bridge`） | 断言 `source==dist`；source 被污染时两者一致地错，门禁**必然绿** |
| `approval.js` `if (typeof next !== 'function') return {kind:'allow'}`（`bridge`） | "闸门根本没接上"这一最坏状态下，闸门报告"我拦住了" |
| `hub.js` `send()` 不抛 ⇒ `delivered=1`（`bridge`） | 半死 socket 下"已投递"恒真 |
| `audit.js` `enabled` + 调用方忽略返回值（`bridge`） | 审计停写后 `ctx.logger.info('capture … → fileRef')` 照打，观测面全绿 |
| `audit.js#project()`（`bridge`） | 只能验证"写入存在"，无法验证"未写入 allow-list 之外的字段" |
| `attach.js` `state.guard().checkFetch(req)`（`bridge`） | 若测试 mock 它恒 true，其后所有断言都绕开鉴权路径 |
| `protocol/codegen.mjs --check`（`bridge`） | `content` 由同进程同一次 schema 读取生成，对 schema 语义错完全无感 |
| `consistency-check.mjs` 的 `allowIf: NEGATED`（`bridge`） | **整行**豁免，写进"已废弃"句子即永久免检 |
| `extension/src/sw/ops/debugger.js#withDebugger`（`2a`） | `attached.delete(tabId)` 在 detach 失败吞异常**之前**执行，`attachedTabs()` 恒绿 |
| `client.js#openFreshSession` `switched`（`2a`） | `sessions.open` 不抛即记 `switched=true`，无事后回读校验 |
| `client.js#trySend`（`2a`） | 空实现 `submit()` 只要不抛就记 `ok:true` |
| `client.js#api().inputActions`（`2a`） | 读的全局符号从未被赋值，恒 `[]` |
| `ops/index.js#maybeDetach`（`2a`） | 空函数被调用，围绕它的测试不可能失败 |

---

## 6. 「项目自称实测、材料里没有证据」清单（PiMoa 的判定）

| 自称 | PiMoa 说缺什么 |
|---|---|
| 「看左边」episode 去重已修 | 片1 材料里 `dsh-plugin/lib/client.js` 零行（片2a 补上后判**被证伪**） |
| 右键菜单端到端落盘 | `extension/` 侧 contextMenus → POST `/ag/attach` 映射（片1）；`'manual'` 从未被任何探针发送（片2c） |
| 「一次抓取只建一个会话」有回归钉 | 全套测试**会话计数断言为 0**；`attach.js:92` 只证投递条数（片2b） |
| 扩展侧 `E_READONLY` 复核 | 该字符串在片1 全部代码中 **0 次出现**，`ErrorCode` 枚举也不含（片1）；片2b 判该层**零断言** |
| cordis waterfall `{kind:'allow'}` 契约 | 注释称 "verified in `dsh-tools/lib/index.js`"，**该文件从未在材料中** |
| 测试是真断言 | 片1 材料 `tests/**` 全 0 字节；只有注释转述文件名 |
| cookie 格式「已对活服务器实测 2026-09-11」 | 无握手样本、无 `FINDINGS.md` |
| 「2026-09-12 measured: sessions created 3ms apart」 | 无日志样本 |
| A12「debugger 不能放 optional_permissions」 | 转述的 `tests/m3/debugger-probe.mjs` 缺失 |
| 探针可进 CI | 硬编码 `/Applications/Google Chrome.app/...` + 依赖外部 `dsh web` 实例，无 CI 配置佐证（片2b） |
| `docs/reviews/*.json` 运行产物 | 探针**只写不读**，材料中一份也没有（片2c） |
| 「两个页面半同时在线」这一自称常态 | **任何探针都未构造**（片2c） |

---

## 7. 取证快照与并发改写（⚠️ 影响裁决指向）

驱动脚本在**进程启动时**一次性读取全部 context 文件（`pimoa-review.mjs` 顶层 `contextBody`）。故各片的材料 = 该片启动那一刻的快照。

审查进行期间，**仓库里有另一个 agent 在并发改文件**（非本驱动 agent 所写）。已核实：

| 文件 | mtime | 是否在该片材料里 | 影响 |
|---|---|---|---|
| `extension/src/sw/ops/index.js` | 02:16:46 | **是**（片2a，启动 02:13:18） | 片2a 对该文件的裁决（含 `maybeDetach` 空函数那条）指向**改动前**的版本 |
| `scripts/pimoa-review.mjs` | 02:15:00 | **是**（片1，启动 02:02:06） | 片1 评的是**改动前**的版本 |
| `scripts/material-guard.mjs` | 02:14:49 | 否 | 新增，未被任何片审到 |
| `tests/unit/material-guard.test.mjs` | 02:15:00 | 否 | 新增，未被任何片审到 |
| `tests/unit/op-debugger-optin.test.mjs` | 02:16:46 | 否 | 新增，未被任何片审到 |
| `extension/dist/*` | 02:1x | 否 | 被并发重建 |

本驱动 agent 只写了 `docs/reviews/pimoa-code-adversarial-*.md` 五份文件，**未改任何源码/测试/配置**。

---

## 8. 缺失/失败片说明

- **片2（合一，`pimoa-code-adversarial-extension.md`）失败**：fail-closed 材料预算超限（424,541 > 360,000 字符），**整片零产出**。该文件只含错误文本，**不含任何裁决**。已按要求拆为 2a/2b/2c 三片重跑，三片全部成功。
- **截断**：bridge 与 2a 的**落盘产物**被 PiMoa 回包预算（10,000 字符）按行截断；全文在 spool 中，驱动 agent 已从 spool 读回并核对。2b、2c 无截断。
- **产物里没有的内容**：片1 与片2a 的 PiMoa **aggregator 未单独输出**「这些声称的证据我没能在材料里找到」与「假绿断言清单」两节（只有 一/二/三 三节）；这两节仅存在于**提议者**（proposer）正文中（bridge spool 第 445-480、643-671 行；2a spool 第 569-627、1209-1248 行）。片2b、片2c 均有独立两节。
