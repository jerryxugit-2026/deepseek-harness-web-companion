#!/usr/bin/env node
/**
 * 门禁单测：**协议错误码是闭集，代码里不许出现集合外的码**。
 *
 * 由来（v3.41 的 P2 项"协议 error.code 收紧"）：`ErrorCode` 枚举一直自称是闭集，但实际代码里
 * 用了 6 个枚举里没有的码（`E_NO_SELECTION` / `E_READONLY` / `E_TARGET_BUSY` / `E_PERMISSION` /
 * `E_PLUGIN`，以及面板本地状态串 `E_WS`）。把 schema 收紧成 `$ref: ErrorCode` 之后，**集合外的码
 * 会让整帧校验失败 → 被宿主丢弃**：`capture-result` 被丢 ⇒ 意图与抓取失联（attach 会落错页面半）。
 * 所以"枚举是否覆盖代码真正用到的码"必须由门禁盯着，而不是靠人记。
 *
 * 本测试做三件事：
 *   1. 扫描产品源码里的 `'E_…'` 字面量，逐个核对是否在 `ENUM.ErrorCode` 里（本地专用码需显式登记）；
 *   2. 三端产物的枚举必须一致；
 *   3. 设计文档 §2.6 的错误码表必须列全 —— 文档漂移和代码漂移是同一类问题。
 *
 * 用法：node tests/unit/protocol-error-codes.test.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ENUM as PLUGIN_ENUM } from '../../dsh-plugin/src/shared/protocol.generated.js'
import { ENUM as EXT_ENUM } from '../../extension/src/lib/protocol.generated.js'
import { ENUM as NATIVE_ENUM } from '../../native-host/protocol.generated.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 200)}`)
}

/** 只扫产品源码：测试/生成物/产物目录不算。 */
const ROOTS = ['extension/src', 'dsh-plugin/src', 'native-host']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.devhome'])
const isGenerated = (path) => /protocol\.generated\.(js|mjs)$/u.test(path) || path.endsWith('protocol.generated.mjs')

/**
 * 不跨协议的本地字符串：面板把 WS 断开当成一个 UI 状态标记用，它**不上线**
 * （`onState({error:'E_WS'})` 只在面板内部消费），因此不属于协议错误码。
 * 每加一条都必须在这里写明理由 —— 这正是"闭集"要被维护的地方。
 */
const LOCAL_ONLY = new Map([
  ['E_WS', 'extension/src/sidepanel/agent-channel.js：面板本地连接状态标记，不发往宿主'],
])

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(js|mjs)$/u.test(name)) out.push(full)
  }
  return out
}

console.log('1. 代码里出现的错误码字面量必须都在协议闭集里')
const enumSet = new Set(PLUGIN_ENUM.ErrorCode)
const files = ROOTS.flatMap((root) => walk(join(ROOT, root))).filter((file) => !isGenerated(file))
const found = new Map()   // code → 出现位置（前 3 处）
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const match of text.matchAll(/['"](E_[A-Z0-9_]+)['"]/gu)) {
    const code = match[1]
    if (!found.has(code)) found.set(code, [])
    const list = found.get(code)
    if (list.length < 3) list.push(relative(ROOT, file))
  }
}
const missing = [...found.keys()].filter((code) => !enumSet.has(code) && !LOCAL_ONLY.has(code))
record(`扫了 ${String(files.length)} 个源文件`, files.length > 20)
record(`找到 ${String(found.size)} 个不同的错误码`, found.size >= 15)
record(`★ 没有集合外的码（越界：${JSON.stringify(missing)}）`, missing.length === 0)
record('本地专用码都写了理由', [...LOCAL_ONLY.keys()].every((code) => String(LOCAL_ONLY.get(code)).includes('：')))

console.log('\n2. 三端枚举一致（同一次 codegen 的产物）')
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
record('插件端 == 扩展端', same(PLUGIN_ENUM.ErrorCode, EXT_ENUM.ErrorCode))
record('插件端 == native host', same(PLUGIN_ENUM.ErrorCode, NATIVE_ENUM.ErrorCode))
record(`枚举共 ${String(PLUGIN_ENUM.ErrorCode.length)} 个码`, PLUGIN_ENUM.ErrorCode.length >= 19)

console.log('\n3. 设计文档 §2.6 的错误码表必须列全（文档漂移＝同一类缺陷）')
const doc = readFileSync(join(ROOT, 'docs/01-protocol.md'), 'utf8')
const undocumented = PLUGIN_ENUM.ErrorCode.filter((code) => !doc.includes(code))
record(`★ §2.6 没漏任何码（漏：${JSON.stringify(undocumented)}）`, undocumented.length === 0)

console.log('\n4. 真正在用的码能通过校验，集合外的码被拒（收紧真的生效）')
const valid = { type: 'capture-result', protocolVersion: 1, requestId: 'r1', ok: false, error: { code: 'E_NO_SELECTION', message: 'x' }, at: 1 }
record('E_NO_SELECTION 的失败帧通过校验', EXT_ENUM !== undefined && (await import('../../dsh-plugin/src/shared/protocol.generated.js')).validateAs('CaptureResultEvent', valid).ok === true)
const bad = { ...valid, error: { code: 'E_NOPE', message: 'x' } }
const badResult = (await import('../../dsh-plugin/src/shared/protocol.generated.js')).validateAs('CaptureResultEvent', bad)
record('★ 集合外的码被拒（不会带着它上线）', badResult.ok === false)
const noId = { type: 'capture-result', protocolVersion: 1, requestId: 'r2', ok: true, fileRef: '@x', at: 1 }
const noIdResult = (await import('../../dsh-plugin/src/shared/protocol.generated.js')).validateAs('CaptureResultEvent', noId)
record('★ ok:true 但缺 captureId 被拒（否则意图链断掉）', noIdResult.ok === false)

// 只有布尔 true 算通过
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
