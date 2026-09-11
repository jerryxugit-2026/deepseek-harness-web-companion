# 04 · DSH 客户端插件设计（`dsh-plugin/src/client/`）

**作用**：在 DSH 页面里接住「网页已捕获」事件，把它变成用户看得见、可删除、可发送的上下文（文本引用 + 图片附件 + 胶囊），也就是 PRD 的 **FR-2.4 上下文胶囊** 与 attach 闭环的最后一跳。

---

## 1. 为什么用 WS 而不是 postMessage 作为主通道

| 方案 | 优点 | 缺点 | 结论 |
|---|---|---|---|
| 面板页 → iframe `window.postMessage` | 零往返 | 只在「侧边栏 iframe」形态可用（独立窗口/普通标签页形态失效）；需校验 `event.origin` | v1.1 低延迟快路径（可选） |
| 桥接插件 → client 插件 **WS `/ag/client`** | 三种宿主形态统一；天然同源（DSH 页面自己发起）；可回执、可补取 | 多一条 WS 连接 | **主通道（本设计）** |

主通道的安全模型更简单：WS 由 DSH 页面自己发起（携带 DSH 会话 cookie），插件侧按**详细设计 §5.4 的 F4 形态**校验（key + DSH 会话 cookie + Origin == 本服务 authority）；**页面侧不需要信任任何跨窗口消息**。

---

## 2. 模块结构

```
dsh-plugin/src/client/
├── index.ts          # 客户端插件入口：apply(ctx)；生命周期装配
├── bridge-client.ts  # WS /ag/client 客户端：连接、重连、hello/ack/request-pending
├── attach-store.ts   # 本会话的待处理/已附加条目（内存 + sessionStorage 兜底）
├── composer-insert.ts# 把一条 attach 变成 composer 内容（文本引用 + 图片附件）
├── chip.tsx          # 胶囊 UI（含 data-ag-chip 测试锚点）
├── slots.ts          # 插槽注册（composer 上方条带）
└── log.ts
```

`package.json` 的客户端声明（宿主据此提供 `lib/client.js`）：

```json
"dsh": { "client": { "platform": "web", "inject": [] } }
```

---

## 3. 生命周期与接线

```ts
export const name = 'dsh-web-companion-bridge-client'
export const inject = []                     // 具体服务名以调研结论为准（见 §7）

export function apply(ctx: Context): void {
  const store = createAttachStore()

  // 1) 与桥接插件建立通道（DSH 页面 → 同源 WS）
  const client = createBridgeClient({
    url: () => `ws://${location.host}/ag/client`,
    onAttach: (event) => { store.add(event); void insertIntoComposer(ctx, event) },
    onOpen: () => client.send({ type: 'hello', protocolVersion: PROTOCOL_VERSION, sessionId: currentSessionId(ctx), workspace: currentWorkspace(ctx) }),
  })
  ctx.effect(() => client.start(), 'ag-client ws')
  ctx.effect(() => () => client.dispose(), 'ag-client dispose')

  // 2) 上下文胶囊（composer 上方条带）
  ctx.effect(() => ctx.slots.register({ name: CHIP_SLOT, select: () => ({ items: store.items(), onDismiss: (id) => { store.remove(id); client.send({ type: 'ack', captureId: id, status: 'dismissed' }) } }) }, ChipStrip), 'ag-chip')

  // 3) 上线补漏：拉取在离线期间产生的捕获
  client.onOpen(() => client.send({ type: 'request-pending' }))
  client.onPending((items) => items.forEach((item) => { store.add(item); void insertIntoComposer(ctx, item) }))
}
```

时序（与 DESIGN §5.2 对应）：

```
桥接插件 --WS attach--> client 插件 → 插入 composer → WS ack(inserted) → 桥接插件 → 面板胶囊状态=已附加
```

**插入失败不丢数据**：`insertIntoComposer` 失败时，条目保留在 `store` 中，胶囊显示「⚠ 未插入」并提供「重试」与「复制引用」两个动作（引用文本即 `fileRef`，用户可手动粘贴）。

---

## 4. `composer-insert.ts`：把一条 attach 变成 composer 内容

```ts
export async function insertIntoComposer(ctx: Context, item: AttachEvent): Promise<Result<void>>
```

步骤（每一步失败都有降级，**整体不抛异常**）：

1. **确定目标会话**：当前选中会话 → 若无，用最近一次会话 → 若仍无，创建一个（`session/create` 语义，见 docs/01 §5 与 §7 调研结论）。
2. **图片附件（若有 `imageRef`）**：把 DSH attachment id 变成 composer 可用的附件项（走 DSH 客户端既有的附件准入路径，**不自己实现上传**）。失败 → 记为 `imageSkipped:true`，继续第 3 步。
3. **文本引用**：把 `fileRef`（形如 `@网页捕获/2026-09-11-1217-react-docs.md`）作为**原子引用**插入草稿。已确认可用 `inputActions.setDraft(text)`（覆盖式写入）；当前草稿经 `useInput` 快照读取后拼接，避免覆盖用户已输入内容：
   ```ts
   const current = useInput().draft            // 快照读取当前草稿
   inputActions.setDraft(current === '' ? fileRef : `${current}\n${fileRef}`)
   ```
   若未来 DSH 暴露「在光标处插入原子引用」的 API（`dsh-client-ui-reference` 的插入路径），优先改用它，以保留 `@` 引用的原子性与显示样式。
4. **可选提示语**：插入一段轻量前缀（默认关闭，可在扩展设置里开启）：
   `参考已附加网页《{{title}}》（{{url}}），正文见 {{fileRef}}。`
5. **回执**：成功 → `ack(inserted)`；失败 → `ack(failed)` + 胶囊显示可重试。

**幂等**：以 `captureId` 去重（同一 capture 重复推送只插入一次）。

---

## 5. 胶囊 UI（`chip.tsx`）

- 位置：composer 上方条带（与 PRD FR-2.4 一致）。
- 结构（含测试锚点）：

```html
<div data-ag-chip-root>
  <div data-ag-chip data-capture-id="01J…" data-mode="page" data-status="inserted">
    <span data-ag-chip-icon>📄</span>
    <span data-ag-chip-label>网页: React 19 Docs</span>
    <span data-ag-chip-meta>18.4k 字符 · react.dev</span>
    <button data-ag-chip-dismiss aria-label="移除上下文">✕</button>
  </div>
