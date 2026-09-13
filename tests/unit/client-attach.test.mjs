#!/usr/bin/env node
/**
 * client 半「attach 落地 + 意图嗅探」契约单测 —— 直接加载那个手写 bundle。
 *
 * 契约（v3.39，用户决策 A「恢复设计行为」之后）：
 *   - `sessionMode: 'new'`（面板按钮 / 右键菜单）→ 新建会话 + `sessions.open()` 切过去
 *     + 把 `@文件` 写进**那个新会话**的草稿 + ack `inserted`。这就是设计里 `attachSessionMode`
 *     默认 `new` 的含义：抓取属于一段新对话，用户落在那里，话就能接着说。
 *   - `sessionMode: 'current'`（「看左边」）→ 不新建会话，引用进**当前**草稿。
 *
 * 但"切过去"只在**一次抓取只落一个页面**、**一次意图只抓一次**的前提下才不是惊吓 ——
 * 这两条分别由 `hub.pushClientPrimary`（见 `tests/unit/capture-routing.test.mjs`）和这里的
 * 意图 episode 逻辑保证。历史（v3.38 之前）正是"一抓两投 + 一意图两抓"让同一个切换看起来
 * 随机发生 —— 用户报的现象就是它，会话库里两个会话相隔 5ms 被建出来。
 *
 * 为什么要这么测：`client.js` 是手写产物（`dsh-plugin/package.json` 里的
 * `build:client` 指向一个并不存在的 `build.mjs`），以前只有真 Chrome 探针能碰它，
 * 而探针跑的是**白盒 hook**，正是这类真实链路缺陷漏掉的原因。
 *
 * 用法：node tests/unit/client-attach.test.mjs
 */
/* ── 1. 先把浏览器环境桩住，再加载 bundle ───────────────────────────────── */
let spec = null
globalThis.window = {
  __ModuleLoader__: { load: (value) => { spec = value } },
  addEventListener: () => {},
}
globalThis.document = {
  querySelector: () => null,
  addEventListener: () => {},
  visibilityState: 'visible',
  hasFocus: () => true,
}
globalThis.location = { protocol: 'http:', host: '127.0.0.1:3099', href: 'http://127.0.0.1:3099/' }

const sentFrames = []
globalThis.WebSocket = class {
  constructor(url) {
    this.url = url
    this.readyState = 1
    this.listeners = {}
    // Fire `open` like a real socket would: the bundle's hello (and its page facts) are
    // sent from that handler, so a stub that never opens would silently skip the whole
    // announce path — and the test would "pass" while proving nothing about it.
    setTimeout(() => { for (const fn of this.listeners.open ?? []) fn() }, 0)
  }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn) }
  send(data) { sentFrames.push(data) }
  close() { this.readyState = 3 }
}
globalThis.setInterval = () => 0
globalThis.clearInterval = () => {}

await import('../../dsh-plugin/lib/client.js')
if (spec === null) { console.error('bundle 没有调用 __ModuleLoader__.load'); process.exit(1) }
const reactStub = { useState: () => [0, () => {}], useEffect: () => {}, createElement: () => null }
const clientModule = spec.factory((name) => {
  if (name === 'react') return reactStub
  throw new Error(`unexpected require(${name})`)
})

/* ── 2. 假 ctx：记录每一次 setDraft / sessions.open / create ─────────────── */
const calls = { setDraft: [], opened: [], created: [] }
const drafts = {}
const sessions = {
  list: { getSnapshot: () => ({ ids: ['sess-a'], byId: { 'sess-a': { id: 'sess-a', cwd: '/tmp/ws' } } }) },
  create: async () => { calls.created.push('sess-new'); return 'sess-new' },
  open: async (id) => { calls.opened.push(id) },
  scope: (id) => ({ id }),
}
const shellFor = (id) => ({
  state: { draft: drafts[id] ?? '' },
  setDraft: (text) => { calls.setDraft.push({ sessionId: id, text }); drafts[id] = text },
})
const services = {
  sessions,
  conversation: { input: { for: (scope) => shellFor(scope.id) } },
  uiSession: { currentBinding: { props: { sessionId: 'sess-a' } } },
  uiWorkspace: { workspaces: { list: { getSnapshot: () => ({ items: [{ id: 'ws1', path: '/tmp/ws' }] }) } } },
  slots: undefined,
}
const ctx = { get: (name) => services[name], effect: () => () => {}, on: () => () => {} }

