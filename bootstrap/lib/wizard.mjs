/**
 * 终端问答的薄封装 —— 只做三件事：问、能不问就不问、非交互时**绝不自作主张**。
 *
 * 安全取向（用户要求"安装每一个依赖, 都需要用户确认一下"）：
 *   · 默认答案是「否」—— 用户直接回车不会意外装上东西；
 *   · `--yes` 才批量同意；
 *   · **不在终端里跑（管道/CI）且没给 `--yes` 时，所有询问一律按"否"处理**，
 *     于是引导程序只会打印计划、不动任何文件。这比"没 TTY 就 panic"或"默默全装"都好。
 */
import { createInterface } from 'node:readline/promises'

export function createWizard({ stdin = process.stdin, stdout = process.stdout, assumeYes = false } = {}) {
  const interactive = stdin.isTTY === true
  /*
   * ★ 只在**真终端**里建 readline。
   *
   * 曾经的写法是 `interactive || assumeYes ? createInterface(...) : null` —— 于是
   * 「非交互 + --yes」会去建一个挂在管道 stdin 上的 readline，`rl.question()` 永远等不到输入，
   * **整个安装程序就挂住了**（自动化里最糟的失败形态：不是报错，是僵住）。
   * 现在的规则：不是 TTY 就**绝不阻塞** —— 该问的按"是"（--yes）或"否"（默认）直接定，
   * 需要人输入的（API key）返回空串表示"跳过"。
   */
  const rl = interactive ? createInterface({ input: stdin, output: stdout }) : null
  let autoDeclined = 0
  /*
   * ★ 输入被关掉（Ctrl-D / EOF / 上游进程先退出）时，`rl.question()` 会**抛**
   * `ERR_USE_AFTER_CLOSE` —— 于是安装器甩一段 readline 栈就死了。2026-09-13 用 pty 实测复现：
   * 在两个问句之间喂 EOF 就崩在 `wizard.mjs` 的 ask 上。
   *
   * 用户关掉输入不该是崩溃。统一走 `askLine()`：输入已关闭 ⇒ 返回 `null`，
   * 由调用方按"最保守的默认值"处理（是与否 ⇒ 否、路径 ⇒ 默认路径、等待 ⇒ 不等）。
   */
  let inputClosed = false
  rl?.on('close', () => { inputClosed = true })
  /**
   * 统一的提问入口，返回 `null` 表示"输入已经没了"。
   *
   * 三种情形都要盖住（少一种就是崩或挂）：
   *   · 接口**已经关闭** ⇒ `rl.question()` 同步抛 `ERR_USE_AFTER_CLOSE`；
   *   · 提问**进行中**被关掉 ⇒ 某些 Node 版本里那个 promise **永不 settle**（挂死），
   *     所以这里跟 `close` 事件**赛跑**；
   *   · 正常作答 ⇒ 拿到字符串。
   */
  const askLine = async (prompt) => {
    if (rl === null || inputClosed) return null
    let onClose
    const closed = new Promise((resolve) => { onClose = () => { resolve(null) }; rl.once('close', onClose) })
    try {
      return await Promise.race([rl.question(prompt), closed])
    } catch {
      return null
    } finally {
      rl.off('close', onClose)
    }
  }

  const write = (s) => { stdout.write(`${s}\n`) }

  return {
    interactive,
    get autoDeclined() { return autoDeclined },

    info: write,
    blank: () => write(''),
    step: (n, title) => write(`\n▶ 第 ${String(n)} 步 · ${title}`),
    /** 缩进的小字，用于"将要动哪些文件"。 */
    detail: (s) => write(`    ${s}`),
    warn: (s) => write(`⚠️  ${s}`),

    /** 是/否。默认 No。非交互时：--yes ⇒ 是，否则 ⇒ 否（绝不阻塞）。 */
    async confirm(question) {
      if (assumeYes) { write(`? ${question} → yes（--yes）`); return true }
      if (rl === null) { autoDeclined += 1; write(`? ${question} → no（非交互环境，未给 --yes）`); return false }
      const raw = await askLine(`? ${question} [y/N] `)
      if (raw === null) { autoDeclined += 1; write('  （输入已关闭 ⇒ 按默认 No 处理）'); return false }
      const answer = raw.trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    },

    /**
     * 自由输入（可给默认值）。
     *
     * 非交互 ⇒ 直接返回默认值（绝不阻塞）；`--yes` ⇒ 同样返回默认值，但把这件事打出来 ——
     * `--yes` 的语义是"别再逐项问我"，而"装到哪个目录"仍然可以由 `--install-dir` /
     * `--dsh-home` 这类参数表达（参数优先，见 install.mjs）。
     */
    async ask(question, fallback) {
      if (assumeYes) { write(`? ${question} → ${String(fallback ?? '')}（--yes）`); return fallback }
      if (rl === null) return fallback
      const raw = await askLine(`? ${question}${fallback === undefined ? '' : ` [${fallback}]`} `)
      if (raw === null) return fallback
      const answer = raw.trim()
      return answer === '' ? fallback : answer
    },

    /** 读密钥：在终端里不回显（避免 API key 留在屏幕上/滚动缓冲里）。非交互 ⇒ 空串（跳过）。 */
    async secret(question) {
      if (!interactive) { write(`? ${question} →（非交互环境，跳过）`); return '' }
      /*
       * ★ 输入已经没了就立刻收场（2026-09-13 修，PiMoa 第 3 片查出 BLOCKER）。
       *
       * 这里原来只看构造时捕获的 `interactive`。用户在**前面的问句**上按过 Ctrl-D 之后，
       * stdin 的 'end' **已经发过** —— 再 `once('end')` 永不触发，而且不会再有 `data`
       * ⇒ 下面那个 Promise **永不 settle**，安装器就永久僵死在"贴 API key"这一步
       * （不是报错，是僵死；这正是最糟的失败形态）。
       */
      if (inputClosed || stdin.readableEnded === true) { write(`? ${question} →（输入已关闭，跳过）`); return '' }
      stdout.write(`? ${question} `)
      return await new Promise((resolve) => {
        let buf = ''
        const finish = (value) => {
          try { stdin.setRawMode(false) } catch { /* 流已关/不是真终端时会抛，收尾不该因此崩 */ }
          stdin.off('data', onData)
          stdin.off('end', onEnd)
          /*
           * ★ 这里**必须 resume，不能 pause**（2026-09-12 实测的真实挂起 bug）。
           *
           * readline 的 Interface 是在构造时挂在同一个 stdin 上的，后续的
           * `confirm()` / `pause()` 都靠它收数据。原来这里写 `stdin.pause()`，
           * 而**没有任何地方会再 resume** ⇒ 用户一旦粘贴过 API key，
           * 紧接着第 10 步那句"装好了按回车继续"就**永久挂住**（不是报错，是僵死）。
           * 这正是"只有真人跑一次才会暴露"的那类缺陷 —— 靠一个假 TTY 的单测抓到的。
           */
          stdin.resume()
          stdout.write('\n')
          resolve(value)
        }
        const onData = (chunk) => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n') { finish(buf.trim()); return }
            if (ch === '\u0003') { stdin.setRawMode(false); stdout.write('\n'); process.exit(130) }
            if (ch === '\u007f' || ch === '\b') { buf = buf.slice(0, -1); continue }
            buf += ch
          }
        }
        /** stdin 被关掉（Ctrl-D / EOF）⇒ 当"跳过"收场，别让它挂在一个永远不会来的回车后面。 */
        const onEnd = () => finish('')
        /*
         * `setRawMode` 在"不是真终端"或"输入已关闭"时会**抛**（管道、某些代理终端、已 end 的流）。
         * 抛在 Promise executor 里会变成未捕获异常 ⇒ 安装器直接崩。这里退化成"跳过这一步"。
         */
        try {
          stdin.setRawMode(true)
        } catch {
          write(`? ${question} →（拿不到终端原始模式，跳过）`)
          resolve('')
          return
        }
        stdin.resume()
        stdin.on('data', onData)
        stdin.once('end', onEnd)
      })
    },

    /** 等用户按回车（用于"请你去 Chrome 里点完再回来"）。非交互 ⇒ 立刻返回 false（不阻塞）。 */
    async pause(question) {
      if (rl === null) { write(`… ${question}（非交互环境，跳过等待）`); return false }
      const raw = await askLine(`… ${question}（装好了按回车继续）`)
      // 输入被关掉 ⇒ 不再等（返回 false 表示"没等到人按回车"），而不是崩掉
      return raw !== null
    },

    close() { rl?.close() },
  }
}
