#!/usr/bin/env node
/**
 * `.credentials.yaml` 定点写入单测（`bootstrap/lib/credentials.mjs`）。
 *
 * 为什么这个文件必须被单测钉死：引导程序要替用户把 DeepSeek API key 写进去，而那个文件里
 * **不止有这一把 key** —— 还住着 `records.client-connection/browser-session`，
 * **本插件签发登录 cookie 就靠它**（`dsh-plugin/src/host/cookie.js`）。
 * 一旦整体重写丢了字段，插件当场失效，症状还是最难查的那种（"面板连不上"）。
 *
 * 夹具照真实文件的形状写，值全部是**假值**（本测试绝不读用户真实的凭据文件）。
 *
 * 用法：node tests/unit/credentials-write.test.mjs
 */
import {
  DEEPSEEK_KEY_REF,
  readRef,
  readRefKeys,
  recordsSection,
  upsertRef,
} from '../../bootstrap/lib/credentials.mjs'
import { parseScalar, yamlScalar } from '../../bootstrap/lib/yaml-scalar.mjs'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

const FAKE_KEY = 'sk-FAKE000000000000000000000000000000'
const NEW_KEY = 'sk-FAKE111111111111111111111111111111'

/** 照真实文件形状：version + refs（三把 key）+ records（含 browser-session 记录）。 */
const FIXTURE = `version: 1
refs:
  ${DEEPSEEK_KEY_REF}: ${FAKE_KEY}
  ANTHROPIC_API_KEY: sk-ant-FAKE2222222222222222222222
  CLIPROXY_API_KEY: cp-FAKE3333333333333333333333
records:
  client-connection/browser-session:
    kind: hmac
    payload:
      version: 1
      secret: FAKE-SECRET-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
`

console.log('1. 读：能列出 refs 里的键、能取到值（但不回显给别人看）')
{
  const keys = readRefKeys(FIXTURE)
  record(`列出 3 把 key（实际 ${String(keys.length)}）`, keys.length === 3)
  record('含 DEEPSEEK_API_KEY', keys.includes(DEEPSEEK_KEY_REF))
  record('含 ANTHROPIC_API_KEY', keys.includes('ANTHROPIC_API_KEY'))
  record('取值得到了夹具里那把假 key', readRef(FIXTURE, DEEPSEEK_KEY_REF) === FAKE_KEY)
  record('取不存在的键得 null', readRef(FIXTURE, 'NOPE_KEY') === null)
}

console.log('\n2. ★ 值没变时必须一个字都不改（幂等）')
{
  const { text, action } = upsertRef(FIXTURE, DEEPSEEK_KEY_REF, FAKE_KEY)
  record("action === 'unchanged'", action === 'unchanged')
  record('文本逐字节相等', text === FIXTURE)
}

console.log('\n3. ★ 换 key：只动那一行，别的 key 与 records 逐字节不动')
{
  const { text, action } = upsertRef(FIXTURE, DEEPSEEK_KEY_REF, NEW_KEY)
  record("action === 'updated'", action === 'updated')
  record('新值写入成功', readRef(text, DEEPSEEK_KEY_REF) === NEW_KEY)

  const oldLines = FIXTURE.split('\n')
  const newLines = text.split('\n')
  const changed = []
  for (let i = 0; i < Math.max(oldLines.length, newLines.length); i += 1) if (oldLines[i] !== newLines[i]) changed.push(i)
  record(`行级 diff 只有 1 行（实际 ${String(changed.length)} 行）`, changed.length === 1)
  record('改的正是 DEEPSEEK 那一行', newLines[changed[0]]?.trim().startsWith(`${DEEPSEEK_KEY_REF}:`))

  record('★ records 段逐字节不动', recordsSection(text) === recordsSection(FIXTURE))
  record('★ browser-session 的 secret 没动', text.includes('FAKE-SECRET-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'))
  record('ANTHROPIC_API_KEY 没动', readRef(text, 'ANTHROPIC_API_KEY') === readRef(FIXTURE, 'ANTHROPIC_API_KEY'))
  record('CLIPROXY_API_KEY 没动', readRef(text, 'CLIPROXY_API_KEY') === readRef(FIXTURE, 'CLIPROXY_API_KEY'))
  record('行数不变（没插入/删除行）', newLines.length === oldLines.length)
  record('version: 1 仍在第一行', text.startsWith('version: 1\n'))

  // 幂等：再写同一个值
  const again = upsertRef(text, DEEPSEEK_KEY_REF, NEW_KEY)
  record('再写同一个值 → unchanged', again.action === 'unchanged' && again.text === text)
}

