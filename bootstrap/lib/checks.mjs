/**
 * 依赖体检 —— **纯判定**（事实由调用方探测后传进来，本模块不碰磁盘/网络）。
 *
 * 为什么把判定与探测分开：
 *   · 判定逻辑（"Node 太老算不算阻断""端口被占算警告还是阻断"）是**规则**，必须能被单测钉住；
 *   · 探测（跑 `command -v`、连端口、stat 目录）是 I/O，跟着环境变，单测里换成假事实即可。
 *
 * 每一项都带 `fix`（"缺了该怎么办"），因为引导程序的价值就在于**说清楚下一步**，
 * 而不是只报一句 missing。用户要求："安装每一个依赖, 都需要用户确认一下" ⇒
 * 每项都标了 `installable`（能不能由引导程序代装）与 `command`（代装时跑什么）。
 */
import { MIN_NODE_MAJOR, PLUGIN_ID } from './layout.mjs'

/** 状态 → 图标。**唯一真源**：`summarize()` 的"合法状态集"也从它派生，免得两处枚举漂移。 */
export const STATUS_ICON = { ok: '✅', warn: '⚠️ ', missing: '❌' }

/** 建议安装的 DSH 版本（不写死具体号，由调用方传，见目标里"必须钉版本"那条）。 */
export const INSTALLABLE = 'installable'
export const MANUAL = 'manual'

/** Node 是唯一"引导程序装不了"的依赖（系统级运行时，且安装要用户密码）。 */
export function checkNode({ nodeVersion, minMajor = MIN_NODE_MAJOR }) {
  const major = Number(/^v?(\d+)/u.exec(String(nodeVersion ?? ''))?.[1] ?? Number.NaN)
  const ok = Number.isInteger(major) && major >= minMajor
  return {
    id: 'node',
    label: `Node.js ≥ ${String(minMajor)}`,
    status: ok ? 'ok' : 'missing',
    detail: ok ? `当前 ${String(nodeVersion)}` : `当前 ${String(nodeVersion)}（太老）`,
    fix: ok ? null : `去 https://nodejs.org 装 Node ${String(minMajor)} 或更高，或用 nvm/fnm 装；装完重跑本引导程序`,
    installable: MANUAL,
    command: null,
  }
}

/** `dsh` CLI 是否在 PATH 上。 */
export function checkDshCli({ dshCliPath, dshVersion, targetDshVersion }) {
  if (typeof dshCliPath !== 'string' || dshCliPath === '') {
    return {
      id: 'dsh',
      label: 'DeepSeek Harness（dsh 命令）',
      /*
       * ★ 缺 DSH 是 **warn（警告）而不是 missing（阻断）**。
       * 理由：引导程序**自己会装它**（第 3 步，版本钉死；见 install.mjs）。
       * 阻断项该只留给"引导程序办不到的事"（Node 缺失、目录不可写…）——
       * 否则全新机器上用户会看到"仍有阻断项，仍要继续吗？（不推荐）"，那是误导：
       * 缺 DSH 正是全新机器的**正常**状态。
       */
      status: 'warn',
      detail: 'PATH 里找不到 dsh —— 引导程序会替你装（第 3 步）',
      fix: `将安装（版本钉我们验证过的，**不要用 latest**）：npm install -g @deepseek-ai/dsh@${String(targetDshVersion)}`,
      installable: INSTALLABLE,
      command: ['npm', ['install', '-g', `@deepseek-ai/dsh@${String(targetDshVersion)}`]],
    }
  }
  /*
   * ★ 路径在、但**版本读不出来**（2026-09-13 修，PiMoa 第 3 片查出）：
   * `dsh -V` 失败、或 PATH 上是个**同名的别的程序**。原来的两个分支都不命中
   * ⇒ 直落末尾 `status: 'ok'`，连"这是不是 DSH"都没验就报 ✅。
   */
  if (typeof dshVersion !== 'string' || dshVersion === '') {
    return {
      id: 'dsh',
      label: 'DeepSeek Harness（dsh 命令）',
      status: 'warn',
      detail: `${dshCliPath} 在，但 \`dsh -V\` 读不出版本 —— 可能不是真的 DSH`,
      fix: `先手动确认：${dshCliPath} -V；要重装：npm install -g @deepseek-ai/dsh@${String(targetDshVersion)}`,
      installable: INSTALLABLE,
      command: ['npm', ['install', '-g', `@deepseek-ai/dsh@${String(targetDshVersion)}`]],
    }
  }
  if (typeof dshVersion === 'string' && dshVersion !== targetDshVersion) {
    return {
      id: 'dsh',
      label: 'DeepSeek Harness（dsh 命令）',
      status: 'warn',
      detail: `已装 ${dshVersion}，而我们验证过的是 ${String(targetDshVersion)}`,
      fix: '可以继续（已实测跨小版本可用），但遇到怪问题先怀疑版本漂移；要换版本：npm install -g @deepseek-ai/dsh@<版本>',
      installable: MANUAL,
      command: null,
    }
  }
  return {
    id: 'dsh',
    label: 'DeepSeek Harness（dsh 命令）',
    status: 'ok',
    detail: `${dshCliPath}${typeof dshVersion === 'string' ? ` (${dshVersion})` : ''}`,
    fix: null,
    installable: MANUAL,
    command: null,
  }
}

