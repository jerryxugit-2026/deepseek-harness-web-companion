/**
 * Metadata-only audit trail (design §9 「审计」).
 *
 * Why this exists: on 2026-09-12 a capture created a session out of nowhere and the
 * question "which trigger fired it?" was **unanswerable** — the plugin kept captures
 * only in memory (`recent`, capped at 50) and the instance that served the event was
 * already gone. The design had promised exactly this log all along:
 *
 *     ts, origin, route, status, bytes, duration, captureId  （无 key/正文）
 *
 * Rules this file enforces structurally, not by convention:
 *   - **Allow-list, not redaction.** Only keys in {@link AUDIT_FIELDS} are ever
 *     written; anything else (page markdown, URLs, the pairing key, tokens) is
 *     dropped before it reaches the file. A field added by a future caller cannot
 *     leak by accident — it simply does not get written.
 *   - **Never breaks the feature.** Every failure (disk full, read-only home,
 *     permission) disables the log once and is reported through `log`; the capture
 *     path keeps working.
 *   - **Bounded.** Rotates to the last `keepLines` lines once the file passes
 *     `maxBytes`, so a long-lived install cannot grow the log without limit.
 *
 * Correlation with files on disk: the capture file name ends with the last 6 chars of
 * the captureId (`store.js` → `-<captureId.slice(-6)>.md`), so `captureId` alone is
 * enough to tie a line back to a file without recording the path (which embeds the
 * page title).
 */
import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The only keys that may reach the file. Keep this list short and non-sensitive. */
export const AUDIT_FIELDS = Object.freeze([
  'kind',        // attach | capture-result | ack | control | tool
  'captureId',
  'requestId',
  'trigger',     // look_left | button | shortcut | manual  ← the field whose absence made the hijack unexplainable
  'sessionMode', // current | new
  'mode',        // page | selection | selection+page | screenshot
  'delivered',   // how many client sockets received the attach
  'queued',      // pending-replay: how many captures the backlog held when the page asked
  'requeued',    // pending-replay: how many of them were undeliverable and stayed queued
  'status',      // ack: inserted | dismissed | failed
  'ok',
  'errorCode',
  'chars',
  'truncated',
  'hasSelection',
  'pruned',
  'tool',
  'bytes',
  'durationMs',
  'route',
  'origin',
])

/** Drop every key that is not on the allow-list (and every undefined/oversized value). */
function project(entry) {
  const out = {}
  for (const key of AUDIT_FIELDS) {
    const value = entry?.[key]
    if (value === undefined || value === null) continue
    const type = typeof value
    if (type === 'string') out[key] = value.slice(0, 200)
    else if (type === 'number' || type === 'boolean') out[key] = value
  }
  return out
}

/**
 * @param {object} options
 * @param {string} options.file absolute path of the JSONL file
 * @param {number} [options.maxBytes] rotate past this size
 * @param {number} [options.keepLines] lines kept when rotating
 * @param {(line: string) => void} [options.log]
 */
export function createAuditLog({ file, maxBytes = 512 * 1024, keepLines = 1200, log = () => {} }) {
  let ok = 0        // 成功写入的次数
  let failed = 0    // 失败次数（**不**永久停写，见下）
  let lastError
  let announced = false

  const rotateIfNeeded = () => {
    const size = statSync(file).size
    if (size <= maxBytes) return false
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    const kept = lines.slice(-keepLines)
    writeFileSync(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
    return true
  }

  return {
    file,
    /**
     * Append one entry. Returns true only when it reached the file.
     *
     * A failure does **not** latch the log off any more. It used to set `enabled = false`
     * permanently: one transient IO error (disk busy, a read-only remount, a rotated-away
     * directory) killed auditing for the rest of the process lifetime, with no way back — and
     * since every caller ignores the return value and nothing exposed the state, "the audit is
     * dead" was invisible from inside *and* outside. Audit's whole purpose is to answer questions
     * after the fact, so it must not die quietly (review 2026-09-12). Now: keep trying, count the
     * failures, announce the first one loudly, and expose `status()`.
     */
    append(entry) {
      try {
        mkdirSync(dirname(file), { recursive: true })
        appendFileSync(file, `${JSON.stringify({ ts: new Date().toISOString(), ...project(entry) })}\n`, 'utf8')
        rotateIfNeeded()
        ok += 1
        return true
      } catch (error) {
        failed += 1
        lastError = String(error?.message ?? error)
        if (!announced) {
          announced = true
          log(`audit log write FAILED (${lastError}) — file: ${file}；不会停写，会继续重试`)
        }
        return false
      }
    },
    /** Health surface (exposed by `/ag/whoami`): is auditing actually working right now? */
    status() {
      return { enabled: failed === 0, written: ok, failed, ...(lastError === undefined ? {} : { lastError }) }
    },
    /** Read the last `limit` entries (probes / tests / debugging). */
    read(limit = 100) {
      try {
        const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
        return lines.slice(-limit).map((line) => { try { return JSON.parse(line) } catch { return { unparsable: line.slice(0, 120) } } })
      } catch { return [] }
    },
    /** Convenience getter for the same health signal as `status().enabled`. */
    get enabled() { return failed === 0 },
  }
}
