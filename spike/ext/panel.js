/**
 * Spike panel page: probe direct extension -> DSH API calls and report the
 * outcomes on the console, where the CDP driver records them.
 *
 * The fetch payload is a deliberately minimal client-request envelope: the
 * spike only cares which HTTP status the Host fence and browser auth return.
 */
const DSH_ORIGIN = 'http://127.0.0.1:3080'
const ENVELOPE = { type: 'client-request', rpcId: 'spike-ext-1', method: 'session/list', payload: {} }

async function probe(label, init) {
  const started = Date.now()
  try {
    const response = await fetch(`${DSH_ORIGIN}/api/session/list`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(ENVELOPE),
      ...init,
    })
    const text = (await response.text()).slice(0, 120)
    console.log(`[spike] ${label} status=${String(response.status)} ms=${String(Date.now() - started)} body=${text}`)
  } catch (error) {
    console.log(`[spike] ${label} threw=${String(error)} ms=${String(Date.now() - started)}`)
  }
}

void probe('ext-fetch-credentials-include', { credentials: 'include' })
void probe('ext-fetch-credentials-omit', { credentials: 'omit' })

const frame = document.getElementById('dsh')
frame?.addEventListener('load', () => {
  console.log('[spike] iframe load event fired')
})
console.log('[spike] panel ready')
