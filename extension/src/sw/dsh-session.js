/**
 * DSH session helpers: probe the bridge plugin, decide the embedding URL, and
 * verify that the embedded app actually authenticated.
 *
 * Verified behaviour this module relies on (FINDINGS §3):
 *   - a `SameSite=None; Secure` cookie set for `http://127.0.0.1:<port>/` is
 *     delivered inside a `chrome-extension://` page iframe, for fetch AND for
 *     the WebSocket handshake;
 *   - `SameSite=Strict` (what DSH itself issues) breaks only the WebSocket,
 *     leaving the UI stuck on "connection lost".
 */
import { fetchWithTimeout, fail, ok } from '../lib/result.js'
import { PROTOCOL_VERSION, validateAs } from '../lib/protocol.generated.js'
import { dshOrigin, dshPort, enterUrl, isPaired, pingUrl } from '../lib/urls.js'

/**
 * Probe `/ag/ping`.
 * @returns {Promise<ReturnType<typeof ok> | ReturnType<typeof fail>>}
 */
export async function probe(timeoutMs = 1500) {
  const response = await fetchWithTimeout(pingUrl(), { method: 'GET', cache: 'no-store' }, timeoutMs)
  if (!response.ok) return response
  if (response.value.status !== 200) {
    return fail('E_PLUGIN', `bridge plugin answered HTTP ${String(response.value.status)}`)
  }
  try {
    const payload = await response.value.json()
    const validated = validateAs('PingResponse', payload)
    if (!validated.ok) return fail('E_PAYLOAD', `bridge plugin ping payload rejected: ${validated.error.message}`)
    return ok(payload)
  } catch (error) {
    return fail('E_PAYLOAD', `bridge plugin returned non-JSON: ${String(error)}`)
  }
}

/**
 * Full pre-flight: DSH up, plugin loaded, pairing provisioned, versions aligned.
 * @returns {Promise<{ ok: boolean, url?: string, state: object, error?: object }>}
 */
export async function ensureReady() {
  const ping = await probe()
  if (!ping.ok) {
    return { ok: false, state: { dsh: 'down' }, error: { code: 'E_DSH_DOWN', message: `DSH is not reachable at ${dshOrigin()}` } }
  }
  const info = ping.value
  if (info.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, state: { dsh: 'up', plugin: info }, error: { code: 'E_VERSION', message: `protocol mismatch: plugin=${String(info.protocolVersion)} extension=1` } }
  }
  if (info.paired !== true || !isPaired()) {
    return {
      ok: false,
      state: { dsh: 'up', plugin: info },
      error: {
        code: 'E_UNPAIRED',
        message: 'extension and plugin are not paired yet — run `node scripts/init-key.mjs` and reload the extension',
      },
    }
  }
  return { ok: true, url: enterUrl(), state: { dsh: 'up', port: dshPort(), plugin: info } }
}
