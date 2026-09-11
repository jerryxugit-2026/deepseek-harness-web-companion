/**
 * Browser-session cookie minting for the embedded client.
 *
 * DSH hands browsers an authority-bound signed cookie:
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON{version,authority,issuedAt,expiresAt})
 *                 + "." + base64url(hmac_sha256(secret, encodedBody))
 * where `secret` is the 32-byte credential record
 * `client-connection/browser-session` and `authority` is the request `Host`.
 *
 * The shipped app can only issue that cookie as `SameSite=Strict`, which breaks
 * the WebSocket handshake inside a `chrome-extension://` iframe (verified: HTTP
 * 200 but `WS /api/remote.mux` -> 401, "connection lost, retry #n"). So this
 * plugin mints the SAME value with `SameSite=None; Secure`, which Chrome accepts
 * for the trustworthy loopback origin.
 *
 * Verified against the live server on 2026-09-11; see FINDINGS.md §2-3.
 */
import { createHash, createHmac } from 'node:crypto'
import { credentialKey } from '@deepseek-ai/dsh-credentials'

/** Credential record DSH stores its browser-session signing secret in. */
export const SESSION_RECORD = credentialKey('client-connection', 'browser-session')

const SECRET_BYTES = 32
const COOKIE_PREFIX = 'dsh-auth-'
const PAYLOAD_VERSION = 1

/** @param {Buffer | Uint8Array | string} value */
function b64url(value) {
  return Buffer.from(value).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
}

function decodeB64url(value) {
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')
}

/** Cookie name for one request authority (`host[:port]`). */
export function cookieName(authority) {
  return COOKIE_PREFIX + b64url(createHash('sha256').update(authority).digest())
}

/**
 * Read the signing secret from the credential provider.
 * @param {{ readRecord: (key: string) => Promise<{ kind: string, payload?: unknown } | undefined> }} credentials
 * @returns {Promise<Buffer | undefined>} raw 32-byte secret, or undefined when unavailable
 */
export async function readSigningSecret(credentials) {
  const record = await credentials.readRecord(SESSION_RECORD)
  if (record === undefined || record.kind !== 'grant') return undefined
  const payload = record.payload
  if (typeof payload !== 'object' || payload === null) return undefined
  const secret = payload.secret
  if (typeof secret !== 'string') return undefined
  const decoded = decodeB64url(secret)
  return decoded.byteLength === SECRET_BYTES ? decoded : undefined
}

/**
 * Mint the cookie value. Exported separately so tests can lock the format with
 * a fixed secret and timestamp vector.
 * @param {Buffer} secret 32-byte signing secret
 * @param {string} authority request authority, e.g. `127.0.0.1:3080`
 * @param {number} issuedAt epoch ms
 * @param {number} expiresAt epoch ms
 */
export function encodeSessionCookie(secret, authority, issuedAt, expiresAt) {
  const body = b64url(Buffer.from(JSON.stringify({ version: PAYLOAD_VERSION, authority, issuedAt, expiresAt }), 'utf8'))
  return `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
}

/**
 * Build the full `Set-Cookie` header value.
 * @param {{ name: string, value: string, maxAgeSeconds: number, expiresAt: number, partitioned?: boolean }} spec
 */
export function sessionCookieHeader(spec) {
  const attributes = [
    `${spec.name}=${spec.value}`,
    `Max-Age=${String(spec.maxAgeSeconds)}`,
    'Path=/',
    `Expires=${new Date(spec.expiresAt).toUTCString()}`,
    'HttpOnly',
    'SameSite=None',
    'Secure',
  ]
  if (spec.partitioned === true) attributes.push('Partitioned')
  return attributes.join('; ')
}

/**
 * End-to-end mint for one request.
 * @param {object} params
 * @param {object} params.credentials credential provider service
 * @param {string} params.authority `Host` header value
 * @param {number} params.maxAgeDays cookie lifetime
 * @param {boolean} [params.partitioned] emit `Partitioned` (CHIPS)
 * @returns {Promise<{ name: string, value: string, header: string } | { error: string }>}
 */
export async function mintSessionCookie({ credentials, authority, maxAgeDays, partitioned = false }) {
  const secret = await readSigningSecret(credentials)
  if (secret === undefined) return { error: 'E_VERSION' }
  const issuedAt = Date.now()
  const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000
  const cookie = {
    name: cookieName(authority),
    value: encodeSessionCookie(secret, authority, issuedAt, expiresAt),
    maxAgeSeconds: Math.floor((expiresAt - issuedAt) / 1000),
    expiresAt,
    partitioned,
  }
  return { ...cookie, header: sessionCookieHeader(cookie) }
}
