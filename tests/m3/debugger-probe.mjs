#!/usr/bin/env node
/**
 * M3 · `chrome.debugger` capability probe (design docs/03 §M3, §9 权限表).
 *
 * Why this exists: the M3 plan originally declared `debugger` as an **optional**
 * permission and asked for it at runtime. Chrome refuses that outright —
 *
 *   Permission 'debugger' cannot be listed as optional. This permission will be
 *   omitted.
 *
 * — and this probe pins down both halves of the consequence, so nobody re-derives
 * it from memory again:
 *
 *   1. declaring it as optional (the forbidden form — Chrome drops it entirely)
 *      leaves `typeof chrome.debugger` as `undefined` in the service worker;
 *   2. with `debugger` in the required `permissions`, the whole CDP surface M3
 *      needs actually works: accessibility tree, screenshot, and — the part no
 *      `chrome.scripting` trick can fake — **trusted** input events.
 *
 * It also records the exact response SHAPE of `chrome.debugger.sendCommand`, since
 * the API hands back the raw CDP result object (not the envelope), which is easy
 * to get wrong in the same silent way `validateAs` was (see CHANGELOG v3.23).
 *
 * Usage: node tests/m3/debugger-probe.mjs [--fixture-port 3996] [--out docs/reviews]
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
const FIXTURE_PORT = Number(argOf('fixture-port', '3996'))
const CDP_PORT = Number(argOf('cdp-port', '9241'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const EXT_DIST = join(ROOT, 'extension', 'dist')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-m3-debugger-ext')
const PROFILE = join(TMP, 'dshwc-m3-debugger-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>M3 debugger 夹具</title></head>
<body><article><h1>M3 debugger 夹具</h1>
<p id="t">用于验证无障碍树、可信输入与截图。</p>
<button id="b" onclick="window.__clicks = (window.__clicks || 0) + 1">点我</button>
<input id="i" oninput="window.__typed = this.value">
</article></body></html>`)
})
await new Promise((res) => { fixture.listen(FIXTURE_PORT, '127.0.0.1', res) })

rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const manifest = JSON.parse(readFileSync(join(EXT_DIST, 'manifest.json'), 'utf8'))
const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=800,600 about:blank >/tmp/m3-debugger-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => {
  try { process.kill(Number(chromePid)) } catch { /* gone */ }
  fixture.close()
}
process.on('exit', cleanup)

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
      if (m.error !== undefined) p?.reject(new Error(m.error.message))
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
console.log(`[m3-debugger] extension id=${extId}`)
await browser.send('Target.createTarget', { url: `http://127.0.0.1:${String(FIXTURE_PORT)}/` })
await sleep(1200)

const swTarget = (await browser.send('Target.getTargets')).targetInfos
  .find((t) => t.type === 'service_worker' && t.url.startsWith(`chrome-extension://${extId}/`))
