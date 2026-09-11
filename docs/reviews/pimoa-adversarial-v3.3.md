# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`详细设计文档.md`、`docs/reviews/pimoa-adversarial-v3.2.md`、`docs/CHANGELOG.md`
- prompt：`scripts/review-prompts/design-adversarial.md`
- 用时：227.3s
- 裁决（status）：**unknown**
- 生成时间：2026-09-11T17:42:06.279Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
## 三、【最终裁决】

**结论：有条件可开工 · 阻断项 1 · MAJOR 8 · MINOR 7。** 本轮最重要的进展是一条**亲验结论**：DSH 源码检出 `packages/client/ui-conversation/src/client/input/contract.ts` 中 `setDraft`/`addImages`/`submit` **确实存在**（`:35/:37/:46`），此前两轮"源码检出未命中"实为 glob 写法（限 `*.d.ts`）与 `packages/credentials` 权限截断所致——因此**假设 B 应从"未证实"上调为"符号已亲验成立、引用路径失准"**，必须纠正的是 §6.3 的文件名/行号引用而非证据等级，更**不应据此提前触发 M0c**。但同一次亲验也推翻了设计的一条核心前提：真实签名为 `setDraft(text, editRange?)`（`:104`，配套 `EditRange` 于 `:147`、`draft-changed` 事件于 `:253`），说明"`setDraft` 是唯一整段写入入口"不成立，v3.3 为此新写的三分支撤销契约与 Q4 都建立在伪约束上，应在 M0a 一并复核后简化。唯一的开工阻断是权限模型：v3.3 为修 v3.2 的 BLOCKER-B 引入 `optional_host_permissions` + 首次引导授予，却未意识到**授予动作本身也需要扩展侧用户手势**，而意图路径（F4 → 桥接插件 → SW）全程无手势——授权卡弹不出、`activeTab` 不激活、`executeScript` 与 `captureVisibleTab` 同时失权，旗舰交互「看左边」在其主路径上物理不可行；开工前必须在 §0.1/§9 中**三选一写死**（声明式 host_permissions ／ 意图触发一律降级为"微壳按钮确认后再抓" ／ 首启强制走一次按钮路径完成授权），并在 M0a 的权限对照实验里补测"无手势调用 `permissions.request` 的 `lastError`"。其余应在 M1 前落盘的还有四项契约面缺口：`attachmentId`→`File` 的取回通道（新增 `GET /ag/attachment` 或 attach 事件直带 base64，二选一写进 §5.2）、漂移 shim 补 `setDraft`、`/ag/agent` 与 `/ag/client` 的重连状态机拆分、§7.4 补"DSH 未登录/会话失效导致 F4 恒 403"降级行并把 ack 与 UI 撤销解耦。方案整体**不否掉**：认证链路有实测截图支撑，composer 契约现已亲验，M0a/M0b/M0c 的证伪与切换窗口设计合理；最脆弱的两个假设应更新为——①`optional_host_permissions` 与无手势意图触发能否共存（当前判断为大概率互斥，是唯一阻断），②截图能否真正成为 composer 附件（`createDraftImages` 尚未亲验命中 + 二进制取回通道缺失），二者任一崩塌都只影响"看左边"的便捷入口与多模态验收，不影响 M1 认证、M2 落盘、M3 反向控制的主干。

## 一、【冲突点与采信】

