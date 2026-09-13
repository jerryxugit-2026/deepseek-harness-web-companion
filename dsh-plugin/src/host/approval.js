/**
 * Write-op approval gate (design §9, ADR-12 follow-up).
 *
 * The write tools already have two guards — they are not registered unless
 * `allowBrowserWriteOps` is on, and the extension re-checks the same flag on every
 * frame. This adds the third, which is the one the design actually promised: when
 * write access *is* on, each call can be routed to the human through DSH's own
 * approval seam before it touches the page.
 *
 * The seam is a cordis **waterfall** on `tools/pre-execute` (verified in
 * dsh-tools/lib/index.js): the runtime calls it with the execution and an
 * innermost `next` that resolves to `{ kind: 'allow' }`. A listener that returns
 * `{ kind: 'ask', reason }` hands the decision to `ctx.get('approval')`; a
 * deployment without that service degrades `ask` to a **deny** with a readable
 * reason. That degradation is why this module reports its mode instead of
 * assuming: on such a deployment the panel switch stays the effective gate, and
 * pretending otherwise would silently make every click fail.
 *
 * The same reasoning applies to the engine's own **policy** (`ask` / `never`), not just to the
 * service's presence: under `never` the service exists but nothing is ever asked, so the mode
 * becomes `policy-never` and a write call is refused with that reason (see policyOf).
 */
export const WRITE_TOOLS = Object.freeze(['browser_click', 'browser_type', 'browser_navigate'])

const WRITE_TOOL_SET = new Set(WRITE_TOOLS)

/**
 * @param {object} options
 * @param {object} options.ctx plugin context (needs `get` and `on`)
 * @param {() => boolean} options.writeEnabled current value of `allowBrowserWriteOps`
 * @param {() => boolean} [options.approvalRequired] whether to route each call to a human
 * @param {(line: string) => void} [options.log]
 * @returns {{ mode: 'ask' | 'policy-never' | 'switch-only' | 'off', policy: string, listener: Function, dispose: () => void }}
 */
export function createWriteGate({ ctx, writeEnabled, approvalRequired = () => true, log = () => {} }) {
  // Recomputed on every read, NOT captured once at construction. It used to be a `const` snapshot
  // that `/ag/control` reported back to the panel as `approvalMode` — so if the approval service
  // went away mid-session (the engine's own docs allow an unmount), the panel would keep telling
  // the user "every write asks you first" while nothing was asking (review 2026-09-12).
  const approvalService = () => (typeof ctx.get === 'function' ? ctx.get('approval') : undefined)

  /**
   * Which approval policy is really in force for one call.
   *
   * `'never'` is the DSH default-off switch (dsh-user-approval: `APPROVAL_POLICIES = ['ask','never']`):
   * the service exists, but `decide()` returns `'rejected'` **before** consulting any answerer. The
   * old code only asked whether the service *existed*, so it reported `'ask'` and the panel promised
   * "every click asks you first" while every click was auto-rejected with a message to the model that
   * blamed the user ("the user rejected tool browser_click") — nobody was ever asked (ledger §5-12).
   *
   * The live policy is per session (`effectivePolicy` folds the session's own `approval/policy`
   * event over the configured default), so it is read from the execution's agent whenever we have
   * one, and from the configured default when we do not.
   *
   * @param {{ session?: object }} [agent]
   * @returns {'ask' | 'never' | 'unavailable' | 'unknown'}
   */
  const policyOf = (agent) => {
    const approval = approvalService()
    if (approval === undefined) return 'unavailable'
    const session = agent?.session
    if (session !== undefined && typeof approval.effectivePolicy === 'function') {
      try {
        const live = approval.effectivePolicy(session)
        if (live === 'ask' || live === 'never') return live
      } catch { /* engine changed → fall back to the configured default below */ }
    }
    const configured = approval.config?.policy
    return configured === 'ask' || configured === 'never' ? configured : 'unknown'
  }

  const modeOf = () => {
    if (approvalService() === undefined) return 'switch-only'
    if (!approvalRequired()) return 'off'
    // A deployment whose policy is `never` has no way to ask, so it must not be reported as `ask`.
    return policyOf() === 'never' ? 'policy-never' : 'ask'
  }

  const listener = (exec, next) => {
    const name = String(exec?.name ?? '')
    if (typeof next !== 'function') {
      // The host's waterfall contract is broken. For a NON-write tool that is harmless, but for a
      // write tool this must FAIL CLOSED: the gate exists so that a changed host API can never
      // silently become "writes are unrestricted". The old `return { kind: 'allow' }` did exactly
      // that (review 2026-09-12; the old unit test even pinned it as intended).
      if (!WRITE_TOOL_SET.has(name)) return { kind: 'allow' }
      log(`write gate: refusing ${name} — the pre-execute hook has no \`next\` (host API changed)`)
      return { kind: 'deny', reason: `${name} refused: the approval hook could not run (host API changed)` }
    }
    if (!WRITE_TOOL_SET.has(name)) return next()
    if (writeEnabled() !== true) {
      return { kind: 'deny', reason: `${name} is disabled: the write switch (allowBrowserWriteOps) is off` }
    }
    // The operator's explicit choice wins over the session policy. `approvalForWriteOps: false`
    // means "write ops do not go through the approval seam at all" — in that mode this plugin never
    // asks, so a session whose policy is `never` has nothing to reject and blocking here would be a
    // lie of omission (the operator disabled approval; the panel switch is the gate, `mode` reports
    // `off`). Checked BEFORE the policy probe for exactly that reason.
    if (!approvalRequired()) return next()
    // Otherwise the decision is made from THIS call's policy, not from the session-less mode: a
    // deployment whose default is `never` can still have a session that was switched back to `ask`,
    // and that session must be able to ask (the first version of this fix asked `modeOf()` here and
    // silently ALLOWED that session's writes instead).
    const policy = policyOf(exec?.agent)
    // Under `never` there is nobody to ask and the engine would answer the ask with a rejection —
    // refused here, with the real reason, so the model is not told that a human said no.
    if (policy === 'never') {
      return {
        kind: 'deny',
        reason: `${name} refused: this session's approval policy is "never" (approval prompts are disabled) and ${name} changes the page, so it needs approval. Ask the user to switch the policy back to "ask", or to turn the write switch off.`,
      }
    }
    // A deployment without the approval service cannot ask: the panel switch stays the gate
    // (mode reports `switch-only` and the panel must not imply otherwise). `unknown` is treated as
    // askable — asking fails closed, allowing does not.
    if (policy === 'unavailable') return next()
    return {
      kind: 'ask',
      reason: `${name} will change the page you are looking at (click/type/navigate). Approve this one call?`,
    }
  }

  // Registered through `ctx.effect` so cordis tears the listener down with the plugin. The gate's
  // own `dispose` existed but **no caller ever invoked it** — a hot reload left the old listener
  // on the `tools/pre-execute` bus (review 2026-09-12).
  const off = typeof ctx.on === 'function' ? ctx.on('tools/pre-execute', listener) : () => {}
  const dispose = typeof off !== 'function'
    ? () => {}
    : typeof ctx.effect === 'function'
      ? ctx.effect(() => off, 'ag:write-gate')
      : off
  log(`approval: write-op gate mode=${modeOf()} (recomputed per read)`)
  return {
    get mode() { return modeOf() },
    /** The configured/live policy, for diagnostics (see policyOf). */
    get policy() { return policyOf() },
    listener,
    dispose: typeof dispose === 'function' ? dispose : () => {},
  }
}
