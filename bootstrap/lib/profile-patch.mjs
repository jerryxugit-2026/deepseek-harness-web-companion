/**
 * 幂等地读写 DSH profile 补丁层（`$DSH_HOME/profiles/web/cordis.patch.yml`）里属于本插件的
 * 那一个 `insert` 条目。
 *
 * 为什么需要它（用户 2026-09-12 的原话）：
 * 「这是典型的硬编码问题。我们要在这个版本，彻底检查，变成通过引导程序传入参数。」
 *
 * 现状是**手工**往这个 YAML 里插一行指向 `<下载目录>/dsh-plugin/src/host/index.js` 的绝对路径
 * （HANDOFF 的安装步骤里写着"再然后：手工往 cordis.patch.yml 插一行"）。用户把下载的目录
 * 挪走或删掉，插件立刻失效。本模块把那一行交给引导程序**按参数**写，并且：
 *
 *   1. **幂等** —— 重复运行不产生第二个条目；
 *   2. **最小改动** —— 只动我们那一个条目的 `name:` 与我们管理的 config 键，
 *      文件里别人的条目（semble / codegraph…）与人类写的注释**逐字节不动**；
 *   3. **可逆** —— `removeCompanion()` 只摘掉我们这一条。
 *
 * 本模块**纯文本进、纯文本出**（不碰文件系统），所以能拿用户真实的文件当夹具来断言。
 */

import { parseScalar, yamlScalar } from './yaml-scalar.mjs'

export { yamlScalar }

/** 我们自己写的托管块标记（只有我们写的块才带标记）。 */
export const MARK_BEGIN = '# >>> dsh-web-companion (managed by bootstrap/install.mjs — 不要手改这一块) >>>'
export const MARK_END = '# <<< dsh-web-companion <<<'

/** 顶层列表项的起点：行首的 `- `（YAML 序列项）。 */
const TOP_ITEM = /^-(?:\s|$)/u

/** `id: xxx`（允许行首有 `- `）。 */
function idLinePattern(id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  return new RegExp(`^\\s*-?\\s*id:\\s*${escaped}\\s*$`, 'u')
}

/** 顶层项起点的行号列表。 */
function topItemStarts(all) {
  const out = []
  for (let i = 0; i < all.length; i += 1) if (TOP_ITEM.test(all[i])) out.push(i)
  return out
}

/**
 * 找到含 `id:` 的**那一条**所占的行区间 `[start, end)`。找不到返回 null。
 *
 * ★ 只圈我们这一条，**不圈整个 `- insert:` 段**（2026-09-13 修；PiMoa 片 2 的两条 BLOCKER）。
 *
 * 原来是"段级"范围（start = 段头 `- insert:`、end = 下一个顶层项）。但 DSH 允许**一个
 * `- insert:` 段里装好几条** —— 用户真实的 `cordis.patch.yml` 里那一段就同时装着
 * `mcp-semble` 与 `mcp-codegraph`。段级范围会导出两件坏事：
 *   · `replaceName()` 取的是段内**第一个** `name:` ⇒ 我们的插件路径会覆盖邻居的名字；
 *   · `removeCompanion()` 整段 `splice` ⇒ 卸载时**连带删掉邻居**（用户数据丢失）。
 * 现在 end 停在"下一条同缩进条目"或"更浅缩进"处，两个函数都只动我们这一条。
 */
