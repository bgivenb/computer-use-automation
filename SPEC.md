# Computer-Use Capability System — Implementation Specification

## 1. Product invariant

The system turns one supervised, model-driven browser run into a reusable capability, then executes that capability without a model.

```text
live UI + LLM discovery -> reviewed, versioned artifact -> deterministic replay
```

Discovery and replay intentionally have different trust boundaries:

- Discovery may call an LLM, but every proposed action is checked against a reviewed step skeleton and runtime policy before execution.
- Replay loads only a validated artifact and performs zero model calls.
- Both phases operate through the same browser surface and policy engine.
- A human handoff transfers control of the same browser context; it never launches a replacement session.

## 2. Demonstrated scenario

The included synthetic banking fixture represents a hostile legacy application embedded in an iframe. The demonstrated capability prepares a savings subaccount for an existing member without performing the final irreversible creation action.

| Member ID | Expected terminal outcome | Purpose |
| --- | --- | --- |
| `12345` | `success` | Happy path |
| `00000` | `business_outcome` | Member not found |
| `77777` | `success` | Transient detail failure followed by bounded recovery |
| `88888` | `failure` | Permission denied |
| `99999` | `failure` or resumed `success` | Unexpected notice and same-session human handoff |

Acceptance requires discovery evidence from a real provider call and replay evidence produced with `OPENAI_API_KEY` absent.

## 3. Runtime boundaries

The implementation is a single TypeScript package targeting Node.js 22 or newer.

```text
CLI
 ├─ discovery runner ──> OpenAI Responses API
 ├─ artifact compiler ─> versioned JSON capability
 └─ replay runner ─────> Playwright surface
                          ├─ policy engine
                          ├─ event recorder
                          └─ intervention coordinator

Synthetic target server ─> top-level shell + legacy iframe
Loopback operator UI ─────> act / resume / abort
```

Persistent production infrastructure is deliberately out of scope. Artifacts and run evidence are plain files so the implementation can be audited and reproduced locally.

## 4. Capability artifact

Every artifact is parsed by a strict Zod contract before any browser is launched. Unknown fields fail validation.

Required top-level data includes:

- schema version and capability identity;
- discovery-run provenance and target application family, version, and surface;
- typed input and output schemas;
- ordered steps and explicit terminal branches;
- target origin and route allowlists;
- action-kind and risk ceilings;
- a canonical SHA-256 digest reported with discovery and replay results.

Each step declares:

- a stable ID and human-readable intent;
- exactly one command kind;
- ordered locator candidates;
- optional frame locator candidates;
- a bounded timeout and postconditions;
- structured reads or typed input bindings;
- explicit branches for expected business and runtime states.

Locator resolution is deterministic: candidates are tried in artifact order and the first candidate matching exactly one element wins; interactive actions then enforce Playwright actionability. Attempt receipts preserve match counts for missing and ambiguous diagnostics.

Input bindings use `{{inputs.camelCaseName}}` templates. Values are validated for type, length, range, and pattern before launch. The exact values used by discovery are the compiler's parameterization and leak-check source of truth.

## 5. Discovery protocol

Discovery is a genuine observe–decide–act loop:

1. Start one browser session and navigate to the trusted target.
2. Observe the active page and frames as a compact structured snapshot.
3. Send the snapshot, safe prior history, and the reviewed next-step intent to the model.
4. Validate the structured response.
5. Require its action kind to match the reviewed step skeleton and its result to satisfy that step's reviewed checkpoint.
6. Apply origin, route, command, and risk policy to the actual acting frame and destination.
7. Execute the action and validate the step checkpoint.
8. Record a redacted event and repeat until a terminal outcome.

Discovery is bounded by per-step, provider-call, total-run, and maximum-step limits. Repeated state/action pairs fail as no-progress rather than looping indefinitely.

