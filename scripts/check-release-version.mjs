#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const args = process.argv.slice(2);

function fail(message) {
  console.error(`[release-version] ERROR: ${message}`);
  process.exit(1);
}

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) fail(`${flag} requires a value`);
  return value;
}

function nonEmpty(value) {
  const normalized = String(value ?? "").trim();
  return normalized || undefined;
}

const packageJsonArg = valueAfter("--package-json");
const packageJsonPath = packageJsonArg
  ? resolve(process.cwd(), packageJsonArg)
  : resolve(root, "package.json");

let pkg;
try {
  pkg = JSON.parse(readFileSync(packageJsonPath, "utf8"));
} catch (error) {
  fail(`cannot read package metadata at ${packageJsonPath}: ${error instanceof Error ? error.message : error}`);
}

const version = String(pkg.version ?? "");
const match = version.match(/^(\d+\.\d+\.\d+)(?:-rc\.(\d+))?$/);
if (!match) fail(`unsupported package version: ${version}`);

if (pkg.publishConfig?.tag !== undefined) {
  fail("publishConfig.tag must be omitted; release commands select next or latest explicitly");
}

const prerelease = match[2] !== undefined;
const inferredChannel = prerelease ? "next" : "latest";
const requestedChannel = valueAfter("--channel");
if (requestedChannel && !["next", "latest"].includes(requestedChannel)) {
  fail(`unsupported release channel: ${requestedChannel}`);
}
if (requestedChannel && requestedChannel !== inferredChannel) {
  fail(`${version} must publish to ${inferredChannel}, not ${requestedChannel}`);
}

const explicitTag = valueAfter("--tag") ?? nonEmpty(process.env.RELEASE_TAG);
const githubTag = process.env.GITHUB_REF_TYPE === "tag"
  ? nonEmpty(process.env.GITHUB_REF_NAME)
  : undefined;
const releaseTag = explicitTag ?? githubTag;
const expectedTag = `v${version}`;
const requireTag = args.includes("--require-tag");

if (releaseTag && releaseTag !== expectedTag) {
  fail(`release tag ${releaseTag} does not match package version ${expectedTag}`);
}
if (requireTag && !releaseTag) {
  fail(`set RELEASE_TAG=${expectedTag} or run from Git tag ${expectedTag}`);
}

console.log(`[release-version] OK: ${version} -> ${inferredChannel}${releaseTag ? ` (${releaseTag})` : ""}`);
