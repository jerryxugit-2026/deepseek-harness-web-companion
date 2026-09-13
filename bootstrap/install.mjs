#!/usr/bin/env node
/**
 * DSH Web Companion · 终端引导程序
 *
 * 目标（用户 2026-09-12 的原话，逐条对应下面每一步）：
 *   · 「让用户选择安装目录」
 *   · 「检测所有的依赖, 如果没有安装, 就在用户已经选好的目录去安装依赖」
 *   · 「安装每一个依赖, 都需要用户确认一下」
 *   · 「引导程序需要告诉用户怎么申请 DeepSeek API key, 然后让他可以把 Key 贴进来」
 *   · 「告诉用户 chrome 扩展怎么安装, 让用户自己按照步骤操作」
 *   · 「用户安装完 chrome 扩展以后, 在引导程序选择安装完成。这时候, 引导程序要检测所有的依赖,
 *      chrome 扩展是否都健康运行。然后引导程序退出」
 *   · 「引导程序不需要做 GUI 的, 一个终端界面的程序就可以」
 *
 * 另外两条硬约束：
 *   · **发行包保持轻量**：本程序只复制我们自己的源码；依赖（DSH、esbuild、ws、dsh-tools…）
 *     一律在安装时由它**下载**，发行包里不含任何 `node_modules`，也不含预构建的 `extension/dist`。
 *   · **默认 dry-run**：不加 `--apply` 时只打印"将要写哪些文件"，一个字节都不动。
 *     用户明确要求过：「默认只打印'我打算改哪些文件'，不动真格」。
 *
 * 用法：
 *   node bootstrap/install.mjs                  # dry-run（默认）：只打印计划
 *   node bootstrap/install.mjs --apply          # 真的装（每一步都问一次）
 *   node bootstrap/install.mjs --apply --yes    # 真的装，不再逐项询问
 *
 * 可选参数：--install-dir <路径> --dsh-home <路径> --port <端口> --dsh-version <版本>
 */
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, symlinkSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PORT,
  PLUGIN_ID,
  defaultInstallDir,
  installPayload,
  installPayloadFilter,
  parsePort,
  resolveLayout,
} from './lib/layout.mjs'
import { applyPluginLinks, classifyMissingPluginDeps, describePluginLinks, findDshRoot, planPluginLinks } from './lib/dsh-root.mjs'
import { extensionIdFromKey } from './lib/extension-id.mjs'
import { checkChrome, checkDirectory, checkDshCli, checkMount, checkNode, checkPort, renderChecks, summarize } from './lib/checks.mjs'
import { dirStatus, dshVersion as readDshVersion, pingPlugin, portListening, readPairingKey, which } from './lib/probe.mjs'
import { applyNativeHostInstall, describeNativeHostPlan, planNativeHostInstall } from './lib/native-host-install.mjs'
import { buildMountConfig, describeCompanion, upsertCompanion } from './lib/profile-patch.mjs'
import { finishBanner, probeHealth, renderHealth } from './lib/health.mjs'
import { DEEPSEEK_KEY_REF, readRef, upsertRef } from './lib/credentials.mjs'
import { createWizard } from './lib/wizard.mjs'

/* ─────────────────────────── 参数 ─────────────────────────── */

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

if (flag('help') || flag('h')) {
  console.log(`DSH Web Companion · 安装引导程序（终端，无 GUI）

用法：
  node bootstrap/install.mjs                  # dry-run（默认）：只打印将要改哪些文件
  node bootstrap/install.mjs --apply          # 真的安装（每一处改动都会先问你）
  node bootstrap/install.mjs --apply --yes    # 真的安装，不再逐项询问

可选：
  --install-dir <路径>   安装到哪（默认 ${defaultInstallDir(homedir())}；**不给就会问你一次**）
  --dsh-home <路径>      DSH 数据目录（默认 $DSH_HOME 或 ${join(homedir(), '.dsh')}；**不给就会问你一次**）
  --port <端口>          DSH 端口（默认 ${String(DEFAULT_PORT)}）
  --dsh-version <版本>   要钉的 DSH 版本（默认用你已装的那个；**不要用 latest**）

退出码：
  0 成功   2 参数/前置条件不满足（含 dry-run 有阻断项）   3 中途失败   4 关键步骤被你拒绝
  5 步骤全跑完、但复检没过（常见于刚装完还没重启 DSH —— 见收尾提示）   130 Ctrl-C
`)
  process.exit(0)
}

const HERE = dirname(fileURLToPath(import.meta.url))
/** 仓库根 / 安装根：引导程序在 `<root>/bootstrap/` 下，两种情形都成立。 */
const ROOT = resolve(HERE, '..')

const DRY_RUN = !flag('apply')
const ASSUME_YES = flag('yes')
const homeDir = homedir()
/**
 * 目录：命令行**显式**给了就用它（`null` = 没给）。
 *
 * 没给的时候要**问用户**（2026-09-13 用户指出："引导程序会不会让用户选择目录进行安装？"）——
 * 问的地方见下面 `w.ask()` 那一段。这其实是本文件第 6 行本来就写着的目标，此前只是没实现。
 */
// `|| null`：`--install-dir=` 这种**空值**会被 argOf 返回 `''`，而 `resolve('')` 会落到 cwd
// （2026-09-13 修；PiMoa 片 A 第 15 条）—— 空值必须当成"没给"，才会走"问你一次"。
const installDirArg = argOf('install-dir', null) || null
const dshHomeArg = argOf('dsh-home', null) || null
const defaultInstallDirPath = resolve(defaultInstallDir(homeDir))
const defaultDshHomePath = resolve(process.env.DSH_HOME?.trim() || join(homeDir, '.dsh'))
const port = parsePort(argOf('port', DEFAULT_PORT)) ?? DEFAULT_PORT
/** 要钉的 DSH 版本：优先命令行，其次已装的那个（避免把用户的 DSH 降级/升级到别处）。 */
const requestedDshVersion = argOf('dsh-version', null)

