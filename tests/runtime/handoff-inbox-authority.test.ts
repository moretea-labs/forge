import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  countHandoffItems,
  createHandoffItem,
  getHandoffItem,
  handoffInboxPath,
  resolveHandoffItem,
} from "../../src/runtime/control-plane/facade/handoff-inbox-store";
import { handoffRequiresAttention } from "../../src/runtime/control-plane/facade/handoff-inbox-application";

describe("HandoffItem persistence authority", () => {
  test("controller-home inbox remains authoritative across session-cache changes and fresh reads", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-handoff-authority-"));
    const controllerHome = join(root, "controller-home");
    const repoRoot = join(root, "repo");
    const repoId = "repo_handoff_authority";
    mkdirSync(join(repoRoot, ".ai/harness/session"), { recursive: true });
    try {
      const location = { controllerHome, repoId };
      const created = createHandoffItem(location, {
        id: "decision-1",
        repoId,
        title: "Choose bounded continuation",
        severity: "blocked",
        reason: "The next safe implementation choice is ambiguous.",
        creationReason: "ambiguous_outcome",
        summary: "A controller decision is required before continuing.",
        currentState: { repoId, statusSummary: "blocked on controller judgement" },
        evidenceRefs: [],
        recommendedDecision: "Review the evidence and choose one bounded path.",
        recommendedPrompt: "Review the pending decision and continue only after resolving it.",
        suggestedNextActions: [],
      });

      expect(created.status).toBe("pending");
      expect(handoffInboxPath(location)).toBe(join(controllerHome, "repositories", repoId, "handoff-inbox", "index.json"));
      expect(existsSync(handoffInboxPath(location))).toBe(true);

      writeFileSync(
        join(repoRoot, ".ai/harness/session/continuation.md"),
        "# Forge Session Continuation Snapshot\n\nThis cache falsely claims the decision is resolved.\n",
      );
      expect(getHandoffItem(location, created.id)?.status).toBe("pending");

      resolveHandoffItem(location, created.id, { decision: "Use path A", resolver: "chatgpt" });
      const fresh = getHandoffItem(location, created.id);
      expect(fresh?.status).toBe("resolved");
      expect(fresh?.decision).toBe("Use path A");
      expect(fresh?.resolver).toBe("chatgpt");
      expect(readFileSync(handoffInboxPath(location), "utf8")).toContain('"status": "resolved"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("count is not truncated by bounded list previews", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-handoff-count-"));
    const location = { root: join(root, "handoff-inbox") };
    try {
      for (let index = 0; index < 37; index += 1) {
        createHandoffItem(location, {
          id: `pending-${index}`,
          repoId: "repo_handoff_count",
          title: `Pending ${index}`,
          severity: "needs_review",
          reason: "Pending review.",
          creationReason: "ambiguous_outcome",
          summary: "Pending review.",
          currentState: { repoId: "repo_handoff_count", statusSummary: "pending" },
          evidenceRefs: [],
          recommendedDecision: "Review.",
          recommendedPrompt: "Review.",
          suggestedNextActions: [],
        });
      }
      expect(countHandoffItems({ ...location, status: "pending" })).toBe(37);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("attention projection follows canonical pending UserRequest authority only", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-handoff-attention-"));
    const location = { root };
    try {
      const legacyOnly = createHandoffItem(location, {
        id: "legacy-decision",
        repoId: "repo_attention",
        workId: "work-terminal",
        title: "Historical compatibility projection",
        severity: "needs_review",
        reason: "Historical decision.",
        creationReason: "ambiguous_outcome",
        summary: "Historical decision.",
        currentState: { repoId: "repo_attention", workId: "work-terminal", statusSummary: "pending" },
        evidenceRefs: [],
        recommendedDecision: "Review.",
        recommendedPrompt: "Review.",
        suggestedNextActions: [],
      });
      const projected = createHandoffItem(location, {
        id: "decision-current",
        repoId: "repo_attention",
        title: "Current decision",
        severity: "needs_review",
        reason: "Human decision required.",
        creationReason: "ambiguous_outcome",
        summary: "Human decision required.",
        currentState: { repoId: "repo_attention", statusSummary: "pending" },
        evidenceRefs: [],
        recommendedDecision: "Decide.",
        recommendedPrompt: "Decide.",
        suggestedNextActions: [],
      });
      const pendingProjection = { ...projected, canonicalUserRequestId: "usr-current" };
      const resolvedProjection = { ...projected, id: "decision-resolved", canonicalUserRequestId: "usr-resolved" };
      const resolver = { userRequestIsPending: (requestId: string) => requestId === "usr-current" };
      expect(handoffRequiresAttention(legacyOnly, resolver)).toBe(false);
      expect(handoffRequiresAttention(pendingProjection, resolver)).toBe(true);
      expect(handoffRequiresAttention(resolvedProjection, resolver)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
