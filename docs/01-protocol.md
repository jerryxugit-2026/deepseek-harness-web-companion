# 01 · 协议契约（Protocol）

**适用范围**：Chrome 扩展 ⇄ DSH 桥接插件 ⇄ DSH 客户端插件 ⇄ native host 之间的全部线上消息。
**单源原则**：所有消息结构定义在 `protocol/messages.schema.json`（JSON Schema 2020-12），通过 `protocol/codegen.mjs` 生成三端代码；任何一端手写结构体都视为 bug（见 §7 同步测试）。

---

## 1. 命名与版本

- 协议版本：`PROTOCOL_VERSION = 1`（每端在握手时交换；不匹配时插件返回 `E_VERSION`，扩展提示升级）。
- 三端产物：
  - `extension/src/lib/protocol.generated.js`（ESM，含 `validate*` 断言函数）
  - `dsh-plugin/src/shared/protocol.generated.ts`（类型 + zod schema）
  - `native-host/protocol.generated.mjs`
- 所有时间戳为 epoch ms（`number`），所有路径为绝对路径字符串，所有二进制（截图）为 **base64 无 dataURL 前缀**。

---

## 2. HTTP 端点（桥接插件注册在 `ctx.webServer`，**不走 `/api` 围栏**）

通用约定：
- 只监听 DSH 既有的回环端口（默认 3080），不额外开端口。
- 每个请求必须同时满足：`Origin` ∈ 配置的扩展 ID 白名单 **且** `?key=`/`X-AG-Key` 等于预共享 key。否则 **403**（不回显细节）。
- 全部响应 `Cache-Control: no-store`。

### 2.1 `GET /ag/ping`

用途：扩展探测 DSH 是否在跑、插件是否已加载、协议版本是否匹配。
输入：`?key=…`（或 `X-AG-Key` 头）
输出 `200 application/json`：

```json
{ "ok": true, "protocolVersion": 1, "plugin": "dsh-antigravity-bridge", "pluginVersion": "0.1.0",
  "dsh": { "port": 3080, "home": "/Users/mac/.dsh" },
  "capabilities": ["attach", "agentBridge", "screenshot", "browserTools"],
  "connectedClients": 1, "connectedExtension": true }
```

### 2.2 `GET /ag/enter`

用途：**认证握手**。被赋给侧边栏 iframe 的 `src`（或独立窗口 URL）。
输入：`?key=…`
处理：
1. 校验 Origin/Key；
2. 用 DSH 的会话签名密钥（见 docs/03 §4）签发该 authority 的 cookie；
3. 返回 `303 Location: /` + `Set-Cookie`。

输出头（关键）：

```
Set-Cookie: dsh-auth-<hash>=v1.<payload>.<sig>; Path=/; HttpOnly; SameSite=None; Secure; Max-Age=2592000
```

失败：`403 {"ok":false,"error":{"code":"E_AUTH","message":"forbidden"}}`。

> **为什么必须 `SameSite=None; Secure`**：实测 `Strict` 时 iframe 内 HTTP 正常但 `WS /api/remote.mux` 握手 401，界面卡在 `connection lost, retry #n`（FINDINGS §3）。`Secure` 在 `http://127.0.0.1` 上被 Chrome 视为可信来源，允许。
>
> 对照实测：DSH 原生 `?token=` 交换（`GET /?token=…`）返回的是 `Set-Cookie: …; HttpOnly; SameSite=Strict`（2026-09-11 在本机 3099 端口实测确认）。所以**不能依赖原生 token 流程让侧边栏 iframe 完成认证**，必须由桥接插件签发 `None; Secure` 形态。

### 2.3 `POST /ag/attach`

用途：提交一次网页捕获（三种粒度之一或组合）。
输入：

```json
{
  "protocolVersion": 1,
  "captureId": "01J…ULID",
  "mode": "page | selection | screenshot | selection+page",
  "page": { "title": "…", "url": "https://…", "domain": "example.com", "capturedAt": 1767000000000 },
  "markdown": "…（正文 Markdown，mode 含 page/selection 时必填）",
  "selection": { "text": "…", "selectorHint": "main > p:nth-child(3)" },
  "screenshot": { "mime": "image/png", "base64": "…", "width": 1280, "height": 800, "scale": 1 },
  "target": { "sessionId": "可选，指定投递到的会话", "workspace": "/Users/mac/ai_tools/dsh project" }
}
```

输出 `200`：

