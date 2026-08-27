import { relative, resolve } from "node:path";
import { validateInputs } from "../artifact/bind.js";
import {
  artifactDigest,
  compileArtifact,
  writeArtifact,
  type CapabilityProfile,
  type CompiledArtifact,
} from "../artifact/compiler.js";
import type { Policy } from "../core/policy.js";
import type { ModelDriver } from "../discovery/driver.js";
import { runDiscovery } from "../discovery/runner.js";
import { createRuntimeContext, runtimePermissionsFor, writeJson } from "./runtime.js";

export type DiscoverySummary = {
  status: "success";
  runId: string;
  provider: string;
  model: string;
  modelCalls: number;
  artifactId: string;
  artifactRevision: number;
  artifactSha256: string;
  artifactPath: string;
};

export const discoverCapability = async (options: {
  goal: string;
  origin: string;
  profile: CapabilityProfile;
  inputValues: Record<string, unknown>;
  driver: ModelDriver;
  artifactPath: string;
  runsDirectory?: string;
  headless?: boolean;
}): Promise<{ compiled: CompiledArtifact; summary: DiscoverySummary; runDirectory: string }> => {
  const inputs = validateInputs(options.profile.inputs, options.inputValues);
  const redaction = {
    sensitiveValues: inputs,
  };
  const runtimePermissions = runtimePermissionsFor(options.origin);
  const runtime = await createRuntimeContext({
    runtimePermissions,
    ...(options.runsDirectory === undefined ? {} : { runsDirectory: options.runsDirectory }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    redaction,
  });

  try {
    const policy: Policy = {
      layers: [
        { name: "runtime", permissions: runtimePermissions },
        { name: "capability-profile", permissions: options.profile.permissions },
      ],
      irreversibleActions: "intervene",
    };
    const discovery = await runDiscovery({
      runId: runtime.runId,
      goal: options.goal,
      profile: options.profile,
      inputValues: inputs,
      model: options.driver,
      surface: runtime.surface,
      policy,
      recorder: runtime.recorder,
    });
    const compiled = compileArtifact(discovery.trace, options.profile, inputs);
    await writeArtifact(options.artifactPath, compiled.artifact);
    await runtime.recorder.record(
      { phase: "compile", actor: { type: "system" }, capabilityId: compiled.artifact.id },
      {
        type: "artifact.compiled",
        data: {
          artifactId: compiled.artifact.id,
          revision: compiled.artifact.revision,
          path: options.artifactPath,
        },
      },
    );

    const summary: DiscoverySummary = {
      status: "success",
      runId: runtime.runId,
      provider: options.driver.name,
      model: discovery.model,
      modelCalls: discovery.modelCalls,
      artifactId: compiled.artifact.id,
      artifactRevision: compiled.artifact.revision,
      artifactSha256: artifactDigest(compiled.artifact),
      artifactPath: (() => {
        const path = relative(process.cwd(), resolve(options.artifactPath));
        return path.startsWith("..") ? "[external-artifact]" : path;
      })(),
    };
    await writeJson(resolve(runtime.runDirectory, "summary.json"), summary);
    return { compiled, summary, runDirectory: runtime.runDirectory };
  } finally {
    await runtime.close();
  }
};
