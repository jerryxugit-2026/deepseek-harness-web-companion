# M2 · 自动拉起（H4①）实测验证 —— 用户真实 Chrome

- **执行者**：用户本人（真实 Chrome + 已安装扩展 `idpgkob…`）
- **时间**：2026-09-11 16:32
- **场景**：扩展刷新后，用户 Ctrl-C 停掉 `dsh web` → 点击扩展图标 → 面板应自行拉起 DSH

## 结论：**成功，且逐环可核对**

| 环节 | 证据 |
|---|---|
| 扩展请求 native host | `~/.dsh/logs/dsh-web-companion-host.log`：`20:32:36 host started pid=8124` |
| host 拉起 DSH 并拿到 token | 同日志：`20:32:40 ensure-dsh → started=true port=3080`（**4 秒**） |
| host 用完即断（短连接） | 同日志：`20:32:40 stdin closed — exiting` |
| 记录进程与 URL | `~/.dsh/web-companion-dsh.json`：`pid 8125`、`port 3080`、`startedAt 16:32:40`、`token 长度 43` |
| **运行中的确实是它拉起的那个** | `lsof :3080` → `node 8125` = 状态文件记录的 pid（完全一致） |
| 面板连上并可用 | `/ag/ping` → `paired: true`、`liveTickets: 0`（票据已消费）、**`connectedClients: 2`**（真实浏览器里的 DSH 页面已连上上下文通道） |
| 端到端可用 | 用户随即成功抓取：`网页捕获/2026-09-11-1632-notebooklm-clawhub-l-ba83.md`（front-matter + 正文完整） |

## 与自动化探针的关系（诚实记录）

`tests/m2/autostart-probe.mjs` 在**本 agent 沙箱内**启动的 Chrome 上失败：`connectNative` 返回 `Specified native messaging host not found.`（同一清单在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` 中结构、权限、`allowed_origins` 与同目录可用的其它 host 一致；`run-host.sh` 可被直接 exec 并正确响应帧）。判断为**测试环境限制**（Chrome 作为被沙箱进程的子进程），故本轮改由**真实环境实测**闭环，证据如上表。

## 遗留

- 自动化 E2E 仍缺"自动拉起"这一环；若要做成 CI 可跑，需要在非沙箱环境执行（或改用真实 Chrome 的 headed 模式）。
