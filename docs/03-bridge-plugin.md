# 03 · DSH 桥接插件（host 半）设计：`dsh-plugin/`

**包名**：`dsh-web-companion-bridge`
**作用**：DSH 进程内的桥接层 —— 认证握手、网页捕获落盘、attach 事件推送、以及把浏览器操作暴露成 DSH 的模型工具。
**为什么必须是插件**：只有同进程才能签发 DSH 会话 cookie、注册模型工具、访问工作区与 attachment 存储（见 DESIGN §4 D3）。

---

## 1. 包结构

```
dsh-plugin/
├── package.json
├── tsconfig.json
├── build.mjs                     # esbuild：host → lib/index.js；client → lib/client.js
├── src/
│   ├── host/
│   │   ├── index.ts              # 插件入口：apply(ctx, config)；装配路由/WS/工具
│   │   ├── config.ts             # Config schema（zod）
│   │   ├── key-store.ts          # 预共享 key 的读取/校验（$DSH_HOME/dsh-web-companion.json）
│   │   ├── guard.ts              # Origin + key 校验（HTTP 与 WS 共用）
│   │   ├── cookie.ts             # 会话 cookie 签发（含版本探测与回退）
│   │   ├── routes/
│   │   │   ├── ping.ts  enter.ts  attach.ts  pending.ts  ack.ts
│   │   ├── hub.ts                # 两条 WS 通道的连接注册表 + 请求/响应关联 + 心跳
│   │   ├── tool-bridge.ts        # 把 hub 请求包装成模型工具结果/错误
│   │   ├── store.ts              # 捕获落盘（工作区 md 文件 + DSH attachment）
│   │   └── log.ts
│   ├── client/                   # 见 docs/04
│   │   └── index.ts
│   └── shared/protocol.generated.ts
└── tests/
    ├── host/*.test.ts            # 用假 ctx（假 webServer/credentials/tools/logger）
    ├── client/*.test.ts
    └── fakes/{ctx.ts,webserver.ts,credentials.ts,session.ts}
```

### package.json 关键字段

```json
{
  "name": "dsh-web-companion-bridge",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js" },
  "dependencies": { "@deepseek-ai/dsh-tools": "0.1.2-rc.1", "@deepseek-ai/dsh-credentials": "0.1.2-rc.1", "ws": "^8.21.0" },
  "dsh": {
    "client": { "platform": "web", "inject": [] }
  },
  "scripts": { "build": "node build.mjs", "test": "vitest run" }
}
```

**依赖版本必须钉死**：`@deepseek-ai/dsh-*` 在 npm 上的 `latest` 是 stub `0.0.1-rc.1`，必须写 `0.1.2-rc.1`（或 `@next`），否则会装到错误版本（调研结论）。

**配置声明用 Schemastery**（`@deepseek-ai/schemastery`），**不是 zod**：

```ts
import Schema from '@deepseek-ai/schemastery'
export const Config = Schema.object({
  enabled: Schema.boolean().default(true),
  extensionOrigins: Schema.array(Schema.string()).default([]),
  cookieMode: Schema.union(['none-secure', 'partitioned']).default('none-secure'),
  cookieMaxAgeDays: Schema.number().default(30),
  attachDir: Schema.string().default('网页捕获'),
  attachMaxBytes: Schema.number().default(8388608),
  toolTimeoutMs: Schema.number().default(10000),
  allowBrowserWriteOps: Schema.boolean().default(false),
})
```

**客户端插件产物的硬性格式**（调研结论，装错则宿主加载失败）：
- 文件必须是 **CJS 闭包工厂**：`window.__ModuleLoader__.load({ id, factory: (require) => { var module={exports:{}}; var exports=module.exports; … return module.exports } })`；
- external 只能是宿主已 seed 的基线模块 —— 已装 `0.1.2-rc.1` 的 shell 只 seed **8 个**：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、`@deepseek-ai/dsh-client-ui-primitives`（master 已增至 9 个，多一个 dockkit）→ 其余一律内联；
- 宿主从 `exports["./client"]` 解析路径（不硬编码 `lib/client.js`）；
- 浏览器只以 `/plugins/??<pkg>/client.js&rev=<rev>`（combo URL）形式请求，没有逐文件路由。


