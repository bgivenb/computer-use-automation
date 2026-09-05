import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CapabilityArtifactSchema,
  RunResultSchema,
  type CapabilityArtifact,
  type CapabilityStep,
  type Command,
  type EvidenceRef,
  type FailureCategory,
  type PermissionSet,
  type RunResult,
  type StepBranch,
} from "../core/contracts.js";
import type { EventRecorder } from "../core/event-recorder.js";
import { effectiveCommandRisk, evaluatePolicy, type Policy } from "../core/policy.js";
import { redactValue } from "../core/redact.js";
import type { InterventionCoordinator, InterventionEvent } from "../runtime/intervention.js";
import { LocatorResolutionError, type SurfaceAdapter, describeTarget } from "../surface/adapter.js";
import type { RunSession } from "../runtime/session.js";
import { bindCommand, bindCondition, bindTemplate, validateInputs } from "./bind.js";

export type ReplaySummary = {
  artifactId: string;
  artifactRevision: number;
  artifactSha256: string;
  modelCalls: 0;
  result: RunResult;
  signature: string[];
};

type JsonScalar = string | number | boolean | null;

class PolicyRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "PolicyRejectedError";
  }
}

const commandTarget = (command: Command): string | undefined => {
  switch (command.kind) {
    case "click":
    case "fill":
    case "select":
    case "read":
      return describeTarget(command.target);
    case "navigate":
    case "wait":
      return undefined;
  }
};

const failureCategory = (error: unknown): FailureCategory => {
  if (error instanceof PolicyRejectedError) return "policy";
  if (error instanceof LocatorResolutionError) return "locator";
  if (error instanceof Error && /timeout/i.test(error.message)) return "timeout";
  return "surface";
};

const buildPolicy = (runtimePermissions: PermissionSet, artifact: CapabilityArtifact): Policy => ({
  layers: [
    { name: "runtime", permissions: runtimePermissions },
    { name: "artifact", permissions: artifact.permissions },
  ],
  irreversibleActions: "intervene",
});

const bindDetails = (
  details: Record<string, string> | undefined,
  inputs: Readonly<Record<string, string | number | boolean>>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(details ?? {}).map(([key, value]) => [key, bindTemplate(value, inputs)]),
  );

