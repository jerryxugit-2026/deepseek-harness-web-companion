#!/usr/bin/env node
/**
 * 单测：调试器相关工具必须服从运行期「浏览器控制」开关（ADR-12 / T8）。
 *
 * 由来（我在 PiMoa 验真时额外核出的 MAJOR，见 `docs/reviews/pimoa-verification-2026-09-12.md` §2）：
 * `opScreenshot` 原来写的是
 *
 *     if (debuggerAvailable() && (wantFullPage || settings.browserControl === true))
 *
 * 而 `debuggerAvailable()` 只问 `chrome.debugger.attach` **存不存在**，不问用户有没有开开关。
 * 于是模型调一次 `browser_screenshot{fullPage:true}`（或 `browser_ax`）就会 attach 调试器、
 * 弹出**不可消除**的「正在调试」横幅 —— 与 ADR-12/T8「install 期必需、运行期 opt-in：默认不 attach」
 * 以及 `tools.js` 里这两个工具**自己描述**的"整页需要「浏览器控制」开关"直接矛盾。
 *
 * 本测试断言的是**行为**（有没有真的去 attach），不是"代码里有没有那个字符串"。
 *
 * 用法：node tests/unit/op-debugger-optin.test.mjs
 */

/** 记录调试器是否被 attach 过 —— 这就是本测试要盯的副作用。 */
let attachAttempts = 0

globalThis.chrome = {
  tabs: {
    get: async (id) => ({ id, windowId: 1, url: 'https://example.com/', title: 'fixture', active: true }),
    query: async () => [{ id: 1, windowId: 1, url: 'https://example.com/', title: 'fixture', active: true }],
    // 视口截图路径：用一个真实会出现的错误，避免"静默成功"掩盖问题
    captureVisibleTab: async () => { throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.") },
  },
  scripting: { executeScript: async () => [{ result: null }] },
  runtime: { getManifest: () => ({ version: '0.1.0' }) },
  storage: { local: { get: async () => ({}), set: async () => {} } },
  debugger: {
    // 只要它存在，`debuggerAvailable()` 就为 true —— 正是缺陷成立的前提
    attach: async () => { attachAttempts += 1 },
    detach: async () => {},
    sendCommand: async () => ({ result: { value: null } }),
    getTargets: async () => [],
    onDetach: { addListener: () => {} },
  },
}

const { opAx, opScreenshot } = await import('../../extension/src/sw/ops/index.js')

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

/** Run an op and report how it failed (never letting a throw escape). */
const attempt = async (fn) => {
  try {
    const value = await fn()
    return { ok: true, value }
  } catch (error) {
    return { ok: false, code: error?.code, message: String(error?.message ?? error) }
  }
}

console.log('1. 「浏览器控制」关着：整页截图必须被拒，且**绝不许** attach 调试器')
{
  attachAttempts = 0
  const refused = await attempt(() => opScreenshot({ tabId: 1, fullPage: true }, { browserControl: false }))
  record('被拒（不是静默成功）', refused.ok === false)
  record('错误码是 E_NO_PERMISSION', refused.code === 'E_NO_PERMISSION')
  record('提示里点名开关与后果（可操作）', /浏览器控制/u.test(refused.message) && /调试/u.test(refused.message))
  record('**没有 attach 调试器**（横幅不会出现）', attachAttempts === 0)
}

console.log('\n2. 「浏览器控制」关着：无障碍树同样必须被拒，且不许 attach')
{
  attachAttempts = 0
  const refused = await attempt(() => opAx({ tabId: 1 }, { browserControl: false }))
  record('被拒', refused.ok === false)
  record('错误码 E_NO_PERMISSION', refused.code === 'E_NO_PERMISSION')
  record('提示里点名开关', /浏览器控制/u.test(refused.message))
  record('**没有 attach 调试器**', attachAttempts === 0)
}

console.log('\n3. 「浏览器控制」开着：两条路径都要放行并真的走调试器（否则就是修过头了）')
{
  attachAttempts = 0
  await attempt(() => opScreenshot({ tabId: 1, fullPage: true }, { browserControl: true }))
  record('整页截图尝试了 attach（放行）', attachAttempts > 0)
  attachAttempts = 0
  await attempt(() => opAx({ tabId: 1 }, { browserControl: true }))
  record('无障碍树尝试了 attach（放行）', attachAttempts > 0)
}

console.log('\n4. 开关关着的**视口**截图仍然可用（不能把正常功能一起封掉）')
{
  attachAttempts = 0
  const shot = await attempt(() => opScreenshot({ tabId: 1, fullPage: false }, { browserControl: false }))
  // 我的桩故意让 captureVisibleTab 抛权限错（真实会出现），所以这里期望"走到那条路并如实报错"。
  // 关键断言是：它**不是**被"需要先打开开关"那条闸门拦下的（回退路径的提示文案里**故意**会提到
  // 「浏览器控制」作为限流绕过建议，所以不能用"消息里有没有这四个字"来判别），也没有 attach 调试器。
  record('没有被"需要先打开开关"闸门拦下', /需要先打开/u.test(String(shot.message ?? '')) === false)
  record('没有 attach 调试器', attachAttempts === 0)
  record('如实报了权限错误（可诊断）', shot.ok === false && String(shot.message).includes('activeTab'))
}

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
