import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { InputValidationError, validateInputs } from "../artifact/bind.js";
import { artifactDigest, type CompiledArtifact } from "../artifact/compiler.js";
import { replayArtifact, type ReplaySummary } from "../artifact/replay.js";
import {
  CapabilityArtifactSchema,
  PermissionSetSchema,
  type CapabilityArtifact,
  type PermissionSet,
} from "../core/contracts.js";
import { evaluatePolicy } from "../core/policy.js";
import { redactValue, type RedactionOptions } from "../core/redact.js";
import { InterventionCoordinator } from "../runtime/intervention.js";
import { createRuntimeContext, writeJson, type RuntimeContext } from "./runtime.js";

export type PreparedReplay = {
  runtime: RuntimeContext;
  coordinator: InterventionCoordinator;
  promise: Promise<ReplaySummary>;
  close: () => Promise<void>;
};

export class ArtifactIntegrityError extends Error {
  constructor() {
    super("Compiled artifact digest does not match its content");
    this.name = "ArtifactIntegrityError";
  }
}

export const invalidInputSummary = (
  artifact: CapabilityArtifact,
  inputValues: Record<string, unknown>,
): ReplaySummary | undefined => {
  try {
    validateInputs(artifact.contract.inputs, inputValues);
    return undefined;
  } catch (error) {
    if (!(error instanceof InputValidationError)) throw error;
    return {
      artifactId: artifact.id,
      artifactRevision: artifact.revision,
      artifactSha256: artifactDigest(artifact),
      modelCalls: 0,
      result: {
        status: "failure",
        runId: randomUUID(),
        category: "invalid_input",
        message: error.message,
        retryable: false,
        evidence: [],
      },
      signature: [],
    };
  }
};

export const prepareReplay = async (options: {
  artifact: CapabilityArtifact;
  inputValues: Record<string, unknown>;
  runtimePermissions: PermissionSet;
  runsDirectory?: string;
  headless?: boolean;
  allowInterventions?: boolean;
}): Promise<PreparedReplay> => {
  const artifact = CapabilityArtifactSchema.parse(options.artifact);
  const runtimePermissions = PermissionSetSchema.parse(options.runtimePermissions);
  validateInputs(artifact.contract.inputs, options.inputValues);
  const entryDecision = evaluatePolicy(
    {
      layers: [{ name: "runtime", permissions: runtimePermissions }],
      irreversibleActions: "deny",
    },
    { action: "navigate", url: artifact.entryUrl, risk: "safe" },
  );
  if (entryDecision.decision !== "allow") {
    throw new Error(
      `Runtime policy does not trust the artifact entry URL: ${entryDecision.reason}`,
    );
  }

  const sensitiveKeys = Object.entries(artifact.contract.outputs)
    .filter(([, output]) => output.value.sensitivity !== "public")
    .map(([name]) => name);
  const redaction: RedactionOptions = {
    sensitiveValues: options.inputValues as Record<string, string | number | boolean>,
    sensitiveKeys,
  };
  const runtime = await createRuntimeContext({
    runtimePermissions,
    ...(options.runsDirectory === undefined ? {} : { runsDirectory: options.runsDirectory }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
    redaction,
  });
  const coordinator = new InterventionCoordinator();
  const promise = replayArtifact({
    artifact,
    artifactSha256: artifactDigest(artifact),
    inputValues: options.inputValues,
    runtimePermissions,
    surface: runtime.surface,
    recorder: runtime.recorder,
    ...(options.allowInterventions === false ? {} : { coordinator }),
  }).then(async (summary) => {
    await writeJson(resolve(runtime.runDirectory, "summary.json"), redactValue(summary, redaction));
    return summary;
  });

  const close = async (): Promise<void> => {
    await Promise.all(
      coordinator
        .list()
        .map(({ id }) => coordinator.abort(id, "Replay closed while intervention was pending")),
    );
    await promise.catch(() => undefined);
    await runtime.close();
  };

  return {
    runtime,
    coordinator,
    promise,
    close,
  };
};

export const replayCompiled = async (options: {
  compiled: CompiledArtifact;
  inputValues: Record<string, unknown>;
  runtimePermissions: PermissionSet;
  runsDirectory?: string;
  headless?: boolean;
}): Promise<ReplaySummary> => {
  if (artifactDigest(options.compiled.artifact) !== options.compiled.sha256) {
    throw new ArtifactIntegrityError();
  }
  const inputFailure = invalidInputSummary(options.compiled.artifact, options.inputValues);
  if (inputFailure) return inputFailure;
  const prepared = await prepareReplay({
    artifact: options.compiled.artifact,
    inputValues: options.inputValues,
    runtimePermissions: options.runtimePermissions,
    allowInterventions: false,
    ...(options.runsDirectory === undefined ? {} : { runsDirectory: options.runsDirectory }),
    ...(options.headless === undefined ? {} : { headless: options.headless }),
  });
  try {
    return await prepared.promise;
  } finally {
    await prepared.close();
  }
};
