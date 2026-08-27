import { describe, expect, it } from "vitest";

import { createRunEvent, RunEventSchema, type RunEventEnvelope } from "../../src/core/events.js";

const envelope: RunEventEnvelope = {
  eventVersion: "1.0",
  timestamp: "2026-08-26T12:00:00.000Z",
  runId: "run-1",
  sequence: 3,
  phase: "replay",
  actor: { type: "automation" },
  capabilityId: "prepare_savings_subaccount",
  stepId: "open_member",
};

describe("RunEventSchema", () => {
  it("creates a typed action event with locator diagnostics", () => {
    const event = createRunEvent(envelope, {
      type: "action.completed",
      data: {
        target: "member search button",
        receipt: {
          action: "click",
          ok: true,
          durationMs: 28,
          urlBefore: "http://127.0.0.1:4173/members",
          urlAfter: "http://127.0.0.1:4173/members/12345",
          resolution: {
            strategyIndex: 1,
            kind: "text",
            attempts: [
              { strategyIndex: 0, kind: "role", matches: 0 },
              { strategyIndex: 1, kind: "text", matches: 1 },
            ],
          },
        },
      },
    });

    expect(event.type).toBe("action.completed");
    if (event.type === "action.completed") {
      expect(event.data.receipt.resolution?.strategyIndex).toBe(1);
    }
  });

  it("records intervention state as an event, not a terminal result", () => {
    const event = createRunEvent(
      {
        ...envelope,
        phase: "handoff",
        actor: { type: "human", id: "operator-local" },
      },
      {
        type: "intervention.changed",
        data: {
          interventionId: "intervention-1",
          state: "claimed",
          reason: "runtime_state",
          summary: "Operator is dismissing an unexpected confirmation",
        },
      },
    );

    expect(event.actor.type).toBe("human");
  });

  it("records the exact deterministic recovery command", () => {
    const event = createRunEvent(envelope, {
      type: "recovery.attempted",
      data: {
        attempt: 1,
        maxAttempts: 2,
        command: {
          kind: "click",
          target: {
            description: "Try again link",
            whyRobust: "Stable user-facing recovery label",
            strategies: [{ kind: "text", text: "Try again", exact: true }],
          },
        },
        reason: "The first detail request returned a transient error",
      },
    });

    expect(event.type).toBe("recovery.attempted");
    if (event.type === "recovery.attempted") {
      expect(event.data.command.kind).toBe("click");
    }
  });

  it("rejects an event whose payload does not match its discriminator", () => {
    expect(
      RunEventSchema.safeParse({
        ...envelope,
        type: "checkpoint.checked",
        data: {
          attempt: 1,
          maxAttempts: 2,
          reason: "slow load",
        },
      }).success,
    ).toBe(false);
  });
});
