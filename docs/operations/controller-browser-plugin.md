# Controller Browser Plugin

The `browser` plugin gives the controller a bounded local browser surface for page reading and explicitly authorized interaction. It supports Playwright-managed contexts, loopback CDP attachment, and macOS active-tab attachment through Apple Events for Google Chrome and Vivaldi.

## Scope

Supported action groups:

- **Session lifecycle**: `create_session`, `list_sessions`, `close_session`, `clear_session`, `close_page`
- **Navigation**: `open_page`, `navigate`, `reload`, `go_back`, `wait_for_load_state`
- **DOM / extraction**: `get_text`, `get_html`, `query_selector`, `query_all`, `get_attribute`, `extract_links`, `extract_tables`, `extract_forms`, `snapshot_interactive`
- **Screenshots / artifacts**: `screenshot` (page, full-page, or element selector)
- **Forms / interaction** (authorized): `click`, `double_click`, `hover`, `focus`, `type`, `fill`, `select_option`, `check`, `uncheck`, `press`, `keyboard_shortcut`, `wait_for_selector`
- **Bounded file transfer** (authorized): `attach_local_file`, `await_file_transfer`
- **Diagnostics**: `get_console_errors`, `get_failed_requests`

Still out of scope by design:

- free-form submit / delete / publish / payment / send workflows as first-class actions
- auto-opening downloaded executables
- leaking cookies, tokens, or raw profile secrets in responses

Interactions that can mutate remote state still require `confirm_authorization=true`. Domain allowlists remain enforced for every navigation and interaction result.

## Runtime model

- `plugin_id` stays `browser`
- the provider is local browser automation: configured loopback CDP, macOS Apple Events for an already-running Chrome/Vivaldi tab, or a Playwright persistent context
- the default profile mode is `repo_local`, with profile data under `.forge/browser/profiles/`
- `profileMode=custom` is explicit-only and uses the configured Chromium-family profile path directly when launching a managed context
- controller-home BrowserSession state is authoritative; legacy `.forge/browser/sessions/*.json` files are imported once and then removed
- screenshots live under `.forge/browser/screenshots/`
- downloads live under `.forge/browser/downloads/`

Runtime maintenance bounds repository-local browser artifacts: upload staging is retained for 24 hours and screenshots for seven days. Profiles, downloads, diagnostics, and user-created review artifacts are not included in this automatic cleanup.

The browser mode is explicit:

- `attach_preferred` is the default. It uses a strict order: configured loopback CDP endpoints; then an already-running, scriptable macOS Google Chrome or Vivaldi instance; then `cdpAttachFallback`. The default fallback is `managed_persistent`, so Forge only launches its own Playwright browser after attach paths are unavailable. CDP inventory reuses a previously owned matching tab. Apple Events prefers the frontmost supported browser, otherwise Chrome before Vivaldi; it can reuse a unique existing tab at the requested URL, otherwise creates a plugin-owned background tab while preserving the user's active tab, and reattaches directly to the saved window/tab identity on later actions.
- `managed_persistent` is the explicit managed-browser mode: each action uses a visible persistent Playwright context, restores the target URL, performs one bounded operation, persists session metadata, then closes the context.
- `isolated` launches a visible persistent context with a per-session repo-local profile under `.forge/browser/profiles/isolated/<session_id>`. It does not share the default plugin profile or a configured custom profile.

Session metadata is reusable across actions via `session_id`. Any action that returns a generated `sessionId` persists that session before returning, so the identifier is immediately valid for follow-up actions. Transient navigation failures can retry with `retries` (1–3).

### Reliability and safety notes

