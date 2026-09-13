#!/usr/bin/env node
/**
 * 终端交互层单测（`bootstrap/lib/wizard.mjs`）—— 用**假 TTY** 驱动，不需要真终端。
 *
 * 由来：上一轮我用 `script` 造 pty 去验引导程序第 10→11 步的交互，卡在 API key 提示，
 * 当时以为是"pty 把输入丢了"。本轮先**假设验证**再动手，结果是**我自己代码的 bug**：
 *
 *   `secret()` 结尾调了 `stdin.pause()`，而**没有任何地方会再 resume**。
 *   readline 的 Interface 在构造时就挂在同一个 stdin 上，后面的
 *   `confirm()` / `pause()` 全靠它收数据 ⇒ **用户一粘贴 API key，
 *   紧接着那句"装好了按回车继续"就永久挂住**（不报错，僵死）。
 *
 * 这正是"只有真人跑一次才会暴露"的那类缺陷，而注入一个假 TTY 就能稳定复现它。
 * 本文件里带 ★★ 的那两条就是它的回归。
 *
 * 设计约束：**任何一次等待超时都必须变成一条变红的断言，而不是让测试进程崩掉/挂住**
 * （这个项目吃过"假绿"的亏，也不该吃"假挂"的亏）。所以所有交互等待都过 `tryAnswer`，
 * 超时返回哨兵 `TIMEOUT`，断言自然为假。
 *
 * 诚实边界：这是**模拟 TTY**，不是真终端。它覆盖同一条代码路径，
 * 但真人终端的行为（真 raw mode、Ctrl-C、粘贴多字符、终端回显）仍建议由用户在真终端走一遍。
 *
 * 用法：node tests/unit/wizard-interaction.test.mjs
 */
