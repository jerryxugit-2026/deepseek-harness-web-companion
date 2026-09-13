#!/usr/bin/env node
/**
 * M3 · ops probe (design docs/06 §8.2, E2E-7) — real Chrome, real page.
 *
 * Drives the seven browser ops the tool bridge calls, exactly the way the bridge
 * does: `chrome.runtime.sendMessage({kind:'op', …})` from an extension document
 * (the panel owns the `/ag/agent` socket, the service worker owns the browser
 * APIs). Everything is asserted against a live fixture page — the point of M3 is
 * that a model can *change* a page and observe the change.
 *
 * What it pins down:
 *   1. read tools work without any debugger attach;
 *   2. write tools are REFUSED unless the call carries `allowWrite` (the plugin's
 *      `allowBrowserWriteOps` decision, re-enforced in the worker);
 *   3. the untrusted (scripting) path really changes the page — and reports
 *      `trusted: false` so nobody mistakes it for real input;
 *   4. after the runtime switch, the trusted (debugger `Input.*`) path really
 *      changes the page and reports `trusted: true`;
 *   5. `navigate` / `wait` / `tabs` / `screenshot` / `ax` answer with the shapes
 *      the tools schema promises.
 *
 * Usage: node tests/m3/ops-probe.mjs [--fixture-port 3995] [--out docs/reviews]
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocket } from 'ws'
import { createResults } from '../lib/probe-result.mjs'
import { createRequire } from 'node:module'
import { buildBrowserTools } from '../../dsh-plugin/src/host/tools.js'

/**
 * 引擎自己的 JSON-Schema 校验器（就是它给出那句 "must match exactly one oneOf branch"）。
 * 用它而不是自己写一套：本事故之所以漏网，正是因为"工具层声明"和"op 层真值"从没在同一个地方比过。
 */
