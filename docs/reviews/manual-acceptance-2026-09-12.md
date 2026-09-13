# 人工验收记录 — 2026-09-12（真机，用户本人操作）

**环境**：真实 `dsh web`（`127.0.0.1:3080`，`DSH_HOME=~/.dsh`）、真实 Chrome、扩展 `idpgkobbblmpmnonlndopijgfmehfmig`
（本轮重启 + 刷新过，`/ag/whoami` 的进程内审计计数归零可证是新进程）。
**用户真实工作区**：`/Users/mac/ai_tools/dsh project`；抓取落盘 `/Users/mac/ai_tools/dsh project/网页捕获`。

**记录规则**：每项写「谁做的 / 观察 / 证据 / 结论」。✅ = 通过；❌ = 失败（按 AGENTS.md 先分类：权限 / 平台限制 / 逻辑缺陷）；
⛔ = 本环境无法执行（写明原因与解锁条件）。

---

## 0. 本轮真机先抓到的三次"只有真机才暴露"的问题（都不是靠这份清单发现的，但都属于它的范围）

| 项 | 现象 | 结论 |
|---|---|---|
| F2 鉴权（v3.40 引入的回归） | 面板的 `GET /ag/control` 是**扩展文档发的简单 GET**，Chrome 不给 `Origin` ⇒ 严格 F2 一律 403 ⇒ 面板永远显示"写开关是关的"（写本身一直能用） | 已修（`guard.originOk` 对称化 F4 的写法）+ 真机复验 ✅ |
| `browser_ax` 工具层 | 真机调用只得 `tool "browser_ax" returned invalid output: "value" must match exactly one oneOf branch (matched 0)` | 已修：schema 的 `nodeId` 改成字符串（CDP `AXNode.nodeId` 是字符串）。真机复验 ✅ 见 §B-0 |
| `browser_screenshot` 工具层 | 每次调用 `ReferenceError: randomBytes is not defined`（v3.40 只加了用法没加 import）——**这条能力一直是坏的** | 已修 + 真机复验 ✅ 见 §B-0 |

---

## A. 授权弹窗三分支

⛔ **未跑**。要跑需要把扩展的「站点访问权限」改成「点击时」再抓一次未授权站点；本轮为了让抓取可用保持授权开启状态。
解锁条件：用户愿意临时改权限设置（3 步，做完可改回）。

---

## B. 浏览器控制 / 调试横幅 / 写操作审批

### B-0（新增项：真机上验工具层修好的两件事）

| 步骤 | 谁做 | 观察 / 证据 | 结论 |
|---|---|---|---|
| `browser_ax`（tab 1152021686，apexnc） | 模型 | 返回**真实无障碍树**：`total: 996`、截 25 个节点、`nodeId` 形如 `"1816"`（字符串） | ✅ |
| `browser_screenshot`（`fullPage:true`，同 tab） | 模型 | `@网页捕获/assets/browser-2026-09-12-2142-5582f6.png`；PNG 2003×3420、1.78MB、`trusted:true`、`contentHeight:3420`；**看图确认是 apexnc 页面本体**（航拍头图 / 导航 / 正文 / Resident Services 宫格 / 页脚），非空白图 | ✅ |

### B4 · 「浏览器控制」勾选 + 调试横幅

| | |
|---|---|
| 谁做 | 用户勾选；模型发起 AX/整页截图 |
| 用户的观察 | 面板「浏览器控制」= 勾选态 ✓；**标签页顶部没看到「正在调试此浏览器」横幅** |
| 核实结论 | **横幅不是常驻**：`ops/debugger.js#withDebugger` 是 attach → 执行 → `finally` 里 detach（除非 `reuse:true`），所以横幅只在一次调用进行中可见（整页截图约 1s、AX 树约 0.1s）。开关是**许可**，不是常驻 attach |
| 文档处置 | `docs/09` B4、`docs/12` T8 已按实测改写（原来写的是"不可消除横幅"，与实现不符） |
| 现场演示 | 模型连发两次整页截图（21:42 → 1.78MB；21:49 → **2.99MB**、`contentHeight:3458`、`trusted:true`），用户盯着目标标签页：**看到了，并且看到了瞬间的「浏览器正在调试」那行字** |
| 结论 | ✅ **人工确认通过**：横幅在一次调用进行中确实出现、调用结束即消失（与 `withDebugger` 的 attach→detach 实现一致）。`docs/09` B4 / `docs/12` T8 里"不可消除横幅"的错误期望已订正 |

