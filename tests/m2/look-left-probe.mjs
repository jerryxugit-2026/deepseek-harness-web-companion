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
import { createResults } from '../lib/probe-result.mjs'

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

// 断言/观测分离，且只有布尔 true 算通过 —— 见 ../lib/probe-result.mjs 的由来。
const { record, observe, results, observations, finish } = createResults({ label: 'm2/look-left' })

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
  // 每次运行用**唯一**的草稿：宿主的意图去重规则是「同一 sessionId+draft、来自另一个页面半、5 秒内」
  // 折叠成一次（v3.40 修重复抓取时加的）。本探针每次都开新 socket（新 client id），但用过固定的
  // sessionId+draft ⇒ 5 秒内连跑两次时，第二次的意图被判成「另一个页面半的重复投递」而被吃掉。
  // 实测：连续跑第 2、3 次都红 3 条。探针必须与运行次数无关，所以草稿带时间戳。
  const DRAFT = `看左边 ${String(Date.now())}`
  const client = connect('/ag/client', { Origin: ORIGIN })
  await client.opened
  // 不要谎报 workspace：插件会记住最近一次 client hello 的 workspace，后续探针的落盘
  // 就会跑到这个假目录（真实发生：probe:capture 的文件落进 /tmp/probe-workspace）。
  // 省略该字段，插件会退到配置里的 defaultWorkspace —— 与其它探针一致。
  client.send({ type: 'hello', protocolVersion: 1, sessionId: 's-look-left' })
  client.send({ type: 'intent', protocolVersion: 1, kind: 'look-left', sessionId: 's-look-left', draft: DRAFT, trigger: 'keyword', at: Date.now() })
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
  client.send({ type: 'intent', protocolVersion: 1, kind: 'look-left', sessionId: 's-look-left', draft: DRAFT, trigger: 'keyword', at: Date.now() })
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
  // 审计文件是**追加**的：id 固定不变的话，上一轮写下的 ack 条目会替本轮作答（实测：去掉 handler
  // 后探针仍然绿 —— 典型的假绿）。所以每次运行用唯一 id，探针必须与运行次数无关。
  const ACK_CAPTURE_ID = `cap-look-left-ack-${String(Date.now())}`
  const workspace = resolve(ROOT, '.devhome/workspace-m0a')
  mkdirSync(workspace, { recursive: true })
  const attached = await fetch(`${ORIGIN}/ag/attach?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', Origin: EXT_ORIGIN },
    body: JSON.stringify({
      protocolVersion: 1,
      captureId: ACK_CAPTURE_ID,
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
  record('抓取推送到达 client 通道（未被 intent 队列吞掉）', pushed?.captureId === ACK_CAPTURE_ID)
  record('推送 mode=page 且带 fileRef', pushed?.mode === 'page' && typeof pushed?.fileRef === 'string')

  // ★ 页面半把"我怎么处理这份抓取"回执（`ClientAckEvent`）发给宿主 —— 宿主必须留痕。

  // 由来（2026-09-12 真机）：client 半从 v3.38 起就在发这个帧，而 `onClientFrame` 只认
  // hello/request-pending/intent ⇒ 回执被静默丢弃，一整天的真实抓取在审计里留下 **0 条** `ack`
  // （而审计字段表里 `status` 的注释写的正是 "ack: inserted | dismissed | failed"）。
  // 于是"引用到底插进输入框没有"事后无法回答 —— 这正是审计存在的意义。
  client.send({ type: 'ack', captureId: ACK_CAPTURE_ID, status: 'inserted' })
  await sleep(400)
  const auditLines = readFileSync(resolve(ROOT, argOf('audit-file', '.devhome/logs/web-companion-audit.jsonl')), 'utf8')
    .split('\n').filter((line) => line !== '')
    .map((line) => { try { return JSON.parse(line) } catch { return null } })
    .filter((value) => value !== null)
  const ackEntry = [...auditLines].reverse().find((entry) => entry.kind === 'ack' && entry.captureId === ACK_CAPTURE_ID)
  record('★宿主收下页面的回执并写进审计（kind=ack）', ackEntry !== undefined)
  record('★回执里的 status 如实落盘（inserted）', ackEntry?.status === 'inserted')

  client.close()
  agent.close()
  await sleep(200)

    writeFileSync(resolve(OUT_DIR, 'look-left-probe.json'), `${JSON.stringify({ probe: 'm2/look-left', port: PORT, at: new Date().toISOString(), results, observations }, null, 2)}\n`)
  finish('look-left-probe.json')
}

await main()