</div>
```

- 状态：`inserted`（默认）/ `image-skipped` / `text-only` / `failed`（后两者显示提示与重试）。
- 样式走 DSH 的 UI primitives（保证亮/暗主题一致）；不引入独立样式体系。

---

## 6. 单测设计（`dsh-plugin/tests/client/`）

环境：vitest + jsdom；`makeFakeClientCtx()` 提供假 slots/session/attachment 与假 WS。

| 文件 | 覆盖 | 关键用例（≥） |
|---|---|---|
| `bridge-client.test.ts` | WS 客户端 | ①hello 帧内容 ②断线重连（假时钟）③`attach` 事件分发 ④非法帧丢弃 ⑤dispose 关闭（≥5） |
| `attach-store.test.ts` | 条目存储 | ①按 captureId 去重 ②dismiss 移除 ③sessionStorage 恢复 ④顺序稳定（≥4） |
| `composer-insert.test.ts` | 插入编排 | ①图片+文本插入调用参数正确 ②无会话时创建会话 ③图片失败→继续文本且标记 ④原子引用不可用→纯文本回退 ⑤重复 push 幂等 ⑥ack 状态正确（≥6） |
| `chip.test.tsx` | 胶囊渲染 | ①`data-ag-chip` 与 `capture-id` ②标题/元信息文本 ③✕ 触发 dismiss 回调 ④失败态显示重试（≥4） |
| `protocol-sync.test.ts` | 协议同步 | 同 docs/01 §7 |

E2E 覆盖见 docs/06 的 **E2E-5**（胶囊出现、✕ 移除、ack 收到）。

---

## 7. 需要在实现期确认的宿主 API（本设计的风险点）

已从 `@deepseek-ai/dsh-client-ui-conversation/lib/types/client/contract/input.d.ts` 与 `contract/slots.d.ts` 读到**确切签名**的部分：

```ts
/** 输入动作（通过 ctx.uiSession 的 standard props 暴露给插件） */
export interface InputActions {
  setDraft(text: string): void                       // ← 覆盖整个草稿：文本引用的落点
  addImages(ids: readonly DraftAttachmentId[]): boolean   // ← 追加“浏览器持有的图片 id”
  removeImage(id: DraftAttachmentId): void
  pruneImages(ids: readonly DraftAttachmentId[]): void
  submit(): void
}

/** composer bar 自身的注入面（package-internal，插件边界外不可用） */
addImages: ((files: readonly File[]) => string | null) | undefined   // File[] → 返回新附件 id 或 null

/** 已知可用的 composer 相关插槽（PropsRuntime 提供标准会话 props） */
'conversation.input.attachments' | 'conversation.input.overlay' | 'conversation.input.left'
| 'conversation.input.plan' | 'conversation.input.right' | 'conversation.input.model'
| 'conversation.composer.dock' | 'conversation.composer.bar'
```

据此更新的结论：

| 能力 | 结论 | 依据 | 降级 |
|---|---|---|---|
| **文本引用进输入框** | ✅ 可行：`inputActions.setDraft(currentDraft + '\n' + fileRef)`（当前草稿从 `useInput` 快照读） | `InputActions.setDraft` 明确注释为「persisted-draft seed and programmatic writes」 | — |
| **胶囊挂载位置** | ✅ 候选插槽已确认：优先 `conversation.input.attachments`，其次 `conversation.input.left` / `conversation.composer.dock` | `slots.d.ts` 的 `PropsRenderSlots<…>` 列表 | 最差渲染在面板顶部条带（不依赖 DSH 插槽） |
| **截图变成 composer 图片附件** | ⚠️ 部分确认：`InputActions.addImages` 只接受**已准入的 `DraftAttachmentId`**；`File[] → id` 的准入函数位于 composer bar 的 **package-internal inject 面**（文档明确「never across a plugin boundary」）。因此需要找到**插件可用的准入路径**（host RPC 端点或客户端 store） | `input.d.ts:202-213`、`slots.d.ts:299`、`input.d.ts:220-228` 的边界声明 | 截图落盘为工作区文件，`setDraft` 插入 `@网页捕获/assets/xxx.png` 引用（DSH 原生支持图片文件作为附件） |

> 仍需实现期确认的唯一硬点：**`DraftAttachmentId` 的获取路径**（图片准入 RPC）。调研结论落盘于 `docs/research/02-dsh-client-composer-attach.md`；实现时若与该笔记冲突，以实测为准并回写本节。
