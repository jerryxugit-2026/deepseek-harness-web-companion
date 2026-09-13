#!/usr/bin/env node
/**
 * 依赖体检的**判定规则**单测（`bootstrap/lib/checks.mjs`）。
 *
 * 为什么单测"判定"而不是"探测"：探测跟着环境走（换台机器结果就不同），判定是**规则** ——
 * 「Node 太老算不算阻断」「端口被占是警告还是阻断」「缺 Chrome 要不要拦」这些必须写死并可回归。
 * 所以 checks.mjs 只吃事实、不碰磁盘；本文件喂它各种事实组合。
 *
 * 用法：node tests/unit/preflight-checks.test.mjs
 */
import {
  checkChrome,
  checkDirectory,
  checkDshCli,
  checkMount,
  checkNode,
  checkPort,
  renderChecks,
  summarize,
} from '../../bootstrap/lib/checks.mjs'
// ★ 端口从 `layout.mjs` 导（2026-09-13 修；PiMoa 片 3 第 17 条）：原来逐字写死 3080，
//   于是改默认端口**不会让任何测试变红**。
import { DEFAULT_PORT } from '../../bootstrap/lib/layout.mjs'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

console.log('1. Node：唯一的"引导程序装不了"的依赖，且必须给出去哪装')
{
  record('够新 → ok', checkNode({ nodeVersion: 'v22.22.3' }).status === 'ok')
  record('刚好边界 → ok', checkNode({ nodeVersion: 'v22.0.0' }).status === 'ok')
  const old = checkNode({ nodeVersion: 'v18.20.0' })
  record('太老 → missing（阻断）', old.status === 'missing')
  record('太老时给了安装指引（不是只说"缺"）', typeof old.fix === 'string' && old.fix.includes('nodejs.org'))
  record('Node 标成装不了（不该假装能代装）', old.installable === 'manual' && old.command === null)
  record('取不到版本 → missing', checkNode({ nodeVersion: 'garbage' }).status === 'missing')
}

console.log('\n2. dsh 命令：缺了要给出**钉版本**的安装命令（不能用 latest）')
{
  const missing = checkDshCli({ dshCliPath: null, dshVersion: null, targetDshVersion: '0.1.5-rc.2' })
  /*
   * ★ 缺 DSH 是 **warn 而不是 missing（阻断）** —— 因为引导程序自己会装它（第 3 步）。
   * 全新机器上缺 DSH 是**正常**状态；把它当阻断会误导用户看到
   * "仍有阻断项，仍要继续吗？（不推荐）"。阻断只留给引导程序办不到的事。
   */
  record('★ 缺 → warn（不是阻断，因为引导程序会代装）', missing.status === 'warn')
  record('★ 缺的时候不会被算成阻断项', summarize([missing]).blockers.length === 0)
  record('但仍然是"可代装"类', missing.installable === 'installable')
  record('★ 指引里带钉死的版本', missing.fix.includes('@0.1.5-rc.2'))
  record('★ 指引里明说不要用 latest', missing.fix.includes('不要用 latest'))
  record('给出可执行命令（引导程序可代装）', Array.isArray(missing.command) && missing.command[1].includes('@deepseek-ai/dsh@0.1.5-rc.2'))

  const match = checkDshCli({ dshCliPath: '/usr/local/bin/dsh', dshVersion: '0.1.5-rc.2', targetDshVersion: '0.1.5-rc.2' })
  record('版本一致 → ok', match.status === 'ok')
  record('把 dsh 的路径显示出来', match.detail.includes('/usr/local/bin/dsh'))

  const drift = checkDshCli({ dshCliPath: '/usr/local/bin/dsh', dshVersion: '0.1.2-rc.1', targetDshVersion: '0.1.5-rc.2' })
  record('★ 版本漂移 → warn（实测跨小版本可用，不该硬拦）', drift.status === 'warn')
  record('漂移时把两个版本都写出来', drift.detail.includes('0.1.2-rc.1') && drift.detail.includes('0.1.5-rc.2'))
  record('漂移不是阻断（status 不是 missing）', drift.status !== 'missing')
}

console.log('\n3. 端口：三种情形必须分得清（这是最容易卡住用户的地方）')
{
  const reuse = checkPort({ port: DEFAULT_PORT, listening: true, paired: true })
  record('已有本插件在跑 → ok 且说"会复用"', reuse.status === 'ok' && reuse.detail.includes('复用'))
  record('复用时不建议用户去动它（无 fix）', reuse.fix === null)

  const stolen = checkPort({ port: DEFAULT_PORT, listening: true, paired: false })
  record('★ 端口被别人占 → warn', stolen.status === 'warn')
  record('★ 给出 lsof 自查命令（含端口号）', stolen.fix.includes('lsof') && stolen.fix.includes(String(DEFAULT_PORT)))

  const free = checkPort({ port: 3099, listening: false, paired: false })
  record('空闲 → ok', free.status === 'ok')
  record('空闲时说明稍后由 DSH 监听', free.detail.includes('空闲'))
}

