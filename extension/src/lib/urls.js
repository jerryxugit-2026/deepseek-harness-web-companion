/**
 * Loopback URL construction and the shared dev/prod configuration.
 *
 * `KEY` and `PORT` come from `dev-config.js`, which the provisioning script
 * (`scripts/init-key.mjs`) generates: in a packaged build the key is stored in
 * `chrome.storage.local` by the options page instead, and this module reads it
 * from there.
 */
import { DEV_CONFIG } from './dev-config.js'

/** DSH web port the companion talks to. */
export const dshPort = () => DEV_CONFIG.port

/** Base origin of the local DSH instance. */
export const dshOrigin = () => `http://127.0.0.1:${String(dshPort())}`

/** Liveness + pairing probe. */
export const pingUrl = () => `${dshOrigin()}/ag/ping`

/** Authentication handshake URL assigned to the embedded frame. */
export const enterUrl = (key = DEV_CONFIG.key) => `${dshOrigin()}/ag/enter?key=${encodeURIComponent(key)}`

/** WebSocket channel used by the agent tool bridge (M3). */
export const agentSocketUrl = (key = DEV_CONFIG.key) =>
  `ws://127.0.0.1:${String(dshPort())}/ag/agent?key=${encodeURIComponent(key)}`

/** Whether the dev pairing file has been provisioned. */
export const isPaired = () => typeof DEV_CONFIG.key === 'string' && DEV_CONFIG.key.length > 0
