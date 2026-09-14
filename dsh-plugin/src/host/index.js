/**
 * DSH Web Companion — DSH host bridge plugin (M1 scope).
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
import { auditPath } from './paths.js'
import { loadCompanionKey } from './key-store.js'
import { createGuard } from './guard.js'
import { pingRoute } from './routes/ping.js'
import { enterRoute } from './routes/enter.js'
import { whoamiRoute } from './routes/whoami.js'
import { registerWsProbe } from './routes/ws-probe.js'
import { registerWsEcho } from './routes/ws-echo.js'
import { probePageRoute } from './routes/probe-page.js'
import { ackRoute, attachRoute, pendingRoute } from './routes/attach.js'
import { isPaired } from './key-store.js'
import { createPendingDelivery } from './pending.js'
import { ticketRoute } from './routes/ticket.js'
import { controlRoute } from './routes/control.js'
import { createWriteGate } from './approval.js'
import { createTicketStore } from './tickets.js'
import { createStore } from './store.js'
import { createAuditLog } from './audit.js'
import { createHub } from './hub.js'
import { registerBrowserTools } from './tools.js'

export const name = 'dsh-web-companion-bridge'
export const inject = ['webServer', 'credentials', 'tools']

export { PROTOCOL_VERSION }
export const PLUGIN_VERSION = '3.48.1'

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
    // 面向**模型**的文案语言（工具 description / 字段说明 / 错误提示）：宿主没有
    // chrome.i18n，所以由插件自带的表（host/model-text.js）按这个值取词。
    locale: config.locale ?? 'en',
    attachMaxBytes: config.attachMaxBytes ?? 8 * 1024 * 1024,
    pendingLimit: config.pendingLimit ?? 32,
    defaultWorkspace: config.defaultWorkspace,
    attachSessionMode: config.attachSessionMode ?? 'new',
    toolTimeoutMs: config.toolTimeoutMs ?? 10000,
    approvalForWriteOps: config.approvalForWriteOps !== false,
    allowBrowserWriteOps: config.allowBrowserWriteOps === true,
    // 0 (or negative) disables the sweep; see docs/03 §7 and host/retention.js
    retentionHours: config.retentionHours ?? 24,
    log: (line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`),
    intentEnabled: config.intentEnabled ?? true,
    intentCaptureMode: config.intentCaptureMode ?? 'page',
    // Metadata-only audit trail (docs: audit.js). On by default: it is the artifact
    // that makes "what fired this capture?" answerable after the fact, and it holds
    // no page content, no URL and no key.
    auditLog: config.auditLog !== false,
    auditFile: config.auditFile ?? auditPath(),
    auditMaxBytes: config.auditMaxBytes ?? 512 * 1024,
  }

  const connLogger = (line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`)
  const recent = { captures: [], acks: [] }
  const store = createStore(resolved)
  const audit = resolved.auditLog
    ? createAuditLog({ file: resolved.auditFile, maxBytes: resolved.auditMaxBytes, log: connLogger })
    : { file: null, enabled: false, append: () => false, read: () => [] }
  if (audit.enabled) connLogger(`audit trail: ${String(audit.file)}`)
  const tickets = createTicketStore({ ttlMs: config.ticketTtlMs ?? 30000 })
  /** Last workspace a connected DSH page announced — the default capture target. */
  const clientFacts = { workspace: undefined, sessionId: undefined }
  /** What the extension last announced about itself (`agent-hello`) — diagnostics only. */
  let agentFacts = { version: undefined, panel: undefined, at: 0 }
  const hub = createHub({
    log: (line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`),
    onClientFrame: (frame, entry) => {
      if (frame?.type === 'hello') {
        if (typeof frame.workspace === 'string' && frame.workspace !== '') clientFacts.workspace = frame.workspace
        if (typeof frame.sessionId === 'string') clientFacts.sessionId = frame.sessionId
        ctx.logger?.info?.(`[dsh-web-companion-bridge] client hello session=${String(frame.sessionId ?? '?').slice(0, 14)} workspace=${String(clientFacts.workspace ?? '(none)').slice(-28)} embedded=${String(frame.embedded ?? '?')} visible=${String(frame.visible ?? '?')} focused=${String(frame.focused ?? '?')}`)
        return
      }
      // The page half asks for whatever it missed while it was not open (design §4.2).
      if (frame?.type === 'request-pending') { deliverPending(entry); return }
      // What the page half DID with the capture it received (`ClientAckEvent`, design §4.2).
      //
      // The client half has been sending this since v3.38 and the host had **no handler** — the same
      // class of gap as `request-pending` / `agent-hello`: a frame with a producer and no consumer.
      // The cost is durable evidence: `recordAck` writes the audit line (`kind:"ack"`, `status`) and the
      // audit's own field list documents `status` for exactly this, yet a whole day of real captures left
      // **0** ack entries (measured 2026-09-12) — so "did the reference actually land in the composer?"
      // was unanswerable after the fact.
      if (frame?.type === 'ack') {
        const validated = validateAs('ClientAckEvent', frame)
        if (validated.ok) state.recordAck(frame)
        else ctx.logger?.warn?.(`[dsh-web-companion-bridge] ack rejected: ${validated.error.message}`)
        return
      }
      // 「看左边」: the DSH page sniffs the composer and asks us to fetch the page.
      if (frame?.type === 'intent') relayIntent(frame, entry)
    },
    // The panel was closed when the intent arrived → deliver it now.
    onAgentConnect: () => {
      const queued = store.drainIntents()
      if (queued.length === 0) return
      const last = queued[queued.length - 1]
      const delivered = hub.pushAgent({ ...last, reason: 'queued' })
      // Only the LAST intent is replayed (design §5.2 deliberately avoids replaying a backlog of
      // stale captures). The old line claimed `replayed ${queued.length}` — a log that lied about
      // behaviour, with the dropped ones leaving no trace at all.
      ctx.logger?.info?.(
        `[dsh-web-companion-bridge] replayed 1/${String(queued.length)} queued intent(s) → ${String(delivered)} agent socket(s)` +
        (queued.length > 1 ? ` (dropped ${String(queued.length - 1)} stale)` : ''),
      )
      audit.append({ kind: 'intent-replay', requestId: last.requestId, delivered })
    },
    onAgentFrame: (frame) => {
      // `agent-hello` had a producer (the panel sends it on every (re)connect) and no handler —
      // the same class of gap as `request-pending`. It is the only place the extension's build
      // version reaches the host, which is exactly what diagnosing a *stale build* needs, so
      // record it instead of dropping it on the floor.
      if (frame?.type === 'agent-hello') {
        agentFacts = { version: frame.extensionVersion, panel: frame.panel, at: Date.now() }
        ctx.logger?.info?.(`[dsh-web-companion-bridge] agent hello ext=${String(frame.extensionVersion ?? '?')} panel=${String(frame.panel ?? '?')}`)
        return
      }
      if (frame?.type !== 'capture-result') return
      const validated = validateAs('CaptureResultEvent', frame)
      if (!validated.ok) {
        ctx.logger?.warn?.(`[dsh-web-companion-bridge] capture-result rejected: ${validated.error.message}`)
        return
      }
      // The extension answers the intent's capture with BOTH ids, which is the only
      // place the two are correlated: remember who asked, so the attach can go home.
      if (validated.ok === true && typeof frame.captureId === 'string') {
        linkCaptureToIntent(frame.captureId, frame.requestId)
      }
      state.recordCaptureResult(frame)
    },
  })

  /**
   * Hand the capture backlog to the page half that just asked for it.
   *
   * The client half sends `{type:'request-pending'}` on **every** (re)connect (design §4.2),
   * and the host had no handler for that frame: a capture taken while no DSH page was open
   * landed on disk, was queued by `attachRoute` (`deliveredTo: []`), and then sat in the
   * queue forever. `GET /ag/pending` existed but nothing ever called it — the backlog was
   * **write-only**, and the only symptom was a capture the user never saw.
   *
   * The delivery rules (owner binding, re-queue when nobody can take the frame) live in
   * `host/pending.js`: the failure branch is the one that decides whether a capture survives
   * or is silently dropped, and it is unreachable from the probes.
   */
  const deliverPending = createPendingDelivery({ hub, store, audit, log: connLogger })

  /**
   * Turn a client 「看左边」intent into a capture request for the extension.
   *
   * Sniffing deliberately lives in the DSH page's client half (ADR-11): the
   * extension never reads the composer. The request is queued when no panel is
   * connected, so the intent is not lost — it is replayed by `onAgentConnect`.
   */
  let intentSeq = 0

  /**
   * Last intent we relayed, for host-side de-duplication.
   *
   * The client half's episode logic is **per page** (a closure inside each React app), and a
   * user normally has two page halves sniffing the *same* shared composer draft — so both
   * can fire an intent for one 「看左边」 and produce two captures. The host sees both
   * requests and is the only place that can collapse them, so it does: same session + same
   * draft within a short window ⇒ one relay.
   */
  let lastIntent = { key: '', at: 0 }
  const INTENT_DEDUPE_MS = 5000

  /**
   * Which page half asked for which capture.
   *
   * Two page halves are normal — the DSH GUI in a normal tab **and** the DSH GUI embedded
   * in the side panel's iframe — and a capture must not be handed to the wrong one:
   * `sessionMode: 'current'` inserts into "the current session" *as that page half sees
   * it*. So the origin is tracked end to end: intent → requestId →
   * (the extension's `capture-result` carries both ids) → captureId → attach.
   */
  const intentOwners = new Map()   // requestId → { clientId, at }
  const captureOwners = new Map()  // captureId → { clientId, at }
  const OWNER_TTL_MS = 5 * 60 * 1000
  const pruneOwners = () => {
    const cutoff = Date.now() - OWNER_TTL_MS
    for (const [key, value] of intentOwners) { if (value.at < cutoff) intentOwners.delete(key) }
    for (const [key, value] of captureOwners) { if (value.at < cutoff) captureOwners.delete(key) }
  }
  const rememberIntentOwner = (requestId, entry) => {
    pruneOwners()
    if (typeof entry?.id === 'string') intentOwners.set(requestId, { clientId: entry.id, at: Date.now() })
  }
  const linkCaptureToIntent = (captureId, requestId) => {
    const owner = typeof requestId === 'string' ? intentOwners.get(requestId) : undefined
    if (owner === undefined) return
    intentOwners.delete(requestId)
    captureOwners.set(captureId, { clientId: owner.clientId, at: Date.now() })
  }
  /** Read-and-forget: the owner is only needed for the one attach that follows. */
  const takeCaptureOwner = (captureId) => {
    const owner = captureOwners.get(captureId)
    if (owner === undefined) return undefined
    captureOwners.delete(captureId)
    return owner.clientId
  }

  const relayIntent = (frame, entry) => {
    if (resolved.intentEnabled !== true) {
      ctx.logger?.info?.('[dsh-web-companion-bridge] intent ignored (intentEnabled=false)')
      return
    }
    const validated = validateAs('ClientIntentEvent', frame)
    if (!validated.ok) {
      ctx.logger?.warn?.(`[dsh-web-companion-bridge] intent rejected: ${validated.error.message}`)
      return
    }
    // Collapse the same 「看左边」 arriving from TWO page halves (see lastIntent).
    const clientId = typeof entry?.id === 'string' ? entry.id : undefined
    const intentKey = `${String(frame.sessionId ?? '')}\u0000${String(frame.draft ?? '')}`
    const intentAt = Date.now()
    if (
      intentKey === lastIntent.key &&
      clientId !== undefined &&
      lastIntent.clientId !== undefined &&
      clientId !== lastIntent.clientId &&          // ← 必须来自**另一个**页面半才算重复
      intentAt - lastIntent.at < INTENT_DEDUPE_MS
    ) {
      ctx.logger?.info?.('[dsh-web-companion-bridge] intent de-duplicated (same session+draft from another page half)')
      return
    }
    lastIntent = { key: intentKey, clientId, at: intentAt }
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
    rememberIntentOwner(event.requestId, entry)
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

  /**
   * M3: the model-facing tools.
   *
   * The write subset is decided by `allowBrowserWriteOps`, and that decision can be
   * flipped at runtime through `/ag/control` — so registration is a *re-runnable*
   * step rather than a one-shot: turning write access off disposes the write tools
   * (they stop existing for the model) instead of leaving a check to refuse them.
   */
  const runtime = { allowBrowserWriteOps: resolved.allowBrowserWriteOps === true }
  let toolDisposers = []
  let browserTools = []
  const applyTools = (log = () => {}) => {
    for (const dispose of toolDisposers) dispose()
    toolDisposers = []
    browserTools = registerBrowserTools({
      ctx,
      hub,
      config: { ...resolved, allowBrowserWriteOps: runtime.allowBrowserWriteOps },
      resolveWorkspace: () => clientFacts.workspace ?? resolved.defaultWorkspace,
      log,
      keepDisposers: toolDisposers,
    })
  }
  applyTools((line) => ctx.logger?.info?.(`[dsh-web-companion-bridge] ${line}`))

  /**
   * Third guard on write ops (design §9): route each call to the human through DSH's
   * approval seam when this deployment has one; otherwise stay honest and say the
   * panel switch is the only gate.
   */
  const writeGate = createWriteGate({
    ctx,
    writeEnabled: () => runtime.allowBrowserWriteOps === true,
    approvalRequired: () => resolved.approvalForWriteOps !== false,
    log: connLogger,
  })

  const state = {
    pluginVersion: PLUGIN_VERSION,
    liveTickets: () => tickets.liveCount,
    connectedClients: () => hub.clientCount,
    connectedAgents: () => hub.agentCount,
    queuedIntents: () => store.intentCount,
    recordCaptureResult: (frame) => {
      audit.append({ kind: 'capture-result', requestId: frame.requestId, captureId: frame.captureId, ok: frame.ok === true, errorCode: frame.error?.code })
      ctx.logger?.info?.(
        `[dsh-web-companion-bridge] capture-result ${frame.requestId} ok=${String(frame.ok)}` +
        (frame.fileRef === undefined ? '' : ` → ${frame.fileRef}`) +
        (frame.error === undefined ? '' : ` error=${frame.error.code ?? '?'} ${frame.error.message ?? ''}`),
      )
    },
    clientWorkspace: () => clientFacts.workspace,
    recordCapture: (event, delivered, trigger) => {
      recent.captures.push({ captureId: event.captureId, fileRef: event.fileRef, delivered, at: Date.now() })
      if (recent.captures.length > 50) recent.captures.shift()
      // `trigger` + `sessionMode` are the two fields that answer "why did a session
      // appear?": trigger is what the extension saw, sessionMode is what we decided.
      audit.append({
        kind: 'attach',
        captureId: event.captureId,
        trigger,
        sessionMode: event.sessionMode,
        mode: event.mode,
        delivered,
        chars: event.summary?.chars,
        truncated: event.summary?.truncated,
        hasSelection: event.summary?.hasSelection,
      })
      ctx.logger?.info?.(
        `[dsh-web-companion-bridge] capture ${event.captureId} trigger=${String(trigger ?? '?')} sessionMode=${String(event.sessionMode ?? '?')} → ${event.fileRef} (delivered=${String(delivered)})`,
      )
    },
    recordAck: (payload) => {
      recent.acks.push({ ...payload, at: Date.now() })
      if (recent.acks.length > 50) recent.acks.shift()
      audit.append({ kind: 'ack', captureId: payload.captureId, status: payload.status })
      ctx.logger?.info?.(`[dsh-web-companion-bridge] ack ${payload.captureId} = ${payload.status}`)
    },
    recent,
    pairing: () => pairing,
    guard: () => guard,
    credentials: ctx.credentials,
    dshHome: dshHome(),
    port: () => ctx.webServer?.port,
    capabilities: () => browserTools,
    /** Audit health for `/ag/whoami` — "the audit died quietly" must be observable. */
    auditStatus: () => audit.status(),
    /** Read-only accessors for `GET /ag/control` — a read must not mutate (see control.js). */
    writeOps: () => runtime.allowBrowserWriteOps === true,
    approvalMode: () => writeGate.mode,
    /** Flip a runtime switch, re-registering the tool set so the change is structural. */
    applyControl: (patch) => {
      connLogger(`control: allowBrowserWriteOps ${String(runtime.allowBrowserWriteOps)} → ${String(patch.allowBrowserWriteOps)}`)
      runtime.allowBrowserWriteOps = patch.allowBrowserWriteOps === true
      applyTools()
      // A silent capability flip is exactly the kind of thing an audit trail is for.
      // 这里装的是「哪道闸在把关」，不是错误码 —— 塞进 errorCode 会把诊断读歪。
      audit.append({ kind: 'control', tool: 'allowBrowserWriteOps', ok: runtime.allowBrowserWriteOps, status: writeGate.mode })
      return { allowBrowserWriteOps: runtime.allowBrowserWriteOps, capabilities: browserTools, approvalMode: writeGate.mode }
    },
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
        `paired=${String(isPaired(pairing))} ` +
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
      path: ROUTE.wsEcho,
      handler: registerWsEcho(),
    }),
    `dsh-web-companion-bridge: WS ${ROUTE.wsEcho}`,
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
        // Hand the attach back to the page half that asked for it (when one did).
        resolveOwner: (captureId) => takeCaptureOwner(captureId),
      })),
    }),
    `dsh-web-companion-bridge: POST ${ROUTE.attach}`,
  )

  // --- runtime control surface (extension side only, F2) ---
  ctx.effect(
    () => ctx.webServer.register({
      kind: 'exact',
      path: ROUTE.control,
      handler: withPairing((req, res) => {
        if (!state.guard().checkFetch(req)) {
          res.writeHead(403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
          res.end(JSON.stringify({ ok: false, error: { code: 'E_AUTH', message: 'control requires the pairing key and a trusted extension origin' } }))
          return
        }
        return controlRoute({ state })(req, res)
      }),
    }),
    `dsh-web-companion-bridge: POST ${ROUTE.control}`,
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
      path: ROUTE.wsProbe,
      handler: registerWsProbe({ state }),
    }),
    `dsh-web-companion-bridge: WS ${ROUTE.wsProbe}`,
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
