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

/** One JSON-RPC POST; the HTTP transport answers with an SSE stream. */
async function rpc(body, sessionId) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }
  if (sessionId !== undefined) headers['mcp-session-id'] = sessionId
  const response = await fetch(URL, { method: 'POST', headers, body: JSON.stringify(body) })
  const text = await response.text()
  const messages = text
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => { try { return JSON.parse(line.slice(6)) } catch { return undefined } })
    .filter((value) => value !== undefined)
  return { sessionId: response.headers.get('mcp-session-id') ?? sessionId, status: response.status, messages, raw: text }
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

/** MCP tool results carry content blocks; PiMoa also returns structured JSON in text. */
const blocks = result.result?.content ?? []
const textOut = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')

let structured
for (const block of blocks) {
  if (block.type !== 'text') continue
  try {
    const parsed = JSON.parse(block.text)
    if (parsed !== null && typeof parsed === 'object') { structured = parsed; break }
  } catch { /* not JSON, keep as text */ }
}

const verdict = structured?.status ?? structured?.result?.status ?? 'unknown'
const header = [
  '# PiMoa 对抗性审核结果',
  '',
  `- 工具：\`${TOOL}\``,
  `- 端点：\`${URL}\``,
  `- 输入：${CONTEXT_FILES.map((f) => `\`${f}\``).join('、')}`,
  `- prompt：\`${PROMPT_FILE}\``,
  `- 用时：${(elapsed / 1000).toFixed(1)}s`,
  `- 裁决（status）：**${String(verdict)}**`,
  `- 生成时间：${new Date().toISOString()}`,
  '',
  '---',
  '',
].join('\n')

mkdirSync(dirname(resolve(ROOT, OUT)), { recursive: true })
writeFileSync(resolve(ROOT, OUT), `${header}${textOut}\n`)
console.log(`[pimoa] status=${String(verdict)} elapsed=${(elapsed / 1000).toFixed(1)}s → ${OUT}`)
if (structured?.receipt !== undefined) console.log(`[pimoa] receipt=${JSON.stringify(structured.receipt).slice(0, 400)}`)
