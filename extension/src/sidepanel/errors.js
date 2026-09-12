/**
 * 面向用户的错误话术（从 panel.js 抽出来，便于单测 —— 这是用户唯一会读到的文字）。
 *
 * 分层原则：**SW/ops 只说事实**（`E_NO_SELECTION`、"no text is selected"），
 * **面板负责翻译成"你该做什么"**。抽取动机：探针曾断言 SW 的消息里应出现
 * "选区"字样而失败 —— 因为那句话根本不在这一层；把它做成可单测的纯函数后，
 * 两层各查各的，不会再互相错怪。
 */

/** Map a failure from the service worker / bridge into something a user can act on. */
export function explainError(error) {
  const message = String(error?.message ?? '')
  if (/Cannot access contents of url|must request permission to access this host|Either the '<all_urls>' or 'activeTab'/u.test(message)) {
    return '当前网页未获授权：请点「授权并抓取」授予一次「读取所有网站」权限；或在目标网页上点一次扩展图标（临时授权该标签页）后重试。'
  }
  if (error?.code === 'E_NO_SELECTION') return '没有检测到选区：请先在网页上划选文字再点「Attach 选区」，或改用「Attach 网页」抓整页。'
  if (error?.code === 'E_NO_WORKSPACE') return `没有可用的工作区：${message}`
  if (error?.code === 'E_DSH_DOWN') return '本地 DSH 未运行：请先启动 dsh web。'
  if (error?.code === 'E_READONLY') return '这次操作需要写权限：请在面板打开「写操作」开关（模型侧才会注册点击/输入/导航工具）。'
  if (error?.code === 'E_EXT_OFFLINE') return '浏览器扩展没有连上：请打开侧边栏面板（面板打开时才会建立 /ag/agent 通道）。'
  if (error?.code === 'E_TARGET_BUSY') return '目标标签页已被别的调试器占用（例如 DevTools 打开着）：关掉它再试。'
  if (error?.code === 'E_TIMEOUT') return `操作超时：${message}。页面可能仍在加载，可稍后重试。`
  return message
}
