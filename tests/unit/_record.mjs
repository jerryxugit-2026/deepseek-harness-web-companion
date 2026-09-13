/**
 * 断言记录器 —— 共享版（2026-09-13 起**新写的**测试用它）。
 *
 * 背景：33 个既有单测各自复制了同一段 `record`。我曾尝试一次性把 33 个文件都改成 import 这个模块，
 * **两次都切坏了文件**（import 插进多行 import 块中间；闭括号匹配到别处致 11 个文件语法错），
 * 于是全部回退 —— 结论：**纯重复代码不是缺陷，错误地批量改 33 个文件的风险远大于收益**
 * （见 docs/CHANGELOG.md v3.47 §4 与 docs/11-台账.md §5 第 18 项）。
 *
 * 所以改成**增量**：新测试用这个共享模块，既有文件保持原样；谁将来改到哪个文件，顺手迁一个。
 *
 * 用法：import { createRecorder } from './_record.mjs'
 *       const { results, record, finish } = createRecorder()
 */
export function createRecorder() {
  const results = {}
  const record = (name, value) => {
    if (Object.hasOwn(results, name)) {
      throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`)
    }
    results[name] = value
    console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 170)}`)
  }
  const finish = () => {
    const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
    console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
    process.exitCode = failed.length === 0 ? 0 : 1
  }
  return { results, record, finish }
}
