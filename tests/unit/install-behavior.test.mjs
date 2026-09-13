#!/usr/bin/env node
/**
 * `bootstrap/install.mjs` 的**行为**测试（2026-09-13 加）。
 *
 * 由来（PiMoa 片 2 第 8 条）：原有 5 个引导程序单测**全部**只测 `bootstrap/lib/*` 的纯函数，
 * 于是用户那几条硬约束 ——「默认只打印'我打算改哪些文件', 不动真格」——**零回归保护**。
 * 这个文件把 HOME / 安装目录 / DSH 数据目录全指到临时目录，然后**真的 spawn** 引导程序。
 *
 * 三个用例（各自独立一个假 HOME，互不污染）：
 *   A. 默认（dry-run）：退出码 0，**一个文件都没创建**；
 *   B. dry-run + `--yes`：最危险的组合 —— 少了 DRY_RUN 的提前退出，`--yes` 会把每个
 *      `confirm()` 变成"是"，于是一路真写下去。这里同样断言**什么都没创建**；
 *   C. `--apply` 但在**非交互**下没给 `--yes`：每个 `confirm()` 都按"否" ⇒ 同样**什么都没装**，
 *      而且必须**如实说出来**，不许报成功、退出码必须非 0。
 *
 * 咬合验证：把 `install.mjs` 里 `if (DRY_RUN) { … process.exit(…) }` 那段提前退出删掉 ⇒ B 立刻红。
 *
 * 用法：node tests/unit/install-behavior.test.mjs
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const INSTALLER = join(ROOT, 'bootstrap', 'install.mjs')

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
}

const BASE = mkdtempSync(join(tmpdir(), 'dshwc-behavior-'))

/**
 * 跑一次引导程序。
 *
 * 两个目录都**显式**用参数给出 ⇒ 连"问你装到哪"都不会触发，测试完全确定；
 * stdin 用管道（非 TTY）⇒ 任何 `confirm()`/`ask()` 都不会阻塞。
 */
function runInstaller(tag, argv) {
  const home = join(BASE, tag, 'home')
  const installDir = join(BASE, tag, 'install')
  const dshHome = join(BASE, tag, 'dsh')
  const args = [
    INSTALLER, ...argv,
    '--install-dir', installDir,
    '--dsh-home', dshHome,
  ]
  let out = ''
  let code = 0
  let spawnFailed = false
  try {
    out = execFileSync(process.execPath, args, {
      cwd: ROOT,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome },
      input: '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000,
    })
  } catch (error) {
    /*
     * ★ 必须区分"程序跑完并返回非 0"与"根本没跑起来"（2026-09-13 修；PiMoa 片 5 第 3 条）：
     * spawn 失败（ENOENT）、超时、maxBuffer 溢出时 `error.status` 是 undefined ⇒ 原来会被
     * `?? 1` 伪造成"非 0"，于是 C 的 `code !== 0` 在进程压根没起来时也能绿。
     */
    spawnFailed = typeof error?.status !== 'number'
    code = error?.status ?? 1
    out = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`
  }
  return { home, installDir, dshHome, code, out, spawnFailed }
}

console.log('\n1. ★ 默认 dry-run：只打印计划，一个文件都不创建')
{
  const r = runInstaller('dry', [])
  record('进程真的跑起来了（不是 spawn/超时失败）', r.spawnFailed === false)
  /*
   * ★ 退出码断言不能只认 0（2026-09-13 修；PiMoa 片 5 第 1 条 —— 环境依赖假红）：
   * dry-run 出口是 `die(verdict.blockers.length > 0 ? 2 : 0)`，只要预检出现任一阻断项
   * （例如运行环境 Node < 22、临时目录父级不可写），2 就是**正常**结果。
   * "是否真的走完了 dry-run"要看**输出**，退出码只作辅助。
   */
  record('★ 确实走完了 dry-run（打印了计划与结束语）', r.out.includes('将要写入') && r.out.includes('dry-run 结束'))
  record('退出码 0 或 2（2 = 预检有阻断项；dry-run 仍然没写盘）', r.code === 0 || r.code === 2)
  record('安装目录没被创建', existsSync(r.installDir) === false)
  record('DSH 数据目录没被创建', existsSync(r.dshHome) === false)
}

console.log('\n2. ★ dry-run + --yes：最危险的组合，也必须一个文件都不创建')
{
  const r = runInstaller('dryyes', ['--yes'])
  record('进程真的跑起来了', r.spawnFailed === false)
  record('★ 仍然走的是 dry-run 出口（正面证据，不只是"目录不存在"）', r.out.includes('dry-run 结束'))
  record('退出码 0 或 2', r.code === 0 || r.code === 2)
  record('★ 安装目录没被创建（退回"删掉 DRY_RUN 提前退出" ⇒ 这里红）', existsSync(r.installDir) === false)
  record('DSH 数据目录没被创建', existsSync(r.dshHome) === false)
}

console.log('\n3. ★ --apply 但非交互且没给 --yes：一个字节都不动，且必须如实说"什么都没装"')
{
  const r = runInstaller('applyno', ['--apply'])
  record('进程真的跑起来了', r.spawnFailed === false)
  record('安装目录没被创建（每个 confirm 都按否）', existsSync(r.installDir) === false)
  record('DSH 数据目录没被创建', existsSync(r.dshHome) === false)
  /*
   * ★ 三条停法都要认（2026-09-13 修；PiMoa 片 5 第 2 条）：预检**有阻断项**时会先在
   * "仍有阻断项，仍要继续吗？"处非交互按否并 exit 2，那三个旧关键词一个都不打印 ⇒ 换台机器就假红。
   */
  record('★ 说清为什么没装（拒绝创建目录 / 什么都没装 / 就此停下 / 仍有阻断项）',
    r.out.includes('拒绝创建目录') || r.out.includes('什么都没装')
      || r.out.includes('就此停下') || r.out.includes('仍有阻断项'))
  // 否定式文案断言脆弱（横幅一改就静默失效），所以主判据用"步骤没跑" + 退出码
  record('★ 退出码非 0（不把"什么都没做"当成功）', r.code !== 0)
  record('确实没走到安装步骤（计划里那句"dry-run 结束"不该出现）', r.out.includes('dry-run 结束') === false)
}

rmSync(BASE, { recursive: true, force: true })

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
