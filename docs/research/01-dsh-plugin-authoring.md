# 01 — Writing, building, installing and testing a THIRD-PARTY DSH plugin (host half + browser/client half)

Research note. **No implementation was performed.** Every claim below is grounded in either

* an **installed file** — `$DSH/pkg` = `/Users/mac/.hermes/node/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/…`, cited as `$DSH/pkg/file:line`; or
* the **public repo** `https://github.com/deepseek-ai/deepseek-harness` (**default branch is `master`, not `main`** — `main` returns 404 on `raw.githubusercontent.com`), cited as full URLs with line numbers from the fetched file.

Verification legend: **[V]** verified by reading a file · **[V-DERIVED]** conclusion derived by reading code but not shipped as a documented statement · **[UNVERIFIED]** could not confirm.

Local environment facts used throughout:

| Fact | Value | Source |
|---|---|---|
| dsh version | `0.1.2-rc.1` | `dsh --version` |
| dsh install root | `/Users/mac/.hermes/node/lib/node_modules/@deepseek-ai/dsh/` | `ls` |
| CLI entry | `/Users/mac/.local/bin/dsh` | `which dsh` |
| DSH home | `/Users/mac/.dsh` | `ls` |
| web profile dir | `/Users/mac/.dsh/profiles/web` | `ls` |
| Node | `v22.22.3` (`engines` in repo root: `^22.19.0 || >=24.0.0`) | `node -v` |
| **pnpm** | **NOT ON PATH** | `dsh plugin --profile web --help` → `dsh: pnpm not found on PATH — install pnpm to manage profile plugins`, exit **127** |

---

## 0. Executive summary

1. A DSH plugin is a **module exporting `apply(ctx, config?)`** plus optional `name`, `inject`, `Config`. There is no plugin base class requirement and no registration file to edit for a local `--patch` load. [V] `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/index.md` L17–29.
2. A **third-party, npm-installable** plugin is a *bundle*: a package whose `package.json` declares `dsh.bundle.patch` pointing at a `cordis.patch.yml` layer. Install with `dsh plugin --profile <name> add <spec>`; the CLI forwards to pnpm in the profile dir and then appends the package name to `dsh.profile.bundles`. [V]
3. A package can be **dual-face** — host half at `exports["."]` (ESM, `lib/index.js`) and browser half at `exports["./client"]` (CJS-closure factory, `lib/client.js`), declared by `dsh.client`. [V] `$DSH/dsh-client-modules/package.json`.
4. **The host does not hardcode `lib/client.js`.** It reads `exports["./client"]` from the package manifest and joins it to the package.json directory. `./lib/client.js` is the *repo convention*, enforced only by the repo's own tsdown preset. [V] `$DSH/dsh-client-modules/lib/index.js:635-641`.
5. The client bundle must be **CJS in a closure factory** that calls `window.__ModuleLoader__.load({ id, factory })`, with every shared import resolved through the injected `require`. [V] `…/tsdown.client.ts` L428–571 + `$DSH/dsh-client-ui-goal/lib/client.js:1`.
6. The frozen externals baseline is **`PLATFORM_MODULES`** — 9 specifiers on `master`, **only 8 in the installed 0.1.2-rc.1 shell** (no `dsh-client-ui-dockkit`). Every other `@deepseek-ai/*` value import is either the package's own `dsh.client.external` row or a **build error** (purity gate). [V] + version-drift finding.
7. A third-party plugin **can** register raw HTTP routes, WebSocket upgrades, index injections and credentials through ordinary services, but **cannot** reuse the repo's tsdown preset, Playwright web lane, or fixture harnesses without reimplementing them.
8. **Blocker for this machine:** `dsh plugin` needs `pnpm` on `PATH`; it is absent, so `dsh plugin --profile web add …` exits 127 today. [V]

---

## 1. Package layout for a plugin package

### 1.1 The plugin module contract

Four exports matter. Named exports are required (a default export drops `inject` — see the repo postmortem `docs/postmortem/0001-acp-default-export-drops-inject.md`).

```ts
// docs/user/develop/basic/index.md L91-101 (repo)
import type { Context } from '@deepseek-ai/cordis'
export const name = 'my-tool-plugin'
export const inject = ['tools']
export function apply(ctx: Context) { ctx.tools.register(/* ... */) }
```

A real installed host plugin, verbatim (`$DSH/dsh-webhook-github/lib/index.js:158-193`):

```js
const name = "webhook-github";
const inject = ["webServer", "webhookRuntime", "credentials"];
const Config = z.object({
  source: z.string().required(),
  path: z.string().required(),
  secretEnv: z.string().role("credential-ref").required(),
  maxBodyBytes: z.number().step(1).min(1).max(Number.MAX_SAFE_INTEGER).required()
});
function apply(ctx, config) {
  assertConfig(config);
  const route = { kind: "exact", path: config.path,
    handler: createGitHubWebhookHandler(ctx, { /* … */ }) };
  ctx.effect(() => ctx.webServer.register(route), `webhook-github: ${config.path}`);
}
export { Config, apply, inject, name };
```

`z` here is **Schemastery**, not zod: `import z from "@deepseek-ai/schemastery"` (`…:1`). Three plugin forms are supported — function module, object (`export default { name, inject, apply }`), and class (`export default class X extends Service { static inject = [...]; constructor(ctx){ super(ctx,'myService') } }`). [V] `docs/user/develop/basic/index.md` L105–138.

### 1.2 The four `dsh` manifest roles

`package.json.dsh` is read by **two independent readers**, and the keys do not interact:

| Key | Reader | Meaning |
|---|---|---|
| `dsh.bundle.patch` | `dsh` CLI + app-boot | "this package ships a profile configuration layer" |
| `dsh.profile.bundles[]` | app-boot | "this *directory* composes these layers, in this order" (only profiles have it) |
| `dsh.client.{platform,inject,external,immediately}` | `dsh-client-modules` node half | "this package has a browser half to load" |

Typed: `DshBundleManifest` / `DshProfileManifest` / `DshManifestSection` at `$DSH/dsh-app-boot/lib/types/profile.d.ts:26-60` — **note that this type does not declare `client`**; the client half is read structurally at `$DSH/dsh-client-modules/lib/index.js:629-630` (`const dsh = pkg.dsh; parseDshClient(name, dsh?.client)`), and the repo's own build preset types it as `readonly dsh?: { readonly client?: { readonly external?: unknown } }` (`…/tsdown.client.ts` L332). **[V]**

> **No installed package declares more than one `dsh` key.** I enumerated all 223 `@deepseek-ai/*` packages: 2 declare `dsh.bundle` (`dsh-base`, `dsh-web-app`, `dsh-acp-app`), ~60 declare `dsh.client`, **zero declare both**. So an all-in-one "bundle + client" third-party package has **no shipped exemplar**; it follows from the two readers being independent, but treat it as **[V-DERIVED]**, not documented.

### 1.3 Real minimal example with BOTH halves — quoted

The genuine dual-face exemplar is `@deepseek-ai/dsh-client-modules` (node half = the whole client-module registry; browser half = the module table). Verbatim `$DSH/dsh-client-modules/package.json`:

```json
{
  "name": "@deepseek-ai/dsh-client-modules",
  "description": "Client module system, dual-face: …",
  "version": "0.1.2-rc.1",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "exports": {
    ".": { "types": "./lib/types/index.d.ts", "default": "./lib/index.js" },
    "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" },
    "./invariant": { "types": "./lib/types/invariant.d.ts", "default": "./lib/invariant.js" },
    "./src/*": "./src/*",
    "./package.json": "./package.json"
  },
  "dsh": { "client": { "platform": "web", "inject": [], "immediately": true } },
  "license": "MIT",
  "devDependencies": {
    "@deepseek-ai/cordis-plugin-loader": "^1.0.3",
    "@deepseek-ai/dsh-host-webserver": "^0.1.2-rc.1",
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-invariants": "^0.1.2-rc.1"
  },
  "files": ["lib/index.js", "lib/invariant.js", "lib/client.js", "lib/types/**/*.d.ts"],
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" },
  "scripts": { "bundle": "tsdown", "watch": "tsdown --watch" }
}
```

A **pure UI plugin** keeps the *same* shape with an empty node half — `$DSH/dsh-client-ui-goal/lib/index.js` is 404 bytes, in full:

```js
//#region lib/types/index.js
/**
* Goal surface plugin, node half. Pure UI plugin: the empty apply exists so
* the plugin appears in the host cordis.yml / Loader; the browser half
* ships via exports["./client"], discovered through the package.json
* dsh.client declaration.
*/
function apply() {}
//#endregion
export { apply };
```

Its manifest differs from `dsh-client-modules` only in the `dsh.client` payload (no `immediately`, non-empty informational `inject`):

```json
"dsh": {
  "client": {
    "inject": ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-api-session-controller",
               "@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-chat",
               "@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-client-ui-renderer",
               "@deepseek-ai/dsh-client-ui-session"],
    "platform": "web"
  }
}
```
(`$DSH/dsh-client-ui-goal/package.json` verbatim)

