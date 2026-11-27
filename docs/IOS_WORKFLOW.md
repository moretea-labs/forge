# Forge iOS development workflow

Forge owns one reusable iOS workflow engine. An app repository may add an optional
.forge/ios-workflow.json; it does not need to copy or maintain project-specific
build/install/preview scripts.

## Execution boundaries

- **Preview** (smoke_review): discover scheme, build or use a supplied app, prepare
  one Simulator, install, launch, capture a screenshot, and collect app logs.
  It never invokes xcodebuild test or XCTest.
- **Tests** (xcode_test): a separate capability. It runs only when a test action is
  explicitly requested. Its scheme, destination, selectors, and bounded parallelism
  can be configured independently.
- **Physical iPhone**: build uses the configured device UDID as an iOS destination;
  CoreDevice actions use the configured physical-device selector when device is
  omitted. Installation still requires an explicit built app_path, and app opening
  still requires an explicit bundle ID and the normal exact-device authorization.
- **No config**: Forge falls back to project discovery and its existing safe defaults.
  Explicit action arguments always override repository config.

## Example: Simulator-first app

Create .forge/ios-workflow.json in the app repository:

~~~json
{
  "schemaVersion": 1,
  "project": {
    "workspace": "App.xcworkspace",
    "scheme": "App",
    "configuration": "Debug",
    "bundleId": "com.example.app"
  },
  "preview": {
    "target": "simulator",
    "simulator": {
      "name": "iPhone 17 Pro"
    },
    "cleanupPolicy": "keep",
    "launchWaitMs": 800,
    "screenshotLabel": "development-preview"
  },
  "tests": {
    "scheme": "AppTests",
    "simulator": {
      "name": "iPhone 17 Pro"
    },
    "onlyTesting": [],
    "parallelTesting": false,
    "maxParallelTestingWorkers": 1
  }
}
~~~

## Example: physical iPhone target

Set preview.target to physical_device and provide the exact Xcode UDID.
selector may be the exact CoreDevice identifier, UDID, or paired device name.
When both are supplied, Forge verifies they resolve to the same device.

~~~json
{
  "schemaVersion": 1,
  "project": {
    "workspace": "App.xcworkspace",
    "scheme": "App",
    "configuration": "Debug",
    "bundleId": "com.example.app"
  },
  "preview": {
    "target": "physical_device",
    "physicalDevice": {
      "udid": "00008110-001234567890001E",
      "selector": "CORE-DEVICE-IDENTIFIER"
    }
  }
}
~~~

For this target, an explicit build action defaults to destination_platform=ios.
After the build, use physical_device_install with its resulting .app path, then
physical_device_open with observe_after_open=true for a fresh screenshot. These
mutating device operations retain their existing exact-device authorization; config
selects the target but never grants permission or signs/releases an app.

## Config contract

- schemaVersion must be 1; unknown keys and invalid values fail closed.
- project.workspace / project.project are repository-relative paths.
- Preview target is simulator (default) or physical_device.
- Simulator cleanup defaults to keep; Forge does not shut down a warm device merely
  because a preview completed.
- launchWaitMs is bounded from 0 to 30,000.
- XCTest defaults are separate from preview. Parallel testing defaults to false;
  worker count is bounded to 1 or 2 and has no effect unless parallel testing is
  explicitly enabled.
- Per-action arguments take precedence over config values; config takes precedence
  over automatic discovery/defaults.
