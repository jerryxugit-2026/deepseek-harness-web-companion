#!/usr/bin/env node
/**
 * 抓取质量审计（M4）：拿**真实抓下来的文件**当数据源，把"噪音"量化。
 *
 * 为什么需要它：抓取质量是启发式堆积出来的，而"某个站点被误删了正文"这类问题
 * 只有对比真实产物才能发现。README 里那句"导航型短链接列表在某些站点仍可能被误删"
 * 不该是拍脑袋写的 —— 这个脚本给出可复现的数字。
 *
 * 它做两件事：
 *   1. **噪音计数**：分类 chip 行、标签页残留、Read more、trailing stats、
 *      占位锚点（1–2 字 + 纯页内锚点链接）、以及"密集短链接列表"（可能是导航残留，
 *      也可能是被误删的真内容 —— 需要人判断，所以只报数字不下结论）；
 *   2. **结构完整性**：有没有一级标题、有没有正文段落、正文/噪音比。
 *
 * 用法：node tests/quality/audit-captures.mjs [--dir "网页捕获"] [--json]
 *      默认审计当前仓库根目录下的 网页捕获/；可传多个 --dir。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

const args = process.argv.slice(2)
const dirs = []
for (let i = 0; i < args.length; i += 1) if (args[i] === '--dir') dirs.push(args[i + 1])
if (dirs.length === 0) dirs.push('网页捕获')
const asJson = args.includes('--json')

const PATTERNS = {
  placeholderAnchor: /^\s*[-*]\s*\[.{1,2}\]\([^)]*#\)\s*$/gmu,
  chipRow: /^\s*[-*]\s*\[?(Knowledge|Automation|Creative|Overview|Details|Files|Versions|Stats & details)\]?\(?/gmu,
  readMore: /\bread more\b/giu,
  tabStrip: /(stats & details|stats and details)/giu,
  trailingStats: /(downloads?\b|last updated|current version)/giu,
  navHeading: /^#{1,3}\s*(navigation|menu|breadcrumb|skip to|main menu)\s*$/gimu,
  shortLinkItems: /^\s*[-*]\s*\[[^\]]{1,12}\]\([^)]+\)\s*$/gmu,
}

function parse(filePath) {
  const raw = readFileSync(filePath, 'utf8')
  const match = /^---\n([\s\S]*?)\n---\n?/u.exec(raw)
  const front = match === null ? '' : match[1]
  const body = match === null ? raw : raw.slice(match[0].length)
  const field = (name) => {
    const hit = new RegExp(`^${name}:\\s*(.*)$`, 'mu').exec(front)
    return hit === null ? undefined : hit[1].replace(/^"|"$/gu, '')
  }
  const lines = body.split('\n')
  const contentLines = lines.filter((line) => line.trim() !== '')
  const counts = {}
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    counts[name] = (body.match(pattern) ?? []).length
  }
  const isSelection = /^>\s*\*\*用户选区\*\*/mu.test(body)
  const hasH1 = /^#\s+\S/mu.test(body)
  const paragraphs = contentLines.filter((line) => !/^\s*[-*#>`]/u.test(line) && line.trim().length > 40).length
  const noise = counts.placeholderAnchor + counts.chipRow + counts.readMore + counts.tabStrip + counts.trailingStats + counts.navHeading
  return {
    file: filePath,
    url: field('url'),
    trigger: field('trigger'),
    extVersion: field('sourceVersion'),
    mode: isSelection ? 'selection' : 'page',
    bytes: Buffer.byteLength(body, 'utf8'),
    lines: contentLines.length,
    paragraphs,
    hasH1,
    counts,
    noise,
    // 短链接条目既可能是导航残留、也可能是真内容：单独列出供人判断
    shortLinkRatio: contentLines.length === 0 ? 0 : Math.round((counts.shortLinkItems / contentLines.length) * 100),
  }
}

const files = []
for (const dir of dirs) {
  // 默认目录在插件仓库的上一级（抓取落在"工作区"，而工作区常常是仓库根）
  // 第一版把绝对路径当 base 又拼了一次 dir → 三个候选全不存在，静默"没找到文件"
  const candidates = [resolve(process.cwd(), dir), resolve(process.cwd(), '..', dir), resolve(process.cwd(), '../..', dir)]
  const full = candidates.find((candidate) => existsSync(candidate))
  if (full === undefined) continue
  for (const entry of readdirSync(full)) {
    const path = join(full, entry)
    if (statSync(path).isFile() && entry.endsWith('.md')) files.push(path)
  }
}
if (files.length === 0) {
  console.error(`没有找到抓取文件（找过：${dirs.join(', ')}）`)
  process.exit(2)
}

const reports = files.sort().map(parse)
if (asJson) {
  console.log(JSON.stringify({ auditedAt: new Date().toISOString(), dirs, reports }, null, 2))
} else {
  console.log(`审计 ${String(reports.length)} 份抓取\n`)
  const pad = (value, width) => String(value).padEnd(width)
  console.log(`${pad('文件', 44)} ${pad('模式', 9)} ${pad('构建', 7)} ${pad('行', 5)} ${pad('段落', 5)} ${pad('H1', 4)} ${pad('噪音', 5)} ${pad('短链接%', 8)}`)
  for (const report of reports) {
    const name = report.file.split('/').pop().slice(-42)
    // 没有 sourceVersion 的文件是"加这个字段之前"的构建抓的：噪音数偏高不代表当前回归
    console.log(`${pad(name, 44)} ${pad(report.mode, 9)} ${pad(report.extVersion ?? '(旧)', 7)} ${pad(report.lines, 5)} ${pad(report.paragraphs, 5)} ${pad(report.hasH1 ? '✓' : '✗', 4)} ${pad(report.noise, 5)} ${pad(String(report.shortLinkRatio) + '%', 8)}`)
  }
  const noisy = reports.filter((r) => r.noise > 0)
  const noH1 = reports.filter((r) => r.mode === 'page' && !r.hasH1)
  const linkHeavy = reports.filter((r) => r.shortLinkRatio >= 40)
  console.log(`\n有噪音命中：${String(noisy.length)}/${String(reports.length)}`)
  if (noisy.length > 0) for (const r of noisy) console.log(`  ${r.file.split('/').pop()} → ${JSON.stringify(Object.fromEntries(Object.entries(r.counts).filter(([, v]) => v > 0)))}`)
  if (noH1.length > 0) console.log(`整页抓取缺 H1：${noH1.map((r) => r.file.split('/').pop()).join(', ')}`)
  if (linkHeavy.length > 0) console.log(`链接占比 ≥40%（需人判断是导航残留还是真内容）：${linkHeavy.map((r) => `${r.file.split('/').pop()}(${String(r.shortLinkRatio)}%)`).join(', ')}`)
  const legacy = reports.filter((r) => r.extVersion === undefined)
  if (legacy.length > 0) console.log(`\n注意：${String(legacy.length)} 份文件没有 sourceVersion —— 它们是"记录构建版本"之前抓的，噪音数偏高不代表当前构建有回归。`)
}
