# 02 — DSH Web GUI 客户端插件「插入 composer 内容 + 附件 + 上下文 chip」seam 调研

> 目标：为 Chrome 扩展方案（`网页插件/`）确定**浏览器侧（client plugin）**把「已抓取的网页正文（Markdown）+ 可选截图 PNG + 一个可移除的上下文 chip」塞进 DSH Web GUI composer 的**确切 API**，以及选择/创建 session 的方式。
>
> 结论先行：**可行，但 composer 写入不是一条 API，而是三条不同的 seam**——(a) 整段文本用 `InputActions.setDraft`；(b) 任意位置插入（含原子 chip）必须经 **per-session scoped cordis 事件** `slash/input-insert-reference` / `slash/input-insert-text`；(c) 图片必须先落成浏览器侧 `File`，经 `ctx.conversation.createDraftImages` + `inputActions.addImages`。chip 用 slot `conversation.input.dock`。
>
> 本笔记只做调研，未改动任何实现代码。唯一写出的文件就是本文件。

---

## 0. 版本与 ground truth（重要：安装版本 ≠ master）

本笔记的**第一权威**是**本机已安装**的构建产物与类型声明：

```
/Users/mac/.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/
```

- `@deepseek-ai/dsh-web-frontend` `package.json` → `"version": "0.1.2-rc.1"`（`dist/` 是 vite 预构建产物）
- 因此**所有签名以该目录下的 `lib/types/**/*.d.ts` 与 `lib/*.js`（运行时 bundle）为准**

⚠️ **必须先读第 9 节「版本漂移」**：`master` 分支上的姊妹代码已经把 image 词汇整体改名为 attachment（`addImages` → `addAttachments`）。如果你按 GitHub 上的 README 写代码，会在本机 0.1.2-rc.1 上报 `undefined is not a function`。

一个**已确认的本地不一致**（务必记住）：

| 位置 | 文件 | `InputActions` 成员 |
|---|---|---|
| **类型声明（第三方编译期看到）** | `dsh-client-ui-conversation/lib/types/client/contract/input.d.ts:202-213` | `setDraft` / `addImages` / `removeImage` / `pruneImages` / `submit` |
| **运行时导出（`dsh-client-ui-conversation/lib/client.js`）** | `SessionInputShell.actions`（`removeImage: (id) =>` 在 `client.js` 偏移 ~396789，`addImages(ids) {` 在 ~402091） | 同名，**一致** |
| `master` 分支源码 `packages/client/ui-conversation/src/client/contract/input.ts:238-249` | — | `setDraft` / `add**Attachments**` / `remove**Attachment**` / `prune**Attachments**` / `submit` |
| `facade.d.ts` 的 `SessionInputShell` | `dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:119-139` | 同时存在 `setDraft` / `addImages` / `removeImage` / `pruneImages` / `commitSend` |

**行动项**：插件里对 action 调用做**能力探测**（见 §9.3 的兼容 shim），不要硬编码单一名字。

---

## 1. 客户端插件是怎么被加载的（先决条件）

任何「第三方 client plugin」必须满足 `dsh-client-modules` 的加载契约。

`dsh-client-modules/README.md`（Summary / "Declaring a client plugin"）：

> A browser plugin package declares `dsh.client` in its `package.json` with `platform: 'web'`, exports a `./client` bundle, and lists any non-baseline module requests under `dsh.client.external`. … The host serves built client bundles over `/plugins` … **the host serves built client bundles, so `pnpm run build` must have produced each `lib/client.js` before launch; a missing bundle fails activation loudly.**

本机真实样例（最简单的一个客户端插件）`dsh-client-ui-agent-preset/package.json`：

```json
{
  "name": "@deepseek-ai/dsh-client-ui-agent-preset",
  "exports": {
    ".":        { "types": "./lib/types/index.d.ts",        "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": {
    "client": {
      "inject": [
        "@deepseek-ai/dsh-api-session-controller",
        "@deepseek-ai/dsh-client-connection",
        "@deepseek-ai/dsh-client-locale",
        "@deepseek-ai/dsh-client-ui-conversation",
        "@deepseek-ai/dsh-client-ui-session",
        "@deepseek-ai/dsh-client-ui-settings",
        "@deepseek-ai/dsh-client-ui-workspace",
        "@deepseek-ai/dsh-api-remotes"
      ],
      "platform": "web"
    }
  }
}
```

浏览器半边只导出 `inject` + `apply`：

```ts
// dsh-client-ui-agent-preset/lib/types/client/index.d.ts
/** Required services (cordis fiber inject). */
export declare const inject: string[]
/** Mount the roster surfaces: hero chip, session-header label, settings section. */
export declare function apply(ctx: ClientContext): void
```

**结论**：目标插件包 = `dsh.client.platform: 'web'` + `exports["./client"]` → `apply(ctx)`。
`dsh.client.inject` 里声明的包名会被 host 编成 module-graph 边（保证依赖先加载）；**平台共享表（React / Cordis / 静态 UI 库）之外的运行时 import 必须进 `dsh.client.external`**，否则 bundle 里会内联出第二份 React 实例。

---

## 2. Q1 — composer（input）状态归谁所有，程序化插入的公开 API 是什么

### 2.1 所有权链条

`dsh-client-ui-conversation/README.md`（Summary + "Shell and standard props"）：

> `ui-conversation` … exposes React-free registries and per-Session bindings through `ctx.uiConversation`, and contributes the `useConversation`, `useInput`, and `inputActions` standard props through `ctx.uiSession`. … **The surface is a shell-owned Lexical editor**: reference chips are atomic decorator nodes carrying the owner's serialization identity (submission expands them through the owner codec) …

- **draft 文本 + chip 的真实状态**：`SessionInputShell` 私有的 Lexical editor（`dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:57-64`）
- **对外发布的状态**：`SessionInputShell.state: SnapshotStore<InputState>`（同上 `:60`）
- **每个 session 一个 shell**：`InputHub implements SessionInputResolver`（`lib/types/client/input/hub.d.ts:17`），`InputHub.shellFor(binding)` / `InputHub.shell(id)`（`:40` / `:47`）
- **注册为 cordis service**：`ConversationController extends Service`，`declare module '@deepseek-ai/cordis' { interface Context { conversation: IConversation; uiConversation: UiConversation } }`（`lib/types/client/index.d.ts:26-33`）
- 运行时：`client.js` 里 `ctx.plugin(ConversationController, { input: inputHub, blocks: composerBlocks })`，并且 `ctx.uiSession.provide({ hooks: ["conversation","input"], props: ["inputActions"], resolve: (binding) => {...} })`

`InputState`（`lib/types/client/contract/input.d.ts:294-313`）就是 chip/图片的读面：

```ts
export interface InputState {
    /** Clipboard-text projection of the editor document (chips expanded to their clipboard form). */
    readonly draft: string;
    /** Ordered runtime-only image ids; bytes and URLs stay in ConversationController. */
    readonly imageIds: readonly DraftAttachmentId[];
    /** Monotonic editor revision (span CAS compares against this). */
    readonly draftRev: number;
    readonly phase: 'plain' | 'adjudicating' | 'claimed' | 'submitting';
    readonly claim?: { readonly token: string; readonly hint?: string; readonly images?: boolean };
    /** Reference occurrence view of the editor's chips, sorted by offset. */
    readonly occurrences: readonly Occurrence[];
    readonly queue: readonly QueuedMessage[];
}
```

### 2.2 公开的 action 面（第三方唯一「干净」的写入入口）

`lib/types/client/contract/input.d.ts:196-213`：

```ts
/**
 * The public input action face provided to every session-scope slot
 * component: stable-identity void callbacks, mirroring the
 * useStore+actions convention. Command-style handles (arbitrate/space/
 * paste/…) stay InputBar-private and never ride this face.
 */
export interface InputActions {
    /** Replace the whole draft (persisted-draft seed and programmatic writes). */
    setDraft(text: string): void;
    /** Append ordered browser-owned image ids; busy admission phases refuse. */
    addImages(ids: readonly DraftAttachmentId[]): boolean;
    /** Remove one browser-owned image id; busy admission phases refuse. */
    removeImage(id: DraftAttachmentId): void;
    /** Drop ids whose browser-owned objects no longer exist. */
    pruneImages(ids: readonly DraftAttachmentId[]): void;
    /** Enter submission (adjudication / claim transaction / default sink inside). */
    submit(): void;
}
```

**它怎么到插件手里**——通过 standard props（`lib/types/client/contract/slots.d.ts:191-210`）：

```ts
interface SessionStandardProps {
    useConversation: UseConversation;                                 // SnapshotSelectorHook<ConversationSnapshot>
    useInput: SnapshotSelectorHook<InputState>;
    inputActions: InputActions;
}
interface SessionMaybeStandardProps {
    useConversation: MaybeSnapshotSelectorHook<ConversationSnapshot>;
    useInput: MaybeSnapshotSelectorHook<InputState>;
    inputActions: InputActions | undefined;
}
```

官方 slot 文档把它列为 framework-provided hooks（[Client slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots)，"Framework-provided hooks" 表）：

> | `session` | `useConversation`, `useInput`, `inputActions` | `ui-conversation` |
> | `session-maybe` | optional `useConversation`, `useInput`, `inputActions` results | `ui-conversation` |

### 2.3 第三条路：per-session `SessionInput`（比 actions 更强，且能插 chip）

`InputActions` **只有 `setDraft`（整段替换）**，不能「在光标处插入」。要插 chip / 任意位置文本，用 `SessionInput`：

`lib/types/client/contract/input.d.ts:163-195`：

```ts
/** Per-session input facade owned by the conversation wiring layer. */
export interface SessionInput extends InputTarget {
    /** Replace the whole draft (persisted-draft seed and programmatic writes). */
    setDraft(text: string): void;
    /** Append ordered browser-owned image ids; busy admission phases refuse. */
    addImages(ids: readonly DraftAttachmentId[]): boolean;
    removeImage(id: DraftAttachmentId): void;
    pruneImages(ids: readonly DraftAttachmentId[]): void;
    submit(mode?: InputSubmitMode): void;
    notify(level: 'info' | 'error', text: string): void;
    readonly state: SnapshotStore<InputState>;
}

/** Session-addressed access to the per-session input facade. */
export interface SessionInputResolver {
    /** Resolve the facade for one session-scope ctx. */
    for(actx: Context): SessionInput;
}
```

而 `InputTarget` **不含** `insertText`（注意：`SessionInputShell` 类**有** `insertText(text, span, keepCompleting?)`，见 `facade.d.ts:210-232`，但它不在 `SessionInput` 接口上 → 第三方**不能**依赖它）：

