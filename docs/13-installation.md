# Install & deploy (the bootstrapper)

> **Language**: this extension is **English-only**. Whichever UI language your Chrome uses (Chinese or English), the panel, the error copy and the model-facing tool descriptions are always English — only the `en` locale pack is shipped, and Chrome falls back to `default_locale` when it finds no match.

> Chinese version: [`13-安装部署.md`](./13-安装部署.md)
>
> ⚠️ **Paths in this document are deliberately written as placeholders** (`<install-dir>`,
> `~/.dsh/…`). Hard-coded absolute paths are exactly what this release set out to remove — a path
> that is correct on the author's machine is wrong on yours.

---

## 0. The one-minute version

```bash
# 1. see what it is going to do (dry-run by default — it writes nothing)
node bootstrap/install.mjs

# 2. when that looks right, install for real (it asks once per step)
node bootstrap/install.mjs --apply

# 3. check the install at any time
node bootstrap/doctor.mjs

# 4. remove it again
node bootstrap/uninstall.mjs --apply
```

The paths above are relative to the folder you downloaded/unpacked, so `cd` into it first.

---

## 1. What you end up with

| Thing | Where | Notes |
|---|---|---|
| Bridge plugin (host + page half) | `<install-dir>/dsh-plugin/` | in-process DSH plugin: `/ag/*` routes, writing captures to disk, the `browser_*` tools |
| Extension build output | `<install-dir>/extension/dist/` | **built on your machine**, with your port and pairing key baked in |
| Native host launcher | `<install-dir>/native-host/` | lets Chrome start DSH when it is not running |
| Chrome host manifest | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.dsh.web_companion.json` | allows your extension to talk to the local process |
| Pairing key | `~/.dsh/dsh-web-companion.json` | shared secret between extension and plugin (**idempotent: reused, never rotated**) |
| Plugin mount line | `~/.dsh/profiles/web/cordis.patch.yml` | tells DSH to load the plugin (**only our entry is touched; backed up first**) |

Default install directory: **the folder you unzipped** (just press Enter); default DSH data directory: `~/.dsh/`.
**If you do not pass `--install-dir` / `--dsh-home`, the wizard asks you for both** before printing the plan
(press Enter to accept the default; a leading `~/` is expanded). Piped/CI runs and `--yes` never block — they take the default.

---

## 2. Prerequisites

| Needed | Notes |
|---|---|
| **macOS** | Only macOS for now. The Linux browser-directory branch is implemented but **untested**; Windows (registry) is **not implemented** — the bootstrapper says so instead of pretending |
| **Node.js ≥ 22** | Detected. It **cannot install Node for you** — Node is a system runtime and installing it needs your password. If it is missing, you get told where to get it |
| **Chrome / Chromium** | Required (the extension is an MV3 side-panel extension) |
| **DeepSeek Harness** | Required. If missing, the bootstrapper can install it for you |

---

## 3. The ten steps the bootstrapper takes

Each step first prints what it will touch, then **asks you once** (`--yes` agrees to everything).
If it is not running in a terminal (a pipe/CI) and `--yes` was not given, **every question is answered "no"** —
so it only prints the plan and changes nothing.

| Step | What it does | Which files it touches |
|---|---|---|
| 1 | create the install directory | `<install-dir>` |
| 2 | copy **our own sources** | `<install-dir>/…` (**no `node_modules`, no `dist`**) |
| 3 | hook up plugin dependencies (**link** to your DSH, no download) | `<install-dir>/dsh-plugin/node_modules/…` (symlinks) |
| 4 | prepare `esbuild` (**no longer downloaded by the wizard**; a missing one is reported with its command) | `<install-dir>/extension/node_modules/` |
| 5 | generate/reuse the pairing key | `~/.dsh/dsh-web-companion.json` (+ `.bak-before-install`) |
| 6 | build the extension and verify its port | `<install-dir>/extension/dist/` |
| 7 | install the native messaging host | Chrome manifest + `<install-dir>/native-host/run-host.sh` |
| 8 | write the plugin mount line | `~/.dsh/profiles/web/cordis.patch.yml` (+ `.bak-before-companion`) |
| 9 | walk you through the DeepSeek API key | `~/.dsh/.credentials.yaml` (+ `.bak-before-apikey`) |
| 10 | print the manual Chrome steps and wait for you | prints only |
| 11 | re-check (DSH answers / paired / dist port / extension reachable) | read-only |

---

## 4. Why dependencies are *linked*, not downloaded

> **Changed 2026-09-13: the wizard no longer downloads or installs any dependency.**
> The user's verdict after testing it: deciding by ourselves and pulling things in "looks clever, and is
> probably wrong". On his machine DeepSeek Harness is a **source checkout** at
> `/Volumes/Ex/ai_workspace/deepseek-harness` (no `node_modules`, root package named
> `@deepseek-ai/dsh-root`); the old check only ran `command -v dsh`, never mentioned it, and was about
> to install a second, global copy.
>
> What the wizard does now:
>   1. **multi-source detection**: `--dsh <path>` → `PATH` → npm global prefix and common locations,
>      printing every candidate it found;
>   2. a **dependency report**: what is missing, where it belongs, and the exact command to copy;
>   3. **a missing required dependency stops it before it writes any file** (exit code 2). The old order
>      copied the sources first and only discovered the missing DSH at step 3, leaving a half-install
>      that could not run.
>
> The commands you run yourself (only the ones the report flags):
> ```bash
> npm install -g @deepseek-ai/dsh@0.1.5-rc.2                                  # DeepSeek Harness itself
> cd "<your DSH install dir>" && npm install ws                               # plugin runtime deps (if reported missing)
> npm install --prefix "<install-dir>/extension" esbuild                      # extension build tool (if reported missing)
> ```

This is the single most important design decision in the installer, and it came from **reading a working
deployment** rather than guessing.

The plugin's `node_modules/` contains **no real packages** — only three **symlinks** into your own DSH
installation:

```
dsh-plugin/node_modules/@deepseek-ai/dsh-tools       -> <DSH root>/node_modules/@deepseek-ai/dsh-tools
dsh-plugin/node_modules/@deepseek-ai/dsh-credentials -> <DSH root>/node_modules/@deepseek-ai/dsh-credentials
dsh-plugin/node_modules/ws                           -> <DSH root>/node_modules/ws
```

Four benefits, each measured:

1. **Versions can never drift** — the plugin runs inside the DSH process, so it uses DSH's own sub-packages.
   Upgrading DSH from 0.1.2-rc.1 to 0.1.5-rc.2 required **nothing** from the plugin.
2. **Nothing to download** — DSH already ships those three packages.
3. **No peer-dependency hell** — installing `@deepseek-ai/dsh-tools@0.1.5-rc.2` on its own fails with
   `ERESOLVE` (it peer-depends on `dsh-llm`, `cordis`, `dsh-agent` and six more); inside DSH's tree those
   peers already exist.
4. **Upgrading DSH never means reinstalling the plugin.**

**Never install DSH (or its sub-packages) with `latest`**: measured 2026-09-12, the npm `latest` tag of
`@deepseek-ai/dsh-tools` is `0.0.1-rc.1` — a stub. The bootstrapper pins the version and treats "which
version" as an explicit parameter.

---

## 5. The DeepSeek API key

Step 9 prints the instructions and lets you **paste** the key (it is not echoed in the terminal, so it does
not stay in your scrollback):

1. open <https://platform.deepseek.com/> and sign in;
2. “API keys” → “Create new API key”;
3. copy the `sk-…` string (**shown only once**) and paste it into the bootstrapper.

It is written to `refs.DEEPSEEK_API_KEY` in `~/.dsh/.credentials.yaml`.

**That one line is all it changes.** The same file also holds your other keys and a
`records.client-connection/browser-session` entry (**the plugin signs its login cookie with it**). The
bootstrapper does a **targeted edit plus a backup** — it never rewrites the file. Leave the prompt empty to
skip it and leave the file untouched.

> Why the bootstrapper writes this file at all: DSH has **no** built-in command for setting a key
> (measured: `dsh --help` lists only `web` and `plugin`).

---

## 6. Loading the extension in Chrome (manual, by design)

1. go to `chrome://extensions`
2. turn on **Developer mode**
3. click **Load unpacked**
4. select `<install-dir>/extension/dist`
5. click the extension icon in the toolbar to open the side panel

