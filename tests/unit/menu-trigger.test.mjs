#!/usr/bin/env node
/**
 * 右键菜单 → /ag/attach 的 trigger 契约单测。
 *
 * 由来（2026-09-12 实测抓到的真缺陷）：`handleMenuClick` 一直发 `trigger: 'contextmenu'`，
 * 而 `AttachRequest.trigger` 的枚举是 `look_left | button | shortcut | manual` —— 这个值
 * **不在枚举里**，于是每次右键抓取都在 host 的 `validateAs('AttachRequest')`
 * （`dsh-plugin/src/host/routes/attach.js:41`）被 400 挡掉，一个文件都不会落盘。
 * 菜单看起来接好了，实际是哑的；台账 §3 还把它记成「已有」。
 *
 * 这条断言的作用：把"扩展发出去的 trigger"直接喂给**同一个生成校验器**，
 * 值一旦偏离 schema 立刻红 —— 而不是等真站点上右键一次才发现。
 *
 * 用法：node tests/unit/menu-trigger.test.mjs
 */
import { handleMenuClick, MENU_PAGE, MENU_SELECTION } from '../../extension/src/sw/menu.js'
import { validateAs } from '../../dsh-plugin/src/shared/protocol.generated.js'

const results = {}
const record = (name, value) => {
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 140)}`)
}

/** Build the AttachRequest body the SW would POST, from one menu click. */
const bodyFor = (menuItemId) => {
  const captured = []
  const opened = []
  let trigger
  // handleMenuClick is async and calls `capture` synchronously; capture what it sends.
  const done = handleMenuClick(
    { menuItemId, tab: { windowId: 7 } },
    (request) => { captured.push(request); trigger = request.trigger; return Promise.resolve({ ok: true }) },
    (windowId) => { opened.push(windowId); return Promise.resolve() },
  )
  return { done, captured, opened, trigger: () => trigger }
}

console.log('1. 菜单点出来的 trigger 必须过 AttachRequest 的 schema（这就是那个真缺陷）')
{
  const { done, trigger } = bodyFor(MENU_PAGE)
  await done
  const value = trigger()
  record(`发出的 trigger = ${JSON.stringify(value)}（不是 'contextmenu'）`, value !== 'contextmenu')
  const validated = validateAs('AttachRequest', {
    protocolVersion: 1,
    captureId: 'cap-unit-menu',
    trigger: value,
    page: { title: 't', url: 'https://example.invalid/', domain: 'example.invalid', capturedAt: Date.now() },
    content: { markdown: 'hello', truncated: false },
  })
  record('同一个生成校验器认可它（validateAs ok）', validated.ok === true)
  if (validated.ok !== true) console.log(`     校验器说：${JSON.stringify(validated.error).slice(0, 200)}`)
}

console.log('\n2. 两个菜单项各自的抓取 mode')
{
  const page = bodyFor(MENU_PAGE)
  await page.done
  record('「Ask DSH about this page」→ mode=page', page.captured[0]?.mode === 'page')
  const selection = bodyFor(MENU_SELECTION)
  await selection.done
  record('「Ask DSH about selection」→ mode=selection', selection.captured[0]?.mode === 'selection')
}

console.log('\n3. 面板必须先打开（右键手势是唯一可靠的开面板时机），且只发一次抓取')
{
  const run = bodyFor(MENU_PAGE)
  await run.done
  record('先开面板（windowId 透传）', run.opened.length === 1 && run.opened[0] === 7)
  record('只发出一次 capture', run.captured.length === 1)
}

console.log('\n4. 防御性：窗口 id 缺失时也不崩（菜单可能在无 windowId 的上下文触发）')
{
  const captured = []
  await handleMenuClick({ menuItemId: MENU_PAGE }, (request) => { captured.push(request); return Promise.resolve() }, () => Promise.resolve())
  record('无 tab/windowId 时仍发出抓取', captured.length === 1)
}

// 只有布尔 true 算通过：任何没记上的都算失败（原来记成 null/对象会静默通过）
const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
