import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { CapabilityArtifactSchema } from "../core/contracts.js";
import { RunEventSchema } from "../core/events.js";

const manifestPath = "evidence/manifest.json";

const ManifestStatusSchema = z.enum(["pending", "collecting", "complete"]);
const ScenarioKindSchema = z.enum([
  "discovery",
  "replay-success",
  "replay-business-outcome",
  "replay-recovery",
  "replay-failure",
  "handoff",
]);
const FileRoleSchema = z.enum([
  "events",
  "summary",
  "artifact",
  "result",
  "intervention",
  "screenshot",
  "other",
]);

const EvidenceFileSchema = z.strictObject({
  path: z.string().min(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  role: FileRoleSchema,
});

const EvidenceScenarioSchema = z.strictObject({
  id: z.string().min(1),
  kind: ScenarioKindSchema,
  runId: z.string().min(1),
  command: z.string().min(1),
  expectedStatus: z.string().min(1),
  modelCalls: z.number().int().nonnegative(),
  sourceRevision: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  files: z.array(EvidenceFileSchema),
});

const EvidenceManifestSchema = z.strictObject({
  schemaVersion: z.literal("1.0"),
  status: ManifestStatusSchema,
  syntheticDataOnly: z.literal(true),
  note: z.string().min(1),
  generatedAt: z.iso.datetime().optional(),
  sourceRevision: z.string().min(1).optional(),
  scenarios: z.array(EvidenceScenarioSchema),
});

type ManifestStatus = z.infer<typeof ManifestStatusSchema>;
type ScenarioKind = z.infer<typeof ScenarioKindSchema>;
type FileRole = z.infer<typeof FileRoleSchema>;
type EvidenceScenario = z.infer<typeof EvidenceScenarioSchema>;
type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;
type JsonObject = Record<string, unknown>;

const expectedStatuses: Readonly<Record<ScenarioKind, readonly string[]>> = {
  discovery: ["success"],
  "replay-success": ["success"],
  "replay-business-outcome": ["business_outcome"],
  "replay-recovery": ["success"],
  "replay-failure": ["failure"],
  handoff: ["success", "escalated"],
};

export type VerificationIssue = {
  path: string;
  message: string;
};

export type EvidenceVerification = {
  status: ManifestStatus | "invalid";
  scenarioCount: number;
  checkedFileCount: number;
  issues: VerificationIssue[];
};

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function addIssue(issues: VerificationIssue[], path: string, message: string): void {
  issues.push({ path, message });
}

function addSchemaIssues(
  issues: VerificationIssue[],
  basePath: string,
  problems: readonly { path: PropertyKey[]; message: string }[],
): void {
  for (const problem of problems) {
    const suffix = problem.path.map(String).join(".");
    addIssue(issues, suffix.length === 0 ? basePath : `${basePath}.${suffix}`, problem.message);
  }
}

function rolesFor(scenario: EvidenceScenario): FileRole[] {
  return scenario.files.map(({ role }) => role);
}

function requireRole(
  roles: FileRole[],
  role: FileRole,
  scenarioPath: string,
  issues: VerificationIssue[],
): void {
  if (!roles.includes(role)) {
    addIssue(issues, `${scenarioPath}.files`, `must include a file with role ${role}`);
  }
}

function validateCoverage(manifest: EvidenceManifest, issues: VerificationIssue[]): void {
  if (manifest.status === "pending" && manifest.scenarios.length !== 0) {
    addIssue(issues, `${manifestPath}.scenarios`, "must be empty while status is pending");
  }
  if (manifest.status !== "pending" && manifest.scenarios.length === 0) {
    addIssue(issues, `${manifestPath}.scenarios`, "must not be empty after collection starts");
  }
  if (manifest.status !== "complete") return;

  if (manifest.generatedAt === undefined) {
    addIssue(issues, `${manifestPath}.generatedAt`, "is required when status is complete");
  }
  if (manifest.sourceRevision === undefined) {
    addIssue(issues, `${manifestPath}.sourceRevision`, "is required when status is complete");
  }
  const kinds = new Set(manifest.scenarios.map(({ kind }) => kind));
  for (const required of [
    "discovery",
    "replay-success",
    "replay-business-outcome",
    "handoff",
  ] satisfies ScenarioKind[]) {
    if (!kinds.has(required)) {
      addIssue(issues, `${manifestPath}.scenarios`, `complete evidence is missing ${required}`);
    }
  }
  if (!kinds.has("replay-recovery") && !kinds.has("replay-failure")) {
    addIssue(
      issues,
      `${manifestPath}.scenarios`,
      "complete evidence needs a recovery or hard-failure replay",
    );
  }
}

function validateScenarios(manifest: EvidenceManifest, issues: VerificationIssue[]): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [index, scenario] of manifest.scenarios.entries()) {
    const scenarioPath = `${manifestPath}.scenarios.${index}`;
    if (ids.has(scenario.id)) {
      addIssue(issues, `${scenarioPath}.id`, `duplicate scenario id: ${scenario.id}`);
    }
    ids.add(scenario.id);

    if (scenario.kind === "discovery" && scenario.modelCalls < 1) {
      addIssue(
        issues,
        `${scenarioPath}.modelCalls`,
        "live discovery must record at least one call",
      );
    } else if (scenario.kind !== "discovery" && scenario.modelCalls !== 0) {
      addIssue(
        issues,
        `${scenarioPath}.modelCalls`,
        "non-discovery evidence must record zero calls",
      );
    }
    if (!expectedStatuses[scenario.kind].includes(scenario.expectedStatus)) {
      addIssue(
        issues,
        `${scenarioPath}.expectedStatus`,
        `must be one of ${expectedStatuses[scenario.kind].join(", ")} for ${scenario.kind}`,
      );
    }

    const roles = rolesFor(scenario);
    requireRole(roles, "events", scenarioPath, issues);
    if (scenario.kind === "discovery") {
      requireRole(roles, "summary", scenarioPath, issues);
      requireRole(roles, "artifact", scenarioPath, issues);
    } else {
      requireRole(roles, "result", scenarioPath, issues);
    }
    if (scenario.kind === "replay-failure") {
      requireRole(roles, "screenshot", scenarioPath, issues);
    }
    if (scenario.kind === "handoff") {
      requireRole(roles, "intervention", scenarioPath, issues);
      requireRole(roles, "screenshot", scenarioPath, issues);
    }
    for (const singleton of ["events", "summary", "artifact", "result", "intervention"] as const) {
      if (roles.filter((role) => role === singleton).length > 1) {
        addIssue(issues, `${scenarioPath}.files`, `role ${singleton} may appear only once`);
      }
    }
    for (const [fileIndex, file] of scenario.files.entries()) {
      if (paths.has(file.path)) {
        addIssue(
          issues,
          `${scenarioPath}.files.${fileIndex}.path`,
          `file is referenced more than once: ${file.path}`,
        );
      }
      paths.add(file.path);
    }
  }
}

