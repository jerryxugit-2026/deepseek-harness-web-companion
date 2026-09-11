# dsh-chrome 可行性验证结果（FINDINGS）

目标：像 Chrome 自带的 Gemini 侧边栏那样，在网页上加一个按钮 → 点开侧边栏 → **侧边栏里就是本地 DSH 的完整 Web 界面** → 可以把当前网页 attach 进去 → 由本地完全体 agent 处理。

结论：**可行，并且已经在真实 Chrome（150.0.7871.125）里跑通到"侧边栏形态的 iframe 中，DSH GUI 完整认证启动，编辑器可用"这一步。** 下面是实测证据与仍然存在的工程约束。

---

## 1. 实测环境

- Chrome 150.0.7871.125（系统安装版，无头模式；扩展通过 CDP `Extensions.loadUnpacked` 加载）
- 本机正在运行的 DSH Web：`http://127.0.0.1:3080`（真实用户实例，真实 session/workspace）
- 验证脚本：`spike/run-embed.sh` + `spike/cdp-embed.mjs`
- 截图证据：`spike/out/panel-none-secure.png`、`spike/out/panel-partitioned-none-secure.png`
- 完整报告：`spike/out/embed-report.json`

## 2. 硬约束（读源码 + 实测确认）

| 事实 | 证据 |
|---|---|
| `/api` 有 Host/Origin 围栏：Host 必须是 loopback/trusted，`Sec-Fetch-Site: cross-site` 一律 403，Origin 必须与 Host 同 authority | `dsh-client-connection/lib/index.js` `isTrustedApiRequest()`；实测 `Origin: chrome-extension://…` → **403**，`Sec-Fetch-Site: cross-site` → **403**，无 cookie 的普通请求 → **401** |
| 浏览器会话是 **HttpOnly + SameSite=Strict** 的签名 cookie，绑定 authority（cookie 名 = `dsh-auth-` + base64url(sha256(authority))） | `dsh-client-connection/lib/index.js` `sessionCookie()` / `encodeCookie()` |
| 服务端不设任何 `X-Frame-Options` / CSP `frame-ancestors` | 全包 grep 无命中 → **可以被 iframe 嵌入** |
| Chrome 137+ 命令行 `--load-extension` 已不可用 | 实测加载失败；改用 CDP `Extensions.loadUnpacked`（路径不能含空格） |

**推论：扩展页面（chrome-extension://）不能直接 fetch DSH 的 `/api`（403）。但 iframe 内部的 DSH 页面自己发起的同源请求是合法的（Origin/Sec-Fetch-Site 都是它自己）。**

## 3. 实测结果矩阵

`panel.html`（扩展页）内嵌 `http://127.0.0.1:3080/`，cookie 由扩展用 `chrome.cookies.set` 安装：

| cookie 形态 | iframe 文档 | SPA 启动 | HTTP RPC | **WebSocket 事件流** | 编辑器 |
|---|---|---|---|---|---|
| `SameSite=Strict`（DSH 原生下发形态） | 200 | 渲染 | 200 ✅ | ❌ `HTTP Authentication failed; no valid credentials available`，无限 `connection lost, retry` | ❌ 无 |
| **`SameSite=None; Secure`** | 200 | ✅ 完整启动 | 200 ✅ | ✅ 无任何错误 | ✅ 可用（workspace=dsh project，模型 DeepSeek Flash High，"描述你想要构建的内容…"） |
| `Partitioned; SameSite=None; Secure`（CHIPS） | 200 | ✅ 完整启动 | 200 ✅ | ✅ | ✅ |

对照组（移除 cookie 后重载）：iframe 文档直接 **401**，即 fail-closed —— 认证确实由 cookie 提供，而不是被绕过。

补充实测：
- 扩展页直接 `fetch('http://127.0.0.1:3080/api/session/list', {credentials:'include'})` → **403 forbidden**（围栏生效，不是 Chrome 的本地网络限制）。
- 在有 cookie 的 iframe 内部直接发 RPC → **200**，即嵌入页面的认证通道完全正常。
- 窄宽度（420px，接近 Chrome 侧边栏宽度）布局：DSH UI 自带响应式，侧栏收起为图标，主区正常 —— 见截图。

## 4. 因此的目标架构

两段式，各自职责清晰：

**A. DSH 侧：一个插件 bundle（`dsh-chrome-bridge`）**，装进 `web` profile（`dsh plugin --profile web add …`）：
1. 注册一条**不走 `/api` 围栏**的自己的路由（`ctx.webServer.register`），例如 `GET /ext/enter`：
   - 仅接受被信任的 `chrome-extension://<固定ID>` Origin（外加一次性握手 key，key 在安装时写入 `$DSH_HOME` 与扩展）；
   - 用 `ctx.credentials` 里 `client-connection/browser-session` 的签名密钥，按 DSH 既有格式**签发一个会话 cookie**；
   - 返回 `303 → /` 并 `Set-Cookie: dsh-auth-…=…; SameSite=None; Secure; HttpOnly; Path=/`。
   - 这一步是"侧边栏里那一个 iframe 能被认证"的钥匙（实测 Strict 会让 WS 挂掉，必须 None+Secure）。
2. `POST /ext/attach`：接收扩展抓取的网页内容（Markdown/HTML/选区/截图 PNG），写入当前工作区文件或 DSH 的持久 attachment 存储，返回可引用的描述符。
3. 可选：`GET /ext/events`（SSE），让扩展在不打开 iframe 时也能知道会话状态。

**B. Chrome 扩展（MV3）**：
- `action` 按钮（点击开侧边栏）+ 右键菜单 "Ask DSH about this page"；
- **side panel**：`panel.html` = 握手 + iframe 指向 `http://127.0.0.1:3080/ext/enter?...`；
- **content script**：抓当前页面（正文 innerText/Readability→Markdown、选区、`chrome.tabs.captureVisibleTab` 截图）；
- 通过 `postMessage` 把 attach 内容送进 iframe 内的 DSH 页面；
- 兜底：若用户 Chrome 禁了第三方 cookie，侧边栏失败 → 一键"在独立窗口打开"（顶层上下文，无任何 cookie 限制）。

**C. DSH 客户端插件（小）**：在 DSH 页面里监听扩展的 `postMessage`，把 attach 的内容插进 composer（文本 + 图片附件），并显示一个"已附加网页"的 chip。这是让 attach 体验像 Gemini 的关键一环（否则只能退化成"把内容写成文件再手动 @ 引用"）。

## 5. 仍需验证/决策的点

1. 用户 Chrome 若开启 "Block third-party cookies"，`SameSite=None` 是否仍被放行（Partitioned/CHIPS 是已实测的备选方案；两条路都已验证可用）。
2. DSH 未启动时的 UX（提示 / 后续用 native messaging 直接把 `dsh web` 拉起来）。
3. attach 内容进 composer 用哪个客户端 API 最稳（`dsh-client-ui-conversation` 的 `ctx.uiConversation` / input actions / attachment 准入路径，需在实现阶段定）。
4. 签名 cookie 格式属于 DSH 内部实现：需加版本探测 + 失败回退（例如回退到"让用户粘贴启动 URL 里的 token"）。

## 6. 复现方式

```sh
cd spike
./run-embed.sh          # 无头 Chrome + 扩展 + CDP 驱动，输出 out/embed-report.json 与截图
node mint-cookie.mjs    # 单独验证：用 $DSH_HOME 的签名密钥签发一个合法会话 cookie
```
