# Architecture

The system is one Node.js process around five narrow boundaries: a `ModelDriver`, a discovery loop, a
compiler, a deterministic replay executor, and a browser/session runtime. The target is a local
synthetic bank-servicing application with nested tables, an iframe, generated IDs, transient and
business errors, and an irreversible-looking final action. Keeping the target local makes every test
repeatable and avoids real credentials or PII while still exercising a live UI.

Discovery observes the page and its frames, bounded visible text and controls, URL, state digest, and
a screenshot. A driver returns exactly one schema-validated decision. The implemented provider uses
OpenAI Responses structured output; `ScriptedModelDriver` exercises the same loop in tests but is only
a fixture. Successful actions form a compact trace. Compilation combines that trace with a
hand-authored capability profile containing the contract, checkpoints, error branches, permissions,
and risk semantics, then rejects leaked sample inputs. The result is independent of model prose.

Replay receives only an artifact, inputs, a surface, policy, recorder, and optional intervention
coordinator. It has no model driver. Both paths use the same Playwright surface, redactor, layered
policy, JSONL event schema, and one `RunSession`. Filesystem persistence under `.runs/` is deliberate:
it keeps this vertical slice inspectable without introducing databases, queues, or services that do
not improve the load-bearing design.

# Artifact schema

`CapabilityArtifactSchema` is a strict Zod v1 contract. Its identity block carries an ID, revision,
description, discovery run ID, and target product family/version/surface. Its invocation contract
declares typed, sensitivity-labelled inputs; typed outputs tied to named read bindings; and legitimate
business outcomes. Entry URL, origin/route/action permissions, ordered steps, and final success
conditions make the artifact both executable and reviewable.

Each step records a parameterized command, description, timeout, risk, postconditions, and optional
branches for recovery, business outcomes, failure, or intervention. A target contains human-readable
intent and robustness reasoning, an optional frame locator, and an ordered bundle of independent
role, label, text, or CSS strategies. Replay accepts only a unique match and records every attempted
strategy plus the selected index. Generated DOM IDs and raw coordinates are never artifact
dependencies; CSS is used narrowly where the hostile form exposes only a stable business field name
or table contract.

The compiler replaces exact discovery samples with `{{inputs.name}}` templates and fails if a sample
survives serialization. It also checks that output bindings exist, artifact actions are permitted,
business branches are declared, and step IDs are unique. The deliberate trade-off is that discovery
currently learns the action sequence while the capability profile supplies semantic step metadata and
must have the same action count. This is safer and easier to review than inferring production error
policy from one model run, but a general recorder would need an approval workflow for editing or
inferring that metadata.

# Determinism & error handling

Replay binds validated inputs, traverses steps in stored order, resolves locator strategies in stored
order, policy-checks each command, executes only declared branches, verifies every postcondition and
the final checkpoint, and returns declared outputs. It neither receives nor calls a model; summaries
report `modelCalls: 0`. A normalized signature records step, action, locator candidate, URL, branch,
and checkpoint decisions so two runs can be compared without volatile timestamps or run IDs.

The result union separates `success`, `business_outcome`, and `failure`. Member `00000` returns
`member-not-found` rather than throwing. Member `77777` exposes a known transient host error and runs
one explicit safe recovery command. Member `88888` becomes a non-retryable permission failure.
Member `99999` invokes the handoff branch. Unexpected locator failures, timeouts, policy rejection,
checkpoint mismatch, surface errors, invalid outputs, and operator aborts retain distinct terminal
categories and diagnostic messages. Final failures capture a screenshot and retain the structured
event log.

This is intentionally closed-world recovery. Replay never asks a model to improvise and never retries
an irreversible command. UI drift is treated as a failed locator or checkpoint with evidence, not as
permission to guess. Step deadlines bound browser actions and postcondition waits; recovery remains
one declared safe command rather than a generalized backoff engine.

# Heterogeneity & multi-tenant

The durable vocabulary is commands, conditions, target intent, ordered locator strategies, receipts,
and results; Playwright details live in the surface module. A legacy-web adapter can add visual anchors
or coordinate fallbacks while preserving those contracts. A desktop adapter would implement the same
observe/resolve/act/check/capture behaviors using an accessibility tree and OS input. Coordinates
should remain a low-confidence fallback tied to a screenshot anchor and viewport, never the only
locator for a high-risk action.

