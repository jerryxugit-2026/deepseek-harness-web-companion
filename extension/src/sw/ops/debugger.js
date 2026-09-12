/**
 * M3 browser-control primitives that need the DevTools protocol.
 *
 * `chrome.debugger` is declared as a **required** permission (ADR-12 — Chrome
 * refuses to accept it as optional), but attaching is a **runtime** decision: the
 * panel's 「浏览器控制」switch gates it, and while attached the browser shows the
 * "being debugged" infobar. So every call here is explicit about attaching and
 * always detaches again, and the caller learns which path served the request
 * (`trusted: true|false`) instead of guessing.
 *
 * Verified in real Chrome by tests/m3/debugger-probe.mjs:
 *   - `Accessibility.getFullAXTree` / `Page.captureScreenshot` / `Input.*` all work;
 *   - `sendCommand` resolves to the **CDP result body** (`Runtime.evaluate` → `.result.value`);
 *   - a second attach throws `Another debugger is already attached to the tab with id: …`;
 *   - `Input.insertText` goes to the **focused** element, so focus must be set first.
 */

/** Protocol version M3 pins (design §11.1). */
const PROTOCOL_VERSION = '1.3'

/** Tab ids this extension currently holds attached (double attach is an error, not a no-op). */
const attached = new Set()

/** Whether the debugger API is usable at all in this installation. */
export function debuggerAvailable() {
  return typeof chrome.debugger?.attach === 'function'
}

/**
 * Run `body` with the debugger attached to `tabId`, detaching in every path.
 * @param {number} tabId
 * @param {(target: {tabId: number}) => Promise<any>} body
 * @param {{ reuse?: boolean }} [options] `reuse` keeps the attach open for the next call
 */
export async function withDebugger(tabId, body, options = {}) {
  if (!debuggerAvailable()) {
    throw Object.assign(new Error('chrome.debugger is unavailable (permission missing)'), { code: 'E_NO_PERMISSION' })
  }
  const target = { tabId }
  const alreadyMine = attached.has(tabId)
  if (!alreadyMine) {
    try {
      await chrome.debugger.attach(target, PROTOCOL_VERSION)
      attached.add(tabId)
    } catch (error) {
      const message = String(error?.message ?? error)
      // Someone else (DevTools, another extension) owns the tab — say so plainly.
      throw Object.assign(new Error(message), { code: /already attached/iu.test(message) ? 'E_TARGET_BUSY' : 'E_TARGET' })
    }
  }
  try {
    return await body(target)
  } finally {
    if (options.reuse !== true && !alreadyMine) {
      attached.delete(tabId)
      await chrome.debugger.detach(target).catch(() => {})
    }
  }
}

/** Detach every tab this extension attached (SW teardown / switch flipped off). */
export async function detachAll() {
  const ids = [...attached]
  attached.clear()
  for (const tabId of ids) await chrome.debugger.detach({ tabId }).catch(() => {})
  return ids
}

/** The runtime-attached tabs (diagnostics + probe assertions). */
export function attachedTabs() {
  return [...attached]
}

/** One CDP command; `sendCommand` resolves to the result body, not to an envelope. */
export async function send(tabId, method, params) {
  return withDebugger(tabId, (target) => chrome.debugger.sendCommand(target, method, params ?? {}), { reuse: true })
}

