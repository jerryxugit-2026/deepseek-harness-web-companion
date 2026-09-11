# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`详细设计文档.md`、`PRD_需求定义说明书.md`、`docs/REVIEW-v3.0.md`、`FINDINGS.md`、`docs/research/03-chrome-extension-constraints.md`
- prompt：`scripts/review-prompts/design-adversarial.md`
- 用时：287.4s
- 裁决（status）：**unknown**
- 生成时间：2026-09-11T17:21:52.296Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
# 三、【最终裁决】

**结论：有条件可开工 —— 阻断项 8 条（另 10 条 MAJOR、7 条 MINOR）。** 但首要事实是流程层面的：REVIEW-v3.0 自述"硬错误已全部修入 v3.1"，而送审正文头部仍是 **v3.0 · 工程实现基准**，且 sandbox、无 key 的 iframe `src`、`image/webp`、`protocolVersion:3`、`content/intent-sniff.ts` 五处**原样在位**——说明 v3.1 要么未落盘、要么未送审。因此在拿到真正落盘的 v3.1 之前，**不能按现有正文开工**。放行条件按顺序为：①就"自动拉起 DSH 做不做"拍板，并同步消除 DESIGN.md 与详设的两套结论；②把 8 条阻断修入正文（其中"意图嗅探迁至 DSH client 插件"与"安装路径改为 `cordis.patch.yml` 绝对路径条目并前移至 M1"是 M1/M2 能否成立的开关）；③在 M1 之前跑掉上述 3 条 UNVERIFIED 实验，尤其是"3P cookie 屏蔽下的 12 次请求矩阵"——这是唯一一条既承载核心承诺、又从未被验证的假设；④用一个 ≤2 天的最小 spike 证明闭环（扩展装 cookie → iframe 起 DSH → client 插件可读 composer 草稿 → 经 `WS /ag/client` 双向通信 → 落盘 + 胶囊渲染），spike 不通则立即切换实现路径而非硬推 M2。协议单源（`protocol/messages.schema.json` + codegen + 三端同步测试）虽不阻断 M1，但必须在 M2 启动前就位，否则三端漂移会在联调期集中爆发。方案方向不予否决。

