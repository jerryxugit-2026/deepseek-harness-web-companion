/**
 * YAML 标量的最小渲染器 —— 只处理我们需要的那几种（字符串/数字/布尔）。
 *
 * 为什么要它：写进 profile patch 的插件路径**含空格**（`/Users/mac/ai_tools/dsh project/...`），
 * 不引号会变成非法 YAML；而用户粘进来的 API key 可能含 `#`、`:` 等字符。
 * 宁可多引一层引号，也不要写出一个解析不了的配置。
 */

/** 需要引号的情况：空串、首尾空格、含 YAML 有特殊含义的字符、或长得像别的类型。 */
export function yamlScalar(value) {
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  const s = String(value)
  if (s === '') return "''"
  const plain = /^[A-Za-z0-9_./+-]+$/u.test(s)
    && !/^(true|false|null|yes|no|on|off|~)$/iu.test(s)
    && !/^[+-]?\d+(\.\d+)?$/u.test(s)
    && s.trim() === s
  if (plain) return s
  return `'${s.replaceAll("'", "''")}'`
}

/** 解析一个 YAML 标量（去掉外层引号、还原转义的单引号）。 */
export function parseScalar(raw) {
  const t = String(raw ?? '').trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1)
  return t
}
