#!/usr/bin/env node
/**
 * 面板错误话术单测（用户唯一会读到的文字）。
 *
 * 由来：探针曾断言"SW 返回的消息里应出现『选区』"而失败 —— 那句话属于面板层。
 * 抽成纯函数后，SW 只报事实、面板负责翻译，两层各测各的。
 *
 * 用法：node tests/unit/panel-errors.test.mjs
 */
import { explainError } from '../../extension/src/sidepanel/errors.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 120)}`)
}
const has = (text, ...needles) => needles.every((needle) => String(text).includes(needle))

console.log('1. 每个已知错误码都要给出"该做什么"，而不是把内部消息丢给用户')
const CASES = [
  ['E_NO_SELECTION', { code: 'E_NO_SELECTION', message: 'no text is selected on the page' }, ['选区', 'Attach 选区', 'Attach 网页']],
  ['E_NO_WORKSPACE', { code: 'E_NO_WORKSPACE', message: 'no workspace resolved' }, ['工作区']],
  ['E_DSH_DOWN', { code: 'E_DSH_DOWN', message: 'x' }, ['dsh web']],
  ['E_READONLY', { code: 'E_READONLY', message: 'op "browser_click" changes the page' }, ['写操作']],
  ['E_EXT_OFFLINE', { code: 'E_EXT_OFFLINE', message: 'no extension connected' }, ['侧边栏']],
  ['E_TARGET_BUSY', { code: 'E_TARGET_BUSY', message: 'Another debugger is already attached' }, ['DevTools']],
  ['E_TIMEOUT', { code: 'E_TIMEOUT', message: 'no answer within 10000ms' }, ['超时']],
]
for (const [code, error, needles] of CASES) {
  record(`${code} → 可操作提示`, has(explainError(error), ...needles))
}

console.log('\n2. 权限类错误（按 Chrome 逐字消息识别，不依赖我们自己包装）')
const permErrors = [
  { message: 'Cannot access contents of url "https://x/"' },
  { message: "Either the '<all_urls>' or 'activeTab' permission is required." },
  { message: 'must request permission to access this host' },
]
record('三种权限消息都映射到"授权并抓取"', permErrors.every((e) => has(explainError(e), '授权并抓取')))

console.log('\n3. 未知错误不吞、原样透出（便于抓 bug）')
const unknown = explainError({ code: 'E_WEIRD', message: 'something nobody mapped' })
record('未知码原样返回 message', unknown === 'something nobody mapped')
record('没有 message 时也不崩', explainError({ code: 'E_X' }) === '')
record('undefined 不崩', explainError(undefined) === '')

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
