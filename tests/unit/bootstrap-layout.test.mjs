#!/usr/bin/env node
/**
 * 安装布局单测（`bootstrap/lib/layout.mjs`）。
 *
 * 由来（用户 2026-09-12）：「这是典型的硬编码问题。我们要在这个版本，彻底检查，变成通过
 * 引导程序传入参数。」本文件就是那句话的可执行版：
 *
 *   · **行为断言**：换一个 installDir / dshHome / homeDir，返回的每条路径都得跟着变
 *     —— 只要有一条是写死的，这里就会红；
 *   · **源码门禁**：`bootstrap/lib/*.mjs` 里不许出现绝对路径字面量
 *     （`/Users/`、`/home/`、`C:\`）。这条正是为了挡住历史上真实存在的那一处：
 *     `native-host/install.mjs:21` 把 Chrome 清单目录写死成 macOS 的
 *     `~/Library/Application Support/...`。**把老写法贴回去，这条会红。**
 *
 * 用法：node tests/unit/bootstrap-layout.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_PORT,
  HOST_NAME,
  MIN_NODE_MAJOR,
  PLUGIN_ID,
  chromeNativeMessagingCandidates,
  defaultInstallDir,
  installPayload,
  installPayloadFilter,
  npmInstallTargets,
  parseNodeMajor,
  parsePort,
  pickChromeTarget,
  resolveLayout,
} from '../../bootstrap/lib/layout.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')

const results = {}
const record = (name, value) => {
  if (Object.hasOwn(results, name)) throw new Error(`断言名重复：「${name}」—— 同名会覆盖，红会被绿掩盖，请改一个唯一的名字`);
  results[name] = value
  console.log(`  ${value === true ? '✅' : value === false ? '❌' : '·'} ${name}: ${JSON.stringify(value).slice(0, 140)}`)
}

const base = {
  installDir: '/tmp/wc-install',
  dshHome: '/tmp/wc-home',
  homeDir: '/tmp/wc-user',
  platform: 'darwin',
}

console.log('1. 基本布局：所有路径都从参数推导')
{
  const l = resolveLayout(base)
  record('pluginEntry 落在 installDir 下', l.pluginEntry === '/tmp/wc-install/dsh-plugin/src/host/index.js')
  record('pluginEntry 是绝对路径', l.pluginEntry.startsWith('/'))
  record('profilePatch 落在 dshHome 下', l.profilePatch === '/tmp/wc-home/profiles/web/cordis.patch.yml')
  record('pairingFile 落在 dshHome 下', l.pairingFile === '/tmp/wc-home/dsh-web-companion.json')
  record('credentialsFile 落在 dshHome 下', l.credentialsFile === '/tmp/wc-home/.credentials.yaml')
  record('runner 在 native-host 下', l.runner === '/tmp/wc-install/native-host/run-host.sh')
  record(`port 默认 ${String(DEFAULT_PORT)}`, l.port === DEFAULT_PORT)
  record('常量没被改坏', PLUGIN_ID === 'dsh-web-companion-bridge' && HOST_NAME === 'com.dsh.web_companion')
}

console.log('\n2. ★ 参数化：换参数必须换结果（写死的路径在这里就露馅）')
{
  const a = resolveLayout(base)
  const b = resolveLayout({ ...base, installDir: '/other/place', dshHome: '/other/home', homeDir: '/other/user' })
  record('pluginEntry 跟着 installDir 变', a.pluginEntry !== b.pluginEntry && b.pluginEntry === '/other/place/dsh-plugin/src/host/index.js')
  record('profilePatch 跟着 dshHome 变', b.profilePatch === '/other/home/profiles/web/cordis.patch.yml')
  record('chromeManifestPath 跟着 homeDir 变', a.chromeManifestPath !== b.chromeManifestPath)
  record('同一参数两次调用结果一致（纯函数）', JSON.stringify(resolveLayout(base)) === JSON.stringify(a))
  record('结果里不含测试参数以外的用户目录', JSON.stringify(b).includes('/tmp/wc-user') === false)
  record('默认安装目录也随 homeDir 变', defaultInstallDir('/tmp/wc-user') === '/tmp/wc-user/.dsh/plugins/dsh-web-companion')
}

console.log('\n3. 平台分支：Chrome 清单目录不是写死的 macOS 路径')
{
  const darwin = chromeNativeMessagingCandidates({ platform: 'darwin', homeDir: '/tmp/u' })
  record('darwin 是数组且有 chrome', Array.isArray(darwin) && darwin[0].browser === 'chrome')
  record('darwin 路径含 NativeMessagingHosts', darwin[0].dir.endsWith('/NativeMessagingHosts'))
  record('darwin 路径以 homeDir 开头（不是硬编码的主目录）', darwin[0].dir.startsWith('/tmp/u/'))

  const linux = chromeNativeMessagingCandidates({ platform: 'linux', homeDir: '/tmp/u', env: { XDG_CONFIG_HOME: '/tmp/xdg' } })
  record('linux 有 4 个浏览器候选', linux.length === 4)
  record('linux 尊重 XDG_CONFIG_HOME', linux[0].dir === '/tmp/xdg/google-chrome/NativeMessagingHosts')
  const linuxDefault = chromeNativeMessagingCandidates({ platform: 'linux', homeDir: '/tmp/u', env: {} })
  record('linux 无 XDG 时退到 ~/.config', linuxDefault[0].dir === '/tmp/u/.config/google-chrome/NativeMessagingHosts')

  const win = chromeNativeMessagingCandidates({ platform: 'win32', homeDir: 'C:\\Users\\x' })
  record('win32 走注册表（不是目录）', win.registry === true && win.keyPath('n').startsWith('HKCU\\'))
  record('win32 注册表键含 host 名', win.keyPath(HOST_NAME).endsWith(`\\${HOST_NAME}`))

  const picked = pickChromeTarget(linux, (dir) => dir.includes('chromium'))
  record('pickChromeTarget 优先已装的浏览器', picked.browser === 'chromium')
  record('都不存在时退回第一个', pickChromeTarget(linux, () => false).browser === 'chrome')
}

console.log('\n4. win32 的 layout：没有清单目录，但有注册表信息')
{
  const l = resolveLayout({ ...base, platform: 'win32' })
  record('chromeManifestPath 为 null', l.chromeManifestPath === null)
  record('chromeRegistry 带 keyPath', l.chromeRegistry?.registry === true)
  record('win32 用反斜杠拼路径', l.pluginEntry.includes('\\') && l.pluginEntry.endsWith('index.js'))
}

console.log('\n5. 拒绝相对路径（否则会把路径写歪到进程 cwd）')
{
  const cases = [
    ['installDir', { ...base, installDir: 'relative/dir' }],
    ['dshHome', { ...base, dshHome: 'relative/home' }],
    ['homeDir', { ...base, homeDir: '' }],
  ]
  for (const [field, opts] of cases) {
    let threw = false
    try { resolveLayout(opts) } catch (error) { threw = error instanceof TypeError }
    record(`${field} 非法时抛 TypeError`, threw)
  }
  record('win32 绝对路径（C:\\…）被接受', (() => {
    try { resolveLayout({ ...base, platform: 'win32', installDir: 'C:\\Apps\\wc', dshHome: 'C:\\H', homeDir: 'C:\\U' }); return true } catch { return false }
  })())
}

console.log('\n6. 解析小工具')
{
  record('parseNodeMajor(v22.22.3)=22', parseNodeMajor('v22.22.3') === 22)
  record('parseNodeMajor(22.1.0)=22', parseNodeMajor('22.1.0') === 22)
  record('parseNodeMajor(垃圾)=null', parseNodeMajor('not-a-version') === null)
  record('parseNodeMajor(空)=null', parseNodeMajor(undefined) === null)
  record(`最低 Node 主版本是 ${String(MIN_NODE_MAJOR)}`, MIN_NODE_MAJOR === 22)
  record('parsePort(3080)=3080', parsePort('3080') === 3080)
  record('parsePort(0)=null', parsePort('0') === null)
  record('parsePort(70000)=null', parsePort('70000') === null)
  record('parsePort(abc)=null', parsePort('abc') === null)
}

console.log('\n7. ★ 发行包必须轻：只带源码，依赖由引导程序下载（用户 2026-09-12 的约束）')
{
  const payload = installPayload()
  record('清单里有 dsh-plugin 源码', payload.some((p) => p.startsWith('dsh-plugin/')))
  record('清单里有 native-host', payload.includes('native-host'))
  record('清单里有 bootstrap 自己', payload.includes('bootstrap'))
  record('清单不整仓复制 tests/ 与 docs/', !payload.includes('tests') && !payload.includes('docs'))
  record('清单不整仓复制 .devhome', !payload.some((p) => p.includes('.devhome')))
  // 注意别写成 `p.includes('dist')`：`scripts/check-dist-config.mjs` 里也有 "dist" 这个子串，
  // 那样写会假红（第一版就是这么错的）。这里按**路径段**判。
  record('★ 清单不含 extension/dist（必须现场构建）', !payload.some((p) => p === 'extension/dist' || p.startsWith('extension/dist/')))
  record('★ 清单不含任何 node_modules', !payload.some((p) => p.includes('node_modules')))
  record('清单带上了构建 dist 所需的东西', payload.includes('extension/build.mjs') && payload.includes('extension/package.json') && payload.includes('extension/src'))
  record('★ 过滤掉 run-host.sh', installPayloadFilter('native-host/run-host.sh') === false)
  record('过滤掉 node_modules', installPayloadFilter('dsh-plugin/node_modules/ws/index.js') === false)
  record('过滤掉构建产物', installPayloadFilter('extension/dist/manifest.json') === false)
  record('过滤掉 .devhome', installPayloadFilter('.devhome/workspace-m0a/x.md') === false)
  record('保留 host.mjs', installPayloadFilter('native-host/host.mjs') === true)
  record('保留扩展源码', installPayloadFilter('extension/src/sw/index.js') === true)

  const targets = npmInstallTargets()
  record('★ 依赖装在 dsh-plugin（插件运行时依赖）', targets.includes('dsh-plugin'))
  record('★ 依赖装在 extension（esbuild，构建用）', targets.includes('extension'))
  record('默认不装根目录 devDeps（用户装机不需要 ws/codegraph）', targets.includes('.') === false)
  record('显式要求时才带根目录', npmInstallTargets({ includeDevTools: true }).includes('.'))

  /*
   * ★ 交叉核对：清单必须覆盖 `extension/build.mjs` 真正需要的东西。
   *
   * 为什么加这条（真事故，2026-09-12）：英文版新增了 `extension/_locales/`，
   * 而 `installPayload()` 是**手维护**的清单，忘了加它 ⇒ 装到安装目录后
   * `build.mjs` 拷 `_locales` 时直接 `ENOENT: lstat …/extension/_locales` 报错，
   * 而当时的断言只抽查了几个名字，**没咬到**。现在直接从 build.mjs 源码里把
   * STATIC 与 ENTRIES 读出来，逐个要求被清单覆盖 —— 两个文件必须一致。
   */
  const buildSrc = readFileSync(join(ROOT, 'extension', 'build.mjs'), 'utf8')
  const staticArray = JSON.parse((/const STATIC = (\[[^\]]*\])/u.exec(buildSrc)?.[1] ?? '[]').replaceAll("'", '"'))
  const entryKeys = [...buildSrc.matchAll(/'(src\/[A-Za-z0-9_./-]+\.js)':/gu)].map((m) => m[1])
  const needed = [...new Set([...staticArray, ...entryKeys])]
  record(`从 build.mjs 读到 ${String(needed.length)} 个必要输入`, needed.length >= 4)
  const coveredBy = (rel) => {
    const full = `extension/${rel}`
    return payload.some((entry) => full === entry || full.startsWith(`${entry}/`))
  }
  const uncovered = needed.filter((rel) => !coveredBy(rel))
  record(`★ 清单覆盖 build.mjs 的全部输入（缺：${uncovered.join(',') || '无'}）`, uncovered.length === 0)
  // 单独点名语言包：它是"目录"形态、且正是上面那次漏掉的
  record('★ 清单里有 extension/_locales（Chrome 语言包位置）', payload.includes('extension/_locales'))
}