> `dsh.client` 声明让 DSH 的 client-module 系统把本包当作浏览器插件加载（宿主扫描 loader 条目 → 组 boot graph → 从 `/plugins` 提供客户端产物）。**构建产物必须存在**，否则宿主会在激活时报「missing bundle」。字段细节以 `docs/research/01-dsh-plugin-authoring.md` 为准；如与实测冲突，以实测为准并回写本文件。

### 安装方式（两条路，按环境选）

| 环境 | 做法 | 备注 |
|---|---|---|
| **本机现状（无 pnpm）** | 在 profile 的 `cordis.patch.yml` 加绝对路径条目：`- insert: [{ id: dsh-web-companion-bridge, name: '/abs/.../dsh-plugin/src/host/index.js' }]` | 【实测】loader 接受绝对路径，插件可正常加载并注册路由；本项目 dev profile 已用此法跑通 |
| **有 pnpm 时（推荐长期）** | 打包成 bundle（`dsh.bundle.patch` + `cordis.patch.yml`）后 `dsh plugin --profile web add <spec>` | 【调研】该命令转发给 pnpm；本地目录是 **symlink**（`link:`）不是复制，改代码即生效；成功后自动把包名追加进 `dsh.profile.bundles` |

⚠️ **不要运行 `dsh --profile web --dump-config` 之外的写操作**：该命令每次都会重写 `profiles/web/cordis.yml`，只读环境会 `EPERM`；**永远改 `cordis.patch.yml`**，`cordis.yml` 是每次启动都会被重写的空根。


---

## 2. 插件入口与配置

```ts
// src/host/index.ts
export const name = 'dsh-web-companion-bridge'          // 服务名（ctx.antigravityBridge 可读）
export const inject = ['webServer', 'credentials', 'tools'] // 需要的服务：按实际可用性调整
export const Config = ConfigSchema                 // zod schema

export async function apply(ctx: Context, config: Config): Promise<void> {
  const key = await loadKey(config)                       // 读 $DSH_HOME/dsh-web-companion.json
  const guard = createGuard({ key, allowedOrigins: config.extensionOrigins })
  const hub = createHub(ctx, config)                      // 两条 WS 通道
  const store = createStore(ctx, config)                   // 落盘 + attachment

  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ag/ping',  handler: pingRoute(guard, hub, config) }), 'ag:ping')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ag/enter', handler: enterRoute(ctx, guard, config) }), 'ag:enter')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ag/attach', handler: attachRoute(guard, hub, store) }), 'ag:attach')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ag/pending', handler: pendingRoute(guard, store) }), 'ag:pending')
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/ag/ack', handler: ackRoute(guard, hub) }), 'ag:ack')

  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/ag/agent',  handler: hub.upgradeExtension }), 'ag:ws-agent')
  ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/ag/client', handler: hub.upgradeClient }), 'ag:ws-client')

  registerBrowserTools(ctx, hub, config)                   // browser_read / browser_click / …
  ctx.effect(() => () => hub.dispose(), 'ag:dispose')
}
```

`Config` 字段：

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关 |
| `extensionOrigins` | string[] | `[]` | 允许的 `chrome-extension://<id>` 列表（至少一个，空则拒绝一切） |
| `keyFile` | string | `$DSH_HOME/dsh-web-companion.json` | 预共享 key 文件 |
| `attachDir` | string | `网页捕获` | 相对工作区的落盘目录 |
| `attachMaxBytes` | number | `8388608` | 单次捕获上限（含截图 base64） |
| `markdownMaxChars` | number | `120000` | 写入文件的正文上限 |
| `toolTimeoutMs` | number | `10000` | 浏览器操作默认超时 |
| `allowBrowserWriteOps` | boolean | `false` | 是否允许 click/type/navigate（默认只读，见 DESIGN §8） |
| `cookieMaxAgeDays` | number | `30` | 签发 cookie 的有效期 |
| `cookieMode` | `'none-secure' \| 'partitioned'` | `'none-secure'` | 签发形态（两者都已实证可用） |

---

## 3. 路由实现要点

所有路由统一前置 `guard.check(req)`：

```ts
interface GuardResult { ok: true } | { ok: false, status: 401 | 403, code: 'E_AUTH' }
```