/**
 * 用户显式指定的挂载 config。
 *
 * `--set key=value` 可重复；另给一个专门的 `--approval-for-write-ops <true|false>`，
 * 因为这台部署真的需要它 —— 见 `buildMountConfig` 的注释：本安装器的
 * "卸载 → 重装"往返曾把 `approvalForWriteOps: false` 悄悄丢掉。
 */
const extraConfig = {}
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] !== '--set' || argv[i + 1] === undefined) continue
  const at = argv[i + 1].indexOf('=')
  if (at <= 0) continue
  const key = argv[i + 1].slice(0, at)
  const raw = argv[i + 1].slice(at + 1)
  extraConfig[key] = raw === 'true' ? true : raw === 'false' ? false : (/^-?\d+(\.\d+)?$/u.test(raw) ? Number(raw) : raw)
}
const approvalFlag = argOf('approval-for-write-ops', null)
if (approvalFlag !== null && approvalFlag !== 'true' && approvalFlag !== 'false') {
  console.error(`✗ --approval-for-write-ops 只接受 true/false，收到 ${JSON.stringify(approvalFlag)}`)
  process.exit(2)
}
const approvalForWriteOps = approvalFlag === null ? undefined : approvalFlag === 'true'

const w = createWizard({ assumeYes: ASSUME_YES })

/**
 * 「让用户选择安装目录」—— 用户 2026-09-12 就写进目标、2026-09-13 发现没做。
 *
 *   · 命令行给了 `--install-dir` / `--dsh-home` ⇒ 不问（脚本/自动化里让参数说话）；
 *   · 真终端 ⇒ 各问一句：直接回车用默认值，打 `~/xxx` 也能认；
 *   · 非交互（管道/CI）或 `--yes` ⇒ `ask()` 立刻返回默认值，**绝不挂住**（wizard.mjs 的契约）。
 *
 * 两个目录都不属于"依赖下载"，所以这里只问一次、不再逐项确认；真正会动磁盘的每一步
 * （mkdir / 复制 / 下载 / 写配置）后面仍然各自 `confirm()` 一次。
 */
const expandUserPath = (value) => {
  const raw = String(value).trim().replace(/^"(.*)"$/u, '$1').replace(/^'(.*)'$/u, '$1')
  if (raw === '~') return homeDir
  if (raw.startsWith('~/')) return join(homeDir, raw.slice(2))
  return raw
}
const installDir = installDirArg === null
  ? resolve(expandUserPath(await w.ask('本程序安装到哪个目录？', defaultInstallDirPath)))
  : resolve(installDirArg)
const dshHome = dshHomeArg === null
  ? resolve(expandUserPath(await w.ask('DSH 数据目录（配对钥匙/凭据放这里）？', defaultDshHomePath)))
  : resolve(dshHomeArg)

const layout = resolveLayout({ installDir, dshHome, homeDir, port, platform: process.platform, env: process.env, exists: existsSync })

const step = (n, title) => {
  /*
   * 记住"现在是第几步"，给 `uncaughtException` 兜底用（2026-09-13）。
   * 原来那些直接写盘的调用（applyPluginLinks / applyNativeHostInstall / writeFileSync）
   * 一旦抛异常就是一段裸栈 + 退出码 1，用户看不出"停在哪一步、要不要回滚"。
   */
  currentStepTitle = `第 ${String(n)} 步 · ${title}`
  return w.step(n, title)
}
const run = (cmd, args, opts = {}) => {
  const shown = [cmd, ...args].join(' ')
  w.detail(`$ ${shown}`)
  if (DRY_RUN) return { status: 0, dryRun: true }
  const res = spawnSync(cmd, args, { stdio: 'inherit', env: { ...process.env, DSH_HOME: dshHome }, ...opts })
  return { status: res.status ?? 1 }
}

/**
 * 关键步骤失败就**当场停**。
 *
 * 为什么必须停：第 8 步会把用户的 DSH 指向安装目录里的插件。如果第 3 步的
 * `npm install` 失败了（断网、registry 抽风），安装目录里就没有 `node_modules`，
 * 而一旦挂载写下去，**用户下次重启 DSH 时插件会直接加载失败**（解析不到
 * `@deepseek-ai/dsh-tools`）—— 把"装到一半"变成"原来的也不能用了"。
 * 所以宁可停在这里、由用户重跑，也不许带着坏依赖往下走。
 */
/**
 * 退出码约定（`--help` 里也印一份，自动化调用方可以依赖）：
 *   0 成功 / 2 参数或前置条件不满足（dry-run 有阻断项也是 2）/ 3 中途失败 / 4 关键步骤被用户拒绝 / 130 Ctrl-C
 */
const die = (code) => {
  /*
   * ★ 必须**同步**退出（2026-09-13 实测踩到的坑，`install-behavior` 用例 B 当场咬出来）。
   *
   * 我第一版写成 `process.stdout.write('', () => process.exit(code))`（想"先 flush 再退"）——
   * 但它是**异步**的：调用点后面的代码会在回调之前照常往下跑。于是 dry-run 的提前退出失效，
   * `--yes` 之下真把安装目录创建了出来，正面打掉用户那条「默认只打印…不动真格」的硬约束。
   *
   * 代价（明知）：管道下 stdout 是异步的，`process.exit()` 可能截掉最后几行输出；
   * 真终端（本程序的正常用法）下 stdout 是同步的，不受影响。**正确性优先于完整性**。
   */
  process.exit(code)
}
let currentStepTitle = '（还没开始）'
/*
 * 兜底：任何没被接住的异常/拒绝，都要说清"停在哪一步"，而不是甩一段裸栈给用户。
 * 退出码统一 3（中途失败），与 `must()` 一致。
 */
