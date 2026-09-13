# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`tests/m0a/composer-probe.mjs`、`tests/m0a/cookie-ext/manifest.json`、`tests/m0a/cookie-ext/probe.js`、`tests/m0a/cookie-matrix.mjs`、`tests/m0a/ext/manifest.json`、`tests/m0a/ext/panel.js`、`tests/m0a/ext/sw.js`、`tests/m0a/keepalive-ext/manifest.json`、`tests/m0a/keepalive-ext/page.js`、`tests/m0a/keepalive-ext/sw.js`、`tests/m0a/keepalive-probe.mjs`、`tests/m0a/permission-probe.mjs`、`tests/m0b/attach-probe.mjs`、`tests/m0b/chip-probe.mjs`、`tests/m1/panel-probe.mjs`
- prompt：`scripts/review-prompts/code-review.md`
- 用时：308.8s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:46:12.799Z

---
【最终裁决·前置（由服务端代码从正文末尾抽出，正文顺序未变）】
# 三、【最终裁决】

这批 M0a/M0b/M1「探针」不是测试，是**带 JSON 报告的现象记录器**：七个脚本里没有一处 `assert`，没有一处非零退出，`attach-probe` 唯一的失败过滤器还因 `v === 'error:'` 的字面量比较而恒不命中；文件头逐条写明的期望（403 / 413 / 400、marker 入 DOM、sw 死 / page 活、ticket 不泄密钥）一个都没有落成判定。因此"已验证"这一自我评价在代码层面不成立——它们证明的是「流程跑完了」，不是「行为正确」。叠加白盒钩子代偿真实路径（`__AG_CLIENT__.dismiss()` 顶替点击 ✕、`__AG_PROBE_WRITE__` 顶替真实 attach→草稿链路）与 `composer-probe` 漏抄 `Cdp.on()` 导致控制台错误被全量吞掉，这套门禁在 client 半启动失败、推送丢失、鉴权放行、图像准入失校的情况下**仍会全绿**。硬编码层面（6 份 macOS Chrome 绝对路径、3099/3080 两套默认端口、扩展内写死 PORT、cookie 名算法与 installCookie 双份实现、workspace 路径双份且拼写相反）则决定了这批探针从未在 CI 上跑过，只能在作者本机复现。

**若只能修 3 处：**
1. **给所有探针装上真判定与非零退出**——先修 `attach-probe.mjs` 的 `v === 'error:'` 与恒 `exit(0)`，把文件头声明的 403/413/400、`pushedEvents > 0`、`pendingDrain[0].captureId === 'M0B-PROBE-B'` 全部改成硬断言。这一处把"记录器"变回"门禁"，B 类问题过半连带解决。
2. **`composer-probe.mjs` 补回 `Cdp.on()` 事件监听并加 `domContainsMarker` 断言**——让控制台错误不再被吞（`consoleLines`/`errors` 当前恒空），并断言写入后的编辑器正文必须包含 `M0B-DOM-MARKER`、`hasAuthenticationText` 必须为 false。这一处直接堵死"白盒钩子自检"这一最危险的假绿。
3. **`chip-probe.mjs` 的撤销改为点击 DOM 上的 ✕ 而非 `__AG_CLIENT__.dismiss()`，胶囊/草稿状态改从真实 DOM 读取**，`__AG_CLIENT__` 只用作辅助诊断。这一处让 E2E-0 闭环第一次真正走用户路径。

（`CHROME` 路径与端口硬编码建议同批处理：改为 `process.env.CHROME_BIN ?? 平台默认`、端口统一由单一常量/参数下发到扩展内，否则上述三处修完仍只有作者一台机器能验证。）

# 一、【冲突点与采信】

