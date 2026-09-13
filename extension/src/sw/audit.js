/**
 * Extension-side audit ring buffer (design §9 「审计」: 扩展记录 capture / attach / tool).
 *
 * Why: on 2026-09-12 a capture appeared that the user did not expect, and there was no
 * way to ask the *extension* what it had done — the SW kept only `lastState` in memory,
 * which MV3 discards after ~30s idle. The plugin side now writes a JSONL trail; this is
 * the other half of the same question: "did the extension even attempt a capture, with
 * which trigger, and what did the host answer?"
 *
 * Privacy rules (structural, not by convention):
 *   - **Host name only, never the path or query.** The design asks for `domain`; a full
 *     URL would leak search terms, document ids and tokens in the query string.
 *   - No page text, no selection text, no key, no cookie. Only the allow-listed fields
 *     below are ever persisted — a future caller cannot leak by adding a field.
 *   - Bounded: the newest {@link AUDIT_LIMIT} entries, oldest dropped first.
 *
 * Read it with `chrome.runtime.sendMessage({ kind: 'audit' })`.
 */
const AUDIT_KEY = 'ag-audit'
const AUDIT_LIMIT = 200

/** The only keys allowed into storage. */
export const AUDIT_FIELDS = Object.freeze([
  'kind',      // capture | tool
  'ok',
  'code',      // error code when ok === false
  'mode',      // page | selection | screenshot
  'trigger',   // look_left | button | shortcut | manual
  'domain',    // HOST ONLY
  'chars',
  'truncated',
  'captureId',
  'tool',
  'tabId',
  'ms',
])

/** Keep only allow-listed, scalar, size-capped values. */
export function projectAudit(entry) {
  const out = {}
  for (const key of AUDIT_FIELDS) {
    const value = entry?.[key]
    if (value === undefined || value === null) continue
    const type = typeof value
    if (type === 'string') out[key] = value.slice(0, 120)
    else if (type === 'number' || type === 'boolean') out[key] = value
  }
  return out
}

/** Host name of a tab URL, or undefined when it is not a normal page. */
export function hostOf(url) {
  try {
    const parsed = new URL(String(url ?? ''))
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.host : undefined
  } catch { return undefined }
}

/** Append one entry (never throws — auditing must not break a capture). */
export async function recordAudit(entry) {
  try {
    const stored = await chrome.storage.local.get(AUDIT_KEY)
    const list = Array.isArray(stored?.[AUDIT_KEY]) ? stored[AUDIT_KEY] : []
    list.push({ ts: Date.now(), ...projectAudit(entry) })
    while (list.length > AUDIT_LIMIT) list.shift()
    await chrome.storage.local.set({ [AUDIT_KEY]: list })
    return true
  } catch { return false }
}

/** Newest last. */
export async function readAudit() {
  try {
    const stored = await chrome.storage.local.get(AUDIT_KEY)
    return Array.isArray(stored?.[AUDIT_KEY]) ? stored[AUDIT_KEY] : []
  } catch { return [] }
}

export { AUDIT_KEY, AUDIT_LIMIT }
