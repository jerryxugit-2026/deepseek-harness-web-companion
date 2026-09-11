# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`详细设计文档.md`、`docs/reviews/pimoa-adversarial-v3.1.md`、`docs/CHANGELOG.md`
- prompt：`scripts/review-prompts/design-adversarial.md`
- 用时：332.2s
- 裁决（status）：**unknown**
- 生成时间：2026-09-11T17:36:59.929Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

**结论：有条件可开工 · 阻断项 2 · MAJOR 7 · MINOR 9。**

v3.2 对上一轮 6 条阻断是**真实落盘而非口头修复**：鉴权补第四形态、配对 key 与一次性 ticket 职责分离、WS 归属统一、体积上限收敛到同一测量轴、H4 单态化、E2E-0 改写为三条可判定硬断言，并把"评审条目→正文"对齐脚本化（`consistency-check.mjs`）——这与上一轮被点名的"修句子不修契约面"已形成实质区分，方向**不否掉**。但残留的两条阻断仍属同一病根的第三次浮现：修了 §5.4 的矩阵却没回改 §5.1 的端点表；补齐了 `cookies` 的权限最小化却没有回头核对"最小权限集能否支撑 §7.1 的意图触发路径"——后者尤为致命，因为它不是措辞问题，而是**旗舰交互「看左边」在最常见的"开面板后换过标签页"情形下会因缺 `activeTab`/host 权限而直接失败**，且 `scripting` 注入与 `captureVisibleTab` 会一起失权。因此开工前置条件是：①把 §5.1 端点表的鉴权列改为引用 §5.4 的形态编号，并在 `consistency-check` 里加一条"§5.4 之外出现裸『key + Origin』即失败"的规则；②在 M0a 追加一条权限实验（左侧开 fixture 页 → 三组对照：先点扩展图标 / 先点左侧网页 / 无任何手势，分别经 iframe 内触发调 `captureVisibleTab` 与 `executeScript`，记录 `lastError`），据结果决定是否必须把 `*://*/*` 或"触发前强制一次扩展侧手势"写回设计——这一条不解决，M2 的三天会全部押在一条走不通的主路径上。本轮全部证据强度均为"送审正文内自证的推理"（设计包不在审计可读根内，无一条亲验），故 §6.3 的两处【源码】断言与假设 B 一律维持**未证实**而非已证伪，M0a 必须以"安装产物逐字片段 + 版本号/commit + 内省原始输出落盘 `docs/reviews/`"作为闭环判据。最后两点定性建议直接写回文档：其一，M3 退出条件删去"可靠点击"，改为"普通 HTML 页 100% / 主流 SPA 80%+ 且失败可诊断"（同时保留本轮结论：`requiredVersion:"1.3"` 的怀疑不成立，不必上调）；其二，在 §10 末尾补一条应急预案——若 M0b 断言①（必须是 DSH 原生 composer）失败，自动追加 M0c 自研前端骨架预算并**整体重写 §0.3 与 §1.1 的收益表述**，把切换条件写成 CHANGELOG 的显式触发条目，避免第三次以"修句子"的方式回退。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| 阻断项总数与构成 | P-A：2 条（client 同源 cookie 竞态、胶囊轨道未锁定）；P-B：3 条（§5.1 端点表残留、配对 key 生命周期、构建期"运行时内省") | **合并后 2 条**：`/ag/ack` 端点鉴权形态残留 + `activeTab` 与意图触发路径冲突 | 两方阻断集合几乎不相交，需逐条按证据重定级：P-A 两条均因与文档正文冲突或论证不成立而降级；P-B 三条中仅第一条经收窄后成立，另两条降为 MAJOR；而 P-B 列为"高"的 `activeTab` 问题实为唯一会直接打断主路径的硬缺陷，应升为阻断 |
| `/ag/enter` 303 后 client 插件首次 `/ag/client` 握手是否存在 cookie 竞态 | P-A：存在异步竞态，首帧可能不带 cookie，属阻断；P-B 未提 | **不采信 P-A**（降为 MINOR） | `Set-Cookie` 在 303 响应头处理时即写入 cookie jar，后续导航与该文档发出的同源子请求必然携带；client 插件是在重定向目标页加载完成后才被 `__ModuleLoader__` 装载，时序上晚于 cookie 写入。P-A 未给出任何反例或规范引用，属"把猜测写成结论" |
| 胶囊承载轨道是否"未锁定" | P-A：dock slot 与文本内嵌两条路都没写死，实现只能猜，属阻断 | **部分采信，收窄后降为 MAJOR** | 与文档正文冲突：§6.3 已明确"胶囊插槽 `conversation.input.dock`（备选 `.attachments`/`.left`）"，§8.2 E2E-5 断言 `[data-ag-chip]`，轨道**已选定**。但 P-A 暴露出的真实缺口成立：`setDraft` 是"唯一整段写入"入口，点 ✕ 删胶囊后草稿里的引用文本如何回撤（整段重写会覆盖用户已输入内容）无任何约定 |
| §6.3 "构建期运行时内省 `window.__ModuleLoader__`" | P-B：构建期跑在 Node 里没有 `window`，技术事实错误，属阻断；P-A：只指出"内省产物落到哪里未定"（中） | **采信 P-B 的发现 + P-A 的修法，定 MAJOR** | 措辞确实自相矛盾（"被服务的 shell 产物"= 磁盘文件，"运行时内省"= 浏览器上下文），但并非不可能：M0a 的 Q3 本就要跑运行时探针，其输出可导出给构建期。属"未定义由谁执行、产物落到哪里"，二选一即可修，不构成开工阻断 |
| 配对 key 生命周期是否自相矛盾 | P-B：「仅重装/轮换时更换」与 §7.4「未配对→跑 init-key」构成循环定义，属阻断 | **降为 MAJOR** | 重装扩展本就等于重新配对，两句话不构成硬矛盾；真实缺口是 P-B 后半段指出的：未定义 `$DSH_HOME/dsh-web-companion.json` 与 `chrome.storage.local` 谁是权威、缓存失效如何检测、§7.2 时序图完全跳过配对环节 |
| `activeTab` 在"意图触发"路径上是否够用 | P-B：iframe 内触发时对左侧标签页的授权不必然有效（高）；P-A 未提 | **采信 P-B 并升为 BLOCKER** | 少数方给出可核对的交叉证据：§11.1「`captureVisibleTab` 需 `<all_urls>` 或 `activeTab`」+ §9「不申请 `<all_urls>`，`*://*/*` 改 optional」+ §7.1 意图路径由 client 插件→host→SW 发起、**全程无扩展侧用户手势**。这会同时打掉截图与 `scripting` 注入，是 G2/G3 主路径的直接失效点 |
| `chrome.debugger` `requiredVersion:"1.3"` 是否不足 | P-A：PiMoa 上一轮的怀疑本身有误，应予维持；P-B 未提 | **采信 P-A** | `requiredVersion` 是最低版本声明而非能力上限，1.3 为 CDP 稳定版号；应保留此项纠正，防止 v3.3 被上一轮误判带偏 |
| M3「可靠点击/输入」是否过度承诺 | P-A：SPA 合成事件下 `Input.dispatchMouseEvent` 不总生效，应删"可靠"二字（高） | **采信但降为 MINOR** | 方向正确，但 P-A 未给出 Chrome 150 上的实测或文档引用，属经验判断；作为验收措辞收敛处理即可 |
| WS 归属（`bridgeSocket()` 放侧边栏文档） | P-B：Q8 未跑却用强断言"必须放这里"，违反文档自定 §13.2 第 2 条（高）；P-A：补充"文档被冻结后重连语义未写"（中） | **两条合并为一条 MAJOR** | 互补且都可核对：P-B 指出"结论写在证据之前"，P-A 指出"冻结/恢复的状态机缺失"，同属 §6.2 一处缺口 |
| ULID 示例、扩展加载路径、`cookies` 权限等上一轮遗留 | 两方均未重提 | **确认已闭环** | v3.2 已落盘：`cookies` 移入 optional、§11.1 区分命令行与 CDP 两条路径、H4 单态化、E2E-0 三硬断言、体积上限同轴化、鉴权矩阵补第四形态 |
| 证据边界 | P-B 明确声明设计包不在可读根内、DSH 检出未能完整枚举，故标"未能亲验"；P-A 未作同等声明但也只基于送审正文 | **采信 P-B 的处理方式** | 本轮**全部裁决证据强度均为"推理（送审正文内自证）"**，无一条亲验；§6.3 契约路径在 DSH 源码检出中的命中与否仍为**未证实**（非"已证伪"） |

