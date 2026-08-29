#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function runTrackedForgeHelper(helperName: string, args = process.argv.slice(2)): never {
  const helperId = helperName.replace(/\.[^.]+$/, "");
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = resolve(scriptDir, "..", "..");
  const sourceCli = join(sourceRoot, "src", "cli", "index.ts");
  const canonicalHelper = join(sourceRoot, "assets", "templates", "helpers", helperName);
  const command = existsSync(sourceCli) && existsSync(canonicalHelper)
    ? ["bun", sourceCli, "run", helperId]
    : ["forge", "run", helperId];
  const result = spawnSync(command[0], [...command.slice(1), ...args], {
    cwd: process.cwd(),
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`Missing Forge runtime for helper ${helperId}: ${result.error.message}`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}