console.log('\n8. ★ 源码门禁：bootstrap/lib 里不许出现绝对路径字面量')
{
  const libDir = join(ROOT, 'bootstrap', 'lib')
  const files = readdirSync(libDir).filter((f) => f.endsWith('.mjs')).sort()
  record('找到了 lib 文件', files.length >= 4)
  /** 去掉整行注释后再扫 —— 注释里**提到**路径（当例子讲）是允许的，写出字面量不行。 */
  const stripFullLineComments = (source) => source
    .split('\n')
    .filter((line) => {
      const t = line.trim()
      return !(t.startsWith('*') || t.startsWith('/*') || t.startsWith('//') || t.startsWith('*/'))
    })
    .join('\n')
  const offenders = []
  for (const file of files) {
    const code = stripFullLineComments(readFileSync(join(libDir, file), 'utf8'))
    for (const pattern of [/\/Users\//u, /\/home\//u, /[A-Za-z]:\\\\Users/u]) {
      if (pattern.test(code)) offenders.push(`${file} 命中 ${String(pattern)}`)
    }
  }
  record(`0 个绝对路径字面量（发现 ${String(offenders.length)} 处）${offenders.length > 0 ? ` → ${offenders.join('；')}` : ''}`, offenders.length === 0)
}

const failed = Object.entries(results).filter(([, v]) => v !== true).map(([k]) => k)
console.log(`\n${failed.length === 0 ? '✅ 全部通过' : `❌ 失败 ${String(failed.length)} 项：${failed.join('、')}`}（${String(Object.keys(results).length)} 条断言）`)
process.exitCode = failed.length === 0 ? 0 : 1
