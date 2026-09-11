#!/usr/bin/env node
/**
 * Native messaging host (design docs/05 §2).
 *
 * Chrome talks to this process over stdio with 4-byte little-endian length
 * prefixed JSON frames. stdout carries frames ONLY; every log line goes to the
 * log file, because a stray print would desynchronise Chrome's parser.
 *
 * Commands: ensure-dsh | status | stop-dsh | get-info
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { ensureDsh, probePort, readState } from './launcher.mjs'

const MAX_FRAME = 1024 * 1024 // Chrome's host→browser ceiling
const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const logFile = process.env.DSH_COMPANION_LOG ?? join(dshHome, 'logs', 'dsh-web-companion-host.log')

function log(line) {
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`)
  } catch { /* logging must never break the protocol */ }
}

function writeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  process.stdout.write(Buffer.concat([header, body]))
}

/** One command → one response payload. */
async function handle(request) {
  switch (request?.cmd) {
    case 'ensure-dsh': {
      const result = await ensureDsh(request.args ?? {})
      log(`ensure-dsh → started=${String(result.started)} port=${String(result.port)}`)
      return result.failure === undefined
        ? { ok: true, result }
        : { ok: false, error: { code: 'E_DSH_DOWN', message: `dsh web failed to start (${String(result.failure)})`, detail: result.stderrTail } }
    }
    case 'status': {
      const state = await readState(dshHome)
      const port = request.args?.port ?? state?.port ?? 3080
      const listening = await probePort(port)
      log(`status → listening=${String(listening)} port=${String(port)}`)
      return { ok: true, result: { running: listening, port, pid: state?.pid ?? null, url: state?.url ?? null } }
    }
    case 'stop-dsh': {
      const state = await readState(dshHome)
      const pid = request.args?.pid ?? state?.pid
      if (typeof pid !== 'number') return { ok: true, result: { stopped: false, reason: 'no-pid' } }
      try { process.kill(pid, 'SIGTERM') ; log(`stop-dsh → SIGTERM ${String(pid)}`); return { ok: true, result: { stopped: true, pid } } } catch (error) {
        return { ok: false, error: { code: 'E_INTERNAL', message: String(error) } }
      }
    }
    case 'get-info':
      return { ok: true, result: { dshHome, node: process.execPath, host: new URL(import.meta.url).pathname, logFile } }
    default:
      return { ok: false, error: { code: 'E_PAYLOAD', message: `unknown command ${String(request?.cmd)}` } }
  }
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    if (buffer.length < 4) return
    const length = buffer.readUInt32LE(0)
    if (length > MAX_FRAME) { log(`frame too large (${String(length)}) — exiting`); process.exit(1) }
    if (buffer.length < 4 + length) return
    const body = buffer.subarray(4, 4 + length)
    buffer = buffer.subarray(4 + length)
    let request
    try { request = JSON.parse(body.toString('utf8')) } catch (error) { log(`bad JSON frame: ${String(error)}`); continue }
    void handle(request).then((response) => {
      writeFrame({ id: request?.id ?? null, ...response })
    })
  }
})
process.stdin.on('end', () => { log('stdin closed — exiting'); process.exit(0) })
log(`host started pid=${String(process.pid)}`)
