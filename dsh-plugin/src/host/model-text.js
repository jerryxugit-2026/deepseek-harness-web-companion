/**
 * 面向**模型**的文案表（`browser_*` 工具的 description / 字段说明 / 工具错误提示）。
 *
 * 为什么不用 `chrome.i18n`：这些文案是**宿主进程**里的插件读的，宿主没有 `chrome.i18n`；
 * 扩展侧那套 `extension/i18n/messages.source.json` → codegen 的单源机制在这里不可用。
 * 所以宿主自带一份，语言由插件配置的 `locale` 决定（默认 `'en'`，可选 `'zh_CN'`）。
 *
 * 单源约定：两种语言写在**相邻字段**里（`{ en, zh_CN }`），不是两份文件 ——
 * 物理上不可能出现"改了中文忘了英文"的错位。`tests/unit/model-text.test.mjs` 是这里的门禁：
 * 两语都非空、必须不同（防假翻译）、zh_CN 必须含汉字、`tools.js` 引用的 key 与表里的 key 双向一致。
 *
 * 占位符用 `$1`/`$2`，与扩展侧 `extension/src/lib/i18n.js` 的 `t()` 保持一致。
 */

/** 支持的语言集合（顺序即测试用例顺序）。 */
export const MODEL_LOCALES = ['en', 'zh_CN']

/** 默认语言：英文版面向模型的默认。 */
export const DEFAULT_MODEL_LOCALE = 'en'

/**
 * 文案表。每条都必须同时有 `en` 与 `zh_CN`，且两者不同 —— 门禁盯着这件事。
 *
 * 命名：`<工具/用途><字段>`，共用文案（如 `outTabId`）只留一条，避免同句多处漂移。
 */
