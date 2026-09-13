#!/usr/bin/env node
/**
 * ★ 回归测试：**安装过程绝不许改掉扩展 ID**。
 *
 * 由来（2026-09-12，本次引导程序**自己踩出来的真实事故**）：
 * `scripts/init-key.mjs` 原来只有两条路 —— 「`scripts/.dev-extension-key.json` 存在就用它」
 * 与「生成一对新的」。而那个文件是**私钥材料、被 gitignore**，引导程序复制源码到安装目录时
 * **不会带上它**（这是对的）⇒ init-key 就在安装目录里**生成了一对新密钥**：
 *
 *   扩展 ID：idpgkobbblmpmnonlndopijgfmehfmig  →  coceclkaehnmkjkboghilkkkolmjcial
 *
 * 而用户 Chrome 里装着的还是**老 ID** 的扩展 ⇒ 配对文件的 `extensionOrigins`、
 * native host 清单的 `allowed_origins` 全部对不上，**用户原本能用的插件当场失效**。
 *
 * 修法与断言：没有私钥文件时，**沿用 `extension/manifest.json` 里已钉的公钥**。
 * 本测试就是那句话的可执行版 —— 把修法退回去（改成无条件生成新密钥），这里必红。
 *
 * 做法：造一个假的仓库根（`extension/manifest.json` + `scripts/init-key.mjs`），
 * 在里面真跑一遍 init-key，然后断言 ID 没变、且没有偷偷生成新私钥。
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extensionIdFromKey } from '../../bootstrap/lib/extension-id.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

/* 造一个假的仓库根。公钥内容不需要是真 RSA —— extensionIdFromKey 只是对它做 sha256，
   而 init-key 写回去的是 der.toString('base64')，只要 base64 是规范形式就能逐字往返。 */
const PINNED_KEY = Buffer.from('DSH-WEB-COMPANION-TEST-PUBLIC-KEY-DER-BYTES-0123456789').toString('base64')
const EXPECTED_ID = extensionIdFromKey(PINNED_KEY)

function makeFakeRepo({ withPinnedKey, withPrivateKeyFile }) {
  const root = mkdtempSync(join(tmpdir(), 'ag-initkey-'))
  mkdirSync(join(root, 'extension'), { recursive: true })
  // init-key 还会写 extension/src/lib/dev-config.js —— 目录得先存在，否则它 ENOENT 退出
  mkdirSync(join(root, 'extension', 'src', 'lib'), { recursive: true })
  mkdirSync(join(root, 'scripts'), { recursive: true })
  const manifest = { manifest_version: 3, name: 'x', version: '0.1.0' }
  if (withPinnedKey) manifest.key = PINNED_KEY
  writeFileSync(join(root, 'extension', 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  cpSync(join(REPO, 'scripts', 'init-key.mjs'), join(root, 'scripts', 'init-key.mjs'))
  if (withPrivateKeyFile) {
    writeFileSync(join(root, 'scripts', '.dev-extension-key.json'),
      `${JSON.stringify({ publicKeyDer: PINNED_KEY, privateKeyPem: 'irrelevant' }, null, 2)}\n`, { mode: 0o600 })
  }
  return root
}

function runInitKey(root) {
  const home = join(root, 'fake-home')
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'init-key.mjs'), '--home', home, '--port', '3099'],
    { encoding: 'utf8' })
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '', home }
}

console.log('0. 前提：夹具算出来的 ID 是确定的')
record(`夹具 ID = ${EXPECTED_ID}`, EXPECTED_ID.length === 32)
record('换个公钥 ID 就变（说明断言不是在比空值）', extensionIdFromKey(Buffer.from('other').toString('base64')) !== EXPECTED_ID)

console.log('\n1. ★ 没有私钥文件、但 manifest 里钉了公钥（= 引导程序迁移已有部署的情形）')
{
  const root = makeFakeRepo({ withPinnedKey: true, withPrivateKeyFile: false })
  const out = runInitKey(root)
  record('init-key exit 0', out.status === 0)
  const afterKey = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')).key
  record('★ manifest 里的公钥**没被动**（ID 不变）', afterKey === PINNED_KEY)
  record('★ 由 manifest 公钥推出的 ID 仍是原来的', extensionIdFromKey(afterKey) === EXPECTED_ID)
  const pairing = JSON.parse(readFileSync(join(out.home, 'dsh-web-companion.json'), 'utf8'))
  record('★ 配对文件登记的 origin 是原 ID（Chrome 里那个扩展仍被承认）',
    pairing.extensionOrigins?.[0] === `chrome-extension://${EXPECTED_ID}`)
  record('★ 没有偷偷生成新私钥（沿用而不是新建）', existsSync(join(root, 'scripts', '.dev-extension-key.json')) === false)
  record('输出里如实标明来源是 manifest', out.stdout.includes('"extensionKeySource": "manifest"'))
  record('端口按参数写进配对文件', pairing.port === 3099)
  rmSync(root, { recursive: true, force: true })
}

console.log('\n2. 有私钥文件时（= 开发者本机）：照样沿用，ID 不变')
{
  const root = makeFakeRepo({ withPinnedKey: true, withPrivateKeyFile: true })
  const out = runInitKey(root)
  record('exit 0', out.status === 0)
  record('公钥没变', JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')).key === PINNED_KEY)
  record('来源标为 key-file', out.stdout.includes('"extensionKeySource": "key-file"'))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n3. manifest 里也没有公钥（真正的全新环境）：这时才该生成，并落盘私钥')
{
  const root = makeFakeRepo({ withPinnedKey: false, withPrivateKeyFile: false })
  const out = runInitKey(root)
  record('exit 0', out.status === 0)
  const afterKey = JSON.parse(readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')).key
  record('生成了一个公钥', typeof afterKey === 'string' && afterKey.length > 0)
  record('确实新建了私钥文件（首次安装该有）', existsSync(join(root, 'scripts', '.dev-extension-key.json')))
  record('来源标为 generated', out.stdout.includes('"extensionKeySource": "generated"'))
  rmSync(root, { recursive: true, force: true })
}

console.log('\n4. 幂等：连着跑两次，第二次 ID 与文件都不变')
{
  const root = makeFakeRepo({ withPinnedKey: true, withPrivateKeyFile: false })
  runInitKey(root)
  const first = readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')
  runInitKey(root)
  const second = readFileSync(join(root, 'extension', 'manifest.json'), 'utf8')
  record('★ manifest 两次逐字节相同', first === second)
  record('不会第二次又生成私钥', existsSync(join(root, 'scripts', '.dev-extension-key.json')) === false)
  rmSync(root, { recursive: true, force: true })
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
