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

  /**
   * The extension proves itself, in the only two ways Chrome actually lets it.
   *
   * Form F2 is "key + exact `Origin`", and that is what this checks — but Chrome does **not**
   * send `Origin` on a *simple* cross-origin GET from an extension document (measured
   * 2026-09-12 against a real panel document: `GET /ag/control?key=…` arrived with
   * `origin: null, sec-fetch-site: none, sec-fetch-mode: cors`, and the strict check answered
   * 403 — so the panel's 「read the switch」 call could never succeed; the v3.40 change from
   * POST to GET for that read was therefore never verified in a browser). Non-simple methods
   * (POST) *do* carry the exact `Origin`, which is why the flip always worked.
   *
   * So the same request is accepted when the browser certifies the initiator instead:
   * `Sec-Fetch-Site: none` **and** `Sec-Fetch-Mode: cors`. Both headers are set by the browser
   * and cannot be forged by a page (a website's fetch is `cross-site`, a navigation is
   * `navigate`), and the pairing key is still required — so this is not a loosening of the
   * credential, only of the *shape* the credential arrives in. Symmetric with F4, which already
   * spells out what "Origin absent" is allowed to mean.
   */
  const originOk = (req) => {
    const origin = req.headers.origin
    if (typeof origin === 'string') return origins.has(origin)
    return req.headers['sec-fetch-site'] === 'none' && req.headers['sec-fetch-mode'] === 'cors'
  }

  /** Does the request carry a DSH session cookie (`dsh-auth-…`)? */
  const sessionCookieOk = (req) => {
    const raw = req.headers.cookie
    return typeof raw === 'string' && raw.split(';').some((part) => part.trim().startsWith('dsh-auth-'))
  }

  /**
   * Form F4 (design §5.4): the DSH page's own client half.
   *
   * Design §5.4 spells the rule out in full: an `Origin`, **when present**, must equal this
   * server's own authority; when it is **absent**, same-origin-ness must be established
   * from `Sec-Fetch-Site: same-origin` **plus a session cookie**.
   *
   * The implementation used to stop at "absent ⇒ accept". That branch also matches every
   * request the browser sends *without* `Origin` for reasons that have nothing to do with
   * same-origin: navigations and subresources (`<img>`, `<script>`, `<link>`) send none.
   * So a web page could reach these routes with no credential at all — and `GET /ag/pending`
   * is destructive (`store.drain()` splices), i.e. `<img src="http://127.0.0.1:3080/ag/pending">`
   * on any site could empty the queue. Fixed to the documented rule; callers that are not a
   * browser (probes, scripts) must send an explicit `Origin` naming this authority — which
   * is exactly what they already do.
   */
  const sameOriginOk = (req) => {
    const origin = req.headers.origin
    const host = req.headers.host
    if (typeof origin === 'string') return typeof host === 'string' && origin === `http://${host}`
    return req.headers['sec-fetch-site'] === 'same-origin' && sessionCookieOk(req)
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

    /**
     * Client-half channel/endpoints (form F4).
     *
     * The DSH page's own client half holds no key on purpose — the key never
     * belongs in page JavaScript. Same-origin is the credential (see `sameOriginOk`
     * for what "same-origin" is allowed to mean), with key+extension-origin as the
     * non-browser/extension path.
     */
    checkClient: (req) => sameOriginOk(req) || (keyOk(req) && originOk(req)),
  }
}