let dying = false
process.on('uncaughtException', (error) => {
  // 哨兵：处理器自己抛（例如流已关时 w.warn 失败）会**再次进入**同一处理器 ⇒ 死循环
  if (dying) return
  dying = true
  w.warn(`在「${currentStepTitle}」崩了：${String(error?.message ?? error)}`)
  w.warn('已完成的步骤是幂等的；修掉原因后重跑本程序即可。')
  console.error(error)
  die(3)
})
process.on('unhandledRejection', (reason) => {
  if (dying) return
  dying = true
  w.warn(`在「${currentStepTitle}」崩了（未处理的 Promise 拒绝）：${String(reason?.message ?? reason)}`)
  w.warn('已完成的步骤是幂等的；修掉原因后重跑本程序即可。')
  console.error(reason)
  die(3)
})

const must = (res, what) => {
  if (res.status === 0) return true
  w.warn(`${what} 失败（exit ${String(res.status)}）—— 就此停下，不改动你的 DSH 挂载。`)
  w.warn('修好之后重跑本程序即可（已完成的步骤是幂等的，不会重复做坏事）。')
  w.close()
  die(3)
}

/**
 * 把"DSH 里没有、但允许下载"的插件依赖装到**安装目录内的暂存区**，再链进 `dsh-plugin/node_modules`。
 *
 * 为什么不直接 `npm install --prefix <安装目录>/dsh-plugin ws`：npm 会按
 * `dsh-plugin/package.json` 把**整棵树** reify ⇒ 连带装出**第二份** `@deepseek-ai/dsh-tools`，
 * 而那个包在 npm 上的 `latest` 是 `0.0.1-rc.1` 的 stub（见第 3 步上面的注释）——
 * 等于用一个跑不起来的副本顶掉"必须与 DSH 同源"的那一条。
 *
 * 暂存区放在**安装目录里**（不是 /tmp）：重跑与升级时已有就不重复下载。
 * ⚠️ 调用点必须在 `applyPluginLinks()` **之后** —— 它开头就 `rm -rf node_modules`。
 * 本函数只在 apply 路径上可达（见上方 `if (DRY_RUN) { … }` 的提前退出），所以不需要 `DRY_RUN` 分支。
 */
async function linkDownloadablePluginDeps(names) {
  const stage = join(layout.installDir, '.plugin-deps')
  const staged = (name) => join(stage, 'node_modules', name)
  // ★ 判"装过了"要看 **`package.json` 在不在**，不能只看目录（2026-09-13 修，PiMoa 片 B 第 9 条）：
  //   上一次 `npm install` 中途崩掉会留下半截目录，只判目录就会把它当成"已有，不重复下载"。
  const installed = (name) => existsSync(join(staged(name), 'package.json'))
  const needing = names.filter((name) => !installed(name))

  if (needing.length > 0) {
    w.detail(`暂存区：${stage}`)
    if (!(await w.confirm(`DSH 里没有 ${needing.join('、')} —— 现在下载到暂存区？`))) {
      /*
       * ★ 拒答不能静默 `return`（2026-09-13 修，PiMoa 片 B 第 2 条）：`ws` 既没下也没链，
       * 交互式拒绝又**不计入** `autoDeclined`，于是后面第 6.5 步会以 `ERR_MODULE_NOT_FOUND`
       * 失败 —— 用户看到的是一个莫名其妙的"模块找不到"，而不是"你刚才拒绝了下载那一步"。
       * 用显式 `die(2)`（前置条件不满足），不再借道 `must({status:1})` 编一个假的 exit 1。
       */
      w.warn(`你拒绝了下载 ${needing.join('、')} —— 没有它插件加载不起来，就此停下。`)
      w.warn('想继续就重跑本程序并在这一步选 y（或先把包装进你的 DSH）。')
      w.close()
      die(2)
    }
    must(
      run('npm', ['install', '--no-audit', '--no-fund', '--no-save', '--prefix', stage, ...needing]),
      `下载 ${needing.join('、')}`,
    )
  } else {
    w.detail(`复用暂存区里已有的 ${names.join('、')}（不重复下载）`)
  }

  for (const name of names) {
    const linkPath = join(layout.pluginDir, 'node_modules', name)
    w.detail(`链接 ${staged(name)} → ${linkPath}`)
    mkdirSync(dirname(linkPath), { recursive: true })   // 带 scope 的包要先建 @scope/ 目录
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(staged(name), linkPath, 'dir')
  }
}

/* ─────────────────────── 探测事实 → 体检 ─────────────────────── */

let dshPath = which('dsh')
const installedDshVersion = readDshVersion(dshPath)
const targetDshVersion = requestedDshVersion ?? installedDshVersion ?? '0.1.5-rc.2'
const listening = portListening(port)
const pairingKey = readPairingKey(layout.pairingFile)
const ping = listening ? await pingPlugin(port, pairingKey) : { paired: false, reachable: false }

/**
 * 部署**之前**就存在的扩展 ID（从配对文件读）。
 *
 * 这是本程序最重要的一个守卫：扩展 ID 由公钥决定，而用户 Chrome 里**已经装着一个**该 ID 的
 * 扩展。安装过程一旦把 ID 换掉，配对文件的 `extensionOrigins`、native host 清单的
 * `allowed_origins` 就全对不上，**用户原来能用的插件当场失效**
 * （2026-09-12 真踩过：init-key 在安装目录里找不到私钥就生成了一对新密钥）。
 * 有了它，同一类事故再也无法静默通过。
 */
const preExistingExtensionId = (() => {
  if (!existsSync(layout.pairingFile)) return null
  try {
    const origins = JSON.parse(readFileSync(layout.pairingFile, 'utf8'))?.extensionOrigins
    const first = Array.isArray(origins) ? origins[0] : null
    return typeof first === 'string' ? first.replace('chrome-extension://', '') : null
  } catch {
    return null
  }
})()

/**
 * dry-run 里也要显示**真实**扩展 ID。参照系取**源目录**那份 manifest 的公钥 ——
 * 它是项目故意钉死的身份（提交进 git），而安装目录里那份可能已经被上一次失败搞脏。
 */
const pinnedExtensionId = (() => {
  for (const candidate of [join(ROOT, 'extension', 'manifest.json'), join(installDir, 'extension', 'manifest.json')]) {
    if (!existsSync(candidate)) continue
    try {
      const key = JSON.parse(readFileSync(candidate, 'utf8'))?.key
      if (typeof key === 'string' && key !== '') return extensionIdFromKey(key)
    } catch { /* 下一个候选 */ }
  }
  return 'pending-extension-id'
})()