The model cannot add steps, widen policy, select an irreversible final action, or write the final artifact directly. The compiler derives the artifact from the reviewed skeleton plus observed, reusable locator data, then computes its canonical digest.

## 6. Deterministic replay

Replay performs the following sequence before browser launch:

1. Parse the artifact and invocation input.
2. Compute the canonical artifact digest for result and evidence correlation.
3. Intersect artifact policy with runtime policy.
4. Reject incompatible origins, routes, commands, or risks.
5. Execute steps in artifact order using only declared locators, conditions, and recovery branches.
6. Validate structured output before returning it.

Replay imports no model client and records `modelCalls: 0`. It has no fallback path to discovery or free-form reasoning.

Recovery is bounded and restricted to declared transient branches. Business outcomes, permission errors, policy denials, invalid inputs, artifact validation failures, and ambiguous locators are not silently retried.

Terminal results use one of three categories:

- `success`: the requested reversible preparation completed;
- `business_outcome`: the application returned an expected non-error result such as member not found;
- `failure`: a runtime, policy, validation, or intervention failure prevented completion.

## 7. Safety and data handling

The effective policy is always the narrower intersection of artifact and runtime constraints.

- Only reviewed origins and exact, parameterized, or explicitly wildcarded routes are permitted.
- HTTP and WebSocket traffic is checked across all frames, and service workers are blocked.
- The acting frame URL is checked immediately before every command.
- Live element semantics and built-in command heuristics impose a runtime risk floor.
- The inspected target and destination are fingerprinted, rechecked, and acted on through the same element handle.
- Route and action ceilings are checked independently of risk classification.
- Downloads are disabled.
- The demo stops before the final `Create` action; that route and action are absent from both allowlists.
- Event payloads, model history, results, and evidence are recursively redacted.
- Credential-shaped strings and registered sensitive values are masked.
- The repository secret scanner covers tracked and non-ignored untracked text files.

No real customer data or credentials are required. All fixtures use synthetic identifiers and content.

## 8. Errors, intervention, and evidence

Terminal replay failures use the explicit categories `invalid_input`, `policy`, `permission`, `timeout`, `locator`, `checkpoint`, `surface`, `internal`, and `aborted`, with step and retryability context. Discovery separately stops on provider timeout, no progress, unsafe decisions, failed checkpoints, and its step or wall-clock bounds. Strict artifact and output parsing fail closed before an invalid value can be reported as success.

When a step declares human intervention:

1. Automation releases its exclusive control lease.
2. The loopback operator UI exposes the existing browser session.
3. The operator may act, resume, or abort.
4. Resume first validates the artifact's declared condition.
5. Automation reacquires the lease and continues from the same page and context.

Operator commands are serialized to prevent double-act and resume races. Closing a run aborts any pending intervention.

Every run writes structured JSONL events and a terminal result. Failures capture a best-effort screenshot. Intervention runs also persist the handoff request and handoff screenshot. `evidence/manifest.json` hashes every submitted evidence file and links each scenario to its provenance.

## 9. Designed extensions and deliberate cuts

The artifact's `surface` discriminator is currently `web`; a desktop adapter can preserve the runner contracts while introducing desktop-specific locator and policy schemas. Tenant policy can be loaded independently and intersected with the validated artifact at runtime. Artifact revisions carry a canonical digest in results and evidence and can be placed behind approval and rollout controls.

This reference implementation deliberately excludes a database, queue, distributed scheduler, authentication service, generalized visual agent, drag/drop, file upload, arbitrary JavaScript execution, and irreversible transaction support. Those additions would not strengthen the discovery/replay proof.

## 10. Acceptance commands

```bash
npm ci
npm run browser:install
npm run verify
npm run discover -- --driver openai
env -u OPENAI_API_KEY npm run replay -- --member-id 12345
env -u OPENAI_API_KEY npm run demo
```

`npm run verify` is the repository gate: formatting, linting, type checking, unit and integration tests, evidence verification, and secret scanning must all pass.
