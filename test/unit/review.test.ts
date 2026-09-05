import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  approveArtifact,
  verifyApproval,
  reviewerKeys,
  diffArtifacts,
} from "../../src/artifact/review.js";
import { CapabilityArtifactSchema } from "../../src/core/contracts.js";
import { artifactDigest } from "../../src/artifact/compiler.js";

const artifact = CapabilityArtifactSchema.parse(
  JSON.parse(readFileSync("artifacts/examples/prepare-savings-subaccount.v1.json", "utf8")),
);
const keys = reviewerKeys();
const now = new Date("2026-09-05T00:00:00Z");
const approval = approveArtifact({
  artifact,
  policy: artifact.permissions,
  reviewer: "Test reviewer",
  reason: "Reviewed synthetic workflow and policy",
  privateKey: keys.privateKey,
  now,
});
const verify = (overrides: Partial<Parameters<typeof verifyApproval>[0]> = {}) =>
  verifyApproval({
    artifact,
    policy: artifact.permissions,
    approval,
    trustedPublicKey: keys.publicKey,
    now,
    ...overrides,
  });

describe("review trust boundary", () => {
  it("verifies a signed exact artifact and policy", () => {
    expect(verify()).toEqual(approval);
  });
  it("rejects a different trust root", () => {
    expect(() => verify({ trustedPublicKey: reviewerKeys().publicKey })).toThrow("not trusted");
  });
  it("rejects policy changes including narrowing until reviewed again", () => {
    expect(() => verify({ policy: { ...artifact.permissions, routes: ["/"] } })).toThrow(
      "policy changed",
    );
  });
  it("rejects expiration and future receipts", () => {
    expect(() => verify({ now: new Date("2026-09-06T00:00:00Z") })).toThrow("expired");
    expect(() => verify({ now: new Date("2026-09-04T23:59:59Z") })).toThrow("validity");
  });
  it("rejects tampered attribution", () => {
    expect(() =>
      verify({ approval: { ...approval, body: { ...approval.body, reviewer: "Someone else" } } }),
    ).toThrow("not trusted");
  });
  it("rejects every generated artifact mutation", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 120 }), (suffix) => {
        expect(() =>
          verify({ artifact: { ...artifact, description: artifact.description + suffix } }),
        ).toThrow("changed after approval");
      }),
      { seed: 20260905, numRuns: 100 },
    );
  });
  it("uses the schema to normalize object order while preserving step order", () => {
    const reordered = Object.fromEntries(Object.entries(artifact).reverse());
    expect(artifactDigest(CapabilityArtifactSchema.parse(reordered))).toBe(
      artifactDigest(artifact),
    );
    expect(diffArtifacts(artifact, reordered)).toMatchObject({ changed: false, delta: null });
    expect(
      diffArtifacts(artifact, { ...artifact, steps: [...artifact.steps].reverse() }),
    ).toMatchObject({ changed: true });
  });
  it("bounds approval lifetime", () => {
    expect(() =>
      approveArtifact({
        artifact,
        policy: artifact.permissions,
        reviewer: "Test",
        reason: "Reviewed policy",
        privateKey: keys.privateKey,
        validHours: 169,
      }),
    ).toThrow("1–168");
  });
});
