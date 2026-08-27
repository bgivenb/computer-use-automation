# Computer-Use Automation System - Implementation Spec

Status: implementation-ready  
Target submission: interface.ai Staff Software Engineer take-home  
Submission contract: public GitHub repository; email the repository URL on its own line to `assignments@interface.ai`

## 1. Product intent

Build a small, complete vertical slice of the backend integration layer that gives an AI agent "hands" inside a legacy application with no usable API.

The system must demonstrate this production model end to end:

1. An LLM discovers how to complete a natural-language goal on a live UI.
2. The successful discovery run is compiled into a typed, versioned, reviewable capability artifact.
3. A caller invokes that capability with typed inputs.
4. The system replays it deterministically, with no LLM making replay decisions.
5. Runtime business outcomes, recoverable conditions, and hard failures are handled deliberately.
6. Automation can pause and transfer control of the same live session to a human, then resume.
7. Guardrails and redaction protect the surface and its data throughout.

The implementation should optimize for judgment, correctness, and explainability rather than feature breadth or scaling infrastructure.

## 2. Scope

### Must build

- A local, live "legacy bank servicing" web application that intentionally uses awkward markup: nested tables, an iframe, generated element IDs, and few semantic attributes.
- A real LLM-driven observe-decide-act discovery run against that application.
- A compiler that converts the successful run into a typed capability artifact, independent of the model transcript.
- A deterministic replay engine that accepts artifact inputs, performs the recorded flow without LLM decisions, verifies checkpoints, and returns typed outputs.
- Explicit handling for success, a known business outcome, a recoverable runtime condition, a hard failure, and escalation.
- Domain/route/action allowlists, risk classification, and log/artifact redaction.
- Structured logs and rich failure evidence.
- A minimal operator console that controls the exact same browser session during handoff and records human actions.
- Unit tests for schemas, policy, redaction, result classification, and locator resolution; integration tests for the end-to-end happy path and representative failures.
- The exact required repository deliverables: `/README.md`, `/REPORT.md`, and `/evidence/`.

### Explicitly not building

- Real bank or credit-union integrations.
- Real credentials or real PII.
- Desktop automation; only the adapter seam and design story.
- Production queues, clusters, tenant provisioning, or a complete multi-tenant control plane.
- A polished real-time co-browsing product.
- Open-ended LLM recovery during replay.
- More than one optional stretch goal before the core is complete.

## 3. Concrete demo scenario

### Target application

Create `apps/legacy-bank`, a local-only mock of a bank back-office servicing tool. It should be realistic enough to exercise the evaluation criteria but contain only synthetic data.

Primary flow:

1. Open the member-search screen.
2. Search for a parameterized `memberId`.
3. Distinguish a member record from the legitimate "member not found" outcome.
4. Open the member detail page.
5. Read and return `memberName` and `savingsBalance`.
6. Start an "Open savings sub-account" flow.
7. Enter a parameterized `accountNickname`.
8. Reach and verify the review screen.
9. Stop before the irreversible final submission unless a human explicitly approves it.

The main saved capability is `prepare_savings_subaccount`. Its normal success condition is the review screen, not account creation. This keeps the automated demo safe while still exercising a meaningful multi-step action.

### Injected runtime states

The target app must expose deterministic test fixtures, selected by synthetic member ID or a test-only query/config value:

| Fixture | Required system behavior |
| --- | --- |
| `12345` | Happy path; return balance and reach review screen. |
| `00000` | Return `business_outcome/member_not_found`; do not throw. |
| `77777` | First detail load is transiently slow or fails once; retry and recover. |
| `88888` | Permission-denied page; produce a non-recoverable failure or escalation with evidence. |
| `99999` | Unexpected confirmation/interstitial; raise an intervention and allow same-session human handling. |

All names, IDs, and balances are synthetic.

## 4. Technical decisions

### Stack

- Language/runtime: TypeScript on Node.js 22.
- Workspace/package manager: pnpm workspaces.
- Browser automation: Playwright using one long-lived `BrowserContext` and `Page` per run.
- LLM integration: provider-neutral `ModelDriver` interface with one implemented structured-output adapter. The implementation may use OpenAI or Anthropic, selected by environment variable.
- Validation and schema generation: Zod, with JSON Schema emitted for artifacts and model tool contracts.
- Local API/operator console: Fastify plus a minimal React/Vite UI, or an equally small server-rendered alternative if that cuts setup time.
- Logging: JSONL event stream with a run/capability/step correlation model.
- Tests: Vitest plus Playwright integration tests.
- Persistence: filesystem only under `.runs/` and `artifacts/`; no database.

