/**
 * M3 op layer: the seven `browser_*` capabilities the tool bridge calls
 * (design docs/01 §ops, docs/03 §6).
 *
 * Two execution paths, and the result always says which one ran:
 *
 *   - **scripting path** (`trusted: false`): `chrome.scripting.executeScript` —
 *     inside the page's own JavaScript, so synthesized events are *untrusted*;
 *     a page that checks `event.isTrusted` or uses a shadow-DOM widget can ignore
 *     it. Works without any debugger attach.
 *   - **trusted path** (`trusted: true`): `chrome.debugger` + `Input.*` — real
 *     input events, verified to fire the page's own handlers
 *     (tests/m3/debugger-probe.mjs). Enabled at runtime by the panel's
 *     「浏览器控制」switch (ADR-12), never silently: an op that wanted the trusted
 *     path and did not get it says so in `notes`.
 *
 * Every op takes an optional `tabId`; without one it targets the page the user is
 * looking at, with the same "never our own surface" rule as capture (v3.23).
 */
import { capturePageContent } from '../capture.js'
import { activeTab } from '../capture.js'
import {
  accessibilityTree, debuggerAvailable, detachAll, elementCenter,
  pageScreenshot, positionCaret, trustedClick, trustedFocus, trustedKey, trustedType,
} from './debugger.js'

const MAX_WAIT_MS = 30000
const POLL_MS = 200

const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** Op error with a protocol code the bridge can map to a tool error. */
const opError = (code, message) => Object.assign(new Error(message), { code })

/** Resolve the tab an op should act on. */
async function resolveTab(params = {}) {
  if (Number.isInteger(params.tabId)) {
    const tab = await chrome.tabs.get(params.tabId).catch(() => null)
    if (tab === null) throw opError('E_TARGET', `no tab with id ${String(params.tabId)}`)
    return tab
  }
  return activeTab()
}

/** Run a self-contained function in the page; errors are classified like capture's. */
async function inPage(tabId, func, args = []) {
  const [injection] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func, args })
    .catch((error) => {
      const message = String(error?.message ?? error)
      throw opError(/Cannot access contents of url|must request permission to access this host|Either the '<all_urls>' or 'activeTab'/u.test(message) ? 'E_NO_PERMISSION' : 'E_TARGET', message)
    })
  return injection?.result
}

/** Wait until a predicate function returns true in the page. */
async function waitFor(tabId, func, args = [], timeoutMs = 5000) {
  const deadline = Date.now() + Math.min(timeoutMs, MAX_WAIT_MS)
  let last
  while (Date.now() < deadline) {
    last = await inPage(tabId, func, args).catch((error) => ({ error: String(error.message) }))
    if (last === true) return { ok: true, elapsedMs: Math.min(timeoutMs, MAX_WAIT_MS) - (deadline - Date.now()) }
    await sleep(POLL_MS)
  }
  return { ok: false, elapsedMs: Math.min(timeoutMs, MAX_WAIT_MS), last }
}

/* ─────────────────────────── read / tabs / wait ─────────────────────────── */

/** `browser_read`: cleaned Markdown of the page (or of one element). */
export async function opRead(params = {}) {
  const tab = await resolveTab(params)
  if (typeof params.selector === 'string' && params.selector !== '') {
    const text = await inPage(tab.id, (selector) => {
      const el = document.querySelector(selector)
      return el === null ? null : { text: el.innerText, tag: el.tagName.toLowerCase(), matched: true }
    }, [params.selector])
    if (text === null || text === undefined) throw opError('E_TARGET', `selector not found: ${params.selector}`)
    return { tabId: tab.id, url: tab.url, title: tab.title, selector: params.selector, tag: text.tag, text: text.text, chars: text.text.length }
  }
  const captured = await capturePageContent(tab.id)
  return {
    tabId: tab.id,
    url: captured.page.url,
    title: captured.page.title,
    domain: captured.page.domain,
    markdown: captured.content.markdown,
    chars: captured.content.markdown.length,
    truncated: captured.content.truncated === true,
    hasVideo: captured.page.hasVideo === true,
  }
}