---

## 二、【逐条裁决】

### BLOCKER（2 条）

| 级别 | 位置#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | 详细设计 §5.1 端点表 `POST /ag/ack`（及若由 client 消费的 `GET /ag/pending`） | 推理（正文内自证） | 上一轮 BLOCKER-1 只修了 §5.4 矩阵没回改端点表：ack 由 iframe 内 client 插件（同源 Origin）发出，端点表却仍标"key + 精确 Origin（扩展）"，实现者照表写 guard 会再次恒 403 | §5.1「`POST /ag/ack`｜key + Origin｜客户端回执」 vs §5.4 第四行「**不得**要求 `chrome-extension://`」 vs §8.2 E2E-5「✕ 后…`/ag/ack` 收到 `dismissed`」 |
| BLOCKER | 详细设计 §7.1 意图触发路径 × §9 权限最小化 × §11.1 `captureVisibleTab` | 推理（三处交叉自证） | 「看左边」意图路径的抓取由 client 插件经 host→SW 发起，**扩展侧无用户手势**，`activeTab` 不会（或已因切换标签/导航而失去）覆盖左侧目标页；在默认权限集不含 `<all_urls>` 的前提下，`captureVisibleTab` 与 `scripting.executeScript` 都会失权——该产品的旗舰交互在"打开面板后换过标签页"这一最常见情形下必然失败，全文未识别 | §11.1「`captureVisibleTab`｜需 `<all_urls>` 或 `activeTab`」＋ §9「不申请 `<all_urls>`；`*://*/*` 全部改为 optional」＋ §7.1「`Host->>SW: 触发抓取（微壳中转）`」 |

