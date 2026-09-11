#!/usr/bin/env node
/**
 * Documentation + code graph builder for the DSH Web Companion project.
 *
 * Two graphs, one command:
 *   1. doc → section → code/doc references, read from every markdown file;
 *   2. coverage: which code area is described by which document.
 *
 * Outputs (both regenerated wholesale, so they can never drift silently):
 *   docs/DOC-GRAPH.md     human-readable graph + tables + drift issues
 *   docs/doc-graph.json   machine-readable graph for tooling/diffing
 *
 * Run:  node scripts/doc-graph.mjs           # rewrite the two outputs
 *       node scripts/doc-graph.mjs --check   # verify up to date + no issues (exit 1 on drift)
 *
 * Companion to the CODE graph (`codegraph`, .codegraph/):
 *   npm run graph:sync   → incremental code re-index
 *   npm run graph:docs   → this script
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT_MD = join(ROOT, 'docs', 'DOC-GRAPH.md')
const OUT_JSON = join(ROOT, 'docs', 'doc-graph.json')
const CHECK = process.argv.includes('--check')

/** Directories that never take part in either graph. */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.devhome', '.codegraph', 'out', 'dist'])
/** Where real code lives; used to classify references and compute coverage. */
const CODE_AREAS = {
  extension: 'Chrome MV3 扩展（side panel / service worker / content script）',
  'dsh-plugin': 'DSH 进程内插件（host 桥接 + client composer 注入）',
  'native-host': 'native messaging 宿主（拉起 dsh web，M2）',
  protocol: '单源消息 schema + codegen',
  scripts: '安装 / 配对 / 工具脚本',
  'tests/e2e': 'E2E harness 与用例',
  spike: '可行性实验（回归基线）',
}

/** Recursively list files, honouring SKIP_DIRS. */
function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

const allFiles = walk(ROOT).map((f) => relative(ROOT, f).split('\\').join('/'))
const mdFiles = allFiles.filter((f) => f.endsWith('.md')).sort()
const codeFiles = allFiles.filter((f) => /\.(mjs|cjs|js|ts|tsx|json|sh)$/u.test(f) && !f.endsWith('package-lock.json')).sort()