| 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|
| §6.3「`setDraft` 等契约在 DSH 源码中是否存在」 | P-B（deepseek）：`packages/` 下两轮检索零命中，证据等级失真，应下调为【未证实】并"立即触发 M0c" | **均不采信，改判为"已亲验存在"** | 本次亲验：`/Volumes/Ex/ai_workspace/deepseek-harness/packages/client/ui-conversation/src/client/input/contract.ts:35,37,46,75,77,83,104,106` 同时出现 `setDraft` / `addImages` / `submit`。P-B 的零命中源于其把 glob 限死为 `*.d.ts`（检出是 `src/*.ts` 布局）且 `packages/credentials` 权限报错截断遍历——**用被截断的否定检索写成了结论**，正是任务纪律禁止的"把猜测写成结论"。设计文档所引的**行号/文件名（`lib/types/.../contract/input.d.ts:202-213`）仍然对不上**，属引用路径失准，非断言失真 |
| 权限模型（`*://*/*` optional + 意图路径无手势） | P-A（MiniMax）：`activeTab` 在意图路径永不激活，定 MAJOR；P-B：`chrome.permissions.request()` 无手势必抛错，授权卡在旗舰场景根本弹不出，定 BLOCKER | **采信 P-B 的定级（BLOCKER），并入 P-A 的论据** | P-B 指出了更致命的一层：v3.3 的"首次使用引导授予"**其自身的授予动作**也依赖扩展侧手势，因此该修法没有真正修掉 v3.2 的 BLOCKER-B，只是把失权点从抓取挪到了授权。两人论据互补，合并为一条阻断 |
| 配对 key 如何首次进入 `chrome.storage.local` | P-B：`init-key.mjs` 是 Node 脚本写不了扩展存储，构成"要鉴权先有 key / 要拿 key 先鉴权"的循环，定 BLOCKER；P-A 未提 | **采信问题，降为 MAJOR** | §6.1 明确 `init-key.mjs` 同时生成 `extension/src/lib/dev-config.js`——**开发期投递通道已存在**，循环不成立；真实缺口只在**生产期**（无 dev-config 时用户如何输入配对码）与 §7.2 时序未画该分支 |
| F4「必须携带有效 DSH 会话 cookie」的风险 | P-A：未登录/会话过期时 `/ag/ack` 恒 403 且 §7.4 无对应降级行，定 BLOCKER；P-B 未提 | **采信"§7.4 缺行"，降为 MAJOR** | 缺降级行是可核对的真实缺口；但 P-A 关于"DSH 服务端驱逐内存会话"的事故链属推测，无材料支撑，不足以支撑阻断级 |
| 重连后 `hello` + `request-pending` 的通道归属 | P-A：`request-pending` 属 `/ag/client`（client 插件侧），微壳在 `/ag/agent` 上发它是通道混淆，定 MAJOR；P-B 未提 | **采信 P-A** | 少数方给出可核对交叉证据：§5.2 通道表把 `request-pending` 归在 `/ag/client` 的 client→插件方向，而 §6.2 让微壳重连后发它 |
| `cordis.patch.yml` 绝对路径含空格未实测 | P-A：定 MAJOR，M0a 需补验 | **降为 MINOR** | §6.4 与 C7 均标注该路径**已在本机（路径本身含空格）实测跑通**；纪律要求"已被实测支撑的项不凭常识否定"，仅可要求把日志落盘 |
| §0.2 H4 保留选项②表格 | P-A：与 §13.2 纪律 3 冲突，MINOR | **不采信** | 表外已用"决策（已定，非待定）"单态化，并给出改选时的成组修改清单，属规范的决策留痕，非冲突 |
| 依赖钉版 / lockfile 缺失 | P-A：无 `package-lock` 会让 external 解析崩，MAJOR | **降为 MINOR** | seed external 按**包名**白名单匹配，transitive 版本漂移导致 `__ModuleLoader__.load` 失败的链条未经证实；但"协议有 sha256、依赖无锁"的不对称确是工程缺口 |
| 两方一致且我复核认可的 | imageRef→`File` 取不回二进制（v3.2 已提、v3.3 未修）；漂移 shim 漏 `setDraft`；§12.2 可用率列无测量方法；§7.4 DRM「黑帧检测」无实现路径 | **全部采信** | 逐条可在正文定位，且均为 v3.2 已点名而 v3.3 未落盘的残留 |

---

## 二、【逐条裁决】

