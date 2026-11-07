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
