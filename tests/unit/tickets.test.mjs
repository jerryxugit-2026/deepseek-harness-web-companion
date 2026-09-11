#!/usr/bin/env node
/**
 * Unit tests for the single-use entry-ticket store (design §5.4).
 *
 * Clock and randomness are injected, so expiry and single-use semantics are
 * tested without waiting for wall time.
 *
 * Usage: node tests/unit/tickets.test.mjs
 */
import { createTicketStore } from '../../dsh-plugin/src/host/tickets.js'

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) { console.log(`  ✓ ${label}`); return }
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  failures.push(label)
}

let clock = 1_000_000
let counter = 0
const store = createTicketStore({ ttlMs: 30_000, now: () => clock, random: () => `ticket-${String(++counter)}`, limit: 3 })

console.log('1. 签发与单次消费')
const first = store.issue()
check('issue 返回 ticket 与 expiresAt', typeof first.ticket === 'string' && first.expiresAt === clock + 30_000)
check('首次消费成功', store.consume(first.ticket) === true)
check('二次消费失败（一次性）', store.consume(first.ticket) === false)
check('未知 ticket 失败', store.consume('nope') === false)
check('空/非法输入失败', store.consume('') === false && store.consume(undefined) === false)

console.log('2. 过期语义（假时钟）')
const expiring = store.issue()
clock += 29_999
check('TTL 内仍可消费', store.consume(expiring.ticket) === true)
const late = store.issue()
clock += 30_001
check('超过 TTL 后拒绝', store.consume(late.ticket) === false)
check('过期 ticket 不再计入 liveCount', store.liveCount === 0)

console.log('3. 容量上限：超出后淘汰最旧')
clock += 1000
const issued = [store.issue(), store.issue(), store.issue(), store.issue()]
check('liveCount 不超过上限 3', store.liveCount === 3, `liveCount=${String(store.liveCount)}`)
check('最旧的一枚已被淘汰', store.consume(issued[0].ticket) === false)
check('最新的仍可用', store.consume(issued[3].ticket) === true)

console.log('4. 默认参数可独立实例化')
const fresh = createTicketStore()
const ticket = fresh.issue()
check('默认 TTL 为 30s', ticket.ttlMs === 30_000)
check('默认随机串非空且不重复', typeof ticket.ticket === 'string' && ticket.ticket.length >= 16 && fresh.issue().ticket !== ticket.ticket)

console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${String(failures.length)} 项失败`}`)
if (failures.length > 0) process.exit(1)