### MAJOR（7 条）

| 级别 | 位置#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| MAJOR | §6.3 `可用 external` | 推理 | "构建期从被服务的 shell 产物**运行时内省**"措辞自相矛盾（Node 构建期无 `window`），且未定义内省产物落到哪里、失败如何 fail——§6.3 自述"错误形态会导致插件根本不加载" | §6.3「构建期从被服务的 shell 产物**运行时内省** seed 表（`window.__ModuleLoader__` 的 seed / `platform.ts` 编译产物）」 |
| MAJOR | §7.1 第 8 步 `setDraft` + §8.2 E2E-5 胶囊 ✕ | 推理 | 胶囊轨道虽已选定为 `input.dock`，但"胶囊 ✕ 删除"与"`setDraft` 写入的引用文本"是两条独立轨道，而 `setDraft` 是**整段覆盖**唯一入口——回撤引用文本必然覆盖用户此后输入的内容，语义未定义 | §6.3「`setDraft` 是**唯一整段写入**入口」 vs §8.2 E2E-5「✕ 后消失且 `/ag/ack` 收到 `dismissed`」 |
| MAJOR | §6.3 `API 漂移` 探针清单 | 推理 | 漂移 shim 只覆盖 `createDraftImages??createDraftAttachments` 与 `addImages??addAttachments`，**最高频依赖 `setDraft` 未列入**——master 同样可能重命名，届时 M0b 判据②与整条注水链一起失效 | §6.3「能力探测 shim：先探测 `createDraftImages ?? createDraftAttachments`、`addImages ?? addAttachments`」 |
| MAJOR | §5.2 `attach` 事件 `imageRef` → §6.3 `createDraftImages([File])` | 推理 | `createDraftImages` 需要 `File` 对象，但 host 推给 client 的只有 `{attachmentId, mime}`，文档未定义 client 端如何由 attachmentId 取回二进制（无下载端点、无 base64 回传约定）——M2 实现必卡 | §5.1 响应「`"imageRef": { "attachmentId": "att_…", "mime": "image/png" }`」 vs §6.3「`createDraftImages([File])`」 |
| MAJOR | §5.4 key 生命周期表 + §7.2 时序图 | 推理 | 未指定 `$DSH_HOME/dsh-web-companion.json` 与 `chrome.storage.local` 谁是权威、缓存失效如何检测、`init-key.mjs` 重跑是"首次生成"还是"轮换"；§7.2 自动拉起时序图完全跳过配对环节 | §5.4「配对 key…长期；仅重装/轮换时更换」 vs §7.4「未配对 → 指引 `node scripts/init-key.mjs` + 重载扩展」 |
| MAJOR | §6.2 `bridgeSocket()` + §9 T12 + §12.4 Q8 | 推理 | 结论写在证据之前：Q8（空闲 WS 是否保活侧边栏文档）未跑，§6.2 却用"**必须放这里，不能放 SW**"的强断言，违反本文档 §13.2 第 2 条；且侧边栏被隐藏/冻结后的重连与状态机未定义 | §6.2「持有 `WS /ag/agent`（**必须放这里，不能放 SW**）」 vs §12.4 Q8「…行为未实测…闭环 M0a」 |
| MAJOR | §1.2 G2 + §10 M2 排期 | 推理 | 轻量页 p50 ≤300ms 的物理下限已被 Readability + turndown + 跨进程注入 + 多跳往返吃掉大半，而 M2 的 3 天内无任何性能优化预算；G2 虽标【目标·未测】，M2 退出条件却未把"产出基线测量报告"与"达标"区分开 | §1.2 G2「轻量页（<50KB 正文）p50 ≤300ms」＋ §10 M2 退出条件（无性能项） |

