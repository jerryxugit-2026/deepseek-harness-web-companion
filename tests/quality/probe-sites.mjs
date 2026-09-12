#!/usr/bin/env node
/**
 * M4 · 多站点抓取质量回归（`npm run probe:sites`）。
 *
 * 为什么需要它：UI 噪音启发式是"为一类页面调参"的规则，改一处很容易在另一类页面上
 * 误删正文 —— v3.29 就发生过（chip 行阈值 24 字符时把真实链接列表里的条目一起删了）。
 * 所以这里固定五类页面（文档站 / 新闻 / 政务站 / SPA 控制台 / 论坛），
 * 每类都同时断言**两件事**：
 *
 *   ① **该清的清了**（导航残留、chip 行、标签页、Read more、trailing stats、占位锚点）；
 *   ② **该留的留着**（各类页面的正文标记、H2 结构、代码块、引用、列表、相对链接绝对化）。
 *
 * 夹具是本地固定 HTML（`tests/quality/sites/*.html`）——**不依赖外网**，因此可以进 CI，
 * 也不会因为站点改版而随机失败。真实站点的抓取质量由 `npm run audit:captures` 用真
 * 文件说话。
 *
 * 前置：dev 实例在跑（`DSH_HOME=.devhome dsh web --no-open --port 3099`）。
 * Usage: node tests/quality/probe-sites.mjs [--port 3099] [--fixture-port 3994]
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
const FIXTURE_PORT = Number(argOf('fixture-port', '3994'))
const CDP_PORT = Number(argOf('cdp-port', '9245'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const WORKSPACE = resolve(ROOT, argOf('workspace', '.devhome/workspace-m0a'))
const DEV_CONFIG = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const PAIRING = resolve(ROOT, '.devhome/dsh-web-companion.json')
const EXT_DIST = join(ROOT, 'extension', 'dist')
const SITES = join(HERE, 'sites')
const TMP = process.env.TMPDIR ?? '/tmp'
const EXT_COPY = join(TMP, 'dshwc-sites-ext')
const PROFILE = join(TMP, 'dshwc-sites-profile')
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const ping = await fetch(`http://127.0.0.1:${String(DSH_PORT)}/ag/ping`).then((r) => r.json()).catch(() => null)
if (ping?.paired !== true) {
  console.error(`\n✗ dev 实例未就绪（端口 ${String(DSH_PORT)}）—— 先启动：DSH_HOME=.devhome dsh web --no-open --port ${String(DSH_PORT)}\n`)
  process.exit(3)
}

/* dev-config 指到本实例（探针自己还原） */
const DEV_BACKUP = readFileSync(DEV_CONFIG, 'utf8')
const key = JSON.parse(readFileSync(PAIRING, 'utf8')).key
writeFileSync(DEV_CONFIG, `export const DEV_CONFIG = { port: ${String(DSH_PORT)}, key: ${JSON.stringify(key)} }\nexport default DEV_CONFIG\n`)
const restore = () => { try { writeFileSync(DEV_CONFIG, DEV_BACKUP) } catch { /* best effort */ } }
try { execFileSync(process.execPath, [join(ROOT, 'extension', 'build.mjs')], { stdio: 'ignore' }) } catch { /* ignore */ }
rmSync(EXT_COPY, { recursive: true, force: true }); cpSync(EXT_DIST, EXT_COPY, { recursive: true })
rmSync(PROFILE, { recursive: true, force: true })

/** 每个站点的期望：必须留下 / 必须清掉。 */
const CASES = [
  {
    file: 'docs.html',
    name: '文档站',
    keep: ['WIDGET-API-MARKER', '## 初始化', '## 销毁', '```js', '- destroy() 会解绑全部事件'],
    drop: [/\]\(\/c\/api\)/u, /^\s*[-*]\s*\[A\]\(/mu],
    dropWhy: '分类 chip 与占位锚点必须清掉',
  },
  {
    file: 'news.html',
    name: '新闻',
    keep: ['NEWS-MARKER', '## 主要变化', '“这不是一份完美的预算', '记者 张三'],
    // 引用必须生成**合法** Markdown：每行都带 `>`（孤立 `>` + 空行会被渲染成空引用）
    extra: [{ name: '引用是合法 Markdown（每行带 >）', test: (body) => /^> “这不是一份完美的预算/mu.test(body) }],
    drop: [/Read more/iu, /\]\(\/news\/1\)/u],
    dropWhy: '"Read more" 区块与其链接必须清掉',
  },
  {
    file: 'gov.html',
    name: '政务站',
    keep: ['GOV-MARKER', '## Program details', '## Contact', "Tree Owner's Manual"],
    drop: [/^\s*[-*]\s*\[A\]\(/mu, /Downloads 1,234/u],
    dropWhy: '占位锚点与页脚统计必须清掉',
  },
  {
    file: 'spa.html',
    name: 'SPA 控制台',
    keep: ['SPA-MARKER', '构建成功率', '4 分 12 秒'],
    drop: [/Stats &amp; details|Stats & details/u, /Load more/iu, /\]\(\/d\)/u],
    dropWhy: '标签页、Load more、侧栏 chip 必须清掉',
  },
  {
    file: 'forum.html',
    name: '论坛',
    keep: ['FORUM-MARKER', '1 楼', '2 楼', 'hashFiles'],
    drop: [/Copy link/iu, /^\s*[-*]?\s*Share\s*$/mu],
    dropWhy: '操作标签（Share / Report / Copy link）必须清掉',
  },
]

