/**
 * DSH process launcher (design docs/05 §3).
 *
 * Owns one job: make sure a `dsh web` server is listening, and hand back the
 * tokenized startup URL when we were the ones who started it.
 *
 * Measured facts this relies on: the launcher prints exactly one
 * `dsh web: http://127.0.0.1:<port>/?token=<43 chars>` line, ~4 s after a cold
 * start (FINDINGS §2). The child is detached and unreferenced so it survives the
 * native host exiting.
 */
import { spawn } from 'node:child_process'
import { connect } from 'node:net'
import { readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

const URL_LINE = /^dsh web:\s+(\S+)/mu
const DEFAULT_PORT = 3080
const DEFAULT_TIMEOUT_MS = 20000

/** Is something already listening on the loopback port? */
export function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    const done = (value) => { socket.removeAllListeners(); socket.destroy(); resolve(value) }
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
    socket.setTimeout(timeoutMs, () => done(false))
  })
}

/** Where the runtime facts (pid/port/url) are remembered. */
export function stateFile(dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')) {
  return join(dshHome, 'web-companion-dsh.json')
}

/**
 * Start `dsh web` and resolve once the tokenized URL appears (or the timeout,
 * or the child exits). Never throws for the "already running" case.
 * @param {{ port?: number, profile?: string, timeoutMs?: number, dshBin?: string, dshHome?: string, spawnImpl?: typeof spawn }} [options]
 */
export async function ensureDsh(options = {}) {
  const port = options.port ?? DEFAULT_PORT
  const profile = options.profile ?? 'web'
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const dshBin = options.dshBin ?? process.env.DSH_BIN ?? 'dsh'
  const dshHome = options.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const spawnImpl = options.spawnImpl ?? spawn

  if (await probePort(port)) {
    return { started: false, port, url: `http://127.0.0.1:${String(port)}/`, token: null, reason: 'already-listening' }
  }

  // `dsh web` is the alias of `--profile web`; passing `--profile` again makes
  // the CLI fail with "unknown option '--profile'" (measured), so the flags
  // after `web` are the web app's own.
  void profile
  const child = spawnImpl(dshBin, ['web', '--no-open', '--port', String(port)], {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DSH_HOME: dshHome },
  })
  child.unref?.()

  const collected = []
  let url
  let token = null
  const deadline = Date.now() + timeoutMs

  const started = await new Promise((resolve) => {
    let buffer = ''
    const onData = (chunk) => {
      buffer += String(chunk)
      collected.push(String(chunk))
      if (collected.length > 40) collected.shift()
      const match = URL_LINE.exec(buffer)
      if (match !== null && url === undefined) {
        url = match[1]
        try { token = new URL(url).searchParams.get('token') } catch { token = null }
        resolve('url')
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', (chunk) => { collected.push(String(chunk)) })
    child.once('error', (error) => resolve(`error:${String(error.message)}`))
    child.once('exit', (code) => resolve(`exit:${String(code)}`))
    const timer = setInterval(() => {
      if (Date.now() > deadline) { clearInterval(timer); resolve('timeout') }
    }, 200)
    timer.unref?.()
    setTimeout(() => { clearInterval(timer) }, timeoutMs + 50).unref?.()
  })

  if (started !== 'url' || url === undefined) {
    return {
      started: false,
      port,
      failure: started,
      stderrTail: collected.join('').split('\n').slice(-8).join('\n').slice(-800),
    }
  }

  const record = { pid: child.pid ?? null, port, url, token, startedAt: Date.now() }
  try { await writeFile(stateFile(dshHome), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 }) } catch { /* best effort */ }
  return { started: true, ...record }
}

/** Read the remembered runtime facts, if any. */
export async function readState(dshHome) {
  try { return JSON.parse(await readFile(stateFile(dshHome), 'utf8')) } catch { return null }
}
