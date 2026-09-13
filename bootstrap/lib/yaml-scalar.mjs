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
  /*
   * ★ 含控制字符（换行/回车/制表…）**必须走双引号 + 转义**（2026-09-13 修；PiMoa 片 2 第 14 条）：
   * 单引号风格里塞一个真换行，在 `refs:` 那种两空格缩进下续行会落到列 0 ⇒ 整个
   * `.credentials.yaml` 可能直接解析不了。双引号风格是 YAML 里能安全表达控制字符的写法。
   */
  if (/[\u0000-\u001f\u007f]/u.test(s)) {
    const escaped = s
      .replaceAll('\\', '\\\\')
      .replaceAll('"', '\\"')
      .replaceAll('\n', '\\n')
      .replaceAll('\r', '\\r')
      .replaceAll('\t', '\\t')
    return `"${escaped}"`
  }
  /*
   * ★ "像数字"的判据要放宽（2026-09-13 修；PiMoa 片 2 第 15 条）：原来的
   * `/^[+-]?\d+(\.\d+)?$/` 挡不住 `1e5` / `0x10` / `.5`，而字符集允许它们 ⇒
   * 下游 YAML 解析器会把 `sk-...` 之类的**字符串**读成数字。
   */
  const looksNumeric = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u.test(s)
    || /^0[xXoObB][0-9a-fA-F_]+$/u.test(s)
    || /^[+-]?\.(inf|nan)$/iu.test(s)
  const plain = /^[A-Za-z0-9_./+-]+$/u.test(s)
    && !/^(true|false|null|yes|no|on|off|~)$/iu.test(s)
    && !looksNumeric
    && s.trim() === s
  if (plain) return s
  return `'${s.replaceAll("'", "''")}'`
}

/** 解析一个 YAML 标量（去掉外层引号、还原转义的单引号与双引号转义）。 */
export function parseScalar(raw) {
  const t = String(raw ?? '').trim()
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replaceAll("''", "'")
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    // 单趟反转义：`\n` `\r` `\t` `\"` `\\`（分步 replaceAll 会把 `\\n` 误当成换行）
    return t.slice(1, -1).replace(/\\(.)/gu, (_, ch) => (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch))
  }
  return t
}
