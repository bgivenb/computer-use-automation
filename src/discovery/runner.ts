import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  assertReusableCommand,
  type CapabilityProfile,
  type DiscoveryTrace,
} from "../artifact/compiler.js";
import { bindCommand, bindCondition, validateInputs } from "../artifact/bind.js";
import type { DiscoveryDecision } from "../core/contracts.js";
import type { EventRecorder } from "../core/event-recorder.js";
import { effectiveCommandRisk, evaluatePolicy, type Policy } from "../core/policy.js";
import { redactValue } from "../core/redact.js";
import { type PlaywrightSurface, describeTarget } from "../surface/playwright.js";
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
  surface: PlaywrightSurface;
  policy: Policy;
  recorder: EventRecorder;
  maxSteps?: number;
  timeoutMs?: number;
  modelCallTimeoutMs?: number;
}): Promise<DiscoveryRun> => {
  const inputs = validateInputs(options.profile.inputs, options.inputValues);
  const trace: DiscoveryTrace = { runId: options.runId, goal: options.goal, actions: [] };
  const maxSteps = options.maxSteps ?? 16;
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  let previousAttempt: { digest: string; command: string } | undefined;

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
        nextStep: {
          kind: options.profile.steps[trace.actions.length]?.kind ?? "wait",
          description: options.profile.steps[trace.actions.length]?.description ?? "Finish",
          risk: options.profile.steps[trace.actions.length]?.risk ?? "safe",
        },
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

    if (decision.type === "escalate") {
      throw new DiscoveryStoppedError(decision.summary, decision);
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
      throw new DiscoveryStoppedError(
        "Discovery repeated the same action without changing the surface",
      );
    }
    previousAttempt = attempt;

    const semantics = options.profile.steps[trace.actions.length];
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
    const policyContext = await options.surface.policyContext(command);
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
    if (policy.decision !== "allow") throw new DiscoveryStoppedError(policy.reason, decision);

    const timeoutMs = Math.min(semantics.timeoutMs ?? 10_000, Math.max(1, deadline - Date.now()));
    const result = await options.surface.execute(command, timeoutMs, policyContext);
    trace.actions.push({ command: decision.command, receipt: result.receipt });
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
        throw new DiscoveryStoppedError(
          `Discovery action did not reach its declared checkpoint: ${receipt.observed}`,
          decision,
        );
      }
    }
  }

  throw new DiscoveryStoppedError(`Discovery exceeded maxSteps=${maxSteps}`);
};
