/**
 * Loopback URL construction and the shared dev/prod configuration.
 *
 * `KEY` and `PORT` come from `dev-config.js`, which the provisioning script
 * (`scripts/init-key.mjs`) generates: in a packaged build the key is stored in
 * `chrome.storage.local` by the options page instead, and this module reads it
 * from there.
 */
import { DEV_CONFIG } from './dev-config.js'
import { CHANNEL, PROTOCOL_VERSION, ROUTE } from './protocol.generated.js'

/** DSH web port the companion talks to. */
export const dshPort = () => DEV_CONFIG.port

/** Base origin of the local DSH instance. */
export const dshOrigin = () => `http://127.0.0.1:${String(dshPort())}`

/** Liveness + pairing probe. */
export const pingUrl = () => `${dshOrigin()}${ROUTE.ping}`

/** One-time entry ticket (replaces handing the long-lived key to the frame URL). */
export const ticketUrl = () => `${dshOrigin()}${ROUTE.ticket}`

/** Capture submission. */
export const attachUrl = () => `${dshOrigin()}${ROUTE.attach}`

export { PROTOCOL_VERSION }

/** Authentication handshake URL assigned to the embedded frame. */
export const enterUrl = (key = DEV_CONFIG.key) => `${dshOrigin()}${ROUTE.enter}?key=${encodeURIComponent(key)}`

/** Preferred handshake: exchange a ticket (not the long-lived key) for the frame URL. */
export const enterUrlWithTicket = (ticket) => `${dshOrigin()}${ROUTE.enter}?ticket=${encodeURIComponent(ticket)}`

/** WebSocket channel used by the agent tool bridge (M3). */
export const agentSocketUrl = (key = DEV_CONFIG.key) =>
  `ws://127.0.0.1:${String(dshPort())}${CHANNEL.agent}?key=${encodeURIComponent(key)}`

/** Whether the dev pairing file has been provisioned. */
export const isPaired = () => typeof DEV_CONFIG.key === 'string' && DEV_CONFIG.key.length > 0
