# M0a 探针报告 · Cookie 矩阵（probe-cookie-matrix）

- **探针**：`tests/m0a/cookie-matrix.mjs` + `tests/m0a/cookie-ext/`（MV3 探针扩展）+ 插件侧测量端点 `/ag/whoami`、`/ag/wsprobe`、`/ag/probe-page`
- **环境**：无头 Chrome 150.0.7871.125 · 隔离 DSH（`.devhome`，端口 3099）
- **原始数据**：`docs/reviews/probe-cookie-matrix.json`、`docs/reviews/probe-cookie-matrix-3p.json`
- **回答**：设计 Q1（Strict 为何 fetch 通、WS 不通）与 Q2（3P 屏蔽下是否仍可用）

## 1. Q1 矩阵（逐格实测，未屏蔽 3P）

四种请求形态 × 三种 cookie 属性，`sessionCookiePresent` = 服务端在该请求里**真的收到了会话 cookie**（`/ag/whoami` 与 `/ag/wsprobe` 直接回读 `Cookie:` 头）：

| cookie 属性 | 扩展页 fetch | **iframe 内 fetch** | 扩展页 WebSocket | **iframe 内 WebSocket** |
|---|---|---|---|---|
| `SameSite=Strict` | ✅ | ✅ | ❌ | ❌ |
| **`SameSite=None; Secure`** | ✅ | ✅ | ✅ | ✅ |
| `Partitioned; SameSite=None; Secure` | ✅ | ✅ | ✅ | ✅ |

**结论**：
1. 与 FINDINGS §3 的早期结论**一致且更精确**：不对称只出现在 **WebSocket 握手**，且**扩展页自身与 iframe 内都一样**（不是 iframe 独有）；
2. `None; Secure` 与 CHIPS 都能让四格全绿 → 设计的 D2/D9 成立；
3. **机制仍未证实**（Q1 的"为什么"）：需要 `chrome://net-export` 的 `COOKIE_*` 事件做机制级定位，本轮只闭环了现象。

## 2. Q2：3P 屏蔽 —— **未完成验证（诚实记录）**

`--block3p` 通过 profile 偏好 `{"profile":{"block_third_party_cookies":true}}` 启动后，矩阵结果**与未屏蔽时完全一致**（`none-secure`、`partitioned` 全绿）。但这**不能**推出"3P 屏蔽不影响本设计"，因为对照显示该偏好未被真正执行：

| 对照（`http://localhost` 顶层页 iframe `http://127.0.0.1:3099` = 真跨站） | cookie 属性 | 跨站 iframe 内 fetch | 跨站 iframe 内 WS |
|---|---|---|---|
| 3P 屏蔽 profile | `SameSite=None; Secure` | **仍被投递** | **仍被投递** |
| 3P 屏蔽 profile | `SameSite=Strict` | 不投递 | 不投递 |

即：若偏好真的生效，第一行应当是"不投递"。**因此 Q2 结论待定**，需改用 Chrome 真正的 3P 屏蔽路径（feature flag / 企业策略 / 在 `chrome://settings` 里手动开启）重跑同一矩阵。

> 附带收获：跨站对照证明了 `SameSite=None; Secure` 在普通跨站 iframe 中也能投递（与扩展 iframe 表现一致），这对"扩展豁免"的说法是**弱证据**而非证明——两者行为相同，无法区分"扩展豁免"与"None 本来就通"。

## 3. 本轮暴露的设计缺陷（已修，v3.7）

**同源请求不发 `Origin` 头**。【实测】iframe 内的同源 `fetch('/ag/whoami')` 到达服务端时 `Origin: null`（Fetch 规范：同源请求省略 Origin）。而 v3.1–v3.6 的 §5.4 把 F4 定义为"**Origin 必须等于本服务 authority**"——按字面实现会把 DSH 页面自己的合法请求判成 F1 导航（或被拒）。

修正后的 F4 判定：**Origin 存在时必须等于 authority；Origin 缺失时以 `Sec-Fetch-Site: same-origin` + 有效 DSH 会话 cookie 判定**。`/ag/whoami` 的分类器已同步修正。

## 4. 复现

```sh
DSH_HOME="$PWD/.devhome" dsh web --no-open --port 3099 &   # 起隔离 DSH
node tests/m0a/cookie-matrix.mjs                            # Q1 矩阵
node tests/m0a/cookie-matrix.mjs --block3p --cdp-port 9228   # Q2（偏好方式，已知不足以证伪/证实）
```
