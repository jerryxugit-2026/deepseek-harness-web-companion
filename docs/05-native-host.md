# 05 · Native Messaging Host 设计（`native-host/`）

**目的**：让扩展在 DSH 未运行时**自动拉起 `dsh web` 并拿到带 token 的启动 URL**（DESIGN G4），并在需要时报告/停止该进程。
**形态**：一个单文件 Node 脚本 + Chrome 侧的 host manifest（由安装脚本生成）。

---

## 1. 组件与文件

```
native-host/
├── host.mjs                     # 主程序：stdin/stdout 帧循环（无第三方依赖）
├── launcher.mjs                 # 子进程管理：探测端口、spawn dsh web、捕获 token URL
├── runtime-config.json          # 安装时生成：{ dshBin, nodeBin, dshHome, extensionId, logFile }
├── manifest.template.json       # Chrome host manifest 模板
├── install.mjs                  # 安装：解析 dsh 路径、生成 config、写 Chrome manifest、自检
├── uninstall.mjs
└── tests/{framing.test.mjs,launcher.test.mjs,install.test.mjs}
```

Chrome 侧 manifest（安装后落盘到 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.antigravity.web_companion.json`）：

```json
{
  "name": "com.antigravity.web_companion",
  "description": "Antigravity Web Companion host: starts and inspects the local dsh web server",
  "path": "/Users/mac/ai_tools/dsh project/网页插件/native-host/run.sh",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<钉死的扩展ID>/"]
}
```

要点：
- **扩展 ID 必须固定**：扩展 `manifest.json` 带 `"key"`（安装脚本生成密钥对并把公钥写入扩展），否则重装后 ID 变化会导致 host 拒绝连接。ID 算法 = 公钥 DER 的 SHA-256 前 16 字节，按 nibble 映射到 a–p（`scripts/init-key.mjs` 已实现）。
- `path` 指向 `run.sh`（`#!/bin/sh` + `exec "$NODE" "$DIR/host.mjs"`），规避「可执行文件必须是二进制」的顾虑；`run.sh` 由安装脚本生成并 `chmod +x`。（【文档】`path` 必须绝对路径且具备执行位；shebang 脚本可用性属推断，见 docs/research/03）
- 安装脚本必须处理**路径含空格**（本项目路径就含空格）：全程引号包裹，`run.sh` 内用 `"$DIR"`。
- **manifest 没有 `args` 字段**（【文档】）：Chrome 只会传 `argv[1] = 调用方 origin`。因此所有启动参数必须写进生成出来的 `run.sh` / `runtime-config.json`，或作为**首个协议消息**发送 —— 不要指望命令行参数。
- **体积上限**：host → Chrome **1MB**（超限即视为致命错误），Chrome → host **64MiB**（【文档】；MDN 的 4GB 已过时）。因此捕获/截图等大载荷一律走 HTTP `/ag/attach`，**不要**塞进 native messaging。
- **进程回收**：Chrome 在扩展/浏览器关闭时只 SIGKILL host 自身（不会杀孙进程），所以 spawn 出来的 `dsh web` 会变孤儿 → host 必须在 stdin EOF（或收到 `stop-dsh`）时回收：读 `$DSH_HOME/antigravity-dsh.json` 中的 pid，校验命令行确含 `dsh` 后 SIGTERM；如需保活则在文档里明确「DSH 常驻」是用户选择。

---

## 2. 帧协议

Chrome native messaging 固定帧格式：**4 字节小端无符号长度 + UTF-8 JSON**，单帧上限 1MB。

```js
// host.mjs
function readFrames(stream, onMessage) {
  let buffer = Buffer.alloc(0)
  stream.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    for (;;) {
      if (buffer.length < 4) return
      const length = buffer.readUInt32LE(0)
      if (length > 1024 * 1024) process.exit(1)     // 协议上限，直接退出
      if (buffer.length < 4 + length) return
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      onMessage(JSON.parse(body.toString('utf8')))
    }
  })
}
function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([header, body]))
}
```

命令（对应 docs/01 §6）：`ensure-dsh` / `status` / `stop-dsh` / `get-info`。
**stdout 只允许承载帧**；所有日志写 `$DSH_HOME/logs/antigravity-native-host.log`（含时间戳、pid、命令、耗时）。

---

## 3. `launcher.mjs`：拉起 `dsh web` 并捕获 token URL

```ts
type EnsureResult = { started: boolean, pid?: number, url: string, token: string, port: number }

export async function ensureDsh({ profile = 'web', port = 3080, timeoutMs = 20000 }): Promise<EnsureResult>
```

算法：