**Build-output convention:** every installed client package has exactly `lib/client.js`, `lib/client.js.map`, `lib/index.js`, `lib/types/**`. Declaration is what matters:

```json
"files": ["lib/index.js", "lib/client.js", "lib/types/**/*.d.ts"]
```
(`$DSH/dsh-client-ui-goal/package.json`, `dsh-client-ui-jobs`, `dsh-client-ui-attachment` — identical)

### 1.4 The installable third-party BUNDLE form (official tutorial)

Verbatim from `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/user/develop/basic/publish.md` L26–62:

```
hello-plugin/
├── package.json       # declares dsh.bundle
├── cordis.patch.yml   # the layer applied when a profile lists this bundle
└── index.js           # plugin modules the patch rows reference
```

```json
{
  "name": "dsh-hello-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "index.js",
  "files": ["index.js", "cordis.patch.yml"],
  "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
}
```

```yaml
# hello-plugin/cordis.patch.yml
- insert:
    - id: hello
      name: dsh-hello-plugin
```

"A package without the `dsh.bundle` declaration still installs, but only as a plain dependency: `dsh plugin` prints a warning and activates no layer." (same doc, L64) [V]

### 1.5 `src/` layout conventions (repo-internal, adopted by convention)

From `packages/client/AGENTS.md` "New plugin package checklist" (L138), verbatim:

> 1. **Package skeleton**: `package.json` (`@deepseek-ai/dsh-client-<name>`, exports `.`/`./client`/`./src/*`/`./package.json`, optional `./invariant` only for an independent runtime relationship, `dsh.client` manifest, `files` list), `tsconfig.json` (extends `tsconfig.base.client.json`, one `references` entry per workspace dependency), `tsdown.config.ts` (`clientBundle(id, ['lib/types/index.js'])`, plus `lib/types/invariant.js` only when published), `src/index.ts` (empty node-half apply), optional `src/invariant.ts`, `src/css-modules.d.ts` when using CSS Modules, and `README.md` with the Model Experience section and the reason when no invariant is published.

So: `src/index.ts` (host half) and `src/client/index.ts` (browser half) — the client entry compiled by the preset is literally `'src/client/index.ts'` (`…/tsdown.client.ts` L115). `tsc` emits to `lib/types/**` first, and the bundler consumes `lib/types/**` — hence `libEntry: ['lib/types/index.js']` at every call site (`packages/client/ui-goal/tsdown.config.ts`, verbatim):

```ts
import { clientBundle } from '../tsdown.client.ts'
export default clientBundle('@deepseek-ai/dsh-client-ui-goal', ['lib/types/index.js'])
```

A third-party package is **free to ignore all of this**; only these are contractual: `apply`/`inject`/`Config` named exports, `exports["."]` for the node half, `exports["./client"]` for the browser half, `dsh.client.platform === "web"`, and the browser artifact's shape (§2.1).

---

## 2. How a client bundle is built and served

### 2.1 Module format and artifact shape **[V]**

The browser half is **CJS inside a closure factory**, not ESM, not IIFE. `packages/client/tsdown.client.ts` L428–571 (`clientConfig`) is the authoritative recipe:

```ts
format: 'cjs',
platform: 'browser',
outDir: 'lib',
dts: false,
sourcemap: true,
clean: false,
outputOptions: {
  entryFileNames: 'client.js',
  sourcemapExcludeSources: false,
  sourcemapPathTransform: browserSourcePath,
  banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
  footer: 'return module.exports; } });',
  intro: 'var module = { exports: {} }; var exports = module.exports;',
},
```

Resulting artifact head, verbatim from the installed package (`$DSH/dsh-client-ui-goal/lib/client.js:1-8`):

```js
window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-client-ui-goal",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let react = require("react");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
```

and its tail:

```js
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
//# sourceMappingURL=client.js.map
```

The runtime contract is typed at `$DSH/dsh-client-modules/lib/types/client/manifest.d.ts:147-157`:

```ts
/** One client bundle's factory registration submitted through `window.__ModuleLoader__.load`. */
export interface ClientBundleRegistration {
  /** Plugin id (package name) — the registration key; must match the graph row being executed. */
  id: string;
  /**
   * Closure factory holding the whole bundle body: receives the synchronous
   * require bound to the module table and returns the bundle's exports. Runs
   * once, at materialization.
   */
  factory: (require: (spec: string) => unknown) => Record<string, unknown>;
}
```

and the window API at `…manifest.d.ts:186-191`:

```ts
export interface DshWindow {
  __DSH_BOOT__?: unknown;
  __ModuleLoader__?: ClientModuleLoaderTarget;
}
```

**Key semantic [V]:** the bundle body is *lazy*. Executing the script only *registers* the factory; all module side effects (including CSS injection) run at materialization (`manifest.d.ts:9-16`). The `require` handed to the factory is **synchronous and cannot wait** — an unsatisfied specifier throws on the spot, and module cycles are fatal (`packages/client/AGENTS.md` "The module graph sits below cordis DI" table).

### 2.2 The frozen externals baseline — `PLATFORM_MODULES` **[V]**

Definition, verbatim from `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/packages/client/web/src/platform.ts`:

```ts
/** The module specifiers the shell shares into the frozen module table. */
export const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
export const PRELOADED_CLIENT_EXTERNALS = [] as const
```

`packages/client/web/src/seed.ts` materialises the table from static imports (`'react': React, 'react/jsx-runtime': ReactJsxRuntime, …`), with a `satisfies Record<PlatformModule, unknown>` pin so the list and the import set cannot drift.

> ### ⚠️ VERSION DRIFT — the installed shell has **8**, not 9
> `PLATFORM_MODULES` on `master` = **9** entries including `@deepseek-ai/dsh-client-ui-dockkit`.
> The **installed** `0.1.2-rc.1` shell seeds **8**. Verified by reading the built shell bundle:
> `$DSH/dsh-web-frontend/dist/assets/index-Df-65__b.js`, byte offset **420294** (110-line file; the seed function `zp()` begins there), and its call site `staticModules:zp()` at byte offset **421120**:
> ```js
> react:q5,"react/jsx-runtime":Y5,"react-dom":n6,"react-dom/client":o6,
> "@deepseek-ai/cordis":M5,"@deepseek-ai/dsh-client-store":M6,
> "@deepseek-ai/dsh-client-ui-slots":T6,"@deepseek-ai/dsh-client-ui-primitives":Fp
> ```
> `@deepseek-ai/dsh-client-ui-dockkit` is **not installed** in `$DSH/node_modules/@deepseek-ai/` either.
> **A third-party plugin targeting this machine's DSH must treat the baseline as those 8 specifiers.**

**Nothing else is a baseline external.** `packages/client/AGENTS.md` L77–81, verbatim:

> 1. **Baseline externals are implicit for every dynamic bundle.** Do not repeat React, Cordis, `client/store`, `ui-primitives`, `ui-slots`, or `ui-dockkit` in package manifests.
> 2. **`dsh.client.external` is not a feature-plugin dependency mechanism.** Only infrastructure, transport, or generated assembly may add a package-specific non-baseline value request whose dynamic row must be materialized through the module table. Declare the exact import specifier; only a trailing `/client` aliases the package row.
> 3. **Silence means a private copy.** Ordinary third-party implementation libraries may be bundled independently. A value reached only through `import type` is erased and creates no request.
> 4. **A request has two possible suppliers.** A dynamic package supplies its own row; `PLATFORM_MODULES` supplies an exact static-table key. There is no `dsh.client.provide` alias protocol.

The three seed libraries `dsh-client-store`, `dsh-client-ui-slots`, `dsh-client-ui-primitives` **are published on npm** (each has `publishConfig.access: public`; e.g. `packages/client/ui-slots/package.json` on `master`) but are **not** installed under `$DSH/node_modules/@deepseek-ai/` — they are compiled into the shell dist and reached only through the seed table. **[V]**

### 2.3 How `dsh.client.external` is validated **[V]**

Runtime validation (`$DSH/dsh-client-modules/lib/index.js:139-166`), verbatim:

```js
function parseDshClient(pkgName, value) {
	if (value === void 0) return void 0;
	if (typeof value !== "object" || value === null) throw new Error(`client-modules: ${pkgName} has a non-object dsh.client declaration`);
	const decl = value;
	if (typeof decl.platform !== "string") throw new Error(`client-modules: ${pkgName} dsh.client.platform must be a string`);
	const inject = optionalStringArray(pkgName, "dsh.client.inject", decl.inject);
	const external = optionalStringArray(pkgName, "dsh.client.external", decl.external);
	if (decl.immediately !== void 0 && typeof decl.immediately !== "boolean") throw new Error(`client-modules: ${pkgName} dsh.client.immediately must be a boolean`);
	return { platform: decl.platform, ...inject !== void 0 ? { inject } : {}, ...external !== void 0 ? { external } : {}, ...decl.immediately !== void 0 ? { immediately: decl.immediately } : {} };
}
```

Rules enforced end-to-end:

| Rule | Where |
|---|---|
| `dsh.client` must be an object; `platform` must be a string; only `platform === 'web'` yields a row (anything else is silently "not a client package") | `index.js:142-144`, `:631-634` |
| `inject` / `external` must be arrays of strings | `index.js:39-41` (`optionalStringArray`) |
| Declaring `dsh.client` **without** `exports["./client"]` throws: `client-modules: <pkg> declares dsh.client but exports no "./client" bundle` | `index.js:635-636` |
| `exports["./client"]` must be a string, or an object with a string `default` | `index.js:155-166` |
| A row must not declare its **own** package in `external` | `index.js:360-362` |
| `external` edges form a DAG — a cycle throws listing the packages on it | `index.js:349-371` |
| `external` entries naming another row reorder that row **before** the consumer; entries naming a static-table key add no edge | `index.js:339-348` |
| **`dsh.client.inject` is informational only** — "they do not sequence entry activation or apply order. Activation order is Cordis fiber inject waiting on *services*, nothing else." | `packages/client/AGENTS.md` L140 |
| Two active Loader sources resolving to the same package name is a composition error | `index.js:794-800` |
| A missing built bundle aggregates into one loud `AggregateError` at activation (`FAILED` fiber): message `client-modules: client bundle not found; run \`pnpm run build\` before launch:` + package + path | `index.js:91-120`, `:746-760` |

Build-time validation (repo only): the `dsh-client-bundle-purity` Rolldown plugin rejects any `@deepseek-ai/*` **value** import that is neither a baseline/requested external, a vendored library (`cosmokit`, `schemastery`), an inline-safe wire layer, nor a generated `/remote` — `…/tsdown.client.ts` L482–500. A third-party plugin has no such gate; it must self-enforce.

### 2.4 How the host serves bundles under `/plugins` **[V]**

Registration (`$DSH/dsh-client-modules/lib/index.js:480-487`), verbatim:

```js
ctx.effect(() => ctx.webServer.register({
	kind: "prefix",
	path: "/plugins",
	handler: this.serveBundle
}), "client-modules: bundle route");
ctx.on("webserver/index-inject", (table) => {
	table.push(...bootInjections(this.composed));
});
```

URL construction (`index.js:181-184`):

```js
function comboUrl(ids, rev, sourceMap = false) {
	return `/plugins/??${ids.map((id) => `${id}/client.js${sourceMap ? ".map" : ""}`).join(",")}&rev=${rev}`;
}
```

Served URL forms (the `??` is deliberate — the whole resource list is one query):

```
/plugins/??<pkg-a>/client.js,<pkg-b>/client.js&rev=<rev>            # multi- or single-resource artifact
/plugins/??<pkg-a>/client.js.map,<pkg-b>/client.js.map&rev=<rev>    # indexed Source Map v3
```

Every served response is `content-type: text/javascript; charset=utf-8` (or `application/json` for maps) with `cache-control: public, max-age=31536000, immutable` (`index.js:122`, `:838-858`). `GET`/`HEAD` only; other methods → `405`; an unknown/altered resource list, missing rev, or stale rev → `404` (`serveBundle`, `index.js:838-858`). Combo URLs are kept ≤ **3 KiB** UTF-8 (`MAX_COMBO_URL_BYTES`, `index.js:124`); rows are greedily partitioned before that limit and the longer map form is what is measured. Combo revisions are a 12-hex sha1 (`HASH_REVISION_LENGTH`, `index.js:125`, `:167-180`).

Doc-level confirmation, `docs/subsystems/client-modules.md` L85 (repo):

> `GET`/`HEAD /plugins/??<package-a>/client.js,<package-b>/client.js&rev=<rev>` serves an exact generated combo script; a one-resource request uses the same form and is the HMR path. […] Unknown or altered resource lists, missing revisions, and stale revisions answer 404 rather than serving different bytes or letting the SPA fallback return HTML as JavaScript; other methods are 405.

**There is no plain `/plugins/<pkg>/client.js` route.** That path appears in the source only as a *sourcemap fallback source name* and as a diagnostic path (`index.js:213`, `:253`) — it is not a key in the response table and would 404. **[V-DERIVED]**

### 2.5 Which bundler? **[V]**

| Layer | Tool | Evidence |
|---|---|---|
| Per-package node half | **tsdown** (`format: ['esm']`, `platform: 'node'`, `target: 'es2024'`, `outDir: 'lib'`) | repo root `tsdown.config.ts` L16–32; `$DSH/*/package.json` `"scripts": {"bundle": "tsdown"}` |
| Per-package **client bundle** | **tsdown** with `format: 'cjs'`, `platform: 'browser'`, `entryFileNames: 'client.js'` | `packages/client/tsdown.client.ts` L428–571 |
| Web shell (`apps/web`) | **vite** (`vite build`, `@vitejs/plugin-react`) | `apps/web/vite.config.ts`; `$DSH/dsh-web-frontend/package.json` `"build": "vite build"` |
| CSS inside client bundles | **lightningcss** (`transform({ cssModules: { pattern: '[hash]_[local]' }, minify: true })`) | `…/tsdown.client.ts` L11–17, L508–525 |

Repo build scripts (root `package.json`, verbatim):

```json
"build:lib": "pnpm run build:lib:host && pnpm run build:lib:client",
"build:lib:host": "node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host",
"build:lib:client": "tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client",
"build:web": "pnpm --filter @deepseek-ai/dsh-web-frontend run build"
```

`DSH_BUILD_FACE=client` is why `'src/client/index.ts'` becomes the entry — but the **published artifact is built from `lib/types/client/index.js`**, i.e. after `tsc` (`…/tsdown.client.ts` L113-123).

### 2.6 Minimal build config a STANDALONE package needs **[V-DERIVED]**

The repo preset is not importable by a third party (it reaches for `../../scripts/client-build-environment.ts` and a workspace glob of `packages/*/*/package.json`, `…/tsdown.client.ts` L20, L352). Reproduce its *contract* with esbuild, which does the same thing in ~15 lines:

```jsonc
// package.json (third-party, dual-face)
{
  "name": "dsh-my-plugin",
  "version": "0.1.0",
  "type": "module",
  "main": "lib/index.js",
  "exports": {
    ".":        { "default": "./lib/index.js" },
    "./client": { "default": "./lib/client.js" },
    "./package.json": "./package.json"
  },
  "files": ["lib/index.js", "lib/client.js", "lib/client.js.map", "cordis.patch.yml"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": [] }
  },
  "peerDependencies": { "@deepseek-ai/cordis": "^4.0.2" },
  "devDependencies": {
    "@deepseek-ai/cordis": "^4.0.2",
    "@deepseek-ai/dsh-client-ui-slots": "^0.1.2-rc.1",
    "@deepseek-ai/dsh-client-ui-primitives": "^0.1.2-rc.1",
    "@types/react": "~18.3.1",
    "react": "^18.2.0",
    "esbuild": "^0.24.0",
    "typescript": "^6.0.3"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json && esbuild src/client/index.tsx --bundle --format=cjs --platform=browser --target=es2024 --sourcemap --outfile=lib/client.js --banner:js=\"window.__ModuleLoader__.load({ id: 'dsh-my-plugin', factory: (require) => { var module = { exports: {} }; var exports = module.exports;\" --footer:js=\"return module.exports; } });\" --external:react --external:react/jsx-runtime --external:react-dom --external:react-dom/client --external:@deepseek-ai/cordis --external:@deepseek-ai/dsh-client-store --external:@deepseek-ai/dsh-client-ui-slots --external:@deepseek-ai/dsh-client-ui-primitives"
  }
}
```

Contract points the config must satisfy (all **[V]** against the runtime/loader, and against `…/tsdown.client.ts`):

1. `--external` **exactly** the 8 baseline specifiers above (9 if targeting a newer DSH than 0.1.2-rc.1) **plus** whatever the package declares in `dsh.client.external`.
2. Everything else, including other `@deepseek-ai/*` packages, **must be inlined** — a `require()` the module table cannot answer throws at materialization.
3. The banner must inject `var module = { exports: {} }; var exports = module.exports;` *inside* the factory, and the footer must `return module.exports;` — the loader's `require` returns `module.exports`, and `dsh-client-ui-*` bundles set `exports.apply` / `exports.inject`.
4. `id` in the banner must equal the package name in `package.json` — rows are keyed by package name (`manifest.d.ts:148-149`, `index.js:329-337`).
5. Emit a `.map` next to the bundle; a missing/torn map is tolerated (identity section) but a *malformed* one only warns (`index.js:744-753`).
6. Keep `"type": "module"` for the node half but note the client artifact is CJS — it is `require`d through the module table, never `import`ed by Node.

### 2.7 CSS

Inside a client bundle the repo supports three conventions, all compiled by lightningcss at build time (`…/tsdown.client.ts` L33–53, L501–557):

* `x.module.css` → default export = hashed class map (`[hash]_[local]`), plus an injected `<style data-plugin="<id>" data-plugin-css="<id>/<file>">` tag at factory execution;
* `x.css` → global injection into `<head>` (same tag shape, no class map export);
* `x.css?inline` → exports the compiled CSS **text**, for a plugin-owned lifecycle effect.

A third party can replicate this with any CSS-Modules bundler plugin or skip it entirely (the repo is the only consumer of the `data-plugin-css` tag convention).

---

