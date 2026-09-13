#!/usr/bin/env node
/**
 * M2 · capture probe (design docs/06 §8.2 E2E-2).
 *
 * Drives the BUILT extension end to end for the capture path:
 *
 *   fixture page (127.0.0.1, covered by host_permissions)
 *     → service worker builds the capture (MAIN-world extraction → Markdown)
 *     → POST /ag/attach (key + extension Origin)
 *     → file lands in the workspace with front-matter
 *     → the DSH page inside the panel's iframe receives the push and renders a chip
 *
 * Only the text path is asserted here: `captureVisibleTab` needs `<all_urls>` or
 * `activeTab`, and a headless run cannot produce the required user gesture (the
 * exact error text is captured by tests/m0a/permission-probe.mjs).
 *
 * Usage: node tests/m2/capture-probe.mjs [--port 3099] [--fixture-port 3999]
 */
import { createServer } from 'node:http'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createResults } from '../lib/probe-result.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const DSH_PORT = argOf('port', '3099')
const FIXTURE_PORT = Number(argOf('fixture-port', '3999'))
const CDP_PORT = Number(argOf('cdp-port', '9232'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const WORKSPACE = resolve(ROOT, argOf('workspace', '.devhome/workspace-m0a'))
const EXT_DIST = join(ROOT, 'extension', 'dist')
const EXT_COPY = join(process.env.TMPDIR ?? '/tmp', 'dshwc-capture-ext')
const PROFILE = join(process.env.TMPDIR ?? '/tmp', 'dshwc-capture-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${DSH_PORT}`
const MARKER = 'FIXTURE-ARTICLE-MARKER-77'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

/** A page shaped like real documentation: nav noise + article + code block. */
const fixtureServer = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8">
<title>M2 抓取夹具页</title>
<meta name="description" content="用于验证正文抽取的夹具页面">
</head><body>
<nav>导航噪音 导航噪音</nav>
<article>
  <h1>M2 抓取夹具</h1>
  <div class="chips">
    <a href="/c/knowledge">Knowledge</a><a href="/c/automation">Automation</a><a href="/c/creative">Creative</a>
  </div>
  <p>${MARKER} 这是主内容第一段，用于验证抽取与落盘。</p>
  <ul class="doc-list">
  <li><a href="#placeholder-anchor-junk">A</a></li>
  <li><a href="http://127.0.0.1:${String(FIXTURE_PORT)}/#x">B</a></li>
  <li><a href="http://127.0.0.1:${String(FIXTURE_PORT)}/relative/path">Go</a></li>
  <li><a href="http://127.0.0.1:${String(FIXTURE_PORT)}/doc/1">这是一份真实文档链接，标题很长不会被当成 chip</a></li>
  <li><a href="http://127.0.0.1:${String(FIXTURE_PORT)}/doc/2">另一份同样很长的真实文档链接标题</a></li>
</ul>
<p>真实正文里的短标签反例：<a href="#real-section">Home</a> 必须保留。</p>
<h2>小节标题</h2>
  <ul><li>要点一</li><li>要点二</li></ul>
  <pre><code class="language-js">const answer = 42</code></pre>
  <p>外部链接：<a href="/relative/path">相对链接</a></p>
  <p>恶意链接：<a href="javascript:alert(1)">点我</a> 隐形字符：[KNOW\u200bLEDGE] 内联图：<img src="data:image/png;base64,iVBORw0KGgo=" alt="inline"></p>
  <div class="tabs"><span>SKILL.md</span><span>Stats &amp; details</span><span>Files</span><span>Versions</span></div>
  <button>Read more</button>
  <section class="stats">
    <div>DownloadsAll time30d7d <strong>162</strong></div>
    <div>Last updated4mo agoCurrent versionv1.0.0LicenseMIT-0Report</div>
  </section>
</article>
<footer>页脚噪音</footer>
</body></html>`)
})
await new Promise((r) => { fixtureServer.listen(FIXTURE_PORT, '127.0.0.1', r) })

async function portBusy(port) {
  try { return (await fetch(`http://127.0.0.1:${String(port)}/json/version`)).ok } catch { return false }
}
if (await portBusy(CDP_PORT)) throw new Error(`CDP port ${String(CDP_PORT)} busy — kill the stale Chrome first`)

/**
 * Isolation: point the BUILT extension at the probe port (default 3099) for the
 * duration of the run, then restore and rebuild — otherwise a probe run would
 * write fixture captures into the user's real workspace.
 */
const devConfigOriginal = readFileSync(DEV_CONFIG, 'utf8')
// the probe instance's OWN pairing key (not the real profile's)
const pairingFile = resolve(ROOT, argOf('pairing', '.devhome/dsh-web-companion.json'))
const devKey = JSON.parse(readFileSync(pairingFile, 'utf8')).key
writeFileSync(DEV_CONFIG, `export const DEV_CONFIG = { port: ${DSH_PORT}, key: '${devKey}' }\n`)
execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' })
const restoreDevConfig = () => {
  try { writeFileSync(DEV_CONFIG, devConfigOriginal) } catch { /* ignore */ }
  try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
}

rmSync(EXT_COPY, { recursive: true, force: true })
cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=520,900 about:blank >/tmp/m2-capture-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => {
  try { process.kill(Number(chromePid)) } catch { /* gone */ }
  fixtureServer.close()
  restoreDevConfig()
}
process.on('exit', cleanup)
process.on('uncaughtException', (error) => { console.error('[capture-probe] fatal:', error); cleanup(); process.exit(1) })

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
const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })
console.log(`[capture-probe] extension id=${extId}`)

