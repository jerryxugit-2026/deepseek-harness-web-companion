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
 */
export const WRITE_TOOLS = Object.freeze(['browser_click', 'browser_type', 'browser_navigate'])

const WRITE_TOOL_SET = new Set(WRITE_TOOLS)

/**
 * @param {object} options
 * @param {object} options.ctx plugin context (needs `get` and `on`)
 * @param {() => boolean} options.writeEnabled current value of `allowBrowserWriteOps`
 * @param {() => boolean} [options.approvalRequired] whether to route each call to a human
 * @param {(line: string) => void} [options.log]
 * @returns {{ mode: 'ask' | 'switch-only' | 'off', listener: Function, dispose: () => void }}
 */
export function createWriteGate({ ctx, writeEnabled, approvalRequired = () => true, log = () => {} }) {
  const hasApprovalService = typeof ctx.get === 'function' && ctx.get('approval') !== undefined
  const mode = !hasApprovalService ? 'switch-only' : approvalRequired() ? 'ask' : 'off'

  const listener = (exec, next) => {
    // Defensive: without the innermost `next` this hook cannot let anything through,
    // so refuse to be the reason a tool call hangs — hand control back.
    if (typeof next !== 'function') return { kind: 'allow' }
    const name = String(exec?.name ?? '')
    if (!WRITE_TOOL_SET.has(name)) return next()
    if (writeEnabled() !== true) {
      return { kind: 'deny', reason: `${name} is disabled: the write switch (allowBrowserWriteOps) is off` }
    }
    if (mode === 'ask') {
      return {
        kind: 'ask',
        reason: `${name} will change the page you are looking at (click/type/navigate). Approve this one call?`,
      }
    }
    return next()
  }

  const dispose = typeof ctx.on === 'function' ? ctx.on('tools/pre-execute', listener) : () => {}
  log(`approval: write-op gate mode=${mode} (approval service ${hasApprovalService ? 'present' : 'absent'})`)
  return { mode, listener, dispose: typeof dispose === 'function' ? dispose : () => {} }
}