校验顺序（**任一失败即 403，且响应体不回显原因**）：
1. `key`（query `key` 或头 `X-AG-Key`，`timingSafeEqual` 比较）；
2. `Origin` 头 ∈ `extensionOrigins`（HTTP）；WS 升级请求同样校验 `Origin`；
3. `/ag/client` 例外：除 key 外还要求携带有效 DSH 会话 cookie（由 DSH 页面发起，天然具备）。

### 3.1 `enter.ts` —— 认证握手（**整个方案的关键 20 行**）

```ts
export function enterRoute(ctx, guard, config) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const g = guard.check(req); if (!g.ok) return sendJson(res, g.status, { ok: false, error: { code: g.code, message: 'forbidden' } })
    const authority = req.headers.host                       // e.g. "127.0.0.1:3080"
    const cookie = mintSessionCookie(ctx, authority, config) // 见 §4
    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': '/',
      'set-cookie': `${cookie.name}=${cookie.value}; Path=/; HttpOnly; Max-Age=${maxAge}; ` +
                    (config.cookieMode === 'partitioned'
                      ? 'SameSite=None; Secure; Partitioned'
                      : 'SameSite=None; Secure'),
    })
    res.end()
  }
}
```

**失败模式与处理**：

| 情况 | 处理 |
|---|---|
| 拿不到签名密钥 | 记录 warn，返回 `E_AUTH`（面板提示「桥接插件未完成初始化」） |
| cookie 格式版本不认识 | 回退 `cookieMode` 的另一种形态 → 仍失败则返回 409 `E_VERSION`，面板提示「请更新插件」 |
| 用户在 Chrome 禁用第三方 cookie | 前端探针会发现认证失败 → 降级独立窗口（DESIGN §5.1 失败分支） |

### 3.2 `attach.ts`

处理顺序（保证「先落盘、后推送」，推送失败不影响落盘）：

1. `guard.check` → 校验 → 读体（流式累计，超 `attachMaxBytes` 立即 `413` 并销毁 socket）；
2. `validateAttachRequest(body)`（shared schema）→ 失败 `400 E_PAYLOAD`；
3. `store.writeMarkdown(capture)` → `{fileRef, filePath}`（`E_NO_WORKSPACE`/`E_STORAGE`）；
4. 若有截图 → `store.admitImage(pngBuffer)` → `{attachmentId}`；
5. 组装 `AttachResult`，`hub.pushToClients(result)`（无在线客户端则入 `store.pendingQueue`）；
6. 返回 `200 AttachResult`（含 `deliveredTo`）。

### 3.3 `pending.ts` / `ack.ts`

- `pending`：返回未投递队列（`?peek=1` 不消费）；客户端插件上线时主动拉取（补漏）。
- `ack`：更新捕获条目状态（`inserted/dismissed/failed`），用于面板胶囊同步；幂等。

---

## 4. 会话 cookie 签发（`cookie.ts`）

**已验证的格式**（FINDINGS §2，实测 curl 通过）：

```
name  = "dsh-auth-" + base64url(sha256(authority))          // authority = "127.0.0.1:3080"
value = "v1." + base64url(JSON({version:1, authority, issuedAt, expiresAt})) + "." + base64url(HMAC_SHA256(secret, encodedBody))
secret = 32 字节随机，base64url 存于 credentials 记录 client-connection/browser-session
```

实现策略（**稳健优先**）：

```ts
export function mintSessionCookie(ctx, authority, config): { name: string, value: string } {
  // 1) 优先：通过 ctx.credentials 读取 DSH 自己的记录，复用其密钥（不新建、不改写）
  const record = readCredentialRecord(ctx, 'client-connection', 'browser-session')
  const secret = decodeBase64Url(record.payload.secret)
  // 2) 若 DSH 未来暴露公开签发 API（如 connection 服务的 authenticatedUrl/cookie 铸造），优先调用它
  // 3) 否则按上述格式自行签发，并写入格式版本号以便升级时探测
}
```

**契约测试（必须）**：用固定 secret + 固定时间戳算出**已知向量**，断言产出的 cookie 值逐字节一致（`tests/host/cookie.vector.test.ts`）。这样 DSH 一旦改格式，测试会立刻红，而不是等到线上 401。同时 E2E-1 会用真实 DSH 校验一次端到端可用性。

