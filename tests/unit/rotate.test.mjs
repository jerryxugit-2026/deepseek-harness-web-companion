#!/usr/bin/env node
/**
 * 原生 host 日志轮转单测（`native-host/rotate.mjs`）。
 *
 * 由来：用户问"审计日志有没有防膨胀"。查下来 —— 抓取目录与截图目录走 24h 清扫、
 * 插件的审计 JSONL 按大小轮转、扩展侧是 200 条环形缓冲，**只有原生 host 日志
 * （`~/.dsh/logs/dsh-web-companion-host.log`）是裸 append、没有任何上限**。
 * 它增长得慢（只在 ensure-dsh/status/stop-dsh 时加一行），但"慢"不是"有界"。
 *
 * 用法：node tests/unit/rotate.test.mjs
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { rotateIfNeeded } from '../../native-host/rotate.mjs'

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 140)}`)
}

const dir = mkdtempSync(join(tmpdir(), 'ag-rotate-'))
const file = join(dir, 'host.log')

console.log('1. 未超上限：原样不动（不要为了"看起来干净"而丢日志）')
writeFileSync(file, 'line-1\nline-2\n', 'utf8')
const untouched = rotateIfNeeded(file, { maxBytes: 1024, keepLines: 10 })
record('rotated=false', untouched.rotated === false)
record('内容没被动过', readFileSync(file, 'utf8') === 'line-1\nline-2\n')

console.log('\n2. 超上限：截到最近 keepLines 行，且**保留的是最新的**')
for (let i = 0; i < 400; i += 1) appendFileSync(file, `2026-09-12T00:00:00.000Z line-${String(i).padStart(3, '0')} padding-padding-padding\n`)
const before = statSync(file).size
const rotated = rotateIfNeeded(file, { maxBytes: 4096, keepLines: 50 })
const after = statSync(file).size
record(`确实轮转了（${String(before)}B → ${String(after)}B）`, rotated.rotated === true && after < before)
record('有界（≤ 上限 + 余量）', after <= 4096 + 200)
const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean)
record(`保留 50 行（实际 ${String(lines.length)}）`, lines.length === 50)
record('保留的是最新那批（末行是 line-399）', lines.at(-1).includes('line-399'))
record('最旧的已被丢掉（不含 line-000）', readFileSync(file, 'utf8').includes('line-000') === false)

console.log('\n3. 反复轮转不会把文件撑回去（长期运行有界）')
for (let round = 0; round < 20; round += 1) {
  for (let i = 0; i < 60; i += 1) appendFileSync(file, `2026-09-12T00:00:00.000Z round-${String(round)} i-${String(i)} padding-padding-padding\n`)
  rotateIfNeeded(file, { maxBytes: 4096, keepLines: 50 })
  if (statSync(file).size > 4096 + 200) break
}
record(`20 轮之后仍 ≤ 上限+余量（${String(statSync(file).size)}B）`, statSync(file).size <= 4096 + 200)

console.log('\n4. 防御性：文件不存在 / 路径不可写 —— 不抛异常（日志坏了不能弄坏 native messaging）')
{
  let threw = false
  let missing
  try { missing = rotateIfNeeded(join(dir, 'never-existed.log'), { maxBytes: 10 }) } catch { threw = true }
  record('文件不存在时不抛异常', threw === false)
  record('返回 rotated=false', missing?.rotated === false)
  let threw2 = false
  try { rotateIfNeeded('/dev/null/nope/never.log', { maxBytes: 10 }) } catch { threw2 = true }
  record('路径不可写时不抛异常', threw2 === false)
}

rmSync(dir, { recursive: true, force: true })
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
