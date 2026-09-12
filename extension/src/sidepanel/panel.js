/**
 * Side panel controller (M1): ask the service worker for a ready-to-use
 * embedding URL, mount it, and keep a small status bar honest.
 *
 * The embedded frame is the real DSH web GUI. Authentication happens inside the
 * frame through `/ag/enter` (server-side `Set-Cookie`), so this page never
 * handles the session cookie itself.
 */
import { createStore } from './state.js'
import { startAgentChannel } from './agent-channel.js'
import { controlUrl, pairingKey } from '../lib/urls.js'

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
  browserControl: document.getElementById('browser-control'),
  bcToggle: document.getElementById('bc-toggle'),
  writeOps: document.getElementById('write-ops'),
  woToggle: document.getElementById('wo-toggle'),
  attachSelection: document.getElementById('attach-selection'),
  frame: document.getElementById('dsh'),
}

const store = createStore()
let currentUrl = ''

/** White-box probe hooks (tests/m2/look-left-e2e-probe.mjs); harmless in production. */
const probe = { agentConnected: false, browserControl: false, frames: [], intents: [], errors: [] }
globalThis.__AG_PANEL__ = probe

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

els.retry.addEventListener('click', () => { void initBrowserControl()
void initWriteOps()
void connect() })

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

/**
 * Shared capture trigger; `mode` picks page / selection / screenshot.
 *
 * `trigger` is the honest provenance of the run: `button` when a click started
 * it, `look_left` when the DSH page's intent did.
 *
 * The gesture-less path must NOT try to prompt — `chrome.permissions.request`
 * needs a real user gesture and throws otherwise (measured,
 * tests/m0a/permission-probe.mjs). It also must not pre-emptively refuse: the
 * required `host_permissions` already cover loopback pages and `activeTab` may
 * be live, so the honest gate is the browser's own answer. A refusal therefore
 * surfaces as a mapped E_PERMISSION message telling the user to grant once from
 * the button.
 */
async function runCapture(mode, trigger = 'button') {
  const gestureless = trigger !== 'button'
  if (!gestureless && !(await hasCapturePermission())) {
    const granted = await askForPermission()
    if (!granted) {
      els.status.textContent = '未授权：可在目标网页点一次扩展图标（临时授权）后重试'
      return { ok: false, error: { code: 'E_PERMISSION', message: 'user denied the capture permission' } }
    }
  }
  const result = await ask({ kind: 'capture', mode, trigger })
  if (result.ok) {
    const ref = result.value?.result?.fileRef ?? ''
    els.status.textContent = `已附加：${ref}`
    store.dispatch({ attach: 'attached', lastFileRef: ref })
    return result
  }
  const readable = explain(result.error)
  els.status.textContent = `抓取失败：${readable}`
  store.dispatch({ attach: 'failed', message: readable })
  return { ok: false, error: { ...result.error, message: readable } }
}

/**
 * 「浏览器控制」switch (ADR-12): `debugger` is a required permission, but attaching
 * is a runtime choice — while attached the browser shows the "being debugged"
 * infobar, so it stays off until asked for, and turning it off releases every
 * attach immediately.
 */
async function initBrowserControl() {
  const stored = await chrome.storage.local.get('browserControl').catch(() => ({}))
  const enabled = stored?.browserControl === true
  els.bcToggle.checked = enabled
  els.browserControl.hidden = false
  probe.browserControl = enabled
  els.bcToggle.addEventListener('change', () => {
    void (async () => {
      const reply = await ask({ kind: 'browser-control', enabled: els.bcToggle.checked })
      if (!reply.ok) {
        els.status.textContent = `切换浏览器控制失败：${String(reply.error?.message ?? '')}`
        els.bcToggle.checked = !els.bcToggle.checked
        return
      }
      probe.browserControl = reply.value.browserControl === true
      probe.detached = reply.value.detached ?? []
      els.status.textContent = probe.browserControl
        ? '浏览器控制已开启：点击/输入走真实输入事件（浏览器会显示「正在调试」横幅）'
        : '浏览器控制已关闭：已释放调试器'
    })()
  })
}

