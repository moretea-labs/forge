# Forge — local-first ChatGPT MCP action runtime

Forge connects ChatGPT (or another selected external MCP controller) to permission-scoped operations on your computer, code repositories, browser, and connected services. **ChatGPT decides; Forge executes, persists, and verifies.** Forge is not an internal AI coding model and does not require a separate OpenAI API key when using ChatGPT as the controller.

## Install and connect

Requires Node.js 20.10+ and npm (or Bun).

```bash
npm install -g @moretea-labs/forge@latest
forge --version
forge setup
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

Supported hosts: macOS and modern Linux; use WSL2 for the recommended Windows path. Native Windows is a preview with a limited portable Runtime scope. Git is needed only for repository development features.

## Learn more

- See [README.md](README.md) for the maintained English product overview, capability descriptions, and security model.
- [Installation and setup](docs/tutorials/01-install-and-start.md)
- [Connect ChatGPT over MCP](docs/tutorials/02-connect-chatgpt.md)
- [Features and providers](docs/operations/features.md)
- [Docs](docs/README.md) · [GitHub Wiki](https://github.com/moretea-labs/forge/wiki)
- [Latest stable release (v1.8.1)](https://github.com/moretea-labs/forge/releases/tag/v1.8.1) · [npm package](https://www.npmjs.com/package/@moretea-labs/forge)
