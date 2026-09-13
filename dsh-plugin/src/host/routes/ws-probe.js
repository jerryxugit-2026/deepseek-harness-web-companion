/**
 * `WS /ag/wsprobe` — M0a measurement endpoint (design Q1).
 *
 * The WebSocket handshake is where `SameSite` semantics differ from `fetch`
 * inside a `chrome-extension://` iframe. This route records the handshake's
 * `Cookie` header verbatim, completes a normal 101 upgrade, then closes — so a
 * browser can tell us, per cookie variant, whether the cookie arrived.
 */
import { WebSocketServer } from 'ws'
import { isPaired } from '../key-store.js'

const server = new WebSocketServer({ noServer: true })

/**
 * The diagnostic one handshake produces.
 *
 * Pure on purpose: the `paired` verdict here used to disagree with `/ag/ping` (this endpoint
 * said "key exists", ping said "key + trusted origin"), and that is exactly the kind of
 * difference no probe could see — the handler was untestable. Now the route only wires, and
 * `tests/unit/pairing-semantics.test.mjs` asserts both endpoints give the same answer.
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @param {import('../key-store.js').CompanionKey} pairing
 */
export function wsProbeDiagnostic(req, pairing) {
  const cookie = req.headers.cookie ?? ''
  const cookieName = /(dsh-auth-[A-Za-z0-9_-]+)=/u.exec(cookie)?.[1] ?? null
  return {
    kind: 'wsprobe',
    origin: req.headers.origin ?? null,
    host: req.headers.host ?? null,
    secFetchSite: req.headers['sec-fetch-site'] ?? null,
    cookieHeaderPresent: cookie.length > 0,
    sessionCookiePresent: cookieName !== null,
    sessionCookieName: cookieName,
    // Same verdict as /ag/ping (see key-store.js#isPaired); the parts stay available for probing.
    paired: isPaired(pairing),
    keyConfigured: pairing?.key !== undefined,
    trustedOrigins: pairing?.extensionOrigins?.length ?? 0,
    at: Date.now(),
  }
}

export function registerWsProbe({ state }) {
  return (req, socket, head) => {
    const diagnostic = wsProbeDiagnostic(req, state.pairing())
    server.handleUpgrade(req, socket, head, (ws) => {
      try { ws.send(JSON.stringify(diagnostic)) } catch { /* best effort */ }
      setTimeout(() => { try { ws.close() } catch { /* already closed */ } }, 250)
    })
  }
}
