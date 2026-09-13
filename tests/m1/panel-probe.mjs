#!/usr/bin/env node
/**
 * M1 · E2E-1 panel probe (design docs/06 §8.2).
 *
 * Loads the BUILT extension (`extension/dist`) into a throwaway Chrome, opens
 * the side panel document, and verifies the whole authentication chain against a
 * live DSH instance:
 *
 *   panel → service worker → POST /ag/ticket → iframe src = /ag/enter?ticket=…
 *        → 303 + Set-Cookie(SameSite=None; Secure) → DSH GUI boots inside the frame
 *
 * Assertions: the frame URL carries a ticket (never the long-lived key), the
 * embedded DSH document is the real GUI (title + composer), nothing says
 * "authentication required", and the panel's status indicator reads `up`.
 *
 * Read-only: it only loads pages, it never posts a capture.
 *
 * Usage: node tests/m1/panel-probe.mjs [--port 3099] [--out docs/reviews]
 *
 * 默认端口是**开发实例**（3099），不是你真在用的那个。这一条以前默认 3080 —— 也就是拿探针
 * 去戳用户真实实例；探针是只读的（不 post 抓取），但"默认指向用户的实例"本身就不该是默认值：
 * 真要验真实实例，请显式写 `--port 3080`。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
// 默认指向开发实例；要验真实实例必须显式 --port 3080（见文件头说明）。
const DSH_PORT = argOf('port', '3099')
const CDP_PORT = Number(argOf('cdp-port', '9231'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const EXT_DIST = join(ROOT, 'extension', 'dist')
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const PAIRING = resolve(ROOT, argOf('key-file', '.devhome/dsh-web-companion.json'))
const EXT_COPY = join(process.env.TMPDIR ?? '/tmp', 'dshwc-ext-dist')
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'dshwc-panel-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${DSH_PORT}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy — kill the stale Chrome first`)

/*
 * ── 先把写开关打开：这样才能验出「面板是**读**到状态的，还是永远显示 off」 ────────
 * 背景（2026-09-12 实测）：v3.40 把面板的「读开关状态」从 POST 改成 GET，而 Chrome 对**扩展文档
 * 发的简单 GET 不带 Origin** ⇒ 换来的是一次 403，面板 `enabled` 永远是 false（开关看着总是关的）。
 * 打开真状态再开面板，才能把"读成功"和"读不到、退回默认 false"区分开。
 */
const pairingRaw = JSON.parse(readFileSync(PAIRING, 'utf8'))
const KEY = pairingRaw.key
const EXT_ORIGIN = pairingRaw.extensionOrigins[0]
const postControl = async (allow) => {
  const response = await fetch(`${ORIGIN}/ag/control?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: EXT_ORIGIN },
    body: JSON.stringify({ allowBrowserWriteOps: allow }),
  })
  return { status: response.status, body: await response.json().catch(() => null) }
}
const preControl = await postControl(true).catch((error) => ({ status: 0, body: String(error) }))
console.log(`  前置：把写开关置为 on → HTTP ${String(preControl.status)}（${JSON.stringify(preControl.body?.allowBrowserWriteOps ?? preControl.body).slice(0, 60)}）`)

/*
 * ── 让面板也指向**这一个**实例 ────────────────────────────────────────────────
 * 2026-09-12 实测的坑：面板 iframe 的地址来自 `extension/src/lib/dev-config.js`（烤进 dist），
 * 而 `--port` 只影响探针自己的网络过滤 ⇒ 不重写 dev-config 的话，探针会"用 3099 的过滤器看 3080 的
 * 请求"（实测 `dshHttp: {}` + 一条 403，看着像探针坏了）。所以这里和 capture/look-left-e2e 一样：
 * 重写 dev-config → 重建 dist → 拷贝给 Chrome；结束时**还原并重建 dist**（dist 正是用户 Chrome
 * 加载的目录，只还原源文件会留下测试端口的产物）。
 */
const DEV_BACKUP = readFileSync(DEV_CONFIG, 'utf8')
const pairingKey = JSON.parse(readFileSync(PAIRING, 'utf8')).key
writeFileSync(DEV_CONFIG, `/**
 * Generated for local runs (probes rewrite this file and restore it).
 */
export const DEV_CONFIG = { port: ${String(DSH_PORT)}, key: ${JSON.stringify(pairingKey)} }

export default DEV_CONFIG
`)
try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
const restoreDevConfig = () => {
  try {
    writeFileSync(DEV_CONFIG, DEV_BACKUP)
    execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' })
  } catch { /* best effort：真失败由 npm run check:dist 兜底 */ }
}

// the extension must be loaded from a path without spaces (loadUnpacked limit)
rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=420,900 about:blank >/tmp/m1-panel-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } restoreDevConfig() }
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[panel-probe] fatal:', error); cleanup(); process.exit(1) })

class Cdp {
  #socket
  #id = 1
  #pending = new Map()
  #events = []
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
      c.#events.push(m)
    })
    return c
  }
  get events() { return this.#events }
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

const loaded = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
const extId = loaded.id
console.log(`[panel-probe] extension id=${extId}`)

await browser.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true })
const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel/panel.html`, width: 420, height: 900, newWindow: true })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
await browser.send('Runtime.enable', {}, sessionId)
await browser.send('Network.enable', {}, sessionId)
await browser.send('Log.enable', {}, sessionId)
await browser.send('Page.enable', {}, sessionId)

