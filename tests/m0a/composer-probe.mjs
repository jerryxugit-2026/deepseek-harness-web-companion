#!/usr/bin/env node
/**
 * M0a · composer / client-plugin probe (design §6.3, Q3 + Q4).
 *
 * Opens the real DSH web GUI in headless Chrome, lets the bridge plugin's
 * CLIENT half boot through the DSH module loader, then reads `window.__AG_PROBE__`
 * — the verbatim evidence for:
 *   Q3  which services a third-party client plugin can reach, whether the
 *       composer contract and the image-admission API exist at runtime, and
 *       whether `exports["./client"]` + `__ModuleLoader__.load` really work;
 *   Q4  the shape/arity of `setDraft` and friends.
 *
 * Usage: node tests/m0a/composer-probe.mjs [--port 3099] [--url <tokenized url>]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const DSH_PORT = argOf('port', '3099')
const CDP_PORT = Number(argOf('cdp-port', '9226'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'm0a-composer-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

/** The tokenized startup URL carries a fresh process token; read it from the dev boot log. */
function tokenUrl() {
  const explicit = argOf('url', '')
  if (explicit !== '') return explicit
  const log = readFileSync(resolve(ROOT, '.devhome/boot.log'), 'utf8')
  const match = /http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/u.exec(log)
  if (match === null) throw new Error('no tokenized URL in .devhome/boot.log — is the dev DSH running?')
  return match[0]
}

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy — kill the stale Chrome first`)

rmSync(PROFILE, { recursive: true, force: true })
const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --window-size=1280,900 about:blank >/tmp/m0a-composer-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } }
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[m0a-composer] fatal:', error); cleanup(); process.exit(1) })

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
for (let i = 0; i < 40; i += 1) {
  try { browserWs = (await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(500) }
}
if (browserWs === undefined) throw new Error('chrome devtools never came up')
const browser = await Cdp.connect(browserWs)

const url = tokenUrl()
console.log(`[m0a-composer] opening ${url.replace(/token=.*/u, 'token=<redacted>')}`)
const { targetId } = await browser.send('Target.createTarget', { url, width: 1280, height: 900, newWindow: true })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
await browser.send('Runtime.enable', {}, sessionId)
await browser.send('Page.enable', {}, sessionId)
await browser.send('Log.enable', {}, sessionId)

const consoleLines = []
const errors = []
browser.send('Runtime.enable', {}, sessionId).catch(() => {})
const origSend = browser.send.bind(browser)
// collect console/log events through a listener registered on the socket
const listenerSocket = browserWs
void listenerSocket

async function evaluate(expression, timeoutMs = 10000) {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
  const result = await Promise.race([call, timeout])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}
void origSend

/**
 * Wait for the probe: first the synchronous findings, then the asynchronous
 * draft-write/image-admission steps (they need a session, so they settle late).
 */
let probe
for (let i = 0; i < 45; i += 1) {
  const value = await evaluate(`JSON.stringify({
    probe: globalThis.__AG_PROBE__ ?? null,
    async: globalThis.__AG_PROBE_ASYNC__ ?? null,
    rows: Array.isArray(globalThis.__DSH_BOOT__) ? globalThis.__DSH_BOOT__.length : null,
    composer: document.querySelector('[contenteditable], textarea') !== null,
    title: document.title,
  })`, 8000)
  if (typeof value === 'string') {
    const parsed = JSON.parse(value)
    const asyncSteps = (parsed.async ?? []).map((s) => s.step)
    const done = asyncSteps.includes('draft-write') || asyncSteps.includes('image-admission') || asyncSteps.includes('draft-write-attempt')
    if (parsed.probe !== null && parsed.probe.length > 0 && done) { probe = parsed; break }
    if (parsed.probe !== null && parsed.probe.length > 0) probe = parsed
  }
  await sleep(1000)
}

/**
 * M0b assertion #1/#2: drive the REAL UI (pick the workspace so the native
 * composer mounts), then ask the client plugin to write into the draft and read
 * the marker back out of the DOM.
 */
async function clickByText(text) {
  const box = await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const all = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], div, span')]
    const el = all.find((node) => (node.textContent ?? '').trim() === wanted && node.offsetParent !== null)
    if (el === undefined) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, tag: el.tagName }
  })()`, 6000)
  if (box === null || box.error !== undefined) return { clicked: false, text, box }
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId)
  return { clicked: true, text, tag: box.tag }
}