const chromePlan = planNativeHostInstall(layout, { extensionId: pinnedExtensionId, exists: existsSync })
const mount = describeCompanion(existsSync(layout.profilePatch) ? readFileSync(layout.profilePatch, 'utf8') : '', { id: PLUGIN_ID })

const checks = [
  checkNode({ nodeVersion: process.version }),
  checkDshCli({ dshCliPath: dshPath, dshVersion: installedDshVersion, targetDshVersion }),
  checkPort({ port, listening, paired: ping.paired }),
  checkDirectory({ id: 'dsh-home', label: 'DSH 数据目录', path: dshHome, status: dirStatus(dshHome), createHint: `确认能创建 ${dshHome}（引导程序会用 mkdir -p）` }),
  checkDirectory({ id: 'install-dir', label: '安装目录', path: installDir, status: dirStatus(installDir), createHint: '换一个可写的位置：--install-dir <路径>' }),
  checkChrome({ installed: chromePlan.chromeDir !== null && existsSync(dirname(chromePlan.chromeDir)), manifestDir: chromePlan.manifestPath, browser: chromePlan.browser }),
  checkMount({ exists: mount.found, entryPath: mount.entryPath, expectedPath: layout.pluginEntry }),
]
const verdict = summarize(checks)

/* ─────────────────────────── 计划 ─────────────────────────── */

w.info('════════════════════════════════════════════════════════════')
w.info(' DSH Web Companion · 安装引导程序')
w.info('════════════════════════════════════════════════════════════')
w.blank()
w.info(`  安装目录   ${layout.installDir}`)
w.info(`  DSH 数据   ${layout.dshHome}`)
w.info(`  端口       ${String(port)}`)
w.info(`  DSH 版本   ${targetDshVersion}${installedDshVersion !== null && installedDshVersion !== targetDshVersion ? `（已装 ${installedDshVersion}）` : ''}`)
w.info(`  模式       ${DRY_RUN ? '🔎 dry-run —— 只打印计划，不动任何文件（真装请加 --apply）' : '✍️  apply —— 会真的改动文件（每一步都会问你）'}`)
w.blank()
w.info(' 依赖体检')
for (const line of renderChecks(checks)) w.info(`  ${line}`)
w.blank()

if (verdict.blockers.length > 0) {
  w.warn(`有 ${String(verdict.blockers.length)} 项阻断，先解决它们再装：`)
  for (const b of verdict.blockers) w.info(`   · ${b.label}：${b.fix ?? b.detail}`)
  w.blank()
}

w.info(' 将要写入 / 改动的东西')
w.info(`   ① 创建安装目录      ${layout.installDir}`)
w.info(`   ② 复制源码          ${String(installPayload().length)} 项（不含 node_modules、不含 dist —— 发行包保持轻）`)
w.info(`   ③ 准备 DSH          ${dshPath === null ? `**缺** ⇒ 将安装 @deepseek-ai/dsh@${targetDshVersion}（钉版本，不用 latest）` : `已装，跳过（${dshPath}）`}`)
w.info(`      接上插件依赖      ${layout.pluginDir}/node_modules → 你的 DSH（优先链接、版本自动一致；DSH 里真缺了才下载 ws）`)
w.info(`   ④ 准备 esbuild      ${join(layout.installDir, 'extension')}（只有它要下载，约 11MB）`)
w.info(`   ⑤ 生成配对钥匙      ${layout.pairingFile}（幂等：已存在则复用，不轮换）`)
w.info(`   ⑥ 构建扩展产物      ${layout.extensionDist}（端口=${String(port)}）`)
for (const line of describeNativeHostPlan(chromePlan)) w.info(`   ⑦ ${line}`)
w.info(`   ⑧ 挂载插件          ${layout.profilePatch}（先备份；只改我们那一条）`)
{
  // 让 dry-run 就能看清"要写什么 config"——新装/老装的差别在这里最容易出错
  const planned = buildMountConfig({ freshInstall: mount.found !== true, approvalForWriteOps, extra: extraConfig })
  const kind = mount.found === true ? '已有安装（不写 attachDir，沿用原目录名）' : '新装（写 attachDir=captures）'
  w.info(`      · ${kind}；config = ${Object.keys(planned).length === 0 ? '（无）' : JSON.stringify(planned)}`)
}
w.info(`   ⑨ 写入 API key      ${layout.credentialsFile}（先备份；只改 refs.${DEEPSEEK_KEY_REF}）`)
w.info(`   ⑩ Chrome 里加载扩展 ${layout.extensionDist}（你手动点，程序会告诉你点哪里）`)
w.blank()

if (DRY_RUN) {
  w.info('（dry-run 结束。确认无误后加 --apply 真装。）')
  w.close()
  die(verdict.blockers.length > 0 ? 2 : 0)
}

/* ─────────────────────────── 执行 ─────────────────────────── */

if (verdict.blockers.length > 0 && !ASSUME_YES) {
  const go = await w.confirm('仍有阻断项，仍要继续吗？（不推荐）')
  if (!go) { w.close(); die(4) }
}

/** 第 8 步被拒 ⇒ 插件不会被 DSH 加载，收尾时必须如实标成"没装成"（2026-09-13）。 */
let mountSkipped = false

step(1, `创建安装目录 ${layout.installDir}`)
if (await w.confirm('创建这个目录？')) {
  mkdirSync(layout.installDir, { recursive: true })
} else {
  w.warn('用户拒绝创建目录 —— 无法继续。')
  w.close()
  die(4)
}

