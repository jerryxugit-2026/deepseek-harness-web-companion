#!/usr/bin/env node
/**
 * M2 · 「看左边」E2E probe (design docs/06 §8.2, E2E-3) — real Chrome.
 *
 * The Node-only probe (tests/m2/look-left-probe.mjs) proves the bridge half. This
 * one proves the two halves that only a browser has:
 *
 *   fixture tab (active)
 *     │  the DSH page inside the panel's iframe sniffs the composer draft
 *     │      「看左边」  → WS /ag/client  → intent
 *     ▼
 *   bridge plugin  →  WS /ag/agent  →  side-panel document
 *     │                                     │ chrome.runtime.sendMessage
 *     │                                     ▼
 *     │                              service worker: extract → POST /ag/attach
 *     ▼
 *   file in the workspace  +  attach push back to the DSH page (composer chip)
 *
 * The intent path has NO user gesture, so this also pins down that a capture
 * still works without the optional `<all_urls>` grant: the fixture lives on
 * 127.0.0.1, which the required `host_permissions` already cover.
 *
 * Usage: node tests/m2/look-left-e2e-probe.mjs [--port 3099] [--fixture-port 3998]
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const DSH_PORT = argOf('port', '3099')
const FIXTURE_PORT = Number(argOf('fixture-port', '3998'))
const CDP_PORT = Number(argOf('cdp-port', '9233'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const WORKSPACE = resolve(ROOT, argOf('workspace', '.devhome/workspace-m0a'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const PAIRING = resolve(ROOT, '.devhome/dsh-web-companion.json')
const EXT_DIST = join(ROOT, 'extension', 'dist')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-lookleft-ext')
const PROFILE = join(TMP, 'dshwc-lookleft-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${String(DSH_PORT)}`
const MARKER = 'LOOK-LEFT-FIXTURE-MARKER-19'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })
mkdirSync(WORKSPACE, { recursive: true })

/* ── dev-config must point at THIS instance (the probe restores it afterwards) ── */
const DEV_BACKUP = readFileSync(DEV_CONFIG, 'utf8')
const key = JSON.parse(readFileSync(PAIRING, 'utf8')).key
const writeDevConfig = (port, pairingKey) => writeFileSync(DEV_CONFIG, `/**
 * Generated for local runs (probes rewrite this file and restore it).
 */
export const DEV_CONFIG = { port: ${String(port)}, key: ${JSON.stringify(pairingKey)} }

export default DEV_CONFIG
`)
writeDevConfig(DSH_PORT, key)
const restoreDevConfig = () => { try { writeFileSync(DEV_CONFIG, DEV_BACKUP) } catch { /* best effort */ } }
try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }

const fixtureServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>看左边夹具页</title></head>
<body><nav>导航噪音</nav><article><h1>看左边夹具</h1>
<p>${MARKER} 这是「看左边」意图应当抓到的正文。</p>
<p>第二段：意图路径没有任何用户手势，仍必须能抓取本页。</p></article></body></html>`)
})
await new Promise((res) => { fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', res) })

rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })
const captureDir = join(WORKSPACE, '网页捕获')
const before = existsSync(captureDir) ? new Set(readdirSync(captureDir)) : new Set()

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=520,900 about:blank >/tmp/m2-lookleft-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => {
  try { process.kill(Number(chromePid)) } catch { /* gone */ }
  fixtureServer.close()
  restoreDevConfig()
}
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[look-left-e2e] fatal:', error); cleanup(); process.exit(1) })

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
      if (m.error !== undefined) p?.reject(new Error(`${String(p.method)}: ${m.error.message}`))
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
const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
console.log(`[look-left-e2e] extension id=${extId}（期望 idpgkobbblmpmnonlndopijgfmehfmig）`)

const open = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}
const evaluate = async (sessionId, expression, timeoutMs = 12000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}
const frameSession = async () => {
  const { targetInfos } = await browser.send('Target.getTargets')
  const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(ORIGIN))
  if (iframe === undefined) return null
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return sessionId
}

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${(JSON.stringify(value) ?? String(value)).slice(0, 240)}`)
}