```json
{ "ok": true, "captureId": "01J…ULID",
  "fileRef": "@网页捕获/2026-09-11-1217-react-docs.md",
  "filePath": "/Users/mac/ai_tools/dsh project/网页捕获/2026-09-11-1217-react-docs.md",
  "imageRef": { "attachmentId": "att_…", "mime": "image/png", "width": 1280, "height": 800 },
  "deliveredTo": ["client:8f2c…"] }
```

字段语义：
- `fileRef` 是可插入 composer 的 `@path` 原子引用文本（工作区相对路径）。
- `imageRef` 由 DSH 的持久 attachment 存储返回（服务重启后仍可复用）。
- `deliveredTo` 为空数组表示当前没有 DSH 页面在线（内容已落盘，下次打开时通过 `GET /ag/pending` 取回）。

### 2.4 `GET /ag/pending`

用途：客户端插件上线时补取未投递的捕获（也用于扩展自检）。
输出：`{ "ok": true, "items": [ AttachResult… ] }`（取回后标记已投递；`?peek=1` 不消费）。

### 2.5 `POST /ag/ack`

用途：客户端插件确认已把胶囊插入 composer（幂等）。
输入 `{ "captureId": "…", "status": "inserted | dismissed | failed", "detail": "可选" }`。

### 2.6 错误码表（HTTP 与 WS 共用）

| code | HTTP | 含义 | 触发 |
|---|---|---|---|
| `E_AUTH` | 403 | Origin 或 key 不匹配 | 未授权扩展/网站 |
| `E_VERSION` | 409 | 协议版本不匹配 | 扩展与插件版本漂移 |
| `E_PAYLOAD` | 400 | 结构校验失败 | schema 不通过 |
| `E_TOO_LARGE` | 413 | 超过体积上限 | 截图/正文超限（默认 8MB） |
| `E_NO_WORKSPACE` | 409 | 目标工作区不可用 | 未选择工作区或路径不存在 |
| `E_STORAGE` | 500 | 落盘/附件存储失败 | 磁盘或权限问题 |
| `E_EXT_OFFLINE` | 503 | 扩展未连接（工具桥） | WS `/ag/agent` 不在线 |
| `E_TIMEOUT` | 504 | 浏览器操作超时 | 默认 10s |
| `E_TARGET` | 422 | 选择器/元素未命中 | 点击/输入目标不存在 |
| `E_INTERNAL` | 500 | 未归类错误 | — |

---

## 3. WebSocket：`/ag/agent`（扩展 SW ⇄ 桥接插件）

- 升级请求：`GET /ag/agent?key=…&extId=…`，`Origin: chrome-extension://<id>`；插件校验通过后 `101`。
- 帧格式：**文本帧 + JSON**（不用二进制帧，便于日志）。
- 心跳：插件每 20s 发 `{"type":"ping"}`；扩展回 `{"type":"pong"}`；连续 2 次未回则判定离线（`E_EXT_OFFLINE`）。

### 3.1 插件 → 扩展（请求）

```json
{ "type": "request", "id": "r-7f3a", "protocolVersion": 1, "op": "click",
  "args": { "selector": "button[type=submit]", "tabId": 123, "timeoutMs": 10000 },
  "deadline": 1767000010000 }
```

`op` 取值（M3 全量）：

| op | args | 结果关键字段 | 实现手段 |
|---|---|---|---|
| `read` | `{tabId?, maxChars?, includeHtml?}` | `{title,url,text,selection}` | `scripting.executeScript` |
| `screenshot` | `{tabId?, fullPage?}` | `{base64,width,height}` | `captureVisibleTab`（fullPage 用 debugger） |
| `click` | `{tabId?, selector?, text?, index?}` | `{ok, matched, tag, coords}` | scripting（不可点击元素回退 debugger） |
| `type` | `{tabId?, selector?, text, submit?}` | `{ok, value}` | scripting（原生 setter + input 事件） |
| `navigate` | `{tabId?, url, waitUntil?}` | `{ok, finalUrl, status}` | `chrome.tabs.update` + 等待 |
| `tabs` | `{}` | `{tabs:[{id,title,url,active}]}` | `chrome.tabs.query` |
| `wait` | `{tabId?, selector?, text?, timeoutMs}` | `{ok, elapsedMs}` | scripting 轮询 |

### 3.2 扩展 → 插件（响应 / 主动事件）

```json
{ "type": "response", "id": "r-7f3a", "ok": true, "result": { "matched": 1, "coords": [420,318] }, "elapsedMs": 87 }
{ "type": "response", "id": "r-7f3b", "ok": false, "error": { "code": "E_TARGET", "message": "selector not found" } }
{ "type": "event", "kind": "tab-activated", "payload": { "tabId": 123, "url": "https://…" } }
{ "type": "hello", "protocolVersion": 1, "extVersion": "0.1.0", "capabilities": ["read","screenshot","click","type","navigate","tabs","wait","debugger"] }
```

