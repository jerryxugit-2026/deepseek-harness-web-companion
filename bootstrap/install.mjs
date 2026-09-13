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
import { applyPluginLinks, describePluginLinks, findDshRoot, planPluginLinks } from './lib/dsh-root.mjs'
import { extensionIdFromKey } from './lib/extension-id.mjs'
import { checkChrome, checkDirectory, checkDshCli, checkMount, checkNode, checkPort, renderChecks, summarize } from './lib/checks.mjs'
import { dirStatus, dshVersion as readDshVersion, pingPlugin, portListening, readPairingKey, which } from './lib/probe.mjs'
import { applyNativeHostInstall, describeNativeHostPlan, planNativeHostInstall } from './lib/native-host-install.mjs'
import { buildMountConfig, describeCompanion, upsertCompanion } from './lib/profile-patch.mjs'
import { finishBanner, overallOk, pendingHard, probeHealth, renderHealth } from './lib/health.mjs'
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
  --install-dir <路径>   安装到哪（默认 ~/.dsh/plugins/dsh-web-companion；**不给就会问你一次**）
  --dsh-home <路径>      DSH 数据目录（默认 $DSH_HOME 或 ~/.dsh；**不给就会问你一次**）
  --port <端口>          DSH 端口（默认 3080）
  --dsh-version <版本>   要钉的 DSH 版本（默认用你已装的那个；**不要用 latest**）
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
const installDirArg = argOf('install-dir', null)
const dshHomeArg = argOf('dsh-home', null)
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

const step = (n, title) => w.step(n, title)
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
const must = (res, what) => {
  if (res.status === 0) return true
  w.warn(`${what} 失败（exit ${String(res.status)}）—— 就此停下，不改动你的 DSH 挂载。`)
  w.warn('修好之后重跑本程序即可（已完成的步骤是幂等的，不会重复做坏事）。')
  w.close()
  process.exit(3)
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
w.info(`      接上插件依赖      ${layout.pluginDir}/node_modules → 你的 DSH（不下载，版本自动一致）`)
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
  process.exit(verdict.blockers.length > 0 ? 2 : 0)
}

/* ─────────────────────────── 执行 ─────────────────────────── */

if (verdict.blockers.length > 0 && !ASSUME_YES) {
  const go = await w.confirm('仍有阻断项，仍要继续吗？（不推荐）')
  if (!go) { w.close(); process.exit(2) }
}

let created = false

step(1, `创建安装目录 ${layout.installDir}`)
if (await w.confirm('创建这个目录？')) {
  mkdirSync(layout.installDir, { recursive: true })
  created = true
} else {
  w.warn('用户拒绝创建目录 —— 无法继续。')
  w.close()
  process.exit(1)
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
        process.exit(3)
      }
      w.info(`   ✅ DSH 可用：${dshPath}`)
    } else {
      w.warn('未安装 DSH。后面的依赖链接与自检会失败 —— 建议先装完再重跑。')
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
    const missing = plan.filter((i) => !i.available)
    if (missing.length > 0) {
      w.warn(`DSH 里缺 ${missing.map((m) => m.name).join('、')} —— 这三个包正常随 DSH 一起来，安装可能不完整。`)
    }
    if (await w.confirm('建立这些链接？')) {
      const made = applyPluginLinks({ pluginDir: layout.pluginDir, plan })
      w.info(`   ✅ 链接了 ${String(made.length)} 个包`)
    }
  }
}

step(4, '准备扩展构建依赖（esbuild —— 这一个要下载）')
{
  // 本机如果已经有（开发机的 extension/node_modules），直接链接，省一次下载。
  const localEsbuild = join(ROOT, 'extension', 'node_modules', 'esbuild')
  const targetDir = join(layout.installDir, 'extension', 'node_modules')
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
    must(run('npm', ['install', '--no-audit', '--no-fund', '--no-save', '--prefix', join(layout.installDir, 'extension'), 'esbuild@^0.25.0']), '下载 esbuild')
  }
}

step(5, '生成配对钥匙（幂等，不轮换已有 key）')
if (await w.confirm('生成/复用配对钥匙？')) {
  // 先备份：init-key 会重写配对文件（幂等，但用户可能想回滚）
  if (!DRY_RUN && existsSync(layout.pairingFile)) {
    copyFileSync(layout.pairingFile, `${layout.pairingFile}.bak-before-install`)
    w.detail(`已备份配对文件 → ${layout.pairingFile}.bak-before-install`)
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
      process.exit(3)
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
    process.exit(3)
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
  w.detail(next.action === 'unchanged' ? '内容已是目标状态（无需改动）' : `动作：${next.action}`)
  w.detail(`备份到：${layout.profilePatch}.bak-before-companion`)
  if (Object.keys(config).length === 0 && mountBefore.found === true) {
    w.info('   💡 本程序只写它自己管理的键（attachDir / approvalForWriteOps）。')
    w.info('      若你之前设过别的键（例如 approvalForWriteOps: false），用 `--approval-for-write-ops false` 或 `--set key=value` 显式带上；它不会自己去猜。')
  }
  if (await w.confirm('写入这一行挂载？')) {
    if (existsSync(layout.profilePatch)) copyFileSync(layout.profilePatch, `${layout.profilePatch}.bak-before-companion`)
    mkdirSync(dirname(layout.profilePatch), { recursive: true })
    writeFileSync(layout.profilePatch, next.text)
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
    if (existsSync(layout.credentialsFile)) copyFileSync(layout.credentialsFile, `${layout.credentialsFile}.bak-before-apikey`)
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
let health = []
if (waited) {
  step(11, '复检：DSH 应答 / 插件配对 / 产物端口 / 扩展连通（代理判据）')

  const probeOnce = () => probeHealth({ port, dshHome, installDir: layout.installDir })

  health = await probeOnce()
  for (const line of renderHealth(health)) w.info(`   ${line}`)

  /*
   * 「扩展连通」是**软判据**（代理：侧边栏一开，iframe 里的 DSH 页面半就会连上）。
   * 它没过时给用户一次机会打开侧边栏再查，而不是直接说"你没装好" ——
   * 因为本程序**看不到**扩展装没装，只能看它有没有连上来。
   */
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
 * `finishBanner()` 把"**没查**"（非交互跳过了第 11 步）与"**查了没过**"分开 ——
 * 原来直接用 `overallOk(health)`，而空数组是 false，于是非交互跑法会谎报"硬判据没过"。
 */
const banner = finishBanner(health)
w.info(banner.text)
if (banner.softHint) w.info(' 💡 那条 ⚠️ 是软判据：打开侧边栏后它会变 ✅ —— 那才是"扩展真的连上来了"的证据')
w.info('════════════════════════════════════════════════════════════')
w.info(` 自查：node ${join(layout.installDir, 'bootstrap', 'doctor.mjs')}`)
w.info(` 卸载：node ${join(layout.installDir, 'bootstrap', 'uninstall.mjs')}`)
w.info(' 试试：打开侧边栏，在输入框写「看左边」')
w.blank()
w.close()
process.exit(0)
