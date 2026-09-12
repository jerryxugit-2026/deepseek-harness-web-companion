/**
 * Capture retention (design docs/03 §7).
 *
 * One capture is one Markdown file. Nothing else in this project deletes them, so
 * without a sweep the capture directory grows forever — and it is a directory the
 * agent reads, so growth is context cost, not just disk cost.
 *
 * Policy: on every capture, delete the files **this bridge wrote** in that same
 * directory once they are older than `retentionHours` (default 24h). Deliberately:
 *
 *   - a **sweep on write**, not a timer: the plugin does no background work, the
 *     cleanup happens exactly when the problem is being created, and a session
 *     that captures nothing pays nothing;
 *   - **only our own file names** are candidates (the `yyyy-MM-dd-HHmm-*.md` stamp
 *     plus `.tmp` leftovers). Anything a user dropped into that folder is theirs —
 *     the count is reported as `kept` and never touched;
 *   - mtime decides age, because it is the one thing that stays true when a file
 *     is copied, restored or renamed — but our names carry the capture time too,
 *     so the report shows both.
 */
import { readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/** The exact shape `store.js` writes: `<yyyy-MM-dd-HHmm>-<slug>-<id6>.md`. */
export const CAPTURE_FILE = /^\d{4}-\d{2}-\d{2}-\d{4}-.*\.md$/u
/** Half-written files from a crashed run (`.tmp` is renamed into place on success). */
export const TEMP_FILE = /\.tmp$/u

/**
 * Delete expired captures in one directory.
 *
 * @param {string} dir absolute capture directory
 * @param {{ retentionHours?: number, now?: number, log?: (line: string) => void }} [options]
 * @returns {Promise<{ removed: {name: string, ageHours: number}[], kept: number, disabled?: boolean, missing?: boolean }>}
 */
export async function sweepCaptures(dir, options = {}) {
  const retentionHours = options.retentionHours ?? 24
  const now = options.now ?? Date.now()
  const log = options.log ?? (() => {})
  // `retentionHours <= 0` is the documented off switch; `undefined` means default.
  if (!(retentionHours > 0)) return { removed: [], kept: 0, disabled: true }

  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    // No captures yet (or the directory was never created) — nothing to do.
    return { removed: [], kept: 0, missing: true }
  }

  const cutoff = now - retentionHours * 3600 * 1000
  const removed = []
  let kept = 0
  for (const entry of entries) {
    if (!entry.isFile()) continue
    if (!CAPTURE_FILE.test(entry.name) && !TEMP_FILE.test(entry.name)) {
      kept += 1
      continue
    }
    const full = join(dir, entry.name)
    const info = await stat(full).catch(() => null)
    if (info === null) continue
    if (info.mtimeMs >= cutoff) {
      kept += 1
      continue
    }
    try {
      await rm(full, { force: true })
      const ageHours = Math.round(((now - info.mtimeMs) / 3600 / 1000) * 10) / 10
      removed.push({ name: entry.name, ageHours })
    } catch (error) {
      // A failed delete must never fail the capture that triggered it.
      log(`retention: could not remove ${entry.name}: ${String(error?.message ?? error)}`)
      kept += 1
    }
  }
  if (removed.length > 0) {
    log(`retention: removed ${String(removed.length)} capture(s) older than ${String(retentionHours)}h (oldest ${String(Math.max(...removed.map((r) => r.ageHours)))}h)`)
  }
  return { removed, kept }
}
