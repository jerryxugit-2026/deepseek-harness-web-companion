#!/usr/bin/env node
/**
 * 扩展侧审计的纯函数单测（`extension/src/sw/audit.js`）。
 *
 * 只测两个不需要 chrome API 的函数，但它们正是隐私边界所在：
 *   - `hostOf`：只允许主机名落盘。设计 §9 要求记 `domain`，而整条 URL 会把搜索词、
 *     文档 id、query 里的 token 一起带进去 —— 这里钉死"路径与 query 一律丢掉"。
 *   - `projectAudit`：只有 allow-list 里的键能进 storage，字符串截断。
 *
 * 用法：node tests/unit/audit-fields.test.mjs
 */
import { AUDIT_FIELDS, hostOf, projectAudit } from '../../extension/src/sw/audit.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 140)}`)
}

console.log('1. hostOf：只留主机名，路径 / query / fragment 全部丢掉')
record('https://www.apexnc.org/1081/Plant-the-Peak?a=1#x → www.apexnc.org', hostOf('https://www.apexnc.org/1081/Plant-the-Peak?a=1#x') === 'www.apexnc.org')
record('query 里的 token 不会出现', hostOf('https://x.example/search?q=SECRET-QUERY').includes('SECRET') === false)
record('chrome:// 页面 → undefined（不是普通网页）', hostOf('chrome://extensions') === undefined)
record('扩展自身页面 → undefined', hostOf('chrome-extension://abc/panel.html') === undefined)
record('file:// → undefined', hostOf('file:///Users/mac/secret.md') === undefined)
record('空值 / 垃圾输入不崩', hostOf(undefined) === undefined && hostOf('not a url') === undefined)

console.log('\n2. projectAudit：只有 allow-list 的键能进 storage')
const projected = projectAudit({
  kind: 'capture', ok: true, mode: 'page', trigger: 'manual', domain: 'x.example',
  url: 'https://x.example/private?token=LEAK', markdown: 'LEAK-BODY', selectionText: 'LEAK-SEL',
  key: 'LEAK-KEY', title: 'LEAK-TITLE', cookie: 'LEAK-COOKIE',
})
record('保住了该留的字段', projected.trigger === 'manual' && projected.domain === 'x.example' && projected.ok === true)
const extra = Object.keys(projected).filter((key) => !AUDIT_FIELDS.includes(key))
record(`没有多余键（多出：${JSON.stringify(extra)}）`, extra.length === 0)
const serialized = JSON.stringify(projected)
record('序列化后不含任何 LEAK 值', serialized.includes('LEAK') === false)

console.log('\n3. 长字符串截断（审计不能被正文撑大）')
const long = projectAudit({ kind: 'capture', domain: 'x'.repeat(500) })
record('截断到 120 字符', long.domain.length === 120)
record('undefined/null 直接不写', Object.keys(projectAudit({ kind: 'capture', trigger: undefined, tool: null })).join(',') === 'kind')

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