```ts
// lib/types/client/contract/input.d.ts:157-162
export interface InputTarget {
    /** Replace the trigger span with claim.token and enter claimed (span-CAS'd). */
    beginCommand(claim: CommandClaim, span: TokenSpan): boolean;
    /** Replace the trigger span with one reference chip (span-CAS'd). */
    insertReference(ref: ReferenceInsert, span: TokenSpan): boolean;
}
```

### 2.4 所以：任意位置插入 = 发 scoped cordis 事件

`SessionInputShell` 的动词就是被这些事件的 bail listener 调用的；监听器注册在 **session scope** 上（`client.js`，`InputHub.shellFor` 内）：

```js
actx.effect(() => {
  const offs = [
    actx.on("slash/input-begin-command",     (req) => shell.beginCommand(req.claim, req.span) ? true : void 0),
    actx.on("slash/input-insert-reference",  (req) => shell.insertReference(req.reference, req.span) ? true : void 0),
    actx.on("slash/input-consume-token",     (req) => shell.consumeToken(req.guard) ? true : void 0),
    actx.on("slash/input-insert-text",       (req) => shell.insertText(req.text, req.span, req.continue === true) ? true : void 0)
  ];
  return () => { for (const off of offs) off(); ... };
}, "conversation.input: session shell");
```

事件契约（`lib/types/client/contract/input.d.ts:122-149`，`@mode bail` = 有返回值、同步）：

```ts
declare module '@deepseek-ai/cordis' {
    interface Events {
        /** @mode bail */
        'slash/input-begin-command'(request: BeginCommandRequest): true | undefined;
        /** @mode bail */
        'slash/input-insert-reference'(request: InsertReferenceRequest): true | undefined;
        /** @mode bail */
        'slash/input-consume-token'(request: ConsumeTokenRequest): true | undefined;
        /** @mode bail */
        'slash/input-insert-text'(request: InsertTextRequest): true | undefined;
    }
}
```

请求体（同文件 `:15-20`、`:46-53`、`:87-92`）：

```ts
/** Pick-time draft span guarded by the input revision. */
export interface TokenSpan { readonly start: number; readonly end: number; readonly draftRev: number }

/** Structured reference inserted by an input-trigger source. */
export interface ReferenceInsert {
    readonly source: string;                                     // owner/serializer routing key
    readonly ref: string;                                        // owner-scoped reference id
    readonly label: string;                                      // inline display label
    readonly appearance?: 'session' | 'file' | 'folder';         // domain glyph
    readonly clipboardText: string;                              // clipboard/persistence projection
}

export interface InsertReferenceRequest { readonly reference: ReferenceInsert; readonly span: TokenSpan }
export interface InsertTextRequest { readonly text: string; readonly span: TokenSpan; readonly continue?: boolean }
```

**span 语义（必须照做，否则静默失败）**——`facade.d.ts:194-232` 的注释即实现约束：

- `draftRev !== this.rev` → 直接 `return false`（CAS 失败，**不抛错**）
- 坐标是 **detect 投影**坐标，不是 clipboard 投影坐标
- `insertReference` 还会在 chip 后补一个空格（若后一个字符不是空格）
- `insertText` **没有 phase 限制**（只查 rev），而 `insertReference` / `beginCommand` 只在 `plain | claimed` 相位生效
- 插到末尾（append 语义）：`{ start: input.draftRev ? detectLen : 0, end: detectLen, draftRev }`。**注意** `InputState.draft` 是 clipboard 投影；仅当草稿里**没有 chip** 时 clipboard 长度 == detect 长度（chip-free 草稿是常见情形），有 chip 时必须用 `caretSpan()` 或 occurrence 偏移换算 —— 第三方拿不到 `caretSpan()`（`ComposerKeyboard` 是 InputBar-private，见 `input.d.ts:218-256` 的类注释 "package-internal, never across a plugin boundary"）。**→ 务实做法：追加时用 `span = { start: L, end: L, draftRev }`，其中 `L` 取 `Math.max(lastOccurrence.offset + lastOccurrence.length, draft.length)` 之类，或直接改用 `setDraft` 拼接。**

### 2.5 第三方插件能不能调用？——**能，但要先拿到 session scope**

两条通路都**不是** root ctx 上可用的：

| 通路 | 需要的 ctx | 由谁提供 | 第三方可用？ |
|---|---|---|---|
| `ctx.conversation.input.for(actx)` → `SessionInput` | **Agent(session) scope ctx** | `ctx.sessions.scope(sessionId)` 或 slot `inject` 的 `sessionId` | ✅ 可用 |
| `actx.emit/bail('slash/input-insert-reference', …)` | 同上 | 同上 | ✅ 可用 |
| slot 组件里的 `inputActions` / `useInput` | 组件 props | `ctx.uiSession.provide` | ✅ 可用（最省事） |
| `ctx.uiConversation` | root | service | ✅ 但**只在注册 event Definition / View builder / binding 时有用**，不碰 composer 文本 |

**获取 session scope 的官方姿势**——`ui-conversation` 自己的 queue dock 就是活样板（`client.js`）：

```js
ctx.slots.inject("conversation.input.dock", () => ctx.slots.register({
  name: "conversation.input.dock", id: "queue", order: 20, locale: NS,
  inject: (sessionId) => {
    const actx = ctx.sessions.scope(sessionId);
    if (actx === void 0) throw new Error(`queue dock: session "${sessionId}" resolved no scope`);
    const conversation = actx.get("conversation");
    ...
  }
}, QueueDock));
```

`ctx.sessions.scope` 的契约（`dsh-api-session-controller/lib/types/client/contract/sessions.d.ts`）：

```ts
/**
 * Resolve an Agent-scoped context view (use-and-discard).
 * @param id - session id.
 * @returns scoped ctx, or undefined for a session neither listed nor already scoped.
 */
scope(id: SessionId): AgentContext | undefined;
/** @param id - session id. @returns binding, or undefined for a session neither listed nor already scoped. */
binding(id: SessionId): SessionBinding | undefined;
```

`SessionBinding`（`client/sessions/service.d.ts:102-110`）自带 scope：

```ts
export interface SessionBinding {
    readonly sessionId: SessionId;
    readonly session: SessionFace;      // ISession + ObservableSnapshot<SessionSnapshot>
    readonly eventSource: SessionEventSource;
    readonly ctx: AgentContext;         // ← 就是 actx
}
```

**完整可跑的写入序列**（本笔记的核心结论之一）：

```ts
// inside a session-scope slot entry's `inject` factory (or a click handler)
const actx = ctx.sessions.scope(sessionId);              // AgentContext | undefined
if (actx === undefined) return;
const shell = ctx.conversation.input.for(actx);          // SessionInput
const rev = shell.state.getSnapshot().draftRev;

// (A) 整段替换 —— 最稳
shell.setDraft(markdown + promptSuffix);

// (B) 任意位置插入纯文本（不经 chip，不需要 codec）
actx.bail(actx, 'slash/input-insert-text', {
  request: { text: '…', span: { start, end, draftRev: rev } },
} as never);   // 见下方「bail 调用签名」注记

// (C) 插入原子 chip（需要该 source 注册了 codec）
ctx.conversation.input.for(actx).insertReference(   // 或经事件
  { source: 'reference', ref: '@网页.md', label: '网页.md', appearance: 'file', clipboardText: '@网页.md' },
  { start, end, draftRev: rev },
);
```

> **bail 调用签名（UNVERIFIED 细节）**：`InputTriggerController.execute` 用的形式是
> `actx.bail(actx, 'slash/input-begin-command', payload)`（`dsh-client-ui-input-trigger/lib/client.js`），
> 即 **`bail(thisArg, name, ...args)`**。cordis 的 `bail` 在类型上是 `(...args: unknown[]) => unknown` 级别，
> 所以**类型层面不会帮你校验 payload 形状**；签名请以 `input-trigger` 的实参形式为准。
> 更安全的替代：不要发事件，直接调 `SessionInput.insertReference(...)`（类型完整、有 CAS、返回值可判）。

### 2.6 相位与并发守卫（照抄这些 if）

```ts
// facade.d.ts:120-132
// addImages: phase === 'adjudicating' || 'submitting' → return false（拒绝）
// removeImage: 同上 → 拒绝
// insertReference / beginCommand: phase 必须 plain|claimed
```

`InputHub.shell(id)` 在 binding 缺失时**抛错**：
`throw new Error('conversation.input: session "${id}" resolved no binding')`（`client.js`）。

---

## 3. Q2 — 图片附件的端到端准入

### 3.1 全链路（已逐段验证）

```
chrome extension  (base64 PNG)
   │  ① 变成浏览器 File
   ▼
ConversationController.createDraftImages(files: readonly File[]): readonly ComposerAttachment[]
   │     · 只做 MIME 白名单校验（imageMediaType(file.type)），不做字节/像素校验
   │     · browserDraftAttachment(file) = { kind:'image', id: randomUUID(), previewUrl: URL.createObjectURL(file), file }
   │     · 注册进私有 Map<DraftAttachmentId, ComposerAttachment> + Image() 探针补 width/height
   ▼
SessionInputShell.addImages(ids: readonly DraftAttachmentId[]): boolean     ← 只把 id 写进 InputState.imageIds
   │
   ▼  （用户按 Enter 或插件调 submit()）
ConversationController.sendSession(session, text, imageIds, mode, signal?)
   │     或 SessionFace.prompt(content, mode, signal?, requestId?)
   │  · serializeImages() → encodeImage(file) → { mediaType: imageMediaType(file.type), data: base64Of(file), name? }
   │  · base64Of = FileReader.readAsDataURL(file) 后取逗号之后部分（"native canonical base64"）
   ▼
RPC  session/prompt      ←── 唯一的图片「上传」= inline base64，没有独立 upload endpoint
   │     request: { requestId, sessionId, mode, content: readonly PromptContentPart[], clientTimeZone? }
   ▼
Host: admitPromptContent → dsh-attachment / dsh-attachment-local（正规化 + 去重 + 持久化）
   │     返回 durable ImageAttachmentRef
   ▼
client 收 durable ref → ui-conversation 的 session image URL cache: ctx.uiConversation.imageUrl(sessionId, attachment)
       浏览器显示：blob: objectURL（或 data: URL 回退）
```

### 3.2 关键类型

`dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:17-27`：

```ts
/** Browser-owned image that has not crossed the durable Host boundary. */
export interface ComposerAttachment {
    kind: 'image';
    id: DraftAttachmentId;
    file: File;
    previewUrl: string;
    /** Intrinsic pixel width, filled asynchronously by the intake header probe. */
    width?: number;
    height?: number;
}
```

`dsh-client-ui-conversation/lib/types/client/service.d.ts:102-126`（**这就是「插件要调什么」的答案**）：

