# Forge Client credential authorization — 2026-11-08

## Scope

This snapshot records the authority boundaries used by the macOS Forge Client after removing per-turn external-provider write approval and adding managed generic API credentials.

## Authorities

### Repository writes

Ordinary repository-local effects use the existing Repository AccessPolicy only.

- `request`: external providers are read-only.
- `full_access`: ordinary repository-local write tools are available for the exact bound repository/checkout and remain available until the repository policy changes.
- The conversation does not persist a second authorization Boolean.
- A caller-provided `allowEffects` value is not an authorization source.
- Remote-write, destructive and credential boundaries remain separately gated.

### Credential material

Credential bytes have exactly one secret owner.

- JoyCode: installed JoyCode.app login/session/signing material.
- Codex: existing Codex CLI login.
- zro/DeepSeek: existing zro local credential store.
- Forge-managed generic API credentials: macOS Keychain service keyed by opaque `credentialRef`.

Forge's credential registry contains metadata only: opaque reference, label, endpoint and timestamps. It never contains the secret.

### Credential use authorization

Use of a Forge-managed generic API credential is authorized by canonical Identity `AuthorizationGrant`.

- capability: `credential:use`
- target: exact credential ref
- constraint: exact provider + endpoint
- reusable until expiry or revocation
- no second approval database or client-owned grant state
- `rh_credential` exposes only status/authorize/revoke metadata and never secret material

Provider execution resolves:

`credentialRef -> exact active AuthorizationGrant -> macOS Keychain -> provider request`

Raw secret material is not returned through MCP, the native bridge, conversation history, Requirement/Plan, Controller records, or provider configuration JSON.

## Create and rotate

Forge-managed generic API credentials are imported from the macOS clipboard because third-party API credentials must be issued by their provider; Forge does not fabricate externally valid keys.

Create and rotate:

1. read the clipboard inside the Desktop execution boundary;
2. validate and write the secret to Keychain;
3. clear the clipboard;
4. persist or update metadata only;
5. create can immediately enroll credential-use authorization from the native product.

Clipboard clearing is attempted even when Keychain mutation fails. Create removes a partially written Keychain item if clearing fails. Rotate restores the previous Keychain value if clipboard clearing or metadata persistence fails.

## UI ownership

The installed SwiftUI product owns credential-management interaction:

- import from clipboard + authorize
- rotate from clipboard
- authorize/revoke use
- delete

The React surface is development/design support and does not accept raw API keys.

## Non-goals

This does not create a generic secret platform, second credential store, provider fallback matrix, new daemon, Work lifecycle, repository progress authority, or model-visible raw-secret tool.
