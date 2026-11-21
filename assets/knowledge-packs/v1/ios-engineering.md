# Forge iOS Engineering · First-party knowledge v1

**Scope:** Generic iOS, SwiftUI, Xcode and device engineering method. This is an advisory Forge Context/Cognitive pack, not an alternative design system, provider, workflow, signing authority, release approval, or device owner. The latest user decision and each project's `AGENTS.md`, `DESIGN.md`, source, release baseline and product Issue take precedence.

## Source and flow before implementation

1. Establish the exact repository, checkout, target, configuration, Bundle ID, signing method, deployment target, SDK and affected feature. Inspect the actual code and current Git status; do not assume a previous branch or simulator screenshot represents the current build.
2. Define the user journey, source-of-truth model, state changes and failure states before editing. Keep SwiftUI views declarative and cohesive; put persistence and domain transitions behind explicit owners. Prefer value types, explicit absence/failure, actor isolation and Sendable over force unwraps, casts or suppressed concurrency diagnostics.
3. Honor the project's approved screen composition, navigation hierarchy, design tokens, dynamic type, VoiceOver/focus order, localizations and safe-area contracts. Do not change frozen layout, section ownership or action visibility without new explicit user authorization. A generic visual change cannot override a product-specific acceptance decision.
4. For alignment distinguish the **glyph**, visible control surface, hit area and native container spacing. Optical centering is not proof of equal coordinates, and geometric centering is not proof of optical centering. Reinspect actual pixels after changing SF Symbol size, stroke, weight or offset.

## Verify at the correct level

- Start with the smallest relevant code/parser, localization, accessibility and behavior tests; run an Xcode build for the precise scheme/target/device configuration next. A Swift parse pass is not a full build. Simulator build is not a physical-device build. Both may pass without a viable installation.
- Report separate outcomes for **compiled**, **signed**, **installed**, **launched**, **foreground observed**, **interaction verified** and **visually reviewed**. A successful process invocation or device-list entry proves none of the later stages by itself.
- A device install or CoreDevice launch receipt is not evidence that the intended app is currently foreground. Inspect a fresh screenshot, confirm exact app identity, and only then act. The model must see the relevant image before accepting its visual quality; a file path, checksum, bounding box or successful test does not substitute for pixel review.
- For consequential UI work review representative list/detail/edit/empty/long-text/error states as relevant, and confirm visual weight, optical alignment, truncation, keyboard/safe area, transitions and touch/AX targets. Preserve state across tab changes and return navigation. Verify effects in the actual simulator or phone when available.
- Only one actor may own live physical-iPhone mutations at a time. Do not race CoreDevice, HID, XCTest or WDA on the same phone, replay an action whose outcome is uncertain, or use a fresh observation ID as implicit foreground authorization. After post-action screenshot failure, acquire a fresh observation rather than repeating the input.
- Keep local Beta and released app identities distinct. Confirm Bundle ID, signing and device before installing, and do not overwrite production apps or user data without authorization. Builds, device installation, TestFlight upload, App Store submission and publication are different effects with separate permissions.

## Evidence and handoff

Report exact checkout/commit, scheme, SDK/configuration, Bundle ID, device, checks and their observed status. Mark unknown or unrun checks `NOT RUN`; a screenshot capture is `Captured`, not necessarily `Model Visible`, `Visual Reviewed` or human-accepted. Do not silently convert source build, device readiness or screenshot existence into a successful product-journey receipt.

For real-device operation use the existing Forge `ios-development` and `computer` capabilities and their current explicit authorization contracts. Do not create a second iOS provider, lock, data store, design plugin dependency or long-running transport. Exact physical-device ownership and live foreground checks are mechanically enforced by the current owner.

## Provenance and authority

This is a semantic extraction from:
- `moretea-labs/forge:docs/architecture/CURRENT.md` (Swift architecture, state and concurrency rules)
- `moretea-labs/forge:docs/forge-ios-development-assistant.md` (development, simulator/physical-device evidence, safe input, explicit permissions)
- `moretea-labs/forge:docs/architecture/decisions/20260904-ios-device-migration-baseline.md` (one physical-device owner, Xcode vs device responsibilities, observe/confirm/act boundaries)
- `moretea-labs/forge:assets/knowledge-packs/v1/design-ui-ux.md` (visual methodology and optical centering)

The project repository remains authoritative for its actual technical configuration and approved design. Update this single Forge-owned iOS method instead of reintroducing another cross-project iOS Skill/Plugin rule. The sibling manifest pins its SHA-256 content digest.
