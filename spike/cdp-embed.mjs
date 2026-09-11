/**
 * Spike driver, phase 4: with the DSH GUI confirmed to render inside a
 * chrome-extension:// iframe, determine which cookie form lets the embedded app
 * also open its authenticated event stream (ws://127.0.0.1:3080/api/remote.mux).
 *
 * Variants: strict / no_restriction+secure / partitioned(no_restriction+secure).
 * Per variant: observed HTTP statuses, WebSocket handshake outcomes, console
 * errors, embedded DOM state, and a screenshot.
 *
 * Usage: node cdp-embed.mjs --ext <dir> --out <dir> [--port 9222]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = Number(argOf('port', '9222'))
const OUT = argOf('out', join(HERE, 'out'))
const EXT_DIR = argOf('ext', '/tmp/dsh-spike-ext')
const DSH_ORIGIN = 'http://127.0.0.1:3080'
const WAIT_MS = 10000

mkdirSync(OUT, { recursive: true })
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

const cookie = execFileSync(process.execPath, [join(HERE, 'mint-cookie.mjs'), '127.0.0.1:3080'], { encoding: 'utf8' }).trim()
const cookieAt = cookie.indexOf('=')
const COOKIE_NAME = cookie.slice(0, cookieAt)
const COOKIE_VALUE = cookie.slice(cookieAt + 1)

class Cdp {
  #socket
  #nextId = 1
  #pending = new Map()
  #listeners = new Set()

  static async connect(url) {
    const client = new Cdp()
    client.#socket = new WebSocket(url)
    await new Promise((resolve, reject) => {
      client.#socket.addEventListener('open', resolve, { once: true })
      client.#socket.addEventListener('error', () => { reject(new Error('cdp socket error')) }, { once: true })
    })
    client.#socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id !== undefined) {
        const pending = client.#pending.get(message.id)
        client.#pending.delete(message.id)
        if (message.error !== undefined) pending?.reject(new Error(`${pending.method}: ${message.error.message}`))
        else pending?.resolve(message.result)
        return
      }
      for (const listener of client.#listeners) listener(message)
    })
    return client
  }

  on(listener) { this.#listeners.add(listener) }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++
    const payload = { id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method })
      this.#socket.send(JSON.stringify(payload))
    })
  }
}

const browser = await Cdp.connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl)

const observed = new Map()
const recordFor = (sessionId, url) => {
  const existing = observed.get(sessionId)
  if (existing !== undefined) { if (url !== '') existing.url = url; return existing }
  const fresh = { url, http: new Map(), console: [], failures: [], errors: [], exceptions: [], sockets: [] }
  observed.set(sessionId, fresh)
  return fresh
}

browser.on((message) => {
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params
    recordFor(sessionId, targetInfo.url)
    void Promise.all([
      browser.send('Runtime.enable', {}, sessionId).catch(() => {}),
      browser.send('Network.enable', {}, sessionId).catch(() => {}),
      browser.send('Log.enable', {}, sessionId).catch(() => {}),
      browser.send('Page.enable', {}, sessionId).catch(() => {}),
    ])
    return
  }
  const record = message.sessionId === undefined ? undefined : observed.get(message.sessionId)
  if (record === undefined) return
  const { method, params } = message
  if (method === 'Network.responseReceived' && typeof params?.response?.url === 'string' && params.response.url.startsWith(DSH_ORIGIN)) {
    const key = `${String(params.response.status)} ${new URL(params.response.url).pathname}`
    record.http.set(key, (record.http.get(key) ?? 0) + 1)
  } else if (method === 'Network.loadingFailed') {
    record.failures.push(`${String(params?.errorText)} blocked=${String(params?.blockedReason ?? '')}`)
  } else if (method === 'Network.webSocketCreated') {
    record.sockets.push({ event: 'created', url: String(params.url) })
  } else if (method === 'Network.webSocketHandshakeResponseReceived') {
    record.sockets.push({ event: 'handshake', status: params.response?.status })
  } else if (method === 'Network.webSocketFrameReceived') {
    if (record.sockets.length < 12) record.sockets.push({ event: 'frame-in', len: String(params.response?.payloadData ?? '').length })
  } else if (method === 'Network.webSocketClosed') {
    record.sockets.push({ event: 'closed' })
  } else if (method === 'Runtime.consoleAPICalled') {
    record.console.push(params.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' '))
  } else if (method === 'Log.entryAdded') {
    if (params.entry.level === 'error') record.errors.push(`${String(params.entry.text).slice(0, 160)}`)
  } else if (method === 'Runtime.exceptionThrown') {
    record.exceptions.push(String(params.exceptionDetails?.text ?? 'exception').slice(0, 160))
  }
})

async function evaluate(sessionId, expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}

const targets = async () => (await browser.send('Target.getTargets')).targetInfos

async function attachFrame() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const frame = (await targets()).find((info) => info.type === 'iframe' && info.url.startsWith(DSH_ORIGIN))
    if (frame !== undefined) {
      const sessionId = (await browser.send('Target.attachToTarget', { targetId: frame.targetId, flatten: true })).sessionId
      recordFor(sessionId, frame.url)
      await Promise.all([
        browser.send('Runtime.enable', {}, sessionId).catch(() => {}),
        browser.send('Network.enable', {}, sessionId).catch(() => {}),
        browser.send('Log.enable', {}, sessionId).catch(() => {}),
      ])
      return { targetId: frame.targetId, sessionId }
    }
    await sleep(400)
  }
  return undefined
}

const report = { cookieName: COOKIE_NAME, variants: {} }

const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR })
const extId = loaded.id
report.extId = extId
await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })

const panelUrl = `chrome-extension://${extId}/panel.html`
let panelTarget
for (let attempt = 0; attempt < 20; attempt += 1) {
  panelTarget = (await targets()).find((info) => info.type === 'page' && info.url === panelUrl)
  if (panelTarget !== undefined) break
  await sleep(500)
}
if (panelTarget === undefined) {
  const created = await browser.send('Target.createTarget', { url: panelUrl, width: 420, height: 900, newWindow: true })
  panelTarget = { targetId: created.targetId }
}
const { sessionId: panel } = await browser.send('Target.attachToTarget', { targetId: panelTarget.targetId, flatten: true })
recordFor(panel, panelUrl)
await Promise.all([
  browser.send('Runtime.enable', {}, panel),
  browser.send('Network.enable', {}, panel),
  browser.send('Log.enable', {}, panel),
  browser.send('Page.enable', {}, panel),
])
await browser.send('Emulation.setDeviceMetricsOverride', { width: 420, height: 900, deviceScaleFactor: 1, mobile: false }, panel)

report.panelIdentity = await evaluate(panel, `JSON.stringify({ href: location.href, readyState: document.readyState, runtimeId: chrome.runtime?.id ?? null })`)

report.directFetchFromExtension = await evaluate(panel, `(async () => {
  const res = await fetch('${DSH_ORIGIN}/api/session/list', {
    method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include',
    body: JSON.stringify({ type: 'client-request', rpcId: 'probe', method: 'session/list', payload: { args: {} } }),
  })
  return JSON.stringify({ status: res.status, body: (await res.text()).slice(0, 80) })
})()`)

const variantSpecs = [
  { key: 'strict', sameSite: 'strict', secure: false, partition: false },
  { key: 'none-secure', sameSite: 'no_restriction', secure: true, partition: false },
  { key: 'partitioned-none-secure', sameSite: 'no_restriction', secure: true, partition: true },
]

for (const spec of variantSpecs) {
  const partitionArg = spec.partition ? `, partitionKey: { topLevelSite: 'chrome-extension://${extId}' }` : ''
  report.variants[spec.key] = {}
  report.variants[spec.key].install = await evaluate(panel, `(async () => {
    const url = '${DSH_ORIGIN}/'
    await new Promise((resolve) => chrome.cookies.remove({ url, name: '${COOKIE_NAME}' }, resolve))
    await new Promise((resolve) => chrome.cookies.remove({ url, name: '${COOKIE_NAME}', partitionKey: { topLevelSite: 'chrome-extension://${extId}' } }, () => resolve()))
    const stored = await new Promise((resolve) => chrome.cookies.set({
      url, name: '${COOKIE_NAME}', value: '${COOKIE_VALUE}', path: '/',
      sameSite: '${spec.sameSite}', secure: ${String(spec.secure)}${partitionArg},
    }, resolve))
    const all = await new Promise((resolve) => chrome.cookies.getAll({ url, name: '${COOKIE_NAME}' }, resolve))
    return JSON.stringify({ stored: stored === null ? null : { sameSite: stored.sameSite, secure: stored.secure, partitionKey: stored.partitionKey ?? null }, visible: all.length })
  })()`)

  observed.clear()
  recordFor(panel, panelUrl)
  await browser.send('Page.reload', { ignoreCache: false }, panel)
  await sleep(WAIT_MS)

  const frame = await attachFrame()
  const entry = report.variants[spec.key]
  entry.httpFromPanel = Object.fromEntries([...recordFor(panel, panelUrl).http].sort())
  if (frame === undefined) {
    entry.frame = 'missing'
  } else {
    await sleep(3000)
    const record = recordFor(frame.sessionId, '')
    entry.frame = {
      http: Object.fromEntries([...record.http].sort()),
      sockets: record.sockets,
      console: record.console.slice(0, 10),
      errors: [...new Set(record.errors)].slice(0, 6),
      dom: await evaluate(frame.sessionId, `JSON.stringify({
        title: document.title,
        nodes: document.querySelectorAll('*').length,
        hasComposer: document.querySelector('textarea, [contenteditable="true"]') !== null,
        unauthorized: (document.body?.innerText ?? '').includes('authentication required'),
        text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 200),
      })`),
    }
    await browser.send('Target.detachFromTarget', { sessionId: frame.sessionId }).catch(() => {})
  }
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, panel)
  const path = join(OUT, `panel-${spec.key}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  entry.screenshot = path
}

writeFileSync(join(OUT, 'embed-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
process.exit(0)
