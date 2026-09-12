/**
 * WebSocket hub (design docs/03 §5).
 *
 * Two channels, deliberately separate:
 *   - `/ag/client` is spoken by the DSH page's client half (attach pushes,
 *     intent events, acks);
 *   - `/ag/agent` is spoken by the extension half (capture requests now,
 *     browser tool calls at M3).
 *
 * `onAgentConnect` runs the moment an agent socket appears, which is what makes
 * a 「看左边」intent survive a closed side panel: the intent is queued in the
 * plugin and replayed on the next connect.
 *
 * Request/response (`callAgent`) also lives here: the hub owns the sockets, so it
 * owns the correlation table, the timeouts, and the rule that a disconnect fails
 * every in-flight call immediately instead of letting each one wait out its clock.
 *
 * Connection state lives here; routes never touch sockets directly. Idle
 * sockets are heartbeated, and every in-flight request is failed immediately on
 * disconnect instead of waiting for its timeout.
 */
import { WebSocketServer } from 'ws'

const HEARTBEAT_MS = 20000
const OFFLINE_AFTER_MS = 30000

export function createHub({
  log = () => {},
  onClientFrame = () => {},
  onAgentFrame = () => {},
  onAgentConnect = () => {},
} = {}) {
  const servers = { client: new WebSocketServer({ noServer: true }), agent: new WebSocketServer({ noServer: true }) }
  const sockets = { client: new Set(), agent: new Set() }
  /** id → { resolve, reject, timer, tool, startedAt } for in-flight agent calls. */
  const inflight = new Map()
  let callSeq = 0
  const heartbeat = setInterval(() => {
    for (const channel of ['client', 'agent']) {
      for (const entry of sockets[channel]) {
        if (Date.now() - entry.lastSeen > OFFLINE_AFTER_MS) {
          log(`hub: ${channel} peer timed out`)
          try { entry.ws.terminate() } catch { /* already gone */ }
          continue
        }
        try { entry.ws.send(JSON.stringify({ type: 'ping' })) } catch { /* peer gone */ }
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  const attach = (channel) => (req, socket, head) => {
    servers[channel].handleUpgrade(req, socket, head, (ws) => {
      const entry = { ws, lastSeen: Date.now(), id: `client:${Math.random().toString(16).slice(2, 6)}`, inflight: new Set() }
      sockets[channel].add(entry)
      log(`hub: ${channel} peer connected (${String(sockets[channel].size)})`)
      // first thing after a peer appears: hand it whatever it missed
      if (channel === 'agent') { try { onAgentConnect(entry) } catch { /* listener must not kill the socket */ } }
      ws.on('message', (data) => {
        entry.lastSeen = Date.now()
        const text = String(data)
        if (text.includes('"pong"')) return
        try { log(`hub: ${channel} ← ${text.slice(0, 160)}`) } catch { /* ignore */ }
        let frame
        try {
          frame = JSON.parse(text)
        } catch { return /* not JSON */ }
        // A tool result settles its own promise here — correlation belongs to the
        // socket owner, not to the caller, so a disconnect can fail the whole set.
        if (channel === 'agent' && frame?.type === 'tool-result' && typeof frame.id === 'string' && inflight.has(frame.id)) {
          settle(frame.id, frame)
          return
        }
        if (channel === 'client') onClientFrame(frame, entry)
        else onAgentFrame(frame, entry)
      })
      ws.on('error', () => { sockets[channel].delete(entry) })
    })
  }

  /** Fan one event out to a channel's sockets, pruning the dead ones. */
  const pushTo = (channel, event) => {
    const text = JSON.stringify(event)
    let delivered = 0
    for (const entry of [...sockets[channel]]) {
      try {
        entry.ws.send(text)
        delivered += 1
      } catch {
        sockets[channel].delete(entry)
      }
    }
    return delivered
  }

  /** Settle one in-flight call from its tool-result frame. */
  const settle = (id, frame) => {
    const pending = inflight.get(id)
    if (pending === undefined) return
    inflight.delete(id)
    pending.entry?.inflight.delete(id)
    clearTimeout(pending.timer)
    const elapsedMs = Date.now() - pending.startedAt
    log(`hub: agent call ${pending.tool} ${frame.ok === true ? 'ok' : `failed (${String(frame.error?.code ?? '?')})`} in ${String(elapsedMs)}ms`)
    pending.resolve({ ...frame, elapsedMs })
  }

  return {
    upgradeClient: attach('client'),
    upgradeAgent: attach('agent'),
    get clientCount() { return sockets.client.size },
    get agentCount() { return sockets.agent.size },

    /** Broadcast an event to the DSH page halves; returns how many accepted it. */
    push(event) {
      return pushTo('client', event)
    },

    /** Broadcast an event to the extension (browser-tool / capture requests). */
    pushAgent(event) {
      return pushTo('agent', event)
    },

    /**
     * Send one `tool-call` to the extension and await its `tool-result`.
     *
     * The first connected agent socket serves the call (a second panel would be a
     * second user decision) — but *every* in-flight call belongs to that socket, so
     * its disconnect fails them all at once with `E_EXT_OFFLINE`.
     *
     * @param {{tool: string, params?: object, allowWrite?: boolean}} request
     * @param {{timeoutMs?: number}} [options]
     */
    callAgent(request, options = {}) {
      const entry = [...sockets.agent][0]
      if (entry === undefined) {
        return Promise.reject(Object.assign(new Error('no browser extension is connected (open the side panel)'), { code: 'E_EXT_OFFLINE' }))
      }
      callSeq += 1
      const id = `tool-${Date.now().toString(36)}-${String(callSeq)}`
      const timeoutMs = options.timeoutMs ?? 15000
      const frame = {
        type: 'tool-call',
        protocolVersion: options.protocolVersion ?? 1,
        id,
        tool: request.tool,
        params: request.params ?? {},
        ...(request.allowWrite === true ? { allowWrite: true } : {}),
      }
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          inflight.delete(id)
          entry.inflight.delete(id)
          reject(Object.assign(new Error(`extension did not answer ${request.tool} within ${String(timeoutMs)}ms`), { code: 'E_TIMEOUT' }))
        }, timeoutMs)
        timer.unref?.()
        inflight.set(id, { resolve, reject, timer, entry, tool: request.tool, startedAt: Date.now() })
        entry.inflight.add(id)
        try {
          entry.ws.send(JSON.stringify(frame))
        } catch (error) {
          inflight.delete(id)
          entry.inflight.delete(id)
          clearTimeout(timer)
          sockets.agent.delete(entry)
          reject(Object.assign(new Error(`could not reach the extension: ${String(error?.message ?? error)}`), { code: 'E_EXT_OFFLINE' }))
        }
      })
    },

    /** In-flight calls (diagnostics). */
    get inflightCount() { return inflight.size },

    dispose() {
      clearInterval(heartbeat)
      for (const channel of ['client', 'agent']) {
        for (const entry of sockets[channel]) { try { entry.ws.close() } catch { /* ignore */ } }
        sockets[channel].clear()
      }
    },
  }
}