/** `browser_tabs`: what is open, which one is active. */
export async function opTabs(params = {}) {
  const tabs = await chrome.tabs.query({})
  const filtered = tabs
    .filter((tab) => (typeof params.urlContains === 'string' && params.urlContains !== '' ? String(tab.url ?? '').includes(params.urlContains) : true))
    .filter((tab) => (params.includeExtensionPages === true ? true : !String(tab.url ?? '').startsWith('chrome-extension://')))
    .map((tab) => ({
      id: tab.id,
      title: String(tab.title ?? '').slice(0, 120),
      url: String(tab.url ?? '').slice(0, 300),
      active: tab.active === true,
      windowId: tab.windowId,
      ...(tab.lastAccessed === undefined ? {} : { lastAccessed: tab.lastAccessed }),
    }))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
  return { tabs: filtered, count: filtered.length, total: tabs.length }
}

/** `browser_wait`: sleep, wait for a selector, or wait for text. */
export async function opWait(params = {}) {
  const tab = await resolveTab(params)
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.min(params.timeoutMs, MAX_WAIT_MS) : 5000
  if (typeof params.selector === 'string' && params.selector !== '') {
    const result = await waitFor(tab.id, (selector) => document.querySelector(selector) !== null, [params.selector], timeoutMs)
    if (!result.ok) throw opError('E_TIMEOUT', `selector did not appear within ${String(timeoutMs)}ms: ${params.selector}`)
    return { tabId: tab.id, waited: 'selector', selector: params.selector, elapsedMs: result.elapsedMs }
  }
  if (typeof params.text === 'string' && params.text !== '') {
    const result = await waitFor(tab.id, (text) => (document.body?.innerText ?? '').includes(text), [params.text], timeoutMs)
    if (!result.ok) throw opError('E_TIMEOUT', `text did not appear within ${String(timeoutMs)}ms: ${params.text}`)
    return { tabId: tab.id, waited: 'text', text: params.text, elapsedMs: result.elapsedMs }
  }
  const ms = Number.isFinite(params.ms) ? Math.min(params.ms, MAX_WAIT_MS) : 500
  await sleep(ms)
  return { tabId: tab.id, waited: 'ms', elapsedMs: ms }
}

/* ───────────────────────────── write ops ───────────────────────────── */

/** Locate a click target: CSS selector, exact/partial text, or `index`. */
async function findTarget(tabId, params) {
  const found = await inPage(tabId, (spec) => {
    const visible = (el) => {
      const rect = el.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0
    }
    const describe = (el) => ({
      tag: el.tagName.toLowerCase(),
      text: (el.innerText ?? el.value ?? '').trim().slice(0, 80),
      selector: el.id === '' ? null : `#${el.id}`,
    })
    if (typeof spec.selector === 'string' && spec.selector !== '') {
      const el = document.querySelector(spec.selector)
      return el === null ? { error: 'selector-not-found' } : { matched: 1, ...describe(el), visible: visible(el) }
    }
    const wanted = String(spec.text ?? '').trim()
    if (wanted === '') return { error: 'no-selector-and-no-text' }
    const candidates = [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],[role="link"],summary,label')]
      .filter(visible)
      .filter((el) => ((el.innerText ?? el.value ?? '').trim() === wanted)
        || ((el.innerText ?? el.value ?? '').trim().toLowerCase().includes(wanted.toLowerCase())))
    if (candidates.length === 0) return { error: 'text-not-found' }
    const index = Number.isInteger(spec.index) ? spec.index : 0
    const el = candidates[index]
    if (el === undefined) return { error: `index ${String(index)} out of ${String(candidates.length)} matches` }
    return { matched: candidates.length, ...describe(el), visible: visible(el) }
  }, [{ selector: params.selector, text: params.text, index: params.index }])
  if (found?.error !== undefined) {
    const code = found.error === 'text-not-found' || found.error === 'selector-not-found' ? 'E_TARGET' : 'E_PAYLOAD'
    throw opError(code, `${found.error}: ${String(params.selector ?? params.text ?? '')}`)
  }
  return found
}

/**
 * `browser_click`.
 * Trusted path runs when the runtime toggle is on AND a selector gives us a box;
 * otherwise the page's own `click()` runs (untrusted but usually enough).
 */
