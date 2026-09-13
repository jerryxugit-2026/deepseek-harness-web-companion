#!/usr/bin/env node
/**
 * 门禁单测：**面向模型**的文案表（`dsh-plugin/src/host/model-text.js` + `host/tools.js`）。
 *
 * 为什么宿主需要自己一套：这些文案是模型读的（工具 description / 字段说明 / 工具错误提示），
 * 而宿主进程**没有 `chrome.i18n`** —— 扩展侧那套 `extension/i18n` 的单源机制在这里用不上。
 * 语言由插件配置的 `locale` 决定（默认 `'en'`，可选 `'zh_CN'`）。
 *
 * 钉住的是翻译最容易出的五类错（与 `i18n-messages.test.mjs` 同构）：
 *   1. **两侧漂移**：某个 key 只填了一种语言 ⇒ 断言"两语都非空"；
 *   2. **假翻译**：把英文抄进 zh_CN 冒充"翻过了" ⇒ 断言"两语必须不同"；
 *   3. **没翻**：zh_CN 里其实没有汉字 ⇒ 断言"zh_CN 必须含汉字"；
 *   4. **漏抽取 / 死文案**：`tools.js` 引用了表里没有的 key，或表里有没人用的 key ⇒ 双向断言；
 *   5. **残留硬编码**：`tools.js` 里还有中文字符串字面量（注释里的中文允许）。
 *
 * 第 5 条**故意不用"抽字符串字面量"的做法**：本仓有**含引号的正则字面量**
 * （`ops/index.js` 的 `/Either the '<all_urls>' or 'activeTab'/`），迷你词法分析器一旦被它带偏，
 * 后面的内容会被整段跳过 ⇒ **假阴性**。所以用"去注释"（与 `i18n-messages.test.mjs` 同一套规则，
 * 且本文件的扫描器自带自检，见第 3 节）。
 *
 * 用法：node tests/unit/model-text.test.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_MODEL_LOCALE, MODEL_LOCALES, MODEL_MESSAGES, modelText, resolveModelLocale,
} from '../../dsh-plugin/src/host/model-text.js'
import { buildBrowserTools } from '../../dsh-plugin/src/host/tools.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const TOOLS_JS = join(REPO, 'dsh-plugin', 'src', 'host', 'tools.js')
const CJK = /[\u4e00-\u9fff]/u
const SOURCE_LOCALES = ['en', 'zh_CN']

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
}

/**
 * 去掉注释，再看剩下文本里的汉字（与 `tests/unit/i18n-messages.test.mjs#stripComments` 同规则）。
 *
 * 规则：块注释、HTML 注释、以及**前面带空白**的 `//` 到行尾。要求 `//` 前有空白是为了不误伤
 * `http://`；代价是"字符串里写了 ` // ` 再跟中文"会漏检 —— 已知、可接受，仓库里没有这种写法。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/(^|\s)\/\/[^\n]*/gu, '$1')
}

/**
 * `'网页捕获'` 是**数据契约默认值**（截图的落盘目录名，`store.js`/attach/抓取探针都依赖它），
 * **不是面向模型的文案**，因此不建 key、也不翻译（任务里明确点名）。
 *
 * 这里只豁免**这一处精确表达式**，不是"字符串里的中文一律放过"—— 下一节会断言这处契约仍然存在，
 * 免得太窄的豁免把"契约被删"也一起盖住。
 */
const DATA_CONTRACT_DEFAULT = "config.attachDir ?? '网页捕获'"

/** 已抽取干净的文件里是否还有面向模型的汉字字面量。 */
function residualModelCjk(text) {
  return CJK.test(stripComments(text.split(DATA_CONTRACT_DEFAULT).join("config.attachDir ?? '<DATA_CONTRACT_DEFAULT>'")))
}

const toolsText = readFileSync(TOOLS_JS, 'utf8')