```ts
/**
 * Create runtime-only draft images and their object URLs.
 * @param files - browser files to register after MIME validation.
 * @returns ordered draft descriptors.
 */
createDraftImages(files: readonly File[]): readonly ComposerAttachment[];

/** Resolve ordered input-state ids to runtime-owned draft images. */
draftImages(ids: readonly DraftAttachmentId[]): readonly ComposerAttachment[];

/**
 * Serialize ordered draft images to command-submit wire payloads without
 * sending or releasing them …
 * @returns base64 payloads in id order.
 */
serializeDraftImages(imageIds: readonly DraftAttachmentId[]): Promise<readonly SubmitImageAttachment[]>;

/** Release one browser-owned draft image and preview URL. */
releaseDraftImage(id: DraftAttachmentId): void;
releaseDraftImages(attachments: readonly ComposerAttachment[]): void;

/**
 * Submit ordered draft images with text through one host admission. …
 * @returns the Host admission outcome; local attachment preparation failures reject.
 */
sendSession(session: SessionFace, text: string, imageIds: readonly DraftAttachmentId[], mode: InputSubmitMode, signal?: AbortSignal): Promise<SubmitOutcome>;
```

`IConversation` 面（第三方通过 `ctx.conversation` 看到的那一层）只暴露 `input` / `blocks` / `send` / `updateQueue` / `cancel` / `loadOlder`：

```ts
// service.d.ts:23-54
export interface IConversation {
    readonly input: SessionInputResolver;
    readonly blocks: ComposerBlocks;
    /** Send a prompt into the caller scope's session (queued turn). */
    send(text: string): Promise<void>;
    updateQueue(itemId: QueueItemId, action: QueueAction): Promise<void>;
    cancel(): Promise<void>;
    loadOlder(): Promise<void>;
}
```

**⚠️ 因此 `createDraftImages` / `sendSession` / `releaseDraftImage` 这些方法在 `ConversationController` 类是 public 的，但没有出现在 `IConversation` 接口里**（`ctx.conversation` 的声明类型是 `IConversation`）。第三方 TS 代码要调它们，需要
(a) `(ctx.conversation as unknown as ConversationController).createDraftImages(files)`（`ConversationController` 是**值导出**，见 `lib/types/client/index.d.ts:5`），或
(b) 走 UI 通道：注册一个 `session` scope 的 slot 条目并从 `inject` 里拿到同款能力——**注意 conversation 自己的 `addImages` inject 面是 `InputBar` 私有的**（`slots.d.ts:296-311` 的 `ComposerBarInjected`，注释明确 "Package-private operations injected into the resident composer bar"）。
→ **务实推荐：`(ctx.conversation as unknown as import('@deepseek-ai/dsh-client-ui-conversation/client').ConversationController)`**，并在 §9.3 做能力探测。**此项标记 UNVERIFIED-BY-TYPES**（运行时存在，类型面未承诺）——settle 实验见 §10。

`DraftAttachmentId` 是品牌化字符串：`export type DraftAttachmentId = Branded<'DraftAttachmentId'>`（`input.d.ts:151`），运行时就是 `crypto.randomUUID()`（`browserDraftAttachment`）。

### 3.3 线格式与 Host 侧准入

`dsh-api-session-controller/lib/typert.remote-client.d.ts:35-54`（生成的 RPC 名册，权威）：

```ts
interface TypertRemoteMap {
  'session/attachment':          (request: SessionAttachmentRequest)          => Promise<RemoteResult<SessionAttachmentValue>>
  'session/cancel':              (request: SessionCancelRequest)              => Promise<RemoteResult<SessionCancelValue>>
  'session/canOpenWorkspacePath':()                                           => Promise<RemoteResult<boolean>>
  'session/control':             (signal?: AbortSignal)                       => AsyncIterable<SessionControlFrame>
  'session/create':              (request: SessionCreateRequest)              => Promise<RemoteResult<SessionCreateValue>>
  'session/follow':              (request: SessionFollowRequest, signal?)     => AsyncIterable<SessionFollowFrame>
  'session/fork':                (request: SessionForkRequest)                => Promise<RemoteResult<SessionForkValue>>
  'session/list':                (_request: SessionListRequest, signal?)      => Promise<RemoteResult<SessionListValue>>
  'session/modelCatalog':        ()                                           => Promise<RemoteResult<ModelCatalog>>
  'session/openWorkspacePath':   (request: SessionOpenWorkspacePathRequest, signal?) => Promise<RemoteResult<SessionOpenWorkspacePathValue>>
  'session/page':                (request: SessionPageRequest, signal?)       => Promise<RemoteResult<SessionPage>>
  'session/prompt':              (request: SessionPromptRequest, signal?)     => Promise<RemoteResult<SessionPromptValue>>
  'session/rename':              (request: SessionRenameRequest)              => Promise<RemoteResult<SessionRenameValue>>
  'session/search':              (request: SessionSearchRequest, signal?)     => Promise<RemoteResult<SessionSearchValue>>
  'session/selectModel':         (request: SessionSelectModelRequest)         => Promise<RemoteResult<SessionSelectModelValue>>
  'session/updateQueue':         (request: SessionUpdateQueueRequest)         => Promise<RemoteResult<SessionUpdateQueueValue>>
  'skills/list':                 (request: SkillListRequest, signal?)         => Promise<RemoteResult<SkillListValue>>
  'fileReferences/list':         (agentId: SessionId, query: string, signal?) => Promise<RemoteResult<FileReferenceCandidate[]>>
}
```

**注意：没有 `attachments/upload` 之类的独立端点。** grep 全仓 client bundle，命中只有 `'session/attachment'`（**读**：`readAttachment`）与 `'session/prompt'`（**写**）。
→ **图片的「准入」就是 `session/prompt` 的 inline base64 part**。

`dsh-attachment/lib/types/types.d.ts:39-70`：

```ts
/** Base64-encoded image upload accompanying one wire request. */
export interface EncodedImageAttachment {
    /** Declared media type, verified against the decoded bytes during admission. */
    mediaType: ImageMediaType;               // 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'
    /** Canonical base64 encoding of the image bytes. */
    data: string;
    /** Optional display name; it is never interpreted as a path. */
    name?: string;
}

/**
 * Browser-submitted prompt content accepted by Host prompt endpoints; the
 * accepting Host promotes image parts to durable references through
 * `admitPromptContent` before any message is created, so a wire caller can
 * never cite an attachment it did not upload.
 */
export type PromptContentPart =
    | { readonly type: 'text';  readonly text: string }
    | { readonly type: 'image'; readonly mediaType: ImageMediaType; readonly data: string; readonly name?: string };

/** Host-admitted prompt content with each uploaded image replaced by its durable reference. */
export type AdmittedPromptContentPart =
    | { readonly type: 'text';  readonly text: string }
    | { readonly type: 'image'; readonly attachment: ImageAttachmentRef };
```

**插件拿到什么 descriptor**——`ImageAttachmentRef`（`dsh-attachment/lib/types/types.d.ts:6-28`）：

```ts
/** Durable, serializable reference to one immutable normalized image. */
export interface ImageAttachmentRef {
    /** Opaque storage identifier; never a filesystem path or bearer URL. */
    attachmentId: AttachmentId;
    /** Media type verified from the stored bytes. */
    mediaType: ImageMediaType;
    /** Exact encoded byte length. */
    bytes: number;
    /** Intrinsic encoded width in pixels. */
    width: number;
    /** Intrinsic encoded height in pixels. */
    height: number;
    /** Optional display name stripped of local path information. */
    name?: string;
    /** Input dimensions after applying EXIF orientation and before normalization scaling.
     *  Present only when normalization reduced the image. */
    originalDimensions?: { width: number; height: number };
}
```

**怎么拿到 `ImageAttachmentRef`（三条已确认的路径）**：

1. **不直接拿**（推荐）：走 composer 提交，durable ref 出现在 `PendingSubmissionImage` 的 retire 回调里 —— `dsh-api-session-controller/lib/types/client/contract/session.d.ts`：
   ```ts
   export type PendingSubmissionRetirement =
     | { readonly reason: 'observed'; readonly attachments: readonly ImageAttachmentRef[] }
     | { readonly reason: 'failed' };
   export interface BeginSubmissionInput {
       readonly mode: 'queue' | 'steer';
       readonly text: string;
       readonly images: readonly PendingSubmissionImage[];
       readonly onRetire?: (retirement: PendingSubmissionRetirement) => void;
   }
   ```
   （`ConversationController.sendSession` 内部就是这样拿到的：`onRetire: (settlement) => this.settleSubmittedImages(...)`。）
2. **从历史里读**：`SessionFace.readAttachment(attachmentId)` → `RemoteResult<{ attachment: ImageAttachmentRef; data: Uint8Array }>`（对应 RPC `session/attachment`，请求 `{ sessionId, attachmentId }`）。
3. **直接自己发 prompt**：`ISession.prompt(content, mode, signal?, requestId?)`（`contract/session.d.ts:145`），随后从 `session.beginSubmission(...).onRetire` 或下一次 durable `user/message` 事件里读到 ref。

**渲染**：`ctx.uiConversation.imageUrl(sessionId, attachment): Promise<string>`（`client/conversation/assembly.d.ts:56`，README 明确 "resolves one session-authorized browser URL per attachment and revokes it with the Session binding"）。运行时实现是 `readAttachment` → `URL.createObjectURL(new Blob(...))`，不支持 blob 时回退 `data:${mediaType};base64,...`。

### 3.4 限制（全部来自 README，非猜测）

`dsh-attachment-local/README.md`（"Minimal configuration" 表）：

| Field | Default | Meaning |
|---|---|---|
| `maxImageBytes` | **20 MiB** | 单图源码字节上限 |
| `maxImagesPerMessage` | **20** | 单条消息图片数上限 |
| `maxMessageImageBytes` | **200 MiB** | 单条消息图片总字节上限 |
| `maxImagePixels` | **64,000,000** | 源码 width×height 上限 |
| `maxImageDimension` | **8192** | 单边像素上限 |
| `normalizedImageMaxPixels` | **2048×2048** | 归一化总像素预算 |
| `normalizedImageMaxBytes` | **4 MiB** | 归一化编码字节目标 |
| `imageCompressionConcurrency` | **2** | 归一化并发 |

格式：**只接受 PNG / JPEG / WebP / GIF 光栅图**；GIF 只保留第一帧；元数据/色彩配置被剥离；存入 `<DSH_HOME>/attachments/v1/objects/<sha256-prefix>/<sha256>`；**从不自动删除**；`dsh-attachment/README.md` 明确 "Unsent composer drafts stay in the browser until you submit"。

**客户端侧限制（已从 bundle 逐行确认）**：