step(2, '复制源码（依赖不复制，稍后下载）')
{
  const items = installPayload()
  for (const rel of items) w.detail(`${rel} → ${join(layout.installDir, rel)}`)
  if (await w.confirm(`复制以上 ${String(items.length)} 项？`)) {
    for (const rel of items) {
      const src = join(ROOT, rel)
      if (!existsSync(src)) { w.warn(`清单里有但磁盘上没有，跳过：${rel}`); continue }
      const dest = join(layout.installDir, rel)
      /*
       * ★ 先删再拷（= 替换，而不是"盖上去"）。
       * 为什么必须这样（2026-09-13 实测踩到）：升级已有安装时，源里**删掉**的文件
       * 会留在安装目录里 —— 英文版把 `extension/_locales/zh_CN` 删了，可按老办法拷贝之后
       * 它仍待在安装目录，Chrome 照样会在中文界面下挑到中文，`永远英文` 这个定位当场失效。
       * 逐条替换每个 payload 项即可根除这一类"陈旧残留"。
       */
      rmSync(dest, { recursive: true, force: true })
      mkdirSync(dirname(dest), { recursive: true })
      cpSync(src, dest, {
        recursive: true,
        filter: (s) => installPayloadFilter(relative(ROOT, s).split(sep).join('/')),
      })
    }
  }
}

step(3, '准备 DSH 与插件依赖（DSH 缺了才装；插件依赖链接过去，不下载）')
{
  /*
   * ★ 第一步：**DSH 本身缺了就装**。
   *
   * 这一条是给"全新机器"补的（用户要在一台远端 Mac 上从 GitHub 下载后实测）：
   * 之前本安装器只做"链接到**已装**的 DSH"，在那台机器上会直接卡住 ——
   * `findDshRoot()` 拿不到 DSH 根 ⇒ 依赖链不上 ⇒ 第 6.5 步自检失败。
   *
   * 版本**必须钉死**：实测 `@deepseek-ai/dsh-tools` 的 npm `latest` 是 `0.0.1-rc.1` 这个 stub，
   * 用 latest 会装出一个跑不起来的东西。默认钉我们验证过的那个版本。
   */
  if (dshPath === null) {
    w.warn(`PATH 里没有 \`dsh\` —— 需要安装 @deepseek-ai/dsh@${targetDshVersion}`)
    w.info('   （为什么钉版本：`@deepseek-ai/dsh-tools` 的 npm `latest` 实测是 0.0.1-rc.1 的 stub）')
    if (await w.confirm(`现在用 npm 全局安装 @deepseek-ai/dsh@${targetDshVersion}？`)) {
      must(run('npm', ['install', '-g', `@deepseek-ai/dsh@${targetDshVersion}`]), '安装 DSH')
      // 装完重新定位：全局 bin 可能不在当前 PATH 上，退一步用 `npm prefix -g` 拼出来
      dshPath = which('dsh')
      if (dshPath === null && !DRY_RUN) {
        try {
          const prefix = execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim()
          const candidate = join(prefix, 'bin', 'dsh')
          if (existsSync(candidate)) {
            dshPath = candidate
            w.warn(`\`dsh\` 还不在 PATH 上；已直接使用 ${candidate}`)
            w.warn(`建议把这一行加进你的 shell 配置：export PATH="${join(prefix, 'bin')}:$PATH"`)
          }
        } catch { /* 下面统一报错 */ }
      }
      if (dshPath === null) {
        w.warn('装完了但找不到 `dsh` 可执行文件 —— 请把 npm 全局 bin 目录加进 PATH 后重跑本程序。')
        w.close()
        die(3)
      }
      w.info(`   ✅ DSH 可用：${dshPath}`)
    } else {
      w.warn('未安装 DSH。后面的依赖链接与自检会失败 —— 建议先装完再重跑。')
      /*
       * ★ 当场停下（2026-09-13 修，PiMoa 片 1 第 16 条）：没有 DSH 就没有"同源子包"，
       * 第 4/5/6 步会白下载约 11MB、白构建一次，最后到第 6.5 步才以模块找不到失败。
       */
      w.warn('就此停下。注意：安装目录在第 1/2 步**已经创建/覆盖过了**，只是依赖不完整 ⇒ 插件现在跑不起来；')
      w.warn('把 DSH 装好之后重跑本程序即可补齐（已完成的步骤是幂等的）。')
      w.close()
      die(2)
    }
  } else {
    w.detail(`DSH 已装：${dshPath}${installedDshVersion === null ? '' : ` (${installedDshVersion})`} —— 跳过安装`)
  }

  const dshRoot = findDshRoot(dshPath)
  if (dshRoot === null) {
    w.warn('定位不到已安装的 DSH 包根目录 —— 无法链接依赖。先确认 `dsh` 可用。')
  } else {
    const plan = planPluginLinks({ dshRoot, pluginDir: layout.pluginDir, exists: existsSync })
    w.detail(`DSH 安装根：${dshRoot}`)
    w.detail('插件跑在 DSH 进程里，所以直接用它自己那份子包 —— 版本永远一致、不用下载：')
    for (const line of describePluginLinks(plan)) w.detail(`  ${line}`)
    /*
     * DSH 里缺包时的兜底（2026-09-13）。
     *
     * 此前这里只 `warn` 一句就继续 ⇒ 要等第 6.5 步导入自检才以"模块找不到"失败，而那时
     * 已经写了一堆文件。现在按"这个包能不能下载"分两路，判据在
     * `classifyMissingPluginDeps()`（纯函数 + 单测）：能下载的（`ws`）下载到暂存区，
     * 必须与 DSH 同源的（两个 `@deepseek-ai/*`）**当场停下**（dry-run 时只警告，见下）。
     */
    const gaps = classifyMissingPluginDeps(plan)
    if (gaps.fatal.length > 0) {
      w.warn(`DSH 里缺 ${gaps.fatal.join('、')} —— 这三个包正常随 DSH 一起来。`)
      w.warn('它们是 DSH 自己的子包，插件必须与 DSH 用同一份；下载第二份会变成两个模块实例，所以这里不下载。')
      w.warn('先把 DSH 装好（例如重装 `@deepseek-ai/dsh`）再重跑本程序。')
      must({ status: 1 }, `插件依赖检查（缺 ${gaps.fatal.join('、')}）`)
    }
    if (await w.confirm('建立这些链接？')) {
      const made = applyPluginLinks({ pluginDir: layout.pluginDir, plan })
      w.info(`   ✅ 链接了 ${String(made.length)} 个包`)
    }
    /*
     * ★ 可下载依赖的处理放在**这个 confirm 之外**（2026-09-13 修；PiMoa 片 A 第 3 条）：
     * 原来它嵌在"建立这些链接？"里面 ⇒ 用户拒绝建链接时，缺 `ws` 这件事被整段跳过，
     * 而隔壁 fatal 分支却在 confirm **之前**就硬失败 —— 两条路的守卫位置不对称。
     * 注意顺序：`applyPluginLinks()` 开头会 `rm -rf node_modules`，所以这一段必须在它之后。
     */
    if (gaps.downloadable.length > 0) await linkDownloadablePluginDeps(gaps.downloadable)
  }
}

