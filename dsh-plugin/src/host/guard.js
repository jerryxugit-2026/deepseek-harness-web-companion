/**
 * Request gate for every `/ag/*` route.
 *
 * Three request shapes, deliberately gated differently:
 *   - `navigation` (iframe `src`, popup window): a browser sends NO `Origin`
 *     header on navigations, so the shared key alone decides. The key is never
 *     exposed to page scripts (the extension puts it in the iframe URL, the
 *     server answers 303 and `Referrer-Policy: no-referrer` keeps it out of
 *     later requests).
 *   - `fetch` (extension service worker / panel page): key AND exact
 *     `Origin: chrome-extension://<id>`.
 *   - `upgrade` (WebSocket handshake): same as fetch — Chrome does send
 *     `Origin` for WS handshakes.
 *
 * See docs/08-security.md T1/T2/T4/T9.
 */
import { timingSafeEqual } from 'node:crypto'

/** Extract the shared key from `?key=` or the `x-ag-key` header. */
function keyOf(req) {
  try {
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const fromQuery = url.searchParams.get('key')
    if (typeof fromQuery === 'string' && fromQuery !== '') return fromQuery
  } catch {
    return undefined
  }
  const header = req.headers['x-ag-key']
  return typeof header === 'string' && header !== '' ? header : undefined
}

/** Constant-time comparison that tolerates length mismatch. */
function sameSecret(actual, expected) {
  const a = Buffer.from(actual, 'utf8')
  const b = Buffer.from(expected, 'utf8')
  if (a.byteLength !== b.byteLength) return false
  return timingSafeEqual(a, b)
}

/**
 * @param {{ key: string | undefined, extensionOrigins: readonly string[] }} pairing
 */
export function createGuard(pairing) {
  const origins = new Set(pairing.extensionOrigins)
  const key = pairing.key

  const keyOk = (req) => key !== undefined && key.length > 0 && (() => {
    const presented = keyOf(req)
    return presented !== undefined && sameSecret(presented, key)
  })()

  const originOk = (req) => {
    const origin = req.headers.origin
    return typeof origin === 'string' && origins.has(origin)
  }

  return {
    /** Whether the pairing file is complete enough to serve anything. */
    configured: key !== undefined && key.length > 0 && origins.size > 0,

    /** Iframe/popup navigation: key only. */
    checkNavigation: (req) => keyOk(req),

    /** fetch/XHR from the extension: key and origin. */
    checkFetch: (req) => keyOk(req) && originOk(req),

    /** WebSocket handshake: key and origin. */
    checkUpgrade: (req) => keyOk(req) && originOk(req),
  }
}