# 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| 阻断项计数 | 提议一：4 条阻断（sandbox/无 key/webp/嗅探点）；提议二：9 条阻断（另含 Origin 导航、client 插件形态、pnpm 安装、协议信封、自动拉起未决） | 采信提议二的口径，但下调协议信封一项 → **本裁决判 8 条阻断** | "阻断"应以"照文档写代码会失败或里程碑卡死"为准。§9 T1 导航 Origin、client 插件形态、pnpm 安装三项均满足该标准（提议一自己在 H1/H3/H2 的论证里也承认"必然失败/M1 卡死"，只是给了低一级标签，属标签与论证不自洽）。协议信封不阻断 M1（M1 只用 /ag/ping、/ag/enter），降为 MAJOR 并标注"M2 前置阻断" |
| 送审基线本身是否成立 | 提议一默认以 v3.0 正文为基线逐条复核；提议二额外指出"REVIEW-v3.0 自称已修入 v3.1，但送审正文仍是 v3.0，sandbox/无 key/webp/protocolVersion:3/intent-sniff.ts 全部在位" | 提议二 | 这是可核对的元问题：REVIEW 开头写"硬错误已全部修入 v3.1"，而送审 `详细设计文档.md` 标题行仍为 **v3.0 · 状态 核心决策定稿 / 工程实现基准**，且 §6.2 仍带 sandbox。要么 v3.1 未落盘，要么未送审——这本身就是一条独立的流程阻断，提议一漏了 |
| sandbox 的危害论证 | 提议一：单独 `allow-scripts` 会把上下文切到 null origin，"极可能破坏 cookie 投递"；提议二：`allow-scripts`+`allow-same-origin` 是公认的 sandbox 自我失效组合，但仍改变存储/下载/弹窗上下文，关键是**偏离了全部实测条件** | 提议二，且进一步收紧表述 | 提议一的机制描述不准确：文档给的组合里带 `allow-same-origin`，origin 并不会变 opaque，所以"必定 403/401"是没有证据的断言。正确的阻断理由是：①该属性在此组合下安全收益为零；②FINDINGS §3 全部矩阵在无 sandbox 下取得，加上它等于把已验证结论作废且无人复测。按"无收益 + 作废实证"判阻断，而非按"必定失败"判 |
| webp 的依据强度 | 双方均引 `docs/research/03` §5.1 判为硬事实 | 结论采信（改 png/jpeg），但**降级证据标注** | 上下文 `docs/research/03` §5.1 原文只写了"`ImageDetails` controls `format`/`quality`"，**并未逐字列出枚举值**。"不支持 webp"来自 Chrome tabs API 的 ImageDetails 枚举（jpeg\|png），属平台外部知识而非本材料内的引用。两份提议都把它当作材料内 FACT，属轻度拔高，需标注为"推理" |
| `/ag/enter` 导航态如何校验 | 提议一：`key + UA + Referer`；提议二：`导航(key only)` + 一次性短 TTL 兑换 | 提议二 | UA 校验无任何安全价值（可任意伪造），Referer 在扩展页发起的子框架导航中受 Referrer-Policy 影响不可靠，把它写进校验矩阵会重蹈"要么误杀要么放宽"的覆辙。一次性 key + 短 TTL + 落地即换 HttpOnly cookie 是唯一自洽解 |
| "0 额外进程"是否与 Go/native 拉起器冲突 | 提议一 C3 认为二者互斥；提议二未提 | 均不采信提议一 C3 | 该论证不成立：Go 拉起器/native host 都是**按需拉起、随 port 生命周期回收的非常驻进程**，与 G6 的"0 新增**常驻**进程"不构成矛盾。此条应剔除 |
| ADR-3 "0 额外内存消耗" | 提议二指出 iframe 内跑的是完整 DSH SPA，口径与 G6 的"扩展 <20MB"混淆；提议一未提 | 提议二 | 少数方证据更强且可核对（ADR-3 原文"0 额外内存消耗" vs §1 G6 只承诺"扩展打包体积 <1MB / 0 新增常驻进程"），是真实的同文档口径不一致 |
| §11.4 "扩展路径不要包含空格" | 提议二指出这是 `docs/research/03` §1.5 明标 **OBSERVED / UNVERIFIED as a general rule** 的观察，却被写成硬约束，且项目根路径本身就含空格；提议一未提 | 提议二 | 这是全材料里最可核对的一处"把未验证观察写成工程约束"的自打脸（归属路径 `/Users/mac/ai_tools/dsh project/网页插件/` 含空格） |
| M3 `browser_click/type` 可行性与 2 天预算 | 提议二指出 `scripting` 只能产生 `isTrusted:false` 且**完全拿不到 AX 树**，可靠驱动必须 `chrome.debugger`（带不可消除 infobar、`requiredVersion` 必须 "1.3"），而 M3 预算内无任何 debugger 条目；提议一仅在低危项里附带提及 infobar | 提议二 | 直接命中 G5/FR-3.2 的能力承诺与排期的冲突，依据是 `docs/research/03` §6.5 对比表的 FACT 级条目 |
| 字幕覆盖率量化 | 提议一给出"覆盖率天花板约 60-70%（粗估）"；提议二只给覆盖矩阵不给数字 | 提议二 | 用未测数字替换未测承诺，是把猜测写成结论，违反本次评审纪律，剔除 |
| G2 阈值重设 | 提议一直接给"轻量页 ≤300ms / 标准页 p95 ≤800ms / 含截图 ≤1500ms"；提议二主张拆冷热 + 定基准页 + 把字幕移出硬指标后再测 | 提议二 | 提议一的新数字同样没有测量依据，等于用一组无依据数字替换另一组 |
| 是否否掉方案 / 最脆弱假设 | 提议一：①iframe 内 DSH 可被扩展可控 ②嗅探点可落在 client 插件；提议二：①扩展顶层 scheme 永不受 3P cookie 限制（且该场景恰是唯一未实测的）②DSH 永不下 `X-Frame-Options`/`frame-ancestors`（"全包 grep 无命中"是快照不是契约） | 两者合并，以提议二为主 | 提议一的两条实为同一件事（都指向 client 插件可编程性），且已被 REVIEW A4 定性为"必须改"而非"可能崩"；提议二的两条才是**方案级归零风险**，且都能指向材料中自陈的 UNVERIFIED |
| 一致判断（无分歧部分） | 双方同判：结论均为"有条件可开工"、均不否掉方案、均认定 A4（意图嗅探跨域）最致命、均认定 FINDINGS §3 的实测矩阵（含"移除 cookie → 401 fail-closed"对照组）证据质量高、均认定 `<1MB`/`<50ms`/`<20MB`/`1.5s`/`300ms` 无测量基线 | 全部采信 | 两路独立推导同结论，且均能落到原文片段 |

