import { z } from "zod";

import {
  ActionReceiptSchema,
  CheckReceiptSchema,
  CommandSchema,
  CommandKindSchema,
  DiscoveryDecisionSchema,
  EvidenceRefSchema,
  InterventionReasonSchema,
  RiskSchema,
  RunResultSchema,
} from "./contracts.js";
import { PolicyDecisionSchema } from "./policy.js";

export const RunPhaseSchema = z.enum(["discovery", "compile", "replay", "handoff"]);
export type RunPhase = z.infer<typeof RunPhaseSchema>;

export const ActorSchema = z.strictObject({
  type: z.enum(["model", "automation", "human", "system"]),
  id: z.string().min(1).optional(),
});
export type Actor = z.infer<typeof ActorSchema>;

const EventBaseShape = {
  eventVersion: z.literal("1.0"),
  timestamp: z.iso.datetime(),
  runId: z.string().min(1),
  sequence: z.number().int().nonnegative(),
  phase: RunPhaseSchema,
  actor: ActorSchema,
  capabilityId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
};

export const RunEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("surface.observed"),
    data: z.strictObject({
      url: z.url(),
      digest: z.string().min(1),
      screenshot: EvidenceRefSchema.optional(),
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("model.decided"),
    data: z.strictObject({
      decision: DiscoveryDecisionSchema,
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("policy.evaluated"),
    data: z.strictObject({
      action: CommandKindSchema,
      url: z.url(),
      risk: RiskSchema,
      result: PolicyDecisionSchema,
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("action.completed"),
    data: z.strictObject({
      target: z.string().min(1).optional(),
      receipt: ActionReceiptSchema,
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("checkpoint.checked"),
    data: z.strictObject({
      receipt: CheckReceiptSchema,
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("recovery.attempted"),
    data: z.strictObject({
      attempt: z.number().int().positive(),
      maxAttempts: z.number().int().positive(),
      command: CommandSchema,
      reason: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("intervention.changed"),
    data: z.strictObject({
      interventionId: z.string().min(1),
      state: z.enum(["requested", "claimed", "resumed", "aborted"]),
      reason: InterventionReasonSchema,
      summary: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("human.action"),
    data: z.strictObject({
      interventionId: z.string().min(1),
      sessionId: z.string().min(1),
      action: z.enum(["click", "type", "key", "reload"]),
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("artifact.compiled"),
    data: z.strictObject({
      artifactId: z.string().min(1),
      revision: z.number().int().positive(),
      path: z.string().min(1),
    }),
  }),
  z.strictObject({
    ...EventBaseShape,
    type: z.literal("run.completed"),
    data: z.strictObject({
      result: RunResultSchema,
    }),
  }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

export type RunEventEnvelope = Pick<
  RunEvent,
  | "eventVersion"
  | "timestamp"
  | "runId"
  | "sequence"
  | "phase"
  | "actor"
  | "capabilityId"
  | "stepId"
>;

type WithoutEnvelope<Event> = Event extends unknown ? Omit<Event, keyof RunEventEnvelope> : never;
export type RunEventPayload = WithoutEnvelope<RunEvent>;

/** Combines an envelope with a typed payload and validates the persisted event at the boundary. */
export function createRunEvent(envelope: RunEventEnvelope, payload: RunEventPayload): RunEvent {
  return RunEventSchema.parse({ ...envelope, ...payload });
}
