# iOS physical-device migration baseline

Status: accepted migration baseline
Date: 2026-09-04
Issue: #47 / T9

This decision freezes the ownership map for migrating the current in-process physical-iPhone implementation to one independently operated `ios-device` provider service. It does **not** define a second plugin protocol. The generic Forge plugin/action/registration contracts remain authoritative.

## Authority dependency

This migration consumes the existing generic plugin architecture instead of copying it:

- Forge plugin/action semantics and authorization use `src/runtime/plugins/types.ts` and the normal plugin store;
- an independently installed provider is addressed through the existing `ExternalPluginRegistration` / external-adapter boundary;
- provider transport, lifecycle, capability negotiation, protocol version fencing and registration revisioning stay generic plugin concerns;
- legacy MCP names may translate into canonical typed iOS actions, but the translation is never runtime or device authority.

The issue's historical `ISS-20260802-3EC105` protocol decision is therefore satisfied by the current generic plugin implementation. This document records only iOS ownership and migration choices.

## Product and process boundaries

### `ios-development`

`ios-development` is repository-development tooling owned by the Forge Runtime release. It includes Xcode/toolchain status, project/scheme discovery, build/test, Simulator lifecycle/screenshot, smoke review and the Xcode-facing App Store Connect authentication reference. Its current implementation is composed by `src/runtime/plugins/ios-adapter.ts` over `src/runtime/safe-tooling/ios-development.ts`.

It may start bounded build/test/simulator child processes. It does not own a physical phone, a WDA session, a CoreDevice trusted tunnel, or a durable physical-device interaction.

### `ios-device`

`ios-device` is the one physical-device resource domain. The exact paired phone is the resource identity; CoreDevice identifiers, hardware UDID and reviewed provider aliases may all name that same resource. `InteractionSessionRecord.provider = "ios-device"` is the shared ownership domain and `engine = "coredevice" | "agent-device"` selects an implementation engine inside that domain, not another owner.

The target migration has one independently operated `ios-device` provider process for physical-device transport/runtime work. That provider may host CoreDevice, RemoteXPC/HID and agent-device/WDA engines, but those engines must serialize against the same exact-phone ownership fence. Forge remains the semantic/controller side and must not run a competing long-lived physical-device owner after cutover.

The provider release is independently versioned from the Forge Runtime release and is selected/verified through the generic external-plugin registration boundary. Forge release activation must not silently replace provider device state.

## State and resource ownership

| Concern | Sole owner after migration | Boundary |
| --- | --- | --- |
| Requirement/Work/controller authority | Forge Controller | Never exported to `ios-device`. |
| Physical-phone ownership and live backend handles | `ios-device` provider | One exact phone, one mutation owner across CoreDevice and agent-device engines. |
| Durable semantic InteractionSession identity | Forge iOS/Controller layer | Engine is metadata inside the one `ios-device` provider domain; provider-local session/WDA handles are not second durable authority. |
| CoreDevice discovery, trusted tunnel and RemoteXPC/HID transport | `ios-device` provider | No parallel Forge-side tunnel owner after cutover. |
| agent-device/WDA process/session runtime | `ios-device` provider | Capability/version contract is reviewed and fail-closed. |
| WDA signing execution and provider runtime signing state | `ios-device` provider | Forge may pass bounded non-secret configuration/reference; signing runtime state is not mirrored into a second owner. |
| App-specific semantic locators and assertions | Forge app adapters | Provider receives semantic/typed operations and returns observations; transport code does not learn JD or other app business semantics. |
| Bounded/redacted acceptance evidence | Forge | Provider observations are evidence inputs, not semantic acceptance authority. |
| Xcode build/test/simulator state | `ios-development` in Forge | Separate from physical-device ownership. |
| App Store Connect account/release actions | App Store Connect adapter | Separate remote-account authority; not part of `ios-device`. |

`interactionMayOwnTarget()` and the target-alias rules are the current migration fence: old records that cannot prove they refer to a different phone fail closed rather than allowing CoreDevice and agent-device to acquire the same device concurrently.

## Existing module migration map

`KEEP` means the responsibility stays in Forge. `MOVE` means the responsibility belongs in the independent `ios-device` provider. `REWRITE` means the current in-process module is useful evidence/behavior but is not itself the final service boundary. `DELETE` is conditional on the stated removal criterion.

