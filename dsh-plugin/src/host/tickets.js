/**
 * One-time entry tickets (design §5.4 key lifecycle).
 *
 * The long-lived pairing key must never sit in a frame URL (it would linger in
 * history, referrers and screenshots). The panel exchanges the key for a ticket
 * through `POST /ag/ticket`, puts only the ticket in the iframe `src`, and the
 * ticket dies the moment `/ag/enter` consumes it — once, within a short TTL.
 *
 * The store is pure (clock and randomness are injected) so expiry and
 * single-use semantics are unit-testable without waiting for wall time.
 */
import { randomBytes } from 'node:crypto'

const DEFAULT_TTL_MS = 30000

/** @param {{ ttlMs?: number, now?: () => number, random?: () => string, limit?: number }} [options] */
export function createTicketStore(options = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
  const now = options.now ?? Date.now
  const random = options.random ?? (() => randomBytes(24).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, ''))
  const limit = options.limit ?? 64
  /** @type {Map<string, number>} ticket → expiry */
  const live = new Map()

  const prune = (at) => {
    for (const [ticket, expiresAt] of live) if (expiresAt <= at) live.delete(ticket)
  }

  return {
    /** Issue one ticket; returns it with its expiry. */
    issue() {
      const at = now()
      prune(at)
      while (live.size >= limit) live.delete(live.keys().next().value)
      const ticket = random()
      live.set(ticket, at + ttlMs)
      return { ticket, expiresAt: at + ttlMs, ttlMs }
    },

    /** Consume a ticket exactly once; false when unknown, used or expired. */
    consume(ticket) {
      if (typeof ticket !== 'string' || ticket === '') return false
      const at = now()
      const expiresAt = live.get(ticket)
      if (expiresAt === undefined) return false
      live.delete(ticket)
      return expiresAt > at
    },

    /** Outstanding (unexpired) ticket count — for /ag/ping diagnostics. */
    get liveCount() {
      prune(now())
      return live.size
    },
  }
}
