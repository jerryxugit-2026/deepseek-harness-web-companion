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

const MAX_MARKDOWN = 120000
const MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024

/** Which tab the user is looking at. */
async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (tab?.id === undefined) throw Object.assign(new Error('no active tab'), { code: 'E_TARGET' })
  return tab
}

/** Run the extractor in the page (MAIN world, self-contained function). */
export async function capturePageContent(tabId, maxChars = MAX_MARKDOWN) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: extractPage,
    args: [{ maxChars }],
  })
  const value = injection?.result
  if (value === undefined || value === null) {
    throw Object.assign(new Error('extraction returned nothing'), { code: 'E_TARGET' })
  }
  return value
}

/** Viewport screenshot as PNG (base64 without the data: prefix). */
export async function captureScreenshot() {
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
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
