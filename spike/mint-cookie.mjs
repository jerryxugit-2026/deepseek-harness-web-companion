/**
 * Spike helper: mint a DSH browser-session cookie for a given authority.
 *
 * DSH stores a 32-byte signing secret as a base64url credential record
 * (`client-connection/browser-session`) under $DSH_HOME/.credentials.yaml and
 * hands the browser a signed, authority-bound cookie:
 *
 *   name  = "dsh-auth-" + base64url(sha256(authority))
 *   value = "v1." + base64url(JSON payload) + "." + base64url(hmac_sha256(secret, encodedPayload))
 *   payload = { version: 1, authority, issuedAt, expiresAt }
 *
 * Usage: node mint-cookie.mjs [authority]   # default 127.0.0.1:3080
 * Prints: <cookieName>=<cookieValue>
 */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const b64url = (buf) => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')
const decodeB64url = (value) => Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/'), 'base64')

function readSecret() {
  const home = process.env.DSH_HOME?.trim() !== undefined && process.env.DSH_HOME.trim() !== ''
    ? process.env.DSH_HOME.trim()
    : join(homedir(), '.dsh')
  const text = readFileSync(join(home, '.credentials.yaml'), 'utf8')
  const lines = text.split('\n')
  const start = lines.findIndex((line) => line.startsWith('  client-connection/browser-session:'))
  if (start === -1) throw new Error('no client-connection/browser-session record in credentials')
  for (let i = start; i < lines.length; i += 1) {
    const match = /^\s+secret:\s*(\S+)\s*$/u.exec(lines[i] ?? '')
    if (match !== null) return decodeB64url(match[1])
  }
  throw new Error('no secret field in credentials record')
}

const authority = process.argv[2] ?? '127.0.0.1:3080'
const secret = readSecret()
const name = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`
const issuedAt = Date.now()
const maxAgeDays = 30
const expiresAt = issuedAt + maxAgeDays * 24 * 60 * 60 * 1000
const body = b64url(Buffer.from(JSON.stringify({ version: 1, authority, issuedAt, expiresAt }), 'utf8'))
const value = `v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`
console.log(`${name}=${value}`)
