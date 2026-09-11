/**
 * Spike driver: drive a headless Chrome over CDP to answer one question —
 * can the real DSH web GUI authenticate and render inside an iframe of a
 * chrome-extension:// page (the side-panel shape)?
 *
 * For each cookie variant it installs a valid DSH session cookie, opens the
 * extension panel page, records every HTTP status the DSH origin returns,
 * inspects the DSH frame's DOM, and saves a screenshot.
 *
 * Usage: node cdp-spike.mjs --ext-id <id> [--out <dir>] [--port 9222]
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
const EXT_ID = argOf('ext-id', '')
const OUT = argOf('out', join(HERE, 'out'))
const DSH_ORIGIN = 'http://127.0.0.1:3080'
const DSH_AUTHORITY = '127.0.0.1:3080'
const BOOT_WAIT_MS = 15000

if (EXT_ID === '') throw new Error('--ext-id is required')
mkdirSync(OUT, { recursive: true })

const cookie = execFileSync(process.execPath, [join(HERE, 'mint-cookie.mjs'), DSH_AUTHORITY], { encoding: 'utf8' }).trim()
const cookieAt = cookie.indexOf('=')
const COOKIE_NAME = cookie.slice(0, cookieAt)
const COOKIE_VALUE = cookie.slice(cookieAt + 1)

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

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

  close() { this.#socket.close() }
}

const browser = await Cdp.connect((await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl)

async function attach(targetId) {
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  return sessionId
}

/** Open one blank page target, enable the domains we observe, and bind a recorder. */
async function openPage({ width = 420, height = 900 } = {}) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', width, height, newWindow: true })
  const sessionId = await attach(targetId)
  const record = { http: new Map(), console: [], failures: [], logEntries: [], exceptions: [] }
  browser.on((message) => {
    if (message.sessionId !== sessionId) return
    const { method, params } = message
    if (method === 'Network.responseReceived' && typeof params?.response?.url === 'string' && params.response.url.startsWith(DSH_ORIGIN)) {
      const key = `${String(params.response.status)} ${new URL(params.response.url).pathname}`
      record.http.set(key, (record.http.get(key) ?? 0) + 1)
    } else if (method === 'Network.loadingFailed') {
      record.failures.push(String(params?.errorText))
    } else if (method === 'Runtime.consoleAPICalled') {
      record.console.push(params.args.map((a) => String(a.value ?? a.description ?? a.type)).join(' '))
    } else if (method === 'Log.entryAdded') {
      record.logEntries.push(`${params.entry.level}: ${params.entry.text}`)
    } else if (method === 'Runtime.exceptionThrown') {
      record.exceptions.push(String(params.exceptionDetails?.text ?? 'exception'))
    }
  })
  await browser.send('Network.enable', {}, sessionId)
  await browser.send('Page.enable', {}, sessionId)
  await browser.send('Runtime.enable', {}, sessionId)
  await browser.send('Log.enable', {}, sessionId)
  return { targetId, sessionId, record }
}

/** Inspect the DSH document itself: it is a cross-origin (out-of-process) frame target. */
async function inspectDshFrame() {
  const { targetInfos } = await browser.send('Target.getTargets')
  const frame = targetInfos.find((info) => info.type === 'iframe' && info.url.startsWith(DSH_ORIGIN))
  if (frame === undefined) return { found: false, targets: targetInfos.map((i) => `${i.type} ${i.url}`) }
  const sessionId = await attach(frame.targetId)
  await browser.send('Runtime.enable', {}, sessionId)
  const probe = await browser.send('Runtime.evaluate', {
    expression: `JSON.stringify({
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 400),
      nodes: document.querySelectorAll('*').length,
      hasTextarea: document.querySelector('textarea') !== null,
      hasEditable: document.querySelector('[contenteditable="true"]') !== null,
      scriptCount: document.scripts.length,
      bootFailure: (document.body?.innerText ?? '').includes('Failed to load plugins')
    })`,
    returnByValue: true,
  }, sessionId)
  await browser.send('Target.detachFromTarget', { sessionId })
  return { found: true, ...JSON.parse(probe.result.value) }
}

async function screenshot(sessionId, name) {
  const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  const path = join(OUT, `${name}.png`)
  writeFileSync(path, Buffer.from(data, 'base64'))
  return path
}

function cookieParams(variant) {
  const base = { name: COOKIE_NAME, value: COOKIE_VALUE, url: `${DSH_ORIGIN}/`, path: '/', httpOnly: true }
  if (variant === 'strict') return { ...base, sameSite: 'Strict' }
  if (variant === 'none') return base
  if (variant === 'none-secure') return { ...base, sameSite: 'None', secure: true }
  if (variant === 'partitioned') {
    return { ...base, sameSite: 'None', secure: true, partitionKey: { topLevelSite: `chrome-extension://${EXT_ID}` } }
  }
  throw new Error(`unknown variant ${variant}`)
}

/** Install one cookie variant on an open page session, then navigate it. */
async function installAndNavigate(sessionId, variant, url) {
  const params = cookieParams(variant)
  await browser.send('Network.deleteCookies', { name: COOKIE_NAME, url: params.url }, sessionId).catch(() => {})
  const stored = await browser.send('Network.setCookie', params, sessionId)
  await browser.send('Page.navigate', { url }, sessionId)
  return stored
}

function summarize(record) {
  return {
    http: Object.fromEntries([...record.http].sort()),
    console: record.console,
    failures: [...new Set(record.failures)],
    httpLog: record.logEntries.filter((line) => line.startsWith('error') || line.includes('401') || line.includes('403')),
    exceptions: record.exceptions,
  }
}

const report = { extId: EXT_ID, cookieName: COOKIE_NAME, variants: {} }

const runs = [
  { key: 'baseline-tab-strict', variant: 'strict', url: `${DSH_ORIGIN}/`, size: { width: 1280, height: 900 } },
  { key: 'panel-strict', variant: 'strict', url: `chrome-extension://${EXT_ID}/panel.html`, size: { width: 420, height: 900 } },
  { key: 'panel-none', variant: 'none', url: `chrome-extension://${EXT_ID}/panel.html`, size: { width: 420, height: 900 } },
  { key: 'panel-none-secure', variant: 'none-secure', url: `chrome-extension://${EXT_ID}/panel.html`, size: { width: 420, height: 900 } },
  { key: 'panel-partitioned', variant: 'partitioned', url: `chrome-extension://${EXT_ID}/panel.html`, size: { width: 420, height: 900 } },
]

for (const run of runs) {
  try {
    const page = await openPage(run.size)
    const stored = await installAndNavigate(page.sessionId, run.variant, run.url)
    await sleep(BOOT_WAIT_MS)
    report.variants[run.key] = {
      cookieStored: stored?.success ?? stored,
      ...summarize(page.record),
      dshFrame: await inspectDshFrame(),
      screenshot: await screenshot(page.sessionId, run.key),
    }
    await browser.send('Target.closeTarget', { targetId: page.targetId })
  } catch (error) {
    report.variants[run.key] = { error: String(error) }
  }
  await sleep(1000)
}

writeFileSync(join(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
browser.close()
