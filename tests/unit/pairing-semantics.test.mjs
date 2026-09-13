#!/usr/bin/env node
/**
 * 单测：**「paired」只能有一个口径**（v3.41 的 P2 项）。
 *
 * 由来：同一个词在两个端点上意思不同 ——
 *   `/ag/ping`     ：`paired = key !== undefined && extensionOrigins.length > 0`
 *   `/ag/wsprobe`  ：`paired = key !== undefined`
 * 而面板、`probe-all`、四个探针都用 `paired === true` 当"这套安装可用"的判据；文档也把它写成
 * 前置条件（`docs/09`、`docs/12`）。也就是说：**有 key 但没登记扩展 origin** 的安装，
 * 一个端点说"已配对"、另一个说"没配对"，而两边都不会报错 —— 谁读到哪个算哪个。
 *
 * 修法：判据收进 `key-store.js#isPaired`（唯一实现），两个端点都引用它；并且这里**跨端点**断言，
 * 而不是只测那个函数（只测函数的话，接线再歪一次也照样绿）。
 *
 * 用法：node tests/unit/pairing-semantics.test.mjs
 */
import { isPaired } from '../../dsh-plugin/src/host/key-store.js'
import { pingRoute } from '../../dsh-plugin/src/host/routes/ping.js'
import { wsProbeDiagnostic } from '../../dsh-plugin/src/host/routes/ws-probe.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 200)}`)
}

/** 跑一次 `/ag/ping`，拿回真实响应体（不是"看源码里怎么写的"）。 */
const runPing = (pairing) => {
  let body
  const res = {
    writeHead: () => {},
    end: (payload) => { body = JSON.parse(String(payload)) },
  }
  pingRoute({ state: { pairing: () => pairing, pluginVersion: '0.1.0', dshHome: '/tmp/dsh', port: () => 3080, capabilities: () => ['browser_read'] }, protocolVersion: 1 })({ headers: {} }, res)
  return body
}

const PAIRED = { key: 'k'.repeat(43), extensionOrigins: ['chrome-extension://abcdefghijklmnop'], source: '/tmp/pair.json', error: undefined }
const KEY_ONLY = { key: 'k'.repeat(43), extensionOrigins: [], source: '/tmp/pair.json', error: undefined }
const ORIGIN_ONLY = { key: undefined, extensionOrigins: ['chrome-extension://abcdefghijklmnop'], source: '/tmp/pair.json', error: undefined }
const EMPTY = { key: undefined, extensionOrigins: [], source: '/tmp/pair.json', error: 'ENOENT' }

console.log('1. 判据本身：key + 受信 origin 才算配对')
record('key + origin → true', isPaired(PAIRED) === true)
record('只有 key、没有受信 origin → **false**（旧 wsprobe 在这里说 true）', isPaired(KEY_ONLY) === false)
record('只有 origin、没有 key → false', isPaired(ORIGIN_ONLY) === false)
record('什么都没有（配对文件缺失）→ false', isPaired(EMPTY) === false)
record('undefined 不炸', isPaired(undefined) === false)

console.log('\n2. 两个端点必须给出**同一个** verdict（这才是接线）')
const req = { headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', cookie: 'dsh-auth-abc=1' } }
for (const [label, pairing, expected] of [['已配对', PAIRED, true], ['只有 key', KEY_ONLY, false], ['配对文件缺失', EMPTY, false]]) {
  const ping = runPing(pairing)
  const probe = wsProbeDiagnostic(req, pairing)
  record(`${label}：/ag/ping 说 paired=${String(expected)}`, ping.paired === expected)
  record(`${label}：/ag/wsprobe 说同一个值`, probe.paired === ping.paired)
  record(`${label}：与 isPaired() 一致`, ping.paired === isPaired(pairing) && probe.paired === isPaired(pairing))
  record(`${label}：keyConfigured 仍然如实反映"有没有 key"`, ping.keyConfigured === (pairing.key !== undefined) && probe.keyConfigured === (pairing.key !== undefined))
}

console.log('\n3. 探针端点该报的细节没丢（只是"结论"统一了）')
const probe = wsProbeDiagnostic(req, KEY_ONLY)
record('sessionCookiePresent 照旧', probe.sessionCookiePresent === true)
record('trustedOrigins 如实是 0', probe.trustedOrigins === 0)
record('kind 还是 wsprobe（探针照旧能认）', probe.kind === 'wsprobe')

// 只有布尔 true 算通过
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