console.log('1. 文案表本身：key 命名、两语都非空、没有多余语言字段')
{
  const keys = Object.keys(MODEL_MESSAGES)
  record(`表里有 ${String(keys.length)} 条文案`, keys.length > 0)
  const badName = keys.filter((k) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(k))
  record(`key 命名都合规（${badName.join(',') || '无问题'}）`, badName.length === 0)
  const missing = []
  for (const [k, entry] of Object.entries(MODEL_MESSAGES)) {
    for (const loc of SOURCE_LOCALES) {
      if (typeof entry[loc] !== 'string' || entry[loc].trim() === '') missing.push(`${k}.${loc}`)
    }
  }
  record(`★ 两种语言都不为空（缺：${missing.slice(0, 4).join(',') || '无'}）`, missing.length === 0)
  const unknownLocale = keys.flatMap((k) => Object.keys(MODEL_MESSAGES[k]).filter((l) => !SOURCE_LOCALES.includes(l)))
  record('没有多余语言字段', unknownLocale.length === 0)
  record('MODEL_LOCALES 就是这两种语言', [...MODEL_LOCALES].sort().join(',') === [...SOURCE_LOCALES].sort().join(','))
  record('默认语言是 en', DEFAULT_MODEL_LOCALE === 'en')
}

console.log('\n2. ★ 假翻译门禁：两种语言必须真的不同，且 zh_CN 必须含汉字')
{
  const same = Object.entries(MODEL_MESSAGES)
    .filter(([, entry]) => entry.en === entry.zh_CN)
    .map(([k]) => k)
  record(`en 与 zh_CN 都不同的有 ${String(Object.keys(MODEL_MESSAGES).length - same.length)} 条（相同：${same.join(',') || '无'}）`, same.length === 0)
  const untranslated = Object.entries(MODEL_MESSAGES).filter(([, e]) => !CJK.test(e.zh_CN)).map(([k]) => k)
  record(`★ zh_CN 里确实含汉字（可疑：${untranslated.join(',') || '无'}）`, untranslated.length === 0)
  // 反向：英文那侧不该混进汉字（混进去说明两种语言被填反了）
  const enWithCjk = Object.entries(MODEL_MESSAGES).filter(([, e]) => CJK.test(e.en)).map(([k]) => k)
  record(`en 里没有汉字（可疑：${enWithCjk.join(',') || '无'}）`, enWithCjk.length === 0)
}

console.log('\n3. 扫描器自检：先证明"能咬"，再拿它去扫 tools.js（防假阴性）')
{
  record('硬编码中文 description 会被判为残留', residualModelCjk("description: '目标标签页 id',") === true)
  record('注释里的中文不算残留', residualModelCjk('// 这是中文注释\nconst a = 1') === false)
  record('块注释里的中文不算残留', residualModelCjk('/* 中文 */ const a = 1') === false)
  // 这条是本文件开头那段"不要抽字符串字面量"的理由：含引号的正则字面量后面还有中文，必须仍被扫出来
  record(
    '含引号的正则字面量不会让后面的中文漏检',
    residualModelCjk("const r = /Either the '<all_urls>' or 'activeTab'/u.test(m)\nconst d = '中文'") === true,
  )
  record('★ 仍保留 attachDir 的数据契约默认值（豁免只针对这一处）', toolsText.includes(DATA_CONTRACT_DEFAULT))
}

console.log('\n4. ★ 双向一致：tools.js 引用的 key 都在表里，表里也没有死 key')
{
  const referenced = new Set()
  for (const m of toolsText.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/gu)) referenced.add(m[1])
  for (const m of toolsText.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/gu)) referenced.add(m[1])
  record(`tools.js 里引用了 ${String(referenced.size)} 个 key`, referenced.size > 0)
  const unknown = [...referenced].filter((k) => !Object.hasOwn(MODEL_MESSAGES, k))
  record(`★ 引用的 key 都在表里（缺失：${unknown.join(',') || '无'}）`, unknown.length === 0)
  const dead = Object.keys(MODEL_MESSAGES).filter((k) => !referenced.has(k))
  record(`表里没有死 key（未被引用：${dead.join(',') || '无'}）`, dead.length === 0)
}

console.log('5. ★ tools.js 里 0 处残留的中文字符串字面量（注释里的中文允许）')
{
  const residual = residualModelCjk(toolsText)
  const sample = residual ? (stripComments(toolsText).split('\n').find((l) => CJK.test(l)) ?? '').trim().slice(0, 80) : ''
  record(`★ 0 处残留${residual ? ` → ${sample}` : ''}`, residual === false)
}

