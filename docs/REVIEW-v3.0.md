# 详细设计 v3.0 评审报告（Review of v3.0 → 修正为 v3.1）

**评审人**：DSH（本地 agent） · **日期** 2026-09-11 · **被评审对象**：`详细设计文档.md` v3.0、`PRD_需求定义说明书.md` v3.0、`DESIGN.md` v3.0、`README.md`
**结论**：**大方向正确，但不能直接开工**——存在 12 处硬错误（其中 4 处会直接让 M2 关键功能无法实现或让既有实测结论失效），另有 11 处"重写导致的信息丢失"需要回填。
**处理**：硬错误已全部修入 [详细设计文档.md](./详细设计文档.md) v3.1；信息丢失项已按附录形式回填并指向 `docs/*`；1 项需你拍板（A12）。

---

## A. 硬错误（必须修，否则会直接失败）

| # | 位置 | 错误 | 为什么是错的 | 修正 |
|---|---|---|---|---|
| **A1** | §6.2 iframe | `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"` | 我们的**全部实测证据都是在无 `sandbox` 条件下取得的**；`sandbox` 改变安全上下文（存储访问/剪贴板/下载/弹窗转义），可能直接破坏 cookie 投递与 WS 握手。此外 `allow-scripts`+`allow-same-origin` 组合本身就让 sandbox 形同虚设。 | 删除 `sandbox`；如确需，先补 E2E 证明 cookie 与 WS 仍可用 |
| **A2** | §6.2 iframe `src` | 硬编码 `http://127.0.0.1:3080/ag/enter`（无 `?key=`） | 插件对 `/ag/enter` 校验预共享 key；无 key 必然 **403**——文档自己在 §9 T2 就要求了 key | 运行时构造 `enterUrl(key)`；key 由 `scripts/init-key.mjs` 生成并注入 |
| **A3** | §5.1 payload | `"viewportScreenshot": "data:image/webp;base64,…"` | `chrome.tabs.captureVisibleTab` 的 `format` 只支持 `png` / `jpeg`，**不支持 webp**；且协议未约定是否带 dataURL 前缀 | 改为 `format:"png"`（大图可退化 `jpeg` q80），字段 `screenshot:{mime, base64(无前缀), width, height}`，并加体积上限与降级策略 |
| **A4** | §0.1 / §3 架构图 / §6.1 `intent-sniff.ts` / §7.1 | 把"输入框检测到『看左边』"放在**扩展端**（`panel.ts` / `content/intent-sniff.ts`） | 用户实际输入的输入框是 **iframe 内 DSH 的 composer**，跨域。扩展**读不到它的内容，也拿不到按键事件**。这条不修，PRD FR-2.0 的核心交互在 M2 根本无法实现 | 意图嗅探必须在 **DSH client 插件**内实现（它跑在页面里，可读草稿：`SessionInput`/`useInput` 快照）；扩展侧只保留顶栏按钮与快捷键；client 插件识别到意图后经 `WS /ag/client` 通知桥接插件去触发抓取 |
| **A5** | §9 T1 | "插件校验请求头中的 `Origin` 必须严格等于扩展 ID" | `/ag/enter` 是**导航请求，浏览器不发 `Origin` 头**。按字面实现会导致：要么把合法请求误杀，要么被迫放宽成无校验 | 明确三形态校验矩阵：`导航(key only)` / `fetch(key+Origin)` / `WS升级(key+Origin)`；已在 v3.1 §5.3 写入 |
| **A6** | §6.1 / §3 | client 插件描述为 "Web 注入脚本（Node.js/JS）" | DSH 浏览器插件**必须是 CJS 闭包工厂 bundle**：`window.__ModuleLoader__.load({id, factory})`，经 `package.json` 的 `exports["./client"]` 暴露，只能使用宿主 seed 的 **8 个**基线 external，且只以 `/plugins/??<pkg>/client.js&rev=…` 形式加载。"注入脚本"不是 DSH 支持的机制 | 按调研结论改写打包形态与 externals 白名单，补构建步骤（详见 `docs/03` §包与安装） |
| **A7** | §6.1 | 只有一句 `scripts/install-plugin.mjs`（"链接至 DSH 目录"） | `dsh plugin --profile web add` 依赖 **pnpm**；本机**没有 pnpm**（实测 `dsh plugin --profile web --help` → exit 127）。按此方案 M1 卡在安装 | 给出两条路径：①开发期 = profile `cordis.patch.yml` 绝对路径条目（**已实测跑通**）②生产期 = 打成 bundle + 装 pnpm 后 `dsh plugin add` |
| **A8** | §5.1 / §5.2 | `protocolVersion: 3`；WS 消息 `{id, tool, params}`；无错误封装、无 `/ag/pending`、`/ag/ack`、`hello`/`ping`、无错误码表 | 把**文档版本号**当协议版本；且与 `DESIGN.md`/`docs/01` 的信封不一致 → 三端实现必然对不上 | 协议统一为 **v1**（文档版本另计）；WS 统一信封 `{type:"request",id,op,args,deadline}` / `{type:"response",…}` / `{type:"event",…}`；补齐端点与错误码表；单源 schema 由 `protocol/messages.schema.json` 生成 |
| **A9** | §7.1 时序图 | `Input->>CS`（微壳直接调 content script）、`Input->>Model 提交 Prompt` | 扩展页**不能**直接调 content script（必须经 service worker 用 `chrome.scripting`/`tabs`）；提交 Prompt 发生在 **iframe 内的 DSH composer**，微壳无法提交 | 时序图改为：微壳 → SW →（scripting）CS → SW → 桥接插件；胶囊由 client 插件在 DSH composer 内渲染；提交由用户在 DSH composer 内完成 |
| **A10** | ADR-6 / FR-2.1 / G2 / §12.2 | 承诺"自动提取**全部**字幕"，仅把 DRM 列为"不支持 raw mp4" | ①跨域 `<track>` 在未开 CORS 时 `textTracks[i].cues` **读不到**（需 `mode='hidden'` 才填充）②YouTube/B站 DOM 只渲染**当前 cue**，完整时间轴需站点私有接口（签名参数、易变、可能违反条款）③DRM 保护画面下 `captureVisibleTab` 通常返回**黑帧**（不只"不传 mp4"） | 降级为 **best-effort + 覆盖矩阵**：同源/带 CORS 的 `<track>` ✅；播放器字幕面板 DOM（YouTube 等）✅ 但依赖 DOM 结构、标注易碎；完整时间轴字幕 ⚠️ 尽力；DRM ❌（截图黑帧）；验收标准按矩阵写 |
| **A11** | G1 / G2 | G1「≤1.5s composer 可输入」、G2「≤300ms」 | `dsh web` **冷启动实测约 4s**（本机实测）才能打印 token URL；SPA 在 iframe 内还要再启动。1.5s 作为**冷启动**指标不可达；300ms 也没写清页面规模/是否含截图/是否 p50 | 拆成冷/热启动：**热启动（DSH 已在跑）≤1.5s**、**冷启动（需拉起）≤8s**；抓取给出 p50/p95 与基准页（含 3 个规模档） |
| **A12** | ADR-4 / C5 / PRD FR-3.3 | 把"自动拉起 DSH"整段砍掉："依赖用户本机正在稳定运行的 DSH" | 你此前明确勾选过 **"自动拉起 DSH（native messaging 启动 dsh web，免手动开服务）"**。而该能力**不需要 Go**——一个 Node 脚本 + native messaging manifest 即可（我已实测 `dsh web` 冷启动 4s 打印带 token 的 URL，可自动拉起）。当前 DSH 恰好一直在跑，掩盖了这个缺口 | **需你拍板**：①恢复 native messaging 自动拉起（推荐，约 1 天）②或明确接受"手动先起 DSH"并在 G 表里删掉该期望。v3.1 暂按"计划恢复"标注为待决 |

