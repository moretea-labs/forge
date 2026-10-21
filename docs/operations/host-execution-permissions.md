# Ordinary host command execution

Forge uses one host AI permission decision. When the local owner explicitly
enables Full Access in the existing Forge settings, the authenticated
execute_command(scope=host) route accepts ordinary host commands. No second
expiring process:exec Grant, per-command Forge confirmation or self-issued
MCP Grant is created.

- The request requires an authenticated principal and an existing exact
  ForgeInstance identity on the executing machine.
- A legacy/default permission that happens to project full_access is not an
  explicit opt-in. Request mode does not authorize host execution.
- Tool calls remain governed by the host AI platform's normal permissions,
  Process Runtime command lifecycle, audit and result redaction.
- Credential access, Keychain, OS-protected actions, console unlock and
  destructive operations retain their separate system and typed-capability
  protections; raw host-command capability does not assert successful
  credential or unlock authorization.
- Different Mac/WSL instances keep independent local identity and settings.

Standing authorizations for credential and device workflows belong to
existing Forge Requirement req-credential-standing-grants-20261016 / GitHub
#288; secret-safe authenticated HTTP belongs to #172.
