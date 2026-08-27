# Computer-Use Automation System

A compact TypeScript/Playwright vertical slice for turning one model-driven UI run into a typed,
reviewable capability and replaying it without model decisions.

> **Submission status:** complete. `/evidence/` contains a genuine OpenAI Responses discovery over
> the live synthetic UI, its compiled artifact, and five credential-free deterministic replays. The
> scripted driver remains a test fixture and is never represented as provider evidence.

## What the demo does

The local target is an intentionally awkward bank-servicing UI: nested tables, an iframe, generated
element IDs, and sparse semantics. The capability searches for a synthetic member, reads their name
and savings balance, prepares a savings sub-account, and stops at the review checkpoint before the
irreversible **Create account** action.

| Member | Runtime state | Expected result |
| --- | --- | --- |
| `12345` | Normal flow | `success` with name and balance |
| `00000` | No matching record | `business_outcome / member-not-found` |
| `77777` | One transient detail failure | Declared recovery, then `success` |
| `88888` | Permission denial | Non-retryable `failure / permission` |
| `99999` | Unexpected host notice | Same-session human handoff, then `success` |

```text
goal -> ModelDriver -> discovery loop -> successful action trace
                                      -> compiler -> capability artifact v1

inputs + artifact -> deterministic replay -> Playwright surface -> legacy demo
                         |                     |
                         +-> policy + events <-+
                         +-> intervention coordinator <-> operator
```

Discovery and replay share contracts, policy, redaction, event recording, and the browser surface.
Only discovery receives a `ModelDriver`. Replay executes the artifact's ordered commands and declared
branches directly and reports `modelCalls: 0`.

## Setup

Requirements: Node.js 22+, npm, and a Chromium build installed by Playwright.

```bash
git clone https://github.com/bgivenb/interface-ai-computer-use.git
cd interface-ai-computer-use
npm ci
npm run browser:install
```

No credentials are needed for the target app, replay, tests, or scripted fixture. All records are
synthetic and all servers bind to loopback.

Run the full local quality gate:

```bash
npm run verify
```

This checks formatting, lint, types, tests, the production build, evidence integrity, and secret
patterns across tracked and untracked non-ignored files.

## Offline fixture path

Run the complete local scenario without an API key:

```bash
npm run demo
```

This starts the hostile UI on an ephemeral loopback port, uses `ScriptedModelDriver` to exercise the
real discovery loop, compiles an artifact, and replays all five fixtures. Generated artifacts, JSONL
events, summaries, and screenshots stay under ignored `.runs/` paths.

To inspect the agent-to-artifact and artifact-to-replay steps separately:

```bash
npm run discover -- --driver scripted \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json

env -u OPENAI_API_KEY npm run replay -- \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json \
  --member-id 12345 \
  --nickname "Rainy Day"
```

The first command is useful for development, but its scripted decisions do not count as the required
genuine discovery run.

## Genuine discovery and deterministic replay

Use a newly rotated key in the shell that launches discovery. Do not add it to this repository or
paste it into evidence.

```bash
export OPENAI_API_KEY="<newly-rotated-key>"
export OPENAI_MODEL="gpt-5.4-mini"

npm run discover -- --driver openai --headed \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json
```

The CLI starts the live local target, runs one structured OpenAI Responses decision per observation,
verifies the review checkpoint, writes the artifact, and reports the run directory. Provider request
storage is disabled. After discovery, prove replay has no credential dependency:

```bash
unset OPENAI_API_KEY

npm run replay -- \
  --artifact artifacts/examples/prepare-savings-subaccount.v1.json \
  --member-id 12345 \
  --nickname "Rainy Day"
```

Replay returns structured JSON containing the artifact digest, terminal result, normalized execution
signature, evidence references, and `modelCalls: 0`.

## Exceptional paths and handoff

After producing the artifact, run the declared exceptional states with the same replay command:

```bash
npm run replay -- --member-id 00000   # legitimate business outcome; exit 0
npm run replay -- --member-id 77777   # safe one-time recovery; exit 0
npm run replay -- --member-id 88888   # permission failure; exit 4
npm run replay -- --member-id 99999   # automated operator-fixture handoff; exit 0
```

For a person-driven handoff, use:

```bash
npm run replay -- --member-id 99999 --interactive
```

Open the printed loopback operator URL, claim the intervention, click **Dismiss and continue** on the
live screenshot, then select **Verify and resume**. The automation lease is released before the human
lease is granted; resume is refused until the declared checkpoint passes. The target `Page` and
`BrowserContext` are preserved, and human actions are added to the run event stream.

## Evidence and repository guide

Local runs are private working data under `.runs/`. Curated `/evidence/` includes the genuine
discovery log, saved artifact, success, business-outcome, recovery, failure, and handoff replays.
Every manifest entry includes SHA-256 hashes and a declared model-call count; `npm run
evidence:verify` validates file integrity, event schemas and ordering, run IDs, artifact provenance,
and the zero-model replay boundary.

- `src/core/` - strict Zod contracts, events, policy, and redaction
- `src/discovery/` - provider-neutral driver seam, OpenAI adapter, and scripted fixture
- `src/artifact/` - parameterization, compilation, and deterministic replay
- `src/surface/` - Playwright perception, targeting, checkpoints, and evidence capture
- `src/runtime/` - browser-session lease and operator handoff
- `src/demo/` - synthetic hostile legacy target and runtime fixtures
- `src/evidence/` - evidence verifier and tracked-text secret scanner
- [`REPORT.md`](./REPORT.md) - design decisions, limits, and explicit cuts
- [`SPEC.md`](./SPEC.md) - executable product and acceptance specification for the built slice
