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
  gate: document.getElementById('gate'),
  gateText: document.getElementById('gate-text'),
  gateAllow: document.getElementById('gate-allow'),
  gateCancel: document.getElementById('gate-cancel'),
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
  // clear the message so a stale "connecting…" never lingers in the DOM
  store.dispatch({ dsh: 'up', url: ready.value.url, message: '', handshake: ready.value.state?.handshake ?? 'unknown' })
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

/**
 * One-time capture permission (design §9, option ③).
 *
 * `chrome.permissions.request` only works from a user gesture, and the
 * 「看左边」intent path has none — so the grant must happen once, here, in a
 * click handler. After that the intent path works without any gesture.
 */
async function hasCapturePermission() {
  try {
    return await chrome.permissions.contains({ origins: ['*://*/*'] })
  } catch {
    return false
  }
}

/** Show the inline gate; resolves true when the user grants, false otherwise. */
function askForPermission() {
  return new Promise((resolve) => {
    els.gateText.textContent = '需要一次性授权，才能读取任意网页的正文与截图。内容只在本机处理（写入工作区 + 交给本地 DSH），不会经过本扩展外的任何服务。'
    els.gate.hidden = false
    const cleanup = () => {
      els.gate.hidden = true
      els.gateAllow.removeEventListener('click', onAllow)
      els.gateCancel.removeEventListener('click', onCancel)
    }
    const onAllow = () => {
      void (async () => {
        let granted = false
        try {
          // the click IS the gesture Chrome requires
          granted = await chrome.permissions.request({ origins: ['*://*/*'] })
        } catch (error) {
          els.status.textContent = `授权失败：${String(error)}`
        }
        cleanup()
        resolve(granted)
      })()
    }
    const onCancel = () => { cleanup(); resolve(false) }
    els.gateAllow.addEventListener('click', onAllow)
    els.gateCancel.addEventListener('click', onCancel)
  })
}

/** Turn extension errors into something a user can act on. */
function explain(error) {
  const message = String(error?.message ?? '')
  if (/Cannot access contents of url|must request permission to access this host|Either the '<all_urls>' or 'activeTab'/u.test(message)) {
    return '当前网页未获授权：请点「授权并抓取」授予一次「读取所有网站」权限；或在目标网页上点一次扩展图标（临时授权该标签页）后重试。'
  }
  if (error?.code === 'E_NO_WORKSPACE') return `没有可用的工作区：${message}`
  if (error?.code === 'E_DSH_DOWN') return '本地 DSH 未运行：请先启动 dsh web。'
  return message
}

els.attach.addEventListener('click', () => {
  void (async () => {
    if (!(await hasCapturePermission())) {
      const granted = await askForPermission()
      if (!granted) {
        els.status.textContent = '未授权：可在目标网页点一次扩展图标（临时授权）后重试'
        return
      }
    }
    els.attach.disabled = true
    els.attach.textContent = '抓取中…'
    const result = await ask({ kind: 'capture', mode: 'page', trigger: 'button' })
    els.attach.disabled = false
    els.attach.textContent = 'Attach 网页'
    if (result.ok) {
      const ref = result.value?.result?.fileRef ?? ''
      els.status.textContent = `已附加：${ref}`
      store.dispatch({ attach: 'attached', lastFileRef: ref })
      return
    }
    const readable = explain(result.error)
    els.status.textContent = `抓取失败：${readable}`
    store.dispatch({ attach: 'failed', message: readable })
  })()
})

void connect()
