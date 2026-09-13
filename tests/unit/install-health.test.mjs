#!/usr/bin/env node
/**
 * 健康复检判定单测（`bootstrap/lib/health.mjs`）。
 *
 * 由来（本轮改正的一处**假红**）：第一版把 `/ag/ping` 的 `connectedClients > 0`
 * 标成「扩展已连上桥接」。查源码发现那是 `hub.clientCount` —— **DSH 页面半（client 半）**的
 * 连接数，**不是扩展**。于是用户没开侧边栏时这条会报红，而扩展其实好好的。
 *
 * 本项目的验收口味是"不许假绿，也不许假红"，所以现在：
 *   · 硬判据三条：DSH 应答 / 插件配对 / 产物端口一致 —— 参与总判定；
 *   · 「扩展连通」降级为**软判据**（代理判据），不参与总判定，且必须**如实说明它是代理**、
 *     并给出下一步。要变成真判据得给 `/ag/ping` 加字段（动协议 schema，本轮故意不做）。
 *
 * 用法：node tests/unit/install-health.test.mjs
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluateHealth, finishBanner, overallOk, pendingHard, probeHealth, renderHealth } from '../../bootstrap/lib/health.mjs'
// ★ 端口从 `layout.mjs` 导（2026-09-13 修；PiMoa 片 3 第 17 条）：原来这里逐字写死 3080，
//   于是改默认端口**不会让任何测试变红**。
import { DEFAULT_PORT } from '../../bootstrap/lib/layout.mjs'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
}

const FACTS_OK = {
  port: DEFAULT_PORT,
  ping: { reachable: true, paired: true, connectedClients: 3 },
  distOk: true,
  installDir: '/inst',
}
const byId = (items, id) => items.find((i) => i.id === id)

console.log('1. 全绿时：三条硬判据 + 一条软判据都对')
{
  const items = evaluateHealth(FACTS_OK)
  record('4 条判据', items.length === 4)
  record('DSH 应答 ok', byId(items, 'dsh-up').ok === true)
  record('已配对 ok', byId(items, 'paired').ok === true)
  record('产物端口 ok', byId(items, 'dist-port').ok === true)
  record('扩展代理判据 ok', byId(items, 'extension-proxy').ok === true)
  record('总判定为通过', overallOk(items) === true)
  record('没有待处理的硬判据', pendingHard(items).length === 0)
}

console.log('\n2. ★ 关键：扩展那条是**软**判据 —— 它挂了不许把安装判成失败')
{
  const items = evaluateHealth({ ...FACTS_OK, ping: { reachable: true, paired: true, connectedClients: 0 } })
  const proxy = byId(items, 'extension-proxy')
  record('★ 代理判据 ok=false', proxy.ok === false)
  record('★ 但它标着 soft=true', proxy.soft === true)
  record('★ 总判定仍然是"通过"（只看硬判据）', overallOk(items) === true)
  record('★ 待处理硬判据里没有它', pendingHard(items).some((i) => i.id === 'extension-proxy') === false)
  record('★ 明说这是代理判据（不假装能看穿 Chrome）', proxy.label.includes('代理判据'))
  record('★ 给出下一步：打开侧边栏', proxy.fix.includes('侧边栏'))
  record('★ 如实承认看不到"装没装"', proxy.fix.includes('看不到'))
}

console.log('\n3. 硬判据挂了 ⇒ 总判定必须失败，并给出修法')
{
  const down = evaluateHealth({ ...FACTS_OK, ping: { reachable: false, paired: false, connectedClients: null } })
  record('DSH 不通 → ok=false', byId(down, 'dsh-up').ok === true === false)
  record('★ dsh 那条是硬判据', byId(down, 'dsh-up').soft === false)
  record('总判定失败', overallOk(down) === false)
  record('修法指向 dsh web', byId(down, 'dsh-up').fix.includes('dsh web'))
  record('配对那条也失败', byId(down, 'paired').ok === false)
  record('配对修法指向挂载/重跑', byId(down, 'paired').fix.includes('挂载'))

  const badDist = evaluateHealth({ ...FACTS_OK, distOk: false })
  record('产物端口不一致 → 该条失败', byId(badDist, 'dist-port').ok === false)
  record('总判定失败', overallOk(badDist) === false)
  record('修法给出重建命令（含安装目录）', byId(badDist, 'dist-port').fix.includes('/inst/extension/build.mjs'))
}

console.log('\n4. distOk=null（没跑检查）时不许假装通过')
{
  const items = evaluateHealth({ ...FACTS_OK, distOk: null })
  const dist = byId(items, 'dist-port')
  record('ok=false（没验就是没验）', dist.ok === false)
  record('★ 标为 soft（不因"没检查"而把安装判死）', dist.soft === true)
  record('detail 说"未检查"', dist.detail.includes('未检查'))
  record('总判定不受它影响', overallOk(items) === true)
}

console.log('\n5. 拿不到 connectedClients 时如实说拿不到（不是"通"也不是"不通"）')
{
  const items = evaluateHealth({ ...FACTS_OK, ping: { reachable: true, paired: true, connectedClients: null } })
  const proxy = byId(items, 'extension-proxy')
  record('ok=false', proxy.ok === false)
  record('detail 说明"拿不到这个数"', proxy.detail.includes('拿不到'))
  record('仍然只是软判据', proxy.soft === true)
}

console.log('\n6. 渲染：❌ 的那条要带上 ↳ 修法；✅ 的不啰嗦；软判据用 ⚠️')
{
  const okLines = renderHealth(evaluateHealth(FACTS_OK))
  record('全绿时 4 行', okLines.length === 4)
  record('全绿时没有 ↳', okLines.every((l) => !l.includes('↳')))
  record('全绿时每行 ✅', okLines.every((l) => l.startsWith('✅')))

  const softLines = renderHealth(evaluateHealth({ ...FACTS_OK, ping: { reachable: true, paired: true, connectedClients: 0 } }))
  record('软判据用 ⚠️（不是 ❌）', softLines.some((l) => l.startsWith('⚠️')))
  record('★ 软判据那条带 ↳ 修法', softLines.some((l) => l.startsWith('⚠️') && l.includes('↳')))

  const badLines = renderHealth(evaluateHealth({ ...FACTS_OK, ping: { reachable: false, paired: false, connectedClients: null } }))
  record('硬判据失败用 ❌', badLines.some((l) => l.startsWith('❌')))
  record('❌ 那条带 ↳ 修法', badLines.some((l) => l.startsWith('❌') && l.includes('↳')))
}

console.log('\n7. ★ probeHealth（有 I/O 的那层）：引导程序第 11 步与 doctor 共用它')
{
  const base = mkdtempSync(join(tmpdir(), 'ag-health-'))
  const withScript = join(base, 'with-script')
  const withoutScript = join(base, 'without-script')
  mkdirSync(join(withScript, 'scripts'), { recursive: true })
  mkdirSync(withoutScript, { recursive: true })
  // 假脚本：不会被真的执行（spawn 是注入的），只需"存在"以走进判定分支
  writeFileSync(join(withScript, 'scripts', 'check-dist-config.mjs'), '// stub\n')

  const fakePing = async () => ({ reachable: true, paired: true, connectedClients: 2 })

  const okItems = await probeHealth({
    port: DEFAULT_PORT, dshHome: base, installDir: withScript,
    ping: fakePing, spawn: () => ({ status: 0 }),
  })
  record('注入了 ping 就按注入的走（reachable/paired 传进判定）', byId(okItems, 'dsh-up').ok === true && byId(okItems, 'paired').ok === true)
  record('connectedClients=2 传进代理判据', byId(okItems, 'extension-proxy').ok === true)
  record('产物脚本 exit 0 ⇒ 该条通过', byId(okItems, 'dist-port').ok === true)
  record('总判定通过', overallOk(okItems) === true)

  const failedDist = await probeHealth({
    port: DEFAULT_PORT, dshHome: base, installDir: withScript,
    ping: fakePing, spawn: () => ({ status: 1 }),
  })
  record('产物脚本 exit 1 ⇒ 该条失败', byId(failedDist, 'dist-port').ok === false)
  record('总判定失败', overallOk(failedDist) === false)

  const noScript = await probeHealth({
    port: DEFAULT_PORT, dshHome: base, installDir: withoutScript,
    ping: fakePing, spawn: () => ({ status: 0 }),
  })
  record('★ 没有产物脚本时 distOk=null（不假装通过）', byId(noScript, 'dist-port').ok === false)
  record('★ 且标为 soft（不因缺脚本把安装判死）', byId(noScript, 'dist-port').soft === true)
  record('此时总判定仍只看另外两条硬判据 → 通过', overallOk(noScript) === true)

  const down = await probeHealth({
    port: DEFAULT_PORT, dshHome: base, installDir: withScript,
    ping: async () => ({ reachable: false, paired: false, connectedClients: null }),
    spawn: () => ({ status: 0 }),
  })
  record('DSH 不通 ⇒ 总判定失败', overallOk(down) === false)

  rmSync(base, { recursive: true, force: true })
}

/**
 * 2026-09-13 追加：收尾横幅不许把"**没查**"说成"**没过**"。
 *
 * 真实现场：`node bootstrap/install.mjs --apply --yes`（非交互）跑完，最后打的是
 * "还有硬判据没过（见上面的 ❌ 与 ↳ 修法）" —— 可上面一条 ❌ 都没有，因为非交互时
 * `w.pause()` 返回 false、第 11 步复检**压根没跑**，`health` 是空数组，
 * 而 `overallOk([])` 是 false。退回"直接 overallOk(health)"的写法，第一条断言就会红。
 */
