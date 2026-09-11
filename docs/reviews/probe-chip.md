# M0b 探针报告 · E2E-0 完整闭环（probe-chip）

- **探针**：`tests/m0b/chip-probe.mjs`（无头 Chrome + 自签会话 cookie + 真实 UI 驱动）
- **被测**：host 半 `/ag/attach` + `WS /ag/client` hub + client 半（草稿注入 / 胶囊 / ack）
- **环境**：隔离 DSH（`.devhome`，端口 3099，工作区 `m0a-workspace`）
- **原始数据**：`docs/reviews/probe-chip.json` · 截图 `docs/reviews/probe-chip.png`
- **回答**：**E2E-0（最小闭环）是否真的能跑通**

## 1. 结论：闭环成立，逐段取证

| 环节 | 实测结果 |
|---|---|
| client 半连上 `WS /ag/client`（同源，无需 key） | ✅ `clientConnected: true` |
| 真实 UI 选中会话 → composer 激活 | ✅ `composerActive: true` |
| `POST /ag/attach` | ✅ 200，`deliveredTo: ["client:1"]` |
| **胶囊出现** | ✅ 1 个：`{captureId, status: "inserted", mode: "selection+page", label: "📄 网页: M0B 胶囊探针页"}` |
| **草稿被注入引用** | ✅ `draftContainsFileRef: true`，草稿内容即 `@网页捕获/2026-09-11-1552-m0b-胶囊探针页-xdig60.md` |
| ack（插入） | ✅ `{status: "inserted"}` |
| **✕ 撤销** | ✅ 胶囊数 0；草稿被还原为 `"\n"`（引用已移除）；ack `{status: "dismissed"}` |

即：**抓取 → 落盘 → 推送 → 注入草稿 → 胶囊 → 撤销 → 回执** 全链路自动跑通，无人工介入。

## 2. 本轮修掉的一个真实缺陷

首轮跑通时 `✕` **只删了胶囊、没清掉草稿里的引用**。根因：`shell.state.draft` 在写入后往往是**空串**，权威内容在活动编辑器的 DOM 里；撤销逻辑只读 state，于是 `current.includes(inserted)` 永远为假。
**修法**：新增 `readDraft()` 三级回退（`shell.state.draft` → `shell.lastMirroredDraft` → 活动编辑器 `innerText`），插入与撤销都走它。修后 `draftAfterDismiss` 变为 `"\n"`（干净）。

## 3. 与设计的偏差（已记录，不隐瞒）

**胶囊用 DOM 注入而非 `conversation.input.dock` 插槽**。理由：插槽注册需要 React 组件 + 插槽 props 契约，属 M1/M2 的打磨项；本轮先把**可观察契约**（出现 / 可删 / 回执）做实。`docs/04 §5` 的插槽方案仍是目标形态，代码注释已标注为分阶段实现。

## 4. 环境注意（下次探针可省事）

隔离 dev home 首次加载会弹「内测声明」遮罩，需要先点「继续」；本探针靠点击链顺带穿过了它（`uiClicks` 里第一项 `选择工作区` 返回 `false` 即为遮罩所致），后续探针建议显式先点掉。

## 5. 复现

```sh
DSH_HOME="$PWD/.devhome" dsh web --no-open --port 3099 &
node tests/m0b/chip-probe.mjs --port 3099
```
