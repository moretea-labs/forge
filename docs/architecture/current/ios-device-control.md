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
  +-- input backend (preferred next layer)
  |    +-- CoreDevice / RemoteXPC HID when bound
  |    `-- Xcode Device Hub + Mac control as official host-side fallback
  |
  `-- agent-device XCTest provider (explicit semantic fallback)
       +-- accessibility snapshot
       +-- semantic target resolution
       +-- semantic fill / press / waits
       `-- one stable per-physical-device runtime state
```

## Hard invariants

1. `physical_device_status`, `physical_device_list`, `physical_device_info`, `physical_device_apps`, `physical_device_open`, `physical_device_screenshot`, `physical_device_events`, and `physical_device_close` do not build, install, probe, attach, or stop XCTest/WDA.
2. The CoreDevice physical provider does not own a Runner HTTP endpoint. The old `FORGE_IOS_DEVICE_RUNNER_URL` integration and duplicate physical WDA actions are removed.
3. XCTest is opt-in because only explicit `agent_device_*` actions enter that provider. `agent_device_prepare` is the recommended proactive warm/sign/install action; if an explicitly chosen semantic session finds its stable cache absent or invalid, the underlying agent-device provider may still rebuild/start its Runner.
4. Physical `agent-device` state is keyed by stable provider device identity, not logical interaction id. Repeated interactions on the same iPhone therefore reuse one daemon/Runner cache and lease domain. Simulator state remains interaction-isolated.
5. Visual truth comes from CoreDevice screenshot/display state. Accessibility evidence is an optional semantic enhancement and is not a prerequisite for default physical-device observation or workflow verification.
6. Device mutations remain fenced by the shared `ios-device` interaction ownership domain so CoreDevice and XCTest cannot concurrently claim the same physical target.

## Why CoreDevice is the default

Xcode 27 exposes the current device-management substrate through `devicectl` and Device Hub. The attached iPhone advertises Application Control, Capture Screenshot, Get Display Information, Get Lock State, View Device Screen, HID Digitizer, HID Keyboard, HID Scroll, HID Button, and Universal HID capabilities. Forge now reports those facts instead of inferring that physical screenshots/input require XCTest.

`devicectl` remains the supported scripting surface for lifecycle and observation. The public CLI does not currently expose a general tap/type command despite the device advertising HID features, so Forge does not pretend those actions are implemented by CoreDevice yet.

## Input strategy

The next input backend should use the same long-lived device identity and must not recreate a transport per gesture.

Preferred order:

1. Bind RemoteXPC/CoreDevice HID behind the physical provider after a bounded compatibility prototype on the active Xcode/iOS pair.
2. Xcode Device Hub is the official host-side live screen/input fallback for human/debug use. Forge Desktop Operator can discover and invoke Device Hub UI, but its current background-AX contract does not expose the foreground pointer mapping needed to treat the phone canvas as a production automated input backend.
3. Use `agent-device` only when semantic accessibility inspection materially improves reliability.

A third independent physical-iPhone provider should not be added. Input backends belong behind the existing physical-device facade or as an explicitly composed host-control fallback.

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
- no `agent-device`, `XCTRunner`, WebDriverAgent, or XCTest `xcodebuild` process was created by the workflow;
- no new Runner app appeared on the device;
- interaction ownership was released cleanly.

For semantic fallback, additionally prove that repeated interactions resolve to one stable per-device runtime state. Prefer an explicit `agent_device_prepare` to warm/provision the fallback once; do not claim that an explicitly chosen `agent_device_open` can never rebuild a missing or invalid Runner cache.
