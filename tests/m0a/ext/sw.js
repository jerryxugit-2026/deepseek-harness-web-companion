/**
 * M0a permission probe — service worker half.
 *
 * Every case replies with a structured result so the CDP driver can record
 * `lastError` text verbatim (that text is the evidence the design cites).
 */

/** Report one case back to whoever asked. */
async function report(caseName, fn) {
  const started = Date.now()
  try {
    const value = await fn()
    return { case: caseName, ok: true, value, elapsedMs: Date.now() - started }
  } catch (error) {
    return {
      case: caseName,
      ok: false,
      error: String(error instanceof Error ? error.message : error),
      lastError: chrome.runtime.lastError?.message ?? null,
      elapsedMs: Date.now() - started,
    }
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  void (async () => {
    switch (message?.case) {
      // B: gesture-less permission request (expected to fail).
      case 'grant-no-gesture':
        sendResponse(await report('grant-no-gesture', async () => {
          const granted = await chrome.permissions.request({ origins: ['*://*/*'] })
          return { granted, hasPermission: await chrome.permissions.contains({ origins: ['*://*/*'] }) }
        }))
        return
      // helper: inspect current permission state
      case 'contains':
        sendResponse(await report('contains', async () => ({
          hostPermission: await chrome.permissions.contains({ origins: ['*://*/*'] }),
          activeTab: await chrome.permissions.contains({ permissions: ['activeTab'] }),
        })))
        return
      // D/E: gesture-less capture on the active tab (the intent path).
      case 'capture-no-gesture':
        sendResponse(await report('capture-no-gesture', async () => {
          const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
          if (tab?.id === undefined) throw new Error('no active tab')
          const injected = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: () => ({ title: document.title, text: (document.body?.innerText ?? '').slice(0, 60) }),
          })
          const png = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' })
          return { tabId: tab.id, url: tab.url, injected: injected[0]?.result ?? null, pngBytes: Math.round((png.length * 3) / 4) }
        }))
        return
      case 'revoke':
        sendResponse(await report('revoke', async () => ({
          removed: await chrome.permissions.remove({ origins: ['*://*/*'] }),
          hostPermission: await chrome.permissions.contains({ origins: ['*://*/*'] }),
        })))
        return
      default:
        sendResponse({ case: String(message?.case), ok: false, error: 'unknown case' })
    }
  })()
  return true
})

console.log('[m0a] service worker ready')