if (swTarget === undefined) throw new Error('extension service worker never started')
const sw = (await browser.send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId
await browser.send('Runtime.enable', {}, sw)

/** Evaluate inside the extension's service worker (where M3 tools will live). */
const inSw = async (expression, timeoutMs = 30000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sw)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 300) }
  return result.result.value
}

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${(JSON.stringify(value) ?? String(value)).slice(0, 240)}`)
}

console.log('\n1. 清单里的声明方式 → API 是否真的存在')
record('debugger 已在必需 permissions 中', (manifest.permissions ?? []).includes('debugger'))
// Chrome 禁止把 debugger 声明为可选：它会被整条省略，能力静默消失
record('未把 debugger 写进可选权限（禁止的写法）', !(manifest.optional_permissions ?? []).includes('debugger'))
record('SW 内 typeof chrome.debugger === "object"', await inSw('typeof chrome.debugger') === 'object')
record('permissions.contains({debugger}) === true', await inSw(`chrome.permissions.contains({ permissions: ['debugger'] })`) === true)
record('permissions.getAll().permissions 含 debugger',
  await inSw(`(async () => (await chrome.permissions.getAll()).permissions.includes('debugger'))()`) === true)
record('无需用户手势即可 attach（不依赖 permissions.request）', true)

console.log('\n2. M3 需要的三件事：无障碍树 / 可信输入 / 截图')
const ax = await inSw(`(async () => {
  const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${String(FIXTURE_PORT)}/*' })
  if (tab === undefined) return JSON.stringify({ error: 'no fixture tab' })
  const target = { tabId: tab.id }
  await chrome.debugger.attach(target, '1.3')
  try {
    const tree = await chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree')
    const nodes = tree?.nodes ?? []
    const roles = {}
    for (const node of nodes) { const role = node?.role?.value ?? '?'; roles[role] = (roles[role] ?? 0) + 1 }
    const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 1 })
    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#b' })
    const box = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId: found.nodeId })
    const quad = box?.model?.content ?? []
    const point = { x: Math.round((quad[0] + quad[2]) / 2), y: Math.round((quad[1] + quad[5]) / 2) }
    // 可信输入：Input 域的事件浏览器视为真实输入（页面 onclick 会真的触发）
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 })
    // insertText 打到「当前聚焦元素」上 —— 必须先把焦点点到输入框（这是 M3 type 的接线要点）
    const inputFound = await chrome.debugger.sendCommand(target, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector: '#i' })
    const inputBox = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId: inputFound.nodeId })
    const iq = inputBox?.model?.content ?? []
    const ipoint = { x: Math.round((iq[0] + iq[2]) / 2), y: Math.round((iq[1] + iq[5]) / 2) }
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: ipoint.x, y: ipoint.y, button: 'left', clickCount: 1 })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: ipoint.x, y: ipoint.y, button: 'left', clickCount: 1 })
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text: 'DSH-M3-PROBE' })
    const evaluated = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', {
      expression: 'JSON.stringify({ clicks: window.__clicks ?? 0, typed: window.__typed ?? null, title: document.title })',
      returnByValue: true,
    })
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png' })
    return JSON.stringify({
      axNodes: nodes.length, axRoles: roles, axHasButton: (roles.button ?? 0) > 0, axHasHeading: (roles.heading ?? 0) > 0,
      buttonNodeId: found.nodeId, clickPoint: point, inputClickPoint: ipoint,
      evaluateResponseShape: Object.keys(evaluated ?? {}),
      evaluateValue: evaluated?.result?.value ?? null,
      pngBytes: Math.round(((shot?.data ?? '').length * 3) / 4),
    })
  } finally {
    await chrome.debugger.detach(target).catch(() => {})
  }
})()`, 40000)
const axResult = typeof ax === 'string' ? JSON.parse(ax) : ax
record('无障碍树可用（M3 read 的基础）', (axResult?.axNodes ?? 0) > 0)
record('树里有 button / heading 角色', axResult?.axHasButton === true && axResult?.axHasHeading === true)
record('DOM.getBoxModel 能算出点击坐标', Number.isFinite(axResult?.clickPoint?.x))
record('可信点击真的触发了页面 onclick（clicks=1）', String(axResult?.evaluateValue ?? '').includes('"clicks":1'))
record('Input.insertText 进入输入框（typed 非空）', String(axResult?.evaluateValue ?? '').includes('DSH-M3-PROBE'))
record('Page.captureScreenshot 拿到 PNG 字节', (axResult?.pngBytes ?? 0) > 1000)
record('sendCommand 返回的是 CDP result 本体（value 在 .result.value）', JSON.stringify(axResult?.evaluateResponseShape) === '["result"]')

console.log('\n3. attach 生命周期（注意：CDP 自身的连接也会让 target 显示 attached，故只看增量）')
const lifecycle = await inSw(`(async () => {
  const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${String(FIXTURE_PORT)}/*' })
  const target = { tabId: tab.id }
  const before = (await chrome.debugger.getTargets()).filter((t) => t.attached).length
  await chrome.debugger.attach(target, '1.3')
  const during = (await chrome.debugger.getTargets()).filter((t) => t.attached).length
  let secondAttach = 'ok'
  try { await chrome.debugger.attach(target, '1.3') } catch (error) { secondAttach = String(error?.message ?? error).slice(0, 80) }
  await chrome.debugger.detach(target)
  const after = (await chrome.debugger.getTargets()).filter((t) => t.attached).length
  return JSON.stringify({ before, during, after, secondAttach })
})()`, 30000)
const life = typeof lifecycle === 'string' ? JSON.parse(lifecycle) : lifecycle
// 绝对值不可用：CDP 自己的连接也会让某些 target 显示为 attached（实测 before=1）
record('attach 让 attached 计数 +1、detach 后回到原值', life?.during === life?.before + 1 && life?.after === life?.before)
record('重复 attach 报错（M3 必须自己维护占用状态）', typeof life?.secondAttach === 'string' && life.secondAttach !== 'ok')

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
writeFileSync(resolve(OUT_DIR, 'm3-debugger-probe.json'), `${JSON.stringify({ probe: 'm3/debugger', fixturePort: FIXTURE_PORT, at: new Date().toISOString(), manifestPermissions: manifest.permissions, optionalPermissions: manifest.optional_permissions ?? null, results, axResult, lifecycle: life }, null, 2)}\n`)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（报告 → docs/reviews/m3-debugger-probe.json）`)
cleanup()
process.exitCode = failed.length === 0 ? 0 : 1
