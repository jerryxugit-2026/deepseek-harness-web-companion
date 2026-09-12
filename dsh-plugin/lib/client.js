/**
 * DSH Web Companion — client half.
 *
 * Loaded by the DSH web shell through `window.__ModuleLoader__.load({...})`: the
 * bundle must be a CommonJS closure factory whose module exports the plugin face
 * (`apply` / `name` / `inject`). This package declares it via
 * `exports["./client"]` + `dsh.client.platform === "web"`.
 *
 * Two jobs, both verified against the live shell:
 *
 *   A. **Context channel (M0b)** — hold `WS /ag/client` (same-origin, so no key
 *      ever appears in page JavaScript), receive `attach` events, insert the
 *      `@fileRef` reference into the composer draft, render a removable chip,
 *      ack every capture, and report the 「看左边」intent upstream.
 *
 *   B. **White-box probe (M0a)** — publish what a third-party plugin can reach
 *      (`window.__AG_PROBE__`, `__AG_PROBE_ASYNC__`, `__AG_PROBE_WRITE__`) so the
 *      CDP harness can assert on it verbatim.
 *
 * Chip rendering note (updated v3.33): the chip now renders through DSH's own
 * `conversation.input.dock` slot — `ctx.slots.inject(name, () => ctx.slots.register(
 * options, Component))`, with the component as the SECOND positional argument and
 * returning **React** elements (`react` is a platform seed module; bundling our own
 * React would break hooks). The DOM strip (`[data-ag-chip]`) is kept as a fallback
 * for the case where the dock never mounts (older shell / declaration missing), so
 * the observable contract — present / removable / acked — never depends on which
 * host rendered it (`__AG_CLIENT__.chips()` reports `host: 'slot' | 'dom'`).

 * Slot contract facts this code relies on (read from the shell's source, with the
 * official slot ledger as the authority):
 *   - a list slot needs `id`; entries sort by `priority` then `order` (both default 0);
 *   - registering into a slot that is NOT declared throws — the declaration comes
 *     from the parent entry's `children` table, which is why `inject` (wait for the
 *     declaration) is mandatory rather than optional;
 *   - components receive `sessionId` (session-scoped slot) plus the standard hooks;
 *     the outlet remounts per session, so component-local state cannot leak across
 *     sessions.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-companion-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const CHANNEL = '/ag/client'
    const HEARTBEAT_MS = 20000
    const INTENT_PATTERN = /^\s*(看左边|look left)/imu
    const PROBE_CANDIDATES = [
      'conversation', 'sessions', 'uiConversation', 'uiSession', 'slots', 'connection',
      'workspaces', 'uiWorkspace', 'modules',
    ]

    const log = (...args) => { try { console.log('[ag-client]', ...args) } catch { /* ignore */ } }
    const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
    const composerElement = () => document.querySelector('[contenteditable="true"], textarea')

    /** Compact, non-leaking description of a value's shape. */
    const describe = (value) => {
      if (value === undefined) return 'undefined'
      if (value === null) return 'null'
      const type = typeof value
      if (type !== 'object' && type !== 'function') return `${type}:${String(value).slice(0, 60)}`
      const keys = new Set()
      let cursor = value
      for (let depth = 0; depth < 4 && cursor !== null && cursor !== Object.prototype; depth += 1) {
        for (const key of Object.getOwnPropertyNames(cursor)) keys.add(key)
        cursor = Object.getPrototypeOf(cursor)
      }
      return { type, keys: [...keys].filter((k) => k !== 'constructor').sort().slice(0, 60) }
    }

    function apply(ctx) {
      // ---------------------------------------------------------------- probe --
      const steps = []
      const asyncSteps = []
      const record = (step, value) => {
        steps.push({ step, value })
        try { console.log('[ag-probe]', step, JSON.stringify(value)) } catch { /* ignore */ }
      }
      const recordAsync = (step, value) => {
        asyncSteps.push({ step, value })
        globalThis.__AG_PROBE_ASYNC__ = asyncSteps
        try { console.log('[ag-probe-async]', step, JSON.stringify(value)) } catch { /* ignore */ }
      }

      record('boot', {
        href: typeof location === 'undefined' ? null : location.href,
        moduleLoader: typeof globalThis.__ModuleLoader__,
        bootKeys: globalThis.__DSH_BOOT__ !== null && typeof globalThis.__DSH_BOOT__ === 'object' ? Object.keys(globalThis.__DSH_BOOT__) : typeof globalThis.__DSH_BOOT__,
      })

      const services = {}
      for (const name of PROBE_CANDIDATES) {
        try {
          const service = ctx.get(name)
          services[name] = service === undefined ? 'undefined' : describe(service)
        } catch (error) { services[name] = `threw:${String(error).slice(0, 60)}` }
      }
      record('services', services)

      const conversation = ctx.get('conversation')
      const sessions = ctx.get('sessions')
      record('composer-contract', {
        conversationKeys: conversation === undefined ? null : describe(conversation),
        hasCreateDraftImages: typeof conversation?.createDraftImages === 'function',
        hasCreateDraftAttachments: typeof conversation?.createDraftAttachments === 'function',
        hasScope: typeof sessions?.scope === 'function',
      })
      globalThis.__AG_PROBE__ = steps
      record('probe-done', { steps: steps.length })

      /** The current session's working directory — the capture target workspace. */
      const currentWorkspace = () => {
        try {
          const uiSession = ctx.get('uiSession')
          const sessions = ctx.get('sessions')
          const id = uiSession?.currentBinding?.props?.sessionId
          if (typeof id !== 'string') return undefined
          const snapshot = sessions?.list?.getSnapshot?.()
          const item = snapshot?.byId?.[id] ?? (snapshot?.ids ?? []).map((key) => snapshot?.byId?.[key]).find((entry) => entry?.id === id)
          if (typeof item?.cwd === 'string') return item.cwd
          const binding = uiSession?.currentBinding?.props
          return typeof binding?.workspace === 'string' ? binding.workspace : undefined
        } catch { return undefined }
      }

      /** Which session does the SHELL consider current? Drives the real composer. */
      const currentSessionId = () => {
        try {
          const uiSession = ctx.get('uiSession')
          const fromBinding = uiSession?.currentBinding?.props?.sessionId
          return typeof fromBinding === 'string' ? fromBinding : undefined
        } catch { return undefined }
      }

      /**
       * Harness-driven write used by the M0b assertions: only runs once the UI has
       * an ACTIVE composer, writes a marker, verifies it in the live editor's DOM,
       * then restores whatever the user had typed.
       *
       * `options.keep` skips the restore — the 「看左边」E2E needs the draft to STAY
       * written (a restore after 900ms races the 800ms intent sniffer and makes the
       * test pass by luck rather than by contract).
       */
      globalThis.__AG_PROBE_WRITE__ = async (marker, options = {}) => {
        const id = currentSessionId()
        if (typeof id !== 'string') return { error: 'no current session' }
        const shell = ctx.get('conversation').input.for(ctx.get('sessions').scope(id))
        if (shell === undefined || shell === null) return { error: 'no session input shell' }
        const pre = typeof shell.state?.draft === 'string' ? shell.state.draft : ''
        shell.setDraft(marker)
        await sleep(900)
        const el = composerElement()
        const result = {
          marker,
          sessionId: id.slice(0, 14),
          contentEditable: el?.getAttribute?.('contenteditable') ?? null,
          domText: String(el?.innerText ?? '').slice(0, 160),
          domHasMarker: String(el?.innerText ?? '').includes(marker),
          stateDraft: String(shell.state?.draft ?? '').slice(0, 80),
          lastMirroredDraft: String(shell.lastMirroredDraft ?? '').slice(0, 80),
        }
        if (options.keep !== true) shell.setDraft(pre)
        await sleep(400)
        result.restoredNow = String(shell.state?.draft ?? '').slice(0, 60)
        globalThis.__AG_PROBE_WRITE_RESULT__ = result
        return result
      }

      // ------------------------------------------------------- context channel --
      const state = { chips: new Map(), connected: false, deliveries: [], acks: [], intents: [] }
      let socket
      let stopIntent = () => {}
      let heartbeat

      const send = (frame) => {
        if (socket === undefined || socket.readyState !== 1) return false
        try { socket.send(JSON.stringify(frame)); return true } catch { return false }
      }

      /**
       * Read the composer draft from the most authoritative source available.
       * Measured behaviour: `shell.state.draft` is often empty right after a
       * write while the live editor already shows the text, so the DOM is the
       * fallback that makes undo reliable.
       */
      const readDraft = (shell) => {
        const fromState = typeof shell?.state?.draft === 'string' ? shell.state.draft : ''
        if (fromState !== '') return fromState
        const fromMirror = typeof shell?.lastMirroredDraft === 'string' ? shell.lastMirroredDraft : ''
        if (fromMirror !== '') return fromMirror
        const el = composerElement()
        return el === null ? '' : String(el.innerText ?? el.value ?? '')
      }

      /** Anchor a chip strip just above whatever the composer currently is. */
      function positionChip(root) {
        const composer = composerElement()
        if (composer === null) { root.style.bottom = '96px'; return }
        const rect = composer.getBoundingClientRect()
        root.style.bottom = `${String(Math.max(8, window.innerHeight - rect.top + 8))}px`
      }

      /* ── chip store (slot + DOM share one source of truth) ───────────────── */

      /** Listeners for the slot component; the chips Map stays the only state. */
      const chipListeners = new Set()
      const notifyChips = () => {
        for (const listener of [...chipListeners]) {
          try { listener() } catch (error) { log('chip listener failed', String(error).slice(0, 80)) }
        }
      }
      const subscribeChips = (listener) => {
        chipListeners.add(listener)
        return () => { chipListeners.delete(listener) }
      }
      /** Chips belonging to one session, newest last (the dock is session-scoped). */
      const chipsForSession = (sessionId) => [...state.chips.entries()]
        .filter(([, entry]) => entry.sessionId === sessionId)
        .map(([captureId, entry]) => ({ captureId, ...entry }))

      const chipLabel = (item) => `📄 网页: ${String(item.page?.title ?? '未命名').slice(0, 40)}`
      const chipMeta = (item) => `${String(item.summary?.chars ?? 0)} 字符${item.summary?.hasSelection === true ? ' · 含选区' : ''}`

      /**
       * Register the chip row into `conversation.input.dock`.
       *
       * @returns true when the registration was accepted (the component may still
       *          mount later — the declaration can arrive after us, which is exactly
       *          what `inject` waits for).
       */
      function registerChipDock(React) {
        const slots = ctx.get?.('slots') ?? ctx.slots
        if (slots === undefined || typeof slots.inject !== 'function') {
          log('slots service unavailable: chips stay DOM-anchored')
          return false
        }
        const CHIP_STYLE = {
          pointerEvents: 'auto', display: 'inline-flex', alignItems: 'center', gap: '6px',
          maxWidth: 'min(560px, 90vw)', padding: '4px 8px', borderRadius: '999px',
          border: '1px solid rgba(127,127,127,.35)', background: 'rgba(127,127,127,.12)',
          font: '12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
        }
        const LABEL_STYLE = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        const META_STYLE = { opacity: 0.65, flex: 'none' }
        const DISMISS_STYLE = { all: 'unset', cursor: 'pointer', padding: '0 2px', opacity: 0.7, flex: 'none' }
        const ROW_STYLE = { display: 'flex', flexWrap: 'wrap', gap: '6px', justifyContent: 'center', padding: '2px 0' }

        /** The dock entry: one chip per capture inserted into THIS session. */
        function CaptureDock(props) {
          const sessionId = props?.sessionId
          const [, force] = React.useState(0)
          React.useEffect(() => {
            state.dockMounted = true
            state.dockSessionId = sessionId
            // `inputActions` is the slot's stable public action face — stash it so the
            // harness can drive a real user turn (see tests/m3/agent-turn-probe.mjs).
            state.inputActions = props?.inputActions
            const off = subscribeChips(() => { force((n) => n + 1) })
            force((n) => n + 1)
            return () => { off(); state.dockMounted = false }
          }, [sessionId])
          const items = typeof sessionId === 'string' ? chipsForSession(sessionId) : []
          if (items.length === 0) return null
          return React.createElement('div', { 'data-ag-dock': 'slot', style: ROW_STYLE },
            items.map((item) => React.createElement('div', {
              key: item.captureId,
              'data-ag-chip': 'true',
              'data-capture-id': item.captureId,
              'data-mode': item.mode ?? 'page',
              'data-status': item.status ?? 'inserted',
              'data-session-mode': item.sessionMode ?? 'current',
              style: CHIP_STYLE,
            },
            React.createElement('span', { key: 'label', 'data-ag-chip-label': 'true', style: LABEL_STYLE }, chipLabel(item)),
            React.createElement('span', { key: 'meta', 'data-ag-chip-meta': 'true', style: META_STYLE }, chipMeta(item)),
            React.createElement('button', {
              key: 'dismiss',
              type: 'button',
              'data-ag-chip-dismiss': 'true',
              title: '移除上下文',
              style: DISMISS_STYLE,
              onClick: () => { void dismissCapture({ captureId: item.captureId }) },
            }, '✕'))))
        }

        try {
          slots.inject('conversation.input.dock', () => slots.register({
            name: 'conversation.input.dock',
            id: 'dsh-companion-chips',   // fresh id → additive, never fights the shipped entries
            order: 30,
          }, CaptureDock))
          state.chipHost = 'slot'
          log('dock slot registered (conversation.input.dock)')
          return true
        } catch (error) {
          state.chipHost = 'dom'
          log('dock registration failed', String(error).slice(0, 140))
          return false
        }
      }

      /** Build the chip element for one attach event (fallback host). */
      function renderChip(item, onDismiss) {
        const root = document.createElement('div')
        root.dataset.agChipRoot = 'true'
        root.style.cssText = 'position:fixed;left:0;right:0;z-index:2147483000;display:flex;justify-content:center;pointer-events:none;font:12px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
        const chip = document.createElement('div')
        chip.dataset.agChip = 'true'
        chip.dataset.captureId = item.captureId
        chip.dataset.mode = item.mode ?? 'page'
        chip.dataset.status = 'inserted'
        chip.style.cssText = 'pointer-events:auto;display:inline-flex;align-items:center;gap:6px;max-width:min(560px,90vw);padding:4px 8px;border-radius:999px;border:1px solid rgba(127,127,127,.35);background:rgba(127,127,127,.12);backdrop-filter:blur(6px);color:inherit'
        const label = document.createElement('span')
        label.dataset.agChipLabel = 'true'
        label.textContent = `📄 网页: ${String(item.page?.title ?? '未命名').slice(0, 40)}`
        chip.dataset.sessionMode = item.sessionMode ?? 'current'
        label.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
        const meta = document.createElement('span')
        meta.dataset.agChipMeta = 'true'
        meta.textContent = `${String(item.summary?.chars ?? 0)} 字符${item.summary?.hasSelection === true ? ' · 含选区' : ''}`
        meta.style.cssText = 'opacity:.65;flex:none'
        const dismiss = document.createElement('button')
        dismiss.dataset.agChipDismiss = 'true'
        dismiss.textContent = '✕'
        dismiss.title = '移除上下文'
        dismiss.style.cssText = 'all:unset;cursor:pointer;padding:0 2px;opacity:.7;flex:none'
        dismiss.addEventListener('click', () => { void onDismiss(item) })
        chip.append(label, meta, dismiss)
        root.append(chip)
        document.body.append(root)
        positionChip(root)
        window.addEventListener('resize', () => { positionChip(root) })
        return root
      }

      /**
       * Create a session for this capture and try to make it current.
       *
       * Measured: `sessions.create({ workspaceId })` works from a plugin, and
       * `sessions.open(id)` is the same call the workspace UI uses, so the shell
       * usually follows. When it does not, we still insert into the NEW session
       * (never into the user's running one) and the chip offers a manual switch.
       */
      async function openFreshSession(workspace) {
        const sessions = ctx.get('sessions')
        // `sessions.create` takes a workspace **id**, not a path — passing the
        // path fails with `workspace/not-found` (measured). Match the announced
        // cwd against the workspace registry, else fall back to the first
        // registered workspace so the new session is usable (a workspace-less
        // session renders an inert composer).
        const workspaceId = (() => {
          try {
            const items = ctx.get('uiWorkspace')?.workspaces?.list?.getSnapshot?.()?.items ?? []
            if (typeof workspace === 'string' && workspace !== '') {
              const byPath = items.find((item) => item.path === workspace || item.cwd === workspace)
              if (byPath !== undefined) return byPath.workspaceId ?? byPath.id
            }
            return items[0]?.workspaceId ?? items[0]?.id
          } catch { return undefined }
        })()
        const id = await sessions.create(workspaceId === undefined ? {} : { workspaceId })
        void id
        const sessionId = typeof id === 'string' ? id : (id?.id ?? id?.sessionId)
        let switched = false
        try {
          await sessions.open(sessionId)
          switched = true
        } catch (error) {
          log('open(new session) failed', String(error).slice(0, 120))
        }
        await sleep(1200)
        globalThis.__AG_LAST_NEW_SESSION__ = { workspaceId, sessionId, switched }
        return { sessionId, switched }
      }

      /** Apply one attach event: reference into the draft, chip on screen, ack. */
      async function applyAttach(item) {
        state.deliveries.push({ captureId: item.captureId, fileRef: item.fileRef, at: Date.now() })
        let inserted = false
        let detail = ''
        let sessionId
        let preDraft = ''
        let sessionMode = item.sessionMode ?? 'current'
        let switched = false
        try {
          if (sessionMode === 'new') {
            const fresh = await openFreshSession(currentWorkspace() ?? undefined)
            sessionId = fresh.sessionId
            switched = fresh.switched
          } else {
            const id = currentSessionId()
            if (typeof id !== 'string') throw new Error('no current session')
            sessionId = id
          }
          if (typeof sessionId !== 'string') throw new Error('no target session')
          const shell = ctx.get('conversation').input.for(ctx.get('sessions').scope(sessionId))
          preDraft = readDraft(shell)
          const next = preDraft.trim() === '' ? item.fileRef : `${preDraft.trimEnd()}\n${item.fileRef}`
          shell.setDraft(next)
          inserted = true
        } catch (error) {
          detail = String(error).slice(0, 160)
        }
        // The dock hosts the chip when it mounted; the DOM strip is the fallback
        // for shells where the slot never appeared. Either way the chips Map is the
        // single source of truth, so ✕ and ack behave identically.
        const useSlot = state.dockMounted === true
        const root = useSlot ? undefined : renderChip(item, dismissCapture)
        state.chips.set(item.captureId, {
          sessionId, preDraft, inserted: item.fileRef, sessionMode, switched,
          status: inserted ? 'inserted' : 'failed',
          mode: item.mode, page: item.page, summary: item.summary,
          fileRef: item.fileRef, host: useSlot ? 'slot' : 'dom',
          ...(root === undefined ? {} : { root, chip: root.firstElementChild }),
        })
        if (root !== undefined) root.firstElementChild.dataset.status = inserted ? 'inserted' : 'failed'
        notifyChips()
        send({ type: 'ack', captureId: item.captureId, status: inserted ? 'inserted' : 'failed', ...(detail === '' ? {} : { detail }) })
        state.acks.push({ captureId: item.captureId, status: inserted ? 'inserted' : 'failed' })
        globalThis.__AG_LAST_ATTACH__ = { captureId: item.captureId, inserted, detail, fileRef: item.fileRef, sessionId, sessionMode, switched }
        log('attach applied', item.captureId, sessionMode, inserted ? 'inserted' : `failed: ${detail}`, switched ? '(switched)' : '(no-switch)')
        return inserted
      }

      /** ✕ on a chip: undo our insertion, drop the chip, ack `dismissed`. */
      async function dismissCapture(item) {
        const entry = state.chips.get(item.captureId)
        try {
          if (entry?.sessionId !== undefined && typeof entry.inserted === 'string') {
            const shell = ctx.get('conversation').input.for(ctx.get('sessions').scope(entry.sessionId))
            const current = readDraft(shell)
            if (current.includes(entry.inserted)) {
              shell.setDraft(current.replace(entry.inserted, '').replace(/\n{2,}/gu, '\n').trimEnd())
            } else if (current.trim() === entry.inserted.trim() && typeof entry.preDraft === 'string') {
              shell.setDraft(entry.preDraft)
            }
          }
        } catch (error) { log('dismiss undo failed', String(error).slice(0, 120)) }
        entry?.root?.remove()
        state.chips.delete(item.captureId)
        notifyChips()
        send({ type: 'ack', captureId: item.captureId, status: 'dismissed' })
        state.acks.push({ captureId: item.captureId, status: 'dismissed' })
        log('dismissed', item.captureId)
      }

      /** 「看左边」intent watcher (design ADR-11: sniffing lives in this half). */
      function watchIntent() {
        let lastSent = ''
        const timer = setInterval(() => {
          try {
            const sessionId = currentSessionId()
            if (typeof sessionId !== 'string') return
            const shell = ctx.get('conversation').input.for(ctx.get('sessions').scope(sessionId))
            const draft = readDraft(shell)
            if (draft === '' || draft === lastSent) return
            if (!INTENT_PATTERN.test(draft)) return
            lastSent = draft
            state.intents.push({ draft, at: Date.now() })
            send({ type: 'intent', protocolVersion: 1, kind: 'look-left', sessionId, draft, trigger: 'keyword', at: Date.now() })
            log('intent detected', draft.slice(0, 40))
          } catch { /* composer not ready */ }
        }, 800)
        return () => { clearInterval(timer) }
      }

      const connect = () => {
        const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:'
        try { socket = new WebSocket(`${scheme}//${location.host}${CHANNEL}`) } catch (error) { log('ws throw', String(error)); return }
        socket.addEventListener('open', () => {
          state.connected = true
          const sessionId = currentSessionId()
          const workspace = currentWorkspace()
          send({ type: 'hello', protocolVersion: 1, extVersion: 'client', ...(sessionId === undefined ? {} : { sessionId }), ...(workspace === undefined ? {} : { workspace }) })
          send({ type: 'request-pending' })
          log('ws open')
        })
        socket.addEventListener('message', (event) => {
          const text = String(event.data)
          if (text.includes('"ping"')) { send({ type: 'pong' }); return }
          let frame
          try { frame = JSON.parse(text) } catch { return }
          if (frame.type === 'attach') void applyAttach(frame)
        })
        socket.addEventListener('close', () => { state.connected = false; log('ws closed') })
        socket.addEventListener('error', () => { /* close follows */ })
      }

      connect()
      heartbeat = setInterval(() => { send({ type: 'ping' }) }, HEARTBEAT_MS)
      stopIntent = watchIntent()

      // Re-announce when the user picks another session/workspace, so captures
      // land in what they are actually looking at (design §7 resolution order).
      let announcedWorkspace
      const announceTimer = setInterval(() => {
        if (socket === undefined || socket.readyState !== 1) return
        const workspace = currentWorkspace()
        if (workspace === undefined || workspace === announcedWorkspace) return
        announcedWorkspace = workspace
        const sessionId = currentSessionId()
        send({ type: 'hello', protocolVersion: 1, extVersion: 'client', ...(sessionId === undefined ? {} : { sessionId }), workspace })
        log('re-announced workspace', workspace.slice(-32))
      }, 3000)
      stopIntent = ((inner) => () => { clearInterval(announceTimer); inner() })(stopIntent)

      // Register the dock BEFORE the app mounts, so a capture that lands early still
      // has a host. `require('react')` resolves to the shell's own React: a bundled
      // copy would create a second React and hooks would break.
      try {
        registerChipDock(require('react'))
      } catch (error) {
        log('dock bootstrap failed', String(error).slice(0, 140))
        state.chipHost = 'dom'
      }

      globalThis.__AG_CLIENT__ = {
        state,
        chipHost: () => state.chipHost ?? 'unknown',
        dockMounted: () => state.dockMounted === true,
        chips: () => [...document.querySelectorAll('[data-ag-chip]')].map((el) => ({
          host: el.closest('[data-ag-dock]') === null ? 'dom' : 'slot',
          captureId: el.dataset.captureId, status: el.dataset.status, mode: el.dataset.mode,
          label: el.querySelector('[data-ag-chip-label]')?.textContent ?? null,
        })),
        deliver: (item) => applyAttach(item),
        dismiss: (captureId) => {
          const entry = state.chips.get(captureId) ?? {}
          return dismissCapture({ captureId, ...entry })
        },
        reconnect: connect,
        /** Harness: create + open a session so an agent turn has somewhere to go. */
        newSession: async () => {
          const fresh = await openFreshSession(currentWorkspace() ?? undefined)
          await sleep(800)
          return { ...fresh, sessionId: fresh?.sessionId ?? currentSessionId() ?? null }
        },
        /** Harness: which input/ send actions exist right now (no guessing). */
        actions: () => {
          const conversation = ctx.get('conversation')
          return {
            sessionId: currentSessionId() ?? null,
            hasInputActions: state.inputActions !== undefined,
            inputActionKeys: state.inputActions === undefined ? [] : Object.keys(state.inputActions),
            conversationHasSend: typeof conversation?.send === 'function',
            conversationHasSendSession: typeof conversation?.sendSession === 'function',
          }
        },
        /**
         * Harness: deliver one user message. Tries the candidates in order and stops at
         * the first that does not throw — the goal is to learn the real call shape of
         * THIS DSH version empirically instead of hard-coding a guessed name.
         */
        trySend: async (text) => {
          const conversation = ctx.get('conversation')
          const id = currentSessionId()
          const attempted = []
          const attempt = async (label, fn) => {
            try {
              const returned = await fn()
              attempted.push({ label, ok: true, returned: returned === undefined ? 'undefined' : String(typeof returned) })
              return true
            } catch (error) {
              attempted.push({ label, ok: false, error: String(error?.message ?? error).slice(0, 160) })
              return false
            }
          }
          if (typeof id !== 'string') { attempted.push({ label: 'no-session', ok: false, error: 'currentSessionId() is not a string' }); return attempted }
          const scope = ctx.get('sessions').scope(id)
          const shell = conversation.input.for(scope)
          try { shell.setDraft(text) } catch (error) { attempted.push({ label: 'setDraft', ok: false, error: String(error?.message ?? error).slice(0, 120) }) }
          // Discovered empirically (the error text was the documentation):
          //   - `conversation.send` needs a SESSION SCOPE: `ctx.sessions.scope(id).conversation`
          //   - the slot's public action face exposes `submit`, not `send`
          if (state.inputActions?.submit !== undefined) {
            if (await attempt('inputActions.setDraft+submit', async () => { state.inputActions.setDraft(text); return state.inputActions.submit() })) return attempted
          }
          const scoped = ctx.get('sessions').scope(id)?.conversation
          if (typeof scoped?.send === 'function') {
            if (await attempt('scopedConversation.send(text)', () => scoped.send(text))) return attempted
          }
          if (typeof shell?.submit === 'function') {
            if (await attempt('shell.setDraft+submit', async () => { shell.setDraft(text); return shell.submit() })) return attempted
          }
          if (typeof conversation.sendSession === 'function') {
            await attempt('conversation.sendSession([id], text)', () => conversation.sendSession([id], text))
          }
          return attempted
        },
        /**
         * Introspect the pieces an agent turn needs (harness-only): which methods the
         * conversation service and the session input shell actually expose in THIS
         * DSH version. Used by tests/m3/agent-turn-probe.mjs to find the send action
         * instead of guessing a name that may not exist.
         */
        api: () => {
          const describe = (object, label) => {
            if (object === undefined || object === null) return { label, missing: true }
            const own = Object.keys(object)
            const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(object) ?? {})
            const fns = [...new Set([...own, ...proto])].filter((k) => {
              try { return typeof object[k] === 'function' } catch { return false }
            })
            return { label, type: typeof object, own: own.slice(0, 40), methods: fns.slice(0, 60) }
          }
          const conversation = ctx.get('conversation')
          const sessionId = currentSessionId()
          const shell = typeof sessionId === 'string' ? conversation?.input?.for(ctx.get('sessions').scope(sessionId)) : undefined
          return {
            sessionId: sessionId ?? null,
            conversation: describe(conversation, 'conversation'),
            input: describe(conversation?.input, 'conversation.input'),
            shell: describe(shell, 'shell'),
            inputActions: Object.keys(globalThis.__AG_PANEL_INPUT_ACTIONS__ ?? {}).slice(0, 40),
          }
        },
        sessions: () => {
          try {
            const snapshot = ctx.get('sessions')?.list?.getSnapshot?.()
            return { current: currentSessionId() ?? null, ids: snapshot?.ids ?? [], count: (snapshot?.ids ?? []).length }
          } catch (error) { return { error: String(error).slice(0, 80) } }
        },
      }

      void recordAsync
      ctx.effect(() => () => {
        clearInterval(heartbeat)
        stopIntent()
        try { socket?.close() } catch { /* ignore */ }
      }, 'ag-client: dispose')

      log('client half ready')
    }

    // `inject` makes cordis defer `apply` until these exist — without it every
    // service lookup is undefined (verified in M0a).
    module.exports = { name: 'dsh-web-companion-bridge-client', inject: ['sessions', 'conversation', 'slots'], apply }
    return module.exports
  },
})