export async function opClick(params = {}, settings = {}) {
  const tab = await resolveTab(params)
  const target = await findTarget(tab.id, params)
  const notes = []
  if (settings.browserControl === true && debuggerAvailable() && typeof params.selector === 'string' && params.selector !== '') {
    const point = await elementCenter(tab.id, params.selector)
    await trustedClick(tab.id, point)
    return { tabId: tab.id, ok: true, matched: target.matched, tag: target.tag, text: target.text, coords: point, trusted: true }
  }
  if (settings.browserControl === true && debuggerAvailable()) notes.push('trusted path needs a CSS selector; used the untrusted DOM click')
  else notes.push('浏览器控制未开启：使用 DOM 合成点击（页面若检查 isTrusted 会忽略）')
  const clicked = await inPage(tab.id, (spec) => {
    const el = spec.selector !== null && spec.selector !== undefined && spec.selector !== ''
      ? document.querySelector(spec.selector)
      : [...document.querySelectorAll('a,button,[role="button"],input[type="submit"],[role="link"],summary,label')]
        .find((node) => ((node.innerText ?? node.value ?? '').trim().toLowerCase().includes(String(spec.text ?? '').trim().toLowerCase())))
    if (el === null || el === undefined) return false
    el.scrollIntoView({ block: 'center' })
    el.click()
    return true
  }, [{ selector: params.selector ?? null, text: params.text ?? '' }])
  if (clicked !== true) throw opError('E_TARGET', `could not click ${String(params.selector ?? params.text ?? '')}`)
  return { tabId: tab.id, ok: true, matched: target.matched, tag: target.tag, text: target.text, trusted: false, notes }
}

/** `browser_type`: focus the field and enter text, optionally submitting. */
export async function opType(params = {}, settings = {}) {
  const tab = await resolveTab(params)
  const text = String(params.text ?? '')
  if (text === '') throw opError('E_PAYLOAD', 'text is required')
  const notes = []
  let value = null
  if (settings.browserControl === true && debuggerAvailable() && typeof params.selector === 'string' && params.selector !== '') {
    await trustedFocus(tab.id, params.selector)
    // Caret first (script), then a trusted insertion — "append" and "replace" are
    // explicit instead of depending on where the click happened to land.
    await positionCaret(tab.id, params.selector, params.replace === true ? 'all' : 'end')
    await trustedType(tab.id, text)
    if (params.submit === true) await trustedKey(tab.id, 'Enter')
    return { tabId: tab.id, ok: true, typed: text.length, trusted: true, replace: params.replace === true, submitted: params.submit === true }
  }
  notes.push('浏览器控制未开启：使用原生 setter + input 事件（React 等受控组件可用，但不产生 isTrusted 事件）')
  value = await inPage(tab.id, (spec) => {
    const el = spec.selector === null || spec.selector === '' ? document.activeElement : document.querySelector(spec.selector)
    if (el === null || el === undefined) return { error: 'target-not-found' }
    if (el.focus !== undefined) el.focus()
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter !== undefined) setter.call(el, spec.replace === true ? spec.text : `${el.value ?? ''}${spec.text}`)
    else el.textContent = spec.text
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    if (spec.submit === true && el.form !== null && el.form !== undefined) el.form.requestSubmit()
    return { value: String(el.value ?? el.textContent ?? '').slice(0, 200) }
  }, [{ selector: params.selector ?? null, text, replace: params.replace === true, submit: params.submit === true }])
  if (value?.error !== undefined) throw opError('E_TARGET', `${value.error}: ${String(params.selector ?? '(active element)')}`)
  return { tabId: tab.id, ok: true, typed: text.length, value: value?.value ?? null, trusted: false, submitted: params.submit === true, notes }
}

/** `browser_navigate`: load a URL in the target tab and wait for the load event. */
export async function opNavigate(params = {}) {
  const tab = await resolveTab(params)
  const url = String(params.url ?? '')
  if (!/^https?:\/\//u.test(url)) throw opError('E_PAYLOAD', `url must be http(s): ${url}`)
  const timeoutMs = Number.isFinite(params.timeoutMs) ? Math.min(params.timeoutMs, MAX_WAIT_MS) : 15000
  const loaded = new Promise((resolve) => {
    const timer = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(false) }, timeoutMs)
    const listener = (updatedId, info) => {
      if (updatedId !== tab.id || info.status !== 'complete') return
      clearTimeout(timer)
      chrome.tabs.onUpdated.removeListener(listener)
      resolve(true)
    }
    chrome.tabs.onUpdated.addListener(listener)
  })
  await chrome.tabs.update(tab.id, { url })
  const ok = await loaded
  const after = await chrome.tabs.get(tab.id).catch(() => null)
  if (!ok) return { tabId: tab.id, ok: false, url: String(after?.url ?? url), title: after?.title ?? null, notes: [`load did not complete within ${String(timeoutMs)}ms`] }
  return { tabId: tab.id, ok: true, url: String(after?.url ?? url), title: after?.title ?? null }
}

/* ─────────────────────────── screenshot / ax tree ─────────────────────────── */

