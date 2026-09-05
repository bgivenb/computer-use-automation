import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { discoverCapability } from "../app/discover.js";
import { replayCompiled } from "../app/replay.js";
import { artifactDigest } from "../artifact/compiler.js";
import { createDemoProfile } from "../demo/profile.js";
import { startDemoServer, type DemoServerOptions } from "../demo/server.js";
import { ScriptedModelDriver } from "../discovery/scripted.js";

type Scenario = {
  name: string;
  memberId: string;
  fault?: DemoServerOptions["fault"];
  expected: string;
};
const scenarios: Scenario[] = [
  { name: "normal", memberId: "12345", expected: "success" },
  { name: "record-not-found", memberId: "00000", expected: "business_outcome:member-not-found" },
  { name: "transient-host-error", memberId: "77777", expected: "success" },
  { name: "permission-denied", memberId: "88888", expected: "failure:permission" },
  {
    name: "expired-session",
    memberId: "12345",
    fault: "session-expired",
    expected: "failure:permission",
  },
  {
    name: "host-validation",
    memberId: "12345",
    fault: "validation",
    expected: "business_outcome:validation-rejected",
  },
  { name: "slow-load", memberId: "12345", fault: "slow", expected: "success" },
  { name: "ambiguous-control", memberId: "12345", fault: "ambiguous", expected: "failure:locator" },
  { name: "hostile-page-text", memberId: "12345", fault: "page-injection", expected: "success" },
];

/** Measured local browser trials, deliberately separate from provider-backed discovery evidence. */
export const evaluateReplays = async (options: { repeat?: number; output?: string } = {}) => {
  const repeat = options.repeat ?? 3;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 10)
    throw new Error("Repeat must be 1–10");
  const root = resolve(".runs", `evaluation-${randomUUID()}`);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const base = await startDemoServer();
  const port = Number(new URL(base.origin).port);
  const profile = createDemoProfile(base.origin);
  const discovery = await discoverCapability({
    goal: "Prepare a synthetic savings account through review",
    origin: base.origin,
    profile,
    inputValues: profile.inputSamples,
    driver: new ScriptedModelDriver(),
    artifactPath: resolve(root, "fixture-artifact.json"),
    runsDirectory: root,
  }).finally(() => base.close());
  const trials = [];
  for (const scenario of scenarios) {
    const server = await startDemoServer({
      port,
      ...(scenario.fault ? { fault: scenario.fault } : {}),
    });
    try {
      for (let iteration = 0; iteration < repeat; iteration += 1) {
        const start = performance.now();
        const result = await replayCompiled({
          compiled: discovery.compiled,
          inputValues: { ...profile.inputSamples, memberId: scenario.memberId },
          runtimePermissions: profile.permissions,
          runsDirectory: root,
        });
        const terminal = result.result;
        const actual =
          terminal.status === "success"
            ? "success"
            : terminal.status === "business_outcome"
              ? `business_outcome:${terminal.code}`
              : `failure:${terminal.category}`;
        trials.push({
          scenario: scenario.name,
          iteration: iteration + 1,
          expected: scenario.expected,
          actual,
          passed: actual === scenario.expected,
          elapsedMs: Math.round(performance.now() - start),
          modelCalls: result.modelCalls,
          recoveries: result.signature.filter((step) => step.includes("branch:recover")).length,
          runId: terminal.runId,
          evidenceFiles: terminal.evidence.length,
        });
      }
    } finally {
      await server.close();
    }
  }
  const durations = trials.map((trial) => trial.elapsedMs).sort((a, b) => a - b);
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    fixture: "synthetic-legacy-bank",
    discoveryDriver: "scripted-fixture-not-provider",
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    artifactSha256: artifactDigest(discovery.compiled.artifact),
    trialCount: trials.length,
    passed: trials.filter((trial) => trial.passed).length,
    modelCallsDuringReplay: trials.reduce((sum, trial) => sum + trial.modelCalls, 0),
    p50Ms: durations[Math.ceil(durations.length * 0.5) - 1],
    p95Ms: durations[Math.ceil(durations.length * 0.95) - 1],
    limits:
      "Small sequential synthetic sample, not production reliability or a statistical confidence bound. Hostile-page trials exercise model-free replay, not live-model injection resistance. Timings include browser launch, execution, evidence and shutdown.",
    trials,
  };
  const destination = resolve(options.output ?? resolve(root, "report.json"));
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { destination, report };
};
