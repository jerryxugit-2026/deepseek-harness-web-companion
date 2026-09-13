#!/usr/bin/env node
/**
 * M0a · Permission experiment (design §9 权限模型 / §12.5 假设 A′).
 *
 * Question: can "first-run grant from the panel button + gesture-less capture
 * afterwards" work, or does Chrome's gesture requirement make the flagship
 * 「看左边」 path infeasible?
 *
 * Measured cases (all driven from the extension's own panel page, which is the
 * real caller in the design):
 *   B  permissions.request WITHOUT a user gesture   → the gesture rule, verbatim error
 *   A  permissions.request WITH a user gesture      → is the call even accepted?
 *   A2 real CDP mouse click on the panel button     → does the click handler's grant settle?
 *   C  gesture-less capture (executeScript + captureVisibleTab) with the grant
 *   D  the same capture after revoking the grant    → the failure mode the design avoids
 *
 * Limitations recorded in the report: headless Chrome cannot render the native
 * permission prompt, and `activeTab` cannot be granted programmatically.
 *
 * Usage: node tests/m0a/permission-probe.mjs [--out docs/reviews]
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
// 3997：原来默认 3999，与 tests/m2/capture-probe.mjs 撞车（两个探针若并发就会 EADDRINUSE）
const FIXTURE_PORT = Number(argOf('fixture-port', '3997'))
const CDP_PORT = Number(argOf('cdp-port', '9223'))
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'm0a-permission-profile')
const EXT_COPY = '/tmp/m0a-permission-ext' // loadUnpacked cannot resolve paths containing spaces
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGINS = ['*://*/*']

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
let chromePidForCleanup
const cleanup = () => { if (chromePidForCleanup !== undefined) { try { process.kill(Number(chromePidForCleanup)) } catch { /* gone */ } } }
process.on('exit', cleanup)
process.on('SIGINT', () => { cleanup(); process.exit(130) })
process.on('uncaughtException', (error) => { console.error('[m0a] fatal:', error); cleanup(); process.exit(1) })
mkdirSync(OUT_DIR, { recursive: true })

const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end('<!doctype html><html><head><title>M0a Fixture Page</title></head><body><h1>FIXTURE-MARKER-42</h1><p>capture target</p></body></html>')
})
await new Promise((r) => { server.listen(FIXTURE_PORT, '127.0.0.1', r) })