export const MODEL_MESSAGES = {
  // ── 共用：标签页参数与工具错误提示 ──────────────────────────────────────────
  tabParam: {
    en: 'Target tab id; omit it to act on the page the user is currently looking at (never this extension’s own pages).',
    zh_CN: '目标标签页 id；省略则用用户当前所在页（不会抓扩展自身的页面）',
  },
  errExtOfflineHint: {
    en: '$1 (the browser extension is not connected: open the side panel — the /ag/agent channel only exists while the panel is open.)',
    zh_CN: '$1（浏览器扩展没连着：请打开侧边栏（面板打开时才会建立 /ag/agent 通道））',
  },
  errTimeoutHint: {
    en: '$1 (the extension did not answer before the timeout and the page may still be loading; try browser_wait first.)',
    zh_CN: '$1（扩展在超时前没有回应，页面可能正在加载；可以先用 browser_wait）',
  },

  // ── browser_read ───────────────────────────────────────────────────────────
  readDescription: {
    en: 'Read the page text (cleaned Markdown), or read only the element matching a CSS selector. Use it to understand the page the user is looking at.',
    zh_CN: '读取网页正文（清洗后的 Markdown），或只读某个 CSS 选择器对应的元素。用于理解用户正在看的页面。',
  },
  readSelectorParam: {
    en: 'Optional: read only the text of the element matching this CSS selector',
    zh_CN: '可选：只读这个 CSS 选择器对应的元素文本',
  },
  outTabId: {
    en: 'Target tab id',
    zh_CN: '目标标签页 id',
  },
  outPageUrl: {
    en: 'Page URL',
    zh_CN: '页面 URL',
  },
  outPageTitle: {
    en: 'Page title',
    zh_CN: '页面标题',
  },
  readDomainOut: {
    en: 'Domain',
    zh_CN: '域名',
  },
  readMarkdownOut: {
    en: 'Cleaned body Markdown',
    zh_CN: '清洗后的正文 Markdown',
  },
  readTextOut: {
    en: 'Element text in selector mode',
    zh_CN: '选择器模式下的元素文本',
  },
  readSelectorOut: {
    en: 'Element selector read in selector mode',
    zh_CN: '选择器模式下读的元素选择器',
  },
  readTagOut: {
    en: 'Element tag in selector mode',
    zh_CN: '选择器模式下的元素标签',
  },
  readCharsOut: {
    en: 'Character count',
    zh_CN: '字符数',
  },
  readTruncatedOut: {
    en: 'Whether the text was truncated',
    zh_CN: '正文是否被截断',
  },
  readHasVideoOut: {
    en: 'Whether the page contains a <video> element',
    zh_CN: '页面是否含 <video>',
  },

  // ── browser_tabs ───────────────────────────────────────────────────────────
  tabsDescription: {
    en: 'List the open browser tabs (id/title/URL/active) to locate the page to operate on.',
    zh_CN: '列出浏览器里打开的标签页（id/标题/URL/是否活动），用于定位要操作的页面。',
  },
  tabsUrlContainsParam: {
    en: 'Optional: only list tabs whose URL contains this substring',
    zh_CN: '可选：只列 URL 含该子串的标签页',
  },
  tabsCountOut: {
    en: 'Number of entries returned',
    zh_CN: '返回条数',
  },
  tabsTotalOut: {
    en: 'Total number of tabs in the browser',
    zh_CN: '浏览器里的标签页总数',
  },
  tabTitleOut: {
    en: 'Title',
    zh_CN: '标题',
  },
  tabActiveOut: {
    en: 'Whether the tab is active',
    zh_CN: '是否活动标签',
  },
  tabWindowIdOut: {
    en: 'Window id',
    zh_CN: '窗口 id',
  },
  tabLastAccessedOut: {
    en: 'Last accessed timestamp',
    zh_CN: '最近访问时间戳',
  },

  // ── browser_wait ───────────────────────────────────────────────────────────
  waitDescription: {
    en: 'Wait: a fixed number of milliseconds, for a selector to appear, or for a piece of text to appear on the page. Use it to wait for async loading instead of sleeping blindly.',
    zh_CN: '等待：固定毫秒、等选择器出现、或等页面上出现某段文字。用于等异步加载，替代盲等。',
  },
  waitMsParam: {
    en: 'Milliseconds to wait (default 500, max 30000)',
    zh_CN: '等待毫秒（默认 500，上限 30000）',
  },
  waitSelectorParam: {
    en: 'Optional: wait for this CSS selector to appear',
    zh_CN: '可选：等该 CSS 选择器出现',
  },
  waitTextParam: {
    en: 'Optional: wait for this substring to appear in the page text',
    zh_CN: '可选：等页面文本中出现该子串',
  },
  waitTimeoutParam: {
    en: 'Timeout in milliseconds (default 5000)',
    zh_CN: '超时毫秒（默认 5000）',
  },
  waitWaitedOut: {
    en: 'Wait type: ms | selector | text',
    zh_CN: '等待类型：ms | selector | text',
  },
  waitElapsedOut: {
    en: 'Actual milliseconds waited',
    zh_CN: '实际等待毫秒',
  },
  waitSelectorOut: {
    en: 'Selector that was waited for',
    zh_CN: '等待的选择器',
  },
  waitTextOut: {
    en: 'Text that was waited for',
    zh_CN: '等待的文本',
  },

  // ── browser_screenshot ─────────────────────────────────────────────────────
  screenshotDescription: {
    en: 'Take a screenshot — full page or viewport. The PNG is written into the workspace and its path is returned (reference it with @ to show it to the user).',
    zh_CN: '截图。整页或视口，PNG 会存到工作区并返回路径（可直接用 @ 引用给用户看）。',
  },
  screenshotFullPageParam: {
    en: 'Whether to capture the full page (default: the viewport; full page needs the "browser control" switch)',
    zh_CN: '是否整页（默认视口；整页需要「浏览器控制」开关）',
  },
  screenshotFilePathOut: {
    en: 'Absolute path of the PNG written to disk',
    zh_CN: '落盘的 PNG 绝对路径',
  },
  screenshotFileRefOut: {
    en: 'Workspace-relative reference (@…)',
    zh_CN: '工作区相对引用（@…）',
  },
  screenshotBytesOut: {
    en: 'File size in bytes',
    zh_CN: '文件字节数',
  },
  screenshotMimeOut: {
    en: 'MIME type',
    zh_CN: 'MIME 类型',
  },
  screenshotFullPageOut: {
    en: 'Whether it was a full-page capture',
    zh_CN: '是否整页',
  },
  screenshotTrustedOut: {
    en: 'Whether the debugger (trusted) path was used',
    zh_CN: '是否走 debugger（可信路径）',
  },
  screenshotClippedOut: {
    en: 'Whether the full-page capture was clipped at the height limit',
    zh_CN: '整页截图是否被高度上限裁剪',
  },
  screenshotClippedAtPxOut: {
    en: 'Clip height in pixels',
    zh_CN: '裁剪高度（像素）',
  },
  screenshotContentHeightOut: {
    en: 'Page content height in pixels',
    zh_CN: '页面内容高度（像素）',
  },

  // ── browser_ax ─────────────────────────────────────────────────────────────
  axDescription: {
    en: 'Read the page accessibility tree (a role/name/value list). Better than reading the page text for locating clickable elements; needs the "browser control" switch.',
    zh_CN: '取页面的无障碍树（role/name/value 列表）。比抓正文更适合定位可点元素，需要「浏览器控制」开关。',
  },
  axMaxNodesParam: {
    en: 'Maximum number of nodes to return (default 400)',
    zh_CN: '最多返回多少节点（默认 400）',
  },
  axTotalOut: {
    en: 'Total number of nodes in the tree',
    zh_CN: '树里的节点总数',
  },
  axTruncatedOut: {
    en: 'Whether the result was truncated by maxNodes',
    zh_CN: '是否被 maxNodes 截断',
  },
  axNameOut: {
    en: 'Accessible name',
    zh_CN: '可读名称',
  },
  axValueOut: {
    en: 'Current value',
    zh_CN: '当前值',
  },
  axNodeIdOut: {
    en: 'CDP accessibility node id (AXNode.nodeId, a string)',
    zh_CN: 'CDP 无障碍节点 id（AXNode.nodeId，字符串）',
  },

  // ── browser_click ──────────────────────────────────────────────────────────
  clickDescription: {
    en: 'Click an element (by CSS selector or visible text). The returned trusted flag says whether real input events were used.',
    zh_CN: '点击元素（CSS 选择器或可见文本）。返回 trusted 表示是否用了真实输入事件。',
  },
  clickSelectorParam: {
    en: 'CSS selector (required for the trusted path)',
    zh_CN: 'CSS 选择器（可信路径需要它）',
  },
  clickTextParam: {
    en: 'Or: find the element by its visible text',
    zh_CN: '或：按可见文本找元素',
  },
  clickIndexParam: {
    en: 'Index to pick when several elements match (0-based)',
    zh_CN: '匹配到多个时的序号（从 0 开始）',
  },
  clickOkOut: {
    en: 'Whether the click landed',
    zh_CN: '是否点到',
  },
  clickMatchedOut: {
    en: 'Number of matched elements',
    zh_CN: '匹配到的元素个数',
  },
  clickTagOut: {
    en: 'Element tag',
    zh_CN: '元素标签',
  },
  clickTextOut: {
    en: 'Element text',
    zh_CN: '元素文本',
  },
  trustedEventOut: {
    en: 'Whether real input events were used',
    zh_CN: '是否走了真实输入事件',
  },

  // ── browser_type ───────────────────────────────────────────────────────────
  typeDescription: {
    en: 'Type text into an input field (optionally submitting). replace=true overwrites the existing content; the default appends.',
    zh_CN: '在输入框里输入文本（可选提交）。replace=true 覆盖原内容，默认追加。',
  },
  typeTextParam: {
    en: 'Text to type',
    zh_CN: '要输入的文本',
  },
  typeSelectorParam: {
    en: 'CSS selector (the currently focused element is used when omitted)',
    zh_CN: 'CSS 选择器（省略则用当前聚焦元素）',
  },
  typeReplaceParam: {
    en: 'Whether to overwrite the existing content (default: append)',
    zh_CN: '是否覆盖原有内容（默认追加）',
  },
  typeSubmitParam: {
    en: 'Whether to submit with Enter',
    zh_CN: '是否回车提交',
  },
  typeOkOut: {
    en: 'Whether typing succeeded',
    zh_CN: '是否输入成功',
  },
  typeTypedOut: {
    en: 'Number of characters typed',
    zh_CN: '输入字符数',
  },
  typeValueOut: {
    en: 'Field value after typing',
    zh_CN: '输入后的字段值',
  },
  typeReplaceOut: {
    en: 'Whether replace mode was used',
    zh_CN: '是否覆盖模式',
  },
  typeSubmittedOut: {
    en: 'Whether it was submitted',
    zh_CN: '是否提交',
  },

  // ── browser_navigate ───────────────────────────────────────────────────────
  navigateDescription: {
    en: 'Open an http(s) URL in the target tab and wait for it to finish loading.',
    zh_CN: '在目标标签页打开一个 http(s) URL，并等加载完成。',
  },
  navigateUrlParam: {
    en: 'The http(s) URL to open',
    zh_CN: '要打开的 http(s) URL',
  },
  navigateTimeoutParam: {
    en: 'Load timeout in milliseconds (default 15000)',
    zh_CN: '加载超时毫秒（默认 15000）',
  },
  navigateOkOut: {
    en: 'Whether loading completed',
    zh_CN: '是否加载完成',
  },
  navigateFinalUrlOut: {
    en: 'Final URL',
    zh_CN: '最终 URL',
  },
}

