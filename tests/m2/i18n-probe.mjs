#!/usr/bin/env node
/**
 * 真 Chrome 双语探针：**在 en 与 zh_CN 两种界面语言下各跑一次**，验证英文版真的生效。
 *
 * 为什么要单独一个探针（而不是只靠单测）：单测是在 Node 里跑 `t()`，用的是**兜底路径**
 * （Node 没有 `chrome.i18n`）。真正要验的是**Chrome 自己**那条链路：
 *   浏览器界面语言 → Chrome 挑 `_locales/<locale>/messages.json` → `chrome.i18n.getMessage`
 *   → `applyI18n()` 填进 DOM → 用户看到的字
 * 这条链路里任何一环坏了（`default_locale` 写错、语言包没进 dist、`data-i18n` 拼错、applyI18n 没跑），
 * 单测都照样绿。所以必须真 Chrome。
 *
 * 两个刻意的设计：
 *   1. **期望值从源表读**（`extension/i18n/messages.source.json`），不写死在探针里 ——
 *      否则改了文案就得跟着改探针，那是在测"探针和文案一致"，不是在测产品。
 *   2. **把副本 dist 的端口指到一个死端口**（只改 `/tmp` 里那份副本），这样面板连不上用户的
 *      真实 DSH，不会往用户的会话里插东西；同时顺带验到"运行时状态文案也是本地化的"。
 *
 * 用法：node tests/m2/i18n-probe.mjs
 * 前置：无（不需要 DSH 实例）。
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const EXT_DIST = join(ROOT, 'extension', 'dist')
const SOURCE = JSON.parse(readFileSync(join(ROOT, 'extension', 'i18n', 'messages.source.json'), 'utf8'))
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const TMP = process.env.TMPDIR ?? '/tmp'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/**
 * 每种语言跑一轮。`--lang` 与预置 profile 的 `Local State`（`intl.app_locale`）**一起**用，
 * 因为实测 **`--lang` 单独不可靠**（第一次跑 `--lang=en` 却报 zh-CN，第二次 `--lang=zh-CN` 反而英文）。
 *
 * ★ 关键设计：**期望值不绑定"我请求了哪种语言"，而绑定"Chrome 实际报的是哪种语言"**。
 *   这样断言测的是真契约（浏览器语言 → 挑对语言包 → 填进 DOM），而不是在测 `--lang` 这个开关。
 *   "两种语言是否都被覆盖到"由最后一条**单独**的断言去要求 —— 造不出两种环境就明说失败，
 *   而不是把探针机制的问题伪装成产品问题。
 */
const LOCALES = [
  { arg: 'en', want: 'en', label: 'en（英文界面）' },
  { arg: 'zh-CN', want: 'zh_CN', label: 'zh-CN（中文界面）' },
]

