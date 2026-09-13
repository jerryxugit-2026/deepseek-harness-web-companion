#!/usr/bin/env node
/**
 * M3 单测：`browser_*` 工具定义（docs/03 §6）。
 *
 * 不进浏览器也能把**契约**钉死，而且钉的是两件最容易腐烂的事：
 *
 *   1. **声明的 output schema 必须接受实现真正返回的值** —— 用 DSH 自己的
 *      `validateJsonSchemaValue`（跟运行期同一份校验器）喂真实返回值；schema 与
 *      实现一旦漂移，CI 就红，而不是等用户第一次调用才炸。
 *   2. **写工具没开开关时根本不注册** —— 不是"注册了但拒绝"：没注册的工具对模型
 *      不可见，哄不动。开了开关才出现，并且扩展侧还会再拦一次。
 *
 * 用法：node tests/unit/browser-tools.test.mjs
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { buildBrowserTools, persistScreenshot, stampOf } from '../../dsh-plugin/src/host/tools.js'
import { ASSET_FILE } from '../../dsh-plugin/src/host/retention.js'

// Resolve DSH's own validator the way the PLUGIN does (its node_modules pins
// 0.1.2-rc.1): the test must validate with the same copy the runtime uses, not with
// a second install that could drift.
const requireFromPlugin = createRequire(new URL('../../dsh-plugin/src/host/tools.js', import.meta.url))
const { validateJsonSchemaValue } = requireFromPlugin('@deepseek-ai/dsh-tools')

const root = mkdtempSync(join(tmpdir(), 'dsh-browser-tools-'))
const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value)}`)
}

/** A hub stub whose answers mirror the shapes the extension really returns. */
function makeHub(answers) {
  const calls = []
  return {
    calls,
    callAgent: async (request) => {
      calls.push(request)
      const answer = answers[request.tool]
      if (answer === undefined) throw Object.assign(new Error(`no stub for ${request.tool}`), { code: 'E_INTERNAL' })
      if (answer.throw !== undefined) throw Object.assign(new Error(answer.throw.message), { code: answer.throw.code })
      // Either a wrapper ({reply} / {throw}) or a raw frame — raw frames are the
      // common case, and returning `answer.reply` for them yielded `undefined`,
      // which quietly turned every success assertion into an error-branch pass.
      return answer.reply ?? answer
    },
  }
}

/**
 * DSH's validator returns an ARRAY of violations (empty = valid), not an object —
 * the first version of this test read `.ok` and therefore "passed" on failure.
 */
const violationsOf = (schema, value) => validateJsonSchemaValue(schema, value, '')

const READ_REPLIES = {
  browser_read: { ok: true, value: { url: 'https://example.com/', title: '示例', markdown: '# 标题\n正文', chars: 9, truncated: false } },
  browser_tabs: { ok: true, value: { count: 1, tabs: [{ id: 7, title: '示例', url: 'https://example.com/', active: true }] } },
  browser_wait: { ok: true, value: { waited: 'selector', elapsedMs: 120, selector: '#late' } },
  // nodeId 用**字符串**：CDP 的 Accessibility.AXNode.nodeId 是字符串（DOM.Node.nodeId 才是数字）。
  // 这个夹具原来写成数字 11，于是「schema 声明成 num」这个真缺陷被夹具本身盖住了 —— 真机上
  // 调 browser_ax 只会得到 "invalid output"，永远拿不到树。
  browser_ax: { ok: true, value: { tabId: 7, url: 'https://example.com/', title: '示例', total: 42, truncated: true, nodes: [{ role: 'button', name: '点我', nodeId: '11' }] } },
  browser_screenshot: { ok: true, value: { mime: 'image/png', bytes: 2048, fullPage: true, trusted: true, base64: Buffer.from('fake-png-bytes').toString('base64') } },
}
const WRITE_REPLIES = {
  browser_click: { ok: true, value: { ok: true, matched: 1, tag: 'button', text: '点我', trusted: true, coords: { x: 10, y: 20 } } },
  browser_type: { ok: true, value: { ok: true, typed: 4, value: 'DSH', trusted: false, submitted: false, notes: ['non-trusted'] } },
  browser_navigate: { ok: true, value: { ok: true, url: 'https://example.com/two', title: '第二页' } },
}

