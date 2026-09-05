import { z } from "zod";

const IdentifierSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][a-z0-9_-]*$/);

export const SensitivitySchema = z.enum(["public", "sensitive", "secret"]);
export type Sensitivity = z.infer<typeof SensitivitySchema>;

const ValueSpecBase = {
  description: z.string().min(1),
  sensitivity: SensitivitySchema,
};

export const ValueSpecSchema = z
  .discriminatedUnion("type", [
    z.strictObject({
      ...ValueSpecBase,
      type: z.literal("string"),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().positive().optional(),
      pattern: z.string().min(1).max(256).optional(),
      choices: z.array(z.string()).min(1).optional(),
    }),
    z.strictObject({
      ...ValueSpecBase,
      type: z.literal("number"),
      integer: z.boolean().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      unit: z.string().min(1).optional(),
    }),
    z.strictObject({
      ...ValueSpecBase,
      type: z.literal("boolean"),
    }),
  ])
  .superRefine((spec, context) => {
    if (spec.type !== "string") return;
    if (
      spec.minLength !== undefined &&
      spec.maxLength !== undefined &&
      spec.minLength > spec.maxLength
    ) {
      context.addIssue({
        code: "custom",
        message: "minLength must not exceed maxLength",
        path: ["minLength"],
      });
    }
    if (spec.pattern !== undefined) {
      try {
        new RegExp(spec.pattern);
      } catch {
        context.addIssue({
          code: "custom",
          message: "pattern must be a valid regular expression",
          path: ["pattern"],
        });
      }
    }
  });
export type ValueSpec = z.infer<typeof ValueSpecSchema>;

export const TemplateSchema = z.string().min(1);
export type Template = z.infer<typeof TemplateSchema>;

export const LocatorKindSchema = z.enum(["role", "label", "text", "css"]);
export type LocatorKind = z.infer<typeof LocatorKindSchema>;

export const LocatorStrategySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("role"),
    role: z.string().min(1),
    name: TemplateSchema,
    exact: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("label"),
    text: TemplateSchema,
    exact: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("text"),
    text: TemplateSchema,
    exact: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("css"),
    selector: z.string().min(1),
  }),
]);
export type LocatorStrategy = z.infer<typeof LocatorStrategySchema>;

export const LocatorBundleSchema = z.strictObject({
  strategies: z.array(LocatorStrategySchema).min(1),
});
export type LocatorBundle = z.infer<typeof LocatorBundleSchema>;

export const TargetSchema = z.strictObject({
  description: z.string().min(1),
  whyRobust: z.string().min(1),
  frame: LocatorBundleSchema.optional(),
  strategies: z.array(LocatorStrategySchema).min(1),
});
export type Target = z.infer<typeof TargetSchema>;

export const ConditionKindSchema = z.enum(["url", "visible", "hidden", "text"]);
export type ConditionKind = z.infer<typeof ConditionKindSchema>;

export const ConditionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("url"),
    path: TemplateSchema,
  }),
  z.strictObject({
    kind: z.literal("visible"),
    target: TargetSchema,
  }),
  z.strictObject({
    kind: z.literal("hidden"),
    target: TargetSchema,
  }),
  z.strictObject({
    kind: z.literal("text"),
    target: TargetSchema.optional(),
    includes: TemplateSchema,
  }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const CommandKindSchema = z.enum(["navigate", "click", "fill", "select", "read", "wait"]);
export type CommandKind = z.infer<typeof CommandKindSchema>;

export const CommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("navigate"),
    url: TemplateSchema,
  }),
  z.strictObject({
    kind: z.literal("click"),
    target: TargetSchema,
  }),
  z.strictObject({
    kind: z.literal("fill"),
    target: TargetSchema,
    value: TemplateSchema,
  }),
  z.strictObject({
    kind: z.literal("select"),
    target: TargetSchema,
    value: TemplateSchema,
  }),
  z.strictObject({
    kind: z.literal("read"),
    target: TargetSchema,
    bind: IdentifierSchema,
    parse: z.enum(["text", "currency"]),
  }),
  z.strictObject({
    kind: z.literal("wait"),
    until: ConditionSchema,
  }),
]);
export type Command = z.infer<typeof CommandSchema>;

export const RiskSchema = z.enum(["safe", "reversible", "irreversible"]);
export type Risk = z.infer<typeof RiskSchema>;

