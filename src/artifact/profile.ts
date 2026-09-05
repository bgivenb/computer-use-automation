import { z } from "zod";
import {
  CapabilityArtifactSchema,
  CapabilityStepSchema,
  CommandKindSchema,
  ConditionSchema,
  OutputSpecSchema,
  PermissionSetSchema,
  StepBranchSchema,
  ValueSpecSchema,
  BusinessOutcomeSpecSchema,
} from "../core/contracts.js";

/** Trusted author configuration, never populated from page text or model output. */
export const CapabilityProfileSchema = z
  .strictObject({
    id: CapabilityArtifactSchema.shape.id,
    revision: CapabilityArtifactSchema.shape.revision,
    name: z.string().min(1),
    description: z.string().min(1),
    app: CapabilityArtifactSchema.shape.app,
    entryUrl: z.url(),
    inputs: z.record(z.string(), ValueSpecSchema),
    inputSamples: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    outputs: z.record(z.string(), OutputSpecSchema),
    businessOutcomes: z.array(BusinessOutcomeSpecSchema),
    permissions: PermissionSetSchema,
    steps: z.array(
      CapabilityStepSchema.omit({ id: true, command: true }).extend({
        kind: CommandKindSchema,
        timeoutMs: z.number().int().positive().max(60_000).optional(),
      }),
    ),
    success: z.array(ConditionSchema).min(1),
    checkpoints: z.array(ConditionSchema).min(1).optional(),
    mode: z.enum(["guided", "explore"]).optional(),
    resumeWhen: z.array(ConditionSchema).min(1).optional(),
    onObserved: z.array(StepBranchSchema).optional(),
  })
  .superRefine((profile, context) => {
    if (profile.mode === "explore" && !profile.checkpoints?.length)
      context.addIssue({
        code: "custom",
        path: ["checkpoints"],
        message: "Exploration requires a reviewed checkpoint catalog",
      });
    if (profile.mode !== "explore" && profile.steps.length === 0)
      context.addIssue({
        code: "custom",
        path: ["steps"],
        message: "Guided discovery requires reviewed steps",
      });
  });
