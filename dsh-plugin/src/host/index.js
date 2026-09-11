/**
 * Antigravity Web Companion — DSH host bridge plugin (M1 scope).
 *
 * Loaded into the `web` profile as a plugin row. Responsibilities at M1:
 *   1. register `/ag/ping` (liveness + pairing state) and `/ag/enter` (mint a
 *      `SameSite=None; Secure` session cookie so a `chrome-extension://`
 *      iframe can authenticate and open its event stream);
 *   2. keep the pairing state (shared key + trusted extension origins) fresh.
 *
 * Later milestones add `/ag/attach`, `/ag/pending`, `/ag/ack` and the two
 * WebSocket channels (`/ag/agent`, `/ag/client`) — see docs/03-bridge-plugin.md.
 */
import { companionPath, dshHome } from './paths.js'
import { loadCompanionKey } from './key-store.js'
import { createGuard } from './guard.js'
import { pingRoute } from './routes/ping.js'
import { enterRoute } from './routes/enter.js'

export const name = 'dsh-web-companion-bridge'
export const inject = ['webServer', 'credentials']

export const PROTOCOL_VERSION = 1
export const PLUGIN_VERSION = '0.1.0'

/** How long a loaded pairing file is trusted before it is re-read. */
const PAIRING_TTL_MS = 5000

/**
 * @param {object} ctx cordis context
 * @param {object} [config] plugin config (docs/03 §2)
 */
export function apply(ctx, config = {}) {
  const resolved = {
    cookieMaxAgeDays: config.cookieMaxAgeDays ?? 30,
    cookieMode: config.cookieMode ?? 'none-secure',
    keyFile: config.keyFile ?? companionPath(),
  }

  let pairing = { key: undefined, extensionOrigins: [], source: resolved.keyFile, error: undefined }
  let loadedAt = 0
  let guard = createGuard(pairing)

  /** Throttled re-read of the pairing file; the guard always reflects it. */
  const refresh = async () => {
    if (Date.now() - loadedAt < PAIRING_TTL_MS) return pairing
    pairing = await loadCompanionKey(resolved.keyFile)
    loadedAt = Date.now()
    guard = createGuard(pairing)
    return pairing
  }

  const state = {
    pluginVersion: PLUGIN_VERSION,
    pairing: () => pairing,
    guard: () => guard,
    credentials: ctx.credentials,
    dshHome: dshHome(),
    port: () => ctx.webServer?.port,
    capabilities: () => [],
  }

  /** Every guarded route re-reads the pairing first (cheap, throttled). */
  const withPairing = (fn) => async (req, res) => {
    await refresh()
    return fn(req, res)
  }

  ctx.effect(() => {
    void (async () => {
      await refresh()
      ctx.logger?.info?.(
        `[dsh-web-companion-bridge] ${PLUGIN_VERSION} on port ${String(state.port() ?? '?')}; ` +
        `paired=${String(pairing.key !== undefined && pairing.extensionOrigins.length > 0)} ` +
        `origins=${String(pairing.extensionOrigins.length)} source=${resolved.keyFile}` +
        (pairing.error === undefined ? '' : ` error=${pairing.error}`),
      )
    })()
    return () => {}
  }, 'dsh-web-companion-bridge: pairing')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/ag/ping',
      // also refresh: the pairing file can be (re)written after this process booted
      handler: withPairing(pingRoute({ state, protocolVersion: PROTOCOL_VERSION })),
    }),
    'dsh-web-companion-bridge: GET /ag/ping',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: '/ag/enter',
      handler: withPairing(enterRoute({ state, config: resolved })),
    }),
    'dsh-web-companion-bridge: GET /ag/enter',
  )
}
