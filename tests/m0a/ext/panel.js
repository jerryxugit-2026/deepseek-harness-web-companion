/**
 * M0a permission probe — panel page.
 *
 * Case A runs the permission request inside a REAL click handler (the driver
 * dispatches a trusted mouse event at the button), which is the only situation
 * Chrome allows `chrome.permissions.request` in.
 */
const log = document.getElementById('log')

function show(label, value) {
  const line = `[${label}] ${JSON.stringify(value)}`
  log.textContent = log.textContent === '-' ? line : `${log.textContent}\n${line}`
  console.log(`[m0a-panel] ${line}`)
}

document.getElementById('grant').addEventListener('click', () => {
  void (async () => {
    try {
      const granted = await chrome.permissions.request({ origins: ['*://*/*'] })
      const state = await chrome.permissions.contains({ origins: ['*://*/*'] })
      show('A:grant-on-click', { granted, contains: state })
    } catch (error) {
      show('A:grant-on-click', { threw: String(error), lastError: chrome.runtime.lastError?.message ?? null })
    }
  })()
})

document.getElementById('contains').addEventListener('click', () => {
  void (async () => {
    show('contains', await chrome.permissions.contains({ origins: ['*://*/*'] }))
  })()
})

show('panel-ready', { href: location.href, id: chrome.runtime.id })
