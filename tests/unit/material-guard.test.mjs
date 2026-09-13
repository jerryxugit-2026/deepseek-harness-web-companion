#!/usr/bin/env node
/**
 * 单测：审核材料卫生守卫（`scripts/material-guard.mjs`）。
 *
 * 由来（真事故，2026-09-12）：我给 PiMoa 分片时把 `scripts/` 放进 context，于是
 * `scripts/.dev-extension-key.json` —— **RSA-2048 私钥**（`privateKeyPem`）+ `publicKeyDer`
 * （与 `extension/manifest.json` 的 `key` 逐字相同，推导出的扩展 ID 就是本扩展的 ID）——
 * 被逐字读入并作为材料外发给模型厂商（`moa_verify` 实测 models=deepseek-v4-flash,minimax/MiniMax-M3）。
 * 设计 §9/T2 早就把"密钥文件误外发"列为本机高频事故模式，但当时只防了 git，没防"喂给外部模型"。
 *
 * 本测试钉住：路径黑名单 + 内容嗅探都能拦住，且干净文件与不存在的文件不误报。
 *
 * 用法：node tests/unit/material-guard.test.mjs
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SECRET_CONTENT, SECRET_PATH, describeOffenders, findSecretFiles } from '../../scripts/material-guard.mjs'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 150)}`)
}
const read = (path) => readFileSync(path, 'utf8')
const dir = mkdtempSync(join(tmpdir(), 'ag-guard-'))

console.log('1. 路径黑名单：本仓库真实的密钥/凭据路径必须被拦')
const repo = '/Users/mac/ai_tools/dsh project/网页插件'
const flagged = (path) => findSecretFiles([path], read).length > 0
record('scripts/.dev-extension-key.json（扩展私钥）', flagged(join(repo, 'scripts/.dev-extension-key.json')))
record('extension/src/lib/dev-config.js（含配对密钥）', flagged(join(repo, 'extension/src/lib/dev-config.js')))
record('~/.dsh/dsh-web-companion.json（配对密钥）', flagged('/Users/mac/.dsh/dsh-web-companion.json'))
record('.devhome/dsh-web-companion.json（测试配对密钥）', flagged(join(repo, '.devhome/dsh-web-companion.json')))
record('任意 *.pem', SECRET_PATH.test('/tmp/whatever.pem'))
record('任意 id_rsa', SECRET_PATH.test('/Users/mac/.ssh/id_rsa'))

console.log('\n2. 内容嗅探：路径改名也拦得住')
const sneaky = join(dir, 'innocent-looking.txt')
writeFileSync(sneaky, `const a = 1\n-----BEGIN RSA PRIVATE KEY-----\n${'MIIEow'.repeat(40)}\n-----END RSA PRIVATE KEY-----\n`)   // 真实长度的 base64 正文
record('伪装成 ordinary 的 PEM 私钥 → 内容命中', flagged(sneaky))
const fieldName = join(dir, 'config-like.json')
writeFileSync(fieldName, JSON.stringify({ publicKeyDer: 'AAAA', privateKeyPem: 'MIIEow'.repeat(40) }))
record('只有字段名 privateKeyPem → 内容命中', flagged(fieldName))
record('裸 PEM 头（没有正文）**不**误判 —— 否则守卫会拦自己的源码', SECRET_CONTENT.test('-----BEGIN PRIVATE KEY-----') === false)
record('PEM 头 + 真实 base64 正文才判密钥', SECRET_CONTENT.test(`-----BEGIN PRIVATE KEY-----\n${'A'.repeat(200)}`) === true)
record('★守卫自己的源码不被自己拦住（否则它进不了审查材料）', findSecretFiles([join(repo, 'scripts/material-guard.mjs')], read).length === 0)
record('★守卫的测试文件也不被自己拦住', findSecretFiles([join(repo, 'tests/unit/material-guard.test.mjs')], read).length === 0)

console.log('\n3. 不误报：普通源码/文档/配置必须放行')
const clean = join(dir, 'plain.js')
writeFileSync(clean, 'export const answer = 42 // 这是普通源码，没有任何密钥\n')
record('普通 js 文件放行', findSecretFiles([clean], read).length === 0)
record('本项目的 client 半（手写产物）放行', findSecretFiles([join(repo, 'dsh-plugin/lib/client.js')], read).length === 0)
record('package.json 放行', findSecretFiles([join(repo, 'package.json')], read).length === 0)
record('不存在的文件不报错也不误报', findSecretFiles([join(dir, 'nope.js')], read).length === 0)

console.log('\n4. 拒绝信息可读且说明后果（人得知道为什么被拦）')
const text = describeOffenders(findSecretFiles([join(repo, 'scripts/.dev-extension-key.json')], read))
record('点名了文件', text.includes('.dev-extension-key.json'))
record('说明了会把密钥送给模型厂商', text.includes('模型厂商'))
record('给了修法（剔除 + 重跑）', text.includes('grep -v'))

rmSync(dir, { recursive: true, force: true })
// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