| # | 分歧点 | 各方主张 | 采信 | 理由 |
|---|---|---|---|---|
| 1 | 被审代码是否存在于当前仓库 | P1（deepseek）：`rg --files` 证明 `tests/m0a/**`、`tests/m0b/**`、`tests/m1/panel-probe.mjs` 在 cwd `/Users/mac/ai_tools/PiMoa` 内不存在，仓库是 PiMoa（MCP/MoA），无 `extension/`、`dsh-plugin/`、`native-host/`；P2（MiniMax）：默认存在并按其审查 | **采信 P1 的事实** | 可核对的负向检索证据强于默认假设；本会话内确实无法 `node tests/m0a/composer-probe.mjs` 复现 |
| 2 | 事实如此是否就该拒审 | P1：拒审，要求先对齐路径；P2：照审 | **采信 P2 的做法** | 任务上下文已**逐字给出**全部 12 个文件的源码，代码审查的对象是文本本身；拒交清单等于放弃可做的工作。正确姿态＝按粘贴源码审 + 声明不可执行验证 |
| 3 | 行号可信度 | P2 给出精确 `文件:行号`；P1 指出行号无法对应任何可执行文件 | **采信 P1** | P2 的行号无一可核（例如它自称引用 `permission-probe.mjs:30-31` 却写出并不存在的 `'/tmp/m2-permission-ext'` 再自行更正）。本报告一律改用**逐字片段**定位，行号标注为「粘贴文本中」 |
| 4 | CHROME 路径硬编码处数 | P2：4 处 | **修正为 6 处** | composer-probe / cookie-matrix / keepalive-probe / permission-probe / chip-probe / panel-probe 各一处，逐字同串 |
| 5 | `keepalive-ext/sw.js` 的 `const PORT = 3099` 定级 | P2：BLOCKER | **降为 MAJOR** | 只影响探针自身可移植性，且与其它默认端口一致；不改变产物行为 |
| 6 | CDP `userGesture:true` 是否被 Chrome 当作真实手势 | P2：断言「Chrome 不承认」 | **判为可疑，不采信该断言** | CDP `Runtime.evaluate` 的 `userGesture` 确实会赋予渲染进程瞬时激活；P2 无证据。但它指出的**用例顺序污染**成立，保留该部分 |
| 7 | composer-probe 与 chip-probe 之间「第一次会话被第二次替换」 | P2：已确认 | **降为【可疑待验】并改述** | Chrome profile 互相隔离（P2 自己也承认），真正问题是两脚本按**文本 `'新会话'`** 定位行，多次运行后侧栏出现多行同名，`.find()` 取首个 → 可能操作旧会话 |
| 8 | attach-probe 的失败判定 | 双方均未发现 | **补充为 BLOCKER** | `filter(([, v]) => v === false \|\| v === 'error:')` 中 `'error:'` 是字面量，永不匹配 `error:${msg}`；且末尾恒 `process.exit(0)` |
| 9 | 鉴权/限额用例的期望值 | 双方均未发现 | **补充为 BLOCKER** | 文件头宣称「无 key → 403；超大 → 413；schema 拒 → 400」，代码只 `record(status)`，从不与期望值比较 |
| 10 | 假 PNG 的 `bytes: 24` | P2 只说「是假数据，不致命」 | **升级并给出硬证据** | `'iVBORw0KGgoAAAANSUhEUg=='` 解码仅 16 字节，与声明的 `bytes: 24`、`1280×800` 全部互斥；探针能过 ⇒ 宿主的图像准入校验实际未被触及 |

一致判断（无分歧部分）：两方都认同「不能把文档/报告的自我评价当事实」；本报告的所有结论只来自粘贴源码。

---

# 二、【逐条裁决】

**BLOCKER**

| 级别 | 文件#位置 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| BLOCKER | `tests/m0b/attach-probe.mjs` # 收尾判定 | 亲验（粘贴源码） | 失败过滤器写死字面量 `'error:'`，且无论如何都 `exit(0)`，探针在结构上无法变红 | `const failed = Object.entries(results).filter(([, v]) => v === false \|\| v === 'error:')` + `process.exit(0)` |
| BLOCKER | `tests/m0b/attach-probe.mjs` # 第 6 步鉴权段 | 亲验 | 文件头声明的 403/413/400 期望值一次都没被断言，只 `record` 状态码；host 若返回 200 同样"通过" | `record('noKey', (await post('/ag/attach', capturePayload('C'))).status)`、`record('oversize', oversize.status)` |
| BLOCKER | `tests/m0a/composer-probe.mjs` # `uiDriven.markerWrite` / `domAfterWrite` | 亲验 | 写入 `'M0B-DOM-MARKER'` 后抓了 `innerText` 却从不比较是否包含该 marker，M0b 断言②退化为「钩子存在且编辑器存在」 | `text: (document.querySelector('[contenteditable], textarea')?.innerText ?? …).slice(0, 200)`（全文无 `includes('M0B-DOM-MARKER')`） |
| BLOCKER | `tests/m0b/chip-probe.mjs` # 第 5 步「✕ 撤销」 | 亲验 | 宣称验证「✕ 移除胶囊」，实际调用白盒方法而非点击 DOM 上的 ✕，真实用户路径（事件绑定/冒泡/ack 触发点）完全未被覆盖 | `await evaluate(\`globalThis.__AG_CLIENT__.dismiss(${JSON.stringify(captureId)})\`)` |
| BLOCKER | `tests/m0b/chip-probe.mjs` # 第 4 步断言源 | 亲验＋推理 | 胶囊、投递、ack 三项全部读自同一个 `__AG_CLIENT__` 白盒镜像，循环退出条件即断言条件，若镜像是 client 半自维护副本则整段是自检 | `chips: globalThis.__AG_CLIENT__?.chips?.() ?? []` … `if ((chipState?.chips ?? []).length > 0) break` |

**MAJOR**

