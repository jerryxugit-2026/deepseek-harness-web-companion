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
      const answer = (await rl.question(`? ${question} [y/N] `)).trim().toLowerCase()
      return answer === 'y' || answer === 'yes'
    },

    /** 自由输入（可给默认值）。非交互 ⇒ 直接返回默认值。 */
    async ask(question, fallback) {
      if (rl === null) return fallback
      const answer = (await rl.question(`? ${question}${fallback === undefined ? '' : ` [${fallback}]`} `)).trim()
      return answer === '' ? fallback : answer
    },

    /** 读密钥：在终端里不回显（避免 API key 留在屏幕上/滚动缓冲里）。非交互 ⇒ 空串（跳过）。 */
    async secret(question) {
      if (!interactive) { write(`? ${question} →（非交互环境，跳过）`); return '' }
      stdout.write(`? ${question} `)
      return await new Promise((resolve) => {
        let buf = ''
        const finish = (value) => {
          stdin.setRawMode(false)
          stdin.off('data', onData)
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
        stdin.setRawMode(true)
        stdin.resume()
        stdin.on('data', onData)
      })
    },

    /** 等用户按回车（用于"请你去 Chrome 里点完再回来"）。非交互 ⇒ 立刻返回 false（不阻塞）。 */
    async pause(question) {
      if (rl === null) { write(`… ${question}（非交互环境，跳过等待）`); return false }
      await rl.question(`… ${question}（装好了按回车继续）`)
      return true
    },

    close() { rl?.close() },
  }
}
