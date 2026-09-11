#!/usr/bin/env node
/**
 * M0a · cookie matrix harness (design Q1 + Q2).
 *
 * Launches headless Chrome with the cookie-probe extension, runs the matrix
 * (3 cookie variants × 4 request forms), and optionally repeats it with
 * third-party cookies blocked (`--block3p`) to answer Q2.
 *
 * Usage: node tests/m0a/cookie-matrix.mjs [--port 3099] [--block3p] [--out docs/reviews]
 */
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const DSH_PORT = argOf('port', '3099')
const CDP_PORT = Number(argOf('cdp-port', '9227'))
const BLOCK_3P = process.argv.includes('--block3p')
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const PROFILE = join(process.env.TMPDIR ?? '/tmp', BLOCK_3P ? 'm0a-cookie-profile-3p' : 'm0a-cookie-profile')
const EXT_COPY = join(process.env.TMPDIR ?? '/tmp', 'm0a-cookie-ext')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const pairing = JSON.parse(readFileSync(resolve(ROOT, '.devhome/dsh-web-companion.json'), 'utf8'))
const PINNED_EXT_ID = pairing.extensionOrigins[0].replace('chrome-extension://', '')

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy — kill the stale Chrome first`)

rmSync(PROFILE, { recursive: true, force: true })
rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(join(HERE, 'cookie-ext'), EXT_COPY, { recursive: true })

// Q2: force third-party cookie blocking through the profile preference.
if (BLOCK_3P) {
  mkdirSync(join(PROFILE, 'Default'), { recursive: true })
  writeFileSync(join(PROFILE, 'Default', 'Preferences'), JSON.stringify({ profile: { block_third_party_cookies: true } }))
}

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging about:blank >/tmp/m0a-cookie-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } }
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[cookie-matrix] fatal:', error); cleanup(); process.exit(1) })

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

const { id: loadedId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
console.log(`[cookie-matrix] extension loaded id=${loadedId} (pinned=${PINNED_EXT_ID}) block3p=${String(BLOCK_3P)}`)

const url = `chrome-extension://${loadedId}/probe.html?port=${DSH_PORT}&key=${encodeURIComponent(pairing.key)}`
const { targetId } = await browser.send('Target.createTarget', { url, newWindow: true })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
await browser.send('Runtime.enable', {}, sessionId)
await browser.send('Log.enable', {}, sessionId)

const evaluate = async (expression, timeoutMs = 12000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
  const result = await Promise.race([call, timeout])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}

let matrix
for (let i = 0; i < 60; i += 1) {
  const value = await evaluate('JSON.stringify(globalThis.__COOKIE_MATRIX__ ?? null)', 8000)
  if (typeof value === 'string' && value !== 'null') { matrix = JSON.parse(value); break }
  await sleep(1000)
}

const pageLog = await evaluate(`document.getElementById('log').textContent.slice(0, 4000)`, 8000)
const consoleErrors = await evaluate(`JSON.stringify((globalThis.__COOKIE_MATRIX__ ? 'ok' : 'pending'))`, 8000)
void consoleErrors

/**
 * Control: is the third-party-cookie blocking pref actually enforced?
 * A page on `http://localhost` (a DIFFERENT site from 127.0.0.1) embeds the
 * DSH probe page; if blocking works, the frame must NOT see the cookie even for
 * `SameSite=None; Secure`.
 */
const CONTROL_PORT = 4010
const controlServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html><body><iframe id="f" src="http://127.0.0.1:${DSH_PORT}/ag/probe-page?t=${String(Date.now())}" style="width:300px;height:120px"></iframe>
<script>
window.addEventListener('message', (event) => {
  if (event.data?.source !== 'ag-probe-page') return
  globalThis.__CONTROL_RESULT__ = event.data.result
  document.title = 'control done'
})
</script></body></html>`)
})
await new Promise((r) => { controlServer.listen(CONTROL_PORT, 'localhost', r) })

async function controlFor(variant) {
  const installExpr = `(async () => {
    const bytes = new TextEncoder().encode('127.0.0.1:${DSH_PORT}')
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+','-').replaceAll('/','_').replace(/=+$/u,'')
    const name = 'dsh-auth-' + b64
    const origin = 'http://127.0.0.1:${DSH_PORT}/'
    await new Promise((r) => chrome.cookies.remove({ url: origin, name }, r))
    await new Promise((r) => chrome.cookies.remove({ url: origin, name, partitionKey: { topLevelSite: 'chrome-extension://' + chrome.runtime.id } }, r))
    const details = { url: origin, name, value: 'PROBE-VALUE', path: '/', httpOnly: true }
    ${variant === 'strict' ? "details.sameSite = 'strict'" : "details.sameSite = 'no_restriction'; details.secure = true"}
    const stored = await new Promise((r) => chrome.cookies.set(details, r))
    return JSON.stringify(stored === null ? null : { sameSite: stored.sameSite, secure: stored.secure })
  })()`
  const installed = await evaluate(installExpr, 12000)
  const control = await browser.send('Target.createTarget', { url: `http://localhost:${String(CONTROL_PORT)}/`, newWindow: true })
  const controlSession = (await browser.send('Target.attachToTarget', { targetId: control.targetId, flatten: true })).sessionId
  await browser.send('Runtime.enable', {}, controlSession)
  const read = async (expression, timeoutMs = 12000) => {
    const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, controlSession)
    const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
    const result = await Promise.race([call, timeout])
    if (result.timedOut === true) return { timedOut: true }
    if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
    return result.result.value
  }
  let value = null
  for (let i = 0; i < 12; i += 1) {
    const raw = await read('JSON.stringify(globalThis.__CONTROL_RESULT__ ?? null)', 8000)
    if (typeof raw === 'string' && raw !== 'null') { value = JSON.parse(raw); break }
    await sleep(800)
  }
  await browser.send('Target.closeTarget', { targetId: control.targetId })
  return { variant, installed, crossSiteFrame: value === null ? { noResult: true } : { form: value.fetch?.form, sessionCookiePresent: value.fetch?.sessionCookiePresent, wsCookiePresent: value.ws?.sessionCookiePresent } }
}

const control = []
for (const variant of ['none-secure', 'strict']) control.push(await controlFor(variant))
controlServer.close()

const report = {
  probe: 'cookie-matrix',
  controlCrossSite: control,
  chrome: '150.0.7871.125',
  blockThirdPartyCookies: BLOCK_3P,
  dshPort: DSH_PORT,
  extensionId: loadedId,
  pinnedExtensionId: PINNED_EXT_ID,
  matrix: matrix ?? null,
  pageLog,
}
const outPath = join(OUT_DIR, BLOCK_3P ? 'probe-cookie-matrix-3p.json' : 'probe-cookie-matrix.json')
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(JSON.stringify({ summary: matrix === null ? 'NO MATRIX' : matrix.results.map((r) => ({
  variant: r.variant,
  extFetch: r.extensionFetch?.sessionCookiePresent,
  frameFetch: r.frameFetch?.sessionCookiePresent,
  extWs: r.extensionWs?.sessionCookiePresent,
  frameWs: r.frameWs?.sessionCookiePresent,
})), pageLog: String(pageLog).slice(0, 800) }, null, 2))
cleanup()
process.exit(0)