console.log('\n6. resolveModelLocale：容错归一化（未知值退回默认，不抛）')
{
  const CASES = [
    [undefined, 'en'], [null, 'en'], ['', 'en'], ['   ', 'en'],
    ['en', 'en'], ['en-US', 'en'], ['EN', 'en'], ['en_US', 'en'],
    ['zh', 'zh_CN'], ['zh-CN', 'zh_CN'], ['zh_CN', 'zh_CN'], ['zh-Hans', 'zh_CN'], ['ZH-cn', 'zh_CN'], ['zh-TW', 'zh_CN'],
    ['fr', 'en'], ['de-DE', 'en'], [42, 'en'], [{}, 'en'], [[], 'en'],
  ]
  const wrong = CASES.filter(([input, expected]) => resolveModelLocale(input) !== expected)
    .map(([input, expected]) => `${JSON.stringify(input)}→${resolveModelLocale(input)}(期望 ${expected})`)
  record(`★ ${String(CASES.length)} 个分支都对（错：${wrong.slice(0, 3).join(';') || '无'}）`, wrong.length === 0)
  record('归一化结果一定在 MODEL_LOCALES 里', CASES.every(([input]) => MODEL_LOCALES.includes(resolveModelLocale(input))))
}

console.log('\n7. t()：占位替换、未知 key 原样返回、未知占位不抛')
{
  const en = modelText('en')
  const zh = modelText('zh_CN')
  record('默认语言取到英文', en('outTabId') === 'Target tab id')
  record('zh_CN 取到中文', zh('outTabId') === '目标标签页 id')
  record('未知 locale 退回默认（英文）', modelText('fr')('outTabId') === en('outTabId'))
  record('★ 未知 key 原样返回 key（一眼看出漏配）', en('noSuchKey') === 'noSuchKey' && zh('noSuchKey') === 'noSuchKey')
  record('占位替换 $1（英文）', en('errTimeoutHint', ['boom']).includes('boom'))
  record('占位替换 $1（中文，且保留全角括号）', zh('errExtOfflineHint', ['boom']).startsWith('boom（'))
  record('★ 未知占位不炸、原样留着', en('errTimeoutHint').includes('$1'))
  record('参数多于占位不炸', en('outTabId', ['x', 'y']) === 'Target tab id')
  record('substitutions 非数组也容错', en('errTimeoutHint', 'boom').includes('boom'))
  record('返回值一定是字符串', typeof en('outTabId') === 'string' && typeof en('noSuchKey') === 'string')
}

console.log('\n8. 接线：config.locale 真的决定工具文案（默认 en，zh_CN 可切）')
{
  const hub = { callAgent: async () => ({ ok: true, value: {} }) }
  const build = (config) => Object.fromEntries(
    buildBrowserTools({ hub, config, resolveWorkspace: () => '/tmp/ws', log: () => {} }).map((tool) => [tool.name, tool]),
  )
  const defaultTools = build({})
  const zhTools = build({ locale: 'zh_CN' })
  const enDescription = defaultTools.browser_read.description
  record('不给 locale 时 description 是英文（不含汉字）', !CJK.test(enDescription))
  record('★ config.locale=zh_CN 时 description 是中文（与默认不同）', CJK.test(zhTools.browser_read.description) && zhTools.browser_read.description !== enDescription)
  // defineTool 把 parameters 编译成 JSON schema，字段说明在 properties.<name>.description
  record(
    '★ tabId 参数说明也跟着语言走',
    defaultTools.browser_read.parameters.properties.tabId.description !== zhTools.browser_read.parameters.properties.tabId.description,
  )
  record(
    '切语言不改 schema 结构（参数名一致）',
    JSON.stringify(Object.keys(defaultTools.browser_read.parameters.properties)) === JSON.stringify(Object.keys(zhTools.browser_read.parameters.properties)),
  )
  record('未知 locale 与默认文案一致', build({ locale: 'fr' }).browser_read.description === enDescription)
  record('工具名字与数量不受语言影响', Object.keys(defaultTools).join(',') === Object.keys(zhTools).join(','))
}

// 只有布尔 true 算通过：任何没记上的都算失败
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