### Why this stack

TypeScript keeps the artifact, action, result, and intervention contracts executable and reviewable in one language. Playwright provides a reliable web implementation without coupling the artifact to Playwright-specific selectors: browser details remain behind a `SurfaceAdapter`. Filesystem persistence makes artifacts and evidence easy to review in Git and avoids infrastructure the brief does not reward.

### Surface strategy

Discovery should observe more than a clean DOM:

- accessibility-oriented text/roles when available,
- a bounded structural snapshot,
- a screenshot and viewport metadata,
- frame boundaries and current URL,
- recent action/result context.

The model chooses from policy-checked abstract actions and returns a structured action plus a proposed target description. The runtime resolves that description on the live surface and records a locator bundle. This demonstrates a path beyond clean-DOM automation while keeping the implementation achievable.

## 5. Repository layout

```text
/
  README.md
  REPORT.md
  SPEC.md
  package.json
  pnpm-workspace.yaml
  tsconfig.base.json
  .env.example
  .gitignore
  apps/
    legacy-bank/                # intentionally awkward live target app
    operator-console/           # minimal pause/control/resume UI
  packages/
    contracts/                  # artifact, action, result, event schemas
    surface/                    # SurfaceAdapter interfaces
    surface-playwright/         # browser perception/action/locator resolver
    discovery/                  # LLM-driven observe-decide-act loop
    artifact-compiler/          # transcript/run -> reusable capability
    replay/                     # deterministic executor
    policy/                     # allowlists, risk checks, redaction
    runtime/                    # sessions, controller lease, intervention flow
    observability/              # JSONL events, screenshots, trace helpers
    cli/                        # discover, replay, inspect commands
  artifacts/
    examples/
      prepare-savings-subaccount.v1.json
  evidence/
    discovery/
      events.jsonl
      summary.json
      screenshots/
    replay-success/
      result.json
      events.jsonl
    replay-business-outcome/
      result.json
      events.jsonl
    replay-escalation/
      intervention.json
      events.jsonl
      screenshots/
  tests/
    integration/
```

Generated local runs and secrets are ignored. Curated, redacted examples under `/evidence/` are committed.

## 6. Architecture

```text
CLI / caller
    |
    +--> DiscoveryRunner ----> ModelDriver
    |         |                    |
    |         v                    | structured decisions only
    |     RunSession <-------------+
    |         |
    |         v
    |   SurfaceAdapter (Playwright implementation)
    |         |
    |         v
    |   live legacy-bank UI
    |         |
    |         +--> EventRecorder / EvidenceStore
    |         +--> PolicyEngine
    |         +--> InterventionCoordinator <--> Operator console
    |
    +--> ArtifactCompiler --> CapabilityArtifact v1
    |
    +--> ReplayRunner ------> same SurfaceAdapter, PolicyEngine,
                              EventRecorder, and InterventionCoordinator
                              (no ModelDriver dependency)
```

### Core boundaries

`SurfaceAdapter` is the seam between a reusable flow and a concrete UI technology.

```ts
interface SurfaceAdapter {
  observe(options: ObservationOptions): Promise<SurfaceObservation>;
  resolve(target: TargetSpec): Promise<ResolvedTarget>;
  act(action: ResolvedAction): Promise<ActionReceipt>;
  assert(condition: ConditionSpec): Promise<AssertionResult>;
  extract(spec: ExtractionSpec): Promise<unknown>;
  captureEvidence(reason: EvidenceReason): Promise<EvidenceRef[]>;
  describeSession(): Promise<SessionDescriptor>;
}
```

`ModelDriver` is present only in discovery. The replay package must not import it.

`RunSession` owns the live browser context and an exclusive controller lease. It is the unit transferred between automation and the human operator.

`PolicyEngine` evaluates every proposed or recorded action before execution; replay does not trust an artifact merely because it was saved.

## 7. Capability artifact v1

The artifact is the central deliverable. It is a contract and executable plan, not a cleaned-up transcript.

### Top-level shape

