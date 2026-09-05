#!/usr/bin/env node
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";
import { projectCommand, readJson } from "./app/project-cli.js";
import { CapabilityProfileSchema } from "./artifact/profile.js";
import { PermissionSetSchema } from "./core/contracts.js";
import { redactValue } from "./core/redact.js";
import { artifactDigest } from "./artifact/compiler.js";
import { discoverCapability } from "./app/discover.js";
import { invalidInputSummary, prepareReplay } from "./app/replay.js";
import { readArtifact, runtimePermissionsFor } from "./app/runtime.js";
import { startDemoServer, type DemoServer } from "./demo/server.js";
import { createDemoProfile, DEMO_ACCOUNT_NICKNAME, DEMO_MEMBER_ID } from "./demo/profile.js";
import { OpenAIResponsesDriver } from "./discovery/openai.js";
import { ScriptedModelDriver } from "./discovery/scripted.js";
import type { ModelDriver } from "./discovery/driver.js";
import { startOperatorServer, type OperatorServer } from "./runtime/operator-server.js";
import type { PreparedReplay } from "./app/replay.js";

const DEFAULT_PORT = 4173;
const DEFAULT_ARTIFACT = "artifacts/examples/prepare-savings-subaccount.v1.json";
const DEFAULT_GOAL =
  "Look up member 12345, read the savings balance, and prepare a new savings sub-account named Rainy Day through the review screen.";

const usage = `Computer-use automation runtime

Usage:
  npm run dev -- serve [--port 4173]
  npm run discover -- [--driver scripted|openai] [--artifact PATH] [--headed] [--mode guided|explore] [--goal TEXT]
    External synthetic target: --target URL --profile FILE --inputs FILE --policy FILE --synthetic [--interactive]
  npm run replay -- [--artifact PATH] [--member-id 12345] [--nickname "Rainy Day"] [--interactive]
  npm run demo
  npm run cua -- inspect --artifact FILE
  npm run cua -- diff --before FILE --after FILE
  npm run cua -- keygen --directory NEW_DIRECTORY
  npm run cua -- approve --artifact FILE --policy FILE --key PRIVATE_PEM --reviewer NAME --reason TEXT --out FILE
  npm run cua -- run --artifact FILE --inputs FILE --policy FILE --approval FILE --trusted-key PUBLIC_PEM
  npm run cua -- profile --target URL --out FILE
  npm run cua -- evaluate [--repeat 3] [--out NEW_FILE]

Replay never calls a model. A genuine discovery requires OPENAI_API_KEY in the process environment.`;

const parsePort = (value: string | undefined, fallback = DEFAULT_PORT): number => {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65_535)
    throw new Error(`Invalid port: ${value}`);
  return port;
};

const output = (value: unknown): void => {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
};
const note = (message: string): void => {
  process.stderr.write(`${message}\n`);
};

const waitForSignal = async (): Promise<void> =>
  new Promise((resolve) => {
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });

const serve = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: { port: { type: "string" } },
    strict: true,
  });
  const server = await startDemoServer({ port: parsePort(values.port) });
  output({ status: "ready", target: server.origin });
  await waitForSignal();
  await server.close();
};

const driverFor = (name: string): ModelDriver => {
  if (name === "scripted") return new ScriptedModelDriver();
  if (name === "openai") {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is not set; supply it in the local process environment");
    }
    return new OpenAIResponsesDriver();
  }
  throw new Error(`Unknown discovery driver: ${name}`);
};

