export type RuntimeConnectionStatus = 'not_connected' | 'connecting' | 'connected' | 'degraded';

export interface ForgeDesktopProjection {
  runtime: {
    status: RuntimeConnectionStatus;
    label: string;
    detail: string;
  };
  project: {
    name: string;
    subtitle: string;
  } | null;
  thread: {
    title: string;
  } | null;
}

/**
 * Presentation-only bootstrap value. Requirement, Plan, Work, Controller,
 * Scheduler and connection facts remain authoritative in the Forge Runtime.
 * The desktop client never persists a competing semantic copy.
 */
export const disconnectedProjection = Object.freeze({
  runtime: {
    status: 'not_connected',
    label: 'Runtime not connected',
    detail: 'Desktop bootstrap is ready. Runtime projection wiring is the next delivery slice.',
  },
  project: null,
  thread: null,
} satisfies ForgeDesktopProjection);

export interface ForgeRuntimeProjectionPort {
  readProjection(): Promise<ForgeDesktopProjection>;
}