### B5 · 写操作审批的实际批准 / 拒绝

| | |
|---|---|
| 前置 | 用户已在面板把「写操作」拨到开；面板文案显示 **"写操作已开启：模型可见 8 个浏览器工具（每次点击/输入都会先请求批准）"** |
| 模型动作 | `browser_navigate`（tab 1152021686 → `https://example.com/`） |
| 实际返回 | **拒绝**，理由逐字：`browser_navigate refused: this session's approval policy is "never" (approval prompts are disabled) and browser_navigate changes the page, so it needs approval. Ask the user to switch the policy back to "ask", or to turn the write switch off.` |
| 核实 | 本会话的审批策略**真的是 `never`**（DSH 给模型的运行时上下文里逐字写着 "Approval prompts are disabled in this session: actions that require approval are rejected automatically"）。而 `/ag/control` 报的是 `approvalMode: "ask"`——那是**与会话无关的配置默认值** |
| 结论 | ✅ **这恰好是台账 §5-12 那条缺陷的修复在真机上的正面证据**：修之前模型会收到 `the user rejected tool "browser_navigate"`（没有人被问过，纯甩锅）；现在如实说"本会话策略是 never"。<br>⛔ **批准/拒绝两个分支本身没跑成**，因为本会话根本没有审批弹窗可用 |
| 用户的处置（2026-09-12） | 不去验证弹窗，而是把**部署**改成"无审批"形态：`~/.dsh/profiles/web/cordis.patch.yml` 里给插件加 `config: approvalForWriteOps: false`（写操作不走审批缝，只由面板「写操作」开关把关；`/ag/control` 会报 `approvalMode: "off"`，面板文案变成「审批已在配置里关闭」）。<br>**回滚**：删掉那两行 config 或用 `~/.dsh/profiles/web/cordis.patch.yml.bak-before-approval-off` 覆盖，然后重启 `dsh web` |
| 由此留下的**未验项**（如实记录） | 审批弹窗的**交互**（真的弹出来、点批准/拒绝）在本机仍未验证；unit 层有 `write-gate` 37 断言覆盖判定逻辑，但"弹窗"本身只有换回 `ask` 部署才能验 |
| 附带发现 | 面板那条 `ask` 文案拿到的是"默认策略"，对本会话不成立（面板端点没有会话上下文）。已把措辞改成"按默认策略；某会话若被设为 never，会被当场拒绝" |

### B6 · 取消勾选后调试器相关调用必须被拒

| | |
|---|---|
| 谁做 | 用户在面板取消勾选「浏览器控制」 |
| 模型动作 | `browser_ax`（tab 1152021686，`maxNodes:5`） |
| 实际返回 | `{"code":"E_NO_PERMISSION","message":"无障碍树需要先打开「浏览器控制」开关（它要 attach 调试器，页面上会出现「正在调试」横幅）"}` |
| 结论 | ✅ 通过：**拒绝而不是静默 attach**（这正是 v3.40 §P1 修的那条：`opScreenshot`/`opAx` 必须服从运行期开关）。附注：提示里那句"会出现横幅"是对的（调用期间），与 B4 订正后的口径一致 |

### B7 · 目标页被别的调试器占用 —— ★ 期望被实测推翻

| | |
|---|---|
| 谁做 | 用户勾回「浏览器控制」并在 apexnc 标签页按 F12 打开 DevTools（用户确认） |
| 模型动作 | `browser_ax`（tab 1152021686）**连测两次** |
| 实际结果 | **两次都成功**，都返回真实树（`total: 999`）—— 没有报 `E_TARGET_BUSY` |
| 结论 | ❌ **原期望不成立**（不是产品缺陷，是文档写错了）：新版 Chrome（本机 150）允许多个调试器并存，DevTools 打开着**不阻塞**本扩展 attach。`E_TARGET_BUSY` 的真实触发是**另一个扩展**持有该目标；至于"同一扩展重复 attach"，Chrome 原文 `Another debugger is already attached to the tab with id: 1029398121.` 已由 `probe:m3-debugger` 记录在案（那条路径被我们自己的 `attached` Set 提前挡掉） |
| 文档处置 | `docs/09` B7 已作废并写明实测；`docs/12` T8 同步；面板提示（`errors.js`）从"（例如 DevTools 打开着）"收窄为"（通常是另一个扩展在调试该页）"，单测同步 |



