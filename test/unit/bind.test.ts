import { describe, expect, it } from "vitest";
import { bindCommand, bindTemplate, parameterizeCommand } from "../../src/artifact/bind.js";
import { compileArtifact, type CapabilityProfile } from "../../src/artifact/compiler.js";

describe("artifact input bindings", () => {
  it("binds camelCase input names", () => {
    expect(
      bindTemplate("member={{inputs.memberId}}&name={{ inputs.accountNickname }}", {
        memberId: "12345",
        accountNickname: "Rainy Day",
      }),
    ).toBe("member=12345&name=Rainy Day");
  });

  it("round-trips a discovered sample through parameterization", () => {
    const parameterized = parameterizeCommand(
      { kind: "fill", target: target, value: "Rainy Day" },
      { accountNickname: "Rainy Day" },
    );

    expect(parameterized).toMatchObject({ value: "{{inputs.accountNickname}}" });
    expect(bindCommand(parameterized, { accountNickname: "Reserve" })).toMatchObject({
      value: "Reserve",
    });
  });

  it("parameterizes the exact invocation values rather than stale profile samples", () => {
    const profile: CapabilityProfile = {
      id: "test-capability",
      revision: 1,
      name: "Test capability",
      description: "Exercise compiler parameterization",
      app: { family: "test-app", version: "1", surface: "web" },
      entryUrl: "https://example.test/",
      inputs: {
        memberId: {
          type: "string",
          description: "Member ID",
          sensitivity: "sensitive",
        },
      },
      inputSamples: { memberId: "12345" },
      outputs: {},
      businessOutcomes: [],
      permissions: { origins: ["https://example.test"], routes: ["/"], actions: ["fill"] },
      steps: [
        {
          kind: "fill",
          description: "Fill member ID",
          expect: [{ kind: "visible", target }],
          risk: "reversible",
        },
      ],
      success: [{ kind: "visible", target }],
    };
    const compiled = compileArtifact(
      {
        runId: "run-1",
        goal: "Test",
        actions: [
          {
            command: { kind: "fill", target, value: "54321" },
            receipt: {
              action: "fill",
              ok: true,
              durationMs: 1,
              urlBefore: "https://example.test/",
              urlAfter: "https://example.test/",
            },
          },
        ],
      },
      profile,
      { memberId: "54321" },
    );

    expect(compiled.artifact.steps[0]?.command).toMatchObject({
      kind: "fill",
      value: "{{inputs.memberId}}",
    });
    expect(JSON.stringify(compiled.artifact)).not.toContain("54321");
  });
});

const target = {
  description: "nickname",
  whyRobust: "stable form name",
  strategies: [{ kind: "css" as const, selector: 'input[name="accountNickname"]' }],
};
