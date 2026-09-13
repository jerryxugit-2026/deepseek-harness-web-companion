#!/usr/bin/env node
/**
 * 文案与本地化单测（`extension/i18n/*` + `extension/src/lib/i18n.js`）。
 *
 * 这是英文版的**门禁**：翻译最容易出的三种错，这里各有一条断言钉住 ——
 *
 *   1. **两侧漂移**：改了中文忘了英文（或反过来）⇒ 断言"每个 key 两种语言都不为空"；
 *   2. **假翻译**：把英文原样填进 zh_CN 冒充"翻过了" ⇒ 断言"两种语言必须不同"
 *      （真有意相同的，得显式加进 ALLOW_SAME，逼人做一次有意识的决定）；
 *   3. **漏抽取**：代码里还用着硬编码字面量、或用了源表里不存在的 key ⇒
 *      断言"代码/HTML 里引用的 key 都在源表里" + "已抽取的文件里不许再有汉字字面量"。
 *
 * 另外验证运行期取值（`t`）与 DOM 填充（`applyI18n`）在没有 `chrome.i18n` 的 Node 里
 * 也能确定地工作 —— 否则测试只能断言"要么这样要么那样"，等于没断言。
 *
 * 用法：node tests/unit/i18n-messages.test.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_LOCALE, MESSAGES } from '../../extension/src/lib/messages.generated.js'
import { applyI18n, t, uiLanguage } from '../../extension/src/lib/i18n.js'
import { CODE_TO_KEY, PERMISSION_KEY } from '../../extension/src/sidepanel/errors.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '..', '..')
const EXT = join(REPO, 'extension')
const SOURCE = JSON.parse(readFileSync(join(EXT, 'i18n', 'messages.source.json'), 'utf8'))
/** 源表里必须齐的列（zh_CN 是中文原稿/参考）。 */
const LOCALES = ['en', 'zh_CN']
/**
 * ★ 真正**发布**的语言包（用户 2026-09-13 决定：「用户的 chrome 设置成中文或者英文,
 * 我们的插件都是英文版, 就可以」）。Chrome 挑不到匹配语言就退到 default_locale ⇒
 * 只发布 en 就保证**任何浏览器语言下都显示英文**。
 */
const SHIPPED_LOCALES = ['en']

/** 真有意让两种语言相同的 key 放这里（目前为空 —— 空的本身是个好信号）。 */
const ALLOW_SAME = new Set([])

/**
 * 「已抽取干净」的文件清单：这些文件里**不许再出现汉字字面量**。
 * 随着逐轮改造往里加（panel.js / sw/ops/index.js 等），加进来就等于立了门禁。
 */
const EXTRACTED_FILES = [
  'manifest.json',
  'src/sidepanel/panel.html',
  'src/sidepanel/panel.js',
  'src/sidepanel/errors.js',
  'src/lib/i18n.js',
  'src/sw/capture.js',
  'src/sw/dsh-session.js',
  // ops/index.js 的 notes 与错误文案面向**模型**而非用户（固定英文，见文件内注释），
  // 但它同样不许再有中文字面量 —— 加进来就等于立了门禁。
  'src/sw/ops/index.js',
]

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
}

const CJK = /[\u4e00-\u9fff]/u

/**
 * 去掉注释，再看剩下文本里的汉字。
 *
 * 为什么是"去注释"而不是"抽字符串字面量"（第一版两种都写错了）：
 *   · 抽字面量要用迷你词法分析器，而本仓的正则字面量里**含引号**
 *     （`errors.js` 有 `/Either the '<all_urls>' or 'activeTab'/`），一旦被当成字符串起始，
 *     后面的内容就全被跳过 ⇒ **假阴性**（漏掉真正的中文）。门禁最不能容忍的就是假阴性。
 *   · 去注释只需要几条我自己控制的规则，且本仓的注释就是中文写的 —— 注释里的中文本来就该允许。
 *
 * 规则（含已知局限，写在这里免得以后误判）：块注释 `/* *\/`、HTML 注释 `<!-- -->`、
 * 以及**前面带空白**的 `//` 到行尾。要求 `//` 前有空白是为了不误伤 `http://` 这类字符串；
 * 代价是"字符串里写了 ` // ` 再跟中文"这种情况会漏检 —— 已知、可接受，且不是本仓的写法。
 */
function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//gu, ' ')
    .replace(/<!--[\s\S]*?-->/gu, ' ')
    .replace(/(^|\s)\/\/[^\n]*/gu, '$1')
}

/** 已抽取文件里是否还有面向用户的汉字。 */
function residualCjk(text) {
  return CJK.test(stripComments(text))
}

