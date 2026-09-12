#!/usr/bin/env node
/**
 * M3 · 真模型回合探针（E2E-7 的最后一格）—— 让**模型**真的调用 `browser_*`。
 *
 * 为什么单独做：ops 层、工具注册、门禁、审批都被逐层测过，但"模型发出调用 → 工具执行
 * → 结果回到对话"这条**跨三层的链路**从没被真实模型跑过。它需要的条件很具体：
 * 一个活着的 DSH、一个连上的扩展（侧边栏文档持有 `/ag/agent`）、以及一个"真的会去调
 * 工具"的用户消息。
 *
 * 做法：在 DSH 页面里直接投递一条用户消息（不模拟输入框，避免把 UI 事件当成契约），
 * 然后断言：
 *   ① 扩展端收到 `tool-call`（`__AG_PANEL__.frames` 与 `lastOp` 有记录）；
 *   ② 工具真的读到了夹具页（回复里出现夹具标记）；
 *   ③ 插件侧能力集与调用一一对应。
 *
 * `--dump-api`：只打印 DSH 运行时暴露的 conversation/shell 方法面（用来确认"发送"动作
 * 在**当前版本**里叫什么，而不是猜一个名字）。
 *
 * 前置：dev 实例在跑（`DSH_HOME=.devhome dsh web --no-open --port 3099`）。
 * Usage: node tests/m3/agent-turn-probe.mjs [--port 3099] [--dump-api] [--prompt "..."]
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
const FIXTURE_PORT = Number(argOf('fixture-port', '3992'))
const CDP_PORT = Number(argOf('cdp-port', '9247'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const PAIRING = resolve(ROOT, '.devhome/dsh-web-companion.json')
const EXT_DIST = join(ROOT, 'extension', 'dist')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-turn-ext')
const PROFILE = join(TMP, 'dshwc-turn-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const DSH_ORIGIN = `http://127.0.0.1:${String(DSH_PORT)}`
const FIXTURE_ORIGIN = `http://127.0.0.1:${String(FIXTURE_PORT)}`
const MARKER = 'AGENT-TURN-FIXTURE-MARKER'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
const dumpApi = process.argv.includes('--dump-api')
const PROMPT = argOf('prompt', `请用 browser_read 工具读取我当前正在看的那个网页，然后只回答一句话：正文里出现的特定标记是什么？不要猜测，必须真的调用工具。`)
mkdirSync(OUT_DIR, { recursive: true })

const ping = await fetch(`${DSH_ORIGIN}/ag/ping`).then((r) => r.json()).catch(() => null)
if (ping?.paired !== true) {
  console.error(`\n✗ dev 实例未就绪（${DSH_ORIGIN}/ag/ping）\n`)
  process.exit(3)
}

const fixture = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(`<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>Agent 回合夹具</title></head>
<body><article><h1>Agent 回合夹具</h1>
<p>${MARKER} 这一段是模型通过 browser_read 应当读到的正文内容，标记必须原样出现在回复里。</p>
<p>第二段：用于确认工具返回的是真实页面内容而不是模型编造。</p></article></body></html>`)
})
await new Promise((res) => { fixture.listen(FIXTURE_PORT, '127.0.0.1', res) })

const DEV_BACKUP = readFileSync(DEV_CONFIG, 'utf8')
const key = JSON.parse(readFileSync(PAIRING, 'utf8')).key
writeFileSync(DEV_CONFIG, `export const DEV_CONFIG = { port: ${String(DSH_PORT)}, key: ${JSON.stringify(key)} }\nexport default DEV_CONFIG\n`)
const restore = () => { try { writeFileSync(DEV_CONFIG, DEV_BACKUP) } catch { /* best effort */ } }
try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
rmSync(EXT_COPY, { recursive: true, force: true }); cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=1200,900 about:blank >/tmp/m3-turn-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } ; fixture.close(); restore() }
process.on('exit', cleanup)