/** 把 Chrome 报的界面语言归一到我们的语言包名。 */
function normalizeLocale(raw) {
  return String(raw ?? '').toLowerCase().replace('_', '-').startsWith('zh') ? 'zh_CN' : 'en'
}

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 200)}`)
}

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
    return new Promise((resolve, reject) => { this.#pending.set(id, { resolve, reject }) })
  }
}

/** 递归把 dist 副本里烤着的端口改到死端口（只动 /tmp 那份副本）。 */
function rewritePortInCopy(dir, from = 3080, to = 1) {
  const walk = (d) => {
    for (const entry of readdirSync(d)) {
      const full = join(d, entry)
      if (statSync(full).isDirectory()) { walk(full); continue }
      if (!entry.endsWith('.js')) continue
      const text = readFileSync(full, 'utf8')
      const next = text.replaceAll(`port: ${String(from)}`, `port: ${String(to)}`)
      if (next !== text) writeFileSync(full, next)
    }
  }
  walk(dir)
}

async function runLocale({ arg, want }) {
  const copy = join(TMP, `dshwc-i18n-ext-${want}`)
  const profile = join(TMP, `dshwc-i18n-profile-${want}`)
  const cdpPort = want === 'en' ? 9334 : 9335
  rmSync(copy, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
  cpSync(EXT_DIST, copy, { recursive: true })
  rewritePortInCopy(copy)
  // 预置界面语言：Chrome 从 profile 根的 `Local State` 读 `intl.app_locale`
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'Local State'), JSON.stringify({ intl: { app_locale: arg } }))

  const pid = execFileSync('/usr/bin/env', ['bash', '-c',
    `"${CHROME}" --user-data-dir="${profile}" --remote-debugging-port=${cdpPort} --lang=${arg} `
    + '--no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new '
    + `--enable-unsafe-extension-debugging --window-size=420,900 about:blank >/tmp/dshwc-i18n-chrome-${want}.log 2>&1 & echo $!`,
  ], { encoding: 'utf8' }).trim()

  /*
   * ★ 两段式设置界面语言。
   *
   * 实测（2026-09-12）：macOS 上 `--lang` **不管用**（`--lang=en` 起来仍报 zh-CN），
   * 而"启动前预置 Local State"也没用 —— Chrome 首启会用系统语言把它覆盖掉。
   * 所以：**先跑一次让它把 profile 建好 → 关掉 → 改 Local State 的 `intl.app_locale` → 再起来**。
   */
  const setAppLocale = async () => {
    writeFileSync(join(profile, 'Local State'), JSON.stringify({ intl: { app_locale: arg } }))
    try { writeFileSync(join(profile, 'Default', 'Preferences'), JSON.stringify({ intl: { app_locale: arg } })) } catch { /* 目录可能还没有 */ }
  }

  const browserWs0 = await (async () => {
    for (let i = 0; i < 40; i += 1) {
      try { return (await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)).json()).webSocketDebuggerUrl } catch { await sleep(500) }
    }
    return undefined
  })()
  if (browserWs0 === undefined) throw new Error('chrome devtools never came up (first phase)')
  const first = await Cdp.connect(browserWs0)
  await first.send('Browser.close').catch(() => { /* 关掉即可 */ })
  try { process.kill(Number(pid)) } catch { /* gone */ }
  await sleep(1500)
  await setAppLocale()

  const pid2 = execFileSync('/usr/bin/env', ['bash', '-c',
    `"${CHROME}" --user-data-dir="${profile}" --remote-debugging-port=${cdpPort} --lang=${arg} `
    + '--no-first-run --no-default-browser-check --no-sandbox --disable-gpu --headless=new '
    + `--enable-unsafe-extension-debugging --window-size=420,900 about:blank >/tmp/dshwc-i18n-chrome-${want}-2.log 2>&1 & echo $!`,
  ], { encoding: 'utf8' }).trim()
  void pid

  const cleanup = () => {
    try { process.kill(Number(pid2)) } catch { /* gone */ }
  }

  try {
    let browserWs
    for (let i = 0; i < 40; i += 1) {
      try { browserWs = (await (await fetch(`http://127.0.0.1:${String(cdpPort)}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(500) }
    }
    if (browserWs === undefined) throw new Error('chrome devtools never came up')
    const browser = await Cdp.connect(browserWs)
    const { id: extId } = await browser.send('Extensions.loadUnpacked', { path: copy })
    const { targetId } = await browser.send('Target.createTarget', {
      url: `chrome-extension://${extId}/src/sidepanel/panel.html`, width: 420, height: 900, newWindow: true,
    })
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true })
    await browser.send('Runtime.enable', {}, sessionId)

    const evaluate = async (expression, timeoutMs = 8000) => {
      const call = browser.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId)
      const result = await Promise.race([call, sleep(timeoutMs).then(() => ({ timedOut: true }))])
      if (result.timedOut === true) return { timedOut: true }
      if (result.exceptionDetails !== undefined) return { error: String(result.exceptionDetails.text) }
      return result.result.value
    }

    /*
     * ★ 等"面板脚本真的跑起来了"再读 DOM。
     *
     * 第一版这里是"只要 `#attach-page` 的文本非空就跳出" —— 而 `panel.html` 里**本来就写着
     * 英文默认文案**（给 JS 没跑起来时兜底用），所以第一次轮询就满足了，读到的是**静态 HTML**：
     * DOM 看着是英文、`<html lang>` 还是 `en`，而同一页里 `chrome.i18n.getMessage` 明明是中文。
     * 那次"红"是**探针读太早**，不是产品问题。
     * 现在改用模块自己设的就绪标记：`panel.js` 第 47 行 `globalThis.__AG_PANEL__ = probe`，
     * 它在 `applyI18n()`（第 20 行）**之后**执行 ⇒ 见到它就意味着本地化已经填过了。
     */
    let snap = null
    let ready = false
    for (let i = 0; i < 40; i += 1) {
      const raw = await evaluate(`JSON.stringify({
        ready: typeof globalThis.__AG_PANEL__ === 'object' && globalThis.__AG_PANEL__ !== null,
        uiLang: chrome.i18n.getUILanguage(),
        msgAttach: chrome.i18n.getMessage('attachPageLabel'),
        msgErr: chrome.i18n.getMessage('errNoSelection'),
        domAttach: document.getElementById('attach-page')?.textContent ?? null,
        domSelection: document.getElementById('attach-selection')?.textContent ?? null,
        domRetry: document.getElementById('retry')?.textContent ?? null,
        domStatus: document.getElementById('status-text')?.textContent ?? null,
        titleAttr: document.getElementById('attach-page')?.getAttribute('title') ?? null,
        htmlLang: document.documentElement.lang,
        docTitle: document.title,
        manifestName: chrome.runtime.getManifest().name,
        manifestDesc: chrome.runtime.getManifest().description,
        manifestLocale: chrome.runtime.getManifest().default_locale,
      })`)
      snap = typeof raw === 'string' ? JSON.parse(raw) : null
      if (snap?.ready === true) { ready = true; break }
      await sleep(250)
    }
    if (snap === null) throw new Error('panel snapshot never became available')
    if (!ready) throw new Error('panel module never reached __AG_PANEL__ (applyI18n should have run by then)')
    return { snap, cleanup }
  } catch (error) {
    cleanup()
    throw error
  }
}

