/**
 * Frame budget for `/ag/agent` replies (M3).
 *
 * The bridge plugin needs screenshot **pixels** to persist them into the workspace,
 * but a tool result also travels as one WebSocket frame, so the extension trims
 * what cannot fit instead of failing the whole call.
 *
 * The first version dropped every `base64` field unconditionally — which made
 * `browser_screenshot` structurally unable to succeed (the plugin then reported
 * `E_STORAGE: extension returned no pixels`). Keeping pixels below a generous cap
 * and dropping only the oversized ones is the honest split: the small ones work,
 * the huge ones are refused with the reason attached.
 */

/** ~6 MB of base64 (≈4.5 MB of PNG) — comfortably inside a local socket frame. */
export const MAX_BASE64_CHARS = 6_000_000
/** Markdown beyond this is clipped in the frame; the file on disk stays complete. */
export const MAX_MARKDOWN_CHARS = 20000

/**
 * @param {any} value tool value from the service worker
 * @returns {any} a value that fits the frame, with explicit notes about what was cut
 */
export function withinFrameBudget(value) {
  if (value === null || typeof value !== 'object') return value
  const copy = { ...value }
  if (typeof copy.base64 === 'string') {
    const bytes = copy.bytes ?? Math.round((copy.base64.length * 3) / 4)
    if (copy.base64.length > MAX_BASE64_CHARS) {
      copy.base64Omitted = true
      copy.base64Bytes = bytes
      delete copy.base64
      copy.notes = [...(Array.isArray(copy.notes) ? copy.notes : []), `pixels dropped: ${String(bytes)} bytes exceeds the ${String(Math.round(MAX_BASE64_CHARS * 3 / 4 / 1024 / 1024))}MB frame budget`]
    } else {
      copy.bytes = bytes
    }
  }
  if (typeof copy.markdown === 'string' && copy.markdown.length > MAX_MARKDOWN_CHARS) {
    const total = copy.chars ?? copy.markdown.length
    copy.markdown = `${copy.markdown.slice(0, MAX_MARKDOWN_CHARS)}\n…[truncated in frame: ${String(total)} chars total; read the file for the rest]`
    copy.markdownTruncatedInFrame = true
  }
  return copy
}