const open = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}
const evaluate = async (sessionId, expression, timeoutMs = 12000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const timeout = sleep(timeoutMs).then(() => ({ timedOut: true }))
  const result = await Promise.race([call, timeout])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}

// 断言 / 观测分离，且**只有布尔 true 算通过** —— 规则的单一真源在 tests/lib/probe-result.mjs。
// 这个探针以前既不算失败集、又无条件 `process.exit(0)`（结构上不可能变红），旧过滤器
// `v === false` 还会把记成 `null` 的断言静默算过。
const { record, observe, results, observations, finish } = createResults({ label: 'm2-capture' })
// 1. fixture page first (it must be the ACTIVE tab for the capture)
const fixture = await open(`http://127.0.0.1:${String(FIXTURE_PORT)}/`)
await sleep(800)
// 2. the panel document (installs the panel + iframe → DSH client half)
const panel = await open(`chrome-extension://${extId}/src/sidepanel/panel.html`)
await sleep(1000)

console.log('1. 面板已连上 DSH（等待 iframe 内的 DSH GUI）')
let frameReady = null
for (let i = 0; i < 30; i += 1) {
  const { targetInfos } = await browser.send('Target.getTargets')
  const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(ORIGIN))
  if (iframe !== undefined) { frameReady = iframe.url; break }
  await sleep(1000)
}
record('dshFrameUrl', frameReady)

console.log('1b. 记录抓取前的会话状态（用于验证"默认新开会话"）')
const frameEval = async (expression, timeoutMs = 12000) => {
  const { targetInfos } = await browser.send('Target.getTargets')
  const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(ORIGIN))
  if (iframe === undefined) return { error: 'no dsh frame' }
  const frameSession = (await browser.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId
  await browser.send('Runtime.enable', {}, frameSession)
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, frameSession)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  await browser.send('Target.detachFromTarget', { sessionId: frameSession }).catch(() => {})
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
  return result.result.value
}
const sessionsBefore = await frameEval(`JSON.stringify(globalThis.__AG_CLIENT__?.sessions?.() ?? null)`)
record('sessionsBefore', typeof sessionsBefore === 'string' ? JSON.parse(sessionsBefore) : sessionsBefore)

// 保留策略（v3.25）：在同目录埋一个 25h 前的「我们写的」抓取文件与一个用户文件
console.log('1c. 埋入保留策略的测试文件（25h 前的抓取文件 + 用户自己的文件）')
mkdirSync(join(WORKSPACE, '网页捕获'), { recursive: true })
const staleName = '2026-09-10-2000-stale-retention-fixture-zz99.md'
const stalePath = join(WORKSPACE, '网页捕获', staleName)
const userKeepName = '我的笔记-不要删.md'
const userKeepPath = join(WORKSPACE, '网页捕获', userKeepName)
for (const [path, ageHours] of [[stalePath, 25], [userKeepPath, 200]]) {
  writeFileSync(path, '# retention fixture\n', 'utf8')
  const at = new Date(Date.now() - ageHours * 3600 * 1000)
  utimesSync(path, at, at)
}

