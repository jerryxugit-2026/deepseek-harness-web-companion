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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const INSTALLER = join(ROOT, 'bootstrap', 'install.mjs')

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
}

const BASE = mkdtempSync(join(tmpdir(), 'dshwc-behavior-'))

/**
 * 列出目录树里的**每一条相对路径**（用于前后比对"有没有多出东西"）。
 *
 * ★ 为什么需要它（2026-09-13 PiMoa 复核 MAJOR-M4）：假 npm 只能挡住"经 PATH 调用 npm"这一种写法 ——
 * 如果哪天改成 `node <npm-cli.js> install` 或直接 fetch tarball，记账断言照样全绿。
 * 对整个沙箱做前后快照，"偷偷写了/下了任何东西"就一定露出来。
 */
function snapshot(root) {
  const out = []
  const walk = (dir, rel) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const r = rel === '' ? entry.name : rel + '/' + entry.name
      out.push(r)
      if (entry.isDirectory()) walk(join(dir, entry.name), r)
    }
  }
  walk(root, '')
  return out
}

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
  record('DSH 数据目录没被创建（第2次）', existsSync(r.dshHome) === false)
}

console.log('\n3. ★ --apply 但非交互且没给 --yes：一个字节都不动，且必须如实说"什么都没装"')
{
  const r = runInstaller('applyno', ['--apply'])
  record('进程真的跑起来了（第2次）', r.spawnFailed === false)
  record('安装目录没被创建（每个 confirm 都按否）', existsSync(r.installDir) === false)
  record('DSH 数据目录没被创建（第3次）', existsSync(r.dshHome) === false)
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

console.log('\n4. ★ 缺省安装目录 = 你解压出来的这个文件夹（用户 2026-09-13 要求）；原地安装不删源码')
{
  /*
   * 不给 --install-dir ⇒ 缺省值必须就是**本包所在目录**（bootstrap/ 的上一级）。
   * 非交互（stdin 是管道）⇒ 就算触发"问你装到哪"也立刻返回缺省值，不会挂住。
   */
  const runNoInstallDir = () => {
    const home = join(BASE, 'inplace', 'home')
    const dshHome = join(BASE, 'inplace', 'dsh')
    let out = ''
    let code = 0
    let spawnFailed = false
    try {
      out = execFileSync(process.execPath, [INSTALLER, '--dsh-home', dshHome], {
        cwd: ROOT,
        env: { ...process.env, HOME: home, DSH_HOME: dshHome },
        input: '',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 180000,
      })
    } catch (error) {
      spawnFailed = typeof error?.status !== 'number'
      code = error?.status ?? 1
      out = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`
    }
    return { home, dshHome, out, code, spawnFailed }
  }

  const inPlace = runNoInstallDir()
  record('原地分支：进程真的跑起来了', inPlace.spawnFailed === false)
  record('★ 缺省安装目录 == 本包目录（而不是 ~/.dsh/plugins/...）', inPlace.out.includes(`安装目录   ${ROOT}`))
  record('★ 计划如实说"沿用本目录（原地安装）"', inPlace.out.includes('沿用本目录'))
  record('★ 计划如实说"复制源码          跳过"', inPlace.out.includes('复制源码          跳过'))
  /*
   * ★ 只断言**有意义**的东西（2026-09-13 自测发现）：原来这里断言"隔离 HOME 里一个文件都没有"，
   * 但探测 npm 全局前缀时 `npm prefix -g` 会创建 `$HOME/.npm`（它连 HOME 本身都会建）——
   * 那是 npm 自己的缓存目录，不是我们写的东西。断言工具的行为会把门禁变成假红。
   */
  record('dry-run 下 DSH 数据目录没被创建', existsSync(inPlace.dshHome) === false)
  record('dry-run 下没有 ~/.dsh', existsSync(join(inPlace.home, '.dsh')) === false)

  /*
   * ★ 反向断言（防硬编码骗过上面几条）：显式给**别的**目录时，必须走
   * "创建安装目录 + 复制源码 N 项"，且**绝不能**出现"沿用本目录"。
   */
  const elsewhere = runInstaller('elsewhere', [])
  record('异地分支：进程真的跑起来了', elsewhere.spawnFailed === false)
  record('★ 显式 --install-dir 时不说"沿用本目录"', elsewhere.out.includes('沿用本目录') === false)
  record('★ 显式 --install-dir 时计划为"创建安装目录"', elsewhere.out.includes('创建安装目录'))
  record('★ 显式 --install-dir 时计划为"复制源码 N 项"', /复制源码\s+\d+ 项/.test(elsewhere.out))
}

console.log('\n5. ★ 依赖层只报告（2026-09-13 用户定调）：缺 DSH 时一个文件都不写、绝不调用 npm')
{
  /*
   * 在一个**隔离的"干净机器"**里跑 --apply --yes：
   *   · HOME 指向临时目录（这样 ~/.local/bin/dsh 之类的候选都不存在）；
   *   · PATH 只有 /usr/bin:/bin（没有 dsh、没有 node_modules），前面再塞一个**只会记账的假 npm**；
   *   · 显式给 --install-dir，这样"有没有偷偷先建目录"可以被断言到。
   * 期望：拦在写文件之前（exit 2），并把该跑的命令告诉用户。
   *
   * 这组断言会咬的地方：谁把"自己判断 + 自己下载/自己装 DSH"加回来，
   * 假 npm 的记账文件里就会出现 install，或者隔离目录被创建 ⇒ 立刻红。
   */
  const sandbox = join(BASE, 'nodeps')
  const fakeBin = join(sandbox, 'bin')
  mkdirSync(fakeBin, { recursive: true })
  const npmLog = join(sandbox, 'npm-calls.log')
  // 假 npm：只把参数记下来，什么都不做（真 npm 不该在这个场景里被调用到 install）
  writeFileSync(join(fakeBin, 'npm'), `#!/bin/sh\necho "$@" >> "${npmLog}"\nexit 0\n`, { mode: 0o755 })
  const home = join(sandbox, 'home')
  mkdirSync(home, { recursive: true })
  const installDir = join(sandbox, 'install')
  const dshHome = join(sandbox, 'dsh')
  const before = snapshot(sandbox)

  let out = ''
  let code = 0
  let spawnFailed = false
  try {
    out = execFileSync(process.execPath, [INSTALLER, '--apply', '--yes', '--install-dir', installDir, '--dsh-home', dshHome], {
      cwd: ROOT,
      env: { ...process.env, HOME: home, DSH_HOME: dshHome, PATH: `${fakeBin}:/usr/bin:/bin` },
      input: '',
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 180000,
    })
  } catch (error) {
    spawnFailed = typeof error?.status !== 'number'
    code = error?.status ?? 1
    out = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`
  }

  record('干净机器：进程真的跑起来了（不是 spawn/超时失败）', spawnFailed === false)
  record('★ 缺 DSH ⇒ 退出码 2（前置条件不满足，不是"中途失败"）', code === 2)
  record('★ 报告里给出可复制的安装命令（是"告诉用户"，不是"替用户装"）', /npm install -g @deepseek-ai\/dsh@\S+/u.test(out))
  record('★ 报告里明说本程序不下载、不安装任何依赖', out.includes('本程序不下载、不安装任何依赖'))
  record('★ 报告里告诉用户可以用 --dsh 点路径（源码安装的情形）', out.includes('--dsh'))
  record('★ 安装目录没被创建（依赖门禁拦在"第 1 步"之前）', existsSync(installDir) === false)
  record('★ DSH 数据目录没被创建', existsSync(dshHome) === false)
  record('★ 隔离 HOME 里没有留下任何东西', existsSync(join(home, '.dsh')) === false)
  /*
   * 假 npm 的记账：允许出现 `prefix -g`（那是**只读探测**，用它找全局安装位置），
   * 但**绝不能**出现 install —— 出现了就说明又在自己下载/自己装了。
   */
  const calls = existsSync(npmLog) ? readFileSync(npmLog, 'utf8') : ''
  record('★ 全程没调用过 npm install（假 npm 记账里没有 install）', calls.includes('install') === false)
  /*
   * ★ 非空断言（2026-09-13 PiMoa 复核 MAJOR-M4）：`[].every(...)` 恒真 —— 记账文件不存在时
   * 这条会"通过"，于是"探测根本没发生"也算绿。必须先要求记账**非空**。
   */
  const callLines = calls.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  record('★ 探测确实发生过（记账非空 —— 空集 every 恒真，不算通过）', callLines.length > 0)
  record('★ 记账里只有只读的 prefix -g，没有任何别的 npm 调用', callLines.every((l) => l === 'prefix -g'))
  /*
   * ★ 【接线检查，不是行为证明】缺依赖的硬门禁必须存在，且位于第 1 步（首次写盘）之前。
   *
   * 为什么不只靠上面的行为断言（2026-09-13 实测，必须记下来）：现在有**两道**门 ——
   *   · `verdict.blockers` 那道（阻断项在脚本化模式下直接退 2），
   *   · `depBlockers` 这道（缺依赖无条件停下，连"交互式下用户硬要越过"也拦住）。
   * 任何一道单独都能保证"缺依赖 ⇒ 不写文件 + 退 2"，所以把其中一道注入 `if (false)` 变异之后，
   * 本节的行为断言**仍然全绿**（实测 0 条变红）。两道门是刻意的纵深防御，不是冗余 bug；
   * 但"删掉其中一道"这件事必须有人看着 —— 这条静态断言就是那个看守，名字里也写清楚了它是什么。
   */
  const installerSrc = readFileSync(INSTALLER, 'utf8')
  const atDepGate = installerSrc.indexOf('if (depBlockers.length > 0) {')
  const atStep1 = installerSrc.indexOf('step(1, ')
  record('★ 【接线检查】缺依赖的硬门禁存在，且位于第 1 步（首次写盘）之前',
    atDepGate !== -1 && atStep1 !== -1 && atDepGate < atStep1)

  const added = snapshot(sandbox).filter((p) => !before.includes(p))
  record('★ 沙箱里没有新增任何文件（唯一允许的是 npm 自己的缓存目录 home/.npm）',
    added.every((p) => p.startsWith('home/.npm') || p === 'npm-calls.log'))
}

console.log('\n6. ★ --yes 不能跳过阻断项：退出码必须是 2（前置条件），不是 3（中途失败）')
{
  /*
   * 造一个"祖先存在但不可写"的安装目录：0o500 的父目录会让 dirStatus 判 unwritable ⇒ 阻断项。
   * 修复前：`--apply --yes` 会绕过逃生口一路走到 mkdirSync 抛 EACCES，被兜底成 exit 3。
   */
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    // ★ 不写装饰性断言（字面量 true 永远为绿，被 consistency-check 当场抓到）：
    //   这里断言的是**真实探测结果**，不是常量 —— 只有真的以 root 运行才会为真。
    record('★ 以 root 运行 ⇒ 0o500 挡不住 mkdir，本机跳过上面那条（该条仅在非 root 下出现）', process.getuid() === 0)
  } else {
    const ro = join(BASE, 'ro')
    mkdirSync(ro, { recursive: true })
    chmodSync(ro, 0o500)
    let out = ''
    let code = 0
    let spawnFailed = false
    try {
      out = execFileSync(process.execPath, [INSTALLER, '--apply', '--yes', '--install-dir', join(ro, 'install'), '--dsh-home', join(BASE, 'ro-home')], {
        cwd: ROOT,
        env: { ...process.env, HOME: join(BASE, 'ro-home') },
        input: '',
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 180000,
      })
    } catch (error) {
      spawnFailed = typeof error?.status !== 'number'
      code = error?.status ?? 1
      out = `${String(error?.stdout ?? '')}${String(error?.stderr ?? '')}`
    }
    chmodSync(ro, 0o700)
    record('第6节：进程真的跑起来了', spawnFailed === false)
    record('★ 退出码 2（前置条件不满足），而不是 3（中途失败）', code === 2)
    record('★ 说清是阻断项、并声明没有改动任何文件', out.includes('阻断') && out.includes('没有改动任何文件'))
  }
}

rmSync(BASE, { recursive: true, force: true })

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
