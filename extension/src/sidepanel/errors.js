/**
 * 面向用户的错误话术（从 panel.js 抽出来，便于单测 —— 这是用户唯一会读到的文字）。
 *
 * 分层原则：**SW/ops 只说事实**（`E_NO_SELECTION`、"no text is selected"），
 * **面板负责翻译成"你该做什么"**。抽取动机：探针曾断言 SW 的消息里应出现
 * "选区"字样而失败 —— 因为那句话根本不在这一层；把它做成可单测的纯函数后，
 * 两层各查各的，不会再互相错怪。
 *
 * 英文版改造（2026-09-12）后的结构：**判定**与**取文案**分开成两个函数。
 *   · `explainErrorKey(error)` 只做判定，返回 `{ key, substitutions }` 或 `{ raw }` ——
 *     它是**与语言无关**的，所以单测断言"走对了哪个分支"不会因为翻译而失效
 *     （原来断言的是中文字符串，一翻译就得跟着改，那种测试锁的是措辞而不是行为）；
 *   · `explainError(error)` 才去取实际文案（`chrome.i18n`，Node 里退回默认语言包）。
 */
import { t } from '../lib/i18n.js'

/**
 * 错误码 → 文案 key。
 *
 * 做成**数据表**而不是一长串 `if`，是为了让"文案有没有漏翻 / 有没有死文案"这条门禁
 * 能把它们静态地看见（`tests/unit/i18n-messages.test.mjs` 直接 import 这张表）。
 * 一长串 if 里的 `return { key: 'errXxx' }` 对扫描器来说是不可见的，只能靠手写豁免名单 ——
 * 那种豁免名单迟早会过期。
 */
export const CODE_TO_KEY = {
  E_NO_SELECTION: 'errNoSelection',
  E_NO_WORKSPACE: 'errNoWorkspace',
  E_DSH_DOWN: 'errDshDown',
  E_READONLY: 'errReadonly',
  E_EXT_OFFLINE: 'errExtOffline',
  // 成因按实测收窄：2026-09-12 真机上 DevTools 打开着时，本扩展 attach **照样成功**（两次调用都返回了树）。
  // 已知会触发这条的是**另一个扩展**占着该目标（以及同一扩展重复 attach，见 probe:m3-debugger 的 secondAttach）。
  E_TARGET_BUSY: 'errTargetBusy',
  E_TIMEOUT: 'errTimeout',
}

/** 权限类错误的话术 key（按 Chrome 的逐字消息识别，不依赖错误码）。 */
export const PERMISSION_KEY = 'errNoHostPermission'

/** 需要把原始 message 当作 `$1` 塞进文案的错误码。 */
const WITH_MESSAGE = new Set(['E_NO_WORKSPACE', 'E_TIMEOUT'])

/**
 * 判定：这个失败该给用户看哪条话术。
 * @returns {{key: string, substitutions?: string[]} | {raw: string}}
 */
export function explainErrorKey(error) {
  const message = String(error?.message ?? '')
  if (/Cannot access contents of url|must request permission to access this host|Either the '<all_urls>' or 'activeTab'/u.test(message)) {
    return { key: PERMISSION_KEY }
  }
  const key = CODE_TO_KEY[error?.code]
  if (key === undefined) return { raw: message }
  return WITH_MESSAGE.has(error.code) ? { key, substitutions: [message] } : { key }
}

/** Map a failure from the service worker / bridge into something a user can act on. */
export function explainError(error) {
  const decision = explainErrorKey(error)
  if (decision.raw !== undefined) return decision.raw
  return t(decision.key, decision.substitutions ?? [])
}