console.log('\n4. ★ 键不存在时：插进 refs: 块里，不跑到 records 后面去')
{
  const noKey = FIXTURE.replace(`  ${DEEPSEEK_KEY_REF}: ${FAKE_KEY}\n`, '')
  record('前提：夹具里已经没有这个键', readRef(noKey, DEEPSEEK_KEY_REF) === null)
  const { text, action } = upsertRef(noKey, DEEPSEEK_KEY_REF, NEW_KEY)
  record("action === 'inserted'", action === 'inserted')
  record('插入后取得到', readRef(text, DEEPSEEK_KEY_REF) === NEW_KEY)
  record('插在 records 之前（仍在 refs 块内）', text.indexOf(DEEPSEEK_KEY_REF) < text.indexOf('records:'))
  record('缩进是 2 空格（对齐兄弟键）', text.includes(`\n  ${DEEPSEEK_KEY_REF}: `))
  record('★ records 段逐字节不动', recordsSection(text) === recordsSection(noKey))
  record('别的两把 key 仍在', readRef(text, 'ANTHROPIC_API_KEY') !== null && readRef(text, 'CLIPROXY_API_KEY') !== null)
  record('行数正好 +1', text.split('\n').length === noKey.split('\n').length + 1)
}

console.log('\n5. 连 refs: 块都没有时：新建一个，records 仍然不动')
{
  const noRefs = `version: 1\nrecords:\n  client-connection/browser-session:\n    kind: hmac\n`
  const { text, action } = upsertRef(noRefs, DEEPSEEK_KEY_REF, NEW_KEY)
  record("action === 'inserted'", action === 'inserted')
  record('新建了 refs: 块', text.includes('\nrefs:\n') || text.startsWith('refs:\n'))
  record('取得到新值', readRef(text, DEEPSEEK_KEY_REF) === NEW_KEY)
  record('★ records 段逐字节不动', recordsSection(text) === recordsSection(noRefs))
}

console.log('\n6. 值需要引号时不能写出非法 YAML')
{
  const tricky = 'sk-a b#c:d'
  record('yamlScalar 给可疑值加引号', yamlScalar(tricky).startsWith("'") && yamlScalar(tricky).endsWith("'"))
  const { text } = upsertRef(FIXTURE, DEEPSEEK_KEY_REF, tricky)
  record('读回来与写入的一致（引号被正确还原）', readRef(text, DEEPSEEK_KEY_REF) === tricky)
  record('★ records 段仍然不动', recordsSection(text) === recordsSection(FIXTURE))
  record('parseScalar 还原双写单引号', parseScalar("'a''b'") === "a'b")
  record('parseScalar 去掉双引号', parseScalar('"abc"') === 'abc')
  record('parseScalar 普通值原样', parseScalar('abc') === 'abc')
}

console.log('\n7. 防御：夹具是假的，本测试绝不碰用户真实的凭据文件')
{
  /*
   * ★ 2026-09-13 修（PiMoa 片 2 第 16 条）：原来这两条断言**都是无效的**。
   *
   *   · `!import.meta.url.includes(真实凭据路径)` —— `import.meta.url` 是**本文件自己的
   *     路径**，永远不含那串 ⇒ **恒真**，什么都没断言。
   *   · `FIXTURE.includes('FAKE') && !FIXTURE.includes('sk-') === false` —— `!` 优先级让表达式
   *     实际是 `(... && (!B)) === false`；而夹具里的假 key 本来就带 `sk-` ⇒ 恒真、语义还反了。
   *
   * 现在两条都改成**真会咬**的：源码里不许出现真实凭据路径字面量（改成读真文件就红）；
   * 夹具里每一把 key 都必须带 `FAKE` 标记（粘一把真 key 进来就红）。
   */
  const SELF_SOURCE = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  // needle 拆成两段写，否则这一行自己就命中自己
  record('本测试源码里不含真实凭据路径字面量', SELF_SOURCE.includes('.dsh/' + '.credentials.yaml') === false)
  const fixtureKeys = FIXTURE.match(/sk-[A-Za-z0-9-]+/gu) ?? []
  record('夹具里的 key 全是明显假值（都带 FAKE，没有真 key）',
    fixtureKeys.length > 0 && fixtureKeys.every((k) => k.includes('FAKE')))
  record('三个键名与真实文件一致', readRefKeys(FIXTURE).join(',') === `${DEEPSEEK_KEY_REF},ANTHROPIC_API_KEY,CLIPROXY_API_KEY`)
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
