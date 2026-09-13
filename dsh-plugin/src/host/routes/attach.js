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

export function attachRoute({ state, store, hub, config, resolveWorkspace, resolveOwner = () => undefined }) {
  return async (req, res) => {
    const send = (status, payload, extraHeaders = {}) => {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders })
      res.end(JSON.stringify(payload))
    }
    if (!state.guard().checkFetch(req)) return send(403, { ok: false, error: { code: 'E_AUTH', message: 'forbidden' } })

    let payload
    try {
      payload = JSON.parse(await readBody(req, config.attachMaxBytes))
    } catch (error) {
      const code = error.code === 'E_TOO_LARGE' ? 'E_TOO_LARGE' : 'E_PAYLOAD'
      // We stop reading an oversize body ON PURPOSE (that is the point of the 413), so the
      // socket still has unread data and Node must destroy it. Saying `keep-alive` and then
      // closing is a lie the client pays for: undici pooled the socket, reused it for the
      // next request, and got `ECONNRESET` — reproduced deterministically (2026-09-12) as
      // "413 then the very next GET /ag/pending fails". Advertise the close instead.
      return send(code === 'E_TOO_LARGE' ? 413 : 400, { ok: false, error: { code, message: String(error.message ?? error) } }, code === 'E_TOO_LARGE' ? { connection: 'close' } : {})
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
    // Exactly ONE page half receives a capture.
    //
    // This used to be `hub.push(event)` — a broadcast — and a user normally has two page
    // halves connected (the DSH GUI in a tab + the DSH GUI embedded in the side panel's
    // iframe). Every half applied the attach on its own, so **one capture produced two
    // sessions, two chips and two draft inserts** (measured 2026-09-12: sessions created
    // 3ms apart, twice per capture; the original 22:23 report was the same thing at 5ms).
    // The page half that asked wins; otherwise the hub picks (side panel → focused →
    // visible → newest).
    // `resolveOwner` is read-and-forget, so grab the owner first and hand it to the queue when
    // nobody could take the frame: a queued capture must remember WHICH page half asked for it,
    // or `sessionMode: 'current'` will later insert into the other page's session.
    const ownerId = resolveOwner(payload.captureId)
    const deliveredId = hub.pushClientPrimary(event, ownerId)
    if (deliveredId === null) store.enqueue({ ...event, ownerClientId: ownerId })
    state.recordCapture?.(event, deliveredId === null ? 0 : 1, payload.trigger)

    return send(200, {
      ok: true,
      captureId: payload.captureId,
      fileRef: written.fileRef,
      filePath: written.filePath,
      // A real client id (or nothing) — never a count pretending to be one.
      deliveredTo: deliveredId === null ? [] : [deliveredId],
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
