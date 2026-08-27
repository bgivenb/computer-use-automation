import OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import {
  DiscoveryDecisionSchema,
  type DiscoveryDecision,
  type LocatorStrategy,
  type Target,
} from "../core/contracts.js";
import type { DiscoveryPrompt, ModelDriver } from "./driver.js";

const INSTRUCTIONS = `You discover a reusable UI workflow on a synthetic local banking demo.
Return exactly one structured decision per turn. Never claim success unless the declared review
checkpoint is visible. Never click the final Create account action. Prefer role/name or stable
business text for actions, then the supplied stable CSS candidates; never use generated ids, frame
names, or raw coordinates. The task UI is inside an iframe: copy its stable iframe[title=...] selector
into target.frame for every inner target. For reads, use a supplied structural CSS selector and never
locate the variable output by its current text. Fill values only with the provided {{inputs.name}}
templates and use required output binding names exactly. Escalate when ambiguous, unsafe, or outside
the goal.`;

const ModelLocatorStrategySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("role"),
    role: z.string().min(1),
    name: z.string().min(1),
    exact: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("label"),
    text: z.string().min(1),
    exact: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("text"),
    text: z.string().min(1),
    exact: z.boolean(),
  }),
  z.strictObject({ kind: z.literal("css"), selector: z.string().min(1) }),
]);

const ModelTargetSchema = z.strictObject({
  description: z.string().min(1),
  whyRobust: z.string().min(1),
  frame: z.strictObject({ strategies: z.array(ModelLocatorStrategySchema).min(1) }).nullable(),
  strategies: z.array(ModelLocatorStrategySchema).min(1),
});

const ModelCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("click"), target: ModelTargetSchema }),
  z.strictObject({
    kind: z.literal("fill"),
    target: ModelTargetSchema,
    value: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("select"),
    target: ModelTargetSchema,
    value: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("read"),
    target: ModelTargetSchema,
    bind: z.string().min(1),
    parse: z.enum(["text", "currency"]),
  }),
]);

const ModelDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("act"),
    command: ModelCommandSchema,
    reason: z.string().min(1),
  }),
  z.strictObject({ type: z.literal("finish"), reason: z.string().min(1) }),
  z.strictObject({
    type: z.literal("escalate"),
    reason: z.enum(["stuck", "ambiguous_target", "policy_block", "risky_action", "runtime_state"]),
    summary: z.string().min(1),
  }),
]);

const ModelResponseSchema = z.strictObject({ decision: ModelDecisionSchema });

const normalizeTarget = (target: z.infer<typeof ModelTargetSchema>): Target => ({
  description: target.description,
  whyRobust: target.whyRobust,
  ...(target.frame === null
    ? {}
    : { frame: { strategies: target.frame.strategies as LocatorStrategy[] } }),
  strategies: target.strategies as LocatorStrategy[],
});

const normalizeDecision = (decision: z.infer<typeof ModelDecisionSchema>): DiscoveryDecision => {
  if (decision.type !== "act") return DiscoveryDecisionSchema.parse(decision);
  const command = decision.command;
  return DiscoveryDecisionSchema.parse({
    ...decision,
    command: { ...command, target: normalizeTarget(command.target) },
  });
};

const boundedHistory = (prompt: DiscoveryPrompt): unknown[] =>
  prompt.history.slice(-6).map(({ command, receipt }) => ({
    command,
    receipt: {
      action: receipt.action,
      ok: receipt.ok,
      urlAfter: receipt.urlAfter,
      resolution: receipt.resolution,
    },
  }));

export class OpenAIResponsesDriver implements ModelDriver {
  readonly name = "openai-responses";
  readonly model: string;
  readonly #client: OpenAI;

  constructor(options: { model?: string; apiKey?: string } = {}) {
    this.model = options.model ?? process.env.OPENAI_MODEL ?? "gpt-5.4-mini";
    this.#client = new OpenAI(options.apiKey ? { apiKey: options.apiKey } : {});
  }

  async decide(prompt: DiscoveryPrompt): Promise<DiscoveryDecision> {
    const state = {
      goal: prompt.goal,
      step: prompt.step,
      allowedInputTemplates: prompt.inputNames.map((name) => `{{inputs.${name}}}`),
      requiredOutputBindings: prompt.outputNames,
      reviewedNextStep: prompt.nextStep,
      page: {
        url: prompt.observation.url,
        title: prompt.observation.title,
        visibleText: prompt.observation.visibleText.slice(0, 12_000),
        frames: prompt.observation.frames,
        observedElements: prompt.observation.controls,
      },
      recentActions: boundedHistory(prompt),
    };

    const content: Array<
      | { type: "input_text"; text: string }
      | { type: "input_image"; image_url: string; detail: "original" }
    > = [
      {
        type: "input_text",
        text: `Choose the next single decision from this state:\n${JSON.stringify(state)}`,
      },
    ];
    if (prompt.screenshotBase64) {
      content.push({
        type: "input_image",
        image_url: `data:image/png;base64,${prompt.screenshotBase64}`,
        detail: "original",
      });
    }

    const response = await this.#client.responses.parse(
      {
        model: this.model,
        instructions: INSTRUCTIONS,
        input: [{ role: "user", content }],
        text: {
          format: zodTextFormat(ModelResponseSchema, "discovery_decision"),
          verbosity: "low",
        },
        reasoning: { effort: "low" },
        max_output_tokens: 1_500,
        store: false,
      },
      { signal: prompt.signal },
    );

    if (!response.output_parsed) {
      throw new Error("OpenAI returned no parsed discovery decision");
    }
    return normalizeDecision(ModelResponseSchema.parse(response.output_parsed).decision);
  }
}
