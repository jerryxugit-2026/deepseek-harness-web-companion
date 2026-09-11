# 03 — Chrome (Manifest V3) platform constraints & APIs for the side-panel + local-app extension

**Status:** research note, no implementation.
**Written:** 2026-09-11. **Target:** Chrome stable lineage ≥ 148 (our lab machine: Chrome 150.0.7871.125, macOS arm64).
**Supersedes:** nothing. **Related:** `01-*`, `02-*` in this directory (app/architecture notes).

The extension under design must (a) show a side panel, (b) embed a local web app (`http://127.0.0.1:3080`, i.e. `dsh web`) in an iframe inside that panel, (c) capture the current page (readability text, selection, viewport screenshot), (d) start/control a local Node process over native messaging, and (e) drive the browser on behalf of an agent (read DOM, click, type, navigate).

### Legend

- **FACT** — statement from an authoritative doc; every claim carries an inline link.
- **INFERENCE** — reasoned from cited sources/code, not stated verbatim in a doc.
- **UNVERIFIED** — cannot be confirmed from docs/source in this pass; the settling experiment is given inline.
- **OBSERVED** — experimentally confirmed by us on Chrome 150.0.7871.125/macOS (parent agent's runs); reports the behaviour, not the contract.

Time-sensitive claims carry an "as of" date. Where a doc URL has no stable anchor, the page title is the citation target and the doc's own "Last updated" date is quoted where known.

---

## 0. Constraint summary and required permission set

| # | Constraint | Consequence for the design |
|---|---|---|
| 1 | A side panel can only render **a local resource inside the extension package** — `PanelOptions.path` "must be a local resource within the extension package" ([sidePanel](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-PanelOptions)) | The `dsh web` UI **cannot** be the panel's document. The iframe is not optional — it is the only mechanism. |
| 2 | MV3 service worker dies after **30 s idle**; a WebSocket alone does not keep it alive (Chrome <116), and even on 116+ **only traffic** resets the timer ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle), [websockets how-to](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)) | WS to `dsh web` must be **owned by the side-panel document** (a normal extension page, not the SW), or held open with a ≤20 s keepalive; the SW must be written to be killed at any moment. |
| 3 | An embedded third-party site "will use the extension origin as the **partition key**", so it cannot see cookies set for it in a normal browsing context ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)) | Cookies for the iframe must be written **by the extension** as `SameSite=None; Secure` for the `127.0.0.1` URL (a `partitionKey` is possible but redundant here — §3.3/§3.4). |
| 4 | `chrome-extension://` pages cannot set `Secure` cookies, hence cannot use `SameSite=None` or `Partitioned` **on their own origin** ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)) | Auth cookies must live on `http://127.0.0.1:3080`, not on the extension origin. |
| 5 | Third-party cookies "are **never blocked** even in subframes if the top-level page for a given tab is a `chrome-extension://` page" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)) | The side panel is the privileged top-level page; the 3P-cookie setting should not break the iframe — but see the tension flagged in §3.5. |
| 6 | Native host `stdout` is **reserved exclusively** for the length-prefixed protocol ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)) | The launcher must spawn `dsh web` with its own pipe (`stdio:['ignore','pipe','pipe']`) and re-emit its stdout as protocol frames; `inherit` corrupts the channel. |
| 7 | Host→Chrome messages are capped at **1 MB**; Chrome→host at **64 MiB** ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)) | The tokenized URL printed by `dsh web` is fine; any large payload (screenshots) must go over HTTP to `127.0.0.1`, not over the native channel. |
| 8 | `captureVisibleTab` requires `<all_urls>` **or** `activeTab`, captures the **active tab of a window**, and is throttled to **2 calls/s** ([tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab), [tabs constants](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)) | Viewport screenshots are cheap to request but not free; pick a permission strategy (§5.1). |
| 9 | `chrome.debugger` gives trusted `Input.*` + the **only** accessibility-tree access, at the cost of the "started debugging this browser" infobar ([debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)) | Agent drive-by-CDP is the only reliable click/type path; the infobar is user-visible and Cancel kills the session. |
| 10 | MV3 default `extension_pages` CSP has **no** `default-src`/`frame-src`/`connect-src`, so framing and connecting to `127.0.0.1` need **no CSP change** ([CSP manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)) | Do **not** add a `content_security_policy` block; adding `default-src` would newly constrain the iframe and socket. |
| 11 | Local Network Access does **not** apply to extensions: "We do not currently have plans to apply LNA restrictions to extensions. Currently, extensions that have the necessary host permissions are allowed to make local network requests." ([LNA Adoption Guide](https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/mobilebasic), updated 2026-05-18) | No LNA prompt for the iframe/WS to `127.0.0.1`. Re-check if Chrome ever widens LNA scope (§7.2). |

**Minimal permission set** (with the install warnings Chrome shows, from the [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list)):

```jsonc
{
  "manifest_version": 3,
  "minimum_chrome_version": "125",          // flat debugger sessions; 116 = WS-in-SW
  "permissions": [
    "sidePanel",        // no warning
    "scripting",        // no warning
    "cookies",          // no warning
    "debugger",         // "Access the page debugger backend" + "Read and change all your data on all websites"
    "nativeMessaging",  // "Communicate with cooperating native applications."
    "offscreen",        // no warning
    "alarms",           // no warning
    "storage"           // no warning
  ],
  "host_permissions": [
    "http://127.0.0.1/*",       // the local app over HTTP + WS
    "<all_urls>"                // page capture / DOM reads / agent driving
  ],
  "side_panel": { "default_path": "sidepanel.html" },
  "action": { "default_title": "Open panel" },
  "content_security_policy": { "extension_pages": "script-src 'self'; object-src 'self';" } // optional; omit to inherit exactly this
}
```

`<all_urls>` "affects all hosts" and "Chrome web store reviews for extensions that use it may take longer" ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)); `activeTab` is the warned-less alternative but is gesture-gated (§5.3).

---

## 1. `chrome.sidePanel` (Chrome 114+, MV3)

Source unless noted: [`chrome.sidePanel` reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel) (page "Last updated 2026-01-19").

### 1.1 Surface and permissions

- Permission: `"sidePanel"`. Availability Chrome 114+, MV3+ ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- "As an extension page, side panels have access to all Chrome APIs" ([reference, Concepts](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)). The panel is therefore a full extension page: it can call `chrome.cookies`, `chrome.scripting`, `chrome.debugger`, `chrome.runtime.connectNative`, etc., and it holds a DOM (so it can own a WebSocket — see §2.4).
- Declared default document: `"side_panel": { "default_path": "sidepanel.html" }`, "a relative path within the extension directory" ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).

### 1.2 The panel **cannot** show a remote URL (confirmed) — this is the core constraint

`setOptions()` takes a [`PanelOptions`](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-PanelOptions):

| Field | Type | Documented constraint |
|---|---|---|
| `path` | string | "The path to the side panel HTML file to use. **This must be a local resource within the extension package.**" |
| `enabled` | boolean | optional, default `true` |
| `tabId` | number | applies the options to that tab only; omitted = default for all tabs |

