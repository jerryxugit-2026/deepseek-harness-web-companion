/**
 * `GET /ag/ping` — liveness, protocol version, pairing state and capabilities.
 *
 * This route is intentionally NOT key-guarded: the extension uses it to decide
 * whether DSH is up, whether the bridge plugin is loaded, and whether the
 * pairing file still needs to be provisioned. It discloses no secrets.
 */
import { fileURLToPath } from 'node:url'
import { isPaired } from '../key-store.js'
import { validateAs } from '../../shared/protocol.generated.js'

export function pingRoute({ state, protocolVersion }) {
  return (_req, res) => {
    const pairing = state.pairing()
    const payload = {
      ok: true,
      protocolVersion,
      plugin: 'dsh-web-companion-bridge',
      pluginVersion: state.pluginVersion,
      keyConfigured: pairing.key !== undefined,
      paired: isPaired(pairing),
      trustedOrigins: pairing.extensionOrigins.length,
      pairingSource: pairing.source,
      /*
       * ★ 新增（2026-09-14，用户在一台机器上装了两份插件之后提的）：**"我这份代码是从哪个文件加载的"**。
       *
       * 为什么必须有：机器上可以同时存在多份安装（例如 `~/.dsh/plugins/dsh-web-companion` 一份旧的、
       * 项目目录一份新的）。`doctor` 只能检查"它以为的那个安装目录"，而**真正在跑的**是哪一份，
       * 从外面完全看不出来 —— 实测出现过"自查全绿、实际跑的是 0.1.0"的假绿。
       * 报出加载路径之后，doctor 可以拿它跟 profile 挂载行逐字比对，假绿无处可藏。
       *
       * 从 `routes/ping.js` 往上一级就是这个入口文件本身，正好等于 profile 挂载里 `name:` 的那一行。
       */
      pluginEntry: fileURLToPath(new URL('../index.js', import.meta.url)),
      // always a string|null: the schema is closed, and an omitted optional
      // field must still be explicit rather than `undefined`
      pairingError: pairing.error ?? null,
      dsh: { home: state.dshHome, port: state.port() },
      capabilities: state.capabilities(),
      // Omitted when the state cannot answer — NOT set to `undefined`. The schema treats a key that
      // is present with `undefined` as a type error ("expected number, got undefined"), so the old
      // form turned a state object without these probes into a 500 E_INTERNAL on the one route that
      // exists to *explain* the install (caught by tests/unit/pairing-semantics.test.mjs).
      ...(typeof state.liveTickets === 'function' ? { liveTickets: state.liveTickets() } : {}),
      ...(typeof state.connectedClients === 'function' ? { connectedClients: state.connectedClients() } : {}),
    }
    // Fail loudly on drift: a payload the schema rejects must never ship.
    const validated = validateAs('PingResponse', payload)
    if (!validated.ok) {
      res.writeHead(500, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify({ ok: false, error: { code: 'E_INTERNAL', message: `ping payload violates schema: ${validated.error.message}` } }))
      return
    }
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(payload))
  }
}