const discover = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      driver: { type: "string", default: "scripted" },
      artifact: { type: "string", default: `.runs/discovery-${randomUUID()}.json` },
      port: { type: "string" },
      headed: { type: "boolean", default: false },
      mode: { type: "string", default: "guided" },
      goal: { type: "string" },
      target: { type: "string" },
      profile: { type: "string" },
      inputs: { type: "string" },
      policy: { type: "string" },
      synthetic: { type: "boolean", default: false },
      interactive: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.mode !== "guided" && values.mode !== "explore")
    throw new Error("Mode must be guided or explore");
  const goal = values.goal ?? DEFAULT_GOAL;
  if (!goal.trim() || (values.target && !values.goal))
    throw new Error("External discovery requires an explicit nonempty --goal");
  if (values.target && (!values.profile || !values.inputs || !values.policy || !values.synthetic))
    throw new Error(
      "External discovery requires --profile, --inputs, --policy and --synthetic; raw screenshots are not suitable for regulated data",
    );
  if (!values.target && (values.profile || values.inputs || values.policy))
    throw new Error("Use --target with external profile, inputs and policy");
  const externalProfile = values.profile
    ? CapabilityProfileSchema.parse(await readJson(values.profile))
    : undefined;
  const externalPolicy = values.policy
    ? PermissionSetSchema.parse(await readJson(values.policy))
    : undefined;
  const externalInputs = values.inputs ? await readJson(values.inputs) : undefined;
  if (
    externalInputs !== undefined &&
    (!externalInputs || typeof externalInputs !== "object" || Array.isArray(externalInputs))
  )
    throw new Error("Inputs must be a JSON object");
  if (externalProfile && externalProfile.entryUrl !== values.target)
    throw new Error("Target must exactly match the reviewed profile entryUrl");
  const selectedDriver = driverFor(values.driver);
  const server = values.target
    ? undefined
    : await startDemoServer({ port: parsePort(values.port) });
  let operator: OperatorServer | undefined;
  try {
    const origin = values.target ? new URL(values.target).origin : (server as DemoServer).origin;
    const profile = externalProfile ?? createDemoProfile(origin);
    profile.mode = values.mode;
    const result = await discoverCapability({
      goal,
      origin,
      profile,
      inputValues: (externalInputs as Record<string, unknown>) ?? profile.inputSamples,
      driver: selectedDriver,
      artifactPath: values.artifact,
      headless: !values.headed,
      ...(externalPolicy ? { runtimePermissions: externalPolicy } : {}),
      ...(values.interactive
        ? {
            onRuntimeReady: async (_runtime, coordinator) => {
              operator = await startOperatorServer({ coordinator });
              note(`Operator console: ${operator.origin}`);
            },
          }
        : {}),
    });
    output({ ...result.summary, runDirectory: result.runDirectory });
  } finally {
    await operator?.close();
    await server?.close();
  }
};

const originPort = (origin: string): number => {
  const url = new URL(origin);
  if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") {
    throw new Error("This demo CLI starts only loopback target artifacts");
  }
  return url.port ? Number(url.port) : 80;
};