console.log('\n4. finishBanner：没复检 ≠ 复检没过')
{
  const none = finishBanner([])
  record('★ 没复检时不许说"硬判据没过"（退回 overallOk(health) ⇒ 这里红）', none.text.includes('硬判据没过') === false)
  record('没复检时要说清是"没做复检"', none.text.includes('没做复检'))
  record('没复检时不提示软判据', none.softFailed.length === 0)

  const allHardOk = finishBanner([
    { id: 'dsh-up', ok: true, soft: false, label: 'A' },
    { id: 'paired', ok: true, soft: false, label: 'B' },
    { id: 'dist-port', ok: true, soft: false, label: 'C' },
  ])
  record('硬判据全过 ⇒ 报"全过"', allHardOk.text.includes('硬判据全过'))
  record('硬判据全过 ⇒ ok=true', allHardOk.ok === true)

  const hardFail = finishBanner([
    { id: 'dsh-up', ok: true, soft: false, label: 'A' },
    { id: 'paired', ok: false, soft: false, label: 'B' },
  ])
  record('硬判据真没过 ⇒ 才报"没过"', hardFail.text.includes('硬判据没过'))
  record('硬判据没过 ⇒ ok=false', hardFail.ok === false)

  const onlySoftFail = finishBanner([
    { id: 'dsh-up', ok: true, soft: false, label: 'A' },
    { id: 'extension-proxy', ok: false, soft: true, label: '扩展连通' },
  ])
  record('只有软判据没过 ⇒ 硬判据仍算全过', onlySoftFail.text.includes('硬判据全过'))
  record('软判据未过会点名 id（上层据此给"开侧边栏"提示）', onlySoftFail.softFailed.length === 1 && onlySoftFail.softFailed[0].id === 'extension-proxy')

  /*
   * ★ 2026-09-13 追加（PiMoa 片 3 第 2 条 BLOCKER + 片 1 第 6 条）：
   *   ① 横幅括号里只能列**真查过**的判据；
   *   ② 挂载被跳过 / 非交互全按否 ⇒ 不许报"装好了"。
   * 退回写死文案、或退回不看这两个入参 ⇒ 下面三条立刻红。
   */
  const unchecked = finishBanner([
    { id: 'dsh-up', ok: true, soft: false, label: '本插件应答' },
    { id: 'paired', ok: true, soft: false, label: '已配对' },
    { id: 'dist-port', ok: false, soft: true, label: '产物端口 == 真实端口' },
  ])
  record('★ 没查过的判据不许出现在"硬判据全过（…）"括号里', unchecked.text.includes('产物端口') === false)
  record('★ 且它要出现在 softFailed 里（好让上层说清"这项没验"）', unchecked.softFailed.length === 1 && unchecked.softFailed[0].id === 'dist-port')
  record('软判据没过不阻断安装本身', unchecked.ok === true)

  const skipped = finishBanner([{ id: 'dsh-up', ok: true, soft: false, label: 'A' }], { mountSkipped: true })
  record('★ 挂载被跳过 ⇒ 一律不算成功（退回 ⇒ 这里红）', skipped.ok === false && skipped.text.includes('等于没装'))

  const declined = finishBanner([{ id: 'dsh-up', ok: true, soft: false, label: 'A' }], { autoDeclined: 3 })
  record('★ 非交互下全按否 ⇒ 一律不算成功（退回 ⇒ 这里红）', declined.ok === false && declined.text.includes('什么都没装'))
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
