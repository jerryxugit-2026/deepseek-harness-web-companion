#!/usr/bin/env node
/**
 * `doctor` —— 随时自查这次安装到底通不通（终端，无 GUI）。
 *
 * 为什么单独做成一个命令（而不是只塞在引导程序第 11 步里）：
 *   1. 用户装完之后**任何时候**都可能需要它（"今天面板连不上了"）；
 *   2. 引导程序第 11 步与它**共用同一段逻辑**（`lib/health.mjs` 的 `probeHealth`），
 *      不会出现"装的时候这么判、自查的时候那么判"的两处漂移；
 *   3. 它不阻塞、不需要 TTY ⇒ 可以自动化、可以贴到 issue 里。
 *
 * 用法：
 *   node bootstrap/doctor.mjs
 *   node bootstrap/doctor.mjs --json          # 机器可读，便于贴日志
 *   node bootstrap/doctor.mjs --port 3080 --dsh-home ~/.dsh --install-dir <安装目录>
 *
 * 缺省安装目录 = 本包所在的目录（与安装器一致）；装在别处时用 --install-dir 显式给出。
 *
 * 退出码：0 = 硬判据全过；1 = 有硬判据没过。（软判据不影响退出码 —— 见 lib/health.mjs 的说明。）
 */
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PORT, PATCH_FILENAME, PLUGIN_ID, PROFILE_NAME, installDirFromEntry, parsePort } from './lib/layout.mjs'
import { readCompanionEntry } from './lib/profile-patch.mjs'
import { overallOk, pendingHard, probeHealth, renderHealth } from './lib/health.mjs'
import { createWizard } from './lib/wizard.mjs'

const argv = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const homeDir = homedir()
const port = parsePort(argOf('port', DEFAULT_PORT)) ?? DEFAULT_PORT
const dshHome = resolve(argOf('dsh-home', process.env.DSH_HOME?.trim() || join(homeDir, '.dsh')))
/*
 * ★ 缺省安装目录按优先级三选一（2026-09-14；用户实测"本机装了两份插件"之后要求）：
 *   ① `--install-dir` 显式给；
 *   ② **从 profile 挂载行反推** —— DSH 就是照那一行加载插件的，这是"实际在用哪一份"的唯一真源；
 *   ③ 本包所在的目录（原地安装且还没挂载时的情形）。
 *
 * 为什么必须有 ②：本机实测装了两份（`~/.dsh/plugins/dsh-web-companion` 一份 0.1.0、项目目录一份
 * 3.48.2）。缺省值只按"本包目录"猜时，doctor 会去查**没在跑**的那一份 —— 实测出现过
 * "自查全绿、实际在跑 0.1.0"的**假绿**。（远端那台没这问题：它就是原地安装，两者同路径。）
 */
const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const installDirArg = argOf('install-dir', null)
const mountEntry = (() => {
  try {
    const patchFile = join(dshHome, 'profiles', PROFILE_NAME, PATCH_FILENAME)
    if (!existsSync(patchFile)) return null
    return readCompanionEntry(readFileSync(patchFile, 'utf8'), PLUGIN_ID).entryPath ?? null
  } catch { return null }
})()
const installDirFromMount = installDirFromEntry(mountEntry)
const installDirSource = installDirArg !== null ? 'arg' : installDirFromMount !== null ? 'mount' : 'package'
const installDir = resolve(installDirArg ?? installDirFromMount ?? ROOT)
const asJson = argv.includes('--json')

const items = await probeHealth({ port, dshHome, installDir })

if (asJson) {
  console.log(JSON.stringify({ port, dshHome, installDir, installDirSource, ok: overallOk(items), items }, null, 2))
} else {
  const w = createWizard({})
  w.info(`DSH Web Companion · 自查（端口 ${String(port)}）`)
  w.info(`  安装目录   ${installDir}${installDirSource === 'arg' ? '（--install-dir）' : installDirSource === 'mount' ? '（从 profile 挂载反推）' : '（本包目录）'}`)
  w.info(`  DSH 数据   ${dshHome}`)
  w.blank()
  for (const line of renderHealth(items)) w.info(line)
  w.blank()
  const bad = pendingHard(items)
  if (bad.length === 0) {
    w.info('✅ 硬判据全过。')
    const soft = items.filter((i) => i.soft && !i.ok)
    if (soft.length > 0) w.info('💡 上面那条 ⚠️ 是软判据（代理判据），打开侧边栏后应变成 ✅。')
  } else {
    w.info(`❌ 有 ${String(bad.length)} 条硬判据没过：`)
    for (const b of bad) w.info(`   · ${b.label} —— ${b.fix ?? b.detail}`)
  }
  w.blank()
  w.close()
}

process.exit(overallOk(items) ? 0 : 1)
