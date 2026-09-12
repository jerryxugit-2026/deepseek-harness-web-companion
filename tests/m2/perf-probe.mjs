#!/usr/bin/env node
/**
 * M4 · 验收指标实测（G1 侧边栏启动、G2 抓取耗时、G6 体积）。
 *
 * 设计文档 §1.2 里 G1/G2/G6 一直挂着 `【目标·未测】`。这份探针把它们变成数字 ——
 * 目标值来自设计文档，方法写在代码里，**不达标也照实记录**。
 *
 * 诚实边界（写在最前面，避免把数字用超出适用范围）：
 *   - 跑在**无头** Chrome 上，与有头存在差异（合成输入、无 GPU 合成路径）；
 *   - 同一台 Mac、本机回环，网络与磁盘都是本机最优情况；
 *   - 结果是**基线**，不是承诺；换机器/换页面结构会变。
 *
 * 前置：dev 实例在跑（`DSH_HOME=.devhome dsh web --no-open --port 3099`）。
 * Usage: node tests/m2/perf-probe.mjs [--port 3099] [--runs 7]
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const RUNS = Number(argOf('runs', '7'))
const FIXTURE_PORT = Number(argOf('fixture-port', '3993'))
const CDP_PORT = Number(argOf('cdp-port', '9246'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const PAIRING = resolve(ROOT, '.devhome/dsh-web-companion.json')
const EXT_DIST = join(ROOT, 'extension', 'dist')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-perf-ext')
const PROFILE = join(TMP, 'dshwc-perf-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${String(FIXTURE_PORT)}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const ping = await fetch(`http://127.0.0.1:${String(DSH_PORT)}/ag/ping`).then((r) => r.json()).catch(() => null)
if (ping?.paired !== true) {
  console.error(`\n✗ dev 实例未就绪（端口 ${String(DSH_PORT)}）\n`)
  process.exit(3)
}

/* 三类页面：轻量（<50KB 正文）/ 标准（~120KB 正文）/ 长页（用于截图） */
const paragraph = (i) => `<p>第 ${String(i)} 段：PERF-MARKER 这是一段用于测量抓取耗时的正文，长度接近真实文章段落，包含若干中文与 English words 混排。</p>`
const LIGHT = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>性能·轻量页</title></head><body><article><h1>轻量页</h1>${Array.from({ length: 12 }, (_, i) => paragraph(i)).join('')}</article></body></html>`
const STANDARD = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>性能·标准页</title></head><body><article><h1>标准页</h1>${Array.from({ length: 400 }, (_, i) => paragraph(i)).join('')}</article></body></html>`

const server = createServer((req, res) => {
  const url = String(req.url ?? '/')
  const body = url.startsWith('/standard') ? STANDARD : LIGHT
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
})
await new Promise((res) => { server.listen(FIXTURE_PORT, '127.0.0.1', res) })

const DEV_BACKUP = readFileSync(DEV_CONFIG, 'utf8')
const key = JSON.parse(readFileSync(PAIRING, 'utf8')).key
writeFileSync(DEV_CONFIG, `export const DEV_CONFIG = { port: ${String(DSH_PORT)}, key: ${JSON.stringify(key)} }\nexport default DEV_CONFIG\n`)
const restore = () => { try { writeFileSync(DEV_CONFIG, DEV_BACKUP) } catch { /* best effort */ } }
try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
rmSync(EXT_COPY, { recursive: true, force: true }); cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=1200,900 about:blank >/tmp/m4-perf-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } ; server.close(); restore() }
process.on('exit', cleanup)

class Cdp {
  #socket; #id = 1; #pending = new Map()
  static async connect(url) {
    const c = new Cdp(); c.#socket = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#socket.addEventListener('open', res, { once: true })
      c.#socket.addEventListener('error', () => { rej(new Error('cdp socket error')) }, { once: true })
    })
    c.#socket.addEventListener('message', (event) => {
      const m = JSON.parse(event.data); if (m.id === undefined) return
      const p = c.#pending.get(m.id); c.#pending.delete(m.id)
      if (m.error !== undefined) p?.reject(new Error(m.error.message)); else p?.resolve(m.result)
    })
    return c
  }
  send(method, params = {}, sessionId) {
    const id = this.#id++
    this.#socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }) })
  }
}
let browserWs
for (let i = 0; i < 40; i += 1) {
  try { browserWs = (await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(500) }
}
const browser = await Cdp.connect(browserWs)
const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
const evaluate = async (sessionId, expression, timeoutMs = 120000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 200) }
  return result.result.value
}
const percentiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0
  return { min: sorted[0] ?? 0, p50: at(0.5), p95: at(0.95), max: sorted.at(-1) ?? 0, n: sorted.length }
}