```ts
type CapabilityArtifactV1 = {
  schemaVersion: "1.0";
  capability: {
    id: string;
    name: string;
    description: string;
    revision: number;
    status: "draft" | "approved";
    createdAt: string;
    provenance: {
      discoveryRunId: string;
      targetApp: string;
      targetAppVersion: string;
    };
  };
  contract: {
    inputs: Record<string, JsonSchema>;
    outputs: Record<string, JsonSchema>;
    businessOutcomes: BusinessOutcomeSpec[];
  };
  applicability: {
    vendorProduct: string;
    baseVersionRange: string;
    tenantProfile?: string;
    surfaceKinds: Array<"web" | "legacy-web" | "desktop">;
  };
  entryPoint: EntryPointSpec;
  policy: ArtifactPolicy;
  steps: CapabilityStep[];
  success: ConditionSpec;
  outputBindings: Record<string, ExtractionSpec>;
  redaction: RedactionSpec;
};
```

### Step shape

```ts
type CapabilityStep = {
  id: string;
  description: string;
  action: ActionSpec;
  target?: TargetSpec;
  preconditions?: ConditionSpec[];
  postconditions: ConditionSpec[];
  timeoutMs: number;
  retry: RetryPolicy;
  on: StepBranch[];
  risk: "safe" | "reversible" | "irreversible";
  evidence: "none" | "on-failure" | "always";
};
```

### Target specification

A target stores a ranked bundle of independent strategies rather than one brittle selector.

```ts
type TargetSpec = {
  intent: string;
  scope?: { frame?: TargetSpec; region?: string };
  candidates: Array<
    | { kind: "role-name"; role: string; name: Template; exact: boolean; weight: number }
    | { kind: "label"; text: Template; weight: number }
    | { kind: "text"; text: Template; exact: boolean; weight: number }
    | { kind: "relation"; anchor: TargetSpec; relation: "near" | "following" | "within"; weight: number }
    | { kind: "visual-anchor"; assetRef: string; expectedRegion?: Rect; threshold: number; weight: number }
    | { kind: "css"; selector: string; weight: number }
  >;
  resolution: {
    minimumScore: number;
    requireUnique: boolean;
    ambiguity: "fail" | "escalate";
  };
};
```

The runtime evaluates candidates in a deterministic order and records which candidate resolved. Raw screen coordinates may be recorded only as a low-confidence fallback tied to a visual anchor and viewport constraints; they are never the sole high-confidence locator.

### Parameters and redaction

Artifacts contain templates such as `{{inputs.memberId}}`, never concrete discovery values. Inputs can be marked `sensitive`, `secret`, or `nonSensitive`. Sensitive values may exist in memory during a run but are replaced in persisted logs with stable tokens such as `[REDACTED:memberId]`. Secrets must never appear in artifacts, events, screenshots retained in Git, or model prompts unless explicitly required and protected; the demo uses no secrets.

### Tenant and version reuse

The base artifact identifies a vendor product and compatible version range. Tenant profiles contain narrowly scoped overrides:

- entry URL mapping,
- branding/text aliases,
- locator candidate additions or weight changes,
- known interstitial handlers,
- policy restrictions.

Overrides may refine but not silently weaken base safety policy. Replay records the base revision and override revision. Failed checkpoints produce a drift signal; they do not auto-edit an approved artifact.

## 8. Discovery loop

### Inputs

```ts
type DiscoveryRequest = {
  goal: string;
  target: EntryPointSpec;
  sampleInputs: Record<string, unknown>;
  limits: { maxSteps: number; timeoutMs: number };
  policyProfile: string;
};
```

### Per-step algorithm

1. Verify the controller lease is owned by `automation`.
2. Observe current URL, frames, accessibility/structural state, screenshot reference, visible error signals, and recent history.
3. Redact the observation before it is sent to the model or persisted.
4. Ask the model for exactly one structured decision: act, extract, finish, or escalate.
5. Validate the model response against the action schema.
6. Resolve the proposed target and measure ambiguity.
7. Evaluate domain, route, action, and risk policy.
8. Execute one action or create an intervention.
9. Record the decision rationale, resolved target strategy, receipt, new observation digest, timing, and evidence references.
10. Stop on a verified goal, max steps, timeout, repeated no-progress state, policy block, or dead end.

### No-progress detection

Compute a stable digest from URL, visible-state summary, and key screenshot/perception features. Escalate after the same digest and action intent repeat twice without a meaningful state change, or after locator ambiguity remains unresolved. This is a bounded rule, not a model opinion.

### Artifact compilation

Compilation occurs only after the success checkpoint passes. It must:

- remove failed exploratory actions and model-only chatter,
- parameterize concrete sample values,
- preserve successful target strategies plus justified fallbacks,
- infer/validate input and output schemas,
- attach explicit preconditions, postconditions, branches, timeouts, and retry policies,
- classify risk per step,
- validate the result against `CapabilityArtifactV1`,
- replay the draft once before it is eligible for approval.

