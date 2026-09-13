/**
 * 装完之后的**健康复检**（判定与渲染；探测结果由调用方传进来）。
 *
 * ★ 这里有一条必须讲清楚的**诚实边界**（第一版写错了，本轮改正）：
 *
 * 用户要求「引导程序要检测所有的依赖, chrome 扩展是否都健康运行」。但**扩展是 Chrome 里的东西，
 * 它不主动连上来，外面就看不见它** —— 本插件能观察到的只有：
 *   · `connectedClients`：**DSH 页面半（client 半）**的连接数，不是扩展；
 *   · 扩展自己持有的 `/ag/agent` 通道数：**当前 `/ag/ping` 没有暴露这个字段**
 *     （`dsh-plugin/src/host/index.js` 里只有 `connectedClients: () => hub.clientCount`）。
 *
 * 第一版把 `connectedClients > 0` 标成「扩展已连上桥接」——**那是错的**：用户没开侧边栏时
 * 这条会报红，而扩展其实好好的（假红）。按本项目的验收口味（不许假绿、也不许假红），
 * 这里改成如实说：
 *   · 硬判据只有三条能机器判定的事实（DSH 应答 / 插件已配对 / 产物端口与配对端口一致）；
 *   · 「扩展有没有连上」用**代理判据**（软判据）：侧边栏一打开，iframe 里的 DSH 页面半就会连上，
 *     `connectedClients` 因此 >0。判据是可解释的，但**不能拿它当"扩展没装"的证据**，
 *     所以它 `soft: true`，不参与总成功/失败，并给出明确的下一步。
 *
 * 要把它变成真判据，需要给 `/ag/ping` 加一个字段（例如 `agentClients: () => hub.agentCount`）。
 * 那会动到协议 schema（`ping` 有正向量、且帧是闭集），本轮**故意不做**，已记入 CHANGELOG。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pingPlugin as probePing, readPairingKey } from './probe.mjs'

/**
 * @param {object} facts
 * @param {number} facts.port
 * @param {{reachable:boolean, paired:boolean, connectedClients:number|null}} facts.ping
 * @param {boolean|null} facts.distOk          `check-dist-config` 是否通过；null = 没跑
 * @param {string} facts.installDir
 * @returns {{id:string, ok:boolean, soft:boolean, label:string, detail:string, fix:string|null}[]}
 */
