# 07 · 实现计划（任务分解与完成判据）

**用法**：按任务编号顺序执行；每个任务的「完成判据」必须实际跑过（不是「应该能跑」）。任务之间标注依赖，无依赖的可并行。
**约定**：`EXT/` = `extension/`，`PLUG/` = `dsh-plugin/`，`NH/` = `native-host/`，`PROTO/` = `protocol/`，`E2E/` = `tests/e2e/`。

---

## M1 · 骨架与认证（目标：侧边栏里出现可用的 DSH 界面）

| # | 任务 | 产出文件 | 依赖 | 完成判据 |
|---|---|---|---|---|
| 1.1 | 单源协议 schema + codegen | `PROTO/messages.schema.json`、`PROTO/codegen.mjs`、`PROTO/vectors/*` | — | `node PROTO/codegen.mjs` 生成三端产物；`test:protocol` 全绿（含 sha256 同步） |
| 1.2 | 扩展骨架与权限清单 | `EXT/manifest.json`、`EXT/src/sw/index.js`、`EXT/src/sidepanel/panel.{html,css,js}`、`EXT/src/lib/{urls,cookie,result,ids}.js` | 1.1 | 无报错加载进 Chrome；`chrome://extensions` 无警告；面板能打开且显示状态点 |
| 1.3 | 桥接插件骨架 + 路由 | `PLUG/package.json`、`PLUG/build.mjs`、`PLUG/src/host/{index,config,guard,key-store}.ts`、`routes/ping.ts` | 1.1 | `dsh plugin --profile web add ./dsh-plugin` 后 `GET /ag/ping` 带正确 key+Origin 返回 200；错误 key/Origin 返回 403 |
| 1.4 | cookie 签发 + 握手路由 | `PLUG/src/host/cookie.ts`、`routes/enter.ts`、`PLUG/tests/host/cookie.vector.test.ts` | 1.3 | 固定向量测试逐字节相等；真实 `GET /ag/enter` 返回 303 + `SameSite=None; Secure` |
| 1.5 | 面板 iframe 嵌入 + 探针降级 | `EXT/src/sidepanel/iframe-host.js`、`EXT/src/sw/dsh-session.js` | 1.2, 1.4 | **E2E-1 通过**；若把 cookieMode 改成 strict 则复现 `connection lost`（反向验证，证明判据有效） |
| 1.6 | M1 回归基线固化 | `E2E/harness/*`、`E2E/cases/e2e1-embed.mjs`、`E2E/cases/e2e10-regression-baseline.mjs` | 1.5 | `npm run test:e2e -- --case e2e1,e2e10` 全绿；产物含截图与 HTTP 状态图 |

**M1 退出条件**：E2E-1 + E2E-10 通过；面板里能完成一次真实对话（人工确认一次即可）。

---

## M2 · 上下文（抓取 → 落盘 → 胶囊）+ 自动拉起

| # | 任务 | 产出 | 依赖 | 完成判据 |
|---|---|---|---|---|
| 2.1 | 正文抓取与 Markdown | `EXT/src/content/extract.fn.js`、`markdown.js`、`EXT/src/sw/capture.js` | 1.2 | `markdown.test.js`/`extract.test.js` 全绿（≥13 用例）；真实长文抓取 ≤120k 字符 |
| 2.2 | 选区与截图 | `EXT/src/content/content.js`（选区缓存+浮标）、`capture.js` 截图分支 | 2.1 | 选区 attach 内容与所选一致；截图 attach 拿到 PNG（**E2E-3/4**） |
| 2.3 | attach 路由 + 落盘 | `PLUG/src/host/routes/attach.ts`、`store.ts` | 1.3, 2.1 | `routes.attach.test.ts`+`store.test.ts` 全绿；真实工作区出现带 front-matter 的 md |
| 2.4 | WS hub + 客户端通道 | `PLUG/src/host/hub.ts` | 1.3 | `hub.test.ts` 全绿；`/ag/client` 推送可被测试客户端收到 |
| 2.5 | client 插件：composer 注入 + 胶囊 | `PLUG/src/client/*` | 2.4, docs/04 §7 调研结论 | `composer-insert`/`chip` 单测全绿；**E2E-5 通过**（胶囊出现、✕ 移除、ack） |
| 2.6 | 面板工具栏与胶囊同步 | `EXT/src/sidepanel/toolbar.js`、`EXT/src/sw/attach-sender.js` | 2.3, 2.5 | 三粒度按钮均可点；成功后胶囊出现；失败有明确错误文案 |
| 2.7 | native host + 自动拉起 | `NH/*` | 1.2 | `NH/tests` 全绿；**E2E-8 通过**（杀掉 DSH → 点击 → 自动拉起并认证成功） |
| 2.8 | 第三方 cookie 降级路径 | `iframe-host.fallback()`、`EXT/src/sw/panel-control.js` | 1.5, 2.7 | **E2E-9 通过**（禁用 3P cookie 时要么分区 cookie 成功、要么独立窗口成功） |

