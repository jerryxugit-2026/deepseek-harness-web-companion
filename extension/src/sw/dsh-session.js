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
import { DEV_CONFIG } from '../lib/dev-config.js'
import { ensureDsh as nativeEnsureDsh } from './native-host.js'
import { t } from '../lib/i18n.js'

const DEV_KEY = DEV_CONFIG.key
import { dshOrigin, dshPort, enterUrl, enterUrlWithTicket, isPaired, pingUrl, ticketUrl } from '../lib/urls.js'

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
 * Exchange the pairing key for a single-use entry ticket (design §5.4).
 * The key stays inside the service worker; only the ticket reaches the frame URL.
 * @returns {Promise<ReturnType<typeof ok> | ReturnType<typeof fail>>}
 */
export async function requestTicket(timeoutMs = 3000) {
  if (!isPaired()) return fail('E_UNPAIRED', 'extension has no pairing key')
  const response = await fetchWithTimeout(`${ticketUrl()}?key=${encodeURIComponent(TICKET_KEY())}`, { method: 'POST' }, timeoutMs)
  if (!response.ok) return response
  if (response.value.status !== 200) return fail('E_AUTH', `ticket request rejected with HTTP ${String(response.value.status)}`)
  const payload = await response.value.json()
  const validated = validateAs('TicketResponse', payload)
  if (!validated.ok) return fail('E_PAYLOAD', `ticket payload rejected: ${validated.error.message}`)
  return ok(payload)
}

/** Indirection so tests can inject a key without touching dev-config. */
function TICKET_KEY() {
  return DEV_KEY
}

/**
 * Full pre-flight: DSH up, plugin loaded, pairing provisioned, versions aligned.
 * @returns {Promise<{ ok: boolean, url?: string, state: object, error?: object }>}
 */
export async function ensureReady() {
  let ping = await probe()
  let started = false
  let nativeNote
  if (!ping.ok) {
    // Not listening → ask the native host to start `dsh web`, then probe again.
    const started_ = await nativeEnsureDsh({ port: dshPort(), timeoutMs: 25000 })
    if (started_.ok) {
      started = started_.value?.started === true
      nativeNote = started_?.value
      for (let i = 0; i < 20 && !ping.ok; i += 1) {
        await new Promise((r) => { setTimeout(r, 500) })
        ping = await probe(1500)
      }
    } else {
      return {
        ok: false,
        state: { dsh: 'down', native: started_.error.code },
        error: {
          code: started_.error.code === 'E_NATIVE_MISSING' ? 'E_NATIVE_MISSING' : 'E_DSH_DOWN',
          message: started_.error.code === 'E_NATIVE_MISSING'
            ? t('dshDownNoNativeHost')
            : t('dshAutoStartFailed', [started_.error.message]),
        },
      }
    }
    if (!ping.ok) {
      return { ok: false, state: { dsh: 'down', native: nativeNote }, error: { code: 'E_DSH_DOWN', message: t('dshNotReady', [dshOrigin()]) } }
    }
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
        message: t('errNotPaired'),
      },
    }
  }
  // Prefer the ticket handshake: the long-lived key never enters the frame URL (design T9).
  let ticket = await requestTicket()
  if (!ticket.ok) {
    // One retry: a ticket can fail merely because the plugin restarted between probe and request.
    await new Promise((r) => { setTimeout(r, 400) })
    ticket = await requestTicket()
  }
  if (ticket.ok) {
    return {
      ok: true,
      url: enterUrlWithTicket(ticket.value.ticket),
      state: { dsh: 'up', port: dshPort(), plugin: info, handshake: 'ticket', ticketExpiresAt: ticket.value.expiresAt, autoStarted: started },
    }
  }
  // Fail closed. This used to fall back to `enterUrl()` — i.e. the shared pairing key silently
  // went into the iframe URL, where it lands in browser history, `Referer` and access logs. That
  // contradicted both the comment above and design T9 ("key 不进网页可达位置"); §7.4's `?token=`
  // fallback is a *user-initiated* step (paste the URL `dsh web` printed), never an automatic one.
  return {
    ok: false,
    state: { dsh: 'up', port: dshPort(), plugin: info, handshake: 'ticket-failed', ticketError: ticket.error.code },
    error: {
      code: 'E_UNPAIRED',
      message: t('errTicketFailed', [String(ticket.error.code), String(ticket.error.message)]),
    },
  }
}
