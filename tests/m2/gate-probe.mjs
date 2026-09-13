#!/usr/bin/env node
/**
 * M2 · permission-gate probe.
 *
 * Verifies the onboarding gate (design §9 option ③) actually appears when the
 * extension lacks host permission for the page the user is looking at:
 * on a non-permitted origin, clicking 「Attach 网页」 must show the inline gate
 * instead of a raw Chrome error.
 *
 * The grant itself cannot be exercised headlessly (Chrome cannot render the
 * native prompt, measured in tests/m0a/permission-probe.mjs) — that branch is
 * covered by the manual checklist.
 *
 * Usage: node tests/m2/gate-probe.mjs [--url https://example.com]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createResults } from '../lib/probe-result.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const TARGET_URL = argOf('url', 'https://example.com')
// 9235：原来默认 9233，与 tests/m2/look-left-e2e-probe.mjs 撞车
const CDP_PORT = Number(argOf('cdp-port', '9235'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const EXT_COPY = join(process.env.TMPDIR ?? '/tmp', 'dshwc-gate-ext')
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'dshwc-gate-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy`)
rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(join(ROOT, 'extension', 'dist'), EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=520,900 about:blank >/tmp/m2-gate-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } }
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[gate-probe] fatal:', error); cleanup(); process.exit(1) })

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
const browser = await Cdp.connect(browserWs)
const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
console.log(`[gate-probe] extension id=${extId}`)

const open = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}
const evaluate = async (sessionId, expression, timeoutMs = 8000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}
const click = async (sessionId, selector) => {
  const box = await evaluate(sessionId, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (el === null) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`)
  if (box === null || box.error !== undefined) return false
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId)
  return true
}

const { record, observe, results, observations, finish } = createResults({ label: 'm2/gate-probe' })

// a page the extension has NO host permission for
const site = await open(TARGET_URL)
await sleep(1500)
record('targetUrl', await evaluate(site.sessionId, 'location.href'))
// the panel document, with the site tab left active
const panel = await open(`chrome-extension://${extId}/src/sidepanel/panel.html`)
await sleep(1200)
await browser.send('Target.activateTarget', { targetId: site.targetId })
await sleep(500)

record('permissionBefore', await evaluate(panel.sessionId, `chrome.permissions.contains({ origins: ['*://*/*'] })`))
record('attachClicked', await click(panel.sessionId, '#attach-page'))
await sleep(1200)
record('gateState', await evaluate(panel.sessionId, `JSON.stringify({
  visible: document.getElementById('gate').hidden === false,
  text: document.getElementById('gate-text').textContent.slice(0, 120),
  allowLabel: document.getElementById('gate-allow').textContent,
})`))

const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, panel.sessionId)
const shot = join(OUT_DIR, 'probe-gate.png')
writeFileSync(shot, Buffer.from(data, 'base64'))
record('screenshot', shot)

writeFileSync(join(OUT_DIR, 'probe-gate.json'), `${JSON.stringify({ probe: 'm2-gate', target: TARGET_URL, results, observations }, null, 2)}\n`)
console.log('\n写入 docs/reviews/probe-gate.json')
cleanup()
finish()
