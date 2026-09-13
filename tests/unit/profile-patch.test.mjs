#!/usr/bin/env node
/**
 * profile 补丁层读写单测（`bootstrap/lib/profile-patch.mjs`）。
 *
 * 由来（用户 2026-09-12）：「这是典型的硬编码问题。我们要在这个版本，彻底检查，变成通过
 * 引导程序传入参数。」要参数化的就是这一行 —— 现在它是**手工**写进
 * `$DSH_HOME/profiles/web/cordis.patch.yml` 的、指向下载目录的绝对路径。
 *
 * 本文件要证明三件事（用户把下载目录挪走/删掉之后不能出事）：
 *   1. **幂等**：重复运行不产生第二个条目；
 *   2. **最小改动**：只动我们那一个条目，文件里别人的条目（semble / codegraph）与
 *      人类写的注释**逐字节不动** —— 这条用"行级 diff 只能有一行"来咬；
 *   3. **可逆**：摘掉之后能回到原样（round-trip 逐字节相等）。
 *
 * 夹具刻意照用户**真实文件的形状**写（含 semble / codegraph 两个 insert 段、中间的空行、
 * 段前的说明注释、config 里的人类注释），因为"手搓夹具会盖住真缺陷"是这个项目栽过的地方。
 *
 * 用法：node tests/unit/profile-patch.test.mjs
 */
import {
  MANAGED_CONFIG_KEYS,
  MARK_BEGIN,
  MARK_END,
  buildMountConfig,
  describeCompanion,
  findEntrySpan,
  readCompanionEntry,
  removeCompanion,
  renderBlock,
  upsertCompanion,
  yamlScalar,
} from '../../bootstrap/lib/profile-patch.mjs'
import { PLUGIN_ID } from '../../bootstrap/lib/layout.mjs'

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

/** 用户真实文件的形状（示例里把路径换成占位，结构逐字照抄）。 */
const OLD_PATH = '/Users/someone/Downloads/网页插件/dsh-plugin/src/host/index.js'
const NEW_PATH = '/Users/someone/.dsh/plugins/dsh-web-companion/dsh-plugin/src/host/index.js'

const FIXTURE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).

- insert:
    # --- semble: document retrieval, via a shared HTTP service ------------
    - id: mcp-semble
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: semble
        transport: streamable-http
        url: http://127.0.0.1:8757/mcp
        toolCallTimeoutMs: 300000
        failOnStartupError: false

    # --- codegraph: code symbol graph (stdio) ------------------------------
    - id: mcp-codegraph
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: codegraph
        transport: stdio
        command: /opt/somewhere/node
        failOnStartupError: false

# --- DSH Web Companion bridge ----------------------------------------------
# 浏览器伴侣的 host 半（/ag/* 路由）。client 半由同一 package 的
# exports["./client"] + dsh.client.platform 自动发现，无需单列一行。
# 回滚：删除本 insert 段；或 \`cp cordis.patch.yml.bak-before-companion cordis.patch.yml\`
- insert:
    - id: dsh-web-companion-bridge
      name: '${OLD_PATH}'
      config:
        # 写操作**不走审批缝**，只由面板上的「写操作」开关把关。
        # 为什么这么配（2026-09-12 用户决定）：本机会话审批策略是 never。
        approvalForWriteOps: false
