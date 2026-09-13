#!/usr/bin/env node
/**
 * 插件侧审计日志单测（`dsh-plugin/src/host/audit.js`）。
 *
 * 由来：2026-09-12 一次没人预期的抓取凭空建了会话，而"究竟哪条触发路径发的"**查不出来**
 * —— 插件只把抓取留在内存（`recent`，上限 50），当事实例已经没了。设计 §9 其实一直要求
 * 一份审计（`ts, origin, route, status, bytes, duration, captureId`，无 key/正文）。
 *
 * 这里钉住三件事，都是**结构性**的、不靠约定：
 *   ①  只写 allow-list 里的字段 —— URL / 正文 / 选区 / 密钥即使被传进来也进不了文件；
 *   ②  有界 —— 超过 maxBytes 就轮转，长期运行不会无限增长；
 *   ③  写不进去也不能弄坏抓取 —— 失败即自我禁用并报告，不抛异常。
 *
 * 用法：node tests/unit/audit-log.test.mjs
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AUDIT_FIELDS, createAuditLog } from '../../dsh-plugin/src/host/audit.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 140)}`)
}

const dir = mkdtempSync(join(tmpdir(), 'ag-audit-'))
const file = join(dir, 'audit.jsonl')
const log = createAuditLog({ file, maxBytes: 400, keepLines: 5, log: () => {} })

console.log('1. 记一条抓取：关键字段必须落盘（trigger / sessionMode 就是定案用的那两个）')
log.append({ kind: 'attach', captureId: 'cap-abc123', trigger: 'manual', sessionMode: 'new', mode: 'page', delivered: 1, chars: 812, truncated: false, hasSelection: false })
const entries = log.read(10)
const first = entries[0] ?? {}
record('写入了 1 条', entries.length === 1)
record('trigger 落盘（manual）', first.trigger === 'manual')
record('sessionMode 落盘（new）', first.sessionMode === 'new')
record('带 ISO 时间戳', typeof first.ts === 'string' && first.ts.includes('T'))
for (const key of ['captureId', 'mode', 'delivered', 'chars']) record(`字段 ${key} 在`, first[key] !== undefined)

console.log('\n2. allow-list：URL / 正文 / 选区 / 密钥一律进不了文件（隐私是结构性的）')
log.append({
  kind: 'attach', captureId: 'cap-leak', trigger: 'button', sessionMode: 'current',
  url: 'https://secret.example.com/path?token=LEAK-TOKEN',
  fileRef: '@网页捕获/2026-09-12-0000-secret-page-title-ab12.md',
  markdown: 'LEAK-BODY 这是一段正文',
  selection: { text: 'LEAK-SELECTION' },
  key: 'LEAK-KEY', cookie: 'LEAK-COOKIE', token: 'LEAK-TOKEN',
})
const raw = readFileSync(file, 'utf8')
for (const needle of ['LEAK-TOKEN', 'LEAK-BODY', 'LEAK-SELECTION', 'LEAK-KEY', 'LEAK-COOKIE', 'secret.example.com', 'secret-page-title']) {
  record(`文件里不含 ${needle}`, raw.includes(needle) === false)
}
record('非 allow-list 键一个都没写进去', Object.keys(entries[1] ?? {}).every((key) => key === 'ts' || AUDIT_FIELDS.includes(key)))

console.log('\n3. 有界：超过 maxBytes 自动轮转（长期运行不会涨成 GB）')
for (let i = 0; i < 40; i += 1) log.append({ kind: 'attach', captureId: `cap-${String(i)}`, trigger: 'button', mode: 'page', delivered: 1, chars: 1000 + i })
const size = statSync(file).size
record(`文件大小 ${String(size)}B ≤ maxBytes+单条余量`, size <= 400 + 300)
const after = log.read(100)
record('轮转后仍能读出条目', after.length > 0)
record('保留的是较新的（最后一条含 chars=1039）', after.at(-1)?.chars === 1039)

console.log('\n4. 写不进去也不能弄坏抓取：**报错但不永久停写**，可观测，且不抛异常')
{
  const bad = createAuditLog({ file: '/dev/null/definitely/not/a/dir/audit.jsonl', log: () => {} })
  let threw = false
  let ok = true
  try { ok = bad.append({ kind: 'attach', captureId: 'cap-x' }) } catch { threw = true }
  record('不抛异常', threw === false)
  record('返回 false（调用方知道没记上）', ok === false)
  record('enabled 如实反映"此刻写不进去"', bad.enabled === false)
  record('再写一次仍是 false', bad.append({ kind: 'attach' }) === false)
  // ★关键回归：**不永久拉闸**。旧实现第一次失败就 `enabled=false` 并让后续 append 直接
  // return（短路）—— 于是一次瞬时 IO 错误就让审计"永久死亡"，而且系统内外都看不见。
  // 现在第二次 append 会**真的再试一次**，所以失败计数是 2 而不是 1。
  record('★第二次是真的重试（failed=2），不是永久拉闸短路', bad.status().failed === 2)
  record('★健康状态可观测（status() 给出 written/failed/lastError）',
    bad.status().written === 0 && typeof bad.status().lastError === 'string' && bad.status().lastError.length > 0)
  const good = createAuditLog({ file: join(dir, 'recover.jsonl'), log: () => {} })
  good.append({ kind: 'attach', captureId: 'cap-y' })
  record('另一个可用路径不受影响（全局没有"审计已死"状态）', good.status().enabled === true && good.status().written === 1)
}

rmSync(dir, { recursive: true, force: true })
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