Then go back to the bootstrapper and press Enter; it re-checks.

> **Why this cannot be automated**: Chrome does not allow silent extension installs (137+ removed
> `--load-extension`). This project's own automated probes use the CDP `Extensions.loadUnpacked` path — that
> is a *test* channel, not something to install an extension for a user with.

---

## 7. Confirming it really works

```bash
node bootstrap/doctor.mjs          # human-readable
node bootstrap/doctor.mjs --json   # machine-readable (good for pasting into an issue)
```

It checks four things; **three are hard** (they decide the exit code):

| Check | Kind | Meaning |
|---|---|---|
| DSH answers on the port | hard | is it up, is the port right |
| plugin loaded and paired (`paired`) | hard | do the mount line and the pairing file agree |
| extension build port == real pairing port | hard | prevents "the build got baked with the wrong port" |
| extension reachable | **soft (proxy)** | it looks at `connectedClients` (DSH **page-half** connections) |

**Be honest about that last one**: the extension lives inside Chrome and does not announce itself, so from the
outside **it is invisible**. The plugin also does not currently expose the extension's `/ag/agent` channel
count. So this check is a **proxy** — opening the side panel makes the embedded DSH page half connect, which
pushes `connectedClients` above zero. It **does not decide pass/fail** (`0` does not mean the extension is not
installed, only that the side panel is not open) and it tells you what to do next.