## 3. Host-side APIs available to a plugin

### 3.1 `ctx.webServer.register` and the route shape **[V]**

Source of truth: `$DSH/dsh-host-webserver/lib/types/index.d.ts:30-97`, verbatim:

```ts
/** Route match kind: 'exact' matches the pathname verbatim; 'prefix' p matches p and p/<anything>. */
export type WebRouteKind = 'exact' | 'prefix';
/** One named route registration. */
export interface WebRoute {
    kind: WebRouteKind;
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns the full response lifecycle (may hold the response open, e.g. SSE). */
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}
/** One exact-path HTTP upgrade registration. */
export interface WebUpgradeRoute {
    /** Absolute pathname, no trailing slash. */
    path: string;
    /** Owns protocol negotiation and the upgraded socket after dispatch. */
    handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void | Promise<void>;
}
```

```ts
export declare class WebServer extends Service {
    static Config: z<Config>;
    get port(): number;
    get host(): Config['host'];
    register(route: WebRoute): () => void;
    registerUpgrade(route: WebUpgradeRoute): () => void;
    registerFallback(handler: WebRoute['handler']): () => void;
    tapIndex(transform: (html: string) => string): () => void;
    [Service.init](): Promise<void>;
    applyIndexTaps(html: string): string;
    collectIndexInjections(): IndexInjection[];
    renderIndex(html: string): string;
}
```

`IncomingMessage`/`ServerResponse` are from **`node:http`** and `Duplex` from **`node:stream`** (`index.d.ts:8-9`). Matching: **exact table first, then longest prefix, then the fallback** (`README.md`, `docs/subsystems/web-server.md`). Duplicate `(kind, path)` throws; duplicate upgrade path throws; a second `registerFallback` throws — all three verified in `$DSH/dsh-host-webserver/lib/index.js:190-198`, `:206-208`. `Config` is `{ host: '127.0.0.1' | '0.0.0.0'; port: number; compression?: 'none'|'gzip'; compressionLevel?: number; compressionThresholdBytes?: number }` (`index.d.ts:48-59`).

`register` **returns a disposer**; the idiom is `ctx.effect(...)` so the fiber owns it. Real SSE route with an exact path (`$DSH/dsh-client-hmr/lib/index.js:121-160`):

```js
const EVENTS_ENDPOINT = "/plugins/events";
ctx.effect(() => {
	const disposeRoute = ctx.webServer.register({
		kind: "exact",
		path: EVENTS_ENDPOINT,
		handler: (req, res) => {
			if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405); res.end(); return; }
			connect(res);          // writes 200 + text/event-stream and holds the response open
		}
	});
	const unsubscribe = ctx.clientModules.onRebuilt((id, rev) => { /* push SSE frames */ });
	return () => { unsubscribe(); disposeRoute(); for (const res of connections) res.destroy(); connections.clear(); };
}, "client-hmr: /plugins/events channel");
```

Failure semantics (README, `docs/subsystems/web-server.md`): a throwing handler answers **400** (or destroys the socket once headers are out) and logs a warning — it never exits the process. A listen failure rejects plugin initialization.

### 3.2 `registerUpgrade` — WebSocket upgrades **[V]**

The webserver does **not** depend on `ws`. It hands the raw socket over; the plugin owns protocol negotiation. Signed type is in §3.1 (`WebUpgradeRoute.handler(req, socket, head)` with `socket: Duplex`, `head: Buffer`).

The shipped WebSocket consumer uses **`ws`** (`^8.21.0`, a direct dependency of `dsh-api-gateway`), instantiated **`noServer: true`**:

```js
// $DSH/dsh-api-gateway/lib/index.js:203
server = new WebSocketServer({ noServer: true });

// $DSH/dsh-api-gateway/lib/index.js:225-240
handleUpgrade(req, socket, head) {
  this.server.handleUpgrade(req, socket, head, (websocket) => {
    this.missedHeartbeats.set(websocket, 0);
    websocket.on("pong", () => { this.missedHeartbeats.set(websocket, 0); });
    this.startHeartbeat();
    /* … */
  });
}

// $DSH/dsh-api-gateway/lib/index.js:460-480
ctx.inject(["connection", "webServer"], (webCtx) => {
  const mux = new RemoteStreamMuxServer(/* … */);
  webCtx.effect(() => {
    const route = {
      path: REMOTE_STREAM_MUX_PATH,
      handler: (req, socket, head) => {
        const rejection = webCtx.connection.requestRejection(req);
        if (rejection !== void 0) { rejectRemoteStreamUpgrade(socket, rejection); return; }
        mux.handleUpgrade(req, socket, head);
      }
    };
    const unregister = webCtx.webServer.registerUpgrade(route);
    return async () => { unregister(); await mux.close(); };
  }, `api-gateway: ${REMOTE_STREAM_MUX_PATH} WebSocket`);
});
```

Note: the shipped gateway **does not bind `/api` for upgrades via `registerUpgrade` alone** — it also gates on `connection.requestRejection(req)` for browser authentication. A third-party plugin that wants the same trust fence must call `ctx.connection.requestRejection(req)` itself (or accept unauthenticated upgrades on loopback). Unmatched upgrade connections are closed by the server. **[V]**

### 3.3 Index injection: the event, `renderIndex`, `tapIndex` **[V]**

Event declaration (`$DSH/dsh-host-webserver/lib/types/index.d.ts:19-28`), verbatim:

```ts
interface Events {
    /**
     * Collect the structured index injection table. Emitted on every index
     * render and every worker boot-payload request; listeners push their
     * current rows, so a row's data is read fresh at emit time.
     * @param table - Mutable row table; listeners append in activation order.
     * @mode emit
     */
    'webserver/index-inject'(table: IndexInjection[]): void;
}
```

Row union (`…/injections.d.ts:11-51`), verbatim:

```ts
export type IndexInjectionPlacement = 'head' | 'body';
export type IndexInjection =
  | { kind: 'global'; name: string; value: unknown }                       // assigns a JSON value to a globalThis property
  | { kind: 'script'; placement: IndexInjectionPlacement; text: string }   // inline classic script
  | { kind: 'script-src'; placement: IndexInjectionPlacement; src: string }// external classic script, parser-blocking when served
  | { kind: 'script-preload'; src: string }                                // advisory preload
  | { kind: 'style'; text: string }                                        // <style> in head
  | { kind: 'html'; placement: IndexInjectionPlacement; html: string };    // raw markup fragment
```

Rendering order (`index.d.ts:126-139`): `renderIndex(html)` renders the fresh structured table into the body, **then** applies every `tapIndex(transform)` in registration order. `applyIndexTaps(html)` runs taps alone. `collectIndexInjections()` performs the emit.

Real consumer (`$DSH/dsh-client-ui-theme/lib/index.js:87-92`), verbatim:

```js
function apply(ctx) {
	ctx.inject(["settings"], (settingsCtx) => {
		settingsCtx.settings.register(THEME_NAMESPACE, ThemeSettingsSchema);
	});
	ctx.on("webserver/index-inject", (table) => {
		const section = readSection(ctx);
		table.push(bootThemeInjection(section.preference, section.fontSize));
	});
}
```

**Which plugins can inject?** The fallback owner is the only renderer. `$DSH/dsh-host-frontend-static/lib/index.js:84-87` builds every index response as:

```js
const renderIndex = async () => {
	return ctx.webServer.renderIndex(await readFile(distIndex, "utf8")).replace(/<head(?:\s[^>]*)?>/i, (open) => `${open}<base href="/">`);
};
ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => { /* … */ }), "frontend-static: fallback seat");
```

So a third-party **`webserver/index-inject` listener works today** (the shipped `frontend-static` seat calls `renderIndex`), but `registerFallback` itself is taken — a second claim throws. To add a `<script>` to `index.html`, push a `script-src` row; `tapIndex` is the escape hatch for markup no row expresses.

The shipped boot protocol is itself built from these rows (`$DSH/dsh-client-modules/lib/index.js:387-432`, `bootInjections`): one inline `script` head row defining `window.__ModuleLoader__` in `'queue'` mode, `script-preload` rows for the application batch, `script-src` head rows for the parser-blocking bootstrap batch, and finally a `global` row for `__DSH_BOOT__`.

### 3.4 `ctx.credentials` **[V]**

Two disjoint key spaces (`$DSH/dsh-credentials/lib/types/types.d.ts:11-54`). Grammar constants, verbatim from `$DSH/dsh-credentials/lib/index.js:13-15`:

```js
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Both halves of a {@link CredentialKey}; the `/` between them is what keeps it out of {@link REF_PATTERN}. */
const KEY_SEGMENT_PATTERN = /^[a-z][a-z0-9-]*$/;
```

* **`CredentialRef`** — a POSIX-style env-var name (`DEEPSEEK_API_KEY`). Ambient/`.env`/store layers.
* **`CredentialKey`** — `"<scope>/<id>"`, **lowercase hyphenated identifiers**, `scope` = *the owning plugin's registered name*, `id` = that plugin's own addressing unit. Built with `credentialKey(scope, id)`, parsed with `parseCredentialKey(value)`; both throw `TypeError` off-grammar. `credentialKeyScope(key)` / `credentialKeyId(key)` split it back.

