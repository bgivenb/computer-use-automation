import { relative, resolve } from "node:path";
import { lstat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { validateInputs } from "../artifact/bind.js";
import {
  artifactDigest,
  compileArtifact,
  writeArtifact,
  type CapabilityProfile,
  type CompiledArtifact,
} from "../artifact/compiler.js";
import type { Policy } from "../core/policy.js";
import type { PermissionSet } from "../core/contracts.js";
import { redactValue } from "../core/redact.js";
import { CapabilityProfileSchema } from "../artifact/profile.js";
import { InterventionCoordinator } from "../runtime/intervention.js";
import type { ModelDriver } from "../discovery/driver.js";
import { runDiscovery } from "../discovery/runner.js";
import {
  createRuntimeContext,
  runtimePermissionsFor,
  writeJson,
  type RuntimeContext,
} from "./runtime.js";

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
  discoveryMode?: "guided" | "explore";
  artifactStatus?: "draft";
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
  runtimePermissions?: PermissionSet;
  onRuntimeReady?: (runtime: RuntimeContext, coordinator: InterventionCoordinator) => Promise<void>;
  interventionTimeoutMs?: number;
}): Promise<{ compiled: CompiledArtifact; summary: DiscoverySummary; runDirectory: string }> => {
  const profile = CapabilityProfileSchema.parse(options.profile);
  await lstat(resolve(options.artifactPath)).then(
    () => {
      throw new Error("Artifact destination already exists; choose a new revision path");
    },
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  const inputs = validateInputs(profile.inputs, options.inputValues);
  const redaction = {
    sensitiveValues: inputs,
  };
  const runtimePermissions = options.runtimePermissions ?? runtimePermissionsFor(options.origin);
  const runtime = await createRuntimeContext({
    runtimePermissions,
    ...(options.runsDirectory === undefined ? {} : { runsDirectory: options.runsDirectory }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    redaction,
  });

  const coordinator = new InterventionCoordinator();
  try {
    await options.onRuntimeReady?.(runtime, coordinator);
    const policy: Policy = {
      layers: [
        { name: "runtime", permissions: runtimePermissions },
        { name: "capability-profile", permissions: profile.permissions },
      ],
      irreversibleActions: "intervene",
    };
    const discovery = await runDiscovery({
      runId: runtime.runId,
      goal: options.goal,
      profile,
      inputValues: inputs,
      model: options.driver,
      surface: runtime.surface,
      policy,
      recorder: runtime.recorder,
      ...(options.onRuntimeReady
        ? {
            onBlocked: async (reason, conditions, stepId) => {
              const screenshot = await runtime.surface.capture(`discovery-handoff-${stepId}`);
              const handle = coordinator.request({
                session: runtime.session,
                runId: runtime.runId,
                capabilityId: profile.id,
                stepId,
                goal: options.goal,
                reason: "stuck",
                summary: reason,
                verifyResume: async () => {
                  for (const condition of conditions)
                    if (!(await runtime.surface.humanCheck(condition))) return false;
                  return true;
                },
              });
              await writeJson(
                resolve(runtime.runDirectory, `intervention-${handle.request.id}.json`),
                redactValue({ ...handle.request, evidence: [screenshot] }, redaction),
              );
              await runtime.recorder.record(
                { phase: "handoff", actor: { type: "system" }, capabilityId: profile.id, stepId },
                {
                  type: "intervention.changed",
                  data: {
                    interventionId: handle.request.id,
                    state: "requested",
                    reason: "stuck",
                    summary: reason,
                  },
                },
              );
              const timeout = new AbortController();
              const expiry = delay(options.interventionTimeoutMs ?? 120_000, undefined, {
                signal: timeout.signal,
              })
                .then(async () => {
                  if (coordinator.get(handle.request.id))
                    await coordinator.abort(handle.request.id, "Discovery intervention timed out");
                })
                .catch((error: unknown) => {
                  if (!timeout.signal.aborted) throw error;
                });
              let resolution: Awaited<typeof handle.resolution>;
              try {
                resolution = await handle.resolution;
              } finally {
                timeout.abort();
                await expiry;
              }
              for (const event of coordinator.events(handle.request.id)) {
                if (event.type === "human_action")
                  await runtime.recorder.record(
                    {
                      phase: "handoff",
                      actor: { type: "human" },
                      capabilityId: profile.id,
                      stepId,
                    },
                    {
                      type: "human.action",
                      data: {
                        interventionId: event.interventionId,
                        sessionId: event.sessionId,
                        action: event.detail as "click" | "type" | "key" | "reload",
                      },
                    },
                  );
              }
              await runtime.recorder.record(
                { phase: "handoff", actor: { type: "system" }, capabilityId: profile.id, stepId },
                {
                  type: "intervention.changed",
                  data: {
                    interventionId: handle.request.id,
                    state: resolution.kind,
                    reason: "stuck",
                    summary: reason,
                  },
                },
              );
              if (resolution.kind === "aborted") throw new Error(resolution.reason);
            },
          }
        : {}),
    });
    const compiled = compileArtifact(discovery.trace, profile, inputs);
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
      discoveryMode: profile.mode ?? "guided",
      artifactStatus: "draft",
    };
    await writeJson(resolve(runtime.runDirectory, "summary.json"), summary);
    return { compiled, summary, runDirectory: runtime.runDirectory };
  } catch (error) {
    const screenshot = await runtime.surface.capture("discovery-failure").catch(() => undefined);
    const result = {
      status: "failure" as const,
      runId: runtime.runId,
      category: "surface" as const,
      message: error instanceof Error ? error.message : "Discovery failed",
      retryable: false,
      evidence: screenshot ? [screenshot] : [],
    };
    await runtime.recorder.record(
      { phase: "discovery", actor: { type: "system" }, capabilityId: profile.id },
      { type: "run.completed", data: { result } },
    );
    await writeJson(
      resolve(runtime.runDirectory, "summary.json"),
      redactValue(
        {
          result,
          discoveryMode: profile.mode ?? "guided",
          modelCalls: runtime.recorder.modelCalls,
        },
        redaction,
      ),
    );
    throw error;
  } finally {
    await runtime.close();
  }
};