function resolveEvidencePath(repoRoot: string, declaredPath: string): string | undefined {
  if (isAbsolute(declaredPath) || declaredPath.includes("\\")) return undefined;
  const absolute = resolve(repoRoot, declaredPath);
  const fromEvidence = relative(resolve(repoRoot, "evidence"), absolute);
  if (fromEvidence === "" || fromEvidence === ".." || fromEvidence.startsWith(`..${sep}`)) {
    return undefined;
  }
  return absolute;
}

async function digest(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

async function readJson(
  absolutePath: string,
  displayPath: string,
  issues: VerificationIssue[],
): Promise<unknown> {
  try {
    return JSON.parse(await readFile(absolutePath, "utf8")) as unknown;
  } catch (error) {
    addIssue(
      issues,
      displayPath,
      `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

function validateRunDocument(
  value: unknown,
  scenario: EvidenceScenario,
  displayPath: string,
  issues: VerificationIssue[],
): void {
  if (!isObject(value)) {
    addIssue(issues, displayPath, "must contain a JSON object");
    return;
  }
  const run = isObject(value.result) ? value.result : value;
  if (run.runId !== scenario.runId) {
    addIssue(issues, `${displayPath}.runId`, `must equal manifest runId ${scenario.runId}`);
  }
  if (run.status !== scenario.expectedStatus) {
    addIssue(
      issues,
      `${displayPath}.status`,
      `must equal manifest expectedStatus ${scenario.expectedStatus}`,
    );
  }
  if (value.modelCalls !== undefined && value.modelCalls !== scenario.modelCalls) {
    addIssue(
      issues,
      `${displayPath}.modelCalls`,
      `must equal manifest modelCalls ${scenario.modelCalls}`,
    );
  }
}

function validateArtifact(
  value: unknown,
  scenario: EvidenceScenario,
  displayPath: string,
  issues: VerificationIssue[],
): void {
  const parsed = CapabilityArtifactSchema.safeParse(value);
  if (!parsed.success) {
    addSchemaIssues(issues, displayPath, parsed.error.issues);
    return;
  }
  if (parsed.data.discoveryRunId !== scenario.runId) {
    addIssue(
      issues,
      `${displayPath}.discoveryRunId`,
      `must equal discovery runId ${scenario.runId}`,
    );
  }
}

async function validateEvents(
  absolutePath: string,
  displayPath: string,
  scenario: EvidenceScenario,
  issues: VerificationIssue[],
): Promise<void> {
  const lines = (await readFile(absolutePath, "utf8")).split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) {
    addIssue(issues, displayPath, "event log must not be empty");
    return;
  }

  let previousSequence: number | undefined;
  let previousTimestamp: number | undefined;
  let modelCalls = 0;
  let relevantPhaseSeen = false;
  for (const [index, line] of lines.entries()) {
    const eventPath = `${displayPath}:${index + 1}`;
    if (line.trim().length === 0) {
      addIssue(issues, eventPath, "blank lines are not valid JSONL events");
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error) {
      addIssue(
        issues,
        eventPath,
        `invalid JSONL event: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    const parsed = RunEventSchema.safeParse(value);
    if (!parsed.success) {
      addSchemaIssues(issues, eventPath, parsed.error.issues);
      continue;
    }
    const event = parsed.data;
    if (event.runId !== scenario.runId) {
      addIssue(issues, `${eventPath}.runId`, `must equal manifest runId ${scenario.runId}`);
    }
    if (previousSequence === undefined && event.sequence !== 0 && event.sequence !== 1) {
      addIssue(issues, `${eventPath}.sequence`, "first sequence must be 0 or 1");
    }
    if (previousSequence !== undefined && event.sequence !== previousSequence + 1) {
      addIssue(issues, `${eventPath}.sequence`, `must follow sequence ${previousSequence}`);
    }
    previousSequence = event.sequence;
    const timestamp = Date.parse(event.timestamp);
    if (previousTimestamp !== undefined && timestamp < previousTimestamp) {
      addIssue(issues, `${eventPath}.timestamp`, "must not move backwards");
    }
    previousTimestamp = timestamp;
    if (
      (scenario.kind === "discovery" && event.phase === "discovery") ||
      (scenario.kind !== "discovery" && (event.phase === "replay" || event.phase === "handoff"))
    ) {
      relevantPhaseSeen = true;
    }
    if (event.actor.type === "model") modelCalls += 1;
  }

  if (!relevantPhaseSeen) {
    addIssue(
      issues,
      displayPath,
      `contains no ${scenario.kind === "discovery" ? "discovery" : "replay/handoff"} event`,
    );
  }
  if (modelCalls !== scenario.modelCalls) {
    addIssue(
      issues,
      displayPath,
      `contains ${modelCalls} model-authored events; manifest declares ${scenario.modelCalls} modelCalls`,
    );
  }
}

async function verifyScenarioFiles(
  repoRoot: string,
  scenario: EvidenceScenario,
  issues: VerificationIssue[],
): Promise<number> {
  let checked = 0;
  for (const file of scenario.files) {
    const absolutePath = resolveEvidencePath(repoRoot, file.path);
    if (absolutePath === undefined) {
      addIssue(issues, file.path, "must be a repository-relative path inside evidence/");
      continue;
    }
    try {
      if (!(await lstat(absolutePath)).isFile()) {
        addIssue(issues, file.path, "must resolve to a regular file, not a symlink");
        continue;
      }
    } catch {
      addIssue(issues, file.path, "referenced file does not exist");
      continue;
    }
    checked += 1;
    const actualHash = await digest(absolutePath);
    if (actualHash !== file.sha256) {
      addIssue(issues, file.path, `SHA-256 mismatch (actual ${actualHash})`);
      continue;
    }

    if (file.role === "events") {
      await validateEvents(absolutePath, file.path, scenario, issues);
      continue;
    }
    if (file.role === "summary" || file.role === "result") {
      const value = await readJson(absolutePath, file.path, issues);
      if (value !== undefined) validateRunDocument(value, scenario, file.path, issues);
      continue;
    }
    if (file.role === "artifact") {
      const value = await readJson(absolutePath, file.path, issues);
      if (value !== undefined) validateArtifact(value, scenario, file.path, issues);
      continue;
    }
    if (file.role === "intervention") {
      const value = await readJson(absolutePath, file.path, issues);
      if (!isObject(value) || value.runId !== scenario.runId) {
        addIssue(issues, `${file.path}.runId`, `must equal manifest runId ${scenario.runId}`);
      }
    }
  }
  return checked;
}

export async function verifyEvidence(repoRoot = process.cwd()): Promise<EvidenceVerification> {
  const issues: VerificationIssue[] = [];
  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(await readFile(resolve(repoRoot, manifestPath), "utf8")) as unknown;
  } catch (error) {
    addIssue(
      issues,
      manifestPath,
      `cannot read valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { status: "invalid", scenarioCount: 0, checkedFileCount: 0, issues };
  }
  const parsed = EvidenceManifestSchema.safeParse(rawManifest);
  if (!parsed.success) {
    addSchemaIssues(issues, manifestPath, parsed.error.issues);
    return { status: "invalid", scenarioCount: 0, checkedFileCount: 0, issues };
  }

  const manifest = parsed.data;
  validateCoverage(manifest, issues);
  validateScenarios(manifest, issues);
  let checkedFileCount = 0;
  if (manifest.status !== "pending") {
    for (const scenario of manifest.scenarios) {
      checkedFileCount += await verifyScenarioFiles(repoRoot, scenario, issues);
    }
  }
  return {
    status: issues.length === 0 ? manifest.status : "invalid",
    scenarioCount: manifest.scenarios.length,
    checkedFileCount,
    issues,
  };
}

async function main(): Promise<void> {
  const result = await verifyEvidence();
  if (result.issues.length > 0) {
    console.error(`Evidence verification failed with ${result.issues.length} issue(s):`);
    for (const problem of result.issues) {
      console.error(`- ${problem.path}: ${problem.message}`);
    }
    process.exitCode = 1;
  } else if (result.status === "pending") {
    console.log("Evidence manifest is valid and explicitly pending live evidence collection.");
  } else {
    console.log(
      `Evidence verified: ${result.scenarioCount} scenario(s), ${result.checkedFileCount} file(s).`,
    );
  }
}

const entryPath = process.argv[1];
if (entryPath !== undefined && fileURLToPath(import.meta.url) === resolve(entryPath)) {
  await main();
}