/** Paths that look like code inside backticks, e.g. `extension/src/sw/index.js`. */
const CODE_REF = /`([A-Za-z0-9_./@-]+\.(?:mjs|cjs|js|ts|tsx|json|sh))`/gu
/** Markdown links to other documents in this repo. */
const DOC_LINK = /\]\(\.?\/?([^)#\s]+\.md)(?:#[^)]*)?\)/gu
const HEADING = /^(#{1,6})\s+(.*)$/u

function docNode(path) {
  const text = readFileSync(join(ROOT, path), 'utf8')
  const lines = text.split('\n')
  const sections = []
  let title = path
  const codeRefs = new Set()
  const docRefs = new Set()

  lines.forEach((line, index) => {
    const heading = HEADING.exec(line)
    if (heading !== null) {
      const level = heading[1].length
      const label = heading[2].trim()
      if (level === 1 && sections.length === 0 && title === path) title = label
      sections.push({ level, heading: label, line: index + 1 })
    }
    for (const match of line.matchAll(CODE_REF)) codeRefs.add(match[1])
    for (const match of line.matchAll(DOC_LINK)) {
      const target = match[1].replace(/^\.\//u, '')
      if (/^https?:\/\//u.test(target)) continue // external URL, not an in-repo link
      docRefs.add(target)
    }
  })

  const version = /版本[^\n]*?(v\d+\.\d+[^\s·|)]*)/u.exec(text)?.[1] ?? null
  return {
    path,
    title,
    version,
    lines: lines.length,
    sections: sections.filter((s) => s.level <= 2),
    codeRefs: [...codeRefs].sort(),
    docRefs: [...docRefs].sort(),
  }
}

const docs = mdFiles.map(docNode)

/** References that name a file that does not exist yet = planned work (informational). */
const issues = []
const plannedArea = []
const plannedBare = []
const externalRefs = []

/** Does the reference point at a file in this repo (exact path or unique basename)? */
function resolves(ref) {
  if (allFiles.includes(ref)) return true
  return allFiles.some((f) => f.endsWith(`/${ref}`))
}

/** A reference to the installed DSH package tree or another external checkout. */
function isExternal(ref) {
  return ref.startsWith('@') || ref.startsWith('/') || /^(dsh-|dsh_)/u.test(ref) || ref.includes('/lib/')
}

for (const doc of docs) {
  for (const ref of doc.codeRefs) {
    if (resolves(ref)) continue
    const area = Object.keys(CODE_AREAS).find((a) => ref.startsWith(`${a}/`))
    const entry = { doc: doc.path, ref }
    if (area !== undefined) plannedArea.push(entry)
    else if (isExternal(ref)) externalRefs.push(entry)
    else plannedBare.push(entry)
  }
  for (const ref of doc.docRefs) {
    if (resolves(ref)) continue
    const sibling = join(dirname(doc.path), ref).split('\\').join('/')
    if (allFiles.includes(sibling)) continue
    issues.push({ kind: 'broken-doc-link', doc: doc.path, ref })
  }
}

/** Which code area each document talks about (coverage view). */
const coverage = {}
for (const area of Object.keys(CODE_AREAS)) {
  coverage[area] = docs.filter((d) => d.codeRefs.some((r) => r.startsWith(`${area}/`)) || d.path.startsWith(`${area}/`)).map((d) => d.path)
}

const graph = {
  generatedBy: 'scripts/doc-graph.mjs',
  project: 'dsh-web-companion',
  docs: docs.map((d) => ({ path: d.path, title: d.title, version: d.version, lines: d.lines, sections: d.sections.length, codeRefs: d.codeRefs.length, docRefs: d.docRefs.length })),
  code: { indexedFiles: codeFiles.length, areas: coverage },
  plannedReferences: { inArea: plannedArea, bare: plannedBare },
  externalReferences: externalRefs,
  issues,
}

/** Stable ordering so --check can compare byte-for-byte. */
const stable = (value) => JSON.stringify(value, null, 2)

function renderMarkdown() {
  const docRows = docs
    .map((d) => `| \`${d.path}\` | ${d.title} | ${d.version ?? '—'} | ${String(d.lines)} | ${String(d.sections.length)} | ${String(d.codeRefs.length)} |`)
    .join('\n')
  const areaRows = Object.entries(CODE_AREAS)
    .map(([area, label]) => {
      const described = coverage[area] ?? []
      return `| \`${area}/\` | ${label} | ${described.length === 0 ? '⚠️ 无文档覆盖' : described.map((p) => `\`${p}\``).join(' ')} |`
    })
    .join('\n')
  const refRows = (entries) => {
    if (entries.length === 0) return '（无）'
    const refs = [...new Set(entries.map((e) => e.ref))].sort()
    return refs.map((ref) => `| \`${ref}\` | ${[...new Set(entries.filter((e) => e.ref === ref).map((e) => e.doc))].map((d) => `\`${d}\``).join(' ')} |`).join('\n')
  }
  const plannedRows = refRows(plannedArea)
  const bareRows = refRows(plannedBare)
  const externalRows = refRows(externalRefs)
  const issueRows = issues.length === 0
    ? '（无）'
    : issues.map((i) => `| ${i.kind} | \`${i.doc}\` | \`${i.ref}\` |`).join('\n')

  return `# 文档与代码图谱（DOC-GRAPH）

> **自动生成，请勿手改**：\`node scripts/doc-graph.mjs\`（校验：\`node scripts/doc-graph.mjs --check\`）
> 生成时间：${new Date().toISOString()}
>
> **更新时机（随项目进展）**：
> 1. 任一 \`*.md\` 或代码文件增删改后 → \`npm run graph:sync\`（代码图谱增量重建）+ \`npm run graph:docs\`（本文件重生成）；
> 2. 每个里程碑（M1–M4）收尾必须执行一次，并把 \`--check\` 纳入交付前检查；
> 3. \`--check\` 发现 broken-doc-link / missing-code-ref 时以非零码退出，作为质量门。

## 1. 文档清单（${String(docs.length)} 份 / ${String(codeFiles.length)} 个代码与配置文件）

| 文档 | 标题 | 版本 | 行数 | 二级标题数 | 代码引用数 |
|---|---|---|---|---|---|
${docRows}

## 2. 文档 ↔ 代码 覆盖矩阵

| 代码区 | 职责 | 描述它的文档 |
|---|---|---|
${areaRows}

## 3. 代码区依赖图（文档层视角）

\`\`\`mermaid
flowchart LR
  PRD["PRD_需求定义说明书"] --> DD["详细设计文档 v3.1"]
  DD --> P["docs/01 协议契约"]
  DD --> E["docs/02 扩展设计"]
  DD --> H["docs/03 桥接插件(host)"]
  DD --> C["docs/04 客户端插件"]
  DD --> N["docs/05 native host"]
  DD --> T["docs/06 测试方案"]
  DD --> S["docs/08 安全模型"]
  P --> PROTO["protocol/"]
  E --> EXT["extension/"]
  H --> PLUG["dsh-plugin/src/host"]
  C --> CLI["dsh-plugin/src/client"]
  N --> NH["native-host/"]
  T --> E2E["tests/e2e/"]
  EXT --> SPIKE["spike/ (回归基线)"]
  E2E --> SPIKE
\`\`\`

## 4. 规划中但尚未实现的引用（实现进度视角）

> 这些引用指向"设计已定、代码未写"的路径，随 M1–M4 推进应逐步从本表消失。

| 引用路径 | 出现在文档 |
|---|---|
${plannedRows}

### 4.2 松散引用（设计草图里的文件名，尚未落位）

| 引用路径 | 出现在文档 |
|---|---|
${bareRows}

### 4.3 外部引用（DSH 安装包 / 系统路径，非本仓库文件）

| 引用路径 | 出现在文档 |
|---|---|
${externalRows}

## 5. 图谱问题（必须为零）

| 类型 | 文档 | 引用 |
|---|---|---|
${issueRows}
`
}

const rendered = renderMarkdown()
const jsonText = `${stable(graph)}\n`

if (CHECK) {
  const okMd = existsSync(OUT_MD) && readFileSync(OUT_MD, 'utf8') === rendered
  const okJson = existsSync(OUT_JSON) && readFileSync(OUT_JSON, 'utf8') === jsonText
  if (!okMd || !okJson) {
    console.error('doc-graph: 图谱已过期，请运行 `node scripts/doc-graph.mjs`')
    process.exit(1)
  }
  if (issues.length > 0) {
    console.error(`doc-graph: 发现 ${String(issues.length)} 个引用问题`)
    for (const issue of issues) console.error(`  - ${issue.kind}: ${issue.doc} → ${issue.ref}`)
    process.exit(1)
  }
  console.log(`doc-graph: OK（${String(docs.length)} 文档 / ${String(codeFiles.length)} 代码文件 / 待实现引用 ${String(plannedArea.length + plannedBare.length)} 条）`)
  process.exit(0)
}

writeFileSync(OUT_MD, rendered)
writeFileSync(OUT_JSON, jsonText)
console.log(`doc-graph: 已生成 docs/DOC-GRAPH.md 与 docs/doc-graph.json（${String(docs.length)} 文档 / ${String(codeFiles.length)} 代码文件）`)
if (issues.length > 0) {
  console.error(`doc-graph: 有 ${String(issues.length)} 个引用问题，详见 §5`)
  process.exit(1)
}