| 级别 | 位置#符号 | 证据强度 | 理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | 详细设计 §9 权限模型#`optional_host_permissions` × §7.1 意图路径 | 推理（正文三处交叉） | 意图路径全程无扩展侧手势，`chrome.permissions.request` 无法发起，`activeTab` 也不激活 → 授权卡与抓取**同时**不可达，v3.3 的修法未真正闭合 v3.2 的 BLOCKER-B | §9「`*://*/*`｜`optional_host_permissions`，首次使用引导授予」＋降级契约 1「首次点「👀 看左边」（或首次意图触发）时…弹出一次说明卡」 vs §7.1「`Host->>SW: 触发抓取（微壳中转）`」 |
| MAJOR | 详细设计 §6.3#`setDraft` 是**唯一整段写入**入口 ＋ 插入/撤销契约 ＋ §12.4 Q4 | **亲验** | 真实契约为 `setDraft(text: string, editRange?: EditRange)`，即**支持区间写入**；建立在"只能整段覆盖"之上的三分支撤销契约与 Q4「光标处插入载荷未知」都是伪约束，会让 M2 写出不必要的复杂逻辑 | `packages/client/ui-conversation/src/client/input/contract.ts:104`「`setDraft(text: string, editRange?: EditRange): void`」；另见 `:147` `EditRange`、`:253` `draft-changed` 事件带 `editRange` |
| MAJOR | 详细设计 §6.3#【源码·可复现】引用路径 | **亲验** | 符号存在但**所引文件名与行号在检出中不成立**（检出为 `src/client/input/contract.ts`，非 `lib/types/client/contract/input.d.ts:202-213`）；等级可保留【源码】，引用必须改为"安装产物 vs 源码检出"双路径并各贴逐字片段 | 设计 §6.3 依据栏 vs 亲验命中 `contract.ts:35/37/46` |
| MAJOR | 详细设计 §5.1 响应#`imageRef.attachmentId` × §6.3#`createDraftImages([File])` | 推理 | client 端无任何路径由 `attachmentId` 取回二进制（无下载端点、无 base64 回传约定），v3.2 已列 MAJOR，v3.3 未修，只把它改写为"默认降级"，却未同步下调 §8.3 第 5 条多模态验收 | §5.1「`"imageRef": { "attachmentId": "att_…", "mime": "image/png" }`」 vs §6.3「`createDraftImages([File])`…**无需宿主往返**」 |
| MAJOR | 详细设计 §6.3#API 漂移 shim 清单 | 推理＋亲验佐证 | shim 只覆盖图片两组 API，漏掉全链最高频的 `setDraft`；而亲验显示同一契约文件里 `setDraft` 已存在**双签名**，正说明该符号本身在演进 | §6.3「先探测 `createDraftImages ?? createDraftAttachments`、`addImages ?? addAttachments`」 vs §7.1 第 8 步与 E2E-0 断言②均依赖 `setDraft` |
| MAJOR | 详细设计 §6.2#`bridgeSocket()` 重连状态机 | 推理 | 重连后由**微壳**发 `request-pending`，但该消息在 §5.2 通道表中属 `/ag/client` 的 client 插件→插件方向，两条 WS 被捆在一个状态机里；Q8 亦未定义 `/ag/client` 由谁持有、冻结后如何恢复 | §6.2「重连成功后发 `hello` + `request-pending`」 vs §5.2「`WS /ag/client`｜client → 插件（`hello`、`ack`、`request-pending`、`intent`）」 |
| MAJOR | 详细设计 §5.4#F4「有效 DSH 会话 cookie」 × §7.4 降级矩阵 | 推理 | 未登录/会话失效时 `/ag/ack`、`/ag/pending` 恒 403，而 §7.4 十余行降级中**无任何一行**覆盖该态，client 插件会进入无止境重试；且 ack 失败与 UI 撤销未解耦 | §5.4 F4「key + 有效 DSH 会话 cookie + Origin 必须等于本服务 authority」 vs §7.4 全表（无"DSH 未登录/会话过期"行） |
| MAJOR | 详细设计 §5.4 key 生命周期#配对投递 × §7.2 时序 | 推理 | 只定义了权威源与漂移检测，未定义**生产期**扩展侧首次获得 key 的通道（开发期靠 `init-key.mjs` 生成 `dev-config.js`，生产期空白），§7.2 `paired=true` 分支默认 key 已在扩展侧 | §5.4「权威源 = `$DSH_HOME/dsh-web-companion.json`…`chrome.storage.local` 是缓存副本」 vs §6.1「`scripts/init-key.mjs` # 生成配对（扩展 key + … + dev-config）」 |
| MAJOR | 详细设计 §1.2 G2 × §10 M2 退出条件 | 推理 | 链路含 ≥3 次跨进程往返 + Readability/turndown，p50 ≤300ms 无基线；M2 三天退出条件既无性能项，也未把"产出基线报告"与"达标"分开（v3.2 已提，v3.3 未修） | §1.2 G2「轻量页（<50KB 正文）p50 ≤300ms」＋ §10 M2 退出条件行 |
| MINOR | 详细设计 §12.2#「生产可用率预估」列 | 推理 | 该列无测量方法（"低"/"依赖 DOM 结构"），与同格 ✅ 混用"技术可达性 / 产品覆盖率"两套语义，违反 §13.2 第 2 条；v3.2 已提未修 | §12.2 首行「同源或带 CORS 的 `<track>`｜✅ 完整｜…｜**低**」 |
| MINOR | 详细设计 §7.4#DRM 行「黑帧检测」 | 推理 | Chrome 不暴露 DRM 元数据，逐像素扫描成本未评估，该"检测方式"不可实现；应改为域名/协议前置拦截 + 结果标注 | §7.4「页面为 chrome://、扩展商店、DRM｜注入失败/黑帧检测」 |
| MINOR | 详细设计 §7.4 × §11.1#`chrome.debugger` | 推理 | 「DevTools 打开会踢掉扩展」是已写明的平台事实，但降级矩阵无对应行，M3 增强路径在用户开 DevTools 时静默失效 | §11.1「DevTools 打开会踢掉扩展」 vs §7.4 全表 |
| MINOR | 详细设计 §10 M3 退出条件#「普通 HTML 页 100%」 | 推理 | 方向修正正确（删"可靠"），但 100% 是无基线的绝对门槛，且未写测量方法（样本量/重复次数） | §10 M3「点击/输入成功率目标：普通 HTML 页 100%、主流 SPA ≥80%」 |
| MINOR | 详细设计 §5.1#`GET /ag/pending?peek=1` × §5.4 F4 | 推理 | F4 定义只涵盖 Origin/cookie/key，未说明覆盖 `pending`/`ack`/`hello`，`peek` 语义也未在鉴权面出现 | §5.1「`GET /ag/pending`｜**F4**｜…（`?peek=1` 不消费）」 |
| MINOR | 详细设计 §6.1/§6.4#依赖锁定 | 推理 | 三处钉 `0.1.2-rc.1` 但全文无 lockfile / `npm ci` 纪律，协议面有 sha256 而依赖面无校验 | §6.4「依赖版本｜`@deepseek-ai/dsh-*` 必须钉 `0.1.2-rc.1`」＋ §6.1 目录树（无 lock 文件） |
| MINOR | 详细设计 §6.4#开发期安装（含空格绝对路径） | 推理 | 标注为【实测】可信，但无落盘证据；建议把插件加载成功的探测输出（如 `ctx.plugin(...)` 存在性）归档，避免与 C9 的扩展侧空格问题混谈 | §6.4「profile `cordis.patch.yml`：`- insert: [{ id: …, name: '<绝对路径>/src/host/index.js' }]`（**已实测**）」 |
| MINOR | 详细设计 §6.3 external#探针失败行为 | 推理 | 两段式内省修掉了"构建期没有 window"的矛盾，但未定义探针失败时构建是否 fail-closed（禁止静默回退手抄清单） | §6.3「①**运行时**…导出 `docs/reviews/probe-seed.json`；②**构建期**…读取该 JSON 生成 `external` 配置」 |

