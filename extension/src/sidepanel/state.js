/**
 * Minimal observable state store for the panel (docs/02 §3.8).
 * Pure logic, no DOM: unit-testable.
 */

/** @typedef {'unknown'|'down'|'up'|'starting'} DshState */
/** @typedef {'idle'|'sending'|'attached'|'failed'} AttachState */

/**
 * @param {{ dsh?: DshState, attach?: AttachState, message?: string, url?: string }} initial
 */
export function createStore(initial = {}) {
  let state = { dsh: 'unknown', attach: 'idle', message: '', url: '', ...initial }
  const listeners = new Set()

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    /** Merge a patch; notify subscribers only when something changed. */
    dispatch(patch) {
      const next = { ...state, ...patch }
      const changed = Object.keys(patch).some((key) => state[key] !== next[key])
      state = next
      if (changed) for (const listener of [...listeners]) listener(state)
      return changed
    },
  }
}
