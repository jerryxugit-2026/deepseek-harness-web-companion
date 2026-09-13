# DSH Web Companion

> **Language**: this extension is **English-only**. Whichever UI language your Chrome uses (Chinese or English), the panel, the error copy and the model-facing tool descriptions are always English — only the `en` locale pack is shipped, and Chrome falls back to `default_locale` when it finds no match.

Click a browser button, get a side panel that shows your **local DSH agent**, and hand it the page you are
looking at — while giving that agent the ability to read and write files, run commands, and drive the browser
back.

> Design source of truth: `详细设计文档.md` (Chinese). Every claim in that document carries an evidence tag
> (【实测】measured / 【源码】read from source / 【文档】documented / 【推理】inferred / 【目标·未测】target,
> untested). This README is only an entry point and a status summary.
>
> 中文版：[`README.md`](./README.md)

## What it looks like

```
┌─ Chrome ──────────────────────┐        ┌─ local DSH (dsh web) ─────────────┐
│ Side panel (panel.html shell)  │        │ bridge plugin                     │
│  ├ status / Attach page / sel. │←─WS───→│  /ag/agent   /ag/client           │
│  ├ grant & capture / switches  │  HTTP  │  /ag/enter /ag/attach /ag/control │
│  └ iframe: the real DSH GUI    │←──────→│                                   │
└───────────────────────────────┘        └───────────────────────────────────┘
        │ chrome.scripting / chrome.debugger
        ▼
   the page on your left (text extraction / screenshots / trusted clicks and typing)
```

Three channels are deliberately kept apart: `/ag/client` (the DSH page half: capture pushes, intent, ack),
`/ag/agent` (the extension: intent relay, `browser_*` tool calls), and an HTTP control plane (pairing ticket,
entry handshake, runtime switches).

## Quick start (use the bootstrapper)

```bash
cd "网页插件"

node bootstrap/install.mjs          # 1. see what it would do (dry-run by default — writes nothing)
node bootstrap/install.mjs --apply  # 2. actually install (it asks once per step)
node bootstrap/doctor.mjs           # 3. check the install at any time
```

The bootstrapper: asks where to install → checks each dependency and asks before installing it (Node is only
detected, never installed for you; DSH can be installed) → **links** the plugin's dependencies to your DSH
instead of downloading them → builds the extension with your real port baked in → installs the native
messaging host → writes the profile mount line idempotently → walks you through pasting a DeepSeek API key →
tells you how to load the extension in Chrome → re-checks everything and exits. **macOS only for now.**

Then load the extension: `chrome://extensions` → **Load unpacked** → pick
`<install-dir>/extension/dist`, and click the side-panel icon.

To uninstall: `node bootstrap/uninstall.mjs --apply`.

> **Full guide** (prerequisites, what each of the ten steps touches, why dependencies are *linked*, API key,
> troubleshooting, rollback): [`docs/13-安装部署.md`](./docs/13-安装部署.md) (Chinese).
>
> Paths in that document are written as `<install-dir>` on purpose — it is written for *your* machine, and
> hard-coded absolute paths are exactly what this release set out to remove.

<details>
<summary>Manual development flow (only when hacking on the plugin itself)</summary>

```bash
npm install                       # root dev deps (ws, codegraph — used by tests/scripts)
(cd extension && npm install)     # extension build deps (esbuild) — note: a SEPARATE npm package
node scripts/init-key.mjs         # pairing key (idempotent) → ~/.dsh/dsh-web-companion.json
node native-host/install.mjs      # native messaging host
npm run build:ext                 # build the extension → extension/dist
dsh web                           # start DSH (web profile, port 3080)
```

Plugin install (dev): add one line to `~/.dsh/profiles/web/cordis.patch.yml` —
`- insert: [{ id: dsh-web-companion-bridge, name: '<absolute path>/dsh-plugin/src/host/index.js' }]` —
then restart `dsh web`. **The bootstrapper exists to write exactly that line from parameters**; normal users
never edit it by hand.

</details>

## What it can do (each item measured)