### MINOR（9 条）

| 级别 | 位置#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| MINOR | §5.4 第四形态行 | 推理 | 把 client 插件的 fetch 与 WS 升级合并成一格，`guard` 的"四形态"用例因此未拆 `fetch/WS × 同源/跨源` 的完整 2×2；建议拆为 5 行、`guard` ≥11 例 | §5.4「**fetch/WS** `/ag/client`（**DSH 页面内的 client 插件，同源**）」 |
| MINOR | §5.4 第四形态"必须携带有效 DSH 会话 cookie" | 推理 | 同源请求自动带 cookie，该项与 key 校验高度重叠、几乎不增安全边界；应写明它防的是什么（未认证的同源上下文）与首帧握手时机，否则实现者会误加重试逻辑。（P-A 提出的"cookie 写入竞态"论据不成立，已剔除） | §5.4「key + 有效 DSH 会话 cookie + Origin 必须等于本服务 authority」 |
| MINOR | §8.2 E2E-0 断言② | 推理 | `setDraft(marker)` 会覆盖用户真实草稿，判据未要求断言后恢复原值；同时未记录"覆盖式写入"这一 Q4 的负例基线 | §8.2 E2E-0「调用 `shell.setDraft(marker)` 后，composer 内容**真的改变**」 |
| MINOR | §10 M3「debugger opt-in 增强（可靠点击/输入）」 | 推理 | 对 React/Vue 合成事件，CDP `Input.dispatchMouseEvent` 并非总生效，"可靠"二字不可验收；应改为分档指标 + 失败回退 `element.click()` 与诊断输出。（同时确认：PiMoa 上一轮对 `requiredVersion:"1.3"` 不足的怀疑不成立，`requiredVersion` 是最低版本声明，应维持 1.3） | §10 M3「**debugger opt-in 增强**（可靠点击/输入 + AX 读取，`requiredVersion:"1.3"`）」 |
| MINOR | §12.2 覆盖矩阵 | 推理 | 新增的"生产可用率预估"列无测量方法（"低"/"依赖 DOM 结构"），且与同格的 ✅ 混用两套语义（技术可达性 vs 产品覆盖率）——正是 §13.2 第 2 条禁止的形态 | §12.2「同源或带 CORS 的 `<track>`｜✅ 完整｜…｜**低**」 |
| MINOR | §9 T2 + §13.1 `graph:check` | 推理 | T2 承诺"M1 起在 `graph:check` 中加'密钥文件未被跟踪'断言"，但 §13.1 对 `graph:check` 的定义只含文档图谱与 broken-doc-link；应写明用 `git ls-files` 判定并列入 `npm run check` | §9 T2「M1 起在 `graph:check` 中加"密钥文件未被跟踪"断言」 vs §13.1 产物列 |
| MINOR | §8.1 `capture` 降级链用例 | 推理 | 只写了"质量→尺寸→丢弃"的 happy path，未规定判定时机（编码前预估 vs base64 后实测）与 `dropped.reason` 的枚举取值，实现与测试会各写各的 | §5.1「降级链：降质量（JPEG q80）→ 降尺寸（最长边 2048）→ 仍超则丢弃」 |
| MINOR | §6.3「已装 0.1.2-rc.1 实测 8 个」+ §6.3 契约路径 | 推理（**未能亲验**） | 两处【源码】断言目前都无法按引用在送审材料内复现（设计包不在可读根内；PiMoa 上一轮在源码检出未命中同路径）；应把内省原始输出与 d.ts 逐字片段 + commit/tag 贴入 `docs/reviews/`。**假设 B 维持"未证实"，不可据此断言文档有误** | §6.3 依据栏「【源码·可复现】…`contract/input.d.ts:202-213`…PiMoa 亲验：源码检出…**未命中**同路径」 |
| MINOR | §7.4 DRM 行 + §6.2 状态灯 | 推理 | ①"黑帧检测"无实现路径（Chrome 不返回 DRM 元数据，逐像素扫描成本未评估）；②冷启动 4–8s 期间顶栏状态灯只有 `connecting` 一态，缺 `starting-dsh / authenticating` 的文案映射，用户会以为卡死 | §7.4「页面为 chrome://、扩展商店、DRM｜注入失败/黑帧检测」＋ §6.2「`data-status="connecting"`」 |