```js
// dsh-client-ui-conversation/lib/client.js
createDraftImages(files) {
  for (const file of files) imageMediaType(file.type);   // ← 唯一的客户端校验
  return files.map((file) => { const attachment = browserDraftAttachment(file); ... });
}
function imageMediaType(value) {
  switch (value) {
    case "image/png": case "image/jpeg": case "image/webp": case "image/gif": return value;
    default: throw new UnsupportedImageMediaTypeError(value);
  }
}
function browserDraftAttachment(file) {
  return { kind: "image", id: randomUUID(), previewUrl: URL.createObjectURL(file), file };
}
function base64Of(file) { /* FileReader.readAsDataURL → data-URL 逗号之后 */ }
```

→ **客户端不做 size / count / pixel 校验**（`createDraftImages` 无 `maxImagesPerMessage` 检查）。超限只会在 `session/prompt` 被 Host 以 `session/attachment-invalid` 拒绝：
```ts
// dsh-api-session-controller/lib/types/types.d.ts:183-185
'session/attachment-invalid': { readonly reason: string };
```

### 3.5 composer 里怎么显示

`dsh-client-ui-attachment`（纯表现层，通过 slot 注入数据）注册三个面（README + `lib/types/client/*.d.ts`）：

- `conversation.input.attachments`（`ComposerAttachmentsProps = PropsRuntime<'conversation.input.attachments'> & PropsLocale<'conversation'>`）
  owner 面 `ComposerAttachmentsOwnerProps`（`conversation/contract/slots.d.ts:28-43`）：
  ```ts
  export interface ComposerAttachmentsOwnerProps {
      readonly attachments: readonly ComposerAttachment[];
      readonly canAcceptDrop: boolean;
      readonly onAddImages: (files: readonly File[]) => void;
      readonly onRemoveImage: (id: DraftAttachmentId) => void;
      readonly dropLimits?: { readonly count: number; readonly size: string } | undefined;
  }
  ```
- `conversation.message.images`（历史消息图廊，`MessageImagesOwnerProps`）
- `conversation.trajectory.images`

表现细节（README）：draft 缩略图固定 64px、单行横向滚动、有边缘翻页箭头、点击开原图 lightbox；孤图消息 240px 长边、多图 64px 方块。

**注意**：`conversation.input.attachments` 是 `single` 槽 → **一个占位者**。`dsh-client-ui-attachment` 已经占了它。**不要试图注册进这个槽**（同 priority 的第二条注册会抛错，见 §4.4）；要加「附件相关」的 UI，用 `conversation.input.dock` / `conversation.composer.dock` / `conversation.input.overlay`。

### 3.6 插件手里有 base64 PNG 时，到底要写什么

```ts
/** chrome extension 通过 postMessage 送来的 base64（不含 data: 前缀） */
function fileFromBase64(b64: string, name = 'screenshot.png', type = 'image/png'): File {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], name, { type });
}

// ── 在 session scope 里 ────────────────────────────────────────────────
const actx = ctx.sessions.scope(sessionId);
if (actx === undefined) throw new Error('attach: session has no scope');
const shell = ctx.conversation.input.for(actx);          // SessionInput
const cc = ctx.conversation as unknown as ConversationController;   // 见 §2.3 注记

const drafts = cc.createDraftImages([fileFromBase64(pngBase64, 'page.png', 'image/png')]);
// drafts: readonly ComposerAttachment[] = [{ kind:'image', id: DraftAttachmentId, file, previewUrl, width?, height? }]
const ok = shell.addImages(drafts.map(d => d.id));      // → InputState.imageIds
if (!ok) { cc.releaseDraftImages(drafts); throw new Error('composer is busy (adjudicating/submitting)'); }
// → 64px 缩略图立即出现在 composer 下方的附件轨道里；预览 URL 由 conversation 拥有
```

**失败回滚**：`releaseDraftImage(id)` / `releaseDraftImages(attachments)` 释放 registry 条目并 `URL.revokeObjectURL`。**提交成功**后不要手动 release —— `sendSession` 会把预览 URL 交给 durable image cache（`settleSubmittedImages`）。

**descriptor 回执**：本地阶段你拿到的是 `ComposerAttachment`（含 `id: DraftAttachmentId`）；**durable 阶段的 `ImageAttachmentRef` 只在 Host 准入后出现**，通过 `session/prompt` 的 durable `user/message` 事件或 `beginSubmission().onRetire({reason:'observed', attachments})` 获得。

---

## 4. Q3 — composer 区域可渲染 UI 的 slot / 扩展点全表

### 4.1 slot 机制（契约）

`@deepseek-ai/dsh-client-ui-slots` 的 registry 引擎在 npm 包里（本机**未安装** `dsh-client-ui-slots`，但 `dsh-client-ui-renderer` 以 `runtime dependency` 方式引用它；`ui-slots` 的**声明类型**可从源码与官方文档确认）：

- `SlotMap` 是编译期注册表，初始为空，由各包 `declare module '@deepseek-ai/dsh-client-ui-slots' { interface SlotMap { … } }` 合并
- 四种基数：`single` / `list`（需要 `id` + `order`）/ `keyed` / `chain`（需要 `select`）
- 三种 scope：`root` / `session-maybe` / `session`
- **声明即占有**：注册进未声明的 slot 会抛；重复声明同一 child 会抛；`chain` 缺 `select` 会抛；`list` 缺 `id` 会抛；同一 cell 同 priority 的第二条注册会抛
- 每个 entry 的 disposer 会**级联折叠**它声明的 child slots

官方文档（[Client slots](https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots)）给出的骨架 + `ctx` 服务签名（`dsh-client-ui-renderer/lib/types/client/registry.d.ts`）：

```ts
/** One synchronous effect installed while an injected slot declaration is live. */
type SlotInjectionEffect = (() => void) | Iterable<() => void, void, void>;

export declare class SlotRegistry extends Service {
    /** The single registration API. */
    readonly register: SlotCore['register'];
    /**
     * Install an effect for each declaration lifetime of a slot. …
     * @returns idempotent disposer for the wait and active effect.
     */
    inject(key: keyof SlotMap & string, callback: () => SlotInjectionEffect): () => void;
    install(renderer: SlotRenderer): void;
    installLocale(face: LocaleFace): void;
    provideRoot(contribution: RootStandardSourceContribution): () => void;
    installScope(scope: Exclude<SlotScope,'root'|'session-maybe'>, adapter: SlotScopeAdapter): void;
    bindStoreScope(binding: Pick<ScopedStandardSourceBinding,'key'|'ctx'>): void;
    renderSlot<K extends keyof SlotMap & string>(key: K, owner: OwnerOf<K>): ReturnType<SlotRenderer['renderRoot']>;
    entries(key: keyof SlotMap & string): readonly StoredEntry[];
    entriesOfSlot(key: keyof SlotMap & string): readonly StoredEntry[];
    snapshot(root?: string): LiveSlotNode[];
    onEntryError(fn: (key: string, entry: StoredEntry, error: unknown, info: { abdicated: boolean }) => void): () => void;
    spec<K extends keyof SlotMap & string>(key: K): SlotSpec<SlotMap[K]> | undefined;
    subscribe(key: keyof SlotMap & string, fn: () => void): () => void;
    getVersion(key: keyof SlotMap & string): number;
}
```

`register` 的两个重载（`ui-slots/src/index.ts`，语义同 `dsh-client-ui-renderer` 的转发面）：

```ts
register(options: BaseOptions<K, EntryKey, D, H, M, N> & { inject?: undefined }, component: C & SlotComponent<ComposedProps<…>> & RendersCheck<C, D>): () => void
register(options: BaseOptions<K, EntryKey, D, H, M, N> & {
    inject: (...args: InjectParams<K, H>) => I
}, component: C & SlotComponent<ComposedProps<…, I, …>> & RendersCheck<C, D>): () => void
```

四份 props 份额：

| 份额 | 组件类型 | 来源 |
|---|---|---|
| owner 值 + session/global 标准套件 | `PropsRuntime<K>` | `renderSlot` 调用点 + scope adapter |
| 子 slot 渲染器 | `PropsRenderSlots<S>` | registration 的 `children` |
| store 选择器/写回调 | `PropsStore<H>` | registration 的 `store` |
| 业务注入 | `InjectFace<I>` | registration 的 `inject` 工厂 |
| 本地化 `t` | `PropsLocale<N>` | registration 的 `locale` |
| chain 选举结果 | `matched` | registration 的 `select` 返回值 |

`inject` 工厂参数（`InjectParams`，`ui-slots`）：

```ts
export type InjectParams<K extends keyof SlotMap & string, H> =
  ScopeOf<K> extends 'session'
    ? ([H] extends [StoreDecl] ? [sessionId: SessionIdOf, actions: BoundActions<HandleOf<H>>] : [sessionId: SessionIdOf])
    : ScopeOf<K> extends 'session-maybe'
      ? ([H] extends [StoreDecl] ? [sessionId: SessionIdOf | undefined, actions: …| undefined] : [sessionId: SessionIdOf | undefined])
      : ([H] extends [StoreDecl] ? [actions: …] : [])
```

### 4.2 composer 相关 slot 全表（来自 `dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts:80-190`）

| slot key | kind | scope | owner props | 位置 | 适合 chip？ |
|---|---|---|---|---|---|
| `conversation.composer` | chain | session | `ComposerChainProps { sessionId, session, pendingInteraction }` | 整个 composer 的**临时接管** | ❌（会顶掉 composer；默认 composer 仍在下面以 `overlay` 方式挂着） |
| `conversation.composer.bar` | single | session-maybe | `ComposerBarOwnerProps { variant:'hero'\|'composer', blocked?, disabled?, workspacePickerOpen?, onRequestWorkspace?, placeholder?, accessory? }` | composer **主体** | ❌ 已被 `InputBar` 占有 |
| `conversation.input.attachments` | single | session-maybe | `ComposerAttachmentsOwnerProps` | composer 内 draft 图片轨道 | ❌ 已被 `ui-attachment` 占有 |
| **`conversation.input.dock`** | **list** | **session** | **`InputZone { session: SessionSnapshot; input: InputState }`** | **composer 卡片**上方**整宽** | ✅✅ **推荐** |
| `conversation.composer.dock` | list | session | `{}` | composer 卡片**下方**环境性条目 | ✅ 备选（不挤压卡片布局） |
| `conversation.input.overlay` | list | session | `{}` | composer **卡片内浮层** | ⚠️ 可用但要自己绝对定位，易与菜单/popup 打架 |
| `conversation.input.left` | list | session | `{}` | 工具行左侧紧凑控件 | ✅ 若想要 1 行小 chip |
| `conversation.input.right` | list | session | `{}` | 提交按钮前 | ✅ 同上 |
| `conversation.input.plan` | single | session | `InputControlOwnerProps { locked }` | 工具行 plan 控件 | ❌ 已占有 |
| `conversation.input.model` | single | session | `InputControlOwnerProps { locked }` | 工具行模型选择 | ❌ 已占有 |
| `conversation.session.header.actions` / `.utilities` | list | session | `ConversationHeaderActionOwnerProps { children?: never }` | 会话标题右侧 | ⚠️ 不是 composer 区 |
| `conversation.message.images` | single | session | `MessageImagesOwnerProps { images, loadImage, align }` | 历史消息图廊 | ❌（= §3.5 的图片槽） |
| `conversation.chat.node` | keyed | session | `ChatNodeOwnerProps` (+ `keyProps.node`, `hookContext`) | 逐 Chat 节点渲染器 | ❌ |
| `shell.overlay` | list | root | — | 浮在全 app 之上 | ⚠️ 全局浮层（`ui-renderer` 文档推荐的「自己的浮层」位） |
| `conversation` | single | root | `ConversationSlotProps` | 会话外壳 | ❌ |