export const replayArtifact = async (options: {
  artifact: CapabilityArtifact;
  artifactSha256: string;
  inputValues: Record<string, unknown>;
  runtimePermissions: PermissionSet;
  surface: SurfaceAdapter;
  session?: RunSession;
  recorder: EventRecorder;
  coordinator?: InterventionCoordinator;
}): Promise<ReplaySummary> => {
  const artifact = CapabilityArtifactSchema.parse(options.artifact);
  const inputs = validateInputs(artifact.contract.inputs, options.inputValues);
  const runId = options.recorder.runId || randomUUID();
  const policy = buildPolicy(options.runtimePermissions, artifact);
  const outputsByBinding: Record<string, JsonScalar> = {};
  const evidence: EvidenceRef[] = [{ kind: "events", path: "events.jsonl" }];
  const signature: string[] = [];

  const finish = async (result: RunResult): Promise<ReplaySummary> => {
    const validatedResult = RunResultSchema.parse(result);
    await options.recorder.record(
      { phase: "replay", actor: { type: "system" }, capabilityId: artifact.id },
      { type: "run.completed", data: { result: validatedResult } },
    );
    return {
      artifactId: artifact.id,
      artifactRevision: artifact.revision,
      artifactSha256: options.artifactSha256,
      modelCalls: 0,
      result: validatedResult,
      signature,
    };
  };

  const fail = async (optionsForFailure: {
    category: FailureCategory;
    message: string;
    retryable: boolean;
    stepId?: string;
    expected?: Record<string, JsonScalar>;
    observed?: Record<string, JsonScalar>;
  }): Promise<ReplaySummary> => {
    try {
      evidence.push(
        await options.surface.capture(
          `failure-${optionsForFailure.stepId ?? optionsForFailure.category}`,
        ),
      );
    } catch {
      // A crashed surface must not replace the structured failure with another exception.
    }
    return finish({
      status: "failure",
      runId,
      category: optionsForFailure.category,
      ...(optionsForFailure.stepId === undefined ? {} : { stepId: optionsForFailure.stepId }),
      message: optionsForFailure.message,
      retryable: optionsForFailure.retryable,
      ...(optionsForFailure.expected === undefined ? {} : { expected: optionsForFailure.expected }),
      ...(optionsForFailure.observed === undefined ? {} : { observed: optionsForFailure.observed }),
      evidence,
    });
  };

  const executePolicyChecked = async (
    command: Command,
    risk: CapabilityStep["risk"],
    stepId: string,
    timeoutMs = 10_000,
  ) => {
    const policyContext = await options.surface.policyContext(command);
    const effectiveRisk = effectiveCommandRisk(command, risk, policyContext.riskText);
    const decision = evaluatePolicy(policy, {
      action: command.kind,
      url: policyContext.url,
      risk: effectiveRisk,
    });
    await options.recorder.record(
      { phase: "replay", actor: { type: "system" }, capabilityId: artifact.id, stepId },
      {
        type: "policy.evaluated",
        data: {
          action: command.kind,
          url: policyContext.url,
          risk: effectiveRisk,
          result: decision,
        },
      },
    );
    if (decision.decision !== "allow") throw new PolicyRejectedError(decision.reason);
    const action = await options.surface.execute(command, timeoutMs, policyContext);
    await options.recorder.record(
      { phase: "replay", actor: { type: "automation" }, capabilityId: artifact.id, stepId },
      {
        type: "action.completed",
        data: {
          ...(commandTarget(command) === undefined ? {} : { target: commandTarget(command) }),
          receipt: action.receipt,
        },
      },
    );
    signature.push(
      `${stepId}|${command.kind}|${action.receipt.resolution?.strategyIndex ?? "-"}|${action.receipt.urlAfter}`,
    );
    if (command.kind === "read") {
      if (typeof action.value !== "string" && typeof action.value !== "number") {
        throw new Error(`Read command ${command.bind} returned a non-scalar value`);
      }
      outputsByBinding[command.bind] = action.value;
    }
    return action;
  };

  const entry = bindCommand({ kind: "navigate", url: artifact.entryUrl }, inputs);
  try {
    await executePolicyChecked(entry, "safe", "entry");
  } catch (error) {
    return fail({
      category: failureCategory(error),
      message: error instanceof Error ? error.message : "Entry navigation failed",
      retryable: false,
      stepId: "entry",
    });
  }

  for (const step of artifact.steps) {
    const command = bindCommand(step.command, inputs);
    try {
      await executePolicyChecked(command, step.risk, step.id, step.timeoutMs);
    } catch (error) {
      return fail({
        category: failureCategory(error),
        message: error instanceof Error ? error.message : "Action failed",
        retryable: step.risk === "safe",
        stepId: step.id,
      });
    }

    let terminal: ReplaySummary | undefined;
    let recovered = false;
    for (const branch of step.onObserved ?? []) {
      const branchResult = await applyBranch(branch, step);
      if (branchResult?.kind === "terminal") {
        terminal = branchResult.summary;
        break;
      }
      if (branchResult?.kind === "recovered") recovered = true;
    }
    if (terminal) return terminal;

    for (const condition of step.expect) {
      const bound = bindCondition(condition, inputs);
      const receipt = await options.surface.check(bound, { timeoutMs: step.timeoutMs });
      await options.recorder.record(
        {
          phase: "replay",
          actor: { type: "automation" },
          capabilityId: artifact.id,
          stepId: step.id,
        },
        { type: "checkpoint.checked", data: { receipt } },
      );
      signature.push(`${step.id}|check:${receipt.kind}|${receipt.passed}`);
      if (!receipt.passed) {
        return fail({
          category: "checkpoint",
          message: `Postcondition failed after ${step.description}`,
          retryable: recovered,
          stepId: step.id,
          expected: { value: receipt.expected },
          observed: { value: receipt.observed },
        });
      }
    }
  }

  for (const condition of artifact.success) {
    const receipt = await options.surface.check(bindCondition(condition, inputs), {
      timeoutMs: 10_000,
    });
    await options.recorder.record(
      { phase: "replay", actor: { type: "automation" }, capabilityId: artifact.id },
      { type: "checkpoint.checked", data: { receipt } },
    );
    signature.push(`success|check:${receipt.kind}|${receipt.passed}`);
    if (!receipt.passed) {
      return fail({
        category: "checkpoint",
        message: "Capability success checkpoint failed",
        retryable: false,
        expected: { value: receipt.expected },
        observed: { value: receipt.observed },
      });
    }
  }

  const outputs: Record<string, JsonScalar> = {};
  for (const [name, spec] of Object.entries(artifact.contract.outputs)) {
    const value = outputsByBinding[spec.from];
    if (value === undefined) {
      return fail({
        category: "internal",
        message: `Declared output ${name} has no value for binding ${spec.from}`,
        retryable: false,
      });
    }
    try {
      const validated = validateInputs({ [name]: spec.value }, { [name]: value })[name];
      if (validated === undefined) throw new Error("validator returned no value");
      outputs[name] = validated;
    } catch (error) {
      return fail({
        category: "checkpoint",
        message: `Output ${name} violated its declared contract: ${
          error instanceof Error ? error.message : "validation failed"
        }`,
        retryable: false,
      });
    }
  }
  return finish({ status: "success", runId, outputs, evidence });

  async function applyBranch(
    branch: StepBranch,
    step: CapabilityStep,
  ): Promise<{ kind: "terminal"; summary: ReplaySummary } | { kind: "recovered" } | undefined> {
    const receipt = await options.surface.check(bindCondition(branch.when, inputs));
    if (!receipt.passed) return undefined;

    signature.push(`${step.id}|branch:${branch.action.kind}`);
    switch (branch.action.kind) {
      case "return_outcome":
        return {
          kind: "terminal",
          summary: await finish({
            status: "business_outcome",
            runId,
            code: branch.action.code,
            details: bindDetails(branch.action.details, inputs),
            evidence,
          }),
        };
      case "fail":
        return {
          kind: "terminal",
          summary: await fail({
            category: branch.action.category,
            message: branch.action.message,
            retryable: false,
            stepId: step.id,
          }),
        };
      case "recover": {
        const recoveryCommand = bindCommand(branch.action.command, inputs);
        await options.recorder.record(
          {
            phase: "replay",
            actor: { type: "system" },
            capabilityId: artifact.id,
            stepId: step.id,
          },
          {
            type: "recovery.attempted",
            data: {
              attempt: 1,
              maxAttempts: 1,
              command: recoveryCommand,
              reason: branch.action.message,
            },
          },
        );
        try {
          await executePolicyChecked(recoveryCommand, "safe", step.id, step.timeoutMs);
          return { kind: "recovered" };
        } catch (error) {
          return {
            kind: "terminal",
            summary: await fail({
              category: failureCategory(error),
              message: error instanceof Error ? error.message : "Recovery failed",
              retryable: false,
              stepId: step.id,
            }),
          };
        }
      }
      case "intervene": {
        if (!options.coordinator || !options.session) {
          return {
            kind: "terminal",
            summary: await fail({
              category: "surface",
              message: "Human intervention is required but no coordinator is running",
              retryable: false,
              stepId: step.id,
            }),
          };
        }

        const resumeWhen = bindCondition(branch.action.resumeWhen, inputs);
        const screenshot = await options.surface.capture(`handoff-${step.id}`);
        evidence.push(screenshot);
        const handle = options.coordinator.request({
          session: options.session,
          runId,
          capabilityId: artifact.id,
          stepId: step.id,
          goal: artifact.description,
          reason: branch.action.reason,
          summary: branch.action.summary,
          verifyResume: () => options.surface.humanCheck(resumeWhen),
        });
        const interventionPath = "intervention.json";
        await writeFile(
          resolve(options.surface.runDirectory, interventionPath),
          `${JSON.stringify(
            redactValue({ ...handle.request, screenshot }, options.recorder.redaction),
            null,
            2,
          )}\n`,
          { encoding: "utf8", mode: 0o600 },
        );
        evidence.push({ kind: "snapshot", path: interventionPath });
        await options.recorder.record(
          {
            phase: "handoff",
            actor: { type: "system" },
            capabilityId: artifact.id,
            stepId: step.id,
          },
          {
            type: "intervention.changed",
            data: {
              interventionId: handle.request.id,
              state: "requested",
              reason: branch.action.reason,
              summary: branch.action.summary,
            },
          },
        );
        const resolution = await handle.resolution;
        await recordHandoffEvents(
          options.coordinator.events(handle.request.id),
          handle.request.id,
          step.id,
        );
        if (resolution.kind === "aborted") {
          return {
            kind: "terminal",
            summary: await fail({
              category: "aborted",
              message: resolution.reason,
              retryable: false,
              stepId: step.id,
            }),
          };
        }

        const resumed = await options.surface.check(resumeWhen);
        await options.recorder.record(
          {
            phase: "handoff",
            actor: { type: "automation" },
            capabilityId: artifact.id,
            stepId: step.id,
          },
          { type: "checkpoint.checked", data: { receipt: resumed } },
        );
        if (!resumed.passed) {
          return {
            kind: "terminal",
            summary: await fail({
              category: "checkpoint",
              message: "Human handoff resume checkpoint failed",
              retryable: false,
              stepId: step.id,
            }),
          };
        }
        return { kind: "recovered" };
      }
    }
  }

  async function recordHandoffEvents(
    events: InterventionEvent[],
    interventionId: string,
    stepId: string,
  ): Promise<void> {
    let claimed = false;
    let resumed = false;
    for (const event of events) {
      if (event.type === "human_claimed" && !claimed) {
        claimed = true;
        await options.recorder.record(
          { phase: "handoff", actor: { type: "human" }, capabilityId: artifact.id, stepId },
          {
            type: "intervention.changed",
            data: {
              interventionId,
              state: "claimed",
              reason: "runtime_state",
              summary: "Human claimed the existing live session.",
            },
          },
        );
      }
      if (event.type === "human_action") {
        await options.recorder.record(
          { phase: "handoff", actor: { type: "human" }, capabilityId: artifact.id, stepId },
          {
            type: "human.action",
            data: {
              interventionId,
              sessionId: event.sessionId,
              action: (event.detail ?? "click") as "click" | "type" | "key" | "reload",
            },
          },
        );
      }
      if (event.type === "automation_claimed" && !resumed) {
        resumed = true;
        await options.recorder.record(
          { phase: "handoff", actor: { type: "system" }, capabilityId: artifact.id, stepId },
          {
            type: "intervention.changed",
            data: {
              interventionId,
              state: "resumed",
              reason: "runtime_state",
              summary: "Resume checkpoint passed and automation reclaimed the same session.",
            },
          },
        );
      }
    }
  }
};