- Domain allowlist is checked before navigation and after interactive URL changes.
- Selector failures include repair hints (`repairHint`) when possible. Selector snapshots prefer unique `data-*`, role/ARIA, name, and non-generated id anchors; structural `nth-of-type` paths are only a last resort and are derived from the actual DOM sibling position rather than result order. Open Shadow DOM can be traversed explicitly with bounded `host >>> descendant` selectors; closed shadow roots remain inaccessible.
- Reusing a saved macOS native session is fail-closed: if the stable plugin-owned tab identity disappears, Forge returns `PLUGIN_BROWSER_SESSION_STATE_LOST` instead of silently creating a replacement tab that could discard unsaved form/editor state.
- Console errors and failed requests are captured for Playwright/CDP cycles. Apple Events attachment reports empty console/network diagnostics because those streams are not exposed by the browser scripting dictionary.
- Artifacts stay under `.forge/browser/**` (not arbitrary local paths).
- CDP attach is bounded to configured loopback endpoints only; the plugin does not scan arbitrary ports or remote hosts. Native discovery checks only the configured Chrome/Vivaldi candidates and does not launch them.
- CDP browsers are disconnected after the action; Apple Events keeps plugin-owned session tabs open until `close_session`/`close_page` while preserving user-owned tabs; managed contexts are closed after the action. Standard native DOM reads/interactions do not foreground the owned tab and return DOM evidence instead of attempting a screenshot.
- Health `userFacingStatus` reports `ready`, `session active`, or setup states.

## Browser Runtime V3 contract

Browser Runtime V3 is the current Browser authority. The V2 ADR in [`../architecture/decisions/20260826-browser-runtime-v2.md`](../architecture/decisions/20260826-browser-runtime-v2.md) remains historical rationale; it is not a second runtime contract. Public Browser action IDs remain stable.

- controller-home BrowserSession state is the only durable browser-session authority;
- exact provider/resource identity is stable while URL/title are mutable observations and are refreshed after persisted reads;
- provider routing is capability-based instead of fallback-by-exception;
- a warm provider handle is reusable across bounded actions and full rediscovery is exceptional;
- cold native rebind uses the saved exact `windowId` + `tabId`; losing optional global tab inventory does not authorize guessing a user tab;
- mutations compile to provider-local `observe -> act -> verify` transactions;
- raw Apple Events / AX / socket / CGEvent success is not accepted as mutation success without postcondition evidence;
- typed browser-internal capabilities are preferred for bookmarks/tabs/downloads instead of driving `chrome://` UI;
- foreground physical input is explicit and separate. Browser `trusted_input` does not silently foreground a tab or reuse Desktop coordinates; use an explicitly authorized Desktop Operator foreground/physical action when that is the intended capability.

The warm-path performance targets remain p95 <= 350 ms for reads, <= 600 ms for DOM interaction plus verification, and <= 700 ms for typed browser-internal-resource operations. Explicit physical-input fallback targets p95 <= 1500 ms and is foreground-capable only when requested. Current-source live evidence is emitted by `tests/live/browser-runtime-v3.e2e.ts`; Work/Plan evidence owns measured p50/p95 values rather than this maintained runbook.

## Configuration

The source of truth is `.forge/plugins/browser.json`.

Example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "browserMode": "attach_preferred",
  "profileMode": "repo_local",
  "nativeAttachMode": "auto",
  "nativeBrowserCandidates": ["vivaldi", "chrome"],
  "cdpAttachFallback": "managed_persistent",
  "browserChannel": "chromium",
  "defaultTimeoutMs": 30000
}
```

Browser URLs are open by default across hosts. The URL boundary is scheme-based: top-level navigation accepts absolute `http://` and `https://` URLs and rejects `file://`, `data:`, browser-internal pages, and custom schemes. Interaction risk and authorization are enforced by the typed action policy rather than a domain grant.

Additional browser/profile fields:

- `browserMode`
  - `managed_persistent` keeps the existing persistent-context lifecycle.
  - `attach_preferred` tries configured CDP endpoints, then macOS Apple Events when enabled, then follows `cdpAttachFallback`.
  - `isolated` uses a per-session repo-local profile under `.forge/browser/profiles/isolated/`.
- `profileMode`
  - `repo_local` keeps the plugin on the repo-owned Playwright profile under `.forge/browser/profiles/default`.
  - `custom` is the explicit opt-in path for an existing Chrome/Chromium profile.
- `profileDir`
  - required when `profileMode=custom`
  - may point either at a browser user-data directory or at one profile subdirectory such as `Profile 1`
- `profileDirectory`
  - optional when `profileDir` points at the browser user-data directory
  - selects one Chrome profile inside that user-data directory
- `browserChannel`
  - `chromium` (default bundled Playwright engine)
  - `chrome`, `chrome-beta`, `chrome-dev`, `chrome-canary`
