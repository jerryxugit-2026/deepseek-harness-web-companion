/**
 * `GET /ag/enter` — authentication handshake for the embedded client.
 *
 * Assigned to the side panel's iframe `src` (or a popup window URL). Mints the
 * DSH session cookie for this request authority with `SameSite=None; Secure`,
 * then 303s to `/` so the key leaves the address bar and never reaches the
 * referrer of later requests.
 */
import { mintSessionCookie } from '../cookie.js'

export function enterRoute({ state, config, tickets }) {
  return async (req, res) => {
    // Preferred: a single-use ticket (`?ticket=`). Fallback: the pairing key
    // (`?key=`), kept for probes and for the manual-token degraded path.
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const ticket = url.searchParams.get('ticket')
    const viaTicket = ticket !== null
    const authorized = viaTicket ? tickets.consume(ticket) : state.guard().checkNavigation(req)
    if (!authorized) return forbidden(res)
    const authority = req.headers.host
    if (typeof authority !== 'string' || authority === '') return forbidden(res)

    const minted = await mintSessionCookie({
      credentials: state.credentials,
      authority,
      maxAgeDays: config.cookieMaxAgeDays,
      partitioned: config.cookieMode === 'partitioned',
    })
    if ('error' in minted) {
      res.writeHead(409, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: { code: minted.error, message: 'session signing secret unavailable' } }))
      return
    }

    res.writeHead(303, {
      'cache-control': 'no-store',
      'location': '/',
      'referrer-policy': 'no-referrer',
      'set-cookie': minted.header,
    })
    res.end()
  }
}

function forbidden(res) {
  res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
  res.end('forbidden')
}