**回退链**（任一失败依次尝试）：
1. 公开 API 签发 → 2. 自签 `SameSite=None; Secure` → 3. 自签 `Partitioned; SameSite=None; Secure` → 4. 返回 `E_VERSION`，前端降级独立窗口并提示用户可手动粘贴 `dsh web` 启动 URL 里的 `?token=`（终极兜底，无需插件即可恢复可用）。

---

## 5. WS Hub（`hub.ts`）

用 `ws`（DSH 自带 `node_modules/ws`；插件把它声明为依赖）的 `noServer` 模式接管 `ctx.webServer.registerUpgrade` 给的原始 socket：

```ts
const wss = new WebSocketServer({ noServer: true })
export function upgradeExtension(req: IncomingMessage, socket: Duplex, head: Buffer) {
  if (!guard.checkWs(req).ok) { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => attachExtension(ws, req))
}
```

| 职责 | 实现要点 |
|---|---|
| 连接注册 | `extensions: Set<WebSocket>`、`clients: Map<sessionId, WebSocket>`；`connectedExtension` 供 `/ag/ping` 上报 |
| 请求关联 | `pending: Map<id, {resolve, reject, timer}>`；`send(op,args,timeoutMs)` 返回 Promise；超时 → `E_TIMEOUT` |
| 心跳 | 每 20s 发 `{type:'ping'}`；30s 无 `pong` → `terminate()` 并按离线处理 |
| 断连语义 | 断连时所有 pending 立即以 `E_EXT_OFFLINE` 拒绝（**不要等到超时**），避免模型等待 10s |
| 客户端推送 | `pushToClients(result)` 广播 + `ack` 回执；无客户端 → `store.enqueue(result)` |
| 背压 | 单连接并发上限 4；超出排队；队列上限 32，超出拒绝 `E_INTERNAL` |
| 生命周期 | 插件卸载时 `close()` 全部连接；`ctx.effect` 注册 disposer |

---

## 6. 模型工具（`tool-bridge.ts`）

用 DSH 的工具 API 注册（`defineTool` + `ctx.tools.register`，见 `@deepseek-ai/dsh-tools`）：

```ts
ctx.tools.register(defineTool({
  name: 'browser_click',
  description: 'Click an element in the user\'s current browser tab. Prefer a CSS selector; text matching is a fallback. Returns matched count and element coordinates.',
  parameters: {
    selector: { type: 'string', description: 'CSS selector to click' },
    text: { type: 'string', description: 'Visible text to match when no selector is given' },
    tabId: { type: 'number', description: 'Target tab id; defaults to the active tab of the focused window' },
  },
  output: { schema: { /* JSON Schema：{ok, matched, tag, coords} */ }, render: (args, value) => [{ type: 'text', text: renderClick(value) }] },
  execute: async (args, exec) => bridge.request('click', args, exec.signal),
}))
```

工具清单（M3）：

| 工具名 | 只读? | 默认开放 | 说明 |
|---|---|---|---|
| `browser_read_page` | ✅ | 是 | 读取当前/指定标签页正文与选区 |
| `browser_screenshot` | ✅ | 是 | 视口截图（返回附件引用，交给多模态模型） |
| `browser_tabs` | ✅ | 是 | 列出打开的标签页 |
| `browser_wait_for` | ✅ | 是 | 等待选择器/文本出现 |
| `browser_click` | ❌ | 否（`allowBrowserWriteOps`） | 点击元素 |
| `browser_type` | ❌ | 否 | 输入文本（可选提交） |
| `browser_navigate` | ❌ | 否 | 导航到 URL |

**错误映射**（模型看到的是结构化、可自行纠错的文本）：

| 内部错误 | 工具输出 | 模型可采取的动作 |
|---|---|---|
| `E_EXT_OFFLINE` | 「浏览器扩展未连接。请提示用户点击工具栏图标打开侧边栏，然后重试。」 | 让用户操作，或改用 `web_fetch` |
| `E_TARGET` | 「选择器未命中（matched=0）。可用候选：<最多 5 条可见文本>」 | 换选择器 |
| `E_TIMEOUT` | 「操作超时（10s）。页面可能仍在加载。」 | 先 `browser_wait_for` |
| `E_PAYLOAD` | 参数错误详情 | 修正参数 |