# 二、【逐条裁决】

| 级别 | 文件#符号名 | 证据强度 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | 详细设计文档.md#§6.2 `<iframe sandbox=...>` | 材料亲验 | 全部实测在无 sandbox 下取得，该属性在 `allow-scripts`+`allow-same-origin` 组合下安全收益为零却作废实证基线 | `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"`；对照 FINDINGS.md §3 矩阵 |
| BLOCKER | 详细设计文档.md#§6.2 `iframe src` | 材料亲验 | 硬编码无 `?key=`，与同文档 §9 T2 的预共享 Key 校验直接互斥，按文档抄必 403 白屏 | `src="http://127.0.0.1:3080/ag/enter"` vs §9 T2「预共享 32 字节 Key (`X-AG-Key`) 双因子校验」 |
| BLOCKER | 详细设计文档.md#§0.1/§3/§6.1 `content/intent-sniff.ts`/§7.1 | 材料亲验 | 用户实际输入框在 iframe 内 DSH composer（跨域），扩展既读不到内容也拿不到按键，PRD FR-2.0 核心交互物理不可实现 | §7.1「Input->>Input: 意图命中: 检测到关键词 "看左边"」；§6.1「`intent-sniff.ts` "看左边"输入意图嗅探辅助」 |
| BLOCKER | 详细设计文档.md#§9 T1 Origin 校验 | 推理（Fetch 规范：GET 导航不带 Origin） | `/ag/enter` 是导航请求不发 `Origin` 头，按字面实现只能二选一：误杀全部合法导航，或退化为无校验 | §9 T1「插件校验请求头中的 `Origin` 必须严格等于 `chrome-extension://<EXTENSION_ID>`」 |
| BLOCKER | 详细设计文档.md#§6.1 `src/client/index.js` | 材料亲验（依 REVIEW A6 的源码级结论） | "Web 注入脚本"不是 DSH 支持的加载机制，DSH 客户端插件必须是经 `exports["./client"]` 暴露、由 `__ModuleLoader__.load` 加载的 CJS 闭包工厂 bundle，按注入脚本写加载器根本不会加载 | §6.1「DSH Client 插件 (Web 注入脚本 · Node.js/JS)」 |
| BLOCKER | 详细设计文档.md#§6.1 `scripts/install-plugin.mjs` + §10 M4 | 材料亲验 | 唯一安装路径依赖 pnpm，而 REVIEW A7 实测本机 `dsh plugin --profile web --help` → **exit 127**；且该脚本被排进 M4，而 M1 验收就要求插件在跑 → M1 必卡死 | §10 M4「一键插件链接脚本 (`scripts/install-plugin.mjs`)」 vs M1「DSH Host 插件：实现 `/ag/ping` 与 `/ag/enter`」 |
| BLOCKER | 详细设计文档.md#§5.1 `media.viewportScreenshot` | 推理（Chrome `ImageDetails.format` 枚举为 jpeg\|png；本材料 §5.1 未逐字列举） | 协议要求 webp，`captureVisibleTab` 无法产出；且未约定是否含 dataURL 前缀、无体积上限 → 桥接侧 base64 解析必错位 | `"viewportScreenshot": "data:image/webp;base64,UklGRiQAAABXRUJQVlA4..."` |
| BLOCKER | 详细设计文档.md#ADR-4/C5 ↔ PRD FR-3.3 ↔ DESIGN.md（REVIEW B11 引） | 材料亲验 | 同仓库两套结论（详设"不做自动拉起" vs DESIGN.md 保留 native host 拉起），且 G1「一键侧边栏秒级就绪」在 DSH 未起时直接不成立——当前 DSH 恰好一直在跑掩盖了该缺口，属必须拍板的决策阻断 | ADR-4「Go 拉起器后做，现在不做」；G1「点击工具栏图标…≤1.5s 内 composer 可输入」 |
| MAJOR（M2 前置阻断） | 详细设计文档.md#§5.1 `protocolVersion` / §5.2 WS 消息 | 材料亲验 | 把文档版本号当协议版本（3），WS 为裸 `{id,tool,params}`，无信封/错误码/`hello`/`ping`/`ack`，三端实现必然对不齐 | `"protocolVersion": 3`；`{"id":"call_01J7Z1XYZ","tool":"browser_read_page","params":{...}}` |
| MAJOR | 详细设计文档.md#§7.1 时序图 `Input->>CS` / `Input->>Model` | 材料亲验 | 扩展页不能直接调 content script（须经 SW + `chrome.scripting`），Prompt 提交发生在 iframe 内 DSH composer，微壳无从提交 | §7.1「Input->>CS: 提取正文高信噪比 Markdown」「Input->>Model: 提交 Prompt」 |
| MAJOR | 详细设计文档.md#§1 G1/G2 性能指标 | 材料亲验 | 无测量方法、无基准页、不分冷热；材料自陈 `dsh web` 冷启动约 4s，1.5s 作为冷启动物理不可达；300ms 未定页面规模/是否含截图/p50 还是 p95 | G1「**≤1.5s** 内 composer 可输入」；G2「**≤300ms** 内抓取正文 Markdown、视口截图与视频字幕」 |
| MAJOR | 详细设计文档.md#ADR-6/§12.2 ↔ PRD FR-2.1「自动提取全部字幕」 | 材料亲验（依 REVIEW A10） | 三重物理约束（跨域 `<track>` 无 CORS 读不到 cues、YouTube/B站 DOM 只渲染当前 cue、DRM 下截图黑帧）使"全部"不可兑现，且 DRM 危害被窄化为"不传 mp4" | FR-2.1「自动提取**全部**字幕与台词文本」；§12.2「不支持 Netflix/Disney+ 等 DRM 加密视频」 |
| MAJOR | 详细设计文档.md#§9 威胁矩阵（仅 T1–T4） | 材料亲验 | 本地高权限 agent + 反向浏览器控制只列 4 条威胁；T3 尤其回避了真实利用链：注入文本落盘 → agent 读取 → 调用本地 Bash/`browser_click`，仅以"纯数据文件落盘"作辩护 | T3 防御列「网页快照强制以**纯数据文件落盘**（不直接混入系统执行指令）」 |
| MAJOR | 详细设计文档.md#§8 测试方案（L0–L3 共 4 行） | 材料亲验 | L0「类型定义无 `any` 遗漏」不是可自动判定的断言，L1/L2 只有标题无用例，L3 仅两条手动断言 → 不构成质量门槛、无法阻回归 | §8 L0「TypeScript 静态编译检查 / 类型定义无 `any` 遗漏」 |
| MAJOR | 详细设计文档.md#§8 L2「错误 Key 均拦截为 403」 | 材料亲验 | 只有负例断言：若把导航态也按 Origin 误杀成 403（见上方 BLOCKER），该用例照样全绿，bug 测不出 | §8 L2「3) 错误 Key 均拦截为 403」 |
| MAJOR | 详细设计文档.md#§10 M3 + G5/FR-3.2 `browser_click`/`browser_type` | 材料亲验（`docs/research/03` §6.5 对比表） | `scripting` 只产生 `isTrusted:false` 事件且**完全无 AX 树**，可靠驱动必须 `chrome.debugger`（`requiredVersion` 必须 `"1.3"`、带 Cancel 即断的全局 infobar），而 M3 仅 2 天且无任何 debugger 条目 | §10 M3「注册 `browser_read_page`、`browser_screenshot`、`browser_click`、`browser_type`…（2 天）」 |
| MAJOR | 详细设计文档.md#§7 缺 §7.4 / §5.2 缺重连语义 | 材料亲验 | DSH 未起 / 未配对 / iframe 认证失败 / 附件准入失败 / 扩展未连接五态无契约；MV3 SW 30s 回收使 WS 必须可重连，§11.2 只提"别放 SW"未定状态机 | §11.2「WebSocket 连接由侧边栏页面持有」（无重连/降级定义） |
| MAJOR | 全仓库命名 `dsh-antigravity-bridge` / `com.antigravity.web_companion` / `antigravity-companion.json` | 材料亲验（REVIEW B9） | 插件包名、native host 名、配对文件名三处与产品名不一致，任一处错位即 `Specified native messaging host not found` 级联调失败 | §6.1「`dsh-plugin/` … `dsh-antigravity-bridge`」 |
| MINOR | 详细设计文档.md#ADR-3「0 额外内存消耗」 | 材料亲验 | iframe 内跑的是完整 DSH SPA，内存开销必然远超微壳；与 G6 只承诺"体积 <1MB / 0 新增常驻进程"口径不一致 | ADR-3「**0 额外进程、0 额外端口、0 额外内存消耗**」 |
| MINOR | 详细设计文档.md#§11.4「扩展路径不要包含空格」 | 材料亲验 | `docs/research/03` §1.5 明标该现象为 **OBSERVED / UNVERIFIED as a general rule**（未区分空格本身与 shell quoting），却被升格为硬约束；且本项目归属路径本身含空格 | §11.4「扩展路径不要包含空格」 vs 文档头「归属 `/Users/mac/ai_tools/dsh project/网页插件/`」 |
| MINOR | 详细设计文档.md#§11 平台速查 缺 `captureVisibleTab` 限制 | 材料亲验（`docs/research/03` §0 第 8 条、§5.1 FACT） | 漏写"2 次/秒节流"与"仅该窗口 active tab"；"看左边"单次触发碰不到，但 M3 `browser_screenshot` 在 agent 循环里第 3 次/秒即失败 | `docs/research/03`「`MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2`」 |
| MINOR | 详细设计文档.md#§11 缺"侧边栏不能承载远程 URL"负向事实 | 材料亲验 | `PanelOptions.path` "must be a local resource within the extension package" 是 FACT(negative)，意味着微壳+iframe 是**被迫的唯一形态**而非设计选择，弱化后易被"能否直接 setOptions 到 3080"带偏 | `docs/research/03` §1.2「there is no option, method, or manifest field… that accepts a URL」 |
| MINOR | 详细设计文档.md#全篇 证据等级标注缺失 | 材料亲验 | 文档头自定义了【实测】/【源码】/【决策】三级，但正文的 1.5s/300ms/<1MB/<50ms/<20MB 全无标注，读者无法区分硬事实与目标值 | 文档头「【实测】= 本机真实 Chrome 150 / 真实 DSH…」；对照 ADR-2「打包体积 <1MB，启动 <50ms，内存 <20MB」无标注 |
| MINOR | 详细设计文档.md#§1 G2 把字幕并入 300ms 硬指标 | 材料亲验 | 同文档 §12.2 已承认字幕为尽力而为、DRM 不支持，G2 却把它与正文、截图并列为硬指标 | G2「在 **≤300ms** 内抓取正文 Markdown、视口截图与视频字幕」 |
| MINOR | 详细设计文档.md#§6.1 目录结构 | 材料亲验（REVIEW B5） | 缺 `protocol/`、`tests/e2e/`、`native-host/`、`scripts/init-key.mjs`、隔离 dev-home 与配对文件 `$DSH_HOME/dsh-web-companion.json`，与 M1/M2 实际产物不符 | §6.1 目录树仅 `extension/` `dsh-plugin/` `scripts/install-plugin.mjs` |
| 剔除（不成立） | 提议一 C3「0 额外进程 ↔ Go 拉起器互斥」 | 推理 | 拉起器/native host 为按需拉起、随 port 生命周期回收的非常驻进程，与 G6「0 新增**常驻**进程」不构成矛盾 | G6「本地 **0 新增常驻进程**」 |
| 剔除（猜测当结论） | 提议一「字幕覆盖率天花板约 60-70%」、「G2 改 800ms/1500ms」 | — | 以未测数字替换未测承诺，违反"不把猜测写成结论"的纪律 | — |


⚠️ [正文 12371 字符超回包预算 10000，已按行截取前 9968 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260911T172152-moa_verify-14787-tk8h5a-e8f4db7d802b.md（sha256=8f21bcb7e3a7…，66338 字节，保留至 2026-09-25），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=e8f4db7d802b… audit=/Users/mac/.pimoa/spool/20260911T172152-moa_verify-14787-tk8h5a-e8f4db7d802b.md