console.log('1. 源表本身：每个 key 两种语言都非空、命名合规')
{
  const keys = Object.keys(SOURCE)
  record(`源表有 ${String(keys.length)} 条文案`, keys.length > 0)
  const badName = keys.filter((k) => !/^[A-Za-z][A-Za-z0-9_]*$/u.test(k))
  record(`key 命名都合规（${badName.join(',') || '无问题'}）`, badName.length === 0)
  const missing = []
  for (const [k, entry] of Object.entries(SOURCE)) {
    for (const loc of LOCALES) {
      if (typeof entry[loc] !== 'string' || entry[loc].trim() === '') missing.push(`${k}.${loc}`)
    }
  }
  record(`★ 两种语言都不为空（缺：${missing.slice(0, 4).join(',') || '无'}）`, missing.length === 0)
  const unknownLocale = keys.flatMap((k) => Object.keys(SOURCE[k]).filter((l) => !LOCALES.includes(l)))
  record('没有多余语言字段', unknownLocale.length === 0)
}

console.log('\n2. ★ 假翻译门禁：两种语言必须真的不同（防"把英文填进中文"）')
{
  const same = Object.entries(SOURCE)
    .filter(([k, entry]) => !ALLOW_SAME.has(k) && entry.en === entry.zh_CN)
    .map(([k]) => k)
  record(`en 与 zh_CN 都不同的有 ${String(Object.keys(SOURCE).length - same.length)} 条（相同：${same.join(',') || '无'}）`, same.length === 0)
  const zhUntranslated = Object.entries(SOURCE).filter(([, e]) => !CJK.test(e.zh_CN)).map(([k]) => k)
  record(`★ zh_CN 里确实含汉字（可疑：${zhUntranslated.join(',') || '无'}）`, zhUntranslated.length === 0)
}

console.log('\n3. 生成物与源表一致（单源不漂移）')
{
  for (const locale of SHIPPED_LOCALES) {
    const chromeFile = JSON.parse(readFileSync(join(EXT, '_locales', locale, 'messages.json'), 'utf8'))
    const srcKeys = Object.keys(SOURCE).sort().join(',')
    const genKeys = Object.keys(chromeFile).sort().join(',')
    record(`${locale}/messages.json 的 key 集合 == 源表`, srcKeys === genKeys)
    const mismatch = Object.keys(SOURCE).filter((k) => chromeFile[k]?.message !== SOURCE[k][locale])
    record(`${locale}/messages.json 每条文案与源表逐字一致`, mismatch.length === 0)
  }
  record('生成的 JS 模块语言集合 == 发布语言', Object.keys(MESSAGES).sort().join(',') === [...SHIPPED_LOCALES].sort().join(','))
  /*
   * ★★ 这是"永远英文"的机制本身：Chrome 按浏览器界面语言挑语言包，挑不到就退到 default_locale。
   * 所以**只要 _locales 下只有 en**，用户 Chrome 是中文还是英文，插件都必然是英文版。
   * 把 zh_CN 加回去 ⇒ 这条会红。
   */
  const localeDirs = readdirSync(join(EXT, '_locales')).sort()
  record(`★ _locales 下只有一个语言包且是 en（实际：${localeDirs.join(',')}）`, localeDirs.length === 1 && localeDirs[0] === 'en')
  record('★ 没有发布 zh_CN（否则中文浏览器会看到中文，违背"永远英文"）', existsSync(join(EXT, '_locales', 'zh_CN')) === false)
  record('默认语言是 en（与 manifest default_locale 一致）', DEFAULT_LOCALE === 'en')
  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'))
  record('★ manifest 的 default_locale == 生成物的默认语言', manifest.default_locale === DEFAULT_LOCALE)
}

console.log('\n4. manifest 的本地化字段走 __MSG_*__（不是写死的名字）')
{
  const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'))
  record('name 用 __MSG_extName__', manifest.name === '__MSG_extName__')
  record('description 用 __MSG_extDescription__', manifest.description === '__MSG_extDescription__')
  record('action.default_title 用 __MSG_*__', /^__MSG_[A-Za-z0-9_]+__$/u.test(manifest.action?.default_title ?? ''))
  record('★ 扩展 ID 的钉死公钥还在（key 不变 ⇒ ID 不变）', typeof manifest.key === 'string' && manifest.key.length > 100)
}