/** Fail fast when the debug port is already taken (a stale Chrome would be used instead). */
async function portBusy(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${String(port)}/json/version`)
    return r.ok
  } catch { return false }
}
if (await portBusy(CDP_PORT)) {
  throw new Error(`CDP port ${String(CDP_PORT)} is already in use — kill the stale Chrome first (pkill -f m0a-permission-profile)`)
}

rmSync(PROFILE, { recursive: true, force: true })
rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(join(HERE, 'ext'), EXT_COPY, { recursive: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging about:blank >/tmp/m0a-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
chromePidForCleanup = chromePid
console.log(`[m0a] chrome pid=${chromePid} cdp=${CDP_PORT}`)

class Cdp {
  #socket
  #id = 1
  #pending = new Map()
  static async connect(url) {
    const c = new Cdp()
    c.#socket = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#socket.addEventListener('open', res, { once: true })
      c.#socket.addEventListener('error', () => rej(new Error('cdp socket error')), { once: true })
    })
    c.#socket.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.id === undefined) return
      const p = c.#pending.get(m.id)
      c.#pending.delete(m.id)
      if (m.error !== undefined) p?.reject(new Error(`${p.method}: ${m.error.message}`))
      else p?.resolve(m.result)
    })
    return c
  }
  send(method, params = {}, sessionId) {
    const id = this.#id++
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject, method }) })
  }
}

let browserWs
for (let i = 0; i < 60; i += 1) {
  try {
    browserWs = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl
    break
  } catch { await sleep(500) }
}
if (browserWs === undefined) throw new Error('chrome devtools never came up')
const browser = await Cdp.connect(browserWs)

/**
 * Evaluate in a page. `userGesture` mirrors Chrome's "this call happened inside
 * a user gesture" flag, which is what a click handler would provide.
 */
async function evaluate(sessionId, expression, userGesture = false, timeoutMs = 8000) {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture }, sessionId)
  const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
  const result = await Promise.race([call, timeout])
  if (result.timedOut === true) return { timedOut: true, note: `no settlement within ${String(timeoutMs)}ms` }
  if (result.exceptionDetails !== undefined) {
    return { error: String(result.exceptionDetails.text), thrown: result.exceptionDetails.exception?.description ?? null }
  }
  return result.result.value
}

const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
console.log(`[m0a] extension id=${extId}`)

const newTab = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  return { targetId }
}

/** Attach (fresh) to a target and enable the domains we use. */
async function attach(targetId) {
  const attachResult = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  const sessionId = attachResult.sessionId
  if (sessionId === undefined) throw new Error(`attach returned no sessionId: ${JSON.stringify(attachResult)}`)
  await browser.send('Runtime.enable', {}, sessionId)
  await browser.send('Page.enable', {}, sessionId)
  return sessionId
}

/**
 * Run one case against a target, re-attaching once if the session went stale
 * (a background tab can be unloaded, which invalidates its CDP session).
 */
async function runCase(label, targetId, expression, userGesture = false, timeoutMs = 9000) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const sessionId = await attach(targetId)
      const value = await evaluate(sessionId, expression, userGesture, timeoutMs)
      console.log(`[m0a] ${label} => ${JSON.stringify(value).slice(0, 200)}`)
      return value
    } catch (error) {
      console.log(`[m0a] ${label} attempt ${String(attempt + 1)} failed: ${String(error)}`)
      await sleep(700)
    }
  }
  return { error: 'session could not be established' }
}

const requestExpr = (userGestureHint) => `(async () => {
  const state = () => chrome.permissions.contains({ origins: ${JSON.stringify(ORIGINS)} })
  try {
    const granted = await chrome.permissions.request({ origins: ${JSON.stringify(ORIGINS)} })
    return { path: ${JSON.stringify(userGestureHint)}, granted, contains: await state() }
  } catch (error) {
    return { path: ${JSON.stringify(userGestureHint)}, threw: String(error), lastError: chrome.runtime.lastError?.message ?? null, contains: await state() }
  }
})()`

const captureExpr = `(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const out = { tabId: tab?.id ?? null, url: tab?.url ?? null }
  try {
    const injected = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => ({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 40) }),
    })
    out.injected = injected[0]?.result ?? null
  } catch (error) {
    out.injectError = String(error)
    out.injectLastError = chrome.runtime.lastError?.message ?? null
  }
  try {
    const png = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
    out.pngBytes = Math.round((png.length * 3) / 4)
  } catch (error) {
    out.screenshotError = String(error)
    out.screenshotLastError = chrome.runtime.lastError?.message ?? null
  }
  return out
})()`

const panel = await newTab(`chrome-extension://${extId}/panel.html`)
await sleep(700)
const fixture = await newTab(`http://127.0.0.1:${String(FIXTURE_PORT)}/`)
await sleep(500)

const report = { probe: 'm0a-permission', extId, chrome: '150.0.7871.125', headless: true, cases: {}, notes: [] }

// B: gesture-less request (the intent path's situation)
report.cases.B_request_without_gesture = await runCase('B request/no-gesture', panel.targetId, requestExpr('no-gesture'), false)
// A: request with the gesture flag (what a click handler provides)
report.cases.A_request_with_gesture = await runCase('A request/gesture', panel.targetId, requestExpr('userGesture=true'), true, 12000)
// A2: a real trusted click on the panel button
const panelSession = await attach(panel.targetId)
const box = await evaluate(panelSession, `(() => {
  const el = document.getElementById('grant'); const r = el.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`)
await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, panelSession)
await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, panelSession)
await sleep(3000)
report.cases.A2_real_click = {
  clicked: box,
  panelLog: await runCase('A2 panel log', panel.targetId, `document.getElementById('log').textContent`),
}

// C: gesture-less capture with whatever grant state we ended up in
await browser.send('Target.activateTarget', { targetId: fixture.targetId })
await sleep(900)
report.cases.C_capture_state_before = await runCase('C permission state', panel.targetId, `chrome.permissions.contains({ origins: ${JSON.stringify(ORIGINS)} })`)
report.cases.C_capture_without_gesture = await runCase('C capture/no-gesture', panel.targetId, captureExpr, false)

// D: revoke, then repeat (the failure the design must never rely on)
report.cases.D_revoke = await runCase('D revoke', panel.targetId, `chrome.permissions.remove({ origins: ${JSON.stringify(ORIGINS)} }).then(r => ({ removed: r, contains: null }))`, false)
report.cases.D_capture_after_revoke = await runCase('D capture/after-revoke', panel.targetId, captureExpr, false)

report.notes.push('headless Chrome cannot render the native permission prompt; a request that needs the user to answer will hang (`timedOut`) instead of settling.')
report.notes.push('`activeTab` cannot be granted programmatically, so the "toolbar click → activeTab" path is documented behaviour here, not measured.')
report.notes.push('case C result is the design-critical one: it is exactly the gesture-less capture the 「看左边」 intent path performs.')

writeFileSync(join(OUT_DIR, 'probe-permission.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))

server.close()
process.exit(0)
