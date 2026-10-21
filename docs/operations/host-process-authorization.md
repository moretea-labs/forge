# Authorizing ForgeInstance host commands

Host-scoped execute_command requires an exact canonical process:exec Grant.
Repository Full Access and filesystem target grants do not authorize host commands.

Run in a trusted **interactive local terminal** on the exact machine:

    forge security authorize-host-process --principal controller-http-client --minutes 15

Replace the principal with the authenticated principal from the
HOST_PROCESS_GRANT_REQUIRED denial. Review the ForgeInstance identity, principal,
scope, duration and warning. Type the exact full confirmation phrase.

The CLI refuses non-interactive execution, uses the existing machine identity,
grants only process:exec on that exact ForgeInstance with remote_write risk and
1-30 minute expiry, and does not change repository access or Runtime. All
other execution, secret-handling and host safety checks remain enforced.

No MCP/agent tool can self-approve this grant: a chat message is not the required
physical local terminal confirmation.