console.log('\n4. 目录：不存在算"将创建"（不是问题），不可写才算问题')
{
  record('可写 → ok', checkDirectory({ id: 'x', label: 'X', path: '/a', status: 'ok' }).status === 'ok')
  const missing = checkDirectory({ id: 'x', label: 'X', path: '/a', status: 'missing' })
  record('不存在 → ok（会 mkdir）', missing.status === 'ok')
  record('不存在时 detail 写明将创建', missing.detail.includes('将创建'))
  const bad = checkDirectory({ id: 'x', label: 'X', path: '/a', status: 'unwritable' })
  record('★ 不可写 → missing（阻断）', bad.status === 'missing')
  record('不可写时给出要检查的路径', bad.fix.includes('/a'))
}

console.log('\n5. Chrome / 挂载：查不到 Chrome 是警告；挂载指向别处要指出来')
{
  const noChrome = checkChrome({ installed: false, manifestDir: '/x/NativeMessagingHosts', browser: 'chrome' })
  record('没找到 Chrome → warn（不是阻断：用户可能先装 DSH 后装 Chrome）', noChrome.status === 'warn')
  record('给出"先装 Chrome"的指引', noChrome.fix.includes('Chrome'))
  record('已装 → ok 并显示清单落点', checkChrome({ installed: true, manifestDir: '/x/nm', browser: 'chrome' }).detail.includes('/x/nm'))

  const absent = checkMount({ exists: false, entryPath: null, expectedPath: '/inst/…/index.js' })
  record('还没挂载 → warn 且说"将写入"', absent.status === 'warn' && absent.detail.includes('将写入'))
  const same = checkMount({ exists: true, entryPath: '/inst/…/index.js', expectedPath: '/inst/…/index.js' })
  record('已指向目标 → ok', same.status === 'ok')
  const differs = checkMount({ exists: true, entryPath: '/old/checkout/…/index.js', expectedPath: '/inst/…/index.js' })
  record('★ 指向旧位置 → warn（这就是要修的硬编码）', differs.status === 'warn')
  record('★ 把"当前"与"将改为"都摆出来', differs.detail.includes('/old/checkout') && differs.detail.includes('/inst/'))
}

console.log('\n6. 汇总与渲染')
{
  const ok = checkNode({ nodeVersion: 'v22.22.3' })
  const warn = checkPort({ port: DEFAULT_PORT, listening: true, paired: false })
  const block = checkNode({ nodeVersion: 'v16.0.0' })
  const v = summarize([ok, warn, block])
  record('只有一个阻断', v.blockers.length === 1)
  record('阻断就是那条 missing', v.blockers[0].id === 'node')
  record('警告数正确', v.warnings.length === 1)
  record('有阻断 ⇒ ok=false', v.ok === false)
  record('没阻断 ⇒ ok=true', summarize([ok, warn]).ok === true)

  const lines = renderChecks([ok, warn, block])
  record('渲染出至少每项一行', lines.length >= 3)
  record('ok 用 ✅', lines[0].startsWith('✅'))
  // 注意：warn/block 各自还会多渲染一行 "↳ 修法"，所以不能按下标取第 3 行，
  // 得按前缀找（第一版按 lines[2] 取，取到的是 ↳ 那行，假红）。
  record('warn 用 ⚠️', lines.some((l) => l.startsWith('⚠️')))
  record('missing 用 ❌', lines.some((l) => l.startsWith('❌')))
  record('有 fix 的项渲染出 ↳ 修法', lines.some((l) => l.includes('↳')))
  record('ok 的项不渲染 ↳（没毛病就别啰嗦）', lines.filter((l) => l.startsWith('✅')).some((l) => l.includes('↳')) === false)

  /*
   * ★ 2026-09-13 追加（PiMoa 片 B 第 8/16 条）：`summarize` 的「未知 status 当阻断」与
   * `renderChecks` 的 `❓` 当时**没有任何断言** —— 退回旧写法不会变红。
   * 未知状态是"将来有人拼错枚举"的入口：一旦静默通过，就是又一处假绿。
   */
  const mixed = [
    { id: 'a', label: 'ok 项', status: 'ok', detail: 'd', fix: null },
    { id: 'b', label: 'warn 项', status: 'warn', detail: 'd', fix: null },
    { id: 'c', label: 'missing 项', status: 'missing', detail: 'd', fix: null },
    { id: 'x', label: '拼错的状态', status: 'blocked', detail: 'd', fix: null },
  ]
  const sum = summarize(mixed)
  // missing 1 条 + 未知 1 条 = 2 条阻断（未知必须被算进去，这正是本断言要钉的）
  record('★ 未知 status 必须算阻断（退回旧写法 ⇒ 这里红）', sum.ok === false && sum.blockers.length === 2)
  const mixedLines = renderChecks(mixed)
  record('★ 未知 status 渲染成 ❓，不许隐身成空白行（退回 ?? "  " ⇒ 这里红）',
    mixedLines.some((l) => l.startsWith('❓')))
  record('合法状态照旧渲染（ok/warn/missing 都在）',
    mixedLines.some((l) => l.startsWith('✅')) && mixedLines.some((l) => l.startsWith('⚠️')) && mixedLines.some((l) => l.startsWith('❌')))
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
