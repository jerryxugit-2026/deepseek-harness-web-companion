#!/usr/bin/env node
/**
 * Consistency gate: 评审条目 → 正文 的自动对齐检查。
 *
 * 由来：PiMoa 对抗审核（docs/reviews/pimoa-adversarial-v3.1.md）指出一个复发模式——
 * "修的是被点出的那句话，而不是那句话所在的契约面"。因此把历次审核点出的**旧值/旧命名/
 * 旧说法**固化为可执行的黑名单：正文里只要再次出现，CI/交付前检查即失败。
 *
 * 用法：node scripts/consistency-check.mjs            # 检查并打印命中
 *      node scripts/consistency-check.mjs --list     # 只打印规则表
 *
 * 维护约定：每次评审新增"已废弃说法"时，往 RULES 里加一条（含 reason 与出处）。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

/**
 * @typedef {object} Rule
 * @property {string} id
 * @property {RegExp} pattern
 * @property {string} reason 为什么禁止（对应哪条评审项）
 * @property {string[]} [skip] 允许出现的历史/审计类文件（相对路径前缀）
 * @property {string[]} [only] 仅在这些文件里检查
 * @property {RegExp} [allowIf] 行内命中该模式时豁免（用于「旧名已废弃」这类正当引用）
 */

/** 历史与审计文件允许保留旧说法（它们记录"当时是什么样"）。 */
const HISTORY = ['FINDINGS.md', 'docs/CHANGELOG.md', 'docs/REVIEW-', 'docs/reviews/', 'docs/research/']
/**
 * 反例向量故意包含被禁的值（例如 `image/webp`、未知错误码）——它们的用途正是
 * 证明 schema 会拒绝这些输入，因此不参与"废弃说法"扫描。
 */
const NEGATIVE_VECTORS = 'protocol/vectors/invalid/'
/** 生成物：内容完全来自其它文档，检查源文档即可。 */
const GENERATED = ['docs/DOC-GRAPH.md', 'docs/doc-graph.json']
/** 正当的"已废弃/已否决"叙述。 */
const NEGATED = /废弃|否决|不再|禁止|旧名|已改|历史|改为|修正|误读|高估|证伪|订正/u

