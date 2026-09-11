/**
 * `GET /ag/ping` — liveness, protocol version, pairing state and capabilities.
 *
 * This route is intentionally NOT key-guarded: the extension uses it to decide
 * whether DSH is up, whether the bridge plugin is loaded, and whether the
 * pairing file still needs to be provisioned. It discloses no secrets.
 */
import { validateAs } from '../../shared/protocol.generated.js'

export function pingRoute({ state, protocolVersion }) {
  return (_req, res) => {
    const pairing = state.pairing()
    const payload = {
      ok: true,
      protocolVersion,
      plugin: 'dsh-web-companion-bridge',
      pluginVersion: state.pluginVersion,
      keyConfigured: pairing.key !== undefined,
      paired: pairing.key !== undefined && pairing.extensionOrigins.length > 0,
      trustedOrigins: pairing.extensionOrigins.length,
      pairingSource: pairing.source,
      // always a string|null: the schema is closed, and an omitted optional
      // field must still be explicit rather than `undefined`
      pairingError: pairing.error ?? null,
      dsh: { home: state.dshHome, port: state.port() },
      capabilities: state.capabilities(),
      liveTickets: typeof state.liveTickets === 'function' ? state.liveTickets() : undefined,
    }
    // Fail loudly on drift: a payload the schema rejects must never ship.
    const validated = validateAs('PingResponse', payload)
    if (!validated.ok) {
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: `ping payload violates schema: ${validated.error.message}` } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
}
