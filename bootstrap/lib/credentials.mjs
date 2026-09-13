/**
 * `$DSH_HOME/.credentials.yaml` 的**定点**读写：只碰 `refs:` 里的某一个键。
 *
 * 为什么必须定点（而不是"解析整个 YAML 再写回去"）：
 *
 * 1. 那个文件里除了模型 API key，还住着 `records.client-connection/browser-session`
 *    —— **本插件签发登录 cookie 就靠这条记录**（`dsh-plugin/src/host/cookie.js` 读它）。
 *    整体重写一旦丢字段，插件当场失效，而且症状会表现为"面板连不上"，很难查。
 * 2. 用户机器上还有别的 key（ANTHROPIC_API_KEY / CLIPROXY_API_KEY…），都不是我们该动的。
 * 3. DSH **没有**自带的设置 key 的命令（实测 `dsh --help` 只有 `web` 与 `plugin`），
 *    所以引导程序只能自己写这个文件 —— 那就更要写得保守。
 *
 * 本模块**纯文本进、纯文本出**，不碰文件系统（备份与 0600 权限由调用方负责）。
 */
import { parseScalar, yamlScalar } from './yaml-scalar.mjs'

/** 引导程序要写的键名（DSH 读的是这个引用名）。 */
export const DEEPSEEK_KEY_REF = 'DEEPSEEK_API_KEY'

/** 找顶层 `refs:` 块的行区间 `[contentStart, contentEnd)`（不含 `refs:` 那一行）。 */
function refsRange(all) {
  const at = all.findIndex((line) => /^refs:\s*$/u.test(line))
  if (at === -1) return null
  let end = at + 1
  while (end < all.length) {
    const line = all[end]
    if (line.trim() !== '' && !/^\s/u.test(line)) break
    end += 1
  }
  return { at, start: at + 1, end }
}

/** 读 `refs:` 里出现的键名（不回显值 —— 值可能是密钥）。 */
export function readRefKeys(text) {
  const all = text.split('\n')
  const range = refsRange(all)
  if (range === null) return []
  const keys = []
  for (let i = range.start; i < range.end; i += 1) {
    const m = /^\s+([A-Za-z0-9_]+):/u.exec(all[i])
    if (m !== null) keys.push(m[1])
  }
  return keys
}

/** 读某个键的值（引导程序用它判断"是不是已经是这个 key 了"）。 */
export function readRef(text, keyName) {
  const all = text.split('\n')
  const range = refsRange(all)
  if (range === null) return null
  for (let i = range.start; i < range.end; i += 1) {
    const m = new RegExp(`^\\s+${keyName}:\\s*(.*)$`, 'u').exec(all[i])
    if (m !== null) return parseScalar(m[1])
  }
  return null
}

/**
 * 写入/更新 `refs.<keyName>`。
 *
 * @returns {{ text: string, action: 'updated'|'inserted'|'unchanged', keys: string[] }}
 */
export function upsertRef(text, keyName, value) {
  const source = text.endsWith('\n') || text === '' ? text : `${text}\n`
  const all = source.split('\n')
  if (all.at(-1) === '') all.pop()

  const rendered = yamlScalar(value)
  const range = refsRange(all)

  if (range === null) {
    /*
     * 连 `refs:` 都没有 —— 新建一个。
     *
     * 插在 `records:` **之前**，而不是简单追加到文件末尾。两个理由：
     *  1. `records:` 那段（含签发 cookie 用的 browser-session 记录）保持是文件尾段，
     *     "它有没有被动过"就是一个干净的区域比较，而不是"一直比到 EOF"；
     *  2. 人读起来也顺：refs 是简单映射，records 是嵌套结构。
     */
    const recordsAt = all.findIndex((line) => /^records:\s*$/u.test(line))
    const block = ['refs:', `  ${keyName}: ${rendered}`]
    if (recordsAt !== -1) {
      all.splice(recordsAt, 0, ...block)
    } else {
      while (all.length > 0 && all.at(-1).trim() === '') all.pop()
      if (all.length > 0) all.push('')
      all.push(...block)
    }
    const out = `${all.join('\n')}\n`
    return { text: out, action: 'inserted', keys: readRefKeys(out) }
  }

  const re = new RegExp(`^(\\s+)${keyName}:\\s*(.*)$`, 'u')
  for (let i = range.start; i < range.end; i += 1) {
    const m = re.exec(all[i])
    if (m === null) continue
    if (parseScalar(m[2]) === String(value)) {
      return { text: source, action: 'unchanged', keys: readRefKeys(source) }
    }
    all[i] = `${m[1]}${keyName}: ${rendered}`
    const out = `${all.join('\n')}\n`
    return { text: out, action: 'updated', keys: readRefKeys(out) }
  }

  // 键不存在：插到 refs: 块的最后一行非空行之后，缩进照抄兄弟键
  let indent = '  '
  let insertAt = range.start
  for (let i = range.start; i < range.end; i += 1) {
    const m = /^(\s+)[A-Za-z0-9_]+:/u.exec(all[i])
    if (m !== null) { indent = m[1]; insertAt = i + 1 }
  }
  all.splice(insertAt, 0, `${indent}${keyName}: ${rendered}`)
  const out = `${all.join('\n')}\n`
  return { text: out, action: 'inserted', keys: readRefKeys(out) }
}

/**
 * 把 `records:` 那一段原样切出来（单测用它证明"没被动过"）。
 *
 * 段边界取到**下一个顶层键**（行首非空白且以字母/下划线开头），而不是一直切到 EOF ——
 * 否则"在我们之后追加的东西"会落进这个片里，让断言看起来像"records 被动过"。
 */
export function recordsSection(text) {
  const all = text.split('\n')
  const at = all.findIndex((line) => /^records:\s*$/u.test(line))
  if (at === -1) return null
  let end = at + 1
  while (end < all.length && !/^[A-Za-z_]/u.test(all[end])) end += 1
  return all.slice(at, end).join('\n').trimEnd()
}