export const FailureCategorySchema = z.enum([
  "invalid_input",
  "policy",
  "permission",
  "timeout",
  "locator",
  "checkpoint",
  "surface",
  "internal",
  "aborted",
]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

export const InterventionReasonSchema = z.enum([
  "stuck",
  "ambiguous_target",
  "policy_block",
  "risky_action",
  "runtime_state",
]);
export type InterventionReason = z.infer<typeof InterventionReasonSchema>;

export const BranchActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("recover"),
    command: CommandSchema,
    message: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("return_outcome"),
    code: IdentifierSchema,
    details: z.record(z.string(), TemplateSchema).optional(),
  }),
  z.strictObject({
    kind: z.literal("fail"),
    category: FailureCategorySchema,
    message: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("intervene"),
    reason: InterventionReasonSchema,
    summary: z.string().min(1),
    resumeWhen: ConditionSchema,
  }),
]);
export type BranchAction = z.infer<typeof BranchActionSchema>;

export const StepBranchSchema = z.strictObject({
  when: ConditionSchema,
  action: BranchActionSchema,
});
export type StepBranch = z.infer<typeof StepBranchSchema>;

export const CapabilityStepSchema = z.strictObject({
  id: IdentifierSchema,
  description: z.string().min(1),
  command: CommandSchema,
  expect: z.array(ConditionSchema).min(1),
  onObserved: z.array(StepBranchSchema).optional(),
  timeoutMs: z.number().int().positive().max(60_000),
  risk: RiskSchema,
});
export type CapabilityStep = z.infer<typeof CapabilityStepSchema>;

const OriginSchema = z
  .url()
  .refine((value) => new URL(value).origin === value, "Expected an origin without a path");

const RouteSchema = z
  .string()
  .min(1)
  .refine((route) => {
    if (!route.startsWith("/") || route.includes("?") || route.includes("#")) return false;
    const segments = route.split("/").slice(1);
    return segments.every((segment, index) => {
      if (segment === "*") return index === segments.length - 1;
      if (segment.startsWith(":")) return /^:[a-z][A-Za-z0-9_-]*$/.test(segment);
      return segment.length > 0 || segments.length === 1;
    });
  }, "Expected an exact path with optional :segment parameters or a trailing /* prefix");

export const PermissionSetSchema = z.strictObject({
  origins: z.array(OriginSchema).min(1),
  routes: z.array(RouteSchema).min(1),
  actions: z.array(CommandKindSchema).min(1),
});
export type PermissionSet = z.infer<typeof PermissionSetSchema>;

export const BusinessOutcomeSpecSchema = z.strictObject({
  code: IdentifierSchema,
  description: z.string().min(1),
});
export type BusinessOutcomeSpec = z.infer<typeof BusinessOutcomeSpecSchema>;

export const OutputSpecSchema = z.strictObject({
  value: ValueSpecSchema,
  from: IdentifierSchema,
});
export type OutputSpec = z.infer<typeof OutputSpecSchema>;