console.log('2. 让 fixture 页成为活动标签，然后从面板触发抓取')
await browser.send('Target.activateTarget', { targetId: fixture.targetId })
await sleep(600)
const attachResult = await evaluate(panel.sessionId, `(async () => {
  const reply = await chrome.runtime.sendMessage({ kind: 'capture', mode: 'page', trigger: 'button' })
  return JSON.stringify(reply ?? null)
})()`, 40000)
record('attachReply', typeof attachResult === 'string' ? JSON.parse(attachResult) : attachResult)

console.log('3. 落盘文件校验')
const attachDir = join(WORKSPACE, '网页捕获')
void attachDir
let latest = null
if (existsSync(attachDir)) {
  const files = readdirSync(attachDir).map((f) => join(attachDir, f)).filter((f) => statSync(f).isFile()).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
  latest = files[0] ?? null
}
const pagePathFromReply = (typeof attachResult === 'string' ? JSON.parse(attachResult) : attachResult)?.value?.result?.filePath
record('filePath', typeof pagePathFromReply === 'string' ? pagePathFromReply : latest)
const authoritativePath = typeof pagePathFromReply === 'string' && existsSync(pagePathFromReply) ? pagePathFromReply : latest
if (authoritativePath !== null && authoritativePath !== undefined) {
  const text = readFileSync(authoritativePath, 'utf8')
  record('fileChecks', {
    hasMarker: text.includes(MARKER),
    // UI-noise heuristics (v3.20): chips/tabs/action labels/trailing stats gone
    hasCategoryChips: text.includes('Knowledge'),
    hasTabStrip: text.includes('Stats & details') || text.includes('Stats &amp; details'),
    hasReadMore: /Read more/u.test(text),
    hasTrailingStats: /DownloadsAll time|Last updated/u.test(text),
    hasTitle: text.includes('M2 抓取夹具'),
    hasNavNoise: text.includes('导航噪音'),
    hasFooterNoise: text.includes('页脚噪音'),
    hasHeading: text.includes('## 小节标题'),
    hasListItem: text.includes('- 要点一'),
    hasCodeBlock: text.includes('```js'),
    hasAbsoluteLink: /\]\(http:\/\/127\.0\.0\.1:3999\/relative\/path\)/u.test(text),
    frontMatter: text.startsWith('---'),
    chars: text.length,
  })
}

console.log('3b. 选区模式：先选中一段文本，再以 selection 抓取')
const selectionResult = await evaluate(fixture.sessionId, `(() => {
  const p = [...document.querySelectorAll('article p')].find((el) => el.textContent.includes('${MARKER}'))
  if (p === undefined) return 'no-target'
  const range = document.createRange()
  range.selectNodeContents(p)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  return sel.toString().slice(0, 60)
})()`)
record('selectionSet', selectionResult)
await browser.send('Target.activateTarget', { targetId: fixture.targetId })
await sleep(400)
const selectionReply = await evaluate(panel.sessionId, `(async () => {
  const reply = await chrome.runtime.sendMessage({ kind: 'capture', mode: 'selection', trigger: 'button' })
  return JSON.stringify(reply ?? null)
})()`, 40000)
record('selectionReply', typeof selectionReply === 'string' ? JSON.parse(selectionReply) : selectionReply)
const selPath = (typeof selectionReply === 'string' ? JSON.parse(selectionReply) : selectionReply)?.value?.result?.filePath
if (typeof selPath === 'string' && existsSync(selPath)) {
  const text = readFileSync(selPath, 'utf8')
  record('selectionFileChecks', {
    hasSelectionBlock: text.includes('**用户选区**'),
    markdownIsSelectionOnly: !text.includes('小节标题') && !text.includes('要点一'),
    hasMarker: text.includes('MARKER') || text.includes('M2 抓取夹具'),
    chars: text.length,
  })
}
// 复合判定必须拆成**逐条断言**：以前它们是一个对象传给 record()，而旧过滤器只认字面
// false ⇒ 里面任何一项为 false 都**不会**让探针变红（记成对象 → 静默通过）。现在 helper 会把
// 非布尔记录归入"观测"，所以这里显式拆开 —— 观测量仍有，但判定是真判定。
const emptySelection = await (async () => {
  // 先清掉选区，再请求选区抓取：必须明确失败且**不产生文件**
  await evaluate(fixture.sessionId, '(() => { const s = window.getSelection(); s.removeAllRanges(); return s.toString() })()')
  await browser.send('Target.activateTarget', { targetId: fixture.targetId })
  await sleep(300)
  const filesBefore = existsSync(attachDir) ? readdirSync(attachDir).length : 0
  const reply = await evaluate(panel.sessionId, `(async () => {
    const r = await chrome.runtime.sendMessage({ kind: 'capture', mode: 'selection', trigger: 'button' })
    return JSON.stringify(r ?? null)
  })()`, 30000)
  const parsed = typeof reply === 'string' ? JSON.parse(reply) : reply
  const filesAfter = existsSync(attachDir) ? readdirSync(attachDir).length : 0
  return {
    refusedWithCode: parsed?.ok === false && parsed?.error?.code === 'E_NO_SELECTION',
    noFileWritten: filesAfter === filesBefore,
    // SW 这层只说事实（面向用户的话术在面板 explainError，由单测覆盖）
    swMessageStatesFact: /no text is selected/iu.test(String(parsed?.error?.message ?? '')),
  }
})()
record('空选区被明确拒绝（E_NO_SELECTION）', emptySelection.refusedWithCode)
record('空选区**不落盘**（旧行为是"静默抓整页"）', emptySelection.noFileWritten)
record('SW 的话术只说事实（不越权给用户建议）', emptySelection.swMessageStatesFact)
observe('emptySelection', emptySelection)

