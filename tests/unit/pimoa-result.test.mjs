#!/usr/bin/env node
/**
 * 单测：PiMoa 结果的解析与"裁决"口径（`scripts/pimoa-result.mjs`）。
 *
 * 由来（v3.41 的 P2 项）：`scripts/pimoa-review.mjs` 用
 * `structured?.status ?? structured?.result?.status ?? 'unknown'` 判裁决，而 `structured` 来自
 * `JSON.parse(block.text)` —— 真实的 PiMoa 回答是**「Markdown + 围栏 JSON receipt」**，那段 JSON.parse
 * 必然抛，于是**每一份** review 都带着 `裁决（status）：unknown` 落进仓库。`unknown` 读起来像"工具没说"，
 * 但对着真实 receipt 核对（`~/.pimoa/spool`）后发现：**工具根本没有 status 字段**，它给的是
 * `quorum` 与每个 proposer 的 `proposerMarks`；这两样被整块丢掉了。
 *
 * 本测试用**合成**的 receipt（键与真实一致，内容自造，不夹带任何厂商输出）钉住三件事：
 *   1. 围栏 JSON 能被读出来（原来读不出）；
 *   2. 没有 receipt 时 status 是 **null**（不是编出来的 'unknown'）；
 *   3. quorum / proposerMarks / 聚合模型 / 耗时 / 成本照实读出并写进摘要行。
 *
 * 用法：node tests/unit/pimoa-result.test.mjs
 */
import { bodyOf, describeReceipt, receiptOf, summaryLine } from '../../scripts/pimoa-result.mjs'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 200)}`)
}

/** 与真实 receipt 同键的合成样本。 */
const RECEIPT = {
  mode: 'verify',
  preset: 'moa_verify',
  models: ['vendorA/model-1', 'vendorB/model-2'],
  quorum: '2/2',
  profile: 'verify-worker',
  proposerMarks: { '0:vendorA/model-1': 'completed', '1:vendorB/model-2': 'completed' },
  aggregator: { model: 'vendorC/aggregator', usage: { input: 1, output: 2 }, costUsd: 0, durationMs: 189000, sessionId: 's-1', trace: [] },
  bodySha256: 'a'.repeat(64),
  totalCostUsd: 0,
  delivery: { ok: true },
}

const ANSWER = [
  '## receipt',
  '',
  '```json',
  JSON.stringify(RECEIPT, null, 2),
  '```',
  '',
  '## 审核结论',
  '',
  '第 1 条发现……',
].join('\n')

console.log('1. 围栏 JSON receipt 必须能读出来（旧代码在这里必然抛）')
const receipt = receiptOf(ANSWER)
record('读到了 receipt', receipt !== null && typeof receipt === 'object')
record('quorum 原样读出', receipt?.quorum === '2/2')
record('两个 proposer 的标记都在', Object.keys(receipt?.proposerMarks ?? {}).length === 2)

console.log('\n2. 正文与 receipt 分离（review 文档里不该塞一份机器字段）')
const body = bodyOf(ANSWER)
record('正文保留了审核结论', body.includes('第 1 条发现'))
record('正文里没有 receipt 的 JSON', body.includes('bodySha256') === false)
record('正文里没有多余的 receipt 标题', /(^|\n)#{1,6}\s*receipt\s*($|\n)/u.test(body) === false)

console.log('\n3. 没有 receipt 时**不许编裁决**')
const empty = describeReceipt(null)
record('status 是 null（不是字符串 "unknown"）', empty.status === null)
record('摘要行说明"receipt 缺失"，而不是报一个状态', /receipt 缺失/u.test(summaryLine(null)))
record('退化的纯文本也能处理（正文仍在）', bodyOf('只有正文') === '只有正文' && receiptOf('只有正文') === null)
record('坏 JSON 不抛，只是没有 receipt', receiptOf('```json\n{ 坏 }\n```') === null)

console.log('\n4. 真实字段照实读出（这才是可核对的证据）')
const info = describeReceipt(receipt)
record('quorum=2/2', info.quorum === '2/2')
record('两个模型名都在', info.models.length === 2)
record('聚合模型读得出', info.aggregator?.model === 'vendorC/aggregator')
record('耗时读得出（189s）', info.durationMs === 189000)
record('成本读得出（0）', info.costUsd === 0)
record('bodySha256 读得出（可与正文对账）', info.bodySha256 === 'a'.repeat(64))
record('proposerMarks 逐条保留', Object.values(info.proposerMarks).every((mark) => mark === 'completed'))

console.log('\n5. 摘要行：说明"没 status"，并把真正的证据摊开')
const line = summaryLine(receipt)
record('点了 quorum', line.includes('quorum 2/2'))
record('点了每个 proposer 的完成标记', line.includes('0:vendorA/model-1=completed') && line.includes('1:vendorB/model-2=completed'))
record('点了聚合模型', line.includes('vendorC/aggregator'))
record('明说 receipt 里没有 status（不再假装有个裁决）', line.includes('没有') && line.includes('status'))
record('真给了 status 时原样采用', summaryLine({ ...RECEIPT, status: 'pass' }) === '**pass**')

// 只有布尔 true 算通过
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
