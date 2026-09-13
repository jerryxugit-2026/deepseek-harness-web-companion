# DSH Web Companion（Antigravity Web Companion）

> **语言**：本插件是**英文版** —— 无论你的 Chrome 界面语言设成中文还是英文，界面文案、报错文案与面向模型的工具说明**都显示英文**（发布的语言包只有 `en`；Chrome 的规则是「找不到匹配语言就退到 default_locale」，所以少发一个包就等于锁死英文）。

> **English**: [`README.en.md`](./README.en.md) —— the same content for English readers / open-source
> visitors. 安装部署也有英文版：[`docs/13-installation.md`](./docs/13-installation.md)。

点一下浏览器按钮即开侧边栏、直接看到**本地 DSH agent**，并把你正在看的网页一键交给他 —— 同时给 agent 读写磁盘、执行命令、反向操作浏览器的能力。

> 设计真源：`详细设计文档.md`（v3.29）。所有结论都带证据标签（【实测】/【源码】/【文档】/【推理】/【目标·未测】）；本 README 只做入口与现状汇总。

## 它长什么样

```
┌─ Chrome ──────────────────────┐        ┌─ 本机 DSH（dsh web） ─────────────┐
│ 侧边栏（panel.html 微壳）      │        │ 桥接插件 dsh-web-companion-bridge │
│  ├ 状态灯 / Attach 网页 / 选区 │←─WS───→│  /ag/agent  /ag/client            │
│  ├ 授权并抓取 / 浏览器控制/写操作│  HTTP  │  /ag/enter /ag/attach /ag/control│
│  └ iframe：真正的 DSH GUI      │←──────→│                                   │
└───────────────────────────────┘        └───────────────────────────────────┘
        │ chrome.scripting / chrome.debugger
        ▼
   左侧当前网页（正文抽取 / 截图 / 可信点击与输入）
```

三条通道刻意分开：`/ag/client`（DSH 页面半通道：抓取推送、意图、ack）、`/ag/agent`（扩展：意图转发、`browser_*` 工具调用）、HTTP 控制面（配对票据、进入握手、运行期开关）。

## 快速开始（推荐：用引导程序）

```bash
cd "dsh project/网页插件"

node bootstrap/install.mjs          # ① 先看它打算做什么（默认 dry-run，不动任何文件）
node bootstrap/install.mjs --apply  # ② 真装（每一步都会单独问你一次）
node bootstrap/doctor.mjs           # ③ 装完随时自查（硬判据 + 一条如实标注的软判据）
```

引导程序会：选安装目录 → 逐项体检依赖（Node 只检测不代装；DSH 缺了可以装）→
接上插件依赖（**链接**到你那份 DSH，不下载）→ 现场构建扩展 → 装 native messaging host →
幂等写 profile 挂载行 → 引导你粘贴 DeepSeek API key → 告诉你 Chrome 扩展怎么点 →
复检并退出。**只考虑 macOS。**

装完后在 `chrome://extensions` 里 **加载已解压的扩展程序** → 选 `<安装目录>/extension/dist`，
点侧边栏图标即可。卸载：`node bootstrap/uninstall.mjs --apply`。

> **完整说明（前置条件 / 十步各动哪些文件 / 依赖为什么是链接 / 排错 / 回滚）见
> `/Users/mac/ai_tools/dsh project/网页插件/docs/13-安装部署.md`。**
>
> 那份文档里的路径**故意写成 `<安装目录>` 这类占位**，因为它是给别人的机器看的 ——
> 硬编码绝对路径正是本次改造要消灭的东西。

<details>
<summary>开发期手工流程（改本插件自身时才需要）</summary>

```bash
npm install                       # 根依赖（含 ws、codegraph；测试/脚本用）
(cd extension && npm install)     # 扩展构建依赖（esbuild）——注意这是**独立的一个包**
node scripts/init-key.mjs         # 生成配对 key（幂等）→ ~/.dsh/dsh-web-companion.json
node native-host/install.mjs      # 安装 native messaging host
npm run build:ext                 # 构建扩展 → extension/dist
dsh web                           # 启动 DSH（web profile，默认 3080）
```

插件安装（开发期）：在 `~/.dsh/profiles/web/cordis.patch.yml` 加一行
`- insert: [{ id: dsh-web-companion-bridge, name: '<绝对路径>/dsh-plugin/src/host/index.js' }]`，
然后重启 `dsh web`。**引导程序做的就是把这行按参数幂等地写进去**，正常用户不需要手改。

</details>

## 现在能做什么（每条都有实测）

| 能力 | 用法 | 证据 |
|---|---|---|
| 侧边栏内嵌真实 DSH GUI | 点图标 → 面板 iframe | E2E-1 真实 GUI 通过 |
| 抓取整页正文为 Markdown | 面板「Attach 网页」/ 右键菜单 | UI 噪音三条启发式 + 占位锚点清理；真站（apexnc.org）实测 |
| 抓取选区 | 先在网页划选，再点「Attach 选区」 | 选区文件仅含选区（282 字），含 `> **用户选区**` 块 |
| 输入框写「看左边」自动抓当前页 | 在 DSH 输入框写「看左边」 | 全链路 22/22（无 `<all_urls>` 授权下）：嗅探 → 转发 → 抓取 → 落盘 → 回推 → 胶囊 + 引用写入当前会话 |
| agent 反向操作浏览器 | 开「浏览器控制」；模型调用 `browser_read/click/type/navigate/tabs/wait/screenshot/ax` | ops 30/30（真 Chrome）：非可信/可信两条路径都真的改变页面，`trusted` 如实标注 |
| 写操作开关 + 审批 | 面板「写操作」开关 | 控制面 11/11：能力集 5↔8 无需重启；`approvalMode` 如实报告（`ask` = 每次先请求批准；`policy-never` = 本会话审批提示被关，写操作会被当场拒绝并说明是策略） |
| 抓取目录不膨胀 | 自动（每次落盘后清扫 24h 前的本插件文件） | 单测 19 断言 + 现场断言（25h 前文件被清、用户文件保留） |

