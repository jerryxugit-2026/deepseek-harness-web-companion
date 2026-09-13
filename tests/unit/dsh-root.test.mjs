#!/usr/bin/env node
/**
 * 依赖接法单测（`bootstrap/lib/dsh-root.mjs`）。
 *
 * 由来（2026-09-12 读工作正常的现场得出，不是猜的）：插件的 `node_modules` 里
 * **没有真实安装**任何包，而是三个符号链接指向**用户那份 DSH** 自带的子包：
 *   `@deepseek-ai/dsh-tools` / `@deepseek-ai/dsh-credentials` / `ws`
 *
 * 这条路线的价值：版本永远一致（DSH 升级插件自动跟随）、不用下载、绕开 peer 依赖地狱
 * —— 实测在插件目录里单装 `@deepseek-ai/dsh-tools@0.1.5-rc.2` 必然 `ERESOLVE` 失败
 * （它 peer 依赖 `dsh-llm` 等 9 个包）。
 *
 * 本文件用**注入的假文件系统**断言"找 DSH 根"与"算链接计划"这两件纯逻辑，
 * 不碰真实磁盘，也不依赖本机装没装 DSH。
 *
 * 用法：node tests/unit/dsh-root.test.mjs
 */
import { DOWNLOADABLE_PLUGIN_DEPS, PLUGIN_RUNTIME_DEPS, applyPluginLinks, candidateNodeModules, classifyMissingPluginDeps, describePluginLinks, findDshRoot, planPluginLinks } from '../../bootstrap/lib/dsh-root.mjs'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
}

