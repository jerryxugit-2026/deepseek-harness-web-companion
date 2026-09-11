/**
 * Side panel controller (M1): ask the service worker for a ready-to-use
 * embedding URL, mount it, and keep a small status bar honest.
 *
 * The embedded frame is the real DSH web GUI. Authentication happens inside the
 * frame through `/ag/enter` (server-side `Set-Cookie`), so this page never
 * handles the session cookie itself.
 */
import { createStore } from './state.js'

const els = {
  dot: document.getElementById('status-dot'),
  status: document.getElementById('status-text'),
  notice: document.getElementById('notice'),
  noticeText: document.getElementById('notice-text'),
  retry: document.getElementById('retry'),
  openWindow: document.getElementById('open-window'),
  attach: document.getElementById('attach-page'),
  frame: document.getElementById('dsh'),
}

const store = createStore()
let currentUrl = ''

store.subscribe((state) => {
  els.dot.dataset.state = state.dsh
  els.status.textContent = statusLabel(state)
  const showNotice = state.dsh === 'down' || state.dsh === 'starting'
  els.notice.hidden = !showNotice
  els.frame.hidden = showNotice
  if (showNotice) els.noticeText.textContent = state.message
})

function statusLabel(state) {
  if (state.dsh === 'up') return 'DSH 已连接'
  if (state.dsh === 'starting') return '正在连接…'
  if (state.dsh === 'down') return 'DSH 未连接'
  return '准备中…'
}

/** Send one message to the service worker and unwrap its Result. */
async function ask(message) {
  try {
    const response = await chrome.runtime.sendMessage(message)
    return response ?? { ok: false, error: { code: 'E_INTERNAL', message: 'no response from service worker' } }
  } catch (error) {
    return { ok: false, error: { code: 'E_INTERNAL', message: String(error) } }
  }
}

/** Mount the embedded DSH surface. */
function mount(url) {
  if (url === currentUrl) return
  currentUrl = url
  els.frame.src = url
  els.frame.hidden = false
}

/** Probe → mount, reporting every failure state into the panel. */
async function connect() {
  store.dispatch({ dsh: 'starting', message: '正在连接本地 DSH…' })
  const ready = await ask({ kind: 'ensure-dsh' })
  if (!ready.ok) {
    store.dispatch({
      dsh: 'down',
      message: `${ready.error.message}\n\n提示：先启动 dsh web（或安装 native host 后自动拉起），再点“重试”。`,
    })
    return
  }
  mount(ready.value.url)
  store.dispatch({ dsh: 'up', url: ready.value.url, message: '' })
}

els.frame.addEventListener('load', () => {
  if (!store.getState().url) return
  store.dispatch({ dsh: 'up' })
})

els.retry.addEventListener('click', () => { void connect() })

els.openWindow.addEventListener('click', () => {
  if (currentUrl === '') return
  void chrome.windows.create({ url: currentUrl, type: 'popup', width: 460, height: 900 })
})

els.attach.addEventListener('click', () => {
  void ask({ kind: 'capture', mode: 'page' }).then((result) => {
    if (!result.ok) store.dispatch({ attach: 'failed', message: result.error.message })
  })
})

void connect()
