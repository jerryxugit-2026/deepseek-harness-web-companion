#!/usr/bin/env node
/**
 * 单测：`/ag/*` 的 F4（DSH 页面 client 半）鉴权矩阵 —— `guard.js#checkClient`。
 *
 * 由来（真缺陷，2026-09-12 由 PiMoa 对抗审核指出、我在本仓库逐字核实）：
 *
 *     const sameOriginOk = (req) => {
 *       const origin = req.headers.origin
 *       if (origin === undefined) return true      // ← 「缺失即放行」
 *       ...
 *     }
 *     checkClient: (req) => sameOriginOk(req) || (keyOk(req) && originOk(req))
 *
 * 设计 §5.4 对 F4 写的是**完整规则**：「Origin 若存在必须等于本服务 authority，**若缺失**
 * 则以 `Sec-Fetch-Site: same-origin` + 有效 cookie 判定」—— 实现只落了前半句。
 *
 * 为什么这半句是安全关键：浏览器**不止同源请求**不发 Origin，**导航与子资源**（`<img>`、
 * `<script>`、`<link>`）同样不发。于是任意网页都能不带任何凭据打到这些路由，而
 * `GET /ag/pending` 是**破坏性**的（`store.drain()` 用 splice 消费）—— 一句
 * `<img src="http://127.0.0.1:3080/ag/pending">` 就能把待投递队列清空。
 *
 * 用法：node tests/unit/guard-client.test.mjs
 */
import { createGuard } from '../../dsh-plugin/src/host/guard.js'

const KEY = 'k'.repeat(43)
const EXT = 'chrome-extension://idpgkobbblmpmnonlndopijgfmehfmig'
const AUTHORITY = '127.0.0.1:3080'
const guard = createGuard({ key: KEY, extensionOrigins: [EXT] })

/** Minimal node-like request stub. */
const req = (headers) => ({ url: '/ag/pending', headers: { host: AUTHORITY, ...headers } })

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 150)}`)
}

console.log('1. ★跨站无 Origin 的请求必须被拒（这就是那条真缺陷）')
{
  // `<img src="http://127.0.0.1:3080/ag/pending">` 与跨站导航的真实形态：
  // 没有 Origin、Sec-Fetch-Site 是 cross-site（浏览器一定会带上它）
  record('cross-site + 无 Origin → 拒', guard.checkClient(req({ 'sec-fetch-site': 'cross-site', cookie: 'dsh-auth-x=y' })) === false)
  // 连 Sec-Fetch-* 都没有（老客户端 / 非浏览器）——也不能凭"没 Origin"就放行
  record('无 Origin 且无任何 Sec-Fetch → 拒', guard.checkClient(req({})) === false)
  record('无 Origin + same-origin 但**没有 cookie** → 拒', guard.checkClient(req({ 'sec-fetch-site': 'same-origin' })) === false)
  record('无 Origin + same-site（不是 same-origin）→ 拒', guard.checkClient(req({ 'sec-fetch-site': 'same-site', cookie: 'dsh-auth-x=y' })) === false)
}

console.log('\n2. 真正的 DSH 页面同源请求必须放行（否则整条链路会死）')
{
  record('无 Origin + same-origin + 会话 cookie → 放行', guard.checkClient(req({ 'sec-fetch-site': 'same-origin', cookie: 'dsh-auth-abc=v1.x.y' })) === true)
  record('cookie 串里夹着别的 cookie 也能认出来', guard.checkClient(req({ 'sec-fetch-site': 'same-origin', cookie: 'theme=dark; dsh-auth-abc=v1.x.y; other=1' })) === true)
}

console.log('\n3. Origin 存在时必须等于本服务 authority（前后两句都要守）')
{
  record('Origin = http://127.0.0.1:3080 → 放行', guard.checkClient(req({ origin: `http://${AUTHORITY}` })) === true)
  record('Origin = http://evil.example → 拒', guard.checkClient(req({ origin: 'http://evil.example' })) === false)
  record('Origin = chrome-extension://…（无 key）→ 拒', guard.checkClient(req({ origin: EXT })) === false)
  record('Origin = https://127.0.0.1:3080（协议不同）→ 拒', guard.checkClient(req({ origin: `https://${AUTHORITY}` })) === false)
}

