import { describe, expect, it } from "vitest";

import {
  CapabilityArtifactSchema,
  LocatorStrategySchema,
  RunResultSchema,
} from "../../src/core/contracts.js";

const memberNameTarget = {
  description: "member name value",
  whyRobust: "The visible row label is stable across generated element IDs",
  frame: {
    strategies: [{ kind: "css" as const, selector: "iframe[name=workspace]" }],
  },
  strategies: [
    { kind: "text" as const, text: "Ada Lovelace", exact: true },
    { kind: "css" as const, selector: "td.member-name" },
  ],
};

function artifactFixture(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    id: "prepare_savings_subaccount",
    revision: 1,
    name: "Prepare savings sub-account",
    description: "Reads a member and reaches the account review screen",
    discoveryRunId: "run-discovery-1",
    app: {
      family: "legacy_bank",
      version: "1.0.0",
      surface: "web",
    },
    entryUrl: "http://127.0.0.1:4173/members",
    contract: {
      inputs: {
        memberId: {
          type: "string",
          description: "Synthetic member identifier",
          sensitivity: "sensitive",
          pattern: "^[0-9]{5}$",
        },
      },
      outputs: {
        memberName: {
          value: {
            type: "string",
            description: "Synthetic member name",
            sensitivity: "sensitive",
          },
          from: "member_name",
        },
      },
      businessOutcomes: [
        {
          code: "member_not_found",
          description: "No member matched the supplied identifier",
        },
      ],
    },
    permissions: {
      origins: ["http://127.0.0.1:4173"],
      routes: ["/members/*"],
      actions: ["read", "click"],
    },
    steps: [
      {
        id: "read_member_name",
        description: "Read the member name",
        command: {
          kind: "read",
          target: memberNameTarget,
          bind: "member_name",
          parse: "text",
        },
        expect: [{ kind: "visible", target: memberNameTarget }],
        onObserved: [
          {
            when: { kind: "text", includes: "Member not found" },
            action: { kind: "return_outcome", code: "member_not_found" },
          },
          {
            when: { kind: "text", includes: "Detail load failed" },
            action: {
              kind: "recover",
              command: {
                kind: "click",
                target: {
                  description: "Try again link",
                  whyRobust: "Stable user-facing recovery label",
                  strategies: [{ kind: "text", text: "Try again", exact: true }],
                },
              },
              message: "Retry the explicitly safe detail load",
            },
          },
        ],
        timeoutMs: 5_000,
        risk: "safe",
      },
    ],
    success: [{ kind: "url", path: "/members/{{inputs.memberId}}" }],
  };
}

describe("CapabilityArtifactSchema", () => {
  it("accepts a compact, reviewable capability", () => {
    const artifact = CapabilityArtifactSchema.parse(artifactFixture());
    const command = artifact.steps[0]?.command;

    expect(command?.kind).toBe("read");
    if (command?.kind !== "read") {
      throw new Error("Expected read command");
    }
    expect(command.target.strategies.map(({ kind }) => kind)).toEqual(["text", "css"]);
    expect(artifact.steps[0]?.onObserved?.[1]?.action.kind).toBe("recover");
  });

  it("rejects unknown locator scoring fields", () => {
    const result = LocatorStrategySchema.safeParse({
      kind: "text",
      text: "Member name",
      weight: 0.9,
    });

    expect(result.success).toBe(false);
  });

  it("rejects invalid string constraints at the schema boundary", () => {
    const artifact = artifactFixture();
    const input = (artifact.contract as { inputs: { memberId: Record<string, unknown> } }).inputs
      .memberId;
    input.pattern = "[";
    input.minLength = 10;
    input.maxLength = 5;

    const result = CapabilityArtifactSchema.safeParse(artifact);
    expect(result.success).toBe(false);
    expect(result.error?.issues.map(({ message }) => message)).toEqual(
      expect.arrayContaining([
        "pattern must be a valid regular expression",
        "minLength must not exceed maxLength",
      ]),
    );
  });

  it("rejects output bindings that no read step produces", () => {
    const artifact = artifactFixture();
    const contract = artifact.contract as { outputs: { memberName: { from: string } } };
    contract.outputs.memberName.from = "missing_binding";

    const result = CapabilityArtifactSchema.safeParse(artifact);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some(({ message }) => message.includes("missing binding"))).toBe(
      true,
    );
  });

  it("rejects branches returning undeclared business outcomes", () => {
    const artifact = artifactFixture();
    const steps = artifact.steps as Array<{
      onObserved: Array<{ action: { code: string } }>;
    }>;
    const firstBranch = steps[0]?.onObserved[0];
    if (firstBranch === undefined) {
      throw new Error("Fixture branch missing");
    }
    firstBranch.action.code = "unknown_outcome";

    const result = CapabilityArtifactSchema.safeParse(artifact);

    expect(result.success).toBe(false);
    expect(result.error?.issues.some(({ message }) => message.includes("Undeclared"))).toBe(true);
  });
});

describe("RunResultSchema", () => {
  it.each([
    {
      status: "success",
      runId: "run-1",
      outputs: { memberName: "Ada Lovelace", savingsBalance: 1250.5 },
      evidence: [],
    },
    {
      status: "business_outcome",
      runId: "run-2",
      code: "member_not_found",
      details: {},
      evidence: [],
    },
    {
      status: "failure",
      runId: "run-3",
      category: "checkpoint",
      stepId: "read_member_name",
      message: "Expected review screen",
      retryable: false,
      expected: { path: "/review" },
      observed: { path: "/error" },
      evidence: [],
    },
  ])("accepts terminal result %#", (result) => {
    expect(RunResultSchema.safeParse(result).success).toBe(true);
  });

  it("does not admit escalation as a terminal result", () => {
    expect(
      RunResultSchema.safeParse({
        status: "escalated",
        runId: "run-4",
        interventionId: "int-1",
        evidence: [],
      }).success,
    ).toBe(false);
  });
});