The original run log remains evidence but is not executable production input.

## 9. Deterministic replay

Replay accepts an artifact and validated input values. The replay module has no model dependency and must fail a build-time dependency test if a model package is imported.

### Algorithm

1. Validate artifact version, status policy, input schema, target applicability, and runtime policy.
2. Open or attach to the declared entry point.
3. For each step:
   - verify preconditions,
   - resolve the target using the recorded deterministic candidate order,
   - reject ambiguous or below-threshold matches,
   - re-evaluate action policy,
   - perform the action,
   - apply only declared recovery behavior,
   - verify postconditions,
   - evaluate declared business-outcome and error branches,
   - emit a structured event.
4. Verify the capability success checkpoint.
5. Extract and validate declared outputs.
6. Return the discriminated result union and finalize evidence.

### Wait and retry policy

- Wait on observable conditions, not fixed sleeps, except for a small bounded polling interval.
- Retry only idempotent actions or actions explicitly marked safe to retry.
- Use exponential backoff with a low attempt cap for transient loads.
- Never retry an irreversible action automatically.
- Capture evidence on final retry failure.

### Result contract

```ts
type RunResult<TOutputs> =
  | {
      status: "success";
      runId: string;
      outputs: TOutputs;
      checkpoint: AssertionReceipt;
      evidence: EvidenceRef[];
    }
  | {
      status: "business_outcome";
      runId: string;
      code: "member_not_found" | string;
      details: Record<string, unknown>;
      evidence: EvidenceRef[];
    }
  | {
      status: "escalated";
      runId: string;
      interventionId: string;
      reason: InterventionReason;
      resumable: boolean;
      evidence: EvidenceRef[];
    }
  | {
      status: "failure";
      runId: string;
      category: "policy" | "permission" | "timeout" | "locator" | "checkpoint" | "surface" | "internal";
      stepId?: string;
      expected?: unknown;
      observed?: unknown;
      message: string;
      retryable: boolean;
      evidence: EvidenceRef[];
    };
```

Expected "member not found" is always a business outcome. A known one-time slow load is recoverable. Permission denial, an unresolved ambiguous control, or a failed checkpoint is a hard failure or escalation according to the artifact branch; none are silently converted to success.

## 10. Safety and policy

### Policy layers

1. Runtime policy: organization-level ceiling.
2. Artifact policy: capability-specific routes and actions.
3. Invocation policy: optional stricter caller constraints.

The effective policy is the intersection; lower layers cannot broaden upper layers.

### Required controls

- Host allowlist defaults to `127.0.0.1`/`localhost` and the configured demo port.
- Route allowlist covers only the legacy-bank app paths used by the capability.
- Allowed discovery/replay actions: navigate, click, type, select, read, wait, screenshot.
- Downloads, uploads, clipboard, new origins, script injection, and arbitrary keyboard shortcuts are denied by default.
- A route change or popup is checked before further action.
- Text entry is checked for secrets and unexpected PII.
- Every artifact action is checked at execution time.

### Risk rules

- Safe: read state, navigate within allowlist, search synthetic records.
- Reversible: fill a form before submission, open/close a panel.
- Irreversible: final "Create account" submission or any action identified as committing a transaction.

Irreversible actions require a human intervention with a fresh screenshot and summary. The demo capability intentionally succeeds at the review checkpoint without performing the final commit.

### Data handling

- Use only synthetic data.
- Central redactor handles configured field names plus common token, credential, email, account, and member-number patterns.
- Persist observation digests rather than complete raw DOM snapshots by default.
- Failure snapshots are redacted or use synthetic fixtures before being committed.
- `.env`, `.runs/`, browser profiles, traces containing unreviewed data, and credentials are gitignored.

## 11. Human escalation and same-session handoff

### Controller state machine

```text
AUTOMATION_ACTIVE
  -> PAUSING
  -> HUMAN_REQUESTED
  -> HUMAN_ACTIVE
  -> RESUMING
  -> AUTOMATION_ACTIVE
  -> COMPLETED | FAILED
```

Only the current lease holder may send actions to the `RunSession`. Lease transitions are serialized and recorded with actor, timestamp, and reason. Automation stops issuing actions before the operator obtains the lease.

### Intervention payload

