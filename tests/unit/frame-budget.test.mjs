#!/usr/bin/env node
/**
 * 帧预算单测（M3）：截图像素必须能过 WS，超限的要"带原因地拒绝"而不是静默丢掉。
 *
 * 由来：第一版 `agent-channel` 无条件删掉 base64 → `browser_screenshot` 结构性
 * 不可能成功（插件侧只会看到 `E_STORAGE: extension returned no pixels`）。
 *
 * 用法：node tests/unit/frame-budget.test.mjs
 */
import { MAX_BASE64_CHARS, MAX_MARKDOWN_CHARS, withinFrameBudget } from '../../extension/src/lib/frame-budget.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 120)}`)
}

console.log('1. 截图像素（小图必须原样过）')
const small = withinFrameBudget({ mime: 'image/png', base64: 'A'.repeat(1000), bytes: 750, fullPage: true })
record('小图保留 base64', typeof small.base64 === 'string' && small.base64.length === 1000)
record('小图不带 base64Omitted', small.base64Omitted === undefined)
record('bytes 按需重算', small.bytes === 750)

console.log('\n2. 超大截图：带原因地拒绝，而不是静默丢')
const huge = withinFrameBudget({ mime: 'image/png', base64: 'A'.repeat(MAX_BASE64_CHARS + 1), bytes: 999 })
record('超限图删除 base64', huge.base64 === undefined)
record('超限图标记 base64Omitted', huge.base64Omitted === true)
record('超限图保留字节数供诊断', huge.base64Bytes === 999)
record('超限图在 notes 里说明原因', Array.isArray(huge.notes) && String(huge.notes[0]).includes('frame budget'))
record('原有的 notes 不被覆盖', withinFrameBudget({ base64: 'A'.repeat(MAX_BASE64_CHARS + 1), notes: ['浏览器控制未开启'] }).notes.length === 2)

console.log('\n3. 长正文：帧内截断 + 说明，原文件不受影响')
const long = withinFrameBudget({ markdown: 'x'.repeat(MAX_MARKDOWN_CHARS + 500), chars: MAX_MARKDOWN_CHARS + 500 })
record('帧内 markdown 被截断', long.markdown.length < MAX_MARKDOWN_CHARS + 200)
record('标记 markdownTruncatedInFrame', long.markdownTruncatedInFrame === true)
record('提示里带原始总长度', long.markdown.includes(String(MAX_MARKDOWN_CHARS + 500)))
record('短正文不动', withinFrameBudget({ markdown: 'short' }).markdown === 'short')

console.log('\n4. 边界与形状')
record('null 原样返回', withinFrameBudget(null) === null)
record('字符串原样返回', withinFrameBudget('x') === 'x')
record('无 base64 的对象不被改动', JSON.stringify(withinFrameBudget({ ok: true, matched: 1 })) === '{"ok":true,"matched":1}')
record('返回的是拷贝（不污染原对象）', (() => { const src = { base64: 'A'.repeat(10) }; withinFrameBudget(src); return src.bytes === undefined })())

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
