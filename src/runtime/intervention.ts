import { randomUUID } from "node:crypto";
import type { RunSession } from "./session.js";

export type InterventionReason =
  | "stuck"
  | "ambiguous_target"
  | "policy_block"
  | "risky_action"
  | "runtime_state";

export type InterventionStatus = "requested" | "human_active" | "resumed" | "aborted";

export type InterventionRequest = {
  id: string;
  runId: string;
  capabilityId: string;
  stepId: string;
  goal: string;
  reason: InterventionReason;
  summary: string;
  sessionId: string;
  createdAt: string;
  status: InterventionStatus;
};

type PendingIntervention = {
  request: InterventionRequest;
  session: RunSession;
  verifyResume: () => Promise<boolean>;
  resolve: (resolution: InterventionResolution) => void;
  queue: Promise<void>;
};

export type InterventionResolution =
  | { kind: "resumed"; request: InterventionRequest }
  | { kind: "aborted"; request: InterventionRequest; reason: string };

export type InterventionHandle = {
  request: InterventionRequest;
  resolution: Promise<InterventionResolution>;
};

export type InterventionEvent = {
  type:
    | "intervention_created"
    | "automation_released"
    | "human_claimed"
    | "human_action"
    | "human_released"
    | "resume_verified"
    | "automation_claimed"
    | "intervention_aborted";
  interventionId: string;
  sessionId: string;
  at: string;
  detail?: string;
};

export type HumanAction =
  | { kind: "click"; x: number; y: number }
  | { kind: "type"; text: string }
  | { kind: "key"; key: string }
  | { kind: "reload" };

const now = (): string => new Date().toISOString();

export class InterventionCoordinator {
  readonly #pending = new Map<string, PendingIntervention>();
  readonly #events: InterventionEvent[] = [];

  list(): InterventionRequest[] {
    return [...this.#pending.values()].map(({ request }) => ({ ...request }));
  }

  get(id: string): InterventionRequest | undefined {
    const pending = this.#pending.get(id);
    return pending ? { ...pending.request } : undefined;
  }

  events(id?: string): InterventionEvent[] {
    return this.#events
      .filter((event) => id === undefined || event.interventionId === id)
      .map((event) => ({ ...event }));
  }

  request(options: {
    session: RunSession;
    runId: string;
    capabilityId: string;
    stepId: string;
    goal: string;
    reason: InterventionReason;
    summary: string;
    verifyResume: () => Promise<boolean>;
  }): InterventionHandle {
    options.session.pauseAutomation();
    const id = randomUUID();
    const request: InterventionRequest = {
      id,
      runId: options.runId,
      capabilityId: options.capabilityId,
      stepId: options.stepId,
      goal: options.goal,
      reason: options.reason,
      summary: options.summary,
      sessionId: options.session.id,
      createdAt: now(),
      status: "requested",
    };

    this.#record("intervention_created", request);
    this.#record("automation_released", request);

    const resolution = new Promise<InterventionResolution>((resolve) => {
      this.#pending.set(id, {
        request,
        session: options.session,
        verifyResume: options.verifyResume,
        resolve,
        queue: Promise.resolve(),
      });
    });
    return { request: { ...request }, resolution };
  }

  claim(id: string): InterventionRequest {
    const pending = this.#require(id);
    if (pending.request.status !== "requested") {
      throw new Error(`Intervention ${id} is ${pending.request.status}`);
    }
    pending.session.claimHuman();
    pending.request.status = "human_active";
    this.#record("human_claimed", pending.request);
    return { ...pending.request };
  }

  async act(id: string, action: HumanAction): Promise<void> {
    const pending = this.#require(id);
    await this.#serialize(pending, async () => {
      if (pending.request.status !== "human_active") {
        throw new Error(`Human does not control intervention ${id}`);
      }

      await pending.session.withHuman(async (page) => {
        switch (action.kind) {
          case "click":
            await page.mouse.click(action.x, action.y);
            break;
          case "type":
            await page.keyboard.type(action.text);
            break;
          case "key":
            await page.keyboard.press(action.key);
            break;
          case "reload":
            await page.reload();
            break;
        }
      });
      this.#record("human_action", pending.request, action.kind);
    });
  }

  async screenshot(id: string): Promise<Buffer> {
    const pending = this.#require(id);
    return pending.session.page.screenshot({ type: "png" });
  }

  async resume(id: string): Promise<InterventionRequest> {
    const pending = this.#require(id);
    return this.#serialize(pending, async () => {
      if (pending.request.status !== "human_active") {
        throw new Error(`Human does not control intervention ${id}`);
      }
      if (!(await pending.verifyResume())) {
        throw new Error("Resume checkpoint is not satisfied");
      }

      this.#record("resume_verified", pending.request);
      pending.session.releaseHuman();
      this.#record("human_released", pending.request);
      pending.session.resumeAutomation();
      this.#record("automation_claimed", pending.request);
      pending.request.status = "resumed";
      const result = { ...pending.request };
      this.#pending.delete(id);
      pending.resolve({ kind: "resumed", request: result });
      return result;
    });
  }

  async abort(id: string, reason: string): Promise<InterventionRequest> {
    const pending = this.#require(id);
    return this.#serialize(pending, async () => {
      if (this.#pending.get(id) !== pending || pending.request.status === "resumed") {
        throw new Error(`Intervention ${id} is no longer pending`);
      }
      if (pending.session.owner === "human") pending.session.releaseHuman();
      pending.request.status = "aborted";
      this.#record("intervention_aborted", pending.request, reason);
      const result = { ...pending.request };
      this.#pending.delete(id);
      pending.resolve({ kind: "aborted", request: result, reason });
      return result;
    });
  }

  async #serialize<T>(pending: PendingIntervention, operation: () => Promise<T>): Promise<T> {
    const previous = pending.queue;
    let release = (): void => undefined;
    pending.queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  #require(id: string): PendingIntervention {
    const pending = this.#pending.get(id);
    if (!pending) throw new Error(`Unknown intervention ${id}`);
    return pending;
  }

  #record(type: InterventionEvent["type"], request: InterventionRequest, detail?: string): void {
    this.#events.push({
      type,
      interventionId: request.id,
      sessionId: request.sessionId,
      at: now(),
      ...(detail === undefined ? {} : { detail }),
    });
  }
}
