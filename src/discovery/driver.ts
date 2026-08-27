import type { DiscoveryDecision } from "../core/contracts.js";
import type { DiscoveryAction } from "../artifact/compiler.js";
import type { SurfaceObservation } from "../surface/playwright.js";
import type { Command, Risk } from "../core/contracts.js";

export type DiscoveryPrompt = {
  goal: string;
  step: number;
  inputNames: string[];
  outputNames: string[];
  nextStep: { kind: Command["kind"]; description: string; risk: Risk };
  signal: AbortSignal;
  observation: SurfaceObservation;
  history: DiscoveryAction[];
  screenshotBase64?: string;
};

export interface ModelDriver {
  readonly name: string;
  readonly model: string;
  decide(prompt: DiscoveryPrompt): Promise<DiscoveryDecision>;
}
