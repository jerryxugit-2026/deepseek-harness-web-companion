#!/usr/bin/env node
/**
 * M3 · 控制面探针（`POST /ag/control`）—— 在真 Chrome 里点面板上的「写操作」开关。
 *
 * 验证的是"用户真的能开关写权限，而不用改 YAML + 重启 DSH"这条路径：
 *
 *   面板开关点击 → 扩展 Origin 的 fetch（F2 形态：key + 精确 Origin）
 *     → 桥接插件重新注册工具集 → 模型可见的工具从 5 个变 8 个（或反向）
 *
 * 需要已在跑的 dev 实例：`DSH_HOME=.devhome dsh web --no-open --port 3099`。
 * 探针会临时把 dev-config 指向该实例（结束后还原），避免动到真实 profile。
 *
 * Usage: node tests/m3/control-probe.mjs [--port 3099]
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
const CDP_PORT = Number(argOf('cdp-port', '9244'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const PAIRING = resolve(ROOT, '.devhome/dsh-web-companion.json')
const EXT_DIST = join(ROOT, 'extension', 'dist')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-control-ext')
const PROFILE = join(TMP, 'dshwc-control-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const ORIGIN = `http://127.0.0.1:${String(DSH_PORT)}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const ping = await fetch(`${ORIGIN}/ag/ping`).then((r) => r.json()).catch(() => null)
if (ping?.paired !== true) {
  console.error(`\n✗ dev 实例未就绪（${ORIGIN}/ag/ping）—— 先启动：DSH_HOME=.devhome dsh web --no-open --port ${String(DSH_PORT)}\n`)
  process.exit(3)
}

/* dev-config 指到本实例，结束后还原（其它探针也这么做） */
const DEV_BACKUP = readFileSync(DEV_CONFIG, 'utf8')
const key = JSON.parse(readFileSync(PAIRING, 'utf8')).key
writeFileSync(DEV_CONFIG, `export const DEV_CONFIG = { port: ${String(DSH_PORT)}, key: ${JSON.stringify(key)} }\nexport default DEV_CONFIG\n`)
const restore = () => { try { writeFileSync(DEV_CONFIG, DEV_BACKUP) } catch { /* best effort */ } }
try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
rmSync(EXT_COPY, { recursive: true, force: true }); cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging about:blank >/tmp/m3-control-chrome.log 2>&1 & echo $!`,
], { encoding: 'utf8' }).trim()
const cleanup = () => { try { process.kill(Number(chromePid)) } catch { /* gone */ } ; restore() }
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
const { targetId } = await browser.send('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel/panel.html` })
const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
await browser.send('Runtime.enable', {}, sessionId)
const evaluate = async (expression, timeoutMs = 15000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 300) }
  return result.result.value
}
const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${(JSON.stringify(value) ?? String(value)).slice(0, 200)}`)
}
const capabilities = () => fetch(`${ORIGIN}/ag/ping`).then((r) => r.json()).then((d) => d.capabilities ?? []).catch(() => [])

console.log(`探测 ${ORIGIN}（dev 实例）\n`)
console.log('1. 面板开关已渲染（插件支持控制面时）')
let toggleVisible = false
for (let i = 0; i < 20; i += 1) {
  toggleVisible = await evaluate(`(() => { const el = document.getElementById('write-ops'); return el !== null && el.hidden === false })()`)
  if (toggleVisible === true) break
  await sleep(500)
}
record('「写操作」开关在面板上可见', toggleVisible)

console.log('\n2. 点开关 → 模型可见工具集变化')
const before = await capabilities()
record('初始为只读（5 个工具）', before.length === 5 && !before.includes('browser_click'))
const enabled = await evaluate(`(async () => {
  const box = document.getElementById('wo-toggle')
  if (box === null) return 'no-toggle'
  const target = box.checked === true ? box : box
  target.checked = true
  target.dispatchEvent(new Event('change', { bubbles: true }))
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 200))
    if (globalThis.__AG_PANEL__?.writeOps === true) return 'enabled'
  }
  return 'timeout'
})()`, 20000)
record('开关点击走通（面板探针确认 writeOps=true）', enabled === 'enabled')
const afterOn = await capabilities()
record('插件即时注册写工具（8 个，无重启）', afterOn.length === 8 && afterOn.includes('browser_click') && afterOn.includes('browser_navigate'))
record('面板探针同步拿到新能力集', Array.isArray((await evaluate('JSON.stringify(globalThis.__AG_PANEL__?.capabilities ?? [])')).constructor === String ? JSON.parse(await evaluate('JSON.stringify(globalThis.__AG_PANEL__?.capabilities ?? [])')) : []) && (JSON.parse(await evaluate('JSON.stringify(globalThis.__AG_PANEL__?.capabilities ?? [])'))).includes('browser_type'))

const disabled = await evaluate(`(async () => {
  const box = document.getElementById('wo-toggle')
  box.checked = false
  box.dispatchEvent(new Event('change', { bubbles: true }))
  for (let i = 0; i < 30; i += 1) {
    await new Promise((r) => setTimeout(r, 200))
    if (globalThis.__AG_PANEL__?.writeOps === false) return 'disabled'
  }
  return 'timeout'
})()`, 20000)
record('可以再关回去', disabled === 'disabled')
const afterOff = await capabilities()
record('关闭后写工具从注册表消失（不是"注册后拒绝"）', afterOff.length === 5 && !afterOff.includes('browser_click'))

console.log('\n3. 控制面的鉴权')
const noKey = await fetch(`${ORIGIN}/ag/control`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: `chrome-extension://${extId}` }, body: JSON.stringify({ allowBrowserWriteOps: true }) })
record('无 key → 403', noKey.status === 403)
const badBody = await fetch(`${ORIGIN}/ag/control?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'content-type': 'application/json', Origin: `chrome-extension://${extId}` }, body: JSON.stringify({ allowBrowserWriteOps: 'yes' }) })
record('非法 body → 400（schema 校验）', badBody.status === 400)
const final = await capabilities()
record('两次非法请求都没改变状态', final.length === 5)

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
writeFileSync(resolve(OUT_DIR, 'm3-control-probe.json'), `${JSON.stringify({ probe: 'm3/control', port: DSH_PORT, at: new Date().toISOString(), results, before, afterOn, afterOff }, null, 2)}\n`)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（报告 → docs/reviews/m3-control-probe.json）`)
cleanup()
process.exitCode = failed.length === 0 ? 0 : 1
