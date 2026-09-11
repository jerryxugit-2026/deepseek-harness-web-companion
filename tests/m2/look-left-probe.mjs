#!/usr/bin/env node
/**
 * M2 · 「看左边」last-hop probe (design docs/06 §8.2, E2E-3).
 *
 * The intent is sniffed in the DSH page (`/ag/client`), so the whole loop can be
 * driven from Node — no Chrome needed:
 *
 *   client half  --intent-->  bridge  --capture-request-->  extension (/ag/agent)
 *                              bridge  <--capture-result--  extension
 *
 * Asserts:
 *   1. an intent with a panel CONNECTED is relayed immediately (`reason: look-left`);
 *   2. an intent with NO panel connected is queued, then replayed on the next
 *      connect (`reason: queued`) — the panel may legitimately be closed;
 *   3. a `capture-result` (success and failure) is accepted without hurting the
 *      socket, so a failed capture never leaves the channel wedged;
 *   4. the new `/ag/agent` upgrade is guarded: a wrong key is refused (403).
 *
 * Requires a running dev instance (`DSH_HOME=.devhome dsh web --no-open --port 3099`).
 *
 * Usage: node tests/m2/look-left-probe.mjs [--port 3099]
 */
import { WebSocket } from 'ws'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const PORT = argOf('port', '3099')
const PAIRING = resolve(ROOT, argOf('key-file', '.devhome/dsh-web-companion.json'))
const OUT_DIR = resolve(ROOT, argOf('out', 'docs/reviews'))
const ORIGIN = `http://127.0.0.1:${PORT}`
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })
mkdirSync(OUT_DIR, { recursive: true })

const pairing = JSON.parse(readFileSync(PAIRING, 'utf8'))
const KEY = pairing.key
const EXT_ORIGIN = pairing.extensionOrigins[0]

const results = {}
const record = (name, value) => { results[name] = value; console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value)}`) }

/** A peer socket that keeps every frame it receives, with `waitFor`. */
function connect(path, headers) {
  const url = `ws://127.0.0.1:${String(PORT)}${path}`
  const ws = new WebSocket(url, headers === undefined ? {} : { headers })
  const frames = []
  const waiters = []
  ws.on('message', (data) => {
    let frame
    try { frame = JSON.parse(String(data)) } catch { return }
    frames.push(frame)
    for (const waiter of [...waiters]) {
      if (waiter.predicate(frame)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(frame) }
    }
  })
  return {
    ws,
    frames,
    opened: new Promise((res, rej) => {
      ws.on('open', () => { res(true) })
      ws.on('error', (error) => { rej(error) })
      ws.on('unexpected-response', (_req, res) => { rej(new Error(`HTTP ${String(res.statusCode)}`)) })
    }),
    send: (frame) => { ws.send(JSON.stringify(frame)) },
    waitFor(predicate, timeoutMs = 3000) {
      const hit = frames.find(predicate)
      if (hit !== undefined) return Promise.resolve(hit)
      return new Promise((res, rej) => {
        const waiter = { predicate, resolve: res }
        waiters.push(waiter)
        setTimeout(() => {
          const at = waiters.indexOf(waiter)
          if (at !== -1) { waiters.splice(at, 1); rej(new Error('timeout waiting for frame')) }
        }, timeoutMs)
      })
    },
    close: () => { try { ws.close() } catch { /* gone */ } },
  }
}

/** Whether the bridge answers at all (and with a valid pairing). */
async function ping() {
  const res = await fetch(`${ORIGIN}/ag/ping`, { cache: 'no-store' })
  return res.json()
}