/**
 * 容错归一化一个 locale 值。
 *
 * 认这些（大小写不敏感、允许 `en-US` / `zh-Hans` 这类 BCP-47 变体）：
 *   · 空 / undefined / 非字符串 → 默认 `'en'`
 *   · `en` / `en-US` / `EN` → `'en'`
 *   · `zh` / `zh-CN` / `zh_CN` / `zh-Hans` → `'zh_CN'`
 *   · 其它未知值 → 默认 `'en'`（不抛，宁可退回默认语言）
 *
 * @param {unknown} raw
 * @returns {'en' | 'zh_CN'}
 */
export function resolveModelLocale(raw) {
  if (typeof raw !== 'string') return DEFAULT_MODEL_LOCALE
  const value = raw.trim().toLowerCase()
  if (value === '') return DEFAULT_MODEL_LOCALE
  if (value === 'en' || value.startsWith('en-') || value.startsWith('en_')) return 'en'
  if (value === 'zh' || value.startsWith('zh-') || value.startsWith('zh_')) return 'zh_CN'
  return DEFAULT_MODEL_LOCALE
}

/**
 * 取一个语言的取词函数。
 *
 * 与扩展侧 `t()` 同一套约定：占位符 `$1`/`$2`；**未知 key 原样返回 key**（一眼看出漏配，
 * 而不是返回空串）；**未知占位原样保留**、参数不够也不抛异常。
 *
 * @param {unknown} locale 任意 locale 值（先过 `resolveModelLocale`）
 * @returns {(key: string, substitutions?: unknown[]) => string}
 */
export function modelText(locale) {
  const resolved = resolveModelLocale(locale)
  return function t(key, substitutions = []) {
    const entry = MODEL_MESSAGES[key]
    if (entry === undefined) return key
    const message = entry[resolved] ?? entry[DEFAULT_MODEL_LOCALE]
    if (typeof message !== 'string') return key
    const args = Array.isArray(substitutions) ? substitutions : [substitutions]
    return message.replace(/\$(\d+)/gu, (match, index) => {
      const value = args[Number(index) - 1]
      return value === undefined ? match : String(value)
    })
  }
}
