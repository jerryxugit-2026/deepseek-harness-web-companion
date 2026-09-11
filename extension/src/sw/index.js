/**
 * Service worker entry: the only place listeners are registered.
 *
 * Message contract (docs/01 §5) — every request is `{ kind, ... }`, every
 * response is a Result from src/lib/result.js.
 */
import { ensureReady } from './dsh-session.js'
import { fail } from '../lib/result.js'

/** Last observed companion state, mirrored to the panel on request. */
let lastState = { dsh: 'unknown', attach: 'idle' }

chrome.runtime.onInstalled.addListener(() => {
  void (async () => {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
    lastState = { ...lastState, dsh: 'unknown' }
  })()
})

/** Route one panel/content request to its handler. */
async function route(message) {
  switch (message?.kind) {
    case 'ensure-dsh': {
      const ready = await ensureReady()
      lastState = { ...lastState, dsh: ready.ok ? 'up' : 'down', ...(ready.error === undefined ? {} : { error: ready.error }) }
      return ready.ok ? { ok: true, value: { url: ready.url, state: ready.state } } : { ok: false, error: ready.error }
    }
    case 'state':
      return { ok: true, value: lastState }
    case 'version':
      return { ok: true, value: { protocolVersion: 1, version: chrome.runtime.getManifest().version } }
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
