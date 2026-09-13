#!/usr/bin/env node
/**
 * 门禁：**仓库根不许出现探针产物**（尤其是抓取目录 `网页捕获/`）。
 *
 * 为什么需要它（真事故，2026-09-12）：`scripts/probe-all.mjs` 曾经用 `cwd: <仓库根>` 拉起测试 DSH，
 * 于是面板 iframe 里那个 DSH 会话的工作目录就是仓库根、它向插件 announce 的 `workspace` 也是仓库根 ——
 * 凡是不显式钉 `target.workspace` 的抓取就落到 `<仓库根>/网页捕获/`：被 git 看见（提交时会混进来），
 * 还被 `scripts/doc-graph.mjs` 当成一份"文档"统计（探针跑完文档数会莫名 +1）。
 *
 * 那次的根因已在 `scripts/probe-all.mjs` 修掉（cwd 改成测试工作区），但"修好了"和"不会再犯"是两件事：
 * 任何新探针/新脚本只要再犯一次，这个门禁就会在 `npm run check` 里当场拦下。
 *
 * 判定很窄、故意窄：**只看仓库根这一层**，只认两种形态 ——
 *   ① 目录 `网页捕获/`（插件默认抓取落盘目录名）
 *   ② 仓库根下直接躺着 `yyyy-MM-dd-HHmm-*.md`（抓取文件命名形态，见 dsh-plugin/src/host/retention.js#CAPTURE_FILE）
 * 仓库里**正当**的 md 不会长这样（README.md / FINDINGS.md / 详细设计文档.md …），所以零误报。
 *
 * 用法：node scripts/check-repo-root.mjs     （退出码：0 = 干净，1 = 发现探针产物）
 */
import { readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/** 抓取文件命名形态，与 `dsh-plugin/src/host/retention.js#CAPTURE_FILE` 保持一致。 */
const CAPTURE_FILE = /^\d{4}-\d{2}-\d{2}-\d{4}-.*\.md$/u
/** 抓取落盘目录名（插件默认值 `config.attachDir`）。 */
const CAPTURE_DIR = '网页捕获'

const offenders = []
for (const entry of readdirSync(ROOT)) {
  if (entry === CAPTURE_DIR) {
    const full = join(ROOT, entry)
    if (statSync(full).isDirectory()) {
      const files = readdirSync(full).slice(0, 5)
      offenders.push({ kind: 'capture-dir', path: full, sample: files })
    }
    continue
  }
  if (entry === 'node_modules' || entry === '.git') continue
  if (CAPTURE_FILE.test(entry)) offenders.push({ kind: 'capture-file', path: join(ROOT, entry), sample: [] })
}

if (offenders.length === 0) {
  console.log(`repo-root: OK（仓库根没有探针产物；${String(readdirSync(ROOT).length)} 个条目已检查）`)
  process.exit(0)
}

console.error('repo-root: ✗ 仓库根出现探针产物 —— 抓取被写进了**仓库**，不是测试工作区。')
for (const offender of offenders) {
  console.error(`  - ${offender.kind}: ${offender.path}${offender.sample.length === 0 ? '' : `（内含 ${offender.sample.join('、')}…）`}`)
}
console.error(
  '\n怎么修：\n' +
  '  1) 把产物移出仓库（确认是探针产物后删除或移到 /tmp）；\n' +
  '  2) 找根因 —— 谁在写这里？常见两类：\n' +
  '     · 探针直接 POST /ag/attach 却**没有** `target.workspace` ⇒ 补上（参考 tests/m0b/attach-probe.mjs）；\n' +
  '     · 探针驱动的是**面板里的 DSH GUI**（点按钮抓取）⇒ 抓取目标由该会话 announce 的 workspace 决定，\n' +
  '       而它等于 **拉起测试 DSH 时的 cwd** ⇒ 检查 scripts/probe-all.mjs 的 spawn `cwd` 是否仍是测试工作区。\n' +
  '  详见 /Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md 避坑清单第 9 条。',
)
process.exit(1)