**不确定但值得验证的 3 条**
1. `createDraftImages` / `createDraftAttachments` 是否真实存在：本轮仅在 `input/contract.ts` 内确认 `setDraft/addImages/submit`，未命中 `createDraftImages`（取证预算耗尽，未全仓搜）。验证：`rg -n 'createDraftImage|createDraftAttachment' packages/client` 并把输出落 `docs/reviews/probe-draft-images.json`；同时在真实页面内省 `ctx.conversation` 运行时键集。
2. `chrome.permissions.request({origins:['*://*/*']})` 在侧边栏文档**无手势**、以及在 SW 中调用的实际行为：写最小扩展，分别在 `action.onClicked` 回调内与 iframe 触发路径上调用，记录 `lastError`。**这一条直接决定上面唯一阻断的修法三选一**。
3. `setDraft(text, editRange)` 的区间写入在 client 插件侧是否可用（即 Q4 是否可直接关闭）：在 M0a 探针里调 `shell.setDraft(marker, {start,end,…})` 并读回 `draft-changed` 事件（`contract.ts:253` 已带 `editRange`），若成立则 §6.3 撤销契约三分支可大幅简化。

**被高估的部分**
- **「复用视觉层、UI 代码接近 0」**：本轮亲验使假设 B 的**符号面**成立（利好），但收益仍受制于两点——图片附件链路（`attachmentId`→`File`）尚无实现路径、权限路径未通；§1.1 愿景里的"点一下即用"实际包含"首授 host 权限 + DSH 已登录 + 可能落到手势降级"三个前置，愿景文案与 §9 授权流存在明显体验落差。
- **G1 冷启动 ≤8s**：基线 4s 只是"端口可用"，未含 native host spawn、iframe 加载、DSH 首屏到 composer 可输入；M0b 必须产出这段的实测分解，否则 8s 是纸面数字。
- **「0 新增常驻进程」**：表述本身无误（按需拉起、随生命周期回收），但 native host 仍是新 Node 进程，建议写成"按需临时拉起、不常驻"，消除误读。

---

## 三、【最终裁决】


⚠️ [正文 8732 字符超回包预算 10000，已按行截取前 8778 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260911T174206-moa_verify-14787-y5ixdr-1f6b55e4180f.md（sha256=7588b10c561d…，50325 字节，保留至 2026-09-25），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=1f6b55e4180f… audit=/Users/mac/.pimoa/spool/20260911T174206-moa_verify-14787-y5ixdr-1f6b55e4180f.md
