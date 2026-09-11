/**
 * `GET /ag/probe-page` — M0a measurement helper (design Q1/Q2).
 *
 * Serves a page ON THE DSH ORIGIN so it can measure what a document inside the
 * embedded frame experiences: whether the session cookie reaches the server for
 * a same-origin `fetch` (form F4) and for a WebSocket handshake, under whatever
 * cookie attributes the extension installed. Results are posted to the parent
 * (the extension page) which correlates them with its own contexts.
 */
const PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>ag probe page</title></head>
<body style="font:12px system-ui;margin:8px">
<div id="out">probe running…</div>
<script>
(async () => {
  const result = { where: 'iframe', href: location.href }
  try {
    const res = await fetch('/ag/whoami', { credentials: 'same-origin' })
    result.fetch = await res.json()
  } catch (error) { result.fetchError = String(error) }
  try {
    result.ws = await new Promise((resolve) => {
      const socket = new WebSocket('ws://' + location.host + '/ag/wsprobe')
      const done = (value) => { try { socket.close() } catch {} ; resolve(value) }
      socket.addEventListener('message', (event) => { try { done(JSON.parse(event.data)) } catch (e) { done({ parseError: String(e) }) } })
      socket.addEventListener('error', () => done({ wsError: 'error event' }))
      socket.addEventListener('close', (event) => done({ wsClosed: event.code }))
      setTimeout(() => done({ wsTimeout: true }), 4000)
    })
  } catch (error) { result.wsError = String(error) }
  document.getElementById('out').textContent = JSON.stringify(result)
  try { parent.postMessage({ source: 'ag-probe-page', result }, '*') } catch {}
})()
</script></body></html>`

export function probePageRoute() {
  return (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    res.end(PAGE)
  }
}
