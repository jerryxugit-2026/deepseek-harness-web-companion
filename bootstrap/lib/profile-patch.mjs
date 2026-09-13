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

import { yamlScalar } from './yaml-scalar.mjs'

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
 * 找到含 `id:` 的那个顶层 `insert` 条目所占的行区间 `[start, end)`。
 * 找不到返回 null。
 */
export function findEntrySpan(text, id) {
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
 * 写入/更新本插件的挂载条目。
 *
 * @returns {{ text: string, action: 'inserted'|'updated'|'unchanged' }}
 */
export function upsertCompanion(text, { id, entryPath, config = {} }) {
  const source = text.endsWith('\n') || text === '' ? text : `${text}\n`
  const all = source.split('\n')
  // split 会留一个末尾空串（代表文件末尾的换行），渲染时要把它去掉
  if (all.at(-1) === '') all.pop()

  const managed = blockRange(all)
  if (managed !== null) {
    const rendered = renderBlock({ id, entryPath, config })
    const current = all.slice(managed.begin, managed.end + 1)
    if (current.join('\n') === rendered.join('\n')) return { text: source, action: 'unchanged' }
    all.splice(managed.begin, managed.end - managed.begin + 1, ...rendered)
    return { text: `${all.join('\n')}\n`, action: 'updated' }
  }

  const span = findEntrySpan(source, id)
  if (span === null) {
    const rendered = renderBlock({ id, entryPath, config })
    const body = [...all]
    while (body.length > 0 && body.at(-1).trim() === '') body.pop()
    // 文件是空的（或只有空行）时不要凭空加一行前导空行
    const next = body.length > 0 ? [...body, '', ...rendered, ''] : [...rendered, '']
    return { text: next.join('\n'), action: 'inserted' }
  }

  const block = all.slice(span.start, span.end)
  const updated = upsertConfigKeys(replaceName(block, entryPath), config)
  if (updated.join('\n') === block.join('\n')) return { text: source, action: 'unchanged' }
  all.splice(span.start, span.end - span.start, ...updated)
  return { text: `${all.join('\n')}\n`, action: 'updated' }
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

  let start = span.start
  if (dropLeadingComment) {
    let at = start - 1
    let sawComment = false
    let mentions = false
    while (at >= 0 && COMMENT.test(all[at])) {
      sawComment = true
      if (/DSH Web Companion/iu.test(all[at])) mentions = true
      at -= 1
    }
    if (sawComment && mentions) start = at + 1
  }

  all.splice(start, span.end - start)
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