/** @type {Rule[]} */
const RULES = [
  {
    id: 'stale-iframe-sandbox',
    pattern: /sandbox="allow-scripts/u,
    reason: 'A1：iframe 加 sandbox 会偏离全部实测条件（无 sandbox 下取得），且 allow-scripts+allow-same-origin 下安全收益为零',
    skip: HISTORY,
  },
  {
    id: 'stale-capture-format',
    pattern: /image\/webp/u,
    reason: 'A3：chrome.tabs.captureVisibleTab 的 format 仅 jpeg|png，不支持 webp',
    skip: HISTORY,
  },
  {
    id: 'stale-protocol-version',
    pattern: /"protocolVersion"\s*:\s*(?!1\b)\d+/u,
    reason: 'A8：协议版本固定为 1（文档版本号不得当协议版本）',
    skip: HISTORY,
  },
  {
    id: 'stale-intent-sniff-location',
    pattern: /intent-sniff/u,
    reason: 'A4/ADR-11：「看左边」嗅探点必须在 DSH client 插件内，扩展端读不到跨域 iframe 的输入框',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'stale-plugin-name',
    pattern: /dsh-antigravity-bridge|dsh-chrome-bridge/u,
    reason: 'B9：插件包名统一为 dsh-web-companion-bridge',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'stale-native-host-name',
    pattern: /com\.antigravity\.web_companion/u,
    reason: 'B9：native host 名统一为 com.dsh.web_companion',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'stale-pairing-file',
    pattern: /antigravity-companion\.json/u,
    reason: 'B9：配对文件统一为 $DSH_HOME/dsh-web-companion.json',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'stale-route-prefix',
    pattern: /['"`]\/ext\//u,
    reason: 'B9：路由前缀统一为 /ag/*',
    skip: HISTORY,
  },
  {
    id: 'overstated-zero-memory',
    pattern: /0 额外内存|零额外内存/u,
    reason: 'PiMoa MINOR：iframe 内是完整 DSH SPA，内存必然增长；G6 只承诺"0 新增常驻进程 + 体积 ≤1MB"',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'overstated-caption-promise',
    pattern: /自动提取全部字幕|提取全部字幕/u,
    reason: 'A10/ADR-6：字幕为 best-effort（覆盖矩阵见 §12.2），不得承诺"全部"',
    skip: [...HISTORY, 'scripts/review-prompts/'],
    allowIf: NEGATED,
  },
  {
    id: 'overstated-zero-client-code',
    pattern: /0 开发成本|零开发成本|0 客户端代码/u,
    reason: 'PiMoa 高估点：复用的是视觉层，桥接逻辑仍需自写 client 插件（§0.3）',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'stale-injection-script-mechanism',
    pattern: /Web 注入脚本/u,
    reason: 'A6：DSH client 插件是 CJS 闭包工厂 bundle（exports["./client"] + /plugins/??），不是注入脚本',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'reviewer-typo',
    pattern: /PiMoi/u,
    reason: 'MINOR：审核方名称应为 PiMoa',
    skip: HISTORY,
  },
  {
    id: 'validateas-value-misuse',
    pattern: /validated\.value|validateAs\([^)]*\)\.value/u,
    reason: '实测缺陷：生成的 validateAs 只在失败时给 error，成功时返回 { ok: true } —— 读 `.value` 得到 undefined；「看左边」链路因此整条静默失效（v3.23 修复）',
    skip: HISTORY,
    // 正当引用：缺陷复盘/契约说明里必须能点名这个写法
    allowIf: NEGATED,
  },
  {
    id: 'pending-decision-lingering',
    pattern: /待拍板|待你拍板/u,
    reason: 'BLOCKER-5：H4 已决（默认①）；悬空的双态表述禁止出现',
    only: ['详细设计文档.md'],
  },
  {
    id: 'stale-single-write-claim',
    pattern: /唯一整段写入|整段写入入口/u,
    reason: 'v3.4 亲验证伪：真实签名为 setDraft(text, editRange?)，存在区间写入能力（contract.ts:104）',
    skip: HISTORY,
    allowIf: NEGATED,
  },
  {
    id: 'bare-auth-restatement',
    pattern: /key \+ Origin|key \+ 精确 Origin/u,
    reason: 'BLOCKER-A：鉴权规则只在 §5.4 定义（F1–F4）；别处必须引用编号，禁止重述"key + Origin"（v3.2 的 §5.1 端点表残留即由此而来）',
    skip: HISTORY,
    allowIf: /§5\.4|F[1-4]\b|形态编号/u,
  },
  {
    id: 'three-form-auth-matrix',
    pattern: /三形态鉴权矩阵/u,
    reason: 'BLOCKER-1：鉴权矩阵必须为四形态（含 client 插件同源），三形态会把 /ag/client 判 403',
    skip: HISTORY,
  },
]

const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.devhome', '.codegraph', 'out', 'dist'])

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const files = walk(ROOT)
  .filter((f) => /\.(md|mjs|js|ts|tsx|json|sh)$/u.test(f) && !f.endsWith('package-lock.json'))
  .filter((f) => !GENERATED.includes(relative(ROOT, f).split('\\').join('/')))
  .filter((f) => relative(ROOT, f) !== 'scripts/consistency-check.mjs') // 规则表本身含这些字面量
  .map((f) => relative(ROOT, f).split('\\').join('/'))
  .sort()

if (process.argv.includes('--list')) {
  for (const rule of RULES) console.log(`${rule.id}\n  pattern: ${String(rule.pattern)}\n  reason:  ${rule.reason}`)
  process.exit(0)
}

const skipped = (rule, file) =>
  file.startsWith(NEGATIVE_VECTORS) ||
  (rule.only !== undefined && !rule.only.includes(file)) ||
  (rule.skip ?? []).some((prefix) => file.startsWith(prefix) || file.includes(prefix))

const hits = []
for (const file of files) {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const lines = text.split('\n')
  for (const rule of RULES) {
    if (skipped(rule, file)) continue
    lines.forEach((line, index) => {
      if (rule.pattern.test(line) && !(rule.allowIf !== undefined && rule.allowIf.test(line))) hits.push({ rule: rule.id, file, line: index + 1, text: line.trim().slice(0, 120), reason: rule.reason })
    })
  }
}

if (hits.length === 0) {
  console.log(`consistency: OK（${String(RULES.length)} 条规则 / ${String(files.length)} 个文件，无废弃说法残留）`)
  process.exit(0)
}

console.error(`consistency: 发现 ${String(hits.length)} 处废弃说法残留——这正是 PiMoa 指出的复发模式，必须逐条清掉：\n`)
for (const hit of hits) {
  console.error(`  [${hit.rule}] ${hit.file}:${String(hit.line)}`)
  console.error(`      ${hit.text}`)
  console.error(`      原因：${hit.reason}`)
}
process.exit(1)