console.log('\n4. 非浏览器/扩展那条路（key + 扩展 Origin）不受影响')
{
  record('key + 扩展 Origin → 放行', guard.checkClient(req({ origin: EXT, 'x-ag-key': KEY })) === true)
  record('错误 key + 扩展 Origin → 拒', guard.checkClient(req({ origin: EXT, 'x-ag-key': 'wrong' })) === false)
  record('query 里的 key 同样认可', guard.checkClient({ url: `/ag/pending?key=${KEY}`, headers: { host: AUTHORITY, origin: EXT } }) === true)
  // 探针就是这么调的：显式 Origin = 本服务 authority（不带 key）——必须继续放行
  record('探针式：显式 Origin=authority（无 key 无 cookie）→ 放行', guard.checkClient(req({ origin: `http://${AUTHORITY}`, 'sec-fetch-site': 'cross-site' })) === true)
}

console.log('\n5. 其余三种形态不受本次改动影响（回归防护）')
{
  record('checkNavigation 只看 key', guard.checkNavigation({ url: `/ag/enter?key=${KEY}`, headers: { host: AUTHORITY } }) === true && guard.checkNavigation({ url: '/ag/enter', headers: { host: AUTHORITY } }) === false)
  record('checkFetch 要 key + 扩展 Origin', guard.checkFetch(req({ origin: EXT, 'x-ag-key': KEY })) === true && guard.checkFetch(req({ origin: EXT })) === false)
  record('checkUpgrade 与 checkFetch 同规则', guard.checkUpgrade(req({ origin: EXT, 'x-ag-key': KEY })) === true && guard.checkUpgrade(req({ origin: `http://${AUTHORITY}`, 'x-ag-key': KEY })) === false)
  record('configured 需要 key 与 origins 都在', guard.configured === true)
  record('空 key 的配对被判未配置', createGuard({ key: '', extensionOrigins: [EXT] }).configured === false)
}

console.log('\n6. ★ 扩展页面发的**简单 GET**：Chrome 不给 Origin，但会给 sec-fetch-site: none')
{
  // 实测（2026-09-12，真 Chrome + 真面板文档）：面板读 `/ag/control` 的 GET 到达服务端时是
  //   origin: null, sec-fetch-site: none, sec-fetch-mode: cors
  // 而 F2 原来只认"精确 Origin"⇒ 403 ⇒ 面板永远读不到写开关状态（v3.40 把 POST 改成 GET 时
  // **没有在浏览器里验过**，这就是代价）。同一条 POST 是带 Origin 的，所以开关本身能用。
  const extensionGet = req({ 'x-ag-key': KEY, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' })
  record('★ 无 Origin 但 sec-fetch-site=none + mode=cors + key → 放行', guard.checkFetch(extensionGet) === true)
  record('★ 少了 key 就不行（凭证仍是 key）', guard.checkFetch(req({ 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' })) === false)
  record('★ 网站的 fetch（cross-site）不行', guard.checkFetch(req({ 'x-ag-key': KEY, 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' })) === false)
  record('★ 导航（mode=navigate）不行', guard.checkFetch(req({ 'x-ag-key': KEY, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'navigate' })) === false)
  record('★ 两个头都缺（curl / 子资源）不行', guard.checkFetch(req({ key: KEY })) === false)
  record('给了 Origin 时仍按精确匹配判（伪造 none 也没用）', guard.checkFetch(req({ 'x-ag-key': KEY, origin: 'https://evil.example', 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' })) === false)
  record('checkClient 同样受益（扩展侧那条分支）', guard.checkClient(req({ 'x-ag-key': KEY, 'sec-fetch-site': 'none', 'sec-fetch-mode': 'cors' })) === true)
}

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exit(failed.length === 0 ? 0 : 1)