完整层级树（官方文档 "Current hierarchy"，摘 composer 段）：

```
root
└─ main
   └─ main.conversation
      ├─ conversation.session
      │  └─ conversation.view
      │     ├─ conversation.chat.node
      │     ├─ conversation.message.images
      │     └─ conversation.trajectory.images
      ├─ conversation.session.header
      │  ├─ conversation.session.header.lineage
      │  ├─ conversation.session.header.actions
      │  ├─ conversation.session.header.utilities
      │  └─ conversation.session.header.corner
      ├─ conversation.composer                 ← chain (temporary takeover)
      │  └─ conversation.approval.detail
      ├─ conversation.composer.bar             ← single (owner: InputBar)
      │  ├─ conversation.input.attachments     ← single (owner: ui-attachment)
      │  ├─ conversation.input.plan
      │  └─ conversation.input.model
      ├─ conversation.input.overlay            ← list
      ├─ conversation.input.dock               ← list   ★ chip 推荐位
      ├─ conversation.composer.dock            ← list
      ├─ conversation.input.left               ← list
      ├─ conversation.input.right              ← list
      ├─ conversation.hero.brand.mark
      ├─ conversation.hero.workspace
      └─ conversation.hero.agentPreset
└─ shell.overlay
```

**owner 数据从哪来（已在 bundle 中确认）**：`ConversationRoot` 里

```js
const zone = session === void 0 || inputState === void 0 ? void 0 : { session, input: inputState };
// …
{zone !== void 0 && renderSlot("conversation.input.dock", zone)}
{input === void 0 || sessionId === void 0 ? null : renderSlot("conversation.input.left", {})}
```

→ `conversation.input.dock` 的 owner 是**活对象**：`input` 就是当前 `InputState`（含 `draftRev`、`occurrences`、`imageIds`），`session` 是 `SessionSnapshot`。这意味着 **chip 组件不只知道「有没有附加」，还能立刻算出插入点 span**。

### 4.3 chip 的正确归宿 + 可跑的注册代码

**结论：`conversation.input.dock`**（`list` / `session`）。理由：
1. 它是**加法**槽（list ⇒ 用唯一 `id`，不 shadow 别人的单元格）；
2. scope = `session` ⇒ 组件 props 自带 `sessionId` / `useInput` / `inputActions`（§2.2），无需服务注入；
3. owner 带 `input`（`InputState`）⇒ chip 能实时显示「已附加 1 页 + 1 图」，并能在 `draftRev` 变化时安全重算 span；
4. 位置在 composer 卡片上方整宽，正是「[📄 page: React 19 Docs ✕]」这种上下文 chip 的形态。

```tsx
// packages/dsh-chrome-bridge/src/client/index.tsx  (示意)
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'   // SlotMap 声明合并
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

export const inject = ['slots', 'sessions', 'conversation', 'uiConversation'] as const

interface AttachmentContext { readonly title: string; readonly url: string; readonly markdownPath: string }
/** per-session attached-page registry owned by this plugin (NOT in SessionSnapshot). */
const attached = new WeakMap<object, AttachmentContext>()   // key: AgentContext

type ChipProps = PropsRuntime<'conversation.input.dock'> & {
  matched: AttachmentContext | undefined
  onDetach: () => void
}

function ContextChip({ input, matched, onDetach }: ChipProps) {
  if (matched === undefined) return null
  return (
    <div className="dsh-ext-context-chip" role="group" aria-label="attached page">
      <span aria-hidden>📄</span>
      <span>{`page: ${matched.title}`}</span>
      <span className="dsh-ext-context-chip-count">
        {input.imageIds.length > 0 ? ` · ${input.imageIds.length} img` : ''}
      </span>
      <button type="button" onClick={onDetach} aria-label="remove attached page">✕</button>
    </div>
  )
}

export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      {
        name: 'conversation.input.dock',
        id: 'chrome-bridge-attach',       // list ⇒ 必须唯一 id
        order: 5,                          // 默认 0；todo dock = 0，queue dock = 20
        locale: undefined,
        inject: (sessionId) => ({
          // sessionId 由 scope adapter 注入（InjectParams<'conversation.input.dock'>）
          get attached() { return sessionId === undefined ? undefined : lookup(sessionId) },
          detach: () => { /* 清 registry + 若已插 chip 则同步编辑草稿 */ },
        }),
      },
      ContextChip as never,
    ),
  )
}
```

> **`matched` 不在 `PropsRuntime` 里**：`matched` 只属于 `chain` 槽的 `ComposedProps`（`MatchedShare`）。上面的 `matched` 是**示意性的业务字段名**，实际应从 `inject` 面拿（如 `attached` / `detach`）。写成 `matched` 会导致类型错误。**正确写法见 §4.3 的 `inject` 返回 + `InjectFace<I>`**。

### 4.4 三条硬规则（踩了会抛在插件激活期）

1. **不能注册进未声明的槽**：`throw new Error('slot "…" is not declared (a parent entry's children table must declare it)')`
2. **同一 cell 同 priority 的第二条注册会抛**（`list` 看 `id`，`single` 看槽本身，`keyed` 看 `key`）→ 想「替换」现有 chip 视觉要显式给**更低** priority（ascending，低者胜）；想「新增」就用新 `id`
3. **声明 child = 唯一所有权**：声明了 child 的 entry 必须真的 `renderSlot`，否则 `RendersCheck` 编译期报错

---

## 5. Q4 — 当前 session / workspace 的得知与选择，以及新建 session

### 5.1 读当前 session

```ts
// dsh-api-session-controller/lib/types/client/sessions/service.d.ts:56-79
export interface SessionListState {
    ids: SessionId[];
    byId: Record<SessionId, SessionSummary>;
    current: SessionId | undefined;          // ★ 当前选中
    phase: SessionListPhase;
    subagentsByParent: Readonly<Record<SessionId, SubagentCatalogSnapshot>>;
    jobsBySession: Readonly<Record<SessionId, Readonly<JobView[]>>>;
    currentAddress: SubagentAddress | undefined;
}
```

- **组件里**：`useSessions(s => s.current)`（`ui-session` 提供的 standard hook；官方文档 "every scope" 行）
- **服务里**：`ctx.sessions.list.getSnapshot().current`（`list: SnapshotStore<SessionListState>`，`service.d.ts:122-123`）
- **本插件自己是被 slot 注入的**：`inject: (sessionId) => …` 直接把当前 session id 交给你（粒度最精确，推荐）

`SessionSnapshot`（`client/contract/snapshot.d.ts:57-81`）关键字段：

```ts
export interface SessionSnapshot {
    readonly sessionId: SessionId;
    readonly queue: readonly QueuedMessage[];
    readonly pendingSubmissions: readonly PendingSubmission[];   // ★ optimistic echo
    readonly running: boolean;
    readonly subagent: { readonly address: SubagentAddress; readonly parentAvailable?: boolean } | null;
    readonly removed: boolean;
    readonly openState: OpenState;            // 'cold' | 'loading' | 'open' | 'error'
    readonly openError: RemoteFailure | null;
    readonly hasMore: boolean;
    readonly loadingOlder: boolean;
    readonly promptError: PromptError | null; // { op:'send'|'stop'; error: RemoteFailure }
    readonly blank: boolean;
    readonly lastAgentError: string | null;
    readonly promptAttempted: boolean;
    readonly awaitingFirstTurn: boolean;
}
```

`PendingSubmission`（同文件 `:38-49`）——**这就是「乐观回显」**，插件判断「我的请求在飞」的权威位：

```ts
export interface PendingSubmission {
    readonly requestId: SessionRequestId;
    readonly placement: PendingSubmissionPlacement;   // 'transcript' | 'queued' | 'steering'
    readonly time: number;
    readonly text: string;
    readonly images: readonly PendingSubmissionImage[];
}
```

### 5.2 读 workspace

- 组件：`useWorkspaces(s => …)`，`WorkspaceSnapshot`（`dsh-api-workspace-controller/lib/types/client/model.d.ts:11-18`）：
  ```ts
  export interface WorkspaceSnapshot {
      readonly items: readonly WorkspaceView[];
      readonly archivedSessionIds: WorkspaceArchiveValue['archivedSessionIds'];
      readonly state: 'idle' | 'loading' | 'error';
      readonly phase: 'pending' | 'ready';
      readonly error: RemoteFailure | null;
  }
  ```
- 服务：`ctx.workspaces`（`declare module '@deepseek-ai/cordis' { interface Context { workspaces: IWorkspaces } }`，`client/index.d.ts:19`），API：`list` / `create({path})` / `rename` / `delete` / `insertBefore` / `archiveSession` / `insertSessionBefore`
- **session → workspace 的归属不在 `SessionSnapshot` 里**：`SessionSummary.cwd` + `projectionValues`（`SessionSummary`，`service.d.ts:32-55`）。ConversationRoot 的 workspace chip 就是读 `sessionWorkspace?.title`。
- **选定 workspace 并开新会话（= 空会话 Hero 的行为）**在 conversation 的 `inject` 面里（`slots.d.ts:248-255`）：
  ```ts
  export interface ConversationInjected {
      /** Connect and open a blank Session in the selected Workspace. */
      selectWorkspace: (workspaceId: WorkspaceId) => Promise<void>;
      hooks: { composerBlock: ObservableSnapshot<ComposerBlock | undefined> };
  }
  ```
  > ⚠️ 这是 `conversation`（root）槽的 **inject 面**——**被 `ui-conversation` 自己的 `ConversationRoot` 占有**，第三方拿不到。第三方走 `ctx.sessions.create({ workspaceId })`。

### 5.3 新建 / 选择 session

**客户端服务（推荐）**：

```ts
// dsh-api-session-controller/lib/types/client/contract/sessions.d.ts
create(opts?: { workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId }): Promise<SessionId>;
open(id: SessionId): void;
clear(): void;
refresh(): Promise<void>;
fork(opts: { sessionId: SessionId; atSeq?: number; increaseTitle?: boolean }): Promise<SessionId>;
```

`ClientSessions.create` 的**关键保证**（`sessions/service.d.ts:236-251`）：

