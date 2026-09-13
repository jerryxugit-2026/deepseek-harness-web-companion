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
 *
 * Model-facing text (descriptions, field docs, error hints) lives in
 * `./model-text.js` and is picked by `config.locale` — the host process has no
 * `chrome.i18n`, so the plugin carries its own table. See that file for the rules.
 */
import { defineTool } from '@deepseek-ai/dsh-tools'
// v3.40 把截图文件名里的随机后缀改成 randomBytes(3)，却**只加了用法没加这个 import** ⇒
// `browser_screenshot` 整条工具在真机上直接 ReferenceError（op 层探针只打 op、单测恰好跳过了
// screenshot 的 execute，两边都没抓到 —— 2026-09-12 由新的「真值驱动工具层」检查抓出）。
import { randomBytes } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sweepCaptures } from './retention.js'
// One implementation of the capture timestamp for the whole host: `stampOf` used to be a second
// copy of `store.js#stamp`, so a change to the file-name convention could silently apply to only
// one of the two places that writes capture files. Kept as an alias because callers import it.
import { stamp as stampOf } from './store.js'
import { modelText, resolveModelLocale } from './model-text.js'

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

/** Map a transport rejection onto the tool-error shape the model can act on. */
function toToolError(error, t) {
  const code = error?.code ?? 'E_INTERNAL'
  const message = String(error?.message ?? error)
  // 两个已知失败模式各带一条"接下来怎么办"的提示；其余错误原样透出。
  if (code === 'E_EXT_OFFLINE') return { code, message: t('errExtOfflineHint', [message]) }
  if (code === 'E_TIMEOUT') return { code, message: t('errTimeoutHint', [message]) }
  return { code, message }
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


/**
 * Build the tool definitions (no registration side effects — the unit test drives
 * these directly).
 *
 * @param {object} options
 * @param {{ callAgent: (request: object, options?: object) => Promise<object> }} options.hub
 * @param {{ toolTimeoutMs?: number, allowBrowserWriteOps?: boolean, attachDir?: string, retentionHours?: number, defaultWorkspace?: string, locale?: string }} options.config
 * @param {(request?: object) => string | undefined} options.resolveWorkspace
 * @param {(line: string) => void} [options.log]
 */
export function buildBrowserTools({ hub, config, resolveWorkspace, log = () => {} }) {
  const timeoutMs = config.toolTimeoutMs ?? 10000
  const allowWrite = config.allowBrowserWriteOps === true
  // Model-facing text: resolved once per build from the plugin config (`locale`, default 'en').
  const t = modelText(resolveModelLocale(config?.locale))
  // `tabId` is the one parameter every tool shares; its description needs `t`, so this
  // cannot be a module-level constant (it used to be `TAB_PARAM` with hardcoded Chinese).
  const tabParam = { type: 'number', description: t('tabParam') }

  /** One call, mapped to `{value}` or `{error}` — never a thrown exception. */
  const dispatch = async (tool, params, exec, perCallTimeout) => {
    try {
      const frame = await hub.callAgent({ tool, params, allowWrite }, { timeoutMs: perCallTimeout ?? timeoutMs })
      if (frame.ok !== true) return { error: frame.error ?? { code: 'E_INTERNAL', message: `${tool} failed` } }
      return { value: frame.value ?? {} }
    } catch (error) {
      return { error: toToolError(error, t) }
    }
  }

  const definitions = []
  const add = (spec) => definitions.push(defineTool(spec))

  // ── read-only tools: always registered ──────────────────────────────────────
  add({
    name: 'browser_read',
    description: t('readDescription'),
    parameters: {
      selector: str(t('readSelectorParam')),
      tabId: tabParam,
    },
    output: {
      // Declared fields = exactly what the extension returns, in both modes; the
      // schema compiler demands an explicit `additionalProperties`, so this doubles
      // as the contract the extension cannot quietly widen.
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: num(t('outTabId')),
          url: str(t('outPageUrl')),
          title: str(t('outPageTitle')),
          domain: str(t('readDomainOut')),
          markdown: str(t('readMarkdownOut')),
          text: str(t('readTextOut')),
          selector: str(t('readSelectorOut')),
          tag: str(t('readTagOut')),
          chars: num(t('readCharsOut')),
          truncated: bool(t('readTruncatedOut')),
          hasVideo: bool(t('readHasVideoOut')),
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
    description: t('tabsDescription'),
    parameters: { urlContains: str(t('tabsUrlContainsParam')) },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          count: num(t('tabsCountOut')),
          total: num(t('tabsTotalOut')),
          tabs: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'number', required: true },
                title: str(t('tabTitleOut')),
                // 'URL' 两语同形，不是需要翻译的文案 ⇒ 不进表（表里每条都要求 zh_CN 含汉字）。
                url: str('URL'),
                active: bool(t('tabActiveOut')),
                windowId: num(t('tabWindowIdOut')),
                lastAccessed: num(t('tabLastAccessedOut')),
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
    description: t('waitDescription'),
    parameters: {
      ms: num(t('waitMsParam')),
      selector: str(t('waitSelectorParam')),
      text: str(t('waitTextParam')),
      timeoutMs: num(t('waitTimeoutParam')),
      tabId: tabParam,
    },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: num(t('outTabId')),
          waited: str(t('waitWaitedOut')),
          elapsedMs: num(t('waitElapsedOut')),
          selector: str(t('waitSelectorOut')),
          text: str(t('waitTextOut')),
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
    description: t('screenshotDescription'),
    parameters: {
      fullPage: bool(t('screenshotFullPageParam')),
      tabId: tabParam,
    },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          filePath: str(t('screenshotFilePathOut')),
          fileRef: str(t('screenshotFileRefOut')),
          bytes: num(t('screenshotBytesOut')),
          mime: str(t('screenshotMimeOut')),
          fullPage: bool(t('screenshotFullPageOut')),
          trusted: bool(t('screenshotTrustedOut')),
          clipped: bool(t('screenshotClippedOut')),
          clippedAtPx: num(t('screenshotClippedAtPxOut')),
          contentHeight: num(t('screenshotContentHeightOut')),
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
        // 数据契约默认值，不是文案：落盘目录名必须与 store.js/attach 保持一致，不随语言变。
        attachDir: config.attachDir ?? '网页捕获',
        base64: value.base64,
        mime: typeof value.mime === 'string' ? value.mime : 'image/png',
        stamp: stampOf(),
        // 6 hex chars, always. `Math.random().toString(16).slice(2, 8)` can yield fewer (e.g. 0.5 →
        // "0.8"), so two screenshots in the same minute could collide and the rename would silently
        // overwrite the first (review 2026-09-12).
        id6: randomBytes(3).toString('hex'),
        retentionHours: config.retentionHours ?? 24,
        log,
      })
      return {
        ...saved,
        bytes: value.bytes ?? Math.round((value.base64.length * 3) / 4),
        mime: value.mime ?? 'image/png',
        fullPage: value.fullPage === true,
        trusted: value.trusted === true,
        ...(value.clipped === true ? { clipped: true } : {}),
        ...(value.clippedAtPx === undefined ? {} : { clippedAtPx: value.clippedAtPx }),
        ...(value.contentHeight === undefined ? {} : { contentHeight: value.contentHeight }),
      }
    },
  })

  add({
    name: 'browser_ax',
    description: t('axDescription'),
    parameters: { maxNodes: num(t('axMaxNodesParam')), tabId: tabParam },
    output: {
      schema: withError({
        type: 'object',
        additionalProperties: false,
        properties: {
          tabId: num(t('outTabId')),
          url: str(t('outPageUrl')),
          title: str(t('outPageTitle')),
          total: num(t('axTotalOut')),
          truncated: bool(t('axTruncatedOut')),
          nodes: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                role: { type: 'string', required: true },
                name: str(t('axNameOut')),
                value: str(t('axValueOut')),
                // CDP 的两个 nodeId 不是一个类型：`Accessibility.AXNode.nodeId` 是**字符串**，
                // `DOM.Node.nodeId` 才是数字。这里声明成 num 时，真实的无障碍树**整条**都过不了
                // output schema ⇒ 模型收到的是「invalid output」而不是树（实测 2026-09-12：真机开着
                // 「浏览器控制」调 browser_ax 直接报 schema 错，而不是返回节点）。
                nodeId: str(t('axNodeIdOut')),
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
      description: t('clickDescription'),
      parameters: {
        selector: str(t('clickSelectorParam')),
        text: str(t('clickTextParam')),
        index: num(t('clickIndexParam')),
        tabId: tabParam,
      },
      output: {
        schema: withError({
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: num(t('outTabId')),
            ok: bool(t('clickOkOut')),
            matched: num(t('clickMatchedOut')),
            tag: str(t('clickTagOut')),
            text: str(t('clickTextOut')),
            trusted: bool(t('trustedEventOut')),
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
      description: t('typeDescription'),
      parameters: {
        text: { type: 'string', required: true, description: t('typeTextParam') },
        selector: str(t('typeSelectorParam')),
        replace: bool(t('typeReplaceParam')),
        submit: bool(t('typeSubmitParam')),
        tabId: tabParam,
      },
      output: {
        schema: withError({
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: num(t('outTabId')),
            ok: bool(t('typeOkOut')),
            typed: num(t('typeTypedOut')),
            value: str(t('typeValueOut')),
            trusted: bool(t('trustedEventOut')),
            replace: bool(t('typeReplaceOut')),
            submitted: bool(t('typeSubmittedOut')),
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
      description: t('navigateDescription'),
      parameters: {
        url: { type: 'string', required: true, description: t('navigateUrlParam') },
        timeoutMs: num(t('navigateTimeoutParam')),
        tabId: tabParam,
      },
      output: {
        schema: withError({
          type: 'object',
          additionalProperties: false,
          properties: {
            tabId: num(t('outTabId')),
            ok: bool(t('navigateOkOut')),
            url: str(t('navigateFinalUrlOut')),
            title: str(t('outPageTitle')),
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