| Current path / responsibility | Decision | Target owner and rationale |
| --- | --- | --- |
| `src/runtime/plugins/ios-adapter.ts` | KEEP, then shrink | Keep the public Forge iOS composition facade and `ios-development` actions. Physical-device actions become provider-backed composition after T10 rather than a second in-process backend. |
| `src/runtime/safe-tooling/ios-development.ts` | KEEP | Repository/Xcode/Simulator development tooling remains Forge-owned. |
| `src/runtime/plugins/interaction-session.ts` | KEEP | Forge keeps durable semantic interaction identity and exact target/alias fencing. `engine` remains implementation metadata, never separate device ownership. |
| `src/runtime/plugins/ios-agent-device.ts` | MOVE + REWRITE | Move physical agent-device/WDA lifecycle, command execution, signing runtime and provider session handling behind the `ios-device` service. Preserve reviewed behavior, not the current monolithic in-process shape. |
| `src/runtime/plugins/ios/agent-device-capabilities.ts` | MOVE | Provider-side version/help negotiation and contract fingerprinting belong next to the executable being negotiated. Forge consumes the declared capability result. |
| `src/runtime/plugins/ios/agent-device-failures.ts` | MOVE, preserve semantics | Transport/session failure classification must be owned with the provider lifecycle. Preserve the semantic-vs-session-death distinction and unknown-outcome fencing. |
| `src/runtime/plugins/ios/agent-device-provider.ts` | MOVE | This is already a provider abstraction; it becomes part of the service-side backend contract rather than a competing Forge device owner. |
| `src/runtime/plugins/ios/agent-device-typed-provider.ts` | MOVE | Typed agent-device client loading/execution belongs in the service process. |
| `src/runtime/plugins/ios-physical-device.ts` | MOVE + REWRITE | CoreDevice physical-phone discovery, launch/install, screenshot and device/session mechanics move behind `ios-device`. Forge retains only canonical action semantics/authorization and normalized evidence. |
| `src/runtime/plugins/ios/remote-xpc-hid.ts` | MOVE | Trusted-tunnel discovery, RemoteXPC keyboard/pasteboard/HID and coordinate transport are provider mechanics tied to the live phone. |
| `src/runtime/plugins/ios/app-adapters.ts` including JD | KEEP | App-specific semantics remain Forge-owned. JD search/navigation selectors and assertions must not move into transport/service code. |
| `src/runtime/plugins/app-store-connect-adapter.ts` | KEEP, separate | Store/account release API authority is unrelated to physical-device transport. |
| `adapters/mcp/runtime-gateway/legacy-ios-tool-adapter.ts` | KEEP temporarily, then DELETE | This is the **only** migration proxy for legacy iOS MCP names. It translates to canonical plugin actions and owns no execution/device state. Remove when no exposed legacy iOS tool/caller depends on it. |
| current iOS physical-device regression tests | REWRITE/SPLIT | Keep Forge tests for semantic action, authorization, interaction ownership and evidence; move provider lifecycle/transport/WDA/CoreDevice contract tests with the service. Cross-boundary integration tests verify one owner, not two implementations. |

## Signing, WDA and CoreDevice rules

1. WDA signing is provider execution state. Team/bundle/signing configuration may be supplied through a bounded configuration/reference, but Forge and the provider must not both maintain mutable signing-session authority.
2. `agent-device` version/help detection remains capability negotiation. A preferred version is support guidance; an unsupported/unreviewed contract fails closed rather than guessing CLI flags.
3. CoreDevice trusted-tunnel/RSD discovery and RemoteXPC/HID live handles stay with the provider that owns the physical phone.
4. A semantic action failure such as element-not-found may preserve the physical session. Transport/session death invalidates the live provider binding. An unknown non-idempotent mutation outcome is fenced and is never replayed merely by switching engines.
5. A screenshot or lifecycle read is observation evidence only. It cannot be promoted into proof that a semantic mutation completed.

## App-adapter boundary

`src/runtime/plugins/ios/app-adapters.ts` is the semantic extension point. The JD adapter remains here because its bundle identity, snapshot depth, semantic targets and interaction expectations are application knowledge. The `ios-device` provider must remain app-agnostic: it owns snapshot/input/session/transport mechanics and returns typed observations.

Adding another app must therefore not require a provider-service release unless the app exposes a genuinely new transport capability.

## Single migration proxy

During migration there is exactly one compatibility translation layer: `adapters/mcp/runtime-gateway/legacy-ios-tool-adapter.ts`.

It may map a bounded legacy MCP name/argument shape to a canonical iOS plugin action. It may not:

- discover or select a device;
- own an InteractionSession;
- launch WDA/CoreDevice services;
- hold signing or tunnel state;
- perform the plugin action itself;
- introduce another approval or evidence authority.

Removal condition: once the stable MCP/tool surface and all maintained callers use canonical typed plugin actions directly, repository search and compatibility tests must show no maintained legacy iOS tool consumer. The adapter and its legacy-only tests are then deleted in the same slice.

## Migration sequence

1. **T9, this baseline:** freeze ownership and the keep/move/rewrite/delete map. No protocol redesign.
2. **T10 / #48:** establish the independent `ios-device` service using the generic plugin/provider boundary, while the legacy MCP translation remains the only proxy.
3. **T11 / #49:** move persistent device identity, provider/WDA/session/signing lifecycle behind that service while preserving Forge InteractionSession authority and one-phone fencing.
4. **T12 / #50:** move reusable semantic interaction-engine behavior without moving app semantics; JD remains a Forge app adapter.
5. **T13 / #51:** validate recovery/performance/core upgrade behavior and prove no dual owner during provider restart or engine failure.
6. **T14 / #52:** complete physical-device Debug build/install/log collection through the converged boundary.
7. Remove the compatibility proxy only after maintained legacy consumers reach zero.

## Acceptance invariants

- `ios-development` and `ios-device` have different resource/process/release authority and cannot silently acquire one another's state.
- One exact physical phone has one `ios-device` mutation owner even when multiple backend engines exist.
- Forge owns semantic app targeting, authorization, durable controller/interaction identity and acceptance evidence; provider owns live device/session/transport mechanics.
- Signing/WDA/CoreDevice tunnel state has one provider owner.
- Exactly one migration proxy exists and it is translation-only.
- The migration reuses the generic plugin registration/action protocol and introduces no iOS-specific competing protocol authority.
