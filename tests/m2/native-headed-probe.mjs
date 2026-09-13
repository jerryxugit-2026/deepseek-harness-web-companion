#!/usr/bin/env node
/**
 * M2 · native messaging probe in HEADED Chrome.
 *
 * The headless test path runs Chrome as a child of this (sandboxed) agent, where
 * native-host manifest lookup failed with "Specified native messaging host not
 * found". This probe repeats the exact call in a normal headed Chrome to
 * separate "the feature is broken" from "the test harness cannot exercise it".
 *
 * It opens a small window and closes it automatically.
 */
import { execFileSync } from 'node:child_process'
import { cpSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createResults } from '../lib/probe-result.mjs'

const CDP = 9235
const PROFILE = '/tmp/dshwc-native-headed'
const EXT = '/tmp/dshwc-native-ext'
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms) })

rmSync(PROFILE, { recursive: true, force: true })
rmSync(EXT, { recursive: true, force: true })
cpSync(join(process.cwd(), 'extension', 'dist'), EXT, { recursive: true })

console.log('启动有头 Chrome（约 16 秒后自动关闭）…')
execFileSync('/usr/bin/env', ['bash', '-c',
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=${PROFILE} --remote-debugging-port=${CDP} --no-first-run --no-default-browser-check --window-size=520,400 about:blank >/tmp/native-headed.log 2>&1 & echo $!`,
])

const cleanup = () => { try { execFileSync('/usr/bin/env', ['bash', '-c', `pkill -f ${PROFILE} 2>/dev/null || true`]) } catch { /* gone */ } }
process.on('exit', cleanup)

let ws
for (let i = 0; i < 40; i += 1) {
  try { ws = (await (await fetch(`http://127.0.0.1:${CDP}/json/version`)).json()).webSocketDebuggerUrl; break } catch { await sleep(500) }
}
if (ws === undefined) { console.error('有头 Chrome 未就绪'); cleanup(); process.exit(1) }

const socket = new WebSocket(ws)
await new Promise((r) => socket.addEventListener('open', r, { once: true }))
let id = 0
const pending = new Map()
socket.addEventListener('message', (e) => {
  const m = JSON.parse(e.data)
  if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
})
const send = (method, params = {}, sessionId) => {
  const myId = ++id
  socket.send(JSON.stringify({ id: myId, method, params, ...(sessionId === undefined ? {} : { sessionId }) }))
  return new Promise((resolve) => { pending.set(myId, resolve) })
}

const ext = await send('Extensions.loadUnpacked', { path: EXT })
const extId = ext.result.id
const target = await send('Target.createTarget', { url: `chrome-extension://${extId}/src/sidepanel/panel.html` })
const attached = await send('Target.attachToTarget', { targetId: target.result.targetId, flatten: true })
const sid = attached.result.sessionId
await send('Runtime.enable', {}, sid)
await sleep(1500)

const expression = `(async () => {
  try {
    const port = chrome.runtime.connectNative('com.dsh.web_companion')
    const reply = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ timeout: true }), 6000)
      port.onMessage.addListener((m) => { clearTimeout(timer); resolve({ message: m }) })
      port.onDisconnect.addListener(() => resolve({ disconnected: chrome.runtime.lastError?.message ?? 'no reason' }))
      port.postMessage({ id: 'h1', cmd: 'get-info' })
    })
    try { port.disconnect() } catch {}
    return JSON.stringify(reply)
  } catch (error) { return JSON.stringify({ threw: String(error), lastError: chrome.runtime.lastError?.message ?? null }) }
})()`

const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sid)
console.log('有头 Chrome connectNative:', result.result.result.value)
cleanup()
// 这个探针**本来一条断言都没有**（PiMoa 审核指出：零断言、零报告）。这里不假装它有：
// finish() 会如实打印「断言 0 条」，把缺口显式留在报告里，而不是静默绿。
const recorder = createResults({ label: 'm2-native-headed' })
recorder.finish()
