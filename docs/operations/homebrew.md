# Homebrew distribution plan

Homebrew is planned as a convenience layer after the first stable npm/GitHub release is published and verified. It is not a separate implementation or version line.

## Gate before creating a tap

Do not publish a formula until all of the following are true:

- `@moretea-labs/forge@1.7.1` exists on npm;
- Git tag and GitHub Release `v1.7.1` exist and point to the tested commit;
- the npm tarball has an immutable checksum;
- macOS installation and `forge --version` / `forge doctor` tests pass;
- upgrade and uninstall behavior is documented.

## Recommended first channel

Create a third-party tap such as `moretea-labs/homebrew-tap`, then install with:

```bash
brew tap moretea-labs/tap
brew install forge
```

The formula should depend on a supported Node version and install the scoped npm tarball with Homebrew's npm helper arguments. It must include a test that runs the installed CLI. Formula updates must be generated from the stable package version and verified SHA-256, never from a moving branch or `latest` URL.

Submitting to Homebrew/core should be considered only after the project has a sustained stable release history and meets Homebrew's acceptance expectations.