> Resolution guarantee: by the time the promise resolves, the created session is in the list store and `binding` resolves it — callers (New Session draft hand-off) may address the scope synchronously, without waiting a notifier flush.

→ **可以 `await ctx.sessions.create({ workspaceId })` 后立刻 `ctx.sessions.scope(id)` + `setDraft`**，正好是我们要的「新建会话 → 塞网页内容」。

**对应 RPC（wire 层）**：

| RPC | Request | Value |
|---|---|---|
| `session/create` | `{ workspaceId?: WorkspaceId; cwd?: string; sessionId?: SessionId; agentPreset?: string }` | `{ sessionId: SessionId; agentPreset?: string }` |
| `session/list` | `{ cursor?: string }` | `{ items: readonly SessionSummary[] }` |
| `session/prompt` | `{ requestId; sessionId; mode: 'queue'\|'steer'; content: readonly PromptContentPart[]; clientTimeZone? }` | `{ accepted: true }` |
| `session/attachment` | `{ sessionId; attachmentId }` | `{ attachment: ImageAttachmentRef; data: string }`（**读**图） |
| `session/cancel` | `{ sessionId }` | `{ accepted: true }` |
| `session/rename` | `{ sessionId; title }` | `{ title; seq }` |
| `session/fork` | `{ sessionId; atSeq? }` | `{ sessionId }` |
| `session/search` | `{ query }` | `{ items; hasMore }` |
| `session/updateQueue` | `{ sessionId; itemId; action }` | `{ accepted: true }` |

> `ctx.sessions.create` **不接受 `agentPreset`**（只有 RPC 接受）。要在创建时指定 preset，只能走 `ctx.remote.session.create({ workspaceId, agentPreset })`。

**直接调 RPC**：`ctx.remote`（`declare module '@deepseek-ai/cordis' { interface Context { remote: ClientRemote } }`，`dsh-api-gateway/lib/types/client/index.d.ts`），生成式命名空间：

```ts
ctx.remote.session.create({ workspaceId })
ctx.remote.session.prompt({ requestId, sessionId, mode: 'queue', content: [{ type: 'text', text: '…' }] })
ctx.remote.fileReferences.list(sessionId, query, signal)
```

### 5.4 程序化发 prompt（不经过 composer）

两种：

```ts
// (1) 服务面，scope-addressed（session/prompt，text 作为一个 text block verbatim 发送）
//     dsh-client-ui-conversation/lib/types/client/service.d.ts:31-36
ctx.conversation.send('…'): Promise<void>;         // 必须在 session scope ctx 上调用

// (2) 带图片 + 乐观回显的完整面
//     dsh-api-session-controller/lib/types/client/contract/session.d.ts:110-147
const handle = session.beginSubmission({ mode: 'queue', text, images, onRetire });
const res = await session.prompt(
  [...images.map(i => ({ type: 'image', mediaType, data, name })), { type: 'text', text }],
  'queue', signal, handle.requestId,
);
```

`ctx.conversation` 是 **scope-addressed**：service 用 cordis tracker 让 `this.ctx` 在属性访问时绑定到调用者 ctx，`scopeOf` 读 session tag；**在 root ctx 上调用会 fail loud**（`service.d.ts:1-9`、`scopedSession` 注释）。

---

## 6. Q5 — transport 可行性：`window` `message` 监听

### 6.1 DSH web shell 自己有没有用 window message？

**结论：没有。** 全量扫描本机所有已安装包的 `lib/*.js`：

```
$ grep -rln "addEventListener(\"message\"" --include="*.js" <pkg root>
./dsh-client-hmr/lib/client.js          # EventSource 的 message 事件（HMR SSE），非 window
./dsh-api-gateway/lib/client.js         # WebSocket 的 message 事件
./dsh-api-gateway/lib/types/client/stream-client.js   # 同上
```

`dsh-web-frontend/dist/assets/` 里唯一命中 `addEventListener("message"...)` 的是 **React scheduler 的 `MessageChannel.port1.onmessage`**（用于 `unstable_scheduleCallback`），与业务无关。全仓 `postMessage` 在 shell bundle 里也**只有那一处**。

→ **`window` 的 `message` 事件命名空间是空的，第三方客户端插件可以安全占用。**

### 6.2 CSP / sandboxing 会不会挡住？

- 本机 `dsh-web-frontend/dist/index.html` **没有 `<meta http-equiv="Content-Security-Policy">`**（全文 679 字节，只有 charset / viewport / manifest / favicon / script / modulepreload / 2×stylesheet）。
- 全量 grep 所有已安装包：**`Content-Security-Policy` / `frame-ancestors` / `X-Frame-Options` 零命中**（与 `网页插件/FINDINGS.md` §2 的实测一致）。
- `dsh-host-webserver/lib/index.js` 里仅有的 `writeHead(404` / `writeHead(400`；`WebRoute.handler` 注释明确 "Owns the full response lifecycle"，但 **DSH 自己不加任何安全响应头**。

→ **CSP 不阻塞**：没有 `default-src`/`script-src` 限制，没有 `frame-ancestors`（所以 iframe 嵌入合法），`postMessage` 也不受 CSP 管控。
→ **sandbox 不阻塞**：插件 bundle 由 `/plugins/??…&rev=…` combo URL 以普通 `<script type="module">` 加载进**同一 document**，不是 sandboxed iframe。
→ 但**跨源 postMessage 的 `event.origin` 校验是必须的**（见下）。

### 6.3 正确的监听/校验/销毁写法

消息来自 embedding 的 `chrome-extension://<id>` 页面（side panel）或 content script 的 `window.postMessage`。校验要点：

```ts
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'  // 固定扩展 ID

export function apply(ctx: Context): void {
  // ctx.effect(...) 的返回值就是 disposer；fiber unload（含 HMR）自动移除监听
  ctx.effect(() => {
    const onMessage = (event: MessageEvent): void => {
      // ① origin 必须精确匹配 extension origin（不要用 startsWith / includes）
      if (event.origin !== EXT_ORIGIN) return
      // ② origin 匹配后，event.source 必须是我们的父窗口（panel 里 iframe 的父）
      if (event.source !== window.parent && event.source !== window) return
      // ③ 结构校验（数据是不可信输入）
      const data = event.data as unknown
      if (typeof data !== 'object' || data === null) return
      const { channel, nonce, kind } = data as Record<string, unknown>
      if (channel !== 'dsh-chrome-bridge/v1') return
      if (typeof nonce !== 'string' || !timingSafeEqual(nonce, expectedNonce)) return
      // ④ 只处理白名单 kind；payload 逐字段校验后再用
      ...
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, 'dsh-chrome-bridge: extension transport')
}
```

安全注意（**必须做**）：
1. **`event.origin` 精确比较**：扩展页面 origin 是 `chrome-extension://<固定32位ID>`。**扩展 ID 由公钥决定**，所以它是稳定常量——但打包时若换了 key 就会变。建议 host 侧（`dsh plugin` 安装期）把 ID 写进插件配置，插件运行时读配置，**不要硬编码**（见 `网页插件/FINDINGS.md` §4 A.1 的握手 key 思路）。
2. **回发消息必须显式 targetOrigin**：`event.source.postMessage(reply, EXT_ORIGIN)`（不要 `'*'`）。
3. **`event.source` 校验**：DSH 页面可能被多个 iframe/窗口嵌入。用 `event.source === window.parent` 精确锚定；若要支持顶层窗口打开（FINDINGS §4 B 的「兜底」路径），则 `window.parent === window`，此时改为校验 `event.source === window` 或放行并依赖 nonce。
4. **一次性握手 nonce**：扩展侧生成随机 nonce 放进 iframe URL（`/ext/enter?...`），DSH 侧插件从 URL/配置读同一值，之后每条消息都带 nonce —— 这样即使 `chrome-extension://` origin 被别的扩展伪造（Chrome 保证 origin 是真实扩展 ID，但仍值得纵深防御）也无害。
5. **dispose**：`ctx.effect` 是正确机制（cordis fiber 生命周期 + HMR reload 都会跑 disposer）。**不要**用模块顶层 `window.addEventListener`——HMR 会累积监听器。

### 6.4 与已有 transport 的关系

- DSH 页面的 RPC 走 `/api`（`API_PATH = '/api'`，`dsh-client-connection/lib/types/api-path.d.ts`）+ WebSocket（gateway stream）。**扩展页面直接 fetch `/api` 会被 Host/Origin 围栏 403**（FINDINGS §2 实测），所以**数据必须从 iframe 内部发起**——这正是本插件存在的理由。
- `dsh-client-connection` 的 `ClientTransportHooks`（`client/index.d.ts:46`）是**给「自己拥有 Host 的 shell」（worker preview 的 postMessage tunnel）预留的**，install 在 page global 上、在插件 boot 之前。**第三方插件不要用这条缝**去改 transport；用独立的 `window` message 通道即可，两者互不冲突。
- 若插件还想从宿主取数据（例如把网页正文写成工作区文件），**在 iframe 内部调用 `ctx.remote.*` 就是合法的同源 RPC**，无需 postMessage 中转。

---

## 7. Q6 — 能不能程序化插入 `@file` 原子引用

**可以，而且不需要新 API。**

### 7.1 `ui-reference` 注册的 source（已在 bundle 中逐行确认）

```js
// dsh-client-ui-reference/lib/client.js
const source = {
  trigger: "@",
  name: "reference",
  showGroupTitle: false,
  async candidates(session, { query, quoted, drilled, signal }) {
    const fileLookup = ctx.remote.fileReferences.list(session.sessionId, query, signal)…
    const sessionLookup = quoted === true ? Promise.resolve([]) : ctx.remote.sessionReferenceResolver.candidates(...)…
  },
  onPick({ candidate, action }) {
    const value = parseCandidate(candidate.value);
    if (value?.kind === "file") {
      if (value.fileKind === "directory" && action === "drill")
        return { text: value.mention, continue: true };
      return { insert: {
        source: "reference",
        ref: value.mention,
        label: value.fileKind === "directory" ? `${value.label}/` : value.label,
        appearance: value.fileKind === "directory" ? "folder" : "file",
        clipboardText: value.mention,
      }};
    }
    if (value?.kind === "session") return { insert: {
      source: "reference", ref: value.mention, label: value.label,
      appearance: "session", clipboardText: value.mention,
    }};
  },
  codec: {
    clipboardText: (ref) => ref,
    serialize: (ref) => Promise.resolve(ref),        // ← 模型看到的就是 ref 本身
  },
};
const inputTriggers = ctx.get("inputTriggers");
ctx.effect(() => inputTriggers.registerSource(source), "ui-reference: @ source");
```

### 7.2 所以插入一个指向「你自己写进工作区」的文件的原子 chip，就是：

