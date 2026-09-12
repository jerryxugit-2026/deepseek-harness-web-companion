#!/usr/bin/env node
/**
 * 一条命令跑完全部 Chrome 探针（M4-3）。
 *
 * 为什么需要它：探针各自能跑通 ≠ 一起能跑通 —— 它们会临时改写 dev-config、占用
 * 3099 端口、启自己的 Chrome 实例。这个脚本把它们按顺序串起来，给出汇总表，
 * 并用非零退出码表达"有探针挂了"，这样 CI（或你）只需要看一行结论。
 *
 * 它**只管自己启动的** dev 实例：结束时只杀自己拉起来的那个，绝不动你可能正在用的实例。
 * `native-*` / `autostart` 这类会碰真实 profile 与真实 Chrome 的探针**不在**这里
 * （见 docs/10-automation.md 的分层说明）。
 *
 * 用法：node scripts/probe-all.mjs [--port 3099] [--only probe:capture,probe:sites]
 */
import { spawn, execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = argOf('port', '3099')
const only = argOf('only', '')
const ORIGIN = `http://127.0.0.1:${String(PORT)}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

/** 有序列表：前面的产物/环境是后面探针的前提（越靠后越"重"）。 */
const PROBES = [
  { script: 'probe:m3-debugger', file: 'tests/m3/debugger-probe.mjs', note: 'debugger 能力前置（14 断言，不需要 dev 实例）' },
  { script: 'probe:look-left', file: 'tests/m2/look-left-probe.mjs', note: '「看左边」桥接跳（11 断言）' },
  { script: 'probe:capture', file: 'tests/m2/capture-probe.mjs', note: '抓取：整页/选区/空选区/噪音/硬化/保留（真 Chrome）' },
  { script: 'probe:sites', file: 'tests/quality/probe-sites.mjs', note: '多站点质量回归（5 类页面，真 Chrome）' },
  { script: 'probe:m3-ops', file: 'tests/m3/ops-probe.mjs', note: '浏览器 op 层（真 Chrome）' },
  { script: 'probe:m3-control', file: 'tests/m3/control-probe.mjs', note: '写操作控制面（真 Chrome + dev 实例）' },
  { script: 'probe:look-left-e2e', file: 'tests/m2/look-left-e2e-probe.mjs', note: '「看左边」全链路（真 Chrome + dev 实例）' },
  { script: 'probe:agent-turn', file: 'tests/m3/agent-turn-probe.mjs', note: '真模型回合：模型真的调用 browser_read（最重，需要模型可用）' },
]
const selected = only === '' ? PROBES : PROBES.filter((p) => only.split(',').some((name) => p.script === name.trim()))

const alive = async () => {
  try {
    const response = await fetch(`${ORIGIN}/ag/ping`, { signal: AbortSignal.timeout(1500) })
    return (await response.json())?.paired === true
  } catch {
    return false
  }
}

let started = null
if (!(await alive())) {
  console.log(`dev 实例不在跑，自己拉一个（${ORIGIN}）…`)
  started = spawn('dsh', ['web', '--no-open', '--port', PORT], {
    cwd: ROOT,
    env: { ...process.env, DSH_HOME: join(ROOT, '.devhome') },
    stdio: 'ignore',
    detached: false,
  })
  for (let i = 0; i < 60 && !(await alive()); i += 1) await sleep(500)
  if (!(await alive())) {
    console.error('✗ dev 实例没能起来（DSH_HOME=.devhome dsh web --no-open --port ' + PORT + '）')
    started?.kill()
    process.exit(3)
  }
  console.log('dev 实例就绪\n')
} else {
  console.log(`复用已在跑的 dev 实例（${ORIGIN}）\n`)
}

const results = []
for (const probe of selected) {
  console.log(`▶ ${probe.script} — ${probe.note}`)
  const startedAt = Date.now()
  let code = 0
  try {
    execFileSync(process.execPath, [join(ROOT, probe.file), '--port', PORT], { cwd: ROOT, stdio: 'inherit', env: process.env })
  } catch (error) {
    code = typeof error?.status === 'number' ? error.status : 1
  }
  results.push({ ...probe, code, seconds: Math.round((Date.now() - startedAt) / 1000) })
  console.log(`  ${code === 0 ? '✅' : `❌ exit=${String(code)}`}（${String(results.at(-1).seconds)}s）\n`)
}

// 只杀自己拉起来的实例
if (started !== null) {
  try { process.kill(-started.pid) } catch { try { started.kill() } catch { /* gone */ } }
}

console.log('汇总')
const pad = (value, width) => String(value).padEnd(width)
for (const r of results) console.log(`  ${r.code === 0 ? '✅' : '❌'} ${pad(r.script, 22)} ${pad(`${String(r.seconds)}s`, 6)} ${r.note}`)
const failed = results.filter((r) => r.code !== 0)
console.log(`\n${failed.length === 0 ? `✅ 全部通过（${String(results.length)} 个探针）` : `❌ ${String(failed.length)}/${String(results.length)} 个探针失败：${failed.map((r) => r.script).join('、')}`}`)
process.exit(failed.length === 0 ? 0 : 1)
