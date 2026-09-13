/**
 * Service worker entry: the only place listeners are registered.
 *
 * Message contract (docs/01 §5) — every request is `{ kind, ... }`, every
 * response is a Result from src/lib/result.js.
 */
import { ensureReady } from './dsh-session.js'
import { buildCapture, shotProblem } from './capture.js'
import { sendCapture } from './attach-sender.js'
import { fail } from '../lib/result.js'
import { PROTOCOL_VERSION } from '../lib/protocol.generated.js'
import { handleMenuClick, registerMenus } from './menu.js'
import { hostOf, readAudit, recordAudit } from './audit.js'
import { OPS, WRITE_OPS, detachAll, runOp } from './ops/index.js'

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
      const trigger = message.trigger ?? 'button'
      const mode = message.mode === 'auto' ? 'page' : (message.mode ?? 'page')
      const startedAt = Date.now()
      lastState = { ...lastState, attach: 'sending', ...(message.mode === undefined ? {} : { captureMode: message.mode }) }
      try {
        const captured = await buildCapture({
          mode,
          trigger,
          captureId,
          includeScreenshot: message.includeScreenshot === true || message.mode === 'screenshot',
        })
        const sent = await sendCapture(captured.body)
        // `mode: 'screenshot'` asks for one artefact. When that artefact is missing the
        // attach still counts as a success for the file, but the answer must not: see
        // shotProblem() (v3.41, false-green found in review).
        const shotFailure = mode === 'screenshot' ? shotProblem(captured.body) : null
        const delivered = sent.ok === true && shotFailure === null
        lastState = {
          ...lastState,
          attach: sent.ok ? 'attached' : 'failed',
          captureId,
          ...(sent.ok ? {} : { error: sent.error }),
          ...(shotFailure === null ? {} : { error: { code: shotFailure.code, message: shotFailure.message } }),
        }
        // Audit is the artifact that answers "who asked for this capture?" after the
        // fact — metadata only, host name only (see sw/audit.js for the allow-list).
        await recordAudit({
          kind: 'capture',
          ok: delivered,
          ...(delivered ? {} : { code: sent.ok ? shotFailure.code : sent.error?.code }),
          mode,
          trigger,
          domain: hostOf(captured.tab?.url),
          captureId,
          chars: captured.body?.content?.markdown?.length,
          truncated: captured.body?.content?.truncated === true,
          ms: Date.now() - startedAt,
        })
        if (sent.ok && shotFailure !== null) return fail(shotFailure.code, shotFailure.message)
        return sent.ok
          ? { ok: true, value: { captureId, result: sent.value, meta: captured.meta } }
          : sent
      } catch (error) {
        const failure = fail(error?.code ?? 'E_INTERNAL', String(error?.message ?? error))
        lastState = { ...lastState, attach: 'failed', error: failure.error }
        await recordAudit({ kind: 'capture', ok: false, code: failure.error?.code, mode, trigger, captureId, ms: Date.now() - startedAt })
        return failure
      }
    }
    case 'op': {
      // M3: one browser op requested by the bridge plugin (via the panel socket).
      // `allowWrite` is decided by the plugin (its allowBrowserWriteOps switch);
      // the extension refuses write ops without it rather than trusting the panel.
      const startedAt = Date.now()
      const result = await runOp({ tool: message.tool, params: message.params ?? {}, allowWrite: message.allowWrite === true })
      lastState = { ...lastState, lastOp: { tool: message.tool, ok: result.ok === true, at: Date.now() } }
      await recordAudit({
        kind: 'tool',
        tool: message.tool,
        ok: result.ok === true,
        ...(result.ok ? {} : { code: result.error?.code }),
        tabId: typeof message.params?.tabId === 'number' ? message.params.tabId : undefined,
        ms: Date.now() - startedAt,
      })
      return result
    }
    case 'capabilities':
      return { ok: true, value: { writeOps: WRITE_OPS, ops: Object.keys(OPS) } }
    case 'browser-control': {
      // Runtime opt-in (ADR-12): the debugger is a required permission, but we only
      // attach when the user flips this switch; turning it off releases every attach.
      await chrome.storage.local.set({ browserControl: message.enabled === true })
      const detached = message.enabled === true ? [] : await detachAll()
      return { ok: true, value: { browserControl: message.enabled === true, detached } }
    }
    case 'state':
      return { ok: true, value: lastState }
    case 'audit':
      // The extension half of the audit trail (metadata only, newest last).
      return { ok: true, value: await readAudit() }
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
