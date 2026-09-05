# Replay evaluation

Run `npm run evaluate -- --repeat 3` for 27 actual browser trials across nine synthetic scenarios.
Every trial creates a fresh browser context; transient state cannot leak between repetitions.
The fixture discovery is scripted and explicitly labelled, not represented as live-model evidence.

| Scenario | Required behavior |
| --- | --- |
| Normal workflow | Success with declared outputs |
| Missing record | Business outcome, not an exception |
| Transient host error | One declared recovery, then success |
| Permission denial | Stop with a permission failure |
| Expired session | Stop; no autonomous reauthentication |
| Host validation | Return a validation business outcome |
| Slow load | Wait within existing action deadlines |
| Ambiguous record control | Stop before clicking either candidate |
| Hostile page text | Model-free replay follows the artifact, not page instructions |

The report includes individual outcomes, durations, recovery counts, evidence references, artifact
digest, runtime/platform, and aggregate p50/p95. Expected failures count as correct behavior; they are
not counted as successful business operations. Timings include browser launch and shutdown.

This small sequential sample is not a production success rate, a scale test, or a statistical
confidence bound. The page-injection scenario does not measure live-model resistance. Separate
integration tests exercise same-session operator control, refused premature resume, and discovery
handoff. Property tests use reproducible seeds to challenge approval invalidation.

Local run files remain under `.runs/`. Curated results can be published after checking that all
fixtures and screenshots are synthetic; do not publish arbitrary operational logs.

## Published baseline

The [v0.2.0 report](../benchmarks/replay-v0.2.0.json) records 27/27 expected outcomes, zero replay
model calls, p50 383 ms and p95 574 ms on Node 26.3.0 / macOS ARM64. It was collected on
2026-09-05 UTC against `b812d3b75516b57c81522767f78927a6f153bf1a`. The
[scripted fixture artifact](../benchmarks/fixture-v0.2.0.json) is included and matches the report's
artifact digest. Trial IDs identify local working logs, which are not all published; the report is a
measurement summary, not a second full evidence archive. CI independently reruns all nine scenarios
on Node 22 and 24. Local timings are illustrative, not latency targets.