const retention = {
  stale25hRemoved: !existsSync(stalePath),
  userFileKept: existsSync(userKeepPath),
}
record('保留策略：25h 前的本插件抓取文件被清', retention.stale25hRemoved)
record('保留策略：用户自己的文件被保留', retention.userFileKept)
observe('retention', retention)

record('placeholderAnchors', (() => {
  const body = typeof pagePathFromReply === 'string' && existsSync(pagePathFromReply) ? readFileSync(pagePathFromReply, 'utf8') : ''
  return {
    // 1–2 字 + 纯页内锚点的列表项应被清掉
    bareAnchorJunkGone: !/^- \[[AB]\]\(/mu.test(body),
    // 短标签但真的会跳转的链接必须保留（反例）
    realShortLabelKept: body.includes('[Go]('),
    proseWithShortAnchorKept: body.includes('[Home]('),
    longDocLinksKept: body.includes('doc/1') && body.includes('doc/2'),
  }
})())

record('hardeningChecks', (() => {
  // 权威路径是**回复里**的 filePath（workspace 由 DSH 页面通报，可能不是本探针以为的那个
  // 目录 —— 早前就因为读"最新文件"而恒为 null，看起来绿其实什么都没验）。
  const pagePath = typeof pagePathFromReply === 'string' && existsSync(pagePathFromReply) ? pagePathFromReply : undefined
  if (pagePath === undefined) return null
  const body = readFileSync(pagePath, 'utf8')
  return {
    javascriptUrlDropped: !/javascript:alert/u.test(body),
    zeroWidthStripped: !/[\u200B-\u200F\uFEFF]/u.test(body),
    dataImageKept: /data:image\/png/u.test(body),
  }
})())

console.log('4. 面板 iframe 内的 DSH 页面是否收到推送并渲染胶囊')
let chip = null
for (let i = 0; i < 25; i += 1) {
  const { targetInfos } = await browser.send('Target.getTargets')
  const iframe = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(ORIGIN))
  if (iframe !== undefined) {
    const frameSession = (await browser.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true })).sessionId
    await browser.send('Runtime.enable', {}, frameSession)
    const raw = await browser.send('Runtime.evaluate', {
      expression: `JSON.stringify(globalThis.__AG_CLIENT__ === undefined ? null : {
        connected: globalThis.__AG_CLIENT__.state.connected,
        chips: globalThis.__AG_CLIENT__.chips(),
        acks: globalThis.__AG_CLIENT__.state.acks,
        lastAttach: globalThis.__AG_LAST_ATTACH__ ?? null,
      })`,
      returnByValue: true,
    }, frameSession)
    await browser.send('Target.detachFromTarget', { sessionId: frameSession }).catch(() => {})
    chip = typeof raw.result?.value === 'string' && raw.result.value !== 'null' ? JSON.parse(raw.result.value) : null
    if ((chip?.chips ?? []).length > 0) break
  }
  await sleep(800)
}
record('chipState', chip)

