/**
 * Native messaging client (design docs/05 §2, docs/02 §3.3).
 *
 * Chrome cannot start processes, so DSH auto-start goes through a native host:
 * one frame in, one frame out, then the port is closed. The connection is
 * deliberately short-lived — a long-lived port would keep the MV3 service
 * worker alive forever and hide lifetime bugs.
 */
import { fail, ok } from '../lib/result.js'

export const HOST_NAME = 'com.dsh.web_companion'
const DEFAULT_TIMEOUT_MS = 25000

/** Send one command to the host and resolve with its reply. */
export function callNative(cmd, args = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let port
    try {
      port = chrome.runtime.connectNative(HOST_NAME)
    } catch (error) {
      resolve(fail('E_NATIVE_MISSING', String(error?.message ?? error)))
      return
    }
    const id = `n-${Date.now().toString(36)}`
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { port.disconnect() } catch { /* already closed */ }
      resolve(value)
    }
    const timer = setTimeout(() => { finish(fail('E_TIMEOUT', 'native host did not answer in time')) }, timeoutMs)
    port.onMessage.addListener((message) => {
      if (message?.id !== id) return
      if (message.ok === true) finish(ok(message.result))
      else finish(fail(message.error?.code ?? 'E_INTERNAL', message.error?.message ?? 'native host error', message.error?.detail))
    })
    port.onDisconnect.addListener(() => {
      const reason = chrome.runtime.lastError?.message
      if (reason === undefined) return
      finish(fail(/not found|not registered|Access to the specified native messaging host is forbidden/u.test(reason) ? 'E_NATIVE_MISSING' : 'E_INTERNAL', reason))
    })
    try {
      port.postMessage({ id, cmd, args })
    } catch (error) {
      finish(fail('E_NATIVE_MISSING', String(error?.message ?? error)))
    }
  })
}

/** Make sure a DSH web server is listening; returns its URL when we started it. */
export const ensureDsh = (args = {}) => callNative('ensure-dsh', args)
export const dshStatus = (args = {}) => callNative('status', args)
export const stopDsh = (args = {}) => callNative('stop-dsh', args)