const results = {}
console.log(`性能基线（无头 Chrome，本机回环，每项 ${String(RUNS)} 次）\n`)

/* ── G1：侧边栏热启动（DSH 已在跑）→ composer 可用 ─────────────────────── */
console.log('1. G1 热启动：打开面板 → iframe 内 composer 可输入')
const hotRuns = []
const phases = { panelDoc: [], iframe: [], composer: [] }
for (let run = 0; run < 3; run += 1) {
  const started = Date.now()
  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel/panel.html` })
  // 阶段 1：面板文档自身就绪（DOM 可查）
  const { sessionId: panelSession } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, panelSession).catch(() => {})
  for (let i = 0; i < 200; i += 1) {
    const ok = await evaluate(panelSession, `document.readyState === 'complete' && document.getElementById('dsh') !== null`, 3000)
    if (ok === true) { phases.panelDoc.push(Date.now() - started); break }
    await sleep(25)
  }
  let composerAt = 0
  let iframeAt = 0
  for (let i = 0; i < 300; i += 1) {
    const { targetInfos } = await browser.send('Target.getTargets')
    const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(`http://127.0.0.1:${String(DSH_PORT)}`))
    if (iframe !== undefined) {
      if (iframeAt === 0) iframeAt = Date.now() - started
      const session = (await browser.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId
      await browser.send('Runtime.enable', {}, session).catch(() => {})
      const ready = await evaluate(session, `document.querySelector('[contenteditable="true"], textarea') !== null`, 3000)
      await browser.send('Target.detachFromTarget', { sessionId: session }).catch(() => {})
      if (ready === true) { composerAt = Date.now() - started; break }
    }
    await sleep(50)
  }
  hotRuns.push(composerAt)
  if (iframeAt > 0) phases.iframe.push(iframeAt)
  if (composerAt > 0) phases.composer.push(composerAt)
  await browser.send('Target.closeTarget', { targetId }).catch(() => {})
  await sleep(500)
}
const hotStats = percentiles(hotRuns.filter((v) => v > 0))
results.g1HotStartMs = hotStats
const G1_HOT_TARGET = 1500
console.log(`   总计 ${JSON.stringify(hotStats)}  目标 p50 ≤ ${String(G1_HOT_TARGET)}ms → ${hotStats.p50 <= G1_HOT_TARGET ? '✅' : '❌'}`)
results.g1PhasesMs = { panelDoc: percentiles(phases.panelDoc), iframeTarget: percentiles(phases.iframe), composerReady: percentiles(phases.composer) }
console.log(`   分解：面板文档 ${String(results.g1PhasesMs.panelDoc.p50)}ms → iframe target ${String(results.g1PhasesMs.iframeTarget.p50)}ms → composer ${String(results.g1PhasesMs.composerReady.p50)}ms\n`)