const requireFromPlugin = createRequire(new URL('../../dsh-plugin/src/host/tools.js', import.meta.url))
const { validateJsonSchemaValue } = requireFromPlugin('@deepseek-ai/dsh-tools')

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const FIXTURE_PORT = Number(argOf('fixture-port', '3995'))
const CDP_PORT = Number(argOf('cdp-port', '9243'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const EXT_DIST = join(ROOT, 'extension', 'dist')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-m3-ops-ext')
const PROFILE = join(TMP, 'dshwc-m3-ops-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${String(FIXTURE_PORT)}`
const MARKER = 'M3-OPS-FIXTURE-MARKER'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const PAGE_ONE = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>M3 ops 夹具</title></head>
<body><article><h1>M3 ops 夹具</h1>
<p>${MARKER} 第一页正文，用于 read/ax/screenshot。</p>
<button id="count" onclick="window.__clicks = (window.__clicks || 0) + 1">点我</button>
<p id="clicks">clicks=0</p>
<input id="field" placeholder="在这里输入">
</article></body></html>`

const PAGE_TWO = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>M3 ops 第二页</title></head>
<body><article><h1>第二页</h1><p id="late-anchor">${MARKER}-TWO</p>
<script>setTimeout(() => { const el = document.createElement('div'); el.id = 'late'; el.textContent = '迟到的元素'; document.body.appendChild(el) }, 700)</script>
</article></body></html>`

const fixture = createServer((req, res) => {
  const two = String(req.url ?? '').startsWith('/two')
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(two ? PAGE_TWO : PAGE_ONE)
})
await new Promise((res) => { fixture.listen(FIXTURE_PORT, '127.0.0.1', res) })

rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })
const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=900,700 about:blank >/tmp/m3-ops-chrome.log 2>&1 & echo $!`,
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
console.log(`[m3-ops] extension id=${extId}`)

const open = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}
const evaluate = async (sessionId, expression, timeoutMs = 20000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 300) }
  return result.result.value
}

// fixture first (it must be the browser's active tab), then the panel document
const fixtureTab = await open(`${ORIGIN}/`)
await sleep(700)
const panel = await open(`chrome-extension://${extId}/src/sidepanel/panel.html`)
await sleep(1500)

// The tab id is Chrome's, not CDP's — ask the extension through `browser_tabs`.
const op = async (tool, params = {}, allowWrite) => {
  const expression = `(async () => {
    const reply = await chrome.runtime.sendMessage(${JSON.stringify({ kind: 'op', tool, params, allowWrite })})
    return JSON.stringify(reply ?? null)
  })()`
  const raw = await evaluate(panel.sessionId, expression, 45000)
  if (typeof raw !== 'string') return { transport: raw }
  try { return JSON.parse(raw) } catch { return { transport: raw } }
}

// 断言/观测分离，且只有布尔 true 算通过 —— 见 ../lib/probe-result.mjs 的由来。
const { record, observe, results, observations, finish } = createResults({ label: 'm3/ops' })

console.log('\n1. 只读工具（无需 debugger）')
const tabs = await op('browser_tabs', {})
const target = (tabs.value?.tabs ?? []).find((t) => String(t.url).startsWith(ORIGIN))
record('browser_tabs 列出夹具页', target !== undefined)
record('browser_tabs 不把扩展自身页面当普通标签', (tabs.value?.tabs ?? []).every((t) => !String(t.url).startsWith('chrome-extension://')))
record('browser_tabs 报告 active 状态', typeof target?.active === 'boolean')
const tabId = target?.id

const read = await op('browser_read', { tabId })
record('browser_read 返回正文 Markdown', String(read.value?.markdown ?? '').includes(MARKER))
record('browser_read 带 title/url/chars', typeof read.value?.title === 'string' && typeof read.value?.chars === 'number')
const readSel = await op('browser_read', { tabId, selector: '#count' })
record('browser_read + selector 只读该元素', readSel.value?.text === '点我' && readSel.value?.tag === 'button')
const readMiss = await op('browser_read', { tabId, selector: '#nope' })
record('selector 不存在 → E_TARGET', readMiss.ok === false && readMiss.error?.code === 'E_TARGET')

console.log('\n2. 写操作门禁（allowBrowserWriteOps 的扩展侧复核）')
const blocked = await op('browser_click', { tabId, selector: '#count' }, false)
record('未授权写操作被拒（E_READONLY）', blocked.ok === false && blocked.error?.code === 'E_READONLY')
const unknown = await op('browser_teleport', {})
record('未知 op → E_PAYLOAD', unknown.ok === false && unknown.error?.code === 'E_PAYLOAD')

console.log('\n3. 非可信路径（scripting 合成事件）')
const before = await evaluate(fixtureTab.sessionId, 'window.__clicks ?? 0')
const clicked = await op('browser_click', { tabId, selector: '#count' }, true)
const after = await evaluate(fixtureTab.sessionId, 'window.__clicks ?? 0')
record('browser_click 真的改变了页面（clicks +1）', clicked.ok === true && Number(after) === Number(before) + 1)
record('非可信路径如实标注 trusted=false', clicked.value?.trusted === false)
record('返回 matched/tag 便于模型自我纠错', typeof clicked.value?.matched === 'number' && clicked.value?.tag === 'button')

const typed = await op('browser_type', { tabId, selector: '#field', text: 'DSH-UNTRUSTED' }, true)
const fieldValue = await evaluate(fixtureTab.sessionId, 'document.getElementById("field").value')
record('browser_type 非可信路径写入输入框', typed.ok === true && fieldValue === 'DSH-UNTRUSTED')

console.log('\n4. 打开运行时开关 → 可信路径（debugger Input.*）')
const enable = await evaluate(panel.sessionId, `(async () => JSON.stringify(await chrome.runtime.sendMessage({ kind: 'browser-control', enabled: true })))()`)
record('运行期开关可打开（无需重新授权）', typeof enable === 'string' && enable.includes('true'))
const before2 = await evaluate(fixtureTab.sessionId, 'window.__clicks ?? 0')
const trusted = await op('browser_click', { tabId, selector: '#count' }, true)
const after2 = await evaluate(fixtureTab.sessionId, 'window.__clicks ?? 0')
record('可信点击真的触发页面 onclick（clicks +1）', trusted.ok === true && Number(after2) === Number(before2) + 1)
record('可信路径如实标注 trusted=true', trusted.value?.trusted === true)
record('可信路径返回点击坐标', Number.isFinite(trusted.value?.coords?.x))

const trustedTyped = await op('browser_type', { tabId, selector: '#field', text: '-TRUSTED', replace: false }, true)
const fieldAfter = await evaluate(fixtureTab.sessionId, 'document.getElementById("field").value')
record('可信输入 append 语义（光标定位到末尾）', trustedTyped.value?.trusted === true && String(fieldAfter).endsWith('-TRUSTED'))
record('可信输入不破坏原有内容', String(fieldAfter).startsWith('DSH-UNTRUSTED'))
const replaced = await op('browser_type', { tabId, selector: '#field', text: 'DSH-REPLACED', replace: true }, true)
const fieldReplaced = await evaluate(fixtureTab.sessionId, 'document.getElementById("field").value')
record('可信输入 replace 语义（选中后覆盖）', replaced.value?.trusted === true && fieldReplaced === 'DSH-REPLACED')

console.log('\n5. ax / screenshot / wait / navigate')
const ax = await op('browser_ax', { tabId, maxNodes: 200 })
record('browser_ax 拿到无障碍节点', (ax.value?.nodes ?? []).length > 5)
record('browser_ax 含 button/heading 角色', (ax.value?.nodes ?? []).some((n) => n.role === 'button') && (ax.value?.nodes ?? []).some((n) => n.role === 'heading'))

const shot = await op('browser_screenshot', { tabId, fullPage: true })
record('browser_screenshot 整页 PNG 有内容', shot.ok === true && (shot.value?.bytes ?? 0) > 1000)
record('截图声明 fullPage 与 trusted', shot.value?.fullPage === true && shot.value?.trusted === true)

const waited = await op('browser_wait', { tabId, ms: 200 }, false)
record('browser_wait(ms) 正常返回', waited.ok === true && waited.value?.elapsedMs >= 200)

const navigated = await op('browser_navigate', { tabId, url: `${ORIGIN}/two` }, true)
record('browser_navigate 加载第二页', navigated.ok === true && String(navigated.value?.url).endsWith('/two'))
record('导航后标题更新', String(navigated.value?.title ?? '').includes('第二页'))
const waitedSel = await op('browser_wait', { tabId, selector: '#late', timeoutMs: 5000 }, false)
record('browser_wait(selector) 等到动态元素', waitedSel.ok === true && waitedSel.value?.selector === '#late')
const waitTimeout = await op('browser_wait', { tabId, selector: '#never', timeoutMs: 600 }, false)
record('等不到 → E_TIMEOUT（可诊断）', waitTimeout.ok === false && waitTimeout.error?.code === 'E_TIMEOUT')

/*
 * ★ 用**真实 CDP 值**驱动工具层，再拿工具真正返回的东西去撞它自己声明的 output schema。
 *
 * 2026-09-12 真机事故：`Accessibility.AXNode.nodeId` 是**字符串**，而 `browser_ax` 的 output schema
 * 声明成 `num` ⇒ 引擎校验失败，模型收到的是 `invalid output`，**永远拿不到无障碍树**（开着
 * 「浏览器控制」也一样）。它漏网的原因正是分层测试各自的盲区：op 探针只看 op 的返回值，
 * 单测只喂**手搓夹具**（nodeId 恰好写成数字）。
 *
 * 注意要驱动 `tool.execute()` 而不是直接拿 op 值比：有些工具会**变换**返回值
 * （`browser_screenshot` 就是：op 返回 base64/tabId/notes，工具把它落盘后换成 filePath/fileRef），
 * 拿 op 值去撞工具 schema 会误报。引擎校验的也正是 `execute()` 的返回值。
 */
const opValues = {
  browser_read: read.value,
  browser_tabs: tabs.value,
  browser_wait: waited.value,
  browser_screenshot: shot.value,
  browser_ax: ax.value,
  browser_click: clicked.value,
  browser_type: typed.value,
  browser_navigate: navigated.value,
}
const toolSpecs = Object.fromEntries(buildBrowserTools({
  // 桩 hub：把刚才**真实**跑出来的 op 值原样交给工具层
  hub: { callAgent: async ({ tool }) => ({ ok: true, value: opValues[tool] ?? {} }) },
  config: { allowBrowserWriteOps: true, attachDir: '网页捕获', retentionHours: 24 },
  // 落盘目标：用探针自己的临时目录（persistScreenshot 会真写一个 PNG）
  resolveWorkspace: () => mkdtempSync(join(tmpdir(), 'ops-probe-tool-')),
  log: () => {},
}).map((tool) => [tool.name, tool]))
// 参数只为过工具层的**入参**校验（值仍由桩 hub 提供真实的 op 结果）
const toolArgs = { browser_type: { text: 'x' }, browser_navigate: { url: 'https://example.com/' } }
for (const name of Object.keys(opValues)) {
  const tool = toolSpecs[name]
  const returned = await tool.execute(toolArgs[name] ?? {}, {})
  const violations = validateJsonSchemaValue(tool.output.schema, returned)
  record(`★真实数据下 ${name} 的返回值通过自己声明的 output schema`, violations.length === 0)
  if (violations.length > 0) console.log(`     ${name} 违规:`, JSON.stringify(violations).slice(0, 240))
}
record('nodeId 的真实类型是字符串（CDP AXNode.nodeId）', typeof ax.value?.nodes?.[0]?.nodeId === 'string')

// 这里原来有一个**只有标题、没有任何断言**的「6. 写操作门禁的运行时开关」小节 ——
// 打印一行小节名就什么都不做，读报告的人会以为这一段测过了。
// 运行时开关（/ag/control 的 F2 形态、能力集 5↔8 无重启）由 `npm run probe:m3-control` 覆盖，
// 本节已删除；本节真正要的那一点（扩展侧复核 allowBrowserWriteOps → E_READONLY）在上面第 2 节。

console.log('\n7. 关闭开关会释放调试器')
const disable = await evaluate(panel.sessionId, `(async () => JSON.stringify(await chrome.runtime.sendMessage({ kind: 'browser-control', enabled: false })))()`)
record('关闭开关返回释放情况', typeof disable === 'string' && disable.includes('browserControl'))

writeFileSync(resolve(OUT_DIR, 'm3-ops-probe.json'), `${JSON.stringify({ probe: 'm3/ops', fixturePort: FIXTURE_PORT, at: new Date().toISOString(), results, observations, sample: { read: { title: read.value?.title, chars: read.value?.chars }, axNodes: (ax.value?.nodes ?? []).length, screenshotBytes: shot.value?.bytes } }, null, 2)}\n`)
cleanup()
finish('m3-ops-probe.json')