import { PassThrough } from 'node:stream'
import { createWizard } from '../../bootstrap/lib/wizard.mjs'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 160)}`)
}

const TIMEOUT = Symbol('timeout')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 假的交互式 stdin：真的是个 Readable（readline 能用），只是没有真终端。 */
function fakeTty() {
  const stdin = new PassThrough()
  stdin.isTTY = true
  stdin.setRawMode = () => stdin
  return stdin
}

function fakeOut() {
  return { isTTY: false, text: '', write(s) { this.text += s } }
}

/**
 * 等待一个交互结果；超时**不抛**，返回 TIMEOUT 哨兵。
 * `text` 为 null 表示**不喂任何输入**（用来验证"它不等待输入"）。
 */
async function tryAnswer(promise, stdin, text, ms = 2000) {
  if (text !== null) {
    await sleep(10)          // 让 question 先挂上监听（真终端里人也是看到提示才打字）
    stdin.write(text)
  }
  let timer
  try {
    return await Promise.race([
      promise,
      new Promise((resolve) => { timer = setTimeout(() => { resolve(TIMEOUT) }, ms) }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

console.log('1. confirm：只有明确的 y/yes 才算同意（默认 No —— 直接回车不会误装东西）')
{
  const stdin = fakeTty(); const out = fakeOut(); const w = createWizard({ stdin, stdout: out })
  record('y → true', await tryAnswer(w.confirm('q1'), stdin, 'y\n') === true)
  record('yes → true', await tryAnswer(w.confirm('q2'), stdin, 'yes\n') === true)
  record('大写 Y → true', await tryAnswer(w.confirm('q3'), stdin, 'Y\n') === true)
  record('★ 空回车 → false（默认 No）', await tryAnswer(w.confirm('q4'), stdin, '\n') === false)
  record('n → false', await tryAnswer(w.confirm('q5'), stdin, 'n\n') === false)
  record('随便打字 → false', await tryAnswer(w.confirm('q6'), stdin, '好吧\n') === false)
  record('提示里带 [y/N]（告诉用户默认是什么）', out.text.includes('[y/N]'))
  w.close()
}

console.log('\n2. --yes：确认类问题不再询问；但"粘贴 key"不是是非题，仍会正常提问')
{
  const stdin = fakeTty(); const out = fakeOut(); const w = createWizard({ stdin, stdout: out, assumeYes: true })
  // 故意不喂输入：如果 confirm 去等 stdin，这里就会得到 TIMEOUT 而不是 true
  record('★ confirm 不喂输入也立刻 → true', await tryAnswer(w.confirm('要装吗'), stdin, null) === true)
  record('输出里标明是 --yes 生效', out.text.includes('--yes'))
  /*
   * 2026-09-13 追加：`ask()` 也必须认 `--yes`。
   *
   * 背景：安装器新增了"问你装到哪个目录"（`w.ask()`）。而 `ask()` 原来**只看 `rl`**，
   * 于是 `--apply --yes` 会**照样弹一句问句然后永久等输入** —— `--yes` 的语义被破坏，
   * 而且这正是"自动化里最糟的失败形态：不是报错，是僵住"。这里不喂输入，
   * 退回旧实现就会 TIMEOUT。
   */
  record('★ ask 在 --yes 下不喂输入也立刻回落默认值（退回旧实现 ⇒ TIMEOUT）', await tryAnswer(w.ask('装到哪', '/opt/x'), stdin, null) === '/opt/x')
  record('ask 用的默认值被打出来了（不静默决定路径）', out.text.includes('/opt/x'))
  // secret 是"要内容"的提问，不是是非题 ⇒ 仍等用户粘贴；回车表示跳过
  record('★ secret 仍是提问：回车 → 空串（跳过）', await tryAnswer(w.secret('key'), stdin, '\n') === '')
  w.close()
}

console.log('\n3. ★ 非交互环境（管道/CI）绝不许阻塞，也绝不自作主张')
{
  const stdin = new PassThrough() // 没有 isTTY ⇒ 非交互
  const out = fakeOut()
  const w = createWizard({ stdin, stdout: out })
  record('interactive=false', w.interactive === false)
  record('★ confirm 立刻返回 false（不挂）', await tryAnswer(w.confirm('q'), stdin, null) === false)
  record('★ secret 立刻返回空串（不挂）', await tryAnswer(w.secret('key'), stdin, null) === '')
  record('★ pause 立刻返回 false（不挂）', await tryAnswer(w.pause('装完了吗'), stdin, null) === false)
  record('ask 无输入时返回默认值', await tryAnswer(w.ask('目录', '/default'), stdin, null) === '/default')
  record('记下了"自动拒绝过几次"（供事后判断）', w.autoDeclined >= 1)
  record('非交互下 secret 的说明是"跳过"', out.text.includes('跳过'))
  w.close()
}

console.log('\n4. secret：读到值、不回显、退格可用')
{
  const stdin = fakeTty(); const out = fakeOut(); const w = createWizard({ stdin, stdout: out })
  const value = await tryAnswer(w.secret('粘贴 key'), stdin, 'sk-SECRETVALUE\n')
  record('读到 value（并去掉首尾空白）', value === 'sk-SECRETVALUE')
  record('★ stdout 里**没有**明文 key（不回显）', out.text.includes('sk-SECRETVALUE') === false)
  record('提示语打出来了', out.text.includes('粘贴 key'))

  const stdin2 = fakeTty(); const out2 = fakeOut(); const w2 = createWizard({ stdin: stdin2, stdout: out2 })
  const edited = await tryAnswer(w2.secret('key'), stdin2, 'sk-ABX\u007fC\n')
  record('退格删掉一个字符（X 被删）', edited === 'sk-ABC')
  w.close(); w2.close()
}

console.log('\n5. ★★ 回归：secret() 之后**还能继续提问**（原来这里会永久挂住）')
{
  const stdin = fakeTty(); const out = fakeOut(); const w = createWizard({ stdin, stdout: out })

  const key = await tryAnswer(w.secret('粘贴 key'), stdin, 'sk-AAA\n')
  record('secret 拿到了值', key === 'sk-AAA')
  record('★ secret 之后 stdin 没有被 pause 住（这就是 bug 的根因）', stdin.isPaused() === false)

  // 真实流程里的下一步：第 10 步 pause
  const paused = await tryAnswer(w.pause('装完了吗'), stdin, '\n')
  record('★★ secret 之后的 pause 能返回（退回旧写法 ⇒ 这里 TIMEOUT）', paused === true)

  // 再下一步：第 11 步里"打开侧边栏再查一次？"的 confirm
  const again = await tryAnswer(w.confirm('再查一次'), stdin, 'y\n')
  record('★★ 再后面的 confirm 也正常', again === true)
  w.close()
}

console.log('\n6. ask / pause / 输出助手')
{
  const stdin = fakeTty(); const out = fakeOut(); const w = createWizard({ stdin, stdout: out })
  record('ask 读到输入', await tryAnswer(w.ask('装到哪'), stdin, '/tmp/x\n') === '/tmp/x')
  record('ask 空输入回落默认值', await tryAnswer(w.ask('装到哪', '/def'), stdin, '\n') === '/def')
  record('pause 回车 → true', await tryAnswer(w.pause('好了吗'), stdin, '\n') === true)

  w.step(3, '下载依赖')
  w.detail('   将写入 /a/b')
  w.warn('小心')
  record('step 打印步号与标题', out.text.includes('第 3 步') && out.text.includes('下载依赖'))
  record('warn 带警告符', out.text.includes('⚠️'))
  w.close()
}

console.log('\n7. close() 之后不抛（收尾要干净）')
{
  const stdin = fakeTty(); const out = fakeOut(); const w = createWizard({ stdin, stdout: out })
  let threw = false
  try { w.close(); w.close() } catch { threw = true }
  record('重复 close 不抛异常', threw === false)
  const w2 = createWizard({ stdin: new PassThrough(), stdout: fakeOut() })
  let threw2 = false
  try { w2.close() } catch { threw2 = true }
  record('非交互 wizard 的 close 也不抛', threw2 === false)
}

console.log('\n8. ★ stdin 被关掉（Ctrl-D / EOF）不许崩，也不许挂')
{
  /*
   * 2026-09-13 用 pty 实测发现的真缺陷：安装器新增"问你装到哪个目录"之后，
   * 两个问句之间喂 EOF（用户按 Ctrl-D）会崩在 `rl.question()` 上：
   *   Error [ERR_USE_AFTER_CLOSE]: readline was closed
   * 所以这里三条都试：**提问中**被关（promise 可能永不 settle ⇒ 挂）、
   * 关掉之后再问（同步抛）。退回旧实现，前两条会 TIMEOUT、第三条会抛。
   */
  const settle = (p) => Promise.race([p, new Promise((resolve) => { setTimeout(() => { resolve(TIMEOUT) }, 2000) })])

  const s1 = fakeTty(); const o1 = fakeOut(); const w1 = createWizard({ stdin: s1, stdout: o1 })
  const p1 = w1.confirm('要装吗')
  await sleep(10); s1.end()                     // 提问进行中，用户按了 Ctrl-D
  record('★ 提问中被关：confirm → false（不抛、不挂）', await settle(p1) === false)
  record('并说明原因（不是静默改主意）', o1.text.includes('输入已关闭'))

  const s2 = fakeTty(); const o2 = fakeOut(); const w2 = createWizard({ stdin: s2, stdout: o2 })
  const p2 = w2.ask('装到哪', '/def')
  await sleep(10); s2.end()
  record('★ 提问中被关：ask → 默认值', await settle(p2) === '/def')

  const s3 = fakeTty(); const o3 = fakeOut(); const w3 = createWizard({ stdin: s3, stdout: o3 })
  s3.end(); await sleep(10)                     // 先关掉，**再**提问
  record('★ 已关掉后再问：confirm → false（旧实现这里同步抛 ERR_USE_AFTER_CLOSE）', await settle(w3.confirm('要装吗')) === false)
  record('已关掉后再问：ask → 默认值', await settle(w3.ask('装到哪', '/def')) === '/def')

  const s4 = fakeTty(); const o4 = fakeOut(); const w4 = createWizard({ stdin: s4, stdout: o4 })
  const p4 = w4.pause('好了吗')
  await sleep(10); s4.end()
  record('★ 提问中被关：pause → false（不再等）', await settle(p4) === false)
  /*
   * ★ 2026-09-13 追加（PiMoa 片 B 第 15 条）：`secret()` 的 EOF 守卫是本批当 BLOCKER 修的，
   * 但上面三组只覆盖了 `confirm` / `ask` / `pause` ⇒ `secret()` **零回归保护**。
   * 补两条：已关掉后再问、提问中被关 —— 两种都必须立刻返回空串。
   * 退回旧实现（只看构造时的 `interactive`）⇒ 这里 TIMEOUT。
   */
  const s5 = fakeTty(); const o5 = fakeOut(); const w5 = createWizard({ stdin: s5, stdout: o5 })
  s5.end(); await sleep(10)
  record('★ 已关掉后再问：secret → 空串（退回旧实现 ⇒ 这里超时）', await settle(w5.secret('key')) === '')
  const s6 = fakeTty(); const o6 = fakeOut(); const w6 = createWizard({ stdin: s6, stdout: o6 })
  const p6 = w6.secret('key')
  await sleep(10); s6.end()
  record('★ 提问中被关：secret → 空串（不挂、不崩）', await settle(p6) === '')
  for (const w of [w1, w2, w3, w4, w5, w6]) w.close()
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