Record union (`types.d.ts:33-54`), verbatim:

```ts
export interface ApiKeyRecord {
    readonly kind: 'api-key';
    /** The non-empty secret value, when this credential is a key at all. */
    readonly key?: string;
    /** Provider environment values such as `AWS_PROFILE`; names are POSIX identifiers. */
    readonly env?: Readonly<Record<string, string>>;
}
export interface GrantRecord {
    readonly kind: 'grant';
    /** Owner-defined JSON value; opaque to the seam and to every other plugin. */
    readonly payload: unknown;
}
export type CredentialRecord = ApiKeyRecord | GrantRecord;
```

Abstract API (`$DSH/dsh-credentials/lib/types/index.d.ts:119-200`), verbatim signatures:

```ts
export declare abstract class CredentialProvider extends Service {
  abstract resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined>;
  abstract describe(ref: CredentialRef): Promise<CredentialInfo>;
  abstract set(ref: CredentialRef, value: string): Promise<void>;        // rejects empty; use unset()
  abstract unset(ref: CredentialRef): Promise<void>;
  abstract readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>;
  abstract describeRecord(key: CredentialKey): Promise<CredentialRecordInfo>;
  abstract listRecords(): Promise<readonly CredentialRecordEntry[]>;
  /** Serialized read-modify-write over one record — the only write path. */
  abstract modifyRecord(key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>)
    : Promise<CredentialRecord | undefined>;
  abstract deleteRecord(key: CredentialKey): Promise<void>;
}
```

Rules: `resolve` is **per operation, never cached**; an empty stored value reads as absent everywhere; records have no `set` — **`modifyRecord` is the only write path** (read-decide-replace under one lock, so a token refresh is safe); events `credentials/reference-updated(ref)` and `credentials/record-updated(key)`.

Real read usage (`$DSH/dsh-webhook-github/lib/index.js:121-125` + `:186`):

```js
const credential = await ctx.credentials.resolve(config.secretEnv);
if (credential === void 0 || credential.value === "") throw new WebhookHttpError(503, "GitHub webhook secret is unavailable");
/* … */ new Webhooks({ secret: credential.value }).verify(body, signature)
// config side: secretEnv: z.string().role("credential-ref").required(),
//              secretEnv: credentialRef(config.secretEnv)
```

The installed provider is `@deepseek-ai/dsh-credentials-local` (a `dsh-base` row) with source layers `env`, `file`, `project-env`, `user-env` (`index.d.ts:74`). On this machine the store is `/Users/mac/.dsh/.credentials.yaml` (mode 0600, present).

### 3.5 Plugin configuration convention — Schemastery, not zod **[V]**

Verbatim from `docs/user/develop/basic/config.md` L9–45:

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config { greeting: string; maxRetries: number; verbose?: boolean }

export const Config: Schema<Config> = Schema.object({
  greeting: Schema.string().default('Hello'),
  maxRetries: Schema.number().default(3),
  verbose: Schema.boolean().default(false),
})

export function apply(ctx: Context, config: Config) { console.log(config.greeting) }
```

> "Do not export a plain object as `Config`; it does not implement the Standard Schema interface required by Cordis." (L45)

Names: `@deepseek-ai/schemastery` is a **rescoped vendored copy** of `schemastery` (npm latest `3.18.2`), installed at `$DSH/schemastery` and also published as `@deepseek-ai/schemastery@3.18.2`. Every installed plugin uses `import z from "@deepseek-ai/schemastery"`. **zod appears only in `dsh-storage-domain` for its own record schemas** — "plugin `Config` stays schemastery" (`$DSH/dsh-storage-domain/README.md:87`). [V]

Runtime-changeable config is a separate seam: `ctx.settings.register(ns, schema, { base: config })` → `scope.get()`, `scope.update(patch)`, `scope.replace(section)`, `scope.mutate(ops)`; namespace grammar is lowercase letters/digits/hyphens; `describe()` + `redactSecrets: true` back the Plugins settings UI (`$DSH/dsh-settings/README.md:46-70`). [V]

### 3.6 Registering a model-facing tool **[V]**

`defineTool` + `ctx.tools.register`. Signature of `register` (`$DSH/dsh-tools/lib/types/index.d.ts:598-602`), verbatim:

```ts
/**
 * Register globally or in the calling agent scope. Scoped tools shadow
 * globals; duplicates within one layer and the reserved `run_code` name fail.
 * @param definition - tool schema, execution, and optional finalization/presentation callbacks.
 * @returns the exact disposer that unregisters the tool.
 */
register(definition: ToolDefinition): () => void;
```

`defineTool` options (`$DSH/dsh-tools/lib/types/schema.d.ts:178-239`), abbreviated verbatim:

```ts
export interface DefineToolOptions<S extends ParameterSchemaSpec, O extends ValueSchemaSpec> {
    readonly name: string;
    readonly description: string;
    readonly parameters: S;                 // per-property schema, compiled to an implicit OPEN object root
    readonly output: {
        readonly schema: O;
        render(args: InferArgs<S>, value: InferValue<NoInfer<O>>): ContentBlock[];
        presentationMeta?(args, value): JsonValue;
    };
    readonly timeoutMs?: number;
    isConcurrencySafe?(args: InferArgs<S>): boolean;
    execute(args: InferArgs<S>, exec: ToolRunContext): Promise<InferValue<NoInfer<O>>>;
    finalizeContent?(exec, result): ContentBlock[] | undefined;
    presentCall?(args): ToolCallView | undefined;
    presentResult?(args, result): ToolResultView | undefined;
}
export declare function defineTool<const S extends ParameterSchemaSpec, const O extends ValueSchemaSpec>(options: DefineToolOptions<S, O>): ToolDefinition;
export declare function validateArgs(spec: ParameterSchemaSpec, args: unknown): string[];
```

Minimal tutorial example (`docs/user/develop/basic/tool.md` L11–33), verbatim:

```ts
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'greet-tool'
export const inject = ['tools']

