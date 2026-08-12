import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createHandoffItem,
  getHandoffItem,
  handoffInboxPath,
  resolveHandoffItem,
} from "../../src/runtime/control-plane/facade/handoff-inbox-store";

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
});
