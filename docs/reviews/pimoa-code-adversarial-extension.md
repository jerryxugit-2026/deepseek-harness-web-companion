# PiMoa 对抗性审核结果

- 工具：`moa_verify`
- 端点：`http://127.0.0.1:8758/mcp`
- 输入：`dsh-plugin/lib/client.js`、`extension/src/content/extract.fn.js`、`extension/src/lib/dev-config.js`、`extension/src/lib/frame-budget.js`、`extension/src/lib/result.js`、`extension/src/lib/urls.js`、`extension/src/sidepanel/agent-channel.js`、`extension/src/sidepanel/errors.js`、`extension/src/sidepanel/panel.js`、`extension/src/sidepanel/state.js`、`extension/src/sw/attach-sender.js`、`extension/src/sw/audit.js`、`extension/src/sw/capture.js`、`extension/src/sw/dsh-session.js`、`extension/src/sw/index.js`、`extension/src/sw/menu.js`、`extension/src/sw/native-host.js`、`extension/src/sw/ops/debugger.js`、`extension/src/sw/ops/index.js`、`tests/m0a/composer-probe.mjs`、`tests/m0a/cookie-ext/manifest.json`、`tests/m0a/cookie-ext/probe.js`、`tests/m0a/cookie-matrix.mjs`、`tests/m0a/ext/manifest.json`、`tests/m0a/ext/panel.js`、`tests/m0a/ext/sw.js`、`tests/m0a/keepalive-ext/manifest.json`、`tests/m0a/keepalive-ext/page.js`、`tests/m0a/keepalive-ext/sw.js`、`tests/m0a/keepalive-probe.mjs`、`tests/m0a/permission-probe.mjs`、`tests/m0b/attach-probe.mjs`、`tests/m0b/chip-probe.mjs`、`tests/m1/panel-probe.mjs`、`tests/m2/autostart-probe.mjs`、`tests/m2/capture-probe.mjs`、`tests/m2/gate-probe.mjs`、`tests/m2/look-left-e2e-probe.mjs`、`tests/m2/look-left-probe.mjs`、`tests/m2/native-headed-probe.mjs`、`tests/m2/perf-probe.mjs`、`tests/m3/agent-turn-probe.mjs`、`tests/m3/control-probe.mjs`、`tests/m3/debugger-probe.mjs`、`tests/m3/ops-probe.mjs`、`tests/protocol/contract.test.mjs`、`tests/quality/audit-captures.mjs`、`tests/quality/probe-sites.mjs`、`tests/unit/agent-selection.test.mjs`、`tests/unit/audit-fields.test.mjs`、`tests/unit/audit-log.test.mjs`、`tests/unit/browser-tools.test.mjs`、`tests/unit/capture-routing.test.mjs`、`tests/unit/client-attach.test.mjs`、`tests/unit/frame-budget.test.mjs`、`tests/unit/menu-trigger.test.mjs`、`tests/unit/panel-errors.test.mjs`、`tests/unit/retention.test.mjs`、`tests/unit/rotate.test.mjs`、`tests/unit/tickets.test.mjs`、`tests/unit/write-gate.test.mjs`
- prompt：`scripts/review-prompts/code-adversarial.md`
- 用时：0.0s
- 裁决（status）：**unknown**
- 生成时间：2026-09-12T06:02:06.969Z

---
[moa failed] stage=config reason=材料预算超限(fail-loud,v4 §4)：prompt+context+recon 合并 424541 字符 > 预算 360000(mode=verify)。请减料、分段调用、或改用 files 传路径由服务端按上限读入;本工具不做静默截断/压缩(那是静默降质)。临时放宽:env PIMOA_MATERIAL_BUDGET_CHARS(见方案 §4.2 的 600k 显式档)。
mode=verify preset=moa_verify quorum=0/0 models= aggregator=(未解析)
