import type { Condition, LocatorBundle, LocatorStrategy, Target } from "../core/contracts.js";
import type { CapabilityProfile } from "../artifact/compiler.js";

export const DEMO_MEMBER_ID = "12345";
export const DEMO_ACCOUNT_NICKNAME = "Rainy Day";

const workspaceFrame: LocatorBundle = {
  strategies: [{ kind: "css", selector: 'iframe[title="Member servicing workspace"]' }],
};

const target = (
  description: string,
  whyRobust: string,
  ...strategies: LocatorStrategy[]
): Target => ({ description, whyRobust, frame: workspaceFrame, strategies });

export const demoTargets = {
  memberId: target(
    "member number field",
    "The form name is a stable business field while generated ids are ignored.",
    { kind: "css", selector: 'input[name="memberId"]' },
  ),
  search: target(
    "Search button",
    "The accessible button role and visible action name express intent.",
    { kind: "role", role: "button", name: "Search", exact: true },
    { kind: "text", text: "Search", exact: true },
  ),
  searchResults: target(
    "Search Results heading",
    "A stable workflow heading is preferable to generated element ids.",
    { kind: "role", role: "heading", name: "Search Results", exact: true },
    { kind: "text", text: "Search Results", exact: true },
  ),
  memberNotFound: target(
    "Member not found outcome",
    "The application exposes this stable business outcome text.",
    { kind: "text", text: "Member not found", exact: true },
  ),
  openMember: target(
    "Open member record link",
    "The link role and action text are stable across generated row ids.",
    { kind: "role", role: "link", name: "Open member record", exact: true },
    { kind: "text", text: "Open member record", exact: true },
  ),
  memberDetail: target(
    "Member Detail heading",
    "The stable workflow heading is independent of tenant styling and generated ids.",
    { kind: "role", role: "heading", name: "Member Detail", exact: true },
    { kind: "text", text: "Member Detail", exact: true },
  ),
  memberName: target(
    "member name value",
    "The legacy detail table has a stable row contract even though it has no semantic field ids.",
    { kind: "css", selector: ".detail tr:nth-child(2) td:nth-child(2)" },
  ),
  savingsBalance: target(
    "available savings balance",
    "The account table column contract is stable; generated ids are not used.",
    { kind: "css", selector: ".results tr:nth-child(2) td:nth-child(3)" },
  ),
  openSavings: target(
    "Open savings sub-account link",
    "The action's link role and name describe its durable business intent.",
    { kind: "role", role: "link", name: "Open savings sub-account", exact: true },
    { kind: "text", text: "Open savings sub-account", exact: true },
  ),
  subaccountHeading: target(
    "Open Savings Sub-account heading",
    "The workflow heading is a stable checkpoint.",
    { kind: "role", role: "heading", name: "Open Savings Sub-account", exact: true },
    { kind: "text", text: "Open Savings Sub-account", exact: true },
  ),
  nickname: target("account nickname field", "The stable form name survives generated DOM ids.", {
    kind: "css",
    selector: 'input[name="accountNickname"]',
  }),
  continueToReview: target(
    "Continue to review button",
    "The button role and business action text are stable.",
    { kind: "role", role: "button", name: "Continue to review", exact: true },
    { kind: "text", text: "Continue to review", exact: true },
  ),
  readyForApproval: target(
    "Ready for final approval checkpoint",
    "This text is the explicit safe stopping checkpoint before the irreversible action.",
    { kind: "text", text: "Ready for final approval", exact: true },
  ),
  temporaryError: target(
    "Temporary system error",
    "The host's stable error classification drives a declared recovery.",
    { kind: "text", text: "Temporary system error", exact: true },
  ),
  tryAgain: target(
    "Try again link",
    "The application explicitly marks this transient request as safe to retry.",
    { kind: "role", role: "link", name: "Try again", exact: true },
    { kind: "text", text: "Try again", exact: true },
  ),
  permissionDenied: target(
    "Permission denied outcome",
    "The application exposes an explicit authorization failure.",
    { kind: "text", text: "Permission denied", exact: true },
  ),
  unexpectedConfirmation: target(
    "Unexpected confirmation required",
    "This explicit runtime state must transfer control to a human.",
    { kind: "text", text: "Unexpected confirmation required", exact: true },
  ),
  dismissInterstitial: target(
    "Dismiss and continue button",
    "The operator can acknowledge the unexpected host notice in the same live session.",
    { kind: "role", role: "button", name: "Dismiss and continue", exact: true },
    { kind: "text", text: "Dismiss and continue", exact: true },
  ),
  createAccount: target(
    "Create account button",
    "The button is an explicit irreversible commit action.",
    { kind: "role", role: "button", name: "Create account", exact: true },
    { kind: "text", text: "Create account", exact: true },
  ),
} satisfies Record<string, Target>;

