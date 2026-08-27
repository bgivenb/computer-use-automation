import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type DiscoverySummary, discoverCapability } from "../../src/app/discover.js";
import { prepareReplay, replayCompiled } from "../../src/app/replay.js";
import { runtimePermissionsFor } from "../../src/app/runtime.js";
import type { CompiledArtifact } from "../../src/artifact/compiler.js";
import {
  createDemoProfile,
  demoTargets,
  DEMO_ACCOUNT_NICKNAME,
  DEMO_MEMBER_ID,
} from "../../src/demo/profile.js";
import { type DemoServer, startDemoServer } from "../../src/demo/server.js";
import { ScriptedModelDriver } from "../../src/discovery/scripted.js";
import type { InterventionRequest } from "../../src/runtime/intervention.js";

const GOAL =
  "Look up the member, read the savings balance, and prepare a savings sub-account through review.";

let demo: DemoServer | undefined;
let temporaryRoot: string | undefined;
let compiled: CompiledArtifact | undefined;
let discoverySummary: DiscoverySummary | undefined;
let artifactPath: string | undefined;

beforeAll(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), "cua-system-"));
  demo = await startDemoServer({ port: 0 });
  artifactPath = join(temporaryRoot, "artifacts", "prepare-savings-subaccount.v1.json");

  const discovery = await discoverCapability({
    goal: GOAL,
    origin: demo.origin,
    profile: createDemoProfile(demo.origin),
    inputValues: {
      memberId: DEMO_MEMBER_ID,
      accountNickname: DEMO_ACCOUNT_NICKNAME,
    },
    driver: new ScriptedModelDriver(),
    artifactPath,
    runsDirectory: join(temporaryRoot, "discovery-runs"),
    headless: true,
  });

  compiled = discovery.compiled;
  discoverySummary = discovery.summary;
}, 30_000);

afterAll(async () => {
  await demo?.close();
  if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
});

