#!/usr/bin/env node
/**
 * M0b · E2E-0 closure probe (design docs/06 §8.2).
 *
 * The full context loop, driven automatically:
 *   extension-independent capture → POST /ag/attach → file on disk →
 *   push over WS /ag/client → client half inserts `@fileRef` into the composer
 *   draft → removable chip appears → ✕ removes chip + reference → ack delivered.
 *
 * Runs headless Chrome against a DSH instance whose plugin is loaded, mints its
 * own session cookie (so no token URL is needed), and drives the real UI just
 * enough to select a session (the composer only becomes live with one selected).
 *
 * Usage: node tests/m0b/chip-probe.mjs [--port 3099] [--key-file <path>] [--workspace <dir>]
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createResults } from '../lib/probe-result.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = argOf('port', '3099')
const HOME = resolve(ROOT, argOf('key-file', '.devhome/dsh-web-companion.json').replace(/\/[^/]+$/u, ''))
const PAIRING = resolve(ROOT, argOf('key-file', '.devhome/dsh-web-companion.json'))
const WORKSPACE = resolve(ROOT, argOf('workspace', '.devhome/workspace-m0a'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const CDP_PORT = Number(argOf('cdp-port', '9230'))
const PROFILE = join(process.env.TMPDIR ?? '/tmp', `m0b-chip-profile-${String(PORT)}`)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })
void HOME

const pairing = JSON.parse(readFileSync(PAIRING, 'utf8'))
const KEY = pairing.key
const EXT_ORIGIN = pairing.extensionOrigins[0]

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy — kill the stale Chrome first`)

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `rm -rf "${PROFILE}"; "${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --window-size=1280,900 about:blank >/tmp/m0b-chip-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } }
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[chip-probe] fatal:', error); cleanup(); process.exit(1) })

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

const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank', width: 1280, height: 900, newWindow: true })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
await browser.send('Runtime.enable', {}, sessionId)
await browser.send('Page.enable', {}, sessionId)

const minted = execFileSync(process.execPath, [resolve(ROOT, 'spike', 'mint-cookie.mjs'), `127.0.0.1:${PORT}`], { encoding: 'utf8' }).trim()
const cookieAt = minted.indexOf('=')
await browser.send('Network.setCookie', {
  name: minted.slice(0, cookieAt), value: minted.slice(cookieAt + 1),
  url: `${ORIGIN}/`, path: '/', httpOnly: true, sameSite: 'Strict',
}, sessionId)
await browser.send('Page.navigate', { url: `${ORIGIN}/` }, sessionId)

const evaluate = async (expression, timeoutMs = 12000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
  const result = await Promise.race([call, timeout])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}

// 断言 / 观测分离，只有布尔 true 算通过；规则单一真源见 tests/lib/probe-result.mjs。
// 以前这个探针既不算失败集，又以 `process.exit(0)` 收尾 —— 结构上不可能变红。
const { record, observe, results, observations, finish } = createResults({ label: 'm0b-chip' })

console.log('1. 等待 client 半加载并连上 /ag/client')
let ready = null
for (let i = 0; i < 40; i += 1) {
  const raw = await evaluate(`JSON.stringify(globalThis.__AG_CLIENT__ === undefined ? null : { connected: globalThis.__AG_CLIENT__.state.connected, chips: globalThis.__AG_CLIENT__.chips().length })`, 8000)
  if (typeof raw === 'string' && raw !== 'null') {
    const parsed = JSON.parse(raw)
    if (parsed.connected === true) { ready = parsed; break }
    ready = parsed
  }
  await sleep(750)
}
record('clientConnected', ready?.connected ?? false)

console.log('2. 驱动真实 UI 选中会话（composer 只有在选中会话后才可用）')
async function clickByText(text) {
  const box = await evaluate(`(() => {
    const wanted = ${JSON.stringify(text)}
    const el = [...document.querySelectorAll('button, [role="button"], [role="menuitem"], div, span')]
      .find((node) => (node.textContent ?? '').trim() === wanted && node.offsetParent !== null)
    if (el === undefined) return null
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })()`, 6000)
  if (box === null || box.error !== undefined) return false
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 }, sessionId)
  return true
}
const clicks = []
clicks.push(['选择工作区', await clickByText('选择工作区')])
await sleep(1000)
clicks.push(['m0a-workspace', await clickByText('m0a-workspace')])
await sleep(1200)
clicks.push(['新会话', await clickByText('新会话')])
await sleep(1500)
const rowBox = await evaluate(`(() => {
  const row = [...document.querySelectorAll('span[class*="_title"]')].find((el) => (el.textContent ?? '').trim() === '新会话' && el.offsetParent !== null)
  if (row === undefined) return null
  const target = row.closest('[role="button"], li, a, div[tabindex]') ?? row
  const r = target.getBoundingClientRect()
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
})()`, 8000)
if (rowBox !== null && rowBox.error === undefined) {
  await browser.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rowBox.x, y: rowBox.y, button: 'left', clickCount: 1 }, sessionId)
  await browser.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rowBox.x, y: rowBox.y, button: 'left', clickCount: 1 }, sessionId)
}
await sleep(1500)
record('uiClicks', clicks)
let composer = null
for (let i = 0; i < 12; i += 1) {
  composer = JSON.parse(await evaluate(`JSON.stringify({ active: document.querySelector('[contenteditable="true"]') !== null, sessionId: globalThis.__AG_CLIENT__?.state?.deliveries?.length ?? 0 })`, 6000))
  if (composer.active === true) break
  await sleep(1000)
}
record('composerActive', composer?.active ?? false)

console.log('3. POST /ag/attach（真实抓取载荷）')
const captureId = `M0B-CHIP-${Date.now().toString(36)}`
const payload = {
  protocolVersion: 1,
  captureId,
  trigger: 'look_left',
  page: { title: 'M0B 胶囊探针页', url: 'https://example.com/m0b-chip', domain: 'example.com', capturedAt: Date.now() },
  content: { markdown: `# M0B 胶囊探针\n\n验证推送 → 草稿 → 胶囊 → 撤销闭环。`, truncated: false, selection: { text: '选中片段', selectorHint: 'main > p' } },
  media: { screenshot: { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==', width: 800, height: 600, bytes: 24 } },
  target: { workspace: WORKSPACE },
}
const attach = await fetch(`${ORIGIN}/ag/attach?key=${encodeURIComponent(KEY)}`, {
  method: 'POST', headers: { 'content-type': 'application/json', origin: EXT_ORIGIN }, body: JSON.stringify(payload),
}).then(async (r) => ({ status: r.status, body: await r.json() }))
record('attachStatus', attach.status)
record('attachDeliveredTo', attach.body?.deliveredTo)

console.log('4. 断言：胶囊出现 + 草稿含引用')
let chipState = null
for (let i = 0; i < 20; i += 1) {
  const raw = await evaluate(`JSON.stringify({
    chips: globalThis.__AG_CLIENT__?.chips?.() ?? [],
    deliveries: globalThis.__AG_CLIENT__?.state?.deliveries ?? [],
    acks: globalThis.__AG_CLIENT__?.state?.acks ?? [],
    draft: (() => { try { const el = document.querySelector('[contenteditable="true"]'); return el === null ? '' : el.innerText } catch { return null } })(),
    lastAttach: globalThis.__AG_LAST_ATTACH__ ?? null,
  })`, 8000)
  chipState = typeof raw === 'string' ? JSON.parse(raw) : null
  if ((chipState?.chips ?? []).length > 0) break
  await sleep(600)
}
record('chipCount', (chipState?.chips ?? []).length)
record('chip', (chipState?.chips ?? [])[0] ?? null)
record('lastAttach', chipState?.lastAttach ?? null)
record('draftContainsFileRef', String(chipState?.draft ?? '').includes(String(attach.body?.fileRef ?? '@@none@@')))
record('draftText', String(chipState?.draft ?? '').slice(0, 160))
record('acksAfterInsert', chipState?.acks ?? [])

console.log('5. ✕ 撤销：胶囊消失 + 引用被移除 + ack=dismissed')
await evaluate(`globalThis.__AG_CLIENT__.dismiss(${JSON.stringify(captureId)})`, 15000)
await sleep(1200)
const after = JSON.parse(await evaluate(`JSON.stringify({
  chips: globalThis.__AG_CLIENT__.chips(),
  acks: globalThis.__AG_CLIENT__.state.acks,
  draft: (() => { const el = document.querySelector('[contenteditable="true"]'); return el === null ? '' : el.innerText })(),
})`, 8000))
record('chipCountAfterDismiss', after.chips.length)
record('draftAfterDismiss', String(after.draft).slice(0, 120))
record('acksTotal', after.acks)

const { data } = await browser.send('Page.captureScreenshot', { format: 'png' }, sessionId)
const shot = join(OUT_DIR, 'probe-chip.png')
writeFileSync(shot, Buffer.from(data, 'base64'))
record('screenshot', shot)

const report = { probe: 'm0b-chip', dshPort: PORT, captureId, workspace: WORKSPACE, results, observations }
writeFileSync(join(OUT_DIR, 'probe-chip.json'), `${JSON.stringify(report, null, 2)}\n`)
cleanup()
finish('docs/reviews/probe-chip.json')
