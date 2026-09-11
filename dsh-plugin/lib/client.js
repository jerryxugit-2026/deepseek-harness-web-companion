/**
 * DSH Web Companion — client half (M0a probe build).
 *
 * Loaded by the DSH web shell through `window.__ModuleLoader__.load({...})`:
 * the bundle must be a CommonJS closure factory whose module exports the plugin
 * face (`apply` / optional `name` / `inject`). The host discovers this file via
 * this package's `exports["./client"]` + `dsh.client.platform === "web"`.
 *
 * M0a scope: probe what a third-party client plugin can actually reach —
 *   Q3 how a plugin obtains the composer contract (services, draft read/write,
 *      image admission, module-loader seed/externals)
 *   Q4 the real signature/semantics of `setDraft` and friends
 *
 * Evidence is published on `window.__AG_PROBE__` and the console so the CDP
 * harness can read it verbatim. No React, no externals: everything is inlined.
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-companion-bridge',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    /** Everything the probe learns, in order. */
    const steps = []
    const record = (step, value) => {
      steps.push({ step, value })
      try { console.log('[ag-probe]', step, JSON.stringify(value)) } catch { console.log('[ag-probe]', step, String(value)) }
    }

    /** Describe a value without leaking functions' internals. */
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
      return { type, keys: [...keys].filter((k) => k !== 'constructor').sort().slice(0, 80) }
    }

    /** Services worth probing, in the order the design depends on them. */
    const CANDIDATES = [
      'conversation', 'sessions', 'uiConversation', 'uiSession', 'slots', 'connection',
      'workspace', 'workspaces', 'uiWorkspace', 'workspaceRegistry',
      'sessionController', 'session', 'agent', 'agents', 'clientModules', 'modules',
    ]

    function apply(ctx) {
      record('boot', {
        href: typeof location === 'undefined' ? null : location.href,
        moduleLoader: typeof globalThis.__ModuleLoader__,
        bootKeys: globalThis.__DSH_BOOT__ !== null && typeof globalThis.__DSH_BOOT__ === 'object' ? Object.keys(globalThis.__DSH_BOOT__) : typeof globalThis.__DSH_BOOT__,
        bootEntryIds: (() => {
          const wire = globalThis.__DSH_BOOT__
          const entries = wire?.entries ?? wire?.plugins ?? wire?.rows
          if (!Array.isArray(entries)) return null
          return entries.map((e) => e?.id ?? e?.name ?? String(e)).slice(0, 60)
        })(),
        // service registry visibility (cordis keeps the store on the root reflect)
        reflectKeys: (() => {
          try { return Object.keys(ctx.reflect ?? {}).slice(0, 20) } catch { return null }
        })(),
        storeServices: (() => {
          try {
            const store = ctx.reflect?.store
            if (store === undefined || store === null) return null
            return [...(store.keys?.() ?? [])].slice(0, 60)
          } catch (error) { return `threw:${String(error).slice(0, 60)}` }
        })(),
      })

      // ---- which services resolve at all (Q3) ----
      const resolved = {}
      for (const candidate of CANDIDATES) {
        try {
          const service = ctx.get(candidate)
          resolved[candidate] = service === undefined ? 'undefined' : describe(service)
        } catch (error) {
          resolved[candidate] = `threw:${String(error).slice(0, 80)}`
        }
      }
      record('services', resolved)

      // ---- composer contract (Q3/Q4) ----
      try {
        const conversation = ctx.get('conversation')
        const sessions = ctx.get('sessions')
        const probe = {
          conversationKeys: conversation === undefined ? null : describe(conversation),
          hasCreateDraftImages: typeof conversation?.createDraftImages === 'function',
          hasCreateDraftAttachments: typeof conversation?.createDraftAttachments === 'function',
          sessionsKeys: sessions === undefined ? null : describe(sessions),
          hasScope: typeof sessions?.scope === 'function',
        }
        // what sessions does the plugin see?
        try {
          const list = sessions?.list?.() ?? sessions?.all?.()
          probe.sessionsListType = Array.isArray(list) ? `array(${String(list.length)})` : describe(list)
          if (Array.isArray(list) && list.length > 0) probe.firstSession = describe(list[0])
          globalThis.__AG_PROBE_SESSIONS__ = list
        } catch (error) {
          probe.sessionsListError = String(error).slice(0, 120)
        }
        record('composer-contract', probe)
      } catch (error) {
        record('composer-contract', { threw: String(error) })
      }

      // ---- draft read/write attempt (Q4 + M0b assertion #2) ----
      // Runs asynchronously so it can wait for a session to exist; results land
      // in `window.__AG_PROBE_ASYNC__` for the CDP harness.
      const asyncSteps = []
      const recordAsync = (step, value) => {
        asyncSteps.push({ step, value })
        globalThis.__AG_PROBE_ASYNC__ = asyncSteps
        try { console.log('[ag-probe-async]', step, JSON.stringify(value)) } catch { /* ignore */ }
      }

      /** Harness-callable probe: run once a composer actually exists. */
      const runDraftProbe = async () => {
        asyncSteps.length = 0
        const sessions = ctx.get('sessions')
        const conversation = ctx.get('conversation')
        const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

        // --- how does the shell itself make a composer exist? follow its own path ---
        const uiSession = ctx.get('uiSession')
        const uiWorkspace = ctx.get('uiWorkspace')

        /** Which session does the SHELL consider current? (drives the real composer) */
        const currentSessionId = (() => {
          try {
            const fromBinding = uiSession?.currentBinding?.props?.sessionId ?? uiSession?.currentBinding?.props?.session?.id
            if (typeof fromBinding === 'string') return fromBinding
            const snapshot = uiSession?.pendingSnapshot?.() ?? uiSession?.resolveCurrent?.()
            const fromSnapshot = snapshot?.sessionId ?? snapshot?.session?.id
            if (typeof fromSnapshot === 'string') return fromSnapshot
          } catch (error) {
            recordAsync('current-session', { threw: String(error).slice(0, 120) })
          }
          return undefined
        })()
        recordAsync('current-session', { sessionId: currentSessionId === undefined ? null : currentSessionId.slice(0, 14), bindingProps: describe(uiSession?.currentBinding?.props) })
        recordAsync('shell-services', {
          uiSessionKeys: uiSession === undefined ? null : describe(uiSession).keys?.slice(0, 24) ?? null,
          currentBinding: describe(uiSession?.currentBinding),
          uiWorkspaceKeys: uiWorkspace === undefined ? null : describe(uiWorkspace).keys?.slice(0, 30) ?? null,
          hasConnectWorkspace: typeof uiWorkspace?.connectWorkspace === 'function',
          hasList: typeof uiWorkspace?.list,
        })

        // resolve a workspace id exactly the way the shell does:
        // uiWorkspace.workspaces.list.getSnapshot().items (see dsh-client-ui-workspace)
        let workspaceId
        try {
          const snapshot = uiWorkspace?.workspaces?.list?.getSnapshot?.()
          const items = snapshot?.items
          const first = Array.isArray(items) ? items[0] : undefined
          workspaceId = first?.workspaceId ?? first?.id
          recordAsync('workspace-list', {
            items: Array.isArray(items) ? items.length : typeof items,
            first: first === undefined ? null : { workspaceId: String(first.workspaceId ?? first.id).slice(0, 12), title: first.title ?? null },
          })
        } catch (error) {
          recordAsync('workspace-list', { threw: String(error).slice(0, 160) })
        }
        recordAsync('workspace-id', { workspaceId: workspaceId === undefined ? null : String(workspaceId) })

        // IMPORTANT: never create or switch sessions here. Doing so fights the
        // UI (the shell follows us to a workspace-less session and the composer
        // goes inert). This probe only OBSERVES the session the shell currently
        // has; writes are driven by __AG_PROBE_WRITE__ after the UI is ready.
        const sessionId = currentSessionId
        recordAsync('session-source', { source: typeof sessionId === 'string' ? 'shell-current' : 'none', id: typeof sessionId === 'string' ? sessionId.slice(0, 14) : null })

        if (typeof sessionId !== 'string') {
          recordAsync('draft-write', { skipped: 'shell has no current session; waiting for the UI to select one' })
          return asyncSteps
        }

        // --- ask the shell to make this session current (the UI's own selection face) ---
        try {
          if (typeof sessionId === 'string' && uiSession !== undefined) {
            const binding = uiSession.createMaterializedBinding?.(sessionId) ?? uiSession.resolve?.(sessionId)
            recordAsync('uiSession.binding', { created: describe(binding) })
            if (binding !== undefined) {
              const published = uiSession.publishCurrent?.(binding)
              recordAsync('uiSession.publishCurrent', { returned: describe(published) })
            }
            await sleep(1500)
            const composer = document.querySelector('[contenteditable]')
            recordAsync('composer-after-publish', {
              contentEditable: composer?.getAttribute?.('contenteditable') ?? null,
              ariaLabel: composer?.getAttribute?.('aria-label') ?? null,
            })
          }
        } catch (error) {
          recordAsync('uiSession.binding', { threw: String(error).slice(0, 200) })
        }

        // --- diagnosis: what does the shell actually render after connectWorkspace? ---
        await sleep(1200)
        recordAsync('dom-diagnosis', {
          currentBinding: describe(uiSession?.currentBinding),
          pendingSnapshot: typeof uiSession?.pendingSnapshot,
          editableCount: document.querySelectorAll('[contenteditable]').length,
          textboxCount: document.querySelectorAll('[role="textbox"]').length,
          textareaCount: document.querySelectorAll('textarea').length,
          lexicalCount: document.querySelectorAll('[data-lexical-editor]').length,
          mainHead: (document.querySelector('main')?.innerHTML ?? '').replace(/\s+/g, ' ').slice(0, 240),
          bodyText: (document.body.innerText ?? '').replace(/\s+/g, ' ').slice(0, 200),
        })

        for (let attempt = 0; attempt < 10; attempt += 1) {
          try {
            const actx = sessions.scope(sessionId)
            const shell = conversation.input.for(actx)
            if (shell === undefined || shell === null) { await sleep(600); continue }
            const marker = `M0A-MARKER-${Date.now().toString(36)}`
            recordAsync('shell', { keys: Object.keys(shell).slice(0, 40), setDraftArity: typeof shell.setDraft === 'function' ? shell.setDraft.length : null })
            const preDraft = typeof shell.state?.draft === 'string'
              ? shell.state.draft
              : (typeof shell.lastMirroredDraft === 'string' ? shell.lastMirroredDraft : '')
            const wrote = shell.setDraft(marker)
            await sleep(1200)
            // read-back sources that do NOT depend on the DOM rendering
            const readBack = {
              lastMirroredDraft: typeof shell.lastMirroredDraft === 'string' ? shell.lastMirroredDraft.slice(0, 60) : describe(shell.lastMirroredDraft),
              stateDraft: (() => {
                try {
                  const st = shell.state
                  if (st === null || st === undefined) return null
                  const text = st.draft ?? st.text ?? st.value ?? st.getSnapshot?.()?.draft
                  return typeof text === 'string' ? text.slice(0, 60) : describe(st).keys?.slice(0, 12) ?? null
                } catch (error) { return `threw:${String(error).slice(0, 60)}` }
              })(),
              bindingActionsSetDraft: typeof uiSession?.currentBinding?.props?.inputActions?.setDraft,
            }
            const dom = document.querySelector('[contenteditable], textarea')
            const container = dom?.closest('[class]') ?? null
            recordAsync('draft-write', {
              marker,
              setDraftReturn: wrote === undefined ? 'undefined' : String(wrote).slice(0, 40),
              domVisible: dom !== null,
              domTag: dom?.tagName ?? null,
              domContentEditable: dom?.getAttribute?.('contenteditable') ?? null,
              domRole: dom?.getAttribute?.('role') ?? null,
              domAriaLabel: dom?.getAttribute?.('aria-label') ?? null,
              domClasses: dom === null ? null : String(dom.className).slice(0, 160),
              containerClasses: container === null ? null : String(container.className).slice(0, 120),
              domContainsMarker: dom === null ? null : (dom.innerText ?? dom.value ?? '').includes(marker),
              domText: dom === null ? null : String(dom.innerText ?? dom.value ?? '').slice(0, 140),
              readBack,
            })

            // image admission (Q3: can a plugin mint a draft attachment?)
            try {
              const file = new File([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], 'm0a.png', { type: 'image/png' })
              const admitted = conversation.createDraftImages !== undefined
                ? conversation.createDraftImages([file])
                : undefined
              recordAsync('image-admission', {
                api: conversation.createDraftImages !== undefined ? 'createDraftImages' : 'none',
                result: Array.isArray(admitted) ? `array(${String(admitted.length)})` : describe(admitted),
                firstId: Array.isArray(admitted) && admitted.length > 0 ? String(admitted[0].id ?? admitted[0]).slice(0, 20) : null,
              })
            } catch (error) {
              recordAsync('image-admission', { threw: String(error).slice(0, 160) })
            }
            // leave the user's draft exactly as we found it
            try {
              shell.setDraft(preDraft)
              await sleep(400)
              recordAsync('draft-restored', { givenBack: preDraft.length, now: String(shell.state?.draft ?? '').slice(0, 40) })
            } catch (error) {
              recordAsync('draft-restore-failed', { threw: String(error).slice(0, 160) })
            }
            return asyncSteps
          } catch (error) {
            recordAsync('draft-write-attempt', { attempt, threw: String(error).slice(0, 160) })
          }
          await sleep(700)
        }
        return asyncSteps
      }
      /**
       * Harness-driven write: runs only after the UI has an ACTIVE composer, so
       * the marker can be verified in the DOM (M0b assertion ②) and then undone.
       */
      globalThis.__AG_PROBE_WRITE__ = async (marker) => {
        const uiSessionNow = ctx.get('uiSession')
        const sessionsNow = ctx.get('sessions')
        const conversationNow = ctx.get('conversation')
        const id = uiSessionNow?.currentBinding?.props?.sessionId
        if (typeof id !== 'string') return { error: 'no current session', props: describe(uiSessionNow?.currentBinding?.props) }
        const actx = sessionsNow.scope(id)
        const shell = conversationNow.input.for(actx)
        if (shell === undefined || shell === null) return { error: 'no session input shell' }
        const pre = typeof shell.state?.draft === 'string' ? shell.state.draft : ''
        shell.setDraft(marker)
        await new Promise((r) => { setTimeout(r, 900) })
        const el = document.querySelector('[contenteditable="true"], [contenteditable]')
        const result = {
          marker,
          sessionId: id.slice(0, 14),
          contentEditable: el?.getAttribute?.('contenteditable') ?? null,
          domText: String(el?.innerText ?? '').slice(0, 160),
          domHasMarker: String(el?.innerText ?? '').includes(marker),
          stateDraft: String(shell.state?.draft ?? '').slice(0, 80),
          lastMirroredDraft: String(shell.lastMirroredDraft ?? '').slice(0, 80),
          imageApi: typeof conversationNow.createDraftImages === 'function',
        }
        shell.setDraft(pre)
        await new Promise((r) => { setTimeout(r, 400) })
        result.restoredNow = String(shell.state?.draft ?? '').slice(0, 60)
        globalThis.__AG_PROBE_WRITE_RESULT__ = result
        return result
      }

      globalThis.__AG_PROBE_RUN__ = runDraftProbe
      globalThis.__AG_PROBE_CTX__ = { conversationAvailable: ctx.get('conversation') !== undefined, sessionsAvailable: ctx.get('sessions') !== undefined }
      void runDraftProbe()

      globalThis.__AG_PROBE__ = steps
      record('probe-done', { steps: steps.length })
    }

    // `inject` makes cordis defer `apply` until the listed services exist; the
    // names below are the ones the design depends on (see docs/04).
    module.exports = { name: 'dsh-web-companion-bridge-client', inject: ['sessions', 'conversation'], apply }
    return module.exports
  },
})