**M2 退出条件**：E2E-2/3/4/5/8/9 通过；PRD 场景 A（文档 → 本地建组件）人工走通一次。

---

## M3 · 浏览器控制（agent 反向操作）

| # | 任务 | 产出 | 依赖 | 完成判据 |
|---|---|---|---|---|
| 3.1 | 扩展侧 WS 客户端 + ops 框架 | `EXT/src/sw/agent-bridge.js`、`ops/{read,tabs,wait}.js` | 2.4 | `agent-bridge.test.js` + 只读 ops 单测全绿；**E2E-6 通过** |
| 3.2 | 写操作 ops | `ops/{click,type,navigate}.js` | 3.1 | 三 op 单测全绿；**E2E-7 通过**（真实点击/输入改变页面状态） |
| 3.3 | 工具注册与错误映射 | `PLUG/src/host/tool-bridge.ts` | 3.1 | `tool-bridge.test.ts` 全绿；模型可见工具列表含 7 个工具（写入类默认不出现在只读模式） |
| 3.4 | 截图工具（含 fullPage 增强，可选 debugger） | `ops/screenshot.js`、`optional_permissions: debugger` 流程 | 3.3 | 视口截图工具可用；`fullPage` 在授权 debugger 后可用（否则明确报错并给替代方案） |
| 3.5 | 权限与审批接线 | 与 DSH 权限预设/审批服务的接线 | 3.3 | 写操作在只读预设下被拒绝且提示开启方式 |

**M3 退出条件**：E2E-6/7 通过；模型能在一次对话里「读网页 → 点击 → 验证结果」。

---

## M4 · 打磨与收尾

| # | 任务 | 产出 | 完成判据 |
|---|---|---|---|
| 4.1 | 快捷键与右键菜单 | `EXT/src/sw/commands.js` | `Cmd+Shift+G`/`Cmd+Shift+E` 生效；右键菜单含「Ask Antigravity about this page」 |
| 4.2 | 域名黑名单与体积上限 | `settings.js` + 面板设置区 | 黑名单站点 attach 被拒且提示；超限给出截断/拒绝的明确文案 |
| 4.3 | 安装一键化 | `NH/install.mjs` + `scripts/setup.mjs`（生成 key、写 profile、装插件、装 native host） | 新机器上一条命令完成安装并自检通过（含路径含空格） |
| 4.4 | 文档回填 | 三份 research 笔记结论回填 docs/02-05 的「待确认」处 | 文档中不再有未消化的 UNVERIFIED 项 |
| 4.5 | 人工验收 | — | docs/06 §5 清单 7 项全部通过 |

---

## 关键路径与排期建议

```
1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6   （M1，最关键：认证链路一旦通，后面都是工程活）
                    ↘ 2.1 → 2.3 → 2.6
              2.4 → 2.5 ┘        ↘ 2.7 → 2.8
              3.1 → 3.2 → 3.3 → 3.4 → 3.5
```

- **最大风险点**：1.4（cookie 签发）与 2.5（composer 编程式插入）。建议 1.4 用固定向量测试先行；2.5 先做「最小可用」——即使只能插入纯文本引用，链路也算通（图片与原子引用作为增强）。
- **可并行**：2.7（native host）与 2.1-2.6 互不依赖；3.x 与 2.x 后段可并行。
- **每完成一个任务立即补单测**，不要攒到最后（协议与 Chrome 行为的回归成本很高）。

---

## 实现期需要立即回答的问题（按优先级）

1. **客户端 composer 插入入口**（docs/04 §7 第一条）→ 决定 FR-2.4 的实现质量。查 `docs/research/02-*.md`。
2. **attachment 准入 API**（docs/04 §7 第二条）→ 决定截图是否能成为 composer 附件。
3. **`dsh plugin --profile web add <本地目录>` 的实际行为**（软链 or 复制）→ 决定开发时是否需要每次 `build` 后重装。查 `docs/research/01-*.md`。
4. **扩展 service worker 与 `/ag/agent` 的 WS 保活**（Chrome SW 回收策略）→ 决定是否需要 `chrome.alarms` + 重连兜底。查 `docs/research/03-*.md`。
