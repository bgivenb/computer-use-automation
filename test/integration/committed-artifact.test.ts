import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { artifactDigest } from "../../src/artifact/compiler.js";
import { CapabilityArtifactSchema } from "../../src/core/contracts.js";

describe("committed provider-discovered artifact", () => {
  it("matches curated evidence and contains no discovery samples or final action", async () => {
    const [artifactText, evidenceText, summaryText] = await Promise.all([
      readFile("artifacts/examples/prepare-savings-subaccount.v1.json", "utf8"),
      readFile("evidence/discovery/artifact.json", "utf8"),
      readFile("evidence/discovery/summary.json", "utf8"),
    ]);
    const artifact = CapabilityArtifactSchema.parse(JSON.parse(artifactText));
    const summary = JSON.parse(summaryText) as { artifactSha256: string; runId: string };

    expect(JSON.parse(evidenceText)).toEqual(artifact);
    expect(artifactDigest(artifact)).toBe(summary.artifactSha256);
    expect(artifact.discoveryRunId).toBe(summary.runId);
    expect(artifact.steps).toHaveLength(8);
    expect(artifactText).not.toMatch(/12345|Rainy Day|Avery Morgan|Create account/);

    const reads = artifact.steps.filter(({ command }) => command.kind === "read");
    expect(reads).toHaveLength(2);
    for (const step of reads) {
      if (step.command.kind !== "read") throw new Error("Expected a read command");
      expect(step.command.target.strategies.every(({ kind }) => kind === "css")).toBe(true);
    }
  });
});