class Cdp {
  #socket; #id = 1; #pending = new Map(); #events = []
  static async connect(url) {
    const c = new Cdp(); c.#socket = new WebSocket(url)
    await new Promise((res, rej) => {
      c.#socket.addEventListener('open', res, { once: true })
      c.#socket.addEventListener('error', () => { rej(new Error('cdp socket error')) }, { once: true })
    })
    c.#socket.addEventListener('message', (event) => {
      const m = JSON.parse(event.data)
      if (m.id === undefined) { c.#events.push(m); return }
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
  events(method, sessionId) {
    return this.#events.filter((e) => e.method === method && (sessionId === undefined || e.sessionId === sessionId))
  }
}
let browserWs
for (let i = 0; i < 40; i += 1) {
  try { browserWs = (await (await fetch(`http://127.0.0.1:${String(CDP_PORT)}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(500) }
}
const browser = await Cdp.connect(browserWs)
const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: EXT_COPY })

/* 夹具标签先激活（browser_read 默认读"用户正在看的页"），再开面板 */
const openTab = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}
const fixtureTab = await openTab(`${FIXTURE_ORIGIN}/`)
await sleep(600)
const panel = await openTab(`chrome-extension://${extId}/src/sidepanel/panel.html`)

/**
 * Evaluate inside the DSH application, not the panel document.
 *
 * Two traps, both hit for real while writing this:
 *   1. the app lives in a **cross-process** iframe (its own CDP target), so the tab
 *      session's default context is the PANEL page — evaluating there returns the
 *      panel's DOM (measured: reached "Antigravity Companion" while looking for the GUI);
 *   2. `Runtime.executionContextCreated` for that frame is delivered on **the iframe
 *      session**, not the tab session — so the context must be resolved there.
 * `Runtime.enable` replays the existing contexts, so enabling on the iframe session is
 * enough; no event has to be caught live.
 */
let dshContextId = null
let dshSessionId = null
const findDshContext = async () => {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const { targetInfos } = await browser.send('Target.getTargets')
    const iframeTarget = targetInfos.find((t) => t.type === 'iframe' && t.url.startsWith(DSH_ORIGIN))
    if (iframeTarget !== undefined) {
      if (dshSessionId === null) {
        dshSessionId = (await browser.send('Target.attachToTarget', { targetId: iframeTarget.targetId, flatten: true })).sessionId
        await browser.send('Runtime.enable', {}, dshSessionId).catch(() => {})
      }
      for (const event of browser.events('Runtime.executionContextCreated', dshSessionId)) {
        const description = event.params?.context
        if (typeof description?.origin === 'string' && description.origin.startsWith(DSH_ORIGIN)) {
          dshContextId = description.id
          return description
        }
      }
      // 上下文可能还没建好：再 enable 一次触发重放
      await browser.send('Runtime.enable', {}, dshSessionId).catch(() => {})
    }
    await sleep(500)
  }
  return null
}
const context = await findDshContext()
const inDsh = async (expression, timeoutMs = 60000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, contextId: dshContextId }, dshSessionId ?? panel.sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 300) }
  return result.result.value
}

console.log(`DSH 上下文：${context === null ? '未找到' : `#${String(context.id)} ${String(context.origin)} (${String(context.name)})`}`)
if (dshContextId === null) {
  console.error('✗ 找不到 DSH 应用的执行上下文（面板里的 iframe 可能没加载成功）')
  cleanup()
  process.exit(3)
}
// 等客户端半通道起来（它才是意图嗅探与胶囊的宿主）
let clientReady = false
for (let i = 0; i < 40; i += 1) {
  if (await inDsh('typeof globalThis.__AG_CLIENT__ === "object"', 5000) === true) { clientReady = true; break }
  await sleep(500)
}
console.log(`客户端半通道：${clientReady ? '已就绪' : '未就绪'}`)

if (dumpApi) {
  const surface = await inDsh('JSON.stringify(globalThis.__AG_CLIENT__.api(), null, 1)', 20000)
  console.log(typeof surface === 'string' ? surface : JSON.stringify(surface))
  cleanup()
  process.exit(0)
}

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${(JSON.stringify(value) ?? String(value)).slice(0, 200)}`)
}


// 面板页（非 DSH 上下文）里的自检：agent 通道为什么没连上
const panelState = await (async () => {
  const call = browser.send('Runtime.evaluate', {
    expression: `(async () => JSON.stringify({
      panel: globalThis.__AG_PANEL__ ?? null,
      ping: await fetch('http://127.0.0.1:${String(DSH_PORT)}/ag/ping').then((r) => r.status).catch((e) => String(e).slice(0, 60)),
    }))()`, awaitPromise: true, returnByValue: true,
  }, panel.sessionId)
  const r = await Promise.race([call, sleep(8000).then(() => ({ timedOut: true }))])
  return r.timedOut === true ? { timedOut: true } : r.result?.value
})()
console.log('   面板自检：', String(panelState).slice(0, 400))
console.log('\n1. 前置：扩展已连上插件，且模型看得到 browser_* 工具')
record('扩展侧 agent 通道已连接', String(panelState).includes('"agentConnected":true'))
const capabilities = ping.capabilities ?? []
record('插件已注册 browser_read（模型可见）', capabilities.includes('browser_read'))
record('默认只读（写工具未注册）', !capabilities.includes('browser_click'))

console.log('\n1b. 等扩展的 agent 通道（面板可能还在退避重连）')
let agentConnected = false
for (let i = 0; i < 30; i += 1) {
  const state = await (async () => {
    const call = browser.send('Runtime.evaluate', { expression: 'JSON.stringify({ connected: globalThis.__AG_PANEL__?.agentConnected === true })', awaitPromise: true, returnByValue: true }, panel.sessionId)
    const r = await Promise.race([call, sleep(5000).then(() => ({ timedOut: true }))])
    return r.timedOut === true ? '' : String(r.result?.value ?? '')
  })()
  if (state.includes('"connected":true')) { agentConnected = true; break }
  await sleep(1000)
}
record('扩展侧 agent 通道已连接（工具调用的前提）', agentConnected)

console.log('\n1c. 建立一个会话（新实例默认没有活动会话）')
const created = await inDsh('(async () => JSON.stringify(await globalThis.__AG_CLIENT__.newSession()))()', 60000)
const session = typeof created === 'string' ? JSON.parse(created) : created
record('新会话已创建并切换', typeof session?.sessionId === 'string' && session.sessionId.startsWith('session-'))
await sleep(1500)
const actions = await inDsh('JSON.stringify(globalThis.__AG_CLIENT__.actions())', 15000)
console.log('   可用动作：', typeof actions === 'string' ? actions : JSON.stringify(actions))

console.log('\n2. 投递一条用户消息（要求模型必须真的调用工具）')
const sent = await inDsh(`(async () => {
  const api = globalThis.__AG_CLIENT__?.api?.()
  return JSON.stringify({ sessionId: api?.sessionId ?? null, conversationMethods: api?.conversation?.methods ?? [], shellMethods: api?.shell?.methods ?? [] })
})()`, 20000)
console.log('   运行时 API 面：', typeof sent === 'string' ? sent : JSON.stringify(sent))

const delivery = await inDsh(`(async () => JSON.stringify(await globalThis.__AG_CLIENT__.trySend(${JSON.stringify(PROMPT)})))()`, 60000)
console.log('   投递结果：', typeof delivery === 'string' ? delivery : JSON.stringify(delivery))
record('用户消息已进入会话', Array.isArray(typeof delivery === 'string' ? JSON.parse(delivery) : delivery)
  && (typeof delivery === 'string' ? JSON.parse(delivery) : delivery).some((a) => a.ok === true))

console.log('\n3. 等待模型真的调用 browser_read')
let toolCalled = false
let markerSeen = false
for (let i = 0; i < 90; i += 1) {
  // frames 在面板上下文；对话正文在 DSH 上下文 —— 别再混
  const framesCall = browser.send('Runtime.evaluate', { expression: 'JSON.stringify(globalThis.__AG_PANEL__?.frames ?? [])', awaitPromise: true, returnByValue: true }, panel.sessionId)
  const framesResult = await Promise.race([framesCall, sleep(5000).then(() => ({ timedOut: true }))])
  const frames = framesResult.timedOut === true ? '' : String(framesResult.result?.value ?? '')
  if (frames.includes('tool-call')) toolCalled = true
  const text = await inDsh('String(document.body?.innerText ?? "")', 15000)
  if (typeof text === 'string' && text.includes(MARKER)) { markerSeen = true }
  if (i === 3 || i === 10) {
    const flat = typeof text === 'string' ? text.replace(/\s+/gu, ' ') : String(text)
    console.log(`   [t+${String(i * 2)}s] 帧=${frames.slice(0, 120)}`)
    console.log(`   [t+${String(i * 2)}s] 对话尾部 900 字：${flat.slice(-900)}`)
    // 工具行的错误文本往往就在这些关键字附近
    for (const needle of ['E_EXT_OFFLINE', 'E_TARGET', 'E_NO_PERMISSION', 'E_TIMEOUT', 'extension', '扩展', '错误', '失败']) {
      const at = flat.indexOf(needle)
      if (at !== -1) console.log(`   ↳ 命中「${needle}」: …${flat.slice(Math.max(0, at - 120), at + 200)}…`)
    }
  }
  if (toolCalled && markerSeen) break
  await sleep(2000)
}
record('扩展收到 tool-call（模型真的调用了）', toolCalled)
record('回复里出现了夹具标记（工具真的读到了页面）', markerSeen)

writeFileSync(join(OUT_DIR, 'm3-agent-turn-probe.json'), `${JSON.stringify({
  probe: 'm3/agent-turn', at: new Date().toISOString(), prompt: PROMPT, capabilities,
  session, actions: typeof actions === 'string' ? JSON.parse(actions) : actions,
  delivery: typeof delivery === 'string' ? JSON.parse(delivery) : delivery,
  results,
}, null, 2)}\n`)
const failed = Object.entries(results).filter(([, value]) => value === false).map(([key]) => key)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（报告 → docs/reviews/m3-agent-turn-probe.json）`)
process.exitCode = failed.length === 0 ? 0 : 1
cleanup()
