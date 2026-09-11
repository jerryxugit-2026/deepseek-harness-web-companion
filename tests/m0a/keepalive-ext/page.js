/**
 * Control for Q8: the same idle WebSocket, but held by an extension DOCUMENT
 * (the side panel's shape). Docs predict this survives; the worker does not.
 */
const PORT = 3099
const out = document.getElementById('log')
const lines = []
const log = (event, detail = '') => {
  const line = `${String(Date.now())} ${event} ${detail}`
  lines.push(line)
  out.textContent = lines.slice(-12).join('\n')
  console.log(`[keepalive-page] ${line}`)
}
const socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/ag/wsecho`)
socket.addEventListener('open', () => log('ws-open'))
socket.addEventListener('message', (event) => log('ws-message', String(event.data).slice(0, 50)))
socket.addEventListener('close', (event) => log('ws-close', `code=${String(event.code)}`))
socket.addEventListener('error', () => log('ws-error'))
// survive visible/hidden transitions like a real side panel
document.addEventListener('visibilitychange', () => log('visibility', document.visibilityState))
log('page-boot')