| 级别 | 文件#位置 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| MAJOR | `tests/m0a/composer-probe.mjs` # `Cdp` 类 | 亲验 | 该类丢弃所有无 `id` 的事件且没有 `on()`（`keepalive-probe.mjs` 的同名类才有），`consoleLines`/`errors` 恒为空数组却写进报告，client 半 boot 报错会被静默吞掉 | `if (m.id === undefined) return` + `const listenerSocket = browserWs; void listenerSocket`（注释却写 "collect console/log events through a listener"） |
| MAJOR | `tests/m0a/composer-probe.mjs` # 等待循环 | 亲验 | `done` 永不到来时仍在第二分支保存 `probe` 并照常出报告，异步步骤缺失表现为"绿" | `if (parsed.probe !== null && parsed.probe.length > 0) probe = parsed` |
| MAJOR | `tests/m0a/composer-probe.mjs` # `errorTexts` | 亲验 | 采集了 `hasAuthenticationText` 却无任何检查，页面显示「authentication required」时报告依旧成立 | `hasAuthenticationText: text.includes('authentication required')`（无消费方） |
| MAJOR | `tests/m0b/attach-probe.mjs` # 第 3 步推送等待 | 亲验 | 只等 20×150ms≈3s，`record('pushedEvents', 0)` 中的 0 不等于 `false`，推送彻底失败也不进失败列表 | `for (let i = 0; i < 20 && received.length === 0; i += 1) await sleep(150)` |
| MAJOR | `tests/m0b/attach-probe.mjs` # 第 5 步离线队列 | 亲验 | 只比较 `items.length`，从不校验排队项的 `captureId`/`fileRef`，host 丢字段或串号照样过 | `record('pendingDrainCount', Array.isArray(pendingDrain.items) ? pendingDrain.items.length : pendingDrain)` |
| MAJOR | `tests/m0b/attach-probe.mjs` # `capturePayload.media` | 亲验（元数据自相矛盾）＋待验（host 行为） | `base64` 解码仅 16 字节，与 `bytes: 24`、`width/height 1280×800` 互斥；探针能通过说明图像准入的尺寸/大小校验根本没被执行 | `screenshot: { mime: 'image/png', base64: 'iVBORw0KGgoAAAANSUhEUg==', width: 1280, height: 800, bytes: 24 }` |
| MAJOR | `tests/m0a/keepalive-probe.mjs` # `swPing` / 报告 | 亲验 | `catch` 分支返回 `swAlive: true`，`swAlive:false` 只代表"没找到 target"，无法区分"从未唤醒"与"被回收"；且全程无断言，两边都活/都死都出报告 | `catch (error) { return { swAlive: true, error: String(error).slice(0, 120) } }`、`interpretation: { swSocket: 'see [keepalive-sw] lines …' }` |
| MAJOR | `tests/m0a/keepalive-ext/sw.js` + `page.js` # `const PORT = 3099` | 亲验 | 端口在扩展内写死两份，而 `keepalive-probe.mjs` 连 `--port` 参数都没有；端口错配的表现与"worker 被回收"完全同形，直接污染 Q8 结论 | `const PORT = 3099`（sw.js 与 page.js 各一份） |
| MAJOR | `tests/m0a/cookie-matrix.mjs` # `controlFor` 内联表达式 | 亲验 | 把 `cookie-ext/probe.js` 的 `cookieNameForAuthority` + `installCookie` 整体复刻一遍且丢掉 `partitioned` 分支，两份实现必然漂移；cookie 名算法一旦与 DSH 服务端不符，全矩阵会一致地"测不到 cookie"却被当成结论 | 内联 `const name = 'dsh-auth-' + b64` 与 `${variant === 'strict' ? "details.sameSite = 'strict'" : "details.sameSite = 'no_restriction'; details.secure = true"}` |
| MAJOR | `tests/m0a/cookie-matrix.mjs` # 扩展 ID | 亲验 | `loadedId` 与 pairing 文件里的 `PINNED_EXT_ID` 只打印不比较，二者不同即意味着矩阵测的是宿主并未白名单的扩展来源 | `console.log(\`[cookie-matrix] extension loaded id=${loadedId} (pinned=${PINNED_EXT_ID}) …\`)` |
| MAJOR | 全部探针 # `CHROME` 常量 | 亲验 | 6 个文件逐字重复 macOS 绝对路径且无回退，非 macOS 环境下 `npm run probe:*` 一条都跑不了，说明这批"验证"从未在 CI 上执行过 | `const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'`（×6） |
| MAJOR | `panel-probe.mjs` vs 其余探针 # 默认端口 | 亲验 | `argOf('port', '3080')` 与其余 `'3099'` 并存，无任何机制防止探针连错实例；连错时表现为"页面没起来"而非报错 | `const DSH_PORT = argOf('port', '3080')` ↔ `const DSH_PORT = argOf('port', '3099')` |
| MAJOR | `tests/m0a/permission-probe.mjs` # 用例顺序 | 亲验 | B→A→A2→C 之间从不复位权限，C（设计关键用例）在代码注释里就承认跑在不确定状态上；A2 的"真点击"结论被前序调用污染 | `// C: gesture-less capture with whatever grant state we ended up in` |
| MAJOR | 各探针 # `?key=<长期密钥>` 放进 URL | 亲验（探针）＋待验（host） | `panel-probe` 专门断言 iframe URL 不得含 `key=`，而 attach/ack/pending/whoami/agent 全部把长期密钥放在 query（会进访问日志/Referer），安全约束在两条路径上不一致 | `fetch(\`${ORIGIN}/ag/attach?key=${encodeURIComponent(KEY)}\`…)` ↔ `record('frameSrcLeaksKey', /[?&]key=/u.test(…))` |
| MAJOR | 探针依赖的 `/ag/whoami`、`/ag/wsprobe`、`/ag/probe-page`、`/ag/wsecho` | 推理（host 源码未提供） | 这四个纯测试端点必须存在于 DSH 插件宿主：若随发布产物一起上线＝测试脚手架进生产；若仅 dev 存在＝探针测的不是生产路径。两种都是缺陷，需查 host 路由注册 | `new WebSocket(\`${WS_ORIGIN}/ag/wsprobe\`)`、`ws://127.0.0.1:${PORT}/ag/wsecho`、`${ORIGIN}/ag/probe-page?t=…` |
| MAJOR | `composer-probe.mjs` / `chip-probe.mjs` # UI 驱动逻辑 | 亲验（重复）＋待验（后果） | 「选择工作区→m0a-workspace→新会话→点行」整段逐字重复两份，且按精确文本 `'新会话'` 定位；多次运行后侧栏出现多行同名，`.find()` 取首个 → 可能写进旧会话 | `[...document.querySelectorAll('span[class*="_title"]')].find((el) => (el.textContent ?? '').trim() === '新会话' …)`（两文件各一份） |
| MAJOR | `tests/m1/panel-probe.mjs` # `unauthorized` 判定 | 推理（需 host `/ag/enter` 源码） | 仅以正文是否含 `'authentication required'` 判定鉴权成功；若 ticket 失效时 host 返回 200＋登录页，断言漏报，且全文同样只 record 不 assert | `unauthorized: (document.body?.innerText ?? '').includes('authentication required')` |

