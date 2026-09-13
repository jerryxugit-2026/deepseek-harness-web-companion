#!/usr/bin/env node
/**
 * 单测：**一次抓取只投给一个页面半**（v3.39 修的重复缺陷）。
 *
 * 由来（真事故，2026-09-12）：`/ag/attach` 用 `hub.push()` —— 一次**广播**。而用户通常有
 * 两个页面半同时连着：主 GUI 标签页 **+ 侧边栏 iframe 里那一份 DSH GUI**。两份各自跑
 * `applyAttach()`，于是**一次抓取产生两个会话、两个胶囊、两次草稿插入**。实测：每次按钮抓取
 * 都在同一毫秒附近多建一个会话（3ms 一对），用户最初报的 22:23 现象就是它（5ms 一对）。
 *
 * 现在的规则（`hub.pushClientPrimary`）：只投**一个**页面半 ——
 *   ① 谁要的给谁（「看左边」意图的发起页面，按 id 指定）；
 *   ② 否则优先**被嵌入**的那份（侧边栏 —— 抓取就是从那里发起的）；
 *   ③ 再否则按 focused → visible → 最近连接。
 * 心跳/状态类事件仍然走 `push()` 广播，两者差别本测试钉死。
 *
 * 用法：node tests/unit/capture-routing.test.mjs
 */
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { createHub } from '../../dsh-plugin/src/host/hub.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 150)}`)
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

const server = createServer()
const hub = createHub({ log: () => {} })
server.on('upgrade', (req, socket, head) => {
  if (String(req.url).startsWith('/ag/client')) hub.upgradeClient(req, socket, head)
  else socket.destroy()
})
await new Promise((res) => { server.listen(0, '127.0.0.1', res) })
const port = server.address().port

/**
 * Connect one fake page half and announce its facts.
 * @returns {Promise<{ws: WebSocket, received: object[], attachIds: () => string[], close: () => void}>}
 */
const connectClient = async (facts = {}) => {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ag/client`)
  const received = []
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data))
    if (frame.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
    received.push(frame)
  })
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, extVersion: 'client', ...facts }))
  await sleep(80) // let the hub record the facts before we route anything
  return {
    ws,
    received,
    attachIds: () => received.filter((f) => f.type === 'attach').map((f) => f.captureId),
    close: () => { try { ws.close() } catch { /* gone */ } },
  }
}

const attachEvent = (captureId) => ({ type: 'attach', sessionMode: 'new', captureId })

console.log('0. 前置：push() 仍然是广播（心跳/状态类事件需要它）')
const tab = await connectClient({ embedded: false, sessionId: 'sess-tab' })
const panel = await connectClient({ embedded: true, sessionId: 'sess-panel' })
record('两个页面半都连上了', hub.clientCount === 2)
record('clientIds() 给出 2 个 id（按连接顺序）', hub.clientIds().length === 2)
record('push() 广播到两个', hub.push({ type: 'state', value: 'x' }) === 2)
await sleep(80)
record('两个都收到了那次广播', tab.received.filter((f) => f.type === 'state').length === 1 && panel.received.filter((f) => f.type === 'state').length === 1)

console.log('\n1. pushClientPrimary()：一次抓取只落一个页面（重复缺陷的回归钉子）')
{
  const delivered = hub.pushClientPrimary(attachEvent('cap-one'))
  await sleep(80)
  record('只投一个页面半：返回**真实 client id**（不是计数）', typeof delivered === 'string' && hub.clientIds().includes(delivered))
  record('全文只有一个 attach 帧', tab.attachIds().length + panel.attachIds().length === 1)
  record('落到了**被嵌入**的那份（侧边栏优先）', panel.attachIds().join() === 'cap-one')
  record('主标签页那份一个都没收到', tab.attachIds().length === 0)
}

console.log('\n2. 指定收件人时以指定为准（「看左边」要把引用送回发起它的页面）')
{
  const [firstId, secondId] = hub.clientIds()
  record('默认胜者是被嵌入的那份', hub.primaryClientId() === secondId)
  const delivered = hub.pushClientPrimary(attachEvent('cap-two'), firstId)
  await sleep(80)
  record('投出去了（返回收件方 id）', typeof delivered === 'string')
  record('指定哪份就投给哪份（覆盖默认规则）', tab.attachIds().join() === 'cap-two')
  record('被覆盖的那份没有多收', panel.attachIds().join() === 'cap-one')
}

console.log('\n3. 没有页面连着 → 返回 null（调用方据此入队，而不是假装投递成功）')
{
  tab.close(); panel.close()
  await sleep(250)
  record('clientCount 归零', hub.clientCount === 0)
  record('返回 null（不是 0/1 计数）', hub.pushClientPrimary(attachEvent('cap-three')) === null)
}

console.log('\n4. 只有主标签页时它能收到（侧边栏关着不该丢抓取）')
{
  const solo = await connectClient({ embedded: false, sessionId: 'sess-tab2' })
  const delivered = hub.pushClientPrimary(attachEvent('cap-four'))
  await sleep(80)
  record('投出去了（返回收件方 id）', typeof delivered === 'string')
  record('主标签页收到了', solo.attachIds().join() === 'cap-four')
  solo.close()
  await sleep(150)
}

console.log('\n5. 指定的收件人已断开 → 回落到规则选出的页面，绝不因此丢抓取')
{
  const alive = await connectClient({ embedded: true })
  const doomed = await connectClient({ embedded: false })
  const doomedId = hub.clientIds().find((id) => id !== hub.primaryClientId())
  doomed.close()
  await sleep(250)
  const delivered = hub.pushClientPrimary(attachEvent('cap-five'), doomedId)
  await sleep(80)
  record('仍然投出去了（不因 preferred 失效而丢）', typeof delivered === 'string')
  record('落到了活着的那份', alive.attachIds().join() === 'cap-five')
  alive.close()
  await sleep(250) // wait for the close to reach the hub, or test 6 inherits a stale peer
}

console.log('\n6. 事实跟随同一 socket 更新：页面从"主标签页"变成"被嵌入"后再投递，规则跟着变')
{
  const only = await connectClient({ embedded: false, sessionId: 'sess-x' })
  record('前置：此刻只有这一个页面连着', hub.clientCount === 1)
  const firstDelivery = hub.pushClientPrimary(attachEvent('cap-six'))
  await sleep(60)
  only.ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, extVersion: 'client', embedded: true, focused: true, visible: true }))
  await sleep(120)
  record('两次投递都成功', typeof firstDelivery === 'string' && typeof hub.pushClientPrimary(attachEvent('cap-seven')) === 'string')
  await sleep(80)
  record(`同一页面收到的是 [${only.attachIds().join(',')}]`, only.attachIds().join() === 'cap-six,cap-seven')
  only.close()
}

hub.dispose?.()
server.close()
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