- `default_path` in the manifest is likewise "a relative path within the extension directory" ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- **FACT (negative):** there is no option, method, or manifest field in the Side Panel API that accepts a URL. The API surface is exactly `close()`, `getLayout()`, `getOptions()`, `getPanelBehavior()`, `open()`, `setOptions()`, `setPanelBehavior()`, events `onOpened`/`onClosed`, and types `CloseOptions`, `GetPanelOptions`, `OpenOptions`, `PanelBehavior`, `PanelClosedInfo`, `PanelLayout`, `PanelOpenedInfo`, `PanelOptions`, `Side`, `SidePanel` ([reference, Types/Methods/Events](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- **Consequence:** embedding `http://127.0.0.1:3080` requires `<iframe src="http://127.0.0.1:3080">` inside a packaged `sidepanel.html`. This is compatible with MV3 policy: the restriction on remotely hosted code targets extension *logic*; "code run in contexts that are isolated from extension APIs (such as iframes and sandboxed pages) are exempt" ([MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)) — **INFERENCE** that a localhost iframe is not "remote code" under that policy, since the docs never name a localhost iframe; a reviewer could still ask why the UI is not packaged.
- The embedded app must not block framing: if `dsh web` ever sends `X-Frame-Options: DENY` or a `Content-Security-Policy: frame-ancestors` that excludes `chrome-extension://<id>`, the iframe will not render. **INFERENCE** (standard web platform behaviour; the extension origin is an opaque-to-the-server scheme, so `frame-ancestors *` or omission is required).
- **OBSERVED:** embedding `http://127.0.0.1:3080` inside a `chrome-extension://` page works on Chrome 150.

### 1.3 Width: no API; the minimum is baked into the browser UI (≈360 px)

- **FACT (negative):** the reference exposes **no** width getter/setter; panel width is user-controlled by dragging. `getLayout()` returns only `{ side: "left" | "right" }` ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#method-getLayout)) — Chrome 140+.
- **FACT (source):** Chromium defines the default *and* minimum content width:

  ```cpp
  // chrome/browser/ui/side_panel/side_panel_entry.h
  // The default and minimum acceptable side panel content width.
  static constexpr int kSidePanelDefaultContentWidth = 360;
  ```

  ([side_panel_entry.h @ 0846458e](https://chromium.googlesource.com/chromium/src/+/0846458e42bede29f9cc39e25f181fbf6b6956cf/chrome/browser/ui/side_panel/side_panel_entry.h#36))

  and the panel's `GetMinimumSize()` returns that constant plus border insets:

  ```cpp
  gfx::Size SidePanel::GetMinimumSize() const {
    const int min_height = 0;
    return gfx::Size(SidePanelEntry::kSidePanelDefaultContentWidth + GetBorderInsets().width(), min_height);
  }
  ```

  ([side_panel.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/views/side_panel/side_panel.cc); resize is clamped to this minimum in `OnResize`.)

- **Practical minimum ≈ 360 px content width** (plus a few px of border); the user's chosen width is persisted per panel id in `prefs::kSidePanelIdToWidth` and overrides the default ([side_panel.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/ui/views/side_panel/side_panel.cc)). Design the embedded app to be usable at 360–400 px.
- **UNVERIFIED:** an upper bound (e.g. an enforced maximum width). *Experiment:* drag the panel divider to its extremes on Chrome 150 and read `document.body.clientWidth` inside `sidepanel.html`; also confirm `kSidePanelDefaultContentWidth` still equals 360 in the shipping build.

### 1.4 Behaviours, per-tab panels, and tab switching

- **Global vs per-tab.** `setOptions({ path, enabled })` with no `tabId` sets the default for every tab; with `tabId` it applies to that tab ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- **Switching tabs (the documented UX):**
  - "The side panel remains open when navigating between tabs (if set to do so)." (global panel)
  - "When a user **temporarily switches to a tab where the side panel is not enabled, the side panel will be hidden**. It will automatically show again when the user switches to a tab where it was previously open."
  - "When the user navigates to a site where the side panel is not enabled, the side panel will **close**, and the extension won't show in the side panel drop-down menu."
  - all from [reference, "Enable a side panel on a specific site"](https://developer.chrome.com/docs/extensions/reference/api/sidePanel).
- **Instance semantics — important for a stateful iframe:** "Note: if the **same path** is set for this `tabId` and the default `tabId`, then the panel for this `tabId` will be a different instance than the panel for the default `tabId`." ([PanelOptions](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-PanelOptions)). **INFERENCE:** a per-tab panel is a separate document with its own iframe → the embedded `dsh web` UI reloads and loses in-page state on every tab switch. Prefer a single **global** panel (no `tabId`) and drive per-tab behaviour by messaging from the SW instead.
- **Opening/closing:**
  - `setPanelBehavior({ openPanelOnActionClick: true })` — "Whether clicking the extension's icon will toggle showing the extension's entry in the side panel. Defaults to `false`"; it is an upsert operation ([PanelBehavior](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-PanelBehavior), [reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
  - `open(options)` (Chrome 116+) "may only be called in response to a user action" — action click, keyboard shortcut, context menu, or a user gesture on an extension page/content script ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
  - `close(options)` (Chrome 141+) requires `tabId` and/or `windowId`. "If only the global side panel is open, the promise returned by the call to `close()` will **reject with an error**. This behavior was changed in Chrome 145, with prior versions falling back to closing the global panel." ([CloseOptions](https://developer.chrome.com/docs/extensions/reference/api/sidePanel#type-CloseOptions)).
  - `getLayout()` Chrome 140+, `onOpened` Chrome 141+, `onClosed` Chrome 142+ ([reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- **Store policy risk:** "Side panel extensions which hijack a user's browsing or search experience" are named violations ([Quality Guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)) — do not auto-open the panel on navigation.
- **UNVERIFIED:** whether keeping the side-panel document open alone prevents SW idle termination. *Experiment:* log `chrome.runtime.onStartup`, a 5 s heartbeat from the SW, and `runtime.getContexts()`; open the panel, do nothing for 5 minutes, and see whether the SW is torn down while the panel document stays alive.

### 1.5 Dev-workflow note: loading an unpacked extension

- The `--load-extension` CLI switch being inert in branded Chrome builds is **UNVERIFIED** by official docs; what *is* documented is narrower: "**Chrome 139: Removing `--extensions-on-chrome-urls` and `--disable-extensions-except` flags in Chrome branded builds**" ([What's new in Chrome extensions](https://developer.chrome.com/docs/extensions/whats-new)).
- The documented replacement path is CDP: `Extensions.loadUnpacked` — "Installs an unpacked extension from the filesystem similar to `--load-extension` CLI flags. Returns extension ID once the extension has been installed", parameter `path` = "Absolute file path", optional `enableInIncognito` ([CDP Extensions domain](https://chromedevtools.github.io/devtools-protocol/tot/Extensions/#method-loadUnpacked)). Related: `Extensions.getExtensions`, `Extensions.uninstall`, `Extensions.triggerAction`.
- **OBSERVED:** `Extensions.loadUnpacked` works on Chrome 150 but fails when the extension directory path contains a space. **UNVERIFIED as a general rule** — treat as a possible upstream bug, not a contract. *Experiment:* retry with a quoted/percent-encoded path, and with a symlink to the same directory, to determine whether the space itself or the shell quoting is at fault.

---

## 2. MV3 service worker lifetime

Source unless noted: [extension service worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) (page "Last updated 2023-05-02", so version notes are authoritative but the modern behaviour is corroborated by the WebSocket how-to and release notes).

### 2.1 Exact numbers

| Condition | Value | Source |
|---|---|---|
| Terminate after inactivity | **30 s**; "Receiving an event or calling an extension API resets this timer." | [lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle) |
| Single request/event taking too long | **5 minutes** | same |
| `fetch()` response taking too long | **30 s** | same |
| Global variables | lost on termination ("Persist data rather than using global variables") | same |
| Web Storage | "not available for extension service workers" | same |
| `chrome.alarms` minimum period | **30 s** — "Chrome limits alarms to at most once every 30 seconds… setting `delayInMinutes` or `periodInMinutes` to less than 0.5 will not be honored and will cause a warning." Unpacked extensions are exempt from the floor | [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms#method-create) |
| Message size (extension messaging) | **64 MiB** max | [messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging) |

### 2.2 What keeps the SW alive (version-gated)

- **Chrome 110** — "Extension API calls reset the timers." (before this, only a *running* handler kept it alive) ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
- **Chrome 109** — "Messages sent from an offscreen document reset the timers."
- **Chrome 105** — "Connecting to a native messaging host using `chrome.runtime.connectNative()` will keep a service worker alive. **If the host process crashes or is shut down, the port is closed and the service worker will terminate after timers complete.** Guard against this by calling `chrome.runtime.connectNative()` in the port's `onDisconnect` event handler."
- **Chrome 114** — "Sending a message with long-lived messaging keeps the service worker alive. **Opening a port no longer resets the timers.**"
- **Chrome 116** — "Active WebSocket connections now extend extension service worker lifetimes. Sending or receiving messages across a WebSocket in an extension service worker resets the service worker's idle timer." Also: `desktopCapture.chooseDesktopMedia()`, `identity.launchWebAuthFlow()`, `management.uninstall()`, `permissions.request()` are allowed past the 5-minute limit.
- **Chrome 118** — "Active debugger sessions created using the `chrome.debugger` API now keep the service worker alive." Implementation uses an explicit `kDoesNotTimeout` keepalive counted on attach ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle); [debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)) — **INFERENCE:** a *lease*, revoked the moment DevTools opens on the tab, the user clicks Cancel on the infobar, or the tab closes.
- **Chrome 120** — alarms minimum period set to 30 s "to match the service worker lifecycle".
- Startup: "When a user profile starts, the `chrome.runtime.onStartup` event fires but **no service worker events are invoked**" — so "the SW is running" is never something you can assume.

### 2.3 Does a WebSocket to a local server survive SW termination? **No.**

- **Chrome <116 (documented):** "Previously, a service worker could become inactive despite a WebSocket connection being active if no other extension events occurred for 30 seconds. **This would terminate the service worker and close the WebSocket connection.**" ([Use WebSockets in service workers](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)).
- **Chrome ≥116 (documented):** the SW stays up **only while messages flow**, and the documented pattern is an explicit keepalive:

  ```js
  function keepAlive() {
    const id = setInterval(() => {
      if (webSocket) webSocket.send('keepalive'); else clearInterval(id);
    }, 20 * 1000);   // 20 s < 30 s idle window
  }
  ```

  with `"minimum_chrome_version": "116"` in the manifest ([how-to](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)).
- **INFERENCE:** even with the keepalive, the 5-minute single-event limit, a crash, an extension update, or a browser restart still ends the WS; every consumer must treat the socket as reconnectable and re-establish it in `onStartup`/`onInstalled`/lazily.
- **UNVERIFIED:** whether an *idle* WS with a server-side ping every <30 s keeps the SW alive indefinitely (the doc states WS traffic resets the idle timer, but not that the 5-minute rule is waived for socket-idle periods). *Experiment:* connect, have the server send a byte every 10 s, never call a Chrome API, and log SW `onStartup`/`onSuspend`-equivalent heartbeats for 30 minutes.

### 2.4 Recommended patterns for this design

1. **Put the socket in the side panel document, not the SW.** The panel is a normal extension page with a DOM and a full API surface ([sidePanel reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)); its lifetime is user-driven, and it can talk to the SW over `chrome.runtime.connect`. **INFERENCE:** this eliminates the 30 s problem for the event stream. The SW keeps only queued/durable work. Caveat: the panel is a *different instance* per tab when per-tab panels are used (§1.4).
2. **If the socket must live in the SW:** keepalive every 20 s (§2.3) and reconnect in `onDisconnect`/on startup. Do not hold state in globals — use `chrome.storage.session`/`local` ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
3. **Use one long-lived `chrome.runtime.connectNative` port as the SW's lifeline when the local host is expected to be up** (Chrome 105+), and re-open it in `onDisconnect` — this is the *documented* keeper pattern ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)). Combine with `chrome.alarms` (period ≥ 30 s) as a supervision heartbeat so the SW is revived if the port drops.
4. **Offscreen documents are not a WebSocket keeper.** Valid `Reason` values are `TESTING`, `AUDIO_PLAYBACK`, `IFRAME_SCRIPTING`, `DOM_SCRAPING`, `BLOBS`, `DOM_PARSER`, `USER_MEDIA`, `DISPLAY_MEDIA`, `WEB_RTC`, `CLIPBOARD`, `LOCAL_STORAGE`, `WORKERS`, `BATTERY_STATUS`, `MATCH_MEDIA`, `GEOLOCATION` ([offscreen reference](https://developer.chrome.com/docs/extensions/reference/api/offscreen#type-Reason); identical enum in [Chromium `offscreen.webidl`](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/api/offscreen.webidl)) — **there is no `WEB_SOCKET` reason**; use `WORKERS`. Constraints: only **one** offscreen document may be open per profile ("an installed extension can only have one open at a time"); "the `chrome.runtime` API is the only extensions API supported by offscreen documents"; the URL "must be a static HTML file bundled with the extension"; it cannot be focused; `AUDIO_PLAYBACK` auto-closes after 30 s without audio, "All other reasons don't set lifetime limits"; `chrome.offscreen.hasDocument()` exists since Chrome 150 ([offscreen reference](https://developer.chrome.com/docs/extensions/reference/api/offscreen)).
5. **Structured-clone messaging (Chrome 148+)** is opt-in and can carry `ArrayBuffer`s/`Blob`s without JSON round-tripping ([What's new, 2026-04-22](https://developer.chrome.com/docs/extensions/whats-new)). Default remains JSON: "In Chrome, the message passing APIs use JSON serialization… `undefined` will be serialized as `null`" ([messaging](https://developer.chrome.com/docs/extensions/develop/concepts/messaging)).

---

## 3. Cookies: extension ↔ `http://127.0.0.1:3080`

### 3.1 The `chrome.cookies` contract

- **Permissions:** "declare the `"cookies"` permission in your manifest **along with host permissions for any hosts whose cookies you want to access**", e.g. `"host_permissions": ["*://*.google.com/"]` ([cookies reference, Permissions](https://developer.chrome.com/docs/extensions/reference/api/cookies)). For `details.url`: "**If host permissions for this URL are not specified in the manifest file, the API call will fail.**" ([cookies reference](https://developer.chrome.com/docs/extensions/reference/api/cookies#method-set)). So `host_permissions` must cover `http://127.0.0.1/*`; `<all_urls>` also covers it ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)).
- **`set(details)` fields** ([reference](https://developer.chrome.com/docs/extensions/reference/api/cookies#method-set)): `url` (required; defines default domain/path), `name`, `value`, `domain`, `path`, `secure` (default `false`), `httpOnly` (default `false`), `sameSite` (default `"unspecified"`), `expirationDate` (seconds since epoch; omitted ⇒ session cookie), `storeId`, `partitionKey`.
- **`sameSite` enum** ([SameSiteStatus](https://developer.chrome.com/docs/extensions/reference/api/cookies#type-SameSiteStatus)): `"no_restriction"` = `SameSite=None`, `"lax"` = `SameSite=Lax`, `"strict"` = `SameSite=Strict`, `"unspecified"` = no attribute.
- **`SameSite=None` requires `Secure` by spec.** RFC 6265bis step 19: "If the cookie's 'same-site-flag' is 'None', abort … unless the cookie's secure-only-flag is true" ([6265bis §5.4](https://raw.githubusercontent.com/httpwg/http-extensions/main/draft-ietf-httpbis-rfc6265bis.md)). Chrome states the dependency from the other direction for extension origins: extension pages cannot use `SameSite=None` because "the `Secure` cookie attribute is only supported for the `https://` scheme", and "this also means that extension pages cannot use other cookie attributes where the Secure attribute is required: **SameSite=None**, **Partitioned**" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)). See also the canonical `Secure; SameSite=None; Partitioned` combination in [CHIPS](https://developer.chrome.com/docs/privacy-sandbox/chips/).
- **Chromium does not enforce that pairing at set time through the extension API.** `CookiesSetFunction::Run` → `CanonicalCookie::CreateSanitizedCookie` contains no SameSite/Secure consistency check; it only attaches a warning reason (`WARN_SAMESITE_NONE_INSECURE`) ([cookies_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/cookies/cookies_api.cc), [canonical_cookie.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/canonical_cookie.cc), [cookie_inclusion_status.h](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_inclusion_status.h)). So there is **no documented error string** for this case. **UNVERIFIED:** the observable outcome of `sameSite:'no_restriction'` with `secure:false`. *Experiment:* call `chrome.cookies.set({url:'http://127.0.0.1:3080/', name:'t', value:'1', sameSite:'no_restriction'})`, then check (a) the returned `Cookie.secure`, and (b) whether a cross-site `fetch()` from the panel carries the cookie. Keep `secure:true` regardless.

### 3.2 Is `http://127.0.0.1` a trustworthy origin for `Secure` cookies? **Yes — by spec and by Chromium code path.**

- **Spec:** "If origin's host matches one of the CIDR notations **127.0.0.0/8** or **::1/128**, return 'Potentially Trustworthy'." ([Secure Contexts §3.1](https://w3c.github.io/webappsec-secure-contexts/#is-origin-trustworthy)). The same section allows user agents to "extend this trust to other, vendor-specific URL schemes like `app:` or `chrome-extension:`" — the normative hook behind Chromium treating extension origins as secure. Chromium's own security FAQ lists the secure/trustworthy origins as `(https,*,*)`, `(wss,*,*)`, `(*,localhost,*)`, `(*,127/8,*)`, `(*,::1/128,*)`, `(file,*,—)`, `(chrome-extension,*,—)` ([Chromium security FAQ](https://chromium.googlesource.com/chromium/src/+/main/docs/security/faq.md)). RFC 6265bis explicitly leaves the definition to the UA: "the notion of a 'secure' connection is not defined by this document … most user agents consider 'https' … and 'localhost' to be trusted host" ([6265bis §5.6](https://raw.githubusercontent.com/httpwg/http-extensions/main/draft-ietf-httpbis-rfc6265bis.md)).
- **Chromium accepts `Secure` cookies from a trustworthy (non-cryptographic) URL** and normalizes them: `ShouldTreatUrlAsTrustworthy` → `IsUrlPotentiallyTrustworthy` ([cookie_access_delegate_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/services/network/cookie_access_delegate_impl.cc)); `IsSetPermittedInContext` returns `kTrustworthy` for loopback, sets `is_allowed_to_access_secure_cookies = true` and adds `WARN_SECURE_ACCESS_GRANTED_NON_CRYPTOGRAPHIC` ([cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_base.cc), [cookie_util.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_util.cc)); and `CreateSanitizedCookie` rewrites `source_scheme` to `kSecure` with source port 443:

  ```cpp
  if (parsed_cookie.IsSecure() || url.SchemeIsCryptographic()) {
    // It's possible that a trustworthy origin is setting this cookie with the
    // `Secure` attribute even if the url's scheme isn't secure. In that case
    // we'll act like it was a secure scheme. ...
    source_scheme = CookieSourceScheme::kSecure;
    if (!url.SchemeIsCryptographic())
      status->AddWarningReason(CookieInclusionStatus::WarningReason::
                                  WARN_TENTATIVELY_ALLOWING_SECURE_SOURCE_SCHEME);
  }
  ```

  ([canonical_cookie.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/canonical_cookie.cc); source port normalized by `GetAndAdjustPortForTrustworthyUrls` in the same file.)
- **And it is sent over plain http to loopback:** `IncludeForRequestURL` documents "Secure cookies should not be included in requests for URLs with an insecure scheme, **unless it is a localhost url**, or the CookieAccessDelegate otherwise denotes them as trustworthy" ([cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_base.cc)).
- **Conclusion (FACT + INFERENCE):** `chrome.cookies.set({ url: "http://127.0.0.1:3080/", secure: true, sameSite: "no_restriction" })` succeeds, and the cookie **is sent over plain `http://127.0.0.1:3080`**, because 127.0.0.0/8 is potentially trustworthy. The port-normalization detail matters only for same-site computation, not cookie matching. **INFERENCE.**
- **The doc-vs-code caveat:** the guide's sentence "The `Secure` cookie attribute is only supported for the `https://` scheme… extension pages cannot use… `SameSite=None`, `Partitioned`" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies), page last updated 2023-09-28) is about cookies whose **URL is a `chrome-extension://` URL**. It does **not** govern a Secure cookie set *for a loopback URL* through the API. Prefer the code + experiment over that sentence. **INFERENCE**, corroborated by OBSERVED behaviour below.

### 3.3 `partitionKey` (CHIPS) — supported on set/get/getAll/remove

- "Partitioned cookies allow a site to mark that certain cookies should be keyed against the origin of the top-level frame… **By default, all API methods operate on unpartitioned cookies.** The `partitionKey` property can be used to override this behavior." ([cookies reference, Partitioning](https://developer.chrome.com/docs/extensions/reference/api/cookies)).
- `CookiePartitionKey` (Chrome 119+) — `topLevelSite`: "The top-level site the partitioned cookie is available in"; `hasCrossSiteAncestor` (Chrome 130+): "Indicates if the cookie was set in a cross-cross site context. **This prevents a top-level site embedded in a cross-site context from accessing cookies set by the top-level site in a same-site context.**" ([CookiePartitionKey](https://developer.chrome.com/docs/extensions/reference/api/cookies#type-CookiePartitionKey)).
- `partitionKey` appears on the `Cookie` type, `CookieDetails` (used by `get`/`getAll`/`remove`), and the `set()` details object — i.e. **all four of set/get/getAll/remove accept it**; `getPartitionKey(FrameDetails)` is Chrome 132+ ([cookies reference](https://developer.chrome.com/docs/extensions/reference/api/cookies), [Partitioning](https://developer.chrome.com/docs/extensions/reference/api/cookies#partitioning)). Partition key = "the site (scheme and registrable domain) of the top-level URL" ([CHIPS](https://developer.chrome.com/docs/privacy-sandbox/chips)).
- **`hasCrossSiteAncestor` if you omit it: Chromium computes it, and for us it computes `true`.** The extension API derives it as `!net::SiteForCookies::FromUrl(url).IsFirstParty(top_level_site)` ([cookies_helpers.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/cookies/cookies_helpers.cc)); with `topLevelSite = "chrome-extension://<id>"` and `url = "http://127.0.0.1:3080"` that expression is **true**, i.e. the API records the cookie as set in a cross-site context. `chrome-extension:` origins are not opaque, so the key serializes fine ([cookie_partition_key.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_partition_key.cc)). The CHIPS spec's browser-extension section likewise says the partition key for extension-page subresources "should be the extension URL" when the extension lacks host permissions for the framed site ([CHIPS explainer](https://raw.githubusercontent.com/privacycg/CHIPS/main/README.md)).
- **INFERENCE (correcting an earlier guess):** you cannot make `hasCrossSiteAncestor` `false` for a normal `http(s)://` frame inside an extension page by omitting the field — the computed value is `true`. Since the extension top-level scheme is already 3P-exempt (§3.5), partitioning is **redundant** here; see §3.4.
- **Why partitioning matters to us (FACT, this is the load-bearing sentence):** "**When an extension embeds a third-party site, that site will use the extension origin as the partition key.** This means the site won't be able to access the same cookies as if it were navigated to directly. See [crbug.com/1463991](https://crbug.com/1463991)." ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)). I.e. the iframe's cookie jar is keyed by `chrome-extension://<id>`, so cookies that `dsh web` or a normal tab set on `127.0.0.1` will **not** be visible inside the panel.
- **OBSERVED:** a partitioned cookie with `partitionKey.topLevelSite = "chrome-extension://<id>"` worked inside the iframe on Chrome 150.
- **Storage parallel (same doc):** "If a page with the `chrome-extension://` scheme includes an iframe, and the extension has host permissions for the site it is embedding, that site will also have access to its top-level partition" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)) — so with `host_permissions: ["http://127.0.0.1/*"]`, `localStorage`/IndexedDB inside the iframe use the top-level partition. **Practical implication:** the app's own client-side storage behaves like a fresh profile inside the panel.

### 3.4 Recommended cookie setup for the iframe

Because of §3.3 the extension must be the one writing the cookie. Two shapes were experimentally validated; **Shape A is the recommended one** and Shape B is redundant for our topology (see below):

```js
// Shape A — unpartitioned, cross-site capable (works for fetch + WS handshake) ← USE THIS
await chrome.cookies.set({
  url: "http://127.0.0.1:3080/",
  name: "dsh_session", value: token,
  secure: true, httpOnly: true,
  sameSite: "no_restriction",              // = SameSite=None
  path: "/",
  expirationDate: Math.floor(Date.now()/1000) + 3600,
});

// Shape B — partitioned (CHIPS). Works, but redundant once the top frame is chrome-extension://
await chrome.cookies.set({
  url: "http://127.0.0.1:3080/",
  name: "dsh_session", value: token,
  secure: true, httpOnly: true, sameSite: "no_restriction",
  partitionKey: { topLevelSite: `chrome-extension://${chrome.runtime.id}` },
});
```

- **Why Shape A is enough:** the extension top-level scheme is on Chromium's third-party-cookie allow-list (§3.5), so the loopback cookie is not treated as a blocked third-party cookie; partitioning "buys nothing" beyond that. **INFERENCE** from the code in §3.5 + the docs sentence quoted there. Shape B remains useful as a *diagnostic* if the panel is ever placed under a non-extension top level (e.g. a future content-script-hosted UI).
- **Do not use `sameSite: "strict"` for the iframe's session cookie.**
- **OBSERVED:** `sameSite:'strict'` *was* sent for `fetch` but **not** for the WebSocket handshake, which broke the app's event stream; Shape A and Shape B both worked for fetch and WS.
- **Documented half of the explanation:** "Requests from an extension to a third-party are treated as same-site if the extension has host permissions for the third-party. This means `SameSite=Strict` cookies can be sent. **Note that this only applies to network requests, not access through `document.cookie` in JavaScript, and does not apply if third-party cookies are blocked.**" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)).
- **But that documented exemption probably is *not* what made `fetch` work**, because Chromium gates it on a cryptographic scheme: `url_request_http_job.cc` sets `force_ignore_site_for_cookies` from `CookieAccessDelegate::ShouldIgnoreSameSiteRestrictions`, which returns `false` when `!url.SchemeIsCryptographic()` ([services/network/cookie_settings.cc](https://chromium.googlesource.com/chromium/src/+/main/services/network/cookie_settings.cc), [url_request_http_job.cc](https://chromium.googlesource.com/chromium/src/+/main/net/url_request/url_request_http_job.cc)) — and our URL is plain `http://127.0.0.1`. Meanwhile `cookie_util.cc` documents that "strict" and "lax" cookies can be included for "requests initiated by extensions" ([cookie_util.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_util.cc)).
- **Why `WebSocket` differs from `fetch`: UNVERIFIED — no authoritative documentation.** Two candidate mechanisms, both unresolved: (i) the WS stack evaluates cookie access from its stored `IsolationInfo`/`site_for_cookies` (`WebSocket::AllowCookies` builds a `net::StaticCookiePolicy` from `isolation_info_.site_for_cookies()`, [services/network/websocket.cc](https://chromium.googlesource.com/chromium/src/+/main/services/network/websocket.cc)), which the renderer supplies ([websocket_connector_impl.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/websockets/websocket_connector_impl.cc)); (ii) some other SameSite-context difference in the WS-initiated `URLRequest`. Note that per spec there is *no* WebSocket-specific cookie rule: the handshake is a Fetch request with `mode:"websocket"`, **credentials mode `"include"`**, `cache:"no-store"` ([HTML §2.1](https://html.spec.whatwg.org/multipage/web-sockets.html)), and Fetch runs the same "append a request `Cookie` header" → `retrieve cookies` + same-site-mode algorithm ([Fetch §3.1.1](https://fetch.spec.whatwg.org/#http-cookies)). A public report of the same class of failure exists: [issuetracker 41497063 — "Cookie sameSite=strict not included during WebSocket connection on same domain"](https://issuetracker.google.com/issues/41497063).
- *Experiment to settle it:* point the local server at a handler that logs the raw `Cookie` request header for both `GET /` (fetch) and `GET /` with `Upgrade: websocket`; from the extension page set three `secure:true` cookies (`strict`, `lax`, `no_restriction`) and diff the headers across four contexts (panel/iframe × fetch/WS), with and without `host_permissions` for `127.0.0.1`. Corroborate with `chrome://net-export` (`URL_REQUEST`/`COOKIE_*` events).

### 3.5 "Block third-party cookies" — extension top-level frames are exempt (two code paths)

- **FACT (doc):** "**Third-party cookies are never blocked even in subframes if the top-level page for a given tab is a `chrome-extension://` page.**" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)). Our side panel *is* that top-level page, so the `127.0.0.1` iframe is privileged. **INFERENCE** (grounded in the quoted sentence, not stated as "extension side panels are exempt").
- **FACT (code, two independent mechanisms — this is why the exemption survives 3P blocking):**
  1. `content_settings::CookieSettings::ShouldAlwaysAllowCookies` — "Allow cookies if the `site_for_cookies` and the `url` match in scheme and both have the Chrome extensions scheme" ([cookie_settings.cc](https://chromium.googlesource.com/chromium/src/+/main/components/content_settings/core/browser/cookie_settings.cc), [services/network/cookie_settings.cc](https://chromium.googlesource.com/chromium/src/+/main/services/network/cookie_settings.cc)).
  2. `IsThirdPartyCookiesAllowedScheme(first_party_url.GetScheme())` → `AllowAllCookies{kAllowByScheme}`, where the allowed-scheme set includes the extension scheme: `{kChromeDevToolsScheme, kExtensionScheme}` ([cookie_settings_base.cc](https://raw.githubusercontent.com/chromium/chromium/main/components/content_settings/core/common/cookie_settings_base.cc), [content_settings_registry.cc](https://chromium.googlesource.com/chromium/src/+/main/components/content_settings/core/browser/content_settings_registry.cc)) and `third_party_cookies_allowed_schemes = {extensions::kExtensionScheme, kChromeDevToolsScheme}` ([profile_network_context_service.cc](https://raw.githubusercontent.com/chromium/chromium/main/chrome/browser/net/profile_network_context_service.cc)). `first_party_url` comes from `site_for_cookies`/the top-frame origin, i.e. `chrome-extension://<id>`.

  Cookies that *would* be blocked receive `EXCLUDE_USER_PREFERENCES` / `EXCLUDE_THIRD_PARTY_PHASEOUT` ([services/network/cookie_settings.cc](https://chromium.googlesource.com/chromium/src/+/main/services/network/cookie_settings.cc)); the allow-by-scheme path short-circuits that for extension top-level pages.
- **FACT (the doc's second bullet, and why it is narrower than it looks):** the same doc says the same-site treatment for extension requests "**does not apply if third-party cookies are blocked**" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)). Given the code above, the coherent reading is: the *cookie send* is still allowed (allow-by-scheme), while the *same-site upgrade* that lets `SameSite=Strict` through is lost. **INFERENCE.** **UNVERIFIED:** the exact observable split on Chrome 150. *Experiment:* enable "Block third-party cookies", then from the side panel measure, on **both** `fetch` and the WS handshake: (a) unpartitioned `SameSite=None;Secure`, (b) unpartitioned `SameSite=Strict`, (c) partitioned CHIPS. Report which of the six still carries a `Cookie:` header.
- **CHIPS survives 3P blocking by design:** "CHIPS, the Storage Access API, and Related Website Sets are the only way to read and write cookies from cross-site contexts, such as iframes, **when third-party cookies are blocked**"; a partitioned cookie lands in a jar "designated only for cookies that the site C sets when it's embedded on site A. The browser will only send that cookie when the top-level site is A." ([CHIPS](https://developer.chrome.com/docs/privacy-sandbox/chips/)). Note CHIPS also requires `Secure` (same page), which loopback satisfies (§3.2) — and Chromium accepts loopback in the partition-validity check ([cookie_base.cc](https://chromium.googlesource.com/chromium/src/+/main/net/cookies/cookie_base.cc)). **INFERENCE:** Shape B is *available* insurance, but with a `chrome-extension://` top level it is redundant (§3.4).
- **FACT (staleness caveat):** "Note that settings around third-party cookies are affected by the Privacy Sandbox work and are adjusted according to its timeline." ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)) — see §7.1.
- **UNVERIFIED (product surface):** whether current Chrome stable still exposes "Block third-party cookies" to ordinary users at all; the Privacy Sandbox "Cookie blocking" page (last updated 2025-12-18) still describes a 1% test-group restriction that the Oct 2025 announcement superseded. *Experiment:* inspect `chrome://settings/cookies` radio options on a fresh profile on Chrome 150.
- **Permissions for all of the above (FACT):** `"cookies"` plus host permissions for the hosts whose cookies you touch; `getAll` "only retrieves cookies for domains that the extension has host permissions to" ([cookies permissions](https://developer.chrome.com/docs/extensions/reference/api/cookies#permissions)). **INFERENCE:** `<all_urls>` includes `http://*/*` and should suffice, but declaring an explicit `"http://127.0.0.1/*"` is the cheap, guaranteed-correct choice.

---

## 4. Native messaging (macOS, MV3)

Sources: [Native messaging concept page](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) (page "Last updated 2023-02-27"), [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list), plus the cited Chromium sources.

### 4.1 Host manifest schema

```json
{
  "name": "com.dsh.web",
  "description": "dsh web bridge",
  "path": "/Users/mac/ai_tools/dsh/bin/dsh-native-host",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://<pinned-extension-id>/"]
}
```

| Field | Documented constraint |
|---|---|
| `name` | "can only contain lowercase alphanumeric characters, underscores and dots. The name can't start or end with a dot, and a dot can't be followed by another dot." Must equal the string passed to `connectNative`/`sendNativeMessage` |
| `description` | "Short application description." |
| `path` | "Path to the native messaging host binary. **On Linux and macOS the path must be absolute.**" — "The host process is started with the current directory set to the directory that contains the host binary." |
| `type` | "one possible value: `stdio`" |
| `allowed_origins` | "List of extensions that should have access to the native messaging host. **allowed-origins values can't contain wildcards.**" |

(all from [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging); a source-only extra field `supports_native_initiated_connections` exists behind the `kOnConnectNative` feature in [native_messaging_host_manifest.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/native_messaging_host_manifest.cc)).

- **FACT (negative) — there is no `args` field.** The documented schema is exactly the five fields above (plus the source-only `supports_native_initiated_connections`); Chrome defines no way to pass command-line arguments to the host. The only arguments Chrome supplies are positional: "The first argument to the native messaging host is the origin of the caller, usually `chrome-extension://[ID of allowed extension]`", and on Windows an extra `--parent-window=<handle>` ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). **INFERENCE:** any parameters our host needs (project root, port, `dsh` binary path) must be baked into the launcher script or sent as the first protocol message — not via the manifest. *Experiment (cheap confirmation):* add an `"args": ["--foo"]` key to the manifest and observe that it is ignored (or that the manifest fails to parse), while `argv[1]` remains the extension origin.

- **Format:** `chrome-extension://<extension-id>/` — the official example is `"allowed_origins": ["chrome-extension://knldjmfmopnpolahpmmgbagdohdnhkik/"]` ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). Chromium parses each entry as a `URLPattern` with `SCHEME_EXTENSION` and hard-rejects wildcards (`match_all_urls`/`match_subdomains` → "Pattern … is not allowed"); a manifest that fails to parse surfaces to the extension as `Specified native messaging host not found.` ([native_messaging_host_manifest.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/native_messaging_host_manifest.cc), [launch_context.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context.cc)).
- **UNVERIFIED:** whether the trailing slash is *required* (every official example has it). *Experiment:* drop the slash, call `connectNative`, and watch Chrome's stderr for `Specified native messaging host not found.` vs a working port.

### 4.2 Exact macOS install path

Per the "Native messaging host location" section ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)):

| Scope | Chrome | Chrome for Testing | Chromium |
|---|---|---|---|
| user | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/<name>.json` | `~/Library/Application Support/Google/ChromeForTesting/NativeMessagingHosts/` | `~/Library/Application Support/Chromium/NativeMessagingHosts/` |
| system | `/Library/Google/Chrome/NativeMessagingHosts/<name>.json` | `/Library/Google/ChromeForTesting/NativeMessagingHosts/` | `/Library/Application Support/Chromium/NativeMessagingHosts/` |

- Directory spelling is `NativeMessagingHosts` — **one word, no space**. User-level hosts live in the `NativeMessagingHosts/` **subdirectory of the user profile directory** (same doc), which is also why `--user-data-dir=/x` implies `/x/NativeMessagingHosts/`.
- "In versions of Chrome earlier than Chrome 146, Google Chrome for Testing used the same locations as Google Chrome."
- Linux equivalents: `/etc/opt/chrome/native-messaging-hosts/`, `~/.config/google-chrome/NativeMessagingHosts/`.
- **UNVERIFIED (but near-certain):** Chrome Canary → `~/Library/Application Support/Google/Chrome Canary/NativeMessagingHosts/`, and any `--user-data-dir` → `<that dir>/NativeMessagingHosts/`. Not in Chrome's table; derived from the profile-subdirectory rule plus Chromium's [user_data_dir.md](https://chromium.googlesource.com/chromium/src/+/main/docs/user_data_dir.md). Settle by dropping a manifest in each candidate directory and calling `connectNative`.
- Edge, if ever needed: `/Library/Microsoft/Edge/NativeMessagingHosts/` and `~/Library/Application Support/Microsoft Edge {Channel}/NativeMessagingHosts/` ([Edge docs](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)), which also states the permission requirement explicitly: **read** on the manifest, **run** on the host runtime.

### 4.3 Stable extension ID via the manifest `key` field

- `key` "maintains the unique ID of an extension, or theme **when it is loaded during development**"; documented workflow: upload a zip to the Developer Dashboard unpublished → Package → **View public key** → strip PEM newlines → paste into `"key"` ([manifest key](https://developer.chrome.com/docs/extensions/reference/manifest/key)).
- The ID is derived from the public key: first 16 bytes of SHA-256 hex-encoded into the `a`–`p` alphabet (`kIdSize = 16`, `GenerateId` → `GenerateIdFromHash(Sha256(input))` in [crx_file/id_util.cc](https://chromium.googlesource.com/chromium/src/+/main/components/crx_file/id_util.cc)). Without `key`, an unpacked extension's ID is `GenerateIdForPath` (hash of the absolute path) — which is why moving the directory changes the ID and breaks `allowed_origins`. **INFERENCE** from those two sources.
- CWS-installed extensions have a stable ID regardless (the dashboard Item ID), so for the shipped product `allowed_origins` can be pinned to the store ID.
- **Recommendation:** put `"key"` in the manifest during development so `allowed_origins` never churns, and keep `partitionsKey`/cookie code free of hard-coded IDs by using `chrome.runtime.id`.

### 4.4 Message size limits and framing

- **Limits (FACT):** "The maximum size of a single message **from the native messaging host is 1 MB**, mainly to protect Chrome from misbehaving native applications. The maximum size of the message sent **to the native messaging host is 64 MiB**." ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). Source: `kMaximumNativeMessageSize = 1024 * 1024` ([native_message_process_host.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/native_message_process_host.cc)). MDN's "4 GB" is stale ([MDN](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Native_messaging)); the discrepancy is tracked in [w3c/webextensions#849](https://github.com/w3c/webextensions/issues/849).
- **Violation behaviour:** host→Chrome oversize logs `Native Messaging host tried sending a message that is <N> bytes long.` and closes the port with `Error when communicating with the native messaging host.`; Chrome→host oversize fails with `Message exceeded maximum allowed size of 64MiB.` ([native_message_process_host.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/native_message_process_host.cc), [messaging_util.cc](https://chromium.googlesource.com/chromium/src/+/main/extensions/renderer/api/messaging/messaging_util.cc)).
- **Framing (FACT):** "Chrome starts each native messaging host in a separate process and communicates with it using standard input (`stdin`) and standard output (`stdout`). The same format is used to send messages in both directions; **each message is serialized using JSON, UTF-8 encoded and is preceded with 32-bit message length in native byte order.**" ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)).
- **stdout is sacred; stderr is for logs:** "Make sure that **all output in `stdout` adheres to the native messaging protocol**. If you want to print some data for debugging purposes, write to `stderr`." Failures ("the native messaging host fails to start, writes to stderr or violates the communication protocol") are written to Chrome's error log, "accessed by starting Chrome from the command line and watching its output in the terminal" (same doc). Chrome remaps only fd 0 and 1, so stderr is inherited into Chrome's log — **INFERENCE** from the `fds_to_remap` construction in [launch_context_posix.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_posix.cc).
- **First argument is the caller origin:** "The first argument to the native messaging host is the origin of the caller, usually `chrome-extension://[ID of allowed extension]`." On Windows a second `--parent-window=` argument is added (value `0` when the caller is a service worker) (same doc).
- Minimal framing implementations (byte-order note: `native byte order` = little-endian on macOS):

```python
import sys, json, struct
def send(msg):
    b = json.dumps(msg).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("=I", len(b)) + b)   # '=' native byte order, 4 bytes
    sys.stdout.buffer.flush()
def read():
    h = sys.stdin.buffer.read(4)
    if len(h) < 4: return None                               # host exited / pipe closed
    n = struct.unpack("=I", h)[0]
    return json.loads(sys.stdin.buffer.read(n)) if n else None
```

```js
const send = (msg) => {                                        // Node launcher
  const b = Buffer.from(JSON.stringify(msg), 'utf8');
  const h = Buffer.alloc(4); h.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([h, b]));
};
let buf = Buffer.alloc(0);
process.stdin.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4) {
    const n = buf.readUInt32LE(0);
    if (buf.length < 4 + n) break;
    handle(JSON.parse(buf.subarray(4, 4 + n).toString('utf8')));
    buf = buf.subarray(4 + n);
  }
});
```

- **Documented pitfall list** ([native messaging, "Debug native messaging"](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)): `Failed to start native messaging host.` (exec permission), `Invalid native messaging host name specified.`, `Native host has exited.` ("The pipe to the native messaging host was broken before the message was read by Chrome. This is most likely initiated from your native messaging host."), `Specified native messaging host not found.`, `Access to the specified native messaging host is forbidden.` (check `allowed_origins`), `Error when communicating with the native messaging host.` ("The message length must not exceed 1024*1024… The message size must be equal to the number of bytes in the message").

### 4.5 Must the host be an executable? Can it be a `#!/bin/sh` script?

- **FACT:** `path` points at a "native messaging host binary" and Chrome execs it directly: `base::CommandLine command_line(host_path); … base::LaunchProcess(command_line, options)` ([launch_context_posix.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_posix.cc)).
- **INFERENCE:** because `LaunchProcess` has `execvp` semantics, a script with a `#!/bin/sh` (or `#!/usr/bin/env node`) shebang works as long as the file has the executable bit. The executable bit **is** required — the docs' remedy for `Failed to start native messaging host.` is "Check whether you have sufficient permissions to execute the native messaging host file" ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)); Edge states it as "provide run permissions on the host runtime" ([Edge docs](https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/native-messaging)). Source nuance: only `base::PathExists` is checked up front, so a missing `+x` passes that check and fails later as `RESULT_FAILED_TO_START` ([launch_context.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context.cc)).
- **UNVERIFIED:** shebang execution for a *native messaging host* specifically. *Experiment:* point `path` at a `+x` shell script that does `exec /usr/bin/env node host.js`, and confirm the port opens and frames round-trip; then repeat with the `+x` bit cleared to confirm the failure string.
- **macOS/Apple silicon:** an unsigned binary will not run — "the operating system enforces that any executable must be signed before it's allowed to run. There isn't a specific identity requirement for this signature: a simple ad-hoc signature is sufficient" ([Apple release notes](https://developer.apple.com/documentation/macos-release-notes/macos-big-sur-11_0_1-universal-apps-release-notes)) — so `codesign -s - <host>` at build time. Distribution outside the App Store for frictionless first run needs Developer ID + notarization ([Apple](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)). Also note Chrome launches the host with `disclaim_responsibility = true` ("This is executing a third-party binary, so do not associate any system private data requests with Chrome", [launch_context_posix.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/messaging/launch_context_posix.cc)) — **INFERENCE:** any TCC prompt (AppleEvents/automation, screen recording, full disk access) is attributed to **our** host/Node binary, not Chrome; a `#!/bin/sh` launcher shifts attribution to the interpreter. **UNVERIFIED:** whether a Node child ever triggers a TCC prompt in our flow. *Experiment:* trigger each privileged operation with `log stream --predicate 'subsystem == "com.apple.TCC"'` running, and record which binary the prompt names.

### 4.6 Capturing the stdout of a child process spawned by the host (the `dsh web` case)

This is the load-bearing requirement: we must read the tokenized URL that `dsh web` prints.

- **FACT:** the host's own stdout is reserved exclusively for the protocol — "all output in `stdout` adheres to the native messaging protocol", and violations produce `Error when communicating with the native messaging host.` ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)).
- **Answer:** **Yes, but only if the launcher gives the child its own pipe.** Spawn with `child_process.spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] })`, read the child's stdout in the host, and re-emit each line as a length-prefixed JSON frame on the host's own fd 1. **INFERENCE**, but architecturally forced: the child's fd 1 is then a pipe owned by the host, invisible to Chrome.
- **What must not happen:** `stdio: 'inherit'` (or a shell `cmd &`) lets the child's raw text land in Chrome's protocol pipe; Chrome's parser desynchronizes and closes the port with a protocol error. The child's stdin likewise belongs to the host unless the host interposes.
- **`connectNative` vs `sendNativeMessage` (FACT):** "When a messaging port is created using `runtime.connectNative()` Chrome starts native messaging host process and **keeps it running until the port is destroyed**. On the other hand, when a message is sent using `runtime.sendNativeMessage()`, without creating a messaging port, **Chrome starts a new native messaging host process for each message**. In that case the first message generated by the host process is handled as a response to the original request… **All other messages generated by the native messaging host in that case are ignored.**" ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). ⇒ A long-lived child only makes sense under `connectNative`.
- **Lifecycle hazard (source-backed):** when the port dies, Chrome terminates the host with `base::EnsureProcessTerminated`, which on macOS SIGKILLs **only the host pid** ([kill_mac.cc](https://chromium.googlesource.com/chromium/src/+/main/base/process/kill_mac.cc)). **INFERENCE:** the `dsh web` grandchild survives as an orphan unless the launcher kills it on stdin EOF/SIGTERM or places it in its own process group and reaps it.
- **Keepalive coupling (FACT):** an open `connectNative` port keeps the SW alive, but "if the host process crashes or is shut down, the port is closed and the service worker will terminate after timers complete. Guard against this by calling `chrome.runtime.connectNative()` in the port's `onDisconnect` event handler." ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)).
- **Permissions/policy (FACT):** `"nativeMessaging"` is required ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list), warning "Communicate with cooperating native applications."); these APIs "are not available inside content scripts, only inside your extension's pages and service worker" ([native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)) — the side panel qualifies. Enterprise: `NativeMessagingBlocklist` (`*` denies all unless allowlisted) and `NativeMessagingAllowlist`, both Chrome 86+, dynamic, per-profile ([blocklist policy](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/NativeMessaging/NativeMessagingBlocklist.yaml), [allowlist policy](https://chromium.googlesource.com/chromium/src/+/main/components/policy/resources/templates/policy_definitions/NativeMessaging/NativeMessagingAllowlist.yaml)).
- **UNVERIFIED:** incognito/split-mode behaviour of native messaging (no doc statement) — **INFERENCE** that it works where the extension is allowed, opening a separate host process per `BrowserContext`. *Experiment:* enable split incognito and count host processes with `ps`.

---

## 5. Page capture

### 5.1 `chrome.tabs.captureVisibleTab`

- **Signature/behaviour (FACT):** `captureVisibleTab(windowId?, options?)` — "Captures the visible area of the currently **active tab in the specified window**. In order to call this method, the extension must have either the `<all_urls>` permission or the `activeTab` permission. In addition to sites that extensions can normally access, this method allows extensions to capture sensitive sites that are otherwise restricted, including `chrome:`-scheme pages, other extensions' pages, and `data:` URLs. **These sensitive sites can only be captured with the `activeTab` permission.** File URLs may be captured only if the extension has been granted file access." `windowId` "Defaults to the current window" ([tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)).
- **Throttle (FACT):** `chrome.tabs.MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND = 2` — "The maximum number of times that `captureVisibleTab` can be called per second. `captureVisibleTab` is expensive and should not be called too often." ([tabs properties](https://developer.chrome.com/docs/extensions/reference/api/tabs#property-MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND)).
- **Returns** a data URL string (Promise, Chrome 88+); `ImageDetails` controls `format`/`quality` ([tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab)).
- **Implementation detail (source, FACT-level):** the function resolves the window, takes `tab_list->GetActiveTab()`, and checks `CanCaptureVisiblePage(..., CaptureRequirement::kActiveTabOrAllUrls)` — i.e. the tab must be the **active** tab of that window, and permission must come from `activeTab` or `<all_urls>` ([tabs_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/tabs/tabs_api.cc)). Failures surface as `Failed to capture tab: view is invisible` / `image readback failed` / `encoding failed`, and policy/DLP variants `kScreenshotsDisabled` / `kScreenshotsDisabledByDlp` (same file).
- **Does it work while focus is in the side panel?** **INFERENCE: yes.** The side panel is a browser UI surface, not a tab: it never becomes the "active tab", so calling `captureVisibleTab` from `sidepanel.html` captures the page that is still the active tab of the current window; the docs require an active *tab*, not window focus. **UNVERIFIED:** the occluded/minimized/unfocused-window case (the `view is invisible` path) and whether a stale frame can be returned for a background window. *Experiment:* from the side panel, capture with (a) the browser window focused, (b) another app focused, (c) the window fully covered, (d) the window minimized; compare image hashes and any error strings.
- **Policy caveat (FACT):** enterprise `DisableScreenshots`/DLP makes both this API and `chrome.debugger.attach()` fail ("Screenshot capture is restricted by policy.") ([debugger reference](https://developer.chrome.com/docs/extensions/reference/api/debugger)).

### 5.2 Reading readability text + selection

- Best-effort path without warnings: `chrome.scripting.executeScript({ target: { tabId }, func })` returning `document.title`, a Readability-style extraction of `document.body.innerText`/cloned DOM, and `window.getSelection().toString()`.
- **FACT:** results are collected per frame: "A single result is included per-frame. **The main frame is guaranteed to be the first index** in the resulting array; all other frames are in a non-deterministic order"; `InjectionResult` carries `documentId`, `frameId`, `result`, and if the injected value is a promise Chrome awaits it ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)).
- **FACT (limitation):** "you can't execute a string using `scripting.executeScript()`" — pass a `func` or packaged `files` ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)).
- **Selection nuance (INFERENCE):** a selection made in the page is visible to the injected script, but a selection *inside the side panel iframe* is in a different document; use `document.getSelection()` in whichever document the user is interacting with, and note `window.getSelection()` inside the panel is the panel's own selection.

### 5.3 `activeTab` vs `host_permissions: ["<all_urls>"]`

| | `activeTab` | `<all_urls>` host permission |
|---|---|---|
| Install warning | "displays **no warning message** during installation" | "Read and change all your data on all websites" ([tabs permission list](https://developer.chrome.com/docs/extensions/reference/permissions-list)) |
| Activation | only on a user gesture — action click, context menu item, keyboard shortcut, omnibox suggestion | always |
| Lifetime | "Access to the tab lasts while the user is on that page, and is **revoked when the user navigates away** or closes the tab" | until revoked |
| Grants | `scripting.executeScript`/`insertCSS` on that tab (with `"scripting"`), `tabs.Tab` url/title/favicon, main-frame `webRequest` interception | same, everywhere matching |
| Sensitive sites for capture | **required** for `chrome:`/other-extension/`data:` captures | not sufficient for those |
| Review | minimal | `<all_urls>` "affects all hosts, Chrome web store reviews for extensions that use it may take longer" ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)) |

(all rows cited to [activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab), [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs), [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting), [match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)).

**INFERENCE for design:** an agent that must read/act on *arbitrary* tabs on demand cannot rely on `activeTab` (the user must invoke the extension on each tab, and access dies on navigation). Ship `<all_urls>` for the agent features plus `"tabs"` only if `Tab.url/title/favIconUrl` are needed outside a granted host ("The `"tabs"` permission… grants an extension the ability to call `tabs.query()` against four sensitive properties on `tabs.Tab` instances: `url`, `pendingUrl`, `title`, and `favIconUrl`", [tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)).

### 5.4 Pages where content scripts / `executeScript` cannot run

- **Match-pattern schemes are limited (FACT):** `scheme` "Must be one of the following": `http`, `https`, `*` (matches only http/https), `file`. "For information on injecting content scripts into unsupported schemes, such as `about:` and `data:`, see Injecting in related frames." ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)).
- **Related frames (FACT):** frames with `about:`, `data:`, `blob:`, `filesystem:` URLs can be injected only via `match_origin_as_fallback: true`, which matches on the *initiator's* origin ([content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)).
- **`file://` (FACT):** `"file:///"` "requires the user to manually grant access" — the "Allow access to file URLs" toggle on `chrome://extensions` ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns); [tabs `captureVisibleTab`](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab) states the same for capture).
- **`chrome://` pages (FACT, source-level):** injection is refused with `Cannot access a chrome:// URL` ([permissions_data.cc](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/permissions/permissions_data.cc), [debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)); the official `activeTab` sample itself guards with `if (!tab.url.includes('chrome://'))` ([activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)).
- **Other extensions' pages and privileged WebUI**: refused by the same checks ([permissions_data.cc](https://chromium.googlesource.com/chromium/src/+/main/extensions/common/permissions/permissions_data.cc)).
- **The Chrome Web Store (UNVERIFIED as current doc):** the explicit "restricted domains" list that used to live in the content-scripts docs (chrome://, other extensions' pages, `chrome.google.com/webstore`, and `file://` unless allowed) is **no longer present** in the current [content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) or [match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns) pages. No current authoritative page states the Web Store restriction. *Experiment:* with `<all_urls>` and `scripting`, call `executeScript` on a `chromewebstore.google.com` tab and on a `chrome://settings` tab, and log `chrome.runtime.lastError` for each.
- **PDF viewer / plugin documents:** the debugger path explicitly skips the out-of-process PDF extension frames ([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)); **INFERENCE** that scripting likewise cannot usefully read the PDF viewer document itself.

---

## 6. Driving the browser for an agent: `chrome.debugger` vs `scripting` + `tabs`

### 6.1 `chrome.debugger`

- **Permission (FACT):** `"debugger"` only; Chromium comments that "the `debugger` permission implies all URLs access (and indicates such to the user), so we don't check explicit page access" — restricted URLs are still refused ([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)). Install prompt: `IDS_EXTENSION_PROMPT_WARNING_DEBUGGER` = **"Access the page debugger backend."** ([permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list), [generated_resources.grd](https://chromium.googlesource.com/chromium/src/+/main/chrome/app/generated_resources.grd)).
- **Methods (FACT):** `attach(target, requiredVersion)`, `detach(target)`, `sendCommand(target, method, commandParams?)`, `getTargets()`; promises since Chrome 96. `Debuggee` requires one of `tabId`/`extensionId`/`targetId`; `DebuggerSession` adds `sessionId` for child sessions. `TargetInfo` = `{id, type: "page"|"background_page"|"worker"|"other", title, url, attached, tabId, extensionId}` ([debugger reference](https://developer.chrome.com/docs/extensions/reference/api/debugger)). Attaching to an extension background page needs `--silent-debugger-extension-api` (same doc).
- **`requiredVersion` (FACT/correction):** the reference's example says `("0.1")`, which is a placeholder — Chromium accepts exactly `"1.0" | "1.1" | "1.2" | "1.3"` ([devtools_agent_host.cc](https://chromium.googlesource.com/chromium/src/+/main/content/browser/devtools/devtools_agent_host.cc)); anything else returns `Requested protocol version is not supported: *`. **Pass `"1.3"`.**
- **Restricted CDP domains (FACT):** "For security reasons, the `chrome.debugger` API does not provide access to all Chrome DevTools Protocol Domains. The available domains are: **Accessibility**, Audits, CacheStorage, Console, CSS, Database, Debugger, DOM, DOMDebugger, DOMSnapshot, Emulation, Fetch, IO, **Input**, Inspector, Log, Network, Overlay, **Page**, Performance, Profiler, Runtime, Storage, **Target**, Tracing, WebAudio, WebAuthn" ([debugger reference](https://developer.chrome.com/docs/extensions/reference/api/debugger)). **`Browser`, `ServiceWorker`, `IndexedDB`, `LayerTree`, `Memory`, `Schema`, `Media` are absent** (negative finding from that list) — so no browser-level UI automation and no service-worker-target debugging through this API.
- **Flat sessions / OOPIFs (FACT):** "Starting in Chrome 125, the `chrome.debugger` API supports flat sessions… you can add a `sessionId` property when calling `chrome.debugger.sendCommand` to identify the child target". Auto-attach is **not recursive**: "with the frame hierarchy A → B → C (where all are cross-origin), calling `Target.setAutoAttach` for the target associated with A would result in the session also being attached to B. However, this is not recursive, so `Target.setAutoAttach` also needs to be called for B to attach the session to C." (same doc).
- **The infobar (FACT/source):** `IDS_DEV_TOOLS_INFOBAR_LABEL` = `"$1" started debugging this browser` ([generated_resources.grd](https://chromium.googlesource.com/chromium/src/+/main/chrome/app/generated_resources.grd)). It is a global infobar with `ShouldExpire()` returning `false` (navigations don't clear it) whose only button is **Cancel, which ends the session** with `DetachReason: "canceled_by_user"` ([extension_dev_tools_infobar_delegate.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.cc), [debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)). It is suppressed on exactly two paths — the `--silent-debugger-extension-api` CLI switch, or a **policy-installed** extension ("We allow policy-installed extensions to circumvent the normal infobar warning", [debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)) — **there is no enterprise policy that hides it for a user-installed CWS extension.** Current code auto-hides it ~5 s after the last client detaches (`kAutoCloseDelay`, [delegate .h](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/extension_dev_tools_infobar_delegate.h)), contradicting an older `.grd` comment that claims it never disappears. **UNVERIFIED:** the observed lifetime on Chrome 150. *Experiment:* attach, detach, and time the infobar; then attach and press Cancel and confirm `onDetach` reports `canceled_by_user`.
- **DevTools coexistence:** the documented direction is that DevTools **evicts** the extension — `onDetach` fires "when either the tab is being closed or **Chrome DevTools is being invoked** for the attached tab" ([onDetach](https://developer.chrome.com/docs/extensions/reference/api/debugger#event-onDetach)). A second attach *by the same extension* to the same target fails with `"Another debugger is already attached to the <type> with id: <id>."` ([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)). **UNVERIFIED:** whether DevTools *already being open* blocks `attach()` (the error string is produced only when the *same extension id* already holds a session, per source). *Experiment:* open F12 on a tab, call `chrome.debugger.attach({tabId},"1.3")`, log `runtime.lastError`; then try two different unpacked extensions on the same tab.
- **SW keepalive (FACT):** Chrome 118+ ([lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)); implementation uses a non-timeout keepalive ([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)).
- **Enterprise blocks (FACT):** `ExtensionSettings.runtime_blocked_hosts` ⇒ attach fails with `"Host access is restricted by policy."` (all-or-nothing); `DisableScreenshots`/DLP ⇒ `"Screenshot capture is restricted by policy."` ([debugger reference](https://developer.chrome.com/docs/extensions/reference/api/debugger)).
- **Events (FACT):** `chrome.debugger.onEvent((source: DebuggerSession, method, params) => …)` is the only channel for `Accessibility.*`/`Page.*`/`Runtime.*`; `source.sessionId` identifies child sessions ([onEvent](https://developer.chrome.com/docs/extensions/reference/api/debugger#event-onEvent)). Domains must be enabled first (`Page.enable`, `Runtime.enable`, `Accessibility.enable`, …).

### 6.2 `scripting` + `tabs` (and its ceiling)

- **Params (FACT):** `target` (`tabId` required; optional `allFrames`, `frameIds`, `documentIds`; "You cannot specify both the `frameIds` and `allFrames` properties"), exactly one of `files`/`func`, `args` (JSON-serializable), `world: "ISOLATED" | "MAIN"`, `injectImmediately` ("injects… without waiting, even if the page has not finished loading") ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)).
- **Worlds (FACT):** `"ISOLATED"` = "the execution environment unique to this extension"; `"MAIN"` = "the execution environment shared with the host page's JavaScript" ([ExecutionWorld](https://developer.chrome.com/docs/extensions/reference/api/scripting#type-ExecutionWorld)). `USER_SCRIPT` is **not** a `scripting` world; it belongs to `chrome.userScripts` ([userScripts](https://developer.chrome.com/docs/extensions/reference/api/userScripts)).
  - **INFERENCE:** `world: 'MAIN'` is required to read page JS state (framework internals, `window.*`); `ISOLATED` is required if you must not be observed by the page. Note MAIN-world injection is subject to the page's CSP? — **UNVERIFIED**; *experiment:* inject into a page with a strict `script-src` CSP and see whether MAIN-world `func` execution is blocked.
- **Returning values (FACT):** one result per frame, main frame first, promises awaited, `args`/results must be JSON-serializable ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)).
- **Click/type fidelity (FACT + INFERENCE):** `element.click()` and `dispatchEvent()` produce events with `isTrusted === false` ([MDN isTrusted](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)); synthetic events therefore do not trigger browser default actions or native-input-dependent widgets (**INFERENCE**). `document.execCommand('insertText')` is "deprecated and non-standard" ([MDN execCommand](https://developer.mozilla.org/en-US/docs/Web/API/Document/execCommand)) but remains the common `contenteditable` path; React-style controlled inputs usually need the native value setter + a dispatched `input` event (**INFERENCE**). CDP `Input.dispatchKeyEvent` / `Input.insertText` / `Input.dispatchMouseEvent` produce **trusted** input and are page-scoped: coordinates are "relative to the main frame's viewport in CSS pixels" ([Input domain](https://chromedevtools.github.io/devtools-protocol/tot/Input/)).
- **What scripting genuinely cannot do:** trusted input; browser-level UI (omnibox, menus, file chooser, permission bubbles, `<select>` popups) — even CDP's `Input` domain is page-scoped; `chrome://`/DevTools/PDF-viewer/other-extension documents; cross-origin DOM beyond independently-permissioned frames ("Each frame is checked independently for URL requirements", [scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)); network/console/capture primitives (`Network`, `Runtime.consoleAPICalled`, `Page.captureScreenshot`, `DOMSnapshot` exist only inside the debugger allowlist).

### 6.3 Coordinates and the accessibility tree

- **Scripting side (FACT + INFERENCE):** `Element.getBoundingClientRect()` is viewport-relative in CSS pixels ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Element/getBoundingClientRect)); add `scrollIntoView()` + `scrollX/scrollY` for page coordinates and use `IntersectionObserver` for visibility ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/IntersectionObserver)). **INFERENCE:** rects do not account for CSS transforms/zoom (visual viewport) and say nothing about occlusion.
- **CDP side (preferred for clicking):** `DOM.getBoxModel` ("Returns boxes for the given node"), `DOM.getContentQuads` (quads "relative to viewport"), `DOM.getNodeForLocation` (hit-test x,y → `backendNodeId`/`frameId`), plus `Page.getLayoutMetrics` for `cssVisualViewport`/`cssLayoutViewport` ([DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/), [Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)). Then act with `Input.dispatchMouseEvent` (`mousePressed|mouseReleased|mouseMoved|mouseWheel`) and `Input.dispatchKeyEvent` (`keyDown|keyUp|rawKeyDown|char`) / `Input.insertText` ([Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)).
- **Accessibility tree (FACT):** CDP `Accessibility.enable` ("causes AXNodeIds to remain consistent between method calls. This turns on accessibility for the page, **which can impact performance until accessibility is disabled**"), `Accessibility.getFullAXTree` ("Fetches the entire accessibility tree for the root Document"; optional `depth`, `frameId`), `getPartialAXTree`, `queryAXTree` ("including nodes that are ignored for accessibility"), `getRootAXNode`, `getAXNodeAndAncestors`, `getChildAXNodes` (the latter "Requires `enable()` to have been called previously") ([Accessibility domain](https://chromedevtools.github.io/devtools-protocol/tot/Accessibility/)). `AXNode` = `nodeId`, `ignored`, `ignoredReasons`, `role`, `name`, `description`, `value`, `properties`, `parentId`, `childIds`, **`backendDOMNodeId`**, `frameId`. Map back with `DOM.resolveNode` ("Resolves the JavaScript node object for a given NodeId or BackendNodeId") or `DOM.describeNode` ("Does not start tracking any objects, can be used for automation"), then `Runtime.evaluate` with an explicit `contextId` ([DOM](https://chromedevtools.github.io/devtools-protocol/tot/DOM/), [Runtime](https://chromedevtools.github.io/devtools-protocol/tot/Runtime/)).
- **Negative finding (FACT):** no extension API exposes the AX tree. `chrome.accessibilityFeatures` only "manage[s] Chrome's accessibility features" via the `ChromeSetting` prototype ([accessibilityFeatures](https://developer.chrome.com/docs/extensions/reference/api/accessibilityFeatures)), and the [API index](https://developer.chrome.com/docs/extensions/reference/api) contains no tree API. ⇒ Reliable AX-driven agent behaviour **requires** an attached `chrome.debugger` session.
- **UNVERIFIED:** whether `Accessibility.getFullAXTree` requires a prior `enable()` (its siblings document the requirement, it does not). *Experiment:* call it without `enable()`, then with, and compare results/errors and node counts.

### 6.4 Navigation and load-waiting

- **Extension-native (FACT):** `tabs.create({url})`, `tabs.update(tabId, {url})` ("JavaScript URLs are not supported; use `scripting.executeScript` instead"), completion via `tabs.onUpdated` where `changeInfo.status` ∈ `"unloaded" | "loading" | "complete"` ([tabs](https://developer.chrome.com/docs/extensions/reference/api/tabs)). Finer: `chrome.webNavigation` (`onBeforeNavigate → onCommitted → [onDOMContentLoaded] → onCompleted`, `onHistoryStateUpdated`, `frameId` main = 0, `documentId`) ([webNavigation](https://developer.chrome.com/docs/extensions/reference/api/webNavigation)).
- **CDP (FACT):** `Page.navigate({url, frameId?})` returns `frameId`, `loaderId` (omitted for same-document navigations), `errorText` ("present if and only if navigation has failed"), `isDownload`; wait on `Page.loadEventFired`, `Page.frameNavigated`, or `Page.lifecycleEvent` ([Page](https://chromedevtools.github.io/devtools-protocol/tot/Page/)).
- **INFERENCE (robust agent loop):** `Page.navigate` → wait for top-frame `Page.frameNavigated`/`lifecycleEvent` → `Runtime.evaluate` readiness probe (`document.readyState === 'complete'`) → `DOM.getDocument` + `Accessibility.getFullAXTree`. `tabs.onUpdated` alone races on SPA route changes and redirect chains.

### 6.5 Comparison table

| Need | `chrome.scripting` + `tabs` | `chrome.debugger` (CDP) |
|---|---|---|
| Permission | `"scripting"` + hosts or `activeTab` ([scripting](https://developer.chrome.com/docs/extensions/reference/api/scripting)) | `"debugger"` only, implies all-URLs ([debugger_api.cc](https://chromium.googlesource.com/chromium/src/+/main/chrome/browser/extensions/api/debugger/debugger_api.cc)) |
| User-visible cost | none with `activeTab` ([activeTab](https://developer.chrome.com/docs/extensions/develop/concepts/activeTab)) | "Access the page debugger backend" warning + global infobar whose Cancel kills the session |
| Click/type | `isTrusted:false`, no default actions ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Event/isTrusted)) | trusted `Input.*`, page-scoped ([Input](https://chromedevtools.github.io/devtools-protocol/tot/Input/)) |
| Read DOM | yes (`world: MAIN` for page JS internals) | yes (`DOM.getDocument`, `Runtime.evaluate`) |
| Coordinates | `getBoundingClientRect` + scroll | `DOM.getBoxModel`, `DOM.getContentQuads`, `DOM.getNodeForLocation` |
| Accessibility tree | **none** | `Accessibility.*` only |
| OOPIF / cross-origin frames | per-frame host permissions; no cross-origin DOM | separate targets; `Target.setAutoAttach` (non-recursive) |
| Network / console / screenshots | no | `Network`, `Runtime`, `Page.captureScreenshot`, `DOMSnapshot` |
| Browser chrome / native UI | no | no (`Browser` domain absent) |
| SW lifetime | 30 s idle | kept alive while attached (Chrome 118+) |
| `chrome://`, PDF viewer, other extensions | blocked | blocked (WebUI refusal) |

**INFERENCE (recommended shape):** attach `chrome.debugger` for the duration of an agent task (accept the infobar; treat it as a lease), drive with `Input.*` + `Accessibility.getFullAXTree` + `DOM.getContentQuads`, navigate with `Page.navigate`, and use `scripting.executeScript({world:'MAIN'})` only for cheap reads or when the infobar/lease is unacceptable (e.g. background summarization on the active tab). Because the debugger session is the strongest SW keepalive available, attach/detach is also the natural "task in progress" marker.

---

## 7. 2025/2026 platform & policy changes that matter here

*As of 2026-09-11.*

### 7.1 Third-party cookies: deprecation cancelled, CHIPS kept

- **Jul 22, 2024:** Google proposed replacing deprecation with user choice — "Instead of deprecating third-party cookies, we would introduce a new experience in Chrome that lets people make an informed choice" ([A new path for Privacy Sandbox on the web](https://privacysandbox.google.com/blog/privacy-sandbox-update)).
- **Oct 17, 2025:** the pivot is confirmed; the update retires Topics, Protected Audience, Attribution Reporting, Private Aggregation, Related Website Sets and IP Protection while stating that CHIPS and FedCM "We'll continue to support" ([Update on Plans for Privacy Sandbox Technologies](https://privacysandbox.com/news/update-on-plans-for-privacy-sandbox-technologies/)).
- **Feature status page (updated 2026-08-14):** CHIPS, FedCM, Storage Access API, storage/network state partitioning, Private State Tokens, UA reduction = "Continue to support"; Topics/Protected Audience/Attribution Reporting/Private Aggregation/Fenced Frames/Shared Storage/Related Website Sets = "Deprecate and remove"; IP Protection and Partitioned Popins = "Discontinue" ([Privacy Sandbox feature status](https://privacysandbox.google.com/overview/status)).
- **Consequence for us:** `partitionKey`/CHIPS is a **supported, stable** mechanism — Shape B in §3.4 is safe to build on. The docs still warn that 3P-cookie settings "are adjusted according to [the Privacy Sandbox] timeline" ([storage-and-cookies](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies)), so re-check after any future announcement.
- **UNVERIFIED:** whether current stable still offers users "Block third-party cookies" (§3.5).

### 7.2 Local Network Access (LNA): extensions are out of scope today

- **Timeline:** opt-in behind `chrome://flags/#local-network-access-check` from Chrome 138; shipping by default in **Chrome 142** — "The Local Network Access permission prompt is launching in Chrome 142" ([New permission prompt for Local Network Access](https://developer.chrome.com/blog/local-network-access)); WebSockets/WebTransport added in **Chrome 147** ([LNA Adoption Guide](https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/mobilebasic), updated 2026-05-18; corroborated by the Feb 2026 [Intent to Ship](https://mail-archive.com/blink-dev@chromium.org/msg15904.html)).
- **What it gates:** connections from the public address space to local/loopback destinations, where loopback is `127.0.0.0/8`/`::1/128` and local covers RFC1918, `169.254.0.0/16`, `fc00::/7`, `fe80::/10` ([LNA blog](https://developer.chrome.com/blog/local-network-access)).
- **It is a web permission, not a manifest permission:** LNA "adds two new permissions to the web platform: `local-network` and `loopback-network`" (split in Chrome 145 from the earlier `local-network-access`) ([guide](https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/mobilebasic)). There is **no** `localNetworkAccess` entry in Chrome's extension [permissions list](https://developer.chrome.com/docs/extensions/reference/permissions-list).
- **Extensions exemption (exact sentence):** "We do not currently have plans to apply LNA restrictions to extensions. Currently, extensions that have the necessary host permissions are allowed to make local network requests." ([guide](https://docs.google.com/document/d/1QQkqehw8umtAgz5z0um7THx-aoU251p705FbIQjDuGs/mobilebasic)). Main-frame navigations and Android WebView are likewise excluded.
- **Consequence:** no prompt, no manifest entry, no `allow="local-network"` iframe attribute needed for the `127.0.0.1` iframe/WS **today**. Because Chrome 147 already gates web WebSockets, the *mechanism* to gate ours exists. **UNVERIFIED:** that the exemption still holds in Chrome 148+ (the guide is dated 2026-05-18, so it should). *Experiment:* run with `--ip-address-space-overrides=127.0.0.1:3080=public` and LNA checking enabled, confirm the panel iframe renders and the WS connects with **no** prompt, and use a public HTTPS page hitting the same origin as a positive control.

### 7.3 Permissions and CSP for localhost: nothing extra is required

- **host_permissions (FACT):** an extension service worker or foreground tab "can talk to remote servers outside of its origin, as long as the extension requests host permissions"; "access is granted both by host and by scheme" ([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)). Use `"http://127.0.0.1/*"` — "Match patterns match all ports unless an explicit port is specified" ([match patterns](https://developer.chrome.com/docs/extensions/develop/concepts/match-patterns)).
- **CSP (FACT):** default MV3 policy is `"extension_pages": "script-src 'self'; object-src 'self';"` ([CSP manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy)), and explicitly: "**While the default policy doesn't restrict connections to hosts**, be careful when explicitly adding either the `connect-src` or `default-src` directives." ([network requests](https://developer.chrome.com/docs/extensions/develop/concepts/network-requests)). No `frame-src`/`connect-src`/`default-src` is declared by default ⇒ framing `http://127.0.0.1` and opening `ws://127.0.0.1` need no CSP change. Adding a `default-src` would newly constrain both — **INFERENCE**, and the practical reason to omit `content_security_policy` entirely.
- If a policy must be declared, the enforced minimum is `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` and "The `extension_pages` policy cannot be relaxed beyond this minimum value."; unpacked extensions may additionally allow localhost script sources ([CSP manifest](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy), [Improve extension security](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security)).
- **Remote code:** MV3 forbids remotely hosted *logic*; "code run in contexts that are isolated from extension APIs (such as iframes and sandboxed pages) are exempt" ([MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)). The only sanctioned remote-execution APIs are the Debugger API and User Scripts API (same doc).

### 7.4 Manifest V2 is gone

- Disabled for all users on all channels **Jul 24, 2025** (Chrome 138); the `ExtensionManifestV2Availability` enterprise policy was removed with **Chrome 139**; "All remaining Manifest V2 extensions are removed from the Chrome Web Store" **Aug 31, 2026** ([MV2 deprecation timeline](https://developer.chrome.com/docs/extensions/develop/migrate/mv2-deprecation-timeline), updated 2026-07-08). MV3-only is a hard constraint.

### 7.5 API churn since 2025 (relevant deltas)

- `chrome.sidePanel`: `getLayout()` Chrome 140; `close()` Chrome 141 (+ behaviour change in Chrome 145, §1.4); `onOpened` Chrome 141; `onClosed` Chrome 142 ([What's new](https://developer.chrome.com/docs/extensions/whats-new), [reference](https://developer.chrome.com/docs/extensions/reference/api/sidePanel)).
- `chrome.offscreen.hasDocument()` Chrome 150 ([offscreen](https://developer.chrome.com/docs/extensions/reference/api/offscreen#method-hasDocument)).
- `chrome.alarms`: `persistAcrossSessions` (Chrome 150), `AlarmCreateInfo.name` (Chrome 152), 1024-byte alarm-name limit (Chrome 150) ([What's new](https://developer.chrome.com/docs/extensions/whats-new), [alarms](https://developer.chrome.com/docs/extensions/reference/api/alarms)).
- `browser.*` namespace mirrored from Chrome 148 ([What's new](https://developer.chrome.com/docs/extensions/whats-new), [transition guide](https://developer.chrome.com/docs/extensions/reference/api)).
- Structured-clone messaging opt-in from Chrome 148 ([What's new, 2026-04-22](https://developer.chrome.com/docs/extensions/whats-new)).
- `chrome.userScripts.execute()` synchronous validation from Chrome 149 ([What's new](https://developer.chrome.com/docs/extensions/whats-new)).
- Command-line switches `--extensions-on-chrome-urls` and `--disable-extensions-except` removed in branded builds from Chrome 139 ([What's new](https://developer.chrome.com/docs/extensions/whats-new)).

### 7.6 Chrome Web Store policy (2026)

- **New policies published Jul 1, 2026; enforcement begins Aug 1, 2026**: (i) Limited Use tightened — "Any user data collected by an extension must now be **strictly necessary to the extension's disclosed single purpose**"; (ii) collection must be "prominently disclosed to the user—regardless of whether the data is closely related to the extension's single purpose", plus proactive disclosure of post-install changes to data handling; (iii) predictive markets added to Regulated Goods; (iv) a Malicious and Prohibited Products clause on circumventing AI-service safety guardrails ([CWS policy updates 2026](https://developer.chrome.com/blog/cws-policy-updates-2026)).
- **Standing policies that bite here:** Single Purpose — "An extension must have a single purpose that is narrow and easy to understand" ([Quality Guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)); Limited Use ([Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use)); API Use — "Extensions must use existing Chrome APIs for their designated use case" ([API Use](https://developer.chrome.com/docs/webstore/program-policies/api-use)); "Side panel extensions which hijack a user's browsing or search experience" is a named violation ([Quality Guidelines](https://developer.chrome.com/docs/webstore/program-policies/quality-guidelines)).
- **FACT (negative):** there is **no** `debugger`-specific or native-messaging-specific policy clause; `debugger` appears as a *permitted* remote-execution API under the MV3 requirements, and native messaging is governed by the `nativeMessaging` permission + `allowed_origins` rather than by a disclosure rule ([MV3 requirements](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements), [native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)). Reviewers do multiply effort for "dangerous permission requests" and "sensitive execution permissions" ([review process](https://developer.chrome.com/docs/webstore/review-process)) — **INFERENCE** that `debugger` + `<all_urls>` lands in that bucket, since no doc names `debugger` explicitly.
- **Practical:** an extension that reads arbitrary page content for an agent must (a) have a defensible single purpose, (b) disclose exactly what is read and where it goes, and (c) keep user data strictly necessary to that purpose — the Jul/Aug 2026 rules attach directly to §5/§6 of this note.

---

## 8. Open questions and the experiments that would settle them

| # | Question | Experiment |
|---|---|---|
| 1 | Does an *idle* WS with server pings <30 s keep the MV3 SW alive indefinitely? | Connect from the SW, server sends 1 byte/10 s, never call a Chrome API, log heartbeats for 30 min ([§2.3](#23-does-a-websocket-to-a-local-server-survive-sw-termination-no)) |
| 2 | Does keeping the side panel open prevent SW termination? | Panel open, 5 min idle, log `runtime.getContexts()` + SW heartbeat ([§1.4](#14-behaviours-per-tab-panels-and-tab-switching)) |
| 3 | Under "Block third-party cookies", is an unpartitioned `SameSite=None;Secure` cookie still sent in the panel iframe — and is a CHIPS cookie sent? | Toggle the setting, then diff `Cookie:` headers on fetch + WS for unpartitioned None/Secure, unpartitioned Strict, and partitioned CHIPS ([§3.5](#35-block-third-party-cookies--extension-top-level-frames-are-exempt-two-code-paths)) |
| 4 | Why does `Strict` survive `fetch` but not the WS handshake? | Server-side request log: 4 contexts (panel/iframe × fetch/WS), 3 cookies (`strict`/`lax`/`no_restriction`), with and without `host_permissions`; corroborate with `chrome://net-export` ([§3.4](#34-recommended-cookie-setup-for-the-iframe)) |
| 5 | Exact failure mode of `sameSite:'no_restriction'` without `secure:true` | Call `set()`, inspect returned `Cookie.secure` and whether a cross-site `fetch()` carries it ([§3.1](#31-the-chromecookies-contract)) |
| 6 | Does `chrome.debugger.attach()` fail when DevTools is already open on the tab? | F12 open, attach, log `runtime.lastError`; then two extensions on one tab ([§6.1](#61-chromedebugger)) |
| 7 | Infobar lifetime on Chrome 150 and whether Cancel breaks the session | Attach/detach with a stopwatch; attach then click Cancel and read `onDetach` reason ([§6.1](#61-chromedebugger)) |
| 8 | `Accessibility.getFullAXTree` without `enable()` | Call both ways, diff results/errors ([§6.3](#63-coordinates-and-the-accessibility-tree)) |
| 9 | Does a `+x` shell script work as `path`? Is the trailing slash in `allowed_origins` required? | Two host manifests, one variable each; read Chrome's stderr ([§4.2](#42-exact-macos-install-path), [§4.5](#45-must-the-host-be-an-executable-can-it-be-a-binsh-script)) |
| 10 | Upper bound on side-panel width; is `kSidePanelDefaultContentWidth` still 360? | Drag divider to both extremes, read `clientWidth` ([§1.3](#13-width-no-api-the-minimum-is-baked-into-the-browser-ui-360-px)) |
| 11 | Current state of the Web Store / `chrome://` injection restriction under `<all_urls>` | `executeScript` on a CWS tab and a `chrome://` tab; log `lastError` ([§5.4](#54-pages-where-content-scripts--executescript-cannot-run)) |
| 12 | Does `world:'MAIN'` injection survive a strict page CSP? | Inject into a CSP-hardened demo page ([§6.2](#62-scripting--tabs-and-its-ceiling)) |
| 13 | Whether current stable still exposes "Block third-party cookies" | Inspect `chrome://settings/cookies` on a fresh profile ([§3.5](#35-block-third-party-cookies--exemption-exists-but-the-docs-contain-a-tension)) |
| 14 | Does `captureVisibleTab` return a stale/failed frame when the window is unfocused/occluded? | 4 focus states, diff hashes and error strings ([§5.1](#51-chrometabscapturevisibletab)) |
| 15 | LNA exemption still true in Chrome ≥148? | `--ip-address-space-overrides=127.0.0.1:3080=public` + LNA enabled, positive control on a public page ([§7.2](#72-local-network-access-lna-extensions-are-out-of-scope-today)) |

---

## 9. Design decisions this research forces (one-line summary)

1. The panel **must** be a packaged extension page hosting an iframe — there is no remote-URL mode (§1.2).
2. Prefer a **global** panel (no `tabId`) because per-tab panels are separate instances and will reload the embedded app (§1.4).
3. Own the WebSocket in the **panel document**, not the service worker; if it must be in the SW, keepalive every 20 s and reconnect on every start (§2).
4. Write the iframe's cookies **from the extension** with `sameSite:'no_restriction'; secure:true` (legal because loopback is a trustworthy origin); never `strict`; omit `partitionKey` — the extension top-level scheme is already 3P-exempt, so CHIPS is redundant (§3.2–§3.5).
5. Native host = `+x`, ad-hoc-signed launcher that spawns `dsh web` with its own stdout pipe, frames everything as `uint32 LE + JSON`, logs only to stderr, and reaps the child on stdin EOF (§4.6).
6. `captureVisibleTab` (with `<all_urls>` or `activeTab`) for viewport shots, ≤2/s; `scripting.executeScript` for text/selection (§5).
7. Agent driving = `chrome.debugger` (CDP `Input.*` + `Accessibility.*` + `DOM.getContentQuads`); accept the infobar, treat the session as a revocable lease and as the SW keepalive (§6).
8. Ship no `content_security_policy` block, rely on `host_permissions: ["http://127.0.0.1/*"]`, and expect **no** LNA prompt today — but track LNA scope changes (§7.2, §7.3).