```ts
// 1) 让 Host 把文件写进 session cwd（fileReferences.list 的服务端；或你自己的 host 插件用 ctx.fs）
//    → 例如 session cwd = /Users/mac/ai_tools/dsh project，文件 = ./网页插件/docs/attach/react19.md
// 2) 用共享 grammar 生成 mention（dsh-file-reference/lib/types/grammar.d.ts）
//    export declare function formatFileMention(candidate: FileReferenceCandidate, preserveQuote: boolean): string | undefined
//    candidate: { path: string; kind: 'file' | 'directory' }   ← path 是相对 session cwd 的路径
//    → '@网页插件/docs/attach/react19.md'（含空格则 '@"…"'）
// 3) 插入 chip
const mention = '@网页插件/docs/attach/react19.md';
const ref: ReferenceInsert = {
  source: 'reference',            // ← 必须精确是 'reference'（否则提交时 serializeReference 抛 "no serializer for reference source …"）
  ref: mention,
  label: 'react19.md',
  appearance: 'file',             // 'file' | 'folder' | 'session'
  clipboardText: mention,
};
const rev = shell.state.getSnapshot().draftRev;
shell.insertReference(ref, { start, end, draftRev: rev });   // ★ 类型安全、有 CAS
// 或等价的事件形式：actx.bail(actx, 'slash/input-insert-reference', { reference: ref, span: { start, end, draftRev: rev } })
```

`formatFileMention` 的完整实现（`dsh-file-reference/lib/types/grammar.js`）：

```js
export function formatFileMention(candidate, preserveQuote) {
    const path = candidate.kind === 'directory' ? `${candidate.path}/` : candidate.path;
    if (/[\u0000-\u001f\u007f-\u009f"]/u.test(path)) return undefined;   // 含引号/控制字符 → 无法安全表达
    const quoted = preserveQuote || /\s/u.test(path);
    if (!quoted) return `@${path}`;
    if (candidate.kind === 'directory') return `@"${path}`;
    return `@"${path}"`;
}
```

→ **别自己拼 `@path`**：路径含空格必须 `@"…"`；路径含 `"` 或控制字符时必须放弃（改用 `setDraft` 里的普通文本，或写一个无空格的文件名）。

### 7.3 「原子 chip」vs「普通文本」的取舍

| | chip（`insertReference`） | 纯文本（`insertText` / `setDraft`） |
|---|---|---|
| 显示 | 原子不可编辑节点 + 领域图标（`appearance`） | 扫描派生的装饰（`TextRefNode`），外观像 chip 但**不是状态** |
| clipboard / 持久化 | 走 owner codec 的 `clipboardText` | 就是字面文本 |
| 提交给模型 | owner codec 的 `serialize(ref, signal)`（`reference` source 是恒等） | 字面文本 |
| 失败模式 | codec/owner 缺失 → **整个提交被 block**（拒绝静默降级，`facade.ts` 注释） | 无 |
| 适用 | 想让用户能一键删掉、且语义明确 | 只是想让路径出现在 prompt 里 |

**本方案建议**：正文 Markdown **写进工作区文件** + 插一个 `@file` chip（语义清晰、可删、模型能自己 `read` 全文），**截图走图片附件通道**（不走文件引用，因为 ref 只读图不读文件）。

---

## 8. 完整参考实现（把 §2–§7 拼起来）

```ts
// ── dsh-chrome-bridge: client half ────────────────────────────────────
// package.json: { "dsh": { "client": { "platform": "web",
//   "inject": ["@deepseek-ai/dsh-client-ui-conversation",
//              "@deepseek-ai/dsh-client-ui-session",
//              "@deepseek-ai/dsh-client-ui-workspace",
//              "@deepseek-ai/dsh-api-session-controller",
//              "@deepseek-ai/dsh-client-connection"] } },
//   "exports": { "./client": { "types": "./lib/types/client/index.d.ts",
//                              "default": "./lib/client.js" } } }

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { InputState, ReferenceInsert } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'

export const inject = ['slots', 'sessions', 'conversation', 'remote', 'workspaces'] as const

interface AttachedPage { title: string; url: string; workspaceRelPath: string; pngBase64?: string }
const pages = new Map<SessionId, AttachedPage>()

/** ① 拿到写入通道 */
function inputFor(ctx: Context, sessionId: SessionId) {
  const actx = ctx.sessions.scope(sessionId)
  if (actx === undefined) throw new Error(`chrome-bridge: session ${sessionId} has no scope`)
  return { actx, shell: ctx.conversation.input.for(actx) }
}

/** ② 插入 markdown 正文（纯文本，追加到草稿末尾） */
function insertText(ctx: Context, sessionId: SessionId, text: string): boolean {
  const { actx, shell } = inputFor(ctx, sessionId)
  const input: InputState = shell.state.getSnapshot()
  const at = input.draft.length                                   // chip-free 草稿下 clipboard == detect
  return actx.bail(actx, 'slash/input-insert-text',
    { request: { text, span: { start: at, end: at, draftRev: input.draftRev } } }) === true
}

/** ③ 插入 @file 原子引用（文件已由 host 半边写进 workspace） */
function insertFileRef(ctx: Context, sessionId: SessionId, relPath: string, label: string): boolean {
  const { shell } = inputFor(ctx, sessionId)
  const input = shell.state.getSnapshot()
  const mention = formatFileMention({ path: relPath, kind: 'file' }, false)
  if (mention === undefined) throw new Error(`chrome-bridge: path not expressible in @-grammar: ${relPath}`)
  const ref: ReferenceInsert = {
    source: 'reference', ref: mention, label, appearance: 'file', clipboardText: mention,
  }
  return shell.insertReference(ref, { start: input.draft.length, end: input.draft.length, draftRev: input.draftRev })
}

/** ④ 附加截图 PNG（base64 → File → draft image） */
function attachPng(ctx: Context, sessionId: SessionId, b64: string, name = 'page.png'): string | null {
  const { shell } = inputFor(ctx, sessionId)
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  const file = new File([bytes], name, { type: 'image/png' })

  const cc = ctx.conversation as unknown as {
    createDraftImages(files: readonly File[]): readonly { id: string }[]
    releaseDraftImages(a: readonly { id: string }[]): void
  }
  const drafts = cc.createDraftImages([file])
  if (!shell.addImages(drafts.map(d => d.id))) { cc.releaseDraftImages(drafts); return null }  // busy
  return drafts[0]?.id ?? null
}

/** ⑤ 页面入口：message 通道 + chip slot */
export function apply(ctx: Context): void {
  ctx.slots.inject('conversation.input.dock', () =>
    ctx.slots.register(
      { name: 'conversation.input.dock', id: 'chrome-bridge-attach', order: 5,
        inject: (sessionId) => ({
          get page() { return sessionId === undefined ? undefined : pages.get(sessionId) },
          detach: () => { if (sessionId !== undefined) pages.delete(sessionId) },
        }) },
      ContextChip as never,
    ),
  )

  ctx.effect(() => {
    const onMessage = (event: MessageEvent): void => {
      if (event.origin !== EXT_ORIGIN) return
      const msg = event.data as { channel?: string; kind?: string; title?: string; url?: string; png?: string }
      if (msg?.channel !== 'dsh-chrome-bridge/v1') return
      const sessionId = ctx.sessions.list.getSnapshot().current
      if (sessionId === undefined) return
      if (msg.kind === 'attach-page') {
        // 由 host 半边（ctx.webServer.register 的 /ext/attach）把 markdown 落盘，这里插 @file
        pages.set(sessionId, { title: msg.title ?? 'untitled', url: msg.url ?? '', workspaceRelPath: '' })
        if (msg.png !== undefined) attachPng(ctx, sessionId, msg.png)
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, 'dsh-chrome-bridge: extension transport')
}
```

**「新建会话」变体**：

```ts
const sessionId = await ctx.sessions.create({ workspaceId })   // 或 { cwd }
ctx.sessions.open(sessionId)
// create() 的保证：resolve 时已在 list store 且 binding 可解析 → 可立刻 scope()/写草稿
```

---

## 9. 版本漂移 / 兼容性（**必须先读**）

### 9.1 本机（0.1.2-rc.1，唯一权威）

- `InputActions.addImages` / `removeImage` / `pruneImages`（`contract/input.d.ts:202-213`）
- `ConversationController.createDraftImages` / `draftImages` / `serializeDraftImages` / `releaseDraftImage(s)` / `sendSession`（`service.d.ts:107-131`）
- `SubmitImageAttachment { mediaType; data; name? }`（`input.d.ts:22-26`）
- `InputState.imageIds`、`ComposerAttachment { kind:'image'; id; file; previewUrl; width?; height? }`

### 9.2 `master` 分支（已确认，**不要照抄**）

`packages/client/ui-conversation/src/client/contract/input.ts:238-249`：

```ts
export interface InputActions {
  setDraft(text: string): void
  addAttachments(ids: readonly DraftAttachmentId[]): boolean
  removeAttachment(id: DraftAttachmentId): void          // 返回 boolean（本机是 void）
  pruneAttachments(ids: readonly DraftAttachmentId[]): void
  submit(): void
}
```

同时 `SubmitAttachment` 取代 `SubmitImageAttachment`、`ImageAttachmentRef` 全部改名 `AttachmentRef`、`ComposerAttachment` 改名、`claim.images` → `claim.attachments`、`SubmitEnvelope.images` → `.attachments`，并新增 `bindFilePicker` / `canPickFiles` / `pickFiles`（`ComposerKeyboard`）。

### 9.3 推荐：能力探测 shim（两种版本通吃）

```ts
type AnyActions = Record<string, unknown>
function isFn(v: unknown): v is (...a: never[]) => unknown { return typeof v === 'function' }

export function composerImageOps(actions: AnyActions) {
  if (isFn(actions.addImages) && isFn(actions.removeImage)) {
    return {
      add: actions.addImages as (ids: readonly string[]) => boolean,
      remove: actions.removeImage as (id: string) => void,
      prune: actions.pruneImages as ((ids: readonly string[]) => void) | undefined,
    }
  }
  if (isFn(actions.addAttachments) && isFn(actions.removeAttachment)) {
    return {
      add: actions.addAttachments as (ids: readonly string[]) => boolean,
      remove: actions.removeAttachment as (id: string) => void,
      prune: actions.pruneAttachments as ((ids: readonly string[]) => void) | undefined,
    }
  }
  throw new Error('chrome-bridge: no composer attachment action found (unknown DSH version)')
}
```

同理探测 conversation service：

```ts
const cc = ctx.conversation as unknown as Record<string, unknown>
const create = (cc.createDraftImages ?? cc.createDraftAttachments) as ((f: readonly File[]) => readonly { id: string }[]) | undefined
if (create === undefined) throw new Error('chrome-bridge: unsupported conversation service surface')
```

