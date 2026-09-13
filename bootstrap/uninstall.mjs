#!/usr/bin/env node
/**
 * DSH Web Companion · 卸载引导程序
 *
 * 原则（用户要求"只反向移除属于自己的东西"）：**只动我们写进去的那几样**。
 *
 *   · profile 补丁层里我们那一条 → 摘掉（先备份）
 *   · Chrome 的 native messaging 清单 → 删掉
 *   · 安装目录 → 删掉（可选，`--keep-files` 保留）
 *   · **配对钥匙默认保留**（`~/.dsh/dsh-web-companion.json`）—— 删了会连带影响重装后的配对，
 *     而且它是 DSH_HOME 里的东西、不是我们独占的；要清得显式 `--purge-pairing`
 *   · **API key 永不删**（那是用户的凭据，跟本插件无关）
 *
 * 默认 dry-run；真卸加 `--apply`。
 *
 * 用法：
 *   node bootstrap/uninstall.mjs                 # dry-run：只打印将要做什么
 *   node bootstrap/uninstall.mjs --apply         # 真的卸
 */
import { existsSync, readFileSync, rmSync, copyFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PORT, PLUGIN_ID, defaultInstallDir, parsePort, resolveLayout } from './lib/layout.mjs'
import { removeCompanion, readCompanionEntry } from './lib/profile-patch.mjs'
import { planNativeHostInstall } from './lib/native-host-install.mjs'
import { createWizard } from './lib/wizard.mjs'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const argOf = (name, fallback) => {
  const at = argv.indexOf(`--${name}`)
  return at === -1 || argv[at + 1] === undefined ? fallback : argv[at + 1]
}

const DRY_RUN = !flag('apply')
const homeDir = homedir()
const installDir = resolve(argOf('install-dir', defaultInstallDir(homeDir)))
const dshHome = resolve(argOf('dsh-home', process.env.DSH_HOME?.trim() || join(homeDir, '.dsh')))
const port = parsePort(argOf('port', DEFAULT_PORT)) ?? DEFAULT_PORT

const w = createWizard({ assumeYes: flag('yes') })
const layout = resolveLayout({ installDir, dshHome, homeDir, port, platform: process.platform, env: process.env, exists: existsSync })

w.info('════════════════════════════════════════════════════════════')
w.info(' DSH Web Companion · 卸载引导程序')
w.info('════════════════════════════════════════════════════════════')
w.info(`  安装目录   ${installDir}`)
w.info(`  DSH 数据   ${dshHome}`)
w.info(`  模式       ${DRY_RUN ? '🔎 dry-run —— 只打印，不动文件（真卸请加 --apply）' : '✍️  apply'}`)
w.blank()

/* 1. profile 挂载 */
const patchText = existsSync(layout.profilePatch) ? readFileSync(layout.profilePatch, 'utf8') : ''
const entry = readCompanionEntry(patchText, PLUGIN_ID)
const removal = removeCompanion(patchText, { id: PLUGIN_ID })
w.info(`① 插件挂载   ${layout.profilePatch}`)
w.info(`   当前指向   ${entry.found ? String(entry.entryPath) : '(没有挂载)'}`)
w.info(`   动作       ${removal.action}`)
if (removal.action === 'removed' && await w.confirm('摘掉这一条挂载？（先备份）')) {
  copyFileSync(layout.profilePatch, `${layout.profilePatch}.bak-before-uninstall`)
  writeFileSync(layout.profilePatch, removal.text)
  w.info(`   已摘掉（备份：${layout.profilePatch}.bak-before-uninstall）`)
}

/* 2. Chrome 清单 */
const plan = planNativeHostInstall(layout, { extensionId: 'irrelevant-for-removal', exists: existsSync })
w.info(`② Chrome 清单 ${plan.manifestPath ?? '(Windows 走注册表，本项目暂不支持)'}`)
if (plan.manifestPath !== null && existsSync(plan.manifestPath) && await w.confirm('删掉这个清单？（拉起器随安装目录一起删）')) {
  rmSync(plan.manifestPath, { force: true })
  w.info('   已删除')
}

/* 3. 安装目录 */
w.info(`③ 安装目录   ${installDir}`)
if (flag('keep-files')) {
  w.info('   --keep-files：保留')
} else if (existsSync(installDir) && await w.confirm('删掉整个安装目录？')) {
  rmSync(installDir, { recursive: true, force: true })
  w.info('   已删除')
}

/* 4. 配对钥匙：默认保留 */
w.info(`④ 配对钥匙   ${layout.pairingFile}`)
if (flag('purge-pairing')) {
  if (existsSync(layout.pairingFile) && await w.confirm('删掉配对钥匙？（重装后要重新配对）')) {
    rmSync(layout.pairingFile, { force: true })
    w.info('   已删除')
  }
} else {
  w.info('   保留（默认。要清加 --purge-pairing）')
}

/* 5. API key：永不删 */
w.info(`⑤ API key    ${layout.credentialsFile}`)
w.info('   保留（这是你的凭据，与本插件无关，本程序不会动它）')
w.blank()
w.info(DRY_RUN
  ? '（dry-run 结束 —— 上面全是"将要做什么"，实际什么都没动。确认无误后加 --apply 真卸。）'
  : '卸载完成。若 DSH 还在跑，重启一次以卸载插件：dsh web')
w.blank()
w.close()
process.exit(0)
