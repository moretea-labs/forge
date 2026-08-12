import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ensureControllerHome } from "../../src/cli/repositories/controller-home";
import {
  attachExternalControllerLaunchPid,
  getExternalControllerLaunchReservation,
  releaseExternalControllerLaunchReservation,
  reserveExternalControllerLaunch,
} from "../../src/runtime/control-plane/launcher/launch-reservation-store";

const roots: string[] = [];
afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }); });

describe("external Controller launch reservation", () => {
  test("fences duplicate spawn reservations without becoming Controller ownership", () => {
    const root = mkdtempSync(join(tmpdir(), "forge-launch-reservation-"));
    roots.push(root);
    const controllerHome = join(root, "controller");
    ensureControllerHome(controllerHome);
    const options = { controllerHome, repoId: "repo-launch-reservation" };
    const first = reserveExternalControllerLaunch(options, { workId: "WORK-1", controllerType: "codex", ttlMs: 60_000 });
    expect(getExternalControllerLaunchReservation(options, "WORK-1")?.reservationId).toBe(first.reservationId);
    expect(() => reserveExternalControllerLaunch(options, { workId: "WORK-1", controllerType: "codex" })).toThrow("CONTROLLER_LAUNCH_ALREADY_RESERVED");
    const bound = attachExternalControllerLaunchPid(options, "WORK-1", first.reservationId, 4242);
    expect(bound.pid).toBe(4242);
    releaseExternalControllerLaunchReservation(options, "WORK-1", first.reservationId, "provider_claimed_or_failed");
    expect(getExternalControllerLaunchReservation(options, "WORK-1")).toBeUndefined();
    const second = reserveExternalControllerLaunch(options, { workId: "WORK-1", controllerType: "claude" });
    expect(second.reservationId).not.toBe(first.reservationId);
  });
});