export function evaluateHealth(facts) {
  const { port, ping, distOk, installDir } = facts ?? {}
  const clients = ping?.connectedClients ?? null
  return [
    {
      id: 'dsh-up',
      /*
       * `reachable` 现在由 `pingPlugin()` **验过身份**才算真（HTTP 200 + `body.ok` +
       * `body.plugin === PLUGIN_ID`），所以这条判据其实是在问"**本插件**在这个端口应答吗"。
       * 文案跟着说准，否则用户会以为"DSH 在跑"就够了（2026-09-13 修，PiMoa 第 3 片查出）。
       */
      ok: ping?.reachable === true,
      soft: false,
      label: `本插件在本机 ${String(port)} 端口应答（/ag/ping）`,
      detail: ping?.reachable === true ? '是' : '否',
      fix: ping?.reachable === true
        ? null
        : `先确认 DSH 在跑（dsh web），再确认插件已挂载（重跑本程序）；手动验证：curl http://127.0.0.1:${String(port)}/ag/ping`,
    },
    {
      id: 'paired',
      ok: ping?.paired === true,
      soft: false,
      label: '插件已加载并配对（/ag/ping → paired）',
      detail: ping?.paired === true ? '是' : '否',
      fix: ping?.paired === true ? null : '插件没挂上或配对文件不匹配：重跑本程序，或检查 profile 挂载行',
    },
    {
      id: 'dist-port',
      ok: distOk === true,
      /*
       * ★ 改**硬判据**（2026-09-13；PiMoa 片 3 BLOCKER 的后半 / 片 A 第 4 条）：
       * 原来 `soft: distOk === null` ⇒ 安装目录缺 `scripts/check-dist-config.mjs`（等于第 2 步复制
       * 不完整）时，总判定照样通过、横幅还说"✅ 装好了"。**缺这个脚本本身就是安装残缺**，
       * 不该被软判据掩盖。现在它硬失败，横幅会说清"未检查"并给出修法。
       */
      soft: false,
      label: '扩展产物端口 == 真实配对端口',
      detail: distOk === true ? '一致' : distOk === null ? '未检查' : '不一致',
      /*
       * `distOk === null` 不是"不一致"，是**没检查**（缺 `scripts/check-dist-config.mjs`，
       * 而那意味着安装目录不完整）。两种情形的修法完全不同（2026-09-13 修，PiMoa 第 3 片查出）。
       */
      fix: distOk === true
        ? null
        : distOk === null
          ? `缺 ${installDir}/scripts/check-dist-config.mjs（安装不完整）—— 重跑本引导程序补上`
          : `重跑构建：node ${installDir}/extension/build.mjs`,
    },
    {
      id: 'extension-proxy',
      ok: clients !== null && clients > 0,
      /*
       * 软判据：为 0 只说明"现在没有 DSH 页面半连着"，**不能**说明扩展没装。
       * 因此它不影响总判定，且必须把话说清楚 + 给出下一步。
       */
      soft: true,
      label: '扩展连通（代理判据：侧边栏里的 DSH 页面半）',
      detail: clients === null
        ? '插件没报这个数（拿不到就别说通不通）'
        : clients > 0
          ? `💡 有 ${String(clients)} 个页面半连着（说明扩展已加载且侧边栏开着）`
          : '现在没有页面半连着 —— 打开侧边栏后应当 >0',
      fix: clients !== null && clients > 0
        ? null
        : '点浏览器工具栏里的本扩展图标打开侧边栏，然后回这里再查一次。'
          + '（注意：本程序看不到"扩展装没装"，只能看它有没有连上来。）',
    },
  ]
}

/** 渲染成终端行。 */
export function renderHealth(items) {
  return items.map((i) => {
    const icon = i.ok ? '✅' : i.soft ? '⚠️ ' : '❌'
    const head = `${icon} ${i.label} —— ${i.detail}`
    return i.ok || i.fix === null ? head : `${head}\n      ↳ ${i.fix}`
  })
}

/** 总判定：**只算硬判据**（软判据永远不把安装判成失败）。 */
export function overallOk(items) {
  const hard = items.filter((i) => !i.soft)
  return hard.length > 0 && hard.every((i) => i.ok)
}

/** 还差哪几条硬判据没过（给"再查一次"的循环用）。 */
export function pendingHard(items) {
  return items.filter((i) => !i.soft && !i.ok)
}

/**
 * 收尾横幅该说什么。
 *
 * ★ 真实缺陷（2026-09-13，`node bootstrap/install.mjs --apply --yes` 实测）：
 * 非交互时 `w.pause()` 直接返回 false ⇒ **第 11 步复检根本没跑** ⇒ `health` 还是空数组；
 * 而 `overallOk([])` 是 `false`（它要求"至少有一条硬判据 **且** 全过"）⇒ 收尾一律打印
 * "安装步骤已跑完，但还有硬判据没过（见上面的 ❌ 与 ↳ 修法）" —— 可上面**一条 ❌ 都没有**。
 * 对"跑在 CI / 脚本里"的用法这是纯误导：人会去翻根本不存在的失败项。
 *
 * 所以这里把"**没查**"与"**查了没过**"分开（抽成纯函数是为了能被单测咬住）。
 */