---

## 4. WebSocket：`/ag/client`（DSH 页面内 client 插件 ⇄ 桥接插件）

- 升级请求由 **DSH 页面自己发起**（同源 `ws://127.0.0.1:3080/ag/client`，携带 DSH 会话 cookie 与 `sessionId`）。
- 用途：把 attach 事件推给页面（D5 决策），并接受页面回执。

### 4.1 插件 → 客户端

```json
{ "type": "attach", "protocolVersion": 1, "captureId": "01J…",
  "fileRef": "@网页捕获/2026-09-11-1217-x.md", "imageRef": { "attachmentId": "att_…" },
  "page": { "title": "React 19 Docs", "url": "https://react.dev/…", "domain": "react.dev", "capturedAt": 1767000000000 },
  "mode": "page",
  "summary": { "chars": 18422, "headings": 12, "truncated": false } }
```

### 4.2 客户端 → 插件

```json
{ "type": "hello", "protocolVersion": 1, "sessionId": "s-…", "workspace": "/Users/mac/…" }
{ "type": "ack", "captureId": "01J…", "status": "inserted" }
{ "type": "request-pending" }
```

---

## 5. 扩展内部消息（`chrome.runtime.sendMessage` 契约）

| 方向 | 消息 | 载荷 | 回复 |
|---|---|---|---|
| panel → SW | `{kind:"ensure-dsh"}` | `{port?, profile?}` | `{ok, url, started:boolean, pid?}` |
| panel → SW | `{kind:"panel-url"}` | `{}` | `{ok, url}`（含 `/ag/enter?key=…`，key 不下发到页面 DOM 之外的日志） |
| panel → SW | `{kind:"capture", mode}` | `{mode:"page"\|"selection"\|"screenshot"}` | `AttachResult` 或错误码 |
| panel → SW | `{kind:"browser-op", op, args}` | 同 §3.1 | 同 §3.1 结果 |
| SW → content | `{kind:"get-selection"}` | `{}` | `{text, rect}` |
| SW → content | `{kind:"ping"}` | `{}` | `{ok:true, hasSelection:boolean}` |
| SW → panel | `{kind:"state", value}` | `{dsh:"up"\|"down"\|"starting", attach:"idle"\|"sending"\|"attached", error?}` | — |

所有消息都必须带 `protocolVersion`；SW 侧统一走 `validateMessage()`，未通过则丢弃并记录。

---

## 6. Native messaging 协议（扩展 SW ⇄ native host）

- 载体：Chrome native messaging（4 字节小端长度前缀 + UTF-8 JSON），单帧上限 1MB。
- 请求 `{ "id":"n-1", "cmd": "ensure-dsh" | "status" | "stop-dsh" | "get-info", "args": {…} }`
- 响应 `{ "id":"n-1", "ok": true, "result": {…} }` / `{ "id":"n-1", "ok": false, "error": {"code","message"} }`

| cmd | args | result |
|---|---|---|
| `ensure-dsh` | `{profile:"web", port:3080, timeoutMs:20000}` | `{started:bool, pid?:number, url:string, token:string, port:number}` |
| `status` | `{}` | `{running:bool, port?:number, pid?:number, url?:string}` |
| `stop-dsh` | `{pid?}` | `{stopped:bool}` |
| `get-info` | `{}` | `{dshHome:string, dshBin:string, node:string, keyPath:string}` |

`ts` 与 `nonce` 字段用于日志关联；host 不持久化任何状态（幂等）。

---

## 7. 单源 schema 与同步测试

```
protocol/
├── messages.schema.json      # 唯一真相：HTTP/WS/native 全部消息
├── codegen.mjs               # 生成三端产物 + 版本常量
└── vectors/*.json            # 正例/反例样本（供三端共用测试）
```

- `codegen.mjs` 输入 schema，输出 §1 的三个产物，并在每个文件头写入 `// AUTO-GENERATED from protocol/messages.schema.json@<sha256>`。
- **同步测试**（三端各跑一次）：读取产物头部的 sha256 与当前 schema 计算值比对，不一致即失败（防止有人手改生成物或忘记重跑 codegen）。
- **向量测试**：`vectors/valid/*.json` 必须全部通过校验，`vectors/invalid/*.json` 必须全部被拒且错误码符合预期。

详见 [docs/06-test-plan.md](./06-test-plan.md) §2。
