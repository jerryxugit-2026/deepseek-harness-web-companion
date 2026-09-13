#!/usr/bin/env node
/**
 * 单测：**嵌入门户 URL 里永远不许出现长期配对密钥**（设计 T9 / §7.4）。
 *
 * 由来（真缺陷，2026-09-12 由 PiMoa 审核指出、我在本仓库逐字核实）：
 * `dsh-session.js#ensureReady` 在**取一次性票据失败**时静默回退到 `enterUrl()` ——
 * 也就是把 32 字节配对密钥直接拼进 iframe 的 URL。那条 URL 会进浏览器历史、`Referer`
 * 与访问日志，而同一段代码上方的注释却写着 "the long-lived key never enters the frame URL"。
 * 设计 §7.4 的 `?token=` 兜底是**用户自己粘贴**的一步，不是我们替他静默降级。
 *
 * 本测试用 `fetch` 桩驱动 `ensureReady` 的三种结局，只钉一件事：**返回的 url 里没有密钥**。
 *
 * 用法：node tests/unit/embed-url.test.mjs
 */

const KEY = 'k'.repeat(43)
const AUTHORITY = '127.0.0.1:3080'

// 模块导入期不允许碰 chrome（native-host.js 只在函数里用），但保险起见给个最小桩。
globalThis.chrome = {
  runtime: { connectNative: () => { throw new Error('native host must not be used in this test') } },
  storage: { local: { get: async () => ({}), set: async () => {} } },
}

/** What the stub answers, per test case. */
let mode = 'ticket-fails'
const jsonResponse = (body, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
})
globalThis.fetch = async (url) => {
  const target = String(url)
  if (target.includes('/ag/ping')) {
    return jsonResponse({
      ok: true, protocolVersion: 1, plugin: 'dsh-web-companion-bridge', pluginVersion: '0.1.0',
      keyConfigured: true, paired: true, trustedOrigins: 1, pairingSource: '/tmp/x.json', pairingError: null,
      dsh: { home: '/tmp', port: 3080 }, capabilities: ['browser_read'], liveTickets: 0, connectedClients: 1,
    })
  }
  if (target.includes('/ag/ticket')) {
    if (mode === 'ticket-ok') return jsonResponse({ ok: true, ticket: 't-'.padEnd(43, 'x'), expiresAt: Date.now() + 30000 })
    return jsonResponse({ ok: false, error: { code: 'E_AUTH', message: 'forbidden' } }, 403)
  }
  throw new Error(`unexpected fetch: ${target}`)
}

const { ensureReady } = await import('../../extension/src/sw/dsh-session.js')
const { MESSAGES } = await import('../../extension/src/lib/messages.generated.js')

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

console.log('1. 票据正常：走 ticket 握手，URL 里是票据不是密钥')
{
  mode = 'ticket-ok'
  const ready = await ensureReady()
  record('ok = true', ready.ok === true)
  record('URL 带 ticket 参数', String(ready.url).includes('ticket='))
  record('★URL 不含长期密钥', String(ready.url).includes(KEY) === false)
  record('state.handshake = ticket', ready.state?.handshake === 'ticket')
}

console.log('\n2. ★票据失败（重试后仍失败）：必须 fail-closed —— 不许把密钥拼进 URL')
{
  mode = 'ticket-fails'
  const ready = await ensureReady()
  record('ok = false（不再静默降级为"能进就行"）', ready.ok === false)
  record('没有返回可用的 url', ready.url === undefined)
  record('★任何返回字段里都不含长期密钥', !JSON.stringify(ready).includes(KEY))
  const msg = String(ready.error?.message)
  /*
   * 英文版改造后，这里的文案**来自文案表**（可本地化），所以断言改成与措辞无关的性质：
   *   ① 带上错误码与服务端给的原因（可诊断）；
   *   ② 带上修法；
   *   ③ 默认语言下**不再含汉字**（证明它真的走了文案表，而不是某处还写死着中文）——
   *      这一条在改造前是红的（那时这句是硬编码中文）。
   * 原来直接断言中文字符串（`/票据/`、`/密钥/`），一翻译就会红：那种断言锁的是措辞。
   */
  record('★文案来自文案表（默认语言无汉字），且带错误码 + 服务端原因',
    /[\u4e00-\u9fff]/u.test(msg) === false && msg.includes('E_AUTH') && msg.includes('403'))
  record('错误可诊断（点名票据失败 + 给出修法）', /ticket/iu.test(msg) && /init-key/u.test(msg))
  record('错误里说明了"为不把长期密钥写进 URL 而停止"', /key/iu.test(msg) && /URL/u.test(msg))
  // 插值有没有串位：模板里有 2 个占位，渲染结果里不该还剩占位符
  record('文案表模板有 2 个占位符', (String(MESSAGES.en.errTicketFailed).match(/\$\d/gu) ?? []).length === 2)
  record('★渲染后没有残留的 $1/$2（插值真的被替换了）', /\$\d/u.test(msg) === false)
  record('state.handshake 如实标记为 ticket-failed', ready.state?.handshake === 'ticket-failed')
  record('复用已有错误码 E_UNPAIRED（不新增协议码）', ready.error?.code === 'E_UNPAIRED')
}

console.log('\n3. 回归钉子：把"回退到 enterUrl()"放回去，本条测试必须变红')
{
  // 用真实模块没法注入旧实现，这里等价地验证：只要有人把密钥拼进 URL，
  // 第 2 节那两条断言（url undefined / 不含密钥）就会失败。
  const legacy = { ok: true, url: `http://${AUTHORITY}/ag/enter?key=${KEY}`, state: { handshake: 'key-fallback' } }
  record('（哨兵）旧实现的返回形状确实含密钥 —— 说明这两条断言不是恒真', JSON.stringify(legacy).includes(KEY) === true)
}

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