const waitForIntervention = async (prepared: PreparedReplay, timeoutMs = 15_000) => {
  const expiresAt = Date.now() + timeoutMs;
  while (Date.now() < expiresAt) {
    const [intervention] = prepared.coordinator.list();
    if (intervention) return intervention;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for the expected intervention");
};

const autoResolveIntervention = async (prepared: PreparedReplay): Promise<void> => {
  const intervention = await waitForIntervention(prepared);
  const pageBefore = prepared.runtime.session.page;
  prepared.coordinator.claim(intervention.id);
  const workspace = prepared.runtime.session.page
    .frames()
    .find((frame) => frame !== pageBefore.mainFrame());
  if (!workspace) throw new Error("Target workspace frame is missing during handoff");
  const button = workspace.getByRole("button", { name: "Dismiss and continue", exact: true });
  const box = await button.boundingBox();
  if (!box) throw new Error("Human handoff control is not visible");
  await prepared.coordinator.act(intervention.id, {
    kind: "click",
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  });
  await workspace
    .getByRole("heading", { name: "Member Detail", exact: true })
    .waitFor({ state: "visible" });
  await prepared.coordinator.resume(intervention.id);
  if (prepared.runtime.session.page !== pageBefore) {
    throw new Error("Handoff replaced the target page instead of preserving the live session");
  }
};

const runReplay = async (options: {
  artifactPath: string;
  memberId: string;
  nickname: string;
  interactive: boolean;
  demoServer?: DemoServer;
}): Promise<Awaited<PreparedReplay["promise"]>> => {
  const artifact = await readArtifact(options.artifactPath);
  const inputValues = { memberId: options.memberId, accountNickname: options.nickname };
  const inputFailure = invalidInputSummary(artifact, inputValues);
  if (inputFailure) return inputFailure;
  const targetOrigin = new URL(artifact.entryUrl).origin;
  const server = options.demoServer ?? (await startDemoServer({ port: originPort(targetOrigin) }));
  if (server.origin !== targetOrigin) {
    if (!options.demoServer) await server.close();
    throw new Error(`Artifact expects ${targetOrigin}, but target started at ${server.origin}`);
  }

  const prepared = await prepareReplay({
    artifact,
    inputValues,
    runtimePermissions: runtimePermissionsFor(server.origin),
    allowInterventions: options.interactive || options.memberId === "99999",
  });
  let operator: OperatorServer | undefined;
  try {
    if (options.interactive) {
      operator = await startOperatorServer({ coordinator: prepared.coordinator });
      note(`Operator console: ${operator.origin}`);
    } else if (options.memberId === "99999") {
      void autoResolveIntervention(prepared).catch((error: unknown) => {
        const pending = prepared.coordinator.list()[0];
        if (pending) {
          void prepared.coordinator.abort(
            pending.id,
            error instanceof Error ? error.message : "handoff failed",
          );
        }
      });
    }
    return await prepared.promise;
  } finally {
    await operator?.close();
    await prepared.close();
    if (!options.demoServer) await server.close();
  }
};

const replay = async (args: string[]): Promise<void> => {
  const { values } = parseArgs({
    args,
    options: {
      artifact: { type: "string", default: DEFAULT_ARTIFACT },
      "member-id": { type: "string", default: DEMO_MEMBER_ID },
      nickname: { type: "string", default: DEMO_ACCOUNT_NICKNAME },
      interactive: { type: "boolean", default: false },
    },
    strict: true,
  });
  const summary = await runReplay({
    artifactPath: values.artifact,
    memberId: values["member-id"],
    nickname: values.nickname,
    interactive: values.interactive,
  });
  output(summary);
  process.exitCode = summary.result.status === "failure" ? 4 : 0;
};

const demo = async (): Promise<void> => {
  const server = await startDemoServer({ port: 0 });
  const artifactPath = `.runs/demo-${Date.now()}.artifact.json`;
  try {
    const profile = createDemoProfile(server.origin);
    const discovery = await discoverCapability({
      goal: DEFAULT_GOAL,
      origin: server.origin,
      profile,
      inputValues: profile.inputSamples,
      driver: new ScriptedModelDriver(),
      artifactPath,
    });
    const cases = ["12345", "00000", "77777", "88888", "99999"];
    const replays = [];
    for (const memberId of cases) {
      replays.push(
        await runReplay({
          artifactPath,
          memberId,
          nickname: DEMO_ACCOUNT_NICKNAME,
          interactive: false,
          demoServer: server,
        }),
      );
    }
    output({
      discovery: discovery.summary,
      artifactSha256: artifactDigest(discovery.compiled.artifact),
      replays: replays.map(({ result, modelCalls, signature }) => ({
        memberId: result.status === "success" ? "successful fixture" : undefined,
        status: result.status,
        ...(result.status === "business_outcome" ? { code: result.code } : {}),
        ...(result.status === "failure" ? { category: result.category } : {}),
        modelCalls,
        signature,
      })),
    });
    const expected = ["success", "business_outcome", "success", "failure", "success"];
    if (replays.some((item, index) => item.result.status !== expected[index])) process.exitCode = 4;
  } finally {
    await server.close();
  }
};

const main = async (): Promise<void> => {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "inspect":
    case "diff":
    case "keygen":
    case "approve":
    case "run":
    case "profile":
    case "evaluate":
      output(await projectCommand(command, args));
      break;
    case "serve":
      await serve(args);
      break;
    case "discover":
      await discover(args);
      break;
    case "replay":
      await replay(args);
      break;
    case "demo":
      await demo();
      break;
    case "help":
    case "--help":
    case "-h":
    case undefined:
      process.stdout.write(`${usage}\n`);
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage}`);
  }
};

main().catch((error: unknown) => {
  process.stderr.write(
    `${redactValue(error instanceof Error ? error.message : "Unknown error")}\n`,
  );
  process.exitCode = 1;
});
