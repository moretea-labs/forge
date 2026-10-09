---
layout: default
title: "Computer and Plugin Setup — macOS desktop, Browser, Design, Knowledge, Figma"
description: "Forge: local-first ChatGPT MCP for secure computer use, browser automation, coding, and developer workflows."
permalink: /Computer-and-Plugins.html
---

# Computer and Plugin Setup — macOS desktop, Browser, Design, Knowledge, Figma

Forge includes a typed **Computer** capability for local-machine tasks and a separate **Browser** capability for websites. ChatGPT (or a selected MCP client) decides actions; Forge enforces permissions and reports evidence. Installing Forge's CLI does not automatically update independently released providers.

## Quick setup on macOS

Install or upgrade the Forge CLI first:

```bash
npm install -g @moretea-labs/forge@latest
forge --version
forge setup next
```

Then install the pinned native Computer provider and verify its health:

```bash
forge computer setup
forge computer doctor
forge computer status --json
```

For an **already installed** Computer provider, run `forge computer update` to install the provider release pinned by the current Forge catalog. If no newer compatible pin exists, this does not upgrade to an arbitrary GitHub tip. Complete any macOS Accessibility / Screen Recording permission prompts that the native provider requires, then re-run `forge computer doctor`. Only macOS currently has the catalogued native Desktop Operator provider; Linux/Windows users should not run `forge computer setup` expecting macOS desktop control.

Computer's provider is **Forge Desktop Operator** (catalog tag `v0.4.5`). Computer can observe and interact with the macOS desktop, request capture and element operations, and use native console-unlock capabilities where authorized. Browser navigation/DOM and web sessions remain a separately owned Browser surface, not a second copy of Desktop Operator authority.

## Other official providers

Review available, platform-compatible pinned releases first:

```bash
forge plugin catalog
forge plugin list --refresh
```

| Plugin ID | Purpose | Pinned catalog tag | Supported installation hosts |
| --- | --- | --- | --- |
| `desktop_operator` | Native Computer provider (use `forge computer` commands) | `v0.4.5` | macOS |
| `design` | Repository-local design workspace and design artifacts | `v0.3.0` | macOS / Linux / Windows |
| `personal_knowledge` | Local personal-knowledge retrieval and safe operations | `v0.2.1` | macOS / Linux / Windows |
| `figma` | Figma plugin bridge and typed canvas operations | `v0.3.0` | macOS |

Install only what you need:

```bash
forge plugin install design
forge plugin install personal_knowledge
forge plugin install figma          # macOS; requires its Figma bridge to be running
forge plugin list --refresh
```

Re-running a provider's `forge plugin install <id>` uses the version pinned by the installed Forge catalog. Provider health can be `degraded` if the target app, local socket, native permission, browser session, or service authentication is missing. An install receipt alone is **not** proof of an operational provider. Figma and other app-specific bridges need their own app/bridge setup before typed calls become ready.

## How to use from ChatGPT

After [connecting ChatGPT to Forge MCP](https://github.com/moretea-labs/forge/blob/main/docs/tutorials/02-connect-chatgpt.md), ask for a bounded goal:

- “Inspect the currently open Chrome page, check form fields, and report what is wrong.”
- “Read the authorized Finder folder, organize the documents, and show me the result.”
- “Use Computer to observe this app and take a screenshot before changing anything.”
- “Inspect the design workspace and prepare a reviewable design artifact.”
- “Search my connected local knowledge base for the project decision.” (requires `personal_knowledge` to be ready)
- “Inspect this open Figma file and tell me which components need review.” (requires a working Figma bridge)

Each provider has its **own** authorization and readiness. Avoid assuming desktop control or website mutation is allowed solely because the MCP connector responds.

## Diagnostics

```bash
forge computer status --json
forge computer doctor
forge plugin list --refresh
forge doctor
```

If Browser readiness mentions Playwright, ensure the selected Browser attach mode and its browser dependencies are configured; native Chrome/Vivaldi attachment and managed Playwright browsing have different requirements. If Computer is not ready, resolve the reported macOS permissions/native provider state; if Figma reports a missing socket, start/configure the Figma bridge rather than repeatedly reinstalling Forge.

More detail: [Plugin Management](https://github.com/moretea-labs/forge/blob/main/docs/forge-plugin-management.md), [Browser runbook](https://github.com/moretea-labs/forge/blob/main/docs/operations/controller-browser-plugin.md), and [Security Model](Security-Model.html).
