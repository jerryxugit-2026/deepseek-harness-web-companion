#!/usr/bin/env node
/**
 * 门禁：**构建产物里烤进去的 DSH 端口，必须和源码 `dev-config.js` 一致**。
 *
 * 由来（2026-09-12 真实事故，代价是用户侧的扩展整整一段时间连不上）：
 * 探针为了让扩展指向测试实例，会**临时改写** `extension/src/lib/dev-config.js`（HANDOFF 避坑
 * 清单第 2 条只提醒了"别忘了还原"）。但如果**与此同时**另一个进程在跑 `npm run build:ext`
 * （或 `npm run check`），构建就会把**测试端口**烤进 `extension/dist/`。而 `dist/` 正是用户
 * Chrome 加载的那个目录 —— 于是用户的侧边栏开始往测试端口拨号：`/ag/agent` 连不上
 * （表现为 `E_EXT_OFFLINE`），而源码里明明是好的，看代码怎么都看不出问题。
 *
 * 这条断言把"源码 vs 产物"的漂移变成 CI 里立刻可见的红色，而不是靠人记得别并发跑。
 *
 * 用法：node scripts/check-dist-config.mjs   （由 `npm run check` 在 build:ext 之后调用）
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'extension', 'src', 'lib', 'dev-config.js')
const BUNDLES = [
  join(ROOT, 'extension', 'dist', 'src', 'sw', 'index.js'),
  join(ROOT, 'extension', 'dist', 'src', 'sidepanel', 'panel.js'),
]

const source = readFileSync(SOURCE, 'utf8')
const expectedPort = (source.match(/port: *([0-9]+)/) ?? [])[1]
const expectedKey = (source.match(/key: *'([^']*)'/) ?? [])[1]

if (expectedPort === undefined) {
  console.error(`✗ 读不到 ${SOURCE} 里的 port —— 这个文件应由 scripts/init-key.mjs 生成`)
  process.exit(1)
}

let failed = false
for (const bundle of BUNDLES) {
  let body
  try {
    body = readFileSync(bundle, 'utf8')
  } catch {
    console.error(`✗ 产物不存在：${bundle}（先跑 npm run build:ext）`)
    failed = true
    continue
  }
  const ports = [...body.matchAll(/port: *([0-9]+)/g)].map((m) => m[1])
  const wrong = [...new Set(ports)].filter((port) => port !== expectedPort)
  if (ports.length === 0) {
    console.error(`✗ ${bundle} 里找不到 port —— 产物可能不是本构建产出的`)
    failed = true
  } else if (wrong.length > 0) {
    console.error(`✗ ${bundle} 烤进去的端口是 ${wrong.join('/')}，源码 dev-config.js 是 ${expectedPort}`)
    console.error('  → 典型原因：探针临时改写 dev-config 时，另一个进程并发跑了 build:ext/check。')
    console.error('  → 修法：确认 dev-config.js 是正确端口后重新 `npm run build:ext`。')
    failed = true
  }
  if (typeof expectedKey === 'string' && expectedKey !== '' && !body.includes(expectedKey)) {
    console.error(`✗ ${bundle} 里的配对 key 与源码 dev-config.js 不一致（产物是旧构建？）`)
    failed = true
  }
}

if (failed) process.exit(1)

/*
 * 独立基准：源码 dev-config 的端口必须等于**真实配对文件**里的端口。
 *
 * 只断言"source == dist"是不够的：探针崩在"改写了 dev-config 但没还原"之间时，两边会**一致地
 * 错**，门禁照样绿 —— 而那正是 HANDOFF 避坑清单第 2 条描述的事故形态，也是 2026-09-12 那次
 * dist 被烤进测试端口的上游原因。真实配对文件是本机上的独立事实，拿它当基准能把这一类抓出来。
 * 该文件不存在时（CI / 干净机器）不判失败，但**明说基准缺失**，不假装检查过。
 */
const pairingPort = (() => {
  // 尊重 DSH_HOME：引导程序允许把数据目录装在别处，那时基准也在别处。
  // （以前这里写死 `~/.dsh` —— 自定义 DSH_HOME 的安装会拿错基准，属于同类硬编码。）
  const dshHome = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  let raw
  try {
    raw = readFileSync(join(dshHome, 'dsh-web-companion.json'), 'utf8')
  } catch (error) {
    // Distinguish "this machine simply has no pairing file" (CI, clean box) from "the check
    // itself is broken". A blanket `catch { return undefined }` turned an undefined-`homedir`
    // TypeError into a cheerful "no baseline available" — i.e. the gate silently degraded to a
    // no-op, which is the exact failure mode this whole pass is about.
    if (error?.code === 'ENOENT') return undefined
    throw new Error(`读配对文件失败（不是"文件不存在"，是本检查自身出问题了）：${String(error?.message ?? error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`配对文件不是合法 JSON：${String(error?.message ?? error)}`)
  }
  if (parsed?.port === undefined || parsed?.port === null) throw new Error('配对文件里没有 port 字段')
  return String(parsed.port)
})()
if (pairingPort === undefined) {
  console.log(`dist-config: 注意 —— ${typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.trim() !== '' ? process.env.DSH_HOME.trim() : '~/.dsh'} 下没有 dsh-web-companion.json，无法用真实配对文件做独立基准（本次只校验了 source==dist）`)
} else if (pairingPort !== expectedPort) {
  console.error(`✗ 源码 dev-config.js 的端口是 ${expectedPort}，而真实配对文件是 ${pairingPort}`)
  console.error('  → 典型原因：某个探针改写了 dev-config.js 却没还原（崩溃/SIGINT），或你换了端口但没重新 init-key。')
  console.error(`  → 修法：node scripts/init-key.mjs --home ~/.dsh 重新生成；或把 dev-config.js 改回 ${pairingPort} 后重跑 build:ext。`)
  process.exit(1)
}

console.log(`dist-config: OK（产物与源码一致，port=${expectedPort}${pairingPort === undefined ? '' : '，且与真实配对文件一致'}）`)
