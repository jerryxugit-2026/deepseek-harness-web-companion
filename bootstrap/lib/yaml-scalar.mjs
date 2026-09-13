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
  if (/[\u0000-\u001f\u007f\u0085\u2028\u2029]/u.test(s)) {
    /*
     * ★ 兜底转义**所有** C0/DEL 控制字符（2026-09-13 修；PiMoa 片 A 第 10 条 / 片 C 第 10 条）：
     * 原来只转 `\n \r \t " \\`，判据却匹配整段 `[\u0000-\u001f\u007f]` ⇒ `\u0007`、`\u007f`
     * 这类会被**原样**写进双引号标量，仍是非法 YAML。
     */
    const escaped = s.replace(/[\u0000-\u001f\u007f\u0085\u2028\u2029"\\]/gu, (ch) => {
      if (ch === '\n') return '\\n'
      if (ch === '\r') return '\\r'
      if (ch === '\t') return '\\t'
      if (ch === '"') return '\\"'
      if (ch === '\\') return '\\\\'
      return `\\x${ch.codePointAt(0).toString(16).padStart(2, '0')}`
    })
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
    // ★ 日期/时间外观也要加引号（2026-09-13 修，PiMoa 片 B 第 14 条）：`2024-01-15` 的字符
    //   全在白名单里、也过不了上面那几条数字判据 ⇒ 会被写成裸标量，而 YAML 解析器读成日期。
    || /^\d{4}-\d{1,2}-\d{1,2}([Tt ].*)?$/u.test(s)
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
    // 单趟反转义：`\n` `\r` `\t` `\"` `\\`，以及兜底写出的 `\xNN`
    // （★ 2026-09-13 修；PiMoa 片 6b 第 5 条：写出端有 `\xNN`、读回端不认 ⇒ 值两轮之间自漂）
    return t.slice(1, -1).replace(/\\x([0-9a-fA-F]{2})|\\u([0-9a-fA-F]{4})|\\(.)/gu,
      (_, hex2, hex4, ch) => (hex2 !== undefined
        ? String.fromCodePoint(Number.parseInt(hex2, 16))
        : hex4 !== undefined
          ? String.fromCodePoint(Number.parseInt(hex4, 16))
          : (ch === 'n' ? '\n' : ch === 'r' ? '\r' : ch === 't' ? '\t' : ch)))
  }
  return t
}
