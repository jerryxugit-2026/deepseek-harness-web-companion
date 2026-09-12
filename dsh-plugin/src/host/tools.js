/**
 * M3 model tools: the `browser_*` set the agent calls (design docs/03 §6).
 *
 * Layering, deliberately: the **plugin** owns tool registration, the read/write
 * gate and the workspace; the **extension** owns the browser. Every tool is a thin
 * shell over one `tool-call` frame, so there is exactly one place where "what the
 * model asked for" turns into "what the browser did" — and that place reports which
 * path served it (`trusted`).
 *
 * Two rules worth stating because they are easy to erode:
 *
 *   1. **Write tools are not registered at all unless `allowBrowserWriteOps` is
 *      true.** Not "registered but refused": an unregistered tool is invisible to
 *      the model, so it cannot be talked into trying. The extension re-checks the
 *      same flag on the frame (`E_READONLY`), so neither side is the only guard.
 *   2. **Failure is a tool error, not an exception** (`{code, message}`), because a
 *      dead extension or a missing element is normal operation for a browser tool;
 *      the model needs to read it and try something else.
 *
 * The output schemas below are enforced twice: the runtime validates every returned
 * value against them, and `tests/unit/browser-tools.test.mjs` feeds each tool's real
 * return value through `validateJsonSchemaValue` so a schema that drifts from the
 * implementation fails in CI instead of at the user's first call.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sweepCaptures } from './retention.js'

/** Closed shape shared by every tool: the value, or a diagnosable error. */
const ERROR_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    code: { type: 'string', required: true },
    message: { type: 'string', required: true },
  },
}

/** `oneOf` success-variant + error — the DSH tool-output convention. */
const withError = (success) => ({ oneOf: [success, ERROR_SCHEMA] })

const str = (description) => ({ type: 'string', description })
const num = (description) => ({ type: 'number', description })
const bool = (description) => ({ type: 'boolean', description })

const TAB_PARAM = { type: 'number', description: '目标标签页 id；省略则用用户当前所在页（不会抓扩展自身的页面）' }

/** Map a transport rejection onto the tool-error shape the model can act on. */
function toToolError(error) {
  const code = error?.code ?? 'E_INTERNAL'
  const hint = code === 'E_EXT_OFFLINE'
    ? '浏览器扩展没连着：请打开侧边栏（面板打开时才会建立 /ag/agent 通道）'
    : code === 'E_TIMEOUT'
      ? '扩展在超时前没有回应，页面可能正在加载；可以先用 browser_wait'
      : undefined
  return { code, message: `${String(error?.message ?? error)}${hint === undefined ? '' : `（${hint}）`}` }
}

/** One screenshot file, kept next to the captures and swept by the same policy. */
async function persistScreenshot({ workspace, attachDir, base64, mime, stamp, id6, retentionHours, log }) {
  const dir = join(workspace, attachDir, 'assets')
  await mkdir(dir, { recursive: true })
  const ext = mime === 'image/jpeg' ? 'jpg' : 'png'
  const name = `browser-${stamp}-${id6}.${ext}`
  const filePath = join(dir, name)
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, Buffer.from(base64, 'base64'))
  await rename(tmp, filePath)
  if (retentionHours > 0) await sweepCaptures(dir, { retentionHours, log })
  return { filePath, fileRef: `@${attachDir}/assets/${name}` }
}

/** Local `yyyy-MM-dd-HHmm` stamp, same convention as captures. */
function stampOf(date = new Date()) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
}

/**
 * Build the tool definitions (no registration side effects — the unit test drives
 * these directly).
 *
 * @param {object} options
 * @param {{ callAgent: (request: object, options?: object) => Promise<object> }} options.hub
 * @param {{ toolTimeoutMs?: number, allowBrowserWriteOps?: boolean, attachDir?: string, retentionHours?: number, defaultWorkspace?: string }} options.config
 * @param {(request?: object) => string | undefined} options.resolveWorkspace
 * @param {(line: string) => void} [options.log]
 */