- `executablePath`
  - explicit Chrome/Chromium binary path
  - mutually exclusive with `browserChannel`
- `cdpEndpoint`
  - optional primary DevTools endpoint for `attach_preferred`
  - must be loopback-only and use `http`, `https`, `ws`, or `wss`
  - HTTP(S) endpoints are probed at `/json/version`; a returned `webSocketDebuggerUrl` is passed to Playwright `connectOverCDP`
- `cdpEndpointCandidates`
  - optional ordered fallback endpoints
  - capped at five total configured endpoints
- `cdpDiscoveryTimeoutMs`
  - bounded to 5 seconds; default is 1500 ms
- `cdpAttachFallback`
  - `managed_persistent` (default) launches the managed persistent context when attach fails
  - `fail_closed` returns `PLUGIN_BROWSER_ATTACH_UNAVAILABLE` with CDP and native-attempt diagnostics and does not launch a new browser
- `nativeAttachMode`
  - `auto` (default) enables macOS Apple Events attachment after CDP attempts fail
  - `disabled` skips native browser discovery
- `nativeBrowserCandidates`
  - ordered list containing `vivaldi` and/or `chrome`; the default is `["vivaldi", "chrome"]`
  - if multiple candidates are running and scriptable, the frontmost browser wins; otherwise candidate order wins
  - discovery checks installation, process state, and active-tab metadata without launching the browser

For an already-running signed-in browser on macOS, prefer `browserMode=attach_preferred` with `nativeAttachMode=auto`. The plugin reuses the running browser process and login state without copying profile data, but does not reuse the user's active tab as an automation target. It creates and owns a separate background tab. `profileMode=custom` remains the explicit path for launching a separate Playwright context against a selected Chromium-family profile.

Example custom Chrome automation-profile binding:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "browserMode": "attach_preferred",
  "profileMode": "custom",
  "profileDir": "/Users/alice/Library/Application Support/Google/Chrome",
  "profileDirectory": "Profile 1",
  "browserChannel": "chrome",
  "cdpEndpoint": "http://127.0.0.1:9222",
  "cdpAttachFallback": "fail_closed",
  "defaultTimeoutMs": 30000
}
```

If `profileMode=custom` points at a live personal Chrome profile, close that same Chrome/Chromium instance first when the browser reports profile-lock or profile-in-use errors.

For `attach_preferred`, start Chrome/Chromium with a non-default automation profile and `--remote-debugging-port=<port>`. Chrome 136+ blocks remote debugging against the default user data directory; use a separate automation profile. The plugin does not launch Chrome with remote debugging flags by itself.

### Active signed-in Chrome or Vivaldi on macOS

Use native attachment when the target session is already logged in:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "browserMode": "attach_preferred",
  "nativeAttachMode": "auto",
  "nativeBrowserCandidates": ["vivaldi", "chrome"],
  "cdpAttachFallback": "managed_persistent"
}
```

The attach order is CDP, then Apple Events, then managed fallback. macOS may require Automation permission for the controller/Node process to control Vivaldi or Google Chrome. The browser must also permit JavaScript from Apple Events for DOM extraction and interaction. If either permission is unavailable or the browser has no window, the attempt is recorded and fallback policy applies. The provider uses the active browser only for discovery, then operates on a plugin-owned tab identified by stable window/tab metadata. It does not read cookies or storage. Top-level Browser actions accept any absolute HTTP(S) URL; non-HTTP(S) schemes fail before launch.

Native limitations are explicit: console/network event capture is unavailable and native file-input/download semantics are not equivalent to Playwright. A screenshot of a plugin-owned background tab fails closed with `PLUGIN_BROWSER_FOREGROUND_REQUIRED`; Forge does not silently activate the tab just to capture evidence. Use explicit foreground/human handoff, CDP, or a managed context for workflows that require screenshots or capabilities not available through background DOM automation.

### Silent native tab semantics

Apple Events attachment treats silence as the default execution contract:

- new sessions create a background plugin-owned tab and leave the browser's active tab unchanged;
- saved native sessions reattach directly by stable `windowId` + `tabId`, without rediscovering or borrowing the user's active tab;
- DOM reads, form fill, click, reload, page-owned navigation, and history back remain in the owned background tab when Chrome/Vivaldi supports them;
- explicit cross-URL `open_page`/`navigate` on an existing native session uses a replacement transaction: create and validate a new background owned tab, then close the old owned tab. This avoids unreliable in-place background navigation and preserves the user's foreground tab;
- if replacement validation fails, the new tab is closed and the prior owned tab remains authoritative;
- native tab ownership is the stable window/tab reference itself. CDP keeps its separate owner-token mechanism;
- only explicitly foreground-dependent operations such as screenshot capture or human handoff may require visible foreground presentation. They fail closed rather than activating implicitly.

The legacy macOS acceptance test remains available through `bun run test:browser-live`. Browser Runtime V3 adds `tests/live/browser-runtime-v3.e2e.ts`, which uses loopback fixtures and exact owned refs to cover Chrome/Vivaldi lifecycle, competing-foreground preservation, same-origin URL drift plus cold rebind, failed replacement postconditions, Chrome internal-resource adoption, cleanup, and per-operation p50/p95 reporting. Run the V3 gate explicitly on a macOS workstation with the target browsers already running:

```bash
bun tests/live/browser-runtime-v3.e2e.ts
```

Set `FORGE_BROWSER_V3_REQUIRE_COMPETING_FOREGROUND=1` when a non-browser application is already frontmost to make foreground preservation a hard precondition. Set `FORGE_BROWSER_V3_REQUIRE_DOM_ALL=1` only when JavaScript-from-Apple-Events permission is expected for every requested native browser. Without that strict flag, a browser whose lifecycle is available but DOM automation is blocked is reported as `external_permission_required` with `PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED`; the harness still verifies exact-ref cleanup and active-user-tab preservation for that product.

The stable Desktop Operator broker may omit global `list_tabs` or Browser `trusted_input`. Forge treats inventory absence as a loss of reuse optimization, not as permission to inspect or adopt unknown user tabs: new sessions create a Forge-owned tab, saved sessions validate exact refs, and close/reconcile operate on exact refs. Missing native trusted input remains a typed Browser capability limitation; explicit Desktop Operator foreground/physical interaction is a separate, visually verified path.

## Tab Resume And Diagnostics

When attaching through CDP, the plugin inventories existing tabs by index, URL, and title. Selection is deterministic:

1. saved session URL and title
2. saved session URL
3. requested URL
4. blank tab
5. new tab

This avoids opening duplicate tabs when a matching tab already exists. Saved session metadata includes the last browser mode, active mode, CDP endpoint, fallback outcome when applicable, tab key, tab URL/title/index, and a resume diagnostic. If the saved tab is not present during a later attach, responses include `sessionResume.status=stale_tab` and explain whether another target URL tab, a blank tab, or a new tab was used.

Stale or unavailable CDP endpoints and unavailable native browsers return attempt-level diagnostics. With `cdpAttachFallback=managed_persistent`, those diagnostics appear in `browserConnection.fallback`; with `fail_closed`, the action fails before launching a managed context. Native sessions record `provider=macos-apple-events` and `browserProduct=vivaldi|chrome`.

## Policy surface

Readonly actions:

- `open_page`
- `get_text`
- `screenshot`
- `close_page`

These stay `confirmation=none` and `risk=readonly`.

Interactive actions:

- `click`
- `type`
- `press`
- `wait_for_selector`

These require `confirmation=authorization`.

Risk levels:

- `click`, `type`, `press` use `risk=remote_write`
- `wait_for_selector` uses `risk=workspace_write`

## URL scheme boundary

Browser no longer maintains per-domain grants or a host allowlist. Any absolute HTTP(S) URL may be opened, redirected to, or reached by an interaction. This avoids configuration churn for normal browsing while preserving the actual trust boundaries:

1. top-level Browser targets must use `http:` or `https:`;
2. local files, browser-internal URLs, `data:` URLs, and custom schemes are rejected as Browser targets;
3. action risk and confirmation still govern remote writes and interactive operations;
4. silent native automation stays on plugin-owned background tabs unless an explicit human handoff requires foreground presentation.

## Dependency requirement

The browser plugin requires the `playwright` package in the repo runtime.

