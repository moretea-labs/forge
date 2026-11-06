# Forge Desktop (macOS)

Forge Desktop is a local Agent client for registered Forge repositories, checkouts and existing Requirement / Plan / Work. The Client does not own or replace the Forge Runtime.

## Development

From the repository root:

```sh
npm run dev --prefix apps/desktop
npm run test:ui --prefix apps/desktop
npm run check --prefix apps/desktop
```

## Build a local macOS app candidate

```sh
npm run bundle:mac:local --prefix apps/desktop
```

Output: `apps/desktop/src-tauri/target/release/bundle/macos/Forge.app`.

This builds the frontend and Rust release executable, enables Tauri packaging **only for this explicit command**, creates the native app bundle, ad-hoc signs it for local Mac testing, and verifies the signature. It does **not** install or switch Forge Runtime or register a background Agent. The normal `tauri.conf.json` keeps bundling disabled; project development and Windows checks are unchanged.

**Not a public release:** ad-hoc signatures have no Developer ID, notarization or distribution trust. A releasable macOS installer requires signed/notarized packaging and final native GUI interaction verification. The app requires the existing Forge Runtime for repository and Codex MCP capabilities. Code in this checkout is not automatically deployed to the currently running (frozen) Runtime; a matching approved Runtime release is required before end-to-end production acceptance.

## Acceptance requirements

1. Source contract, desktop UI, native Rust tests, TypeScript/Vite/Cargo and repository CI all pass.
2. New and resumed Codex turns work against real registered Forge repositories through the actual local-conversation module, including read-only Forge MCP retrieval.
3. Two project-bound conversations can proceed without cross-thread transcript, cancel or draft leaks, and Forge checkout/resource locks remain the writer authority.
4. On an unlocked Mac console, verify the bundled app's sidebar and settings/MCP screens, project and Work selection, input keyboard/IME, send/cancel, resize and Git review interactions.
5. Validate the approved running Runtime against this candidate and sign/notarize any installer meant for distribution.

Do not mark a candidate ready merely because its source CI and local ad-hoc packaging pass.