const evaluate = async (expression, timeoutMs = 10000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
  const result = await Promise.race([call, timeout])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${name}: ${(JSON.stringify(value) ?? String(value)).slice(0, 240)}`)
}

console.log('1. 面板文档与 SW 握手')
let panel = null
for (let i = 0; i < 30; i += 1) {
  const raw = await evaluate(`JSON.stringify({
    status: document.getElementById('status-dot')?.dataset.state ?? null,
    statusText: document.getElementById('status-text')?.textContent ?? null,
    frameSrc: document.getElementById('dsh')?.src ?? null,
    frameHidden: document.getElementById('dsh')?.hidden ?? null,
    notice: document.getElementById('notice-text')?.textContent ?? null,
  })`, 8000)
  panel = typeof raw === 'string' ? JSON.parse(raw) : null
  if (panel?.frameSrc !== null && panel?.frameSrc !== undefined && panel.frameSrc !== '') break
  await sleep(1000)
}
record('panelStatus', panel?.status ?? null)
record('panelStatusText', panel?.statusText ?? null)
record('frameSrc', panel?.frameSrc ?? null)
record('frameSrcUsesTicket', String(panel?.frameSrc ?? '').includes('ticket='))
record('frameSrcLeaksKey', /[?&]key=/u.test(String(panel?.frameSrc ?? '')))
record('notice', panel?.notice ?? null)

console.log('2. iframe 内的 DSH 文档（OOPIF）')
let frame = null
for (let i = 0; i < 30; i += 1) {
  const { targetInfos } = await browser.send('Target.getTargets')
  const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(ORIGIN))
  if (iframe !== undefined) {
    const frameSession = (await browser.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId
    await browser.send('Runtime.enable', {}, frameSession)
    const raw = await browser.send('Runtime.evaluate', {
      expression: `JSON.stringify({
        href: location.href,
        title: document.title,
        nodes: document.querySelectorAll('*').length,
        composer: document.querySelector('[contenteditable]') !== null,
        unauthorized: (document.body?.innerText ?? '').includes('authentication required'),
        bodyText: (document.body?.innerText ?? '').replace(/\\s+/g, ' ').slice(0, 160),
      })`,
      returnByValue: true,
    }, frameSession)
    frame = JSON.parse(raw.result.value)
    await browser.send('Target.detachFromTarget', { sessionId: frameSession }).catch(() => {})
    break
  }
  await sleep(1000)
}
record('iframe', frame)

console.log('4. ★面板**读到**的写开关状态必须等于插件的真实状态')
const liveControl = await fetch(`${ORIGIN}/ag/control?key=${encodeURIComponent(KEY)}`, { headers: { origin: EXT_ORIGIN } }).then((r) => r.json()).catch(() => null)
let toggle = null
for (let i = 0; i < 20; i += 1) {
  const raw = await evaluate(`JSON.stringify({
    checked: document.getElementById('wo-toggle')?.checked ?? null,
    rowVisible: document.getElementById('write-ops')?.hidden === false,
    statusText: document.getElementById('status-text')?.textContent ?? null,
  })`, 8000)
  toggle = typeof raw === 'string' ? JSON.parse(raw) : null
  if (toggle?.rowVisible === true) break
  await sleep(500)
}
record('插件真实状态确为「写操作开」（否则这节测不出东西）', liveControl?.allowBrowserWriteOps === true)
record('开关行可见（说明那次读没有异常退出）', toggle?.rowVisible === true)
record('★面板显示的勾选态 == 插件真实状态（403 那种"读不到就退回 off"会在这里露馅）', toggle?.checked === (liveControl?.allowBrowserWriteOps === true))
// 注意：**不**断言状态文案。面板的状态行在用户拨动开关前属于**连接状态**（「DSH 已连接」），
// 只有拨动之后才写「写操作已开启/已关闭」——这是既有行为，不该为了测试去改产品文案。
record('状态文案仍归连接状态管（没有互相覆盖）', /DSH/u.test(String(toggle?.statusText ?? '')))
const postBack = await postControl(false)
record('收尾：把写开关关回去（不留副作用）', postBack.status === 200 && postBack.body?.allowBrowserWriteOps === false)

console.log('3. 网络与错误面')
const dshRequests = new Map()
const errors = []
for (const event of browser.events) {
  if (event.method === 'Network.responseReceived' && typeof event.params?.response?.url === 'string' && event.params.response.url.startsWith(ORIGIN)) {
    const key = `${String(event.params.response.status)} ${new URL(event.params.response.url).pathname}`
    dshRequests.set(key, (dshRequests.get(key) ?? 0) + 1)
  }
  if (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error') errors.push(String(event.params.entry.text).slice(0, 160))
}
record('dshHttp', Object.fromEntries([...dshRequests].sort()))
record('consoleErrors', [...new Set(errors)].slice(0, 6))

const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId)
const shot = join(OUT_DIR, 'probe-panel.png')
writeFileSync(shot, Buffer.from(data, 'base64'))
record('screenshot', shot)

const report = { probe: 'm1-panel', dshPort: DSH_PORT, extensionId: extId, results }
writeFileSync(join(OUT_DIR, 'probe-panel.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log('\n写入 docs/reviews/probe-panel.json')
cleanup()
process.exit(0)
