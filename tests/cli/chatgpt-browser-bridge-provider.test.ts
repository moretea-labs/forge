import { EventEmitter } from "events";
import { spawn } from "child_process";
import { describe, expect, test } from "bun:test";
import { bootstrapWslWindowsBridgeBrowser } from "../../src/cli/chatgpt-browser/bridge-provider";
import type { WindowsHostEnvironment } from "../../src/runtime/platform/windows-host-discovery";

describe("WSL Windows ChatGPT bridge browser bootstrap", () => {
  test("prefers Google Chrome and provisions a dedicated profile without touching the user profile", async () => {
    const chromeExecutable = "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe";
    const centBrowserExecutable = "/mnt/c/Program Files/CentBrowser/Application/chrome.exe";
    const localAppData = "/mnt/c/Users/greyson/AppData/Local";
    const host: WindowsHostEnvironment = {
      commandExecutable: "/mnt/c/Windows/System32/cmd.exe",
      userProfileWindows: "C:\\Users\\greyson",
      userProfile: "/mnt/c/Users/greyson",
      localAppDataWindows: "C:\\Users\\greyson\\AppData\\Local",
      localAppData,
      programFilesWindows: ["C:\\Program Files"],
      programFiles: ["/mnt/c/Program Files"],
      driveMounts: { c: "/mnt/c" },
    };
    const launched: Array<{ executable: string; args: string[] }> = [];
    const child = new EventEmitter() as unknown as ReturnType<typeof spawn>;
    child.unref = () => {};
    const launch = ((executable: string, args: string[]) => {
      launched.push({ executable, args });
      queueMicrotask(() => child.emit("spawn"));
      return child;
    }) as unknown as typeof spawn;
    const toWindowsPath = (value: string) => `C:\\${value.slice("/mnt/c/".length).replaceAll("/", "\\")}`;

    const binding = await bootstrapWslWindowsBridgeBrowser("/controller", {
      platform: "linux",
      wslDistroName: "Ubuntu",
      hostEnvironment: host,
      fileExists: (path) => [chromeExecutable, centBrowserExecutable].includes(String(path)),
      launch,
      toWindowsPath,
      bridgeToken: () => "test-bridge-token",
      writeExtension: (root, bridgeUrl) => {
        const extensionDir = `${root}/.ai/harness/chatgpt/bridge-extension`;
        return {
          extensionDir,
          manifestPath: `${extensionDir}/manifest.json`,
          contentScriptPath: `${extensionDir}/content-script.js`,
          bridgeUrl,
        };
      },
    });

    expect(binding.executable).toBe(chromeExecutable);
    expect(binding.profileDirectory).toBe("Default");
    expect(binding.userDataDir).toBe(`${localAppData}/Forge/ChatGPT Bridge/User Data`);
    expect(binding.loadExtensionOnLaunch).toBe(true);
    expect(launched).toHaveLength(1);
    expect(launched[0]?.executable).toBe(chromeExecutable);
    expect(launched[0]?.args).toContain(`--user-data-dir=${toWindowsPath(binding.userDataDir!)}`);
    expect(launched[0]?.args).toContain(`--load-extension=${toWindowsPath(binding.extensionDir)}`);
    expect(launched[0]?.args.some((argument) => argument.includes("Google/Chrome/User Data"))).toBe(false);
  });
});
