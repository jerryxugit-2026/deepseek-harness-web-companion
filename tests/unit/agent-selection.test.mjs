#!/usr/bin/env node
/**
 * 单测：`hub.callAgent` 必须挑**活着的** agent socket（M3）。
 *
 * 由来（真事故）：`callAgent` 原来盲取 `[...sockets.agent][0]`。心跳 ping 是**广播**、
 * 工具调用只发给**一个** socket，于是一个"没干净关闭"的旧面板（Chrome 被杀/渲染进程
 * 崩）能收到 ping、却吞掉工具调用 —— 模型看到的是 "The extension timed out"，排查起来
 * 完全指错方向（实测于 tests/m3/agent-turn-probe.mjs）。
 *
 * 用法：node tests/unit/agent-selection.test.mjs
 */
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { createHub } from '../../dsh-plugin/src/host/hub.js'

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : '❌'} ${name}: ${JSON.stringify(value)}`)
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

const server = createServer()
// The hub owns its own WebSocketServer per channel and does the upgrade itself
// (`upgradeAgent(req, socket, head)`) — the first version of this test passed an extra
// `ws` argument and therefore registered nothing, which showed up as E_EXT_OFFLINE.
const hub = createHub({ log: () => {}, onAgentConnect: () => {} })
server.on('upgrade', (req, socket, head) => {
  if (String(req.url).startsWith('/ag/agent')) hub.upgradeAgent(req, socket, head)
  else socket.destroy()
})
await new Promise((res) => { server.listen(0, '127.0.0.1', res) })
const port = server.address().port

/** A fake extension: answers `tool-call` with a result. */
const connectAgent = async ({ answer = true } = {}) => {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ag/agent`)
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data))
    if (frame.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
    if (frame.type === 'tool-call' && answer) {
      ws.send(JSON.stringify({ type: 'tool-result', protocolVersion: 1, id: frame.id, ok: true, value: { from: 'answering-agent' } }))
    }
  })
  return ws
}

/* 一个有问必答的 agent + 一个"哑"agent（模拟陈旧 socket：收得到广播 ping，但不回执） */
const answering = await connectAgent({ answer: true })
await sleep(200)
const mute = await connectAgent({ answer: false })
await sleep(200)

console.log('1. 正常情况：唯一 agent 就是应答者')
const first = await hub.callAgent({ tool: 'browser_read', params: {} }, { timeoutMs: 2000 })
record('拿到应答者的结果', first?.value?.from === 'answering-agent')

console.log('\n2. 关键场景：陈旧 socket 存在时，调用必须仍然成功（可稍慢，但不许失败）')
// 把哑 socket 刷成"最近活跃"（模拟它刚回过一个 pong），旧实现会选它 → 超时
mute.send(JSON.stringify({ type: 'pong' }))
await sleep(300)
let outcome = null
try {
  outcome = await hub.callAgent({ tool: 'browser_read', params: {} }, { timeoutMs: 2000 })
} catch (error) {
  outcome = { error: error.code }
}
record('仍然命中应答者（不是超时）', outcome?.value?.from === 'answering-agent')

console.log('\n3. 应答者消失后，才允许用剩下的（并且它答不上来就是超时）')
// 用 terminate()：真实事故里 Chrome 是被杀的，等价于"没有干净关闭"的 socket
answering.terminate()
for (let i = 0; i < 30 && hub.agentCount > 1; i += 1) await sleep(100)
console.log(`   （剩余 agent: ${String(hub.agentCount)}）`)
let afterClose = null
try {
  afterClose = await hub.callAgent({ tool: 'browser_read', params: {} }, { timeoutMs: 800 })
} catch (error) {
  afterClose = { error: error.code }
}
record('只剩哑 socket → 明确的 E_TIMEOUT（而不是假装成功）', afterClose?.error === 'E_TIMEOUT')

console.log('\n4. 没有任何 agent → E_EXT_OFFLINE')
// 用一个全新的 hub 断言"零连接"这条契约：socket 从 set 里摘除依赖 close/error 事件
// （terminate 后由对端 RST 触发），把那条竞态混进来只会让断言测的不是行为。
// 摘除本身另有断言：起一个新 hub，连一个再 terminate，观察计数回落。
const freshHub = createHub({ log: () => {}, onAgentConnect: () => {} })
const freshServer = createServer()
freshServer.on('upgrade', (req, socket, head) => { freshHub.upgradeAgent(req, socket, head) })
await new Promise((res) => { freshServer.listen(0, '127.0.0.1', res) })
const transient = new WebSocket(`ws://127.0.0.1:${String(freshServer.address().port)}/ag/agent`)
await new Promise((res) => { transient.on('open', res) })
for (let i = 0; i < 20 && freshHub.agentCount === 0; i += 1) await sleep(50)
record('连接后 hub 计数为 1', freshHub.agentCount === 1)
transient.terminate()
for (let i = 0; i < 40 && freshHub.agentCount > 0; i += 1) await sleep(100)
record('断开后 hub 计数归零', freshHub.agentCount === 0)
let freshResult = null
try {
  freshResult = await freshHub.callAgent({ tool: 'browser_read', params: {} }, { timeoutMs: 500 })
} catch (error) {
  freshResult = { error: error.code }
}
record('零连接 → E_EXT_OFFLINE（而不是超时）', freshResult?.error === 'E_EXT_OFFLINE')
freshHub.dispose()
freshServer.close()

mute.terminate()
hub.dispose()
server.close()
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${failed.length} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
