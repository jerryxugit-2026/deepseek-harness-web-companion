/**
 * 运行期文案取值 —— 薄薄一层，但有两个必须处理的现实：
 *
 * 1. **`chrome.i18n` 只在扩展环境里存在**。单测（Node）里没有它，探针的某些上下文也没有，
 *    所以取值必须有一条确定的兜底路径（用生成的 `messages.generated.js` 里的默认语言）。
 *    没有兜底的话，单测只能去断言"要么是中文要么是 key"，那种断言等于没断言。
 * 2. **Chrome 没有声明式本地化**（`data-l10n` 是 Firefox 的）。面板的 HTML 是静态的，
 *    必须由 JS 在启动时把文案填进去 —— 这就是 `applyI18n()`。
 *
 * 文案本身**不在这里**：唯一来源是 `extension/i18n/messages.source.json`，
 * 由 `extension/i18n/codegen.mjs` 生成语言包与这份兜底模块。
 */
import { DEFAULT_LOCALE, MESSAGES } from './messages.generated.js'

/** 把 `$1`/`$2` 这类占位换成实参（Chrome 自己也会做，这是兜底路径用的）。 */
function substitute(template, substitutions) {
  if (!Array.isArray(substitutions) || substitutions.length === 0) return template
  return template.replace(/\$(\d)/gu, (whole, digit) => {
    const at = Number(digit) - 1
    return substitutions[at] === undefined ? whole : String(substitutions[at])
  })
}

/** 兜底：用默认语言包。 */
function fallback(key, substitutions) {
  const raw = MESSAGES[DEFAULT_LOCALE]?.[key]
  if (typeof raw !== 'string') return key   // 未知 key ⇒ 原样返回 key，便于一眼看出漏配
  return substitute(raw, substitutions)
}

/**
 * 取一条文案。
 * @param {string} key 源表里的 key
 * @param {string[]} [substitutions] 依次替换 `$1`、`$2`…
 */
export function t(key, substitutions) {
  const api = globalThis.chrome?.i18n
  if (api !== undefined && api !== null && typeof api.getMessage === 'function') {
    const message = api.getMessage(key, substitutions)
    if (typeof message === 'string' && message !== '') return message
  }
  return fallback(key, substitutions)
}

/** 当前界面语言（`zh_CN` 这种），拿不到就用默认语言。 */
export function uiLanguage() {
  const api = globalThis.chrome?.i18n
  const raw = typeof api?.getUILanguage === 'function' ? api.getUILanguage() : DEFAULT_LOCALE
  return typeof raw === 'string' && raw !== '' ? raw : DEFAULT_LOCALE
}

/**
 * 把带 `data-i18n` / `data-i18n-title` 的元素填上文案，并把 `<html lang>` 设对。
 * 返回处理过的元素个数（单测用它断言"真的填了"，而不是"没抛异常"）。
 */
export function applyI18n(root) {
  const doc = root ?? globalThis.document
  if (doc === undefined || doc === null) return 0
  let touched = 0
  for (const el of doc.querySelectorAll('[data-i18n]')) {
    const key = el.getAttribute('data-i18n')
    if (typeof key === 'string' && key !== '') { el.textContent = t(key); touched += 1 }
  }
  for (const el of doc.querySelectorAll('[data-i18n-title]')) {
    const key = el.getAttribute('data-i18n-title')
    if (typeof key === 'string' && key !== '') { el.setAttribute('title', t(key)); touched += 1 }
  }
  if (doc.documentElement !== undefined && doc.documentElement !== null) {
    /*
     * ★ 用**实际渲染出来的语言**，而不是浏览器语言。
     * 本产品只发布 en 一个语言包（用户 2026-09-13：「用户的 chrome 设置成中文或者英文,
     * 我们的插件都是英文版, 就可以」）⇒ 无论浏览器是什么语言，页面内容都是英文，
     * 那么 `<html lang>` 就该是 `en`（写 zh-CN 会误导读屏软件/翻译功能）。
     */
    doc.documentElement.lang = DEFAULT_LOCALE.replace('_', '-')
  }
  return touched
}
