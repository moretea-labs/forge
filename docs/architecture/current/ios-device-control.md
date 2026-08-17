# iOS Physical Device Control

Status: current architecture (2026-08-17)

## Goal

Forge must be able to operate one exact paired physical iPhone without creating a new XCTest Runner for ordinary device operations. The default path must stay usable when an app has a large, slow, incomplete, or custom accessibility tree.

## Provider split

```text
Forge iOS plugin
  |
  +-- CoreDevice physical provider (default)
  |    +-- discover / connection state
  |    +-- app inventory
  |    +-- app launch
  |    +-- lock state / display metadata
  |    +-- screenshot / visual evidence
  |    +-- View Device Screen URL / HID capability discovery
  |
  +-- RemoteXPC HID input backend (default physical input)
  |    +-- reuse macOS/CoreDevice trusted RSD tunnel
  |    +-- one long-lived worker per physical device
  |    +-- tap / swipe / bounded ASCII keyboard input
  |    `-- Xcode Device Hub remains a human/debug fallback
  |
  `-- agent-device XCTest provider (explicit semantic fallback)
       +-- accessibility snapshot
       +-- semantic target resolution
       +-- semantic fill / press / waits
       `-- one stable per-physical-device runtime state
```

## Hard invariants

1. `physical_device_status`, `physical_device_list`, `physical_device_info`, `physical_device_apps`, `physical_device_open`, `physical_device_screenshot`, `physical_device_tap`, `physical_device_swipe`, `physical_device_type_text`, `physical_device_events`, and `physical_device_close` do not build, install, probe, attach, or stop XCTest/WDA.
2. The CoreDevice physical provider does not own a Runner HTTP endpoint. The old `FORGE_IOS_DEVICE_RUNNER_URL` integration and duplicate physical WDA actions are removed.
3. XCTest is opt-in because only explicit `agent_device_*` actions enter that provider. `agent_device_prepare` is the recommended proactive warm/sign/install action; if an explicitly chosen semantic session finds its stable cache absent or invalid, the underlying agent-device provider may still rebuild/start its Runner.
4. Physical `agent-device` state is keyed by stable provider device identity, not logical interaction id. Repeated interactions on the same iPhone therefore reuse one daemon/Runner cache and lease domain. Simulator state remains interaction-isolated.
5. Visual truth comes from CoreDevice screenshot/display state. Accessibility evidence is an optional semantic enhancement and is not a prerequisite for default physical-device observation, coordinate input, or workflow verification.
6. Physical coordinate input is expressed in current CoreDevice framebuffer pixels. The RemoteXPC worker normalizes those pixels to the HID UInt16 coordinate space and rejects off-screen coordinates instead of silently clamping them.
7. One RemoteXPC HID worker is keyed by stable CoreDevice device identity and stays warm for bounded reuse across logical interactions; a gesture must not recreate the RSD transport.
8. Device mutations remain fenced by the shared `ios-device` interaction ownership domain so CoreDevice/HID and XCTest cannot concurrently claim the same physical target.

## Why CoreDevice is the default

Xcode 27 exposes the current device-management substrate through `devicectl` and Device Hub. The attached iPhone advertises Application Control, Capture Screenshot, Get Display Information, Get Lock State, View Device Screen, HID Digitizer, HID Keyboard, HID Scroll, HID Button, and Universal HID capabilities. Forge now reports those facts instead of inferring that physical screenshots/input require XCTest.

`devicectl` remains the supported scripting surface for lifecycle and observation. The public CLI does not expose a general tap/type command despite the device advertising HID features. Forge therefore keeps lifecycle/visual truth on CoreDevice and binds input through the same trusted RemoteXPC device substrate instead of falling back to XCTest.

## Input strategy

The production input backend reuses the RSD endpoint already established by macOS `remotepairingd` for CoreDevice. Forge discovers the exact device's current trusted tunnel from the bounded unified-log evidence recommended by the upstream RemoteXPC implementation, then opens one persistent HID worker per stable CoreDevice device identity. A stale worker is discarded and the newest bounded endpoint candidates are retried; each individual gesture does not create a new tunnel.

The worker is materialized in Controller-owned runtime storage and runs from a versioned Controller-owned `pymobiledevice3` 10.2.1 toolchain. The TypeScript Runtime passes only a minimal environment (`PATH`, `HOME`, `TMPDIR`, and Python runtime flags), so unrelated Runtime credentials are not inherited by the helper process. The dependency is not vendored into Runtime source.

Current input surface:

1. `physical_device_tap`: one contact/release at a current framebuffer pixel.
2. `physical_device_swipe`: a bounded interpolated touchscreen gesture.
3. `physical_device_type_text`: bounded ASCII HID keyboard input. Arbitrary Unicode is deliberately rejected until a separately verified pasteboard/input-method transport exists on the active iOS/Xcode pair.
4. Xcode Device Hub remains a human/debug fallback. Forge Desktop Operator can discover and invoke Device Hub UI, but its background-AX contract does not make the phone canvas a production pointer backend.
5. `agent-device` remains the semantic accessibility fallback when label/ref resolution materially improves reliability.

A third independent physical-iPhone provider should not be added. Input remains behind the existing physical-device facade.

## Runner lifecycle

The previous implementation placed `AGENT_DEVICE_STATE_DIR` under each interaction id. That caused each logical physical-device interaction to own a fresh daemon/Runner cache and defeated warm reuse.

Physical-device semantic fallback now uses:

```text
controller-home/repositories/<repoId>/interactions/ios-agent-device/
  device-runtime/<stable-provider-device-id>/state
```

Logical interaction records remain separate under `.forge/interactions/ios-device`, but they no longer determine the physical Runner runtime directory. `agent_device_prepare` and subsequent physical semantic sessions resolve to the same per-device runtime.

## Verification contract

For the default physical path, a successful workflow should prove all of the following:

- exact device selected;
- exact bundle identifier installed;
- app launched via CoreDevice;
- screenshot produced via CoreDevice;
- physical tap/swipe uses RemoteXPC HID against the current CoreDevice display geometry;
- repeated input in one warm period reuses the same per-device worker;
- no `agent-device`, `XCTRunner`, WebDriverAgent, or XCTest `xcodebuild` process was created by the workflow;
- no new Runner app appeared on the device;
- interaction ownership was released cleanly.

For semantic fallback, additionally prove that repeated interactions resolve to one stable per-device runtime state. Prefer an explicit `agent_device_prepare` to warm/provision the fallback once; do not claim that an explicitly chosen `agent_device_open` can never rebuild a missing or invalid Runner cache.
