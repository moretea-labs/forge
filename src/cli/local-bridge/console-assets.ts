import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";

export type ConsoleAssetName = "app.js" | "app.css";

export function resolveConsoleAssetPath(
  asset: ConsoleAssetName,
  executablePath = process.execPath,
): string | URL {
  const releaseAssetPath = join(dirname(executablePath), "ui-dist", asset);
  if (existsSync(releaseAssetPath)) return releaseAssetPath;
  return new URL(`./ui-dist/${asset}`, import.meta.url);
}

export function readConsoleAsset(asset: ConsoleAssetName): string {
  return readFileSync(resolveConsoleAssetPath(asset), "utf8");
}
