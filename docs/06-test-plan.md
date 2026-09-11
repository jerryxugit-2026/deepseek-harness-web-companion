# 06 · 测试方案（单测矩阵 + E2E）

**原则**：能纯函数化的一律纯函数化（Markdown 转换、协议校验、payload 组装、帧编解码、cookie 签名）；凡涉及 Chrome 真实行为（cookie 投递、iframe 嵌入、side panel、native messaging、`scripting` 注入）**一律用真实浏览器 E2E 覆盖**，不靠 mock 自证。

---

## 1. 测试分层

| 层 | 名称 | 载体 | 运行命令 | 覆盖对象 |
|---|---|---|---|---|
| L0 | 协议契约 | node + schema | `npm run test:protocol` | 单源 schema、codegen 同步、正反向量 |
| L1 | 单元 | vitest（+jsdom 用于 DOM） | `npm run test:unit` | 见 §2 逐模块矩阵 |
| L2 | 宿主集成 | node:http + ws（真 socket） | `npm run test:integration` | 桥接插件路由/WS/落盘（不启动 DSH 本体） |
| L3 | 端到端 | 真实 Chrome + 真实 DSH + CDP | `npm run test:e2e` | §3 用例表 |
| L4 | 人工验收 | 清单 | — | §5 |

---

## 2. 单元 / 集成矩阵（汇总）

| 模块 | 测试文件 | 用例数（目标） | 判定标准 |
|---|---|---|---|
| `protocol/codegen` | `protocol/tests/sync.test.mjs` | 6 | 生成物 sha256 与 schema 一致；valid 全过；invalid 全拒 |
| `extension/src/content/markdown.js` | `extension/tests/unit/markdown.test.js` | 8+ | HTML→MD 规则逐条断言 |
| `extension/src/content/extract.fn.js` | `.../extract.test.js` | 5+ | jsdom 加载 fixture 断言正文/元数据/噪音剔除 |
| `extension/src/sw/dsh-session.js` | `.../dsh-session.test.js` | 5+ | 200/403/超时/拉起失败/版本不匹配 |
| `extension/src/sw/native-host.js` | `.../native-host.test.js` | 4+ | 帧编解码、超时、`lastError` 映射、id 不匹配丢弃 |
| `extension/src/sw/capture.js` | `.../capture.test.js` | 4+ | 三 mode 组装、MAIN 注入失败回退、截断 |
| `extension/src/sw/attach-sender.js` | `.../attach-sender.test.js` | 4+ | 错误码映射与重试策略 |
| `extension/src/sw/agent-bridge.js` + `ops/*` | `.../agent-bridge.test.js`、`ops-*.test.js` | 6+ / 每 op 3+ | 心跳、退避、未知 op、超时、选择器未命中 |
| `extension/src/sidepanel/state.js` | `.../state.test.js` | 3+ | 状态迁移表 + 订阅 |
| `extension/src/lib/cookie.js` | `.../cookie.test.js` | 3+ | `no_restriction`+`secure` 属性、先删后设 |
| `dsh-plugin guard/cookie` | `dsh-plugin/tests/host/{guard,cookie.vector}.test.ts` | 8+ | 鉴权矩阵；**固定向量逐字节相等** |
| `dsh-plugin routes` | `.../routes.{enter,attach,pending,ack}.test.ts` | 15+ | 状态码、头、队列、上限 |
| `dsh-plugin store` | `.../store.test.ts` | 4+ | 文件名规则、front-matter、原子写 |
| `dsh-plugin hub` | `.../hub.test.ts` | 6+ | 关联、超时、断连立即失败、心跳、并发上限 |
| `dsh-plugin tool-bridge` | `.../tool-bridge.test.ts` | 5+ | 注册矩阵、错误文本、取消 |
| `dsh-plugin client`（见 docs/04） | `dsh-plugin/tests/client/*.test.ts` | 6+ | origin 校验、注入调用参数、胶囊渲染 |
| `native-host` | `native-host/tests/*.test.mjs` | 15+ | 帧、拉起、安装 |

门槛：`lib/`、`ops/`、`markdown.js`、`guard/cookie/store` 行覆盖 ≥85%；其余 ≥70%。

---

## 3. E2E 测试方案（L3）

### 3.1 harness 结构