---

## 8. Uninstalling

```bash
node bootstrap/uninstall.mjs            # show what would be removed (dry-run)
node bootstrap/uninstall.mjs --apply    # do it
```

It only reverses **our own** changes:

- removes our entry from the profile patch (backup first);
- removes the Chrome native messaging manifest;
- removes the install directory (pass `--keep-files` to keep it);
- **keeps the pairing key by default** (removing it affects re-installation); pass `--purge-pairing` to drop it;
- **never touches your API key** — that credential is yours, not this plugin's.

---

## 9. Troubleshooting

| Symptom | Cause / what to do |
|---|---|
| `❌ Node.js ≥ 22` | install from <https://nodejs.org> or via nvm/fnm; **the bootstrapper does not install Node** (needs system access) |
| `⚠️ port is in use, but the answer is not this plugin` | `lsof -nP -iTCP:3080 -sTCP:LISTEN` to see who; or use another port with `--port 3099` |
| `⚠️ Chrome config directory not found` | install Chrome and **start it once**, then re-run |
| Panel cannot connect after install (`E_EXT_OFFLINE`) | run `node bootstrap/doctor.mjs` to see which check fails; common causes: the extension is not loaded, or you changed the port and did not rebuild (re-run step 6) |
| It says “extension ID changed” and stops | that is a **guard** catching a real past incident: changing the extension ID makes the already-installed extension, the pairing file and the native host manifest disagree. Follow the printed instructions to roll back the pairing file from `.bak-before-install`, then retry |
| `dsh` version differs from the one we verified | the bootstrapper **warns but does not block** (cross-minor versions measured working). If something looks wrong, switch back to the verified version first |
| Rolling back this install | mount: `cp ~/.dsh/profiles/web/cordis.patch.yml.bak-before-companion ~/.dsh/profiles/web/cordis.patch.yml`; pairing: `cp ~/.dsh/dsh-web-companion.json.bak-before-install ~/.dsh/dsh-web-companion.json` |

---

## 10. Safety and reversibility (what the bootstrapper guarantees)

1. **Dry-run by default**: without `--apply` it only prints the plan.
2. **One confirmation per step** (`--yes` to batch); when non-interactive it answers "no" to everything and
   **never blocks and never acts on its own**.
3. **A failed critical step stops immediately and does not write the DSH mount** — so a half-finished install
   cannot break the working one.
4. **It proves the plugin loads before touching your DSH**: it really `import()`s the installed plugin to make
   sure dependencies resolve.
5. **Every config change is backed up first**, with the rollback command printed.
6. **It only touches its own things**: other `semble` / `codegraph` entries, your other keys, other native
   messaging hosts — all untouched (unit-asserted byte-for-byte).

---

## 11. Related documents

- [`README.en.md`](../README.en.md) — project entry point (English)
- [`README.md`](../README.md) — project entry point (Chinese)
- [`../详细设计文档.md`](../详细设计文档.md) — design source of truth (architecture / ADRs / protocol / security)
- [`CHANGELOG.md`](./CHANGELOG.md) — what changed in each version and why (including overturned conclusions)
- [`11-台账.md`](./11-台账.md) — completion ledger against the design, with an evidence index