const visible = (selectedTarget: Target): Condition => ({
  kind: "visible",
  target: selectedTarget,
});

export const createDemoProfile = (origin: string): CapabilityProfile => ({
  id: "prepare-savings-subaccount",
  revision: 1,
  name: "Prepare savings sub-account",
  description:
    "Look up a synthetic member, return their savings data, and prepare a new savings sub-account through the safe review checkpoint.",
  app: { family: "northstar-core", version: "7-demo", surface: "web" },
  entryUrl: `${origin}/`,
  inputs: {
    memberId: {
      type: "string",
      description: "Synthetic member number",
      sensitivity: "sensitive",
      pattern: "^[0-9]{5}$",
    },
    accountNickname: {
      type: "string",
      description: "Nickname for the proposed savings sub-account",
      sensitivity: "sensitive",
      minLength: 1,
      maxLength: 40,
    },
  },
  inputSamples: {
    memberId: DEMO_MEMBER_ID,
    accountNickname: DEMO_ACCOUNT_NICKNAME,
  },
  outputs: {
    memberName: {
      value: {
        type: "string",
        description: "Synthetic member display name",
        sensitivity: "sensitive",
      },
      from: "member-name",
    },
    savingsBalance: {
      value: {
        type: "number",
        description: "Current synthetic savings balance",
        sensitivity: "sensitive",
        unit: "USD",
      },
      from: "savings-balance",
    },
  },
  businessOutcomes: [
    {
      code: "validation-rejected",
      description: "The host rejected the proposed account nickname.",
    },
    {
      code: "member-not-found",
      description: "No member exists for the supplied synthetic member number.",
    },
  ],
  permissions: {
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
  },
  steps: [
    {
      kind: "fill",
      description: "Enter the member number",
      expect: [visible(demoTargets.search)],
      risk: "reversible",
    },
    {
      kind: "click",
      description: "Search for the member",
      expect: [visible(demoTargets.searchResults)],
      onObserved: [
        {
          when: visible(demoTargets.memberNotFound),
          action: { kind: "return_outcome", code: "member-not-found" },
        },
      ],
      risk: "safe",
    },
    {
      kind: "click",
      description: "Open the member record",
      expect: [visible(demoTargets.memberDetail)],
      onObserved: [
        {
          when: visible(demoTargets.temporaryError),
          action: {
            kind: "recover",
            command: { kind: "click", target: demoTargets.tryAgain },
            message: "Retry the explicitly safe transient host request once.",
          },
        },
        {
          when: { kind: "text", includes: "Session expired" },
          action: {
            kind: "fail",
            category: "permission",
            message:
              "Session expired; an authorized operator must reauthenticate. No automatic login or retry.",
          },
        },
        {
          when: visible(demoTargets.permissionDenied),
          action: {
            kind: "fail",
            category: "permission",
            message: "The operator is not authorized to view this member.",
          },
        },
        {
          when: visible(demoTargets.unexpectedConfirmation),
          action: {
            kind: "intervene",
            reason: "runtime_state",
            summary: "A human must acknowledge the unexpected host migration notice.",
            resumeWhen: visible(demoTargets.memberDetail),
          },
        },
      ],
      risk: "safe",
    },
    {
      kind: "read",
      description: "Read the member name",
      expect: [visible(demoTargets.memberDetail)],
      risk: "safe",
    },
    {
      kind: "read",
      description: "Read the current savings balance",
      expect: [visible(demoTargets.memberDetail)],
      risk: "safe",
    },
    {
      kind: "click",
      description: "Open the savings sub-account workflow",
      expect: [visible(demoTargets.subaccountHeading)],
      risk: "reversible",
    },
    {
      kind: "fill",
      description: "Enter the proposed account nickname",
      expect: [visible(demoTargets.continueToReview)],
      risk: "reversible",
    },
    {
      kind: "click",
      description: "Reach the review checkpoint",
      expect: [visible(demoTargets.readyForApproval)],
      onObserved: [
        {
          when: { kind: "text", includes: "Enter an account nickname." },
          action: { kind: "return_outcome", code: "validation-rejected" },
        },
      ],
      risk: "reversible",
    },
  ],
  success: [
    visible(demoTargets.readyForApproval),
    { kind: "text", includes: "{{inputs.memberId}}" },
    { kind: "text", includes: "{{inputs.accountNickname}}" },
  ],
  checkpoints: [
    visible(demoTargets.search),
    visible(demoTargets.searchResults),
    visible(demoTargets.memberDetail),
    visible(demoTargets.subaccountHeading),
    visible(demoTargets.readyForApproval),
  ],
});
