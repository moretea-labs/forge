import {
  closeGitHubIssue,
  publishIssueToGitHub,
  refreshGitHubIssue,
} from "./issue-sync";
import type { ControllerIssue } from "../controller/types";
import { tryAppendControllerWorklogEvent } from "../../runtime/evidence/controller-worklog";
import {
  invalidateGitHubPluginStatus,
  loadGitHubPluginConfig,
  type GitHubPluginConfig,
} from "../../runtime/plugins/github-config";
function requireEnabled(repoRoot: string): GitHubPluginConfig {
  const config = loadGitHubPluginConfig(repoRoot);
  if (!config.enabled) throw new Error("GitHub plugin is disabled. Enable it before publishing or syncing Issues.");
  return config;
}

export function publishIssueWithGitHubPlugin(repoRoot: string, issueId: string): ControllerIssue {
  const config = requireEnabled(repoRoot);
  const issue = publishIssueToGitHub(repoRoot, issueId, {
    repo: config.repository,
    labels: config.labels,
    includeTasks: config.includeTasks,
    projectOwner: config.projectOwner,
    projectNumber: config.projectNumber,
  });
  invalidateGitHubPluginStatus(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_issue_published",
    summary: `Published ${issue.id} to GitHub.`,
    actor: "github-plugin",
    issueId: issue.id,
    details: { url: issue.github?.url },
  });
  return issue;
}

export function refreshIssueWithGitHubPlugin(repoRoot: string, issueId: string) {
  requireEnabled(repoRoot);
  const result = refreshGitHubIssue(repoRoot, issueId);
  invalidateGitHubPluginStatus(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_issue_refreshed",
    summary: `Refreshed ${issueId} from GitHub.`,
    actor: "github-plugin",
    issueId,
    details: { url: result.issue.github?.url, remote: result.remote },
  });
  return result;
}

export function closeIssueWithGitHubPlugin(repoRoot: string, issueId: string): ControllerIssue {
  requireEnabled(repoRoot);
  const issue = closeGitHubIssue(repoRoot, issueId);
  invalidateGitHubPluginStatus(repoRoot);
  tryAppendControllerWorklogEvent(repoRoot, {
    category: "github",
    action: "github_issue_closed",
    summary: `Closed the linked GitHub Issue for ${issueId}.`,
    actor: "github-plugin",
    issueId,
    details: { url: issue.github?.url },
  });
  return issue;
}
