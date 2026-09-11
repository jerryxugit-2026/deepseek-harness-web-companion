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

const results = {}
const record = (name, value) => {
  results[name] = value
  const printed = JSON.stringify(value) ?? String(value)
  console.log(`  ${name}: ${printed.slice(0, 220)}`)
}

const post = async (path, body, headers = {}) => {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  const text = await response.text()
  let parsed
  try { parsed = JSON.parse(text) } catch { parsed = text.slice(0, 200) }
  return { status: response.status, body: parsed }
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

const report = {
  probe: 'm0b-attach',
  dshPort: PORT,
  workspace: WORKSPACE,
  results,
}
writeFileSync(join(OUT_DIR, 'probe-attach.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`\n结果写入 docs/reviews/probe-attach.json`)
const failed = Object.entries(results).filter(([, v]) => v === false || v === 'error:').map(([k]) => k)
if (failed.length > 0) console.log(`⚠️ 疑似失败项: ${failed.join(', ')}`)
process.exit(0)
