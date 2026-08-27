import { describe, expect, it } from "vitest";

import {
  effectiveCommandRisk,
  evaluatePolicy,
  routeMatches,
  type Policy,
} from "../../src/core/policy.js";

const policy: Policy = {
  layers: [
    {
      name: "runtime",
      permissions: {
        origins: ["http://127.0.0.1:4173"],
        routes: ["/members/*", "/health"],
        actions: ["navigate", "click", "fill", "read", "wait"],
      },
    },
    {
      name: "artifact",
      permissions: {
        origins: ["http://127.0.0.1:4173"],
        routes: ["/members/*"],
        actions: ["click", "fill", "read", "wait"],
      },
    },
  ],
  irreversibleActions: "intervene",
};

describe("routeMatches", () => {
  it("matches exact routes and segment-bounded prefixes", () => {
    expect(routeMatches("/health", "/health")).toBe(true);
    expect(routeMatches("/members/12345", "/members/*")).toBe(true);
    expect(routeMatches("/members", "/members/*")).toBe(true);
    expect(routeMatches("/membership", "/members/*")).toBe(false);
    expect(routeMatches("/members/12345", "/members/:memberId")).toBe(true);
    expect(routeMatches("/members/12345/edit", "/members/:memberId")).toBe(false);
  });
});

describe("effectiveCommandRisk", () => {
  it("does not let a declared label downgrade an irreversible target", () => {
    expect(
      effectiveCommandRisk(
        {
          kind: "click",
          target: {
            description: "final action",
            whyRobust: "accessible name",
            strategies: [{ kind: "role", role: "button", name: "Create account" }],
          },
        },
        "safe",
      ),
    ).toBe("irreversible");
  });

  it("uses inspected live target semantics for CSS-only clicks", () => {
    expect(
      effectiveCommandRisk(
        {
          kind: "click",
          target: {
            description: "primary action",
            whyRobust: "stable class",
            strategies: [{ kind: "css", selector: ".primary-action" }],
          },
        },
        "safe",
        "button submit Create account https://trusted.test/accounts/create",
      ),
    ).toBe("irreversible");
  });
});

describe("evaluatePolicy", () => {
  it("allows only when every policy layer allows", () => {
    expect(
      evaluatePolicy(policy, {
        action: "read",
        url: "http://127.0.0.1:4173/members/12345?tab=accounts",
        risk: "safe",
      }),
    ).toEqual({ decision: "allow" });
  });

  it("prevents a broader runtime policy from widening the artifact", () => {
    expect(
      evaluatePolicy(policy, {
        action: "navigate",
        url: "http://127.0.0.1:4173/members/12345",
        risk: "safe",
      }),
    ).toMatchObject({
      decision: "deny",
      code: "action_not_allowed",
      layer: "artifact",
    });

    expect(
      evaluatePolicy(policy, {
        action: "read",
        url: "http://127.0.0.1:4173/health",
        risk: "safe",
      }),
    ).toMatchObject({
      decision: "deny",
      code: "route_not_allowed",
      layer: "artifact",
    });
  });

  it("rejects other origins and embedded URL credentials", () => {
    expect(
      evaluatePolicy(policy, {
        action: "read",
        url: "https://example.com/members/12345",
        risk: "safe",
      }),
    ).toMatchObject({ decision: "deny", code: "origin_not_allowed" });

    expect(
      evaluatePolicy(policy, {
        action: "read",
        url: "http://user:password@127.0.0.1:4173/members/12345",
        risk: "safe",
      }),
    ).toMatchObject({ decision: "deny", code: "invalid_url" });
  });

  it("routes irreversible actions to a human after allowlist checks", () => {
    expect(
      evaluatePolicy(policy, {
        action: "click",
        url: "http://127.0.0.1:4173/members/12345",
        risk: "irreversible",
      }),
    ).toEqual({
      decision: "intervene",
      code: "irreversible_action",
      reason: "Irreversible actions require a human controller",
    });
  });

  it("can categorically deny irreversible actions", () => {
    expect(
      evaluatePolicy(
        { ...policy, irreversibleActions: "deny" },
        {
          action: "click",
          url: "http://127.0.0.1:4173/members/12345",
          risk: "irreversible",
        },
      ),
    ).toMatchObject({ decision: "deny", code: "irreversible_action" });
  });
});
