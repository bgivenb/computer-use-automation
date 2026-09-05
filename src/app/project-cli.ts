import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  approveArtifact,
  diffArtifacts,
  reviewerKeys,
  verifyApproval,
} from "../artifact/review.js";
import { artifactDigest } from "../artifact/compiler.js";
import { PermissionSetSchema } from "../core/contracts.js";
import { createDemoProfile } from "../demo/profile.js";
import { prepareReplay } from "./replay.js";
import { readArtifact } from "./runtime.js";
import { evaluateReplays } from "../evaluation/run.js";

export const readJson = async (path: string): Promise<unknown> =>
  JSON.parse(await readFile(resolve(path), "utf8"));
const required = (values: Record<string, string | undefined>, key: string): string => {
  const value = values[key];
  if (!value) throw new Error(`--${key} is required`);
  return value;
};
const saveNew = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
};

export const projectCommand = async (command: string, args: string[]): Promise<unknown> => {
  const flags: Record<string, string[]> = {
    inspect: ["artifact"],
    diff: ["before", "after"],
    keygen: ["directory"],
    approve: ["artifact", "policy", "key", "reviewer", "reason", "out", "hours"],
    run: ["artifact", "policy", "inputs", "approval", "trusted-key"],
    profile: ["target", "out"],
    evaluate: ["repeat", "out"],
  };
  const keys = flags[command];
  if (!keys) throw new Error(`Unknown project command: ${command}`);
  const { values } = parseArgs({
    args,
    strict: true,
    options: Object.fromEntries(keys.map((key) => [key, { type: "string" as const }])),
  });
  const arg = (key: string): string => required(values, key);
  if (command === "evaluate") {
    const result = await evaluateReplays({
      ...(values.repeat ? { repeat: Number(values.repeat) } : {}),
      ...(values.out ? { output: values.out } : {}),
    });
    if (result.report.passed !== result.report.trialCount) process.exitCode = 4;
    return result;
  }
  if (command === "keygen") {
    const directory = resolve(arg("directory"));
    await mkdir(directory, { mode: 0o700 }); // Refuse an existing directory; never overwrite a key.
    const pair = reviewerKeys();
    await writeFile(resolve(directory, "reviewer-private.pem"), pair.privateKey, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(resolve(directory, "reviewer-public.pem"), pair.publicKey, {
      flag: "wx",
      mode: 0o644,
    });
    return {
      directory,
      warning:
        "Keep the private key outside the repository. Configure the trusted public key independently.",
    };
  }
  if (command === "profile") {
    const profile = createDemoProfile(new URL(arg("target")).origin);
    await saveNew(arg("out"), profile);
    return {
      saved: arg("out"),
      purpose: "Synthetic example profile; adapt and review before another target",
    };
  }
  if (command === "diff")
    return diffArtifacts(await readJson(arg("before")), await readJson(arg("after")));
  const artifact = await readArtifact(arg("artifact"));
  if (command === "inspect") return { sha256: artifactDigest(artifact), artifact };
  const policy = PermissionSetSchema.parse(await readJson(arg("policy")));
  if (command === "approve") {
    const approval = approveArtifact({
      artifact,
      policy,
      reviewer: arg("reviewer"),
      reason: arg("reason"),
      privateKey: await readFile(arg("key"), "utf8"),
      ...(values.hours ? { validHours: Number(values.hours) } : {}),
    });
    await saveNew(arg("out"), approval);
    return { saved: arg("out"), approval };
  }
  const approval = verifyApproval({
    artifact,
    policy,
    approval: await readJson(arg("approval")),
    trustedPublicKey: await readFile(arg("trusted-key"), "utf8"),
  });
  const inputs = await readJson(arg("inputs"));
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs))
    throw new Error("Inputs must be a JSON object");
  const prepared = await prepareReplay({
    artifact,
    inputValues: inputs as Record<string, unknown>,
    runtimePermissions: policy,
    allowInterventions: false,
  });
  try {
    const summary = await prepared.promise;
    if (summary.result.status === "failure") process.exitCode = 4;
    return {
      approval: { reviewer: approval.body.reviewer, expiresAt: approval.body.expiresAt },
      ...summary,
    };
  } finally {
    await prepared.close();
  }
};
