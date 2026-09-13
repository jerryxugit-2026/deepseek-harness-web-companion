/**
 * Read one PiMoa tool answer (pure, no network) — used by `scripts/pimoa-review.mjs`.
 *
 * Why this is its own module: the driver used to decide the verdict with
 *
 *     structured?.status ?? structured?.result?.status ?? 'unknown'
 *
 * where `structured` came from `JSON.parse(block.text)`. A real PiMoa answer is **Markdown with a
 * fenced JSON receipt inside** (`## receipt` + ```json … ```), so that parse always threw, the
 * fallback was always taken, and every review landed in the repo with `裁决（status）：unknown` —
 * a value that reads like "the tool refused to say", while the tool simply has no such field
 * (checked against real receipts in `~/.pimoa/spool`, 2026-09-12). The quorum and the per-model
 * proposer marks ARE in the receipt and were being thrown away.
 *
 * Keeping the parsing here makes it testable without spending a vendor round-trip.
 */

/** The first fenced JSON block, parsed. `null` when there is none / it is not JSON. */
export function receiptOf(text) {
  const match = /```json\s*\n([\s\S]*?)\n```/u.exec(String(text ?? ''))
  if (match === null) return null
  try {
    const parsed = JSON.parse(match[1])
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch { return null }
}

/** The answer with the receipt block removed (what belongs in the review document). */
export function bodyOf(text, receipt = receiptOf(text)) {
  const raw = String(text ?? '')
  if (receipt === null) return raw.trim()
  return raw.replace(/```json\s*\n[\s\S]*?\n```/u, '').replace(/^#{1,6}\s*receipt\s*$/gmu, '').trim()
}

/**
 * The honest summary of one answer.
 *
 * `status` is passed through **only when the receipt really has it** — `null` otherwise. There is
 * deliberately no `'unknown'` default: a made-up value is what turned an absent field into a
 * reported verdict.
 */
export function describeReceipt(receipt) {
  if (receipt === null || receipt === undefined) {
    return { status: null, quorum: null, models: [], proposerMarks: {}, aggregator: null, durationMs: null, costUsd: null, bodySha256: null, delivery: null }
  }
  const aggregator = receipt.aggregator ?? null
  return {
    status: typeof receipt.status === 'string' ? receipt.status : null,
    quorum: typeof receipt.quorum === 'string' ? receipt.quorum : null,
    models: Array.isArray(receipt.models) ? receipt.models.filter((m) => typeof m === 'string') : [],
    proposerMarks: receipt.proposerMarks !== null && typeof receipt.proposerMarks === 'object' ? receipt.proposerMarks : {},
    aggregator: aggregator === null ? null : { model: aggregator.model ?? null, durationMs: typeof aggregator.durationMs === 'number' ? aggregator.durationMs : null },
    durationMs: typeof aggregator?.durationMs === 'number' ? aggregator.durationMs : null,
    costUsd: typeof receipt.totalCostUsd === 'number' ? receipt.totalCostUsd : null,
    bodySha256: typeof receipt.bodySha256 === 'string' ? receipt.bodySha256 : null,
    delivery: receipt.delivery ?? null,
  }
}

/** One markdown line that says what actually happened, without inventing a verdict. */
export function summaryLine(receipt) {
  const info = describeReceipt(receipt)
  if (info.status !== null) return `**${info.status}**`
  const parts = []
  if (info.quorum !== null) parts.push(`quorum ${info.quorum}`)
  const marks = Object.entries(info.proposerMarks).map(([who, mark]) => `${who}=${String(mark)}`)
  if (marks.length > 0) parts.push(marks.join(' '))
  if (info.aggregator?.model != null) parts.push(`聚合 ${String(info.aggregator.model)}`)
  if (info.durationMs !== null) parts.push(`${(info.durationMs / 1000).toFixed(1)}s`)
  if (info.costUsd !== null) parts.push(`$${String(info.costUsd)}`)
  return parts.length === 0
    ? '（receipt 缺失：只有正文，没有可核对的结构化字段）'
    : `${parts.join('、')} —— receipt 里**没有** status 字段，这里不编一个`
}
