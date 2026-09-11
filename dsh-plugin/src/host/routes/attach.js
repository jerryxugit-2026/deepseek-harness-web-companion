/**
 * `POST /ag/attach` — accept one capture and deliver it (design docs/03 §3.2).
 *
 * Order matters: **land on disk first, then push**. A push failure never loses
 * the capture — it goes to the pending queue and is drained by whichever client
 * connects next (`GET /ag/pending`).
 */
import { validateAs } from '../../shared/protocol.generated.js'

/** Read the body with a hard size ceiling (413 before buffering anything big). */
async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) {
      const error = new Error('request body exceeds attachMaxBytes')
      error.code = 'E_TOO_LARGE'
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function attachRoute({ state, store, hub, config, resolveWorkspace }) {
  return async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    if (!state.guard().checkFetch(req)) return send(403, { ok: false, error: { code: 'E_AUTH', message: 'forbidden' } })

    let payload
    try {
      payload = JSON.parse(await readBody(req, config.attachMaxBytes))
    } catch (error) {
      const code = error.code === 'E_TOO_LARGE' ? 'E_TOO_LARGE' : 'E_PAYLOAD'
      return send(code === 'E_TOO_LARGE' ? 413 : 400, { ok: false, error: { code, message: String(error.message ?? error) } })
    }
    const validated = validateAs('AttachRequest', payload)
    if (!validated.ok) return send(400, { ok: false, error: validated.error })

    // Workspace resolution (design §7): explicit target → the workspace the
    // connected DSH page announced → plugin config default. Never guess silently:
    // failing with E_NO_WORKSPACE is better than writing into the wrong repo.
    const workspace = payload.target?.workspace ?? resolveWorkspace?.() ?? config.defaultWorkspace
    let written
    try {
      written = await store.write({ ...payload, target: { ...(payload.target ?? {}), ...(workspace === undefined ? {} : { workspace }) } })
    } catch (error) {
      const hint = error.code === 'E_NO_WORKSPACE'
        ? `no workspace resolved (request=${String(payload.target?.workspace ?? 'none')}, client=${String(resolveWorkspace?.() ?? 'none')}, config=${String(config.defaultWorkspace ?? 'none')})`
        : String(error.message ?? error)
      return send(error.code === 'E_NO_WORKSPACE' ? 409 : 500, {
        ok: false,
        error: { code: error.code ?? 'E_STORAGE', message: hint },
      })
    }

    // Where the chip lands depends on who asked:
    //   - the Attach button is a fresh request → a NEW session (config default);
    //   - a 「看左边」intent was typed INTO an existing conversation → that very
    //     session, otherwise the user's question and its page would be split up.
    const sessionMode = payload.trigger === 'look_left' ? 'current' : (config.attachSessionMode ?? 'new')
    const event = {
      type: 'attach',
      sessionMode,
      protocolVersion: payload.protocolVersion,
      captureId: payload.captureId,
      fileRef: written.fileRef,
      filePath: written.filePath,
      mode: payload.content.selection?.text !== undefined && payload.content.selection.text !== '' ? 'selection+page' : 'page',
      page: payload.page,
      ...(payload.media?.screenshot === undefined ? {} : { image: payload.media.screenshot }),
      summary: {
        chars: String(payload.content.markdown ?? '').length,
        truncated: payload.content.truncated === true,
        hasSelection: (payload.content.selection?.text ?? '') !== '',
        bytes: written.bytes,
      },
    }
    const delivered = hub.push(event)
    if (delivered === 0) store.enqueue(event)
    state.recordCapture?.(event, delivered)

    return send(200, {
      ok: true,
      captureId: payload.captureId,
      fileRef: written.fileRef,
      filePath: written.filePath,
      deliveredTo: delivered === 0 ? [] : [`client:${String(delivered)}`],
    })
  }
}

/** `GET /ag/pending` — drain (or peek) captures queued while no client was connected. */
export function pendingRoute({ state, store }) {
  return (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    if (!state.guard().checkClient(req)) return send(403, { ok: false, error: { code: 'E_AUTH', message: 'forbidden' } })
    const url = new URL(req.url ?? '/', 'http://dsh.invalid')
    const peek = url.searchParams.get('peek') === '1'
    return send(200, { ok: true, items: peek ? store.peek() : store.drain() })
  }
}

/** `POST /ag/ack` — client acknowledges how it handled a capture (idempotent). */
export function ackRoute({ state }) {
  return async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(payload))
    }
    if (!state.guard().checkClient(req)) return send(403, { ok: false, error: { code: 'E_AUTH', message: 'forbidden' } })
    let payload
    try {
      payload = JSON.parse(await readBody(req, 64 * 1024))
    } catch (error) {
      return send(400, { ok: false, error: { code: 'E_PAYLOAD', message: String(error.message ?? error) } })
    }
    const validated = validateAs('AckRequest', payload)
    if (!validated.ok) return send(400, { ok: false, error: validated.error })
    state.recordAck?.(payload)
    return send(200, { ok: true })
  }
}
