/**
 * M0a cookie-matrix probe (design Q1 + Q2).
 *
 * Runs on the EXTENSION page and measures, for each cookie variant, what the
 * server actually receives in four request forms:
 *
 *   1. extension page  → fetch      (form F2)
 *   2. embedded frame  → fetch      (form F4, what the DSH SPA itself does)
 *   3. extension page  → WebSocket  (form F3)
 *   4. embedded frame  → WebSocket  (the handshake that broke with SameSite=Strict)
 *
 * Parameters come from the query string: ?port=&key=&variants=
 * Results are printed to the console (CDP reads them) and mirrored into #log.
 */
const params = new URLSearchParams(location.search)
const PORT = params.get('port') ?? '3099'
const KEY = params.get('key') ?? ''
const ORIGIN = `http://127.0.0.1:${PORT}`
const WS_ORIGIN = `ws://127.0.0.1:${PORT}`
const VARIANTS = (params.get('variants') ?? 'strict,none-secure,partitioned').split(',')

const log = document.getElementById('log')
const frame = document.getElementById('frame')
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

function say(line) {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  log.textContent = `${log.textContent}\n${text}`
  console.log('[cookie-matrix]', text)
}

/** Install one cookie variant through the extension cookies API. */
async function installCookie(variant) {
  const name = await cookieNameForAuthority(`127.0.0.1:${PORT}`)
  await new Promise((resolve) => chrome.cookies.remove({ url: `${ORIGIN}/`, name }, () => resolve()))
  await new Promise((resolve) => chrome.cookies.remove({ url: `${ORIGIN}/`, name, partitionKey: { topLevelSite: `chrome-extension://${chrome.runtime.id}` } }, () => resolve()))
  const details = {
    url: `${ORIGIN}/`, name, value: 'PROBE-VALUE', path: '/', httpOnly: true,
  }
  if (variant === 'strict') details.sameSite = 'strict'
  if (variant === 'none') { details.sameSite = 'no_restriction' }
  if (variant === 'none-secure') { details.sameSite = 'no_restriction'; details.secure = true }
  if (variant === 'partitioned') {
    details.sameSite = 'no_restriction'
    details.secure = true
    details.partitionKey = { topLevelSite: `chrome-extension://${chrome.runtime.id}` }
  }
  const stored = await new Promise((resolve) => chrome.cookies.set(details, resolve))
  return { variant, stored: stored === null ? null : { sameSite: stored.sameSite, secure: stored.secure, partitionKey: stored.partitionKey ?? null } }
}

/** The cookie NAME is derived from the request authority (DSH format). */
async function cookieNameForAuthority(authority) {
  const bytes = new TextEncoder().encode(authority)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const b64 = btoa(String.fromCharCode(...new Uint8Array(digest))).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  return `dsh-auth-${b64}`
}

/** Context 1/3: from the extension page itself. */
async function extensionFetch() {
  try {
    const res = await fetch(`${ORIGIN}/ag/whoami?key=${encodeURIComponent(KEY)}`, { credentials: 'include' })
    return await res.json()
  } catch (error) { return { error: String(error) } }
}

function extensionWebSocket() {
  return new Promise((resolve) => {
    try {
      const socket = new WebSocket(`${WS_ORIGIN}/ag/wsprobe`)
      const done = (value) => { try { socket.close() } catch { /* noop */ } ; resolve(value) }
      socket.addEventListener('message', (event) => { try { done(JSON.parse(event.data)) } catch (e) { done({ parseError: String(e) }) } })
      socket.addEventListener('error', () => done({ wsError: 'error event' }))
      socket.addEventListener('close', (event) => done({ wsClosed: event.code }))
      setTimeout(() => done({ wsTimeout: true }), 4000)
    } catch (error) { resolve({ thrown: String(error) }) }
  })
}

/** Context 2/4: run inside the embedded frame (the DSH origin). */
function frameProbe() {
  return new Promise((resolve) => {
    const onMessage = (event) => {
      if (event.data?.source !== 'ag-probe-page') return
      window.removeEventListener('message', onMessage)
      resolve(event.data.result)
    }
    window.addEventListener('message', onMessage)
    frame.hidden = false
    // cache-bust so each variant gets a fresh document with the current cookie
    frame.src = `${ORIGIN}/ag/probe-page?t=${String(Date.now())}`
    setTimeout(() => { window.removeEventListener('message', onMessage); resolve({ frameTimeout: true }) }, 9000)
  })
}

async function runVariant(variant) {
  const installed = await installCookie(variant)
  say({ variant, installed })
  await sleep(300)
  const extFetch = await extensionFetch()
  const frameRun = await frameProbe()
  const extWs = await extensionWebSocket()
  return {
    variant,
    installed,
    extensionFetch: { form: extFetch.form, sessionCookiePresent: extFetch.sessionCookiePresent, ok: extFetch.ok, error: extFetch.error },
    frameFetch: frameRun.fetch === undefined ? frameRun : { form: frameRun.fetch.form, sessionCookiePresent: frameRun.fetch.sessionCookiePresent, ok: frameRun.fetch.ok },
    extensionWs: { sessionCookiePresent: extWs.sessionCookiePresent, wsError: extWs.wsError ?? null, wsClosed: extWs.wsClosed ?? null, wsTimeout: extWs.wsTimeout ?? null },
    frameWs: frameRun.ws === undefined ? frameRun : { sessionCookiePresent: frameRun.ws.sessionCookiePresent, wsError: frameRun.ws.wsError ?? null, wsClosed: frameRun.ws.wsClosed ?? null, wsTimeout: frameRun.ws.wsTimeout ?? null },
  }
}

void (async () => {
  const results = []
  for (const variant of VARIANTS) results.push(await runVariant(variant.trim()))
  const summary = { probe: 'cookie-matrix', extId: chrome.runtime.id, port: PORT, results }
  say(`SUMMARY ${JSON.stringify(summary)}`)
  document.title = 'cookie-matrix done'
  globalThis.__COOKIE_MATRIX__ = summary
})()
