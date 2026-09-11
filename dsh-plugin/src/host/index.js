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
import { CHANNEL, PROTOCOL_VERSION, ROUTE, validateAs } from '../shared/protocol.generated.js'
import { companionPath, dshHome } from './paths.js'
import { loadCompanionKey } from './key-store.js'
import { createGuard } from './guard.js'
import { pingRoute } from './routes/ping.js'
import { enterRoute } from './routes/enter.js'
import { whoamiRoute } from './routes/whoami.js'
import { registerWsProbe } from './routes/ws-probe.js'
import { registerWsEcho } from './routes/ws-echo.js'
import { probePageRoute } from './routes/probe-page.js'
import { ackRoute, attachRoute, pendingRoute } from './routes/attach.js'
import { ticketRoute } from './routes/ticket.js'
import { createTicketStore } from './tickets.js'
import { createStore } from './store.js'
import { createHub } from './hub.js'

export const name = 'dsh-web-companion-bridge'
export const inject = ['webServer', 'credentials']

export { PROTOCOL_VERSION }
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
    attachDir: config.attachDir ?? '网页捕获',
    attachMaxBytes: config.attachMaxBytes ?? 8 * 1024 * 1024,
    pendingLimit: config.pendingLimit ?? 32,
    defaultWorkspace: config.defaultWorkspace,
  }

  const recent = { captures: [], acks: [] }
  const store = createStore(resolved)
  const tickets = createTicketStore({ ttlMs: config.ticketTtlMs ?? 30000 })
  const hub = createHub({ log: (line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`) })

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
    liveTickets: () => tickets.liveCount,
    connectedClients: () => hub.clientCount,
    recordCapture: (event, delivered) => {
      recent.captures.push({ captureId: event.captureId, fileRef: event.fileRef, delivered, at: Date.now() })
      if (recent.captures.length > 50) recent.captures.shift()
      ctx.logger?.info?.(`[dsh-web-companion-bridge] capture ${event.captureId} → ${event.fileRef} (delivered=${String(delivered)})`)
    },
    recordAck: (payload) => {
      recent.acks.push({ ...payload, at: Date.now() })
      if (recent.acks.length > 50) recent.acks.shift()
      ctx.logger?.info?.(`[dsh-web-companion-bridge] ack ${payload.captureId} = ${payload.status}`)
    },
    recent,
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
      path: ROUTE.ping,
      // also refresh: the pairing file can be (re)written after this process booted
      handler: withPairing(pingRoute({ state, protocolVersion: PROTOCOL_VERSION })),
    }),
    `dsh-web-companion-bridge: GET ${ROUTE.ping}`,
  )

  // M0a measurement endpoints: they report what the browser actually sent
  // (cookie presence per request form), so Q1/Q2 can be answered with data.
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.whoami,
      handler: withPairing(whoamiRoute({ state })),
    }),
    `dsh-web-companion-bridge: GET ${ROUTE.whoami}`,
  )

  ctx.effect(
    () => ctx.webServer.registerUpgrade({
      path: ROUTE.whoami.replace('/whoami', '/wsecho'),
      handler: registerWsEcho(),
    }),
    'dsh-web-companion-bridge: WS /ag/wsecho',
  )

  // --- context channel: captures land on disk, then get pushed ---
  ctx.effect(
    () => ctx.webServer.registerUpgrade({
      path: CHANNEL.client,
      handler: (req, socket, head) => {
        if (!state.guard().checkClient(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        hub.upgradeClient(req, socket, head)
      },
    }),
    `dsh-web-companion-bridge: WS ${CHANNEL.client}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.ticket,
      handler: withPairing(ticketRoute({ state, tickets })),
    }),
    `dsh-web-companion-bridge: POST ${ROUTE.ticket}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.attach,
      handler: withPairing(attachRoute({ state, store, hub, config: resolved })),
    }),
    `dsh-web-companion-bridge: POST ${ROUTE.attach}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.pending,
      handler: withPairing(pendingRoute({ state, store })),
    }),
    `dsh-web-companion-bridge: GET ${ROUTE.pending}`,
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.ack,
      handler: withPairing(ackRoute({ state })),
    }),
    `dsh-web-companion-bridge: POST ${ROUTE.ack}`,
  )

  ctx.effect(() => () => hub.dispose(), 'dsh-web-companion-bridge: hub dispose')

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.probePage,
      handler: probePageRoute(),
    }),
    `dsh-web-companion-bridge: GET ${ROUTE.probePage}`,
  )

  ctx.effect(
    () => ctx.webServer.registerUpgrade({
      path: ROUTE.whoami.replace('/whoami', '/wsprobe'),
      handler: registerWsProbe({ state }),
    }),
    'dsh-web-companion-bridge: WS /ag/wsprobe',
  )

  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.enter,
      handler: withPairing(enterRoute({ state, config: resolved, tickets })),
    }),
    `dsh-web-companion-bridge: GET ${ROUTE.enter}`,
  )
}
