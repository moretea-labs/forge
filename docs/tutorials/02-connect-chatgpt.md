# Tutorial 2: Connect ChatGPT

This tutorial connects ChatGPT as the external controller for Forge. Forge stays local and loopback-bound; ChatGPT reaches it through either OpenAI Secure MCP Tunnel or an explicitly chosen HTTPS tunnel.

## 1. Check ChatGPT availability first

ChatGPT MCP availability is controlled by your ChatGPT plan/workspace and can change independently of Forge. Check OpenAI's current [Developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-apps-and-full-mcp-connectors-in-chatgpt-beta) documentation before setup.

At the time this guide was updated, full MCP including write/modify actions is a beta capability for ChatGPT Business, Enterprise, and Edu on web. Pro supports developer-mode MCP with read/fetch scope rather than full write MCP. Workspace administrators may also need to enable developer mode/RBAC.

Forge does not bypass those product permissions.

## 2. Let Forge prepare the local side

Start or resume the user-level setup flow:

```bash
forge setup configure --controller chatgpt --tunnel auto
forge setup next
```

Follow the single `Next` action until the local Package Runtime is ready. The normal user path uses:

```bash
forge mcp setup chatgpt --user-level
forge runtime service install-package
```

The MCP listener remains loopback-only, normally:

```text
http://127.0.0.1:8765/mcp
```

Fresh user-level setup keeps the repository-centric Utility Console disabled until you configure a repository/workbench target. When enabled later it uses a separate loopback port (normally `8766`). **Never expose the Utility Console to the internet.**

A repository is not required to connect ChatGPT. Add repositories, folders, browser capabilities, and service plugins later as needed.

## 3. Choose the remote connection

Run `forge setup next`. Forge supports these connection providers:

### A. OpenAI Secure MCP Tunnel — preferred when available

Secure MCP Tunnel lets an OpenAI-hosted product reach the local MCP server through an outbound tunnel, without creating public inbound access. `--tunnel auto` treats this as the first-choice ChatGPT transport and does not silently choose Cloudflare/Tailscale merely because those CLIs are installed. See OpenAI's [Secure MCP Tunnel guide](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels) and the official [`openai/tunnel-client`](https://github.com/openai/tunnel-client).

You need a tunnel ID and tunnel-use permission from OpenAI Platform. Record only the non-secret tunnel ID in Forge:

```bash
forge setup configure \
  --controller chatgpt \
  --tunnel openai \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef
forge setup next
```

Forge never asks for or stores the tunnel runtime API key. Keep it in the environment used by the official tunnel client:

```bash
export CONTROL_PLANE_API_KEY='...'
```

When `tunnel-client` is installed, setup guides the official supervised runtime path. Conceptually it is:

```bash
tunnel-client runtimes connect \
  --alias forge \
  --tunnel-id tunnel_0123456789abcdef0123456789abcdef \
  --runtime-api-key env:CONTROL_PLANE_API_KEY \
  --mcp-server-url http://127.0.0.1:8767/mcp

tunnel-client runtimes status forge --json
```

Forge reports this provider ready only when `tunnel-client` reports the managed runtime as running, healthy, and ready.

#### What address changes?

With Secure Tunnel there is no public Forge `/mcp` address to paste. The ChatGPT App selects the `tunnel_id`; `tunnel-client` forwards commands to Forge's **loopback OAuth Gateway** (default `127.0.0.1:8767/mcp`), which proxies to the internal bearer-only Runtime (default `127.0.0.1:8765/mcp`). If you customize ports, use the OAuth endpoint printed by `forge mcp setup chatgpt --user-level`.

The App/connector identity and Forge tool schema are separate from the transport. Switching from Cloudflare/HTTPS to Secure Tunnel changes the network path, not the 19-tool Forge schema. A fresh chat is useful for isolated A/B testing, but it is not required merely because transport changed when the same App is already connected.

### B. Cloudflare Tunnel

Choose this when you need a stable public HTTPS endpoint and control the Cloudflare account/domain:

```bash
forge setup configure --controller chatgpt --tunnel cloudflare
forge setup next
```

Setup detects `cloudflared` and the current platform. On macOS it can suggest Homebrew when present; Linux/WSL2 and Windows receive their platform-specific official installation path. After creating a stable named tunnel, record only the resulting `/mcp` URL:

```bash
forge setup configure \
  --controller chatgpt \
  --tunnel existing \
  --endpoint https://forge.example.com/mcp
```

### C. Tailscale Funnel

If you already use Tailscale, choose:

```bash
forge setup configure --controller chatgpt --tunnel tailscale
forge setup next
```

Forge detects the Tailscale CLI and guides Funnel setup for the current platform. Record the final HTTPS `/mcp` URL when available.

### D. Existing HTTPS endpoint or defer

```bash
forge setup configure \
  --controller chatgpt \
  --tunnel existing \
  --endpoint https://forge.example.com/mcp

# Or keep local setup only for now:
forge setup configure --controller chatgpt --tunnel none
```

Cloudflare/Tailscale/existing HTTPS make the MCP endpoint public or internet-reachable by design. OpenAI Secure MCP Tunnel is the private-outbound option when your OpenAI organization supports it.

## 4. Create the ChatGPT app/connector

The ChatGPT UI changes over time, so follow the current OpenAI developer-mode instructions rather than relying on screenshots in this repository.

For a Secure MCP Tunnel connection, choose the **Tunnel** connection type, select/paste the tunnel ID, and choose **No authentication**: the authenticated OpenAI Tunnel is the external authorization boundary. For an HTTPS connection, use the stable HTTPS URL ending in `/mcp` and the OAuth flow generated by Forge.

After creating the app/connector, scan/refresh tools. Do not switch Forge to an exhaustive compatibility toolset simply to expose more names; the bounded default surface is intentional.

## 5. Verify a real Forge call

Start with a read-only prompt:

```text
Use Forge. Call rh_status and tell me whether the Forge Runtime is ready.
Do not modify anything yet.
```

Then, after granting a repository or local folder, verify bounded context/read access. A successful setup means ChatGPT actually made a Forge tool call; a saved tunnel ID or a running local process alone is not proof of end-to-end connectivity.

## 6. Security rules

- Keep Forge MCP and the Utility Console bound to loopback.
- Prefer Secure MCP Tunnel when private outbound connectivity is available and appropriate.
- If using a public HTTPS tunnel, expose only MCP—not the local Utility Console.
- Never paste MCP tokens, OAuth secrets, tunnel runtime API keys, or admin keys into chat or Forge setup state.
- Remote Git, GitHub, email, destructive cleanup, publication, and secret access remain separately authorized by Forge.
- Codex/Claude are not installed or enabled unless you explicitly configure them as controller/execution entries.

Continue with [Tutorial 3: First Repository Task](03-first-repository-task.md) when you want software-work capabilities. Use [Troubleshooting](../operations/troubleshooting.md) when the Runtime, tunnel, connector, or tool surface is not healthy.
