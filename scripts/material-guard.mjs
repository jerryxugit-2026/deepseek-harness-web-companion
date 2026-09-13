/**
 * 材料卫生守卫：**绝不允许把本机密钥当审核材料外发**。
 *
 * 由来（真事故，2026-09-12）：驱动脚本 `scripts/pimoa-review.mjs` 会把 `--context` 列出的文件
 * **逐字**读进来、作为材料交给 PiMoa，而 `moa_verify` 会把材料送给模型厂商（实测
 * `models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3`）。我给的分片命令里有 `scripts/`，
 * 于是 `scripts/.dev-extension-key.json` —— 里面是 **RSA-2048 私钥**（`privateKeyPem`）与
 * `publicKeyDer`，而后者与 `extension/manifest.json` 的 `key` 逐字相同、推导出的扩展 ID
 * 正是 `idpgkobbblmpmnonlndopijgfmehfmig` —— 被当成审核材料发了出去。**密钥外泄。**
 *
 * 这类事故的形态与设计 §9/T2 早就点名的一样（"开发期把密钥文件误提交/误外发是本机高频事故模式"），
 * 但当时只防了 git（`.gitignore`），没防"把文件喂给外部模型"这条等价出口。
 *
 * 本模块的作用：在**发出任何网络请求之前**检查材料清单，命中即拒绝并列出文件名。
 * 判定双保险：
 *   1. 路径黑名单（密钥文件、配对文件、dev 配置、凭据、`.devhome/`、`*.pem`/`*.key`）；
 *   2. 内容嗅探（PEM 私钥头、`privateKeyPem` 这类字段名）—— 路径可以改名，内容骗不过去。
 *
 * 故意**没有**"强制放行"开关：这种检查一旦可以被随手绕过，就等于没有。
 */

/** 路径黑名单：命中即拒绝（不看内容）。 */
export const SECRET_PATH = /(\.dev-extension-key\.json|dsh-web-companion\.json|dev-config\.js|\.credentials\.yaml|(?:^|\/)\.devhome\/|\.pem$|\.key$|(?:^|\/)id_rsa)/u

/**
 * 内容嗅探：**真实密钥块**（PEM 头 + 实际 base64 正文，或私钥字段带着长值）。
 *
 * 路径改名也拦得住。注意这里的"长度下限"是刻意的：早先只匹配裸关键词（`"privateKeyPem"`），
 * 于是**本守卫自己的源码与它的单测**（里面有正则字面量和伪造夹具）也被自己的规则拦住，
 * 那两个文件反而进不了任何审查材料（2026-09-12 实测）。要求"关键词后面真跟着一长串 base64"
 * 就把"描述密钥的东西"和"真的密钥"分开了。
 */
export const SECRET_CONTENT = /(-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]{0,120}?[A-Za-z0-9+/]{120,}|"private(?:KeyPem|_key)"\s*:\s*"[A-Za-z0-9+/=\\-]{120,}")/u

/**
 * 找出材料清单里不该外发的文件。
 *
 * @param {string[]} paths 材料文件路径（相对或绝对）
 * @param {(path: string) => string} read 读取文件内容的函数（便于单测注入；读取失败应抛错）
 * @returns {{ path: string, why: string }[]} 违规清单（空数组 = 干净）
 */
export function findSecretFiles(paths, read) {
  const offenders = []
  for (const path of paths) {
    if (SECRET_PATH.test(path)) {
      offenders.push({ path, why: '路径命中密钥/凭据黑名单' })
      continue
    }
    let text
    try {
      text = read(path)
    } catch {
      // 读不到就不在这里报错：交给调用方的正常报错路径（本模块只管"能不能外发"）
      continue
    }
    if (SECRET_CONTENT.test(text)) offenders.push({ path, why: '内容里出现私钥标记/私钥字段' })
  }
  return offenders
}

/** 把违规清单渲染成可读的拒绝信息。 */
export function describeOffenders(offenders) {
  return [
    '✗ 拒绝外发：材料里含密钥/凭据文件，已在上网之前中止。',
    ...offenders.map((entry) => `    - ${entry.path}（${entry.why}）`),
    '  这些文件会把私钥/配对密钥送给模型厂商（PiMoa 的 moa_verify 会把材料外发）。',
    '  请从 --context 列表里剔除它们（例如 find ... | grep -v dev-extension-key），再重跑。',
    '  本检查故意没有强制放行开关。',
  ].join('\n')
}
