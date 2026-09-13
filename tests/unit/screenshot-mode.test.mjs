#!/usr/bin/env node
/**
 * 单测：`mode: 'screenshot'` 抓不到图时，**不许**回一个 ok:true（v3.41 修假绿）。
 *
 * 缺陷（我在审「假绿」那一类问题时核出来的）：
 *   `captureVisibleTab` 失败（没有 `<all_urls>` 权限、标签页不在前台）时，`buildCapture`
 *   把 `{ dropped: true, dropReason }` 写进 body 照常投递，`sw/index.js` 只看
 *   `sendCapture` 的结果就返回 `ok: true`。于是：
 *     - 面板显示「已附加：…」，用户以为自己拿到了截图；
 *     - 审计里这一条是 ok:true；
 *     - 用户唯一点的那个产物（图）**根本不存在**，而没有任何地方说过这件事。
 *   注意这不是"零像素图"：body 里的 `base64` 是空串，图片文件压根不会被写出来。
 *
 * 本测试**跑到 SW 入口的 route()**（通过 onMessage 监听器），不是只测那个新加的纯函数 ——
 * 缺陷的成因是"接线漏了判据"，只测判据本身会再次变成假绿。
 *
 * 用法：node tests/unit/screenshot-mode.test.mjs
 */

// ---- chrome 桩：只提供这条路径真正用到的部分 ------------------------------------

/** 内存版 storage.local（审计环缓冲走这里）。 */
const store = new Map()

/** 截图行为由每个用例改写 —— 这是本测试的自变量。 */
let shotBehavior = async () => 'data:image/png;base64,AAAA'

/** 记录 /ag/attach 的请求体，用来证明"正文照常投递"。 */
const attachCalls = []

let messageListener = null

globalThis.chrome = {
  runtime: {
    id: 'testextensionid',
    getManifest: () => ({ version: '0.1.0' }),
    onMessage: { addListener: (fn) => { messageListener = fn } },
    onInstalled: { addListener: () => {} },
    onStartup: { addListener: () => {} },
  },
  contextMenus: { onClicked: { addListener: () => {} } },
  sidePanel: { setPanelBehavior: async () => {}, open: async () => {} },
  storage: {
    local: {
      get: async (key) => (key === undefined ? Object.fromEntries(store) : { [key]: store.get(key) }),
      set: async (patch) => { for (const [k, v] of Object.entries(patch)) store.set(k, v) },
    },
  },
  tabs: {
    query: async () => [{ id: 7, windowId: 1, url: 'https://example.com/article', title: 'fixture', active: true, lastAccessed: 1 }],
    captureVisibleTab: async () => shotBehavior(),
  },
  scripting: {
    executeScript: async () => [{
      result: {
        page: { url: 'https://example.com/article', title: 'fixture', host: 'example.com' },
        content: { markdown: '# 正文照常投递', truncated: false },
        meta: { chars: 8 },
      },
    }],
  },
}

globalThis.fetch = async (url, init) => {
  const body = JSON.parse(String(init?.body ?? '{}'))
  attachCalls.push({ url: String(url), body })
  // 形状照抄真实宿主（dsh-plugin/src/host/routes/attach.js 的 200 响应）：**扁平**对象，
  // 不是 { ok, value } 信封 —— 面板读的 `result.value.result.fileRef` 正是建立在这上面。
  // tests/m2/look-left-probe.mjs 用真实例核过这一点（typeof attachBody.fileRef === 'string'）。
  return {
    ok: true,
    status: 200,
    json: async () => ({ ok: true, captureId: body.captureId, fileRef: '网页捕获/fixture.md', filePath: '/tmp/fixture.md', deliveredTo: ['client:1'] }),
  }
}

// 只导入一次：SW 入口在 import 期注册监听器，模块状态要串起全部用例。
await import('../../extension/src/sw/index.js')

if (messageListener === null) {
  console.log('❌ SW 入口没有注册 onMessage 监听器 —— 测试无法进行')
  process.exit(1)
}

