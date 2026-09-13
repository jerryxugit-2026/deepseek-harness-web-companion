/**
 * Right-click entries (design FR-1.2 / "Ask DSH about this page").
 *
 * A context-menu click is an extension-side user gesture, which is exactly what
 * `chrome.sidePanel.open` needs — so this is also the reliable way to open the
 * panel without the toolbar icon.
 */
const MENU_PAGE = 'ag-attach-page'
const MENU_SELECTION = 'ag-attach-selection'

/** Create the menu entries once per install. */
export function registerMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_PAGE, title: 'Ask DSH about this page', contexts: ['page'] })
    chrome.contextMenus.create({ id: MENU_SELECTION, title: 'Ask DSH about selection', contexts: ['selection'] })
  })
}

/**
 * Translate one menu click into a capture + a panel that is actually open.
 * @param {{ menuItemId: string, tab?: chrome.tabs.Tab }} info
 */
export async function handleMenuClick(info, capture, openPanel) {
  const mode = info.menuItemId === MENU_SELECTION ? 'selection' : 'page'
  await openPanel(info.tab?.windowId)
  // `trigger` must be one of the AttachRequest enum (protocol/messages.schema.json):
  // look_left | button | shortcut | manual. This used to send 'contextmenu', which is
  // NOT in that enum — so every right-click capture was rejected 400/E_PAYLOAD by the
  // host's `validateAs('AttachRequest')` (routes/attach.js:41) before anything reached
  // disk. The menu looked wired up and silently did nothing. 'manual' is the honest
  // value: a user-gesture capture that is neither the panel button nor a shortcut.
  // Regression: tests/unit/menu-trigger.test.mjs feeds the emitted value through the
  // same generated validator, so leaving the enum fails `npm run check`.
  return capture({ mode, trigger: 'manual' })
}

export { MENU_PAGE, MENU_SELECTION }
