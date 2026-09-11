#!/usr/bin/env node
/**
 * Extension build + size report (M1 ③ / G6 「扩展 ≤1MB」的可证伪依据).
 *
 * Bundles the MV3 entry points with esbuild, copies the static shell, and
 * prints a per-file size report plus the totals that the acceptance criteria
 * are stated against. `--report-only` re-prints the report without rebuilding.
 *
 * Output: extension/dist/ (what you load unpacked) + docs/reviews/build-size.json
 */
import { build } from 'esbuild'
import { cpSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST = join(HERE, 'dist')
const REPORT_ONLY = process.argv.includes('--report-only')

/** Entry points and the files that ship verbatim. */
const ENTRIES = {
  'src/sw/index.js': 'sw.js',
  'src/sidepanel/panel.js': 'panel.js',
  'src/content/content.js': 'content.js',
}
const STATIC = ['manifest.json', 'src/sidepanel/panel.html', 'src/sidepanel/panel.css']

/** Bytes of every file under `dir`, recursively. */
function walkSizes(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const info = statSync(full)
    if (info.isDirectory()) out.push(...walkSizes(full))
    else out.push({ path: relative(DIST, full), bytes: info.size })
  }
  return out
}

if (!REPORT_ONLY) {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })
  const entryPoints = Object.keys(ENTRIES).filter((rel) => existsSync(join(HERE, rel)))
  const result = await build({
    entryPoints: entryPoints.map((rel) => join(HERE, rel)),
    outdir: DIST,
    entryNames: '[name]',
    bundle: true,
    format: 'esm',
    target: 'chrome116',
    platform: 'browser',
    sourcemap: false,
    minify: false,
    legalComments: 'none',
    metafile: true,
    logLevel: 'warning',
  })
  // entryNames '[name]' loses the directory, so move each bundle to its slot
  for (const [rel, outName] of Object.entries(ENTRIES)) {
    const produced = join(DIST, `${rel.split('/').pop().replace(/\.[jt]s$/u, '')}.js`)
    if (!existsSync(produced)) continue
    const target = join(DIST, outName === 'sw.js' ? 'src/sw/index.js' : outName === 'panel.js' ? 'src/sidepanel/panel.js' : 'src/content/content.js')
    mkdirSync(dirname(target), { recursive: true })
    cpSync(produced, target)
    if (produced !== target) rmSync(produced, { force: true })
  }
  for (const rel of STATIC) {
    const target = join(DIST, rel)
    mkdirSync(dirname(target), { recursive: true })
    cpSync(join(HERE, rel), target)
  }
  const inputs = Object.keys(result.metafile.inputs).length
  console.log(`build: ${String(entryPoints.length)} entry points, ${String(inputs)} modules bundled`)
}

if (!existsSync(DIST)) {
  console.error('build: dist/ missing — run without --report-only first')
  process.exit(1)
}

const files = walkSizes(DIST).sort((a, b) => b.bytes - a.bytes)
const total = files.reduce((sum, f) => sum + f.bytes, 0)
const gzip = files.filter((f) => ['.js', '.html', '.css'].includes(extname(f.path))).reduce((sum, f) => sum + gzipSync(join(DIST, f.path)).length, 0)

console.log('\n产物体积报告（加载 dist/ 即为此体积）')
for (const file of files) console.log(`  ${(file.bytes / 1024).toFixed(1).padStart(8)} KB  ${file.path}`)
console.log(`  ${'—'.repeat(24)}`)
console.log(`  ${(total / 1024).toFixed(1).padStart(8)} KB  总计（未压缩）`)
console.log(`  ${(gzip / 1024).toFixed(1).padStart(8)} KB  总计（gzip 估算）`)
console.log(`\nG6 判据：总计 ≤ 1024 KB → ${total <= 1024 * 1024 ? '✅ 通过' : '❌ 超出'}\n`)

const report = {
  generatedAt: new Date().toISOString(),
  criterion: { limitBytes: 1024 * 1024, metric: 'dist/ total, uncompressed' },
  totalBytes: total,
  gzipBytes: gzip,
  pass: total <= 1024 * 1024,
  files,
}
const outPath = join(ROOT, 'docs', 'reviews', 'build-size.json')
mkdirSync(dirname(outPath), { recursive: true })
writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
console.log(`报告写入 docs/reviews/build-size.json`)
