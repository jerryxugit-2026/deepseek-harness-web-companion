/**
 * `/ag/agent` channel — the extension half of the bridge (design docs/01 §4.4).
 *
 * This is what closes the 「看左边」loop: the DSH page's client half sniffs the
 * composer intent and reports it over `/ag/client`; the bridge turns it into a
 * `capture-request`; this module receives it and runs exactly the same capture
 * the Attach button runs, then answers with a `capture-result`.
 *
 * The socket lives in the *panel document*, not in the service worker: MV3
 * recycles an idle worker after ~30s, while a WebSocket held by an extension
 * document survives (measured in tests/m0a/keepalive-probe.mjs). A panel that is
 * closed therefore simply means "no agent connected" — the bridge queues the
 * intent and replays it on the next connect.
 */
import { ENUM, PROTOCOL_VERSION, validateAs } from '../lib/protocol.generated.js'
import { withinFrameBudget } from '../lib/frame-budget.js'
import { agentSocketUrl, isPaired } from '../lib/urls.js'

/**
 * Every error code that leaves this module must be in the protocol's closed set.
 *
 * The schema now enforces `error.code` against `ErrorCode` (`$ref`), and the bridge **drops a
 * frame that fails validation** — so forwarding an unknown code (a thrown DOM/chrome error can
 * carry any `code`, and a future op may invent one) would turn a diagnosable failure into a
 * silently ignored frame: the intent would never be linked to its capture, and the attach would
 * land on the wrong page half. Normalising here keeps the wire honest *and* keeps the frame.
 */
const PROTOCOL_CODES = new Set(ENUM.ErrorCode)
const wireCode = (code) => (typeof code === 'string' && PROTOCOL_CODES.has(code) ? code : 'E_INTERNAL')

const HEARTBEAT_MS = 20000
const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 30000

/**
 * @param {object} options
 * @param {(mode: string, reason: string) => Promise<object>} options.runCapture
 * @param {(line: string) => void} [options.log]
 * @param {(state: { connected: boolean, error?: string }) => void} [options.onState]
 */