/**
 * 端口状态。三种情形要分清（这正是用户最容易卡住的地方）：
 *   · 已有本插件在跑且已配对 → 复用，别去动它；
 *   · 端口被别的进程占着 → 警告（DSH 起不来）；
 *   · 空闲 → 正常，稍后由 DSH 自己监听。
 */
export function checkPort({ port, listening, paired }) {
  if (listening === true && paired === true) {
    return { id: 'port', label: `端口 ${String(port)}`, status: 'ok', detail: '已有 DSH 在跑且已配对，将复用它', fix: null, installable: MANUAL, command: null }
  }
  if (listening === true && paired !== true) {
    return {
      id: 'port',
      label: `端口 ${String(port)}`,
      status: 'warn',
      detail: '端口被占用，但应答的不是本插件',
      fix: `先确认那个进程是谁：lsof -nP -iTCP:${String(port)} -sTCP:LISTEN；或换一个端口（--port）`,
      installable: MANUAL,
      command: null,
    }
  }
  /*
   * ★ `listening === null` = **探测失败**，不是"空闲"（2026-09-13 修，PiMoa 第 3 片查出）。
   * 原来落到末行 `status: 'ok', detail: '空闲'`，于是"lsof 查不出来"被渲染成绿灯。
   */
  if (listening !== true && listening !== false) {
    return {
      id: 'port',
      label: `端口 ${String(port)}`,
      status: 'warn',
      detail: '查不出这个端口有没有人在听（lsof 缺失/无权限/被拦）',
      fix: `手动看一眼：lsof -nP -iTCP:${String(port)} -sTCP:LISTEN`,
      installable: MANUAL,
      command: null,
    }
  }
  return { id: 'port', label: `端口 ${String(port)}`, status: 'ok', detail: '空闲', fix: null, installable: MANUAL, command: null }
}

/** 一个目录能不能写（结果由调用方 stat/access 后传进来）。 */
export function checkDirectory({ id, label, status, path, createHint }) {
  const ok = status === 'ok'
  const missing = status === 'missing'
  return {
    id,
    label,
    status: ok ? 'ok' : missing ? 'ok' : 'missing',
    detail: ok ? `${path}（可写）` : missing ? `${path}（不存在，将创建）` : `${path}（不可写）`,
    fix: missing || ok ? null : createHint ?? `检查这个目录的权限：${path}`,
    installable: MANUAL,
    command: null,
  }
}

/** Chrome 装没装（决定 native messaging 清单写哪儿有没有意义）。 */
export function checkChrome({ installed, manifestDir, browser }) {
  return installed
    ? { id: 'chrome', label: 'Chrome / Chromium', status: 'ok', detail: `清单将写到 ${String(manifestDir)}`, fix: null, installable: MANUAL, command: null }
    : {
        id: 'chrome',
        label: 'Chrome / Chromium',
        status: 'warn',
        detail: `没找到 ${String(browser ?? 'chrome')} 的配置目录`,
        fix: '先装 Chrome（本插件只支持 Chromium 系）。若已装但在别的用户下，先启动一次 Chrome 再重跑',
        installable: MANUAL,
        command: null,
      }
}

/** 插件挂载是否已存在、且指向哪个目录（诊断用）。 */
export function checkMount({ exists, entryPath, expectedPath }) {
  if (exists !== true) {
    return { id: 'mount', label: `插件挂载（${PLUGIN_ID}）`, status: 'warn', detail: '尚未挂载，将写入', fix: null, installable: MANUAL, command: null }
  }
  const same = entryPath === expectedPath
  return {
    id: 'mount',
    label: `插件挂载（${PLUGIN_ID}）`,
    status: same ? 'ok' : 'warn',
    detail: same ? `已指向 ${String(entryPath)}` : `当前指向 ${String(entryPath ?? '(读不到)')}，将改为 ${String(expectedPath)}`,
    fix: null,
    installable: MANUAL,
    command: null,
  }
}

/**
 * 汇总：有没有阻断项。
 *
 * ★ **未知 status 一律当阻断**（2026-09-13 修，PiMoa 第 3 片查出）：原来只认 `missing`/`warn`，
 * 新增 check 时把枚举拼错（例如写成 `'blocked'`）既不算阻断、渲染时还会退化成两个空格
 * **整行隐身** ⇒ 静默假绿。
 */
export function summarize(checks) {
  // 合法状态集从渲染表派生（2026-09-13 修，PiMoa 片 B 第 8 条）：两处各写一份枚举，
  // 任一方加了键就会"判定与渲染不一致" —— 那正是这条改动要消灭的毛病。
  const known = new Set(Object.keys(STATUS_ICON))
  const blockers = checks.filter((c) => c.status === 'missing' || !known.has(c.status))
  const warnings = checks.filter((c) => c.status === 'warn')
  return { blockers, warnings, ok: blockers.length === 0 }
}

/** 渲染成终端表格（等宽对齐；不引第三方库）。 */
export function renderChecks(checks) {
  const icon = STATUS_ICON
  const width = Math.max(...checks.map((c) => c.label.length), 0)
  const lines = []
  for (const c of checks) {
    // 未知状态显式渲染成 ❓，不许"隐身"（原来 `?? '  '` 会打出一整行空白）
    lines.push(`${icon[c.status] ?? '❓'} ${c.label.padEnd(width)}  ${c.detail}`)
    if (c.fix !== null && c.fix !== undefined && c.status !== 'ok') lines.push(`${' '.repeat(width + 4)}↳ ${c.fix}`)
  }
  return lines
}