/** 假文件系统：一组存在的路径 + 若干 package.json 内容。 */
function fakeFs({ files = {}, json = {} } = {}) {
  return {
    exists: (p) => Object.hasOwn(files, p) || Object.hasOwn(json, p),
    read: (p) => {
      if (!Object.hasOwn(json, p)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
      return json[p]
    },
  }
}

console.log('1. ★ findDshRoot：跟着符号链接走，按包名认，而不是靠路径长相')
{
  const dshPkg = '/prefix/lib/node_modules/@deepseek-ai/dsh/package.json'
  const fs = fakeFs({ json: { [dshPkg]: JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.5-rc.2' }) } })
  const root = findDshRoot('/usr/local/bin/dsh', {
    realpath: () => '/prefix/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
    ...fs,
  })
  record('找到了 DSH 根', root === '/prefix/lib/node_modules/@deepseek-ai/dsh')
}

console.log('\n2. 找不到时老实返回 null（不许瞎猜一个路径）')
{
  const fs = fakeFs({ json: { '/other/thing/package.json': JSON.stringify({ name: 'not-dsh' }) } })
  record('路径不存在（realpath 抛错）→ null', findDshRoot('/nope/dsh', { realpath: () => { throw new Error('ENOENT') }, ...fs }) === null)
  record('祖先里没有 @deepseek-ai/dsh → null', findDshRoot('/x/dsh', { realpath: () => '/other/thing/lib/bin.js', ...fs }) === null)
  record('入参为空 → null', findDshRoot('', fs) === null)
  record('package.json 是坏 JSON → null（不抛）', findDshRoot('/x/dsh', {
    realpath: () => '/other/thing/lib/bin.js',
    exists: () => true,
    read: () => '{ 坏掉的 json',
  }) === null)
}

console.log('\n3. ★ 链接计划：三个运行时依赖，逐个标出 DSH 里有没有')
{
  const dshRoot = '/dsh'
  const present = new Set([`${dshRoot}/node_modules/@deepseek-ai/dsh-tools`, `${dshRoot}/node_modules/@deepseek-ai/dsh-credentials`, `${dshRoot}/node_modules/ws`])
  const plan = planPluginLinks({ dshRoot, pluginDir: '/inst/dsh-plugin', exists: (p) => present.has(p) })
  record(`覆盖 ${String(PLUGIN_RUNTIME_DEPS.length)} 个包`, plan.length === 3)
  record('三个都判为可用', plan.every((i) => i.available))
  record('链接落在插件的 node_modules 下', plan[0].linkPath === '/inst/dsh-plugin/node_modules/@deepseek-ai/dsh-tools')
  record('指向 DSH 里那份', plan[0].target === '/dsh/node_modules/@deepseek-ai/dsh-tools')
  record('ws 也走同一条路', plan.find((i) => i.name === 'ws')?.target === '/dsh/node_modules/ws')

  const partial = planPluginLinks({ dshRoot, pluginDir: '/inst/dsh-plugin', exists: (p) => p.endsWith('ws') })
  record('DSH 里缺 dsh-tools 时标为不可用', partial.find((i) => i.name === '@deepseek-ai/dsh-tools').available === false)
  record('可用性互不牵连（ws 仍可用）', partial.find((i) => i.name === 'ws').available === true)

  const none = planPluginLinks({ dshRoot: null, pluginDir: '/inst/dsh-plugin', exists: () => true })
  record('找不到 DSH 根时全部不可用', none.every((i) => i.available === false))
  record('此时 target 为 null（不会链到字符串 "null" 上）', none.every((i) => i.target === null))
}

console.log('\n3b. ★ 提升布局（前缀安装）：依赖在 prefix 的 node_modules 里，也必须找得到')
{
  /*
   * 真 bug（2026-09-13，做"远端全新机器"演练时抓到）：原来只认
   * `<dshRoot>/node_modules/<pkg>`（依赖**嵌在** dsh 包里的那种布局，本机全局安装就是它）。
   * 但 `npm install --prefix X @deepseek-ai/dsh` 会把依赖**提升**到 `X/node_modules/`，
   * 于是三个包全被判成"缺" ⇒ 一个链接都不建 ⇒ 自检失败。全新机器上正是这条路径。
   */
  const dshRoot = '/prefix/node_modules/@deepseek-ai/dsh'
  const hoisted = new Set([
    '/prefix/node_modules/@deepseek-ai/dsh-tools',
    '/prefix/node_modules/@deepseek-ai/dsh-credentials',
    '/prefix/node_modules/ws',
  ])
  const plan = planPluginLinks({ dshRoot, pluginDir: '/inst/dsh-plugin', exists: (p) => hoisted.has(p) })
  record('★ 提升布局下三个包都判为可用', plan.every((i) => i.available))
  record('★ target 指向前缀的 node_modules（不是 dsh 包内部）',
    plan[0].target === '/prefix/node_modules/@deepseek-ai/dsh-tools')
  const candidates = candidateNodeModules(dshRoot)
  record('候选目录里既含 dsh 包内层、也含前缀那层',
    candidates.includes('/prefix/node_modules/@deepseek-ai/dsh/node_modules') && candidates.includes('/prefix/node_modules'))

  // 嵌套布局（本机全局安装）仍然要能命中，不能被这次修改弄坏
  const nested = new Set(['/g/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools'])
  const nestedPlan = planPluginLinks({ dshRoot: '/g/node_modules/@deepseek-ai/dsh', pluginDir: '/i', exists: (p) => nested.has(p) })
  record('嵌套布局仍然命中（优先就近的那个）',
    nestedPlan[0].target === '/g/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tools')
}

console.log('\n4. 说明行把"缺什么"讲出来（而不是静默少链一个）')
{
  const plan = planPluginLinks({ dshRoot: '/dsh', pluginDir: '/inst/dsh-plugin', exists: (p) => p.endsWith('ws') })
  const lines = describePluginLinks(plan)
  record('三条说明', lines.length === 3)
  record('可用的写出箭头指向', lines.some((l) => l.includes('ws → /dsh/node_modules/ws')))
  record('不可用的带警告字样', lines.some((l) => l.includes('dsh-tools') && l.includes('⚠️')))
}

console.log('\n5. applyPluginLinks：先清空再链接（幂等，且清掉上次失败的半成品）')
{
  const calls = []
  const plan = [
    { name: 'a', target: '/dsh/node_modules/a', linkPath: '/inst/nm/a', available: true },
    { name: 'b', target: '/dsh/node_modules/b', linkPath: '/inst/nm/b', available: false },
  ]
  const made = applyPluginLinks({ pluginDir: '/inst', plan, io: {
    rm: (p) => calls.push(`rm:${p}`),
    mkdir: (p) => calls.push(`mkdir:${p}`),
    symlink: (t, l) => calls.push(`link:${t}->${l}`),
  } })
  record('先把整个 node_modules 删掉', calls[0] === 'rm:/inst/node_modules')
  record('只链可用的那个', made.length === 1 && made[0].name === 'a')
  record('不可用的不建链接', calls.some((c) => c.includes('/nm/b')) === false)
  record('建了正确的符号链接', calls.includes('link:/dsh/node_modules/a->/inst/nm/a'))
}

/*
 * DSH 里缺包时的兜底判据（2026-09-13）。
 *
 * 真实现场：`describePluginLinks()` 早就写着"（需要单独下载）"，但安装器**没有实现下载** ——
 * 缺包只 `warn` 一句就继续，要等第 6.5 步导入自检才以"模块找不到"失败（那时已经写了一堆文件）。
 * 现在分两路：能下载的（`ws`）下载，必须与 DSH 同源的（两个 `@deepseek-ai/*`）当场停下。
 *
 * 这组断言咬的是"分类别退回去"：把 `DOWNLOADABLE_PLUGIN_DEPS` 改成三个包全可下载
 * （即"缺啥都下载"）⇒ `fatal` 变空，第 3、5 条断言立刻红。
 */
console.log('\n5. classifyMissingPluginDeps：缺包时分「能下载」与「必须硬失败」')
{
  const full = PLUGIN_RUNTIME_DEPS.map((name) => ({ name, available: true }))
  const none = classifyMissingPluginDeps(full)
  record('都不缺时两路都空', none.downloadable.length === 0 && none.fatal.length === 0)

  const missingWs = classifyMissingPluginDeps([
    { name: '@deepseek-ai/dsh-tools', available: true },
    { name: '@deepseek-ai/dsh-credentials', available: true },
    { name: 'ws', available: false },
  ])
  record('★ 只缺 ws ⇒ 走「可下载」（ws 是普通 npm 包，没有实例同一性要求）', missingWs.downloadable.join() === 'ws' && missingWs.fatal.length === 0)

  const missingTools = classifyMissingPluginDeps([
    { name: '@deepseek-ai/dsh-tools', available: false },
    { name: '@deepseek-ai/dsh-credentials', available: true },
    { name: 'ws', available: true },
  ])
  record('★ 缺 @deepseek-ai/dsh-tools ⇒ 走「硬失败」（插件跑在 DSH 进程内，必须同一实例）', missingTools.fatal.join() === '@deepseek-ai/dsh-tools' && missingTools.downloadable.length === 0)

  const both = classifyMissingPluginDeps([
    { name: '@deepseek-ai/dsh-tools', available: false },
    { name: '@deepseek-ai/dsh-credentials', available: false },
    { name: 'ws', available: false },
  ])
  record('★ 全缺时两路各自正确（不许把 @deepseek-ai/* 混进可下载）', both.downloadable.join() === 'ws' && both.fatal.length === 2)
  record('可下载集合恰好是 ws（写死在这里，防止悄悄放宽）', DOWNLOADABLE_PLUGIN_DEPS.join() === 'ws')
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
