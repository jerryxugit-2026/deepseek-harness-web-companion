# M0a 探针报告 · 权限实验（probe-permission）

- **探针**：`tests/m0a/permission-probe.mjs`（无头 Chrome 150.0.7871.125 + CDP `Extensions.loadUnpacked`）
- **原始数据**：`docs/reviews/probe-permission.json`
- **被验证的设计假设**：§9 权限模型 / §12.5 假设 A′（"首启按钮授权 + 无手势意图抓取能否共存"）

## 1. 结论（一句话）

**设计判断成立，且拿到了逐字证据**：无手势的 `permissions.request` 被 Chrome 直接拒绝；无授权时无手势的截图被拒且错误文本正是 `Either the '<all_urls>' or 'activeTab' permission is required.`。
**同时推翻设计里一处过度概括**：`executeScript` 并非"必然同时失权"，它取决于**目标源是否已有 host 权限**。

## 2. 逐案结果

| 案 | 场景 | 结果 | 证据（逐字） |
|---|---|---|---|
| **B** | 面板页内**无手势**调 `permissions.request({origins:['*://*/*']})` | ❌ 被拒 | `Error: This function must be called during a user gesture` |
| **A** | 同一调用带 CDP `userGesture=true` | ⏸ 12s 未 settle | 无头模式无法渲染原生授权弹窗 → 请求挂起（非拒绝） |
| **A2** | 真实可信鼠标点击面板按钮（`Input.dispatchMouseEvent`） | ⏸ 3s 内面板日志无新增 | 同上：点击回调**确实执行了**，但 `permissions.request` 等待弹窗而挂起 |
| **C** | **无手势**抓取（`executeScript` + `captureVisibleTab`），**未授权** | 注入 ✅ / 截图 ❌ | 注入成功（该目标 `http://127.0.0.1:3999/` **在本探针扩展的 host_permissions 内**）；截图失败：`Error: Either the '<all_urls>' or 'activeTab' permission is required.` |
| **D** | `permissions.remove` 后重复 C | ⏸ 未 settle | 权限状态切换后该表达式未在 9s 内结束（需后续细查，不影响主结论） |

## 3. 对设计的修正（v3.5 已落盘）

| 原表述 | 修正后 |
|---|---|
| "`executeScript` 与 `captureVisibleTab` 会**同时**失权" | **按源区分**：对**无 host 权限的任意站点**二者都会被拒（这是产品的主场景）；但对**扩展已持权限的源**（产品中的 `http://127.0.0.1/*`，即 DSH 自身）`executeScript` 仍可用。设计结论不变（意图抓取任意网页必须依赖授权），但理由要精确 |
| "授权弹窗弹不出来" | 更准确：**无手势调用的弹窗不可能出现**（逐字错误已取证）；有手势的调用在无头环境无法验证弹窗 UX → 需一次**有头（headed）人工验证**，列入 M1 前置 |
| `permissions.request` 的失败形态 | 不是静默失败，而是**抛异常**（`This function must be called during a user gesture`）→ 微壳必须捕获并转成 UI 提示（"请点击按钮完成一次授权"） |

## 4. 未覆盖 / 待补

1. **有头 Chrome 的授权弹窗 UX**（用户点"允许"后的持久化、拒绝后的状态、撤销后的回退）——无头不可测，列为 M1 前置的 5 分钟人工步骤。
2. **`activeTab` 路径**（点工具栏图标 → 当前标签页临时授权）无法编程授予，属文档行为，未测量。
3. 案 D 的挂起原因（权限撤销后 `tabs.query`/`scripting` 的行为）留待 M0b 顺带确认。
