#!/usr/bin/env node
/**
 * PiMoa adversarial review driver.
 *
 * PiMoa runs locally as an MCP server over HTTP (default 127.0.0.1:8758/mcp) and
 * exposes three tools: moa_run (synthesize), moa_verify (read-only adversarial
 * verification), moa_deliver (synthesize + deterministic file delivery).
 *
 * This driver feeds it a document set and writes the verdict to docs/reviews/.
 *
 * Usage:
 *   node scripts/pimoa-review.mjs --prompt-file scripts/review-prompts/design-adversarial.md \
 *        --context 详细设计文档.md docs/REVIEW-v3.0.md \
 *        --out docs/reviews/pimoa-design-v3.0.md [--tool moa_verify] [--port 8758]
 *
 * Notes:
 *  - `moa_verify` is read-only and fail-closed: if any verifier fails, the whole
 *    call fails and nothing is produced — that is by design, not a bug.
 *  - Documents are passed as text context (not `files`), because the running
 *    PiMoa instance's cwd is its own directory, not this project.
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describeOffenders, findSecretFiles } from './material-guard.mjs'
import { bodyOf, describeReceipt, receiptOf, summaryLine } from './pimoa-result.mjs'
import { request } from 'node:http'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const at = args.indexOf(`--${name}`)
  return at === -1 ? fallback : args[at + 1]
}
const listOf = (name) => {
  const values = []
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== `--${name}`) continue
    for (let j = i + 1; j < args.length && !args[j].startsWith('--'); j += 1) values.push(args[j])
  }
  return values
}

const TOOL = argOf('tool', 'moa_verify')
const PORT = argOf('port', '8758')
const PROMPT_FILE = argOf('prompt-file', '')
const CONTEXT_FILES = listOf('context')
const OUT = argOf('out', join('docs', 'reviews', `pimoa-${TOOL}-${String(Date.now())}.md`))
const TIMEOUT_MS = Number(argOf('timeout-ms', '600000'))
const URL = `http://127.0.0.1:${PORT}/mcp`

if (PROMPT_FILE === '') throw new Error('--prompt-file is required')
if (CONTEXT_FILES.length === 0) throw new Error('--context requires at least one file')

const read = (path) => readFileSync(resolve(ROOT, path), 'utf8')

/*
 * 上网之前先过材料卫生守卫。
 *
 * 真事故（2026-09-12）：这个脚本把 `--context` 的文件逐字读进来当材料，而 `moa_verify` 会把
 * 材料送给模型厂商。我的分片命令里带了 `scripts/`，于是 `scripts/.dev-extension-key.json`
 * （RSA-2048 私钥；其 publicKeyDer 与 manifest.key 逐字相同、推导出的扩展 ID 就是本扩展的 ID）
 * 被外发。守卫在**任何网络请求之前**中止，并故意不提供强制放行开关。
 */
const offenders = findSecretFiles(CONTEXT_FILES, read)
if (offenders.length > 0) {
  console.error(describeOffenders(offenders))
  process.exit(2)
}

/**
 * One JSON-RPC POST; the HTTP transport answers with an SSE stream.
 *
 * Uses `node:http` rather than `fetch` **on purpose**: undici (what `fetch` is in Node) applies a
 * hard 300s body timeout, and a `moa_verify` call over a real document set takes minutes — the
 * successful runs measured 189–309s, i.e. right at that wall, and anything slower died as
 * `TypeError: fetch failed` after the vendor had already been paid. `node:http` has no such
 * default, so `--timeout-ms` is the only clock in play.
 */
function rpc(body, sessionId) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const headers = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'content-length': Buffer.byteLength(payload),
    }
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId
    const call = request({ host: '127.0.0.1', port: PORT, path: '/mcp', method: 'POST', headers }, (response) => {
      let text = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { text += chunk })
      response.on('end', () => {
        const messages = text
          .split('\n')
          .filter((line) => line.startsWith('data: '))
          .map((line) => { try { return JSON.parse(line.slice(6)) } catch { return undefined } })
          .filter((value) => value !== undefined)
        resolve({ sessionId: response.headers['mcp-session-id'] ?? sessionId, status: response.statusCode, messages, raw: text })
      })
    })
    // 静默上限（socket 无数据）：审核期间服务端可能长时间不发字节，所以这里用 --timeout-ms 而不是
    // 一个写死的短超时；超时后给出原因，而不是让进程悬着。
    call.setTimeout(TIMEOUT_MS, () => {
      call.destroy(Object.assign(new Error(`PiMoa 在 ${String(TIMEOUT_MS)}ms 内没有任何响应（可用 --timeout-ms 调大）`), { code: 'E_TIMEOUT' }))
    })
    call.on('error', reject)
    call.end(payload)
  })
}

const contextBody = CONTEXT_FILES
  .map((path) => `# ===== FILE: ${path} =====\n\n${read(path)}`)
  .join('\n\n')

const prompt = read(PROMPT_FILE)

console.log(`[pimoa] tool=${TOOL} port=${PORT} context=${String(CONTEXT_FILES.length)} files`)
const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'dsh-web-companion', version: '0.1.0' } } })
if (init.status !== 200) throw new Error(`initialize failed: HTTP ${String(init.status)} ${init.raw.slice(0, 200)}`)
await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, init.sessionId)

const started = Date.now()
const call = await rpc({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: TOOL, arguments: { prompt, context: contextBody } },
}, init.sessionId)
const elapsed = Date.now() - started

const result = call.messages.find((m) => m.id === 2)
if (result === undefined) {
  throw new Error(`no tool result (HTTP ${String(call.status)}): ${call.raw.slice(0, 400)}`)
}
if (result.error !== undefined) {
  throw new Error(`tool error: ${JSON.stringify(result.error).slice(0, 400)}`)
}

/** MCP tool results carry content blocks; the answer is Markdown with a fenced JSON receipt. */
const blocks = result.result?.content ?? []
const textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')

const receipt = receiptOf(textOut)
const info = describeReceipt(receipt)
const bodyText = bodyOf(textOut, receipt)
const header = [
  '# PiMoa 对抗性审核结果',
  '',
  `- 工具：\`${TOOL}\``,
  `- 端点：\`${URL}\``,
  `- 输入：${CONTEXT_FILES.map((f) => `\`${f}\``).join('、')}`,
  `- prompt：\`${PROMPT_FILE}\``,
  `- 用时：${(elapsed / 1000).toFixed(1)}s`,
  `- 结果：${summaryLine(receipt)}`,
  ...(info.bodySha256 === null ? [] : [`- bodySha256：\`${info.bodySha256}\`（可与正文对账）`]),
  `- 生成时间：${new Date().toISOString()}`,
  '',
  '---',
  '',
].join('\n')

mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true })
writeFileSync(resolve(ROOT, OUT), `${header}${bodyText}\n`)
console.log(`[pimoa] quorum=${String(info.quorum)} models=${String(info.models.length)} elapsed=${(elapsed / 1000).toFixed(1)}s → ${OUT}`)
console.log(`[pimoa] ${summaryLine(receipt)}`)
