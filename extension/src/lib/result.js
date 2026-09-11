/**
 * Uniform result model (docs/02 §3): every fallible helper returns
 * `{ ok: true, value }` or `{ ok: false, error: { code, message, detail? } }`.
 */

/** @typedef {{ code: string, message: string, detail?: unknown }} CompanionError */

/** @param {unknown} value @returns {{ ok: true, value: unknown }} */
export const ok = (value) => ({ ok: true, value })

/**
 * @param {string} code error code from docs/01 §2.6
 * @param {string} message human-readable, shown in the panel
 * @param {unknown} [detail]
 */
export const fail = (code, message, detail) => ({ ok: false, error: { code, message, detail } })

/** Wrap a promise-returning thunk into a Result, mapping thrown errors to `E_INTERNAL`. */
export async function attempt(code, thunk) {
  try {
    return ok(await thunk())
  } catch (error) {
    return fail(code, error instanceof Error ? error.message : String(error))
  }
}

/** fetch with an abort deadline; rejects nothing, always resolves to a Result. */
export async function fetchWithTimeout(url, init = {}, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal })
    return ok(response)
  } catch (error) {
    return fail('E_TIMEOUT', error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(timer)
  }
}
