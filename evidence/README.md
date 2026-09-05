# Evidence

This directory preserves the original guided OpenAI Responses discovery and five deterministic
replays: success, business outcome, transient recovery, permission failure, and same-session handoff.
It also includes a release exploration recording and its changed-input replay. No credential,
browser profile, real customer data, video, or trace archive is included.

[`manifest.json`](./manifest.json) declares each run ID, exact credential-free command, expected
status, model-call count, file role, and SHA-256 digest. Each discovery records nine model-authored
decisions. Every replay and handoff record declares and proves `modelCalls: 0`. The original six
scenarios retain their collection-level source revision; the new scenarios specify their own revision.

## Release exploration

[`exploration/summary.json`](exploration/summary.json) records a real `gpt-5.4-mini` run against
commit `b812d3b75516b57c81522767f78927a6f153bf1a`, without a prescribed next step. The model selected
eight actions and chose to read the savings balance on the final review screen. It used the author's
unordered checkpoint catalog and stopped before account creation.

[`exploration-replay/summary.json`](exploration-replay/summary.json) replays that exact artifact with
the API key absent and the nickname changed from `Rainy Day` to `Reserve Fund`. Both artifact digests
match; final member and nickname checks pass. This is evidence of one successful discovered workflow,
not an estimated discovery success rate. Development trials included safely stopped checkpoint and
locator failures; a release-recording attempt also encountered a provider connection error. See the
[engineering notes](../docs/ENGINEERING.md) for the resulting design changes.

The manifest's `.runs/` commands describe the actual collection paths. To replay the public copy,
use `env -u OPENAI_API_KEY npm run replay -- --artifact evidence/exploration/artifact.json
--member-id 12345 --nickname 'Reserve Fund'` (on one line). Discovery requires a locally configured
key; no key is included in the command or repository.

Run `npm run evidence:verify` from the repository root to validate hashes, JSON/JSONL schemas, event
ordering, run IDs, artifact provenance, scenario coverage, and the model/replay boundary. All names,
identifiers, balances, and screenshots are synthetic; persisted result outputs and input-bearing URLs
are redacted.
