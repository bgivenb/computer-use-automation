import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { RunEventSchema, type Actor, type RunEvent, type RunPhase } from "./events.js";
import { redactValue, type RedactionOptions } from "./redact.js";

export type EventMetadata = {
  phase: RunPhase;
  actor: Actor;
  capabilityId?: string;
  stepId?: string;
};

export class EventRecorder {
  readonly runId: string;
  readonly path: string;
  readonly redaction: RedactionOptions;

  #sequence = 0;
  #events: RunEvent[] = [];

  constructor(options: { runId: string; path: string; redaction?: RedactionOptions }) {
    this.runId = options.runId;
    this.path = resolve(options.path);
    this.redaction = options.redaction ?? {};
  }

  get events(): readonly RunEvent[] {
    return this.#events;
  }

  get modelCalls(): number {
    return this.#events.filter((event) => event.type === "model.decided").length;
  }

  async record(
    metadata: EventMetadata,
    payload: { type: RunEvent["type"]; data: unknown },
  ): Promise<RunEvent> {
    const candidate = redactValue(
      {
        eventVersion: "1.0",
        timestamp: new Date().toISOString(),
        runId: this.runId,
        sequence: this.#sequence,
        phase: metadata.phase,
        actor: metadata.actor,
        ...(metadata.capabilityId === undefined ? {} : { capabilityId: metadata.capabilityId }),
        ...(metadata.stepId === undefined ? {} : { stepId: metadata.stepId }),
        type: payload.type,
        data: payload.data,
      },
      this.redaction,
    );
    const event = RunEventSchema.parse(candidate);
    this.#sequence += 1;
    this.#events.push(event);
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(event)}\n`, { encoding: "utf8", mode: 0o600 });
    return event;
  }

  static async read(path: string): Promise<RunEvent[]> {
    const content = await readFile(path, "utf8");
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
  }
}
