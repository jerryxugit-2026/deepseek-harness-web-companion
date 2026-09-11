#!/usr/bin/env node
/**
 * M0a · Q8 keepalive probe (design D10).
 *
 * Question: which holder keeps an idle WebSocket alive across Chrome's idle
 * policies — the MV3 service worker (expected: recycled after ~30s idle, socket
 * dies with it) or an extension document such as the side panel (expected:
 * unaffected)?
 *
 * Method: load a probe extension whose service worker opens `/ag/wsecho`, open
 * its page (control) which opens a second socket, then poll both for `idleMs`
 * and report every observed state change with timestamps.
 *
 * Usage: node tests/m0a/keepalive-probe.mjs [--seconds 90]
 */
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
const SECONDS = Number(argOf('seconds', '90'))
const CDP_PORT = Number(argOf('cdp-port', '9229'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'm0a-keepalive-profile')
const EXT_COPY = join(process.env.TMPDIR ?? '/tmp', 'm0a-keepalive-ext')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy`)
rmSync(PROFILE, { recursive: true, force: true })
rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(join(HERE, 'keepalive-ext'), EXT_COPY, { recursive: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging about:blank >/tmp/m0a-keepalive-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } }
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[keepalive] fatal:', error); cleanup(); process.exit(1) })

class Cdp {
  #socket
  #id = 1
  #pending = new Map()
  #listeners = new Set()
  static async connect(url) {
    const c = new Cdp()
    c.#socket = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#socket.addEventListener('open', res, { once: true })
      c.#socket.addEventListener('error', () => rej(new Error('cdp socket error')), { once: true })
    })
    c.#socket.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.id !== undefined) {
        const p = c.#pending.get(m.id)
        c.#pending.delete(m.id)
        if (m.error !== undefined) p?.reject(new Error(`${p.method}: ${m.error.message}`))
        else p?.resolve(m.result)
        return
      }
      for (const listener of c.#listeners) listener(m)
    })
    return c
  }
  on(listener) { this.#listeners.add(listener) }
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

// collect console output per target
const consoleByTarget = new Map()
browser.on((message) => {
  if (message.method === 'Target.attachedToTarget') {
    const { sessionId } = message.params
    void browser.send('Runtime.enable', {}, sessionId).catch(() => {})
    void browser.send('Log.enable', {}, sessionId).catch(() => {})
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.sessionId !== undefined) {
    const line = message.params.args.map((a) => String(a.value ?? a.description ?? '')).join(' ')
    const list = consoleByTarget.get(message.sessionId) ?? []
    list.push(line)
    consoleByTarget.set(message.sessionId, list)
  }
})

await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
console.log(`[keepalive] extension id=${extId}; observing ${String(SECONDS)}s of idle`)

const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/page.html`, newWindow: true })
const { sessionId: pageSession } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
await browser.send('Runtime.enable', {}, pageSession)

const swPing = async () => {
  const { targetInfos } = await browser.send('Target.getTargets')
  const sw = targetInfos.find((t) => t.url === `chrome-extension://${extId}/sw.js`)
  if (sw === undefined) return { swAlive: false }
  try {
    const sessionId = (await browser.send('Target.attachToTarget', { targetId: sw.targetId, flatten: true })).sessionId
    const result = await browser.send('Runtime.evaluate', {
      expression: `(async () => {
        try {
          const reply = await chrome.runtime.sendMessage({ case: 'status' })
          return JSON.stringify(reply ?? null)
        } catch (error) { return JSON.stringify({ error: String(error) }) }
      })()`,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId)
    await browser.send('Target.detachFromTarget', { sessionId })
    return { swAlive: true, reply: result.result?.value ?? null }
  } catch (error) {
    return { swAlive: true, error: String(error).slice(0, 120) }
  }
}

const samples = []
const started = Date.now()
while (Date.now() - started < SECONDS * 1000) {
  const pageSocketState = await browser.send('Runtime.evaluate', {
    expression: `document.getElementById('log').textContent.split('\\n').slice(-3).join(' | ')`,
    returnByValue: true,
  }, pageSession).then((r) => r.result?.value ?? null).catch(() => null)
  const sw = await swPing()
  samples.push({ atSeconds: Math.round((Date.now() - started) / 1000), sw, pageLog: pageSocketState })
  await sleep(10000)
}

const collectConsole = () => Object.fromEntries([...consoleByTarget].map(([id, lines]) => [id.slice(0, 8), lines.slice(-12)]))
const report = {
  probe: 'm0a-keepalive',
  chrome: '150.0.7871.125',
  observedSeconds: SECONDS,
  extensionId: extId,
  samples,
  console: collectConsole(),
  interpretation: {
    swSocket: 'see [keepalive-sw] lines: ws-open / ws-close timestamps',
    pageSocket: 'see [keepalive-page] lines and the page log samples',
  },
}
writeFileSync(join(OUT_DIR, 'probe-keepalive.json'), `${JSON.stringify(report, null, 2)}\n`)

const swLines = Object.values(report.console).flat().filter((l) => l.includes('keepalive-sw'))
const pageLines = Object.values(report.console).flat().filter((l) => l.includes('keepalive-page'))
console.log(JSON.stringify({
  swConsole: swLines,
  pageConsole: pageLines,
  swFirstLastSample: [samples[0]?.sw, samples.at(-1)?.sw],
  pageFirstLastSample: [samples[0]?.pageLog, samples.at(-1)?.pageLog],
}, null, 2))
cleanup()
process.exit(0)