export const CapabilityArtifactSchema = z
  .strictObject({
    schemaVersion: z.literal("1.0"),
    id: IdentifierSchema,
    revision: z.number().int().positive(),
    name: z.string().min(1),
    description: z.string().min(1),
    discoveryRunId: z.string().min(1),
    app: z.strictObject({
      family: IdentifierSchema,
      version: z.string().min(1),
      surface: z.literal("web"),
    }),
    entryUrl: TemplateSchema,
    contract: z.strictObject({
      inputs: z.record(z.string(), ValueSpecSchema),
      outputs: z.record(z.string(), OutputSpecSchema),
      businessOutcomes: z.array(BusinessOutcomeSpecSchema),
    }),
    permissions: PermissionSetSchema,
    steps: z.array(CapabilityStepSchema).min(1),
    success: z.array(ConditionSchema).min(1),
  })
  .superRefine((artifact, context) => {
    const stepIds = new Set<string>();
    const bindings = new Set<string>();
    const declaredOutcomes = new Set(artifact.contract.businessOutcomes.map(({ code }) => code));

    for (const [index, step] of artifact.steps.entries()) {
      if (stepIds.has(step.id)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate step id: ${step.id}`,
          path: ["steps", index, "id"],
        });
      }
      stepIds.add(step.id);

      if (!artifact.permissions.actions.includes(step.command.kind)) {
        context.addIssue({
          code: "custom",
          message: `Command ${step.command.kind} is absent from artifact permissions`,
          path: ["steps", index, "command", "kind"],
        });
      }

      if (step.command.kind === "read") {
        if (bindings.has(step.command.bind)) {
          context.addIssue({
            code: "custom",
            message: `Duplicate output binding: ${step.command.bind}`,
            path: ["steps", index, "command", "bind"],
          });
        }
        bindings.add(step.command.bind);
      }

      for (const [branchIndex, branch] of (step.onObserved ?? []).entries()) {
        if (
          branch.action.kind === "recover" &&
          !artifact.permissions.actions.includes(branch.action.command.kind)
        ) {
          context.addIssue({
            code: "custom",
            message: `Recovery command ${branch.action.command.kind} is absent from artifact permissions`,
            path: ["steps", index, "onObserved", branchIndex, "action", "command", "kind"],
          });
        }

        if (branch.action.kind === "return_outcome" && !declaredOutcomes.has(branch.action.code)) {
          context.addIssue({
            code: "custom",
            message: `Undeclared business outcome: ${branch.action.code}`,
            path: ["steps", index, "onObserved", branchIndex, "action", "code"],
          });
        }
      }
    }

    for (const [name, output] of Object.entries(artifact.contract.outputs)) {
      if (!bindings.has(output.from)) {
        context.addIssue({
          code: "custom",
          message: `Output ${name} references missing binding: ${output.from}`,
          path: ["contract", "outputs", name, "from"],
        });
      }
    }
  });
export type CapabilityArtifact = z.infer<typeof CapabilityArtifactSchema>;

export const LocatorAttemptSchema = z.strictObject({
  strategyIndex: z.number().int().nonnegative(),
  kind: LocatorKindSchema,
  matches: z.number().int().nonnegative(),
});
export type LocatorAttempt = z.infer<typeof LocatorAttemptSchema>;

export const LocatorResolutionSchema = z.strictObject({
  strategyIndex: z.number().int().nonnegative(),
  kind: LocatorKindSchema,
  attempts: z.array(LocatorAttemptSchema).min(1),
});
export type LocatorResolution = z.infer<typeof LocatorResolutionSchema>;

export const EvidenceRefSchema = z.strictObject({
  kind: z.enum(["screenshot", "events", "trace", "snapshot"]),
  path: z.string().min(1),
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ActionReceiptSchema = z.strictObject({
  action: CommandKindSchema,
  ok: z.boolean(),
  durationMs: z.number().nonnegative(),
  urlBefore: z.url(),
  urlAfter: z.url(),
  resolution: LocatorResolutionSchema.optional(),
  binding: IdentifierSchema.optional(),
});
export type ActionReceipt = z.infer<typeof ActionReceiptSchema>;

export const CheckReceiptSchema = z.strictObject({
  kind: ConditionKindSchema,
  passed: z.boolean(),
  expected: z.string(),
  observed: z.string(),
  durationMs: z.number().nonnegative(),
});
export type CheckReceipt = z.infer<typeof CheckReceiptSchema>;

export const ObservationSchema = z.strictObject({
  url: z.url(),
  title: z.string(),
  visibleText: z.string(),
  frames: z.array(
    z.strictObject({
      name: z.string().optional(),
      url: z.url(),
      visibleText: z.string(),
    }),
  ),
  digest: z.string().min(1),
  screenshot: EvidenceRefSchema.optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const DiscoveryDecisionSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("act"),
    command: CommandSchema,
    reason: z.string().min(1),
    checkpoint: ConditionSchema.optional(),
  }),
  z.strictObject({
    type: z.literal("finish"),
    reason: z.string().min(1),
  }),
  z.strictObject({
    type: z.literal("escalate"),
    reason: InterventionReasonSchema,
    summary: z.string().min(1),
  }),
]);
export type DiscoveryDecision = z.infer<typeof DiscoveryDecisionSchema>;

export const InterventionRequestSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  capabilityId: IdentifierSchema.optional(),
  goal: z.string().min(1),
  stepId: IdentifierSchema.optional(),
  reason: InterventionReasonSchema,
  summary: z.string().min(1),
  evidence: z.array(EvidenceRefSchema),
  createdAt: z.iso.datetime(),
});
export type InterventionRequest = z.infer<typeof InterventionRequestSchema>;

const JsonObjectSchema = z.record(z.string(), z.json());

export const RunResultSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("success"),
    runId: z.string().min(1),
    outputs: JsonObjectSchema,
    evidence: z.array(EvidenceRefSchema),
  }),
  z.strictObject({
    status: z.literal("business_outcome"),
    runId: z.string().min(1),
    code: IdentifierSchema,
    details: JsonObjectSchema,
    evidence: z.array(EvidenceRefSchema),
  }),
  z.strictObject({
    status: z.literal("failure"),
    runId: z.string().min(1),
    category: FailureCategorySchema,
    stepId: IdentifierSchema.optional(),
    message: z.string().min(1),
    retryable: z.boolean(),
    expected: JsonObjectSchema.optional(),
    observed: JsonObjectSchema.optional(),
    evidence: z.array(EvidenceRefSchema),
  }),
]);
export type RunResult = z.infer<typeof RunResultSchema>;