If Playwright is missing:

- plugin health reports a dependency error
- action execution returns `PLUGIN_DEPENDENCY_MISSING`
- the expected remediation is `bun install`

## Interaction results

Successful `click`, `type`, `press`, and `wait_for_selector` responses include:

- the resolved `url`
- the page `title`
- an `action.summary`
- updated `session` metadata
- a best-effort screenshot path when capture succeeds

Example response shape:

```json
{
  "provider": "playwright",
  "url": "https://example.com/",
  "title": "Example",
  "action": {
    "actionId": "click",
    "summary": "Clicked #cta."
  },
  "session": {
    "sessionId": "browser_1234abcd",
    "url": "https://example.com/",
    "title": "Example"
  },
  "screenshot": {
    "path": ".forge/browser/screenshots/..."
  }
}
```

## Usage notes

- Prefer `open_page` first when you need a stable `session_id`.
- `click`, `type`, `press`, and `wait_for_selector` accept either `session_id` or `url`.
- If both `session_id` and `url` are provided, they must resolve to the same page target.
- `close_page` only removes saved session metadata. It does not delete the persistent profile.
- `profile_dir` is rejected unless `profile_mode=custom` is already configured or supplied in the same `configure` call.
- Visible Chromium-family launches are supported, but managed actions still close after they complete. Apple Events attachment preserves the user's current Vivaldi/Chrome process and login state. For longer human-driven login, MFA, or consent steps in a managed profile, use `request_human_handoff` and resume or cancel it explicitly.

## Bun runtime and the Node browser-attach bridge

The Controller Gateway remains Bun-hosted. For `browserMode=attach_preferred`, page actions are executed by a short-lived, bounded Node child because Playwright CDP WebSocket attachment is not reliable in the supported Bun runtime and native attach must share the same authorized adapter path. The bridge does not create a second Browser implementation: it serializes the already-authorized plugin action over stdin and invokes the same Browser adapter under Node.

The child is started directly without a shell. The CDP endpoint remains loopback-only, request and response payloads are bounded, execution has a bounded timeout, and credentials are never placed in argv. Cookies, storage state, authorization headers, and page secrets are not returned by the bridge protocol. The child disconnects from CDP or releases the Apple Events operation without closing the user's Chrome or Vivaldi instance.

`managed_persistent` and `isolated` continue to run directly in the Controller runtime. Configuration, session listing and cleanup, and human-handoff lifecycle actions also remain local. Set `FORGE_NODE_EXECUTABLE` only to an explicitly trusted executable; an invalid configured path fails closed.

A safe live proof against an already running loopback Chrome instance is available with:

```bash
bun scripts/smoke-browser-cdp-bridge.ts http://127.0.0.1:9222
```

The smoke reuses an existing HTTP(S) tab, repeats the same session action, verifies that the target count does not increase, and confirms that Chrome remains reachable after the Node child disconnects. It does not read cookies or storage state and does not print the page title or full URL.

Immutable Forge whole-Runtime releases include a dedicated `browser-node-bridge-host.js` bundle built for Node. The Browser adapter resolves that sibling entrypoint when running from a release and falls back to the source TypeScript host only in a source checkout. Release verification treats the bridge host as a required, hashed executable.

### Exact-tab selection and local file upload

- Browser URL/title is an observation, never a unique Tab identity. Sessionless URL reuse requires exactly one matching tab; an active tab, former window, duplicated owned marker, or truncated macOS inventory does not break ties. A previously saved native tab can only reattach by its exact ID; disappearance fails with `PLUGIN_BROWSER_SESSION_STATE_LOST` instead of binding a different user tab. Return `PLUGIN_BROWSER_REUSABLE_TAB_AMBIGUOUS` and request an explicit existing Tab binding rather than guessing or trying an alternative provider. Exact native `windowId`/`tabId` binding remains the first choice.
- For a normal webpage `input[type=file]`, `attach_local_file` takes `selector` plus `file_path` or `file_paths` (1–32). Paths are relative to the repository by default. To attach files in Downloads/Desktop or another approved directory, first authorize that directory using the existing `local_system.authorize_target` (read-only is sufficient), then supply `target_key` and file paths **relative to the authorized target root**. Absolute paths, expired/wrong-caller grants, traversal, symlink escape, directories, and executable file types are rejected.
- `attach_local_file` binds files to the DOM input and verifies their selected names/sizes, not the remote application's completed upload. The caller must separately verify its submission and server-side result. In macOS native Browser mode, bytes are transported to Chrome/Vivaldi via the existing browser scripting bridge; large/batch upload performance and live application postconditions require dedicated acceptance.
- A system `Open Panel` triggered by Chrome is **not Finder**. The existing `local_system.reveal_in_finder` command only reveals files and does not select files in that panel. No Browser `attach_local_file` fallback to unreliable Finder clicks or undeclared foreground input is performed; a distinct exact-dialog native Computer workflow would need its own real end-to-end validation.

