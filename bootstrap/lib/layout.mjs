/**
 * 安装布局 —— **所有路径的唯一来源**。
 *
 * 为什么要有这个文件（用户 2026-09-12 的明确要求）：
 * 「这是典型的硬编码问题。我们要在这个版本，彻底检查，变成通过引导程序传入参数。」
 *
 * 所以本模块遵守一条硬规则：**文件里不出现任何绝对路径字面量**。每条路径都由调用方传进来的
 * 参数推导：installDir（用户选的安装目录）、dshHome、port、platform、homeDir、env。
 *
 * 历史包袱（本次要消除的）：
 *   · `native-host/install.mjs` 把 Chrome 清单目录写死成 macOS 的
 *     `~/Library/Application Support/...` —— 换个系统就废；
 *   · `native-host/run-host.sh` 是**被 git 跟踪的生成物**，里面焊着作者本机的 node 路径
 *     与仓库路径 —— 别人 clone 下来拿到的是我的机器布局。
 * 两者都由本模块取代。
 *
 * 分隔符：按**目标平台**选（win32 → `\`，其余 → `/`），而不是按当前进程所在平台，
 * 这样单测在任何机器上跑都是同一个确定结果，也能在 mac 上单测 Windows 分支。
 */
import { posix, win32 } from 'node:path'

/** 插件在 profile patch 里的条目 id（也是 `dsh-plugin/package.json` 的包名）。 */
export const PLUGIN_ID = 'dsh-web-companion-bridge'
/** native messaging host 名（Chrome 清单文件名 = `<HOST_NAME>.json`）。 */
export const HOST_NAME = 'com.dsh.web_companion'
/** 配对文件名（落在 `$DSH_HOME` 下）。 */
export const PAIRING_FILENAME = 'dsh-web-companion.json'
/** DSH profile 名（配对与挂载都写在它下面）。 */
export const PROFILE_NAME = 'web'
/** profile 的用户补丁层文件名。 */
export const PATCH_FILENAME = 'cordis.patch.yml'
/** DSH web 默认端口。 */
export const DEFAULT_PORT = 3080
/** 本插件运行所需的最低 Node 主版本。 */
export const MIN_NODE_MAJOR = 22

/*
 * ★ 2026-09-14 删除 `defaultInstallDir()`（旧的 `~/.dsh/plugins/dsh-web-companion`）：
 * 安装器从 v3.47.2 起的缺省是"**你解压出来的那个文件夹**"（用户明确要求），而这个函数还留着旧概念、
 * 被 doctor / uninstall 各用了一次 —— 同一件事有了**两个真源**，远端实测已经因此产生假红。
 * 缺省值现在只有一个：脚本自己所在的包目录，或者用户显式给的 `--install-dir`。
 */

/** 按目标平台取 path 实现。 */
function pathFor(platform) {
  return platform === 'win32' ? win32 : posix
}

/** 从 `v22.22.3` / `22.1.0` 里取主版本号；拿不到返回 null。 */
export function parseNodeMajor(version) {
  const m = /^v?(\d+)\./u.exec(String(version ?? '').trim())
  return m === null ? null : Number(m[1])
}

/** 把 3080 之类的端口号解析成正整数；非法则 null。 */
export function parsePort(value) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null
}

/**
 * Chromium 系浏览器放 native messaging 清单的候选目录。
 *
 * - darwin：Chrome 系（Chrome/Arc 等）共用 `~/Library/Application Support/Google/Chrome/...`。
 * - linux：每个浏览器一个目录，按"谁装了用谁"挑；`XDG_CONFIG_HOME` 优先。
 * - win32：**不是目录而是注册表**（`HKCU\Software\Google\Chrome\NativeMessagingHosts\<name>`）——
 *   返回 `{ registry: true, ... }`，由调用方决定怎么写。**本机是 macOS，该分支未验。**
 */