/**
 * `browser_screenshot`: viewport or full page.
 *
 * `fullPage` decides the *content*; the runtime switch only decides *how* it is taken
 * (debugger bypasses the 2/s throttle and works on background tabs). Letting the
 * switch imply full-page was the bug this probe caught.
 */
export async function opScreenshot(params = {}, settings = {}) {
  const tab = await resolveTab(params)
  const wantFullPage = params.fullPage === true
  if (debuggerAvailable() && (wantFullPage || settings.browserControl === true)) {
    const shot = await pageScreenshot(tab.id, { fullPage: wantFullPage })
    return {
      tabId: tab.id,
      url: tab.url,
      ...shot,
      trusted: true,
      ...(settings.browserControl === true ? { notes: ['浏览器控制已开启：走 debugger（不受 2 次/秒限流、可在后台标签页截图）'] } : {}),
    }
  }
  if (wantFullPage) throw opError('E_NO_PERMISSION', 'full-page screenshots need chrome.debugger')
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
    const base64 = dataUrl.replace(/^data:image\/png;base64,/u, '')
    return { tabId: tab.id, url: tab.url, mime: 'image/png', base64, bytes: Math.round((base64.length * 3) / 4), fullPage: false, trusted: false }
  } catch (error) {
    const message = String(error?.message ?? error)
    throw opError(/Either the '<all_urls>' or 'activeTab'/u.test(message) ? 'E_NO_PERMISSION' : 'E_TARGET', `${message}（提示：captureVisibleTab 只能抓当前活动标签页，且限流 2 次/秒；开「浏览器控制」可绕过）`)
  }
}

/** `browser_ax`: the accessibility tree — the structured read M3 added debugger for. */
export async function opAx(params = {}) {
  const tab = await resolveTab(params)
  if (!debuggerAvailable()) throw opError('E_NO_PERMISSION', 'accessibility tree needs chrome.debugger')
  const tree = await accessibilityTree(tab.id, { maxNodes: Number.isFinite(params.maxNodes) ? params.maxNodes : 400 })
  return { tabId: tab.id, url: tab.url, title: tab.title, ...tree }
}

/* ────────────────────────────── dispatch ────────────────────────────── */

/** Every op the extension can serve, with whether it changes the page. */
export const OPS = Object.freeze({
  read: { run: opRead, write: false },
  tabs: { run: opTabs, write: false },
  wait: { run: opWait, write: false },
  screenshot: { run: opScreenshot, write: false },
  ax: { run: opAx, write: false },
  click: { run: opClick, write: true },
  type: { run: opType, write: true },
  navigate: { run: opNavigate, write: true },
})

/** Ops that change the page — the bridge refuses these unless explicitly enabled. */
export const WRITE_OPS = Object.freeze(Object.entries(OPS).filter(([, spec]) => spec.write).map(([name]) => name))

/** Runtime switches the panel owns; the SW only reads them. */
const SETTINGS_KEY = 'browserControl'

/** Current runtime settings (panel switch + detach-all on disable). */
export async function readSettings() {
  const stored = await chrome.storage.local.get(SETTINGS_KEY).catch(() => ({}))
  return { browserControl: stored?.[SETTINGS_KEY] === true }
}

/**
 * Execute one op.
 * @param {{tool: string, params?: object, allowWrite?: boolean}} request
 * @returns {Promise<{ok: true, value: object} | {ok: false, error: {code: string, message: string}}>}
 */
export async function runOp(request) {
  const name = String(request?.tool ?? '').replace(/^browser_/u, '')
  const spec = OPS[name]
  if (spec === undefined) {
    return { ok: false, error: { code: 'E_PAYLOAD', message: `unknown op: ${String(request?.tool)} (known: ${Object.keys(OPS).join(', ')})` } }
  }
  if (spec.write && request.allowWrite !== true) {
    return { ok: false, error: { code: 'E_READONLY', message: `op "${name}" changes the page and write access is not enabled (allowBrowserWriteOps=false)` } }
  }
  maybeDetach(request.params?.tabId)
  try {
    const settings = await readSettings()
    const value = await spec.run(request.params ?? {}, settings)
    return { ok: true, value }
  } catch (error) {
    return { ok: false, error: { code: error?.code ?? 'E_INTERNAL', message: String(error?.message ?? error) } }
  }
}

/**
 * Keep one debugger attach per tab instead of flapping the infobar: ops reuse an
 * attach owned by this extension and it is released when the switch goes off or
 * the SW is torn down (`detachAll`).
 */
function maybeDetach(_tabId) { /* attach lifetime is handled by withDebugger({reuse:true}) */ }

export { detachAll, debuggerAvailable }
