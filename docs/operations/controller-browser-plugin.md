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
- saved sessions live under `.forge/browser/sessions/`
- screenshots live under `.forge/browser/screenshots/`
- downloads live under `.forge/browser/downloads/`

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

The live macOS acceptance test covers background replacement, DOM fill/click, click-driven navigation, session URL refresh, `go_back`, `reload`, explicit screenshot refusal, session close, and verifies both the user's active Chrome tab and the system frontmost application remain unchanged.
Run it explicitly on a macOS workstation with a running Chrome instance:

```bash
bun run test:browser-live
```

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