export function buildBrowserTools({ hub, config, resolveWorkspace, log = () => {} }) {
  const timeoutMs = config.toolTimeoutMs ?? 10000
  const allowWrite = config.allowBrowserWriteOps === true

  /** One call, mapped to `{value}` or `{error}` — never a thrown exception. */
  const dispatch = async (tool, params, exec, perCallTimeout) => {
    try {
      const frame = await hub.callAgent({ tool, params, allowWrite }, { timeoutMs: perCallTimeout ?? timeoutMs })
      if (frame.ok !== true) return { error: frame.error ?? { code: 'E_INTERNAL', message: `${tool} failed` } }
      return { value: frame.value ?? {} }
    } catch (error) {
      return { error: toToolError(error) }
    }
  }

  const definitions = []
  const add = (spec) => definitions.push(defineTool(spec))

  // ── read-only tools: always registered ──────────────────────────────────────
  add({
    name: 'browser_read',
    description: '读取网页正文（清洗后的 Markdown），或只读某个 CSS 选择器对应的元素。用于理解用户正在看的页面。',
    parameters: {
      selector: str('可选：只读这个 CSS 选择器对应的元素文本'),
      tabId: TAB_PARAM,
    },
    output: {
      // Declared fields = exactly what the extension returns, in both modes; the
      // schema compiler demands an explicit `additionalProperties`, so this doubles
      // as the contract the extension cannot quietly widen.
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: num('目标标签页 id'),
          url: str('页面 URL'),
          title: str('页面标题'),
          domain: str('域名'),
          markdown: str('清洗后的正文 Markdown'),
          text: str('选择器模式下的元素文本'),
          selector: str('选择器模式下读的元素选择器'),
          tag: str('选择器模式下的元素标签'),
          chars: num('字符数'),
          truncated: bool('正文是否被截断'),
          hasVideo: bool('页面是否含 <video>'),
        },
      }),
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args) {
      const result = await dispatch('browser_read', args, undefined, timeoutMs)
      return result.error ?? result.value
    },
  })

  add({
    name: 'browser_tabs',
    description: '列出浏览器里打开的标签页（id/标题/URL/是否活动），用于定位要操作的页面。',
    parameters: { urlContains: str('可选：只列 URL 含该子串的标签页') },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          count: num('返回条数'),
          total: num('浏览器里的标签页总数'),
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'number', required: true },
                title: str('标题'),
                url: str('URL'),
                active: bool('是否活动标签'),
                windowId: num('窗口 id'),
                lastAccessed: num('最近访问时间戳'),
              },
            },
          },
        },
      }),
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args) {
      const result = await dispatch('browser_tabs', args, undefined, timeoutMs)
      return result.error ?? result.value
    },
  })

  add({
    name: 'browser_wait',
    description: '等待：固定毫秒、等选择器出现、或等页面上出现某段文字。用于等异步加载，替代盲等。',
    parameters: {
      ms: num('等待毫秒（默认 500，上限 30000）'),
      selector: str('可选：等该 CSS 选择器出现'),
      text: str('可选：等页面文本中出现该子串'),
      timeoutMs: num('超时毫秒（默认 5000）'),
      tabId: TAB_PARAM,
    },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: num('目标标签页 id'),
          waited: str('等待类型：ms | selector | text'),
          elapsedMs: num('实际等待毫秒'),
          selector: str('等待的选择器'),
          text: str('等待的文本'),
        },
      }),
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args) {
      const result = await dispatch('browser_wait', args, undefined, Math.min((args?.timeoutMs ?? 5000) + 2000, 30000))
      return result.error ?? result.value
    },
  })

  add({
    name: 'browser_screenshot',
    description: '截图。整页或视口，PNG 会存到工作区并返回路径（可直接用 @ 引用给用户看）。',
    parameters: {
      fullPage: bool('是否整页（默认视口；整页需要「浏览器控制」开关）'),
      tabId: TAB_PARAM,
    },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: str('落盘的 PNG 绝对路径'),
          fileRef: str('工作区相对引用（@…）'),
          bytes: num('文件字节数'),
          mime: str('MIME 类型'),
          fullPage: bool('是否整页'),
          trusted: bool('是否走 debugger（可信路径）'),
        },
      }),
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args) {
      const result = await dispatch('browser_screenshot', args, undefined, 20000)
      if (result.error !== undefined) return result.error
      const value = result.value
      if (typeof value.base64 !== 'string' || value.base64 === '') {
        return { code: 'E_STORAGE', message: `extension returned no pixels (${String(value.base64Omitted === true ? 'frame dropped them' : 'empty')})` }
      }
      const workspace = resolveWorkspace()
      if (typeof workspace !== 'string' || workspace === '') {
        return { code: 'E_NO_WORKSPACE', message: 'no workspace resolved — cannot store the screenshot' }
      }
      const saved = await persistScreenshot({
        workspace,
        attachDir: config.attachDir ?? '网页捕获',
        base64: value.base64,
        mime: typeof value.mime === 'string' ? value.mime : 'image/png',
        stamp: stampOf(),
        id6: Math.random().toString(16).slice(2, 8),
        retentionHours: config.retentionHours ?? 24,
        log,
      })
      return { ...saved, bytes: value.bytes ?? Math.round((value.base64.length * 3) / 4), mime: value.mime ?? 'image/png', fullPage: value.fullPage === true, trusted: value.trusted === true }
    },
  })

  add({
    name: 'browser_ax',
    description: '取页面的无障碍树（role/name/value 列表）。比抓正文更适合定位可点元素，需要「浏览器控制」开关。',
    parameters: { maxNodes: num('最多返回多少节点（默认 400）'), tabId: TAB_PARAM },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: num('目标标签页 id'),
          url: str('页面 URL'),
          title: str('页面标题'),
          total: num('树里的节点总数'),
          truncated: bool('是否被 maxNodes 截断'),
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                name: str('可读名称'),
                value: str('当前值'),
                nodeId: num('CDP 节点 id'),
              },
            },
          },
        },
      }),
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args) {
      const result = await dispatch('browser_ax', args, undefined, 15000)
      return result.error ?? result.value
    },
  })

  // ── write tools: only when the deployment allows them ──────────────────────
  if (allowWrite) {
    add({
      name: 'browser_click',
      description: '点击元素（CSS 选择器或可见文本）。返回 trusted 表示是否用了真实输入事件。',
      parameters: {
        selector: str('CSS 选择器（可信路径需要它）'),
        text: str('或：按可见文本找元素'),
        index: num('匹配到多个时的序号（从 0 开始）'),
        tabId: TAB_PARAM,
      },
      output: {
        schema: withError({
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: num('目标标签页 id'),
            ok: bool('是否点到'),
            matched: num('匹配到的元素个数'),
            tag: str('元素标签'),
            text: str('元素文本'),
            trusted: bool('是否走了真实输入事件'),
            coords: { type: 'object', additionalProperties: false, properties: { x: num('x'), y: num('y') } },
            notes: { type: 'array', items: { type: 'string' } },
          },
        }),
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      async execute(args) {
        const result = await dispatch('browser_click', args, undefined, timeoutMs)
        return result.error ?? result.value
      },
    })

    add({
      name: 'browser_type',
      description: '在输入框里输入文本（可选提交）。replace=true 覆盖原内容，默认追加。',
      parameters: {
        text: { type: 'string', required: true, description: '要输入的文本' },
        selector: str('CSS 选择器（省略则用当前聚焦元素）'),
        replace: bool('是否覆盖原有内容（默认追加）'),
        submit: bool('是否回车提交'),
        tabId: TAB_PARAM,
      },
      output: {
        schema: withError({
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: num('目标标签页 id'),
            ok: bool('是否输入成功'),
            typed: num('输入字符数'),
            value: str('输入后的字段值'),
            trusted: bool('是否走了真实输入事件'),
            replace: bool('是否覆盖模式'),
            submitted: bool('是否提交'),
            notes: { type: 'array', items: { type: 'string' } },
          },
        }),
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      async execute(args) {
        const result = await dispatch('browser_type', args, undefined, timeoutMs)
        return result.error ?? result.value
      },
    })

    add({
      name: 'browser_navigate',
      description: '在目标标签页打开一个 http(s) URL，并等加载完成。',
      parameters: {
        url: { type: 'string', required: true, description: '要打开的 http(s) URL' },
        timeoutMs: num('加载超时毫秒（默认 15000）'),
        tabId: TAB_PARAM,
      },
      output: {
        schema: withError({
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: num('目标标签页 id'),
            ok: bool('是否加载完成'),
            url: str('最终 URL'),
            title: str('页面标题'),
            notes: { type: 'array', items: { type: 'string' } },
          },
        }),
        render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
      },
      async execute(args) {
        const result = await dispatch('browser_navigate', args, undefined, Math.min((args?.timeoutMs ?? 15000) + 3000, 30000))
        return result.error ?? result.value
      },
    })
  }

  return definitions
}

/** Render one tool value as the text block DSH expects. */
function renderValue(value) {
  return JSON.stringify(value)
}

/**
 * Register the tools on the plugin context.
 *
 * @returns {string[]} the registered tool names (also what `/ag/ping` advertises)
 */
export function registerBrowserTools({ ctx, hub, config, resolveWorkspace, log, keepDisposers }) {
  const definitions = buildBrowserTools({ hub, config, resolveWorkspace, log })
  const disposers = definitions.map((definition) => ctx.tools.register(definition))
  // The plugin owns the lifetime (it re-registers on a control flip); when a
  // collector is passed, the disposers go there instead of an effect of their own.
  if (Array.isArray(keepDisposers)) keepDisposers.push(...disposers)
  else ctx.effect(() => () => { for (const dispose of disposers) dispose() }, 'dsh-web-companion-bridge: browser tools')
  const names = definitions.map((definition) => definition.name)
  log(`browser tools registered: ${names.join(', ')}${config.allowBrowserWriteOps === true ? '' : ' (read-only: allowBrowserWriteOps=false)'}`)
  return names
}

export { persistScreenshot, stampOf }
