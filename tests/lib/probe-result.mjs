/**
 * 探针结果收集：**把"假绿"从结构上堵掉**（单一真源）。
 *
 * 由来（2026-09-12，PiMoa 审核 + 我逐条核实）：这套 m0a–m3 探针里，出问题最多的一处不是产品
 * 代码，而是**判定本身**：
 *
 *   - 探针用 `record(name, value)` 同时记录**断言**与**观测数据**（`record('chipState', chip)`
 *     传的是对象），而结束时的失败过滤写成 `filter(([, v]) => v === false)` ——
 *     于是任何**非布尔**记录（`null`、对象、字符串）都**静默算通过**；
 *   - 有 8 个探针（capture / gate / autostart / chip / attach / agent-turn / perf / native-headed）
 *     要么根本不算失败集，要么算了却仍 `process.exit(0)` ⇒ **结构上不可能变红**；
 *   - `capture-probe` 还有一条 `activeChips.every(...)`，空数组恒真。
 *
 * 现在规则只有一条，而且写在这里：**只有布尔 `true` 算通过**。非布尔值一律进"观测"桶，
 * 不参与判定（但它们照旧打进报告，便于人读）。这样"记了个 `null` 就当过"不可能再发生。
 *
 * 用法（每个探针三行）：
 *   import { createResults } from '../lib/probe-result.mjs'
 *   const { record, observe, results, finish } = createResults()
 *   ...
 *   finish()            // 打印汇总并把退出码设成 0/1
 */

/**
 * @param {{ label?: string }} [options]
 * @returns {{ record: Function, observe: Function, results: object, observations: object, failed: Function, finish: Function }}
 */
export function createResults(options = {}) {
  const label = options.label ?? 'probe'
  /** 断言：只收布尔。 */
  const results = {}
  /** 观测：非布尔数据（对象/数组/字符串/数字），永不计通过。 */
  const observations = {}

  const print = (mark, name, value) => {
    const shown = JSON.stringify(value) ?? String(value)
    console.log(`  ${mark} ${name}: ${String(shown).slice(0, 260)}`)
  }

  const record = (name, value) => {
    if (typeof value === 'boolean') {
      results[name] = value
      print(value ? '✅' : '❌', name, value)
      return value
    }
    // 传了非布尔值：这不是断言。当作观测留住，并**不计入通过**。
    observations[name] = value
    print('·', `${name}（观测，不计通过）`, value)
    return value
  }

  const observe = (name, value) => {
    observations[name] = value
    print('·', name, value)
    return value
  }

  /** 未通过 = 不是布尔 true（含 false 与任何"没记上"）。 */
  const failed = () => Object.entries(results).filter(([, value]) => value !== true).map(([name]) => name)

  /**
   * 打印汇总并设置退出码。
   * @param {string} [file] 报告文件名（可选，仅用于提示）
   */
  const finish = (file) => {
    const bad = failed()
    const total = Object.keys(results).length
    if (file !== undefined) console.log(`\n写入 ${file}`)
    console.log(`\n${bad.length === 0 ? `✅ ${label} 全部通过` : `❌ ${label} 失败 ${String(bad.length)}/${String(total)} 项：${bad.join('、')}`}（断言 ${String(total)} 条，观测 ${String(Object.keys(observations).length)} 条）`)
    process.exitCode = bad.length === 0 ? 0 : 1
    return bad
  }

  return { record, observe, results, observations, failed, finish }
}