const uiDriven = { steps: [] }
const composerState = async () => JSON.parse(await evaluate(`JSON.stringify({
  anyEditable: document.querySelector('[contenteditable]') !== null,
  activeEditable: document.querySelector('[contenteditable="true"]') !== null,
  attrs: (() => { const el = document.querySelector('[contenteditable]'); return el === null ? null : { ce: el.getAttribute('contenteditable'), role: el.getAttribute('role') } })(),
})`, 6000))

uiDriven.steps.push(await clickByText('选择工作区'))
await sleep(1200)
uiDriven.steps.push(await clickByText('m0a-workspace'))
await sleep(2000)
uiDriven.steps.push(await clickByText('新会话'))
await sleep(1500)
// list what the sidebar offers so a session row can be clicked deterministically
uiDriven.sidebar = JSON.parse(await evaluate(`JSON.stringify(
  [...document.querySelectorAll('aside *, nav *, [class*="sidebar"] *')]
    .filter((el) => el.children.length === 0 && (el.textContent ?? '').trim().length > 0 && (el.textContent ?? '').trim().length < 40)
    .slice(0, 30)
    .map((el) => ({ tag: el.tagName, role: el.getAttribute('role'), text: (el.textContent ?? '').trim().slice(0, 30), cls: String(el.className).slice(0, 40), visible: el.offsetParent !== null }))
)`, 8000))
// click the session ROW (a span inside the clickable row), not the toolbar button
const rowBox = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('span[class*="_title"]')]
  const row = rows.find((el) => (el.textContent ?? '').trim() === '新会话' && el.offsetParent !== null)
  if (row === undefined) return null
  const target = row.closest('[role="button"], li, a, div[tabindex]') ?? row
  const r = target.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, cls: String(target.className).slice(0, 60) }
})()`, 8000)
if (rowBox !== null && rowBox.error === undefined) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowBox.x, y: rowBox.y, button: 'left', clickCount: 1 }, sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowBox.x, y: rowBox.y, button: 'left', clickCount: 1 }, sessionId)
  uiDriven.steps.push({ clicked: true, text: 'session-row', target: rowBox.cls })
  await sleep(2500)
}
// the shell needs a moment to create + open the session and mount the live editor
for (let i = 0; i < 12; i += 1) {
  uiDriven.composer = await composerState()
  if (uiDriven.composer.activeEditable === true) break
  await sleep(1000)
}

// now run the plugin's write probe
const runResult = await evaluate(`(async () => {
  if (typeof globalThis.__AG_PROBE_RUN__ !== 'function') return { error: 'no probe entry' }
  await globalThis.__AG_PROBE_RUN__()
  return { ok: true }
})()`, 30000)
uiDriven.run = runResult
uiDriven.domAfterWrite = await evaluate(`JSON.stringify({
  present: document.querySelector('[contenteditable="true"], textarea') !== null,
  text: (document.querySelector('[contenteditable], textarea')?.innerText ?? document.querySelector('textarea')?.value ?? '').slice(0, 200),
  composerTag: document.querySelector('[contenteditable], textarea')?.tagName ?? null,
  composerAttrs: (() => { const el = document.querySelector('[contenteditable], textarea'); if (el === null) return null; return { contenteditable: el.getAttribute('contenteditable'), role: el.getAttribute('role'), classes: String(el.className).slice(0, 160) } })(),
  probeAsync: (globalThis.__AG_PROBE_ASYNC__ ?? []).map(s => ({ step: s.step, value: s.value })),
})`, 15000)
const domAfterWrite = typeof uiDriven.domAfterWrite === 'string' ? JSON.parse(uiDriven.domAfterWrite) : uiDriven.domAfterWrite

const errorTexts = await evaluate(`(async () => {
  const text = document.body?.innerText ?? ''
  return JSON.stringify({ hasAuthenticationText: text.includes('authentication required'), bodyHead: text.slice(0, 160) })
})()`)

const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId)
const shotPath = join(OUT_DIR, 'probe-composer.png')
writeFileSync(shotPath, Buffer.from(data, 'base64'))

const report = {
  probe: 'm0a-composer',
  dshUrl: url.replace(/token=.*/u, 'token=<redacted>'),
  chrome: '150.0.7871.125',
  shell: probe ?? { probe: null, note: 'client plugin never published __AG_PROBE__' },
  page: typeof errorTexts === 'string' ? JSON.parse(errorTexts) : errorTexts,
  screenshot: shotPath,
  uiDriven,
  domAfterWrite,
  consoleLines,
  errors,
}
writeFileSync(join(OUT_DIR, 'probe-composer.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify(report, null, 2))
cleanup()
process.exit(0)
