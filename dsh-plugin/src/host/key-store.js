/**
 * Shared-key store.
 *
 * The pairing file is written by `scripts/init-key.mjs`:
 *   { "key": "<43-char base64url>", "extensionOrigins": ["chrome-extension://<id>"] }
 *
 * Fail-closed contract: when the file is missing or malformed the plugin still
 * loads (so `/ag/ping` can explain the state) but every guarded route refuses.
 */
import { readFile } from 'node:fs/promises'
import { companionPath } from './paths.js'

/**
 * @typedef {object} CompanionKey
 * @property {string | undefined} key        shared secret, undefined when unpaired
 * @property {readonly string[]} extensionOrigins trusted `chrome-extension://<id>` origins
 * @property {string} source                 file the values came from
 * @property {string | undefined} error      load failure, when any
 */

/** @returns {Promise<CompanionKey>} */
export async function loadCompanionKey(path = companionPath()) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    const key = typeof parsed.key === 'string' && parsed.key.length > 0 ? parsed.key : undefined
    const origins = Array.isArray(parsed.extensionOrigins)
      ? parsed.extensionOrigins.filter((entry) => typeof entry === 'string')
      : []
    return { key, extensionOrigins: origins, source: path, error: undefined }
  } catch (error) {
    return { key: undefined, extensionOrigins: [], source: path, error: String(error) }
  }
}
