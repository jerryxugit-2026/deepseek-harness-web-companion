/**
 * Capture storage (design docs/03 §7).
 *
 * Writes one capture as a Markdown file with YAML front-matter into the target
 * workspace's capture directory, atomically (tmp → rename) so the agent can
 * never read a half-written file. Also keeps a small pending queue so a capture
 * taken while no DSH page is open is delivered when one appears.
 *
 * Every write also prunes that directory (docs/03 §7): captures are agent input,
 * so an unbounded directory is a context cost as much as a disk cost.
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sweepCaptures } from './retention.js'

/** Filesystem-safe, human-readable slug from a page title. */
export function slugify(title) {
  const ascii = String(title ?? '')
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 48)
  return ascii === '' ? 'capture' : ascii.toLowerCase()
}

/** `2026-09-11-1455` local timestamp used in file names. */
export function stamp(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/** Render the Markdown file: front-matter + optional selection block + body. */
export function renderCapture({ captureId, trigger, page, content, media }) {
  const lines = [
    '---',
    `captureId: ${captureId}`,
    `title: ${JSON.stringify(page.title ?? '')}`,
    `url: ${JSON.stringify(page.url ?? '')}`,
    `domain: ${JSON.stringify(page.domain ?? '')}`,
    `capturedAt: ${String(page.capturedAt ?? Date.now())}`,
    `trigger: ${trigger}`,
    `source: dsh-web-companion`,
  ]
  if (content.truncated === true) lines.push('truncated: true')
  if (media?.screenshot !== undefined) lines.push(`screenshot: ${media.screenshot.mime} (${String(media.screenshot.width)}x${String(media.screenshot.height)})`)
  if (media?.video?.captions !== undefined) lines.push(`captions: ${String(media.video.captions.source ?? 'unknown')}`)
  lines.push('---', '')
  if (content.selection?.text !== undefined && content.selection.text !== '') {
    lines.push('> **用户选区**', '>')
    for (const line of String(content.selection.text).split('\n')) lines.push(`> ${line}`)
    if (content.selection.selectorHint !== undefined) lines.push('>', `> \`${content.selection.selectorHint}\``)
    lines.push('')
  }
  lines.push(String(content.markdown ?? ''), '')
  return lines.join('\n')
}

/** One capture directory per workspace, created on demand. */
export function createStore(config) {
  /** Captures waiting for a client; newest last. */
  const pending = []
  /** Capture requests waiting for the extension (its panel was closed). */
  const pendingIntents = []

  return {
    get pendingCount() { return pending.length },

    /** Write the capture and return its reference; throws on storage failure. */
    async write(capture) {
      const workspace = capture.target?.workspace ?? config.defaultWorkspace
      if (typeof workspace !== 'string' || workspace === '') {
        const error = new Error('no workspace resolved for capture')
        error.code = 'E_NO_WORKSPACE'
        throw error
      }
      const dir = join(workspace, config.attachDir)
      await mkdir(dir, { recursive: true })
      const name = `${stamp()}-${slugify(capture.page?.title)}-${String(capture.captureId).slice(-6)}.md`
      const filePath = join(dir, name)
      const body = renderCapture(capture)
      const bytes = Buffer.byteLength(body, 'utf8')
      const tmp = `${filePath}.tmp`
      await writeFile(tmp, body, 'utf8')
      await rename(tmp, filePath)
      // Retention runs AFTER the new file exists, so the sweep can never race the
      // write, and the file just written is never a candidate (mtime is now).
      const swept = config.retentionHours > 0
        ? await sweepCaptures(dir, { retentionHours: config.retentionHours, log: config.log })
        : { removed: [], kept: 0, disabled: true }
      return {
        filePath,
        fileRef: `@${config.attachDir}/${name}`,
        bytes,
        // internal only (not part of /ag/attach's response body)
        pruned: swept.removed.length,
        prunedFiles: swept.removed.map((entry) => entry.name),
      }
    },

    /** Queue an event for delivery to the next client that connects. */
    enqueue(event) {
      pending.push(event)
      while (pending.length > config.pendingLimit) pending.shift()
      return pending.length
    },

    /** Take (and consume) the queued events. */
    drain() {
      return pending.splice(0, pending.length)
    },

    /** Look without consuming (`peek`). */
    peek() {
      return [...pending]
    },

    /**
     * Queue a capture request for the extension.
     *
     * Separate queue on purpose: `drain()` is consumed by the DSH page half, and
     * a queued intent must not be handed to it (it would look like a capture to
     * insert while nothing has been captured yet).
     */
    enqueueIntent(event) {
      pendingIntents.push(event)
      while (pendingIntents.length > config.pendingLimit) pendingIntents.shift()
      return pendingIntents.length
    },

    /** Take (and consume) the queued intents. */
    drainIntents() {
      return pendingIntents.splice(0, pendingIntents.length)
    },

    get intentCount() { return pendingIntents.length },
  }
}