console.log('1. 只读模式（allowBrowserWriteOps=false）')
const readOnlyHub = makeHub(READ_REPLIES)
const toolWs = mkdtempSync(join(tmpdir(), 'browser-tools-ws-'))
const readOnly = buildBrowserTools({ hub: readOnlyHub, config: { allowBrowserWriteOps: false, attachDir: '网页捕获', retentionHours: 24 }, resolveWorkspace: () => toolWs, log: () => {} })
const names = readOnly.map((t) => t.name)
record('注册了 5 个只读工具', names.length === 5)
record('写工具完全不在注册表里（不是"注册后拒绝"）', !names.includes('browser_click') && !names.includes('browser_type') && !names.includes('browser_navigate'))
record('只读工具集合与设计一致', ['browser_ax', 'browser_read', 'browser_screenshot', 'browser_tabs', 'browser_wait'].every((n) => names.includes(n)))

console.log('\n2. 声明的 output schema 必须接受实现真正返回的值')
const byName = Object.fromEntries(readOnly.map((t) => [t.name, t]))
// screenshot 原来被跳过（它要落盘）—— 于是 `browser_screenshot` 的 execute 里那句
// `randomBytes(...)`（v3.40 只加了用法、没加 import）在真机上直接 ReferenceError，
// 而两个门禁都看不见。现在给它一个临时工作区，把 execute 也跑起来。
for (const name of ['browser_read', 'browser_tabs', 'browser_wait', 'browser_screenshot', 'browser_ax']) {
  const value = await byName[name].execute(name === 'browser_read' ? { tabId: 7 } : {}, {})
  const violations = violationsOf(byName[name].output.schema, value)
  record(`${name} 返回成功值（不是错误分支）`, value?.code === undefined)
  record(`${name} 返回值通过自己的 output schema`, violations.length === 0)
  if (violations.length > 0) console.log('     违规:', JSON.stringify(violations).slice(0, 300))
}

console.log('\n3. 失败是工具错误（{code,message}），不是异常')
const offlineHub = makeHub({ browser_read: { throw: { code: 'E_EXT_OFFLINE', message: 'no extension connected' } } })
const offlineTools = buildBrowserTools({ hub: offlineHub, config: {}, resolveWorkspace: () => '/tmp/ws' })
const offlineResult = await offlineTools.find((t) => t.name === 'browser_read').execute({}, {})
record('扩展离线 → code=E_EXT_OFFLINE 且带可操作提示', offlineResult.code === 'E_EXT_OFFLINE' && String(offlineResult.message).includes('打开侧边栏'))
const timeoutHub = makeHub({ browser_read: { throw: { code: 'E_TIMEOUT', message: 'no answer in 10000ms' } } })
const timeoutTools = buildBrowserTools({ hub: timeoutHub, config: {}, resolveWorkspace: () => '/tmp/ws' })
const timeoutResult = await timeoutTools.find((t) => t.name === 'browser_read').execute({}, {})
record('超时 → code=E_TIMEOUT 且建议 browser_wait', timeoutResult.code === 'E_TIMEOUT' && String(timeoutResult.message).includes('browser_wait'))
const failingHub = makeHub({ browser_read: { reply: { ok: false, error: { code: 'E_TARGET', message: 'selector not found: #x' } } } })
const failingTools = buildBrowserTools({ hub: failingHub, config: {}, resolveWorkspace: () => '/tmp/ws' })
const failingResult = await failingTools.find((t) => t.name === 'browser_read').execute({ selector: '#x' }, {})
record('扩展侧错误原样透出（不吞）', failingResult.code === 'E_TARGET' && failingResult.message.includes('#x'))

