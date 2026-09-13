/**
 * 找出用户**已装的 DSH** 在哪，并把插件需要的运行时包**链接**过去（而不是下载一份）。
 *
 * ★ 这是本轮最重要的一个发现，来自"读工作正常的现场"而不是猜：
 *
 * 工作正常的 `dsh-plugin/node_modules/` 里根本**没有真实安装**任何包，而是三个符号链接：
 * ```
 * @deepseek-ai/dsh-tools       -> <DSH 安装根>/node_modules/@deepseek-ai/dsh-tools
 * @deepseek-ai/dsh-credentials -> <DSH 安装根>/node_modules/@deepseek-ai/dsh-credentials
 * ws                           -> <DSH 安装根>/node_modules/ws
 * ```
 * 这条路线一次解决四个问题：
 *   1. **版本永远一致**：插件跑在 DSH 进程里，用的就是 DSH 自己那份子包。
 *      设计文档 §12.4 Q5 担心的"API 漂移"从根上消失 —— 实测 DSH 从 0.1.2-rc.1 升到
 *      0.1.5-rc.2 之后，插件**不用做任何事**就跟着走了（因为链接跟着变）。
 *   2. **不用下载**：符合用户"发行包保持轻量、依赖由引导程序下载"的约束 ——
 *      这里连下载都不需要，DSH 装好就自带这三个包。
 *   3. **绕开 peer 依赖地狱**：实测 `npm install @deepseek-ai/dsh-tools@0.1.5-rc.2`
 *      在插件目录里**必然失败**（`ERESOLVE`：它 peer 依赖 `@deepseek-ai/dsh-llm` 等 9 个包，
 *      单独装一个子包满足不了）。而链接进 DSH 的树里，peer 天然齐全。
 *   4. **升级 DSH 不需要重装插件**。
 *
 * 注：`esbuild`（构建扩展用）**不在** DSH 里，那一个是真要下载的，见 install.mjs 第 4 步。
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 插件在**运行时**真正 require/import 的包（依据：`dsh-plugin/src/host/*.js` 的 import）。 */
export const PLUGIN_RUNTIME_DEPS = ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-credentials', 'ws']

/**
 * 从 `dsh` 可执行文件出发，向上找到 `@deepseek-ai/dsh` 这个包的根目录。
 *
 * 为什么要跟着符号链接走：本机 `dsh` 是两层软链
 * （`~/.local/bin/dsh` → `~/.hermes/node/bin/dsh` → `<prefix>/lib/node_modules/@deepseek-ai/dsh/lib/bin.js`），
 * 只按字面路径找会找不到。
 *
 * 全部依赖可注入，便于单测（不碰真实文件系统）。
 */
export function findDshRoot(dshPath, { realpath = realpathSync, exists = existsSync, read = readFileSync } = {}) {
  if (typeof dshPath !== 'string' || dshPath === '') return null
  let at
  try {
    at = dirname(realpath(dshPath))
  } catch {
    return null
  }
  for (let i = 0; i < 8; i += 1) {
    const pkgFile = join(at, 'package.json')
    if (exists(pkgFile)) {
      try {
        if (JSON.parse(read(pkgFile, 'utf8'))?.name === '@deepseek-ai/dsh') return at
      } catch { /* 不是合法 JSON，继续向上 */ }
    }
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return null
}

/**
 * 按 Node 的查找顺序列出可能的 `node_modules` 目录（从 DSH 包往上走）。
 *
 * ★ 为什么不能只看 `<dshRoot>/node_modules`（2026-09-13 实测踩到的真 bug）：
 * npm 的**提升（hoisting）**不同布局不一样 ——
 *   · 本机的**全局**安装：依赖**嵌在** dsh 包自己的 node_modules 里
 *     ⇒ `<dshRoot>/node_modules/@deepseek-ai/dsh-tools` ✅
 *   · `npm install --prefix X @deepseek-ai/dsh`（**前缀**安装）：依赖被**提升**到
 *     `X/node_modules/@deepseek-ai/dsh-tools`，而 `<dshRoot>/node_modules/...` **不存在** ❌
 * 只认第一种的话，前缀安装（正是全新机器上会走的那条路）会被判成"三个依赖全缺"，
 * 于是链接一个都不建、自检失败。所以这里按祖先逐层找，与 Node 的解析顺序一致。
 */
export function candidateNodeModules(dshRoot) {
  const out = []
  let at = dshRoot
  for (let i = 0; i < 12; i += 1) {
    out.push(join(at, 'node_modules'))
    const up = dirname(at)
    if (up === at) break
    at = up
  }
  return out
}

/**
 * 算出要建哪些链接。`available=false` 表示 DSH 里没有那个包（那时只能回落到下载）。
 */
export function planPluginLinks({ dshRoot, pluginDir, exists = existsSync }) {
  const nodeModules = join(pluginDir, 'node_modules')
  return PLUGIN_RUNTIME_DEPS.map((name) => {
    // 逐层找：命中 Node 实际会解析到的那个位置（嵌套 / 提升两种布局都覆盖）
    const target = dshRoot === null
      ? null
      : candidateNodeModules(dshRoot).map((dir) => join(dir, name)).find((p) => exists(p)) ?? null
    return {
      name,
      target,
      linkPath: join(nodeModules, name),
      available: target !== null,
    }
  })
}

/**
 * 落地链接。**先清空插件的 node_modules** —— 这样重复运行是幂等的，
 * 也能把上一次失败留下的半成品（比如一坨真实下载的包）清掉。
 *
 * `io` 可注入，便于单测（默认就是真 fs）。
 */
export function applyPluginLinks({ pluginDir, plan, io = {} }) {
  const rm = io.rm ?? ((p) => rmSync(p, { recursive: true, force: true }))
  const mkdir = io.mkdir ?? ((p) => mkdirSync(p, { recursive: true }))
  const symlink = io.symlink ?? ((target, linkPath) => symlinkSync(target, linkPath, 'dir'))
  const nodeModules = join(pluginDir, 'node_modules')
  rm(nodeModules)
  const made = []
  for (const item of plan) {
    if (!item.available) continue
    mkdir(dirname(item.linkPath))
    symlink(item.target, item.linkPath)
    made.push(item)
  }
  return made
}

/** 给用户看的说明行。 */
export function describePluginLinks(plan) {
  return plan.map((i) => (i.available
    ? `${i.name} → ${i.target}`
    : `${i.name} ⚠️ DSH 里没有（需要单独下载）`))
}