const ask = (message) => new Promise((resolve) => {
  const returned = messageListener(message, { id: 'testextensionid' }, resolve)
  if (returned !== true) resolve({ ok: false, error: { code: 'E_TEST', message: '监听器没有同步返回 true（异步响应会丢）' } })
})

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 200)}`)
}
const auditTail = () => (store.get('ag-audit') ?? []).at(-1) ?? {}

// ---- 1. 缺陷本体：screenshot 模式 + 截图失败 -------------------------------------
console.log('1. mode=screenshot 且 captureVisibleTab 抛权限错：必须报失败，且正文仍已投递')
{
  attachCalls.length = 0
  store.delete('ag-audit')
  shotBehavior = async () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.") }
  const res = await ask({ kind: 'capture', mode: 'screenshot', trigger: 'button' })

  record('返回的是 ok:false（不再是假绿）', res.ok === false)
  record('错误码是 E_NO_PERMISSION', res.error?.code === 'E_NO_PERMISSION')
  /*
   * 英文版改造后这些文案来自文案表（可本地化），所以断言改成"结构与措辞无关"的性质：
   * 说清图没成功、说清正文照常投递、带上真实原因。用文案表里的词断言，
   * 这样改措辞不会误报、但"漏了某一层信息"仍然会红。
   */
  const shotMsg = String(res.error?.message ?? '')
  record('★消息来自文案表（默认语言无汉字 ⇒ 不是写死的中文）', /[\u4e00-\u9fff]/u.test(shotMsg) === false)
  record('消息说清"图没成功"', /screenshot failed/iu.test(shotMsg))
  record('消息说清"正文照常投递"', /page text was still delivered/iu.test(shotMsg))
  record('消息带上真实原因（可诊断，不是套话）', /activeTab/u.test(shotMsg))
  record('**正文确实已经 POST /ag/attach 出去了**（没把好的一半一起丢掉）', attachCalls.length === 1 && attachCalls[0].body?.content?.markdown === '# 正文照常投递')
  record('投递的 body 里截图确实是空的（证明它不是"零像素图"）', attachCalls[0]?.body?.media?.screenshot?.base64 === '')
  const last = auditTail()
  record('审计里这一条是 ok:false（事后查得出来）', last.ok === false)
  record('审计里记了错误码', last.code === 'E_NO_PERMISSION')
  record('审计里 mode 记的是 screenshot', last.mode === 'screenshot')
}

// ---- 2. 截图尺寸超限：同一条路，但错误码要如实是 E_TOO_LARGE ----------------------
console.log('\n2. 截图体积超限（captureScreenshot 自己返回 dropped）：错误码必须是 E_TOO_LARGE')
{
  attachCalls.length = 0
  store.delete('ag-audit')
  // 9MB > MAX_SCREENSHOT_BYTES(8MB)
  shotBehavior = async () => `data:image/png;base64,${'A'.repeat(12 * 1024 * 1024)}`
  const res = await ask({ kind: 'capture', mode: 'screenshot', trigger: 'button' })

  record('返回 ok:false', res.ok === false)
  record('错误码 E_TOO_LARGE（不是笼统的 E_TARGET/E_NO_PERMISSION）', res.error?.code === 'E_TOO_LARGE')
  record('消息里带上限原因（exceeds）', /exceeds/u.test(String(res.error?.message ?? '')))
  record('正文仍然投递了', attachCalls.length === 1)
}

// ---- 3. 修过头检查：page 模式不受影响 -------------------------------------------
console.log('\n3. 修过头检查：mode=page 时同样的截图失败**不许**把正文抓取判成失败')
{
  attachCalls.length = 0
  store.delete('ag-audit')
  shotBehavior = async () => { throw new Error('captureVisibleTab failed') }
  const res = await ask({ kind: 'capture', mode: 'page', trigger: 'button' })

  record('page 模式照旧 ok:true', res.ok === true)
  record('page 模式返回 fileRef', typeof res.value?.result?.fileRef === 'string')
  record('page 模式审计 ok:true', auditTail().ok === true)
}

// ---- 4. 修过头检查：真拿到图时必须放行 ------------------------------------------
console.log('\n4. mode=screenshot 且截图成功：必须 ok:true，且 body 里带真图')
{
  attachCalls.length = 0
  store.delete('ag-audit')
  shotBehavior = async () => `data:image/png;base64,${'A'.repeat(4000)}`
  const res = await ask({ kind: 'capture', mode: 'screenshot', trigger: 'button' })

  record('成功路径 ok:true（没有把正常功能一起封掉）', res.ok === true)
  record('body 里带非空 base64', (attachCalls[0]?.body?.media?.screenshot?.base64 ?? '').length === 4000)
  record('body 里没有 dropped 标记', attachCalls[0]?.body?.media?.screenshot?.dropped !== true)
  record('审计 ok:true', auditTail().ok === true)
}

// ---- 5. 判据是"这个模式要的就是图"，不是"代码里出现过 screenshot" ----------------
console.log('\n5. 判据的范围：selection 模式的截图失败不影响结论（该模式要的是选区文字）')
{
  attachCalls.length = 0
  shotBehavior = async () => { throw new Error('captureVisibleTab failed') }
  const res = await ask({ kind: 'capture', mode: 'selection', trigger: 'button' })
  record('没有选区时仍然是 E_NO_SELECTION（既有闸门先响）', res.ok === false && res.error?.code === 'E_NO_SELECTION')
}

// 只有布尔 true 算通过
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