Native Chrome/Vivaldi DOM file attachment follows one bounded transaction: validate every local regular file (up to 32 files and 16 MiB total), observe a unique enabled `input[type=file]` and its `multiple` property, stage the entire batch without modifying the input, then assign `input.files` once and emit one `input`/`change` pair. Mid-transfer failure does **not** leave a partial selection. The final DOM event can trigger a remote upload: if its receipt is unknown, re-observe the exact page before any further mutation; do not replay the transfer blindly. Upload completion still requires separate application-level verification. A macOS Open Panel remains a separate Desktop accessibility workflow, not a fallback for this action.

The macOS Chrome live E2E (`bun run test:browser-live`) calls the **production Computer/Desktop Operator broker** for both active-tab observation and all Browser actions. It must not spawn `osascript`, install a test-only Apple Events callback, or override the stable provider socket; such a test would exercise a different macOS TCC/automation principal and could misattribute a JavaScript permission error to the user's Chrome setting. The E2E preserves the exact active user tab and cleans up only its own created tab. When Chrome reports a JavaScript permission error, inspect the calling provider and Chrome process/profile identity before instructing users to change settings.

The public `PLUGIN_BROWSER_JAVASCRIPT_PERMISSION_REQUIRED` code reports that the **instance selected by Apple Events rejected JavaScript**; it does not prove the visible GUI Chrome checkbox is unchecked. In particular, concurrent Chrome processes using separate `--user-data-dir` roots may make process targeting ambiguous. Preserve the error code for callers but inspect the exact process/profile and real Browser broker invocation. Do not restart Chrome, toggle user settings, or silently switch providers based solely on this code.

The real Chrome E2E also runs a **read-only process-root preflight before the first Apple Event**. If more than one Chrome application root exists (including headless `--user-data-dir` browser instances), it fails with `CHROME_APPLE_EVENTS_TARGET_AMBIGUOUS` instead of claiming the visible Chrome has disabled JavaScript or driving an unproven tab. It never kills the other process or toggles the user's setting. This guard is scoped to the live test harness; it is not an OS-level PID targeting solution for the production AppleScript broker.

Desktop Operator Chrome Apple Events dispatch now has the canonical application-root safety preflight (native commit `cab13fdee`): when a GUI and headless Chrome share the app name, or multiple GUI roots exist, it returns `BROWSER_AUTOMATION_PROCESS_TARGET_AMBIGUOUS` before scripting rather than sending events to an unproven profile; process enumeration failures return `BROWSER_AUTOMATION_PROCESS_PROBE_UNAVAILABLE`. Browser preserves these typed errors, with no provider substitution or guessed Tab identity. This is a fail-closed safety step, not live support for selecting the GUI PID while independent headless Chrome instances remain open.

**PID-bound Chrome update (Desktop Operator commit `3b3c5786`):** Chrome's production Apple Events transport is now the same Desktop Operator provider using `SBApplication(processIdentifier:)`, not name-addressed `osascript`. It selects exactly one non-headless GUI Chrome root, even if separately owned headless/CDP Chrome processes are running. Multiple GUI roots remain ambiguous; losing the verified PID/bundle/executable returns typed nonretryable `BROWSER_AUTOMATION_PROCESS_IDENTITY_LOST`. Forge Browser preserves this error and its live test now permits independent headless Chrome roots. No fallback to name addressing or provider switching. These are source-level changes until separately deployed; final authenticated Chrome Tab and upload E2E remains outstanding.