// 1. fixture first: it must be the browser's active tab for the capture
await open(`http://127.0.0.1:${String(FIXTURE_PORT)}/`)
await sleep(800)
// 2. panel document: owns the iframe AND the /ag/agent socket
const panelTab = await open(`chrome-extension://${extId}/src/sidepanel/panel.html`)
await sleep(1200)

console.log('\n1. 面板 + DSH iframe 就绪')
let frame = null
for (let i = 0; i < 30; i += 1) {
  frame = await frameSession()
  if (frame !== null) break
  await sleep(1000)
}
record('DSH iframe 已加载', frame !== null)

console.log('2. 面板已建立 /ag/agent 通道')
let connected = false
for (let i = 0; i < 20; i += 1) {
  const state = await evaluate(panelTab.sessionId, 'Boolean(globalThis.__AG_PANEL__?.agentConnected)')
  if (state === true) { connected = true; break }
  await sleep(500)
}
record('面板 agent 通道已连接（无手势）', connected)
record('抓取前无 <all_urls> 授权（证明意图路径不依赖它）', await evaluate(panelTab.sessionId, `chrome.permissions.contains({ origins: ['*://*/*'] }).then((v) => v === false)`) === true)

console.log('2b. 等待 DSH 客户端半通道就绪（WS 已开 + 有当前会话），否则嗅探器还没开始工作')
let clientReady = false
let readyState = ''
for (let i = 0; i < 40; i += 1) {
  readyState = String(await evaluate(frame, `JSON.stringify({connected: globalThis.__AG_CLIENT__?.state?.connected === true, current: globalThis.__AG_CLIENT__?.sessions?.()?.current ?? null})`))
  if (readyState.includes('"connected":true') && !readyState.includes('"current":null')) { clientReady = true; break }
  await sleep(500)
}
record('DSH 客户端半通道已就绪（WS + 当前会话）', clientReady)

console.log('3. 在 DSH 输入框写入「看左边」→ 客户端半通道嗅探意图')
const sessionBefore = await evaluate(frame, 'JSON.stringify(globalThis.__AG_CLIENT__?.sessions?.() ?? null)')
record('DSH 客户端探针可用', typeof sessionBefore === 'string' && sessionBefore !== 'null')
// `keep: true` matters: the default hook restores the previous draft after ~900ms,
// which would race the 800ms sniffer (a test that passes by luck).
const wrote = await evaluate(frame, `(async () => { const w = globalThis.__AG_PROBE_WRITE__; if (typeof w !== 'function') return { error: 'no-hook' }; return JSON.stringify(await w('看左边', { keep: true })) })()`, 20000)
const writeResult = typeof wrote === 'string' ? JSON.parse(wrote) : wrote
record('已写入意图草稿并留在输入框', writeResult?.domHasMarker === true)
// The write is only half of it — the client half must SNIFF it (poll loop, 800ms).
let sniffed = 0
for (let i = 0; i < 20; i += 1) {
  const seen = await evaluate(frame, 'JSON.stringify(globalThis.__AG_CLIENT__?.state?.intents ?? [])')
  const list = typeof seen === 'string' ? JSON.parse(seen) : []
  if (list.length > 0) { sniffed = list.length; break }
  await sleep(500)
}
record('客户端嗅探到意图（否则与面板无关）', sniffed > 0)

console.log('4. 等待面板收到 capture-request 并完成抓取')
let intent = null
for (let i = 0; i < 40; i += 1) {
  const seen = await evaluate(panelTab.sessionId, 'JSON.stringify(globalThis.__AG_PANEL__?.intents ?? [])')
  if (typeof seen === 'string' && seen !== '[]') { intent = JSON.parse(seen)[0]; break }
  await sleep(500)
}
record('面板收到 intent 路径的抓取（不是按钮路径）', intent?.reason === 'look-left')
record('抓取成功且落到工作区', intent?.ok === true && typeof intent?.fileRef === 'string')
record('抓取模式为 page（意图默认整页）', intent?.mode === 'page')

