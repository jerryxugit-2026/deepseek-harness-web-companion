# M0a 探针报告 · 空闲 WebSocket 保活（probe-keepalive / Q8）

- **探针**：`tests/m0a/keepalive-probe.mjs` + `tests/m0a/keepalive-ext/`（SW 与扩展页面各持一条空闲 WS）
- **环境**：无头 Chrome 150.0.7871.125 · 本地 `/ag/wsecho` 长连接端点
- **原始数据**：`docs/reviews/probe-keepalive.json`（观察窗 90 秒，每 10 秒采样）
- **回答**：设计 D10（`/ag/agent` 到底该由侧边栏文档还是 SW 持有）

## 结论

| 持有者 | 90 秒空闲后 | 判定 |
|---|---|---|
| **扩展文档（= 侧边栏文档的形态）** | WS 全程 `ws-open`，控制台只有 `page-boot → ws-open → ws-message`，**无 `ws-close`** | ✅ **空闲 90 秒不掉线 → D10 的主方案成立** |
| **MV3 Service Worker** | 目标仍在，但 `chrome.runtime.sendMessage({case:'status'})` 返回 `Error: Could not establish connection. Receiving end does not exist.`（t≈90s 采样） | ⚠️ **SW 在空闲后已不可用**（与 30 秒回收的文档行为一致）；但**未捕获到 `ws-close`**——worker 是被冻结/回收的，不一定会执行 close 处理函数。因此只能断言"SW 不能作为长期持有者"，不能断言"socket 收到过 close 事件" |

**与设计的关系**：D10 结论不变且有实测支撑——`/ag/agent` 由侧边栏文档持有，**兜底方案（SW + `chrome.alarms` 唤醒 + 重连）保留**；心跳 20s/判离线 30s 的重连状态机照旧。

## 局限（诚实记录）

1. 无头 Chrome 的 SW 回收时机与有头可能不同（观察窗只有 90 秒，未做更长窗口）；
2. 未验证"侧边栏关闭/隐藏"这一真实场景下的文档冻结行为（无头无法模拟真实侧边栏生命周期）；
3. 未测量有流量时（心跳）SW 是否会被持续保活——文档称 116+ 仅"流量"重置计时，本次未做对照。

## 复现

```sh
DSH_HOME="$PWD/.devhome" dsh web --no-open --port 3099 &
node tests/m0a/keepalive-probe.mjs --seconds 90
```