export function findEntrySpan(text, id) {
  const all = text.split('\n')
  const idAt = all.findIndex((line) => idLinePattern(id).test(line))
  if (idAt === -1) return null
  const entryIndent = /^\s*/u.exec(all[idAt])?.[0] ?? ''
  /*
   * ★ 起点可能不在 `id:` 那一行（2026-09-13 修；PiMoa 片 A 第 11 条）：
   * 手写形状 `- name: …` 换行 `  id: …` 里，条目的破折号行在 `id:` **上面一行**。
   * 不把起点上移的话，那行会被当成"同缩进的邻居" ⇒ 段头摘不掉、卸载后**残留半条**。
   */
  let start = idAt
  // ★ 夹在 `- name:` 与 `id:` 之间的注释行要跳过（2026-09-13 修；PiMoa 片 6a 第 6 条）：
  //   原来直接看 `idAt - 1`，那一行是注释 ⇒ 破折号判据不命中 ⇒ 起点不上移、卸载残留半条。
  let above = idAt - 1
  while (above >= 0 && /^\s*#/u.test(all[above])) above -= 1
  const prev = all[above] ?? ''
  /*
   * ★ 起点上移的判据（2026-09-13 修；PiMoa 片 6a 第 5 条 + 我自己的回归）：
   *   · 不能写死"缩进差 2 空格"（profile 用 4 空格缩进时判据不命中，"卸载后残留半条"原样存在）；
   *   · 也不能只要求"比 `id:` 浅" —— 那样**段头 `- insert:` 自己**会被误当成条目首行
   *     （0 < 4 命中），span 从段头开始、段头又被当成邻居 ⇒ 配套注释摘不掉（§6 两条当场咬出来）。
   * 正确判据：那行必须是带破折号、**比段头深、又比 `id:` 浅**的"条目自己的首行"。
   */
  const starts = topItemStarts(all)
  const headerAt = [...starts].reverse().find((s) => s <= idAt)
  const headerIndent = headerAt === undefined ? -1 : (/^\s*/u.exec(all[headerAt])?.[0] ?? '').length
  const prevIndent = (/^\s*/u.exec(prev)?.[0] ?? '').length
  if (/^\s*-\s/u.test(prev) && prevIndent > headerIndent && prevIndent < entryIndent.length) {
    start = above
  }
  let end = all.length
  for (let i = idAt + 1; i < all.length; i += 1) {
    if (all[i].trim() === '') continue
    const indent = /^\s*/u.exec(all[i])?.[0] ?? ''
    const isSibling = indent.length === entryIndent.length && /^\s*-\s/u.test(all[i])
    if (indent.length < entryIndent.length || isSibling) { end = i; break }
  }
  return { start, end, idAt }
}

/**
 * 含 `id:` 的那条**所在的 `- insert:` 段**（段头 → 下一个顶层项）。
 *
 * `removeCompanion()` 用它判断"摘掉我们之后，段里还有没有邻居条目" —— 一条都不剩时才连段头一起摘，
 * 免得留个空的 `- insert:`；还有邻居时绝不动段头。
 */
export function findSegmentSpan(text, id) {
  const all = text.split('\n')
  const idAt = all.findIndex((line) => idLinePattern(id).test(line))
  if (idAt === -1) return null
  const starts = topItemStarts(all)
  const start = [...starts].reverse().find((s) => s <= idAt)
  if (start === undefined) return null
  const end = starts.find((s) => s > start) ?? all.length
  return { start, end, idAt }
}

/** 读一下当前挂的是什么路径（只读诊断用）。 */
export function readCompanionEntry(text, id) {
  const span = findEntrySpan(text, id)
  if (span === null) return { found: false, entryPath: null, line: null }
  const all = text.split('\n')
  for (let i = span.idAt; i < span.end; i += 1) {
    const m = /^\s*name:\s*(.+?)\s*$/u.exec(all[i])
    if (m !== null) return { found: true, entryPath: unquote(m[1]), line: i + 1 }
  }
  return { found: true, entryPath: null, line: null }
}

function unquote(raw) {
  const t = raw.trim()
  if ((t.startsWith("'") && t.endsWith("'")) || (t.startsWith('"') && t.endsWith('"'))) return t.slice(1, -1)
  return t
}

/** 渲染成 YAML 标量：需要时加单引号（路径里常带空格，必须加）。见 `yaml-scalar.mjs`。 */

/** 渲染我们要写入的托管块。 */
export function renderBlock({ id, entryPath, config = {} }) {
  const out = [
    MARK_BEGIN,
    '- insert:',
    `    - id: ${id}`,
    `      name: ${yamlScalar(entryPath)}`,
  ]
  const keys = Object.keys(config)
  if (keys.length > 0) {
    out.push('      config:')
    for (const key of keys) out.push(`        ${key}: ${yamlScalar(config[key])}`)
  }
  out.push(MARK_END)
  return out
}

/** 在 `config:` 块内 upsert 若干键，保留块内的人类注释与其他键。 */
function upsertConfigKeys(block, config) {
  const out = [...block]
  const keys = Object.keys(config)
  if (keys.length === 0) return out

  const configAt = out.findIndex((line) => /^\s*config:\s*$/u.test(line))
  if (configAt === -1) {
    // 没有 config: 块 —— 追加一个（缩进对齐到 name: 那一行）
    const nameAt = out.findIndex((line) => /^\s*name:\s*/u.test(line))
    const indent = nameAt === -1 ? '      ' : (/^\s*/u.exec(out[nameAt])?.[0] ?? '      ')
    out.push(`${indent}config:`)
    for (const key of keys) out.push(`${indent}  ${key}: ${yamlScalar(config[key])}`)
    return out
  }

  const indent = (/^\s*/u.exec(out[configAt])?.[0] ?? '') + '  '
  for (const key of keys) {
    const re = new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}:\\s*`, 'u')
    const at = out.findIndex((line, i) => i > configAt && re.test(line) && !/^\s*#/u.test(line))
    if (at === -1) out.splice(configAt + 1, 0, `${indent}${key}: ${yamlScalar(config[key])}`)
    else out[at] = `${indent}${key}: ${yamlScalar(config[key])}`
  }
  return out
}

/** 换掉条目里的 `name:` 那一行。 */
function replaceName(block, entryPath) {
  const at = block.findIndex((line) => /^\s*name:\s*/u.test(line))
  if (at === -1) return block
  const indent = /^\s*/u.exec(block[at])?.[0] ?? ''
  const out = [...block]
  out[at] = `${indent}name: ${yamlScalar(entryPath)}`
  return out
}

function blockRange(all) {
  const begin = all.findIndex((line) => line.trim() === MARK_BEGIN)
  if (begin === -1) return null
  const end = all.findIndex((line, i) => i > begin && line.trim() === MARK_END)
  if (end === -1) return null
  return { begin, end }
}

/**
 * 读出块里 `config:` 映射已有的键值（只认我们自己写的那种两级扁平结构）。
 *
 * 用途见 `upsertCompanion()`：整体重渲染托管块之前，先把**上一轮写进去、这一轮没显式传**的键捞回来，
 * 不许静默丢掉（2026-09-13 修；与 2026-09-12 那次 `approvalForWriteOps: false` 丢失事故同型，
 * 也是"装 / 升级合一"能成立的前提）。
 */
function readBlockConfig(lines) {
  const out = {}
  const at = lines.findIndex((line) => /^\s*config:\s*$/u.test(line))
  if (at === -1) return out
  const baseIndent = (/^\s*/u.exec(lines[at])?.[0] ?? '').length
  for (let i = at + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const indent = (/^\s*/u.exec(line)?.[0] ?? '').length
    if (indent <= baseIndent) break
    const m = /^\s*([A-Za-z0-9_.-]+):\s*(.*?)\s*$/u.exec(line)
    if (m === null) continue
    /*
     * ★ **带引号的来源不做类型还原**（2026-09-13 修，PiMoa 片 B 第 5 条）：
     * `parseScalar` 已经把引号剥掉了，再按"长得像数字"还原，就会把上一轮刻意写成
     * `key: '1.0'` / `'007'` 的**字符串**变回数字 `1` / `7` —— 正是这条改动要防的两轮漂移。
     */
    const raw = m[2]
    const wasQuoted = /^['"]/u.test(raw)
    out[m[1]] = wasQuoted ? parseScalar(raw) : rehydrate(parseScalar(raw))
  }
  return out
}

/**
 * 把解析回来的标量还原成合适的 JS 类型。
 *
 * 不做这一步的话，`--set n=5` 写下去的 `5`（数字）下一轮会被当成字符串 `'5'`、再被 `yamlScalar`
 * 加引号成 `'5'` ⇒ 配置在两轮之间自己漂移。
 */
function rehydrate(text) {
  const t = String(text ?? '').trim()
  /*
   * 判据必须与 `yamlScalar()` 的"像数字"**对齐**（2026-09-13 修；PiMoa 片 A 第 8 条 / 6a 第 7 条）：
   * 那边把 `1e5` / `0x10` / `0b101` / `0o17` / 下划线 / `.5` 也算数字外观并加引号；这边如果只认
   * 十进制与 `0x`，用户手写的裸 `k: 0b101` 会被读成字符串、再写成 `'0b101'` ⇒ 配置两轮之间自己漂。
   */
  const bare = t.replaceAll('_', '')
  if (/^[+-]?0[xX][0-9a-fA-F]+$/u.test(bare) || /^[+-]?0[bB][01]+$/u.test(bare) || /^[+-]?0[oO][0-7]+$/u.test(bare)) {
    return Number(bare)
  }
  if (/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u.test(bare)) return Number(bare)
  if (t === 'true') return true
  if (t === 'false') return false
  return t
}

/**
 * 写入/更新本插件的挂载条目。
 *
 * @returns {{ text: string, action: 'inserted'|'updated'|'unchanged', preserved: string[] }}
 *          `preserved` = 从旧块里保留下来、本次没有显式传的 config 键（调用方应如实告诉用户）。
 */
export function upsertCompanion(text, { id, entryPath, config = {} }) {
  const source = text.endsWith('\n') || text === '' ? text : `${text}\n`
  const all = source.split('\n')
  // split 会留一个末尾空串（代表文件末尾的换行），渲染时要把它去掉
  if (all.at(-1) === '') all.pop()

  const managed = blockRange(all)
  if (managed !== null) {
    const existing = all.slice(managed.begin, managed.end + 1)
    /*
     * ★ **先读旧的、再让本次覆盖**（2026-09-13 修，PiMoa 片 2 第 9 条）：
     * 原来直接 `renderBlock({config})` 整体重写，于是"上一轮用 `--set` 写进 profile、
     * 这一轮没显式传"的键会被**静默删除**。真实事故就是 `approvalForWriteOps: false` 这样丢的。
     */
    const merged = { ...readBlockConfig(existing), ...config }
    const preserved = Object.keys(merged).filter((key) => !(key in config))
    const rendered = renderBlock({ id, entryPath, config: merged })
    if (existing.join('\n') === rendered.join('\n')) return { text: source, action: 'unchanged', preserved }
    all.splice(managed.begin, managed.end - managed.begin + 1, ...rendered)
    return { text: `${all.join('\n')}\n`, action: 'updated', preserved }
  }

  const span = findEntrySpan(source, id)
  if (span === null) {
    const rendered = renderBlock({ id, entryPath, config })
    const body = [...all]
    while (body.length > 0 && body.at(-1).trim() === '') body.pop()
    // 文件是空的（或只有空行）时不要凭空加一行前导空行
    const next = body.length > 0 ? [...body, '', ...rendered, ''] : [...rendered, '']
    return { text: next.join('\n'), action: 'inserted', preserved: [] }
  }

  const block = all.slice(span.start, span.end)
  const merged = { ...readBlockConfig(block), ...config }
  const preserved = Object.keys(merged).filter((key) => !(key in config))
  const updated = upsertConfigKeys(replaceName(block, entryPath), merged)
  if (updated.join('\n') === block.join('\n')) return { text: source, action: 'unchanged', preserved }
  all.splice(span.start, span.end - span.start, ...updated)
  return { text: `${all.join('\n')}\n`, action: 'updated', preserved }
}

/** 一条注释行（用于判断条目上方是否是我们/人类写的说明块）。 */
const COMMENT = /^\s*#/u

/**
 * 摘掉本插件的挂载条目。
 *
 * - 我们写的托管块 → 连标记一起摘掉；
 * - 人类手写的条目 → 摘掉该 `insert` 条目本身，**并且**如果它正上方是紧贴着的、
 *   提到 "DSH Web Companion" 的注释块（没有空行隔开），一并摘掉 —— 那正是配套的说明头。
 *
 * @returns {{ text: string, action: 'removed'|'absent' }}
 */
export function removeCompanion(text, { id, dropLeadingComment = true } = {}) {
  const source = text.endsWith('\n') || text === '' ? text : `${text}\n`
  const all = source.split('\n')
  if (all.at(-1) === '') all.pop()

  const managed = blockRange(all)
  if (managed !== null) {
    all.splice(managed.begin, managed.end - managed.begin + 1)
    return { text: `${trimTrailingBlanks(all).join('\n')}\n`, action: 'removed' }
  }

  const span = findEntrySpan(source, id)
  if (span === null) return { text: source, action: 'absent' }

  const segment = findSegmentSpan(source, id)
  let start = span.start
  if (dropLeadingComment) {
    /*
     * ★ 配套说明注释挂在**段头之上**，不是在我们条目之上（2026-09-13 修）——
     * 所以要从段头往上找。原来从 `span.start`（条目那行）往上找，紧邻的是 `- insert:`
     * 这一行、不是注释 ⇒ 永远找不到，说明头就被孤零零留在了文件里。
     */
    let at = (segment?.start ?? span.start) - 1
    let sawComment = false
    let mentions = false
    while (at >= 0 && COMMENT.test(all[at])) {
      sawComment = true
      if (/DSH Web Companion/iu.test(all[at])) mentions = true
      at -= 1
    }
    if (sawComment && mentions) start = at + 1
  }

  /*
   * ★ 邻居感知（2026-09-13 修；PiMoa 片 2 第 2 条 BLOCKER）。
   *
   * `span` 现在只覆盖**我们这一条**。摘掉之后要判断"这个 `- insert:` 段里还有没有别的条目"：
   *   · 一条都不剩 ⇒ 连段头（及段内残留注释）一起摘，别留个空的 `- insert:`；
   *   · 还有邻居 ⇒ **只摘我们这一条**，段头和邻居一字不动（原来整段 `splice`，会把
   *     `mcp-semble` / `mcp-codegraph` 一起删掉 —— 用户真实文件里它们就在同一段）。
   */
  /*
   * ★ "邻居条目"必须**与条目本身同缩进**才算。第一版漏了这个约束：`args:` 下面的
   * `- --liftoff-only` 也匹配 `/^\s*-\s/`，于是我方段被判成"还有邻居"、段头摘不掉
   * （`profile-patch.test.mjs` 第 6 节当场咬出来）。
   */
  /*
   * 缩进取**条目自己那行**（`span.start`）—— 手写 `- name:` / `id:` 形状下，破折号行的缩进
   * 比 `id:` 少两格；用 `idAt` 的缩进去找邻居会一个都找不到（2026-09-13 修）。
   */
  const entryIndent = (/^\s*/u.exec(all[span.start])?.[0] ?? '').length
  const siblings = segment === null
    ? []
    : all
        .slice(segment.start, segment.end)
        .filter((line) => {
          const indent = (/^\s*/u.exec(line)?.[0] ?? '').length
          return indent === entryIndent && /^\s*-\s/u.test(line) && !idLinePattern(id).test(line)
        })

  // 段里一条都不剩 ⇒ 连段头**和它上面那几行配套说明注释**一起摘（注释在段头之上）
  const segmentStart = segment === null ? start : Math.min(start, segment.start)
  if (segment !== null && siblings.length === 0) {
    all.splice(segmentStart, segment.end - segmentStart)
  } else {
    /*
     * ★ 还有邻居时**只从我们自己这一条开始删**（2026-09-13 修，PiMoa 片 B 第 1 条）。
     *
     * 原来这里删的是 `start` —— 而 `start` 可能已被上面的"配套注释"逻辑拉到**段头之上**。
     * 于是"段头上方恰好有一行提到本插件的注释"＋"段里还有邻居"这两个条件同时成立时，
     * `splice(start, …)` 会把 `- insert:` 段头和**排在我们前面的邻居**一起删掉 ——
     * 跟这条改动本来要消灭的数据丢失是同一类，只是触发条件更窄。
     */
    all.splice(span.start, span.end - span.start)
  }
  return { text: `${trimTrailingBlanks(all).join('\n')}\n`, action: 'removed' }
}

function trimTrailingBlanks(all) {
  const out = [...all]
  while (out.length > 0 && out.at(-1).trim() === '') out.pop()
  return out
}

/** 摘要：当前挂载状态（给 dry-run / 卸载预览用）。 */
export function describeCompanion(text, { id }) {
  const all = text.split('\n')
  const managed = blockRange(all) !== null
  const entry = readCompanionEntry(text, id)
  return { managed, ...entry }
}

/**
 * 决定要写进 profile 挂载条目的 config。
 *
 * ★ 这里编码了用户的两条决定，以及一次**真实事故**的教训：
 *
 * 1. **抓取落盘目录：新装用英文名、老装保留原名。**
 *    老装（`freshInstall === false`）**完全不写 `attachDir`** —— 于是插件用它自己的默认值
 *    `网页捕获`，历史 `@网页捕获/…` 引用继续有效。新装才写 `captures`（英文版发行默认）。
 *
 * 2. **不许静默丢掉用户显式设过的 config。**
 *    2026-09-12 真事故（**本安装器自己造成的**）："卸载 → 重装"往返把用户 profile 里的
 *    `approvalForWriteOps: false` **悄悄丢了**（卸载删掉整条，重装只写自己管的键），
 *    于是 `/ag/control` 的 `approvalMode` 从 `off` 变回 `ask`；而这台机器的会话策略是 `never`，
 *    写操作会因此被当场拒绝。所以"用户设过的键"必须能**显式传进来**，而不是靠猜。
 *
 * @param {object} o
 * @param {boolean} o.freshInstall          profile 里原本没有我们这一条
 * @param {boolean|undefined} o.approvalForWriteOps  显式指定时写进去；undefined = 不写/不动
 * @param {Record<string, string|number|boolean>} [o.extra]  额外的 `--set key=value`
 */
export function buildMountConfig({ freshInstall, approvalForWriteOps, extra = {} }) {
  const config = {}
  // 新装才给英文目录名；老装留空 ⇒ 用插件默认值（中文名），历史引用不失效
  if (freshInstall === true) config.attachDir = 'captures'
  if (typeof approvalForWriteOps === 'boolean') config.approvalForWriteOps = approvalForWriteOps
  for (const [key, value] of Object.entries(extra)) config[key] = value
  return config
}

/** 本安装器自己管理的 config 键（用于 dry-run 里如实说明"哪些键由我负责"）。 */
export const MANAGED_CONFIG_KEYS = ['attachDir', 'approvalForWriteOps']
