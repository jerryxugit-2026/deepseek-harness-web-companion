/**
 * Capture orchestration (design docs/02 §3.4 / M2).
 *
 * Composes one of the three capture granularities and turns it into an
 * `/ag/attach` request body that already satisfies the protocol schema:
 *
 *   page       → cleaned Markdown of the main content
 *   selection  → the user's highlighted text, kept as a highlight block
 *   screenshot → viewport PNG (needs `<all_urls>` or `activeTab`; the caller
 *                decides whether that permission is available)
 */
import { extractPage } from '../content/extract.fn.js'
import { dshOrigin } from '../lib/urls.js'

/** Classify an extension API failure so callers can act on it. */
function classified(error, fallback) {
  const message = String(error?.message ?? error)
  if (/Cannot access contents of url|must request permission to access this host|Either the '<all_urls>' or 'activeTab'/u.test(message)) {
    return Object.assign(new Error(message), { code: 'E_NO_PERMISSION' })
  }
  return Object.assign(new Error(message), { code: error?.code ?? fallback })
}

const MAX_MARKDOWN = 120000
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

/** Pages no content script can ever run in (and none the user is "reading"). */
const UNCAPTURABLE = /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension|chrome-search|chrome-untrusted):/u

/**
 * Whether a tab is one of OUR surfaces rather than the page the user reads.
 *
 * Capturing our own side panel (opened as a tab by the probes, and by anyone who
 * drags it out) or the DSH GUI page is always an `E_NO_PERMISSION` failure — and
 * a misleading one, because the hint then tells the user to grant a permission
 * that cannot help. Measured in tests/m2/look-left-e2e-probe.mjs (v3.23 fix).
 */
function isOwnSurface(tab) {
  const url = String(tab.url ?? '')
  if (url === '') return false
  if (url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return true
  const origin = dshOrigin()
  return url === origin || url.startsWith(`${origin}/`)
}

const capturable = (tab) => tab.id !== undefined && !isOwnSurface(tab) && !UNCAPTURABLE.test(String(tab.url ?? ''))

/**
 * Which tab to capture.
 *
 * Normally the page the user is looking at. When that tab is our own surface —
 * the DSH GUI open in a tab, the panel itself — capturing it is meaningless, so
 * fall back to the most recently used capturable tab and say so in the log. The
 * fallback is deliberately ordered by `lastAccessed`, not by tab index, so it
 * lands on what the user was reading just before.
 */
export async function activeTab(log = () => {}) {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (active !== undefined && capturable(active)) return active
  const candidates = (await chrome.tabs.query({}))
    .filter(capturable)
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
  if (candidates.length === 0) {
    throw Object.assign(new Error('no capturable tab: the active tab is a browser/extension page'), { code: 'E_TARGET' })
  }
  log(`active tab is not capturable (${String(active?.url ?? 'none').slice(0, 40)}); fell back to ${String(candidates[0].url).slice(0, 60)}`)
  return candidates[0]
}

/** Run the extractor in the page (MAIN world, self-contained function). */
export async function capturePageContent(tabId, maxChars = MAX_MARKDOWN) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: extractPage,
    args: [{ maxChars }],
  }).catch((error) => { throw classified(error, 'E_TARGET') })
  const value = injection?.result
  if (value === undefined || value === null) {
    throw Object.assign(new Error('extraction returned nothing'), { code: 'E_TARGET' })
  }
  return value
}

/** Viewport screenshot as PNG (base64 without the data: prefix). */
export async function captureScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
    .catch((error) => { throw classified(error, 'E_NO_PERMISSION') })
  const base64 = dataUrl.replace(/^data:image\/png;base64,/u, '')
  const bytes = Math.round((base64.length * 3) / 4)
  if (bytes > MAX_SCREENSHOT_BYTES) {
    return { dropped: true, reason: `screenshot ${String(Math.round(bytes / 1024))}KB exceeds ${String(MAX_SCREENSHOT_BYTES / 1024 / 1024)}MB` }
  }
  return { mime: 'image/png', base64, width: 0, height: 0, bytes }
}

/**
 * Build the `/ag/attach` body for one mode.
 * @param {{ mode: string, trigger: string, captureId: string, includeScreenshot?: boolean }} request
 */
export async function buildCapture(request) {
  const tab = await activeTab()
  const captured = await capturePageContent(tab.id)
  const selectionText = captured.content.selection?.text ?? ''

  const body = {
    protocolVersion: 1,
    captureId: request.captureId,
    trigger: request.trigger ?? 'button',
    page: captured.page,
    content: request.mode === 'selection' && selectionText !== ''
      ? { markdown: selectionText, truncated: false, selection: { text: selectionText } }
      : { markdown: captured.content.markdown, truncated: captured.content.truncated === true },
  }

  if (request.mode === 'screenshot' || request.includeScreenshot === true) {
    try {
      const shot = await captureScreenshot()
      body.media = { screenshot: shot }
    } catch (error) {
      // permission or focus problems are expected; the text still ships
      body.media = { screenshot: { mime: 'image/png', base64: '', width: 0, height: 0, dropped: true, dropReason: String(error?.message ?? error).slice(0, 120) } }
    }
  }
  return { body, tab: { id: tab.id, url: tab.url, title: tab.title }, meta: captured.meta }
}
