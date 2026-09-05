import type {
  ActionReceipt,
  CheckReceipt,
  Command,
  Condition,
  EvidenceRef,
  Observation,
  LocatorAttempt,
  Target,
} from "../core/contracts.js";

export class LocatorResolutionError extends Error {
  readonly attempts: LocatorAttempt[];
  constructor(target: Target, attempts: LocatorAttempt[]) {
    super(`No unique locator strategy resolved target: ${target.description}`);
    this.name = "LocatorResolutionError";
    this.attempts = attempts;
  }
}
export const describeTarget = (target: Target): string =>
  `${target.description} (${target.strategies
    .map((strategy): string => {
      switch (strategy.kind) {
        case "role":
          return `role=${strategy.role} name=${strategy.name}`;
        case "label":
          return `label=${strategy.text}`;
        case "text":
          return `text=${strategy.text}`;
        case "css":
          return `css=${strategy.selector}`;
        default:
          throw new Error("Unsupported locator strategy");
      }
    })
    .join(" -> ")})`;

export type ObservedControl = {
  frameUrl: string;
  tag: string;
  role: string;
  text: string;
  selector: string;
  name?: string;
  type?: string;
  href?: string;
  placeholder?: string;
  src?: string;
  title?: string;
};
export type SurfaceObservation = Observation & { controls: ObservedControl[] };
export type SurfaceActionResult = { receipt: ActionReceipt; value?: unknown };
export type SurfacePolicyContext = { url: string; fingerprint: string; riskText: string };

/** Runner port. Browser session ownership belongs to the composition root, not this port. */
export interface SurfaceAdapter {
  readonly runDirectory: string;
  observe(options?: { capture?: boolean; reason?: string }): Promise<SurfaceObservation>;
  policyContext(command: Command): Promise<SurfacePolicyContext>;
  execute(
    command: Command,
    timeoutMs?: number,
    expectedPolicy?: SurfacePolicyContext,
  ): Promise<SurfaceActionResult>;
  check(condition: Condition, options?: { timeoutMs?: number }): Promise<CheckReceipt>;
  capture(reason: string): Promise<EvidenceRef>;
  humanCheck(condition: Condition): Promise<boolean>;
}
