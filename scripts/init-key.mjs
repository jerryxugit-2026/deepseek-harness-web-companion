#!/usr/bin/env node
/**
 * Provision the extension <-> bridge-plugin pairing.
 *
 *   1. Generate (once) an RSA key pair and pin the extension id by writing the
 *      public key into `extension/manifest.json` — an unpacked extension's id is
 *      otherwise derived from its directory path, which changes per checkout.
 *   2. Generate the shared key and write `$DSH_HOME/dsh-web-companion.json`
 *      (0600) with the trusted extension origin list.
 *   3. Write the same key + port into `extension/src/lib/dev-config.js` so the
 *      development build can talk to the bridge without an options page.
 *
 * Usage:
 *   node scripts/init-key.mjs [--home <dsh home>] [--port 3080] [--print-id]
 */
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const EXT_DIR = join(ROOT, 'extension')
const KEY_FILE = join(ROOT, 'scripts', '.dev-extension-key.json')

const argOf = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`)
  return at === -1 ? fallback : process.argv[at + 1]
}
const hasFlag = (name) => process.argv.includes(`--${name}`)

const dshHome = resolve(argOf('home', process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')))
const port = Number(argOf('port', '3080'))

/** Chrome extension id from a DER public key: sha256, first 16 bytes, nibble -> a..p. */
function extensionIdFromPublicKey(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32)
  return [...hex].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')
}

/**
 * 复用已钉的密钥对，或首次创建。
 *
 * ★ 2026-09-12 修的**真实回归**（本引导程序自己踩出来的）：
 * 原来只有「`scripts/.dev-extension-key.json` 存在」和「生成一对新的」两条路。
 * 而那个文件是**密钥材料、被 gitignore**，引导程序把它复制到安装目录时**不会带上**
 * （这是对的：不该把私钥发出去）⇒ 于是 init-key 在安装目录里**生成了一对新密钥**，
 * 扩展 ID 从 `idpgkobbblmpmnonlndopijgfmehfmig` 变成 `coceclkaehnmkjkboghilkkkolmjcial`，
 * 而用户 Chrome 里装着的还是**老 ID** 的扩展 ⇒ 配对文件里的 `extensionOrigins` 与
 * native host 清单的 `allowed_origins` 全部对不上，**用户原来能用的插件当场失效**。
 *
 * 修法：**没有私钥文件时，先看 `extension/manifest.json` 里已经钉着的公钥**，
 * 有就直接沿用它（私钥只有打 .crx 才用得上，本项目不需要）。这样：
 *   · 迁移已有部署 → 沿用老 ID，Chrome 里那个扩展继续有效；
 *   · 全新 clone → manifest 里那份被提交的公钥就是项目故意钉的 ID，同样沿用；
 *   · 只有"manifest 里也没有 key"时才生成新的（并落盘私钥备用）。
 */
function loadOrCreateKeyPair() {
  if (existsSync(KEY_FILE)) {
    const stored = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    const der = Buffer.from(stored.publicKeyDer, 'base64')
    return { der, privateKeyPem: stored.privateKeyPem, created: false, source: 'key-file' }
  }
  // 没有私钥文件：优先沿用 manifest 里已经钉着的公钥
  const pinned = readPinnedManifestKey()
  if (pinned !== null) {
    return { der: Buffer.from(pinned, 'base64'), privateKeyPem: null, created: false, source: 'manifest' }
  }
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  const stored = { publicKeyDer: Buffer.from(publicKey).toString('base64'), privateKeyPem: privateKey }
  writeFileSync(KEY_FILE, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 })
  return { der: Buffer.from(publicKey), privateKeyPem: privateKey, created: true, source: 'generated' }
}

/** 读 `extension/manifest.json` 里已钉的公钥（base64 DER）；没有返回 null。 */
function readPinnedManifestKey() {
  try {
    const raw = JSON.parse(readFileSync(join(EXT_DIR, 'manifest.json'), 'utf8'))?.key
    return typeof raw === 'string' && raw !== '' ? raw : null
  } catch {
    return null
  }
}

const { der, created, source } = loadOrCreateKeyPair()
const extensionId = extensionIdFromPublicKey(der)
const manifestKey = der.toString('base64')

// 1. pin the extension id in the manifest
const manifestPath = join(EXT_DIR, 'manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
manifest.key = manifestKey
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

// 2. pairing file for the bridge plugin — reuse the existing key unless
//    --rotate is passed, so re-provisioning a different port never silently
//    invalidates a running DSH instance or an already-loaded extension.
const COMPANION_FILE = 'dsh-web-companion.json'
const companionPathEarly = join(dshHome, COMPANION_FILE)
const existingKey = (() => {
  try { return JSON.parse(readFileSync(companionPathEarly, 'utf8')).key } catch { return undefined }
})()
const bridgeKey = (hasFlag('rotate') || typeof existingKey !== 'string' || existingKey === '')
  ? randomBytes(32).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
  : existingKey
const companion = {
  version: 1,
  key: bridgeKey,
  extensionOrigins: [`chrome-extension://${extensionId}`],
  port,
  createdAt: new Date().toISOString(),
}
mkdirSync(dshHome, { recursive: true })
const companionPath = join(dshHome, COMPANION_FILE)
writeFileSync(companionPath, `${JSON.stringify(companion, null, 2)}\n`, { mode: 0o600 })
chmodSync(companionPath, 0o600)

// 3. dev config inside the extension
writeFileSync(
  join(EXT_DIR, 'src', 'lib', 'dev-config.js'),
  `/**\n * AUTO-GENERATED by scripts/init-key.mjs — do not edit by hand.\n */\nexport const DEV_CONFIG = { port: ${String(port)}, key: '${bridgeKey}' }\n`,
)

console.log(JSON.stringify({
  extensionId,
  extensionKeyPinned: created ? 'generated' : 'reused',
  extensionKeySource: source,
  pairingFile: companionPath,
  port,
  origin: `chrome-extension://${extensionId}`,
}, null, 2))
