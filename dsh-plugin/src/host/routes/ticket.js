/**
 * `POST /ag/ticket` — exchange the pairing key for a single-use entry ticket
 * (design §5.4). Form F2: the extension page, so key + exact `Origin`.
 */
export function ticketRoute({ state, tickets }) {
  return (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    if (!state.guard().checkFetch(req)) return send(403, { ok: false, error: { code: 'E_AUTH', message: 'forbidden' } })
    const issued = tickets.issue()
    return send(200, { ok: true, ticket: issued.ticket, expiresAt: issued.expiresAt })
  }
}