export function chromeNativeMessagingCandidates({ platform, homeDir, env = {} }) {
  const P = pathFor(platform)
  if (platform === 'darwin') {
    return [{ browser: 'chrome', dir: P.join(homeDir, 'Library', 'Application Support', 'Google', 'Chrome', 'NativeMessagingHosts') }]
  }
  if (platform === 'linux') {
    const configHome = typeof env.XDG_CONFIG_HOME === 'string' && env.XDG_CONFIG_HOME !== ''
      ? env.XDG_CONFIG_HOME
      : P.join(homeDir, '.config')
    return [
      { browser: 'chrome', dir: P.join(configHome, 'google-chrome', 'NativeMessagingHosts') },
      { browser: 'chromium', dir: P.join(configHome, 'chromium', 'NativeMessagingHosts') },
      { browser: 'edge', dir: P.join(configHome, 'microsoft-edge', 'NativeMessagingHosts') },
      { browser: 'brave', dir: P.join(configHome, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts') },
    ]
  }
  if (platform === 'win32') {
    return {
      registry: true,
      root: 'HKCU',
      keyPath: (name) => `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${name}`,
      valueName: '',
    }
  }
  return { registry: false, unsupported: platform, keyPath: () => null }
}

/**
 * 从候选里挑一个"真正该写"的目标：优先**已经存在**的浏览器目录，否则退回第一个。
 * `exists` 由调用方注入，便于单测。
 */
export function pickChromeTarget(candidates, exists) {
  if (!Array.isArray(candidates)) return candidates
  return candidates.find((c) => exists(c.dir)) ?? candidates[0]
}

/**
 * 解析出一整套安装布局。**这是路径的唯一真源**：引导程序、uninstall、native host 安装
 * 全都从这里取路径，谁都不许自己拼字符串。
 *
 * @param {object} opts
 * @param {string} opts.installDir 用户选择的安装目录（绝对路径）
 * @param {string} opts.dshHome     DSH 数据目录（绝对路径）
 * @param {string} opts.homeDir     用户主目录（绝对路径）
 * @param {number} [opts.port]
 * @param {string} [opts.platform]
 * @param {object} [opts.env]
 * @param {(dir: string) => boolean} [opts.exists] 探测浏览器目录是否存在（可注入）
 */
export function resolveLayout(opts) {
  const {
    installDir,
    dshHome,
    homeDir,
    port = DEFAULT_PORT,
    platform = process.platform,
    env = {},
    exists = () => false,
  } = opts ?? {}

  for (const [name, value] of Object.entries({ installDir, dshHome, homeDir })) {
    if (typeof value !== 'string' || value.trim() === '') {
      throw new TypeError(`resolveLayout: ${name} 必须是绝对路径字符串`)
    }
    const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/u.test(value)
    if (!absolute) throw new TypeError(`resolveLayout: ${name} 必须是绝对路径，收到 ${JSON.stringify(value)}`)
  }

  const P = pathFor(platform)
  const pluginDir = P.join(installDir, 'dsh-plugin')
  const nativeHostDir = P.join(installDir, 'native-host')

  const chromeCandidates = chromeNativeMessagingCandidates({ platform, homeDir, env })
  const chromeTarget = pickChromeTarget(chromeCandidates, exists)
  const chromeManifestDir = Array.isArray(chromeCandidates) ? chromeTarget.dir : null

  return Object.freeze({
    installDir,
    dshHome,
    homeDir,
    port,
    platform,

    // 装到用户选定目录里的东西
    pluginDir,
    /** 写进 profile patch `name:` 的那一行 —— **本次要参数化的核心** */
    pluginEntry: P.join(pluginDir, 'src', 'host', 'index.js'),
    nativeHostDir,
    nativeHostEntry: P.join(nativeHostDir, 'host.mjs'),
    runner: P.join(nativeHostDir, 'run-host.sh'),
    extensionDist: P.join(installDir, 'extension', 'dist'),

    // DSH 侧
    profilePatch: P.join(dshHome, 'profiles', PROFILE_NAME, PATCH_FILENAME),
    pairingFile: P.join(dshHome, PAIRING_FILENAME),
    credentialsFile: P.join(dshHome, '.credentials.yaml'),
    hostLogFile: P.join(dshHome, 'logs', 'dsh-web-companion-host.log'),

    // Chrome 侧
    chromeCandidates,
    chromeManifestDir,
    chromeManifestPath: chromeManifestDir === null ? null : P.join(chromeManifestDir, `${HOST_NAME}.json`),
    chromeRegistry: Array.isArray(chromeCandidates) ? null : chromeCandidates,
  })
}

/**
 * 需要复制到安装目录的**相对路径清单**（相对仓库根）。
 *
 * 两条约束（用户 2026-09-12）：
 *
 * 1. **发行包必须轻**：「依赖程序都是用引导程序下载，并不在我们打包的安装程序里，不然会很重」
 *    ⇒ 清单里**没有** `node_modules`、**没有**预构建的 `extension/dist`。依赖由引导程序
 *    在安装时 `npm install` 下载（见 `npmInstallTargets()`）。
 * 2. **dist 必须现场构建**：产物里烤着「端口 + 配对 key」（`extension/src/lib/dev-config.js`
 *    由 `scripts/init-key.mjs` 生成），而那个端口是**用户机器上的真实端口**。
 *    因此预构建的 dist 对用户毫无意义 —— 还正好是历史上真实出过的事故
 *    （v3.39：产物被烤进测试端口 3099，用户面板一直往死端口拨号）。
 *
 * 同时**不整仓复制**：仓库里有 `tests/`、`docs/`、`.devhome/`（几百 MB 的测试用 DSH）、
 * 密钥材料等，都不是运行时需要的。列成显式清单，dry-run 时就能打印给用户看。
 */
export function installPayload() {
  return [
    // 插件本体：host 半 + client 半（client 半由 package.json 的 exports 决定怎么被发现）
    'dsh-plugin/src',
    'dsh-plugin/lib',
    'dsh-plugin/package.json',
    // 扩展源码 + 构建脚本（dist 不入清单，见上）
    'extension/src',
    'extension/manifest.json',
    'extension/build.mjs',
    'extension/package.json',
    // ★ 语言包：Chrome 要求它与 manifest.json 同级，build.mjs 会整目录拷进 dist。
    //   漏了它 build 会直接 `ENOENT: lstat …/extension/_locales`（2026-09-12 实测踩到）。
    'extension/_locales',
    // 文案单源 + 生成器（装完之后还能自己重新生成语言包）
    'extension/i18n',
    // native messaging 拉起器（run-host.sh 由安装器现场生成，不入清单）
    'native-host',
    // 引导程序自身，便于装完后再跑一次或卸载
    'bootstrap',
    // 配对与装完自证
    'scripts/init-key.mjs',
    'scripts/check-dist-config.mjs',
    'package.json',
    'package-lock.json',
  ]
}

/**
 * 需要执行 `npm install` 的目录（相对仓库根）—— 依赖由引导程序现场下载。
 *
 * 本仓其实是**三个独立的 npm 包**（实测，2026-09-12）：
 *   · `dsh-plugin/`：插件的运行时依赖（`@deepseek-ai/dsh-tools`、`-credentials`、`ws`）→ **必需**
 *   · `extension/`：构建依赖（`esbuild`）→ **必需**（要现场构建 dist）
 *   · 根目录：只有测试/脚本用（`ws`、`@colbymchenry/codegraph`）→ 用户装机**不需要**
 *
 * 这条差异很容易踩：`extension/build.mjs` 里 `import { build } from 'esbuild'` 能跑通，
 * 是因为 `extension/node_modules/` 存在；只跑根目录的 `npm install` 再构建就会
 * `ERR_MODULE_NOT_FOUND: esbuild`。
 */
export function npmInstallTargets({ includeDevTools = false } = {}) {
  const required = ['dsh-plugin', 'extension']
  return includeDevTools ? [...required, '.'] : required
}

/** 从清单里排除掉不该复制的生成物（run-host.sh 含绝对路径，必须由安装器现写）。 */
export function installPayloadFilter(relativePath) {
  if (relativePath.endsWith('run-host.sh')) return false
  if (relativePath.includes('node_modules/')) return false
  if (relativePath.startsWith('extension/dist/')) return false
  if (relativePath.includes('/dist/')) return false
  if (relativePath.includes('.devhome/')) return false
  return true
}
