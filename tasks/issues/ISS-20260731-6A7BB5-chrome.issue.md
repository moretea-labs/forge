---
id: "ISS-20260731-6A7BB5"
kind: "feature"
status: "review"
updated_at: "2026-08-02T06:24:00.833Z"
source: "repo-harness-controller-v8"
---

# 让浏览器操作复用用户当前 Chrome

用户 Chrome 默认路由、真实窗口与标签页发现、已有标签复用、新标签打开以及 native/DOM 能力区分已经实现。当前只剩最终基线验证和需求验收；底层 CDP 连接能力已由 ISS-20260731-0A6D9E 完成。

## Goals

- Add a macOS User Chrome mode that discovers the real running Chrome, windows, profiles, active tab, and bounded tab inventory.
- Default browser routing to the user's active Chrome before CDP test instances or managed persistent profiles.
- Reuse/focus a matching existing tab and open a new tab in the user's current Chrome when no match exists.
- Distinguish native window/tab control from DOM-capable CDP or extension control in every result.
- Do not silently launch or fall back to an independent browser; require explicit configured fallback and report it prominently.
- Provide an upgrade path for deep DOM interaction through a trusted extension/native-messaging bridge without exposing cookies or credentials.
- Prove behavior against the currently logged-in App Store Connect tab.

## Non-goals

- Bypass Chrome security controls or attach Playwright to a normal Chrome process without a supported control channel.
- Extract cookies, passwords, tokens, storage, or credential material.
- Perform App Store Connect mutations during validation.
- Support every browser or operating system in the first implementation.

## Acceptance Criteria

- [ ] With a normal user Chrome running and no CDP port, Browser status identifies that Chrome and reports native_tab_control instead of claiming Playwright attach.
- [ ] An existing App Store Connect tab is discovered and focused/reused without opening an independent Chrome.
- [ ] When no URL/title match exists, a new tab is opened in the user's current Chrome window.
- [ ] The default policy does not silently fall back to managed_persistent; fallback requires explicit configuration and is visible in the result.
- [ ] DOM-requiring actions fail closed with a precise capability requirement when only native tab control is available.
- [ ] Existing attach_preferred, managed_persistent, isolated, session persistence, and allowed-domain safety remain compatible.
- [ ] Focused tests, typecheck, runtime architecture, and controller-v8 pass.

## GitHub

- Not published.

## Tasks

### T1 — Implement User Chrome default routing and truthful native tab control

- Status: `verifying`
- Objective: Inspect the current Browser plugin and add a macOS user_chrome_preferred/default routing layer. Discover the real user Chrome through bounded native automation, inventory windows/tabs without page contents or secrets, deterministically reuse/focus matching tabs, open a new tab in the active user window when no match exists, and persist only bounded tab metadata. Treat native tab control as distinct from DOM automation. DOM/read/write actions must use an explicit supported control channel (CDP or trusted extension bridge) or fail closed with structured guidance. Do not silently fall back to managed_persistent; introduce an explicit fallback policy and visible routing diagnostics. Preserve existing CDP attach, persistent profile and isolated behavior. Add tests and live App Store Connect proof.
- Depends on: none
- Allowed paths: `src/runtime/plugins/**`, `src/plugins/browser/**`, `tests/runtime/browser-plugin.test.ts`, `tests/runtime/**`, `scripts/**`, `docs/operations/controller-browser-plugin.md`, `docs/architecture/current/human-interaction-plane.md`, `tasks/issues/**`, `package.json`
- Checks: `package:check:type`, `package:check:runtime-architecture`, `package:check:controller-v8`
- Execution hint: selected at runtime

## Related Artifacts

- `ISS-20260731-0A6D9E`
- `current implementation on main`
- `final review required`
