/**
 * Platform resolution for Computer composition. Keeping this behind one seam
 * makes native-provider policy deterministic in contract tests without
 * weakening the production platform fence.
 */
let platformOverrideForTest: NodeJS.Platform | undefined;

export function currentComputerPlatform(): NodeJS.Platform {
  return platformOverrideForTest ?? process.platform;
}

export function setComputerPlatformForTest(platform: NodeJS.Platform | undefined): void {
  platformOverrideForTest = platform;
}