/**
 * 「写操作」switch (M3): whether the *bridge plugin* registers browser_click /
 * browser_type / browser_navigate at all. Off by default — an unregistered tool is
 * invisible to the model, which is a stronger guarantee than refusing a call. The
 * switch talks to `/ag/control` (F2: key + extension Origin), so the plugin
 * re-registers its tool set immediately and no DSH restart is involved.
 */
async function initWriteOps() {
  const reply = await ask({ kind: 'state' }).catch(() => null)
  let enabled = false
  try {
    const response = await fetch(`${controlUrl()}?key=${encodeURIComponent(pairingKey())}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ allowBrowserWriteOps: false }),
    })
    const payload = await response.json().catch(() => null)
    enabled = payload?.allowBrowserWriteOps === true
    probe.capabilities = payload?.capabilities ?? []
    probe.approvalMode = payload?.approvalMode
  } catch (error) {
    // The plugin may be older than this panel; the switch stays hidden then.
    els.status.textContent = `写操作开关不可用：${String(error?.message ?? error).slice(0, 80)}`
    void reply
    return
  }
  els.woToggle.checked = enabled
  els.writeOps.hidden = false
  probe.writeOps = enabled
  els.woToggle.addEventListener('change', () => {
    void (async () => {
      try {
        const response = await fetch(`${controlUrl()}?key=${encodeURIComponent(pairingKey())}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ allowBrowserWriteOps: els.woToggle.checked }),
        })
        const payload = await response.json()
        probe.writeOps = payload.allowBrowserWriteOps === true
        probe.capabilities = payload.capabilities ?? []
        els.woToggle.checked = probe.writeOps
        probe.approvalMode = payload.approvalMode
        const gate = payload.approvalMode === 'ask'
          ? '每次点击/输入都会先向你请求批准'
          : payload.approvalMode === 'switch-only'
            ? '本部署无审批服务：仅由这个开关把关'
            : '审批已在配置里关闭'
        els.status.textContent = probe.writeOps
          ? `写操作已开启：模型可见 ${String((payload.capabilities ?? []).length)} 个浏览器工具（${gate}）`
          : '写操作已关闭：模型只剩只读工具'
      } catch (error) {
        els.status.textContent = `切换写操作失败：${String(error?.message ?? error).slice(0, 80)}`
        els.woToggle.checked = !els.woToggle.checked
      }
    })()
  })
}

/** Button path: keep the button honest about what it is doing. */
async function runCaptureFromButton(mode, button) {
  const label = button.textContent
  button.disabled = true
  button.textContent = '抓取中…'
  try {
    await runCapture(mode, 'button')
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

els.attachSelection.addEventListener('click', () => { void runCaptureFromButton('selection', els.attachSelection) })

els.attach.addEventListener('click', () => {
  void runCaptureFromButton('page', els.attach)
})

/**
 * `/ag/agent` channel: obeys a 「看左边」the user typed into the DSH composer.
 * The panel document owns this socket (a recycled service worker would drop it).
 */
const agentChannel = startAgentChannel({
  log: (line) => { console.debug('[ag]', line) },
  onState: (state) => {
    store.dispatch({ agent: state })
    probe.agentConnected = state.connected === true
    probe.state = state
  },
  onFrame: (frame) => {
    probe.frames.push(frame?.type ?? '?')
    probe.lastFrame = frame
  },
  runCapture: async (mode, reason) => {
    els.status.textContent = reason === 'look-left' ? '「看左边」→ 正在抓取…' : '正在抓取…'
    try {
      const result = await runCapture(mode ?? 'page', 'look_left')
      probe.intents.push({ mode: mode ?? 'page', reason: reason ?? 'look-left', ok: result?.ok === true, fileRef: result?.value?.result?.fileRef, error: result?.error })
      if (result?.ok !== true) els.status.textContent = `「看左边」抓取失败：${explain(result?.error)}`
      return result
    } catch (error) {
      probe.errors.push(String(error?.message ?? error))
      throw error
    }
  },
})
agentChannel.start()

void initBrowserControl()
void initWriteOps()
void connect()
