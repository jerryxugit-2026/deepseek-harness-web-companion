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

console.log('\n7. 防御性：宿主契约变化时，**读工具放行、写工具 fail-closed**')
const ctxD = makeCtx({ approval: undefined })
const gateD = createWriteGate({ ctx: ctxD, writeEnabled: () => true })
record('非写工具缺 next 时返回 allow（不挂住调用）', ctxD.registered['tools/pre-execute']({ name: 'bash' }, undefined).kind === 'allow')
// 写工具：必须**拒绝**。旧实现无差别返回 allow ⇒ 宿主 API 一变，写操作就静默变成"无限制"
// （三层闸门存在的全部意义就是不让这种事发生）。2026-09-12 审核指出、已修。
record('★写工具缺 next 时必须 deny（fail-closed）', ctxD.registered['tools/pre-execute']({ name: 'browser_click' }, undefined).kind === 'deny')
record('拒绝理由可诊断（说明审批钩子没跑起来）', /approval hook|host API/u.test(String(ctxD.registered['tools/pre-execute']({ name: 'browser_type' }, undefined).reason ?? '')))
record('dispose 可调用', typeof gateD.dispose === 'function')
// mode 不再是创建期快照：审批服务中途卸载后，读 mode 必须跟着变（面板据它给用户看文案）
record('★mode 每次读取重算（不是创建期快照）', (() => {
  let approval = { request: async () => 'allowed-once' }
  const ctxE = {
    registered: {},
    get: (name) => (name === 'approval' ? approval : undefined),
    on: (name, callback) => { ctxE.registered[name] = callback; return () => {} },
  }
  const gateE = createWriteGate({ ctx: ctxE, writeEnabled: () => true })
  const before = gateE.mode
  approval = undefined
  return before === 'ask' && gateE.mode === 'switch-only'
})())

console.log('\n7. ★审批策略 never：服务在、但没人会被问 —— 不许骗模型说"用户拒绝了"')
{
  // dsh-user-approval：APPROVAL_POLICIES = ['ask','never']；policy=never 时 decide() 在**问任何人之前**
  // 就返回 'rejected'。旧代码只问"审批服务在不在"，于是报告 mode=ask：面板承诺"每次都会先问你"，
  // 而每次点击都被自动拒，模型收到的是 `the user rejected tool "browser_click"` —— 没有人被问过
  // （台账 §5-12）。这里钉住三件事：mode 如实、写调用被拒、理由说的是策略而不是"用户拒绝"。
  const neverSession = {}
  const approvalNever = {
    config: { policy: 'never' },
    effectivePolicy: () => 'never',
    request: async () => 'rejected',
  }
  const ctxF = makeCtx({ approval: approvalNever })
  const gateF = createWriteGate({ ctx: ctxF, writeEnabled: () => true })
  record('mode=policy-never（不再谎报 ask）', gateF.mode === 'policy-never')
  record('policy 读得出是 never', gateF.policy === 'never')
  const refused = ctxF.registered['tools/pre-execute']({ name: 'browser_click', agent: { session: neverSession } }, next)
  record('写调用被拒（不会绕过 never 直接放行）', refused.kind === 'deny')
  record('理由点名策略 never（可诊断、可操作）', /never/u.test(String(refused.reason)))
  record('★理由**不**甩锅给用户（没有 "user rejected"/"用户拒绝"）', /user rejected|用户拒绝/iu.test(String(refused.reason)) === false)
  record('非写工具照样放行（never 只管需要审批的动作）', ctxF.registered['tools/pre-execute']({ name: 'browser_read', agent: { session: neverSession } }, next) === ALLOW)

  // 会话级覆盖：配置默认是 never，但会话被改成 ask → 必须能问
  const approvalMixed = {
    config: { policy: 'never' },
    effectivePolicy: (session) => (session === neverSession ? 'never' : 'ask'),
    request: async () => 'allowed-once',
  }
  const ctxG = makeCtx({ approval: approvalMixed })
  const gateG = createWriteGate({ ctx: ctxG, writeEnabled: () => true })
  const otherSession = {}
  record('同一部署里另一个会话（ask）仍然走审批', ctxG.registered['tools/pre-execute']({ name: 'browser_type', agent: { session: otherSession } }, next).kind === 'ask')
  record('而 never 的那个会话仍被拒', ctxG.registered['tools/pre-execute']({ name: 'browser_type', agent: { session: neverSession } }, next).kind === 'deny')

  // 引擎没暴露 effectivePolicy 时退到配置默认值，而不是假装 ask
  const approvalNoFold = { config: { policy: 'never' }, request: async () => 'rejected' }
  const ctxH = makeCtx({ approval: approvalNoFold })
  const gateH = createWriteGate({ ctx: ctxH, writeEnabled: () => true })
  record('拿不到会话折算式时按配置默认判（仍不谎报 ask）', gateH.mode === 'policy-never')

  // policy=ask 的正常路径不受影响（修过头检查）
  const approvalAsk = { config: { policy: 'ask' }, effectivePolicy: () => 'ask', request: async () => 'allowed-once' }
  const ctxI = makeCtx({ approval: approvalAsk })
  const gateI = createWriteGate({ ctx: ctxI, writeEnabled: () => true })
  record('policy=ask → mode=ask、写调用走审批（没有把正常部署一起封掉）',
    gateI.mode === 'ask' && ctxI.registered['tools/pre-execute']({ name: 'browser_click', agent: { session: {} } }, next).kind === 'ask')
}

console.log('\n8. ★「显式关掉审批」优先于会话策略：approvalForWriteOps=false 时写操作只由开关把关')
{
  // 2026-09-12 用户决定把他的部署改成这一形态：本会话审批策略是 never（弹窗根本弹不出来），
  // 而 `approvalForWriteOps: false` 的含义是「写操作根本不走审批缝」—— 此时再拿 never 去拒，
  // 就是"操作者说不用问，插件却替他拒绝"。所以这个判断要排在会话策略之前。
  const approvalNever = { config: { policy: 'never' }, effectivePolicy: () => 'never', request: async () => 'rejected' }
  const ctxJ = makeCtx({ approval: approvalNever })
  const gateJ = createWriteGate({ ctx: ctxJ, writeEnabled: () => true, approvalRequired: () => false })
  record('mode=off（如实报告"审批已在配置里关闭"）', gateJ.mode === 'off')
  const allowed = ctxJ.registered['tools/pre-execute']({ name: 'browser_click', agent: { session: {} } }, next)
  record('★写操作**放行**（不再被 never 挡下）', allowed === ALLOW)
  record('非写工具照旧放行', ctxJ.registered['tools/pre-execute']({ name: 'browser_read' }, next) === ALLOW)

  // 但开关仍然是闸门：关掉开关时无论审批怎么配都要 deny（否则"无审批部署"会变成"无闸门"）
  const ctxK = makeCtx({ approval: approvalNever })
  const gateK = createWriteGate({ ctx: ctxK, writeEnabled: () => false, approvalRequired: () => false })
  const deniedK = ctxK.registered['tools/pre-execute']({ name: 'browser_navigate' }, next)
  record('★开关关着时仍然 deny（开关是最后一道闸）', deniedK.kind === 'deny' && String(deniedK.reason).includes('allowBrowserWriteOps'))
  void gateK
}

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