```ts
type InterventionRequest = {
  id: string;
  runId: string;
  capabilityId?: string;
  goal: string;
  stepId?: string;
  reason: "stuck" | "ambiguous_target" | "policy_block" | "risky_action" | "runtime_state";
  summary: string;
  allowedHumanActions: ActionType[];
  session: SessionDescriptor;
  evidence: EvidenceRef[];
  createdAt: string;
};
```

### Minimal real operator flow

1. Automation pauses and releases its lease.
2. Operator opens a local URL for the intervention.
3. The console shows the latest screenshot, goal, step, reason, and event history.
4. Operator claims the lease.
5. Click, type, key, and refresh commands execute against the existing Playwright `Page`; no new context is created.
6. Each human action is recorded with `actorType: "human"` and resulting evidence.
7. Operator selects Resume or Abort.
8. On Resume, the system re-observes the current page, checks the step postcondition or declared resume checkpoint, transfers the lease to automation, and continues.

For the demo, trigger this path with member `99999` or by attempting the final irreversible action.

## 12. Observability and evidence

### Event envelope

```ts
type RunEvent = {
  eventVersion: "1.0";
  timestamp: string;
  runId: string;
  sequence: number;
  phase: "discovery" | "compile" | "replay" | "handoff";
  actor: { type: "model" | "automation" | "human" | "system"; id?: string };
  capabilityId?: string;
  stepId?: string;
  type: string;
  data: Record<string, unknown>;
  evidence?: EvidenceRef[];
};
```

Discovery events include the redacted observation summary, structured model decision, concise rationale, policy decision, resolved locator candidate, action receipt, timing, and checkpoint result. Replay events include no model rationale because no model is called.

### Required committed evidence

- One genuine successful LLM discovery log.
- The compiled artifact generated from that run.
- One successful deterministic replay with outputs.
- One `member_not_found` replay showing the business-outcome contract.
- One recoverable transient-load replay or one escalation run.
- At least one failure screenshot and structured failure/intervention payload.
- A short evidence index explaining how to inspect each file and confirming that all data is synthetic/redacted.

A short recording is optional and should be attempted only after the required evidence is complete.

## 13. CLI and demo contract

Commands should be stable before evidence is captured.

```bash
pnpm install
pnpm dev:target

# Terminal 2: genuine model-driven run
MODEL_PROVIDER=openai MODEL_API_KEY=... pnpm cua discover \
  --goal "Look up member 12345, read the savings balance, and prepare a new savings sub-account named Rainy Day through the review screen" \
  --target http://127.0.0.1:4173 \
  --out artifacts/examples/prepare-savings-subaccount.v1.json

# Deterministic replay; MODEL_API_KEY is intentionally absent
env -u MODEL_API_KEY pnpm cua replay \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json \
  --input memberId=12345 \
  --input accountNickname="Rainy Day"

# Business outcome
env -u MODEL_API_KEY pnpm cua replay \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json \
  --input memberId=00000 \
  --input accountNickname="Rainy Day"

# Same-session escalation demo
pnpm operator
env -u MODEL_API_KEY pnpm cua replay \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json \
  --input memberId=99999 \
  --input accountNickname="Rainy Day"
```

The README must also provide a model-free fixture mode for reviewers to inspect schemas, replay behavior, and tests without live services. It must clearly state that a fixture discovery transcript is not the required genuine run; the genuine run is preserved under `/evidence/discovery/`.

## 14. API errors and exit codes

CLI JSON output must match `RunResult`. Human-readable summaries go to stderr; machine-readable JSON goes to stdout when `--json` is set.

| Exit code | Meaning |
| --- | --- |
| `0` | Success or declared business outcome. |
| `2` | Invalid request, artifact, or inputs. |
| `3` | Policy block. |
| `4` | Runtime failure. |
| `5` | Escalated and waiting for/resolved by a human according to CLI mode. |

Business outcomes use exit `0` because the capability executed correctly and returned a legitimate domain result.

## 15. Testing strategy

### Unit tests

- Artifact schema accepts the curated v1 example and rejects unknown/incompatible versions.
- Input/output validation and template substitution.
- Result union classification.
- Locator candidate ordering, scoring, uniqueness, and below-threshold behavior.
- Policy intersection cannot broaden access.
- Unsafe origin, route, action, and irreversible action are blocked.
- Redactor removes configured fields and representative credential/PII patterns.
- Retry logic refuses non-idempotent retries.
- Controller lease prevents simultaneous automation and human actions.
- Replay package dependency graph contains no model driver.

