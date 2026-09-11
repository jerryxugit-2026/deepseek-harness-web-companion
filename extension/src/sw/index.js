/**
 * Service worker entry: the only place listeners are registered.
 *
 * Message contract (docs/01 §5) — every request is `{ kind, ... }`, every
 * response is a Result from src/lib/result.js.
 */
import { ensureReady } from './dsh-session.js'
import { buildCapture } from './capture.js'
import { sendCapture } from './attach-sender.js'
import { fail } from '../lib/result.js'
import { PROTOCOL_VERSION } from '../lib/protocol.generated.js'
import { handleMenuClick, registerMenus } from './menu.js'

/** Last observed companion state, mirrored to the panel on request. */
let lastState = { dsh: 'unknown', attach: 'idle' }

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
    registerMenus()
    lastState = { ...lastState, dsh: 'unknown' }
  })()
})

chrome.contextMenus?.onClicked.addListener((info) => {
  void handleMenuClick(info, (request) => route({ kind: 'capture', ...request }), async (windowId) => {
    // a context-menu click is a user gesture, so the panel may be opened here
    try { await chrome.sidePanel.open(windowId === undefined ? {} : { windowId }) } catch { /* already open */ }
  }).catch(() => {})
})

/** Route one panel/content request to its handler. */
async function route(message) {
  switch (message?.kind) {
    case 'ensure-dsh': {
      const ready = await ensureReady()
      lastState = {
        ...lastState,
        dsh: ready.ok ? 'up' : 'down',
        handshake: ready.ok ? ready.state?.handshake ?? 'unknown' : undefined,
        ...(ready.error === undefined ? {} : { error: ready.error }),
      }
      return ready.ok ? { ok: true, value: { url: ready.url, state: ready.state } } : { ok: false, error: ready.error }
    }
    case 'capture': {
      // One capture: extract → (optional) screenshot → POST /ag/attach.
      const captureId = `cap-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 6)}`
      lastState = { ...lastState, attach: 'sending', ...(message.mode === undefined ? {} : { captureMode: message.mode }) }
      try {
        const captured = await buildCapture({
          mode: message.mode === 'auto' ? 'page' : (message.mode ?? 'page'),
          trigger: message.trigger ?? 'button',
          captureId,
          includeScreenshot: message.includeScreenshot === true || message.mode === 'screenshot',
        })
        const sent = await sendCapture(captured.body)
        lastState = { ...lastState, attach: sent.ok ? 'attached' : 'failed', captureId, ...(sent.ok ? {} : { error: sent.error }) }
        return sent.ok
          ? { ok: true, value: { captureId, result: sent.value, meta: captured.meta } }
          : sent
      } catch (error) {
        const failure = fail(error?.code ?? 'E_INTERNAL', String(error?.message ?? error))
        lastState = { ...lastState, attach: 'failed', error: failure.error }
        return failure
      }
    }
    case 'state':
      return { ok: true, value: lastState }
    case 'version':
      return { ok: true, value: { protocolVersion: PROTOCOL_VERSION, version: chrome.runtime.getManifest().version } }
    default:
      return fail('E_PAYLOAD', `unknown message kind: ${String(message?.kind)}`)
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void route(message)
    .then(sendResponse)
    .catch((error) => { sendResponse(fail('E_INTERNAL', String(error))) })
  return true
})

chrome.runtime.onStartup?.addListener(() => { lastState = { ...lastState, dsh: 'unknown' } })
