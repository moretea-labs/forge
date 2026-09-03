#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findWindowsIncompatiblePaths } from "./windows-paths.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const failures = [];

function text(path) {
  const absolute = resolve(root, path);
  if (!existsSync(absolute)) {
    failures.push(`missing ${path}`);
    return "";
  }
  return readFileSync(absolute, "utf8");
}

function requireText(path, value) {
  if (!text(path).includes(value)) failures.push(`${path} must contain ${JSON.stringify(value)}`);
}

let trackedPaths = [];
try {
  trackedPaths = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
  for (const entry of findWindowsIncompatiblePaths(trackedPaths)) {
    failures.push(`Windows-incompatible tracked path ${JSON.stringify(entry.path)}: ${entry.problems.join("; ")}`);
  }
} catch (error) {
  failures.push(`unable to inspect tracked paths: ${error instanceof Error ? error.message : String(error)}`);
}

const pkg = JSON.parse(text("package.json") || "{}");
if (pkg.engines?.node !== ">=20.10.0") failures.push("package.json engines.node must be >=20.10.0");
if (!pkg.engines?.bun) failures.push("package.json must document the supported Bun runtime");
if (!pkg.scripts?.["check:platform-support"]) failures.push("package.json is missing check:platform-support");
if (!pkg.scripts?.["smoke:tarball-install"]) failures.push("package.json is missing smoke:tarball-install");
if (!pkg.scripts?.["check:portable-package"]) failures.push("package.json is missing check:portable-package");

requireText("bin/forge.mjs", "#!/usr/bin/env node");
for (const path of ["install.sh", "install.ps1"]) {
  requireText(path, "FORGE_INSTALL_RUNTIME");
  requireText(path, "Node.js 20.10");
  requireText(path, "Git is optional");
  requireText(path, "forge setup");
}
requireText("install.sh", "npm install -g");
requireText("install.ps1", "npm install -g");
requireText("docs/operations/platform-support.md", "Native Windows");
requireText("docs/operations/platform-support.md", "WSL2");
requireText("docs/operations/features.md", "Core features");
requireText("docs/tutorials/01-install-and-start.md", "Node.js 20.10");
requireText("docs/tutorials/01-install-and-start.zh-CN.md", "Node.js 20.10");
requireText(".github/workflows/windows-smoke.yml", "windows-latest");
requireText(".github/workflows/windows-smoke.yml", "-DryRun");
requireText("docs/operations/platform-support.md", "| Platform | Runtime | Controller / MCP | Browser | Native Desktop / Computer | Recovery | Service persistence |");
requireText("docs/operations/platform-support.md", "non-persistent portable");
requireText("docs/operations/platform-support.md", "Windows-host Recovery binding");

requireText("scripts/check-tarball-install-smoke.sh", "FORGE_CONTROLLER_HOME");
requireText("scripts/check-tarball-install-smoke.sh", "CLEAN_HOME");
requireText("scripts/check-tarball-install-smoke.sh", "npm pack --silent");
requireText("scripts/check-tarball-install-smoke.sh", "PACKAGE_VERSION=\"$(node");

const productTextPaths = trackedPaths.filter((entry) =>
  /^(?:bin|src|packages|adapters|assets)\//.test(entry)
  || entry === "install.sh"
  || entry === "install.ps1"
);
const personalBindingPatterns = [
  { label: "macOS personal absolute path", pattern: /\/Users\/[A-Za-z0-9._-]+\// },
  { label: "Linux personal absolute path", pattern: /\/home\/[A-Za-z0-9._-]+\// },
  { label: "Windows personal absolute path", pattern: /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/ },
  { label: "WSL personal Windows path", pattern: /\/mnt\/[a-z]\/Users\/[A-Za-z0-9._-]+\//i },
];
for (const path of productTextPaths) {
  const content = text(path);
  for (const { label, pattern } of personalBindingPatterns) {
    if (pattern.test(content)) failures.push(`${path} contains ${label}; use host discovery/configuration instead`);
  }
}

const publicDocs = [
  "README.md",
  "README.en.md",
  "README.zh-CN.md",
  "README.es.md",
  "README.fr.md",
  "README.ja.md",
  "docs/public-usage-guide.md",
  "docs/public-usage-guide.zh-CN.md",
];
const retiredPersonalRepositoryUrl = ["github.com", "greysonOuyang"].join("/") + "/";
for (const path of publicDocs) {
  const content = text(path);
  if (content.includes(retiredPersonalRepositoryUrl)) failures.push(`${path} contains the retired personal repository URL`);
}

if (failures.length > 0) {
  console.error("[platform-support] FAIL");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
console.log("[platform-support] OK");
