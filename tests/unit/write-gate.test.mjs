#!/usr/bin/env node
/**
 * 写操作第三道闸门单测：cordis waterfall `tools/pre-execute`（M3）。
 *
 * 契约（读 dsh-tools/lib/index.js 得来，不是猜的）：运行期以
 * `ctx.waterfall(carrier, 'tools/pre-execute', exec, () => ({kind:'allow'}))` 调用；
 * 监听器签名 `(exec, next)`，**不调用 next() 就等于否决**；返回
 * `{kind:'ask', reason}` 会把决定权交给 `ctx.get('approval')`，而**没有审批服务的
 * 部署会把 ask 降级为 deny** —— 所以本模块要如实报告 mode，否则打开写开关后每次
 * 点击都会静默失败。
 *
 * 用法：node tests/unit/write-gate.test.mjs
 */
import { WRITE_TOOLS, createWriteGate } from '../../dsh-plugin/src/host/approval.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 140)}`)
}

/** Fake plugin ctx capturing the registered waterfall listener. */
function makeCtx({ approval }) {
  const registered = {}
  return {
    registered,
    get: (name) => (name === 'approval' ? approval : undefined),
    on: (name, callback) => { registered[name] = callback; return () => { delete registered[name] } },
  }
}

const ALLOW = { kind: 'allow' }
const next = () => ALLOW

console.log('1. 注册点：必须是 tools/pre-execute')
const ctxA = makeCtx({ approval: { request: async () => 'allowed-once' } })
// 开关是可变的：常量 true 的桩会让"关闭 → deny"永远测不到（第一版就栽在这）
let writeEnabled = true
const gateA = createWriteGate({ ctx: ctxA, writeEnabled: () => writeEnabled })
record('监听器注册在 tools/pre-execute', typeof ctxA.registered['tools/pre-execute'] === 'function')
record('有审批服务 → mode=ask', gateA.mode === 'ask')

console.log('\n2. 非浏览器工具一律放行（不做"看门狗"）')
for (const name of ['bash', 'read', 'browser_read', 'browser_tabs']) {
  record(`${name} 原样放行`, ctxA.registered['tools/pre-execute']({ name }, next) === ALLOW)
}
record('写工具集合只有 3 个', WRITE_TOOLS.length === 3)

console.log('\n3. 写工具：开关关闭 → deny（并说明是哪道开关）')
writeEnabled = false
const denied = ctxA.registered['tools/pre-execute']({ name: 'browser_click' }, next)
record('关闭时 deny', denied.kind === 'deny')
record('理由点名开关（可诊断）', String(denied.reason).includes('allowBrowserWriteOps'))
record('关闭时连非写工具也不受影响', ctxA.registered['tools/pre-execute']({ name: 'browser_read' }, next) === ALLOW)
writeEnabled = true

console.log('\n4. 写工具：开关打开 + 有审批服务 → ask（交给人类）')
const asked = ctxA.registered['tools/pre-execute']({ name: 'browser_type' }, next)
record('走审批而不是直接放行', asked.kind === 'ask')
record('理由告诉用户会发生什么', String(asked.reason).includes('browser_type') && String(asked.reason).includes('Approve'))
record('三个写工具都受管', ['browser_click', 'browser_type', 'browser_navigate']
  .every((name) => ctxA.registered['tools/pre-execute']({ name }, next).kind === 'ask'))

console.log('\n5. 没有审批服务的部署：mode=switch-only，且不假装有审批')
const ctxB = makeCtx({ approval: undefined })
let writeEnabledB = true
const gateB = createWriteGate({ ctx: ctxB, writeEnabled: () => writeEnabledB })
record('mode=switch-only（如实报告）', gateB.mode === 'switch-only')
record('开关打开时放行（不制造"每次点击都失败"）', ctxB.registered['tools/pre-execute']({ name: 'browser_click' }, next) === ALLOW)
writeEnabledB = false
record('开关关闭时仍然 deny（开关始终是有效闸门）', ctxB.registered['tools/pre-execute']({ name: 'browser_click' }, next).kind === 'deny')

console.log('\n6. 显式关掉审批（approvalForWriteOps=false）')
const ctxC = makeCtx({ approval: { request: async () => 'allowed-once' } })
const gateC = createWriteGate({ ctx: ctxC, writeEnabled: () => true, approvalRequired: () => false })
record('mode=off', gateC.mode === 'off')
record('开关打开时放行', ctxC.registered['tools/pre-execute']({ name: 'browser_navigate' }, next) === ALLOW)

console.log('\n7. 防御性：缺少 next 时不静默否决')
const ctxD = makeCtx({ approval: undefined })
createWriteGate({ ctx: ctxD, writeEnabled: () => true })
record('没有 next 时返回 allow（宁可放行也不挂住调用）', ctxD.registered['tools/pre-execute']({ name: 'bash' }, undefined).kind === 'allow')
record('dispose 可调用', typeof createWriteGate({ ctx: makeCtx({ approval: undefined }), writeEnabled: () => true }).dispose === 'function')

const failed = Object.entries(results).filter(([, v]) => v === false).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
