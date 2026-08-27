import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  CapabilityArtifactSchema,
  type ActionReceipt,
  type BusinessOutcomeSpec,
  type CapabilityArtifact,
  type Command,
  type Condition,
  type OutputSpec,
  type PermissionSet,
  type Risk,
  type StepBranch,
  type Target,
  type ValueSpec,
} from "../core/contracts.js";
import { parameterizeCommand } from "./bind.js";

export type DiscoveryAction = {
  command: Command;
  receipt: ActionReceipt;
};

export type DiscoveryTrace = {
  runId: string;
  goal: string;
  actions: DiscoveryAction[];
};

export type StepSemantics = {
  kind: Command["kind"];
  description: string;
  expect: Condition[];
  onObserved?: StepBranch[];
  timeoutMs?: number;
  risk: Risk;
};

export type CapabilityProfile = {
  id: string;
  revision: number;
  name: string;
  description: string;
  app: CapabilityArtifact["app"];
  entryUrl: string;
  inputs: Record<string, ValueSpec>;
  inputSamples: Record<string, string | number | boolean>;
  outputs: Record<string, OutputSpec>;
  businessOutcomes: BusinessOutcomeSpec[];
  permissions: PermissionSet;
  steps: StepSemantics[];
  success: Condition[];
};

export type CompiledArtifact = {
  artifact: CapabilityArtifact;
  sha256: string;
};

export const artifactDigest = (artifact: CapabilityArtifact): string =>
  createHash("sha256")
    .update(`${JSON.stringify(artifact)}\n`)
    .digest("hex");

const assertStableTarget = (target: Target, readTarget: boolean): void => {
  const strategies = [...(target.frame?.strategies ?? []), ...target.strategies];
  for (const strategy of strategies) {
    if (
      strategy.kind === "css" &&
      (strategy.selector.includes("#") || /\[\s*id\b/i.test(strategy.selector))
    ) {
      throw new Error(`Generated/id-based selectors are not reusable: ${strategy.selector}`);
    }
  }
  if (readTarget && target.strategies.some(({ kind }) => kind !== "css")) {
    throw new Error(
      `Read target ${target.description} must use structural CSS, not the current output value`,
    );
  }
};

/** Enforces the demo's portability rules before a discovered command reaches the browser or artifact. */
export const assertReusableCommand = (command: Command): void => {
  if (command.kind === "navigate") return;
  if (command.kind === "wait") {
    const condition = command.until;
    if (condition.kind !== "url" && condition.target) assertStableTarget(condition.target, false);
    return;
  }
  assertStableTarget(command.target, command.kind === "read");
};

export const compileArtifact = (
  trace: DiscoveryTrace,
  profile: CapabilityProfile,
  inputSamples: Readonly<Record<string, string | number | boolean>> = profile.inputSamples,
): CompiledArtifact => {
  if (trace.actions.length !== profile.steps.length) {
    throw new Error(
      `Discovery recorded ${trace.actions.length} actions; profile requires ${profile.steps.length}`,
    );
  }

  const artifact = CapabilityArtifactSchema.parse({
    schemaVersion: "1.0",
    id: profile.id,
    revision: profile.revision,
    name: profile.name,
    description: profile.description,
    discoveryRunId: trace.runId || randomUUID(),
    app: profile.app,
    entryUrl: profile.entryUrl,
    contract: {
      inputs: profile.inputs,
      outputs: profile.outputs,
      businessOutcomes: profile.businessOutcomes,
    },
    permissions: profile.permissions,
    steps: trace.actions.map((action, index) => {
      assertReusableCommand(action.command);
      const semantics = profile.steps[index];
      if (!semantics) throw new Error(`Missing semantics for discovery action ${index}`);
      if (action.command.kind !== semantics.kind) {
        throw new Error(
          `Discovery action ${index + 1} was ${action.command.kind}; expected ${semantics.kind}`,
        );
      }
      return {
        id: `step-${String(index + 1).padStart(2, "0")}`,
        description: semantics.description,
        command: parameterizeCommand(action.command, inputSamples),
        expect: semantics.expect,
        ...(semantics.onObserved === undefined ? {} : { onObserved: semantics.onObserved }),
        timeoutMs: semantics.timeoutMs ?? 10_000,
        risk: semantics.risk,
      };
    }),
    success: profile.success,
  });

  const serialized = JSON.stringify(artifact);
  for (const [name, sample] of Object.entries(inputSamples)) {
    if (String(sample).length >= 3 && serialized.includes(String(sample))) {
      throw new Error(`Compiler leaked concrete sample for input ${name}`);
    }
  }

  return { artifact, sha256: artifactDigest(artifact) };
};

export const writeArtifact = async (
  path: string,
  artifact: CapabilityArtifact,
): Promise<string> => {
  const absolutePath = resolve(path);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, `${JSON.stringify(artifact, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  return absolutePath;
};
