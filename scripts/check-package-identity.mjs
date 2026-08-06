#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const lock = JSON.parse(readFileSync(resolve(root, "package-lock.json"), "utf8"));
const skill = JSON.parse(readFileSync(resolve(root, "assets/skill-version.json"), "utf8"));

const expectedName = "@moretea-labs/forge";
const requiredFiles = [
  "LICENSE",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "SUPPORT.md",
  "CODE_OF_CONDUCT.md",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "README.md",
  "README.en.md",
  "README.zh-CN.md",
  "install.sh",
  "install.ps1",
  "docs/README.md",
  "docs/tutorials/",
  "docs/operations/",
  "docs/wiki/",
];
const forbiddenPackageEntries = [
  "ARCHITECTURE_MIGRATION_REPORT.md",
  "OPTIMIZATION_REPORT.md",
];

function fail(message) {
  console.error(`[package-identity] ERROR: ${message}`);
  process.exit(1);
}

function requireReleaseScript(name, channel) {
  const script = pkg.scripts?.[name];
  const expected = `bash scripts/publish-release-tarball.sh ${channel}`;
  if (script !== expected) fail(`${name} must delegate to the reusable tarball publisher for ${channel}`);
}

function requireReusableTarballPublisher() {
  const path = resolve(root, "scripts/publish-release-tarball.sh");
  if (!existsSync(path)) fail("reusable tarball publisher is missing");
  const script = readFileSync(path, "utf8");
  for (const required of [
    "node scripts/check-release-version.mjs --channel \"$CHANNEL\" --require-tag",
    "bash scripts/check-npm-release.sh",
    "npm publish \"$TARBALL_PATH\" --tag \"$CHANNEL\" --access public",
  ]) {
    if (!script.includes(required)) fail(`reusable tarball publisher missing: ${required}`);
  }
}

if (pkg.name !== expectedName) fail(`package.json name is ${pkg.name}`);
const versionMatch = String(pkg.version ?? "").match(/^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/);
if (!versionMatch) fail(`package.json version is not a stable or rc semantic version: ${pkg.version}`);
const coreVersion = versionMatch[1];
if (coreVersion !== skill.version || coreVersion !== skill.templateVersion) {
  fail(`package core version ${coreVersion} must match workflow versions ${skill.version}/${skill.templateVersion}`);
}
if (pkg.publishConfig?.access !== "public") fail("publishConfig.access must be public");
if (pkg.publishConfig?.provenance !== true) fail("publishConfig.provenance must be true");
if (pkg.publishConfig?.tag !== undefined) fail("publishConfig.tag must be omitted");
if (pkg.private !== undefined) fail("package must not declare private");
if (pkg.author !== "Moretea Labs contributors") fail(`unexpected package author: ${pkg.author}`);
if (!String(pkg.repository?.url ?? "").includes("moretea-labs/forge")) {
  fail("repository URL must target the canonical Forge repository");
}

const bin = pkg.bin ?? {};
const expectedBins = {
  forge: "bin/forge.mjs",
  "forge-hook": "bin/forge-hook.mjs",
  "forge-runtime": "bin/forge-runtime.mjs",
};
if (JSON.stringify(Object.keys(bin).sort()) !== JSON.stringify(Object.keys(expectedBins).sort())) {
  fail(`package bin surface must be Forge-only: ${Object.keys(bin).sort().join(", ")}`);
}
for (const [name, target] of Object.entries(expectedBins)) {
  if (bin[name] !== target) fail(`${name} bin mapping changed`);
}
for (const forbidden of ["matea", "matea-hook", "repo-harness", "repo-harness-hook", "repo-harness-runtime"]) {
  if (Object.prototype.hasOwnProperty.call(bin, forbidden)) fail(`forbidden compatibility bin remains: ${forbidden}`);
}
if (pkg.scripts?.prepublishOnly !== "bash scripts/check-npm-release.sh") fail("prepublishOnly gate changed");
if (pkg.scripts?.["check:release-version"] !== "node scripts/check-release-version.mjs") {
  fail("release version check changed");
}
requireReleaseScript("release:rc", "next");
requireReleaseScript("release:stable", "latest");
requireReusableTarballPublisher();

const files = new Set(pkg.files ?? []);
for (const required of requiredFiles) {
  if (!files.has(required)) fail(`package files missing ${required}`);
  if (!existsSync(resolve(root, required))) fail(`repository file missing ${required}`);
}
for (const forbidden of forbiddenPackageEntries) {
  if (files.has(forbidden)) fail(`internal report must not be packed: ${forbidden}`);
}

if (lock.name !== pkg.name || lock.version !== pkg.version) {
  fail("package-lock root identity differs from package.json");
}
if (lock.packages?.[""]?.name !== pkg.name || lock.packages?.[""]?.version !== pkg.version) {
  fail("package-lock root package identity differs from package.json");
}

console.log(`[package-identity] OK: ${pkg.name}@${pkg.version}`);