/** Accessibility tree in a flat, agent-friendly form (role/name/value, depth-trimmed). */
export async function accessibilityTree(tabId, { maxNodes = 400 } = {}) {
  const tree = await withDebugger(tabId, (target) => chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree'))
  const nodes = tree?.nodes ?? []
  const out = []
  for (const node of nodes) {
    if (out.length >= maxNodes) break
    const role = node?.role?.value ?? ''
    const name = node?.name?.value ?? ''
    const value = node?.value?.value
    if (role === '' && name === '') continue
    out.push({ nodeId: node.nodeId, role, ...(name === '' ? {} : { name: String(name).slice(0, 120) }), ...(value === undefined ? {} : { value: String(value).slice(0, 120) }) })
  }
  return { nodes: out, total: nodes.length, truncated: nodes.length > out.length }
}

/** Box-model centre of a CSS selector, in viewport CSS pixels. */
export async function elementCenter(tabId, selector) {
  return withDebugger(tabId, async (target) => {
    const doc = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: 1 })
    const found = await chrome.debugger.sendCommand(target, 'DOM.querySelector', { nodeId: doc.root.nodeId, selector })
    if (found?.nodeId === undefined || found.nodeId === 0) {
      throw Object.assign(new Error(`selector not found: ${selector}`), { code: 'E_TARGET' })
    }
    const box = await chrome.debugger.sendCommand(target, 'DOM.getBoxModel', { nodeId: found.nodeId })
    const quad = box?.model?.content ?? []
    if (quad.length < 8) throw Object.assign(new Error(`selector has no box: ${selector}`), { code: 'E_TARGET' })
    return { nodeId: found.nodeId, x: Math.round((quad[0] + quad[2]) / 2), y: Math.round((quad[1] + quad[5]) / 2) }
  })
}

/** Trusted left click at a point (the page's own handlers really run). */
export async function trustedClick(tabId, point, { clickCount = 1 } = {}) {
  return withDebugger(tabId, async (target) => {
    const base = { x: point.x, y: point.y, button: 'left', clickCount }
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mousePressed' })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    return true
  })
}

/** Focus an element (trusted) so a following `trustedType` lands in it. */
export async function trustedFocus(tabId, selector) {
  const point = await elementCenter(tabId, selector)
  await trustedClick(tabId, point)
  return point
}

/** Trusted text insertion into the focused element. */
export async function trustedType(tabId, text) {
  return withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Input.insertText', { text })
    return text.length
  })
}

/**
 * Put the caret where the caller asked, before a trusted insertion.
 *
 * `Input.insertText` inserts at the **caret**, and a click lands the caret wherever
 * it was clicked — so "append" is not free (measured: clicking mid-text inserted
 * mid-text). Positioning is done with page script; the insertion itself stays a
 * trusted input event, which is the part that actually needs the debugger.
 *
 * @param {number} tabId
 * @param {string} selector
 * @param {'end'|'all'} where `end` = append, `all` = replace on next insert
 */
export async function positionCaret(tabId, selector, where) {
  return withDebugger(tabId, async (target) => {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)})
      if (el === null) return 'missing'
      if (el.focus !== undefined) el.focus()
      const isText = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
      if (!isText) return 'not-a-text-field'
      const length = String(el.value ?? '').length
      if (${where === 'all' ? 'true' : 'false'}) el.setSelectionRange(0, length)
      else el.setSelectionRange(length, length)
      return 'ok'
    })()`
    const reply = await chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression, returnByValue: true })
    // sendCommand resolves to the CDP result body → the value lives at .result.value
    const value = reply?.result?.value
    if (value !== 'ok') throw Object.assign(new Error(`cannot position caret in ${selector}: ${String(value)}`), { code: 'E_TARGET' })
    return value
  })
}

/** Trusted key press (e.g. `Enter` to submit). */
export async function trustedKey(tabId, key) {
  const codes = { Enter: { windowsVirtualKeyCode: 13, key: 'Enter', code: 'Enter' }, Tab: { windowsVirtualKeyCode: 9, key: 'Tab', code: 'Tab' } }
  const spec = codes[key]
  if (spec === undefined) throw Object.assign(new Error(`unsupported key: ${key}`), { code: 'E_PAYLOAD' })
  return withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyDown', ...spec })
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...spec })
    return true
  })
}

/** Screenshot of the whole page (not just the viewport) — works on background tabs too. */
export async function fullPageScreenshot(tabId) {
  const shot = await withDebugger(tabId, (target) => chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }))
  const base64 = String(shot?.data ?? '')
  if (base64 === '') throw Object.assign(new Error('empty screenshot'), { code: 'E_TARGET' })
  return { mime: 'image/png', base64, bytes: Math.round((base64.length * 3) / 4), fullPage: true }
}