console.log('\n5. ★ 漏抽取门禁：代码/HTML 里引用的 key 必须都在源表里')
{
  const referenced = new Set()
  const files = []
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) { walk(full); continue }
      if (/\.(js|html)$/u.test(entry.name)) files.push(full)
    }
  }
  walk(join(EXT, 'src'))
  let scanned = 0
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    scanned += 1
    for (const m of text.matchAll(/\bt\(\s*'([A-Za-z0-9_]+)'/gu)) referenced.add(m[1])
    for (const m of text.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/gu)) referenced.add(m[1])
    for (const m of text.matchAll(/data-i18n(?:-title)?="([A-Za-z0-9_]+)"/gu)) referenced.add(m[1])
  }
  /*
   * 还有一类 key 是**间接**引用的：判定函数返回 key 名（`CODE_TO_KEY`、`PERMISSION_KEY`），
   * 由调用方拿去 `t()`。它们对文本扫描不可见 —— 所以直接 import 那张数据表把它们收进来，
   * 而不是手写豁免名单（豁免名单会过期）。
   */
  for (const key of Object.values(CODE_TO_KEY)) referenced.add(key)
  referenced.add(PERMISSION_KEY)
  // manifest 里的 `__MSG_xxx__` 也是引用（它不在 src/ 下，所以单独扫一遍）
  const manifestText = readFileSync(join(EXT, 'manifest.json'), 'utf8')
  for (const m of manifestText.matchAll(/__MSG_([A-Za-z0-9_]+)__/gu)) referenced.add(m[1])

  const unknown = [...referenced].filter((k) => !Object.hasOwn(SOURCE, k))
  record(`扫了 ${String(scanned)} 个文件，引用 ${String(referenced.size)} 个 key（含错误码数据表）`, scanned > 0 && referenced.size > 0)
  record(`★ 引用的 key 都在源表里（缺失：${unknown.join(',') || '无'}）`, unknown.length === 0)
  // 反向：源表里有、但没人引用的死文案
  const dead = Object.keys(SOURCE).filter((k) => !referenced.has(k))
  record(`源表里没有死文案（未被引用：${dead.join(',') || '无'}）`, dead.length === 0)
}

console.log('6. ★ 已抽取的文件里不许再有**面向用户**的汉字字面量（逐轮往里加文件）')
{
  const offenders = []
  for (const rel of EXTRACTED_FILES) {
    const text = readFileSync(join(EXT, rel), 'utf8')
    if (!residualCjk(text)) continue
    const sample = stripComments(text).split('\n').find((l) => CJK.test(l)) ?? ''
    offenders.push(`${rel} → ${sample.trim().slice(0, 60)}`)
  }
  record(`已抽取清单：${EXTRACTED_FILES.length} 个文件`, EXTRACTED_FILES.length > 0)
  record(`★ 0 处残留（发现 ${String(offenders.length)} 处）${offenders.length > 0 ? ` → ${offenders.join('；')}` : ''}`, offenders.length === 0)
}

console.log('\n7. 运行期取值 t()：无 chrome.i18n 时也必须有确定结果')
{
  record('已知 key → 默认语言（en）文案', t('retry') === 'Retry')
  record('★ 未知 key → 原样返回 key（一眼看出漏配，而不是空串）', t('noSuchKey') === 'noSuchKey')
  record('占位替换 $1', t('errNoWorkspace', ['boom']).includes('boom'))
  record('★ 未知占位不炸、原样留着', t('errNoWorkspace').includes('$1'))
  // 运行期只带发布语言（en）⇒ 生成的模块里不该再有 zh_CN（那是参考稿，不进产物）
  record('★ 运行期模块只含发布语言（没有 zh_CN）', MESSAGES.zh_CN === undefined)

  // 模拟扩展环境：chrome.i18n 在场时必须优先用它
  const saved = globalThis.chrome
  globalThis.chrome = { i18n: { getMessage: (k) => (k === 'retry' ? '重试（来自 chrome.i18n）' : ''), getUILanguage: () => 'zh_CN' } }
  record('★ 有 chrome.i18n 时优先用它（而不是兜底）', t('retry') === '重试（来自 chrome.i18n）')
  record('★ chrome.i18n 返回空串时回落到兜底（不显示空白）', t('extName').length > 0)
  record('uiLanguage() 读 chrome.i18n', uiLanguage() === 'zh_CN')
  if (saved === undefined) delete globalThis.chrome; else globalThis.chrome = saved
  record('uiLanguage() 无 chrome 时回落默认语言', uiLanguage() === DEFAULT_LOCALE)
}

console.log('\n8. applyI18n()：真的把文案填进 DOM（用假 document 断言，不用真浏览器）')
{
  const fakeEl = (attrs = {}) => {
    const store = { ...attrs }
    return {
      textContent: attrs.__text ?? '',
      getAttribute: (n) => store[n] ?? null,
      setAttribute: (n, v) => { store[n] = v },
      title: store.title ?? '',
    }
  }
  const textEl = fakeEl({ 'data-i18n': 'retry' })
  const titleEl = fakeEl({ 'data-i18n-title': 'statusTitle' })
  const html = { lang: 'xx' }
  const doc = {
    documentElement: html,
    querySelectorAll: (sel) => (sel === '[data-i18n]' ? [textEl] : sel === '[data-i18n-title]' ? [titleEl] : []),
  }
  const touched = applyI18n(doc)
  record('返回填充过的元素数（2）', touched === 2)
  record('★ textContent 被替成文案', textEl.textContent === t('retry'))
  record('★ title 属性被替成文案', titleEl.getAttribute('title') === t('statusTitle'))
  record('★ <html lang> 被设成界面语言（并转成 BCP-47 的连字符形式）', html.lang === 'en')

  record('没有 document 时返回 0 而不是抛异常', applyI18n(null) === 0)
  record('空查询结果返回 0', applyI18n({ documentElement: null, querySelectorAll: () => [] }) === 0)
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
