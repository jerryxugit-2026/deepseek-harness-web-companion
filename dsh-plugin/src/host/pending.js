/**
 * Backlog delivery (design §4.2 `request-pending`, docs/03 §3.2).
 *
 * A capture is queued by `attachRoute` when no DSH page half was connected
 * (`deliveredTo: []`). The client half asks for whatever it missed on **every**
 * (re)connect, and this is the answer to that ask.
 *
 * Why this is a module instead of three lines inside `index.js`: the interesting
 * branch is the one where delivery FAILS, and that branch decides whether a
 * capture survives or is silently dropped. It is unreachable from the probes
 * (they would need a page half that cannot receive), so it is unit-tested here
 * against the real hub and the real queue.
 */
export function createPendingDelivery({ hub, store, audit = { append: () => false }, log = () => {} }) {
  /**
   * Deliver the queue to the page half that asked for it.
   *
   * @param {{ id?: string }} [entry] the page half that sent `request-pending`
   * @returns {number} how many queued captures a page half accepted
   */
  return (entry) => {
    const queued = store.drain()
    if (queued.length === 0) return 0
    let delivered = 0
    for (const item of queued) {
      // A queued 「看左边」 must still land on the half that asked, or `sessionMode: 'current'`
      // inserts into the wrong page's session. When the capture has no owner (a context-menu
      // capture taken while the page was closed) the requester is the natural recipient.
      const to = hub.pushClientPrimary(item, item.ownerClientId ?? entry?.id)
      if (to === null) {
        // Put it back: a drain that deletes what it could not deliver is the bug this
        // module exists to fix, not a tool to reintroduce.
        store.enqueue(item)
        continue
      }
      delivered += 1
      log(
        `pending capture ${String(item.captureId)} → ${to}` +
        (typeof item.ownerClientId === 'string' ? ` (owner ${item.ownerClientId})` : ' (no owner)'),
      )
    }
    const requeued = queued.length - delivered
    if (requeued > 0) log(`pending: ${String(requeued)} capture(s) could not be delivered, kept in the queue`)
    audit.append({ kind: 'pending-replay', queued: queued.length, delivered, requeued })
    return delivered
  }
}