| Capability | How to use it | Evidence |
|---|---|---|
| Real DSH GUI embedded in the side panel | click the icon → panel iframe | E2E-1 passes against the real GUI |
| Capture a whole page as Markdown | panel “Attach page” / context menu | three UI-noise heuristics + placeholder-anchor cleanup; measured on a real site (apexnc.org) |
| Capture a selection | select text, then “Attach selection” | the capture file contains only the selection (282 chars), with a `> **user selection**` block |
| Type “look left” in the composer to capture the current page | write `look left` (or `看左边`) in the DSH composer | full path 22/22 (without `<all_urls>`): sniff → relay → capture → write to disk → push back → chip + reference inserted into the current session |
| Agent drives the browser back | turn on “Browser control”; the model calls `browser_read/click/type/navigate/tabs/wait/screenshot/ax` | ops layer 30/30 (real Chrome): both the synthetic and the trusted path really change the page, and `trusted` is reported honestly |
| Write switch + approval | panel “Write actions” switch | control plane 11/11: capability set 5↔8 with no restart; `approvalMode` reported honestly (`ask` = ask first each time; `policy-never` = this session has no prompts, so write calls are refused outright and say it is policy) |
| The capture folder never grows forever | automatic (24h sweep after each capture) | 19 assertions + on-site assertion (a 25h-old file was removed, the user's own file kept) |

## Security model (three gates + one retention policy)

1. **Pairing**: `key + exact extension Origin` (F2/F3); the iframe uses a one-time ticket (30s, single use)
   instead of the long-lived key. DSH's own `/api` fence is **not** weakened.
2. **Writes, three layers**: with `allowBrowserWriteOps=false` the write tools are **not registered** (the
   model cannot see them) → the extension re-checks the same frame (`E_READONLY`) → the
   `tools/pre-execute` waterfall hands it to DSH's approval service for per-call approval.
3. **Debugger**: `debugger` is a required permission (Chrome refuses it as optional — ADR-12), but nothing
   attaches by default; the “Browser control” switch decides, and turning it off releases everything.
4. **Retention**: after each capture, files in the same folder that this plugin named and that are older than
   24h are removed. Files you put there yourself are never touched.

## Tests and gates

```bash
npm run check          # protocol consistency → i18n codegen check → repo-root guard → doc graph →
                       # anti-pattern rules → protocol contract → unit tests → build → dist port gate
npm run check:strict   # before shipping: doc-graph byte-comparison too

npm run test:unit              # 30 unit files (see package.json for the full chain)
npm run probe:all              # every real-Chrome probe in one command (spawns its own dev instance)
npm run audit:captures         # quality audit over real capture files
```

Probes that need a dev instance start one first:
`DSH_HOME="$PWD/.devhome" dsh web --no-open --port 3099 &`.

## Layout

```
protocol/          single-source protocol (messages.schema.json → codegen → three artifacts + vectors)
dsh-plugin/        the bridge plugin: host half (routes/hub/tools/retention) + client half (inside the DSH page)
extension/         MV3 extension: sw (capture, ops) / content (extractor) / sidepanel (shell + agent channel)
extension/i18n/    single-source UI copy → _locales/{en,zh_CN}/messages.json (+ a JS fallback module)
bootstrap/         installer / uninstaller / doctor (terminal, no GUI)
native-host/       native messaging host (auto-starts `dsh web`)
scripts/           pairing, doc graph, anti-pattern rules, adversarial review driver
tests/             unit tests + milestone probes (m0a/m0b/m1/m2/m3)
docs/              sub-documents, research, review records, probe reports
```

## Known limitations (honest list)

- **Multi-site capture quality**: the heuristics are conservative; navigation-style short link lists can still
  be removed on some sites (each heuristic has its own off switch, e.g. `stripChipRows: false`).
- **`browser_screenshot` returns a file path**, not an image block: pixels land in
  `<workspace>/网页捕获/assets/`, which avoids guessing at DSH's image-block shape.
- **The intent path needs an extension-side grant**: without `<all_urls>` it can only capture sites the
  extension already has host permission for (e.g. `127.0.0.1`); the panel says what to do about it.
- **Chips** are rendered by DSH's own `conversation.input.dock` slot; if that declaration never appears it
  falls back to a DOM strip (`__AG_CLIENT__.chips()` reports which via `host`).
- **macOS only** for the bootstrapper right now (the Linux branch is written but untested; Windows is not
  implemented).
- **CI is not wired up yet**: `npm run check` is CI-ready; `npm run probe:all` needs a machine with Chrome and
  a local DSH, so it runs locally today.

## Related documents

- [`详细设计文档.md`](./详细设计文档.md) — architecture, ADRs, protocol, modules, test plan, security model
- [`docs/11-台账.md`](./docs/11-台账.md) — **completion ledger** against the design (done / changed / not done, with evidence)
- [`docs/13-安装部署.md`](./docs/13-安装部署.md) — install & deploy guide (Chinese)
- [`docs/CHANGELOG.md`](./docs/CHANGELOG.md) — what changed in each version and why (including overturned conclusions)
- [`docs/HANDOFF.md`](./docs/HANDOFF.md) — hand-off prompt + pitfall list
- [`docs/reviews/`](./docs/reviews/) — probe reports and adversarial review results
