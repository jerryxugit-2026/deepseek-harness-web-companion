#!/usr/bin/env node
/**
 * M0b · capture/attach probe (design docs/03 §3.2, E2E-0 closure).
 *
 * Proves the context channel end to end **without needing the browser UI**:
 *   1. a WS client connects to `/ag/client` (form F4: key + same-origin Origin);
 *   2. a capture is POSTed to `/ag/attach` (form F2: key + extension Origin);
 *   3. the file lands on disk in the target workspace with correct front-matter;
 *   4. the connected client receives the `attach` event (push, not polling);
 *   5. a capture posted while NO client is connected is queued and later
 *      drained by `GET /ag/pending`;
 *   6. the path is authenticated: no key → 403; oversize body → 413; a payload
 *      the schema rejects → 400.
 *
 * Usage: node tests/m0b/attach-probe.mjs [--port 3099] [--out docs/reviews]
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createResults } from '../lib/probe-result.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = argOf('port', '3099')
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const HOME = resolve(ROOT, '.devhome')
const WORKSPACE = join(HOME, 'workspace-m0a')
const ORIGIN = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const pairing = JSON.parse(readFileSync(join(HOME, 'dsh-web-companion.json'), 'utf8'))
const KEY = pairing.key
const EXT_ORIGIN = pairing.extensionOrigins[0]

const { record, observe, results, observations, finish } = createResults({ label: 'm0b/attach-probe' })

const post = async (path, body, headers = {}) => {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text.slice(0, 200) }
  return { status: response.status, body: parsed, headers: Object.fromEntries(response.headers) }
}

const capturePayload = (suffix, overrides = {}) => ({
  protocolVersion: 1,
  captureId: `M0B-PROBE-${suffix}`,
  trigger: 'button',
  page: {
    title: `M0B Probe Page ${suffix}`,
    url: 'https://example.com/m0b',
    domain: 'example.com',
    capturedAt: Date.now(),
  },
  content: {
    markdown: `# M0B 探针 ${suffix}\n\n只读探针写入的正文，用于验证落盘与推送。`,
    truncated: false,
    selection: { text: '被选中的重点段落', selectorHint: 'main > p:nth-child(2)' },
  },
  media: {
    screenshot: { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==', width: 1280, height: 800, bytes: 24 },
  },
  target: { workspace: WORKSPACE },
  ...overrides,
})

console.log('1. 连接 /ag/client（形态 F4：key + 同源 Origin）')
const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ag/client?key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } })
const received = []
socket.on('message', (data) => {
  const text = String(data)
  if (text.includes('"ping"')) { socket.send(JSON.stringify({ type: 'pong' })); return }
  try { received.push(JSON.parse(text)) } catch { received.push({ raw: text.slice(0, 120) }) }
})
const opened = await new Promise((resolve) => {
  socket.on('open', () => resolve(true))
  socket.on('error', (error) => resolve(`error:${String(error.message)}`))
  setTimeout(() => resolve('timeout'), 5000)
})
record('wsOpen', opened)

console.log('2. POST /ag/attach（形态 F2：key + 扩展 Origin）')
const first = await post(`/ag/attach?key=${encodeURIComponent(KEY)}`, capturePayload('A'), { origin: EXT_ORIGIN })
record('attachStatus', first.status)
record('attachBody', first.body)
const filePath = first.body?.filePath
record('fileExists', typeof filePath === 'string' && existsSync(filePath))
if (typeof filePath === 'string' && existsSync(filePath)) {
  const content = readFileSync(filePath, 'utf8')
  record('frontMatter', {
    hasCaptureId: content.includes('captureId: M0B-PROBE-A'),
    hasUrl: content.includes('url: "https://example.com/m0b"'),
    hasTrigger: content.includes('trigger: button'),
    hasSelectionBlock: content.includes('> **用户选区**'),
    hasBody: content.includes('只读探针写入的正文'),
    lines: content.split('\n').length,
    snapshotSha256: createHash('sha256').update(content).digest('hex').slice(0, 16),
  })
}

console.log('3. 已连接的 client 应收到推送（不等客户端拉取）')
for (let i = 0; i < 20 && received.length === 0; i += 1) await sleep(150)
record('pushedEvents', received.length)
record('pushedEventSummary', received[0] === undefined ? null : {
  type: received[0].type,
  captureId: received[0].captureId,
  fileRef: received[0].fileRef,
  mode: received[0].mode,
  hasImage: received[0].image !== undefined,
  summary: received[0].summary,
})

console.log('4. ack 回执')
const ack = await post(`/ag/ack?key=${encodeURIComponent(KEY)}`, { captureId: 'M0B-PROBE-A', status: 'inserted' }, { origin: EXT_ORIGIN })
record('ackStatus', ack.status)

console.log('5. 离线队列：断开 client 后投递，再由 /ag/pending 取回')
socket.close()
await sleep(400)
const offline = await post(`/ag/attach?key=${encodeURIComponent(KEY)}`, capturePayload('B'), { origin: EXT_ORIGIN })
record('offlineAttachStatus', offline.status)
record('offlineDeliveredTo', offline.body?.deliveredTo)
const pendingPeek = await fetch(`${ORIGIN}/ag/pending?peek=1&key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } }).then((r) => r.json())
record('pendingPeekCount', Array.isArray(pendingPeek.items) ? pendingPeek.items.length : pendingPeek)
const pendingDrain = await fetch(`${ORIGIN}/ag/pending?key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } }).then((r) => r.json())
record('pendingDrainCount', Array.isArray(pendingDrain.items) ? pendingDrain.items.length : pendingDrain)
const pendingAgain = await fetch(`${ORIGIN}/ag/pending?peek=1&key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } }).then((r) => r.json())
record('pendingAfterDrain', Array.isArray(pendingAgain.items) ? pendingAgain.items.length : pendingAgain)

console.log('6. 鉴权与输入校验')
record('noKey', (await post('/ag/attach', capturePayload('C'))).status)
record('wrongKey', (await post('/ag/attach?key=nope', capturePayload('C'), { origin: EXT_ORIGIN })).status)
record('extensionOriginWithoutKey', (await post('/ag/attach', capturePayload('C'), { origin: EXT_ORIGIN })).status)
record('schemaRejected', (await post(`/ag/attach?key=${encodeURIComponent(KEY)}`, { protocolVersion: 1, captureId: 'x', trigger: 'telepathy', page: {}, content: {} }, { origin: EXT_ORIGIN })).status)
const oversize = await post(`/ag/attach?key=${encodeURIComponent(KEY)}`, `${JSON.stringify(capturePayload('D')).slice(0, -1)},"pad":"${'x'.repeat(9 * 1024 * 1024)}"}`, { origin: EXT_ORIGIN })
record('oversize', oversize.status)
// 413 是**故意不读完**请求体的：socket 上还有没读的数据，Node 必须销毁它。
// 回 `keep-alive` 就是撒谎 —— 客户端会把这条死连接放回池子，下一个请求直接 ECONNRESET
// （实测：413 之后紧接着 GET /ag/pending 必崩）。所以这里钉住"如实说 close"。
record('★ oversize 的 413 如实声明 connection: close（否则下一个请求踩死 socket）', oversize.headers?.connection === 'close')

console.log('7. 积压补投：没有页面连着时抓的图，页面一连上就必须收到（`request-pending`）')
{
  // 缺陷（v3.41 修）：client 半在**每次**连上时都会发 `{type:'request-pending'}`（设计 §4.2），
  // 而宿主**没有这个帧的 handler**。于是"没开 DSH 页面时抓的东西"落盘、入队、然后**永远躺在队列里**：
  // `GET /ag/pending` 存在但没有任何调用方 —— 队列是**只写**的，用户看到的现象就是"抓了但什么都没发生"。
  // 注意这里刻意**不用** `GET /ag/pending` 去取：探针要验的是**页面自己那条路**（它是产品路径）。
  const offlineId = 'M0B-PROBE-PENDING'
  const before = await fetch(`${ORIGIN}/ag/pending?peek=1&key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } }).then((r) => r.json())
  const offline = await post(`/ag/attach?key=${encodeURIComponent(KEY)}`, capturePayload('PENDING', { captureId: offlineId }), { origin: EXT_ORIGIN })
  record('离线抓取的 attach 是 200', offline.status === 200)
  record('deliveredTo 是空数组（没人收，如实入队）', Array.isArray(offline.body?.deliveredTo) && offline.body.deliveredTo.length === 0)
  const queuedPeek = await fetch(`${ORIGIN}/ag/pending?peek=1&key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } }).then((r) => r.json())
  record('入队了（peek 里能找到它）', Array.isArray(queuedPeek.items) && queuedPeek.items.some((item) => item.captureId === offlineId))

  // 页面半连上 —— 这就是真实浏览器里打开 DSH 页面时发生的事
  const late = new WebSocket(`ws://127.0.0.1:${PORT}/ag/client?key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } })
  const lateFrames = []
  late.on('message', (data) => {
    const text = String(data)
    if (text.includes('"ping"')) { late.send(JSON.stringify({ type: 'pong' })); return }
    try { lateFrames.push(JSON.parse(text)) } catch { /* ignore */ }
  })
  const lateOpen = await new Promise((resolve) => {
    late.on('open', () => resolve(true))
    late.on('error', (error) => resolve(`error:${String(error.message)}`))
    setTimeout(() => resolve('timeout'), 5000)
  })
  record('晚到的页面半连上了', lateOpen === true)
  late.send(JSON.stringify({ type: 'hello', protocolVersion: 1, extVersion: 'probe', embedded: false, sessionId: 'sess-late' }))
  await sleep(120)
  late.send(JSON.stringify({ type: 'request-pending' }))

  const pendingFrame = async () => {
    for (let i = 0; i < 30; i += 1) {
      const hit = lateFrames.find((frame) => frame.type === 'attach' && frame.captureId === offlineId)
      if (hit !== undefined) return hit
      await sleep(150)
    }
    return undefined
  }
  const replayed = await pendingFrame()
  record('★ 页面上线后主动要，积压的抓取被推过来了（不再永远躺在队列里）', replayed !== undefined)
  record('推的是那条抓取（captureId 对得上）', replayed?.captureId === offlineId)
  record('带上可直接引用的 fileRef', typeof replayed?.fileRef === 'string' && replayed.fileRef.startsWith('@'))

  // 再要一次：不能重复推（重复插同一条 `@文件` 是 v3.39 修过的旧病）
  late.send(JSON.stringify({ type: 'request-pending' }))
  await sleep(500)
  const duplicates = lateFrames.filter((frame) => frame.type === 'attach' && frame.captureId === offlineId).length
  record('再要一次不会重复推同一条（计数仍是 1）', duplicates === 1)

  const emptied = await fetch(`${ORIGIN}/ag/pending?peek=1&key=${encodeURIComponent(KEY)}`, { headers: { origin: ORIGIN } }).then((r) => r.json())
  record('队列里已经没有它了（补投是"取走"而不是"复制"）', Array.isArray(emptied.items) && emptied.items.some((item) => item.captureId === offlineId) === false)
  observe('pendingBefore', Array.isArray(before.items) ? before.items.length : before)
  observe('pendingAfterReplay', Array.isArray(emptied.items) ? emptied.items.map((item) => item.captureId) : emptied)
  late.close()
  await sleep(300)
}

const report = {
  probe: 'm0b-attach',
  dshPort: PORT,
  workspace: WORKSPACE,
  results,
}
writeFileSync(join(OUT_DIR, 'probe-attach.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`\n结果写入 docs/reviews/probe-attach.json`)
// 判定交给 createResults#finish —— 这里原来留着一条 `v === false || v === 'error:'` 的旧判定，
// 它和 finish() 的判断标准不同（非布尔的记录它一个都不算失败），属于两套判定并存。
finish('probe-attach.json')
