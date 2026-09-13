#!/usr/bin/env node
/**
 * 集成单测：PiMoa 驱动（`scripts/pimoa-review.mjs`）**真的**能把一次审核跑完并如实落盘。
 *
 * 为什么不是"读源码看看"：这个驱动出过两个只有跑起来才看得见的缺陷 ——
 *   1. `structured?.status ?? 'unknown'`：真实回答是「Markdown + 围栏 JSON receipt」，那段
 *      `JSON.parse(block.text)` 必然抛 ⇒ **每份** review 都写着 `裁决：unknown`；
 *   2. 用 `fetch` 调 MCP ⇒ undici 的 300s body 超时会在审核跑完前把请求掐死（实测成功耗时
 *      189–309s，正好贴着墙）。
 * 两者都是"接线"问题，静态检查看不见。这里用一个**本地假 MCP 服务**替掉厂商，端到端验证：
 * 会话 id 有没有带上、SSE 有没有解析、receipt 有没有读出来、正文有没有落盘、`unknown` 有没有消失。
 *
 * 不含任何厂商调用，也不碰真实 8758 端口。
 *
 * 用法：node tests/unit/pimoa-driver.test.mjs
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 220)}`)
}

/** 厂商中立：键与真实 receipt 一致，内容自造。 */
const RECEIPT = {
  mode: 'verify',
  preset: 'moa_verify',
  models: ['vendorA/model-1', 'vendorB/model-2'],
  quorum: '2/2',
  profile: 'verify-worker',
  proposerMarks: { '0:vendorA/model-1': 'completed', '1:vendorB/model-2': 'completed' },
  aggregator: { model: 'vendorC/aggregator', durationMs: 189000, costUsd: 0, usage: {}, sessionId: 's-1', trace: [] },
  bodySha256: 'b'.repeat(64),
  totalCostUsd: 0,
  delivery: { ok: true },
}
const ANSWER_BODY = '## 审核结论\n\n| 级别 | 发现 |\n|---|---|\n| MAJOR | 合成的测试发现 |\n'
const ANSWER = `## receipt\n\n\`\`\`json\n${JSON.stringify(RECEIPT, null, 2)}\n\`\`\`\n\n${ANSWER_BODY}`

/** 假 MCP：记录收到的请求，按 SSE 形态回答。 */
const seen = []
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', (chunk) => { raw += chunk })
  req.on('end', () => {
    let message
    try { message = JSON.parse(raw) } catch { message = { method: 'unparsable' } }
    seen.push({ method: message.method, sessionId: req.headers['mcp-session-id'] ?? null, accept: req.headers.accept ?? null, bytes: Buffer.byteLength(raw) })
    const sse = (payload) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'sess-test' })
      res.end(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
    }
    if (message.method === 'initialize') return sse({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2024-11-05', serverInfo: { name: 'fake-pimoa', version: '0' } } })
    if (message.method === 'notifications/initialized') {
      res.writeHead(202, { 'mcp-session-id': 'sess-test' })
      res.end()
      return
    }
    if (message.method === 'tools/call') {
      // 故意慢一点：证明这条路径不吃 undici 那种"固定 300s"的默认值（时间尺度缩小到 1.5s）
      setTimeout(() => { sse({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: ANSWER }] } }) }, 400)
      return
    }
    sse({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'unknown method' } })
  })
})
await new Promise((res) => { server.listen(0, '127.0.0.1', res) })
const port = server.address().port

const work = mkdtempSync(join(tmpdir(), 'pimoa-driver-'))
const PROMPT = join(work, 'prompt.md')
const CONTEXT = join(work, 'context.md')
const OUT = join(work, 'out.md')
writeFileSync(PROMPT, '用对抗视角审核这份材料。\n')
writeFileSync(CONTEXT, '# 合成材料\n\n这份材料只用于驱动测试。\n')

/** 跑驱动，收集输出。 */
const run = () => new Promise((done) => {
  const child = spawn(process.execPath, [
    join(ROOT, 'scripts/pimoa-review.mjs'),
    '--port', String(port),
    '--prompt-file', PROMPT,
    '--context', CONTEXT,
    '--out', OUT,
    '--timeout-ms', '20000',
  ], { cwd: ROOT })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  child.stderr.on('data', (chunk) => { stderr += chunk })
  child.on('close', (code) => { done({ code, stdout, stderr }) })
})

console.log('1. 驱动端到端跑完（本地假 MCP，代替厂商）')
const run1 = await run()
record('退出码 0', run1.code === 0)
if (run1.code !== 0) console.log(`    stderr: ${run1.stderr.slice(0, 400)}`)
record('报告文件写出来了', existsSync(OUT))
const report = existsSync(OUT) ? readFileSync(OUT, 'utf8') : ''

console.log('\n2. 传输接线：会话与内容类型')
record('initialize 被调用', seen.some((r) => r.method === 'initialize'))
record('tools/call 带上了 initialize 返回的会话 id（不是新开会话）', seen.some((r) => r.method === 'tools/call' && r.sessionId === 'sess-test'))
record('接受 SSE（accept 头如实声明）', seen.filter((r) => r.method === 'tools/call').every((r) => String(r.accept).includes('text/event-stream')))
record('SSE 里的 result 被解析出来了（否则后面不可能有 DONE 之外的内容）', report.includes('合成材料') === false && report.includes('审核结论'))

console.log('\n3. ★ 裁决口径：读 receipt，而不是编一个 unknown')
record('报告里没有 "unknown"', report.includes('unknown') === false)
record('报告里的结果行点明 quorum 2/2', /quorum 2\/2/u.test(report))
record('点明两个 proposer 都 completed', report.includes('0:vendorA/model-1=completed') && report.includes('1:vendorB/model-2=completed'))
record('点明聚合模型', report.includes('vendorC/aggregator'))
record('明说 receipt 里没有 status 字段（不假装有裁决）', report.includes('没有') && report.includes('status'))
record('bodySha256 记下来了（可与正文对账）', report.includes('b'.repeat(64)))
record('stdout 也报了 quorum', /quorum=2\/2/u.test(run1.stdout))

console.log('\n4. 落盘内容：正文进报告，机器字段不留噪声')
record('审核正文在报告里', report.includes('合成的测试发现'))
record('报告里没有 receipt 的 JSON（bodySha256 只在头部那一行出现）', report.split('bodySha256').length === 2)
record('报告头写清了输入材料', report.includes('context.md') && report.includes('prompt.md'))

server.close()
rmSync(work, { recursive: true, force: true })
// 只有布尔 true 算通过
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
