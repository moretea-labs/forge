# macOS App design — Forge field guide

Reviewed: 2026-11-06 · [ForgeClient Issue #592](https://github.com/moretea-labs/forge/issues/592). These are **implemented conventions**, not an extra UI framework or controller.

## Research and evidence

| Reference | Observation | Forge decision |
| --- | --- | --- |
| [CollectUI Mac App inspiration](https://collectui.com/designs/mac-app-ui-design-inspiration) | Visual inspiration directory; appearance alone does not verify platform behavior | Use as examples to critique, not assets or UI implementation authority |
| [Apple macOS HIG](https://developer.apple.com/design/human-interface-guidelines/designing-for-macos) | Windows resize, menus, keyboard, fewer nested levels | One focused workspace with collapsible sidebar and keyboard access |
| [Apple Toolbars](https://developer.apple.com/design/human-interface-guidelines/toolbars) | Toolbar should express current view and key actions | Keep one compact header; macOS owns window chrome and traffic lights |
| [Apple Sidebars](https://developer.apple.com/design/human-interface-guidelines/sidebars) | Stable navigation may collapse in small windows | Assistant, project assets, system links in one rail; active differs from hover |
| [Raycast native-engineering notes](https://www.raycast.com/blog/a-technical-deep-dive-into-the-new-raycast) | Pointer, hover, menu placement, keyboard and focus reveal native quality | No web-like pointer cursor on buttons; menus dismiss and restore focus |
| Better Design search: Interior / Slate / Playdesk | Each introduces an incompatible surface and component language | Retain established Forge identity; no new React/shadcn component framework |

## Single source and reuse

- `.design-harness/tokens.json` is the canonical **design-token** document, owned by the Forge repository. `apps/desktop/src/design-tokens.ts` imports it directly and passes CSS variables to the app shell. Do not create another theme store.
- `.design-harness/components.json` and `screens/` contain reviewable proposed component/interaction contracts; the running code in `apps/desktop/src` is authoritative for shipped behavior.
- Forge Design registers, validates, reads and exports the one repository design project. Better Design is a research/review reference, not another persistence owner.
- For other Mac apps, reuse the research → token/interaction contract → real render/keyboard QA method; do not copy this client's purple accent, project names or feature hierarchy.

## UI rules

1. **Hierarchy:** Navigation rail + one primary task pane. Requirement/Plan/Work are independent project assets, not cards nested under chat. Secondary evidence uses disclosure, not permanent inspectors.
2. **Material:** Blur only for sidebar, anchored popovers, and composer. Content remains opaque. No stacked glass cards, heavy shadows, doubled separators or dashboard KPIs.
3. **Typography:** System SF/Chinese fallback. Body/navigation ≥13px; 11px for optional metadata only. Space on an 8/12/16/24 rhythm; no tiny primary actions.
4. **Controls:** 12px control radius, 20px floating surface radius where useful, consistent 16–18px icon geometry. Keyboard focus visible; disabled and error states textual.
5. **Interaction:** Cmd+B collapses sidebar; Cmd+N new thread; Cmd+K searches; Escape closes menus and restores focus. Arrow/Home/End navigate options. Never silently rebind a saved Work or conversation when choosing context.
6. **Motion:** Restrained feedback only for spatial changes, no animation during typing/selection, respect reduced-motion and reduced-transparency.
7. **Resizing:** Compare 1440×900, 1100×760, 900×700 and 800×560. Menus must remain within viewport; main action must remain visible; no horizontal overflow.
8. **Authority:** Local coding Agent is primary. MCP/Runtime/Recovery are separate capabilities, not Agent modes. Retired Supervisor automatic continuation is not a user-facing feature.

## Validation contract

Before calling a screen complete, validate the Forge Design project; run Desktop UI tests + TypeScript/Vite/Cargo; render and interact at a wide and compact Mac viewport; inspect focus, Escape, keyboard, disabled state and reduced motion. Source CI or Chrome preview is **not** proof of real native WKWebView interaction or live Agent E2E.

## Reference-led implementation: selected screen 2026-11-06

**Source of the primary layout:** [Minimal Agent Desktop UI — Code with AI Agents (Lukas Horak / PLATFORM, Dribbble)](https://dribbble.com/shots/27163958-Minimal-Agent-Desktop-UI-Code-with-AI-Agents). A visual design reference, **not** an executable component library or claim of native behavior.

**User-approved sidebar reference (C):** [ShioriCode](https://www.shiori.ai/code) for its cool light-gray navigation rail, restrained active states, thread grouping and bottom project control. A / PLATFORM remains the primary work area reference. CollectUI's [mac-app category](https://collectui.com/designs/mac-app-ui-design-inspiration) currently has no published examples, so it is *not* evidence for a specific screen.

| Reference characteristic | Actual implementation contract | Source |
| --- | --- | --- |
| Deliberate narrow left rail, light quiet material | 246px navigation; neutral gray-cream rail, no layered glass panels; active selection filled, not bordered | `App.tsx` `Sidebar`; `styles.css` `.sidebar` |
| Top actions separated from destinations | Fixed New Thread and Search; labeled Workspace section; project-scoped Requirement/Plan/Work/Knowledge beneath | `Sidebar` |
| Recent project conversations | One real local thread index, grouped by repository; no new store; search operates over this same index | `Sidebar` |
| Stable current project placement | Existing project selector near bottom of rail, with actual registered repos and no fabricated project data | `.sidebar-project-popover` |
| Native-feeling reading workspace | One uninterrupted opaque working canvas and a quiet 54px context toolbar; no additional fake macOS window chrome | `.workspace-region` |
| Conversation and tools are the task, not UI decor | Chat transcript primary; contextual diff as opt-in pane; existing real send/cancel semantics untouched | `LocalConversationSurface` |
| Quiet composer | Single off-white 16px-radius composer, modest shadow, grouped real model/repository/work selectors, no permanent decorative control rails | `.agent-chat-composer` |
| Platform robustness | Standard native titlebar as an isolation step while WKWebView blank-window issue is investigated; do not restore native full-window Liquid Glass until actual frontmost window is visibly interactive | `tauri.conf.json` |

**Trade-off:** A provides a focused warm-white Agent canvas; C contributes the cool light-gray sidebar. Keep the original Forge hierarchy and on-demand Git inspector; no imported reference assets, blue gradients or extra full component framework.

**Visual acceptance:** Capture the *actual screen/window* and compare 1440×900 plus 800×560, with and without sidebar, first new thread, open project dropdown, and a selected Requirement/Plan/Work record. Confirm no horizontal overflow, no cut-off menu, real focus/hover/Escape and readable 13px body. Source tests or Accessibility trees alone do not establish that macOS WebKit has painted its foreground window. White or gray window is a release blocker.

**Licensing note:** These sources are visual references. Do not copy source art, avatars, logos, proprietary icons or screenshots into the app; use Forge's own code, data and icon family.

**Saved evidence:** [1440×900 browser preview](./previews/forgeclient-agent-web-preview-1440.png) and [800×560 browser preview](./previews/forgeclient-agent-web-preview-800.png) represent the approved A+C browser preview. They are not evidence that the installed WKWebView paints correctly or that a real Agent run completed.

## Native WKWebView first-frame white-screen investigation (2026-11-06)

On macOS 27.0, the full Tauri/Wry ForgeClient UI was present in the Accessibility tree but its window painted blank. Removing glass effects, changing titlebar style, ad-hoc entitlements, Vite asset path changes and a clean Cargo build did not resolve it. Two independent controlled native experiments established:
- Pure AppKit WKWebView renders a red test page.
- The ForgeClient's own Tauri 2/Wry/Rust main program renders a red test page.
- The entire Forge React application renders natively **without its stylesheet**.
- The **identical complete stylesheet** renders correctly when enabled **after the WebView's initial unstyled frame** using a temporary native CSS-toggle test app.

The app now schedules the *existing* stylesheet import after two animation frames in `src/main.tsx` (single root, single stylesheet). Verify the generated production HTML does not eagerly include a stylesheet link, and verify a cold-launched installed native app visibly shows the sidebar, conversation and composer. This workaround should be removed only after a native regression test establishes that eager CSS no longer stalls WKWebView. Do not treat Chromium/web-only screenshots or Accessibility tree presence as native-render acceptance. Native probe code and test bundles live in temporary paths and must not ship.

## Reference interaction implementation: project selector

Use `@radix-ui/react-popover` **only** where custom menu mechanics create actual native-desktop UX bugs. The project picker now uses Radix Trigger/Portal/Content for anchor placement, Escape/outside dismissal and focus restoration; Forge still supplies Registry project data and the UI retains its single existing selected-project state. No second token/theme system, no project CRUD facade and no extra Provider.

Browser interaction evidence (2026-11-06): 1440×900 and 800×560 both pass bounded portal placement, search focus, Escape-to-trigger focus restoration, outside dismissal and zero page exceptions. Native Mac locked foreground acceptance remains a separate blocker.

## Approved A+C light design — 2026-11-06

- A / workspace: [PLATFORM Minimal Agent](https://dribbble.com/shots/27163958-Minimal-Agent-Desktop-UI-Code-with-AI-Agents) sets the warm-white content canvas, 54px context toolbar, spacious transcript, focused composer and optional Git/code pane. [The related chat design](https://dribbble.com/shots/27160331-Minimal-Agent-Desktop-UI) informs Agent empty and populated threads.
- C / navigation: [ShioriCode](https://www.shiori.ai/code) sets a **cool light-gray sidebar** (#F0F1F4), low-chrome separators and neutral selected states. No reference logos, blue accents or proprietary artwork.
- Functional layout: 246px sidebar (228px at <=1080px and 207px at <=900px), pinned New Thread/Search, independently navigable Work/Requirement/Plan/Knowledge, grouped actual threads, one bottom project picker and Runtime/Settings footer. The Agent conversation owns the main surface; Git detail is on demand rather than a permanent explorer.
- Single style authority: .design-harness/tokens.json v0.3.0 supplies colors to the app shell and Radix portal. The rail is #F0F1F4, canvas #FFFDFB and composer #FFFFFF; styles.css implements spacing/geometry, not a competing palette.
- Browser QA: 1440x900, 1100x760 and 800x560 checked computed colors, no horizontal overflow, bounded project popover, search autofocus, Escape close/focus restoration and zero JS errors. Installed WKWebView visual paint/Agent execution still require independent validation.

### Project-asset detail acceptance — A+C

- Verified the actual **Work**, **Requirement** and **Plan** list/detail surfaces at 1440×900 and 800×560, not only an empty Agent conversation. All retain the chosen sidebar width, no horizontal overflow, and zero browser JavaScript errors.
- `?preview=1` is explicitly a browser-only design fixture. It must never invoke native Tauri `read_project_plan_list` or `read_requirement_detail` commands. Its records are bounded to the existing Work graph, recent history and the currently selected Work projection; the preview labels the limited coverage and disables native refresh.
- The **selected Work** can contain real Requirement/Plan identifiers even when the bounded Work graph omits them. Merge the selected Work into the same read-only record index by Work ID, rather than inventing a second Requirement/Plan store or duplicating the preview fixture. Runtime mode continues to read canonical detail via existing IPC.
- These observations validate browser rendering and navigation only. Native installed-app paint, real Agent send/stop and source-aware Work detail remain separate acceptance items under Issue #592.

### Native first-frame bootstrap candidate (2026-11-06)

The installed Forge.app can still be blank while the same React/Tauri frontend in the separately signed `ForgeBootstrapProbe` (with a paintable initial HTML document) renders. To test the narrowest possible change, `apps/desktop/index.html` now supplies one static, visible "Forge 正在启动…" element, and `src/main.tsx` removes it once the **existing** CSS chunk has loaded. On CSS failure, it reports a visible error instead of disappearing. This is neither a second React root nor an alternative data/Agent authority. **Do not mark the native fix accepted based on compilation alone**: a correctly signed production bundle with the original `com.moretea.forge.desktop` identifier must be cold-launched, visually inspected and operated.

### Agent desktop control acceptance — 2026-11-06

The A+C UI now uses one macOS keyboard destination map: `⌘1` Agent, `⌘2` Work, `⌘3` Requirement, `⌘4` Plan, `⌘5` Knowledge, `⌘,` Settings. Existing `⌘B` sidebar toggle, `⌘K` conversation search and `⌘N` new conversation remain separate and preserved. Sidebar options and workspace titles share concise Chinese labels.

Local Agent conversations use **Delete** instead of a misleading Archive action: the selected thread and draft are removed from the single localStorage owner rather than kept as invisible history. This does **not** modify Forge's canonical Work/Requirement/Plan, Agent provider sessions on the server, or the registered project catalog.

Real Chromium interaction checked at 1440×900 and 800×560: all six destination shortcuts opened their expected surfaces; deleting one of two seeded local threads left one thread and its own draft, with zero page errors. A separate browser-context test seeded localStorage only once, refreshed the page and confirmed that deleted thread remained absent and the other draft persisted; `⌘N` created a new thread and focused the composer. The earlier apparent reappearance on reload was caused by the test bootstrap reseeding on every navigation, not a product defect.

Installed preview policy: retain **only** `~/Applications/Forge.app` for the client and `Forge Desktop Operator.app` as the separate development tool. Archived historical WebKit storage snapshots and duplicate test apps were removed after native rendering recovered with the original Bundle ID. The installed client's current native app must still be smoke-tested for new source changes before claiming a new preview release.

### First-record selection in project assets

With A+C's split Work/Requirement/Plan layout, a populated left list and an empty right pane wastes most of the viewport. The first available record is now selected automatically **once** when opening a populated page. An explicit cross-page deep link takes precedence. In the Work index this selects the row **without** triggering Work navigation; Requirement/Plan load the one canonical detail through the existing IPC only in the native app. Browser preview continues using the known Work relations without any native commands. No new selected-record store or API authority was introduced.
