import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  CapabilityArtifactSchema,
  type CapabilityArtifact,
  type PermissionSet,
} from "../core/contracts.js";
import { EventRecorder } from "../core/event-recorder.js";
import type { RedactionOptions } from "../core/redact.js";
import { RunSession } from "../runtime/session.js";
import { PlaywrightSurface } from "../surface/playwright.js";

export type RuntimeContext = {
  runId: string;
  runDirectory: string;
  session: RunSession;
  surface: PlaywrightSurface;
  recorder: EventRecorder;
  close: () => Promise<void>;
};

export const runtimePermissionsFor = (origin: string): PermissionSet => ({
  origins: [new URL(origin).origin],
  routes: [
    "/",
    "/search",
    "/members/search",
    "/members/:memberId",
    "/members/:memberId/dismiss-interstitial",
    "/members/:memberId/subaccounts/new",
    "/members/:memberId/subaccounts/review",
  ],
  actions: ["navigate", "fill", "click", "read", "wait"],
});

export const createRuntimeContext = async (options: {
  runtimePermissions: PermissionSet;
  runsDirectory?: string;
  runId?: string;
  headless?: boolean;
  redaction?: RedactionOptions;
}): Promise<RuntimeContext> => {
  const runId = options.runId ?? randomUUID();
  const runDirectory = resolve(options.runsDirectory ?? process.env.CUA_RUNS_DIR ?? ".runs", runId);
  await mkdir(runDirectory, { recursive: true, mode: 0o700 });
  const session = await RunSession.launch({
    headless: options.headless ?? process.env.CUA_HEADLESS !== "false",
    permissions: options.runtimePermissions,
  });
  const surface = new PlaywrightSurface({ session, runDirectory });
  const recorder = new EventRecorder({
    runId,
    path: resolve(runDirectory, "events.jsonl"),
    ...(options.redaction === undefined ? {} : { redaction: options.redaction }),
  });
  return {
    runId,
    runDirectory,
    session,
    surface,
    recorder,
    close: () => session.close(),
  };
};

export const writeJson = async (path: string, value: unknown): Promise<void> => {
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
};

export const readArtifact = async (path: string): Promise<CapabilityArtifact> =>
  CapabilityArtifactSchema.parse(JSON.parse(await readFile(resolve(path), "utf8")));