---

## C. 「看左边」的自然使用

### C10 · 面板关着时写「看左边」→ 补发一次

| | |
|---|---|
| 证据 | 审计逐字：`{"kind":"intent-replay","delivered":1,"requestId":"int-mtyocg3x-1"}` 紧接 `{"kind":"attach","captureId":"cap-mtyp9o3f-e515","trigger":"look_left","sessionMode":"current","delivered":1}` |
| 结论 | ✅ 意图队列 + 上线补发在真机上生效（`trigger: look_left` 且 `sessionMode: current`，即落回当前会话，符合设计） |

### C8 · 面板输入框写「看左边」→ 抓取 + 落盘 + 引用

| | |
|---|---|
| 谁做 | 用户在侧边栏的 DSH 输入框写 `看左边` 并发出 |
| 审计逐字 | `{"kind":"attach","captureId":"cap-mtz5vi8d-e2a6","trigger":"look_left","sessionMode":"current","mode":"page","delivered":1,"chars":3493}` + `{"kind":"capture-result",…,"ok":true}`（01:54:42Z；本地 21:54） |
| 落盘 | `网页捕获/2026-09-12-2154-plant-the-peak-apex-nc-official-website-d-e2a6.md`（3761B，front-matter `trigger: look_left`、`url` 是 apexnc 页） |
| 结论 | ✅ 机器可判部分全部通过（触发正确、投递单一半、落盘、`capture-result ok`）。界面三件事（状态栏「已附加」/ 输入框多一行 `@…md` / 胶囊）由用户目视确认 |

### C9 · 同一会话内可重复触发

| | |
|---|---|
| 谁做 | 用户删掉那句话后又写了一次「看左边」 |
| 审计逐字 | 第二次：`{"kind":"attach","captureId":"cap-mtz62jb8-5424","trigger":"look_left","sessionMode":"current","delivered":1,"chars":3493}` + `capture-result ok`（02:00:10Z；本地 22:00）；两次的 `requestId` 不同（`int-mtz5vi80-1` → `int-mtz62jav-2`），说明嗅探器**重新武装**成功 |
| 落盘 | `网页捕获/2026-09-12-2200-plant-the-peak-apex-nc-official-website-8-5424.md` |
| 结论 | ✅ 同一会话内可重复触发（v3.39 修的"插件自己改写的草稿被当成新意图"没有复发，也没有被去重规则吞掉） |



---

## D. 抓取质量判断

| | |
|---|---|
| 用户动作 | 面板「Attach 网页」抓 `https://www.apexnc.org/1081/Plant-the-Peak` → 自动新会话 + 预填 |
| 机器可判部分 | ✅ front-matter 完整（`trigger: button`、`url`/`title`/`domain`/`capturedAt`/`sourceVersion`）；正文 38 行、主内容完整（标题、正文段落、`##` 小标题、真实外链）；✅ 重复缺陷未见（两次抓取都是 `delivered: 1`） |
| 机器发现的瑕疵 | ⚠️ 顶部残留 **3 行导航碎片**（`Home / How Do I... / Apply For`）。形态是**嵌套列表**，现有 `stripChipRows` 只处理"同一父节点下 ≥3 个短叶子"，故漏过 |
| 品味判断 | ✅ **用户结论：够了**。**判断材料**：正文 3495 字符，其中
真噪音只有**顶部 3 行**（`Home / How Do I... / Apply For`，约 130 字符 ≈ **4%**）；
其余"链接行"是正文里的真实内容链接（Helpful Documents & Links、Arbor Day Tree Plantings 列表）——**那是该留的**。
第一个标题（`# Plant the Peak`）出现在正文第 6 行 |
| 现场 | 已把"保留策略"现场布好（见 §E：一个 25h 的探针抓取文件 + 一个用户命名文件），用户下一次抓取即可同时验证 E14 |
| 改进路径 | 给 `probe:sites` 加一个"嵌套导航列表"夹具并让它咬，再动启发式（不做拍脑袋改） |

