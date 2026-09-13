/**
 * `GET /ag/control` — read the current switches **without changing them**;
 * `POST /ag/control` — flip them.
 *
 * The GET exists because the panel used to discover the state with a POST carrying
 * `allowBrowserWriteOps: false` — i.e. **opening the panel silently turned the write
 * switch off**, while the function's own comment claimed it was reading the value
 * (measured 2026-09-12: the audit trail recorded a panel-driven flip back to false on
 * every panel open). A read must not mutate. See docs/CHANGELOG.md v3.39 §8.
 *
 * Why a route instead of a config edit: `allowBrowserWriteOps` decides whether the
 * write tools exist at all, and requiring a YAML edit + a DSH restart for that makes
 * the safe default effectively permanent. The route keeps the default OFF and makes
 * turning it on one deliberate, authenticated call from the panel — and the plugin
 * still **re-registers** the tool set, so "off" means the model cannot see the tool
 * rather than being refused by a check it might talk its way around.
 *
 * Guarded like every other write surface: F2 (fetch from the extension) — key plus an
 * exact extension Origin, see docs/01 §5.4.
 */
import { validateAs } from '../../shared/protocol.generated.js'

/** The current state, in the shape `ControlResponse` already describes. */
function currentState(state) {
  return {
    ok: true,
    allowBrowserWriteOps: state.writeOps?.() === true,
    capabilities: state.capabilities?.() ?? [],
    ...(typeof state.approvalMode === 'function' ? { approvalMode: state.approvalMode() } : {}),
  }
}

export function controlRoute({ state }) {
  return async (req, res) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      const payload = currentState(state)
      send(res, 200, payload)
      return
    }
    const body = await readBody(req)
    if (body.error !== undefined) {
      send(res, 400, { ok: false, error: { code: 'E_PAYLOAD', message: body.error } })
      return
    }
    const validated = validateAs('ControlRequest', body.value)
    if (!validated.ok) {
      send(res, 400, { ok: false, error: validated.error })
      return
    }
    const applied = state.applyControl({ allowBrowserWriteOps: body.value.allowBrowserWriteOps === true })
    const payload = {
      ok: true,
      allowBrowserWriteOps: applied.allowBrowserWriteOps,
      capabilities: applied.capabilities,
      // Say which gate is really in force: 'ask' = every write goes to the human,
      // 'switch-only' = this deployment has no approval service, so the panel switch
      // is the gate (the panel must not imply otherwise).
      ...(applied.approvalMode === undefined ? {} : { approvalMode: applied.approvalMode }),
    }
    const checked = validateAs('ControlResponse', payload)
    if (!checked.ok) {
      send(res, 500, { ok: false, error: { code: 'E_INTERNAL', message: `control response violates schema: ${checked.error.message}` } })
      return
    }
    send(res, 200, payload)
  }
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve({ error: `body exceeds ${String(limit)} bytes` })
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') {
        resolve({ error: 'empty body' })
        return
      }
      try {
        resolve({ value: JSON.parse(text) })
      } catch (error) {
        resolve({ error: `invalid JSON: ${String(error?.message ?? error)}` })
      }
    })
    req.on('error', (error) => { resolve({ error: String(error?.message ?? error) }) })
  })
}

function send(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}
