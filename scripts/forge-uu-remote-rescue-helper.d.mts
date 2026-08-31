export interface UuRemoteRescueConfig {
  schemaVersion: 1;
  device: {
    id: string;
    name: string;
    platform: 'windows';
  };
  wsl: {
    distro: string;
    controllerHome: string;
  };
  uuycCliPath: string;
  desktopOperatorSocketPath: string;
  uuBundleId: string;
}

export function validateConfig(value: unknown): UuRemoteRescueConfig;

export function serviceUnits(controllerHome: string): {
  runtime: string;
  connector: string;
  recoveryGateway: string;
  recoveryWatchdog: string;
};

export function executeAction(
  actionId: string,
  input: Record<string, unknown>,
  configInput: unknown,
  injected?: Record<string, unknown>,
): Promise<Record<string, unknown>>;