---

## E. 自动拉起与保留策略

### E14 · 保留策略现场验证

| | |
|---|---|
| 现场 | 模型在 `网页捕获/` 放两个 **25 小时前**的文件：`2026-09-11-1200-retention-probe-old-aaaaaa.md`（**匹配**抓取命名 `yyyy-MM-dd-HHmm-*.md`）与 `我的笔记-请勿删除.md`（不匹配任何已知形态） |
| 触发 | 用户抓取（21:41 按钮抓取 + 21:54 意图抓取）→ 每次落盘都会 `sweepCaptures` |
| 结果 | 探针抓取文件 **已被删除** ✅；用户命名文件 **仍在**（77B）✅ |
| 结论 | ✅ 通过：清扫只按已知命名形态动手，用户自己的文件不会被误删（这正是 `TEMP_FILE` 收紧那条修复要保证的语义） |

- **E13（native host 自动拉起）**需要 `kill` 掉 3080 的进程 —— 那正是承载当前会话的进程，须放在最后或由用户在下一个会话里核对 `~/.dsh/logs/dsh-web-companion-host.log` 的 `ensure-dsh → started=true`。
- **E14（保留策略现场验证）**可由模型把现场布好（放一个用户命名文件 + 把一个抓取文件 mtime 改成 25h 前），再由用户抓一次触发清扫。

---

## 本轮还顺带实测到的（与清单相关但不属于清单项）

| 项 | 证据 | 结论 |
|---|---|---|
| 宿主端新代码已生效 | `/ag/control` 的 `GET` 在"无 `Origin` + `Sec-Fetch-Site: none` + `Sec-Fetch-Mode: cors`"下返回 **200**（旧形态 403）；超限 `POST /ag/attach` 回 **413 且带 `connection: close`**；`WS /ag/wsecho` 回 `wsecho-hello` | ✅ |
| 审计字段改名生效 | 同一份 `~/.dsh/logs/web-companion-audit.jsonl` 里，旧记录是 `"errorCode":"ask"`，18:12 那条是 `"status":"ask"` | ✅ |
| 「写操作」开关是**运行期**状态 | 宿主每次重启都回到默认关（本次重启后 `/ag/control` 报 `allowBrowserWriteOps:false`，面板如实显示未勾选） | ✅ 符合安全默认；用户已知悉 |

---

## ★ 本轮顺带抓到的第 4 个真缺陷：页面的"回执"帧被丢弃（`ClientAckEvent` 无 handler）

**怎么发现的**：想在验收里回答"引用到底插进输入框没有"，于是去审计里找页面的回执 ——
`grep '"kind":"ack"' ~/.dsh/logs/web-companion-audit.jsonl` → **0 条**（一整天真实抓取一条都没有）。

**核实的链路**：client 半从 v3.38 起就在发 `{type:'ack', captureId, status}`（`lib/client.js` 两处），协议里也有
`ClientAckEvent`，宿主侧 `recordAck` **确实**会写审计（`kind:"ack"` + `status`，字段表里 `status` 的注释写的正是
"ack: inserted | dismissed | failed"）—— 但 `onClientFrame` 只认 `hello` / `request-pending` / `intent`，
**没有 `ack` 分支** ⇒ 帧被静默丢弃。这与 `request-pending`、`agent-hello` 是同一类缺口：**有生产者、没有消费者**。

**修法**：`onClientFrame` 收下 `ack`（先 `validateAs('ClientAckEvent')`，通过则 `state.recordAck(frame)`）；
新增探针断言（`probe:look-left`，断言 11 → **13**）：走真实 WS 发一条 ack，然后**读审计文件**确认
`kind:"ack"` + `status:"inserted"` 落盘。