step(4, '准备扩展构建依赖（esbuild —— 这一个要下载）')
{
  // 本机如果已经有（开发机的 extension/node_modules），直接链接，省一次下载。
  const localEsbuild = join(ROOT, 'extension', 'node_modules', 'esbuild')
  const targetDir = join(layout.installDir, 'extension', 'node_modules')
  /*
   * esbuild 的版本范围从 `extension/package.json` 读 —— **单一真源**（2026-09-13 修，PiMoa 片 1 第 12 条）。
   * 此前这里另写死一份 `esbuild@^0.25.0`，与 `extension/package.json` 的声明**只是碰巧一致**；
   * 将来改一处就会漂（构建脚本用 A、引导程序下载 B）。
   */
  const esbuildRange = (() => {
    const readRange = (file) => {
      try {
        return JSON.parse(readFileSync(file, 'utf8')).devDependencies?.esbuild ?? null
      } catch { return null }
    }
    // ★ 优先读**安装目录里**那份；第 2 步被拒时它还不存在 ⇒ 退回读仓库里那份
    //   （2026-09-13 修，PiMoa 片 B 第 10 条：原来只读安装目录那份，"单一真源"只做了一半）。
    return readRange(join(layout.installDir, 'extension', 'package.json'))
      ?? readRange(join(ROOT, 'extension', 'package.json'))
      ?? '^0.25.0'
  })()
  if (existsSync(localEsbuild) && resolve(localEsbuild) !== resolve(join(targetDir, 'esbuild'))) {
    w.detail(`复用本机已有的 esbuild：${localEsbuild}`)
    if (await w.confirm('链接它（不下载）？')) {
      rmSync(targetDir, { recursive: true, force: true })
      mkdirSync(targetDir, { recursive: true })
      symlinkSync(localEsbuild, join(targetDir, 'esbuild'), 'dir')
      const scope = join(dirname(localEsbuild), '@esbuild')
      if (existsSync(scope)) symlinkSync(scope, join(targetDir, '@esbuild'), 'dir')
    }
  } else if (await w.confirm('现在下载 esbuild（约 11MB，只有扩展构建需要它）？')) {
    must(run('npm', ['install', '--no-audit', '--no-fund', '--no-save', '--prefix', join(layout.installDir, 'extension'), `esbuild@${esbuildRange}`]), '下载 esbuild')
  }
}

step(5, '生成配对钥匙（幂等，不轮换已有 key）')
if (await w.confirm('生成/复用配对钥匙？')) {
  // 先备份：init-key 会重写配对文件（幂等，但用户可能想回滚）
  if (!DRY_RUN && existsSync(layout.pairingFile)) {
    /*
     * ★ **首份原件只备份一次**（2026-09-13 修；PiMoa 片 2 第 3 条）：备份名是固定的，
     * 每次 `copyFileSync` 都覆盖 ⇒ 跑第二遍就把"原始状态"换成了"已被我们改过的状态"，
     * 那句回滚提示 `cp … .bak-before-install …` 就回不到原点了。
     */
    if (!existsSync(`${layout.pairingFile}.bak-before-install`)) {
      copyFileSync(layout.pairingFile, `${layout.pairingFile}.bak-before-install`)
      w.detail(`已备份配对文件 → ${layout.pairingFile}.bak-before-install`)
    } else {
      w.detail(`保留首份备份（不覆盖）→ ${layout.pairingFile}.bak-before-install`)
    }
  }
  must(run(process.execPath, [join(layout.installDir, 'scripts', 'init-key.mjs'), '--home', dshHome, '--port', String(port)]), '生成配对钥匙')

  /*
   * ★ 守卫：扩展 ID 不许变。
   * 变了就意味着 Chrome 里那个扩展、配对文件、native host 清单三者会互相不认。
   */
  if (!DRY_RUN) {
    let afterId = null
    try {
      const key = JSON.parse(readFileSync(join(layout.installDir, 'extension', 'manifest.json'), 'utf8'))?.key
      afterId = typeof key === 'string' && key !== '' ? extensionIdFromKey(key) : null
    } catch { /* 下面按 null 处理 */ }
    if (preExistingExtensionId !== null && afterId !== preExistingExtensionId) {
      w.warn(`扩展 ID 被改掉了：原 ${preExistingExtensionId} → 现 ${String(afterId)}`)
      w.warn('这会让 Chrome 里已装的扩展与配对文件／native host 清单全部对不上（2026-09-12 踩过的真实回归）。')
      w.warn(`已停止。可回滚配对文件：cp ${layout.pairingFile}.bak-before-install ${layout.pairingFile}`)
      w.close()
      die(3)
    }
    w.info(`   ✅ 扩展 ID 未变（${String(afterId)}）`)
  }
}

step(6, '构建扩展产物（把真实端口烤进去）')
if (await w.confirm(`构建 ${layout.extensionDist}？`)) {
  must(run(process.execPath, [join(layout.installDir, 'extension', 'build.mjs')]), '构建扩展产物')
  must(run(process.execPath, [join(layout.installDir, 'scripts', 'check-dist-config.mjs')]), '产物端口自证')
}

