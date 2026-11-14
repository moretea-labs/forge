export type ControllerAgent = 'codex' | 'claude' | 'github-copilot';

export type AgentAuthenticationReadiness = "ready" | "required" | "unknown";

export interface AgentExecutableIdentity {
  schemaVersion: 1;
  agent: Exclude<ControllerAgent, "github-copilot">;
  command: string;
  source: "configured" | "path";
  executablePath: string;
  resolvedPath: string;
  version: string;
  authenticationReadiness: AgentAuthenticationReadiness;
  probedAt: string;
  fileIdentity: {
    device: number;
    inode: number;
    size: number;
    mtimeMs: number;
  };
}