**咬合与两处踩坑**：
1. 去掉 handler ⇒ 断言红 ✓；
2. 但第一版断言**不咬**：captureId 写死，审计文件是**追加**的，上一轮写下的条目替本轮作答（去掉 handler 仍绿）⇒ 改成每次运行唯一 id；
3. 探针第一版还给 ack 帧多带了一个 `protocolVersion` —— `ClientAckEvent` 是**闭集且不含该字段**，帧被校验拒绝（这反过来证明校验真的在拦）。

---

## 重启后的复验（用户重启 `dsh web` + 刷新扩展 + 打开侧边栏之后）

| 验什么 | 结果 |
|---|---|
| 部署形态改成"无审批" | ✅ `/ag/control` → `approvalMode: "off"`（配置 `approvalForWriteOps: false` 生效）；面板文案应为「审批已在配置里关闭」 |
| 写开关是运行期状态 | ✅ 重启后回到 `allowBrowserWriteOps: false`（5 个工具）——安全默认，需重新拨开 |
| **ack 留痕修好并在真机生效** | ✅ 审计里两次抓取各自紧跟一条回执：`{"kind":"attach","captureId":"cap-mtz6cbcw-be13",…}` → `{"kind":"ack","captureId":"cap-mtz6cbcw-be13","status":"inserted"}`；第二次同样（`cap-mtz6clba-3a6a`）。**这是"引用真的插进输入框"的第一份持久化证据**（修复前一整天 0 条） |
| 审计进程内计数 | ✅ `written: 6`（新进程以来 6 条；不是 0 是因为重启后已有抓取） |

### 写操作演示（无审批部署下的放行路径）—— ✅

| 步骤 | 证据 |
|---|---|
| 用户把面板「写操作」拨到开 | `/ag/control` → `allowBrowserWriteOps: true`、**工具数 5 → 8**（无需重启即注册）、`approvalMode: "off"` |
| 模型发 `browser_navigate`（apexnc → example.com） | 返回 `{"tabId":1152021686,"ok":true,"url":"https://example.com/","title":"Example Domain"}` —— **没有任何审批弹窗**（符合"无审批部署：只有开关把关"的设计） |
| 独立复核页面真的变了 | `browser_tabs --urlContains example.com` → 命中 1 个标签页，`title: "Example Domain"` ✅ |
| 收尾（把用户的标签页放回原处） | 再发一次 `browser_navigate` → `https://www.apexnc.org/1081/Plant-the-Peak`、`title: "Plant the Peak \| Apex, NC - Official Website"` ✅ |

**这一项同时验到**：①写开关运行期生效（能力集 5→8，无重启）②无审批部署的放行路径 ③写操作真的改页面（不是只回了个 ok）。

**E13（native host 自带拉起）现状**：`~/.dsh/logs/dsh-web-companion-host.log` 最后三行仍是 **2026-09-11** 的
`host started pid=8124` → `ensure-dsh → started=true port=3080` → `stdin closed — exiting`。也就是说该能力**在 9-11 实测过**
（有逐字证据），但**今天没有复验**（用户是手动重启的，没走"kill 掉再打开面板"那条路）。要复验就得 kill 宿主进程 —— 会中断当前会话，故列为最后一项。

---

## 下一步（按优先级）

1. **C9**：把那句「看左边」删掉再写一次，验"同一会话内可重复触发"。
2. **D 的品味判断**：用户对 apexnc 这份抓取（顶部 3 行导航碎片）给结论。
3. **B5 解锁后补跑**批准/拒绝两个分支（需要会话级 `ask`：改本会话策略，或换新会话）。
4. ~~ack 留痕~~ **已在真机复验 ✅**（见上节）。

2. **B6 / B7**（取消勾选 → `E_NO_PERMISSION`；开着 DevTools → `E_TARGET_BUSY`），模型可驱动，用户只需按一次 F12。
3. **C8 / C9**：用户在面板输入框写「看左边」。
4. **D 的品味判断**：用户对 apexnc 这份抓取给结论。
5. **E14**：模型布现场 → 用户抓一次 → 模型核对。
6. **A**（授权弹窗三分支）与 **E13**（native host 自拉起）：需要改权限设置 / 重启宿主进程，安排在最后。
