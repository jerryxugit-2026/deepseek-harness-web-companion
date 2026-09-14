/**
 * 体检用的**事实探测**（I/O 都在这儿，判定在 `checks.mjs`）。
 *
 * 单独一层是为了让"怎么判定"能被单测钉住，而"怎么探测"跟着环境走。
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PLUGIN_ID } from './layout.mjs'

/** `command -v <cmd>` —— 自己实现，避免依赖 shell 类型。 */
export function which(cmd) {
  try {
    /*
     * ★ 不把 `cmd` 拼进 shell 串（2026-09-13 PiMoa 复核 MINOR）：现在唯一的调用方传的是常量
     * `'dsh'`，没有注入面；但"把变量拼进 shell 命令"这种写法迟早会被别处复用时出事。
     * 改成把参数作为 `$1` 传，shell 侧不再出现变量内容。
     */
    const out = execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
}

/**
 * 找 `dsh` 可执行文件 —— **多源**，不是只问 PATH。
 *
 * ★ 为什么（2026-09-13 用户实测否掉旧做法）：原来只做 `command -v dsh`，于是
 *   · 从**源码**跑起来的 DSH（自己 clone + 自己 build，例如 `/Volumes/Ex/.../deepseek-harness`）、
 *   · 装了但全局 bin 目录不在 PATH 上、
 *   · 装在自定路径的 DSH
 * 一律"看不见" ⇒ 报告说"没装 DSH"，然后引导程序**自己再装一份全局的** ——
 * 机器上出现两个 DSH，用户根本不知道哪个在跑。这正是"用代码猜"最典型的坏结果。
 *
 * 现在改为：`--dsh <路径>` 点名优先 → PATH → npm 全局前缀与几个常见位置。
 * 返回**全部候选及来源**，让调用方如实报告"我找到了什么、准备用哪一个"，
 * 而不是只回一个布尔值。
 */
export function findDshCandidates({ homeDir, exists = existsSync, pathLookup = which, npmPrefix = null, argv = process.argv } = {}) {
  const out = []
  const push = (p, source) => {
    if (typeof p === 'string' && p !== '' && !out.some((c) => c.path === p)) out.push({ path: p, source })
  }
  // ① 用户点名 —— 最高优先，也顺便解决了"我们的猜测看不见你那个安装"这个问题
  const at = argv.indexOf('--dsh')
  if (at !== -1 && typeof argv[at + 1] === 'string' && argv[at + 1] !== '') {
    /*
     * ★ 打上 `named` 标记、**并且不管它存不存在都留下**（2026-09-13 PiMoa 复核 MAJOR-M1）：
     * 调用方必须能同时说清两件事 —— "你点名的路径不存在" 和 "不过我在 PATH 上找到了另一个"。
     * 原来是"谁先谁用"，点错一个路径就把 PATH 上可用的 DSH 整个丢弃了。
     */
    out.push({ path: argv[at + 1], source: '你用 --dsh 点名的', named: true })
  }
  // ② PATH
  push(pathLookup('dsh'), 'PATH')
  // ③ npm 全局前缀 + 常见安装位置（都是**显式**候选，不做全盘扫描）
  const guesses = []
  if (typeof npmPrefix === 'string' && npmPrefix !== '') guesses.push(join(npmPrefix, 'bin', 'dsh'))
  guesses.push(
    join(homeDir, '.local', 'bin', 'dsh'),
    '/opt/homebrew/bin/dsh',
    '/usr/local/bin/dsh',
    join(homeDir, '.hermes', 'node', 'bin', 'dsh'),
  )
  for (const g of guesses) if (exists(g)) push(g, '常见安装位置')
  return out
}

/** 跑 `dsh -V` 取版本；失败返回 null。 */
export function dshVersion(dshPath) {
  if (dshPath === null) return null
  try {
    return execFileSync(dshPath, ['-V'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().replace(/^v/u, '') || null
  } catch {
    return null
  }
}

/** 端口上有没有人在 LISTEN（用 lsof；macOS 自带）。返回**三态**。 */
export function portListening(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() !== ''
  } catch (error) {
    /*
     * ★ 三态（2026-09-13 修，PiMoa 第 3 片查出）：`true` 有人在听 / `false` 确实没人 /
     * `null` **探测失败**（lsof 不存在、没权限、被沙箱拦）。
     *
     * 原来一律 `return false`，把"查不出来"和"确实没有"合并 ⇒ `checkPort()` 走末行渲染成
     * "空闲 ✅" —— 探测失败被当成绿灯。lsof 正常跑完但没匹配到进程时退出码是 **1**，
     * 那才是真正的"确实没人听"；其它情况（ENOENT / 权限 / 被拦）是"不知道"。
     */
    if (error?.status === 1) return false
    return null
  }
}

/** 本插件在不在这个端口上、配对没有。 */
export async function pingPlugin(port, key) {
  try {
    const url = `http://127.0.0.1:${String(port)}/ag/ping${typeof key === 'string' && key !== '' ? `?key=${encodeURIComponent(key)}` : ''}`
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const body = await res.json().catch(() => null)
    /*
     * ★ 必须**验身份**（2026-09-13 修，PiMoa 第 3 片查出）：原来只要 `res.json()` 解析成功就
     * `reachable: true` —— 既不查 `res.ok`，也不查 `body.plugin`。于是**任何一个在这个端口上
     * 回 JSON 的服务**（连一个 404 的 JSON 都算）都会让硬判据"DSH 在本机 N 端口应答"变成 ✅，
     * 连带 `checkPort()` 也会说"已有 DSH 在跑且已配对，将复用它"。
     */
    const isOurs = res.ok === true && body?.ok === true && body?.plugin === PLUGIN_ID
    return {
      reachable: isOurs,
      // 不是我们的服务时，它 body 里的 paired / connectedClients 一个字都不能当真
      paired: isOurs && body?.paired === true,
      plugin: typeof body?.plugin === 'string' ? body.plugin : null,
      connectedClients: isOurs ? body?.connectedClients ?? null : null,
      status: res.status,
    }
  } catch {
    return { reachable: false, paired: false, plugin: null, connectedClients: null, status: null }
  }
}

/** 路径状态：ok | missing | unwritable。 */
export function dirStatus(path) {
  if (!existsSync(path)) {
    // 不存在时看最近的已存在祖先能不能写 —— 能写就意味着可以创建
    let at = dirname(path)
    while (at !== dirname(at)) {
      if (existsSync(at)) {
        try { accessSync(at, constants.W_OK); return 'missing' } catch { return 'unwritable' }
      }
      at = dirname(at)
    }
    /*
     * 一路走到根（`/`）都没找到已存在的祖先（例如 `/newtop/sub`——`/newtop` 也不存在）。
     * 2026-09-13 修（PiMoa 第 3 片查出）：原来这里直接 `return 'missing'`，**没看根能不能写**，
     * 于是这种路径被判成"不存在，将创建 ✅"，真正 `mkdir` 时才失败。
     */
    try { accessSync(at, constants.W_OK); return 'missing' } catch { return 'unwritable' }
  }
  try {
    if (!statSync(path).isDirectory()) return 'unwritable'
    accessSync(path, constants.W_OK)
    return 'ok'
  } catch {
    return 'unwritable'
  }
}

/** 读配对文件里的 key（读不到返回 null）。 */
export function readPairingKey(pairingFile) {
  try {
    return JSON.parse(readFileSync(pairingFile, 'utf8'))?.key ?? null
  } catch {
    return null
  }
}
