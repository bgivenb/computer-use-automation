import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { projectCommand } from "../../src/app/project-cli.js";
import { discoverCapability } from "../../src/app/discover.js";
import { createDemoProfile } from "../../src/demo/profile.js";
import { startDemoServer } from "../../src/demo/server.js";
import { ScriptedModelDriver } from "../../src/discovery/scripted.js";
import { RunSession } from "../../src/runtime/session.js";

it("inspects, signs and invokes a capability; rejects a modified policy before browser launch", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "cua-review-"));
  const server = await startDemoServer();
  try {
    const profile = createDemoProfile(server.origin);
    const artifactPath = join(temporary, "draft.json");
    await discoverCapability({
      goal: "Prepare the synthetic account through review",
      origin: server.origin,
      profile,
      inputValues: profile.inputSamples,
      driver: new ScriptedModelDriver(),
      artifactPath,
      runsDirectory: temporary,
    });
    const policyPath = join(temporary, "policy.json");
    const inputsPath = join(temporary, "inputs.json");
    await writeFile(policyPath, JSON.stringify(profile.permissions));
    await writeFile(inputsPath, JSON.stringify(profile.inputSamples));
    const keyDirectory = join(temporary, "keys");
    await projectCommand("keygen", ["--directory", keyDirectory]);
    const approvalPath = join(temporary, "approval.json");
    await projectCommand("approve", [
      "--artifact",
      artifactPath,
      "--policy",
      policyPath,
      "--key",
      join(keyDirectory, "reviewer-private.pem"),
      "--reviewer",
      "Synthetic test reviewer",
      "--reason",
      "Reviewed synthetic target and exact runtime policy",
      "--out",
      approvalPath,
    ]);
    const args = [
      "--artifact",
      artifactPath,
      "--policy",
      policyPath,
      "--inputs",
      inputsPath,
      "--approval",
      approvalPath,
      "--trusted-key",
      join(keyDirectory, "reviewer-public.pem"),
    ];
    const result = await projectCommand("run", args);
    expect(result).toMatchObject({ result: { status: "success" }, modelCalls: 0 });
    const approval = JSON.parse(await readFile(approvalPath, "utf8"));
    expect(approval.body.reviewer).toBe("Synthetic test reviewer");
    await writeFile(policyPath, JSON.stringify({ ...profile.permissions, routes: ["/"] }));
    const launch = vi.spyOn(RunSession, "launch");
    try {
      await expect(projectCommand("run", args)).rejects.toThrow("policy changed");
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  } finally {
    await server.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
