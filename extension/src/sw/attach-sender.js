/**
 * Capture submission (design docs/02 §3.5).
 *
 * Sends one `/ag/attach` request with the pairing key (form F2: the extension
 * page, so key + exact `Origin`). Retries only on transport timeouts — a 4xx is
 * a contract failure and must surface instead of being retried.
 */
import { DEV_CONFIG } from '../lib/dev-config.js'
import { attachUrl } from '../lib/urls.js'
import { fail, ok } from '../lib/result.js'

const RETRIES = 2
const BACKOFF_MS = [300, 900]
const TIMEOUT_MS = 8000

/** One attempt with an abort deadline. */
async function attempt(body, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => { controller.abort() }, timeoutMs)
  try {
    const response = await fetch(`${attachUrl()}?key=${encodeURIComponent(DEV_CONFIG.key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const payload = await response.json().catch(() => null)
    if (response.ok && payload?.ok === true) return ok(payload)
    const code = payload?.error?.code ?? (response.status === 413 ? 'E_TOO_LARGE' : 'E_STORAGE')
    const error = fail(code, payload?.error?.message ?? `attach failed with HTTP ${String(response.status)}`)
    error.retryable = code === 'E_TIMEOUT'
    return error
  } catch (error) {
    const wrapped = fail('E_TIMEOUT', String(error?.message ?? error))
    wrapped.retryable = true
    return wrapped
  } finally {
    clearTimeout(timer)
  }
}

/** Send with bounded retries on timeout/transport failures only. */
export async function sendCapture(body) {
  let last = await attempt(body, TIMEOUT_MS)
  for (let i = 0; i < RETRIES && last.ok === false && last.retryable === true; i += 1) {
    await new Promise((r) => { setTimeout(r, BACKOFF_MS[i] ?? 900) })
    last = await attempt(body, TIMEOUT_MS)
  }
  return last
}
