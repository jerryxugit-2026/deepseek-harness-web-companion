/**
 * `GET /ag/whoami` — M0a measurement endpoint (design Q1/Q2).
 *
 * Reports exactly what the browser sent, without faking anything:
 *   - whether a DSH session cookie reached the server for THIS request form,
 *   - the `Origin` / `Sec-Fetch-Site` / `Sec-Fetch-Mode` headers,
 *   - which auth form (§5.4 F1–F4) the request matches.
 *
 * Guarded by the same key+origin rules as `/ag/attach`, except that a request
 * carrying a valid DSH session cookie is also accepted (F4) so the in-frame
 * client can measure itself.
 */
const FORMS = { navigation: 'F1', extension: 'F2/F3', sameOrigin: 'F4' }

export function whoamiRoute({ state }) {
  return async (req, res) => {
    const origin = req.headers.origin ?? null
    const host = req.headers.host ?? ''
    const cookie = req.headers.cookie ?? ''
    const cookieName = /(dsh-auth-[A-Za-z0-9_-]+)=/u.exec(cookie)?.[1] ?? null
    const guard = state.guard()
    const isExtension = typeof origin === 'string' && origin.startsWith('chrome-extension://')
    const isSameOrigin = origin !== null && origin === `http://${host}`
    // A same-origin fetch/WS from the embedded frame sends NO `Origin` header
    // (Fetch spec: same-origin requests omit it), so Origin-absent alone cannot
    // mean "navigation" — request metadata distinguishes them.
    const fetchSite = req.headers['sec-fetch-site'] ?? null
    const fetchMode = req.headers['sec-fetch-mode'] ?? null
    const looksLikeSubresource = fetchSite === 'same-origin' || fetchSite === 'same-site' || fetchMode === 'cors' || fetchMode === 'websocket' || fetchMode === 'no-cors'
    const form = isExtension
      ? FORMS.extension
      : isSameOrigin || (origin === null && looksLikeSubresource && fetchSite !== null && fetchSite !== 'none')
        ? FORMS.sameOrigin
        : origin === null ? FORMS.navigation : 'other'
    const authorized = form === FORMS.sameOrigin
      ? true
      : form === FORMS.navigation ? guard.checkNavigation(req) : guard.checkFetch(req)

    res.writeHead(authorized ? 200 : 403, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    res.end(JSON.stringify({
      ok: authorized,
      protocolVersion: 1,
      form,
      origin,
      host,
      secFetchSite: req.headers['sec-fetch-site'] ?? null,
      secFetchMode: req.headers['sec-fetch-mode'] ?? null,
      secFetchDest: req.headers['sec-fetch-dest'] ?? null,
      cookieHeaderPresent: cookie.length > 0,
      sessionCookiePresent: cookieName !== null,
      sessionCookieName: cookieName,
      cookieCount: cookie === '' ? 0 : cookie.split(';').length,
      // 审计健康状态。审计"悄悄死掉"曾在内外部都不可观测（2026-09-12 审核指出）；放在这条
      // 诊断路由上：它只在同源/带 key 时回答，且**不参与协议 schema**（不牵动 codegen 与向量）。
      ...(typeof state?.auditStatus === 'function' ? { audit: state.auditStatus() } : {}),
    }))
  }
}