---

## B. 信息丢失（v3.0 重写导致，须回填）

| # | 丢失内容 | 影响 | 处理 |
|---|---|---|---|
| B1 | 结论上的**证据等级**标注（【实测】/【源码】/【文档】/【待验证】） | 读者无法分辨硬事实与目标值，评审与复盘失去锚点 | v3.1 全篇恢复标注；对 1.5s/300ms/<1MB/<50ms/<20MB 等数字逐条标注"目标值·未测" |
| B2 | **测试方案**（单源 schema 同步测试、~60 条单测矩阵、10 个 E2E 用例及判据、harness 关键事实、覆盖率门槛、隔离清理） | 只剩 4 行（L0=TS 编译无 any、L3=两条手动断言）→ 无法作为正式项目的质量门槛 | v3.1 §8 恢复完整分层方案并指向 `docs/06` |
| B3 | **安全矩阵**（T5 提示注入、T7 数据泄漏、T9 key 残留、T11 越权、权限最小化表、审计日志） | 本地高权限 agent + 浏览器控制的组合，安全章节退化到 4 条不可接受 | v3.1 §9 恢复 12 条威胁 + 最小权限表 + 审计 |
| B4 | **平台约束速查**（侧边栏不能承载远程 URL、宽 360px、per-tab 隐藏语义、`captureVisibleTab` 2 次/秒与活动页限定、`host_permissions` 不支持端口、`debugger` 需 `requiredVersion:"1.3"` 且有不可消除横幅、native messaging 无 `args` 字段/1MB 上限/孙进程回收） | 实现时必然踩坑并返工 | v3.1 §11 恢复完整清单 |
| B5 | 目录结构缺 `native-host/`、`protocol/`、`tests/e2e/`、隔离 dev-home、配对文件 `$DSH_HOME/dsh-web-companion.json`、`scripts/init-key.mjs` | 与 M1/M2 实际产物不符 | v3.1 §6.1 补齐 |
| B6 | **失败降级矩阵**（DSH 未起/未配对/iframe 认证失败/附件准入失败/扩展未连接） | 没有错误处理契约，实现各写各的 | v3.1 §7.4 新增 |
| B7 | **未决问题清单**（Strict 的 fetch/WS 不对称机制、`createDraftImages` 运行时可达性、"光标处插入"载荷、cookie 格式漂移、master 改名 `addImages→addAttachments`） | 风险不可见，容易被当成已完成 | v3.1 §12.4 新增 |
| B8 | 版本语义 | 文档 v3.0 / 协议 "3" / 扩展版本混用 | 统一：文档 v3.1、协议 `protocolVersion:1`、各产物独立 semver |
| B9 | 命名不一致（`dsh-antigravity-bridge` / `com.antigravity.web_companion` / `antigravity-companion.json` vs 产品名 DSH Web Companion） | 安装脚本、配对文件、native host 名三处不一致会直接导致联调失败 | 统一为 `dsh-web-companion-bridge` / `com.dsh.web_companion` / `dsh-web-companion.json`；v3.1 全篇改名 |
| B10 | DSH 侧平台事实（Config 用 **Schemastery** 非 zod、必须声明 `inject`、`register/registerUpgrade` 契约、cookie 签名格式与回退链、composer 注入 API、图片限制 20MiB/20 张/64MP/8192px） | 写代码时必错 | v3.1 §11.2 恢复要点，细节指向 `docs/03`、`docs/04` |
| B11 | **DESIGN.md 与 详细设计文档 自相矛盾**（前者仍保留 native host 自动拉起、§2 架构图与 docs/05；后者说"不做"） | 同仓库两套结论，实施者无所适从 | 待 A12 拍板后统一；v3.1 已在两处标注冲突点 |