## 安全模型（三道闸门 + 一条保留策略）

1. **配对**：`key + 精确扩展 Origin`（F2/F3），iframe 用一次性 ticket（30s、单次）而非长期 key；DSH 自身 `/api` 围栏**未**被削弱。
2. **写操作三层**：`allowBrowserWriteOps=false` 时写类工具**不注册**（模型看不见）→ 扩展对同一帧复核（`E_READONLY`）→ `tools/pre-execute` waterfall 交给 DSH 审批逐次批准。
3. **调试器**：`debugger` 是必需权限（Chrome 拒绝 optional，ADR-12），但**默认不 attach**，由「浏览器控制」开关决定，关闭即释放。
4. **保留策略**：每次落盘后清掉同目录 24h 前**本插件命名**的文件；用户自己放进目录的文件永不删。

## 测试与门禁

```bash
npm run check          # 七道门：协议一致性 → 图谱同步 → 文档图谱 → 反模式黑名单 → 协议契约 → 单测 → 构建
npm run check:strict   # 交付前：文档图谱逐字节比对

npm run test:unit              # tickets + retention + frame-budget + browser-tools + write-gate
npm run probe:look-left        # 「看左边」桥接跳（11 断言，需 dev 实例）
npm run probe:look-left-e2e    # 「看左边」全链路（16 断言，真 Chrome）
npm run probe:capture          # 抓取：整页/选区/噪音/硬化/保留（真 Chrome）
npm run probe:m3-ops           # 浏览器 op 层（31 断言，真 Chrome）
npm run probe:m3-control       # 写操作开关控制面（10 断言，真 Chrome + dev 实例）
npm run probe:m3-debugger      # debugger 能力前置（14 断言）
npm run probe:sites            # 五类页面抓取质量回归（真 Chrome，本地夹具）
npm run probe:all              # 一条命令跑完全部 Chrome 探针（自己拉 dev 实例）
npm run audit:captures         # 用真实抓取文件做质量审计
```

需要 dev 实例的探针先跑：`DSH_HOME="$PWD/.devhome" dsh web --no-open --port 3099 &`。

## 目录结构

```
protocol/          单源协议（messages.schema.json → codegen 生成三份产物 + 契约测试向量）
dsh-plugin/        桥接插件：host 半（路由/hub/工具/保留策略）+ client 半（DSH 页面内）
extension/         MV3 扩展：sw（抓取、ops）/ content（抽取器）/ sidepanel（微壳 + agent 通道）
native-host/       native messaging host（自动拉起 dsh web）
scripts/           配对、文档图谱、反模式黑名单、PiMoa 对抗审核
tests/             单测 + 各里程碑探针（m0a/m0b/m1/m2/m3）
docs/              分册文档、研究、审核记录、探针报告
```

## 已知限制（诚实清单）

- **多站点抓取质量**：启发式是保守的；导航型短链接列表在某些站点仍可能被误删（可用 `stripChipRows: false` 等开关逐条关闭）。
- **`browser_screenshot` 的工具结果给的是文件路径**，不是图片块：像素落 `<workspace>/网页捕获/assets/`，避免猜 DSH 图片块的形状。
- **意图抓取依赖扩展侧授权**：未授予 `<all_urls>` 时，只能抓已持 host 权限的站点（如 `127.0.0.1`）；面板会给出可操作的提示。
- **胶囊**已由 DSH 自己的 `conversation.input.dock` 插槽渲染；`inject` 只保证"等声明"，若声明未出现则回退到 DOM 条带（`__AG_CLIENT__.chips()` 的 `host` 字段会说明是哪种）。
- **CI 尚未接入**：`npm run check` 可直接进 CI；`npm run probe:all`（7 个 Chrome 探针）需要一台带 Chrome 与本机 DSH 的机器，目前在本地跑。

## 相关文档

- `/Users/mac/ai_tools/dsh project/网页插件/docs/13-安装部署.md` —— **安装部署引导程序**（十步说明 / 依赖策略 / 排错 / 回滚）
- `/Users/mac/ai_tools/dsh project/网页插件/详细设计文档.md` —— 架构、ADR、协议、模块、测试方案、安全模型、里程碑
- `/Users/mac/ai_tools/dsh project/网页插件/docs/11-台账.md` —— **对照设计的完成度台账**（哪些完成 / 哪些改了实现方式 / 哪些没做 + 证据索引）
- `/Users/mac/ai_tools/dsh project/网页插件/docs/HANDOFF.md` —— **交接提示词**（可直接粘贴给新会话）+ 避坑清单
- `/Users/mac/ai_tools/AGENT-SEARCH-TOOLS.md` —— **本机检索规范（唯一真源）**：文档问题走 semble、代码问题走 codegraph；本项目一切检索都要按它执行
- `/Users/mac/ai_tools/dsh project/网页插件/docs/CHANGELOG.md` —— 每个版本改了什么、为什么（含被推翻的结论）
- `/Users/mac/ai_tools/dsh project/网页插件/docs/reviews/` —— 探针报告与对抗审核结论
- `/Users/mac/ai_tools/dsh project/网页插件/docs/09-manual-checklist.md` —— 人工验收清单
- `/Users/mac/ai_tools/dsh project/网页插件/docs/10-automation.md` —— 自动化分层