const main = async () => {
  const info = await ping().catch(() => null)
  if (info === null || info.paired !== true) {
    console.error(`\n✗ 桥接插件未就绪（${ORIGIN}/ag/ping）—— 先启动：DSH_HOME=.devhome dsh web --no-open --port ${String(PORT)}\n`)
    process.exitCode = 3
    return
  }
  console.log(`探测 ${ORIGIN}（paired=${String(info.paired)}，扩展 origin ${String(EXT_ORIGIN)}）\n`)

  // ── case 1: panel closed → intent must be queued, then replayed ────────────
  const client = connect('/ag/client', { Origin: ORIGIN })
  await client.opened
  client.send({ type: 'hello', protocolVersion: 1, sessionId: 's-look-left', workspace: '/tmp/probe-workspace' })
  client.send({ type: 'intent', protocolVersion: 1, kind: 'look-left', sessionId: 's-look-left', draft: '看左边', trigger: 'keyword', at: Date.now() })
  await sleep(600)

  const agent = connect(`/ag/agent?key=${encodeURIComponent(KEY)}`, { Origin: EXT_ORIGIN })
  await agent.opened
  agent.send({ type: 'agent-hello', protocolVersion: 1, extensionVersion: '0.1.0', panel: 'sidepanel' })
  let replayed
  try {
    replayed = await agent.waitFor((f) => f.type === 'capture-request', 4000)
  } catch {
    replayed = undefined
  }
  record('面板关闭时意图入队并在连接后补发', replayed !== undefined)
  record('补发的请求 reason=queued / mode=page', replayed?.reason === 'queued' && replayed?.mode === 'page')
  record('补发请求带 requestId 与 sessionId', typeof replayed?.requestId === 'string' && replayed?.requestId.startsWith('int-') && replayed?.sessionId === 's-look-left')

  // ── case 3: the extension answers, both outcomes ───────────────────────────
  if (replayed !== undefined) {
    agent.send({ type: 'capture-result', protocolVersion: 1, requestId: replayed.requestId, ok: true, captureId: 'cap-probe', fileRef: '@网页捕获/probe.md', filePath: '/tmp/probe.md', at: Date.now() })
  }
  await sleep(300)

  // ── case 2: panel connected → immediate relay ──────────────────────────────
  const before = agent.frames.length
  client.send({ type: 'intent', protocolVersion: 1, kind: 'look-left', sessionId: 's-look-left', draft: '看左边', trigger: 'keyword', at: Date.now() })
  let relayed
  try {
    relayed = await agent.waitFor((f, i) => f.type === 'capture-request' && f.reason === 'look-left', 3000)
  } catch {
    relayed = undefined
  }
  record('面板在线时意图立即转发', relayed !== undefined && agent.frames.length > before)
  record('转发请求 reason=look-left', relayed?.reason === 'look-left' && relayed?.mode === 'page')

  // 失败结果也必须被接受，且通道保持可用
  if (relayed !== undefined) {
    agent.send({ type: 'capture-result', protocolVersion: 1, requestId: relayed.requestId, ok: false, error: { code: 'E_PERMISSION', message: 'probe: permission denied' }, at: Date.now() })
  }
  await sleep(400)
  const after = await ping().catch(() => null)
  record('失败结果后插件仍存活（/ag/ping 200）', after?.paired === true)
  record('失败结果后 agent 通道仍打开', agent.ws.readyState === WebSocket.OPEN)

  // ── case 4: the new upgrade path is guarded ───────────────────────────────
  const bad = connect('/ag/agent?key=not-the-key', { Origin: EXT_ORIGIN })
  const rejected = await bad.opened.then(() => false).catch(() => true)
  record('错误 key 的 /ag/agent 被拒（403）', rejected)
  bad.close()

  // ── case 5: 回归 —— 抓取推送必须仍然到达 client 通道（intent 队列不得污染它） ──
  const workspace = resolve(ROOT, '.devhome/workspace-m0a')
  mkdirSync(workspace, { recursive: true })
  const attached = await fetch(`${ORIGIN}/ag/attach?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: EXT_ORIGIN },
    body: JSON.stringify({
      protocolVersion: 1,
      captureId: 'cap-look-left-regression',
      trigger: 'button',
      page: { title: '意图回归页', url: `${ORIGIN}/fixture`, domain: '127.0.0.1', capturedAt: Date.now() },
      content: { markdown: '意图回归正文' },
      target: { workspace, sessionId: 's-look-left' },
    }),
  }).catch(() => null)
  const attachBody = attached === null ? null : await attached.json().catch(() => null)
  record('抓取仍可落盘（POST /ag/attach 200）', attached?.status === 200 && typeof attachBody?.fileRef === 'string')
  let pushed
  try {
    pushed = await client.waitFor((f) => f.type === 'attach', 3000)
  } catch {
    pushed = undefined
  }
  record('抓取推送到达 client 通道（未被 intent 队列吞掉）', pushed?.captureId === 'cap-look-left-regression')
  record('推送 mode=page 且带 fileRef', pushed?.mode === 'page' && typeof pushed?.fileRef === 'string')

  client.close()
  agent.close()
  await sleep(200)

  const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
  writeFileSync(resolve(OUT_DIR, 'look-left-probe.json'), `${JSON.stringify({ probe: 'm2/look-left', port: PORT, at: new Date().toISOString(), results }, null, 2)}\n`)
  console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（报告 → docs/reviews/look-left-probe.json）`)
  process.exitCode = failed.length === 0 ? 0 : 1
}

await main()
