#!/usr/bin/env node
/**
 * 面板错误话术单测（用户唯一会读到的文字）。
 *
 * 由来：探针曾断言"SW 返回的消息里应出现『选区』"而失败 —— 那句话属于面板层。
 * 抽成纯函数后，SW 只报事实、面板负责翻译，两层各测各的。
 *
 * 英文版改造（2026-09-12）后的重要变化：**这里断言的是"走对了哪个分支"，不是具体措辞**。
 * 原来断言的是中文字符串 —— 那种测试锁的是措辞，一翻译就得跟着改（还会掩盖"分支走错"）。
 * 现在判定与取文案分成两个函数，本文件测 `explainErrorKey`（与语言无关）；
 * "两种语言都非空、都真的翻了"那类断言在 `tests/unit/i18n-messages.test.mjs`。
 *
 * 用法：node tests/unit/panel-errors.test.mjs
 */
import { explainError, explainErrorKey } from '../../extension/src/sidepanel/errors.js'

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 130)}`)
}

console.log('1. 每个已知错误码都要映射到**一条可操作的话术**（而不是把内部消息丢给用户）')
const CASES = [
  ['E_NO_SELECTION', { code: 'E_NO_SELECTION', message: 'no text is selected on the page' }, 'errNoSelection'],
  ['E_NO_WORKSPACE', { code: 'E_NO_WORKSPACE', message: 'no workspace resolved' }, 'errNoWorkspace'],
  ['E_DSH_DOWN', { code: 'E_DSH_DOWN', message: 'x' }, 'errDshDown'],
  ['E_READONLY', { code: 'E_READONLY', message: 'op "browser_click" changes the page' }, 'errReadonly'],
  ['E_EXT_OFFLINE', { code: 'E_EXT_OFFLINE', message: 'no extension connected' }, 'errExtOffline'],
  ['E_TARGET_BUSY', { code: 'E_TARGET_BUSY', message: 'Another debugger is already attached' }, 'errTargetBusy'],
  ['E_TIMEOUT', { code: 'E_TIMEOUT', message: 'no answer within 10000ms' }, 'errTimeout'],
]
for (const [code, error, key] of CASES) {
  record(`${code} → ${key}`, explainErrorKey(error).key === key)
}

console.log('\n2. 需要把原始消息带进去的两条，替换参数不能丢')
{
  const ws = explainErrorKey({ code: 'E_NO_WORKSPACE', message: 'no workspace resolved' })
  record('E_NO_WORKSPACE 带 substitutions', Array.isArray(ws.substitutions) && ws.substitutions[0] === 'no workspace resolved')
  const to = explainErrorKey({ code: 'E_TIMEOUT', message: 'no answer within 10000ms' })
  record('E_TIMEOUT 带 substitutions', Array.isArray(to.substitutions) && to.substitutions[0] === 'no answer within 10000ms')
  record('不需要参数的那条不带 substitutions', explainErrorKey({ code: 'E_DSH_DOWN', message: 'x' }).substitutions === undefined)
}

console.log('\n3. 权限类错误（按 Chrome 逐字消息识别，不依赖我们自己包装）')
const permErrors = [
  { message: 'Cannot access contents of url "https://x/"' },
  { message: "Either the '<all_urls>' or 'activeTab' permission is required." },
  { message: 'must request permission to access this host' },
]
record('三种权限消息都映射到 errNoHostPermission', permErrors.every((e) => explainErrorKey(e).key === 'errNoHostPermission'))

console.log('\n4. 真取一条文案：默认语言（en）下要拿到非空、且带上了原始消息')
{
  // Node 里没有 chrome.i18n ⇒ 走生成的默认语言包（en）
  const text = explainError({ code: 'E_TIMEOUT', message: 'no answer within 10000ms' })
  record('E_TIMEOUT 文案非空', typeof text === 'string' && text.length > 0)
  record('★ 原始消息被嵌进文案（人能看到到底超了什么）', text.includes('no answer within 10000ms'))
  const wsText = explainError({ code: 'E_NO_WORKSPACE', message: 'no workspace resolved' })
  record('E_NO_WORKSPACE 也带上了原始消息', wsText.includes('no workspace resolved'))
  record('未知 code 不套话术、原样透出', explainError({ code: 'E_WEIRD', message: 'something nobody mapped' }) === 'something nobody mapped')
}

console.log('\n5. 未知错误不吞、原样透出（便于抓 bug）')
record('未知码原样返回 message', explainError({ code: 'E_WEIRD', message: 'something nobody mapped' }) === 'something nobody mapped')
record('没有 message 时也不崩', explainError({ code: 'E_X' }) === '')
record('undefined 不崩', explainError(undefined) === '')
record('explainErrorKey(undefined) 走 raw 分支', explainErrorKey(undefined).raw === '')

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
