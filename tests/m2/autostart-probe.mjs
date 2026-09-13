#!/usr/bin/env node
/**
 * M2 · auto-start probe (design G4 / H4①).
 *
 * Proves the whole chain Chrome-side: the extension's service worker asks the
 * native host to start `dsh web` on a port where nothing is listening, and the
 * panel ends up connected to the freshly started server.
 *
 * It temporarily points the built extension at a FREE port (default 3096), so it
 * never disturbs a running instance.
 *
 * Usage: node tests/m2/autostart-probe.mjs [--port 3096]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createResults } from '../lib/probe-result.mjs'

// 断言/观测分离、只有布尔 true 算通过（规则单一真源见该 helper）。
const { record, observe, results, observations, finish } = createResults({ label: 'm2-autostart' })

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = argOf('port', '3096')
const CDP_PORT = Number(argOf('cdp-port', '9234'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const DIST = join(ROOT, 'extension', 'dist')
const EXT_COPY = join(process.env.TMPDIR ?? '/tmp', 'dshwc-autostart-ext')
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'dshwc-autostart-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const original = readFileSync(DEV_CONFIG, 'utf8')
const key = /key:\s*'([^']+)'/u.exec(original)?.[1] ?? ''
const listening = async (port) => {
  try { const r = await fetch(`http://127.0.0.1:${port}/ag/ping`); return r.ok } catch { return false }
}
if (await listening(PORT)) throw new Error(`port ${PORT} already serves DSH — pick another with --port`)

/** Point the build at the free port, then restore in `finally`. */
writeFileSync(DEV_CONFIG, `export const DEV_CONFIG = { port: ${PORT}, key: '${key}' }\n`)
execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' })

const cleanupAll = () => {
  try { writeFileSync(DEV_CONFIG, original) } catch { /* ignore */ }
  try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
  try { execFileSync('/usr/bin/env', ['bash', '-c', `lsof -ti :${PORT} | xargs kill 2>/dev/null || true`]) } catch { /* ignore */ }
}

let chromePid
try {
  rmSync(EXT_COPY, { recursive: true, force: true })
  cpSync(DIST, EXT_COPY, { recursive: true })
  rmSync(PROFILE, { recursive: true, force: true })
  chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
    `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=520,900 about:blank >/tmp/m2-autostart-chrome.log 2>&1 & echo $!`,
  ], { encoding: 'utf8' }).trim()

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
    try { browserWs = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(500) }
  }
  const browser = await Cdp.connect(browserWs)
  const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
  console.log(`[autostart] extension id=${extId}; target port ${PORT} (nothing listening)`)

  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel/panel.html`, width: 520, height: 900, newWindow: true })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)

  const evaluate = async (expression, timeoutMs = 10000) => {
    const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
    const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
    if (result.timedOut === true) return { timedOut: true }
    if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
    return result.result.value
  }

  const results = {}

  record('dshListeningBefore', await listening(PORT))
  // call the native host directly first: proves Chrome→host wiring and the manifest
  const nativeReply = await evaluate(`(async () => {
    try {
      const port = chrome.runtime.connectNative('com.dsh.web_companion')
      const reply = await new Promise((resolve) => {
        const timer = setTimeout(() => resolve({ timeout: true }), 8000)
        port.onMessage.addListener((m) => { clearTimeout(timer); resolve(m) })
        port.onDisconnect.addListener(() => resolve({ disconnected: chrome.runtime.lastError?.message ?? 'no reason' }))
        port.postMessage({ id: 'probe-1', cmd: 'get-info' })
      })
      try { port.disconnect() } catch {}
      return JSON.stringify(reply)
    } catch (error) { return JSON.stringify({ threw: String(error), lastError: chrome.runtime.lastError?.message ?? null }) }
  })()`, 15000)
  observe('nativeHostReply', typeof nativeReply === 'string' ? JSON.parse(nativeReply) : nativeReply)

  // now let the panel drive the whole path
  let status = null
  for (let i = 0; i < 45; i += 1) {
    const raw = await evaluate(`JSON.stringify({ state: document.getElementById('status-dot')?.dataset.state ?? null, text: document.getElementById('status-text')?.textContent ?? null })`, 8000)
    status = typeof raw === 'string' ? JSON.parse(raw) : null
    if (status?.state === 'up') break
    await sleep(1000)
  }
  record('panelStatus', status)
  record('dshListeningAfter', await listening(PORT))
  const ping = await fetch(`http://127.0.0.1:${PORT}/ag/ping`).then((r) => r.json()).catch(() => null)
  record('pingAfter', ping === null ? null : { plugin: ping.plugin, paired: ping.paired, port: ping.dsh?.port })

  writeFileSync(join(OUT_DIR, 'probe-autostart.json'), `${JSON.stringify({ probe: 'm2-autostart', port: PORT, results, observations }, null, 2)}\n`)
  console.log('\n写入 docs/reviews/probe-autostart.json')
} finally {
  try { process.kill(Number(chromePid)) } catch { /* gone */ }
  cleanupAll()
  console.log('已恢复 dev-config 并清理临时 DSH')
}
finish()