### 9.4 `.d.ts` 与本机 bundle 的一处历史不一致（不影响调用）

`dsh-client-ui-conversation/lib/types/client/input/facade.d.ts:40-41,221-232` 提到 `defaultSink(text, imageIds, …)` 与 `commandImages`；而 `sendSession`/`serializeDraftImages` 在 `service.d.ts` 里。**契约面以 `contract/*.d.ts` 为准**（那是 `index.d.ts` 重导出的公共类型），`facade.d.ts`/`hub.d.ts` 是 package-private 内部结构（文件头注释明说 "Package-private; the hub alone constructs it"）。

---

## 10. UNVERIFIED 清单 + 可判定的实验

| # | 未确认项 | 为什么要紧 | 判定实验 |
|---|---|---|---|
| U1 | `ctx.conversation`（类型 `IConversation`）在运行时是否真的暴露 `createDraftImages`/`sendSession`/`releaseDraftImage(s)` | 这是插图片的主路径；类型未承诺 | 在 web profile 装一个 hello-world 客户端插件，`apply` 里 `console.log(Object.getOwnPropertyNames(Object.getPrototypeOf(ctx.conversation)))`；或在 DSH GUI 里跑 `cordis_inspect` 工具查 `conversation` service 面 |
| U2 | `actx.bail(actx, 'slash/input-insert-text', payload)` 的**确切实参形状**（payload 直接传还是包一层 `request`） | 插任意位置文本的唯一通路 | 单测：注册 session scope，`actx.bail(actx, 'slash/input-insert-reference', { reference, span })` 看返回 true 且草稿出现 chip；对照 `ui-input-trigger/lib/client.js` 的 `execute()` 实参 |
| U3 | 从 root ctx 是否有官方途径拿 session scope 之外的可写面（例如 `ctx.uiSession` 的公开读面） | 简化实现 | `cordis_inspect what:"client"` 查 `uiSession` service 的公开方法 |
| U4 | `dsh-client-ui-slots` 在本机安装缺失（`require.resolve` 失败，`dsh-client-ui-*` 都以它作 runtime dep）时，插件 bundle 如何解析 `@deepseek-ai/dsh-client-ui-slots` | 决定 `dsh.client.external` 要不要写它 | 检查 `window.__DSH_BOOT__` 的 `PLATFORM_MODULES` 静态表键名（grep `dsh-web-frontend/dist/assets/vendor-*.js`）；或看现成插件 bundle 里该 specifier 是否被内联 |
| U5 | 客户端对 `maxImagesPerMessage` / `maxImageBytes` **完全没有**前置校验（已确认 `createDraftImages` 只查 MIME），所以超限错误只在 `session/prompt` 返回 | UX：需要自己前置把关（截图 PNG 一般远小于 20 MiB，风险低） | 发一张 >20 MiB 或第 21 张图，观察 `session/attachment-invalid` 与整个 prompt 失败（README 明确 "if any image is refused, the whole message fails"） |
| U6 | `insertReference` 的 span 在**含 chip 草稿**里如何精确换算（clipboard ↔ detect 坐标） | 只在「已有 chip 时追加」才踩到 | 手动插两个 chip 后调 `insertReference` 到末尾，观察是否落在正确位置；或直接改用 `setDraft` 全量重写（规避） |
| U7 | `conversation.input.dock` 的 `order` 冲突边界（todo=0，queue=20） | 影响 chip 排位 | `ctx.slots.entries('conversation.input.dock')` 打印现状 |
| U8 | Host 写入 workspace 文件的那半边（`ctx.webServer.register` 的 `/ext/attach`，见 `网页插件/FINDINGS.md` §4 A.2）能否直接用 `ctx.fs` 而不经 HTTP | 决定「先写文件再 `@file`」这条链路是否还能更短 | 读 `dsh-fs` / `dsh-fs-local` 的 host 面类型（本次未展开） |
| U9 | CSP：**未实测**在真实 Chrome + iframe 场景下是否有运行时注入的 CSP（本机静态产物无 CSP meta，全仓无 CSP 字符串，但反向代理/企业策略可能加） | postMessage 本身不受 CSP 限制，故风险低；但 `blob:` / `data:` 图片加载受 `img-src` 影响 | 在 `网页插件/spike` 里用 CDP 读 `document.securityPolicy` / 监听 `securitypolicyviolation` 事件 |

---

## 11. 结论 / 建议路线

1. **不要走「纯文本塞整篇 Markdown」**。改成：
   - host 半边把正文 Markdown 落到 session workspace（`/ext/attach`），
   - client 半边插一个 `@file` chip（`insertReference` + `source:'reference'`，ref 用 `formatFileMention` 生成）。
   → 模型自己 `read` 全文，context 可控、用户可一键删。
2. **截图走图片通道**：`File` → `createDraftImages` → `addImages`，配 §9.3 的能力探测 shim。
3. **chip 用 `conversation.input.dock`**（`list` / `session`，独有 `id`，`order: 5`），从 `inject(sessionId)` 拿 session 与 registry，从 props 的 `input`/`useInput`/`inputActions` 拿状态与动作。
4. **session 选择**：`ctx.sessions.list.current`（读）/ `ctx.sessions.create({workspaceId})` + `open()`（写，且 resolve 后可立即写草稿）。
5. **transport**：`window` message 命名空间在 DSH 里是空的、无 CSP 阻挡；用 `ctx.effect` 注册/销毁，`event.origin` 与扩展 ID 精确比对 + nonce 纵深防御 + 回发显式 `targetOrigin`。
6. **先做 U1/U2 两个 30 分钟实验**再落实现：它们决定 §8 里两条主路径的确切写法。

---

## 附录 A — 文件路径索引（ground truth）

```
# 版本
@deepseek-ai/dsh-web-frontend/package.json                          → "version": "0.1.2-rc.1"

# composer / input
dsh-client-ui-conversation/README.md                                （shell、slots、temporary composer entries）
dsh-client-ui-conversation/lib/types/client/contract/input.d.ts     ★ InputActions / SessionInput / InputState / TokenSpan /
                                                                      ReferenceInsert / SubmitImageAttachment / scoped events
dsh-client-ui-conversation/lib/types/client/contract/slots.d.ts     ★ 全部 SlotMap 声明 + standard props + owner props
dsh-client-ui-conversation/lib/types/client/service.d.ts            ★ IConversation / ConversationController（createDraftImages…）
dsh-client-ui-conversation/lib/types/client/input/facade.d.ts        SessionInputShell（package-private 动词与 CAS 语义）
dsh-client-ui-conversation/lib/types/client/input/hub.d.ts           InputHub（shellFor / shell / inputTriggers）
dsh-client-ui-conversation/lib/types/client/index.d.ts               exports + declare module Context
dsh-client-ui-conversation/lib/client.js                             ★ 运行时（action 名、事件监听、imageMediaType、base64Of）

# trigger / reference
dsh-client-ui-input-trigger/lib/types/types.d.ts                     ★ InputTriggerSource / codec / SubmitEnvelope
dsh-client-ui-input-trigger/lib/types/client/controller.d.ts         ★ InputTriggerController
dsh-client-ui-input-trigger/lib/types/client/contract.d.ts           ctx.inputTriggers 面（registerSource / sessionOf）
dsh-client-ui-input-trigger/lib/client.js                            execute() → actx.bail(...) 实参形状
dsh-client-ui-reference/lib/client.js                                ★ source 名 'reference'、ReferenceInsert 形状、codec
dsh-file-reference/lib/types/grammar.d.ts|.js                        ★ formatFileMention / activeAtToken
dsh-file-reference/lib/types/types.d.ts                              FileReferenceCandidate

# slots runtime
dsh-client-ui-renderer/lib/types/client/registry.d.ts                ★ SlotRegistry（register / inject / install / entries）
dsh-client-ui-renderer/README.md
（dsh-client-ui-slots 本机未安装；类型与语义见 ui-renderer 的转发面 + 官方文档 + master 源码）

# attachment
dsh-attachment/README.md                                             ★ 端到端行为与限制
dsh-attachment-local/README.md                                       ★ 全部 size/format 默认值
dsh-attachment/lib/types/types.d.ts                                  ★ ImageAttachmentRef / PromptContentPart / EncodedImageAttachment
dsh-client-ui-attachment/README.md                                   表现层与三个 slot

# session / workspace / RPC
dsh-api-session-controller/lib/typert.remote-client.d.ts             ★ RPC 名册与签名
dsh-api-session-controller/lib/types/types.d.ts                      ★ 全部 *Request / *Value 形状
dsh-api-session-controller/lib/types/client/contract/sessions.d.ts   ★ ISessions（create/open/binding/scope）
dsh-api-session-controller/lib/types/client/contract/session.d.ts    ★ ISession（prompt/readAttachment/beginSubmission）
dsh-api-session-controller/lib/types/client/contract/snapshot.d.ts   ★ SessionSnapshot / PendingSubmission
dsh-api-session-controller/lib/types/client/sessions/service.d.ts    ★ ClientSessions（create 的 resolve 保证）
dsh-api-session-controller/lib/types/client/scope.d.ts                AgentContext / createScope / scopeOf
dsh-api-workspace-controller/lib/types/client/model.d.ts              WorkspaceSnapshot
dsh-api-workspace-controller/lib/types/client/service.d.ts            IWorkspaces
dsh-api-gateway/lib/types/client/index.d.ts                          ★ ctx.remote: ClientRemote

# client plugin loading / transport
dsh-client-modules/README.md                                          ★ dsh.client 声明与 bundle 服务
dsh-client-ui-agent-preset/package.json                               dsh.client 真实样例
dsh-client-connection/lib/types/api-path.d.ts                         API_PATH = '/api'
dsh-client-connection/lib/types/api-request-trust.d.ts                Host/Origin 围栏
dsh-client-connection/lib/types/client/index.d.ts                     ClientTransportHooks（不要用）
dsh-web-frontend/dist/index.html                                      无 CSP meta
```

## 附录 B — 外部引用

| 内容 | 链接 | 与本机版本的关系 |
|---|---|---|
| Slot 系统官方参考（层级树 / cardinality / 扩展规则） | https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/slots | master；层级树与规则与本机一致 |
| `ui-slots` README | https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/client/ui-slots/README.md | 包未安装在本地；语义与 ui-renderer 转发面一致 |
| `ui-slots` 源码（register 重载 / PropsRuntime / ChainSelect / InjectParams） | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/ui-slots/src/index.ts | master；本机版未安装，签名视为**同版本语义** |
| `ui-conversation` 的 `facade.ts` 源码 | https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/ui-conversation/src/client/input/facade.ts | **master：已改名为 attachment，勿照抄** |
| 本仓库内部调研（cookie / iframe 实测） | `网页插件/FINDINGS.md` | 与本笔记 §6 结论一致 |
