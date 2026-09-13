/**
 * Bounded log rotation for the native messaging host.
 *
 * The host log is appended to for the whole life of the install (`ensure-dsh` /
 * `status` / `stop-dsh` one line each), and it had **no size cap at all** — the one
 * place in this project that could grow without bound. The capture directory and the
 * screenshot directory have the 24h sweep, and the bridge's audit trail rotates on
 * append; this brings the native host log in line with them.
 *
 * Deliberately self-contained (no import from `dsh-plugin/`): the native host must stay
 * runnable on its own — Chrome spawns it directly, outside any DSH process.
 *
 * Both helpers are silent on failure: a logging problem must never break the native
 * messaging protocol (stdout carries frames and nothing else).
 */
import { readFileSync, statSync, writeFileSync } from 'node:fs'

/**
 * Trim `file` to its last `keepLines` lines once it exceeds `maxBytes`.
 *
 * @param {string} file absolute log path
 * @param {{ maxBytes?: number, keepLines?: number }} [options]
 * @returns {{ rotated: boolean, bytes: number }} `bytes` is the size before trimming
 */
export function rotateIfNeeded(file, options = {}) {
  const maxBytes = options.maxBytes ?? 512 * 1024
  const keepLines = options.keepLines ?? 800
  try {
    const bytes = statSync(file).size
    if (bytes <= maxBytes) return { rotated: false, bytes }
    const lines = readFileSync(file, 'utf8').split('\n').filter((line) => line !== '')
    const kept = lines.slice(-keepLines)
    writeFileSync(file, kept.length === 0 ? '' : `${kept.join('\n')}\n`, 'utf8')
    return { rotated: true, bytes }
  } catch {
    // No file yet / not readable / read-only home: nothing to do, never throw.
    return { rotated: false, bytes: 0 }
  }
}