```
tests/e2e/
├── harness/
│   ├── chrome.mjs        # 启动无头 Chrome + CDP 连接 + Extensions.loadUnpacked
│   ├── dsh.mjs           # 启动一个专用 dsh web 实例（独立端口），等待就绪
│   ├── fixture.mjs       # 目标网页 fixture（含可点击/可输入元素、长正文）
│   ├── cdp.mjs           # CDP 薄封装（send/on/evaluate/attachOopif/screenshot）
│   └── assert.mjs        # 断言助手（HTTP 状态图、DOM、WS 帧、截图差异）
├── cases/
│   ├── e2e1-embed.mjs  e2e2-attach-page.mjs  e2e3-attach-selection.mjs
│   ├── e2e4-attach-screenshot.mjs  e2e5-chip.mjs  e2e6-browser-read.mjs
│   ├── e2e7-browser-click-type.mjs  e2e8-autostart.mjs  e2e9-tp-cookie-blocked.mjs
│   └── e2e10-regression-baseline.mjs
└── run.mjs               # 串行执行 + 汇总报告（JSON + Markdown）
```

复用已验证的 spike 资产：`spike/mint-cookie.mjs`（cookie 签名算法自检）、`spike/cdp-embed.mjs`（OOPIF 遥测、变体矩阵）、`spike/run-embed.sh`（无头 Chrome + 无空格路径扩展加载）。

关键 harness 约束（已在 spike 中踩过 / 调研确认）：
- 扩展必须经 **CDP `Extensions.loadUnpacked`** 加载（Chrome 137+ 命令行开关已移除，139 起品牌版连 `--disable-extensions-except` 也移除了），且**目录路径不能含空格** → harness 先把 `extension/` 复制到 `/tmp/ag-ext-<hash>`。扩展 ID 已由 manifest `key` 钉死（`scripts/init-key.mjs` 生成），因此 `allowed_origins` 与配对文件在自动化环境里稳定可预期。
- 若要断言 iframe 内部的 HTTP/WS 行为，必须开 `Target.setAutoAttach({flatten:true})` 并对 **OOPIF 子 target** 单独 `Runtime/Network/Log.enable`（只靠父 target 看不到 iframe 的请求）。
- 截图用父 target 的 `Page.captureScreenshot`（合成结果包含 OOPIF 内容，已成 spike 证据）。
- 本机 Chrome 的 `--no-sandbox`/`--disable-gpu` 在受限环境下可减少子进程崩溃噪声（spike 实测有效）。
- DSH 实例用**独立 `DSH_HOME` + 独立端口**（本项目用 `.devhome` + 3099），并在 profile 的 `cordis.patch.yml` 里以**绝对路径**插入桥接插件（本机无 pnpm，`dsh plugin add` 不可用）。

### 3.2 用例表

