import { z } from "zod";

import {
  CommandKindSchema,
  PermissionSetSchema,
  RiskSchema,
  type Command,
  type PermissionSet,
  type Risk,
} from "./contracts.js";

export const PolicyLayerSchema = z.strictObject({
  name: z.string().min(1),
  permissions: PermissionSetSchema,
});
export type PolicyLayer = z.infer<typeof PolicyLayerSchema>;

export const PolicySchema = z.strictObject({
  layers: z.array(PolicyLayerSchema).min(1),
  irreversibleActions: z.enum(["deny", "intervene"]),
});
export type Policy = z.infer<typeof PolicySchema>;

export const PolicyRequestSchema = z.strictObject({
  action: CommandKindSchema,
  url: z.string().min(1),
  risk: RiskSchema,
});
export type PolicyRequest = z.infer<typeof PolicyRequestSchema>;

export const PolicyDenialCodeSchema = z.enum([
  "no_policy",
  "invalid_url",
  "origin_not_allowed",
  "route_not_allowed",
  "action_not_allowed",
  "irreversible_action",
]);
export type PolicyDenialCode = z.infer<typeof PolicyDenialCodeSchema>;

export const PolicyDecisionSchema = z.discriminatedUnion("decision", [
  z.strictObject({
    decision: z.literal("allow"),
  }),
  z.strictObject({
    decision: z.literal("deny"),
    code: PolicyDenialCodeSchema,
    reason: z.string().min(1),
    layer: z.string().min(1).optional(),
  }),
  z.strictObject({
    decision: z.literal("intervene"),
    code: z.literal("irreversible_action"),
    reason: z.string().min(1),
  }),
]);
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

/** Matches literal segments, `:parameter` segments, and a final `*` suffix. */
export function routeMatches(pathname: string, route: string): boolean {
  const pathSegments = pathname.split("/").filter(Boolean);
  const routeSegments = route.split("/").filter(Boolean);

  for (const [index, segment] of routeSegments.entries()) {
    if (segment === "*") return true;
    const actual = pathSegments[index];
    if (actual === undefined) return false;
    if (!segment.startsWith(":") && segment !== actual) return false;
  }
  return pathSegments.length === routeSegments.length;
}

const riskRank: Readonly<Record<Risk, number>> = {
  safe: 0,
  reversible: 1,
  irreversible: 2,
};

const inferredRisk = (command: Command, observedTarget = ""): Risk => {
  if (command.kind === "navigate" || command.kind === "read" || command.kind === "wait") {
    return "safe";
  }
  if (command.kind === "fill" || command.kind === "select") return "reversible";

  const targetText = [
    command.target.description,
    observedTarget,
    ...command.target.strategies.flatMap((strategy) => {
      if (strategy.kind === "role") return [strategy.name];
      if (strategy.kind === "label" || strategy.kind === "text") return [strategy.text];
      return [];
    }),
  ].join(" ");
  return /\b(?:approve|buy|close account|confirm|create|delete|pay|purchase|send|submit|transfer)\b/i.test(
    targetText,
  )
    ? "irreversible"
    : "reversible";
};

/** Artifact/profile risk can raise this result, but cannot lower the runtime's independent floor. */
export function effectiveCommandRisk(command: Command, declared: Risk, observedTarget = ""): Risk {
  const inferred = inferredRisk(command, observedTarget);
  return riskRank[inferred] > riskRank[declared] ? inferred : declared;
}

export function permissionSetAllows(
  permissions: PermissionSet,
  request: PolicyRequest,
  url: URL,
): PolicyDenialCode | undefined {
  const allowedOrigin = permissions.origins.some((origin) => new URL(origin).origin === url.origin);
  if (!allowedOrigin) {
    return "origin_not_allowed";
  }

  if (!permissions.routes.some((route) => routeMatches(url.pathname, route))) {
    return "route_not_allowed";
  }

  if (!permissions.actions.includes(request.action)) {
    return "action_not_allowed";
  }

  return undefined;
}

/**
 * Evaluates every layer independently, giving runtime and artifact allowlists intersection semantics.
 * The function is deliberately side-effect free so discovery and replay use identical enforcement.
 */
export function evaluatePolicy(policy: Policy, request: PolicyRequest): PolicyDecision {
  if (policy.layers.length === 0) {
    return {
      decision: "deny",
      code: "no_policy",
      reason: "No policy layer was configured",
    };
  }

  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return {
      decision: "deny",
      code: "invalid_url",
      reason: `Invalid URL: ${request.url}`,
    };
  }

  if (url.username !== "" || url.password !== "") {
    return {
      decision: "deny",
      code: "invalid_url",
      reason: "URLs containing credentials are not permitted",
    };
  }

  for (const layer of policy.layers) {
    const denial = permissionSetAllows(layer.permissions, request, url);
    if (denial !== undefined) {
      return {
        decision: "deny",
        code: denial,
        reason: `${layer.name} policy rejected ${request.action} at ${url.origin}${url.pathname}`,
        layer: layer.name,
      };
    }
  }

  if (request.risk === "irreversible") {
    if (policy.irreversibleActions === "intervene") {
      return {
        decision: "intervene",
        code: "irreversible_action",
        reason: "Irreversible actions require a human controller",
      };
    }

    return {
      decision: "deny",
      code: "irreversible_action",
      reason: "Irreversible actions are disabled by policy",
    };
  }

  return { decision: "allow" };
}
