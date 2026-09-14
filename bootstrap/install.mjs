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
import { PLUGIN_RUNTIME_DEPS, applyPluginLinks, describePluginLinks, findDshRoot, missingPluginDeps, planPluginLinks } from './lib/dsh-root.mjs'
import { extensionIdFromKey } from './lib/extension-id.mjs'
import { checkChrome, checkDirectory, checkDshCli, checkEsbuild, checkMount, checkNode, checkPluginDeps, checkPort, renderChecks, summarize } from './lib/checks.mjs'
import { dirStatus, dshVersion as readDshVersion, findDshCandidates, pingPlugin, portListening, readPairingKey } from './lib/probe.mjs'
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

★ 本程序**不下载、不安装任何依赖**（不装 DSH、不装 esbuild、不装任何 npm 包）：
  它只体检 + 告诉你"缺什么、装到哪、跑哪条命令"。缺关键依赖时**一个文件都不会写**。

可选：
  --dsh <路径>          你的 dsh 可执行文件（源码安装 / 自定路径时点给我们；不给就查 PATH 与常见位置）
  --install-dir <路径>   安装到哪（默认：**你运行它的这个文件夹**；不给就会问你一次，直接回车即可）
  --dsh-home <路径>      DSH 数据目录（默认 $DSH_HOME 或 ${join(homedir(), '.dsh')}；**不给就会问你一次**）
  --port <端口>          DSH 端口（默认 ${String(DEFAULT_PORT)}）
  --dsh-version <版本>   报告里建议你装的 DSH 版本（默认你已装的那个或我们验证过的那个；**不要用 latest**）

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
/*
 * ★ 缺省安装目录 = **你解压出来的这个文件夹本身**（用户 2026-09-13 明确要求：
 * 「我解压在哪个目录, 程序就应该缺省安装在哪个目录, 不要你自己设置一个目录」）。
 * 命令行给了 --install-dir 仍然优先；没给时下面会问你一次，默认值就是这个。
 */