/*
 * 挂载之前先自证"装出来的插件真的能加载"——解析不到依赖就别去改用户的 DSH。
 * 只 import 不 apply：顶层 import 能把 `@deepseek-ai/dsh-tools` 解析成功就说明依赖齐了。
 */
step(6.5, '自证：安装目录里的插件能解析依赖')
if (!DRY_RUN) {
  const probeImport = spawnSync(process.execPath, ['--input-type=module', '-e',
    `await import(${JSON.stringify(join(layout.installDir, 'dsh-plugin', 'src', 'host', 'index.js'))}); console.log('plugin-import-ok')`,
  ], { encoding: 'utf8' })
  if (probeImport.status === 0 && probeImport.stdout.includes('plugin-import-ok')) {
    w.info('   ✅ 插件可加载（依赖解析成功）')
  } else {
    w.warn(`插件加载失败，**不改动你的 DSH 挂载**：${(probeImport.stderr ?? '').split('\n').slice(0, 4).join(' / ')}`)
    w.warn('多半是第 3 步的依赖没装全。修好后重跑本程序。')
    w.close()
    die(3)
  }
}

step(7, '安装 native messaging host')
{
  const manifestSrc = existsSync(join(layout.installDir, 'extension', 'manifest.json'))
    ? JSON.parse(readFileSync(join(layout.installDir, 'extension', 'manifest.json'), 'utf8'))
    : null
  const extId = manifestSrc?.key ? extensionIdFromKey(manifestSrc.key) : null
  if (extId === null) {
    w.warn('读不到扩展公钥，跳过 native host 安装（先完成第 5 步生成配对）')
  } else {
    const plan = planNativeHostInstall({ ...layout, homeDir }, { extensionId: extId, nodePath: process.execPath, exists: existsSync })
    for (const line of describeNativeHostPlan(plan)) w.detail(line)
    if (await w.confirm('写入 native host 清单与拉起器？')) applyNativeHostInstall(plan)
  }
}

step(8, '把插件挂到 DSH profile（幂等，先备份）')
{
  const before = existsSync(layout.profilePatch) ? readFileSync(layout.profilePatch, 'utf8') : ''
  const mountBefore = describeCompanion(before, { id: PLUGIN_ID })
  /*
   * 新装 vs 老装决定 config：新装写英文目录名，老装**不写** attachDir
   * （于是沿用插件默认的中文目录名，历史 @网页捕获/… 引用不失效）。
   */
  const config = buildMountConfig({
    freshInstall: mountBefore.found !== true,
    approvalForWriteOps,
    extra: extraConfig,
  })
  const next = upsertCompanion(before, { id: PLUGIN_ID, entryPath: layout.pluginEntry, config })
  w.detail(`挂载路径：${layout.pluginEntry}`)
  w.detail(mountBefore.found === true ? '这是**已有**安装：不写 attachDir（沿用原目录名，历史引用不失效）' : '这是**新装**：写 attachDir=captures（英文目录名）')
  w.detail(`要写的 config：${Object.keys(config).length === 0 ? '（无）' : JSON.stringify(config)}`)
  /*
   * ★ 把 `preserved` 消费掉（2026-09-13；PiMoa 片 B 第 7 条）。
   * `upsertCompanion()` 现在会**自动保留**上一轮写进 profile、本轮没显式传的 config 键，
   * 并把它们报在 `preserved` 里。返回值没人读就是死接线 —— 而且用户看不到"你的设置被保住了"。
   */
  if (next.preserved.length > 0) {
    w.info(`   💡 保留了原有 config 键：${next.preserved.join('、')}（本次没传，按你原来的设置不动）`)
  }
  w.detail(next.action === 'unchanged' ? '内容已是目标状态（无需改动）' : `动作：${next.action}`)
  w.detail(`备份到：${layout.profilePatch}.bak-before-companion`)
  if (Object.keys(config).length === 0 && mountBefore.found === true) {
    w.info('   💡 本程序只写它自己管理的键（attachDir / approvalForWriteOps）。')
    /*
     * ★ 文案必须与行为一致（2026-09-13；PiMoa 片 B 第 7 条）：代码现在**会**自动保留旧键，
     * 原文却写"它不会自己去猜、请用 --set 显式带上" —— 叫用户做多余的事，还错描述了行为。
     */
    w.info('      你在 profile 里已有的其它键（例如 approvalForWriteOps: false）会被**原样保留**，不需要重新传。')
    w.info('      想改哪个键才用 `--approval-for-write-ops false` 或 `--set key=value` 显式覆盖。')
  }
  if (await w.confirm('写入这一行挂载？')) {
    // ★ 首份原件只备份一次（2026-09-13 修；见配对文件那处注释）
    if (existsSync(layout.profilePatch) && !existsSync(`${layout.profilePatch}.bak-before-companion`)) copyFileSync(layout.profilePatch, `${layout.profilePatch}.bak-before-companion`)
    mkdirSync(dirname(layout.profilePatch), { recursive: true })
    writeFileSync(layout.profilePatch, next.text)
  } else {
    /*
     * ★ 拒绝写挂载 = **插件不会被 DSH 加载 = 等于没装**（2026-09-13 修，PiMoa 片 1 第 6 条）。
     * 原来这里静默跳过，接着照样走完第 9/10/11 步并打印收尾横幅，用户会以为装好了。
     */
    mountSkipped = true
    w.warn('已跳过挂载 —— DSH 不会加载本插件，**等于没装**（收尾横幅会如实标出来）。')
  }
}