describe("browser system", () => {
  it("discovers, compiles, and deterministically replays the happy path", async () => {
    const state = requireSystemState();
    const persistedArtifact = JSON.parse(await readFile(state.artifactPath, "utf8")) as unknown;

    expect(state.discoverySummary).toMatchObject({
      status: "success",
      provider: "scripted",
      artifactId: "prepare-savings-subaccount",
    });
    expect(state.discoverySummary.modelCalls).toBeGreaterThan(0);
    expect(persistedArtifact).toEqual(state.compiled.artifact);
    expect(state.compiled.artifact.steps).toHaveLength(8);
    expect(state.compiled.artifact.steps[0]?.command).toMatchObject({
      kind: "fill",
      value: "{{inputs.memberId}}",
    });
    expect(state.compiled.artifact.steps[6]?.command).toMatchObject({
      kind: "fill",
      value: "{{inputs.accountNickname}}",
    });

    const replay = await runReplay(state.compiled, {
      memberId: "12345",
      accountNickname: "Travel Fund",
    });

    expect(replay.modelCalls).toBe(0);
    expect(replay.result).toMatchObject({
      status: "success",
      outputs: {
        memberName: "Avery Morgan",
        savingsBalance: 12_450.67,
      },
    });
    expect(replay.signature.at(-1)).toBe("success|check:visible|true");
  }, 30_000);

  it("returns member-not-found as a business outcome", async () => {
    const { compiled: artifact } = requireSystemState();
    const replay = await runReplay(artifact, {
      memberId: "00000",
      accountNickname: "Unused",
    });

    expect(replay.modelCalls).toBe(0);
    expect(replay.result).toMatchObject({
      status: "business_outcome",
      code: "member-not-found",
      details: {},
    });
    expect(replay.signature).toContain("step-02|branch:return_outcome");
  }, 30_000);

  it("recovers the declared one-time transient failure", async () => {
    const { compiled: artifact } = requireSystemState();
    const replay = await runReplay(artifact, {
      memberId: "77777",
      accountNickname: "Emergency Fund",
    });

    expect(replay.result).toMatchObject({
      status: "success",
      outputs: {
        memberName: "Jordan Lee",
        savingsBalance: 7_777.77,
      },
    });
    expect(replay.signature).toContain("step-03|branch:recover");
    expect(replay.signature.filter((entry) => entry.startsWith("step-03|click|"))).toHaveLength(2);
  }, 30_000);

  it("hands the exact live session to a human and resumes it", async () => {
    const state = requireSystemState();
    const prepared = await prepareReplay({
      artifact: state.compiled.artifact,
      inputValues: {
        memberId: "99999",
        accountNickname: "Human Reviewed",
      },
      runtimePermissions: runtimePermissionsFor(state.demo.origin),
      runsDirectory: join(state.temporaryRoot, "handoff-runs"),
      headless: true,
    });

    try {
      const intervention = await waitForIntervention(() => prepared.coordinator.list());
      expect(intervention.sessionId).toBe(prepared.runtime.session.id);
      expect(prepared.runtime.session.owner).toBe("none");

      prepared.coordinator.claim(intervention.id);
      expect(prepared.runtime.session.owner).toBe("human");

      const dismiss = prepared.runtime.session.page
        .frameLocator('iframe[title="Member servicing workspace"]')
        .getByRole("button", { name: "Dismiss and continue", exact: true });
      const box = await dismiss.boundingBox();
      if (!box) throw new Error("Dismiss button has no visible bounding box");

      await prepared.coordinator.act(intervention.id, {
        kind: "click",
        x: box.x + box.width / 2,
        y: box.y + box.height / 2,
      });
      await prepared.runtime.session.page
        .frameLocator('iframe[title="Member servicing workspace"]')
        .getByRole("heading", { name: "Member Detail", exact: true })
        .waitFor();
      await prepared.coordinator.resume(intervention.id);

      const replay = await prepared.promise;
      expect(replay.result).toMatchObject({
        status: "success",
        outputs: {
          memberName: "Morgan Reyes",
          savingsBalance: 9_999.99,
        },
      });
      expect(prepared.runtime.session.id).toBe(intervention.sessionId);
      expect(prepared.coordinator.events(intervention.id).map(({ type }) => type)).toEqual([
        "intervention_created",
        "automation_released",
        "human_claimed",
        "human_action",
        "resume_verified",
        "human_released",
        "automation_claimed",
      ]);
    } finally {
      for (const intervention of prepared.coordinator.list()) {
        await prepared.coordinator.abort(intervention.id, "System test cleanup");
      }
      await prepared.promise.catch(() => undefined);
      await prepared.close();
    }
  }, 30_000);

  it("returns a structured failure when the non-interactive API encounters a handoff", async () => {
    const { compiled: artifact } = requireSystemState();
    const replay = await runReplay(artifact, {
      memberId: "99999",
      accountNickname: "Needs Operator",
    });

    expect(replay.result).toMatchObject({
      status: "failure",
      category: "surface",
      stepId: "step-03",
    });
  }, 30_000);

  it("produces the same execution signature across equivalent replays", async () => {
    const { compiled: artifact } = requireSystemState();
    const inputs = {
      memberId: "12345",
      accountNickname: "Signature Check",
    };

    const first = await runReplay(artifact, inputs);
    const second = await runReplay(artifact, inputs);

    expect(first.result.status).toBe("success");
    expect(second.result.status).toBe("success");
    expect(first.signature.length).toBeGreaterThan(0);
    expect(second.signature).toEqual(first.signature);
  }, 30_000);

  it("redacts sensitive outputs from persisted telemetry", async () => {
    const state = requireSystemState();
    const prepared = await prepareReplay({
      artifact: state.compiled.artifact,
      inputValues: { memberId: "12345", accountNickname: "Private Output" },
      runtimePermissions: runtimePermissionsFor(state.demo.origin),
      runsDirectory: join(state.temporaryRoot, "redaction-runs"),
      headless: true,
    });

    try {
      const replay = await prepared.promise;
      expect(replay.result).toMatchObject({
        status: "success",
        outputs: { memberName: "Avery Morgan", savingsBalance: 12_450.67 },
      });

      const persisted = [
        await readFile(join(prepared.runtime.runDirectory, "events.jsonl"), "utf8"),
        await readFile(join(prepared.runtime.runDirectory, "summary.json"), "utf8"),
      ].join("\n");
      expect(persisted).not.toContain("Avery Morgan");
      expect(persisted).not.toContain("12450.67");
      expect(persisted).toContain("[REDACTED:memberName]");
      expect(persisted).toContain("[REDACTED:savingsBalance]");
    } finally {
      await prepared.close();
    }
  }, 30_000);

  it("blocks a widened artifact from reaching the final create route", async () => {
    const state = requireSystemState();
    const artifact = structuredClone(state.compiled.artifact);
    artifact.permissions.routes = ["/", "/search", "/members/*"];
    artifact.steps.push({
      id: "step-09",
      description: "Attempt the forbidden final action",
      command: { kind: "click", target: demoTargets.createAccount },
      expect: [{ kind: "text", includes: "No account was created" }],
      timeoutMs: 2_000,
      risk: "safe",
    });

    const replay = await runReplay(
      { artifact, sha256: "runtime-recomputes-the-digest" },
      { memberId: "12345", accountNickname: "Must Not Exist" },
    );

    expect(replay.result).toMatchObject({
      status: "failure",
      category: "policy",
      stepId: "step-09",
    });
    expect(replay.signature.some((entry) => entry.startsWith("step-09|click|"))).toBe(false);
  }, 30_000);

  it("rejects an artifact origin that the caller did not trust before launch", async () => {
    const state = requireSystemState();
    const artifact = { ...state.compiled.artifact, entryUrl: "https://example.com/" };

    await expect(
      prepareReplay({
        artifact,
        inputValues: { memberId: "12345", accountNickname: "Untrusted" },
        runtimePermissions: runtimePermissionsFor(state.demo.origin),
      }),
    ).rejects.toThrow("does not trust the artifact entry URL");
  });

  it("validates extracted outputs against the declared contract", async () => {
    const state = requireSystemState();
    const artifact = structuredClone(state.compiled.artifact);
    const savingsOutput = artifact.contract.outputs.savingsBalance;
    if (!savingsOutput) throw new Error("Savings output fixture is missing");
    savingsOutput.value = {
      type: "string",
      description: "Deliberately incompatible test contract",
      sensitivity: "sensitive",
    };

    const replay = await runReplay(
      { artifact, sha256: "runtime-recomputes-the-digest" },
      { memberId: "12345", accountNickname: "Contract Check" },
    );

    expect(replay.result).toMatchObject({ status: "failure", category: "checkpoint" });
    if (replay.result.status !== "failure") throw new Error("Expected contract failure");
    expect(replay.result.message).toContain("savingsBalance");
  }, 30_000);
});

async function runReplay(artifact: CompiledArtifact, inputValues: Record<string, unknown>) {
  const { temporaryRoot: root } = requireSystemState();
  return replayCompiled({
    compiled: artifact,
    inputValues,
    runtimePermissions: runtimePermissionsFor(requireSystemState().demo.origin),
    runsDirectory: join(root, "replay-runs"),
    headless: true,
  });
}

async function waitForIntervention(
  current: () => InterventionRequest[],
): Promise<InterventionRequest> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const intervention = current()[0];
    if (intervention) return intervention;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Replay did not request human intervention");
}

function requireSystemState(): {
  demo: DemoServer;
  temporaryRoot: string;
  compiled: CompiledArtifact;
  discoverySummary: DiscoverySummary;
  artifactPath: string;
} {
  if (!demo || !temporaryRoot || !compiled || !discoverySummary || !artifactPath) {
    throw new Error("System test setup did not complete");
  }
  return { demo, temporaryRoot, compiled, discoverySummary, artifactPath };
}