const defaultInstallDirPath = ROOT
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
  // 哨兵：处理器自己抛（例如流已关时 w.warn 失败）会**再次进入**同一处理器。
  // ★ 二次进入**必须退出**，不能 `return`（2026-09-13 修；PiMoa 片 6b 第 6 条）：
  //   原来 `return` 会把二次抛吞掉，进程带着坏状态继续跑 —— 比它要修的死循环更难察觉。
  if (dying) process.exit(3)
  dying = true
  w.warn(`在「${currentStepTitle}」崩了：${String(error?.message ?? error)}`)
  w.warn('已完成的步骤是幂等的；修掉原因后重跑本程序即可。')
  console.error(error)
  die(3)
})
process.on('unhandledRejection', (reason) => {
  if (dying) process.exit(3)
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

/*
 * ★ 2026-09-13 删除 `linkDownloadablePluginDeps()`（原来会把 `ws` 下到
 * `<安装目录>/.plugin-deps` 再链进插件）：用户实测后定调「我们用代码去检查依赖, 然后去下载,
 * 看起来聪明, 很可能不对」—— 缺依赖现在只进"依赖报告"，命令交给用户自己跑（见 `checkPluginDeps()`）。
 */
/* ─────────────────────── 探测事实 → 体检 ─────────────────────── */

/*
 * ★ DSH 定位：**多源**，而且把"我找到了什么"如实打印出来。
 *
 * 2026-09-13 用户实测否掉旧做法（只 `command -v dsh`）：他机器上有一份源码树
 * （`/Volumes/Ex/ai_workspace/deepseek-harness`：没有 node_modules、根包名是
 * `@deepseek-ai/dsh-root`），旧探测一个字都没提，然后引导程序还要自己 `npm i -g` 再装一份 ——
 * 机器上会同时存在两份 DSH，用户不知道哪个在跑。
 * 现在：`--dsh <路径>` 点名 → PATH → npm 全局前缀与常见位置；候选全部打印。
 */
const probeDsh = (npmPrefix) => findDshCandidates({ homeDir, exists: existsSync, npmPrefix, argv })
let dshCandidates = probeDsh(null)
if (dshCandidates.length === 0) {
  /*
   * ★ **惰性**探测 npm 全局前缀（2026-09-13 自测发现）：`npm prefix -g` 会顺手创建
   * `$HOME/.npm`（连 HOME 本身都会建出来）。PATH 上已经有 `dsh` 时没必要付这个代价 ——
   * 只有前面所有来源都没找到时才去问 npm，让"正常路径"不产生任何副作用。
   */
  const prefix = (() => {
    try { return execFileSync('npm', ['prefix', '-g'], { encoding: 'utf8' }).trim() } catch { return null }
  })()
  if (prefix !== null && prefix !== '') dshCandidates = probeDsh(prefix)
}
/*
 * ★ 采用"**第一个存在的**候选"，不是"第一个候选"（2026-09-13 PiMoa 复核 MAJOR-M1，已实测）：
 * 原来 `candidates[0]` 会被一个打错的 `--dsh` 路径短路 —— PATH 上明明有一个能用的 DSH，
 * 却因为点名点错而报"没找到"，整轮被阻断。点错要说清，但不该丢掉已经找到的那个。
 */
const namedDsh = dshCandidates.find((c) => c.named === true) ?? null
const namedDshMissing = namedDsh !== null && !existsSync(namedDsh.path)
const chosenDsh = dshCandidates.find((c) => existsSync(c.path)) ?? null
const dshPath = chosenDsh === null ? null : chosenDsh.path
const installedDshVersion = readDshVersion(dshPath)
const targetDshVersion = requestedDshVersion ?? installedDshVersion ?? '0.1.5-rc.2'
const dshRoot = findDshRoot(dshPath)
const linkPlan = dshRoot === null ? [] : planPluginLinks({ dshRoot, pluginDir: layout.pluginDir, exists: existsSync })
const missingDeps = missingPluginDeps(linkPlan)
/**
 * esbuild：**安装目录里那份**（上次装过）或**本包里那份**（开发机 / 原地安装）都算就绪。
 * 从 2026-09-13 起我们不再下载它，缺了只报告命令。
 */
const esbuildTarget = join(layout.installDir, 'extension', 'node_modules', 'esbuild')
const esbuildReady = [esbuildTarget, join(ROOT, 'extension', 'node_modules', 'esbuild')].find((x) => existsSync(x)) ?? null
/**
 * esbuild 版本范围的**单一真源**：构建脚本用哪个版本，报告里的命令就写哪个版本。
 * （原来这段在"第 4 步"内部；现在报告要在计划阶段就用它，所以提到这里。
 *   优先读**安装目录**里那份 package.json —— 第 2 步被拒时它还不存在，退回读包里那份。）
 */
const esbuildRange = (() => {
  const readRange = (file) => {
    try {
      return JSON.parse(readFileSync(file, 'utf8')).devDependencies?.esbuild ?? null
    } catch { return null }
  }
  return readRange(join(layout.installDir, 'extension', 'package.json'))
    ?? readRange(join(ROOT, 'extension', 'package.json'))
    ?? '^0.25.0'
})()
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
  checkDshCli({ dshCliPath: dshPath, dshVersion: installedDshVersion, targetDshVersion, dshCliExists: dshPath === null ? true : existsSync(dshPath) }),
  checkPluginDeps({ names: PLUGIN_RUNTIME_DEPS, missing: missingDeps, dshRoot }),
  /*
   * ★ 命令里的 `--prefix` 指向**包内**的 extension（2026-09-13 PiMoa 复核 MINOR）：
   * 安装目录在第 2 步之前可能还不存在，照旧命令跑会失败；包内那份一定在。装到包内之后，
   * 第 4 步会把它链接进安装目录（链接 ≠ 下载），与 README 里写的路径也一致了。
   */
  checkEsbuild({ path: esbuildReady, command: `npm install --prefix "${join(ROOT, 'extension')}" esbuild@${esbuildRange}` }),
  checkPort({ port, listening, paired: ping.paired }),
  checkDirectory({ id: 'dsh-home', label: 'DSH 数据目录', path: dshHome, status: dirStatus(dshHome), createHint: `确认能创建 ${dshHome}（引导程序会用 mkdir -p）` }),
  checkDirectory({ id: 'install-dir', label: '安装目录', path: installDir, status: dirStatus(installDir), createHint: '换一个可写的位置：--install-dir <路径>' }),
  checkChrome({ installed: chromePlan.chromeDir !== null && existsSync(dirname(chromePlan.chromeDir)), manifestDir: chromePlan.manifestPath, browser: chromePlan.browser }),
  checkMount({ exists: mount.found, entryPath: mount.entryPath, expectedPath: layout.pluginEntry }),
]
const verdict = summarize(checks)

/*
 * ★ 安装目录 == 本目录 ⇒ **原地安装**：源码已在位，不复制、更不删除。
 * 放在"计划"之前，好让 dry-run 就能如实显示会/不会做什么（也便于回归测试观察这个分支）。
 *
 * 为什么必须有这个分支：原来的复制是"先 rm -rf 目标、再 cp 源码过去"，源与目标同路径时
 * 它会**先删掉源码**、再从已删掉的路径复制 —— 直接毁掉用户解压出来的包。缺省安装目录改成
 * ROOT 之后这条成了常规路径，所以它是**安全前提**，不是可选优化。
 */
const inPlace = resolve(layout.installDir) === resolve(ROOT)

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

/*
 * ★ 依赖报告（2026-09-13 用户定调）：引导程序**不下载、不安装任何依赖** ——
 * 只说清"缺什么、装到哪、跑哪条命令"。这两条判据的 command 就是要复制的那条命令。
 */
const depChecks = checks.filter((c) => c.id === 'dsh' || c.id === 'plugin-deps' || c.id === 'esbuild')
const depBlockers = depChecks.filter((c) => c.status === 'missing')
w.info(' 依赖怎么装（本程序不下载、不安装任何依赖；下面是可直接复制的命令）')
for (const line of renderChecks(depChecks)) w.info(`  ${line}`)
for (const c of depChecks) {
  if (c.status !== 'ok' && typeof c.command === 'string') w.info(`     $ ${c.command}`)
}
if (dshCandidates.length > 0) {
  // ★ 候选**全部**打印（2026-09-13 PiMoa 复核 MAJOR-M1）：注释一直宣称"找到了什么都会说"，
  //   而报告只打过选用那一个 —— 用户没法判断我们是不是看漏了他那份安装。
  w.info('   · 找到的 dsh（按优先级，第一个**存在**的会被采用）：')
  for (const c of dshCandidates) w.info(`      - ${c.path}（${c.source}）${existsSync(c.path) ? '' : ' —— 不存在'}`)
}
if (namedDshMissing) {
  w.info(dshPath === null
    ? `   · 你点名的 ${namedDsh.path} 不存在`
    : `   · 你点名的 ${namedDsh.path} 不存在，我改用 ${dshPath}`)
}
w.info('   · DSH 的下载地址：https://www.npmjs.com/package/@deepseek-ai/dsh')
w.info('   · 从源码跑 DSH 的话，用 --dsh <路径> 把它的可执行文件点给我们（源码树不能直接跑，需先装依赖）')
w.blank()

if (verdict.blockers.length > 0) {
  w.warn(`有 ${String(verdict.blockers.length)} 项阻断，先解决它们再装：`)
  for (const b of verdict.blockers) w.info(`   · ${b.label}：${b.fix ?? b.detail}`)
  w.blank()
}

w.info(' 将要写入 / 改动的东西')
w.info(inPlace ? '   ① 安装目录          沿用本目录（原地安装）' : `   ① 创建安装目录      ${layout.installDir}`)
w.info(inPlace ? '   ② 复制源码          跳过（源码已在本目录，不复制也不删除）' : `   ② 复制源码          ${String(installPayload().length)} 项（不含 node_modules、不含 dist —— 发行包保持轻）`)
w.info(`   ③ 准备 DSH          ${dshPath === null ? '**缺** ⇒ 见下面的依赖报告（本程序不代装）' : `用 ${dshPath}`}`)
w.info(`      接上插件依赖      ${layout.pluginDir}/node_modules → 你的 DSH（链接过去，版本自动一致；缺了见依赖报告）`)
w.info(`   ④ 准备 esbuild      ${esbuildReady === null ? '**缺** ⇒ 见下面的依赖报告（本程序不代下载）' : `用 ${esbuildReady}`}`)
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

/*
 * ★ 依赖门禁：缺依赖时**拦在这里**，一个文件都不写。
 * 2026-09-13 用户实测踩到过旧顺序的后果 —— 第 1/2 步先把源码拷了/覆盖了，到第 3 步才发现
 * 缺 DSH，留下一个跑不起来的半成品。这里也不接受"仍要继续"：缺依赖不是"不推荐"，是**做不成**。
 */
if (depBlockers.length > 0) {
  w.warn(`缺 ${String(depBlockers.length)} 项依赖，就此停下（命令见上面的依赖报告）。本程序**没有改动任何文件**。`)
  w.close()
  die(2)
}

if (verdict.blockers.length > 0) {
  /*
   * ★ `--yes` **不能**跳过阻断项（2026-09-13 PiMoa 复核 MAJOR-M3，已实测）：
   * 原来 `&& !ASSUME_YES` 让 `--apply --yes` 直接绕过这个逃生口 —— 于是"安装目录不可写"这类
   * 已知阻断项会一路走到第 1 步 `mkdirSync` 抛 EPERM/EACCES，再被兜底成 **exit 3（中途失败）**，
   * 而它的真实语义是 **2（前置条件不满足）**，自动化会把两者混为一谈。
   * `--yes` 的含义是"别问我"，不是"别管阻断项"。
   */
  if (ASSUME_YES) {
    w.warn(`有 ${String(verdict.blockers.length)} 项阻断 —— --yes 不能跳过阻断项，就此停下。本程序**没有改动任何文件**。`)
    w.close()
    die(2)
  }
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

step(2, inPlace ? '复制源码（原地安装：源码已在本目录，跳过）' : '复制源码（依赖不复制，稍后下载）')
{
  if (inPlace) {
    w.detail(`安装目录就是本目录（${ROOT}）—— 源码已在此，不复制、也不删除任何东西`)
  } else {
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
}

step(3, '接上插件依赖（链接到你 DSH 里那份 —— 本程序不下载）')
{
  if (dshRoot === null) {
    // 门禁已保证 dsh 缺失时不会走到这里；真走到说明探测与判定不一致，宁可停下
    w.warn('定位不到 DSH 的包根目录（找不到 @deepseek-ai/dsh 那个 package.json）—— 无法链接依赖，就此停下。')
    w.close()
    die(2)
  }
  w.detail(`DSH 安装根：${dshRoot}`)
  w.detail('插件跑在 DSH 进程里，所以直接用它自己那份子包 —— 版本永远一致、不用下载：')
  for (const line of describePluginLinks(linkPlan)) w.detail(`  ${line}`)
  if (missingDeps.length > 0) {
    w.warn(`你的 DSH 里缺 ${missingDeps.join('、')} —— 命令在上面依赖报告里，装完重跑本程序。`)
    w.close()
    die(2)
  }
  if (await w.confirm('建立这些链接？')) {
    const made = applyPluginLinks({ pluginDir: layout.pluginDir, plan: linkPlan })
    w.info(`   ✅ 链接了 ${String(made.length)} 个包`)
  } else {
    w.warn('你拒绝了建立依赖链接 —— 插件加载不起来，就此停下。')
    w.close()
    die(4)
  }
}

step(4, '准备扩展构建依赖（esbuild —— 本程序不下载，缺了报告里给你命令）')
{
  if (esbuildReady === null) {
    // 门禁已保证不会走到这里
    w.warn('没找到 esbuild，就此停下。')
    w.close()
    die(2)
  }
  if (resolve(esbuildReady) === resolve(esbuildTarget)) {
    w.detail(`用安装目录里已有的 esbuild：${esbuildTarget}`)
  } else {
    w.detail(`复用本机已有的 esbuild：${esbuildReady}`)
    if (await w.confirm('链接它（不下载）？')) {
      rmSync(esbuildTarget, { recursive: true, force: true })
      mkdirSync(esbuildTarget, { recursive: true })
      symlinkSync(esbuildReady, join(esbuildTarget, 'esbuild'), 'dir')
      const scope = join(dirname(esbuildReady), '@esbuild')
      if (existsSync(scope)) symlinkSync(scope, join(esbuildTarget, '@esbuild'), 'dir')
    } else {
      w.warn('没链接 esbuild —— 扩展构建会失败，就此停下。')
      w.close()
      die(4)
    }
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
if (exitCode === 5) {
  /*
   * ★ 提示必须**按哪几条硬判据没过**分流（2026-09-13 修；PiMoa 片 6b 第 3 条 MAJOR）：
   * 原来只要是 exit 5 就劝"重启 DSH 就好"。可 exit 5 涵盖**任何**硬判据不过 ——
   * 例如 `dist-port`（缺 check-dist-config＝安装残缺、或产物端口不一致），用户重启完仍然红灯，
   * 而且被这句提示带偏、拿不到真因。本批刚把 dist-port 抬成硬判据就是为了暴露它，不能再藏回去。
   */
  const hardFailed = health.filter((i) => !i.soft && !i.ok).map((i) => i.id)
  const onlyNotLive = hardFailed.length > 0 && hardFailed.every((id) => id === 'dsh-up' || id === 'paired')
  if (onlyNotLive) {
    w.info(' 💡 步骤都跑完了。若这是**首次安装**，DSH 还没重启 ⇒ 插件尚未加载，复检当然不过：')
    w.info('    重启 DSH（dsh web）后再跑一次 `node <安装目录>/bootstrap/doctor.mjs` 即可复验。')
  } else {
    w.info(` 💡 步骤跑完了，但硬判据没过：${hardFailed.join('、')} —— 见上面的 ❌ 与 ↳ 修法。`)
    w.info('    （这不是"重启就好"：`dist-port` 那条说明安装目录不完整或产物端口不一致，先按 ↳ 修。）')
  }
}
die(exitCode)