### Integration tests

- Discovery completes the real local target with a stub model for CI; the separate committed evidence proves one genuine provider-backed run.
- Compiled artifact replays successfully without a model key.
- `00000` returns `business_outcome/member_not_found`.
- `77777` recovers within the declared retry budget.
- `88888` produces a clear permission failure and screenshot.
- `99999` pauses, hands the same session to a test operator, records the manual action, resumes, and verifies completion.
- A mutated duplicate target causes deterministic ambiguity failure rather than an arbitrary click.
- A navigation attempt to a non-allowlisted origin is blocked before action.

### Acceptance checks

- Fresh clone setup follows README without undocumented steps.
- No secrets or real PII appear in `git grep` or committed history.
- The artifact is understandable without reading the discovery transcript.
- Replay can run with model environment variables unset and outbound model access disabled.
- Every terminal result includes a run ID and debuggable evidence references.
- Evidence commands and paths exactly match the brief.

## 16. Implementation sequence

### Milestone 1 - contracts and target surface

- Initialize workspace, strict TypeScript, formatting, linting, and tests.
- Implement all Zod contracts first: actions, observations, artifact v1, results, events, policy, and intervention.
- Build the hostile local target with the five fixtures.

Exit: target app is manually usable and contract tests pass.

### Milestone 2 - deterministic core

- Implement `SurfaceAdapter` and Playwright adapter.
- Implement locator bundles, conditions, extraction, policy, redaction, logging, and replay.
- Hand-author a temporary artifact to drive replay tests.

Exit: happy, business-outcome, recovery, permission, and ambiguity integration tests pass without any model.

### Milestone 3 - discovery and compilation

- Add structured `ModelDriver` and bounded discovery loop.
- Record action receipts and compile a reusable artifact.
- Parameterize sample values and validate/replay the compiled draft.

Exit: one genuine discovery produces an artifact that replays with the model disabled.

### Milestone 4 - handoff

- Add controller lease/state machine and intervention coordinator.
- Add the minimal operator console operating the same Playwright page.
- Test pause, claim, manual action, resume, and audit evidence.

Exit: `99999` demonstrates real same-session handoff.

### Milestone 5 - submission package

- Curate and redact `/evidence/`.
- Write README with exact commands.
- Write REPORT.md using exactly the seven required headings.
- Add tests for clean-clone setup and no-model replay.
- Review the repository for secrets, accidental PII, unnecessary framework claims, and unsupported assertions.

Exit: a reviewer can run the vertical slice and trace each design decision to code or evidence.

## 17. Required REPORT.md headings

Use these headings verbatim and keep the report to roughly 1-3 pages:

1. `Architecture`
2. `Artifact schema`
3. `Determinism & error handling`
4. `Heterogeneity & multi-tenant`
5. `Escalation & handoff`
6. `Safety`
7. `Cuts`

The report should defend choices and trade-offs; it should not duplicate setup instructions or narrate every source file.

## 18. Review priority and stretch-goal gate

Optimize effort in this order:

1. Artifact schema and replay result contract.
2. Correct model-discovery to deterministic-replay thread.
3. Runtime error taxonomy, waits, checkpoints, and locator robustness.
4. Same-session human handoff.
5. Safety and redaction.
6. Heterogeneity and multi-tenant design argument.
7. Code quality and communication.

Do not begin a stretch goal until every acceptance check above passes. If time remains, implement only the agent-facing capability interface: expose approved artifacts through a tiny typed catalog/invoke API and demonstrate one invocation. This reinforces the brief's central capability model without distracting from the core.

## 19. Submission checklist

- [ ] Public repository.
- [ ] Root README has setup, configuration, offline/model-free path, exact discovery command, and exact replay command.
- [ ] Root REPORT.md uses the seven exact headings.
- [ ] `/evidence/` contains a genuine LLM discovery, saved artifact, successful replay, and exceptional-state evidence.
- [ ] Replay makes zero model calls.
- [ ] Artifact inputs/outputs and all result variants validate against schemas.
- [ ] Allowlist and risk policy are enforced in discovery and replay.
- [ ] No secrets or real PII are committed.
- [ ] Human handoff controls the same session and records human actions.
- [ ] Tests cover the load-bearing abstractions and representative runtime states.
- [ ] Cuts and next steps are explicit.
- [ ] Every team-relevant claim is defensible from code, tests, or evidence.
- [ ] Email contains only the public repository URL on its own line and is sent from the application address; no zip is attached.

