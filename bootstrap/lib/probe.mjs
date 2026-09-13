/**
 * 体检用的**事实探测**（I/O 都在这儿，判定在 `checks.mjs`）。
 *
 * 单独一层是为了让"怎么判定"能被单测钉住，而"怎么探测"跟着环境走。
 */
import { execFileSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname } from 'node:path'

/** `command -v <cmd>` —— 自己实现，避免依赖 shell 类型。 */
export function which(cmd) {
  try {
    const out = execFileSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return out === '' ? null : out
  } catch {
    return null
  }
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

/** 端口上有没有人在 LISTEN（用 lsof；macOS 自带）。 */
export function portListening(port) {
  try {
    const out = execFileSync('lsof', ['-nP', `-iTCP:${String(port)}`, '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    return out.trim() !== ''
  } catch {
    return false // lsof 无输出时退出码非零 ⇒ 没人在听
  }
}

/** 本插件在不在这个端口上、配对没有。 */
export async function pingPlugin(port, key) {
  try {
    const url = `http://127.0.0.1:${String(port)}/ag/ping${typeof key === 'string' && key !== '' ? `?key=${encodeURIComponent(key)}` : ''}`
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) })
    const body = await res.json()
    return { reachable: true, paired: body?.paired === true, plugin: body?.plugin ?? null, connectedClients: body?.connectedClients ?? null }
  } catch {
    return { reachable: false, paired: false, plugin: null, connectedClients: null }
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
    return 'missing'
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
