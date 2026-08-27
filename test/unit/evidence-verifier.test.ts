import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyEvidence } from "../../src/evidence/verify.js";

const temporaryRoots: string[] = [];

async function temporaryRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cua-evidence-"));
  temporaryRoots.push(root);
  await mkdir(join(root, "evidence"), { recursive: true });
  return root;
}

async function put(root: string, relativePath: string, content: string): Promise<string> {
  const destination = join(root, relativePath);
  await mkdir(dirname(destination), { recursive: true });
  await writeFile(destination, content, "utf8");
  return createHash("sha256").update(content).digest("hex");
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("evidence verification", () => {
  it("accepts an explicitly pending empty manifest", async () => {
    const root = await temporaryRepo();
    await put(
      root,
      "evidence/manifest.json",
      JSON.stringify({
        schemaVersion: "1.0",
        status: "pending",
        syntheticDataOnly: true,
        note: "Live evidence has not been collected.",
        scenarios: [],
      }),
    );

    await expect(verifyEvidence(root)).resolves.toEqual({
      status: "pending",
      scenarioCount: 0,
      checkedFileCount: 0,
      issues: [],
    });
  });

  it("validates hashes, events, model calls, and discovery provenance", async () => {
    const root = await temporaryRepo();
    const runId = "run-discovery-1";
    const events = `${JSON.stringify({
      eventVersion: "1.0",
      timestamp: "2026-08-26T20:00:00.000Z",
      runId,
      sequence: 1,
      phase: "discovery",
      actor: { type: "model" },
      type: "model.decided",
      data: { decision: { type: "finish", reason: "The review checkpoint is visible." } },
    })}\n`;
    const summary = `${JSON.stringify({ runId, status: "success", modelCalls: 1 })}\n`;
    const artifact = `${JSON.stringify({
      schemaVersion: "1.0",
      id: "test_capability",
      revision: 1,
      name: "Test capability",
      description: "A minimal valid artifact used by the evidence verifier test.",
      discoveryRunId: runId,
      app: { family: "legacy_bank", version: "1.0", surface: "web" },
      entryUrl: "http://127.0.0.1:4173/",
      contract: { inputs: {}, outputs: {}, businessOutcomes: [] },
      permissions: {
        origins: ["http://127.0.0.1:4173"],
        routes: ["/"],
        actions: ["navigate"],
      },
      steps: [
        {
          id: "open",
          description: "Open the synthetic application.",
          command: { kind: "navigate", url: "http://127.0.0.1:4173/" },
          expect: [{ kind: "url", path: "/" }],
          timeoutMs: 1_000,
          risk: "safe",
        },
      ],
      success: [{ kind: "url", path: "/" }],
    })}\n`;
    const eventHash = await put(root, "evidence/discovery/events.jsonl", events);
    const summaryHash = await put(root, "evidence/discovery/summary.json", summary);
    const artifactHash = await put(root, "evidence/discovery/artifact.json", artifact);
    await put(
      root,
      "evidence/manifest.json",
      JSON.stringify({
        schemaVersion: "1.0",
        status: "collecting",
        syntheticDataOnly: true,
        note: "Partial evidence under validation.",
        scenarios: [
          {
            id: "discovery",
            kind: "discovery",
            runId,
            command: "npm run discover -- --fixture synthetic",
            expectedStatus: "success",
            modelCalls: 1,
            files: [
              {
                path: "evidence/discovery/events.jsonl",
                sha256: eventHash,
                role: "events",
              },
              {
                path: "evidence/discovery/summary.json",
                sha256: summaryHash,
                role: "summary",
              },
              {
                path: "evidence/discovery/artifact.json",
                sha256: artifactHash,
                role: "artifact",
              },
            ],
          },
        ],
      }),
    );

    const result = await verifyEvidence(root);
    expect(result.status).toBe("collecting");
    expect(result.checkedFileCount).toBe(3);
    expect(result.issues).toEqual([]);
  });

  it("rejects model activity in replay evidence", async () => {
    const root = await temporaryRepo();
    const runId = "run-replay-1";
    const events = `${JSON.stringify({
      eventVersion: "1.0",
      timestamp: "2026-08-26T20:00:00.000Z",
      runId,
      sequence: 0,
      phase: "replay",
      actor: { type: "model" },
      type: "model.decided",
      data: { decision: { type: "finish", reason: "This must never happen in replay." } },
    })}\n`;
    const resultJson = `${JSON.stringify({
      runId,
      status: "success",
      modelCalls: 0,
      outputs: {},
      evidence: [],
    })}\n`;
    const eventHash = await put(root, "evidence/replay/events.jsonl", events);
    const resultHash = await put(root, "evidence/replay/result.json", resultJson);
    await put(
      root,
      "evidence/manifest.json",
      JSON.stringify({
        schemaVersion: "1.0",
        status: "collecting",
        syntheticDataOnly: true,
        note: "Partial evidence under validation.",
        scenarios: [
          {
            id: "replay",
            kind: "replay-success",
            runId,
            command: "npm run replay",
            expectedStatus: "success",
            modelCalls: 0,
            files: [
              { path: "evidence/replay/events.jsonl", sha256: eventHash, role: "events" },
              { path: "evidence/replay/result.json", sha256: resultHash, role: "result" },
            ],
          },
        ],
      }),
    );

    const result = await verifyEvidence(root);
    expect(result.status).toBe("invalid");
    expect(result.issues).toContainEqual({
      path: "evidence/replay/events.jsonl",
      message: "contains 1 model-authored events; manifest declares 0 modelCalls",
    });
  });
});
