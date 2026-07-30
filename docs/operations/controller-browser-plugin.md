# Controller Browser Plugin

The `browser` plugin gives the controller a local Playwright-backed browser surface for bounded page reading and explicitly authorized interaction.

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
- the provider is local Playwright, either attached through a configured CDP endpoint or launched as a persistent context
- the default profile mode is `repo_local`, with profile data under `.repo-harness/browser/profiles/`
- `profileMode=custom` is explicit-only and uses the configured Chrome/Chromium profile path directly
- saved sessions live under `.repo-harness/browser/sessions/`
- screenshots live under `.repo-harness/browser/screenshots/`
- downloads live under `.repo-harness/browser/downloads/`

The browser mode is explicit:

- `managed_persistent` is the default and preserves the previous behavior: each action launches a visible persistent Playwright context, restores the target URL, performs one bounded operation, persists session metadata, then closes the context.
- `attach_preferred` first attempts to attach to one of the configured loopback CDP endpoints with `chromium.connectOverCDP`. It inventories existing tabs, reuses the best URL/title match, and disconnects from the browser instead of closing it.
- `isolated` launches a visible persistent context with a per-session repo-local profile under `.repo-harness/browser/profiles/isolated/<session_id>`. It does not share the default plugin profile or a configured custom profile.

Session metadata is reusable across actions via `session_id`. Transient navigation failures can retry with `retries` (1–3).

### Reliability and safety notes

- Domain allowlist is checked before navigation and after interactive URL changes.
- Selector failures include repair hints (`repairHint`) when possible.
- Console errors and failed requests are captured per open cycle.
- Artifacts stay under `.repo-harness/browser/**` (not arbitrary local paths).
- CDP attach is bounded to configured loopback endpoints only; the plugin does not scan arbitrary ports or remote hosts.
- Attached browsers are disconnected from after the action; managed contexts are closed after the action.
- Health `userFacingStatus` reports `ready`, `domain restricted`, `session active`, or setup states.

## Configuration

The source of truth is `.repo-harness/plugins/browser.json`.

Example:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "provider": "playwright",
  "browserMode": "managed_persistent",
  "profileMode": "repo_local",
  "browserChannel": "chromium",
  "defaultTimeoutMs": 30000,
  "allowedDomains": ["example.com", "docs.example.com"]
}
```

`allowedDomains` is the safety boundary. If it is empty, the plugin can target any HTTP(S) host. If it is set, the plugin accepts only exact hosts or subdomains of those entries.

Additional browser/profile fields:

- `browserMode`
  - `managed_persistent` keeps the existing persistent-context lifecycle.
  - `attach_preferred` tries configured CDP endpoints first and then follows `cdpAttachFallback`.
  - `isolated` uses a per-session repo-local profile under `.repo-harness/browser/profiles/isolated/`.
- `profileMode`
  - `repo_local` keeps the plugin on the repo-owned Playwright profile under `.repo-harness/browser/profiles/default`.
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
  - `fail_closed` returns `PLUGIN_BROWSER_CDP_UNAVAILABLE` with endpoint attempt diagnostics and does not launch a new browser

For an existing signed-in Chrome profile, prefer `profileMode=custom` plus `browserChannel=chrome` or an explicit `executablePath`. The plugin does not attach to a real user profile unless that custom mode is configured on purpose.

Example custom Chrome binding:

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
  "defaultTimeoutMs": 30000,
  "allowedDomains": ["appstoreconnect.apple.com"]
}
```

If `profileMode=custom` points at a live personal Chrome profile, close that same Chrome/Chromium instance first when the browser reports profile-lock or profile-in-use errors.

For `attach_preferred`, start Chrome/Chromium with a non-default automation profile and `--remote-debugging-port=<port>`. Chrome 136+ blocks remote debugging against the default user data directory; use a separate automation profile. The plugin does not launch Chrome with remote debugging flags by itself.

## Tab Resume And Diagnostics

When attaching through CDP, the plugin inventories existing tabs by index, URL, and title. Selection is deterministic:

1. saved session URL and title
2. saved session URL
3. requested URL
4. blank tab
5. new tab

This avoids opening duplicate tabs when a matching tab already exists. Saved session metadata includes the last browser mode, active mode, CDP endpoint, fallback outcome when applicable, tab key, tab URL/title/index, and a resume diagnostic. If the saved tab is not present during a later attach, responses include `sessionResume.status=stale_tab` and explain whether another target URL tab, a blank tab, or a new tab was used.

Stale or unavailable CDP endpoints return attempt-level diagnostics. With `cdpAttachFallback=managed_persistent`, those diagnostics appear in `browserConnection.fallback`; with `fail_closed`, the action fails before launching a managed context.

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

## Allowed-domain enforcement

The plugin enforces `allowedDomains` in three places:

1. It validates the explicit `url` before opening a page.
2. It validates any saved `session_id` target before interaction.
3. It re-checks the resulting page URL after the action and rejects the result if navigation leaves the allowed set.

The plugin does not intentionally provide any action that can bypass this boundary.

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
    "path": ".repo-harness/browser/screenshots/..."
  }
}
```

## Usage notes

- Prefer `open_page` first when you need a stable `session_id`.
- `click`, `type`, `press`, and `wait_for_selector` accept either `session_id` or `url`.
- If both `session_id` and `url` are provided, they must resolve to the same page target.
- `close_page` only removes saved session metadata. It does not delete the persistent profile.
- `profile_dir` is rejected unless `profile_mode=custom` is already configured or supplied in the same `configure` call.
- Visible Chrome/Chromium launches are supported, but managed actions still close after they complete. For longer human-driven login, MFA, or consent steps, use `request_human_handoff` and resume or cancel it explicitly.

## Bun runtime and the Node CDP bridge

The Controller Gateway remains Bun-hosted. For `browserMode=attach_preferred`, page actions are executed by a short-lived, bounded Node child because Playwright CDP WebSocket attachment is not reliable in the supported Bun runtime. The bridge does not create a second Browser implementation: it serializes the already-authorized plugin action over stdin and invokes the same Browser adapter under Node.

The child is started directly without a shell. The CDP endpoint remains loopback-only, request and response payloads are bounded, execution has a bounded timeout, and credentials are never placed in argv. Cookies, storage state, authorization headers, and page secrets are not returned by the bridge protocol. The child disconnects from an attached browser rather than closing the user's Chrome instance.

`managed_persistent` and `isolated` continue to run directly in the Controller runtime. Configuration, session listing and cleanup, and human-handoff lifecycle actions also remain local. Set `REPO_HARNESS_NODE_EXECUTABLE` only to an explicitly trusted executable; an invalid configured path fails closed.

A safe live proof against an already running loopback Chrome instance is available with:

```bash
bun scripts/smoke-browser-cdp-bridge.ts http://127.0.0.1:9222
```

The smoke reuses an existing HTTP(S) tab, repeats the same session action, verifies that the target count does not increase, and confirms that Chrome remains reachable after the Node child disconnects. It does not read cookies or storage state and does not print the page title or full URL.

Immutable Supervisor releases include a dedicated `browser-node-bridge-host.js` bundle built for Node. The Browser adapter resolves that sibling entrypoint when running from a release and falls back to the source TypeScript host only in a source checkout. Release verification treats the bridge host as a required, hashed executable.
