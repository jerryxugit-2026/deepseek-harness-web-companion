/**
 * `GET /ag/ping` — liveness, protocol version, pairing state and capabilities.
 *
 * This route is intentionally NOT key-guarded: the extension uses it to decide
 * whether DSH is up, whether the bridge plugin is loaded, and whether the
 * pairing file still needs to be provisioned. It discloses no secrets.
 */
export function pingRoute({ state, protocolVersion }) {
  return (_req, res) => {
    const pairing = state.pairing()
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify({
      ok: true,
      protocolVersion,
      plugin: 'dsh-web-companion-bridge',
      pluginVersion: state.pluginVersion,
      keyConfigured: pairing.key !== undefined,
      paired: pairing.key !== undefined && pairing.extensionOrigins.length > 0,
      trustedOrigins: pairing.extensionOrigins.length,
      pairingSource: pairing.source,
      pairingError: pairing.error,
      dsh: { home: state.dshHome, port: state.port() },
      capabilities: state.capabilities(),
    }))
  }
}