1. **先探测**：`TCP connect 127.0.0.1:<port>`（300ms 超时）。已监听 → 尝试 `GET /ag/ping`：能拿到 `200` 说明 DSH 与插件都在 → 但 **token 无法从已运行进程获取**（进程内 WeakMap，见 FINDINGS §2）→ 此时返回 `{started:false, url:'http://127.0.0.1:<port>/', token:''}`，扩展走**桥接插件的 `/ag/enter` 握手**（这正是 D3 存在的意义）；若 `/ag/ping` 403/404（说明是别的进程占了端口，或插件未装）→ 返回 `E_PORT_BUSY`，并给出明确提示。
2. **未监听 → spawn**：
   ```js
   const child = spawn(runtime.dshBin, ['web', '--profile', profile, '--no-open', '--port', String(port)], {
     detached: true, stdio: ['ignore', 'pipe', 'pipe'],
     env: { ...process.env, DSH_HOME: runtime.dshHome, PATH: runtime.path },
   })
   child.unref()
   ```
3. **解析 stdout**：逐行匹配 `/^dsh web:\s+(\S+)/`，提取 URL；用 `new URL(url).searchParams.get('token')` 取 token；**拿到即返回**并把该行之后的输出转存日志。

   **实测（2026-09-11，本机）**：
   ```
   $ DSH_HOME=<隔离目录> dsh web --no-open --port 3099
   dsh web: http://127.0.0.1:3099/?token=QnbI60IsZcGxmAsYbcEn1L94zxFzD3lRpLV6SLXmNrw
   ```
   - 该行出现耗时 **约 4 秒**（冷启动），故 `timeoutMs=20000` 有充足余量；
   - token 为 43 字符 base64url；
   - 用该 URL 请求会得到 `303 → /` + `Set-Cookie: dsh-auth-…=v1.…; HttpOnly; SameSite=Strict` —— **注意是 `Strict`**，这正是侧边栏 iframe 内 WebSocket 握手会 401 的根因，也是必须有 `/ag/enter`（签发 `SameSite=None; Secure`）的原因；
   - `--no-open` 与 `--port` 均为 web app 自身参数，`dsh web` 是 `--profile web` 的别名（见 `dsh --help`）。
4. **超时/失败**：`timeoutMs` 内未拿到 URL，或子进程提前 `exit` → 收集最后 20 行 stderr，返回 `E_START_FAILED` 与诊断文本（面板原样展示）。
5. **幂等**：并发 `ensure-dsh` 用进程内 Promise 去重；并把 `{pid, port, url, startedAt}` 写入 `$DSH_HOME/antigravity-dsh.json`（0600），供 `status`/`stop-dsh` 使用。

`status`：读该文件 + TCP 探测 + （可选）`/ag/ping`；不健康则清理文件。
`stop-dsh`：仅当 pid 属于该文件且命令行含 `dsh` 时 `SIGTERM`（先校验，避免误杀）。

---

## 4. 安装流程（`install.mjs`）

```sh
node native-host/install.mjs --extension-id <id>     # 或由扩展首启时提示用户运行
```

步骤：
1. 解析 `dsh`：`which dsh` → `fs.realpath` → 记入 `runtime-config.json`；解析 `node` 同理。
2. 生成 `run.sh`（内容固定，引用 config 的 node 路径）。
3. 写 Chrome host manifest（含 `allowed_origins`）。
4. **自检**：本地直接跑 `echo '{"id":"t","cmd":"get-info"}' | ./run.sh`（用帧格式）验证能回响应。
5. 打印后续动作：在 `chrome://extensions` 重新加载扩展、并在扩展设置页确认「已连接 native host」。

Uninstall：删除 manifest 与 config，保留日志。

---

## 5. 单测设计（`native-host/tests/`）

| 文件 | 覆盖 | 用例 |
|---|---|---|
| `framing.test.mjs` | 帧编解码 | ①往返一致 ②分片到达（逐字节喂）③一次多帧 ④超长帧 → 退出码 1 ⑤非法 JSON → 跳过并记日志（≥5） |
| `launcher.test.mjs` | 拉起逻辑 | ①端口已监听 → 不 spawn ②spawn 后 stdout 出 URL → 解析 token ③超时 → `E_START_FAILED` 且带 stderr 摘要 ④并发去重 ⑤pid 文件写入与清理（≥5，用假 spawn/假 net 注入） |
| `install.test.mjs` | 安装脚本 | ①路径含空格正确转义 ②manifest JSON 结构 ③`allowed_origins` 用传入 ID ④重复安装幂等 ⑤自检失败时报错（≥5，在临时 HOME 下跑） |

E2E（docs/06 E2E-8）另测真机：删除 DSH 进程 → 通过扩展点击 → 观察 `dsh web` 被拉起、iframe 认证成功。
