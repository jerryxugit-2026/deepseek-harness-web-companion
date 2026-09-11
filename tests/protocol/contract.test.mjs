#!/usr/bin/env node
/**
 * Protocol contract test (L0, design docs/06 §8.1).
 *
 * Three guarantees, and nothing that needs a browser:
 *   1. every generated artifact is byte-identical to what the schema produces
 *      (so nobody can hand-edit a generated file, and nobody can change the
 *      schema without regenerating);
 *   2. every `protocol/vectors/valid/*.json` validates, and every
 *      `protocol/vectors/invalid/*.json` is rejected with `E_PAYLOAD`;
 *   3. the three artifacts agree on protocol version, message kinds and enums.
 *
 * Usage: node tests/protocol/contract.test.mjs
 */
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SCHEMA_PATH = join(ROOT, 'protocol', 'messages.schema.json')
const VECTORS = join(ROOT, 'protocol', 'vectors')

const failures = []
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ✓ ${label}`)
    return
  }
  console.log(`  ✗ ${label}${detail === '' ? '' : ` — ${detail}`}`)
  failures.push(label)
}

const schemaText = readFileSync(SCHEMA_PATH, 'utf8')
const schema = JSON.parse(schemaText)
const expectedSha = createHash('sha256').update(schemaText).digest('hex')

const ARTIFACTS = [
  'extension/src/lib/protocol.generated.js',
  'dsh-plugin/src/shared/protocol.generated.js',
  'native-host/protocol.generated.mjs',
]

console.log('1. 生成物与 schema 一致（防手改 / 防忘跑 codegen）')
const modules = {}
for (const rel of ARTIFACTS) {
  const mod = await import(pathToFileURL(join(ROOT, rel)).href)
  modules[rel] = mod
  check(`${rel} 头部 sha256 == schema sha256`, mod.SCHEMA_SHA256 === expectedSha, `artifact=${mod.SCHEMA_SHA256.slice(0, 12)}… schema=${expectedSha.slice(0, 12)}…`)
  check(`${rel} protocolVersion == ${String(schema.protocolVersion)}`, mod.PROTOCOL_VERSION === schema.protocolVersion)
}

// re-run codegen in --check mode as the byte-level guard
const { spawnSync } = await import('node:child_process')
const codegen = spawnSync(process.execPath, [join(ROOT, 'protocol', 'codegen.mjs'), '--check'], { encoding: 'utf8' })
check('codegen --check 通过（产物逐字节匹配 schema）', codegen.status === 0, (codegen.stderr ?? '').trim().split('\n')[0])

console.log('\n2. 三端一致（版本 / 消息种类 / 枚举 / 路由 / 通道）')
const [first, ...rest] = Object.values(modules)
for (const [rel, mod] of Object.entries(modules).slice(1)) {
  check(`${rel} 消息种类一致`, JSON.stringify(mod.MESSAGE_KIND) === JSON.stringify(first.MESSAGE_KIND))
  check(`${rel} 枚举一致`, JSON.stringify(mod.ENUM) === JSON.stringify(first.ENUM))
  check(`${rel} 路由一致`, JSON.stringify(mod.ROUTE) === JSON.stringify(first.ROUTE))
  check(`${rel} 通道一致`, JSON.stringify(mod.CHANNEL) === JSON.stringify(first.CHANNEL))
}
void rest

console.log('\n3. 正向量必须全部通过')
const validFiles = readdirSync(join(VECTORS, 'valid')).filter((f) => f.endsWith('.json')).sort()
for (const file of validFiles) {
  const value = JSON.parse(readFileSync(join(VECTORS, 'valid', file), 'utf8'))
  const result = first.validateMessage(value)
  check(`valid/${file}`, result.ok === true, result.ok === false ? result.error.message : '')
}

console.log('\n4. 反向量必须全部被拒（且错误码为 E_PAYLOAD）')
const invalidFiles = readdirSync(join(VECTORS, 'invalid')).filter((f) => f.endsWith('.json')).sort()
for (const file of invalidFiles) {
  const value = JSON.parse(readFileSync(join(VECTORS, 'invalid', file), 'utf8'))
  const result = first.validateMessage(value)
  check(`invalid/${file}`, result.ok === false && result.error.code === 'E_PAYLOAD', result.ok === true ? '意外通过' : `code=${result.error.code}`)
}

console.log('\n5. 命名定义可直接校验（插件路由用）')
const pingVector = JSON.parse(readFileSync(join(VECTORS, 'valid', 'ping.json'), 'utf8'))
check('validateAs("PingResponse") 接受真实 /ag/ping 载荷', first.validateAs('PingResponse', pingVector).ok === true)
check('validateAs("AttachResponse") 接受真实 /ag/attach 载荷', first.validateAs('AttachResponse', JSON.parse(readFileSync(join(VECTORS, 'valid', 'attach-response.json'), 'utf8'))).ok === true)
const unknown = first.validateAs('NopeResponse', {})
check('validateAs 对未知定义返回 E_INTERNAL', unknown.ok === false && unknown.error.code === 'E_INTERNAL')

console.log(`\n结果：${failures.length === 0 ? '全部通过' : `${String(failures.length)} 项失败`}（正向量 ${String(validFiles.length)} / 反向量 ${String(invalidFiles.length)} / 产物 ${String(ARTIFACTS.length)}）`)
if (failures.length > 0) {
  console.log('失败项：')
  for (const failure of failures) console.log(`  - ${failure}`)
  process.exit(1)
}