console.log('5. 落盘文件与正文断言')
// 落盘目录以**回复里的 filePath** 为准：workspace 是 DSH 页面通报的，可能与探针预设不同
const landedPath = typeof intent?.filePath === 'string' && existsSync(intent.filePath)
  ? intent.filePath
  : (typeof intent?.fileRef === 'string' ? join(captureDir, intent.fileRef.split('/').pop()) : '')
record('抓取文件确实落盘', landedPath !== '' && existsSync(landedPath))
const body = landedPath !== '' && existsSync(landedPath) ? readFileSync(landedPath, 'utf8') : ''
record('文件含夹具正文标记', body.includes(MARKER))
record('front-matter trigger=look_left', /^trigger: look_left$/mu.test(body))

console.log('6. DSH 页面收到 attach 推送（回到客户端）')
let deliveries = null
for (let i = 0; i < 20; i += 1) {
  const seen = await evaluate(frame, 'JSON.stringify(globalThis.__AG_CLIENT__?.state?.deliveries ?? [])')
  if (typeof seen === 'string' && seen !== '[]') { deliveries = JSON.parse(seen); break }
  await sleep(500)
}
record('客户端半通道收到推送', Array.isArray(deliveries) && deliveries.length >= 1)
record('推送 fileRef 与落盘一致', deliveries?.[0]?.fileRef === intent?.fileRef)
const last = await evaluate(frame, 'JSON.stringify(globalThis.__AG_LAST_ATTACH__ ?? null)')
const applied = typeof last === 'string' && last !== 'null' ? JSON.parse(last) : null
record('引用写入输入框成功（inserted=true）', applied?.inserted === true)
record('意图路径落回当前会话（sessionMode=current）', applied?.sessionMode === 'current')
record('意图路径不切换会话外壳（switched=false）', applied?.switched === false)
const draftAfter = await evaluate(frame, `(() => { try { const el = document.querySelector('[contenteditable="true"], textarea'); return el === null ? '' : (el.innerText ?? el.value ?? '') } catch (error) { return 'ERR ' + String(error) } })()`)
// The hard requirement is that the page reference is IN the composer. Whether the
// triggering draft survives is recorded, not asserted: the intent keyword is the
// user's to keep or delete, and DSH owns that text.
record('输入框里出现文件引用（硬要求）', String(draftAfter).includes('网页捕获'))
// 要求是"**落盘的那份文件**的引用进了输入框"，不是"最后一次 attach 等于第一次记录的
// intent"—— 后者在多次 attach 时会变成竞态断言（批量跑时就这么红了一次）。
const landedRef = typeof intent?.fileRef === 'string' ? intent.fileRef : ''
record('落盘文件的引用进了输入框', landedRef !== '' && (
  applied?.fileRef === landedRef || String(draftAfter).includes(landedRef.split('/').pop())
))
record(`触发草稿是否保留（观察）: ${JSON.stringify(String(draftAfter).slice(0, 60))}`, String(draftAfter).includes('看左边'))
const chips = await evaluate(frame, 'JSON.stringify(globalThis.__AG_CLIENT__?.chips?.() ?? [])')
record('屏幕上出现 chip', typeof chips === 'string' && chips.includes('captureId'))

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
writeFileSync(resolve(OUT_DIR, 'look-left-e2e-probe.json'), `${JSON.stringify({ probe: 'm2/look-left-e2e', port: DSH_PORT, fixturePort: FIXTURE_PORT, at: new Date().toISOString(), results, intent, landedFile: landedPath, draftAfter, applied, deliveries: deliveries?.length ?? 0, chips }, null, 2)}\n`)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（报告 → docs/reviews/look-left-e2e-probe.json）`)
cleanup()
process.exitCode = failed.length === 0 ? 0 : 1