console.log('真 Chrome 双语探针（不需要 DSH；副本 dist 的端口已改到死端口，不碰你的实例）\n')
const snaps = {}
for (const locale of LOCALES) {
  console.log(`▶ 请求界面语言 ${locale.label}`)
  const { snap, cleanup } = await runLocale(locale)
  /*
   * ★ 产品定位（用户 2026-09-13）：**永远是英文版**，与用户 Chrome 的界面语言无关。
   * 所以期望值是固定的 'en'，而"浏览器实际报什么语言"只作为**观测**记录下来 ——
   * 本机 Chrome 是 zh-CN，如果插件还能显示英文，那正是要证的行为。
   */
  const actual = 'en'
  snaps[actual] = snaps[actual] ?? []
  snaps[actual].push(snap)
  console.log(`  浏览器界面语言（观测）：${String(snap.uiLang)}；期望插件一律显示：英文`)
  cleanup()
  record(`[${actual}] 面板标签 == 源表里该语言的文案（${String(snap.domAttach)}）`,
    snap.domAttach === SOURCE.attachPageLabel[actual])
  record(`[${actual}] 第二个按钮也对（${String(snap.domSelection)}）`,
    snap.domSelection === SOURCE.attachSelectionLabel[actual])
  record(`[${actual}] 重试按钮对（${String(snap.domRetry)}）`,
    snap.domRetry === SOURCE.retry[actual])
  record(`[${actual}] title 属性也被本地化（${String(snap.titleAttr).slice(0, 40)}…）`,
    snap.titleAttr === SOURCE.attachPageTitle[actual])
  // <html lang> 跟"渲染出来的语言"（en）走，而不是浏览器语言 —— 内容是什么语言就写什么语言
  record(`[${actual}] <html lang> == 渲染语言 en（实际 ${String(snap.htmlLang)}；浏览器是 ${String(snap.uiLang)}）`,
    String(snap.htmlLang).toLowerCase() === 'en')
  record(`[${actual}] 文档标题本地化（${String(snap.docTitle)}）`,
    snap.docTitle === SOURCE.extName[actual])
  record(`[${actual}] 错误文案（errors.js 用的 key）本地化`,
    snap.msgErr === SOURCE.errNoSelection[actual])
  record(`[${actual}] default_locale 是 en`, snap.manifestLocale === 'en')
  record(`[${actual}] manifest.name 已由 Chrome 解析成本语言（${String(snap.manifestName)}）`,
    snap.manifestName === SOURCE.extName[actual])
  record(`[${actual}] manifest.description 也解析了`,
    snap.manifestDesc === SOURCE.extDescription[actual])
  console.log('')
}

console.log('★ 与浏览器界面语言无关：中文浏览器下也必须是英文')
{
  const runs = snaps.en ?? []
  record(`跑了 ${String(runs.length)} 轮`, runs.length >= 1)
  /*
   * ★ 这条是本节的核心证据：本机 Chrome 的界面语言是 zh-CN（非英文），
   * 如果插件仍然全部显示英文，就证明了"发布语言只有 en ⇒ 任何浏览器语言下都是英文"。
   * 若有人把 zh_CN 语言包加回 _locales/，Chrome 会在中文浏览器下挑中文 ⇒ 这里立刻变红。
   */
  const observed = runs.map((r) => String(r.uiLang))
  record(`★ 观测到的浏览器语言里有非英文的（实际：${observed.join(', ')}）—— 这样"无关"才被真正验到`,
    observed.some((l) => !/^en/i.test(l)))
  record(`★ 所有轮次都显示英文（${String(runs.length)}` + ` 轮）`,
    runs.every((r) => /[\u4e00-\u9fff]/u.test(String(r.domAttach)) === false))
  record('★ 所有轮次的 manifest 名称都是英文',
    runs.every((r) => /[\u4e00-\u9fff]/u.test(String(r.manifestName)) === false))
  console.log(`\n  en（期望）: name=${JSON.stringify(SOURCE.extName.en)}  按钮=${JSON.stringify(SOURCE.attachPageLabel.en)}`)
  for (const r of runs) console.log(`  实测(浏览器 ${String(r.uiLang)}): name=${JSON.stringify(r.manifestName)}  按钮=${JSON.stringify(r.domAttach)}`)
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
