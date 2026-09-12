# 自动化分层：哪些能无人值守，哪些必须有人（M4-3）

> 结论先行：**核心质量门禁完全可以无人值守**（协议一致性、单测、构建、文档一致性、真实文件审计）；
> **Chrome 探针需要一个浏览器和本机 DSH**，但**不需要人**；只有**三类**事必须由人做 ——
> 用户手势、有头环境判断、以及"这份内容有没有用"的品味判断。

## 第 0 层：纯静态，零依赖（任何环境都能跑）

```bash
npm run protocol:check      # 协议 schema 与三份生成物逐字节一致（含 sha256）
npm run check:consistency   # 反模式黑名单（19 条规则：被推翻的旧说法不得复活）
npm run graph:check         # 文档图谱逐字节一致（check:strict 用）
npm run test:protocol       # 契约测试：正向量 21 / 反向量 11 / 三份产物
npm run test:unit           # 单测：tickets / retention / frame-budget / browser-tools / write-gate / panel-errors
npm run build:ext           # 扩展构建（含体积门禁 G6 ≤ 1MB）
```

一条命令：`npm run check`（上述全部 + 文档图谱同步）。**这就是 CI 该跑的东西**，不需要 Chrome、不需要 DSH、不需要网络。

## 第 1 层：需要本机 DSH，但不需要浏览器

```bash
DSH_HOME="$PWD/.devhome" dsh web --no-open --port 3099 &
npm run audit:captures -- --dir ".devhome/workspace-m0a/网页捕获"   # 真实抓取文件的质量审计
curl -s http://127.0.0.1:3099/ag/ping                                # 配对/能力集自检
```

## 第 2 层：需要 Chrome（但不需要人）

```bash
npm run probe:all            # 自己拉 dev 实例，按顺序跑下面全部（结束后只杀自己拉的）
```

内部顺序（越靠后越"重"）：

| 探针 | 覆盖 | 需要 |
|---|---|---|
| `probe:m3-debugger` | debugger 权限声明方式、AX 树、可信输入、截图 | Chrome |
| `probe:look-left` | 意图 → 队列 → 补发 → 转发 → 回执 → 403 | DSH |
| `probe:capture` | 整页 / 选区 / **空选区拒绝** / 噪音 / 硬化 / 保留策略 | DSH + Chrome |
| `probe:sites` | 五类页面质量回归（本地夹具，不依赖外网） | DSH + Chrome |
| `probe:m3-ops` | 七个 op、写操作门禁、可信/非可信两条路径 | DSH + Chrome |
| `probe:m3-control` | 写操作开关控制面（能力集 5↔8 无重启） | DSH + Chrome |
| `probe:look-left-e2e` | 「看左边」全链路（嗅探→抓取→落盘→回推→胶囊→引用） | DSH + Chrome |

**不在 `probe:all` 里的探针**（它们会碰真实环境，必须由人决定何时跑）：

| 探针 | 为什么单独 |
|---|---|
| `probe:autostart` / `native-headed-probe` | 会启停真实 `dsh web`、读写 `~/.dsh`、触碰真实 Chrome profile |
| `probe:panel` / `probe:composer` / `probe:cookies` / `probe:keepalive` | M0/M1 的一次性测量（平台事实），结论已固化进设计文档，不需要每次回归 |

## 第 3 层：必须由人做（`docs/09-manual-checklist.md`）

1. **用户手势**：`chrome.permissions.request` 只能由真实点击触发（无手势会抛 `must be called during a user gesture`）→ 授权弹窗的**允许 / 拒绝 / 撤销**三个分支只能人点。
2. **有头环境判断**：调试器「正在调试」横幅是否存在、DSH 审批弹窗的实际批准/拒绝交互、原生通知类行为 —— 无头 Chrome 不呈现这些 UI。
3. **品味判断**：抓取出来的内容"有没有用"（正文是否完整、导航残留是否可接受）。机器只能断言结构（`probe:sites`）与计数（`audit:captures`），判不了"这份够不够好"。

## 现在的实测状态（截至 v3.32）

| 层 | 状态 |
|---|---|
| `npm run check` | ✅ 全绿（协议 / 19 条规则 / 6 个单测文件 / 构建 / G6） |
| `npm run probe:all` | ✅ 7 个探针全绿（见 `docs/reviews/*.json`） |
| 人工清单 | ⏳ 待用户在重启 + 刷新扩展后执行（清单已就绪） |

## CI 落地建议（尚未接入真实 CI，诚实标注）

`npm run check` 可以直接进任何 CI；`probe:all` 需要一台带 Chrome 与本机 DSH 的机器（当前只有你这台 Mac 满足），所以现状是**本地跑**。要接 CI 需要解决两件事：① 一个能装 Chrome 的 runner；② DSH 的安装与 native host（后者在容器里通常不可用，可让探针走"复用已在跑的实例"分支，即不带 `DSH_HOME` 也能跑第 0/1 层）。
