import { createHash, generateKeyPairSync, sign, verify } from "node:crypto";
import { create } from "jsondiffpatch";
import { z } from "zod";
import {
  CapabilityArtifactSchema,
  PermissionSetSchema,
  type CapabilityArtifact,
  type PermissionSet,
} from "../core/contracts.js";
import { artifactDigest } from "./compiler.js";

const hex = z.string().regex(/^[a-f0-9]{64}$/);
const ReviewBodySchema = z.strictObject({
  version: z.literal(1),
  artifactId: z.string().min(1),
  revision: z.number().int().positive(),
  artifactSha256: hex,
  policySha256: hex,
  reviewer: z.string().min(1).max(100),
  reason: z.string().min(8).max(1000),
  issuedAt: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
});
export const ApprovalSchema = z.strictObject({
  body: ReviewBodySchema,
  signature: z.string().regex(/^[A-Za-z0-9+/]+={0,2}$/),
});
export type Approval = z.infer<typeof ApprovalSchema>;
const policyDigest = (policy: PermissionSet): string =>
  createHash("sha256")
    .update(JSON.stringify(PermissionSetSchema.parse(policy)))
    .digest("hex");
const bytes = (body: z.infer<typeof ReviewBodySchema>): Buffer =>
  Buffer.from(JSON.stringify(ReviewBodySchema.parse(body)));

export const reviewerKeys = (): { privateKey: string; publicKey: string } =>
  generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });

export const approveArtifact = (options: {
  artifact: CapabilityArtifact;
  policy: PermissionSet;
  reviewer: string;
  reason: string;
  privateKey: string;
  now?: Date;
  validHours?: number;
}): Approval => {
  const artifact = CapabilityArtifactSchema.parse(options.artifact);
  const hours = options.validHours ?? 24;
  if (!Number.isInteger(hours) || hours < 1 || hours > 168)
    throw new Error("Approval validity must be 1–168 hours");
  const now = options.now ?? new Date();
  const body = ReviewBodySchema.parse({
    version: 1,
    artifactId: artifact.id,
    revision: artifact.revision,
    artifactSha256: artifactDigest(artifact),
    policySha256: policyDigest(options.policy),
    reviewer: options.reviewer,
    reason: options.reason,
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + hours * 3_600_000).toISOString(),
  });
  return { body, signature: sign(null, bytes(body), options.privateKey).toString("base64") };
};

/** Trust is supplied separately by the caller. Never trust a key embedded in an approval. */
export const verifyApproval = (options: {
  artifact: CapabilityArtifact;
  policy: PermissionSet;
  approval: unknown;
  trustedPublicKey: string;
  now?: Date;
}): Approval => {
  const approval = ApprovalSchema.parse(options.approval);
  const artifact = CapabilityArtifactSchema.parse(options.artifact);
  const body = approval.body;
  if (
    !verify(null, bytes(body), options.trustedPublicKey, Buffer.from(approval.signature, "base64"))
  )
    throw new Error("Approval signature is not trusted");
  const now = (options.now ?? new Date()).getTime();
  if (
    Date.parse(body.issuedAt) > now ||
    Date.parse(body.expiresAt) <= now ||
    Date.parse(body.expiresAt) <= Date.parse(body.issuedAt) ||
    Date.parse(body.expiresAt) - Date.parse(body.issuedAt) > 168 * 3_600_000
  )
    throw new Error("Approval is expired or has an invalid validity window");
  if (
    body.artifactSha256 !== artifactDigest(artifact) ||
    body.artifactId !== artifact.id ||
    body.revision !== artifact.revision
  )
    throw new Error("Artifact changed after approval");
  if (body.policySha256 !== policyDigest(options.policy))
    throw new Error("Runtime policy changed after approval");
  return approval;
};

export const diffArtifacts = (before: unknown, after: unknown): unknown => {
  const left = CapabilityArtifactSchema.parse(before);
  const right = CapabilityArtifactSchema.parse(after);
  const differ = create({
    objectHash: (object) => ("id" in object ? String(object.id) : JSON.stringify(object)),
    arrays: { detectMove: true },
  });
  return {
    beforeSha256: artifactDigest(left),
    afterSha256: artifactDigest(right),
    changed: artifactDigest(left) !== artifactDigest(right),
    delta: differ.diff(left, right) ?? null,
  };
};