`

/** 行级 diff：返回改动过的行号（0 基）。 */
function changedLines(a, b) {
  const la = a.split('\n')
  const lb = b.split('\n')
  const out = []
  const n = Math.max(la.length, lb.length)
  for (let i = 0; i < n; i += 1) if (la[i] !== lb[i]) out.push(i)
  return out
}

/**
 * 取出某个 id 所在的顶层条目原文（用于逐字节比较"别人没被动过"）。
 *
 * 两端的空行要裁掉再比：顶层条目的边界由"下一个顶层 `- `"决定，因此末尾那一个空行
 * 会随"后面还有没有别的条目"而出现/消失 —— 那不是内容变化。（第一版没裁，于是假红。）
 */
function sliceEntry(text, id) {
  const span = findEntrySpan(text, id)
  if (span === null) return null
  const lines = text.split('\n').slice(span.start, span.end)
  while (lines.length > 0 && lines[0].trim() === '') lines.shift()
  while (lines.length > 0 && lines.at(-1).trim() === '') lines.pop()
  return lines.join('\n')
}

console.log('1. 先能读出当前挂的是哪条路径（诊断）')
{
  const info = readCompanionEntry(FIXTURE, PLUGIN_ID)
  record('找到了条目', info.found === true)
  record('读出的路径 == 夹具里的旧路径', info.entryPath === OLD_PATH)
  const d = describeCompanion(FIXTURE, { id: PLUGIN_ID })
  record('不是托管块（是人类手写的）', d.managed === false)
}

console.log('\n2. ★ 换参数写入：只动 name 一行，别的条目逐字节不动')
{
  const before = {
    semble: sliceEntry(FIXTURE, 'mcp-semble'),
    codegraph: sliceEntry(FIXTURE, 'mcp-codegraph'),
  }
  const { text, action } = upsertCompanion(FIXTURE, { id: PLUGIN_ID, entryPath: NEW_PATH })
  record("action === 'updated'", action === 'updated')
  record('新路径写进去了', readCompanionEntry(text, PLUGIN_ID).entryPath === NEW_PATH)

  const changed = changedLines(FIXTURE, text)
  record(`行级 diff 只有 1 行（实际 ${String(changed.length)} 行：${changed.join(',')}）`, changed.length === 1)
  record('改动的那一行正是 name:', text.split('\n')[changed[0]]?.trim().startsWith('name:') === true)
  record('semble 条目逐字节不动', sliceEntry(text, 'mcp-semble') === before.semble)
  record('codegraph 条目逐字节不动', sliceEntry(text, 'mcp-codegraph') === before.codegraph)
  record('顶层条目数不变（没插出第二个）', (text.match(/^- /gmu) ?? []).length === (FIXTURE.match(/^- /gmu) ?? []).length)
  record('人类写的说明注释仍在', text.includes('# --- DSH Web Companion bridge ---'))
  record('config 里的人类注释仍在', text.includes('为什么这么配（2026-09-12 用户决定）'))
  record('approvalForWriteOps 没被覆盖', text.includes('approvalForWriteOps: false'))
}

console.log('\n3. ★ 幂等：再跑一次必须一个字都不改')
{
  const once = upsertCompanion(FIXTURE, { id: PLUGIN_ID, entryPath: NEW_PATH })
  const twice = upsertCompanion(once.text, { id: PLUGIN_ID, entryPath: NEW_PATH })
  record("第二次 action === 'unchanged'", twice.action === 'unchanged')
  record('第二次文本与第一次逐字节相等', twice.text === once.text)
  record('第三次也一样', upsertCompanion(twice.text, { id: PLUGIN_ID, entryPath: NEW_PATH }).text === once.text)
}

console.log('\n4. 路径含空格必须加引号（本仓路径就带空格）')
{
  const spaced = '/Users/a b/c d/dsh-plugin/src/host/index.js'
  const { text } = upsertCompanion(FIXTURE, { id: PLUGIN_ID, entryPath: spaced })
  record('带空格的路径被单引号包住', text.includes(`name: '${spaced}'`))
  record('再读回来不带引号（能被解析）', readCompanionEntry(text, PLUGIN_ID).entryPath === spaced)
  record('yamlScalar 对普通值不加引号', yamlScalar('captures') === 'captures')
  record('yamlScalar 对数字保持原样', yamlScalar(24) === '24')
  record('yamlScalar 对布尔保持原样', yamlScalar(false) === 'false')
  record('yamlScalar 对空串加引号', yamlScalar('') === "''")
}

console.log('\n5. config 键 upsert：新增不破坏已有的，值跟随参数')
{
  const { text } = upsertCompanion(FIXTURE, {
    id: PLUGIN_ID,
    entryPath: NEW_PATH,
    config: { attachDir: 'captures', approvalForWriteOps: false },
  })
  record('新键 attachDir 进来了', text.includes('attachDir: captures'))
  record('老键 approvalForWriteOps 仍在', text.includes('approvalForWriteOps: false'))
  record('config 内的人类注释仍在', text.includes('不走审批缝'))
  // 改值
  const { text: t2 } = upsertCompanion(text, { id: PLUGIN_ID, entryPath: NEW_PATH, config: { attachDir: 'captures-en' } })
  record('改 attachDir 的值生效', t2.includes('attachDir: captures-en'))
  record('attachDir 只出现一次（没插重）', (t2.match(/attachDir:/gu) ?? []).length === 1)
  record('semble 仍未被动', sliceEntry(t2, 'mcp-semble') === sliceEntry(FIXTURE, 'mcp-semble'))
}

console.log('\n6. ★ 卸载：摘掉我们这一条（连配套说明头），别人逐字节不动')
{
  const { text, action } = removeCompanion(FIXTURE, { id: PLUGIN_ID })
  record("action === 'removed'", action === 'removed')
  record('条目本体没了', text.includes(PLUGIN_ID) === false)
  record('配套说明头也摘掉了', text.includes('# --- DSH Web Companion bridge') === false)

  /*
   * 「别人没被动过」要按**区域**比，不能按 `sliceEntry` 比。
   *
   * 原因（写第一版时踩的）：我们那一块的说明注释在第二处顶层 `- insert:` 的**上面**，
   * 而顶层条目的边界是"下一个顶层 `- `"，所以那几行注释在结构上算作**前一个**条目的尾部 ——
   * 用 `sliceEntry('mcp-semble')` 取出来的片里就带着我们的说明头，一比就假红。
   * 这里改成比"我们的块之前的所有内容"，这才是"别人的东西没被动过"的准确表述。
   */
  const beforeOurBlock = (t) => t.split('# --- DSH Web Companion bridge ---')[0].trimEnd()
  record('★ 我们那一块之前的内容逐字节不动（semble + codegraph 都在其中）', beforeOurBlock(text) === beforeOurBlock(FIXTURE))
  record('★ 我们那一块之后没有残留（它本来就是最后一块）', text.trimEnd() === beforeOurBlock(text))
  record('semble 仍在', text.includes('serverName: semble'))
  record('codegraph 仍在', text.includes('serverName: codegraph'))
  // 夹具里顶层只有两个 `- insert:`（第一个装 semble+codegraph，第二个装本插件），
  // 摘掉我们的之后应剩 1 个 —— 不是 2。
  record(`顶层条目只剩 1 个（实际 ${String((text.match(/^- /gmu) ?? []).length)} 个）`, (text.match(/^- /gmu) ?? []).length === 1)
  record('夹具本身就是 2 个顶层条目（前提断言）', (FIXTURE.match(/^- /gmu) ?? []).length === 2)
  record('文件头（别人的注释）仍在', text.startsWith('# Your patch layer for this dsh profile'))
}

console.log('\n7. 没有我们条目时：卸载是 no-op，不报错')
{
  const plain = `- insert:\n    - id: mcp-semble\n      name: x\n`
  const { text, action } = removeCompanion(plain, { id: PLUGIN_ID })
  record("action === 'absent'", action === 'absent')
  record('文本一字未改', text === plain)
}

console.log('\n8. ★ 托管块：插入 → 幂等 → 卸载后回到原样（round-trip 逐字节）')
{
  const plain = `- insert:\n    - id: mcp-semble\n      name: x\n`
  const ins = upsertCompanion(plain, { id: PLUGIN_ID, entryPath: NEW_PATH, config: { attachDir: 'captures' } })
  record("action === 'inserted'", ins.action === 'inserted')
  record('写入了托管块标记', ins.text.includes(MARK_BEGIN) && ins.text.includes(MARK_END))
  record('块在文件末尾（没插到别人中间）', ins.text.trimEnd().endsWith(MARK_END))
  record('原内容还在最前面', ins.text.startsWith(plain.trimEnd()))
  const again = upsertCompanion(ins.text, { id: PLUGIN_ID, entryPath: NEW_PATH, config: { attachDir: 'captures' } })
  record("托管块也幂等（action === 'unchanged'）", again.action === 'unchanged' && again.text === ins.text)
  const { text: back, action } = removeCompanion(ins.text, { id: PLUGIN_ID })
  record("卸载托管块 action === 'removed'", action === 'removed')
  record('★ round-trip：卸载后与插入前逐字节相等', back === plain)
  record('托管块标记清干净了', back.includes('>>>') === false)
  record('describeCompanion 认出托管块', describeCompanion(ins.text, { id: PLUGIN_ID }).managed === true)
}

console.log('\n9. 边界：文件末尾没有换行 / 空文件 / 末尾多空行')
{
  const noEol = `- insert:\n    - id: mcp-semble\n      name: x` // 末尾无 \n
  const out = upsertCompanion(noEol, { id: PLUGIN_ID, entryPath: NEW_PATH })
  record('末尾无换行也能处理且补上换行', out.text.endsWith('\n') === true)
  record('原内容仍在', out.text.includes('- id: mcp-semble'))

  const trailing = `- insert:\n    - id: mcp-semble\n      name: x\n\n\n`
  const out2 = upsertCompanion(trailing, { id: PLUGIN_ID, entryPath: NEW_PATH })
  record('末尾多空行不会积成一片（块紧跟在内容后）', out2.text.includes('name: x\n\n' + MARK_BEGIN))

  const empty = upsertCompanion('', { id: PLUGIN_ID, entryPath: NEW_PATH })
  record('空文件也能写入（不抛）', empty.action === 'inserted' && empty.text.includes(PLUGIN_ID))
  record('空文件写入后无前导空行', empty.text.startsWith(MARK_BEGIN))
}

console.log('\n10. 渲染出来的块本身是合法 YAML 形状（缩进对齐）')
{
  const block = renderBlock({ id: PLUGIN_ID, entryPath: NEW_PATH, config: { attachDir: 'captures' } })
  record('首行是标记', block[0] === MARK_BEGIN)
  record('末行是标记', block.at(-1) === MARK_END)
  record('有顶层 - insert:', block[1] === '- insert:')
  record('id 缩进 4 空格', block[2].startsWith('    - id: '))
  record('name 缩进 6 空格', block[3].startsWith('      name: '))
  record('config 缩进 6 空格', block[4] === '      config:')
  record('config 的键缩进 8 空格', block[5].startsWith('        attachDir: '))
}

console.log('\n11. ★ 新装 vs 老装：要写哪些 config（附一次真事故的教训）')
{
  // 依据用户决定：抓取目录"新装用英文名、老装保留原名（历史 @引用 不失效）"
  record('★ 新装 ⇒ 写 attachDir=captures', buildMountConfig({ freshInstall: true }).attachDir === 'captures')
  record('★ 老装 ⇒ 不写 attachDir（沿用插件默认的中文名）', buildMountConfig({ freshInstall: false }).attachDir === undefined)
  record('老装时 config 是空对象（不动任何键）', Object.keys(buildMountConfig({ freshInstall: false })).length === 0)

  /*
   * ★ 真事故（2026-09-12，本安装器自己造成的）："卸载 → 重装"往返把用户 profile 里的
   * `approvalForWriteOps: false` 悄悄丢了 ⇒ `/ag/control` 的 approvalMode 从 off 变回 ask。
   * 修法：用户设过的键必须能**显式传进来**，而不是靠安装器猜。
   */
  record('★ 显式传 approvalForWriteOps:false ⇒ 写进去（老装也一样）',
    buildMountConfig({ freshInstall: false, approvalForWriteOps: false }).approvalForWriteOps === false)
  record('显式传 true 也写进去', buildMountConfig({ freshInstall: false, approvalForWriteOps: true }).approvalForWriteOps === true)
  record('不传 ⇒ 不写这个键（不猜、不覆盖）',
    buildMountConfig({ freshInstall: false }).approvalForWriteOps === undefined)
  record('--set 的额外键会并进去',
    buildMountConfig({ freshInstall: false, extra: { retentionHours: 48 } }).retentionHours === 48)
  record('新装 + 显式键可以同时生效', (() => {
    const c = buildMountConfig({ freshInstall: true, approvalForWriteOps: false })
    return c.attachDir === 'captures' && c.approvalForWriteOps === false
  })())
  record('托管块的键名清单里含这两个', MANAGED_CONFIG_KEYS.includes('attachDir') && MANAGED_CONFIG_KEYS.includes('approvalForWriteOps'))
}

console.log('\n12. 托管块写入：**保留**上一轮写入、本次没传的键（升级不许丢配置）')
{
  const first = upsertCompanion('- insert:\n    - id: other\n      name: x\n', {
    id: PLUGIN_ID, entryPath: NEW_PATH, config: { attachDir: 'captures', approvalForWriteOps: false },
  })
  record('先写入带两个键的托管块', first.text.includes('attachDir: captures') && first.text.includes('approvalForWriteOps: false'))
  const second = upsertCompanion(first.text, { id: PLUGIN_ID, entryPath: NEW_PATH, config: { approvalForWriteOps: false } })
  /*
   * ★ 2026-09-13 **有意改掉**旧期望（原文：「只传一个键时，那个没传的键**会被去掉**（整体替换语义）」）。
   *
   * 那个旧期望正是 2026-09-12 那次真实事故的**成因**：「卸载 → 重装 / 升级」把用户 profile 里
   * 的 `approvalForWriteOps: false` 悄悄删掉，`/ag/control` 的 approvalMode 从 off 变回 ask。
   * 用户明确要求"装/升级合一、升级不许丢配置"，所以改成保留 —— 这不是"为绿灯改期望"，
   * 是把一个被固化的**缺陷**改成正确行为（PiMoa 片 2 第 9 条也点了这条）。
   */
  record('★ 没传的键**被保留**（退回整体替换语义 ⇒ 这里红）', second.text.includes('attachDir: captures'))
  record('★ 且如实报告保留了哪些键（升级时好提示用户）', second.preserved.includes('attachDir'))
  record('没传的键不被删也不重复', (second.text.match(/attachDir:/gu) ?? []).length === 1)
  record('本次传的键照常生效', second.text.includes('approvalForWriteOps: false'))
  record('别人的条目仍在', second.text.includes('- id: other'))
}

console.log('\n13. ★ 与邻居同处一个 `- insert:` 段：只动我们这一条（数据安全）')
{
  /*
   * 真机形状：DSH **允许一个 `- insert:` 段里装好几条** —— 用户真实的
   * `/Users/mac/.dsh/profiles/web/cordis.patch.yml` 里，那一段就同时装着 mcp-semble
   * 与 mcp-codegraph。原来的"段级"范围会把邻居的 name 覆盖掉、卸载时把邻居整段删掉。
   */
  const shared = [
    '- insert:',
    '    - id: mcp-semble',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: semble',
    '',
    '    - id: mcp-codegraph',
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: codegraph',
    '        args:',
    '          - --liftoff-only',
    '',
    `    - id: ${PLUGIN_ID}`,
    '      name: /old/path.js',
    '      config:',
    '        approvalForWriteOps: false',
    '',
  ].join('\n')

  const up = upsertCompanion(shared, { id: PLUGIN_ID, entryPath: NEW_PATH, config: { attachDir: 'captures' } })
  record('★ 邻居的 name 没被覆盖（退回段级范围 ⇒ 这里红）',
    (up.text.match(/'@deepseek-ai\/dsh-mcp-client'/gu) ?? []).length === 2)
  record('邻居的 config 仍在', up.text.includes('serverName: semble') && up.text.includes('serverName: codegraph'))
  record('嵌套列表项没被当成"另一个条目"处理', up.text.includes('- --liftoff-only'))
  record('我们这条的 name 换新了', up.text.includes(NEW_PATH))
  record('段头没被拆成两个', (up.text.match(/^- insert:/gmu) ?? []).length === 1)

  const rm = removeCompanion(shared, { id: PLUGIN_ID })
  record('★ 卸载只摘我们这条，邻居一字不动（退回段级 splice ⇒ 这里红）',
    rm.text.includes('mcp-semble') && rm.text.includes('mcp-codegraph'))
  record('我们这条真没了', rm.text.includes(PLUGIN_ID) === false)
  record('段头仍在（还有邻居，不能删）', rm.text.includes('- insert:'))
  record('邻居的嵌套 args 也还在', rm.text.includes('- --liftoff-only'))

  // 反过来：段里只有我们一条时，段头必须被摘干净（不留空 `- insert:`）
  const alone = `- insert:\n    - id: ${PLUGIN_ID}\n      name: /x.js\n`
  const rmAlone = removeCompanion(alone, { id: PLUGIN_ID })
  record('只有我们一条时，段头一起摘掉（返回空文件）', rmAlone.text.trim() === '' && rmAlone.action === 'removed')
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