/* ── G2：抓取耗时（轻量 / 标准 / 截图） ──────────────────────────────────── */
const fixtureTab = async (path) => {
  const { targetId } = await browser.send('Target.createTarget', { url: `${ORIGIN}${path}`, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  await sleep(800)
  return { targetId, sessionId }
}
const panel = await (async () => {
  const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel/panel.html` })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  await sleep(2500)
  return { targetId, sessionId }
})()

const measureCapture = async (fixtureSession, mode, extra = '') => {
  const runs = []
  let lastReply = null
  for (let i = 0; i < RUNS; i += 1) {
    await browser.send('Target.activateTarget', { targetId: (await browser.send('Target.getTargets')).targetInfos.find((t) => t.sessionId === undefined)?.targetId ?? '' }).catch(() => {})
    const reply = await evaluate(panel.sessionId, `(async () => {
      const t0 = performance.now()
      const r = await chrome.runtime.sendMessage({ kind: 'capture', mode: ${JSON.stringify(mode)}${extra} })
      return JSON.stringify({ ms: Math.round(performance.now() - t0), ok: r?.ok === true, code: r?.error?.code ?? null })
    })()`, 120000)
    if (typeof reply === 'string') {
      const parsed = JSON.parse(reply)
      lastReply = parsed
      if (parsed.ok === true) runs.push(parsed.ms)
    }
  }
  return { stats: percentiles(runs), lastReply, failures: RUNS - runs.length }
}

const light = await fixtureTab('/')
await browser.send('Target.activateTarget', { targetId: light.targetId })
const lightResult = await measureCapture(light.sessionId, 'page')
results.g2LightMs = lightResult.stats
results.g2LightFailures = lightResult.failures
console.log(`2. G2 轻量页（正文 <50KB）：${JSON.stringify(lightResult.stats)}  目标 p50 ≤ 300ms → ${lightResult.stats.p50 <= 300 ? '✅' : '❌'}`)

const standard = await fixtureTab('/standard')
await browser.send('Target.activateTarget', { targetId: standard.targetId })
const standardResult = await measureCapture(standard.sessionId, 'page')
results.g2StandardMs = standardResult.stats
results.g2StandardFailures = standardResult.failures
console.log(`   G2 标准页（正文 ~120KB）：${JSON.stringify(standardResult.stats)}  目标 p95 ≤ 800ms → ${standardResult.stats.p95 <= 800 ? '✅' : '❌'}`)

// 截图：走「浏览器控制」的 debugger 路径（视口 captureVisibleTab 需要 <all_urls>/activeTab）
await evaluate(panel.sessionId, `(async () => JSON.stringify(await chrome.runtime.sendMessage({ kind: 'browser-control', enabled: true })))()`)
const measureShot = async (fullPage) => {
  const runs = []
  let bytes = 0
  for (let i = 0; i < Math.min(RUNS, 5); i += 1) {
    const reply = await evaluate(panel.sessionId, `(async () => {
      const t0 = performance.now()
      const r = await chrome.runtime.sendMessage({ kind: 'op', tool: 'browser_screenshot', params: { fullPage: ${String(fullPage)} }, allowWrite: false })
      return JSON.stringify({ ms: Math.round(performance.now() - t0), ok: r?.ok === true, bytes: r?.value?.bytes ?? 0, fullPage: r?.value?.fullPage })
    })()`, 120000)
    if (typeof reply === 'string') {
      const parsed = JSON.parse(reply)
      if (parsed.ok === true) { runs.push(parsed.ms); bytes = parsed.bytes }
      else if (parsed.code === null) results[`shot${String(fullPage)}Error`] = parsed
    }
  }
  return { stats: percentiles(runs), bytes }
}
const viewportShot = await measureShot(false)
results.g2ScreenshotViewportMs = viewportShot.stats
results.g2ScreenshotViewportBytes = viewportShot.bytes
console.log(`   G2 视口截图：${JSON.stringify(viewportShot.stats)}（${String(viewportShot.bytes)} B）`)
const shotStats = (await measureShot(true)).stats
results.g2ScreenshotMs = shotStats
console.log(`   G2 整页截图（debugger）：${JSON.stringify(shotStats)}  目标 p95 ≤ 1500ms（设计按视口定义）→ ${shotStats.p95 <= 1500 ? '✅' : '⚠️ 整页超目标（见报告说明）'}`)

/* ── G6：体积 ───────────────────────────────────────────────────────────── */
const size = JSON.parse(readFileSync(join(OUT_DIR, 'build-size.json'), 'utf8'))
const totalKb = size.totalBytes === undefined ? size.totalKb ?? null : Math.round(size.totalBytes / 1024)
results.g6BundleKb = totalKb
console.log(`\n3. G6 打包体积：${String(totalKb)} KB  目标 ≤ 1024KB → ${totalKb !== null && totalKb <= 1024 ? '✅' : '❌'}`)

writeFileSync(join(OUT_DIR, 'perf-g1-g2.json'), `${JSON.stringify({
  probe: 'm4/perf', at: new Date().toISOString(), dshPort: DSH_PORT, runs: RUNS,
  caveat: 'headless Chrome, loopback, same machine — 这是基线而非承诺',
  targets: { g1HotStartMs: 1500, g2LightP50Ms: 300, g2StandardP95Ms: 800, g2ScreenshotP95Ms: 1500, g6BundleKb: 1024 },
  results,
}, null, 2)}\n`)
console.log('\n报告 → docs/reviews/perf-g1-g2.json')
cleanup()
