export interface GitHubRepositoryInfo {
  nameWithOwner: string;
  owner: string;
  repo: string;
  url: string;
  defaultBranch: string;
}

export interface GitHubStatus {
  available: boolean;
  authenticated: boolean;
  version?: string;
  repository?: GitHubRepositoryInfo;
  agentTaskSupported: boolean;
  errors: string[];
}