**MINOR**

| 级别 | 文件#位置 | 证据 | 一句理由 | 可核对片段 |
|---|---|---|---|---|
| MINOR | `composer-probe.mjs` # 死变量群 | 亲验 | `readFileSync2` / `origSend` / `listenerSocket` 三处 `void` 占位，是 `Cdp` 类漏抄 `on()` 的直接痕迹（故与上文 MAJOR 同源，非纯风格） | `void readFileSync2`、`void origSend`、`void listenerSocket` |
| MINOR | `keepalive-ext/sw.js` # 无意义 URL 解析 | 亲验 | `new URL('http://x/').search` 恒为空串，是"本该从参数取端口"的残骸，与写死 PORT 呼应 | `const params = new URLSearchParams(new URL('http://x/').search)` / `void params` |
| MINOR | `attach-probe.mjs` / `chip-probe.mjs` / `panel-probe.mjs` # `record` 打印 | 亲验 | `JSON.stringify(undefined)` 返回 `undefined`，字段随后在报告 JSON 里整条消失，"未断言"被读成"没问题" | `const printed = JSON.stringify(value) ?? String(value)` |
| MINOR | `panel-probe.mjs` # 密钥泄漏检测 | 亲验 | 正则只覆盖 `?key=`/`&key=`，hash 片段 `#key=` 漏检 | `/[?&]key=/u.test(String(panel?.frameSrc ?? ''))` |
| MINOR | `panel-probe.mjs` # null 归一 | 亲验 | `?? null` 让"面板未起来"与"iframe 尚未赋值"在报告里同形，无法定位失败原因 | `record('panelStatus', panel?.status ?? null)` |

⚠️ [正文 11129 字符超回包预算 10000，已按行截取前 9839 字符（头部已前置【最终裁决】段）；全文见 /Users/mac/.pimoa/spool/20260912T064612-moa_verify-51771-kszssx-64c0d3fa116a.md（sha256=628c89ce3372…，54824 字节，保留至 2026-09-26），可用 Read 分段读取]

[moa ok] mode=verify preset=moa_verify quorum=2/2 models=deepseek/deepseek-v4-flash,minimax/MiniMax-M3 aggregator=cliproxy/claude-opus-5 cost=$0.0000 body_sha256=64c0d3fa116a… audit=/Users/mac/.pimoa/spool/20260912T064612-moa_verify-51771-kszssx-64c0d3fa116a.md