export function finishBanner(items, { mountSkipped = false, autoDeclined = 0 } = {}) {
  /*
   * 挂载被跳过 ⇒ **等于没装**（DSH 不会加载本插件），不能报"装好了"。
   * 2026-09-13 实测的坏形态：用户在第 8 步答 n，程序照样走完第 9/10/11 步并打印收尾横幅。
   */
  const prefix = mountSkipped
    ? ' ⛔ 未完成：插件挂载被跳过 —— DSH 不会加载本插件，**等于没装**。'
    : ''
  /*
   * 非交互 `--apply` 没给 `--yes` ⇒ 每个 `confirm()` 都按「否」⇒ **一个文件都没动**。
   * 这种"什么都没做"必须显式说出来，否则（DSH 本来就在跑时）横幅照样一片绿。
   */
  const declined = autoDeclined > 0
    ? ` ⛔ 本轮有 ${String(autoDeclined)} 个步骤在非交互环境下按「否」处理 —— 什么都没装（要真装请加 --yes）。`
    : ''
  const softFailed = items.filter((i) => i.soft && !i.ok).map((i) => ({ id: i.id, label: i.label }))
  if (items.length === 0) {
    /*
     * ★ 文案改成说实话（2026-09-13；PiMoa 片 B 第 8 条）：第 11 步复检早已**不再**被
     * `pause()` gate 住（`install.mjs` 里是无条件跑），所以"非交互环境跳过了第 11 步"是**假的**。
     * 这个分支现在只有"`probeHealth` 一条判据都没返回"这种异常情况才会走到（由单测喂）。
     */
    return {
      ok: !mountSkipped && autoDeclined === 0,
      text: `${prefix}${declined} 安装步骤已跑完；但**没拿到任何健康判据**（probeHealth 返回空）—— 请用下面的 doctor 自查`,
      softFailed,
    }
  }
  const hardOk = overallOk(items)
  /*
   * ★ 括号里**只列真的查过的**硬判据（2026-09-13 修，PiMoa 第 3 片查出）：原来是写死的
   * "DSH 应答 / 已配对 / 产物端口一致"，而 `distOk === null`（缺 `scripts/check-dist-config.mjs`）
   * 时那一项**根本没检查**，横幅却照样声称"一致" —— 假绿。
   */
  const passed = items.filter((i) => !i.soft && i.ok).map((i) => i.label).join(' / ')
  return {
    ok: hardOk && !mountSkipped && autoDeclined === 0,
    text: `${prefix}${declined}${hardOk
      ? ` ✅ 装好了，硬判据全过（${passed}）`
      : ' 安装步骤已跑完，但还有硬判据没过（见上面的 ❌ 与 ↳ 修法）'}`,
    softFailed,
  }
}

/**
 * 探测 + 判定（**这一层有 I/O**）。引导程序第 11 步与 `bootstrap/doctor.mjs` 共用它，
 * 于是"装完复检"和"随时自查"走的是**同一段逻辑**，不会两处漂移。
 *
 * @param {object} o
 * @param {number} o.port
 * @param {string} o.dshHome
 * @param {string} o.installDir
 * @param {(a: string, b: string[]) => {status: number|null}} [o.spawn] 便于单测注入
 * @param {(p: number, k: string|null) => Promise<object>} [o.ping]        便于单测注入
 */
export async function probeHealth(o) {
  const { port, dshHome, installDir } = o
  const pingFn = o.ping ?? ((p, k) => probePing(p, k))
  const spawnFn = o.spawn ?? ((cmd, args, opts) => spawnSync(cmd, args, opts))

  const pairingFile = join(dshHome, 'dsh-web-companion.json')
  const ping = await pingFn(port, readPairingKey(pairingFile))

  const checkDistScript = join(installDir, 'scripts', 'check-dist-config.mjs')
  let distOk = null
  if (existsSync(checkDistScript)) {
    const res = spawnFn(process.execPath, [checkDistScript], {
      encoding: 'utf8',
      env: { ...process.env, DSH_HOME: dshHome },
    })
    distOk = res.status === 0
  }

  return evaluateHealth({ port, ping, distOk, installDir })
}
