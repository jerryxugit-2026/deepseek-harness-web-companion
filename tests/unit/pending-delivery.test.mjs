#!/usr/bin/env node
/**
 * 单测：积压补投的**投递规则**（`dsh-plugin/src/host/pending.js`）。
 *
 * 由来（v3.41）：client 半每次连上都会发 `{type:'request-pending'}`（设计 §4.2），而宿主
 * **没有这个帧的 handler** —— 没开 DSH 页面时抓的东西落盘、入队，然后永远躺在队列里。
 * `GET /ag/pending` 存在但没有任何调用方，队列是**只写**的。
 *
 * 真机路径由 `tests/m0b/attach-probe.mjs` 第 7 节覆盖（真的 attach → 页面连上 → 收到）。
 * 本文件补的是**探针够不到的那一支**：投递失败时到底"保住"还是"丢掉"。那一支决定了会不会
 * 静默丢用户的抓取，而它需要"一个收不下帧的页面半"才能触发 —— 探针造不出来，所以才在这里
 * 用真 hub + 真队列来钉。
 *
 * 用法：node tests/unit/pending-delivery.test.mjs
 */
import { createServer } from 'node:http'
import { WebSocket } from 'ws'
import { createHub } from '../../dsh-plugin/src/host/hub.js'
import { createStore } from '../../dsh-plugin/src/host/store.js'
import { createPendingDelivery } from '../../dsh-plugin/src/host/pending.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

// 真 hub + 真 WS 服务器（照 capture-routing 的做法，避免"测我自己写的假 hub"）
const server = createServer()
const hub = createHub({ log: () => {} })
server.on('upgrade', (req, socket, head) => {
  if (String(req.url).startsWith('/ag/client')) hub.upgradeClient(req, socket, head)
  else socket.destroy()
})
await new Promise((res) => { server.listen(0, '127.0.0.1', res) })
const port = server.address().port

// 真队列（createStore 的 enqueue/drain/peek 是纯内存的，不碰磁盘）
const store = createStore({ attachDir: '网页捕获', defaultWorkspace: '/tmp/ag-pending-unit', pendingLimit: 32 })

const auditEntries = []
const audit = { append: (entry) => { auditEntries.push(entry); return true } }
const deliver = createPendingDelivery({ hub, store, audit, log: () => {} })

const connectClient = async (facts = {}) => {
  const ws = new WebSocket(`ws://127.0.0.1:${String(port)}/ag/client`)
  const received = []
  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej) })
  ws.on('message', (data) => {
    const frame = JSON.parse(String(data))
    if (frame.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return }
    received.push(frame)
  })
  ws.send(JSON.stringify({ type: 'hello', protocolVersion: 1, extVersion: 'test', ...facts }))
  await sleep(80)
  return {
    received,
    attachIds: () => received.filter((f) => f.type === 'attach').map((f) => f.captureId),
    close: () => { try { ws.close() } catch { /* gone */ } },
  }
}

const queuedCapture = (captureId, extra = {}) => ({ type: 'attach', sessionMode: 'new', captureId, fileRef: `@网页捕获/${captureId}.md`, ...extra })

console.log('1. 没人能收的时候请求补投：抓取必须**还在队列里**（这是"不丢数据"的那一支）')
{
  const before = store.peek().length
  store.enqueue(queuedCapture('cap-keep'))
  const delivered = deliver({ id: 'client:ghost' })   // 这个 id 没有任何 socket
  record('返回值说明一条都没投出去', delivered === 0)
  record('队列长度没变（不是"取走了再丢"）', store.peek().length === before + 1)
  record('★ 它还躺在队列里（下次页面连上仍能补投）', store.peek().some((item) => item.captureId === 'cap-keep'))
  record('审计如实记了 requeued=1（事后查得出来）', auditEntries.at(-1)?.kind === 'pending-replay' && auditEntries.at(-1)?.requeued === 1 && auditEntries.at(-1)?.queued === 1)
}

console.log('\n2. 有页面连着：投出去、队列清空、审计对上')
{
  store.drain()  // 清掉上一节留下的
  const page = await connectClient({ embedded: true, sessionId: 'sess-a' })
  store.enqueue(queuedCapture('cap-one'))
  store.enqueue(queuedCapture('cap-two'))
  const delivered = deliver({ id: 'client:requester' })
  await sleep(120)
  record('两条都投出去了', delivered === 2)
  record('页面半真的收到了这两条', page.attachIds().sort().join() === 'cap-one,cap-two')
  record('队列空了（补投是"取走"）', store.peek().length === 0)
  record('审计 queued=2 delivered=2 requeued=0', auditEntries.at(-1)?.queued === 2 && auditEntries.at(-1)?.delivered === 2 && auditEntries.at(-1)?.requeued === 0)
  page.close()
  await sleep(250)
}

console.log('\n3. owner 优先：「看左边」的积压必须回到当初发起它的那个页面半')
{
  const tab = await connectClient({ embedded: false, sessionId: 'sess-tab' })
  const panel = await connectClient({ embedded: true, sessionId: 'sess-panel' })
  const [, panelId] = hub.clientIds()
  // 默认规则会选 panel（被嵌入的那份）；owner 指定 tab ⇒ 必须投给 tab，规则服从 owner
  const tabId = hub.clientIds().find((id) => id !== panelId)
  store.enqueue(queuedCapture('cap-owner', { ownerClientId: tabId, sessionMode: 'current' }))
  deliver({ id: panelId })
  await sleep(120)
  record('投给了 owner 指定的那份（而不是默认胜者）', tab.attachIds().join() === 'cap-owner')
  record('另一份没有被塞进来', panel.attachIds().length === 0)
  tab.close(); panel.close()
  await sleep(250)
}

console.log('\n4. 没有 owner 的积压：投给**请求补投的那个页面半**（是谁问的给谁）')
{
  const panel = await connectClient({ embedded: true, sessionId: 'sess-panel-2' })
  const tab = await connectClient({ embedded: false, sessionId: 'sess-tab-2' })
  const panelId = hub.primaryClientId()                     // 默认胜者 = panel
  const tabId = hub.clientIds().find((id) => id !== panelId)
  store.enqueue(queuedCapture('cap-noowner'))
  deliver({ id: tabId })                                    // 但这次是 tab 在问
  await sleep(120)
  record('投给了提问的那份（不按默认规则抢走）', tab.attachIds().join() === 'cap-noowner')
  record('默认胜者这次没收到', panel.attachIds().length === 0)
  panel.close(); tab.close()
  await sleep(250)
}

console.log('\n5. 队列本来就空：什么都不做，也不写噪音审计')
{
  const before = auditEntries.length
  const delivered = deliver({ id: 'client:whoever' })
  record('返回 0', delivered === 0)
  record('没有多写一条审计', auditEntries.length === before)
}

console.log('\n6. 谁都不在（连请求方也断了）：仍然一条不丢')
{
  const ghost = await connectClient({ embedded: true })
  ghost.close()
  await sleep(250)
  store.enqueue(queuedCapture('cap-orphan'))
  const delivered = deliver({ id: 'client:gone' })
  record('投不出去', delivered === 0)
  record('★ 孤儿抓取仍在队列里（等下一个页面）', store.peek().some((item) => item.captureId === 'cap-orphan'))
}

hub.dispose?.()
server.close()
// 只有布尔 true 算通过
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
