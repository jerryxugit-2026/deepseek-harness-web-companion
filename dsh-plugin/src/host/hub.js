/**
 * WebSocket hub (design docs/03 §5).
 *
 * Two channels, deliberately separate:
 *   - `/ag/client` is spoken by the DSH page's client half (attach pushes,
 *     intent events, acks);
 *   - `/ag/agent` is spoken by the extension (browser tool calls; M3).
 *
 * Connection state lives here; routes never touch sockets directly. Idle
 * sockets are heartbeated, and every in-flight request is failed immediately on
 * disconnect instead of waiting for its timeout.
 */
import { WebSocketServer } from 'ws'

const HEARTBEAT_MS = 20000
const OFFLINE_AFTER_MS = 30000

export function createHub({ log = () => {} } = {}) {
  const servers = { client: new WebSocketServer({ noServer: true }), agent: new WebSocketServer({ noServer: true }) }
  const sockets = { client: new Set(), agent: new Set() }
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
      const entry = { ws, lastSeen: Date.now(), id: `client:${Math.random().toString(16).slice(2, 6)}` }
      sockets[channel].add(entry)
      log(`hub: ${channel} peer connected (${String(sockets[channel].size)})`)
      ws.on('message', (data) => {
        entry.lastSeen = Date.now()
        const text = String(data)
        if (text.includes('"pong"')) return
        try { log(`hub: ${channel} ← ${text.slice(0, 160)}`) } catch { /* ignore */ }
      })
      ws.on('close', () => { sockets[channel].delete(entry); log(`hub: ${channel} peer closed (${String(sockets[channel].size)})`) })
      ws.on('error', () => { sockets[channel].delete(entry) })
    })
  }

  return {
    upgradeClient: attach('client'),
    upgradeAgent: attach('agent'),
    get clientCount() { return sockets.client.size },

    /** Broadcast an event; returns how many sockets accepted it. */
    push(event) {
      const text = JSON.stringify(event)
      let delivered = 0
      for (const entry of [...sockets.client]) {
        try { entry.ws.send(text); delivered += 1 } catch { sockets.client.delete(entry) }
      }
      return delivered
    },

    dispose() {
      clearInterval(heartbeat)
      for (const channel of ['client', 'agent']) {
        for (const entry of sockets[channel]) { try { entry.ws.close() } catch { /* ignore */ } }
        sockets[channel].clear()
      }
    },
  }
}
