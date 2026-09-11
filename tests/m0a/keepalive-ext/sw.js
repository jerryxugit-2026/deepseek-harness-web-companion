/**
 * Q8: open one WebSocket from the MV3 service worker and record its lifecycle
 * with wall-clock timestamps. If Chrome recycles the idle worker, the socket
 * dies with it — that is exactly what the design predicts (D10).
 */
const params = new URLSearchParams(new URL('http://x/').search)
void params
const PORT = 3099
const log = (event, detail = '') => console.log(`[keepalive-sw] ${String(Date.now())} ${event} ${detail}`)

let socket
function connect() {
  try {
    socket = new WebSocket(`ws://127.0.0.1:${String(PORT)}/ag/wsecho`)
    socket.addEventListener('open', () => log('ws-open'))
    socket.addEventListener('message', (event) => log('ws-message', String(event.data).slice(0, 60)))
    socket.addEventListener('close', (event) => log('ws-close', `code=${String(event.code)}`))
    socket.addEventListener('error', () => log('ws-error'))
  } catch (error) { log('ws-throw', String(error)) }
}
connect()
log('sw-boot', `socket=${String(socket !== undefined)}`)

// status endpoint for the harness (also proves the worker is still alive)
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.case !== 'status') return false
  sendResponse({ case: 'status', now: Date.now(), readyState: socket?.readyState ?? null, alive: true })
  return true
})
