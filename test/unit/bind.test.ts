import { describe, expect, it } from "vitest";
import { bindCommand, bindTemplate, parameterizeCommand } from "../../src/artifact/bind.js";

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
});

const target = {
  description: "nickname",
  whyRobust: "stable form name",
  strategies: [{ kind: "css" as const, selector: 'input[name="accountNickname"]' }],
};