The implementation is web-only today: runners are typed directly to `PlaywrightSurface`, and the
artifact's surface discriminator is `web`. Extracting a formal `SurfaceAdapter` interface and adding a
desktop discriminator is the next boundary change; no desktop support is implied by this submission.

For tenant reuse, the artifact already identifies a vendor family and version, but its entry origin and
permissions are concrete. At scale I would store an approved base capability per vendor/version range
and small versioned tenant profiles containing entry-point mappings, branding/text aliases, and extra
locator candidates. An override could narrow policy but never widen the runtime or base-artifact
ceiling. Replay would record both revisions. Repeated locator/checkpoint failures would emit drift
signals and quarantine that tenant/version combination; they would not silently rewrite an approved
artifact. Tenant profiles and drift management are designed here, not implemented.

# Escalation & handoff

Discovery stops after the same action repeats against an unchanged surface, a model escalation, an
unsafe policy result, the step limit, or its wall-clock/model-call deadline. Replay raises an
intervention when a declared branch encounters a state it cannot safely resolve. The request identifies
the run, capability, step, goal, reason, session, status, and time; the loopback operator page supplies
a current screenshot of the live target.

`RunSession` is the control seam. It owns one browser, `BrowserContext`, and `Page`, plus an exclusive
lease with three states: automation, none, and human. Automation pauses and releases the lease before
the operator can claim it. The operator can click the current screenshot, type, press a key, reload,
resume, or abort. Every command runs against the existing target page. Resume first evaluates the
artifact's declared checkpoint, then releases the human lease and restores automation; failed
verification leaves control with the operator. Human actions and claim/resume transitions are written
as handoff events.

The console is intentionally bare and loopback-only. It has no authentication, durable routing,
multi-operator arbitration, or remote streaming. Those belong around the real session/lease protocol,
not inside the artifact executor. Intervention evidence is currently assembled from the live
screenshot endpoint and event stream rather than a durable intervention store.

# Safety

Policy is an intersection of caller-supplied runtime and artifact allowlists for origins, parameterized
routes, and action types, so an artifact cannot widen the runtime ceiling. The browser context
independently aborts every request outside those origins and routes, disables downloads, and exposes no
upload, clipboard, arbitrary script, or general keyboard-shortcut command. Policy preflights the acting
iframe or form destination. Runtime risk inference is a floor that artifact labels cannot downgrade;
the saved capability stops at **Ready for final approval** and contains no **Create account** command.

Inputs and outputs carry sensitivity labels. The event recorder deep-redacts invocation values,
sensitive output keys, credentials, tokens, email, SSN, card, member, account, and routing patterns
before schema validation or persistence. Model observations and action history are redacted,
provider-side storage is disabled, local run files use restrictive modes, and `.runs/`, environment
files, profiles, logs, and trace archives are ignored. A scanner covers tracked and untracked
non-ignored files, catches common real-secret formats, and masks its own diagnostics.

All screenshots and records in this demo are synthetic. There is no general pixel-level screenshot
redaction, so using this implementation on regulated data would first require screenshot DLP,
retention controls, encryption, access auditing, and a provider/data-governance review. The policy
engine can classify an irreversible action as requiring intervention, but this artifact avoids that
class entirely; a generalized executor path from that policy decision into approval is future work.

# Cuts

The committed `/evidence/` package contains a genuine provider-backed discovery, its saved artifact,
and credential-free success, business-outcome, recovery, failure, and handoff replays. A scripted run
still exists for repeatable tests, but is not represented as provider evidence.

The slice intentionally omits real bank integrations, real credentials/PII, desktop automation,
tenant overlays, drift services, queues, databases, distributed leases, operator authentication,
pixel-level screenshot redaction, and open-ended model recovery. The compiler relies on a reviewed
capability profile rather than inferring all semantics from one transcript. Recovery is one declared
safe action rather than a general retry scheduler. The final account action is never executed, and the
demo server would not persist it anyway.

Next work, in order: route generic irreversible-policy decisions through an explicit approval
protocol; add operator authentication and durable intervention routing; add pixel-level screenshot
DLP; extract a formal surface interface; then implement versioned tenant overlays and drift
quarantine. No scaling infrastructure is warranted before those boundaries need production use.
