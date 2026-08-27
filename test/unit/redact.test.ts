import { describe, expect, it } from "vitest";

import { redactText, redactValue, toRedactedJson } from "../../src/core/redact.js";

describe("redactText", () => {
  it("redacts configured values before common secrets and PII", () => {
    const redacted = redactText(
      "Ada Lovelace (ada@example.test), member id: 12345, Bearer abcdefghijklmno",
      {
        sensitiveValues: {
          memberName: "Ada Lovelace",
          memberId: "12345",
        },
      },
    );

    expect(redacted).toBe(
      "[REDACTED:memberName] ([REDACTED:email]), member id: [REDACTED:memberId], Bearer [REDACTED:token]",
    );
  });

  it("redacts common credential, SSN, and card formats", () => {
    const redacted = redactText(
      "password=hunter2 ssn 123-45-6789 card 4111 1111 1111 1111 sk-exampletoken123",
    );

    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("123-45-6789");
    expect(redacted).not.toContain("4111 1111 1111 1111");
    expect(redacted).not.toContain("sk-exampletoken123");
  });

  it("preserves typed artifact identifiers", () => {
    expect(redactText("member-name savings-balance member_id=12345")).toBe(
      "member-name savings-balance member_id=[REDACTED:identifier]",
    );
  });
});

describe("redactValue", () => {
  it("deeply redacts configured keys without mutating its input", () => {
    const source = {
      memberId: "12345",
      profile: {
        displayName: "Ada Lovelace",
        password: "hunter2",
        note: "Contact ada@example.test",
      },
      values: ["safe", "Bearer abcdefghijklmno"],
    };

    const redacted = redactValue(source, {
      sensitiveKeys: ["displayName"],
    });

    expect(redacted).toEqual({
      memberId: "[REDACTED:memberId]",
      profile: {
        displayName: "[REDACTED:displayName]",
        password: "[REDACTED:password]",
        note: "Contact [REDACTED:email]",
      },
      values: ["safe", "Bearer [REDACTED:token]"],
    });
    expect(source.memberId).toBe("12345");
    expect(source.profile.password).toBe("hunter2");
  });

  it("produces JSON with no invocation-specific values", () => {
    const json = toRedactedJson(
      { message: "Opened account for Ada Lovelace with id 12345" },
      { sensitiveValues: { memberName: "Ada Lovelace", memberId: "12345" } },
    );

    expect(json).not.toContain("Ada Lovelace");
    expect(json).not.toContain("12345");
    expect(json).toContain("[REDACTED:memberName]");
  });

  it("preserves repeated references while still breaking cycles", () => {
    const shared = { label: "safe" };
    const repeated = redactValue({ left: shared, right: shared });
    expect(repeated).toEqual({ left: { label: "safe" }, right: { label: "safe" } });

    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(redactValue(cyclic)).toEqual({ self: "[REDACTED:circular]" });
  });
});
