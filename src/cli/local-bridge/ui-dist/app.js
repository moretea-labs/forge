// src/cli/local-bridge/ui/api.ts
class ApiError extends Error {
  status;
  payload;
  constructor(message, status, payload) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}
async function requestJson(path, init = {}) {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type"))
    headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers, credentials: "same-origin" });
  let payload = {};
  try {
    payload = await response.json();
  } catch {}
  if (!response.ok) {
    const record = payload && typeof payload === "object" ? payload : {};
    const message = typeof record.error === "string" ? record.error : typeof record.message === "string" ? record.message : `Request failed (${response.status})`;
    throw new ApiError(message, response.status, payload);
  }
  return payload;
}
var api = {
  commandCenter: () => requestJson("/api/console/command-center"),
  work: () => requestJson("/api/console/work"),
  automations: () => requestJson("/api/console/automations"),
  automationSettings: () => requestJson("/api/console/automation-settings"),
  connector: () => requestJson("/api/console/connector/status"),
  advanced: () => requestJson("/api/console/advanced"),
  automationAction: (source, repoId, id, action) => requestJson(`/api/console/automations/${encodeURIComponent(source)}/${encodeURIComponent(repoId)}/${encodeURIComponent(id)}/${encodeURIComponent(action)}`, { method: "POST", body: "{}" }),
  providerAction: (id, action) => requestJson(`/api/console/providers/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" }),
  providerHealth: (id) => requestJson("/api/console/providers/health", { method: "POST", body: JSON.stringify({ providerId: id }) }),
  localToolAction: (id, action) => requestJson(`/api/console/local-tools/${encodeURIComponent(id)}/${action}`, { method: "POST", body: "{}" }),
  localToolHealth: (id) => requestJson("/api/console/local-tools/health", { method: "POST", body: JSON.stringify({ toolId: id }) }),
  registerRepository: (path, displayName) => requestJson("/api/repositories/register", { method: "POST", body: JSON.stringify({ path, displayName }) }),
  removeRepository: (id) => requestJson(`/api/repositories/${encodeURIComponent(id)}/remove`, { method: "POST", body: "{}" })
};

// src/cli/local-bridge/ui/components.ts
var routeItems = [
  { id: "overview", label: "Overview", icon: "⌂" },
  { id: "work", label: "Work", icon: "◇" },
  { id: "automations", label: "Automations", icon: "↻" },
  { id: "capabilities", label: "Capabilities", icon: "◈" },
  { id: "repositories", label: "Repositories", icon: "▱" },
  { id: "settings", label: "Settings", icon: "⚙" },
  { id: "system", label: "System", icon: "◎", secondary: true }
];
function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}
function tone(v) {
  const s = String(v ?? "").toLowerCase();
  if (/ready|healthy|success|succeeded|enabled|connected|detected|green|ok/.test(s))
    return "success";
  if (/fail|error|blocked|red|offline|unavailable/.test(s))
    return "danger";
  if (/pause|wait|attention|warning|amber|setup|degraded|restricted|missing/.test(s))
    return "warning";
  return "neutral";
}
function status(label, state, detail) {
  return `<span class="status"><i class="dot ${tone(state ?? label)}"></i><span>${esc(label)}</span>${detail ? `<small>${esc(detail)}</small>` : ""}</span>`;
}
function header(title, description, action = "") {
  return `<header class="page-head"><div><h1>${esc(title)}</h1><p>${esc(description)}</p></div>${action}</header>`;
}
function empty(title, body) {
  return `<div class="empty"><strong>${esc(title)}</strong><span>${esc(body)}</span></div>`;
}
function advanced(value, label = "Advanced") {
  return `<details class="advanced"><summary>${esc(label)}</summary><pre>${esc(JSON.stringify(value ?? {}, null, 2))}</pre></details>`;
}
function fmtDate(v) {
  if (!v)
    return "—";
  const d = new Date(v);
  return Number.isNaN(d.valueOf()) ? v : new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(d);
}

// src/cli/local-bridge/ui/views/overview.ts
function renderOverview(data) {
  const cc = data.commandCenter, ready = cc.readiness ?? {}, auto = data.automations.summary, work = data.work, plugins = cc.pluginSummary ?? {}, repos = cc.repositories ?? [], attention = (cc.handoffs ?? []).length + (plugins.needsAttention ?? 0) + auto.needsAttention + (work.waitingForUserCount ?? 0) + (work.needsAttentionCount ?? 0);
  const readyLabel = String(ready.label ?? ready.headline ?? "状态未知");
  return header("Overview", "Forge 的长期配置和可用性概览。具体工作、结果与通知继续由 ChatGPT 承担。", '<a class="btn primary" href="https://chatgpt.com" target="_blank" rel="noreferrer">Open ChatGPT ↗</a>') + (cc.warnings ?? []).map((w) => `<div class="notice warning"><strong>Needs attention</strong><span>${esc(w)}</span></div>`).join("") + `<section class="section"><div class="surface">
   <div class="summary-row"><div><strong>System</strong><div class="meta">Controller 与连接状态</div></div>${status(readyLabel, ready.state)}</div>
   <div class="summary-row"><div><strong>Work</strong><div class="meta">持久化的长期目标</div></div><div class="right"><span>${work.activeRequirementCount ?? 0} active · ${work.waitingForUserCount ?? 0} waiting</span><a class="btn" href="#/work">Open</a></div></div>
   <div class="summary-row"><div><strong>Automations</strong><div class="meta">已配置的长期自动工作</div></div><div class="right"><span>${auto.enabled} enabled · ${auto.paused} paused</span><a class="btn" href="#/automations">Manage</a></div></div>
   <div class="summary-row"><div><strong>Capabilities</strong><div class="meta">插件、服务、模型与本地工具</div></div><div class="right"><span>${plugins.ready ?? 0}/${plugins.total ?? (cc.plugins ?? []).length} ready</span><a class="btn" href="#/capabilities">Inspect</a></div></div>
   <div class="summary-row"><div><strong>Repositories</strong><div class="meta">Controller Registry</div></div><div class="right"><span>${repos.length} registered</span><a class="btn" href="#/repositories">Open</a></div></div>
  </div></section>` + `<section class="section"><div class="section-title"><h2>Needs attention</h2><span class="meta">${attention}</span></div><div class="surface">${attention ? `${(cc.handoffs ?? []).slice(0, 4).map((h) => `<div class="resource-row"><div><h3>${esc(h.title ?? "需要处理")}</h3><div class="meta">${esc(h.reason ?? "需要在 ChatGPT 中确认")}</div></div>${status(String(h.statusLabel ?? "Waiting"), h.tone)}</div>`).join("")}${(work.waitingForUserCount ?? 0) + (work.needsAttentionCount ?? 0) > 0 ? `<div class="resource-row"><div><h3>Work</h3><div class="meta">${(work.waitingForUserCount ?? 0) + (work.needsAttentionCount ?? 0)} 项长期工作需要关注</div></div><a class="btn" href="#/work">查看</a></div>` : ""}${plugins.needsAttention ?? 0 ? `<div class="resource-row"><div><h3>Capabilities</h3><div class="meta">${plugins.needsAttention} 项能力需要配置或检查</div></div><a class="btn" href="#/capabilities">查看</a></div>` : ""}` : empty("Nothing needs attention", "Forge 当前没有需要你在控制台处理的配置问题。")}</div></section>`;
}

// src/cli/local-bridge/ui/views/work.ts
var stateLabel = { planned: "Planned", active: "Active", waiting_for_user: "Waiting", done: "Completed", cancelled: "Cancelled" };
function row(item) {
  const detail = item.requiredUserDecision ?? item.blocker ?? item.outcome ?? "Durable tracked objective";
  return `<div class="resource-row"><div><h3>${esc(item.title)}</h3><div class="meta">${esc(detail)}</div><div class="meta">Updated ${fmtDate(item.updatedAt)}</div></div>${status(stateLabel[item.state] ?? item.state, item.needsAttention ? "attention" : item.state)}</div>`;
}
function renderWork(data) {
  const all = data.work.requirements ?? [];
  const active = all.filter((item) => item.state !== "done" && item.state !== "cancelled");
  const completed = all.filter((item) => item.state === "done" || item.state === "cancelled");
  return header("Work", "全局查看真正持久化的目标。这里只显示可证明的分类状态，不展示 Agent 步骤、Run 流水或推测进度。") + `<section class="section"><div class="section-title"><h2>Active</h2><span class="meta">${data.work.activeRequirementCount ?? active.length} tracked · ${data.work.waitingForUserCount ?? 0} waiting</span></div><div class="surface">${active.length ? active.map(row).join("") : empty("No active tracked work", "临时 Direct 工作不会被强制持久化；长期目标才会出现在这里。")}</div></section>` + (completed.length ? `<section class="section"><div class="section-title"><h2>Recent completed</h2></div><div class="surface">${completed.slice(0, 6).map(row).join("")}</div></section>` : "");
}

// src/cli/local-bridge/ui/views/automations.ts
function nextHint(value) {
  if (!value)
    return "";
  return Number.isNaN(Date.parse(value)) ? value : fmtDate(value);
}
function renderAutomations(data) {
  const s = data.automations.summary;
  return header("Automations", "查看和管理 Forge 本地持久化的 Schedule 与 Assistant Routine；ChatGPT 平台自身的自动任务仍由 ChatGPT 管理，不在这里双写。") + `<section class="section"><div class="section-title"><h2>${s.total} configured</h2><span class="meta">${s.enabled} enabled · ${s.paused} paused · ${s.needsAttention} attention</span></div><div class="surface">${data.automations.automations.map((a) => `<div class="resource-row"><div><h3>${esc(a.name)}</h3><div class="meta">${esc(a.repositoryName)} · ${esc(a.schedule)}${a.delivery ? ` · Delivery: ${esc(a.delivery)}` : ""}</div><div class="meta">Last: ${esc(a.lastResult ?? "—")} ${a.lastRunAt ? `· ${fmtDate(a.lastRunAt)}` : ""}${a.nextRunHint ? ` · Next: ${esc(nextHint(a.nextRunHint))}` : ""}</div></div><div class="right">${status(a.status, a.status)}<div class="actions">${a.actions.map((action) => `<button class="btn" data-automation-action="${action}" data-source="${esc(a.source)}" data-repo="${esc(a.repoId)}" data-id="${esc(a.id)}">${action === "run" ? "Run now" : action === "pause" ? "Pause" : "Resume"}</button>`).join("")}</div></div></div>`).join("") || '<div class="empty"><strong>No automations</strong><span>还没有持久化的 Schedule 或 Assistant Routine。</span></div>'}</div></section>`;
}

// src/cli/local-bridge/ui/views/capabilities.ts
function pluginRow(p) {
  return `<div class="resource-row"><div><h3>${esc(p.name)}</h3><div class="meta">${esc(p.description ?? "")}</div><div class="tags">${(p.capabilityLabels ?? []).slice(0, 6).map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div></div><div class="right">${status(p.statusLabel ?? p.status ?? "Unknown", p.status ?? p.tone)}<button class="btn" data-select-capability="${esc(p.id)}">Details</button></div></div>`;
}
function renderCapabilities(data, selectedId) {
  const plugins = data.commandCenter.plugins ?? [], providers = data.automationSettings.providers ?? [], tools = data.automationSettings.localTools ?? [];
  const selected = plugins.find((p) => p.id === selectedId) ?? plugins[0];
  return header("Capabilities", "从“Forge 能做什么”出发查看扩展、服务、执行工具与模型；底层 action/schema 只在 Advanced 中出现。", '<button class="btn" data-refresh>Refresh</button>') + `<div class="tabs"><button class="tab active">All</button><span class="meta">${plugins.length} extensions/services · ${providers.length} models/providers · ${tools.length} local tools</span></div>` + `<div class="split"><div class="surface">${plugins.map(pluginRow).join("")}${providers.map((p) => `<div class="resource-row"><div><h3>${esc(p.displayName)}</h3><div class="meta">Model / provider · ${esc(p.explanation ?? p.summary ?? "")}</div></div>${status(p.statusLabel ?? p.status ?? "Unknown", p.status)}</div>`).join("")}${tools.map((t) => `<div class="resource-row"><div><h3>${esc(t.displayName)}</h3><div class="meta">Execution tool · ${esc(t.summary ?? "")}</div></div>${status(t.status ?? "Unknown", t.status)}</div>`).join("")}</div>` + `<aside class="surface detail">${selected ? `<h2>${esc(selected.name)}</h2><div class="meta">${esc(selected.description ?? "")}</div><div class="detail-grid"><dt>Status</dt><dd>${status(selected.statusLabel ?? selected.status ?? "Unknown", selected.status ?? selected.tone)}</dd><dt>Provider</dt><dd>${esc(selected.provider ?? "—")}</dd><dt>Health</dt><dd>${esc(selected.healthLabel ?? "—")}</dd><dt>Lifecycle</dt><dd>${esc(selected.lifecycleLabel ?? "—")}</dd></div>${selected.nextStep ? `<div class="notice"><strong>Next step</strong><span>${esc(selected.nextStep)}</span></div>` : ""}<div class="tags">${(selected.capabilityLabels ?? []).map((c) => `<span class="tag">${esc(c)}</span>`).join("")}</div>${advanced({ actions: selected.actions, warnings: selected.warnings, advanced: selected.advanced }, "Actions & protocol")}</aside>` : '<div class="empty">Select a capability</div>'}</div>`;
}

// src/cli/local-bridge/ui/views/repositories.ts
function renderRepositories(data) {
  const repos = data.commandCenter.repositories ?? [];
  return header("Repositories", "Forge Controller 已注册的仓库。这里管理 Registry，不存在全局“当前仓库”身份。") + `<section class="section"><div class="surface"><div class="form-row"><div class="field"><label>Local repository path</label><input id="repo-path" placeholder="/Users/…/project"></div><div class="field"><label>Display name (optional)</label><input id="repo-name"></div><div class="actions"><button class="btn primary" data-register-repo>Register</button></div></div>${repos.map((r) => `<div class="resource-row"><div><h3>${esc(r.name)}</h3><div class="meta mono">${esc(r.path ?? "")}</div><div class="meta">${esc([r.branchLabel, r.dirtyLabel].filter(Boolean).join(" · "))}</div>${r.advanced ? advanced(r.advanced) : ""}</div><div class="right">${status(r.readinessLabel ?? r.statusLabel ?? "Registered", r.readinessLabel ?? r.statusLabel)}<button class="btn danger" data-remove-repo="${esc(r.id)}" data-repo-name="${esc(r.name)}">Remove</button></div></div>`).join("")}</div></section>`;
}

// src/cli/local-bridge/ui/views/settings.ts
function renderSettings(data) {
  const s = data.automationSettings, providers = s.providers ?? [], tools = s.localTools ?? [], routing = s.routing?.orders ?? {};
  return header("Settings", "模型、Provider、本地执行工具与路由偏好。Automation 的周期和任务本身不在这里配置。") + (s.warnings ?? []).map((w) => `<div class="notice warning"><strong>Configuration</strong><span>${esc(w)}</span></div>`).join("") + `<section class="section"><div class="section-title"><h2>Models & providers</h2></div><div class="surface">${providers.map((p) => `<div class="resource-row"><div><h3>${esc(p.displayName)}</h3><div class="meta">${esc(p.kindLabel ?? "Provider")}${typeof p.priority === "number" ? ` · priority ${p.priority}` : ""} · ${esc(p.explanation ?? p.summary ?? "")}</div></div><div class="right">${status(p.statusLabel ?? p.status ?? "Unknown", p.status)}${p.handoffOnly ? "" : `<button class="btn" data-provider-action="${p.enabled ? "disable" : "enable"}" data-provider-id="${esc(p.providerId)}">${p.enabled ? "Disable" : "Enable"}</button>`}<button class="btn" data-provider-health="${esc(p.providerId)}">Health</button></div></div>`).join("")}</div></section>` + `<section class="section"><div class="section-title"><h2>Local execution tools</h2></div><div class="surface">${tools.map((t) => `<div class="resource-row"><div><h3>${esc(t.displayName)}</h3><div class="meta">${esc(t.summary ?? "")}${t.version ? ` · ${esc(t.version)}` : ""}</div></div><div class="right">${status(t.status ?? "Unknown", t.status)}<button class="btn" data-tool-action="${t.enabled ? "disable" : "enable"}" data-tool-id="${esc(t.toolId)}">${t.enabled ? "Disable" : "Enable"}</button><button class="btn" data-tool-health="${esc(t.toolId)}">Health</button></div></div>`).join("")}</div></section>` + `<section class="section"><div class="section-title"><h2>Routing</h2></div><div class="surface">${Object.entries(routing).map(([key, order]) => `<div class="summary-row"><div><strong>${esc(key)}</strong><div class="meta">Automatic route order</div></div><span class="meta mono">${esc(order.join(" → ") || "Auto")}</span></div>`).join("") || '<div class="empty">Automatic routing</div>'}</div>${advanced(s.overview, "Provider policy details")}</section>`;
}

// src/cli/local-bridge/ui/views/system.ts
function renderSystem(data) {
  const ready = data.commandCenter.readiness ?? {}, sections = Array.isArray(ready.sections) ? ready.sections : [];
  return header("System", "低频维护入口：Runtime、Connector、Scheduler、SQLite 与诊断。正常使用不需要进入这里。", '<button class="btn" data-load-advanced>Load diagnostics</button>') + `<section class="section"><div class="surface"><div class="summary-row"><div><strong>Controller</strong><div class="meta">${esc(ready.description ?? ready.headline ?? "Forge runtime status")}</div></div>${status(String(ready.label ?? ready.headline ?? "Unknown"), ready.state)}</div>${sections.map((s) => `<div class="summary-row"><div><strong>${esc(s.title ?? "System component")}</strong><div class="meta">${esc(s.detail ?? "")}</div></div>${status(String(s.statusLabel ?? s.status ?? "Unknown"), s.tone ?? s.status)}</div>`).join("")}</div></section>` + `<section class="section"><div class="section-title"><h2>Connector</h2></div><div class="surface detail">${data.connector ? advanced(data.connector, "Connector diagnostics") : '<div class="empty">Connector details unavailable</div>'}</div></section><section id="advanced-system" class="section"></section>`;
}

// src/cli/local-bridge/ui/app.ts
var root = document.getElementById("app");
if (!root)
  throw new Error("Forge console root missing");
var data;
var busy = false;
var selectedCapability = "";
function route() {
  const id = location.hash.replace(/^#\/?/, "").split("/")[0];
  return routeItems.some((r) => r.id === id) ? id : "overview";
}
function shell(content) {
  const current = route();
  let separated = false;
  const nav = routeItems.map((item) => {
    const sep = item.secondary && !separated ? (separated = true, '<div class="nav-separator"></div>') : "";
    return `${sep}<a href="#/${item.id}" class="${current === item.id ? "active" : ""}"><span class="nav-icon">${item.icon}</span>${item.label}</a>`;
  }).join("");
  return `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">F</span>Forge</div><nav class="nav">${nav}</nav></aside><main class="main"><div class="topbar"><button class="icon-btn" data-refresh ${busy ? "disabled" : ""}>${busy ? "Refreshing…" : "Refresh"}</button><a class="btn" href="https://chatgpt.com" target="_blank" rel="noreferrer">ChatGPT ↗</a></div><div class="content">${content}</div></main></div>`;
}
function view() {
  if (!data)
    return '<div class="boot-state">正在读取 Forge 配置…</div>';
  switch (route()) {
    case "work":
      return renderWork(data);
    case "automations":
      return renderAutomations(data);
    case "capabilities":
      return renderCapabilities(data, selectedCapability);
    case "repositories":
      return renderRepositories(data);
    case "settings":
      return renderSettings(data);
    case "system":
      return renderSystem(data);
    default:
      return renderOverview(data);
  }
}
function render() {
  root.innerHTML = data ? shell(view()) : view();
  bind();
}
async function refresh() {
  if (busy)
    return;
  busy = true;
  render();
  try {
    const [commandCenter, work, automations, automationSettings, connector] = await Promise.all([api.commandCenter(), api.work(), api.automations(), api.automationSettings().catch(() => ({})), api.connector().catch(() => ({}))]);
    data = { commandCenter, work, automations, automationSettings, connector };
  } catch (error) {
    root.innerHTML = `<div class="boot-state"><strong>Forge console unavailable</strong><div>${esc(error instanceof Error ? error.message : error)}</div><button class="btn" data-refresh>Retry</button></div>`;
  } finally {
    busy = false;
    render();
  }
}
async function act(run) {
  if (busy)
    return;
  busy = true;
  render();
  try {
    await run();
    busy = false;
    await refresh();
  } catch (error) {
    busy = false;
    alert(error instanceof Error ? error.message : String(error));
    render();
  }
}
function bind() {
  root.querySelectorAll("[data-refresh]").forEach((el) => el.onclick = () => void refresh());
  root.querySelectorAll("[data-select-capability]").forEach((el) => el.onclick = () => {
    selectedCapability = el.dataset.selectCapability ?? "";
    render();
  });
  root.querySelectorAll("[data-automation-action]").forEach((el) => el.onclick = () => void act(() => api.automationAction(el.dataset.source ?? "", el.dataset.repo ?? "", el.dataset.id ?? "", el.dataset.automationAction ?? "")));
  root.querySelectorAll("[data-provider-action]").forEach((el) => el.onclick = () => void act(() => api.providerAction(el.dataset.providerId ?? "", el.dataset.providerAction)));
  root.querySelectorAll("[data-provider-health]").forEach((el) => el.onclick = () => void act(() => api.providerHealth(el.dataset.providerHealth ?? "")));
  root.querySelectorAll("[data-tool-action]").forEach((el) => el.onclick = () => void act(() => api.localToolAction(el.dataset.toolId ?? "", el.dataset.toolAction)));
  root.querySelectorAll("[data-tool-health]").forEach((el) => el.onclick = () => void act(() => api.localToolHealth(el.dataset.toolHealth ?? "")));
  const add = root.querySelector("[data-register-repo]");
  if (add)
    add.onclick = () => {
      const path = (root.querySelector("#repo-path")?.value ?? "").trim();
      const name = (root.querySelector("#repo-name")?.value ?? "").trim();
      if (path)
        act(() => api.registerRepository(path, name || undefined));
    };
  root.querySelectorAll("[data-remove-repo]").forEach((el) => el.onclick = () => {
    const name = el.dataset.repoName ?? "repository";
    if (confirm(`Remove ${name} from Forge registry?`))
      act(() => api.removeRepository(el.dataset.removeRepo ?? ""));
  });
  const adv = root.querySelector("[data-load-advanced]");
  if (adv)
    adv.onclick = () => void (async () => {
      if (busy)
        return;
      busy = true;
      adv.disabled = true;
      adv.textContent = "Loading…";
      try {
        const payload = await api.advanced();
        const target = root.querySelector("#advanced-system");
        if (target)
          target.innerHTML = `<div class="surface detail"><details class="advanced" open><summary>Raw diagnostics</summary><pre>${esc(JSON.stringify(payload, null, 2))}</pre></details></div>`;
      } catch (error) {
        alert(error instanceof Error ? error.message : String(error));
      } finally {
        busy = false;
        adv.disabled = false;
        adv.textContent = "Load diagnostics";
      }
    })();
}
window.addEventListener("hashchange", render);
refresh();
