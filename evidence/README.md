# Evidence

This directory contains one genuine OpenAI Responses discovery on the live synthetic UI and five
deterministic replays: success, business outcome, transient recovery, permission failure, and
same-session handoff. No credential, browser profile, real customer data, video, or trace archive is
included.

[`manifest.json`](./manifest.json) declares each run ID, exact credential-free command, expected
status, model-call count, file role, and SHA-256 digest. Discovery records nine model-authored
decisions. Every replay and handoff record declares and proves `modelCalls: 0`.

Run `npm run evidence:verify` from the repository root to validate hashes, JSON/JSONL schemas, event
ordering, run IDs, artifact provenance, scenario coverage, and the model/replay boundary. All names,
identifiers, balances, and screenshots are synthetic; persisted result outputs and input-bearing URLs
are redacted.