| 用例 | 前置 | 步骤 | 通过判据（全部满足） | 产物 |
|---|---|---|---|---|
| **E2E-1 嵌入与认证** | DSH 在 3080；插件已装；扩展已载 | ①装会话 cookie（走真实 `/ag/enter`）②打开 `panel.html` ③等待 15s | ①iframe target 出现且 URL=`http://127.0.0.1:3080/` ②OOPIF 内 `document.title === 'DeepSeek Harness'` ③composer 元素存在 ④无 `connection lost` ⑤`/api/remote.mux` WS 无 401（Network 事件断言） | `out/e2e1.png`、`out/e2e1.json`（HTTP 状态图） |
| **E2E-2 Attach 整页** | E2E-1 通过；fixture 页为活动标签 | ①打开 fixture 页 ②点面板 `Attach 网页 → 整页` | ①`POST /ag/attach` 200 ②返回值含 `fileRef`、`filePath` ③该文件存在且 front-matter 里 `url` 等于 fixture URL ④正文含 fixture 独有字符串 | `out/e2e2.md`（落盘文件副本） |
| **E2E-3 Attach 选区** | 同上 | ①在 fixture 页选中一段文本（`Runtime.evaluate` 设置 selection）②点 `Attach 网页 → 选区` | ①提交体 `mode` 含 `selection` ②`selection.text` 与所选文本一致（去空白）③文件内含「选区引用块」 | `out/e2e3.json` |
| **E2E-4 Attach 截图** | 同上 | ①点 `Attach 网页 → 截图` | ①返回 `imageRef.attachmentId` 非空 ②`/ag/attach` 体积在限内 ③附件可用（客户端能取到 URL 或文件存在） | `out/e2e4.json` |
| **E2E-5 胶囊入 composer** | E2E-2 通过；DSH 页面内 client 插件在线 | ①触发 attach ②等 5s | ①OOPIF 内存在胶囊节点（`[data-ag-chip]`）②胶囊文本含页面标题 ③点击 ✕ 后节点消失且 `POST /ag/ack` 收到 `dismissed` | `out/e2e5.png` |
| **E2E-6 browser_read_page** | 扩展 SW 与 `/ag/agent` 已连接 | ①在 DSH 侧触发一次 `browser_read_page`（临时注册测试工具或直接对 `/ag/agent` 发请求） | ①返回 `title/url` 与 fixture 一致 ②`text` 含 fixture 独有字符串 ③无控制台错误 | `out/e2e6.json` |
| **E2E-7 点击与输入** | 同上；`allowBrowserWriteOps=true` | ①`browser_click{selector:'#btn'}` ②`browser_type{selector:'#input',text:'hello',submit:true}` | ①点击后 fixture 页 `#log` 文本变化 ②输入框值与提交结果变化 ③两次都在超时内返回且 `ok:true` | `out/e2e7.png` |
| **E2E-8 自动拉起 DSH** | **故意不启动 DSH** | ①点扩展按钮 ②等待 | ①native host 收到 `ensure-dsh` ②`dsh web` 进程出现 ③扩展拿到 URL 或走 `/ag/enter` ④最终 E2E-1 的认证判据全部满足 | `out/e2e8.json`（含耗时） |
| **E2E-9 第三方 cookie 被禁** | Chrome 以 `--disable-features=...` / 预置偏好禁用 3P cookie；插件 `cookieMode=partitioned` | ①同 E2E-1 | ①分区 cookie 下认证仍成功 **或** ②按设计降级：出现独立窗口且其内认证成功，侧边栏显示降级提示 | `out/e2e9.json` |
| **E2E-10 基线回归** | — | ①执行 `spike/run-embed.sh` | ①与 `spike/out/embed-report.json` 中记录的判据一致：`panel-none-secure` 变体 composer 存在、无 WS 错误 | `spike/out/*` |

失败即视为阻塞发布；每个用例失败时 harness 必须导出：截图、CDP 事件摘要（HTTP 图/WS 帧/console）、以及被测进程日志尾部。

### 3.3 运行方式

```sh
# 一次性准备
npm --prefix extension install && npm --prefix dsh-plugin install
node protocol/codegen.mjs
node native-host/install.mjs --extension-id <id>
dsh plugin --profile web add "$PWD/dsh-plugin"     # 把桥接插件装进 web profile

# 分层执行
npm run test:protocol && npm run test:unit && npm run test:integration
npm run test:e2e -- --case e2e1                     # 单用例（调试用）
npm run test:e2e                                    # 全量，串行
```

报告：`tests/e2e/out/report.json` + `report.md`（含每个用例的耗时、判据逐条 ✅/❌、产物路径）。

---

## 4. 隔离与清理

- E2E 使用**临时 Chrome profile**（`$TMPDIR/ag-e2e-profile`），结束即删；绝不触碰用户日常 profile。
- E2E 的 DSH 实例使用**独立端口**（默认 3099）与**独立 DSH_HOME**（复制必要的 `.credentials.yaml` 以便模型可用；仅回环），结束即停。
- E2E 写入的 attach 文件落在**临时工作区**（`$TMPDIR/ag-e2e-workspace`），不污染真实项目目录。
- 所有 harness 进程在 `finally` 中 kill；失败也保证清理（`process.on('exit')` + `SIGINT` 处理）。

---

## 5. 人工验收清单（L4）

1. 侧边栏在 1366×768 与 1920×1080 下均可用；宽度拖到最窄（约 320px）时不出现横向滚动条。
2. 真实网页（GitHub Issue / 技术文档 / 长文章）Attach 后 token 规模可接受（Markdown ≤ 120k 字符，超出有截断提示）。
3. 选区浮标不影响页面交互（不遮挡按钮、不劫持点击、页面样式零污染——Shadow DOM）。
4. Agent 在 attach 后能读取本地工作区文件并落盘改动（对照 PRD 场景 A/B）。
5. 截图 attach 后多模态模型能描述页面布局（对照 PRD 场景 C）。
6. 关闭侧边栏后 WS 断开、无残留进程；再次打开 ≤1s 恢复。
7. 卸载扩展后 DSH 无残留路由/进程（`/ag/ping` 返回 404），native host manifest 可由 `uninstall.mjs` 清除。
