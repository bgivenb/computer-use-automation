import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi } from "vitest";
import { discoverCapability } from "../../src/app/discover.js";
import { replayCompiled } from "../../src/app/replay.js";
import { createDemoProfile, demoTargets } from "../../src/demo/profile.js";
import { startDemoServer } from "../../src/demo/server.js";
import { ScriptedModelDriver } from "../../src/discovery/scripted.js";
import type { ModelDriver } from "../../src/discovery/driver.js";

describe("bounded exploration and discovery handoff", () => {
  it("refuses an existing artifact before calling the provider", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "cua-existing-"));
    try {
      const destination = join(temporary, "draft.json");
      await writeFile(destination, "existing content");
      const profile = createDemoProfile("http://127.0.0.1:1");
      const driver = new ScriptedModelDriver();
      const decide = vi.spyOn(driver, "decide");
      await expect(
        discoverCapability({
          goal: "Preserve the existing artifact",
          origin: "http://127.0.0.1:1",
          profile,
          inputValues: profile.inputSamples,
          driver,
          artifactPath: destination,
          runsDirectory: temporary,
        }),
      ).rejects.toThrow("already exists");
      expect(decide).not.toHaveBeenCalled();
      expect(await readFile(destination, "utf8")).toBe("existing content");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("rejects a model-invented checkpoint even when it would pass on the page", async () => {
    const server = await startDemoServer();
    const temporary = await mkdtemp(join(tmpdir(), "cua-catalog-"));
    try {
      const profile = createDemoProfile(server.origin);
      profile.mode = "explore";
      profile.steps = [];
      const driver: ModelDriver = {
        name: "adversarial-fixture",
        model: "fixture-not-provider",
        decide: async () => ({
          type: "act",
          reason: "Try to replace reviewed success semantics",
          command: { kind: "wait", until: { kind: "visible", target: demoTargets.search } },
          checkpoint: { kind: "url", path: new URL(profile.entryUrl).pathname },
        }),
      };
      const destination = join(temporary, "draft.json");
      await expect(
        discoverCapability({
          goal: "Prepare the synthetic account",
          origin: server.origin,
          profile,
          inputValues: profile.inputSamples,
          driver,
          artifactPath: destination,
          runsDirectory: temporary,
        }),
      ).rejects.toThrow("not in the reviewed catalog");
      await expect(readFile(destination)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("chooses a different action count without the guided sequence and compiles a replayable draft", async () => {
    const server = await startDemoServer();
    const temporary = await mkdtemp(join(tmpdir(), "cua-explore-"));
    try {
      const profile = createDemoProfile(server.origin);
      const reviewed = profile.steps;
      profile.checkpoints = reviewed.flatMap((step) => step.expect);
      profile.mode = "explore";
      profile.steps = []; // No prescribed sequence reaches the runner or model prompt.
      const fixture = new ScriptedModelDriver();
      const driver: ModelDriver = {
        name: "scripted-exploration-test",
        model: "fixture-not-provider",
        decide: async (prompt) => {
          expect(prompt.nextStep).toBeUndefined();
          if (prompt.history.length === 0)
            return {
              type: "act",
              reason: "Observe the initial search checkpoint",
              command: { kind: "wait", until: { kind: "visible", target: demoTargets.search } },
              checkpoint: { kind: "visible", target: demoTargets.search },
            };
          const result = await fixture.decide(prompt);
          if (result.type !== "act") return result;
          const checkpoint =
            prompt.history.length === 1
              ? { kind: "visible" as const, target: demoTargets.search }
              : reviewed[prompt.history.length - 2]?.expect[0];
          if (!checkpoint) throw new Error("Fixture checkpoint missing");
          return { ...result, checkpoint };
        },
      };
      const result = await discoverCapability({
        goal: "Prepare the synthetic savings account through review",
        origin: server.origin,
        profile,
        inputValues: profile.inputSamples,
        driver,
        artifactPath: join(temporary, "draft.json"),
        runsDirectory: temporary,
      });
      expect(result.summary).toMatchObject({ discoveryMode: "explore", artifactStatus: "draft" });
      expect(result.compiled.artifact.steps).toHaveLength(9);
      const replay = await replayCompiled({
        compiled: result.compiled,
        inputValues: profile.inputSamples,
        runtimePermissions: profile.permissions,
        runsDirectory: temporary,
      });
      expect(replay.result.status).toBe("success");
      expect(replay.modelCalls).toBe(0);
    } finally {
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("pauses a failed discovery checkpoint, verifies human repair and resumes the same page", async () => {
    const server = await startDemoServer();
    const temporary = await mkdtemp(join(tmpdir(), "cua-discovery-handoff-"));
    let operatorWork: Promise<void> | undefined;
    try {
      const profile = createDemoProfile(server.origin);
      const detailStep = profile.steps[2];
      if (!detailStep) throw new Error("Missing fixture step");
      detailStep.timeoutMs = 100;
      const result = await discoverCapability({
        goal: "Prepare the synthetic account through review",
        origin: server.origin,
        profile,
        inputValues: { ...profile.inputSamples, memberId: "99999" },
        driver: new ScriptedModelDriver(),
        artifactPath: join(temporary, "draft.json"),
        runsDirectory: temporary,
        onRuntimeReady: async (runtime, coordinator) => {
          const originalPage = runtime.session.page;
          operatorWork = (async () => {
            const deadline = Date.now() + 10_000;
            while (!coordinator.list().length && Date.now() < deadline)
              await new Promise((resolve) => setTimeout(resolve, 10));
            const request = coordinator.list()[0];
            if (!request) throw new Error("No intervention received");
            expect(runtime.session.owner).toBe("none");
            coordinator.claim(request.id);
            await expect(coordinator.resume(request.id)).rejects.toThrow("checkpoint");
            const button = originalPage
              .frameLocator('iframe[title="Member servicing workspace"]')
              .getByRole("button", { name: "Dismiss and continue", exact: true });
            const box = await button.boundingBox();
            if (!box) throw new Error("Missing live operator control");
            await coordinator.act(request.id, {
              kind: "click",
              x: box.x + box.width / 2,
              y: box.y + box.height / 2,
            });
            await originalPage
              .frameLocator('iframe[title="Member servicing workspace"]')
              .getByRole("heading", { name: "Member Detail", exact: true })
              .waitFor();
            await coordinator.resume(request.id);
            expect(runtime.session.page).toBe(originalPage);
          })();
        },
      });
      await operatorWork;
      expect(result.summary.status).toBe("success");
      const events = await readFile(join(result.runDirectory, "events.jsonl"), "utf8");
      expect(events).toContain('"type":"human.action"');
      expect(events).toContain('"state":"resumed"');
    } finally {
      await operatorWork?.catch(() => undefined);
      await server.close();
      await rm(temporary, { recursive: true, force: true });
    }
  });
});