---

## 三、【最终裁决】

**结论：有条件可开工 · 阻断项 2 · MAJOR 7 · MINOR 9。**

v3.2 对上一轮 6 条阻断是**真实落盘而非口头修复**：鉴权补第四形态、配对 key 与一次性 ticket 职责分离、WS 归属统一、体积上限收敛到同一测量轴、H4 单态化、E2E-0 改写为三条可判定硬断言，并把"评审条目→正文"对齐脚本化（`consistency-check.mjs`）——这与上一轮被点名的"修句子不修契约面"已形成实质区分，方向**不否掉**。但残留的两条阻断仍属同一病根的第三次浮现：修了 §5.4 的矩阵却没回改 §5.1 的端点表；补齐了 `cookies` 的权限最小化却没有回头核对"最小权限集能否支撑 §7.1 的意图触发路径"——后者尤为致命，因为它不是措辞问题，而是**旗舰交互「看左边」在最常见的"开面板后换过标签页"情形下会因缺 `activeTab`/host 权限而直接失败**，且 `scripting` 注入与 `captureVisibleTab` 会一起失权。因此开工前置条件是：①把 §5.1 端点表的鉴权列改为引用 §5.4 的形态编号，并在 `consistency-check` 里加一条"§5.4 之外出现裸『key + Origin』即失败"的规则；②在 M0a 追加一条权限实验（左侧开 fixture 页 → 三组对照：先点扩展图标 / 先点左侧网页 / 无任何手势，分别经 iframe 内触发调 `captureVisibleTab` 与 `executeScript`，记录 `lastError`），据结果决定是否必须把 `*://*/*` 或"触发前强制一次扩展侧手势"写回设计——这一条不解决，M2 的三天会全部押在一条走不通的主路径上。本轮全部证据强度均为"送审正文内自证的推理"（设计包不在审计可读根内，无一条亲验），故 §6.3 的两处【源码】断言与假设 B 一律维持**未证实**而非已证伪，M0a 必须以"安装产物逐字片段 + 版本号/commit + 内省原始输出落盘 `docs/reviews/`"作为闭环判据。最后两点定性建议直接写回文档：其一，M3 退出条件删去"可靠点击"，改为"普通 HTML 页 100% / 主流 SPA 80%+ 且失败可诊断"（同时保留本轮结论：`requiredVersion:"1.3"` 的怀疑不成立，不必上调）；其二，在 §10 末尾补一条应急预案——若 M0b 断言①（必须是 DSH 原生 composer）失败，自动追加 M0c 自研前端骨架预算并**整体重写 §0.3 与 §1.1 的收益表述**，把切换条件写成 CHANGELOG 的显式触发条目，避免第三次以"修句子"的方式回退。

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=9ff2210d1921… audit=/Users/mac/.pimoa/spool/20260911T173659-moa_verify-14787-gvtndl-9ff2210d1921.md
