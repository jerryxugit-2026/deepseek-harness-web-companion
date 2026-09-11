/**
 * `WS /ag/wsprobe` — M0a measurement endpoint (design Q1).
 *
 * The WebSocket handshake is where `SameSite` semantics differ from `fetch`
 * inside a `chrome-extension://` iframe. This route records the handshake's
 * `Cookie` header verbatim, completes a normal 101 upgrade, then closes — so a
 * browser can tell us, per cookie variant, whether the cookie arrived.
 */
import { WebSocketServer } from 'ws'

const server = new WebSocketServer({ noServer: true })

export function registerWsProbe({ state }) {
  return (req, socket, head) => {
    const cookie = req.headers.cookie ?? ''
    const cookieName = /(dsh-auth-[A-Za-z0-9_-]+)=/u.exec(cookie)?.[1] ?? null
    const diagnostic = {
      kind: 'wsprobe',
      origin: req.headers.origin ?? null,
      host: req.headers.host ?? null,
      secFetchSite: req.headers['sec-fetch-site'] ?? null,
      cookieHeaderPresent: cookie.length > 0,
      sessionCookiePresent: cookieName !== null,
      sessionCookieName: cookieName,
      paired: state.pairing().key !== undefined,
      at: Date.now(),
    }
    server.handleUpgrade(req, socket, head, (ws) => {
      try { ws.send(JSON.stringify(diagnostic)) } catch { /* best effort */ }
      setTimeout(() => { try { ws.close() } catch { /* already closed */ } }, 250)
    })
  }
}