// `dockMounted` 与 `chips()` 都属于**客户端半通道**（DSH 上下文），面板的 chipState 里没有
// 这两个字段 —— 换上下文查字段就会永远读到 undefined/false（同类错误这次犯了两回）。
// 另外胶囊是异步出现的，用有界轮询代替"读一次快照"，否则断言测的是竞态。
let activeChips = []
let dockMounted = false
for (let i = 0; i < 20; i += 1) {
  const snapshot = await frameEval(`JSON.stringify({ mounted: globalThis.__AG_CLIENT__?.dockMounted?.() === true, chips: globalThis.__AG_CLIENT__?.chips?.() ?? [] })`)
  if (typeof snapshot === 'string') {
    const parsed = JSON.parse(snapshot)
    dockMounted = parsed.mounted === true
    activeChips = parsed.chips
    if (activeChips.length > 0) break
  }
  await sleep(400)
}
// 硬断言两条，都是"出现了才算"的形态，**空集不给绿**：
//   - `dockMounted`：插槽胶囊宿主真的挂上了（这是可观察的契约，不是竞态 —— 应用起来就该有）；
//   - `chipNeverFallsBackToDom`：观察到的胶囊**必须**来自插槽，不许 DOM 兜底。
// 原来只有第二条，而 `[].every(...)` 对空数组恒真 ⇒ 胶囊一个都没生成时它反而变绿（假绿）。
// "此刻有没有胶囊"仍是竞态，不进断言，只作观测（出现/撤销/ack 由 probe:chip 覆盖）。
record('dock 已挂载（胶囊宿主 = DSH 插槽）', dockMounted === true)
record('观察到的胶囊都来自插槽（空集不算证据，改由 dockMounted 判）', activeChips.every((entry) => entry.host !== 'dom'))
observe('chipHostObservation', { dockMounted, chipCount: activeChips.length, hosts: activeChips.map((entry) => entry.host) })

const sessionsAfter = await frameEval(`JSON.stringify(globalThis.__AG_CLIENT__?.sessions?.() ?? null)`)
record('sessionsAfter', typeof sessionsAfter === 'string' ? JSON.parse(sessionsAfter) : sessionsAfter)
const before = typeof sessionsBefore === 'string' ? JSON.parse(sessionsBefore) : sessionsBefore
const after = typeof sessionsAfter === 'string' ? JSON.parse(sessionsAfter) : sessionsAfter
record('newSessionCreated', (after?.count ?? 0) > (before?.count ?? 0))
record('targetIsFreshSession', typeof chip?.lastAttach?.sessionId === 'string' && !(before?.ids ?? []).includes(chip.lastAttach.sessionId))
record('sessionMode', chip?.lastAttach?.sessionMode ?? null)
// 2026-09-12 的契约（**v3.39 按用户决定恢复设计行为**）：按钮/右键抓取 = 新建会话 + **切过去**
// + 把 @文件 写进那个新会话的草稿。v3.38 曾短暂反过来（不切、不预填），那两条断言在 v3.39 后
// 就过期了 —— 但因为本探针当时**结构上不可能变红**（没有失败集、无条件 exit(0)），它一直静默
// 通过，直到把判定收紧后才第一次红出来。白盒复核在 tests/unit/client-attach.test.mjs。
record('按设计切到了新会话（switched=true）', chip?.lastAttach?.switched === true)
record('新会话草稿里已写入 @文件（inserted=true）', chip?.lastAttach?.inserted === true && chip?.lastAttach?.status === 'inserted')

const report = { probe: 'm2-capture', dshPort: DSH_PORT, workspace: WORKSPACE, extensionId: extId, results, observations }
writeFileSync(join(OUT_DIR, 'probe-capture.json'), `${JSON.stringify(report, null, 2)}\n`)
cleanup()
finish('docs/reviews/probe-capture.json')