**与权限体系的关系**：写操作工具默认不注册（不是「注册了但拒绝」），需要时通过 DSH 的权限预设/审批开启；`execute` 内部必须转发 `exec.signal`（取消即中止 WS 请求）。

---

## 7. 落盘与附件（`store.ts`）

```ts
writeMarkdown(capture): Promise<{ fileRef: string, filePath: string }>
// 目标：<workspace>/<attachDir>/<yyyy-MM-dd-HHmm>-<slug>-<captureId 后 6 位>.md
// 内容：YAML front-matter(title/url/domain/capturedAt/mode) + 可选「选区引用块」+ 正文 Markdown
// 原子写：先写 .tmp 再 rename（复用 DSH atomic-write 约定），避免半截文件被 Agent 读到
// fileRef：`@<attachDir>/<file>.md`（工作区相对路径，可直接作为 @ 引用文本）

admitImage(png: Buffer): Promise<{ attachmentId: string }>
// 走 DSH 的持久 attachment 服务（ctx.attachments / dsh-attachment-local）
// 要求：PNG/JPEG，单图 ≤ 配置上限；失败返回 E_STORAGE，不阻塞 Markdown 落盘
```

> **待确认**：attachment 准入的宿主 API 名称与入参（`ctx.attachments.admit(...)` 还是走某个 Remote 端点）—— 以 `docs/research/02-dsh-client-composer-attach.md` 与实现期实测为准；若宿主侧无直接可用的 Node API，则回退方案：把 PNG 直接写进工作区 `网页捕获/assets/`，用 `@` 引用图片路径（DSH 原生支持图片附件走 composer 上传，但宿主侧落盘同样可用）。

**workspace 解析顺序**：`payload.target.workspace` → 配置默认工作区 → 当前会话的工作区 → 失败 `E_NO_WORKSPACE`。

---

## 8. 单测设计（`dsh-plugin/tests/`）

用**假 ctx**（不启动真实 DSH）：`makeFakeCtx()` 提供 `{ webServer: {register, registerUpgrade}, credentials, tools, logger, effect }`，其中 `register` 记录路由对象并返回 disposer，测试直接调用 `route.handler(req, res)`（用 `node:http` 的 `IncomingMessage` 桩或起一个真实 `http.Server` 做集成层）。

| 测试文件 | 覆盖 | 关键用例（≥） |
|---|---|---|
| `guard.test.ts` | Origin/key 校验 | ①正确 key+Origin → ok ②错误 key → 403 ③未列 Origin → 403 ④大小写/端口差异 ⑤timing-safe 比较（长度不同不抛）（≥5） |
| `cookie.vector.test.ts` | 固定向量 | ①已知 secret+时间戳 → 逐字节相等 ②authority 不同 → cookie 名不同 ③过期 → 校验失败（≥3） |
| `routes.enter.test.ts` | 握手 | ①303 + Set-Cookie 含 `SameSite=None; Secure` ②partitioned 模式含 `Partitioned` ③未授权 → 403 且无 Set-Cookie（≥3） |
| `routes.attach.test.ts` | 捕获入库 | ①正常 → fileRef/attachmentId ②超限 → 413 ③schema 非法 → 400 ④无工作区 → 409 ⑤无客户端在线 → 入队且 deliveredTo=[]（≥5） |
| `store.test.ts` | 落盘 | ①文件名 slug 与 ULID 规则 ②front-matter 字段 ③原子写（tmp→rename）④截断标记（≥4） |
| `hub.test.ts` | WS 通道 | ①握手 403 ②请求/响应关联 ③超时 ④断连立即拒绝 pending ⑤心跳缺失→离线 ⑥并发上限（≥6） |
| `tool-bridge.test.ts` | 工具映射 | ①只读工具注册 ②写工具默认不注册 ③`allowBrowserWriteOps` 时注册 ④错误→模型可读文本 ⑤`exec.signal` 取消（≥5） |
| `config.test.ts` | 配置 schema | ①默认值 ②非法 cookieMode 拒绝 ③extensionOrigins 为空时拒绝启动并给出明确报错（≥3） |
| `protocol-sync.test.ts` | schema 同步 | 同 docs/01 §7 |

集成测试（`tests/host/integration.test.ts`）：起真实 `http.Server`，注册路由，用真实 `ws` 客户端连接 `/ag/agent`，断言一次完整 `read` 往返；不需要 DSH 本体。
