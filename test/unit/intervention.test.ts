import { describe, expect, it } from "vitest";
import { InterventionCoordinator } from "../../src/runtime/intervention.js";
import type { RunSession } from "../../src/runtime/session.js";

describe("intervention serialization", () => {
  it("does not abort an intervention that resumed while abort was queued", async () => {
    let owner: "automation" | "human" | "none" = "automation";
    const session = {
      id: "session-1",
      get owner() {
        return owner;
      },
      pauseAutomation: () => {
        owner = "none";
      },
      claimHuman: () => {
        owner = "human";
      },
      releaseHuman: () => {
        owner = "none";
      },
      resumeAutomation: () => {
        owner = "automation";
      },
    } as unknown as RunSession;
    const verificationStarted = deferred<void>();
    const releaseVerification = deferred<void>();
    const coordinator = new InterventionCoordinator();
    const handle = coordinator.request({
      session,
      runId: "run-1",
      capabilityId: "capability-1",
      stepId: "step-1",
      goal: "Test serialization",
      reason: "runtime_state",
      summary: "Needs human input",
      verifyResume: async () => {
        verificationStarted.resolve();
        await releaseVerification.promise;
        return true;
      },
    });
    coordinator.claim(handle.request.id);

    const resume = coordinator.resume(handle.request.id);
    await verificationStarted.promise;
    const abort = coordinator.abort(handle.request.id, "late abort");
    releaseVerification.resolve();

    await expect(resume).resolves.toMatchObject({ status: "resumed" });
    await expect(abort).rejects.toThrow("no longer pending");
    await expect(handle.resolution).resolves.toMatchObject({ kind: "resumed" });
    expect(coordinator.events(handle.request.id).map(({ type }) => type)).not.toContain(
      "intervention_aborted",
    );
  });
});

const deferred = <T>() => {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