step(9, `写入 DeepSeek API key（${DEEPSEEK_KEY_REF}）`)
{
  const credentialsText = existsSync(layout.credentialsFile) ? readFileSync(layout.credentialsFile, 'utf8') : ''
  const current = readRef(credentialsText, DEEPSEEK_KEY_REF)
  w.info('   ')
  w.info('   怎么申请 API key：')
  w.info('     1. 打开 https://platform.deepseek.com/ 注册/登录')
  w.info('     2. 左侧「API keys」→「Create new API key」')
  w.info('     3. 复制那串 sk- 开头的字符串（**只显示一次**，请立刻粘贴到下面）')
  w.info('   ')
  w.detail(`写入位置：${layout.credentialsFile} 的 refs.${DEEPSEEK_KEY_REF}`)
  w.detail(`已存在同名 key：${current === null ? '否' : '是（留空则保留原值）'}`)
  w.detail(`备份到：${layout.credentialsFile}.bak-before-apikey`)
  w.detail('**只改这一行**：别的 key 与 client-connection/browser-session 记录逐字节不动')
  const key = await w.secret('粘贴 API key（留空跳过）:')
  if (key === '') {
    w.info('   已跳过（稍后可以重跑这一步，或直接在 DSH 界面里设置）')
  } else if (await w.confirm('把 key 写进凭据文件？')) {
    // ★ 首份原件只备份一次（2026-09-13 修；见配对文件那处注释）
    if (existsSync(layout.credentialsFile) && !existsSync(`${layout.credentialsFile}.bak-before-apikey`)) copyFileSync(layout.credentialsFile, `${layout.credentialsFile}.bak-before-apikey`)
    const res = upsertRef(credentialsText, DEEPSEEK_KEY_REF, key)
    mkdirSync(dirname(layout.credentialsFile), { recursive: true })
    writeFileSync(layout.credentialsFile, res.text, { mode: 0o600 })
  }
}

/* ───────────────── 用户手动装扩展 → 回来复检 ───────────────── */

step(10, '在 Chrome 里加载扩展（这一步只能你手动做）')
w.info('   1. 地址栏输入：chrome://extensions')
w.info('   2. 右上角打开「开发者模式」')
w.info('   3. 点「加载已解压的扩展程序」')
w.info(`   4. 选择这个目录：${layout.extensionDist}`)
w.info('   5. 装好后点浏览器工具栏的图标打开侧边栏')
w.info('（本程序查不到"扩展装没装"，只能查它有没有连上来 —— 所以这一步由你确认。）')

const waited = await w.pause('装完了吗？')
/*
 * ★ 复检**不再被 `waited` gate 住**（2026-09-13 修；PiMoa 片 1 第 2 条与片 3 第 6 条**各自独立**
 * 查出同一处）。原来 `if (waited) { ...probeHealth... }`：非交互（管道/CI）时 `w.pause()` 直接
 * 返回 false ⇒ **一次健康检查都没跑**，最后却 `exit 0` —— "CI 报成功但从没验过"。
 * `probeHealth()` 是只读的（ping 本机端口 + 跑 check-dist-config），随时可以跑，不该由 pause 把关。
 */
step(11, waited ? '复检：本插件应答 / 配对 / 产物端口 / 扩展连通（代理判据）' : '复检（非交互：跳过等待，直接查一遍）')

const probeOnce = () => probeHealth({ port, dshHome, installDir: layout.installDir })

let health = await probeOnce()
for (const line of renderHealth(health)) w.info(`   ${line}`)

/*
 * 「扩展连通」是**软判据**（代理：侧边栏一开，iframe 里的 DSH 页面半就会连上）。
 * 只有**人在终端前**时才给重试机会 —— 非交互时问也白问（`confirm()` 直接返回 false）。
 */
if (w.interactive) {
  const proxyItem = () => health.find((i) => i.id === 'extension-proxy')
  for (let attempt = 0; attempt < 3 && proxyItem()?.ok !== true; attempt += 1) {
    const retry = await w.confirm('打开侧边栏后再查一次？（本程序看不到扩展装没装，只能看它有没有连上来）')
    if (!retry) break
    health = await probeOnce()
    for (const line of renderHealth(health)) w.info(`   ${line}`)
  }
}

w.blank()
w.info('════════════════════════════════════════════════════════════')
/*
 * `finishBanner()` 负责把三种"不能算成功"的情形说清楚（都在 `health.mjs` 里、有单测）：
 *   · 空数组 = **没查**（与"查了没过"分开，别谎报）；
 *   · 挂载被跳过 = 等于没装；
 *   · 非交互下 `confirm()` 全按否 = 什么都没装。
 */
const banner = finishBanner(health, { mountSkipped, autoDeclined: w.autoDeclined })
w.info(banner.text)
for (const item of banner.softFailed) {
  w.info(item.id === 'extension-proxy'
    ? ' 💡 「扩展连通」是软判据：打开侧边栏后它会变 ✅ —— 那才是"扩展真的连上来了"的证据'
    : ` ⚠️ 软判据没过（不阻断安装）：${item.label}`)
}
w.info('════════════════════════════════════════════════════════════')
w.info(` 自查：node ${join(layout.installDir, 'bootstrap', 'doctor.mjs')}`)
w.info(` 卸载：node ${join(layout.installDir, 'bootstrap', 'uninstall.mjs')}`)
w.info(' 试试：打开侧边栏，在输入框写「看左边」')
w.blank()
w.close()
/*
 * ★ 退出码要分清"装坏了"与"装好了但还没跑起来"（2026-09-13 修；PiMoa 片 A 第 14 条 / 片 C 第 3 条）。
 *
 * 复检不再被 `pause()` gate 之后，**全新安装**必然复检不过（挂载刚写进 profile，而 DSH 是启动时
 * 读那份配置的 ⇒ 插件要等 DSH 重启才会应答）。原来一律退 3（"中途失败"），于是**一次正确的安装
 * 稳定给自动化一个红灯** —— 那是把旧的假绿换成了新的假红。现在：
 *   0 = 复检全过 / 4 = 用户拒绝了关键步骤（或非交互全按否）/ 5 = 步骤跑完但复检没过 / 3 = 中途失败
 */
const exitCode = banner.ok ? 0 : (mountSkipped || w.autoDeclined > 0 ? 4 : 5)
if (exitCode === 5 && health.length > 0) {
  w.info(' 💡 步骤都跑完了。若这是**首次安装**，DSH 还没重启 ⇒ 插件尚未加载，复检当然不过：')
  w.info('    重启 DSH（dsh web）后再跑一次 `node <安装目录>/bootstrap/doctor.mjs` 即可复验。')
}
die(exitCode)