export function apply(ctx: Context) {
  ctx.tools.register(defineTool({
    name: 'greet',
    description: 'Greet someone by name.',
    parameters: { name: { type: 'string', required: true, description: 'The name to greet' } },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    async execute(args) { return `Hello, ${args.name}!` },
  }))
}
```

Fuller real example with an agent-owned session and a nested array parameter (`$DSH/dsh-tool-todo/lib/index.js:95-185`, abridged):

```js
ctx.tools.register(defineTool({
  name: "todo_write",
  description: describe(allowParallel),
  parameters: { todos: { type: "array", required: true,
    description: "The COMPLETE task list, replacing any previous list.",
    items: { type: "object", additionalProperties: false, properties: {
      content: { type: "string", required: true, description: "…" },
      status: { type: "string", required: true, enum: [...STATUSES], description: "…" } } } } },
  output: {
    schema: { type: "object", additionalProperties: false, properties: {
      todos: { type: "array", required: true, items: { /* … */ } },
      counts: { type: "object", additionalProperties: false, required: true, properties: {
        pending: { type: "integer", required: true },
        inProgress: { type: "integer", required: true },
        completed: { type: "integer", required: true } } } } },
    render: (_args, value) => [{ type: "text",
      text: `Updated todo list: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.` }]
  },
  execute(args, exec) {
    const todos = toTodoList(args.todos, allowParallel);
    if (!exec.agent) throw new Error("todo_write requires an owning agent session");
    exec.agent.session.append("todo/write", { todos });
    /* … */
  }
}));
```

Notes: `output` is **mandatory**; `presentCall`/`presentResult` return replay-safe view intents for the Web UI; `tools/change` fires on registration change; a tool is never model-visible under a *scoped* restriction the caller's agent does not have. The repo's own tool authoring reference is `docs/cookbook/adding-a-tool.md`.

### 3.7 Sessions and agents **[V]**

* `ctx.sessions: SessionStore` — `$DSH/dsh-session/lib/types/index.d.ts:26-28`.
* `ctx.agents: AgentRegistry` — `$DSH/dsh-agent/lib/types/index.d.ts:20-31`.
* `ctx.agent?: Agent` — the agent association installed as an own property on `Agent.ctx`.
* Inside a tool, `exec: ToolRunContext extends ToolExecution` gives `exec.agent` (used above), `exec.signal`, `exec.deferContext(msg)` and `exec.concludeTurn()` (`$DSH/dsh-tools/lib/types/index.d.ts:284-301`).
* Other host services a plugin can consume: `ctx.tools`, `ctx.jobs` (`JobRegistry`), `ctx.settings`, `ctx.credentials`, `ctx.clientModules`, `ctx.loader`, `ctx.systemPrompt`, `ctx.commands`, `ctx.skills`, `ctx.webServer`, `ctx.connection`, `ctx.subagents`, `ctx.workflowEngine`. Enumerate them at runtime with the `cordis_inspect_query` tool / the generated `docs/config-catalog.md` surface rather than guessing.

**Discipline rules the repo enforces** (from the shipped `cordis-plugin-development` skill, `$DSH/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md` L100-135): prefer `ctx.get('svc')` + absence check for optional services; declare `inject` **only** for hard dependencies (an undeclared `ctx.svc` access is a Guard rejection); every contribution must be reversible via `ctx.on` / `ctx.effect` / a returned disposer.

---

## 4. Installing a local plugin into the `web` profile

### 4.1 What `dsh plugin --profile web add <spec>` actually does **[V]**

Implementation is `$DSH/lib/plugin-F7ZVfRyo.js` (130 lines, read in full). Steps:

1. `resolveProfileDir(profile)`; if `package.json` is absent, `initProfile(dir, PROFILE_TEMPLATES[profile]?.bundles ?? DEFAULT_PROFILE_BUNDLES, patchReload)` (**L102-107**).
2. `spawnSync("pnpm", args.map(a => anchorPathSpec(a, process.cwd())), { cwd: dir, stdio: "inherit" })` (**L109-113**).
3. On success, `reconcilePlugins(before, dir)` (**L122**).
4. Exit codes: `127` + `dsh: pnpm not found on PATH — install pnpm to manage profile plugins` when pnpm is missing (**L114-118**); the pnpm status otherwise, with an extra hint for git specs about pnpm ≥ 10 blocking `prepare` (**L124-126**).

Relative path anchoring (**L79-94**), verbatim:

```js
function anchorPathSpec(argument, cwd) {
	const match = /^(?<prefix>(?:file|link):)?(?<path>\.{1,2}(?:[/\\].*)?)$/.exec(argument);
	if (match?.groups?.path === void 0) return argument;
	return `${match.groups.prefix ?? ""}${resolve(cwd, match.groups.path)}`;
}
```

> Comment on it (L80-86): "pnpm runs with cwd = the profile directory, so a bare `.` or `../plugin` (or their `file:`/`link:` forms) would silently resolve inside the profile — `add .` from a plugin checkout would self-link the profile. Absolute specs, registry names, and every other pnpm argument pass through untouched."

Reconciliation (**L46-78**): for every key in the profile's `dependencies`, if the resolved package's manifest declares `dsh.bundle.patch`, push the **real installed package name** to `dsh.profile.bundles` (appended in dependency order) and rewrite the profile manifest; if a previously-bundled dependency no longer resolves to a bundle, splice it out. A dependency that declares no `dsh.bundle` gets a one-time stderr warning and no layer:

```
dsh: warning: <pkg> declares no dsh.bundle — installed as a plain dependency, not a profile layer (a later update that gains one activates it automatically)
```

### 4.1.1 Does `add <local dir>` LINK or COPY? — **it links (symlink), it does not copy** **[V]**

The `dsh` CLI itself never copies anything: it only rewrites *relative* path specs to absolute ones (`anchorPathSpec`, L90–94) and then hands the argv to `pnpm` in the profile dir (`L109-113`). What pnpm then does with a **directory** spec is the standard pnpm behavior for a local folder dependency: it records the `link:` protocol in the profile manifest and **symlinks** the package directory into the profile's `node_modules`. The tutorial's resulting profile manifest says exactly that (`docs/user/develop/basic/publish.md` L85–101):

```json
{
  "name": "dsh-profile-demo", "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

Practical consequences:

* **Editing the plugin directory edits the installed plugin** — no re-install, no copy step. The node half is imported fresh on each boot.
* The **client half is still read from disk at boot** (`initialBundleSnapshot` → `readFileSync(clientPath)`, `$DSH/dsh-client-modules/lib/index.js:733-760`), so *rebuilding* `lib/client.js` requires either a restart or the HMR chain (`dsh-client-hmr` stat-polls and calls `ctx.clientModules.rebuilt(id)`, `$DSH/dsh-client-hmr/lib/index.js:1-60`). "Rebuild the bundle (`pnpm --filter <pkg> bundle`) before probing a live `dsh web` server — the registry serves `lib/client.js`, not sources." (`packages/client/AGENTS.md` L142)
* A `file:` spec (e.g. `file:../my-plugin`) is a **packed-path** dependency in pnpm semantics and historically copied on install for tarballs; `dsh` treats `file:` and `link:` identically at the CLI layer (pass-through), so behavior is pnpm's decision, not DSH's. **[V-DERIVED — I could not execute an install: pnpm is absent, §4.4]**
* `pnpm pack` + `dsh plugin add ./pkg.tgz` is the **copy** path, and is what the docs recommend for distribution (`publish.md` L176–178).

**So yes — a local directory works**, and `file:` / `link:` forms work too, both because `anchorPathSpec` only rewrites *relative* specs and because reconciliation keys off the installed manifest, not the spec. Tutorial wording, `docs/user/develop/basic/publish.md` L77-101, verbatim:

```sh
dsh plugin --profile demo add ./hello-plugin
```
> "The first use initializes the profile (with `@deepseek-ai/dsh-base` as its first bundle), pnpm links the checkout, and `dsh` appends the bundle to `dsh.profile.bundles` because the package declares `dsh.bundle`"

```json
{
  "name": "dsh-profile-demo", "private": true,
  "dependencies": { "dsh-hello-plugin": "link:/path/to/hello-plugin" },
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "dsh-hello-plugin"] } }
}
```

Verify without booting: `dsh --profile demo --dump-config   # shows a "# == dsh-hello-plugin" layer`. Remove with `dsh plugin --profile demo remove dsh-hello-plugin` (removes both dependency and layer). [V]

### 4.2 Current `web` profile state, and what a minimal local entry looks like **[V]**

`/Users/mac/.dsh/profiles/web/package.json` (verbatim, current):

```json
{
  "name": "dsh-profile-web", "private": true, "dependencies": {},
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"], "patchReload": "live" } }
}
```

`/Users/mac/.dsh/profiles/web/cordis.patch.yml` (verbatim):

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
[]
```

`/Users/mac/.dsh/profiles/web/cordis.yml` is an **empty array** — and it is rewritten on *every* boot (`prepareProfile` → `writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)`, `$DSH/lib/profile-boot-BTzzdrGY.js:155-164`). The comment there explains why: the vendored Loader's tree write-back would otherwise bake composed rows into the file and duplicate every bundle insert on the next boot. **Edit `cordis.patch.yml`, never `cordis.yml`.** [V]

`/Users/mac/.dsh/profiles/web/pnpm-workspace.yaml` (verbatim):

```yaml
packages:
  - .
nodeLinker: hoisted
autoInstallPeers: false
```

Minimal **profile-local** entry, added by hand to `/Users/mac/.dsh/profiles/web/cordis.patch.yml` (works with **no pnpm at all** — this is the escape hatch given §4.4):

```yaml
# A local plugin loaded by absolute path (no install step, no package.json needed for a single file)
- insert:
    - id: my-local-plugin
      name: '/Users/mac/ai_tools/dsh project/网页插件/my-plugin/src/index.js'
      config:
        greeting: 'hi'

# Or a package directory: keep the ONE-LEVEL config merge in mind (see §4.3)
- insert:
    - id: my-local-bundle-plugin
      name: dsh-my-plugin          # bare name resolves against the profile dir / profiles/node_modules
      config: { greeting: 'hi' }
```

Path form is confirmed by the official tutorial (`docs/user/develop/basic/index.md` L48–62): "The plugin path must be absolute. A patch file contributes configuration but does not change the profile directory from which the loader resolves module paths," then `pnpm dsh web --patch ./scratch-plugin/cordis.yml`. For a **client half** the package must still be discoverable as a *package* by `dsh-client-modules` (it locates the nearest ancestor `package.json`, or resolves a bare specifier through the loader), because `exports["./client"]` is read from that manifest (`$DSH/dsh-client-modules/lib/index.js:660-707`). A single-file absolute path with no `package.json` therefore yields **no browser half**. **[V-DERIVED]**

### 4.3 Bundle patch / layer semantics **[V]**

Patch file shape is a **top-level YAML array** of entries; each entry is either

* `- insert: [ <row>, … ]` where a row is `{ id, name, inject?, disabled?, config? }`, or
* `- id: <existing-row-id>` with optional `config:` / `disabled: true` to override.

Verbatim from `$DSH/dsh-base/cordis.patch.yml:15-30`:

```yaml
- insert:
    - id: timer
      name: '@deepseek-ai/cordis-plugin-timer'
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
      disabled: true
      config:
        root: ['.']
```

Verbatim from `$DSH/dsh-web-app/cordis.patch.yml:41-42, 151-158`:

```yaml
# `dsh.client` rows are the browser roster the modules node half scans into
# window.__DSH_BOOT__; the modules row is simultaneously a host row.
…
    # ── browser plugin roster (dsh.client rows; node halves are layer-2 hosts) ──
    - id: modules
      name: '@deepseek-ai/dsh-client-modules'