console.log('\n4. 写模式（allowBrowserWriteOps=true）')
const writeHub = makeHub({ ...READ_REPLIES, ...WRITE_REPLIES })
const writeTools = buildBrowserTools({ hub: writeHub, config: { allowBrowserWriteOps: true }, resolveWorkspace: () => '/tmp/ws' })
record('写工具在开关打开后注册（共 8 个）', writeTools.length === 8)
for (const name of ['browser_click', 'browser_type', 'browser_navigate']) {
  const tool = writeTools.find((t) => t.name === name)
  const value = await tool.execute(name === 'browser_type' ? { text: 'DSH' } : name === 'browser_navigate' ? { url: 'https://example.com/two' } : { selector: '#b' }, {})
  const violations = violationsOf(tool.output.schema, value)
  record(`${name} 返回成功值（不是错误分支）`, value?.code === undefined)
  record(`${name} 返回值通过自己的 output schema`, violations.length === 0)
  if (violations.length > 0) console.log('     违规:', JSON.stringify(violations).slice(0, 300))
}
record('写操作的帧带 allowWrite=true（扩展侧二次复核用）', writeHub.calls.filter((c) => c.allowWrite === true).length === 3)
record('只读帧不带 allowWrite', (await offlineTools.find((t) => t.name === 'browser_tabs').execute({}, {}), offlineHub.calls.every((c) => c.allowWrite !== true)))

console.log('\n5. 截图落盘 + 沿用同一套保留策略')
const ws = join(root, 'workspace')
const assets = join(ws, '网页捕获', 'assets')
const png = Buffer.from('fake-png-bytes').toString('base64')
const saved = await persistScreenshot({ workspace: ws, attachDir: '网页捕获', base64: png, mime: 'image/png', stamp: stampOf(), id6: 'aa11bb', retentionHours: 24 })
record('截图文件名符合保留策略的命名规则（否则永不清理）', ASSET_FILE.test(saved.filePath.split('/').pop()))
record('截图写进 <workspace>/网页捕获/assets/', existsSync(saved.filePath))
record('返回可直接引用的 @…fileRef', saved.fileRef.startsWith('@网页捕获/assets/browser-'))
// 老的截图按同一策略被清掉（用户文件不动）
const stalePng = join(assets, 'browser-2026-09-10-0900-old-png.md'.replace('.md', '.png'))
writeFileSync(stalePng, 'x')
const at = new Date(Date.now() - 30 * 3600 * 1000)
utimesSync(stalePng, at, at)
const userPng = join(assets, '我的图.png')
writeFileSync(userPng, 'x'); utimesSync(userPng, at, at)
await persistScreenshot({ workspace: ws, attachDir: '网页捕获', base64: png, mime: 'image/png', stamp: stampOf(), id6: 'cc22dd', retentionHours: 24 })
record('30h 前的旧截图被清掉', !existsSync(stalePng))
record('用户自己放的图不清', existsSync(userPng))
record('新写的截图还在', readdirSync(assets).filter((f) => f.startsWith('browser-')).length === 2)

console.log('\n6. 截图缺像素时报 E_STORAGE，而不是写一个空文件')
const noPixels = buildBrowserTools({
  hub: makeHub({ browser_screenshot: { reply: { ok: true, value: { mime: 'image/png', base64Omitted: true, bytes: 999999 } } } }),
  config: {},
  resolveWorkspace: () => '/tmp/ws',
})
const noPixelResult = await noPixels.find((t) => t.name === 'browser_screenshot').execute({}, {})
record('没有像素 → E_STORAGE（提示帧丢掉了像素）', noPixelResult.code === 'E_STORAGE' && String(noPixelResult.message).includes('pixels'))
const noWorkspace = buildBrowserTools({ hub: makeHub(READ_REPLIES), config: {}, resolveWorkspace: () => undefined })
const noWorkspaceResult = await noWorkspace.find((t) => t.name === 'browser_screenshot').execute({}, {})
record('没有工作区 → E_NO_WORKSPACE', noWorkspaceResult.code === 'E_NO_WORKSPACE')

rmSync(root, { recursive: true, force: true })
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