---

## C. 值得保留的部分（方向正确）

1. **收敛到 DSH 单内核，复用原生 GUI** —— 与我的 ADR-1 同结论，收益最大、风险最低。
2. **TS + 无重型前端框架** —— 与"扩展 <1MB"目标自洽（注意：体积主要取决于 Readability 等依赖，需实测基线，见 B1）。
3. **"看左边"单一触发点替代后台轮询**（C6）—— 比我的"点击抓取"更聪明，**前提是把嗅探点放进 client 插件**（A4）。
4. **视频/媒体维度进入 attach** —— 真实价值，按 A10 重划边界后可作为差异化亮点。
5. **Safari 明确不做** —— 与平台事实一致（无 `sidePanel` API）。
6. **Go 拉起器延后** —— 方向可接受；但别把"自动拉起"一起砍掉（A12）。

---

## D. 优化建议（不阻塞，但建议纳入）

| # | 建议 | 收益 |
|---|---|---|
| O1 | 建立**单一事实源** `protocol/messages.schema.json` + codegen + 三端同步测试；文档里的 JSON 片段由 schema 校验（CI 校验文档片段） | 消除 A8 类漂移 |
| O2 | 增加 `docs/CHANGELOG.md` 与"重写纪律"：大版本重写必须把旧版已验证细节以附录保留 | 本次已发生一次信息丢失（B1-B7） |
| O3 | "看左边"识别做得更稳：在 client 插件内匹配 `看左边` / `look left` / 独占行或命令前缀 + 视觉反馈（胶囊/顶栏闪烁），避免正文里出现该词被误触发 | 降低误触发与用户困惑 |
| O4 | 抓取加**预算控制**：正文截断阈值、截图 JPEG 质量与尺寸上限、图片张数上限（对齐 DSH 的 20MiB/20 张/64MP/8192px） | 防 token 爆炸与大图拒绝 |
| O5 | `chrome.debugger` 作为 **opt-in 增强**（可信输入事件 + Accessibility 树）；`scripting` 的 `isTrusted:false` 点击在复杂站点不可靠 | 提升 `browser_click` 成功率 |
| O6 | 引入**能力探测 shim** 应对 DSH master 的 API 改名（`addImages`→`addAttachments` 等） | 跨版本可用 |
| O7 | 建立 **文档图谱 + 代码图谱**（codegraph）+ 随进展更新的机制（本次任务 2 已落地） | 正式项目的可维护性基线 |
