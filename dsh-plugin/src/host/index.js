/**
 * Antigravity Web Companion — DSH host bridge plugin (M1 scope).
 *
 * Loaded into the `web` profile as a plugin row. Responsibilities at M1:
 *   1. register `/ag/ping` (liveness + pairing state) and `/ag/enter` (mint a
 *      `SameSite=None; Secure` session cookie so a `chrome-extension://`
 *      iframe can authenticate and open its event stream);
 *   2. keep the pairing state (shared key + trusted extension origins) fresh.
 *
 * `/ag/attach`, `/ag/pending` and `/ag/ack` land captures on disk; `/ag/client`
 * is spoken by the DSH page's client half (attach pushes, intents, acks) and
 * `/ag/agent` by the extension, which is what closes the 「看左边」loop: the page
 * sniffs the intent, the plugin relays it as a capture request — see
 * docs/03-bridge-plugin.md.
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
    attachSessionMode: config.attachSessionMode ?? 'new',
    // 0 (or negative) disables the sweep; see docs/03 §7 and host/retention.js
    retentionHours: config.retentionHours ?? 24,
    log: (line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`),
    intentEnabled: config.intentEnabled ?? true,
    intentCaptureMode: config.intentCaptureMode ?? 'page',
  }

  const recent = { captures: [], acks: [] }
  const store = createStore(resolved)
  const tickets = createTicketStore({ ttlMs: config.ticketTtlMs ?? 30000 })
  /** Last workspace a connected DSH page announced — the default capture target. */
  const clientFacts = { workspace: undefined, sessionId: undefined }
  const hub = createHub({
    log: (line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`),
    onClientFrame: (frame) => {
      if (frame?.type === 'hello') {
        if (typeof frame.workspace === 'string' && frame.workspace !== '') clientFacts.workspace = frame.workspace
        if (typeof frame.sessionId === 'string') clientFacts.sessionId = frame.sessionId
        ctx.logger?.info?.(`[dsh-web-companion-bridge] client hello session=${String(frame.sessionId ?? '?').slice(0, 14)} workspace=${String(clientFacts.workspace ?? '(none)').slice(-28)}`)
        return
      }
      // 「看左边」: the DSH page sniffs the composer and asks us to fetch the page.
      if (frame?.type === 'intent') relayIntent(frame)
    },
    // The panel was closed when the intent arrived → deliver it now.
    onAgentConnect: () => {
      const queued = store.drainIntents()
      if (queued.length === 0) return
      const delivered = hub.pushAgent({ ...queued[queued.length - 1], reason: 'queued' })
      ctx.logger?.info?.(`[dsh-web-companion-bridge] replayed ${String(queued.length)} queued intent(s) → ${String(delivered)} agent socket(s)`)
    },
    onAgentFrame: (frame) => {
      if (frame?.type !== 'capture-result') return
      const validated = validateAs('CaptureResultEvent', frame)
      if (!validated.ok) {
        ctx.logger?.warn?.(`[dsh-web-companion-bridge] capture-result rejected: ${validated.error.message}`)
        return
      }
      state.recordCaptureResult(frame)
    },
  })

  /**
   * Turn a client 「看左边」intent into a capture request for the extension.
   *
   * Sniffing deliberately lives in the DSH page's client half (ADR-11): the
   * extension never reads the composer. The request is queued when no panel is
   * connected, so the intent is not lost — it is replayed by `onAgentConnect`.
   */
  let intentSeq = 0
  const relayIntent = (frame) => {
    if (resolved.intentEnabled !== true) {
      ctx.logger?.info?.('[dsh-web-companion-bridge] intent ignored (intentEnabled=false)')
      return
    }
    const validated = validateAs('ClientIntentEvent', frame)
    if (!validated.ok) {
      ctx.logger?.warn?.(`[dsh-web-companion-bridge] intent rejected: ${validated.error.message}`)
      return
    }
    intentSeq += 1
    const event = {
      type: 'capture-request',
      protocolVersion: PROTOCOL_VERSION,
      requestId: `int-${Date.now().toString(36)}-${String(intentSeq)}`,
      mode: resolved.intentCaptureMode,
      reason: 'look-left',
      ...(frame.sessionId === undefined ? {} : { sessionId: frame.sessionId }),
      ...(frame.draft === undefined ? {} : { draft: frame.draft }),
      at: Date.now(),
    }
    if (hub.agentCount > 0) {
      ctx.logger?.info?.(`[dsh-web-companion-bridge] intent → extension ${event.requestId} (${String(hub.pushAgent(event))} socket(s))`)
      return
    }
    store.enqueueIntent(event)
    ctx.logger?.info?.(`[dsh-web-companion-bridge] intent queued ${event.requestId} (no panel connected, queue=${String(store.intentCount)})`)
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
    liveTickets: () => tickets.liveCount,
    connectedClients: () => hub.clientCount,
    connectedAgents: () => hub.agentCount,
    queuedIntents: () => store.intentCount,
    recordCaptureResult: (frame) => {
      ctx.logger?.info?.(
        `[dsh-web-companion-bridge] capture-result ${frame.requestId} ok=${String(frame.ok)}` +
        (frame.fileRef === undefined ? '' : ` → ${frame.fileRef}`) +
        (frame.error === undefined ? '' : ` error=${frame.error.code ?? '?'} ${frame.error.message ?? ''}`),
      )
    },
    clientWorkspace: () => clientFacts.workspace,
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
      handler: withPairing(attachRoute({
        state,
        store,
        hub,
        config: resolved,
        resolveWorkspace: () => clientFacts.workspace ?? resolved.defaultWorkspace,
      })),
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

  // --- agent channel: the extension half (capture requests now, tools at M3) ---
  ctx.effect(
    () => ctx.webServer.registerUpgrade({
      path: CHANNEL.agent,
      handler: (req, socket, head) => {
        if (!state.guard().checkUpgrade(req)) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
          socket.destroy()
          return
        }
        hub.upgradeAgent(req, socket, head)
      },
    }),
    `dsh-web-companion-bridge: WS ${CHANNEL.agent}`,
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