```

`!!js` expressions are allowed inside `config` and are evaluated against the row's **injected** context — e.g. `host: !!js ctx.webStartup.host ?? '127.0.0.1'` (`$DSH/dsh-web-app/cordis.patch.yml:116-123`). Layer order (from `composeProfile`, `$DSH/lib/profile-boot-BTzzdrGY.js:172-206`, and `docs/user/develop/basic/publish.md` L112–128):

1. each bundle patch in `dsh.profile.bundles` order (`dsh-base` first, then each installed bundle in the order added);
2. the profile's own `cordis.patch.yml`;
3. `$DSH_HOME/cordis.patch.yml` (home-level, applies to every profile — **outranks** the per-profile layer);
4. each `--patch <path>` overlay in argv order;
5. the telemetry switch patch (only when `DSH_TELEMETRY_DISABLED` is set and the row exists).

> "Later layers win per row, and **a patch replaces a row's entire `config` value rather than deep-merging keys**" (`publish.md` L123, emphasis in source). "Later bundle patches and the user's profile `cordis.patch.yml` address these rows by id, with the last write winning per row." (`$DSH/dsh-base/cordis.patch.yml` header)

Row order carries **no load semantics** — activation is service-availability driven (`$DSH/dsh-base/cordis.patch.yml` header comment).

### 4.4 ⚠️ BLOCKER on this machine: pnpm is missing **[V]**

```
$ dsh plugin --profile web --help
dsh: pnpm not found on PATH — install pnpm to manage profile plugins
$ echo $?
127
```

`pnpm` is not installed (`command -v pnpm` → nothing; `corepack` exists only at `/Users/mac/.hermes/node/bin/corepack`, which is *not* on `PATH`). Consequences:

* `dsh plugin --profile web add <anything>` **cannot work** until pnpm is available.
* `dsh --profile web --dump-config` and `dsh --profile web --help` also failed **in my sandbox** with `EPERM: operation not permitted, open '/Users/mac/.dsh/profiles/web/cordis.yml'` — because `prepareProfile` always rewrites that file. That is a **sandbox artifact** (my file policy is workspace-write), not a DSH defect; the already-running GUI proves the profile boots fine outside the sandbox.
* **Workaround that needs no pnpm:** author the plugin with no install step and wire it in through `/Users/mac/.dsh/profiles/web/cordis.patch.yml` (absolute path or a directory already reachable from the profile), or boot with `--patch <file>`. A package with a browser half still needs a real `package.json` with `exports["./client"]` (§4.2).

**Version-pinning trap [V]** — `@deepseek-ai/dsh-*` packages are on npm, but their `latest` dist-tag is a **stub**:

```
@deepseek-ai/dsh-tools         dist-tags: latest=0.0.1-rc.1  next=0.1.5-rc.2  alpha=0.1.5-alpha.2
@deepseek-ai/dsh-client-test-runtime   latest=0.0.1-rc.1  next=0.1.5-rc.2
```

A bare `pnpm add @deepseek-ai/dsh-tools` resolves to **`0.0.1-rc.1`**, not the installed `0.1.2-rc.1`. Pin explicitly (`@deepseek-ai/dsh-tools@0.1.2-rc.1`) or use `@next`.

Git installs have their own catch (`publish.md` L153–178): a git spec fetches **sources, not artifacts**, so the package needs a self-contained `prepare` script, and pnpm ≥ 10 blocks it until the user adds

```yaml
allowBuilds:
  dsh-hello-plugin: true
```

to the profile's `pnpm-workspace.yaml`. Preferred distribution: publish to npm with `lib/` built at `pnpm publish`, or ship a `pnpm pack` tarball (`dsh plugin add ./hello-plugin-0.1.0.tgz`). The doc names `https://github.com/deepseek-harness/turtle-ui` as the worked external example — **that repo returns 404 today [UNVERIFIED]**.

---

## 5. Testing conventions

### 5.1 Framework and naming **[V]**

**Vitest**, everywhere.

| Tier | Command | Include globs / config |
|---|---|---|
| Unit | `pnpm run test` (= `pnpm run build:native-system && vitest run`) | `packages/*/*/tests/**/*.spec.{ts,tsx}`, `apps/*/tests/**/*.spec.ts`, `scripts/**/*.spec.ts` (`vitest.config.ts` L122-126) |
| Coverage gate | `pnpm run test:coverage` | same include; **per-file 100 %** on `packages/*/*/src/**/*.{ts,tsx}` |
| Real-API e2e | `pnpm run test:e2e` (`vitest run --config vitest.e2e.config.ts`) | `*.e2e.ts`; each suite self-skips without its provider key |
| Expected output | `pnpm run test:expected` | `*.expected.e2e.ts` + `tests/expected/` |
| Snapshot | `pnpm run test:snapshot` | recorded `session[.vN].jsonl` scenarios, `snapshot.yml` |
| **Web browser** | `pnpm run test:web` = `npm run build && npm run test:web:built` | `vitest.web.config.ts`: `apps/web/tests/**/*.e2e.ts`, `apps/web/tests/**/*.snapshot.ts` |
| GUI subset | `pnpm run test:gui` | `vitest run packages/client packages/host` |
| Bench / perf / stress | `test:bench`, `test:web:perf`, `test:web:stress` | `*.perf.ts` |

