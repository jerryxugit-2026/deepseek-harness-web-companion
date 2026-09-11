/**
 * `WS /ag/wsecho` — M0a keepalive probe (design Q8 / D10).
 *
 * A long-lived, idle-tolerant socket used to measure whether a holder survives
 * Chrome's idle policies: the MV3 service worker (expected: terminated after
 * ~30s idle, taking the socket with it) versus an extension *document* such as
 * the side panel (expected: unaffected).
 */
import { WebSocketServer } from 'ws'

const server = new WebSocketServer({ noServer: true })

export function registerWsEcho() {
  return (req, socket, head) => {
    server.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ kind: 'wsecho-hello', at: Date.now(), origin: req.headers.origin ?? null }))
      ws.on('message', (data) => { try { ws.send(String(data)) } catch { /* peer gone */ } })
      ws.on('error', () => { /* ignore */ })
    })
  }
}
