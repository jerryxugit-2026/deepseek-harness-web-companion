/**
 * 扩展 ID 的唯一推导处。
 *
 * 一个已解压扩展的 ID 平时是由**目录路径**派生的（换个目录就换 ID），所以本项目在
 * `extension/manifest.json` 里钉了一个公钥 `key`，让 ID 稳定。
 * ID 的算法：`sha256(公钥 DER)` 取前 16 字节，每个 nibble 映射到 a..p。
 *
 * 这个函数原来在本仓**抄了两遍**（`scripts/init-key.mjs` 与 `native-host/install.mjs`）。
 * 两处算法一旦漂移，表现是"native host 的 allowed_origins 与配对文件里的 origin 不一致"
 * —— 面板连不上，而且要查很久。故收成一处。
 */
import { createHash } from 'node:crypto'

/** 由 base64 的 DER 公钥算出 Chrome 扩展 ID。 */
export function extensionIdFromKey(keyBase64) {
  if (typeof keyBase64 !== 'string' || keyBase64 === '') {
    throw new TypeError('extensionIdFromKey: 需要 manifest 里的 base64 公钥（key 字段）')
  }
  const hex = createHash('sha256').update(Buffer.from(keyBase64, 'base64')).digest('hex').slice(0, 32)
  return [...hex].map((nibble) => String.fromCharCode(97 + Number.parseInt(nibble, 16))).join('')
}

/** 扩展的 origin 形态（配对文件与 native host 清单都用它）。 */
export function extensionOrigin(extensionId) {
  return `chrome-extension://${extensionId}`
}