export function startAgentChannel({ runCapture, log = () => {}, onState = () => {}, onFrame = () => {} }) {
  let socket
  let heartbeat
  let retry
  let delay = RECONNECT_MIN_MS
  let closed = false

  const send = (frame) => {
    if (socket?.readyState !== WebSocket.OPEN) return false
    try {
      socket.send(JSON.stringify(frame))
      return true
    } catch (error) {
      log(`send failed: ${String(error)}`)
      return false
    }
  }

  /**
   * One browser op (M3) → the service worker.
   *
   * The panel owns this socket (an idle MV3 worker is recycled), but the browser
   * APIs live in the worker, so the op is forwarded. `allowWrite` comes from the
   * bridge plugin's own switch and is enforced again in the worker.
   */
  async function handleToolCall(frame) {
    const validated = validateAs('AgentToolCall', frame)
    if (!validated.ok) {
      log(`tool-call rejected: ${validated.error.message}`)
      send({ type: 'tool-result', protocolVersion: PROTOCOL_VERSION, id: typeof frame?.id === 'string' ? frame.id : 'unknown', ok: false, error: { code: wireCode('E_PAYLOAD'), message: validated.error.message } })
      return
    }
    const started = Date.now()
    log(`tool-call ${frame.tool} (allowWrite=${String(frame.allowWrite === true)})`)
    const reply = await chrome.runtime.sendMessage({
      kind: 'op',
      tool: frame.tool,
      params: frame.params ?? {},
      allowWrite: frame.allowWrite === true,
    }).catch((error) => ({ ok: false, error: { code: 'E_INTERNAL', message: String(error?.message ?? error) } }))
    const result = reply ?? { ok: false, error: { code: 'E_INTERNAL', message: 'no response from service worker' } }
    send({
      type: 'tool-result',
      protocolVersion: PROTOCOL_VERSION,
      id: frame.id,
      ok: result.ok === true,
      ...(result.ok === true
        ? { value: withinFrameBudget(result.value) }
        : { error: { code: wireCode(result.error?.code), message: String(result.error?.message ?? 'op failed').slice(0, 600) } }),
      elapsedMs: Date.now() - started,
    })
  }

  /** One capture request → the same orchestration the buttons use. */
  async function handleCaptureRequest(frame) {
    const validated = validateAs('CaptureRequestEvent', frame)
    if (!validated.ok) {
      log(`capture-request rejected: ${validated.error.message}`)
      // Design §5.2: `capture-result` is answered **unconditionally**. Bailing out here used
      // to leave the intent with no terminal state on either side — the plugin waits for a
      // receipt that never comes, and nothing is logged where the user could see it.
      send({
        type: 'capture-result',
        protocolVersion: PROTOCOL_VERSION,
        requestId: typeof frame?.requestId === 'string' ? frame.requestId : 'unknown',
        ok: false,
        error: { code: 'E_PAYLOAD', message: validated.error.message },
        at: Date.now(),
      })
      return
    }
    // Contract note: the generated validator returns only `{ ok }` on success —
    // the validated payload IS the frame handed in (see docs/01 §6). Reading a
    // `.value` field off that result yields `undefined`, which silently killed
    // the entire intent path (v3.23); the consistency gate now bans the pattern.
    const request = frame
    log(`capture-request ${request.requestId} mode=${request.mode} reason=${String(request.reason ?? '?')}`)
    try {
      const result = await runCapture(request.mode, request.reason ?? 'look-left')
      send({
        type: 'capture-result',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: result?.ok === true,
        ...(result?.ok === true
          ? {
              captureId: result.value?.captureId,
              fileRef: result.value?.result?.fileRef,
              filePath: result.value?.result?.filePath,
            }
          : { error: { code: wireCode(result?.error?.code), message: String(result?.error?.message ?? 'capture failed') } }),
        at: Date.now(),
      })
    } catch (error) {
      send({
        type: 'capture-result',
        protocolVersion: PROTOCOL_VERSION,
        requestId: request.requestId,
        ok: false,
        error: { code: 'E_INTERNAL', message: String(error?.message ?? error) },
        at: Date.now(),
      })
    }
  }

  /** Tear the current socket down (heartbeat first, so it cannot resurrect it). */
  function close() {
    clearInterval(heartbeat)
    try { socket?.close() } catch { /* already closed */ }
  }

  function scheduleReconnect() {
    if (closed) return
    clearTimeout(retry)
    retry = setTimeout(() => { open() }, delay)
    delay = Math.min(delay * 2, RECONNECT_MAX_MS)
  }

  function open() {
    if (closed) return
    if (!isPaired()) {
      onState({ connected: false, error: 'E_UNPAIRED' })
      log('not paired: no agent channel')
      return
    }
    try {
      socket = new WebSocket(agentSocketUrl())
    } catch (error) {
      onState({ connected: false, error: String(error) })
      scheduleReconnect()
      return
    }

    socket.addEventListener('open', () => {
      delay = RECONNECT_MIN_MS
      onState({ connected: true })
      log('agent channel connected')
      send({ type: 'agent-hello', protocolVersion: PROTOCOL_VERSION, extensionVersion: chrome.runtime.getManifest().version, panel: 'sidepanel' })
      clearInterval(heartbeat)
      heartbeat = setInterval(() => { if (!send({ type: 'ping', at: Date.now() })) close() }, HEARTBEAT_MS)
    })

    socket.addEventListener('message', (event) => {
      let frame
      try {
        frame = JSON.parse(String(event.data))
      } catch {
        return
      }
      onFrame(frame)
      if (frame?.type === 'ping') { send({ type: 'pong', at: Date.now() }); return }
      if (frame?.type === 'pong') return
      if (frame?.type === 'tool-call') {
        void handleToolCall(frame).catch((error) => {
          log(`tool-call crashed: ${String(error?.message ?? error)}`)
          send({
            type: 'tool-result',
            protocolVersion: PROTOCOL_VERSION,
            id: typeof frame.id === 'string' ? frame.id : 'unknown',
            ok: false,
            error: { code: 'E_INTERNAL', message: String(error?.message ?? error) },
          })
        })
        return
      }
      if (frame?.type === 'capture-request') {
        // Never die silently: a handler bug must still answer the bridge, or the
        // DSH page waits forever for a capture that will never come.
        void handleCaptureRequest(frame).catch((error) => {
          log(`capture-request crashed: ${String(error?.message ?? error)}`)
          send({
            type: 'capture-result',
            protocolVersion: PROTOCOL_VERSION,
            requestId: typeof frame.requestId === 'string' ? frame.requestId : 'unknown',
            ok: false,
            error: { code: 'E_INTERNAL', message: String(error?.message ?? error) },
            at: Date.now(),
          })
        })
      }
    })

    socket.addEventListener('close', () => {
      clearInterval(heartbeat)
      onState({ connected: false })
      log('agent channel closed; retrying')
      scheduleReconnect()
    })
    socket.addEventListener('error', () => { onState({ connected: false, error: 'E_WS' }) })
  }

  return {
    start() { closed = false; open() },
    stop() { closed = true; clearInterval(heartbeat); clearTimeout(retry); try { socket?.close() } catch { /* ignore */ } },
    get connected() { return socket?.readyState === WebSocket.OPEN },
  }
}
