# Forge App Store Connect Integration

Forge exposes App Store Connect as an optional first-party provider behind the stable plugin policy, Process Runtime, receipt, and audit boundaries. Credentials remain external to repository state. Remote mutations require explicit authorization and idempotent provider evidence.

See [Plugin management](forge-plugin-management.md) and [Verification and Release Gates](architecture/CURRENT.md).

## Screenshot processing

`upload_app_screenshot` verifies the exact App, editable iOS version, localization and display set, then confirms the committed screenshot checksum through the official API. It observes the same screenshot ID for up to 45 seconds. `processingComplete: true` requires `COMPLETE`; `processingComplete: false` means the committed asset remains in `UPLOAD_COMPLETE`. Use `list_app_screenshots` to observe that asset before claiming storefront acceptance.

A failed state, mismatched checksum, ambiguous filename or unresolved commit is an explicit error. Do not reserve a replacement or resend bytes to resolve it. Repeating an upload whose checksum is already committed resumes processing observation. Screenshot reordering accepts only the exact existing set of completed assets.