const sites = new Map(CASES.map((c) => [`/${c.file}`, readFileSync(join(SITES, c.file), 'utf8')]))
const server = createServer((req, res) => {
  const body = sites.get(String(req.url ?? ''))
  if (body === undefined) { res.writeHead(404); res.end('nope'); return }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(body)
})
await new Promise((res) => { server.listen(FIXTURE_PORT, '127.0.0.1', res) })

const chromePid = execFileSync('/usr/bin/env', ['bash', '-c',
  `"${CHROME}" --user-data-dir="${PROFILE}" --remote-debugging-port=${CDP_PORT} --no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new --enable-unsafe-extension-debugging --window-size=1000,800 about:blank >/tmp/m4-sites-chrome.log 2>&1 & echo $!`,
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
const open = async (url) => {
  const { targetId } = await browser.send('Target.createTarget', { url, newWindow: false })
  await browser.send('Target.activateTarget', { targetId })
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
  await browser.send('Runtime.enable', {}, sessionId)
  return { targetId, sessionId }
}
const evaluate = async (sessionId, expression, timeoutMs = 40000) => {
  const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
  const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
  if (result.timedOut === true) return { timedOut: true }
  if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text).slice(0, 200) }
  return result.result.value
}

const panel = await open(`chrome-extension://${extId}/src/sidepanel/panel.html`)
await sleep(1500)
const attachDir = join(WORKSPACE, '网页捕获')
const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}`)
}

console.log(`多站点质量回归：${String(CASES.length)} 类页面（夹具 ${String(FIXTURE_PORT)}）\n`)
for (const testCase of CASES) {
  const page = await open(`http://127.0.0.1:${String(FIXTURE_PORT)}/${testCase.file}`)
  await sleep(700)
  const before = existsSync(attachDir) ? new Set(readdirSync(attachDir)) : new Set()
  const reply = await evaluate(panel.sessionId, `(async () => {
    const r = await chrome.runtime.sendMessage({ kind: 'capture', mode: 'page', trigger: 'button' })
    return JSON.stringify(r ?? null)
  })()`)
  const captured = typeof reply === 'string' ? JSON.parse(reply) : reply
  const filePath = captured?.value?.result?.filePath
  const body = typeof filePath === 'string' && existsSync(filePath) ? readFileSync(filePath, 'utf8') : ''
  const kept = testCase.keep.filter((needle) => body.includes(needle))
  const missing = testCase.keep.filter((needle) => !body.includes(needle))
  const leaked = testCase.drop.filter((pattern) => pattern.test(body)).map(String)
  const extras = (testCase.extra ?? []).map((check) => ({ name: check.name, ok: check.test(body) === true }))
  record(`${testCase.name}：抓取成功`, captured?.ok === true && body !== '')
  record(`${testCase.name}：正文完整（${String(kept.length)}/${String(testCase.keep.length)}）${missing.length === 0 ? '' : ` 缺: ${missing.join(' | ')}`}`, missing.length === 0)
  record(`${testCase.name}：${testCase.dropWhy}${leaked.length === 0 ? '' : ` 残留: ${leaked.join(' | ')}`}`, leaked.length === 0)
  for (const extra of extras) record(`${testCase.name}：${extra.name}`, extra.ok)
  await browser.send('Target.closeTarget', { targetId: page.targetId }).catch(() => {})
}

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
writeFileSync(resolve(OUT_DIR, 'm4-site-quality.json'), `${JSON.stringify({ probe: 'm4/sites', fixturePort: FIXTURE_PORT, at: new Date().toISOString(), cases: CASES.map((c) => c.name), results }, null, 2)}\n`)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（报告 → docs/reviews/m4-site-quality.json）`)
cleanup()
process.exitCode = failed.length === 0 ? 0 : 1