Suffix semantics (`docs/testing.md`): `.spec.ts` = unit; `.e2e.ts` = end-to-end / real-API; `.expected.e2e.ts` = owner-local expected output; `.snapshot.ts` = snapshot-driven; `.perf.ts` = diagnostic only. Tests live in a `tests/` directory beside the code they exercise. Spec files are **not** `*.test.ts` — that pattern does not exist in this repo. `vitest.shared.ts` exports `standardDecoratorPlugin()` (transpiles standard TS decorators before Vite's parser) and `vitestExecArgv` (`--no-webstorage` when available).

### 5.2 Browser/UI harness **[V]**

**Playwright, driving real Chromium over real HTTP**, with the composition booted *in-process*. `apps/web/tests/README.md` L5, verbatim:

> These tests boot the real web composition in-process and drive it with a real Chromium over real HTTP. The lane's mechanics — modes, fixtures, goldens, and the deliberate composition divergences from `dsh web` — are documented in `scaffold.ts` and the [browser e2e Agent Note].

Driver source: `apps/web/tests/support.ts:6` — `import type { Browser, Locator, Page } from 'playwright'`. No puppeteer, no raw CDP. Playwright is a **devDependency of `apps/web`** (`$DSH/dsh-web-frontend/package.json` → `"playwright": "^1.49.0"`). ~180 `*.e2e.ts` files under `apps/web/tests/` with committed goldens under `tests/expected/<scenario>/*.expected.md` and `apps/web/tests/snapshots/<scenario>/`. CI pins `DSH_SNAPSHOT=replay` (read-only); `record`/`refresh` are local-only. `vitest.web.config.ts` sets `testTimeout: 180_000`, `hookTimeout: 120_000`, `fileParallelism: false`.

Client-package unit tests use a different, lighter bench: `@deepseek-ai/dsh-client-test-runtime` ("the jsdom slot test bench for browser feature specs", `packages/test-support/README.md`), which is in `devDependencies` of every shipped `dsh-client-ui-*` package — e.g. `$DSH/dsh-client-ui-goal/package.json` lists `"@deepseek-ai/dsh-client-test-runtime": "^0.1.2-rc.1"`.

### 5.3 What a standalone third-party plugin can realistically use

| Harness | Available? | Notes |
|---|---|---|
| `vitest` + `*.spec.ts` | ✅ | Install `vitest` yourself; the naming convention is your choice but the repo's is `tests/**/*.spec.ts`. |
| `@deepseek-ai/dsh-tools` `defineTool` + direct `execute(args, exec)` call | ✅ | Unit-test your tool body with a hand-made `exec`; do not assert on registry internals. |
| `@deepseek-ai/dsh-client-test-runtime` (jsdom slot bench) | ✅ published (`publishConfig.access: public`), but **pin the version** ([proven @ 0.1.2-rc.1](https://registry.npmjs.org/@deepseek-ai/dsh-client-test-runtime)) | Latest dist-tag is a `0.0.1-rc.1` stub. |
| `@deepseek-ai/dsh-loader-smoke` | ✅ published | "Boots Loader-composed applications and drives fixture turns for smoke tests" — the closest thing to a reusable integration harness. |
| `@deepseek-ai/dsh-llm-replay` / `dsh-llm-mock-server` | ✅ published | Keyless deterministic model streams / scripted fault server. |
| `@deepseek-ai/dsh-session-snapshot` | ✅ published | Session-log snapshot adapters for profile-driven tests. |
| Playwright web lane (`apps/web/tests/scaffold.ts`) | ❌ | Not published; lives in the monorepo and reads Host services (`ctx.connection`, the Host `SessionStore`, `ctx.sessionProjectionCache`) directly. |
| Repo gates (`check:all`, `verify-client-packages`, `publint`, oxlint, jscpd, per-file 100 % coverage) | ❌ | Monorepo-only scripts under `scripts/`. |
| Real-composition smoke | ⚠️ do-it-yourself | The repo's rule — "Product-visible plugins require a non-unit REAL-composition test" (`docs/testing.md` "Test the real entry path") — is the right target even standalone: boot a test-only `cordis.yml` through Loader and assert model-visible output. Realistically: spawn `dsh --profile <test-profile> --patch <test.yml>` and assert on stdout/log/artifacts. **Not packaged for third parties.** |

---

## 6. Surprises worth flagging

1. **The repo's default branch is `master`.** `https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/main/...` 404s; `.../master/...` works. `api.github.com/repos/.../git/trees/main?recursive=1` → 404, `.../master...` → 11 905 paths. **The repo is public and complete**, including `docs/`, `packages/`, `apps/`, `tsdown.config.ts` and the `vitest.*.config.ts` family.
2. **`lib/client.js` is a convention, not a contract.** The host joins `exports["./client"]` with the package.json directory (`$DSH/dsh-client-modules/lib/index.js:640`). You may emit anywhere inside the package — but nothing tells you this, and the error message (`client bundle not found; run pnpm run build before launch`) prints the resolved path, not the expected one.
3. **Only 8 baseline externals on this machine, 9 on `master`.** `@deepseek-ai/dsh-client-ui-dockkit` is the delta. Bundling react or cordis *in* the plugin bundle is not fatal, it silently duplicates module identity (hooks break, `instanceof`/symbol identity splits). This is exactly the failure the repo's purity gate exists to prevent — and a third party has no gate.
4. **`dsh.client.inject` does nothing at runtime.** "Informational only (preflight display, HMR diffing); they do not sequence entry activation or apply order" (`packages/client/AGENTS.md` L140). Only `external` (module graph) and Cordis service `inject` (fiber waiting) order anything — three similarly-named declarations with three different meanings and three different failure modes (table in `AGENTS.md`).
5. **The `/plugins` route is only reachable as `/plugins/??<id>/client.js&rev=<rev>`.** There is no `/plugins/<id>/client.js` served path in the installed build; a hand-made URL 404s (or would, if the SPA fallback did not answer HTML — which the docs explicitly call out as the failure mode avoided by 404ing).
6. **A patch replaces a row's whole `config`, it does not deep-merge.** Restate every key you need at every layer that touches the row.
7. **`dsh plugin` needs `pnpm`, and there is none here** (§4.4). Also `dsh --profile web --dump-config` rewrites `cordis.yml` on every invocation, so it cannot be run from a read-only sandbox.
7b. **`dsh plugin add <local dir>` SYMLINKS the directory (`link:`), it does not copy it** (§4.1.1). Editing the checkout edits the running plugin; only `pnpm pack` + a `.tgz` copies.
8. **npm `latest` for `@deepseek-ai/dsh-*` is a stub (`0.0.1-rc.1`).** Always pin or use `@next`.
9. **Credentials have no `set` for records.** `modifyRecord` (serialized read-modify-write) is the only write path; `set`/`unset` exist only for env-var *references*.
10. **`Config` is Schemastery, not zod**, and `@deepseek-ai/schemastery` is the rescoped vendored copy — importing plain `schemastery` works but yields a second schema identity.
11. **`frontend-static` owns the only fallback seat.** A third-party plugin cannot claim it, but *can* inject into index HTML via `webserver/index-inject` / `tapIndex` today, because that seat calls `renderIndex`.
12. **A plugin that wants the browser trust fence must ask for it.** `registerUpgrade` gives you a raw socket; the shipped gateway additionally calls `connection.requestRejection(req)` before upgrading.

---

## 7. UNVERIFIED / open items

* **`https://github.com/deepseek-harness/turtle-ui`** — named in `docs/user/develop/basic/publish.md` L163 as the working external-plugin example. Both `api.github.com/repos/deepseek-harness/turtle-ui` and the raw/tree endpoints return **404**. The org `deepseek-harness` does not resolve publicly. **No verified worked example of an out-of-tree plugin exists in what I could reach.**
* **A single package declaring both `dsh.bundle` and `dsh.client`** has no shipped exemplar (§1.2). The combination is supported by code reading (two independent readers) but is not documented and not tested by any package I can see. **[V-DERIVED]**
* **The exact `cordis.patch.yml` row shape for a *browser-only* plugin's host half** — i.e. whether `inject` is required in the row when the node half is an empty `apply()` — is not stated. `$DSH/dsh-web-app/cordis.patch.yml` rows for UI packages carry **no** `inject`, e.g. `- id: ui-goal / name: '@deepseek-ai/dsh-client-ui-goal'` (L~300). Rows that need services do carry it (`- id: connection / inject: [webRuntime]`). **[V from examples, not from a spec]**
* **Whether a third-party client bundle can be served successfully when the package is installed via `pnpm add <tarball>`** into the profile — resolution goes through `loader.internal.resolveSync` or `createRequire(baseUrl)`, and I did not run an actual install (no pnpm).
* **`docs/config-catalog.md`** (generated catalog of every plugin `Config`) and **`apps/cli/reference/README.md`** were not read line-by-line; they were superseded for this note by the primary sources above.
* Line numbers in `$DSH/dsh-web-frontend/dist/assets/index-Df-65__b.js` are meaningless (110 lines, one minified ~423 KB line); I cite **byte offsets** instead.

---

## 8. Source index

**Installed (authoritative for 0.1.2-rc.1):**

| Topic | Path |
|---|---|
| WebServer routes/index API | `$DSH/dsh-host-webserver/lib/types/index.d.ts` (141 L), `…/lib/types/injections.d.ts` (60 L), `…/lib/index.js` |
| Client module host half | `$DSH/dsh-client-modules/lib/index.js` (861 L), `…/lib/types/index.d.ts`, `…/lib/types/client/manifest.d.ts` (259 L), `…/lib/types/client/system.d.ts` |
| Credentials | `$DSH/dsh-credentials/lib/types/index.d.ts`, `…/lib/types/types.d.ts`, `…/lib/index.js` |
| Tools | `$DSH/dsh-tools/lib/types/index.d.ts`, `…/lib/types/schema.d.ts`, `$DSH/dsh-tool-todo/lib/index.js` |
| Profile/bundle manifest types | `$DSH/dsh-app-boot/lib/types/profile.d.ts` |
| Canonical host plugin module | `$DSH/dsh-webhook-github/lib/index.js` L158–193 |
| SSE route + disposer | `$DSH/dsh-client-hmr/lib/index.js` L121–160 |
| WebSocket upgrade + `ws` | `$DSH/dsh-api-gateway/lib/index.js` L203, L225–240, L460–480 |
| Index-inject consumer | `$DSH/dsh-client-ui-theme/lib/index.js` L87–92 |
| Fallback seat / renderIndex | `$DSH/dsh-host-frontend-static/lib/index.js` L81–97 |
| Bundle patches | `$DSH/dsh-base/cordis.patch.yml`, `$DSH/dsh-web-app/cordis.patch.yml` |
| CLI `plugin` command | `$DSH/lib/plugin-F7ZVfRyo.js` (130 L), `$DSH/lib/profile-boot-BTzzdrGY.js` L155–206 |
| Shell seed table (installed) | `$DSH/dsh-web-frontend/dist/assets/index-Df-65__b.js` @ bytes 420294, 421120 |
| Dual-face exemplars | `$DSH/dsh-client-modules/package.json`, `$DSH/dsh-client-ui-goal/package.json`, `$DSH/dsh-client-ui-goal/lib/client.js` |
| Plugin-authoring skill (shipped) | `$DSH/dsh-agent-presets/presets/cordis/skills/cordis-plugin-development/SKILL.md` (420 L), `…/editing-cordis-compositions/SKILL.md` (165 L) |
| Live profile | `/Users/mac/.dsh/profiles/web/{package.json,cordis.patch.yml,cordis.yml,pnpm-workspace.yaml}` |

**Repo (`https://github.com/deepseek-ai/deepseek-harness`, branch `master`):**

| Topic | URL |
|---|---|
| First plugin / forms / lifecycle | `.../docs/user/develop/basic/index.md` |
| Config (Schemastery) | `.../docs/user/develop/basic/config.md` |
| Tool DSL | `.../docs/user/develop/basic/tool.md` |
| Package & install, layers, git install | `.../docs/user/develop/basic/publish.md` |
| Services / events framework | `.../docs/user/develop/framework/{index,service,events}.md` |
| Client build preset (**the** client-bundle spec) | `.../packages/client/tsdown.client.ts` (624 L) |
| `PLATFORM_MODULES` | `.../packages/client/web/src/platform.ts` |
| Seed table projection | `.../packages/client/web/src/seed.ts` |
| Client-plugin authoring rules | `.../packages/client/AGENTS.md` (25 KB) |
| Client package map | `.../packages/client/README.md` |
| Client modules subsystem | `.../docs/subsystems/client-modules.md` |
| Web server subsystem | `.../docs/subsystems/web-server.md` |
| Testing policy | `.../docs/testing.md` |
| Root scripts | `.../package.json` |
| Vitest configs | `.../vitest.config.ts`, `vitest.shared.ts`, `vitest.e2e.config.ts`, `vitest.web.config.ts` |
| Root build preset | `.../tsdown.config.ts` |
| Web shell build | `.../apps/web/vite.config.ts`, `.../apps/web/package.json` |
| Browser e2e lane | `.../apps/web/tests/README.md`, `.../apps/web/tests/support.ts`, `.../apps/web/tests/scaffold.ts` |
| Test-support roster | `.../packages/test-support/README.md` |
| Node/postinstall tracelog | `.../docs/postmortem/0001-acp-default-export-drops-inject.md` |