clientModule.apply(ctx)
const client = globalThis.__AG_CLIENT__
client.state.dockMounted = true // 免掉 DOM 兜底条带（本测试不测 DOM）

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 150)}`)
}
const offer = (captureId, sessionMode) => client.deliver({
  captureId,
  fileRef: `@网页捕获/${captureId}.md`,
  sessionMode,
  mode: 'page',
  page: { title: '夹具页' },
  summary: { chars: 100, hasSelection: false },
})

console.log('1. sessionMode=new（面板按钮 / 右键菜单）→ 新建会话 + 切过去 + 写进那个会话的草稿')
await offer('cap-new-1', 'new')
const lastNew = globalThis.__AG_LAST_ATTACH__
record('新建了会话', calls.created.length === 1)
record('切到了新会话（sessions.open）', calls.opened.length === 1 && calls.opened[0] === 'sess-new')
record('switched=true', lastNew?.switched === true)
record('引用写进的是**新会话**的草稿', calls.setDraft.length === 1 && calls.setDraft[0]?.sessionId === 'sess-new')
record('草稿内容就是引用', calls.setDraft[0]?.text === '@网页捕获/cap-new-1.md')
record('inserted=true / status=inserted', lastNew?.inserted === true && lastNew?.status === 'inserted')
record('ack=inserted', client.state.acks.at(-1)?.status === 'inserted')

console.log('\n2. sessionMode=current（「看左边」）→ 不新建会话，引用进当前草稿')
await offer('cap-cur-1', 'current')
const lastCur = globalThis.__AG_LAST_ATTACH__
record('没有再多建会话', calls.created.length === 1)
record('没有切换会话', calls.opened.length === 1)
record('引用进的是当前会话 sess-a', calls.setDraft.at(-1)?.sessionId === 'sess-a')
record('switched=false', lastCur?.switched === false)
record('状态 inserted', lastCur?.status === 'inserted')

console.log('\n3. 意图 episode：一次「看左边」只能抓一次（"堆了两个引用"那个缺陷的回归钉子）')
{
  const withKeyword = '看左边, 帮我看看这一页'
  record('第一次看到「看左边」→ 触发', client.sniff(withKeyword) === true)
  record('同一个草稿再嗅一次 → 不再触发', client.sniff(withKeyword) === false)
  // 抓取完成后插件会**改写草稿**（在下面追加 @文件）—— 旧实现把"草稿变了"当成新意图，
  // 于是 785ms 后又抓一次（真实事故：输入框里堆了两个引用，内容还是一模一样的）。
  const afterInsert = `${withKeyword}\n@网页捕获/cap-x.md`
  record('插入 @文件 之后草稿变了 → 仍然不触发', client.sniff(afterInsert) === false)
  record('用户继续打字（同一句）→ 仍不触发', client.sniff(`${withKeyword} 谢谢`) === false)
  record('用户把「看左边」删掉 → 重新武装（本次不触发）', client.sniff('这里没有那个词') === false)
  record('用户又写一次「看左边」→ 再次触发', client.sniff('看左边') === true)
}

console.log('\n4. 向桥上报的页面事实（决定抓取投给哪一个页面）')
{
  const facts = client.facts()
  record('含 embedded / visible / focused 三个布尔', typeof facts.embedded === 'boolean' && typeof facts.visible === 'boolean' && typeof facts.focused === 'boolean')
  record('含当前会话 id', facts.sessionId === 'sess-a')
  globalThis.window.self = { frame: 1 }
  globalThis.window.top = { frame: 2 }
  record('被 iframe 嵌入时 embedded=true（侧边栏那份就是）', client.facts().embedded === true)
  globalThis.window.self = undefined
  globalThis.window.top = undefined
  record('顶层页面 embedded=false', client.facts().embedded === false)
}

console.log('\n5. 回归钉子：每次投递都要有草稿 + ack，且不重复写')
record('两次投递共 2 次 setDraft（各写各的会话）', calls.setDraft.length === 2)
record('两次投递共 2 条 ack，状态都是 inserted', client.state.acks.length === 2 && client.state.acks.every((a) => a.status === 'inserted'))
record('每个胶囊都是 inserted（没有留下的半成品）', [...client.state.chips.values()].every((entry) => entry.status === 'inserted'))
record('上报的 hello 帧带 embedded 字段', sentFrames.some((text) => String(text).includes('"hello"') && String(text).includes('"embedded"')))

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
console.log('\n6. 幂等：同一个 captureId 被重复投递时，只能插入一次（重连/重试不许重复写草稿）')
{
  const before = calls.setDraft.length
  await offer('cap-new-1', 'new')            // 与第 1 节同一个 captureId
  record('重复投递被忽略（没有新的 setDraft）', calls.setDraft.length === before)
  record('第二次返回 false（没插入）', (await client.deliver({ captureId: 'cap-new-1', fileRef: '@x', sessionMode: 'new' })) === false)
  // 胶囊数不是重点（第 4 节 ✕ 掉了一个）：真正要钉的是**第一条胶囊还在、状态没被覆盖**。
  record('胶囊没有被第二次覆盖（仍是第一次那条 inserted）', client.state.chips.get('cap-new-1')?.status === 'inserted')
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
