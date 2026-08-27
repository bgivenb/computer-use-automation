import type { Command, DiscoveryDecision } from "../core/contracts.js";
import { demoTargets } from "../demo/profile.js";
import type { DiscoveryPrompt, ModelDriver } from "./driver.js";

const acted = (prompt: DiscoveryPrompt, predicate: (command: Command) => boolean): boolean =>
  prompt.history.some(({ command }) => predicate(command));

const decision = (command: Command, reason: string): DiscoveryDecision => ({
  type: "act",
  command,
  reason,
});

export class ScriptedModelDriver implements ModelDriver {
  readonly name = "scripted";
  readonly model = "scripted-v1";

  async decide(prompt: DiscoveryPrompt): Promise<DiscoveryDecision> {
    const text = prompt.observation.visibleText;

    if (text.includes("Ready for final approval")) {
      return {
        type: "finish",
        reason: "The declared safe review checkpoint is visible; do not create the account.",
      };
    }

    if (text.includes("Open Savings Sub-account")) {
      const nicknameFilled = acted(
        prompt,
        (command) =>
          command.kind === "fill" && command.target.description === "account nickname field",
      );
      return nicknameFilled
        ? decision(
            { kind: "click", target: demoTargets.continueToReview },
            "Continue to the non-committing review screen.",
          )
        : decision(
            {
              kind: "fill",
              target: demoTargets.nickname,
              value: "{{inputs.accountNickname}}",
            },
            "Fill the proposed nickname through the runtime input binding.",
          );
    }

    if (text.includes("Member Detail")) {
      const readName = acted(
        prompt,
        (command) => command.kind === "read" && command.bind === "member-name",
      );
      if (!readName) {
        return decision(
          {
            kind: "read",
            target: demoTargets.memberName,
            bind: "member-name",
            parse: "text",
          },
          "Read the member name required by the capability output contract.",
        );
      }

      const readBalance = acted(
        prompt,
        (command) => command.kind === "read" && command.bind === "savings-balance",
      );
      if (!readBalance) {
        return decision(
          {
            kind: "read",
            target: demoTargets.savingsBalance,
            bind: "savings-balance",
            parse: "currency",
          },
          "Read the current savings balance required by the capability output contract.",
        );
      }

      return decision(
        { kind: "click", target: demoTargets.openSavings },
        "Open the reversible sub-account preparation flow.",
      );
    }

    if (text.includes("Search Results")) {
      return decision(
        { kind: "click", target: demoTargets.openMember },
        "Open the unique matching synthetic member record.",
      );
    }

    if (text.includes("Member Search")) {
      const memberFilled = acted(
        prompt,
        (command) =>
          command.kind === "fill" && command.target.description === "member number field",
      );
      return memberFilled
        ? decision(
            { kind: "click", target: demoTargets.search },
            "Submit the member lookup after binding the synthetic member id.",
          )
        : decision(
            {
              kind: "fill",
              target: demoTargets.memberId,
              value: "{{inputs.memberId}}",
            },
            "Fill the member field through the runtime input binding.",
          );
    }

    return {
      type: "escalate",
      reason: "stuck",
      summary: `No scripted action matches the visible state at step ${prompt.step}.`,
    };
  }
}
