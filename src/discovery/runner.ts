import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertReusableCommand,
  type CapabilityProfile,
  type DiscoveryTrace,
  type StepSemantics,
} from "../artifact/compiler.js";
import { bindCommand, bindCondition, validateInputs } from "../artifact/bind.js";
import type { DiscoveryDecision, Condition } from "../core/contracts.js";
import type { EventRecorder } from "../core/event-recorder.js";
import { effectiveCommandRisk, evaluatePolicy, type Policy } from "../core/policy.js";
import { redactValue } from "../core/redact.js";
import {
  type SurfaceAdapter,
  type SurfacePolicyContext,
  describeTarget,
} from "../surface/adapter.js";
import type { ModelDriver } from "./driver.js";

export type DiscoveryRun = {
  trace: DiscoveryTrace;
  model: string;
  modelCalls: number;
};

export class DiscoveryStoppedError extends Error {
  readonly decision?: DiscoveryDecision;

  constructor(message: string, decision?: DiscoveryDecision) {
    super(message);
    this.name = "DiscoveryStoppedError";
    if (decision !== undefined) this.decision = decision;
  }
}

export const runDiscovery = async (options: {
  runId: string;
  goal: string;
  profile: CapabilityProfile;
  inputValues: Record<string, unknown>;
  model: ModelDriver;
  surface: SurfaceAdapter;
  policy: Policy;
  recorder: EventRecorder;
  maxSteps?: number;
  timeoutMs?: number;
  modelCallTimeoutMs?: number;
  onBlocked?: (reason: string, conditions: Condition[], stepId: string) => Promise<void>;
}): Promise<DiscoveryRun> => {
  const inputs = validateInputs(options.profile.inputs, options.inputValues);
  const trace: DiscoveryTrace = { runId: options.runId, goal: options.goal, actions: [] };
  const maxSteps = options.maxSteps ?? 16;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let previousAttempt: { digest: string; command: string } | undefined;
  let handoffs = 0;
  const intervene = async (
    reason: string,
    conditions = options.profile.resumeWhen,
  ): Promise<void> => {
    if (!options.onBlocked || !conditions?.length || handoffs >= 2)
      throw new DiscoveryStoppedError(reason);
    handoffs += 1;
    await options.onBlocked(
      reason,
      conditions.map((condition) => bindCondition(condition, inputs)),
      `step-${String(trace.actions.length + 1).padStart(2, "0")}`,
    );
    previousAttempt = undefined;
  };

  const entryCommand = bindCommand({ kind: "navigate", url: options.profile.entryUrl }, inputs);
  const entryPolicy = evaluatePolicy(options.policy, {
    action: "navigate",
    url: entryCommand.kind === "navigate" ? entryCommand.url : options.profile.entryUrl,
    risk: "safe",
  });
  await options.recorder.record(
    { phase: "discovery", actor: { type: "system" }, capabilityId: options.profile.id },
    {
      type: "policy.evaluated",
      data: {
        action: "navigate",
        url: options.profile.entryUrl,
        risk: "safe",
        result: entryPolicy,
      },
    },
  );
  if (entryPolicy.decision !== "allow") {
    throw new DiscoveryStoppedError(entryPolicy.reason);
  }
  await options.surface.execute(entryCommand);

  for (let step = 0; step < maxSteps; step += 1) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new DiscoveryStoppedError("Discovery exceeded its time budget");
    const observation = await options.surface.observe({
      capture: true,
      reason: `discovery-${step}`,
    });
    await options.recorder.record(
      { phase: "discovery", actor: { type: "automation" }, capabilityId: options.profile.id },
      {
        type: "surface.observed",
        data: {
          url: observation.url,
          digest: observation.digest,
          ...(observation.screenshot === undefined ? {} : { screenshot: observation.screenshot }),
        },
      },
    );

    const screenshotBase64 = observation.screenshot
      ? (
          await readFile(resolve(options.surface.runDirectory, observation.screenshot.path))
        ).toString("base64")
      : undefined;
    const safeObservation = redactValue(
      observation,
      options.recorder.redaction,
    ) as typeof observation;
    const safeHistory = redactValue(
      trace.actions,
      options.recorder.redaction,
    ) as typeof trace.actions;
    const signal = AbortSignal.timeout(Math.min(options.modelCallTimeoutMs ?? 30_000, remainingMs));
    let decision: DiscoveryDecision;
    try {
      decision = await options.model.decide({
        goal: options.goal,
        step,
        inputNames: Object.keys(options.profile.inputs),
        outputNames: Object.values(options.profile.outputs).map(({ from }) => from),
        ...(options.profile.mode === "explore"
          ? {}
          : {
              nextStep: {
                kind: options.profile.steps[trace.actions.length]?.kind ?? "wait",
                description: options.profile.steps[trace.actions.length]?.description ?? "Finish",
                risk: options.profile.steps[trace.actions.length]?.risk ?? "safe",
              },
            }),
        success: options.profile.success,
        checkpoints:
          options.profile.checkpoints?.map((condition, index) => ({
            id: `checkpoint-${index}`,
            condition,
          })) ?? [],
        signal,
        observation: safeObservation,
        history: safeHistory,
        ...(screenshotBase64 === undefined ? {} : { screenshotBase64 }),
      });
    } catch (error) {
      if (signal.aborted) throw new DiscoveryStoppedError("Model decision timed out");
      throw error;
    }
    await options.recorder.record(
      {
        phase: "discovery",
        actor: { type: "model", id: options.model.model },
        capabilityId: options.profile.id,
      },
      { type: "model.decided", data: { decision } },
    );

    const previousAction = trace.actions.at(-1);
    if (
      options.profile.mode === "explore" &&
      previousAction?.semantics &&
      previousAction.semantics.expect.length === 0 &&
      decision.type !== "escalate"
    ) {
      const conditions =
        decision.type === "finish"
          ? options.profile.success
          : decision.checkpoint
            ? [decision.checkpoint]
            : [];
      if (!conditions.length)
        throw new DiscoveryStoppedError(
          "Exploration must validate the previous action against the newly observed screen",
        );
      if (
        decision.type === "act" &&
        !options.profile.checkpoints?.some(
          (condition) => JSON.stringify(condition) === JSON.stringify(decision.checkpoint),
        )
      ) {
        throw new DiscoveryStoppedError("Exploration checkpoint is not in the reviewed catalog");
      }
      for (const condition of conditions) {
        const receipt = await options.surface.check(bindCondition(condition, inputs), {
          timeoutMs: Math.min(10_000, Math.max(1, deadline - Date.now())),
        });
        await options.recorder.record(
          { phase: "discovery", actor: { type: "automation" }, capabilityId: options.profile.id },
          { type: "checkpoint.checked", data: { receipt } },
        );
        if (!receipt.passed)
          throw new DiscoveryStoppedError(`Observed-state checkpoint failed: ${receipt.observed}`);
      }
      previousAction.semantics.expect = conditions;
    }

    if (decision.type === "escalate") {
      await intervene(decision.summary);
      continue;
    }
    if (decision.type === "finish") {
      for (const condition of options.profile.success) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new DiscoveryStoppedError("Discovery exceeded its time budget");
        }
        const receipt = await options.surface.check(bindCondition(condition, inputs), {
          timeoutMs: Math.min(10_000, remainingMs),
        });
        await options.recorder.record(
          { phase: "discovery", actor: { type: "automation" }, capabilityId: options.profile.id },
          { type: "checkpoint.checked", data: { receipt } },
        );
        if (!receipt.passed) {
          throw new DiscoveryStoppedError(
            `Model finished before the success checkpoint: ${receipt.observed}`,
            decision,
          );
        }
      }
      return {
        trace,
        model: options.model.model,
        modelCalls: options.recorder.modelCalls,
      };
    }

    const attempt = { digest: observation.digest, command: JSON.stringify(decision.command) };
    if (previousAttempt?.digest === attempt.digest && previousAttempt.command === attempt.command) {
      await intervene("Discovery repeated the same action without changing the surface");
      continue;
    }
    previousAttempt = attempt;

    const semantics: StepSemantics | undefined =
      options.profile.mode === "explore"
        ? {
            kind: decision.command.kind,
            description: decision.reason,
            expect: [],
            risk: "reversible",
            ...(options.profile.onObserved ? { onObserved: options.profile.onObserved } : {}),
          }
        : options.profile.steps[trace.actions.length];
    if (!semantics)
      throw new DiscoveryStoppedError("Model produced more actions than the profile permits");
    if (decision.command.kind !== semantics.kind) {
      throw new DiscoveryStoppedError(
        `Model chose ${decision.command.kind}; reviewed step requires ${semantics.kind}`,
        decision,
      );
    }
    assertReusableCommand(decision.command);
    const command = bindCommand(decision.command, inputs);
    let policyContext: SurfacePolicyContext;
    try {
      policyContext = await options.surface.policyContext(command);
    } catch (error) {
      await intervene(error instanceof Error ? error.message : "Unable to resolve target");
      continue;
    }
    const risk = effectiveCommandRisk(command, semantics.risk, policyContext.riskText);
    const policy = evaluatePolicy(options.policy, {
      action: command.kind,
      url: policyContext.url,
      risk,
    });
    await options.recorder.record(
      {
        phase: "discovery",
        actor: { type: "system" },
        capabilityId: options.profile.id,
        stepId: `step-${String(trace.actions.length + 1).padStart(2, "0")}`,
      },
      {
        type: "policy.evaluated",
        data: { action: command.kind, url: policyContext.url, risk, result: policy },
      },
    );
    if (policy.decision !== "allow") {
      await intervene(policy.reason);
      continue;
    }

    const timeoutMs = Math.min(semantics.timeoutMs ?? 10_000, Math.max(1, deadline - Date.now()));
    const result = await options.surface.execute(command, timeoutMs, policyContext);
    trace.actions.push({
      command: decision.command,
      receipt: result.receipt,
      ...(options.profile.mode === "explore" ? { semantics } : {}),
    });
    await options.recorder.record(
      {
        phase: "discovery",
        actor: { type: "automation" },
        capabilityId: options.profile.id,
        stepId: `step-${String(trace.actions.length).padStart(2, "0")}`,
      },
      {
        type: "action.completed",
        data: {
          ...(decision.command.kind === "navigate" || decision.command.kind === "wait"
            ? {}
            : { target: describeTarget(decision.command.target) }),
          receipt: result.receipt,
        },
      },
    );

    for (const condition of semantics.expect) {
      const receipt = await options.surface.check(bindCondition(condition, inputs), { timeoutMs });
      await options.recorder.record(
        {
          phase: "discovery",
          actor: { type: "automation" },
          capabilityId: options.profile.id,
          stepId: `step-${String(trace.actions.length).padStart(2, "0")}`,
        },
        { type: "checkpoint.checked", data: { receipt } },
      );
      if (!receipt.passed) {
        await intervene(
          `Discovery action did not reach its declared checkpoint: ${receipt.observed}`,
          semantics.expect,
        );
      }
    }
  }

  throw new DiscoveryStoppedError(`Discovery exceeded maxSteps=${maxSteps}`);
};
