#!/usr/bin/env node
/**
 * 保留策略单测：抓取目录不得无限膨胀（设计 docs/03 §7）。
 *
 * 由用户实测提出：`网页捕获/` 每抓一次多一个 .md，没有任何东西会删它们。
 * 这里把策略钉死，并**明确写清哪些文件不许删**（用户自己放进目录的东西）。
 *
 * 用法：node tests/unit/retention.test.mjs
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CAPTURE_FILE, TEMP_FILE, sweepCaptures } from '../../dsh-plugin/src/host/retention.js'

const root = mkdtempSync(join(tmpdir(), 'dsh-retention-'))
const dir = join(root, '网页捕获')
mkdirSync(dir, { recursive: true })

const now = Date.now()
const HOUR = 3600 * 1000

/** Create a file with an explicit mtime (age in hours before `now`). */
function plant(name, ageHours, body = '# capture\n') {
  const full = join(dir, name)
  writeFileSync(full, body, 'utf8')
  const at = new Date(now - ageHours * HOUR)
  utimesSync(full, at, at)
  return full
}

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value)}`)
}
const list = () => readdirSync(dir).sort()

console.log('1. 目录状态：老的我们写的文件 / 新的 / 用户自己的文件')
const oldOurs = plant('2026-09-10-0900-old-page-aa11.md', 25)
const olderOurs = plant('2026-09-09-0900-ancient-page-bb22.md', 48)
const freshOurs = plant('2026-09-11-2200-fresh-page-cc33.md', 1)
const oldTmp = plant('2026-09-10-0900-old-page-dd44.md.tmp', 30)
const userFile = plant('我的笔记.md', 100)
const userJson = plant('index.json', 200, '{}')
const nested = join(dir, 'sub')
mkdirSync(nested, { recursive: true })
plant('sub/2026-09-01-0000-nested-ee55.md', 200)
record('文件名规则认得自己的抓取文件', CAPTURE_FILE.test('2026-09-11-2223-plant-the-peak-apex-nc-official-website-t-99ac.md'))
record('文件名规则认得 .tmp 残留', TEMP_FILE.test('2026-09-11-2223-x-aa11.md.tmp'))
record('文件名规则不认用户文件', !CAPTURE_FILE.test('我的笔记.md') && !CAPTURE_FILE.test('index.json'))

console.log('\n2. 执行清扫（保留 24h）')
const swept = await sweepCaptures(dir, { retentionHours: 24, now })
record('删除 25h 的抓取文件', !list().includes('2026-09-10-0900-old-page-aa11.md'))
record('删除 48h 的抓取文件', !list().includes('2026-09-09-0900-ancient-page-bb22.md'))
record('删除 30h 的 .tmp 残留', !list().includes('2026-09-10-0900-old-page-dd44.md.tmp'))
record('保留 1h 的抓取文件', list().includes('2026-09-11-2200-fresh-page-cc33.md'))
record('保留用户的 我的笔记.md（哪怕 100h 前）', list().includes('我的笔记.md'))
record('保留用户的 index.json（哪怕 200h 前）', list().includes('index.json'))
record('不递归进子目录', list().includes('sub'))
record('报告里 removed 数量 = 3', swept.removed.length === 3)
record('报告里带年龄（便于日志追溯）', swept.removed.every((r) => typeof r.ageHours === 'number' && r.ageHours >= 24))
record('报告里 kept = 未被删的文件数（含用户文件）', swept.kept === 3)

console.log('\n3. 关闭开关与边界')
const disabled = await sweepCaptures(dir, { retentionHours: 0, now })
record('retentionHours=0 → 关闭，什么都不删', disabled.disabled === true && disabled.removed.length === 0)
const missing = await sweepCaptures(join(root, '不存在的目录'), { retentionHours: 24, now })
record('目录不存在 → 不抛错（首次抓取前）', missing.missing === true && missing.removed.length === 0)
const future = plant('2026-09-11-2300-from-the-future-ff66.md', -5)
const none = await sweepCaptures(dir, { retentionHours: 24, now })
record('未来时间戳的文件不会被误删', list().includes('2026-09-11-2300-from-the-future-ff66.md') && none.removed.length === 0)

console.log('\n4. 边界：策略是「严格老于 retention 才删」，断言用 ±1s 而不是"恰好相等"')
// 平台事实（实测）：macOS/APFS 的 mtime 是纳秒精度，用毫秒精度的 Date 调 utimesSync 会存成
// `….999ms` —— 于是"恰好 24h"实际比 cutoff 早约 1µs。把断言钉在 µs 边界上只会造出假失败，
// 所以这里用 1 秒边距，并把比较符语义（>= 保留 / < 删除）写进断言名。
const justOver = plant('2026-09-10-2159-over-24h-hh88.md', 24 + 1 / 3600)
const justUnder = plant('2026-09-10-2201-under-24h-ii99.md', 24 - 1 / 3600)
const edge = await sweepCaptures(dir, { retentionHours: 24, now })
record('24h+1s 的文件被删（严格老于保留期）', !list().includes('2026-09-10-2159-over-24h-hh88.md'))
record('24h-1s 的文件被保留', list().includes('2026-09-10-2201-under-24h-ii99.md'))
record('清扫只删该删的那一个', edge.removed.length === 1)

console.log('\n5. TEMP_FILE 不许越界：本插件的 .md.tmp 归我们，用户自己的 .tmp 不许碰')
{
  // 旧实现是 `/\.tmp$/u` —— 任何 `.tmp` 都算"崩溃残留"，于是用户在捕获目录里放一个
  // `notes.tmp`（老于 24h）就会被删掉，与本文件头部承诺的 "Anything a user dropped into
  // that folder is theirs — never touched" 直接矛盾（2026-09-12 审核指出、已修）。
  plant('2026-09-10-1200-capture-aa11.md.tmp', 30) // store.js 真正会写的形态
  plant('notes.tmp', 30)                            // 用户自己放的
  await sweepCaptures(dir, { retentionHours: 24, now })
  record('本插件的 .md.tmp 被清（崩溃残留该清）', !list().includes('2026-09-10-1200-capture-aa11.md.tmp'))
  record('★用户自己的 notes.tmp 被保留（注释承诺"绝不碰"）', list().includes('notes.tmp'))
}

rmSync(root, { recursive: true, force: true })
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
