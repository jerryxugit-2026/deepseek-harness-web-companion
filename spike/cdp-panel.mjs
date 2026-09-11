/**
 * Spike driver, phase 2: place a valid DSH session cookie into Chrome through
 * the extension's own cookies API, then observe whether the real DSH web GUI
 * can load inside a chrome-extension:// page iframe.
 *
 * Auto-attach is on, so the out-of-process DSH iframe's own console, network
 * statuses, and failures are recorded per target.
 *
 * Usage: node cdp-panel.mjs [--out <dir>] [--port 9222]
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
const DSH_ORIGIN = 'http://127.0.0.1:3080'
const BOOT_WAIT_MS = 15000

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

/** Per-target observation, keyed by CDP session id. */
const observed = new Map()
const ensureObserved = (sessionId, url) => {
  const existing = observed.get(sessionId)
  if (existing !== undefined) return existing
  const fresh = { url, http: new Map(), console: [], failures: [], logEntries: [], exceptions: [] }
  observed.set(sessionId, fresh)
  return fresh
}

browser.on((message) => {
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId, targetInfo } = message.params
    const record = ensureObserved(sessionId, targetInfo.url)
    record.url = targetInfo.url
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
  } else if (method === 'Runtime.consoleAPICalled') {
    record.console.push(params.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' '))
  } else if (method === 'Log.entryAdded') {
    record.logEntries.push(`${params.entry.level}: ${params.entry.text}`)
  } else if (method === 'Runtime.exceptionThrown') {
    record.exceptions.push(String(params.exceptionDetails?.text ?? 'exception'))
  }
})

async function evaluate(sessionId, expression) {
  const result = await browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}

async function targets() {
  return (await browser.send('Target.getTargets')).targetInfos
}

/** The unpacked extension id comes from Chrome itself, never from a path hash guess. */
async function findExtensionId() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const found = (await targets()).find((info) => info.url.startsWith('chrome-extension://'))
    if (found !== undefined) return new URL(found.url).host
    await sleep(500)
  }
  throw new Error('no chrome-extension:// target ever appeared')
}

const extId = await findExtensionId()
console.log(`extension id: ${extId}`)

/** The service worker opens the panel page on install; otherwise open it here. */
async function findOrOpenPanel() {
  const wanted = `chrome-extension://${extId}/panel.html`
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = (await targets()).find((info) => info.type === 'page' && info.url === wanted)
    if (found !== undefined) return found.targetId
    await sleep(500)
  }
  const { targetId } = await browser.send('Target.createTarget', { url: wanted, width: 420, height: 900, newWindow: true })
  return targetId
}

const panelTargetId = await findOrOpenPanel()
const { sessionId: panelSession } = await browser.send('Target.attachToTarget', { targetId: panelTargetId, flatten: true })
ensureObserved(panelSession, `chrome-extension://${extId}/panel.html`)
await Promise.all([
  browser.send('Runtime.enable', {}, panelSession),
  browser.send('Network.enable', {}, panelSession),
  browser.send('Log.enable', {}, panelSession),
  browser.send('Page.enable', {}, panelSession),
])

const report = { extId, cookieName: COOKIE_NAME, panel: {}, variants: {} }

report.panel.identity = await evaluate(panelSession, `JSON.stringify({
  href: location.href,
  runtimeId: chrome.runtime?.id ?? null,
  hasFrame: document.getElementById('dsh') !== null,
  frameSrc: document.getElementById('dsh')?.src ?? null,
  bodyText: (document.body?.innerText ?? '').slice(0, 120)
})`)

/** Install (or clear) the DSH cookie through the extension cookies API. */
async function installCookie(sessionId, variant) {
  const sameSite = variant === 'strict' ? 'strict' : variant === 'lax' ? 'lax' : 'no_restriction'
  const secure = variant === 'none-secure' || variant === 'partitioned'
  const partition = variant === 'partitioned' ? `, partitionKey: { topLevelSite: 'chrome-extension://${extId}' }` : ''
  const expression = `(async () => {
    await new Promise((resolve) => chrome.cookies.remove({ url: '${DSH_ORIGIN}/', name: '${COOKIE_NAME}' }, resolve))
    const stored = await new Promise((resolve) => chrome.cookies.set({
      url: '${DSH_ORIGIN}/', name: '${COOKIE_NAME}', value: '${COOKIE_VALUE}', path: '/',
      sameSite: '${sameSite}', secure: ${String(secure)}${partition}
    }, resolve))
    const all = await new Promise((resolve) => chrome.cookies.getAll({ url: '${DSH_ORIGIN}/' }, resolve))
    return JSON.stringify({ stored: stored === null ? 'null' : { name: stored.name, sameSite: stored.sameSite, secure: stored.secure, partitionKey: stored.partitionKey ?? null }, count: all.length, names: all.map((c) => c.name.slice(0, 16)) })
  })()`
  return evaluate(sessionId, expression)
}

async function snapshot(label) {
  const entry = { observed: {}, frames: [] }
  for (const [, record] of observed) {
    if (record.url.startsWith(DSH_ORIGIN) || record.url.startsWith('chrome-extension://')) {
      entry.observed[record.url] = {
        http: Object.fromEntries([...record.http].sort()),
        console: record.console.slice(0, 20),
        failures: [...new Set(record.failures)],
        errors: record.logEntries.filter((line) => line.startsWith('error')).slice(0, 10),
        exceptions: record.exceptions.slice(0, 5),
      }
    }
  }
  for (const info of await targets()) {
    if (info.type === 'iframe') entry.frames.push({ url: info.url, targetId: info.targetId })
  }
  const dshFrame = (await targets()).find((info) => info.type === 'iframe' && info.url.startsWith(DSH_ORIGIN))
  if (dshFrame !== undefined) {
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId: dshFrame.targetId, flatten: true })
    await browser.send('Runtime.enable', {}, sessionId).catch(() => {})
    entry.dshDom = await evaluate(sessionId, `JSON.stringify({
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 300),
      nodes: document.querySelectorAll('*').length,
      hasTextarea: document.querySelector('textarea') !== null,
      hasEditable: document.querySelector('[contenteditable="true"]') !== null,
      bootFailure: (document.body?.innerText ?? '').includes('Failed to load plugins')
    })`)
    await browser.send('Target.detachFromTarget', { sessionId }).catch(() => {})
  }
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, panelSession)
  const path = join(OUT, `${label}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  entry.screenshot = path
  return entry
}

for (const variant of ['strict', 'none-secure', 'partitioned']) {
  observed.clear()
  ensureObserved(panelSession, `chrome-extension://${extId}/panel.html`)
  report.variants[variant] = { cookie: await installCookie(panelSession, variant) }
  await browser.send('Page.reload', { ignoreCache: false }, panelSession)
  await sleep(BOOT_WAIT_MS)
  Object.assign(report.variants[variant], await snapshot(`panel-${variant}`))
}

writeFileSync(join(OUT, 'panel-report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
process.exit(0)
